import { execFile } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { openaiChatCodec } from "@agentrewind/codec-openai";
import { beforeAll, describe, expect, it } from "vitest";
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
  beforeAll(async () => {
    await execFileAsync("pnpm", ["build"]);
  }, 30000);

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

    const tool = await execFileAsync("node", [cli, "tool", sessionPath, "--name", "lookupCustomer"]);
    expect(JSON.parse(tool.stdout)).toMatchObject({
      step: toolStep,
      name: "lookupCustomer",
      args: { id: "cus_123" },
      result: { id: "cus_123", plan: "enterprise" },
      error: false
    });
    const toolByStep = await execFileAsync("node", [cli, "tool", "fixture", "--store", store, "--step", String(toolStep)]);
    expect(JSON.parse(toolByStep.stdout)).toMatchObject({ name: "lookupCustomer", args: { id: "cus_123" } });

    const context = await execFileAsync("node", [cli, "context", sessionPath, "--step", String(modelSteps[0])]);
    expect(JSON.parse(context.stdout)).toEqual(req("one").messages);

    const defaultContext = await execFileAsync("node", [cli, "context", sessionPath]);
    expect(JSON.parse(defaultContext.stdout)).toEqual(req("one").messages);

    const siteContext = await execFileAsync("node", [cli, "context", sessionPath, "--site", "two"]);
    expect(JSON.parse(siteContext.stdout)).toEqual(req("two").messages);

    const latestContext = await execFileAsync("node", [cli, "context", "latest", "--store", store, "--site", "two"]);
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

    const output = await execFileAsync("node", [cli, "tool", join(store, "tool-error"), "--name", "fail"]);
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

  it("quickstart prints copyable provider starters", async () => {
    const cli = join(process.cwd(), "packages/cli/dist/index.js");
    const store = await mkdtemp(join(tmpdir(), "agentrewind-cli-quickstart-"));

    const list = await execFileAsync("node", [cli, "quickstart"]);
    expect(list.stdout).toContain("agentrewind quickstart openai");
    expect(list.stdout).toContain("agentrewind quickstart anthropic");

    const openrouter = await execFileAsync("node", [cli, "quickstart", "openrouter", "--manager", "npm"]);
    expect(openrouter.stdout).toContain("npm install @agentrewind/sdk");
    expect(openrouter.stdout).toContain("import { OpenAI, openRouterChatCodec, openRouterClientOptions } from \"@agentrewind/sdk\";");
    expect(openrouter.stdout).toContain("openRouterClientOptions");
    expect(openrouter.stdout).toContain("requiredEnv(\"OPENROUTER_API_KEY\")");
    expect(openrouter.stdout).toContain("requiredEnv(\"OPENROUTER_MODEL\")");
    expect(openrouter.stdout).toContain("Missing ${name}. Set it before running this starter.");
    expect(openrouter.stdout).toContain("assertProviderClient(model, codec)");
    expect(openrouter.stdout).toContain("const sessionPath = `.rewind/${sessionId}`;");
    expect(openrouter.stdout).toContain("console.error(explainRewindError(error, { sessionPath }));");
    expect(openrouter.stdout).toContain("defineHarness");
    expect(openrouter.stdout).toContain("AgentRewind.recordRun");
    expect(openrouter.stdout).toContain("AgentRewind.replayRun");
    expect(openrouter.stdout).toContain("What This Starter Does");
    expect(openrouter.stdout).toContain("A stable site name makes drift output");
    expect(openrouter.stdout).toContain("agentrewind list .rewind");
    expect(openrouter.stdout).toContain("agentrewind doctor .rewind/openrouter-demo");
    expect(openrouter.stdout).toContain("agentrewind context .rewind/openrouter-demo");
    expect(openrouter.stdout).toContain("agentrewind context .rewind/openrouter-demo --site openrouter-answer");

    const anthropic = await execFileAsync("node", [cli, "quickstart", "anthropic"]);
    expect(anthropic.stdout).toContain("npm install @agentrewind/sdk");
    expect(anthropic.stdout).toContain("import { Anthropic, anthropicCodec } from \"@agentrewind/sdk\";");
    expect(anthropic.stdout).toContain("ANTHROPIC_MODEL=...");
    expect(anthropic.stdout).toContain("anthropicCodec");
    expect(anthropic.stdout).toContain("explainRewindError");

    const openaiTs = await execFileAsync("node", [cli, "quickstart", "openai", "--format", "ts"]);
    expect(openaiTs.stdout).toContain("import { AgentRewind");
    expect(openaiTs.stdout).toContain("from \"@agentrewind/sdk\"");
    expect(openaiTs.stdout).toContain("openaiChatCodec");
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
    expect(starterSource).toContain("assertProviderClient(model, codec);");
    expect(starterSource).toContain("AgentRewind.recordRun");
    expect(starterSource).toContain("AgentRewind.replayRun");
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
