import { execFile } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { openaiChatCodec } from "@agentrewind/codec-openai";
import { describe, expect, it } from "vitest";
import { AgentRewind, readSession, type NormalizedRequest, type NormalizedResponse, type ProviderCodec } from "@agentrewind/core";

const execFileAsync = promisify(execFile);

const codec: ProviderCodec = {
  name: "cli-fixture",
  interceptPoints: ["create"],
  normalizeRequest(raw) {
    return raw as NormalizedRequest;
  },
  denormalizeRequest(req) {
    return req;
  },
  normalizeResponse(raw) {
    const response = raw as NormalizedResponse;
    return { ...response, raw };
  },
  normalizeStream(rawChunks) {
    return { final: { content: rawChunks, raw: rawChunks }, chunks: rawChunks.map((data, offsetMs) => ({ offsetMs, data })) };
  },
  async *rebuildStream(chunks) {
    for (const chunk of chunks) {
      yield chunk.data;
    }
  },
  stripVolatile(req) {
    return JSON.parse(JSON.stringify(req)) as NormalizedRequest;
  },
  volatileLeafPaths() {
    return [];
  },
  extractUsage(resp) {
    return resp.usage;
  },
  applyOverrides(req) {
    return req;
  }
};

describe("agentrewind CLI", () => {
  it("inspect/context/diff/pack produce expected output on a fixture session", async () => {
    const store = await mkdtemp(join(tmpdir(), "agentrewind-cli-"));
    const session = AgentRewind.record({
      id: "fixture",
      store,
      codec,
      redaction: { enabled: true, patterns: [/secret-\d+/g] },
      tools: {
        lookupCustomer: async (args) => ({ id: (args as { id: string }).id, plan: "enterprise" })
      },
      model: fakeModel([
        { content: "one secret-123", usage: { inputTokens: 3, outputTokens: 1 } },
        { content: "two", usage: { inputTokens: 5, outputTokens: 2 } }
      ])
    });
    await session.run(async (ctx) => {
      ctx.uuid();
      await ctx.tools.lookupCustomer!({ id: "cus_123" });
      await ctx.model.create(req("one"), { site: "one" });
      await ctx.model.create(req("two"), { site: "two" });
    });
    await session.close();
    const sessionPath = join(store, "fixture");
    const cli = join(process.cwd(), "packages/cli/dist/index.js");

    const list = await execFileAsync("node", [cli, "list", store]);
    expect(list.stdout.split("\n")[0]).toBe("id\tprovider\tcreated\torigin\tmodels\ttools\tentropy\terrors\ttokens\tpath");
    expect(list.stdout).toContain("fixture\tcli-fixture");
    expect(list.stdout).toContain("\trecord\t2\t1\t1\t0\tin=8 out=3\t");
    expect(list.stdout).toContain(sessionPath);

    const listAlias = await execFileAsync("node", [cli, "ls", store, "--json"]);
    expect(JSON.parse(listAlias.stdout)).toEqual([
      expect.objectContaining({
        id: "fixture",
        path: sessionPath,
        provider: "cli-fixture",
        origin: "record",
        counts: expect.objectContaining({ modelCalls: 2, toolCalls: 1, entropyDraws: 1, errors: 0 }),
        usage: { inputTokens: 8, outputTokens: 3 }
      })
    ]);

    const emptyStore = await mkdtemp(join(tmpdir(), "agentrewind-cli-empty-"));
    const emptyList = await execFileAsync("node", [cli, "list", emptyStore]);
    expect(emptyList.stdout).toContain(`No AgentRewind sessions found in ${emptyStore}.`);
    const missingStoreJson = await execFileAsync("node", [cli, "list", join(emptyStore, "missing"), "--json"]);
    expect(JSON.parse(missingStoreJson.stdout)).toEqual([]);

    const doctor = await execFileAsync("node", [cli, "doctor", sessionPath]);
    expect(doctor.stdout).toContain("AgentRewind session is readable.");
    expect(doctor.stdout).toContain("Provider: cli-fixture");
    expect(doctor.stdout).toContain("Model steps:");
    expect(doctor.stdout).toContain(`agentrewind context ${sessionPath} --site one`);
    expect(doctor.stdout).toContain(`agentrewind diff ${sessionPath} --from-site one --to-site two`);

    const doctorById = await execFileAsync("node", [cli, "doctor", "fixture", "--store", store]);
    expect(doctorById.stdout).toContain(`Session: ${sessionPath}`);
    expect(doctorById.stdout).toContain("Provider: cli-fixture");

    const inspectBySingleSessionStore = await execFileAsync("node", [cli, "inspect", store, "--no-header"]);
    expect(inspectBySingleSessionStore.stdout).toContain("model_call");
    expect(inspectBySingleSessionStore.stdout).not.toContain("step\tkind");

    const doctorJson = await execFileAsync("node", [cli, "doctor", sessionPath, "--json"]);
    expect(JSON.parse(doctorJson.stdout)).toMatchObject({
      ok: true,
      id: "fixture",
      provider: "cli-fixture",
      counts: { modelCalls: 2 },
      redaction: { enabled: true, total: 2 }
    });

    const inspect = await execFileAsync("node", [cli, "inspect", sessionPath]);
    expect(inspect.stdout.split("\n")[0]).toBe("step\tkind\tlane\tsite\tfingerprint\tdetail\ttokens\tflags");
    expect(inspect.stdout).toContain("model_call");
    expect(inspect.stdout).toContain("model=m");
    expect(inspect.stdout).toContain("in=3 out=1");

    const inspectJson = await execFileAsync("node", [cli, "inspect", sessionPath, "--json"]);
    expect(JSON.parse(inspectJson.stdout)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "model_call",
          site: "one",
          model: "m",
          tokens: { inputTokens: 3, outputTokens: 1 }
        })
      ])
    );

    const timelineAlias = await execFileAsync("node", [
      cli,
      "timeline",
      sessionPath,
      "--kind",
      "model_call",
      "--site",
      "one",
      "--json",
      "--full-fingerprint"
    ]);
    const filteredTimeline = JSON.parse(timelineAlias.stdout);
    expect(filteredTimeline).toHaveLength(1);
    expect(filteredTimeline[0]).toMatchObject({ kind: "model_call", site: "one" });
    expect(filteredTimeline[0].fingerprint.length).toBe(64);

    const inspectNoHeader = await execFileAsync("node", [cli, "inspect", sessionPath, "--no-header"]);
    expect(inspectNoHeader.stdout.split("\n")[0]).not.toContain("step\tkind");

    const events = (await readSession(sessionPath)).events;
    const modelSteps = events.filter((event) => event.kind === "model_call").map((event) => event.step);
    const toolStep = events.find((event) => event.kind === "tool_call")?.step ?? -1;
    const entropyStep = events.find((event) => event.kind === "entropy")?.step ?? -1;
    const entropy = await execFileAsync("node", [cli, "entropy", sessionPath, "--source", "uuid"]);
    expect(JSON.parse(entropy.stdout)).toMatchObject({
      step: entropyStep,
      source: "uuid",
      value: expect.any(String)
    });
    const entropyByStep = await execFileAsync("node", [cli, "entropy", "fixture", "--store", store, "--step", String(entropyStep)]);
    expect(JSON.parse(entropyByStep.stdout)).toMatchObject({ source: "uuid", value: expect.any(String) });

    const tool = await execFileAsync("node", [cli, "tool", sessionPath, "--name", "lookupCustomer", "--json"]);
    expect(JSON.parse(tool.stdout)).toMatchObject({
      step: toolStep,
      name: "lookupCustomer",
      args: { id: "cus_123" },
      result: { id: "cus_123", plan: "enterprise" },
      error: false
    });
    const toolByStep = await execFileAsync("node", [cli, "tool", "fixture", "--store", store, "--step", String(toolStep), "--json"]);
    expect(JSON.parse(toolByStep.stdout)).toMatchObject({ name: "lookupCustomer", args: { id: "cus_123" } });
    const readableTool = await execFileAsync("node", [cli, "tool", sessionPath, "--name", "lookupCustomer"]);
    expect(readableTool.stdout).toContain("Tool: lookupCustomer");
    expect(readableTool.stdout).toContain("Args:");
    expect(readableTool.stdout).toContain("Result:");

    const context = await execFileAsync("node", [cli, "context", sessionPath, "--step", String(modelSteps[0]), "--json"]);
    expect(JSON.parse(context.stdout)).toEqual(req("one").messages);
    const readableContext = await execFileAsync("node", [cli, "context", sessionPath, "--step", String(modelSteps[0])]);
    expect(readableContext.stdout).toContain("1. user");
    expect(readableContext.stdout).toContain("one");
    const promptAlias = await execFileAsync("node", [cli, "prompt", sessionPath, "--step", String(modelSteps[0]), "--json"]);
    expect(JSON.parse(promptAlias.stdout)).toEqual(req("one").messages);
    const invalidStep = await execFileAsync("node", [cli, "context", sessionPath, "--step", "1x"]).catch(
      (caught) => caught as { stderr: string }
    );
    expect(invalidStep.stderr).toContain("Expected a non-negative integer");

    const defaultContext = await execFileAsync("node", [cli, "context", sessionPath, "--json"]);
    expect(JSON.parse(defaultContext.stdout)).toEqual(req("one").messages);

    const siteContext = await execFileAsync("node", [cli, "context", sessionPath, "--site", "two", "--json"]);
    expect(JSON.parse(siteContext.stdout)).toEqual(req("two").messages);

    const latestContext = await execFileAsync("node", [cli, "context", "latest", "--store", store, "--site", "two", "--json"]);
    expect(JSON.parse(latestContext.stdout)).toEqual(req("two").messages);

    const diff = await execFileAsync("node", [cli, "diff", sessionPath, "--from", String(modelSteps[0]), "--to", String(modelSteps[1])]);
    expect(JSON.parse(diff.stdout)).toMatchObject({ tokenDelta: 2, tokenDeltaIsEstimate: false });

    const defaultDiff = await execFileAsync("node", [cli, "diff", sessionPath]);
    expect(JSON.parse(defaultDiff.stdout)).toMatchObject({ tokenDelta: 2, tokenDeltaIsEstimate: false });

    const nextDiff = await execFileAsync("node", [cli, "diff", sessionPath, "--from", String(modelSteps[0])]);
    expect(JSON.parse(nextDiff.stdout)).toMatchObject({ tokenDelta: 2, tokenDeltaIsEstimate: false });

    const siteDiff = await execFileAsync("node", [cli, "diff", sessionPath, "--from-site", "one", "--to-site", "two"]);
    expect(JSON.parse(siteDiff.stdout)).toMatchObject({ tokenDelta: 2, tokenDeltaIsEstimate: false });

    const nextSiteDiff = await execFileAsync("node", [cli, "diff", sessionPath, "--from-site", "one"]);
    expect(JSON.parse(nextSiteDiff.stdout)).toMatchObject({ tokenDelta: 2, tokenDeltaIsEstimate: false });

    const packed = join(store, "fixture.rewind");
    const pack = await execFileAsync("node", [cli, "pack", sessionPath, packed]);
    expect(pack.stdout).toContain("redaction.total=2");
    expect(pack.stdout).toContain("count=2");
    expect(await readFile(packed)).toBeInstanceOf(Buffer);

    const packedById = join(store, "fixture-by-id.rewind");
    const packById = await execFileAsync("node", [cli, "pack", "fixture", packedById, "--store", store]);
    expect(packById.stdout).toContain("redaction.total=2");
    expect(await readFile(packedById)).toBeInstanceOf(Buffer);
  });

  it("session selectors explain ambiguous stores and missing ids", async () => {
    const store = await mkdtemp(join(tmpdir(), "agentrewind-cli-selector-"));
    const cli = join(process.cwd(), "packages/cli/dist/index.js");
    for (const id of ["alpha", "beta"]) {
      const session = AgentRewind.record({
        id,
        store,
        codec,
        model: fakeModel([{ content: id, usage: { inputTokens: 1, outputTokens: 1 } }])
      });
      await session.run(async (ctx) => {
        await ctx.model.create(req(id), { site: id });
      });
      await session.close();
    }

    const ambiguous = await execFileAsync("node", [cli, "doctor", store]).catch((caught) => caught as { stderr: string });
    expect(ambiguous.stderr).toContain("is a session store containing 2 sessions");
    expect(ambiguous.stderr).toContain("agentrewind list");
    expect(ambiguous.stderr).toContain("latest --store");
    expect(ambiguous.stderr).toContain("alpha, beta");

    const missing = await execFileAsync("node", [cli, "doctor", "gamma", "--store", store]).catch((caught) => caught as { stderr: string });
    expect(missing.stderr).toContain('No AgentRewind session "gamma" found');
    expect(missing.stderr).toContain("Available session ids: alpha, beta");
    expect(missing.stderr).toContain("Run agentrewind list");
  });

  it("tool command preserves serialized error details", async () => {
    const store = await mkdtemp(join(tmpdir(), "agentrewind-cli-tool-error-"));
    const cli = join(process.cwd(), "packages/cli/dist/index.js");
    const session = AgentRewind.record({
      id: "tool-error",
      store,
      codec,
      model: fakeModel([]),
      tools: {
        fail: async () => {
          const error = new Error("boom") as Error & { data?: unknown };
          error.data = { code: "E_TEST" };
          throw error;
        }
      }
    });
    await session.run(async (ctx) => {
      await expect(ctx.tools.fail!({ id: "t1" })).rejects.toThrow("boom");
    });
    await session.close();

    const output = await execFileAsync("node", [cli, "tool", join(store, "tool-error"), "--name", "fail", "--json"]);
    expect(JSON.parse(output.stdout)).toMatchObject({
      name: "fail",
      args: { id: "t1" },
      error: {
        name: "Error",
        message: "boom",
        data: { code: "E_TEST" }
      }
    });
  });

  it("fork creates a child session with provider overrides through an OpenAI-compatible endpoint", async () => {
    const store = await mkdtemp(join(tmpdir(), "agentrewind-cli-fork-"));
    const cli = join(process.cwd(), "packages/cli/dist/index.js");
    const requests: unknown[] = [];
    const server = createServer((request, response) => {
      void handleOpenAICompatibleRequest(request, response, requests);
    });
    await listen(server);
    const address = server.address() as AddressInfo;
    const baseURL = `http://127.0.0.1:${address.port}/v1`;

    try {
      const session = AgentRewind.record({
        id: "fork-parent",
        store,
        codec: openaiChatCodec(),
        model: fakeOpenAIChatModel(
          chatCompletion("chatcmpl_recorded", "recorded decision", { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 })
        )
      });
      await session.run(async (ctx) => {
        await ctx.model.create(
          {
            model: "recorded-model",
            messages: [
              { role: "system", content: "Route support tickets." },
              { role: "user", content: "Enterprise refund request." }
            ],
            temperature: 0
          },
          { site: "classify-ticket" }
        );
      });
      await session.close();

      const sessionPath = join(store, "fork-parent");
      const modelStep = (await readSession(sessionPath)).events.find((event) => event.kind === "model_call")?.step;
      expect(modelStep).toEqual(expect.any(Number));

      const dryRun = await execFileAsync(
        "node",
        [
          cli,
          "fork",
          sessionPath,
          "--site",
          "classify-ticket",
          "--provider",
          "openai-compatible",
          "--base-url",
          baseURL,
          "--api-key-env",
          "AGENTREWIND_TEST_API_KEY",
          "--model",
          "fork-model",
          "--system",
          "Prefer enterprise escalation.",
          "--dry-run"
        ],
        { env: { ...process.env, AGENTREWIND_TEST_API_KEY: "test-key" } }
      );
      expect(dryRun.stdout).toContain("AgentRewind fork plan.");
      expect(dryRun.stdout).toContain("Fork point: step");
      expect(dryRun.stdout).toContain("did not check provider credentials");
      expect(requests).toHaveLength(0);

      const fork = await execFileAsync(
        "node",
        [
          cli,
          "fork",
          sessionPath,
          "--step",
          String(modelStep),
          "--provider",
          "openai-compatible",
          "--base-url",
          baseURL,
          "--api-key-env",
          "AGENTREWIND_TEST_API_KEY",
          "--model",
          "fork-model",
          "--system",
          "Prefer enterprise escalation.",
          "--json"
        ],
        { env: { ...process.env, AGENTREWIND_TEST_API_KEY: "test-key" } }
      );
      const payload = JSON.parse(fork.stdout);
      expect(payload).toMatchObject({
        ok: true,
        parent: sessionPath,
        provider: "openai-chat",
        client: "openai-compatible",
        atStep: modelStep,
        site: "classify-ticket",
        overrides: { system: true, model: "fork-model" },
        tokensSpent: { inputTokens: 13, outputTokens: 5 },
        trace: { liveModelCalls: 1 }
      });
      expect(payload.child).toEqual(expect.stringContaining(join(store, "")));
      expect(payload.nextCommands).toEqual(expect.arrayContaining([`agentrewind inspect ${payload.child}`]));

      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        model: "fork-model",
        messages: [
          { role: "system", content: "Prefer enterprise escalation." },
          { role: "user", content: "Enterprise refund request." }
        ]
      });

      const child = await readSession(payload.child);
      expect(child.meta).toMatchObject({
        parent: "fork-parent",
        forkedAtStep: modelStep,
        provider: "openai-chat"
      });
      expect(child.events.some((event) => event.kind === "model_call" && event.provenance === "live")).toBe(true);
    } finally {
      await closeServer(server);
    }
  });

  it("search ranks candidate forks through an OpenAI-compatible endpoint", async () => {
    const store = await mkdtemp(join(tmpdir(), "agentrewind-cli-search-"));
    const cli = join(process.cwd(), "packages/cli/dist/index.js");
    const requests: unknown[] = [];
    const server = createServer((request, response) => {
      void handleSearchOpenAICompatibleRequest(request, response, requests);
    });
    await listen(server);
    const address = server.address() as AddressInfo;
    const baseURL = `http://127.0.0.1:${address.port}/v1`;

    try {
      const session = AgentRewind.record({
        id: "search-parent",
        store,
        codec: openaiChatCodec(),
        model: fakeOpenAIChatModel(
          chatCompletion("chatcmpl_recorded", "hold", { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 })
        )
      });
      await session.run(async (ctx) => {
        await ctx.model.create(
          {
            model: "recorded-model",
            messages: [
              { role: "system", content: "Route support tickets." },
              { role: "user", content: "Enterprise refund request." }
            ],
            temperature: 0
          },
          { site: "classify-ticket" }
        );
      });
      await session.close();

      const sessionPath = join(store, "search-parent");
      const dryRun = await execFileAsync(
        "node",
        [
          cli,
          "search",
          sessionPath,
          "--site",
          "classify-ticket",
          "--provider",
          "openai-compatible",
          "--base-url",
          baseURL,
          "--api-key-env",
          "AGENTREWIND_TEST_API_KEY",
          "--model",
          "search-model",
          "--candidate",
          "Hold::Keep holding enterprise exceptions.",
          "--candidate",
          "Escalate::Prefer enterprise escalation.",
          "--goal-contains",
          "escalate-to-csm",
          "--strategy",
          "alpha-zero",
          "--max-depth",
          "2",
          "--puct-exploration",
          "2.5",
          "--dry-run"
        ],
        { env: { ...process.env, AGENTREWIND_TEST_API_KEY: "test-key" } }
      );
      expect(dryRun.stdout).toContain("AgentRewind search plan.");
      expect(dryRun.stdout).toContain("Strategy: alpha-zero");
      expect(dryRun.stdout).toContain("puctExploration=2.5");
      expect(dryRun.stdout).toContain("Candidates: 2");
      expect(requests).toHaveLength(0);

      const search = await execFileAsync(
        "node",
        [
          cli,
          "search",
          sessionPath,
          "--site",
          "classify-ticket",
          "--provider",
          "openai-compatible",
          "--base-url",
          baseURL,
          "--api-key-env",
          "AGENTREWIND_TEST_API_KEY",
          "--model",
          "search-model",
          "--candidate",
          "Hold::Keep holding enterprise exceptions.",
          "--candidate",
          "Escalate::Prefer enterprise escalation.",
          "--goal-contains",
          "escalate-to-csm",
          "--json"
        ],
        { env: { ...process.env, AGENTREWIND_TEST_API_KEY: "test-key" } }
      );
      const payload = JSON.parse(search.stdout);
      expect(payload).toMatchObject({
        ok: true,
        parent: sessionPath,
        provider: "openai-chat",
        client: "openai-compatible",
        strategy: "beam",
        rollouts: 2,
        tokensSpent: { inputTokens: 26, outputTokens: 10 },
        best: {
          score: 1,
          action: { id: "escalate", label: "Escalate", overrides: { system: true, model: "search-model" } },
          reason: "escalate-to-csm"
        }
      });
      expect(payload.best.sessionPath).toEqual(expect.stringContaining(join(store, "")));
      expect(payload.searchId).toBeTruthy();
      expect(payload.searchPath).toBe(join(store, "searches", `${payload.searchId}.json`));
      expect(payload.bestBranch).toMatchObject({ actionSequence: ["escalate"], meanScore: 1, passRate: 1 });
      expect(payload.nextCommands).toEqual(expect.arrayContaining([`agentrewind inspect ${payload.best.sessionPath}`]));

      expect(requests).toHaveLength(2);
      expect(requests[0]).toMatchObject({
        model: "search-model",
        messages: expect.arrayContaining([{ role: "system", content: "Keep holding enterprise exceptions." }])
      });
      expect(requests[1]).toMatchObject({
        model: "search-model",
        messages: expect.arrayContaining([{ role: "system", content: "Prefer enterprise escalation." }])
      });

      const child = await readSession(payload.best.sessionPath);
      expect(child.meta).toMatchObject({
        parent: "search-parent",
        provider: "openai-chat",
        search: expect.objectContaining({
          searchId: payload.searchId,
          actionSequence: ["escalate"],
          actionSequenceKeys: expect.arrayContaining([expect.stringMatching(/^escalate#/)])
        })
      });
      expect(child.events.some((event) => event.kind === "model_call" && event.provenance === "live")).toBe(true);

      const report = await execFileAsync("node", [cli, "search", "report", payload.searchId, "--store", store, "--json"]);
      expect(JSON.parse(report.stdout)).toMatchObject({
        ok: true,
        searchId: payload.searchId,
        bestSessionPath: payload.best.sessionPath,
        bestBranch: expect.objectContaining({ actionSequence: ["escalate"] })
      });

      const fixturePath = join(store, "regressions", "winner.json");
      const promoted = await execFileAsync("node", [
        cli,
        "search",
        "promote",
        payload.best.sessionPath,
        "--out",
        fixturePath,
        "--json"
      ]);
      const fixture = JSON.parse(promoted.stdout);
      expect(fixture).toMatchObject({
        ok: true,
        fixturePath,
        childSessionPath: payload.best.sessionPath,
        searchId: payload.searchId,
        actionSequence: ["escalate"],
        expected: { score: 1, reason: "escalate-to-csm" }
      });
      expect(JSON.parse(await readFile(fixturePath, "utf8"))).toMatchObject({
        schema: "agentrewind.search-regression-fixture",
        childSessionPath: payload.best.sessionPath,
        actionSequence: ["escalate"]
      });
    } finally {
      await closeServer(server);
    }
  });

  it("search executes ucb, mcts, and alpha-zero strategies against a live endpoint", async () => {
    const store = await mkdtemp(join(tmpdir(), "agentrewind-cli-search-strategies-"));
    const cli = join(process.cwd(), "packages/cli/dist/index.js");
    const server = createServer((request, response) => {
      void handleSearchOpenAICompatibleRequest(request, response, []);
    });
    await listen(server);
    const address = server.address() as AddressInfo;
    const baseURL = `http://127.0.0.1:${address.port}/v1`;
    const env = { ...process.env, AGENTREWIND_TEST_API_KEY: "test-key" };

    try {
      const session = AgentRewind.record({
        id: "search-strategies-parent",
        store,
        codec: openaiChatCodec(),
        model: fakeOpenAIChatModel(
          chatCompletion("chatcmpl_recorded", "hold", { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 })
        )
      });
      await session.run(async (ctx) => {
        await ctx.model.create(
          {
            model: "recorded-model",
            messages: [
              { role: "system", content: "Route support tickets." },
              { role: "user", content: "Enterprise refund request." }
            ],
            temperature: 0
          },
          { site: "classify-ticket" }
        );
      });
      await session.close();
      const sessionPath = join(store, "search-strategies-parent");

      const baseArgs = (strategy: string) => [
        cli,
        "search",
        sessionPath,
        "--site",
        "classify-ticket",
        "--provider",
        "openai-compatible",
        "--base-url",
        baseURL,
        "--api-key-env",
        "AGENTREWIND_TEST_API_KEY",
        "--model",
        "search-model",
        "--strategy",
        strategy,
        "--max-rollouts",
        "3",
        "--candidate",
        "Hold::Keep holding enterprise exceptions.",
        "--candidate",
        "Escalate::Prefer enterprise escalation.",
        "--goal-contains",
        "escalate-to-csm",
        "--json"
      ];

      // UCB really runs three rollouts and revisits the winning arm.
      const ucb = JSON.parse((await execFileAsync("node", baseArgs("ucb"), { env })).stdout);
      expect(ucb).toMatchObject({
        ok: true,
        strategy: "ucb",
        rollouts: 3,
        best: { score: 1, action: { id: "escalate" } }
      });
      expect(ucb.nodes.filter((node: { action: { id: string } }) => node.action.id === "escalate")).toHaveLength(2);
      // Forced first-time exploration omits selectionScore and records a JSON-safe selectionReason.
      expect(ucb.nodes.some((node: { selectionReason?: string }) => node.selectionReason === "unvisited")).toBe(true);
      expect(
        ucb.nodes.every((node: { selectionScore?: number }) => node.selectionScore === undefined || Number.isFinite(node.selectionScore))
      ).toBe(true);
      expect(ucb.diagnostics).toMatchObject({
        strategy: "ucb",
        rollouts: 3,
        branches: expect.arrayContaining([expect.objectContaining({ actionSequence: ["escalate"], visits: 2, meanScore: 1 })])
      });
      expect(ucb.diagnostics.branches.find((branch: { actionSequence: string[] }) => branch.actionSequence[0] === "escalate")?.key).toMatch(/^escalate#/);

      // MCTS over a flat candidate list (no dynamic generators on the CLI) also revisits the winner.
      const mcts = JSON.parse((await execFileAsync("node", baseArgs("mcts"), { env })).stdout);
      expect(mcts).toMatchObject({
        ok: true,
        strategy: "mcts",
        rollouts: 3,
        best: { score: 1, action: { id: "escalate" } }
      });
      expect(mcts.diagnostics.branches).toEqual(
        expect.arrayContaining([expect.objectContaining({ actionSequence: ["escalate"], visits: 2, meanScore: 1 })])
      );

      // AlphaZero expands the higher-prior candidate first using a priors actions file.
      const actionsFile = join(store, "alpha-actions.json");
      await writeFile(
        actionsFile,
        JSON.stringify([
          { id: "escalate", label: "Escalate", system: "Prefer enterprise escalation.", prior: 0.8 },
          { id: "hold", label: "Hold", system: "Keep holding enterprise exceptions.", prior: 0.2 }
        ]),
        "utf8"
      );
      const alphaZero = JSON.parse(
        (
          await execFileAsync(
            "node",
            [
              cli,
              "search",
              sessionPath,
              "--site",
              "classify-ticket",
              "--provider",
              "openai-compatible",
              "--base-url",
              baseURL,
              "--api-key-env",
              "AGENTREWIND_TEST_API_KEY",
              "--model",
              "search-model",
              "--strategy",
              "alpha-zero",
              "--max-rollouts",
              "1",
              "--actions",
              actionsFile,
              "--goal-contains",
              "escalate-to-csm",
              "--json"
            ],
            { env }
          )
        ).stdout
      );
      expect(alphaZero).toMatchObject({
        ok: true,
        strategy: "alpha-zero",
        rollouts: 1,
        best: { score: 1, prior: 0.8, action: { id: "escalate" } }
      });
      const child = await readSession(alphaZero.best.sessionPath);
      expect(child.events.some((event) => event.kind === "model_call" && event.provenance === "live")).toBe(true);
    } finally {
      await closeServer(server);
    }
  });

  it("search supports JSON-path and custom scorer module scoring", async () => {
    const store = await mkdtemp(join(tmpdir(), "agentrewind-cli-search-scorers-"));
    const cli = join(process.cwd(), "packages/cli/dist/index.js");
    const server = createServer((request, response) => {
      void handleSearchJsonOpenAICompatibleRequest(request, response);
    });
    await listen(server);
    const address = server.address() as AddressInfo;
    const baseURL = `http://127.0.0.1:${address.port}/v1`;
    const env = { ...process.env, AGENTREWIND_TEST_API_KEY: "test-key" };

    try {
      const session = AgentRewind.record({
        id: "search-scorers-parent",
        store,
        codec: openaiChatCodec(),
        model: fakeOpenAIChatModel(
          chatCompletion("chatcmpl_recorded", JSON.stringify({ route: "hold" }), { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 })
        )
      });
      await session.run(async (ctx) => {
        await ctx.model.create(
          {
            model: "recorded-model",
            messages: [
              { role: "system", content: "Route support tickets." },
              { role: "user", content: "Enterprise refund request." }
            ],
            temperature: 0
          },
          { site: "classify-ticket" }
        );
      });
      await session.close();
      const sessionPath = join(store, "search-scorers-parent");

      const baseArgs = [
        cli,
        "search",
        sessionPath,
        "--site",
        "classify-ticket",
        "--provider",
        "openai-compatible",
        "--base-url",
        baseURL,
        "--api-key-env",
        "AGENTREWIND_TEST_API_KEY",
        "--model",
        "search-model",
        "--candidate",
        "Hold::Keep holding enterprise exceptions.",
        "--candidate",
        "Escalate::Prefer enterprise escalation.",
        "--json"
      ];

      const jsonScored = JSON.parse(
        (
          await execFileAsync("node", [...baseArgs, "--goal-json", "$.route=escalate-to-csm"], {
            env
          })
        ).stdout
      );
      expect(jsonScored).toMatchObject({
        ok: true,
        scoring: 'JSON output route equals "escalate-to-csm"',
        best: { score: 1, action: { id: "escalate" } }
      });

      const regexScored = JSON.parse(
        (
          await execFileAsync("node", [...baseArgs, "--goal-regex", "escalate-to-csm"], {
            env
          })
        ).stdout
      );
      expect(regexScored).toMatchObject({
        ok: true,
        scoring: "live output matches /escalate-to-csm/",
        best: { score: 1, action: { id: "escalate" } }
      });

      const scorerFile = join(store, "scorer.mjs");
      await writeFile(
        scorerFile,
        [
          "function text(value) { return typeof value === 'string' ? value : JSON.stringify(value); }",
          "export default function score({ trace }) {",
          "  const output = trace.events().filter((event) => event.kind === 'model_call' && event.provenance === 'live').map((event) => text(event.response?.content)).join('\\n');",
          "  return { score: output.includes('escalate-to-csm') ? 1 : 0, reason: `custom:${output}` };",
          "}"
        ].join("\n"),
        "utf8"
      );
      const customScored = JSON.parse(
        (
          await execFileAsync("node", [...baseArgs, "--scorer", scorerFile], {
            env
          })
        ).stdout
      );
      expect(customScored).toMatchObject({
        ok: true,
        scoring: `custom scorer ${scorerFile}`,
        best: { score: 1, action: { id: "escalate" } }
      });
      expect(customScored.best.reason).toContain("escalate-to-csm");
    } finally {
      await closeServer(server);
    }
  });

  it("quickstart prints copyable provider starters", async () => {
    const cli = join(process.cwd(), "packages/cli/dist/index.js");
    const store = await mkdtemp(join(tmpdir(), "agentrewind-cli-quickstart-"));

    const list = await execFileAsync("node", [cli, "quickstart"]);
    expect(list.stdout).toContain("agentrewind quickstart openai");
    expect(list.stdout).toContain("agentrewind quickstart anthropic");

    const openrouter = await execFileAsync("node", [cli, "quickstart", "openrouter", "--manager", "npm"]);
    expect(openrouter.stdout).toContain("npm install @agentrewind/sdk");
    expect(openrouter.stdout).toContain("import { createOpenRouterRewind } from \"@agentrewind/sdk\";");
    expect(openrouter.stdout).toContain("createOpenRouterRewind");
    expect(openrouter.stdout).toContain("requiredEnv(\"OPENROUTER_API_KEY\")");
    expect(openrouter.stdout).toContain("requiredEnv(\"OPENROUTER_MODEL\")");
    expect(openrouter.stdout).toContain("Missing ${name}. Set it before running this starter.");
    expect(openrouter.stdout).toContain("Provider presets create the SDK client");
    expect(openrouter.stdout).toContain("const sessionPath = `.rewind/${sessionId}`;");
    expect(openrouter.stdout).toContain("console.error(explainRewindError(error, { sessionPath }));");
    expect(openrouter.stdout).toContain("defineHarness");
    expect(openrouter.stdout).toContain("rewind.recordRun");
    expect(openrouter.stdout).toContain("rewind.replayRun");
    expect(openrouter.stdout).toContain("What This Starter Does");
    expect(openrouter.stdout).toContain("A stable site name makes drift output");
    expect(openrouter.stdout).toContain("agentrewind list .rewind");
    expect(openrouter.stdout).toContain("agentrewind doctor .rewind/openrouter-demo");
    expect(openrouter.stdout).toContain("agentrewind context .rewind/openrouter-demo");
    expect(openrouter.stdout).toContain("agentrewind context .rewind/openrouter-demo --site openrouter-answer");

    const anthropic = await execFileAsync("node", [cli, "quickstart", "anthropic"]);
    expect(anthropic.stdout).toContain("npm install @agentrewind/sdk");
    expect(anthropic.stdout).toContain("import { createAnthropicRewind } from \"@agentrewind/sdk\";");
    expect(anthropic.stdout).toContain("ANTHROPIC_MODEL=...");
    expect(anthropic.stdout).toContain("createAnthropicRewind");
    expect(anthropic.stdout).toContain("explainRewindError");

    const openaiTs = await execFileAsync("node", [cli, "quickstart", "openai", "--format", "ts"]);
    expect(openaiTs.stdout).toContain("import { createOpenAIRewind");
    expect(openaiTs.stdout).toContain("from \"@agentrewind/sdk\"");
    expect(openaiTs.stdout).toContain("createOpenAIRewind");
    expect(openaiTs.stdout).not.toContain("```");

    const starter = join(store, "agentrewind-openai.ts");
    const write = await execFileAsync("node", [cli, "quickstart", "openai", "--out", starter]);
    expect(write.stdout).toContain(`Wrote ${starter}`);
    const starterSource = await readFile(starter, "utf8");
    expect(starterSource).toContain("function requiredEnv(name: string): string");
    expect(starterSource).toContain("requiredEnv(\"OPENAI_API_KEY\")");
    expect(starterSource).toContain("requiredEnv(\"OPENAI_MODEL\")");
    expect(starterSource).toContain("const sessionId = \"openai-demo\";");
    expect(starterSource).toContain("The harness is your replayable agent workflow.");
    expect(starterSource).toContain("A stable site name makes drift output");
    expect(starterSource).toContain("Provider presets create the SDK client");
    expect(starterSource).toContain("rewind.recordRun");
    expect(starterSource).toContain("rewind.replayRun");
    expect(starterSource).toContain("explainRewindError(error, { sessionPath })");
    expect(starterSource).not.toContain("```");

    const compileCases = [
      { packageDir: "packages/codec-openai", providers: ["openai", "openai-compatible"] },
      { packageDir: "packages/codec-openrouter", providers: ["openrouter"] },
      { packageDir: "packages/codec-anthropic", providers: ["anthropic"] }
    ];
    for (const compileCase of compileCases) {
      const compileStore = await mkdtemp(join(process.cwd(), compileCase.packageDir, ".tmp-quickstart-"));
      const starterFiles: string[] = [];
      try {
        for (const provider of compileCase.providers) {
          const generated = await execFileAsync("node", [cli, "quickstart", provider, "--format", "ts"]);
          const fileName = `${provider}.ts`;
          await writeFile(join(compileStore, fileName), generated.stdout, "utf8");
          starterFiles.push(fileName);
        }
        const starterTsconfig = join(compileStore, "tsconfig.json");
        await writeFile(
          starterTsconfig,
          JSON.stringify(
            {
              extends: join(process.cwd(), "tsconfig.base.json"),
              compilerOptions: {
                noEmit: true
              },
              files: starterFiles
            },
            null,
            2
          ),
          "utf8"
        );
        await execFileAsync("pnpm", ["exec", "tsc", "-p", starterTsconfig], {
          cwd: process.cwd()
        });
      } finally {
        await rm(compileStore, { recursive: true, force: true });
      }
    }
  }, 30000);

  it("prints AgentRewind explanations for missing session paths", async () => {
    const cli = join(process.cwd(), "packages/cli/dist/index.js");
    const store = await mkdtemp(join(tmpdir(), "agentrewind-cli-missing-"));
    const missingSession = join(store, "missing-session");

    const error = await execFileAsync("node", [cli, "doctor", missingSession]).catch((caught) => caught as { stderr: string });

    expect(error.stderr).toContain("SessionStoreError: No AgentRewind session found");
    expect(error.stderr).toContain("Expected to find `meta.json`");
    expect(error.stderr).toContain("Pass the full session directory");
    expect(error.stderr).toContain("agentrewind doctor <session>");
    expect(error.stderr).not.toContain("ENOENT");
  });
});

function req(content: string): NormalizedRequest {
  return { model: "m", messages: [{ role: "user", content }], params: {} };
}

function fakeModel(responses: NormalizedResponse[]): { create(): Promise<unknown> } {
  const queue = [...responses];
  return {
    async create() {
      const next = queue.shift();
      if (!next) {
        throw new Error("No response queued");
      }
      return next;
    }
  };
}

function fakeOpenAIChatModel(response: unknown): { chat: { completions: { create(): Promise<unknown> } } } {
  return {
    chat: {
      completions: {
        async create() {
          return response;
        }
      }
    }
  };
}

function chatCompletion(
  id: string,
  content: string,
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
): Record<string, unknown> {
  return {
    id,
    object: "chat.completion",
    created: 0,
    model: "fixture-model",
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: { role: "assistant", content }
      }
    ],
    usage
  };
}

async function handleOpenAICompatibleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  requests: unknown[]
): Promise<void> {
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
    response.writeHead(404).end();
    return;
  }
  const body = JSON.parse(await readRequestBody(request)) as Record<string, unknown>;
  requests.push(body);
  response.writeHead(200, { "content-type": "application/json" });
  response.end(
    JSON.stringify(chatCompletion("chatcmpl_forked", "forked decision", { prompt_tokens: 13, completion_tokens: 5, total_tokens: 18 }))
  );
}

async function handleSearchOpenAICompatibleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  requests: unknown[]
): Promise<void> {
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
    response.writeHead(404).end();
    return;
  }
  const body = JSON.parse(await readRequestBody(request)) as { messages?: { role?: string; content?: unknown }[] };
  requests.push(body);
  const system = body.messages?.find((message) => message.role === "system")?.content;
  const content = typeof system === "string" && system.includes("escalation") ? "escalate-to-csm" : "hold";
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(chatCompletion("chatcmpl_search", content, { prompt_tokens: 13, completion_tokens: 5, total_tokens: 18 })));
}

async function handleSearchJsonOpenAICompatibleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
    response.writeHead(404).end();
    return;
  }
  const body = JSON.parse(await readRequestBody(request)) as { messages?: { role?: string; content?: unknown }[] };
  const system = body.messages?.find((message) => message.role === "system")?.content;
  const route = typeof system === "string" && system.includes("escalation") ? "escalate-to-csm" : "hold";
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(chatCompletion("chatcmpl_search_json", JSON.stringify({ route }), { prompt_tokens: 13, completion_tokens: 5, total_tokens: 18 })));
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
  }
  return body;
}

function listen(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
