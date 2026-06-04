import { gunzip, gzip } from "node:zlib";
import { promisify } from "node:util";
import { AssertionError } from "node:assert";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  AgentRewind,
  CURRENT_SCHEMA_VERSION,
  CodecError,
  ConfigurationError,
  DriftError,
  FingerprintError,
  PurityLintError,
  Redactor,
  SessionStoreError,
  SerializationError,
  Vault,
  VaultError,
  assertCodecConformance,
  assertProviderClient,
  assertProviderCodec,
  defineAgent,
  defineHarness,
  defineTools,
  diffMessages,
  explainRewindError,
  fingerprint,
  listSessionPaths,
  registerMigration,
  packSession,
  readSession,
  readSessionSummary,
  resolveSessionPath,
  saveVault,
  search,
  setVaultCryptoForTests,
  unpackSession,
  usageAdd,
  usageByStep,
  usageTotal,
  writeSession,
  type AgentContext,
  type ForkOptions,
  type ForkOverrides,
  type ForkResult,
  type Harness,
  type NormalizedRequest,
  type NormalizedResponse,
  type ProviderCodec,
  type RecordOptions,
  type Replay,
  type RewindEvent,
  type ToolValueSerializer,
  type TrajectorySearchAction,
  type Usage
} from "@agentrewind/core";
import { assertReplay, fromSession } from "@agentrewind/test";

const gunzipAsync = promisify(gunzip);
const gzipAsync = promisify(gzip);

const codec: ProviderCodec = {
  name: "synthetic",
  interceptPoints: ["create", "stream"],
  normalizeRequest(raw) {
    return raw as NormalizedRequest;
  },
  denormalizeRequest(req) {
    return req;
  },
  normalizeResponse(raw) {
    const resp = raw as NormalizedResponse;
    return { ...resp, raw };
  },
  normalizeStream(rawChunks) {
    const chunks = rawChunks.map((data, index) => ({ offsetMs: index, data }));
    return { final: { content: rawChunks, raw: rawChunks }, chunks };
  },
  async *rebuildStream(chunks) {
    for (const chunk of chunks) {
      yield chunk.data;
    }
  },
  stripVolatile(req) {
    const clone = JSON.parse(JSON.stringify(req)) as NormalizedRequest;
    delete clone.params.trace;
    return clone;
  },
  volatileLeafPaths() {
    return ["params.trace"];
  },
  extractUsage(resp) {
    return resp.usage;
  },
  applyOverrides(req: NormalizedRequest, overrides: ForkOverrides, step: number): NormalizedRequest {
    const next = {
      ...req,
      params: { ...req.params },
      messages: req.messages.map((message) => ({ ...message }))
    };
    if (overrides.system !== undefined) next.system = overrides.system;
    if (overrides.model !== undefined) next.model = overrides.model;
    return overrides.transformRequest ? overrides.transformRequest(next, step) : next;
  }
};

describe("AgentRewind core", () => {
  it("fingerprint is stable across key reorder, number formatting, and secret value", () => {
    const redactor = new Redactor({ enabled: true, patterns: [/secret-\d+/g] });
    const a: NormalizedRequest = {
      model: "m",
      messages: [{ role: "user", content: { b: 1, a: "secret-123" } }],
      params: { n: 1.0, z: true }
    };
    const b: NormalizedRequest = {
      messages: [{ content: { a: "secret-123", b: 1 }, role: "user" }],
      params: { z: true, n: 1 },
      model: "m"
    };
    expect(fingerprint(a, codec, redactor, "strict")).toBe(fingerprint(b, codec, redactor, "strict"));
  });

  it("fingerprint strips volatile fields before validating retained request values", () => {
    const redactor = new Redactor({ enabled: false });
    const jsonCloningCodec: ProviderCodec = {
      ...codec,
      stripVolatile(raw) {
        return JSON.parse(JSON.stringify(raw)) as NormalizedRequest;
      }
    };

    expect(() =>
      fingerprint({ ...req("bad"), params: { value: Number.NaN } }, jsonCloningCodec, redactor, "strict")
    ).toThrow(FingerprintError);
    expect(() =>
      fingerprint({ ...req("bad"), params: { value: Number.POSITIVE_INFINITY } }, jsonCloningCodec, redactor, "strict")
    ).toThrow(FingerprintError);
    expect(() =>
      fingerprint({ ...req("bad"), params: { value: undefined } }, jsonCloningCodec, redactor, "strict")
    ).toThrow(FingerprintError);
    expect(() =>
      fingerprint(
        { ...req("bad"), messages: [{ role: "user", content: () => undefined }], params: {} },
        jsonCloningCodec,
        redactor,
        "strict"
      )
    ).toThrow(FingerprintError);

    const metadataStrippingCodec: ProviderCodec = {
      ...codec,
      stripVolatile(raw) {
        const request = raw as NormalizedRequest;
        const params = { ...request.params };
        delete params.metadata;
        return {
          ...request,
          messages: request.messages.map((message) => ({ ...message })),
          params
        };
      },
      volatileLeafPaths() {
        return ["params.metadata.*"];
      }
    };

    expect(() =>
      fingerprint(
        { ...req("ok"), params: { metadata: { callback: () => undefined } } },
        metadataStrippingCodec,
        redactor,
        "strict"
      )
    ).not.toThrow();
  });

  it("record writes events.jsonl + blobs + meta with eventsHash", async () => {
    const store = await tempStore();
    const large = "x".repeat(17_000);
    const session = AgentRewind.record({
      id: "record-store",
      store,
      model: fakeModel([{ content: large, usage: usage(1, 2) }]),
      codec
    });
    await session.run(async (ctx) => {
      await ctx.model.create(req("hello"), { site: "first" });
    });
    await session.close();

    const stored = await readSession(join(store, "record-store"));
    const meta = JSON.parse(await readFile(join(store, "record-store", "meta.json"), "utf8")) as { eventsHash: string };
    const rawEvents = await readFile(join(store, "record-store", "events.jsonl"), "utf8");
    expect(meta.eventsHash).toMatch(/^[a-f0-9]{64}$/);
    expect(stored.events.some((event) => event.kind === "model_call")).toBe(true);
    expect(rawEvents).toContain("__agentrewind_blob");
    expect(rawEvents).not.toContain(large);
  });

  it("externalizes large tool error fields to blobs", async () => {
    const store = await tempStore();
    const large = "x".repeat(20_000);
    const session = AgentRewind.record({
      id: "large-error-blob",
      store,
      model: fakeModel([]),
      codec,
      tools: {
        fail: async () => {
          const error = new Error("large failure") as Error & { data?: unknown };
          error.data = { large };
          throw error;
        }
      }
    });
    await expect(session.run(async (ctx) => ctx.tools.fail!({ id: 1 }))).rejects.toThrow("large failure");
    await session.close();

    const rawEvents = await readFile(join(store, "large-error-blob", "events.jsonl"), "utf8");
    expect(rawEvents).toContain("__agentrewind_blob");
    expect(rawEvents).not.toContain(large);

    const stored = await readSession(join(store, "large-error-blob"));
    const tool = stored.events.find((event) => event.kind === "tool_call");
    expect(tool?.error?.data).toEqual({ large });
  });

  it("externalizes large note fields to blobs", async () => {
    const store = await tempStore();
    const large = "n".repeat(20_000);
    const session = AgentRewind.record({
      id: "large-note-blob",
      store,
      model: fakeModel([]),
      codec
    });
    session.note(large);
    await session.close();

    const rawEvents = await readFile(join(store, "large-note-blob", "events.jsonl"), "utf8");
    expect(rawEvents).toContain("__agentrewind_blob");
    expect(rawEvents).not.toContain(large);

    const stored = await readSession(join(store, "large-note-blob"));
    const note = stored.events.find((event) => event.kind === "note");
    expect(note?.text).toBe(large);
  });

  it("rejects session ids and packed paths that escape their destination", async () => {
    const store = await tempStore();
    const session = AgentRewind.record({
      id: "../escape",
      store,
      model: fakeModel([]),
      codec
    });
    await expect(session.close()).rejects.toBeInstanceOf(SessionStoreError);
    await expect(readFile(join(store, "..", "escape", "meta.json"), "utf8")).rejects.toThrow();

    const pack = join(store, "malicious.rewind");
    await writeFile(pack, await gzipAsync(buildTestTar([{ name: "../escaped.txt", data: "owned" }])));
    await expect(unpackSession(pack, join(store, "out"))).rejects.toBeInstanceOf(SessionStoreError);
    await expect(readFile(join(store, "escaped.txt"), "utf8")).rejects.toThrow();
  });

  it("rejects packed sessions with unsupported tar entry types", async () => {
    const store = await tempStore();
    const pack = join(store, "symlink-entry.rewind");
    await writeFile(pack, await gzipAsync(buildTestTar([{ name: "linked-secret", data: "", type: "2" }])));

    await expect(unpackSession(pack, join(store, "out"))).rejects.toBeInstanceOf(SessionStoreError);
    await expect(unpackSession(pack, join(store, "out"))).rejects.toThrow("unsupported tar entry type");
    await expect(readFile(join(store, "out", "linked-secret"), "utf8")).rejects.toThrow();
  });

  it("rejects packed sessions that contain symlinks", async () => {
    const store = await tempStore();
    const session = AgentRewind.record({
      id: "symlink-pack",
      store,
      model: fakeModel([{ content: "ok" }]),
      codec
    });
    await session.run(async (ctx) => {
      await ctx.model.create(req("ok"), { site: "model" });
    });
    await session.close();

    const outside = join(store, "outside-secret.txt");
    await writeFile(outside, "do-not-pack", "utf8");
    await symlink(outside, join(store, "symlink-pack", "linked-secret"));

    const packed = join(store, "symlink-pack.rewind");
    await expect(packSession(join(store, "symlink-pack"), packed)).rejects.toBeInstanceOf(SessionStoreError);
    await expect(packSession(join(store, "symlink-pack"), packed)).rejects.toThrow("symbolic link");
    await expect(readFile(packed, "utf8")).rejects.toThrow();
  });

  it("does not overwrite an existing session id", async () => {
    const store = await tempStore();
    const first = AgentRewind.record({
      id: "duplicate",
      store,
      model: fakeModel([{ content: "first" }]),
      codec
    });
    await first.run(async (ctx) => {
      await ctx.model.create(req("first"), { site: "model" });
    });
    await first.close();

    const second = AgentRewind.record({
      id: "duplicate",
      store,
      model: fakeModel([{ content: "second" }]),
      codec
    });
    await second.run(async (ctx) => {
      await ctx.model.create(req("second"), { site: "model" });
    });
    await expect(second.close()).rejects.toBeInstanceOf(SessionStoreError);
    await expect(second.close()).rejects.toThrow("already exists");

    const stored = await readSession(join(store, "duplicate"));
    const model = stored.events.find((event) => event.kind === "model_call");
    expect(model?.response?.content).toBe("first");
  });

  it("cleans up a new session directory when persistence fails", async () => {
    const store = await tempStore();
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    await expect(
      writeSession(
        store,
        {
          id: "partial-write",
          createdAt: 1,
          agentRewindVersion: "0.1.0",
          schemaVersion: CURRENT_SCHEMA_VERSION,
          provider: "synthetic",
          fingerprintMode: "strict",
          redaction: { enabled: true, patterns: [] },
          eventsHash: ""
        },
        [
          {
            seq: 0,
            step: 0,
            ts: 1,
            lane: "0",
            callSite: "fixture",
            kind: "note",
            schemaVersion: CURRENT_SCHEMA_VERSION,
            text: circular
          }
        ] as unknown as RewindEvent[],
        new Vault()
      )
    ).rejects.toThrow("circular");

    await expect(readdir(join(store, "partial-write"))).rejects.toThrow();
  });

  it("pack waits for an in-flight close before reading session files", async () => {
    const store = await tempStore();
    const session = AgentRewind.record({
      id: "close-pack-race",
      store,
      model: fakeModel([{ content: "ok" }]),
      codec
    });
    await session.run(async (ctx) => {
      await ctx.model.create(req("ok"), { site: "model" });
    });

    const packed = join(store, "close-pack-race.rewind");
    const closing = session.close();
    await expect(session.pack(packed)).resolves.toBeUndefined();
    await closing;

    const archive = await gunzipAsync(await readFile(packed));
    expect(archive.toString("utf8")).toContain("events.jsonl");
  });

  it("validates blob ids and blob content hashes during hydration", async () => {
    const store = await tempStore();
    const malformed = join(store, "malformed-blob");
    await mkdir(join(malformed, "blobs"), { recursive: true });
    await writeFile(
      join(malformed, "meta.json"),
      `${JSON.stringify({
        id: "malformed-blob",
        createdAt: 1,
        agentRewindVersion: "0.1.0",
        schemaVersion: CURRENT_SCHEMA_VERSION,
        provider: "synthetic",
        fingerprintMode: "strict",
        redaction: { enabled: true, patterns: [] },
        eventsHash: ""
      })}\n`
    );
    await writeFile(
      join(malformed, "events.jsonl"),
      `${JSON.stringify({
        seq: 0,
        step: 0,
        ts: 1,
        lane: "0",
        callSite: "fixture",
        kind: "note",
        schemaVersion: CURRENT_SCHEMA_VERSION,
        text: { __agentrewind_blob: "../../outside.json" }
      })}\n`
    );
    await expect(readSession(malformed)).rejects.toThrow("invalid blob id");

    const large = "b".repeat(20_000);
    const record = AgentRewind.record({
      id: "tampered-blob",
      store,
      model: fakeModel([]),
      codec
    });
    record.note(large);
    await record.close();
    const [blob] = await readdir(join(store, "tampered-blob", "blobs"));
    await writeFile(join(store, "tampered-blob", "blobs", blob!), JSON.stringify("tampered"));
    await expect(readSession(join(store, "tampered-blob"))).rejects.toThrow("blob hash");
  });

  it("recordRun records one harness run and closes the session automatically", async () => {
    const store = await tempStore();
    const recorded = await AgentRewind.recordRun(
      {
        id: "record-run",
        store,
        model: fakeModel([{ content: "ok", usage: usage(2, 1) }]),
        codec
      },
      async (ctx) => {
        const response = await ctx.model.create<NormalizedResponse>(req("hello"), { site: "record-run-model" });
        return response.content;
      }
    );

    expect(recorded).toMatchObject({
      id: "record-run",
      path: join(store, "record-run"),
      result: "ok"
    });
    const stored = await readSession(recorded.path);
    expect(stored.events.some((event) => event.kind === "session_end" && event.ok)).toBe(true);
  });

  it("listSessionPaths discovers recorded sessions in a store", async () => {
    const store = await tempStore();
    await mkdir(join(store, "not-a-session"), { recursive: true });
    await mkdir(join(store, "partial-session"), { recursive: true });
    await writeFile(join(store, "partial-session", "meta.json"), "{}", "utf8");

    await AgentRewind.recordRun(
      {
        id: "alpha",
        store,
        model: fakeModel([{ content: "alpha", usage: usage(1, 1) }]),
        codec
      },
      async (ctx) => ctx.model.create(req("alpha"), { site: "alpha" })
    );
    await AgentRewind.recordRun(
      {
        id: "beta",
        store,
        model: fakeModel([{ content: "beta", usage: usage(1, 1) }]),
        codec
      },
      async (ctx) => ctx.model.create(req("beta"), { site: "beta" })
    );

    await expect(listSessionPaths(join(store, "missing-store"))).resolves.toEqual([]);
    await expect(listSessionPaths(store)).resolves.toEqual([join(store, "alpha"), join(store, "beta")]);
  });

  it("resolves replay session selectors from paths, ids, latest, and single-session stores", async () => {
    const store = await tempStore();
    const oneSessionStore = await tempStore();

    await AgentRewind.recordRun(
      {
        id: "first",
        store,
        model: fakeModel([{ content: "first", usage: usage(1, 1) }]),
        codec
      },
      async (ctx) => ctx.model.create<NormalizedResponse>(req("first"), { site: "first" })
    );
    await delay(2);
    await AgentRewind.recordRun(
      {
        id: "second",
        store,
        model: fakeModel([{ content: "second", usage: usage(1, 1) }]),
        codec
      },
      async (ctx) => ctx.model.create<NormalizedResponse>(req("second"), { site: "second" })
    );
    await AgentRewind.recordRun(
      {
        id: "only",
        store: oneSessionStore,
        model: fakeModel([{ content: "only", usage: usage(1, 1) }]),
        codec
      },
      async (ctx) => ctx.model.create<NormalizedResponse>(req("only"), { site: "only" })
    );

    await expect(resolveSessionPath(join(store, "first"))).resolves.toBe(join(store, "first"));
    await expect(resolveSessionPath("first", { store })).resolves.toBe(join(store, "first"));
    await expect(resolveSessionPath("latest", { store })).resolves.toBe(join(store, "second"));
    await expect(resolveSessionPath(oneSessionStore)).resolves.toBe(join(oneSessionStore, "only"));
    await expect(AgentRewind.listSessions(store)).resolves.toEqual([join(store, "first"), join(store, "second")]);
    await expect(AgentRewind.listSessionSummaries(store)).resolves.toEqual([
      expect.objectContaining({ id: "second", path: join(store, "second"), counts: expect.objectContaining({ modelCalls: 1 }) }),
      expect.objectContaining({ id: "first", path: join(store, "first"), counts: expect.objectContaining({ modelCalls: 1 }) })
    ]);

    const replayed = await AgentRewind.replayRun(
      "second",
      { store, codec },
      async (ctx) => (await ctx.model.create<NormalizedResponse>(req("second"), { site: "second" })).content
    );
    expect(replayed).toBe("second");

    const replay = await AgentRewind.replay("latest", { store });
    expect(replay.events().some((event) => event.kind === "model_call" && event.callSite === "second")).toBe(true);

    const latestSummary = await AgentRewind.summary("latest", { store });
    expect(latestSummary).toMatchObject({
      id: "second",
      path: join(store, "second"),
      provider: "synthetic",
      counts: { modelCalls: 1, toolCalls: 0, entropyDraws: 0, errors: 0 },
      usage: { inputTokens: 1, outputTokens: 1 },
      modelSteps: [expect.objectContaining({ site: "second", model: "m", messages: 1 })]
    });
    const directSummary = await readSessionSummary("first", { store });
    expect(directSummary.id).toBe("first");

    const ambiguous = await resolveSessionPath(store).catch((error) => error);
    expect(ambiguous).toBeInstanceOf(SessionStoreError);
    expect(explainRewindError(ambiguous)).toContain("Available session ids: first, second");
    expect(explainRewindError(ambiguous)).toContain("latest --store");
  });

  it("replayRun loads a session and returns one harness replay result", async () => {
    const store = await tempStore();
    const recorded = await AgentRewind.recordRun(
      {
        id: "replay-run",
        store,
        model: fakeModel([{ content: "ok", usage: usage(2, 1) }]),
        codec
      },
      async (ctx) => {
        const response = await ctx.model.create<NormalizedResponse>(req("hello"), { site: "replay-run-model" });
        return response.content;
      }
    );

    await expect(
      AgentRewind.replayRun(recorded.path, { codec }, async (ctx) => {
        const response = await ctx.model.create<NormalizedResponse>(req("hello"), { site: "replay-run-model" });
        return response.content;
      })
    ).resolves.toBe("ok");
  });

  it("preserves tool argument and result types with defineHarness", async () => {
    const store = await tempStore();
    const tools = defineTools({
      lookupCustomer: async (args: { customerId: string }) => ({
        customerId: args.customerId,
        plan: "enterprise" as const
      })
    });
    const harness = defineHarness(tools, async (ctx) => {
      const customer = await ctx.tools.lookupCustomer({ customerId: "cus_123" });
      return customer.plan;
    });

    const recorded = await AgentRewind.recordRun(
      {
        id: "typed-tools",
        store,
        model: fakeModel([]),
        codec,
        tools
      },
      harness
    );
    expect(recorded.result).toBe("enterprise");

    const replay = await AgentRewind.replay<typeof tools>(recorded.path, { codec });
    await expect(replay.run(harness)).resolves.toBe("enterprise");

    await expect(AgentRewind.toolCall("typed-tools", { store, name: "lookupCustomer" })).resolves.toMatchObject({
      kind: "tool_call",
      name: "lookupCustomer",
      args: { customerId: "cus_123" },
      result: { customerId: "cus_123", plan: "enterprise" }
    });
  });

  it("defineAgent carries tools into recordRun and replayRun", async () => {
    const store = await tempStore();
    const tools = defineTools({
      lookupCustomer: async (args: { customerId: string }) => ({ customerId: args.customerId, tier: "enterprise" })
    });
    const agent = defineAgent({
      tools,
      harness: async (ctx) => {
        const customer = await ctx.tools.lookupCustomer({ customerId: "cus_123" });
        const response = await ctx.model.create<NormalizedResponse>(req(customer.tier), { site: "agent-model" });
        return response.content;
      }
    });

    const recorded = await AgentRewind.recordRun(
      {
        id: "defined-agent",
        store,
        model: fakeModel([{ content: "ok", usage: usage(1, 1) }]),
        codec
      },
      agent
    );

    await expect(AgentRewind.replayRun(recorded.path, { codec }, agent)).resolves.toBe("ok");
    const stored = await readSession(recorded.path);
    expect(stored.events).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "tool_call", name: "lookupCustomer" })]));
  });

  it("withProvider binds model, codec, store, and tools once", async () => {
    const store = await tempStore();
    const tools = defineTools({
      lookupCustomer: async (args: { customerId: string }) => ({ customerId: args.customerId, tier: "enterprise" })
    });
    const rewind = AgentRewind.withProvider({
      store,
      model: fakeModel([{ content: "bound", usage: usage(2, 1) }]),
      codec,
      tools
    });
    const agent = defineAgent({
      tools,
      harness: async (ctx) => {
        const customer = await ctx.tools.lookupCustomer({ customerId: "cus_456" });
        return (await ctx.model.create<NormalizedResponse>(req(customer.tier), { site: "bound-model" })).content;
      }
    });

    const recorded = await rewind.recordRun({ id: "bound-provider" }, agent);
    expect(recorded.path).toBe(join(store, "bound-provider"));
    await expect(rewind.replayRun(recorded.path, agent)).resolves.toBe("bound");
  });

  it("ctx.env records and replays environment values instead of reading live process.env during replay", async () => {
    const store = await tempStore();
    const previous = process.env.AGENTREWIND_TEST_ENV;
    try {
      process.env.AGENTREWIND_TEST_ENV = "recorded-env";
      const recorded = await AgentRewind.recordRun(
        {
          id: "env-replay",
          store,
          model: fakeModel([{ content: "recorded-env", usage: usage(1, 1) }]),
          codec
        },
        async (ctx) => {
          const value = ctx.env("AGENTREWIND_TEST_ENV");
          await ctx.model.create(req(value ?? "missing"), { site: "env-model" });
          return value;
        }
      );
      process.env.AGENTREWIND_TEST_ENV = "changed-env";

      await expect(
        AgentRewind.replayRun(recorded.path, { codec }, async (ctx) => {
          const value = ctx.env("AGENTREWIND_TEST_ENV");
          await ctx.model.create(req(value ?? "missing"), { site: "env-model" });
          return value;
        })
      ).resolves.toBe("recorded-env");

      const stored = await readSession(recorded.path);
      expect(stored.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "entropy",
            source: "env",
            key: "AGENTREWIND_TEST_ENV",
            value: "recorded-env"
          })
        ])
      );
    } finally {
      if (previous === undefined) {
        delete process.env.AGENTREWIND_TEST_ENV;
      } else {
        process.env.AGENTREWIND_TEST_ENV = previous;
      }
    }
  });

  it("record mode explains missing tool handlers instead of throwing a plain TypeError", async () => {
    const store = await tempStore();
    const session = AgentRewind.record({
      id: "missing-tool",
      store,
      model: fakeModel([]),
      codec
    });

    const error = await session
      .run(async (ctx) => {
        await ctx.tools.lookupCustomer!({ customerId: "cus_123" });
      })
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(ConfigurationError);
    expect((error as ConfigurationError).message).toContain('Tool handler "lookupCustomer" is not configured');
    expect((error as ConfigurationError).data).toMatchObject({
      tool: "lookupCustomer",
      availableTools: []
    });
    const explanation = explainRewindError(error);
    expect(explanation).toContain("What to check:");
    expect(explanation).toContain("Add a `lookupCustomer` handler");
    expect(explanation).toContain("AgentRewind.recordRun");
    expect(explanation).toContain("No tools are configured");
  });

  it("step indexes boundary events without being consumed by session or note events", async () => {
    const store = await tempStore();
    const session = AgentRewind.record({
      id: "boundary-step-index",
      store,
      model: fakeModel([{ content: "ok" }]),
      tools: { done: async () => ({ ok: true }) },
      codec
    });
    session.note("before");
    await session.run(async (ctx) => {
      await ctx.model.create(req("hello"), { site: "model" });
      ctx.note("between");
      await ctx.tools.done!({});
    });
    await session.close();

    const stored = await readSession(join(store, "boundary-step-index"));
    const boundaryEvents = stored.events.filter((event) => event.kind === "model_call" || event.kind === "tool_call");
    expect(boundaryEvents.map((event) => event.step)).toEqual([0, 1]);
    expect(boundaryEvents.map((event) => event.seq)).toEqual([0, 1]);
    expect(stored.events.find((event) => event.kind === "session_start")?.step).toBe(-1);
    expect(stored.events.filter((event) => event.kind === "note").map((event) => event.step)).toEqual([-1, 0]);
    expect(stored.events.filter((event) => event.kind === "note").map((event) => event.seq)).toEqual([-1, 0]);
  });

  it("entropy: clock/random/uuid are recorded as events in initiation order", async () => {
    const store = await tempStore();
    const session = AgentRewind.record({
      id: "entropy",
      store,
      model: fakeModel([]),
      codec,
      runtime: { now: () => 10, random: () => 0.25, uuid: () => "uuid-1" }
    });
    await session.run(async (ctx) => {
      expect(ctx.clock()).toBe(10);
      expect(ctx.random()).toBe(0.25);
      expect(ctx.uuid()).toBe("uuid-1");
    });
    await session.close();
    const stored = await readSession(join(store, "entropy"));
    expect(stored.events.filter((event) => event.kind === "entropy").map((event) => event.source)).toEqual([
      "clock",
      "random",
      "uuid"
    ]);
    await expect(AgentRewind.entropyDraw("entropy", { store })).resolves.toMatchObject({ source: "clock", value: 10 });
    await expect(AgentRewind.entropyDraw("entropy", { store, source: "random" })).resolves.toMatchObject({
      source: "random",
      value: 0.25
    });
    const uuidStep = stored.events.find((event) => event.kind === "entropy" && event.source === "uuid")?.step ?? -1;
    await expect(AgentRewind.entropyDraw("entropy", { store, step: uuidStep })).resolves.toMatchObject({ source: "uuid", value: "uuid-1" });
  });

  it("non-serializable tool return throws SerializationError at record time", async () => {
    const store = await tempStore();
    const session = AgentRewind.record({
      id: "serialization",
      store,
      model: fakeModel([]),
      codec,
      tools: {
        bad: async () => ({ fn: () => undefined })
      }
    });
    const error = await session.run(async (ctx) => ctx.tools.bad!({})).catch((caught) => caught);
    expect(error).toBeInstanceOf(SerializationError);
    const explanation = explainRewindError(error);
    expect(explanation).toContain("What to check:");
    expect(explanation).toContain("Failing value label: `tool.bad.result.fn`");
    expect(explanation).toContain("toolSerializers");
    expect(explanation).toContain("normalizeRequest()");
  });

  it("fingerprint errors explain JSON compatibility and codec fixes", () => {
    const redactor = new Redactor({ enabled: false });
    const error = (() => {
      try {
        fingerprint({ ...req("bad"), params: { value: Number.NaN } }, codec, redactor, "strict");
      } catch (caught) {
        return caught;
      }
    })();

    expect(error).toBeInstanceOf(FingerprintError);
    const explanation = explainRewindError(error);
    expect(explanation).toContain("stable JSON-compatible data");
    expect(explanation).toContain("finite JSON numbers");
    expect(explanation).toContain("stripVolatile()");
  });

  it("replay of a pure harness reproduces the recorded trajectory with zero live calls", async () => {
    const store = await tempStore();
    const record = AgentRewind.record({
      id: "pure",
      store,
      model: fakeModel([{ content: "ok", usage: usage(3, 4) }]),
      tools: { add: async (args) => ({ sum: (args as { a: number; b: number }).a + (args as { a: number; b: number }).b }) },
      codec
    });
    await record.run(async (ctx) => {
      const model = await ctx.model.create(req("hello"), { site: "model" });
      const tool = await ctx.tools.add!({ a: 1, b: 2 });
      return { model, tool };
    });
    await record.close();

    let liveToolCalls = 0;
    const replay = await AgentRewind.replay(join(store, "pure"), {
      codec,
      tools: { add: async () => ((liveToolCalls += 1), { sum: 0 }) }
    });
    const result = await replay.run(async (ctx) => {
      const model = await ctx.model.create(req("hello"), { site: "model" });
      const tool = await ctx.tools.add!({ a: 1, b: 2 });
      return { model, tool };
    });
    expect(result.tool).toEqual({ sum: 3 });
    expect((result.model as NormalizedResponse).content).toBe("ok");
    expect(liveToolCalls).toBe(0);
    expect(replay.events().map((event) => event.kind)).toEqual((await readSession(join(store, "pure"))).events.map((event) => event.kind));
  });

  it("AgentRewind.replay can load a session without options for inspection", async () => {
    const store = await tempStore();
    const record = AgentRewind.record({
      id: "inspect-without-options",
      store,
      model: fakeModel([{ content: "ok" }]),
      codec
    });
    await record.run(async (ctx) => ctx.model.create(req("inspect"), { site: "model" }));
    await record.close();

    const replay = await AgentRewind.replay(join(store, "inspect-without-options"));
    expect(replay.events().some((event) => event.kind === "model_call")).toBe(true);
    expect(replay.contextAt(0)).toEqual(req("inspect").messages);

    const runError = await replay
      .run(async (ctx) => ctx.model.create(req("inspect"), { site: "model" }))
      .catch((error) => error);
    expect(runError).toBeInstanceOf(ConfigurationError);
    const runExplanation = explainRewindError(runError);
    expect(runExplanation).toContain("Provider codec is required for replay model calls");
    expect(runExplanation).toContain("AgentRewind.replay(sessionPath, { codec })");
    expect(runExplanation).toContain("Recorded provider: synthetic");

    const forkError = await replay.fork({ atStep: 0, model: fakeModel([{ content: "live" }]) }).catch((error) => error);
    expect(forkError).toBeInstanceOf(ConfigurationError);
    expect(explainRewindError(forkError)).toContain("Provider codec is required for replay fork");
  });

  it("assertProviderClient gives actionable errors for mismatched SDK client shapes", () => {
    const nestedCodec: ProviderCodec = {
      ...codec,
      name: "nested-provider",
      interceptPoints: ["chat.completions.create", "chat.completions.stream"]
    };

    expect(() =>
      assertProviderClient(
        {
          chat: {
            completions: {
              create: async () => ({ content: "ok" })
            }
          }
        },
        nestedCodec
      )
    ).not.toThrow();

    let thrown: unknown;
    try {
      assertProviderClient({ chat: { completions: {} } }, nestedCodec);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(CodecError);
    expect((thrown as CodecError).data).toMatchObject({
      codec: "nested-provider",
      path: "chat.completions.create",
      expected: "client.chat.completions.create(request)",
      missingSegment: "create"
    });
    expect(explainRewindError(thrown)).toContain("assertProviderClient(model, codec)");
    expect(explainRewindError(thrown)).toContain("client.chat.completions.create(request)");
  });

  it("record setup validates required options and codec shape with ConfigurationError", async () => {
    const missingOptions = (() => {
      try {
        AgentRewind.record(undefined as unknown as RecordOptions);
      } catch (error) {
        return error;
      }
    })();
    expect(missingOptions).toBeInstanceOf(ConfigurationError);
    expect(explainRewindError(missingOptions)).toContain("AgentRewind.record({ store, model, codec");

    const missingStore = (() => {
      try {
        AgentRewind.record({ model: fakeModel([]), codec } as RecordOptions);
      } catch (error) {
        return error;
      }
    })();
    expect(missingStore).toBeInstanceOf(ConfigurationError);
    expect(explainRewindError(missingStore)).toContain('store: ".rewind"');

    const missingModel = (() => {
      try {
        AgentRewind.record({ store: ".rewind", codec } as RecordOptions);
      } catch (error) {
        return error;
      }
    })();
    expect(missingModel).toBeInstanceOf(ConfigurationError);
    expect(explainRewindError(missingModel)).toContain("Pass the live provider SDK client when recording");
    expect(explainRewindError(missingModel)).toContain("assertProviderClient(model, codec)");

    const missingCodec = (() => {
      try {
        AgentRewind.record({ store: ".rewind", model: fakeModel([]) } as RecordOptions);
      } catch (error) {
        return error;
      }
    })();
    expect(missingCodec).toBeInstanceOf(ConfigurationError);
    expect(explainRewindError(missingCodec)).toContain("Pass the provider codec when recording");

    const invalidCodec = (() => {
      try {
        assertProviderCodec({ name: "broken" });
      } catch (error) {
        return error;
      }
    })();
    expect(invalidCodec).toBeInstanceOf(ConfigurationError);
    expect(explainRewindError(invalidCodec)).toContain("Missing codec fields:");

    await expect(
      assertCodecConformance(codec, {
        name: "basic",
        request: req("hello"),
        response: { content: "ok", usage: usage(1, 1) },
        streamChunks: [{ content: "chunk" }]
      })
    ).resolves.toBeUndefined();

    const missingAssertCodec = (() => {
      try {
        assertProviderClient(fakeModel([]), undefined as unknown as ProviderCodec);
      } catch (error) {
        return error;
      }
    })();
    expect(missingAssertCodec).toBeInstanceOf(ConfigurationError);
    expect(explainRewindError(missingAssertCodec)).toContain("Create the codec before validating the SDK client");
  });

  it("streaming with a create-only codec fails with a clear codec error", async () => {
    const store = await tempStore();
    const createOnlyCodec: ProviderCodec = { ...codec, interceptPoints: ["create"] };
    const record = AgentRewind.record({
      id: "create-only-stream",
      store,
      model: fakeModel([]),
      codec: createOnlyCodec
    });

    await expect(
      record.run(async (ctx) => {
        for await (const _chunk of ctx.model.stream(req("stream"), { site: "stream" })) {
          // The codec should fail before a live stream can be consumed.
        }
      })
    ).rejects.toMatchObject({
      message: 'Codec "synthetic" does not define a stream intercept point'
    });
  });

  it("records partial model and tool streams when the consumer breaks early", async () => {
    const store = await tempStore();
    const record = AgentRewind.record({
      id: "stream-early-break",
      store,
      model: streamingModel([{ token: "one" }, { token: "two" }]),
      codec,
      tools: {
        ticks: async function* () {
          yield "one";
          yield "two";
        }
      }
    });
    await record.run(async (ctx) => {
      for await (const _chunk of ctx.model.stream(req("stream"), { site: "model-stream" })) {
        break;
      }
      for await (const _chunk of ctx.tools.ticks!({})) {
        break;
      }
    });
    await record.close();

    const stored = await readSession(join(store, "stream-early-break"));
    const model = stored.events.find((event) => event.kind === "model_call");
    const tool = stored.events.find((event) => event.kind === "tool_call");
    expect(model?.stream).toHaveLength(1);
    expect(model?.response).toBeUndefined();
    expect(tool?.stream).toHaveLength(1);
  });

  it("strict replay fails when a recorded model or tool stream is never iterated", async () => {
    const store = await tempStore();
    const record = AgentRewind.record({
      id: "stream-not-consumed",
      store,
      model: streamingModel([{ token: "one" }]),
      codec,
      tools: {
        ticks: async function* () {
          yield "one";
        }
      }
    });
    await record.run(async (ctx) => {
      for await (const _chunk of ctx.model.stream(req("stream"), { site: "model-stream" })) {
        // consume the recorded stream
      }
      for await (const _chunk of ctx.tools.ticks!({})) {
        // consume the recorded stream
      }
    });
    await record.close();

    const replayModelOnly = await AgentRewind.replay(join(store, "stream-not-consumed"), { codec });
    await expect(
      replayModelOnly.run(async (ctx) => {
        ctx.model.stream(req("stream"), { site: "model-stream" });
      })
    ).rejects.toBeInstanceOf(DriftError);

    const replayToolOnly = await AgentRewind.replay(join(store, "stream-not-consumed"), { codec });
    await expect(
      replayToolOnly.run(async (ctx) => {
        for await (const _chunk of ctx.model.stream(req("stream"), { site: "model-stream" })) {
          // consume model so the unconsumed tool stream is the remaining drift.
        }
        ctx.tools.ticks!({});
      })
    ).rejects.toBeInstanceOf(DriftError);
  });

  it("replays partial stream chunks before a recorded terminal stream error", async () => {
    const store = await tempStore();
    const record = AgentRewind.record({
      id: "stream-terminal-error",
      store,
      model: {
        async create() {
          throw new Error("Unexpected create");
        },
        async *stream() {
          yield { token: "before-model-error" };
          throw new Error("model boom");
        }
      },
      codec,
      tools: {
        ticks: async function* () {
          yield "before-tool-error";
          throw new Error("tool boom");
        }
      }
    });
    await record.run(async (ctx) => {
      const modelChunks: unknown[] = [];
      await expect(
        (async () => {
          for await (const chunk of ctx.model.stream(req("stream"), { site: "model-stream" })) {
            modelChunks.push(chunk);
          }
        })()
      ).rejects.toThrow("model boom");
      expect(modelChunks).toEqual([{ token: "before-model-error" }]);

      const toolChunks: unknown[] = [];
      await expect(
        (async () => {
          const stream = ctx.tools.ticks!({}) as unknown as AsyncIterable<unknown>;
          for await (const chunk of stream) {
            toolChunks.push(chunk);
          }
        })()
      ).rejects.toThrow("tool boom");
      expect(toolChunks).toEqual(["before-tool-error"]);
    });
    await record.close();

    const stored = await readSession(join(store, "stream-terminal-error"));
    expect(stored.events.find((event) => event.kind === "model_call")).toMatchObject({
      stream: [{ data: { token: "before-model-error" } }],
      error: { message: "model boom" }
    });
    expect(stored.events.find((event) => event.kind === "tool_call")).toMatchObject({
      stream: [{ data: "before-tool-error" }],
      error: { message: "tool boom" }
    });

    const replay = await AgentRewind.replay(join(store, "stream-terminal-error"), { codec });
    await replay.run(async (ctx) => {
      const modelChunks: unknown[] = [];
      await expect(
        (async () => {
          for await (const chunk of ctx.model.stream(req("stream"), { site: "model-stream" })) {
            modelChunks.push(chunk);
          }
        })()
      ).rejects.toThrow("model boom");
      expect(modelChunks).toEqual([{ token: "before-model-error" }]);

      const toolChunks: unknown[] = [];
      await expect(
        (async () => {
          const stream = ctx.tools.ticks!({}) as unknown as AsyncIterable<unknown>;
          for await (const chunk of stream) {
            toolChunks.push(chunk);
          }
        })()
      ).rejects.toThrow("tool boom");
      expect(toolChunks).toEqual(["before-tool-error"]);
    });
  });

  it("strict replay fails if the harness omits a recorded boundary event", async () => {
    const store = await tempStore();
    const record = AgentRewind.record({
      id: "missing-boundary",
      store,
      model: fakeModel([{ content: "one" }, { content: "two" }]),
      codec
    });
    await record.run(async (ctx) => {
      await ctx.model.create(req("one"), { site: "one" });
      await ctx.model.create(req("two"), { site: "two" });
    });
    await record.close();

    const replay = await AgentRewind.replay(join(store, "missing-boundary"), { codec });
    await expect(
      replay.run(async (ctx) => {
        await ctx.model.create(req("one"), { site: "one" });
      })
    ).rejects.toBeInstanceOf(DriftError);
  });

  it("passthrough replay can make a live model call without failing trajectory completion", async () => {
    const store = await tempStore();
    const record = AgentRewind.record({
      id: "passthrough-model",
      store,
      model: fakeModel([{ content: "recorded" }]),
      codec
    });
    await record.run(async (ctx) => ctx.model.create(req("recorded"), { site: "model" }));
    await record.close();

    let liveCalls = 0;
    const replay = await AgentRewind.replay(join(store, "passthrough-model"), {
      codec,
      driftPolicy: "passthrough",
      model: {
        async create() {
          liveCalls += 1;
          return { content: "live" };
        }
      }
    });
    const result = await replay.run(async (ctx) => ctx.model.create(req("changed"), { site: "model" }));
    expect(result).toEqual({ content: "live" });
    expect(liveCalls).toBe(1);
  });

  it("passthrough replay draws live entropy when no recorded entropy event exists", async () => {
    const store = await tempStore();
    const record = AgentRewind.record({
      id: "passthrough-entropy",
      store,
      model: fakeModel([]),
      codec
    });
    await record.run(async () => undefined);
    await record.close();

    const replay = await AgentRewind.replay(join(store, "passthrough-entropy"), {
      codec,
      driftPolicy: "passthrough",
      runtime: {
        now: () => 123,
        random: () => 0.75,
        uuid: () => "live-uuid"
      }
    });
    await expect(
      replay.run(async (ctx) => ({
        now: ctx.clock(),
        random: ctx.random(),
        uuid: ctx.uuid()
      }))
    ).resolves.toEqual({ now: 123, random: 0.75, uuid: "live-uuid" });
  });

  it("in-request entropy embedded in the prompt yields byte-identical requests on record and replay", async () => {
    const store = await tempStore();
    const record = AgentRewind.record({
      id: "entropy-request",
      store,
      model: fakeModel([{ content: "ok" }]),
      codec,
      runtime: { uuid: () => "uuid-in-request" }
    });
    await record.run(async (ctx) => {
      await ctx.model.create(req(ctx.uuid()), { site: "entropy-model" });
    });
    await record.close();

    const replay = await AgentRewind.replay(join(store, "entropy-request"), { codec });
    await replay.run(async (ctx) => {
      await ctx.model.create(req(ctx.uuid()), { site: "entropy-model" });
    });
  });

  it("replay N times is identical every time", async () => {
    const store = await tempStore();
    const record = AgentRewind.record({
      id: "repeat",
      store,
      model: fakeModel([{ content: "stable" }]),
      codec
    });
    await record.run(async (ctx) => ctx.model.create(req("same"), { site: "model" }));
    await record.close();

    const outputs: unknown[] = [];
    for (let i = 0; i < 3; i += 1) {
      const replay = await AgentRewind.replay(join(store, "repeat"), { codec });
      outputs.push(await replay.run(async (ctx) => ctx.model.create(req("same"), { site: "model" })));
    }
    expect(outputs.map((output) => JSON.stringify(output))).toEqual([
      JSON.stringify(outputs[0]),
      JSON.stringify(outputs[0]),
      JSON.stringify(outputs[0])
    ]);
  });

  it("concurrent tool calls with shuffled completion order resolve correctly", async () => {
    const store = await tempStore();
    const record = AgentRewind.record({
      id: "concurrent",
      store,
      model: fakeModel([]),
      codec,
      tools: {
        slow: async () => {
          await delay(10);
          return { name: "slow" };
        },
        fast: async () => ({ name: "fast" })
      }
    });
    await record.run(async (ctx) => Promise.all([ctx.tools.slow!({ id: 1 }), ctx.tools.fast!({ id: 2 })]));
    await record.close();
    const recordedToolLanes = (await readSession(join(store, "concurrent"))).events
      .filter((event) => event.kind === "tool_call")
      .map((event) => event.lane);
    expect(new Set(recordedToolLanes).size).toBeGreaterThan(1);

    let live = 0;
    const replay = await AgentRewind.replay(join(store, "concurrent"), {
      codec,
      tools: {
        slow: async () => ((live += 1), { name: "live-slow" }),
        fast: async () => ((live += 1), { name: "live-fast" })
      }
    });
    const result = await replay.run(async (ctx) => Promise.all([ctx.tools.slow!({ id: 1 }), ctx.tools.fast!({ id: 2 })]));
    expect(result).toEqual([{ name: "slow" }, { name: "fast" }]);
    expect(live).toBe(0);
  });

  it("keeps a stable child lane for each Promise.all branch", async () => {
    const store = await tempStore();
    const record = AgentRewind.record({
      id: "branch-lanes",
      store,
      model: fakeModel([]),
      codec,
      tools: {
        work: async (args) => {
          const { branch, phase } = args as { branch: string; phase: number };
          await delay(branch === "a" && phase === 1 ? 1 : 2);
          return args;
        }
      }
    });
    await record.run(async (ctx) =>
      Promise.all([
        (async () => {
          await ctx.tools.work!({ branch: "a", phase: 1 });
          await delay(10);
          await ctx.tools.work!({ branch: "a", phase: 2 });
        })(),
        (async () => {
          await ctx.tools.work!({ branch: "b", phase: 1 });
          await ctx.tools.work!({ branch: "b", phase: 2 });
        })()
      ])
    );
    await record.close();

    const toolEvents = (await readSession(join(store, "branch-lanes"))).events.filter((event) => event.kind === "tool_call");
    const lanesByBranch = new Map<string, Set<string>>();
    for (const event of toolEvents) {
      const branch = (event.args as { branch: string }).branch;
      lanesByBranch.set(branch, (lanesByBranch.get(branch) ?? new Set()).add(event.lane));
    }
    expect(lanesByBranch.get("a")?.size).toBe(1);
    expect(lanesByBranch.get("b")?.size).toBe(1);
    const [aLane] = [...(lanesByBranch.get("a") ?? [])];
    const [bLane] = [...(lanesByBranch.get("b") ?? [])];
    expect(aLane).toMatch(/^0\./);
    expect(bLane).toMatch(/^0\./);
    expect(aLane).not.toBe(bLane);
  });

  it("records entropy drawn before branch model calls in the branch lane", async () => {
    const store = await tempStore();
    let nextUuid = 0;
    const record = AgentRewind.record({
      id: "entropy-branch-lanes",
      store,
      model: fakeModel([{ content: "a" }, { content: "b" }]),
      codec,
      runtime: { uuid: () => `uuid-${++nextUuid}` }
    });
    await record.run(async (ctx) =>
      Promise.all([
        (async () => {
          const id = ctx.uuid();
          await ctx.model.create(req(id), { site: "a" });
        })(),
        (async () => {
          const id = ctx.uuid();
          await ctx.model.create(req(id), { site: "b" });
        })()
      ])
    );
    await record.close();

    const events = (await readSession(join(store, "entropy-branch-lanes"))).events;
    const entropyByValue = new Map(
      events
        .filter((event) => event.kind === "entropy")
        .map((event) => [event.value, event.lane])
    );
    const modelLanesByPrompt = new Map(
      events
        .filter((event) => event.kind === "model_call")
        .map((event) => [event.request.messages[0]?.content, event.lane])
    );
    expect(entropyByValue.get("uuid-1")).toBe(modelLanesByPrompt.get("uuid-1"));
    expect(entropyByValue.get("uuid-2")).toBe(modelLanesByPrompt.get("uuid-2"));
    expect(entropyByValue.get("uuid-1")).toMatch(/^0\./);
    expect(entropyByValue.get("uuid-1")).not.toBe(entropyByValue.get("uuid-2"));

    const replay = await AgentRewind.replay(join(store, "entropy-branch-lanes"), { codec });
    await replay.run(async (ctx) =>
      Promise.all([
        (async () => {
          const id = ctx.uuid();
          await ctx.model.create(req(id), { site: "a" });
        })(),
        (async () => {
          const id = ctx.uuid();
          await ctx.model.create(req(id), { site: "b" });
        })()
      ])
    );
  });

  it("duplicate requests with different responses are disambiguated by callSite", async () => {
    const store = await tempStore();
    const record = AgentRewind.record({
      id: "callsite",
      store,
      model: fakeModel([{ content: "A" }, { content: "B" }]),
      codec
    });
    await record.run(async (ctx) => {
      await ctx.model.create(req("same"), { site: "a" });
      await ctx.model.create(req("same"), { site: "b" });
    });
    await record.close();
    const replay = await AgentRewind.replay(join(store, "callsite"), { codec });
    await replay.run(async (ctx) => {
      const a = (await ctx.model.create(req("same"), { site: "a" })) as NormalizedResponse;
      const b = (await ctx.model.create(req("same"), { site: "b" })) as NormalizedResponse;
      expect(a.content).toBe("A");
      expect(b.content).toBe("B");
    });
  });

  it("strict replay rejects reordered boundary events", async () => {
    const store = await tempStore();
    const record = AgentRewind.record({
      id: "reordered-boundaries",
      store,
      model: fakeModel([{ content: "A" }, { content: "B" }]),
      codec
    });
    await record.run(async (ctx) => {
      await ctx.model.create(req("first"), { site: "a" });
      await ctx.model.create(req("second"), { site: "b" });
    });
    await record.close();

    const replay = await AgentRewind.replay(join(store, "reordered-boundaries"), { codec });
    await expect(
      replay.run(async (ctx) => {
        await ctx.model.create(req("second"), { site: "b" });
        await ctx.model.create(req("first"), { site: "a" });
      })
    ).rejects.toMatchObject({
      name: "DriftError",
      data: expect.objectContaining({ expectedStep: 0, actualStep: 1 })
    });
  });

  it("tool fallback matching uses kind and fingerprint when the tool name shifts", async () => {
    const store = await tempStore();
    const record = AgentRewind.record({
      id: "tool-fallback",
      store,
      model: fakeModel([]),
      codec,
      tools: {
        original: async () => ({ ok: "recorded" })
      }
    });
    await record.run(async (ctx) => {
      await ctx.tools.original!({ same: true });
    });
    await record.close();

    let liveCalls = 0;
    const replay = await AgentRewind.replay(join(store, "tool-fallback"), {
      codec,
      tools: {
        renamed: async () => {
          liveCalls += 1;
          return { ok: "live" };
        }
      }
    });
    const result = await replay.run(async (ctx) => ctx.tools.renamed!({ same: true }));
    expect(result).toEqual({ ok: "recorded" });
    expect(liveCalls).toBe(0);
  });

  it("harness control-flow change is reported as DriftError", async () => {
    const store = await tempStore();
    const record = AgentRewind.record({
      id: "drift",
      store,
      model: fakeModel([{ content: "ok" }]),
      codec
    });
    await record.run(async (ctx) => {
      await ctx.model.create(req("original"), { site: "model" });
    });
    await record.close();
    const replay = await AgentRewind.replay(join(store, "drift"), { codec });
    const drift = await replay
      .run(async (ctx) => {
        await ctx.model.create(req("changed"), { site: "model" });
      })
      .catch((error) => error);
    expect(drift).toBeInstanceOf(DriftError);
    const explanation = explainRewindError(drift, { sessionPath: join(store, "drift") });
    expect(explanation).toContain("What to check:");
    expect(explanation).toContain("agentrewind inspect");
    expect(explanation).toContain("agentrewind context");
    expect(explanation).toContain("--site model");
    expect(explanation).toContain("--step");
    await expect(
      replay.run(async (ctx) => {
        await ctx.model.create(req("changed"), { site: "model" });
      })
    ).rejects.toBeInstanceOf(DriftError);
  });

  it("contextAt and diffContext return messages and token delta", async () => {
    const store = await tempStore();
    const record = AgentRewind.record({
      id: "context",
      store,
      model: fakeModel([
        { content: "one", usage: usage(4, 1) },
        { content: "two", usage: usage(8, 1) }
      ]),
      codec
    });
    await record.run(async (ctx) => {
      await ctx.model.create(req("one"), { site: "one" });
      await ctx.model.create(req("two"), { site: "two" });
    });
    await record.close();
    const replay = await AgentRewind.replay(join(store, "context"), { codec });
    const modelSteps = replay.events().filter((event) => event.kind === "model_call").map((event) => event.step);
    expect(replay.contextAt(modelSteps[0] ?? -1)).toEqual(req("one").messages);
    expect(replay.diffContext(modelSteps[0] ?? -1, modelSteps[1] ?? -1).tokenDelta).toBe(4);
    await expect(AgentRewind.timeline("context", { store })).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "model_call",
          site: "one",
          model: "m",
          tokens: { inputTokens: 4, outputTokens: 1 }
        }),
        expect.objectContaining({
          kind: "model_call",
          site: "two",
          model: "m",
          tokens: { inputTokens: 8, outputTokens: 1 }
        })
      ])
    );
    await expect(AgentRewind.promptContext("context", { store, site: "two" })).resolves.toEqual(req("two").messages);
    await expect(AgentRewind.promptContext("context", { store })).resolves.toEqual(req("one").messages);
    await expect(AgentRewind.promptDiff("context", { store, fromSite: "one", toSite: "two" })).resolves.toMatchObject({
      tokenDelta: 4,
      tokenDeltaIsEstimate: false
    });
  });

  it("diffContext treats object messages with reordered keys as structurally equal", () => {
    const left = {
      kind: "model_call",
      request: {
        model: "m",
        messages: [{ role: "user", content: { b: 2, a: 1 } }],
        params: {}
      }
    };
    const right = {
      kind: "model_call",
      request: {
        model: "m",
        messages: [{ role: "user", content: { a: 1, b: 2 } }],
        params: {}
      }
    };
    expect(diffMessages(left as Parameters<typeof diffMessages>[0], right as Parameters<typeof diffMessages>[1])).toMatchObject({
      added: [],
      removed: []
    });
  });

  it("redaction restores locally and pack excludes the vault", async () => {
    const store = await tempStore();
    const secret = "secret-999";
    const session = AgentRewind.record({
      id: "redaction",
      store,
      model: fakeModel([{ content: `value=${secret}` }]),
      codec,
      redaction: { enabled: true, patterns: [/secret-\d+/g] }
    });
    await session.run(async (ctx) => {
      await ctx.model.create(req("hello"), { site: "model" });
    });
    await session.close();

    const rawEvents = await readFile(join(store, "redaction", "events.jsonl"), "utf8");
    expect(rawEvents).not.toContain(secret);
    expect(rawEvents).toContain("arw:redacted:");

    const replay = await AgentRewind.replay(join(store, "redaction"), { codec });
    await replay.run(async (ctx) => {
      const restored = (await ctx.model.create(req("hello"), { site: "model" })) as NormalizedResponse;
      expect(restored.content).toContain(secret);
    });

    const packed = join(store, "redaction.rewind");
    await packSession(join(store, "redaction"), packed);
    const unpacked = await gunzipAsync(await readFile(packed));
    expect(unpacked.toString("utf8")).not.toContain("vault.enc");
    expect(unpacked.toString("utf8")).not.toContain(secret);

    const packedBySelector = join(store, "redaction-by-selector.rewind");
    await AgentRewind.pack("redaction", packedBySelector, { store });
    const selectorUnpacked = await gunzipAsync(await readFile(packedBySelector));
    expect(selectorUnpacked.toString("utf8")).not.toContain("vault.enc");
    const unpackedByConvenience = join(store, "unpacked-by-convenience");
    await AgentRewind.unpack(packedBySelector, unpackedByConvenience);
    await expect(readFile(join(unpackedByConvenience, "meta.json"), "utf8")).resolves.toContain('"id": "redaction"');

    const unpackDir = join(store, "unpacked");
    await unpackSession(packed, unpackDir);
    const unpackedReplay = await AgentRewind.replay(unpackDir, { codec });
    await unpackedReplay.run(async (ctx) => {
      const restored = (await ctx.model.create(req("hello"), { site: "model" })) as NormalizedResponse;
      expect(String(restored.content)).toContain("arw:redacted:");
    });
  });

  it("redacts every match for user patterns even when the regex omits the global flag", () => {
    const redactor = new Redactor({ enabled: true, patterns: [/secret-\d+/] });
    expect(redactor.redactString("secret-1 secret-2")).not.toContain("secret-");
    expect(redactor.summary.total).toBe(2);
  });

  it("redaction patterns are restored for replay request fingerprints", async () => {
    const store = await tempStore();
    const session = AgentRewind.record({
      id: "redaction-request",
      store,
      model: fakeModel([{ content: "ok" }]),
      codec,
      redaction: { enabled: true, patterns: [/secret-\d+/g] }
    });
    await session.run(async (ctx) => {
      await ctx.model.create(req("secret-123"), { site: "model" });
    });
    await session.close();

    const replay = await AgentRewind.replay(join(store, "redaction-request"), { codec });
    await replay.run(async (ctx) => {
      await ctx.model.create(req("secret-123"), { site: "model" });
    });

    const packed = join(store, "redaction-request.rewind");
    await packSession(join(store, "redaction-request"), packed);
    const unpackDir = join(store, "redaction-request-unpacked");
    await unpackSession(packed, unpackDir);
    const unpackedReplay = await AgentRewind.replay(unpackDir, { codec });
    await unpackedReplay.run(async (ctx) => {
      await ctx.model.create(req("secret-123"), { site: "model" });
    });
  });

  it("does not persist environment secret values in metadata or packed sessions", async () => {
    const store = await tempStore();
    const key = "AGENTREWIND_TEST_SECRET";
    const secret = "supersecretvalue123";
    const previous = process.env[key];
    process.env[key] = secret;
    try {
      const session = AgentRewind.record({
        id: "env-redaction",
        store,
        model: fakeModel([{ content: secret }]),
        codec
      });
      await session.run(async (ctx) => {
        await ctx.model.create(req("hello"), { site: "model" });
      });
      await session.close();

      const meta = await readFile(join(store, "env-redaction", "meta.json"), "utf8");
      const events = await readFile(join(store, "env-redaction", "events.jsonl"), "utf8");
      expect(meta).not.toContain(secret);
      expect(events).not.toContain(secret);
      expect(events).toContain("arw:redacted:");

      const packed = join(store, "env-redaction.rewind");
      await packSession(join(store, "env-redaction"), packed);
      const unpacked = await gunzipAsync(await readFile(packed));
      expect(unpacked.toString("utf8")).not.toContain(secret);
    } finally {
      if (previous === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous;
      }
    }
  });

  it("env-secret redaction remains deterministic when the environment changes after recording", async () => {
    const store = await tempStore();
    const key = "AGENTREWIND_REPLAY_SECRET";
    const secret = "supersecretvalue123";
    const previous = process.env[key];
    try {
      process.env[key] = secret;
      const recordedWithEnv = AgentRewind.record({
        id: "env-redaction-replay",
        store,
        model: fakeModel([{ content: "ok" }]),
        codec
      });
      await recordedWithEnv.run(async (ctx) => {
        await ctx.model.create(req(secret), { site: "model" });
      });
      await recordedWithEnv.close();

      const meta = await readFile(join(store, "env-redaction-replay", "meta.json"), "utf8");
      expect(meta).not.toContain(secret);

      delete process.env[key];
      const replayWithoutEnv = await AgentRewind.replay(join(store, "env-redaction-replay"), { codec });
      await replayWithoutEnv.run(async (ctx) => {
        await ctx.model.create(req(secret), { site: "model" });
      });

      const recordedWithoutEnv = AgentRewind.record({
        id: "env-redaction-current-env-ignored",
        store,
        model: fakeModel([{ content: "ok" }]),
        codec
      });
      await recordedWithoutEnv.run(async (ctx) => {
        await ctx.model.create(req(secret), { site: "model" });
      });
      await recordedWithoutEnv.close();

      process.env[key] = secret;
      const replayWithNewEnv = await AgentRewind.replay(join(store, "env-redaction-current-env-ignored"), { codec });
      await replayWithNewEnv.run(async (ctx) => {
        await ctx.model.create(req(secret), { site: "model" });
      });
    } finally {
      if (previous === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous;
      }
    }
  });

  it("redacts serialized model and tool errors before storage and restores them on replay", async () => {
    const store = await tempStore();
    const secret = "secret-123";
    const session = AgentRewind.record({
      id: "redacted-errors",
      store,
      model: {
        async create() {
          throw new Error(`model ${secret}`);
        }
      },
      tools: {
        fail: async () => {
          const error = new Error(`tool ${secret}`) as Error & { data?: unknown };
          error.data = { secret };
          throw error;
        }
      },
      codec,
      redaction: { enabled: true, patterns: [/secret-\d+/g] }
    });
    await session.run(async (ctx) => {
      await expect(ctx.model.create(req("model-error"), { site: "model" })).rejects.toThrow(`model ${secret}`);
      await expect(ctx.tools.fail!({ id: 1 })).rejects.toThrow(`tool ${secret}`);
    });
    await session.close();

    const rawEvents = await readFile(join(store, "redacted-errors", "events.jsonl"), "utf8");
    expect(rawEvents).not.toContain(secret);
    expect(rawEvents).toContain("arw:redacted:");

    const replay = await AgentRewind.replay(join(store, "redacted-errors"), { codec });
    await replay.run(async (ctx) => {
      await expect(ctx.model.create(req("model-error"), { site: "model" })).rejects.toThrow(`model ${secret}`);
      await expect(ctx.tools.fail!({ id: 1 })).rejects.toThrow(`tool ${secret}`);
    });
  });

  it("fork with onMiss='error' reports divergence for an unrecorded tool", async () => {
    const store = await tempStore();
    const record = AgentRewind.record({
      id: "fork",
      store,
      model: fakeModel([{ content: "ok" }]),
      tools: { known: async () => ({ ok: true }) },
      codec
    });
    await record.run(async (ctx) => {
      await ctx.model.create(req("prefix"), { site: "model" });
      await ctx.tools.known!({});
    });
    await record.close();
    const replay = await AgentRewind.replay(join(store, "fork"), { codec });
    const toolStep = replay.events().find((event) => event.kind === "tool_call")?.step ?? -1;
    const result = await forkWithHarness(
      replay,
      { atStep: toolStep },
      async (ctx) => {
        await ctx.model.create(req("prefix"), { site: "model" });
        await ctx.tools.unknown!({ id: "unrecorded" });
      }
    );
    expect(result.divergedAtStep).toBe(toolStep);
  });

  it("fork atStep reaches goal when the tail coincides with the recording", async () => {
    const store = await tempStore();
    const record = AgentRewind.record({
      id: "fork-coincident",
      store,
      model: fakeModel([{ content: "prefix" }]),
      tools: { known: async () => ({ ok: true }) },
      codec
    });
    const harness = async (ctx: AgentContext) => {
      await ctx.model.create(req("prefix"), { site: "model" });
      await ctx.tools.known!({ id: 1 });
    };
    await record.run(harness);
    await record.close();
    const toolStep = (await readSession(join(store, "fork-coincident"))).events.find((event) => event.kind === "tool_call")?.step ?? -1;
    const replay = await AgentRewind.replay(join(store, "fork-coincident"), { codec });
    await replay.run(harness);
    const result = await replay.fork({
      atStep: toolStep,
      goal: (trace) => trace.reached("known", { id: 1 })
    });
    expect(result.divergedAtStep).toBeUndefined();
    expect(result.reachedGoal).toBe(true);
    expect(result.tokensSpent).toEqual({ inputTokens: 0, outputTokens: 0 });
    const childReplay = await AgentRewind.replay(join(store, result.sessionId), { codec });
    await childReplay.run(harness);
  });

  it("fork child sessions persist recorded tool prefixes so the full harness replays", async () => {
    const store = await tempStore();
    let toolCalls = 0;
    const tools = defineTools({
      lookup: async (args: { id: number }) => {
        toolCalls += 1;
        return { id: args.id, route: "recorded-prefix" };
      }
    });
    const harness = defineHarness(tools, async (ctx) => {
      const data = await ctx.tools.lookup({ id: 1 });
      return ctx.model.create(req(`route:${data.route}`), { site: "decision" });
    });
    const agent = defineAgent({ tools, harness });
    const record = AgentRewind.record({
      id: "fork-child-full-harness",
      store,
      model: fakeModel([{ content: "old", usage: usage(1, 1) }]),
      tools,
      codec
    });
    await record.run(harness);
    await record.close();
    expect(toolCalls).toBe(1);

    const replay = await AgentRewind.replay(join(store, "fork-child-full-harness"), { codec, tools });
    await replay.run(harness);
    expect(toolCalls).toBe(1);
    const modelStep = replay.events().find((event) => event.kind === "model_call")?.step ?? -1;
    const result = await replay.fork({
      atStep: modelStep,
      harness,
      model: fakeModel([{ content: "new", usage: usage(2, 3) }])
    });
    expect(toolCalls).toBe(1);

    const child = await readSession(join(store, result.sessionId));
    expect(child.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "tool_call", name: "lookup", provenance: "recorded" }),
        expect.objectContaining({ kind: "model_call", provenance: "live" })
      ])
    );

    const childReplay = await AgentRewind.replay(join(store, result.sessionId), { codec, tools });
    await expect(childReplay.run(agent.harness)).resolves.toMatchObject({ content: "new" });
    expect(toolCalls).toBe(1);
  });

  it("fork child sessions preserve recorded prefix entropy lanes so the full harness replays", async () => {
    const store = await tempStore();
    const runtime = { uuid: () => "run-fixed", now: () => 1234, random: () => 0.5 };
    const harness = defineHarness(async (ctx) => {
      const runId = ctx.uuid();
      const observedAt = ctx.clock();
      return ctx.model.create(req(`run:${runId}:at:${observedAt}`), { site: "decision" });
    });
    const record = AgentRewind.record({
      id: "fork-child-entropy-prefix",
      store,
      model: fakeModel([{ content: "old", usage: usage(1, 1) }]),
      codec,
      runtime
    });
    await record.run(harness);
    await record.close();

    const replay = await AgentRewind.replay(join(store, "fork-child-entropy-prefix"), { codec });
    await replay.run(harness);
    const modelStep = replay.events().find((event) => event.kind === "model_call")?.step ?? -1;
    const result = await replay.fork({
      atStep: modelStep,
      harness,
      model: fakeModel([{ content: "new", usage: usage(2, 3) }])
    });

    const child = await readSession(join(store, result.sessionId));
    expect(child.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "entropy", source: "uuid", provenance: "recorded", lane: "0.1" }),
        expect.objectContaining({ kind: "entropy", source: "clock", provenance: "recorded", lane: "0.1" }),
        expect.objectContaining({ kind: "model_call", provenance: "live" })
      ])
    );

    const childReplay = await AgentRewind.replay(join(store, result.sessionId), { codec });
    await expect(childReplay.run(harness)).resolves.toMatchObject({ content: "new" });
  });

  it("fork tool onMiss='stub' tags the tail event with stub provenance", async () => {
    const store = await tempStore();
    const record = AgentRewind.record({
      id: "fork-stub",
      store,
      model: fakeModel([]),
      codec
    });
    await record.run(async () => undefined);
    await record.close();
    const replay = await AgentRewind.replay(join(store, "fork-stub"), { codec });
    const result = await forkWithHarness(
      replay,
      {
        atStep: 0,
        tools: { onMiss: "stub" }
      },
      async (ctx) => {
        const stub = await ctx.tools.missing!({ id: 2 });
        expect(stub).toEqual({ __agentrewind_unavailable: true });
      }
    );
    expect(result.trace.events()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "tool_call",
          name: "missing",
          provenance: "stub"
        })
      ])
    );
  });

  it("fork halts if the harness skips an unconsumed prefix boundary and matches a tail event", async () => {
    const store = await tempStore();
    const record = AgentRewind.record({
      id: "fork-skip-prefix-tail-hit",
      store,
      model: fakeModel([{ content: "prefix" }]),
      tools: { known: async () => ({ ok: true }) },
      codec
    });
    await record.run(async (ctx) => {
      await ctx.model.create(req("prefix"), { site: "prefix" });
      await ctx.tools.known!({ id: 1 });
    });
    await record.close();

    const replay = await AgentRewind.replay(join(store, "fork-skip-prefix-tail-hit"), { codec });
    const prefixStep = replay.events().find((event) => event.kind === "model_call")?.step ?? -1;
    const toolStep = replay.events().find((event) => event.kind === "tool_call")?.step ?? -1;
    const result = await forkWithHarness(
      replay,
      { atStep: toolStep },
      async (ctx) => {
        await ctx.tools.known!({ id: 1 });
      }
    );

    expect(result.divergedAtStep).toBe(prefixStep);
    const child = await readSession(join(store, result.sessionId));
    expect(child.events.some((event) => event.kind === "tool_call")).toBe(false);
  });

  it("fork prefix drift halts before any live tail call", async () => {
    const store = await tempStore();
    const record = AgentRewind.record({
      id: "fork-prefix",
      store,
      model: fakeModel([{ content: "prefix" }, { content: "tail" }]),
      codec
    });
    await record.run(async (ctx) => {
      await ctx.model.create(req("prefix"), { site: "prefix" });
      await ctx.model.create(req("tail"), { site: "tail" });
    });
    await record.close();

    let liveCalls = 0;
    const replay = await AgentRewind.replay(join(store, "fork-prefix"), { codec });
    const prefixStep = replay.events().filter((event) => event.kind === "model_call")[0]?.step ?? -1;
    const tailStep = replay.events().filter((event) => event.kind === "model_call")[1]?.step ?? -1;
    const result = await forkWithHarness(
      replay,
      {
        atStep: tailStep,
        model: {
          async create() {
            liveCalls += 1;
            return { content: "live" };
          }
        }
      },
      async (ctx) => {
        await ctx.model.create(req("changed-prefix"), { site: "prefix" });
      }
    );
    expect(result.divergedAtStep).toBe(prefixStep);
    expect(liveCalls).toBe(0);
  });

  it("fork prefix entropy drift halts without recording live entropy", async () => {
    const store = await tempStore();
    let nextUuid = 0;
    const record = AgentRewind.record({
      id: "fork-prefix-entropy",
      store,
      model: fakeModel([{ content: "prefix" }]),
      codec,
      runtime: { uuid: () => `uuid-${++nextUuid}` }
    });
    await record.run(async (ctx) => {
      const id = ctx.uuid();
      await ctx.model.create(req(id), { site: "after-entropy" });
    });
    await record.close();

    const stored = await readSession(join(store, "fork-prefix-entropy"));
    const entropyStep = stored.events.find((event) => event.kind === "entropy")?.step ?? -1;
    const modelStep = stored.events.find((event) => event.kind === "model_call")?.step ?? -1;
    const replay = await AgentRewind.replay(join(store, "fork-prefix-entropy"), { codec });
    const result = await forkWithHarness(
      replay,
      {
        atStep: modelStep,
        model: fakeModel([{ content: "live" }]),
        runtime: { random: () => 0.9 }
      },
      async (ctx) => {
        ctx.random();
        await ctx.model.create(req("changed"), { site: "after-entropy" });
      }
    );

    expect(result.divergedAtStep).toBe(entropyStep);
    const child = await readSession(join(store, result.sessionId));
    expect(child.events.some((event) => event.kind === "entropy" && event.provenance === "live")).toBe(false);
  });

  it("fork model calls go live with overrides, token accounting, and provenance", async () => {
    const store = await tempStore();
    const record = AgentRewind.record({
      id: "fork-live",
      store,
      model: fakeModel([{ content: "old", usage: usage(1, 1) }]),
      codec
    });
    const harness = async (ctx: AgentContext) => ctx.model.create({ ...req("tail"), system: "old system" }, { site: "decision" });
    await record.run(harness);
    await record.close();
    const replay = await AgentRewind.replay(join(store, "fork-live"), { codec });
    await replay.run(harness);
    const modelStep = replay.events().find((event) => event.kind === "model_call")?.step ?? -1;
    const captured: NormalizedRequest[] = [];
    const liveModel = {
      async create(raw: unknown) {
        captured.push(raw as NormalizedRequest);
        return { content: "new", usage: usage(5, 6) };
      }
    };
    const result = await replay.fork({
      atStep: modelStep,
      model: liveModel,
      overrides: { system: "new system", model: "m2" },
      goal: (trace) => trace.events().some((event) => event.kind === "model_call" && event.provenance === "live")
    });
    expect(captured[0]).toMatchObject({ system: "new system", model: "m2" });
    expect(result.tokensSpent).toEqual({ inputTokens: 5, outputTokens: 6 });
    expect(result.reachedGoal).toBe(true);
  });

  it("fork can use a fresh loaded replay without a harness by walking stored events", async () => {
    const store = await tempStore();
    const record = AgentRewind.record({
      id: "fork-no-harness",
      store,
      model: fakeModel([{ content: "old", usage: usage(1, 1) }]),
      codec
    });
    await record.run(async (ctx) => {
      await ctx.model.create(req("tail"), { site: "tail" });
    });
    await record.close();

    const replay = await AgentRewind.replay(join(store, "fork-no-harness"), { codec });
    const modelStep = replay.events().find((event) => event.kind === "model_call")?.step ?? -1;
    const captured: NormalizedRequest[] = [];
    const result = await replay.fork({
      atStep: modelStep,
      model: {
        async create(raw: unknown) {
          captured.push(raw as NormalizedRequest);
          return { content: "fresh", usage: usage(7, 8) };
        }
      }
    });

    expect(captured[0]).toEqual(req("tail"));
    expect(result.tokensSpent).toEqual({ inputTokens: 7, outputTokens: 8 });
    const child = await readSession(join(store, result.sessionId));
    expect(child.events).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "model_call", provenance: "live" })])
    );
    const childReplay = await AgentRewind.replay(join(store, result.sessionId), { codec });
    await childReplay.run(async (ctx) => ctx.model.create(req("tail"), { site: "tail" }));
  });

  it("trajectory search scores forked results and leaves the selected child replayable with the full harness", async () => {
    const store = await tempStore();
    const tools = {
      policy: async () => ({ tier: "enterprise", renewalAgeDays: 21 })
    };
    const harness = async (ctx: AgentContext) => {
      const policy = (await ctx.tools.policy!({ customerId: "cus_123" })) as { tier: string; renewalAgeDays: number };
      const response = await ctx.model.create<NormalizedResponse>(
        {
          ...req(`tier=${policy.tier}; renewal_age=${policy.renewalAgeDays}`),
          system: "Route support refunds using the policy snapshot."
        },
        { site: "decision" }
      );
      return response.content;
    };
    const record = AgentRewind.record({
      id: "trajectory-search-tool-prefix",
      store,
      model: fakeModel([{ content: "hold", usage: usage(1, 1) }]),
      codec,
      tools
    });
    await record.run(harness);
    await record.close();

    const replay = await AgentRewind.replay(join(store, "trajectory-search-tool-prefix"), { codec, tools });
    await replay.run(harness);
    const modelStep = replay.events().find((event) => event.kind === "model_call")?.step ?? -1;
    const captured: NormalizedRequest[] = [];
    const actionModel = (content: string) => ({
      async create(raw: unknown) {
        captured.push(raw as NormalizedRequest);
        return { content, usage: usage(2, 3) };
      }
    });

    const result = await replay.search<string>({
      atStep: modelStep,
      strategy: "beam",
      budget: { maxRollouts: 2, stopScore: 1 },
      actions: [
        { id: "baseline", label: "Keep current routing", model: actionModel("hold") },
        { id: "escalate", label: "Escalate enterprise exception", model: actionModel("escalate-to-csm") }
      ],
      score: ({ result: forkResult }) => ({
        score: forkResult === "escalate-to-csm" ? 1 : 0,
        reason: String(forkResult)
      })
    });

    expect(result.rollouts).toBe(2);
    expect(result.stoppedReason).toBe("stopScore");
    expect(result.best).toMatchObject({
      action: expect.objectContaining({ id: "escalate" }),
      score: 1,
      result: "escalate-to-csm"
    });
    expect(captured[1]).toMatchObject({ system: "Route support refunds using the policy snapshot." });
    expect(result.tokensSpent).toEqual({ inputTokens: 4, outputTokens: 6 });

    const childReplay = await AgentRewind.replay(result.best!.sessionPath!, { codec, tools });
    await expect(childReplay.run(harness)).resolves.toBe("escalate-to-csm");
  });

  it("trajectory search can run deterministic Monte Carlo rollouts and stop on token budget", async () => {
    const store = await tempStore();
    const harness = async (ctx: AgentContext) => {
      const response = await ctx.model.create<NormalizedResponse>({ ...req("route this ticket"), system: "baseline" }, { site: "decision" });
      return response.content;
    };
    const record = AgentRewind.record({
      id: "trajectory-search-monte-carlo",
      store,
      model: fakeModel([{ content: "hold", usage: usage(1, 1) }]),
      codec
    });
    await record.run(harness);
    await record.close();

    const replay = await AgentRewind.replay(join(store, "trajectory-search-monte-carlo"), { codec });
    await replay.run(harness);
    const modelStep = replay.events().find((event) => event.kind === "model_call")?.step ?? -1;
    const liveModel = {
      async create(raw: unknown) {
        const request = raw as NormalizedRequest;
        return { content: request.system?.includes("good") ? "resolved" : "still-bad", usage: usage(5, 5) };
      }
    };
    const randomValues = [0.1, 0.9];
    const actions: TrajectorySearchAction[] = [
      { overrides: { system: "bad candidate" } },
      { overrides: { system: "good candidate" } }
    ];

    const result = await replay.search<string>({
      atStep: modelStep,
      model: liveModel,
      strategy: "monte-carlo",
      budget: { maxRollouts: 5, maxDepth: 1, maxTokens: 1 },
      random: () => randomValues.shift() ?? 0,
      actions,
      score: ({ result: forkResult }) => (forkResult === "resolved" ? 1 : 0)
    });

    expect(result.rollouts).toBe(1);
    expect(result.stoppedReason).toBe("maxTokens");
    expect(result.best).toMatchObject({
      action: expect.objectContaining({ id: "action-2" }),
      score: 1,
      tokensSpent: { inputTokens: 5, outputTokens: 5 }
    });
  });

  it("trajectory search can use UCB to revisit the highest-scoring candidate", async () => {
    const store = await tempStore();
    const harness = async (ctx: AgentContext) => {
      const response = await ctx.model.create<NormalizedResponse>({ ...req("route this ticket"), system: "baseline" }, { site: "decision" });
      return response.content;
    };
    const record = AgentRewind.record({
      id: "trajectory-search-ucb",
      store,
      model: fakeModel([{ content: "hold", usage: usage(1, 1) }]),
      codec
    });
    await record.run(harness);
    await record.close();

    const replay = await AgentRewind.replay(join(store, "trajectory-search-ucb"), { codec });
    await replay.run(harness);
    const modelStep = replay.events().find((event) => event.kind === "model_call")?.step ?? -1;
    const liveModel = {
      async create(raw: unknown) {
        const request = raw as NormalizedRequest;
        return { content: request.system === "escalate" ? "resolved" : "hold", usage: usage(1, 1) };
      }
    };

    const result = await replay.search<string>({
      atStep: modelStep,
      model: liveModel,
      strategy: "ucb",
      budget: { maxRollouts: 4, explorationWeight: 0 },
      actions: [
        { id: "hold", overrides: { system: "hold" } },
        { id: "escalate", overrides: { system: "escalate" } }
      ],
      score: ({ result: forkResult }) => (forkResult === "resolved" ? 1 : 0)
    });

    const actionCounts = result.nodes
      .filter((node) => node.id !== "root")
      .reduce<Record<string, number>>((counts, node) => {
        const id = node.action?.id ?? "unknown";
        counts[id] = (counts[id] ?? 0) + 1;
        return counts;
      }, {});
    const lastEscalate = result.nodes.filter((node) => node.action?.id === "escalate").at(-1);

    expect(result.rollouts).toBe(4);
    expect(actionCounts).toEqual({ hold: 1, escalate: 3 });
    expect(result.best?.action?.id).toBe("escalate");
    expect(lastEscalate).toMatchObject({ visits: 3, valueSum: 3, meanScore: 1 });
  });

  it("trajectory search can use MCTS to build and replay a multi-step fork", async () => {
    const store = await tempStore();
    const harness = async (ctx: AgentContext) => {
      const response = await ctx.model.create<NormalizedResponse>({ ...req("route this ticket"), system: "baseline" }, { site: "decision" });
      return response.content;
    };
    const record = AgentRewind.record({
      id: "trajectory-search-mcts",
      store,
      model: fakeModel([{ content: "hold", usage: usage(1, 1) }]),
      codec
    });
    await record.run(harness);
    await record.close();

    const replay = await AgentRewind.replay(join(store, "trajectory-search-mcts"), { codec });
    await replay.run(harness);
    const modelStep = replay.events().find((event) => event.kind === "model_call")?.step ?? -1;
    const liveModel = {
      async create(raw: unknown) {
        const request = raw as NormalizedRequest;
        const fixedPrompt = request.system === "escalate enterprise refund exceptions";
        const strongModel = request.model === "strong-router";
        return { content: fixedPrompt && strongModel ? "resolved" : fixedPrompt ? "closer" : "hold", usage: usage(1, 1) };
      }
    };

    const result = await replay.search<string>({
      atStep: modelStep,
      model: liveModel,
      strategy: "mcts",
      budget: { maxRollouts: 4, maxDepth: 2, explorationWeight: 0 },
      actions: ({ depth }) =>
        depth === 1
          ? [
              { id: "baseline-prompt", overrides: { system: "baseline" } },
              { id: "escalate-prompt", overrides: { system: "escalate enterprise refund exceptions" } }
            ]
          : [
              { id: "same-model", overrides: { model: "m" } },
              { id: "strong-model", overrides: { model: "strong-router" } }
            ],
      score: ({ result: forkResult }) => (forkResult === "resolved" ? 1 : forkResult === "closer" ? 0.25 : 0)
    });

    expect(result.rollouts).toBe(4);
    expect(result.best).toMatchObject({
      depth: 2,
      score: 1,
      result: "resolved"
    });
    expect(result.best?.actionSequence.map((action) => action.id)).toEqual(["escalate-prompt", "strong-model"]);
    expect(result.best?.visits).toBe(1);

    const selectedHarness = async (ctx: AgentContext) => {
      const response = await ctx.model.create<NormalizedResponse>(
        { ...req("route this ticket"), system: "escalate enterprise refund exceptions", model: "strong-router" },
        { site: "decision" }
      );
      return response.content;
    };
    const childReplay = await AgentRewind.replay(result.best!.sessionPath!, { codec });
    await expect(childReplay.run(selectedHarness)).resolves.toBe("resolved");
  });

  it("trajectory search exposes public root parent ids for tree search nodes", async () => {
    const store = await tempStore();
    const harness = async (ctx: AgentContext) => {
      const response = await ctx.model.create<NormalizedResponse>({ ...req("route this ticket"), system: "baseline" }, { site: "decision" });
      return response.content;
    };
    const record = AgentRewind.record({
      id: "trajectory-search-public-parent",
      store,
      model: fakeModel([{ content: "hold", usage: usage(1, 1) }]),
      codec
    });
    await record.run(harness);
    await record.close();

    const replay = await AgentRewind.replay(join(store, "trajectory-search-public-parent"), { codec });
    await replay.run(harness);
    const modelStep = replay.events().find((event) => event.kind === "model_call")?.step ?? -1;

    const result = await replay.search<string>({
      atStep: modelStep,
      model: fakeModel([
        { content: "hold", usage: usage(1, 1) },
        { content: "resolved", usage: usage(1, 1) }
      ]),
      strategy: "mcts",
      budget: { maxRollouts: 2 },
      actions: [
        { id: "hold", overrides: { system: "hold" } },
        { id: "escalate", overrides: { system: "escalate" } }
      ],
      score: ({ result: forkResult }) => (forkResult === "resolved" ? 1 : 0)
    });

    const publicNodes = result.nodes.filter((node) => node.id !== "root");
    expect(publicNodes.map((node) => node.parentId)).toEqual(["root", "root"]);
    expect(publicNodes.some((node) => node.parentId === "t0")).toBe(false);
  });

  it("trajectory search rejects SDK atStep values that are not recorded boundaries", async () => {
    const store = await tempStore();
    const harness = async (ctx: AgentContext) => {
      const response = await ctx.model.create<NormalizedResponse>(req("route this ticket"), { site: "decision" });
      return response.content;
    };
    const record = AgentRewind.record({
      id: "trajectory-search-invalid-step",
      store,
      model: fakeModel([{ content: "hold", usage: usage(1, 1) }]),
      codec
    });
    await record.run(harness);
    await record.close();

    const replay = await AgentRewind.replay(join(store, "trajectory-search-invalid-step"), { codec });
    await replay.run(harness);
    await expect(
      replay.search<string>({
        atStep: 999,
        model: fakeModel([{ content: "resolved", usage: usage(1, 1) }]),
        actions: [{ id: "candidate", overrides: { system: "candidate" } }],
        score: ({ result: forkResult }) => (forkResult === "resolved" ? 1 : 0)
      })
    ).rejects.toThrow(/not a recorded boundary step/);
  });

  it("trajectory search passes current Monte Carlo action sequence as parent context", async () => {
    const store = await tempStore();
    const harness = async (ctx: AgentContext) => {
      const response = await ctx.model.create<NormalizedResponse>({ ...req("route this ticket"), system: "baseline" }, { site: "decision" });
      return response.content;
    };
    const record = AgentRewind.record({
      id: "trajectory-search-monte-carlo-parent",
      store,
      model: fakeModel([{ content: "hold", usage: usage(1, 1) }]),
      codec
    });
    await record.run(harness);
    await record.close();

    const replay = await AgentRewind.replay(join(store, "trajectory-search-monte-carlo-parent"), { codec });
    await replay.run(harness);
    const modelStep = replay.events().find((event) => event.kind === "model_call")?.step ?? -1;
    const seenParents: string[][] = [];

    const result = await replay.search<string>({
      atStep: modelStep,
      model: fakeModel([{ content: "resolved", usage: usage(1, 1) }]),
      strategy: "monte-carlo",
      budget: { maxRollouts: 1, maxDepth: 2 },
      random: () => 0.75,
      actions: ({ depth, parent }) => {
        seenParents.push(parent?.actionSequence.map((action) => action.id ?? "") ?? []);
        return depth === 1
          ? [{ id: "prompt", overrides: { system: "prompt" } }]
          : [{ id: parent?.action?.id === "prompt" ? "model-after-prompt" : "wrong", overrides: { model: "strong" } }];
      },
      score: ({ actionSequence }) => (actionSequence.map((action) => action.id).join(">") === "prompt>model-after-prompt" ? 1 : 0)
    });

    expect(seenParents).toEqual([[], ["prompt"]]);
    expect(result.best?.actionSequence.map((action) => action.id)).toEqual(["prompt", "model-after-prompt"]);
  });

  it("trajectory search can use AlphaZero-style priors to pick the first expansion", async () => {
    const store = await tempStore();
    const harness = async (ctx: AgentContext) => {
      const response = await ctx.model.create<NormalizedResponse>({ ...req("route this ticket"), system: "baseline" }, { site: "decision" });
      return response.content;
    };
    const record = AgentRewind.record({
      id: "trajectory-search-alpha-zero",
      store,
      model: fakeModel([{ content: "hold", usage: usage(1, 1) }]),
      codec
    });
    await record.run(harness);
    await record.close();

    const replay = await AgentRewind.replay(join(store, "trajectory-search-alpha-zero"), { codec });
    await replay.run(harness);
    const modelStep = replay.events().find((event) => event.kind === "model_call")?.step ?? -1;
    const captured: NormalizedRequest[] = [];
    const liveModel = {
      async create(raw: unknown) {
        const request = raw as NormalizedRequest;
        captured.push(request);
        return { content: request.system === "preferred" ? "resolved" : "hold", usage: usage(1, 1) };
      }
    };

    const result = await replay.search<string>({
      atStep: modelStep,
      model: liveModel,
      strategy: "alpha-zero",
      budget: { maxRollouts: 1 },
      actions: [
        { id: "low-prior", prior: 0.01, overrides: { system: "ignored" } },
        { id: "high-prior", prior: 0.99, overrides: { system: "preferred" } }
      ],
      score: ({ result: forkResult }) => (forkResult === "resolved" ? 1 : 0)
    });

    expect(captured[0]).toMatchObject({ system: "preferred" });
    expect(result.best).toMatchObject({
      action: expect.objectContaining({ id: "high-prior" }),
      prior: 0.99,
      score: 1
    });
  });

  it("trajectory search keeps exploring when an MCTS branch has no deeper actions", async () => {
    const store = await tempStore();
    const harness = async (ctx: AgentContext) => {
      const response = await ctx.model.create<NormalizedResponse>({ ...req("route this ticket"), system: "baseline" }, { site: "decision" });
      return response.content;
    };
    const record = AgentRewind.record({
      id: "trajectory-search-terminal-branch",
      store,
      model: fakeModel([{ content: "hold", usage: usage(1, 1) }]),
      codec
    });
    await record.run(harness);
    await record.close();

    const replay = await AgentRewind.replay(join(store, "trajectory-search-terminal-branch"), { codec });
    await replay.run(harness);
    const modelStep = replay.events().find((event) => event.kind === "model_call")?.step ?? -1;
    const liveModel = {
      async create() {
        return { content: "ok", usage: usage(1, 1) };
      }
    };

    const result = await replay.search<string>({
      atStep: modelStep,
      model: liveModel,
      strategy: "mcts",
      // explorationWeight 3 forces UCT to re-simulate the terminal "alpha" branch once and
      // then explore the deeper "beta" branch instead of stopping at the dead end.
      budget: { maxRollouts: 4, maxDepth: 2, explorationWeight: 3 },
      actions: ({ depth, parent }) => {
        if (depth === 1) {
          return [
            { id: "alpha", overrides: { system: "alpha" } },
            { id: "beta", overrides: { system: "beta" } }
          ];
        }
        // The "alpha" branch is terminal: it has no depth-2 actions.
        return parent?.action?.id === "beta" ? [{ id: "beta-deep", overrides: { model: "deep" } }] : [];
      },
      score: ({ actionSequence }) => {
        const ids = actionSequence.map((action) => action.id);
        if (ids.includes("beta-deep")) return 1;
        if (ids.includes("alpha")) return 0.8;
        if (ids.includes("beta")) return 0.4;
        return 0;
      }
    });

    // The dead-end branch did not stop the whole search; the budget was spent and the deeper
    // branch was discovered.
    expect(result.rollouts).toBe(4);
    expect(result.stoppedReason).toBe("maxRollouts");
    expect(result.best?.score).toBe(1);
    expect(result.best?.actionSequence.map((action) => action.id)).toEqual(["beta", "beta-deep"]);

    // The terminal "alpha" branch was re-simulated as a leaf rather than returning undefined.
    const alphaNodes = result.nodes.filter((node) => node.action?.id === "alpha");
    expect(alphaNodes).toHaveLength(2);
    expect(alphaNodes.at(-1)?.visits).toBe(2);

    const branchBySequence = new Map(result.diagnostics.branches.map((branch) => [branch.actionSequence.join(" > "), branch]));
    expect(result.diagnostics.branches[0]).toMatchObject({ actionSequence: ["beta", "beta-deep"], visits: 1, meanScore: 1 });
    expect(result.diagnostics.branches[0]?.key).toMatch(/^beta#.+ > beta-deep#/);
    expect(branchBySequence.get("alpha")).toMatchObject({ visits: 2, valueSum: 1.6, meanScore: 0.8 });
    expect(branchBySequence.get("beta")).toMatchObject({ visits: 1, meanScore: 0.4 });
  });

  it("trajectory search treats a missing AlphaZero prior as 0 when any sibling sets one", async () => {
    const store = await tempStore();
    const harness = async (ctx: AgentContext) => {
      const response = await ctx.model.create<NormalizedResponse>({ ...req("route this ticket"), system: "baseline" }, { site: "decision" });
      return response.content;
    };
    const record = AgentRewind.record({
      id: "trajectory-search-mixed-priors",
      store,
      model: fakeModel([{ content: "hold", usage: usage(1, 1) }]),
      codec
    });
    await record.run(harness);
    await record.close();

    const replay = await AgentRewind.replay(join(store, "trajectory-search-mixed-priors"), { codec });
    await replay.run(harness);
    const modelStep = replay.events().find((event) => event.kind === "model_call")?.step ?? -1;
    const captured: NormalizedRequest[] = [];
    const liveModel = {
      async create(raw: unknown) {
        const request = raw as NormalizedRequest;
        captured.push(request);
        return { content: request.system, usage: usage(1, 1) };
      }
    };

    const result = await replay.search<string>({
      atStep: modelStep,
      model: liveModel,
      strategy: "alpha-zero",
      budget: { maxRollouts: 2, maxDepth: 1 },
      actions: [
        { id: "explicit", prior: 0.8, overrides: { system: "explicit" } },
        { id: "omitted", overrides: { system: "omitted" } }
      ],
      score: ({ result: forkResult }) => (forkResult === "explicit" ? 1 : 0)
    });

    // The explicit prior is normalized to 1.0 and the omitted prior to 0, so the explicit
    // action expands first instead of the old behavior that handed the omitted action 0.556.
    expect(captured[0]).toMatchObject({ system: "explicit" });
    expect(result.rollouts).toBe(2);
    const explicitNode = result.nodes.find((node) => node.action?.id === "explicit");
    const omittedNode = result.nodes.find((node) => node.action?.id === "omitted");
    expect(explicitNode?.prior).toBe(1);
    expect(omittedNode?.prior).toBe(0);
    expect(result.best).toMatchObject({ action: expect.objectContaining({ id: "explicit" }), prior: 1, score: 1 });
  });

  it("trajectory search validates Monte Carlo random values", async () => {
    const store = await tempStore();
    const harness = async (ctx: AgentContext) => {
      const response = await ctx.model.create<NormalizedResponse>({ ...req("route this ticket"), system: "baseline" }, { site: "decision" });
      return response.content;
    };
    const record = AgentRewind.record({
      id: "trajectory-search-random-validation",
      store,
      model: fakeModel([{ content: "hold", usage: usage(1, 1) }]),
      codec
    });
    await record.run(harness);
    await record.close();

    const replay = await AgentRewind.replay(join(store, "trajectory-search-random-validation"), { codec });
    await replay.run(harness);
    const modelStep = replay.events().find((event) => event.kind === "model_call")?.step ?? -1;
    const liveModel = {
      async create(raw: unknown) {
        const request = raw as NormalizedRequest;
        return { content: request.system, usage: usage(1, 1) };
      }
    };
    const actions: TrajectorySearchAction[] = [
      { id: "first", overrides: { system: "first" } },
      { id: "second", overrides: { system: "second" } }
    ];

    const selectedLast = await replay.search<string>({
      atStep: modelStep,
      model: liveModel,
      strategy: "monte-carlo",
      budget: { maxRollouts: 1, maxDepth: 1 },
      random: () => 0.999,
      actions,
      score: ({ action }) => (action?.id === "second" ? 1 : 0)
    });
    expect(selectedLast.rollouts).toBe(1);
    expect(selectedLast.best?.action?.id).toBe("second");

    // Out-of-contract random values fail fast with an actionable message instead of
    // silently biasing the sample or indexing past the candidate array.
    await expect(
      replay.search<string>({
        atStep: modelStep,
        model: liveModel,
        strategy: "monte-carlo",
        budget: { maxRollouts: 1, maxDepth: 1 },
        random: () => 1,
        actions,
        score: ({ action }) => (action?.id === "second" ? 1 : 0)
      })
    ).rejects.toThrow(/random\(\) must return a finite number/);
  });

  it("trajectory search reports branch diagnostics for beam sweeps", async () => {
    const store = await tempStore();
    const harness = async (ctx: AgentContext) => {
      const response = await ctx.model.create<NormalizedResponse>({ ...req("route this ticket"), system: "baseline" }, { site: "decision" });
      return response.content;
    };
    const record = AgentRewind.record({
      id: "trajectory-search-diagnostics",
      store,
      model: fakeModel([{ content: "hold", usage: usage(1, 1) }]),
      codec
    });
    await record.run(harness);
    await record.close();

    const replay = await AgentRewind.replay(join(store, "trajectory-search-diagnostics"), { codec });
    await replay.run(harness);
    const modelStep = replay.events().find((event) => event.kind === "model_call")?.step ?? -1;
    const liveModel = {
      async create(raw: unknown) {
        const request = raw as NormalizedRequest;
        return { content: request.system, usage: usage(1, 1) };
      }
    };

    const result = await replay.search<string>({
      atStep: modelStep,
      model: liveModel,
      strategy: "beam",
      budget: { maxRollouts: 2 },
      actions: [
        { id: "hold", overrides: { system: "hold" } },
        { id: "escalate", overrides: { system: "escalate" } }
      ],
      score: ({ result: forkResult }) => (forkResult === "escalate" ? 1 : 0)
    });

    expect(result.diagnostics.strategy).toBe("beam");
    expect(result.diagnostics.rollouts).toBe(2);
    expect(result.diagnostics.branches).toEqual([
      expect.objectContaining({
        actionSequence: ["escalate"],
        depth: 1,
        visits: 1,
        valueSum: 1,
        meanScore: 1,
        minScore: 1,
        maxScore: 1,
        passCount: 1,
        passRate: 1
      }),
      expect.objectContaining({
        actionSequence: ["hold"],
        depth: 1,
        visits: 1,
        valueSum: 0,
        meanScore: 0,
        minScore: 0,
        maxScore: 0,
        passCount: 0,
        passRate: 0
      })
    ]);
    expect(result.diagnostics.branches[0]?.key).toMatch(/^escalate#/);
    expect(result.bestBranch).toMatchObject({ actionSequence: ["escalate"], meanScore: 1 });
  });

  it("trajectory search helpers run prompt sweeps and regression scoring with stable action keys", async () => {
    const store = await tempStore();
    const harness = async (ctx: AgentContext) => {
      const response = await ctx.model.create<NormalizedResponse>({ ...req("route this ticket"), system: "baseline" }, { site: "decision" });
      return response.content;
    };
    const record = AgentRewind.record({
      id: "trajectory-search-helpers",
      store,
      model: fakeModel([{ content: "hold", usage: usage(1, 1) }]),
      codec
    });
    await record.run(harness);
    await record.close();

    const replay = await AgentRewind.replay(join(store, "trajectory-search-helpers"), { codec });
    await replay.run(harness);
    const modelStep = replay.events().find((event) => event.kind === "model_call")?.step ?? -1;
    const callbacks: string[] = [];
    const liveModel = {
      async create(raw: unknown) {
        const request = raw as NormalizedRequest;
        return { content: request.system?.includes("escalate") ? "escalate-to-csm" : "hold", usage: usage(1, 1) };
      }
    };

    const result = await search.promptSweep<string>(replay, {
      atStep: modelStep,
      model: liveModel,
      strategy: "beam",
      concurrency: 2,
      rateLimit: { maxStarts: 10 },
      prompts: [
        { id: "route", label: "Hold", system: "keep holding", metadata: { family: "baseline" } },
        { id: "route", label: "Escalate", system: "escalate enterprise refunds", metadata: { family: "fix" } }
      ],
      score: ({ result: forkResult }) => ({
        score: forkResult === "escalate-to-csm" ? 1 : 0,
        reason: String(forkResult),
        metadata: { output: String(forkResult) }
      }),
      onRollout: (event) => {
        callbacks.push(`${event.status}:${event.rollout}`);
      },
      onNode: (node) => {
        callbacks.push(`node:${node.rollout}`);
      },
      onBest: (node) => {
        callbacks.push(`best:${node.action?.label}`);
      }
    });

    expect(result.best).toMatchObject({ action: expect.objectContaining({ label: "Escalate" }), score: 1 });
    expect(result.bestBranch).toMatchObject({ actionSequence: ["route"], meanScore: 1, passRate: 1 });
    expect(result.diagnostics.branches).toHaveLength(2);
    expect(new Set(result.diagnostics.branches.map((branch) => branch.key)).size).toBe(2);
    expect(result.diagnostics.branches.every((branch) => branch.key.startsWith("route#"))).toBe(true);
    expect(callbacks).toEqual(expect.arrayContaining(["start:1", "start:2", "node:1", "node:2", "best:Escalate"]));

    const regression = await search.regression<string>(replay, {
      atStep: modelStep,
      model: liveModel,
      actions: [{ id: "fixed", overrides: { system: "escalate enterprise refunds" } }],
      assertions: [
        ({ result: forkResult }) => ({ pass: forkResult === "escalate-to-csm", reason: String(forkResult) }),
        ({ trace }) => trace.reached("missing") === false
      ]
    });
    expect(regression.best).toMatchObject({ score: 1, reason: "escalate-to-csm | check 2: pass" });
  });

  it("trajectory search judge helper redacts, caches, and reports judge usage separately", async () => {
    const store = await tempStore();
    const harness = async (ctx: AgentContext) => {
      const response = await ctx.model.create<NormalizedResponse>({ ...req("secret customer route"), system: "baseline" }, { site: "decision" });
      return response.content;
    };
    const record = AgentRewind.record({
      id: "trajectory-search-judge",
      store,
      model: fakeModel([{ content: "hold", usage: usage(1, 1) }]),
      codec
    });
    await record.run(harness);
    await record.close();

    const replay = await AgentRewind.replay(join(store, "trajectory-search-judge"), { codec });
    await replay.run(harness);
    const modelStep = replay.events().find((event) => event.kind === "model_call")?.step ?? -1;
    const rubric = search.defineJudgeRubric({
      name: "support routing",
      goal: "Prefer an escalation route for enterprise refund exceptions.",
      criteria: ["The output routes to a CSM instead of leaving the customer waiting."]
    });
    const cache = search.createMemoryJudgeCache();
    const judgeInputs: string[] = [];

    const result = await search.judge<string>(replay, {
      atStep: modelStep,
      strategy: "ucb",
      budget: { maxRollouts: 2, explorationWeight: 0 },
      model: fakeModel([
        { content: "secret escalate-to-csm", usage: usage(2, 3) },
        { content: "secret escalate-to-csm", usage: usage(2, 3) }
      ]),
      actions: [{ id: "candidate", overrides: { system: "secret escalation policy" } }],
      rubric,
      cache,
      redact: (value) => value.replace(/secret/g, "[redacted]"),
      judge: async (input) => {
        judgeInputs.push(JSON.stringify(input));
        return {
          score: input.outputText.includes("escalate-to-csm") ? 1 : 0,
          reason: "judge accepted escalation",
          confidence: 0.9,
          criteria: [{ id: "criterion-1", pass: true, score: 1 }],
          metadata: { redacted: !JSON.stringify(input).includes("secret") },
          usage: { inputTokens: 11, outputTokens: 7, costUsd: 0.01 }
        };
      }
    });

    expect(result.rollouts).toBe(2);
    expect(judgeInputs).toHaveLength(1);
    expect(judgeInputs[0]).not.toContain("secret");
    expect(result.tokensSpent).toEqual({ inputTokens: 4, outputTokens: 6 });
    expect(result.judgeUsage).toEqual({ inputTokens: 11, outputTokens: 7, costUsd: 0.01 });
    expect(result.nodes.filter((node) => node.id !== "root").map((node) => node.scoreMetadata)).toEqual([
      expect.objectContaining({ judge: expect.objectContaining({ cacheHit: false }) }),
      expect.objectContaining({ judge: expect.objectContaining({ cacheHit: true }) })
    ]);
  });

  it("trajectory search can continue after rollout errors and persists search metadata", async () => {
    const store = await tempStore();
    const harness = async (ctx: AgentContext) => {
      const response = await ctx.model.create<NormalizedResponse>({ ...req("route this ticket"), system: "baseline" }, { site: "decision" });
      return response.content;
    };
    const record = AgentRewind.record({
      id: "trajectory-search-errors",
      store,
      model: fakeModel([{ content: "hold", usage: usage(1, 1) }]),
      codec
    });
    await record.run(harness);
    await record.close();

    const replay = await AgentRewind.replay(join(store, "trajectory-search-errors"), { codec });
    await replay.run(harness);
    const modelStep = replay.events().find((event) => event.kind === "model_call")?.step ?? -1;

    const result = await replay.search<string>({
      atStep: modelStep,
      strategy: "beam",
      onRolloutError: "continue",
      persist: { id: "search-errors" },
      actions: [
        {
          id: "bad-model",
          model: {
            async create() {
              throw new Error("provider exploded");
            }
          }
        },
        { id: "good-model", model: fakeModel([{ content: "resolved", usage: usage(2, 3) }]) }
      ],
      score: ({ result: forkResult }) => (forkResult === "resolved" ? { score: 1, reason: "resolved", metadata: { route: "ok" } } : 0)
    });

    expect(result.searchId).toBe("search-errors");
    expect(result.searchPath).toBe(join(store, "searches", "search-errors.json"));
    expect(result.rollouts).toBe(2);
    expect(result.nodes.find((node) => node.action?.id === "bad-model")).toMatchObject({
      error: expect.objectContaining({ message: "provider exploded" })
    });
    expect(result.best).toMatchObject({ action: expect.objectContaining({ id: "good-model" }), score: 1 });

    const manifest = JSON.parse(await readFile(result.searchPath!, "utf8"));
    expect(manifest).toMatchObject({
      searchId: "search-errors",
      parentSessionId: "trajectory-search-errors",
      bestSessionId: result.best?.sessionId,
      nodes: expect.arrayContaining([
        expect.objectContaining({ action: expect.objectContaining({ id: "bad-model" }), error: expect.objectContaining({ message: "provider exploded" }) }),
        expect.objectContaining({ action: expect.objectContaining({ id: "good-model" }), scoreMetadata: { route: "ok" } })
      ])
    });

    const child = await readSession(result.best!.sessionPath!);
    expect(child.meta.search).toMatchObject({
      searchId: "search-errors",
      parentSessionId: "trajectory-search-errors",
      nodeId: result.best?.id,
      actionSequence: ["good-model"],
      score: 1
    });
  });

  it("fork records tail entropy into the child session", async () => {
    const store = await tempStore();
    let nextUuid = 0;
    const harness = async (ctx: AgentContext) => {
      const id = ctx.uuid();
      return ctx.model.create(req(id), { site: "tail" });
    };
    const record = AgentRewind.record({
      id: "fork-tail-entropy",
      store,
      model: fakeModel([{ content: "old", usage: usage(1, 1) }]),
      codec,
      runtime: { uuid: () => `uuid-${++nextUuid}` }
    });
    await record.run(harness);
    await record.close();

    const replay = await AgentRewind.replay(join(store, "fork-tail-entropy"), { codec });
    await replay.run(harness);
    const entropyStep = replay.events().find((event) => event.kind === "entropy")?.step ?? -1;
    const result = await replay.fork({
      atStep: entropyStep,
      model: fakeModel([{ content: "new", usage: usage(2, 3) }]),
      runtime: { uuid: () => "uuid-tail" }
    });

    const child = await readSession(join(store, result.sessionId));
    expect(child.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "entropy", source: "uuid", value: "uuid-tail", provenance: "live" }),
        expect.objectContaining({ kind: "model_call", provenance: "live" })
      ])
    );

    const childReplay = await AgentRewind.replay(join(store, result.sessionId), { codec });
    await childReplay.run(harness);
  });

  it("fork records live tail env reads while preserving recorded prefix env reads", async () => {
    const store = await tempStore();
    const previous = process.env.AGENTREWIND_FORK_ENV;
    try {
      process.env.AGENTREWIND_FORK_ENV = "recorded";
      const harness = async (ctx: AgentContext) => {
        const value = ctx.env("AGENTREWIND_FORK_ENV");
        return ctx.model.create(req(value ?? "missing"), { site: "tail" });
      };
      const record = AgentRewind.record({
        id: "fork-env",
        store,
        model: fakeModel([{ content: "old", usage: usage(1, 1) }]),
        codec
      });
      await record.run(harness);
      await record.close();

      const replay = await AgentRewind.replay(join(store, "fork-env"), { codec });
      await replay.run(harness);
      const envStep = replay.events().find((event) => event.kind === "entropy" && event.source === "env")?.step ?? -1;

      process.env.AGENTREWIND_FORK_ENV = "forked";
      const result = await replay.fork({
        atStep: envStep,
        model: fakeModel([{ content: "new", usage: usage(2, 2) }])
      });

      const child = await readSession(join(store, result.sessionId));
      expect(child.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "entropy",
            source: "env",
            key: "AGENTREWIND_FORK_ENV",
            value: "forked",
            provenance: "live"
          })
        ])
      );
    } finally {
      if (previous === undefined) {
        delete process.env.AGENTREWIND_FORK_ENV;
      } else {
        process.env.AGENTREWIND_FORK_ENV = previous;
      }
    }
  });

  it("fork child sessions inherit stored redaction patterns for live tail events", async () => {
    const store = await tempStore();
    const secret = "secret-999";
    const record = AgentRewind.record({
      id: "fork-redaction",
      store,
      model: fakeModel([{ content: "old" }]),
      codec,
      redaction: { enabled: true, patterns: [/secret-\d+/g] }
    });
    const harness = async (ctx: AgentContext) => ctx.model.create(req("tail"), { site: "tail" });
    await record.run(harness);
    await record.close();

    const replay = await AgentRewind.replay(join(store, "fork-redaction"), { codec });
    await replay.run(harness);
    const modelStep = replay.events().find((event) => event.kind === "model_call")?.step ?? -1;
    const result = await replay.fork({
      atStep: modelStep,
      model: fakeModel([{ content: secret }])
    });
    const childEvents = await readFile(join(store, result.sessionId, "events.jsonl"), "utf8");
    expect(childEvents).not.toContain(secret);
    expect(childEvents).toContain("arw:redacted:");
  });

  it("fork tail streaming model calls go live and are recorded", async () => {
    const store = await tempStore();
    const harness = async (ctx: AgentContext) => {
      const chunks: unknown[] = [];
      for await (const chunk of ctx.model.stream(req("tail"), { site: "stream-tail" })) {
        chunks.push(chunk);
      }
      return chunks;
    };
    const record = AgentRewind.record({
      id: "fork-stream",
      store,
      model: streamingModel([{ token: "old" }]),
      codec
    });
    await record.run(harness);
    await record.close();

    let liveStreams = 0;
    const replay = await AgentRewind.replay(join(store, "fork-stream"), { codec });
    await replay.run(harness);
    const modelStep = replay.events().find((event) => event.kind === "model_call")?.step ?? -1;
    const result = await replay.fork({
      atStep: modelStep,
      model: {
        async *stream() {
          liveStreams += 1;
          yield { token: "new" };
        }
      },
      goal: (trace) => trace.events().some((event) => event.kind === "model_call" && event.provenance === "live" && Boolean(event.stream))
    });
    expect(liveStreams).toBe(1);
    expect(result.reachedGoal).toBe(true);
  });

  it("tool serializers handle non-JSON args and results during record and replay", async () => {
    const store = await tempStore();
    const serializers = {
      dates: {
        args: dateSerializer,
        result: dateSerializer
      }
    };
    const record = AgentRewind.record({
      id: "tool-serializers",
      store,
      model: fakeModel([]),
      codec,
      tools: {
        dates: async (value) => new Date((value as Date).getTime() + 1000)
      },
      toolSerializers: serializers
    });
    const input = new Date("2026-01-01T00:00:00.000Z");
    await record.run(async (ctx) => {
      const result = await ctx.tools.dates!(input);
      expect(result).toBeInstanceOf(Date);
    });
    await record.close();

    const rawEvents = await readFile(join(store, "tool-serializers", "events.jsonl"), "utf8");
    expect(rawEvents).toContain('"__agentrewind_type":"Date"');

    let liveCalls = 0;
    const replay = await AgentRewind.replay(join(store, "tool-serializers"), {
      codec,
      toolSerializers: serializers,
      tools: {
        dates: async () => {
          liveCalls += 1;
          return new Date();
        }
      }
    });
    await replay.run(async (ctx) => {
      const result = await ctx.tools.dates!(input);
      expect(result).toBeInstanceOf(Date);
      expect((result as Date).toISOString()).toBe("2026-01-01T00:00:01.000Z");
    });
    expect(liveCalls).toBe(0);
  });

  it("cost accounting totals token and cost usage", () => {
    const events = [
      { kind: "model_call", step: 2, usage: { inputTokens: 1, outputTokens: 2, costUsd: 0.1 } },
      { kind: "note", step: 3 },
      { kind: "model_call", step: 4, usage: { inputTokens: 3, outputTokens: 4, costUsd: 0.2 } }
    ] as const;
    expect(usageByStep(events as unknown as Parameters<typeof usageByStep>[0])).toEqual([
      { step: 2, usage: { inputTokens: 1, outputTokens: 2, costUsd: 0.1 } },
      { step: 4, usage: { inputTokens: 3, outputTokens: 4, costUsd: 0.2 } }
    ]);
    const total = usageTotal(events as unknown as Parameters<typeof usageTotal>[0]);
    expect(usageAdd({ inputTokens: 0, outputTokens: 0, costUsd: 0 }, { inputTokens: 1, outputTokens: 2, costUsd: 0.1 })).toEqual({
      inputTokens: 1,
      outputTokens: 2,
      costUsd: 0.1
    });
    expect(total).toEqual({ inputTokens: 4, outputTokens: 6, costUsd: 0.30000000000000004 });
  });

  it("@agentrewind/test asserts replay by selector and explains drift", async () => {
    const store = await tempStore();
    const record = AgentRewind.record({
      id: "helper",
      store,
      model: fakeModel([{ content: "ok" }]),
      codec
    });
    await record.run(async (ctx) => ctx.model.create(req("same"), { site: "model" }));
    await record.close();

    const helper = await fromSession("latest", { store, codec });
    expect(helper.selector).toBe("latest");
    expect(helper.path).toBe(join(store, "helper"));
    await helper.assertReplay(async (ctx) => ctx.model.create(req("same"), { site: "model" }));
    await helper.assertSemanticTrajectory(async (ctx) => ctx.model.create(req("same"), { site: "model" }));
    await assertReplay("helper", { store, codec }, async (ctx) => ctx.model.create(req("same"), { site: "model" }));
    const drift = await assertReplay("latest", { store, codec }, async (ctx) => ctx.model.create(req("different"), { site: "model" })).catch(
      (error) => error
    );
    expect(drift).toBeInstanceOf(AssertionError);
    expect((drift as Error).message).toContain("What to check:");
    let liveCalls = 0;
    await expect(
      assertReplay(
        "latest",
        {
          store,
          codec,
          driftPolicy: "passthrough",
          model: {
            async create() {
              liveCalls += 1;
              return { content: "live" };
            }
          }
        },
        async (ctx) => ctx.model.create(req("different"), { site: "model" })
      )
    ).rejects.toBeInstanceOf(AssertionError);
    expect(liveCalls).toBe(0);
  });

  it("a vN fixture migrates to the current schema via the migration registry", async () => {
    registerMigration(0, (event) => ({ ...event, schemaVersion: CURRENT_SCHEMA_VERSION }));
    const store = await tempStore();
    const session = join(store, "migration");
    await mkdir(session, { recursive: true });
    await writeFile(
      join(session, "meta.json"),
      `${JSON.stringify({
        id: "migration",
        createdAt: 1,
        agentRewindVersion: "0.0.0",
        schemaVersion: CURRENT_SCHEMA_VERSION,
        provider: "synthetic",
        fingerprintMode: "strict",
        redaction: { enabled: true, patterns: [] },
        eventsHash: ""
      })}\n`
    );
    await writeFile(
      join(session, "events.jsonl"),
      `${JSON.stringify({
        seq: 0,
        step: 0,
        ts: 1,
        lane: "0",
        callSite: "fixture",
        kind: "note",
        schemaVersion: 0,
        text: "old"
      })}\n`
    );
    const stored = await readSession(session);
    expect(stored.events[0]?.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });

  it("readSession rejects events.jsonl when it no longer matches meta.eventsHash", async () => {
    const store = await tempStore();
    const record = AgentRewind.record({
      id: "integrity",
      store,
      model: fakeModel([{ content: "ok" }]),
      codec
    });
    await record.run(async (ctx) => {
      await ctx.model.create(req("ok"), { site: "model" });
    });
    await record.close();
    await writeFile(join(store, "integrity", "events.jsonl"), `${await readFile(join(store, "integrity", "events.jsonl"), "utf8")}\n`);
    await expect(readSession(join(store, "integrity"))).rejects.toBeInstanceOf(SessionStoreError);
    await expect(readSession(join(store, "integrity"))).rejects.toThrow("events hash");
  });

  it("readSession explains missing and malformed session directories", async () => {
    const store = await tempStore();

    const missing = await readSession(join(store, "missing-session")).catch((error) => error);
    expect(missing).toBeInstanceOf(SessionStoreError);
    const missingExplanation = explainRewindError(missing);
    expect(missingExplanation).toContain("No AgentRewind session found");
    expect(missingExplanation).toContain("Expected to find `meta.json`");
    expect(missingExplanation).toContain("Pass the full session directory");
    expect(missingExplanation).not.toContain("ENOENT");

    const malformed = join(store, "malformed-session");
    await mkdir(malformed, { recursive: true });
    await writeFile(join(malformed, "meta.json"), "{not json");
    await writeFile(join(malformed, "events.jsonl"), "");
    const malformedError = await readSession(malformed).catch((error) => error);
    expect(malformedError).toBeInstanceOf(SessionStoreError);
    expect(explainRewindError(malformedError)).toContain("Session meta.json is not valid JSON");
  });

  it("vault randomness is injectable for deterministic tests", async () => {
    const restore = setVaultCryptoForTests({ randomBytes: (size) => Buffer.alloc(size, 7) });
    try {
      const store = await tempStore();
      const record = AgentRewind.record({
        id: "vault-crypto",
        store,
        model: fakeModel([{ content: "secret-777" }]),
        codec,
        redaction: { enabled: true, patterns: [/secret-\d+/g] }
      });
      await record.run(async (ctx) => {
        await ctx.model.create(req("ok"), { site: "model" });
      });
      await record.close();
      expect(await readFile(join(store, "vault-crypto", "vault.enc"))).toBeInstanceOf(Buffer);
    } finally {
      restore();
    }
  });

  it("readSession fails closed when encrypted vault material is missing or malformed", async () => {
    const store = await tempStore();
    const missingKey = AgentRewind.record({
      id: "vault-missing-key",
      store,
      model: fakeModel([{ content: "secret-111" }]),
      codec,
      redaction: { enabled: true, patterns: [/secret-\d+/g] }
    });
    await missingKey.run(async (ctx) => {
      await ctx.model.create(req("secret-111"), { site: "model" });
    });
    await missingKey.close();
    await rm(join(store, "vault-missing-key", "vault.enc.key"));
    await expect(readSession(join(store, "vault-missing-key"))).rejects.toBeInstanceOf(VaultError);
    await expect(readSession(join(store, "vault-missing-key"))).rejects.toThrow("Missing local vault key");

    const malformedVault = AgentRewind.record({
      id: "vault-malformed",
      store,
      model: fakeModel([{ content: "secret-222" }]),
      codec,
      redaction: { enabled: true, patterns: [/secret-\d+/g] }
    });
    await malformedVault.run(async (ctx) => {
      await ctx.model.create(req("secret-222"), { site: "model" });
    });
    await malformedVault.close();
    await writeFile(join(store, "vault-malformed", "vault.enc"), "not-a-vault", "utf8");
    await expect(readSession(join(store, "vault-malformed"))).rejects.toBeInstanceOf(VaultError);
    await expect(readSession(join(store, "vault-malformed"))).rejects.toThrow("Unsupported vault format");
  });

  it("saveVault refuses to replace invalid local vault keys", async () => {
    const store = await tempStore();
    const vaultPath = join(store, "vault.enc");
    await writeFile(`${vaultPath}.key`, "short", "utf8");
    const vault = new Vault();
    vault.add("arw:redacted:test", "secret-value");

    await expect(saveVault(vaultPath, vault)).rejects.toBeInstanceOf(VaultError);
    await expect(readFile(`${vaultPath}.key`, "utf8")).resolves.toBe("short");
    await expect(readFile(vaultPath)).rejects.toThrow();
  });

  it("purity lint flags an un-wrapped fs.writeFile during recording with the call site", async () => {
    const store = await tempStore();
    const outPath = join(store, "outside.txt");
    const record = AgentRewind.record({
      id: "purity",
      store,
      model: fakeModel([]),
      codec,
      purityLint: true
    });
    await expect(
      record.run(async () => {
        await writeFile(outPath, "unsanctioned");
      })
    ).rejects.toMatchObject({
      name: "PurityLintError",
      data: {
        diagnostics: expect.arrayContaining([
          expect.objectContaining({
            kind: "fs",
            callSite: expect.stringContaining("core.test.ts")
          })
        ])
      }
    });
    await rm(outPath, { force: true });
    expect(PurityLintError).toBeDefined();
  });
});

function req(content: string): NormalizedRequest {
  return {
    model: "m",
    messages: [{ role: "user", content }],
    params: { temperature: 0 }
  };
}

function fakeModel(responses: NormalizedResponse[]): { create(req: unknown): Promise<unknown>; stream(): AsyncIterable<unknown> } {
  const queue = [...responses];
  return {
    async create() {
      const next = queue.shift();
      if (!next) {
        throw new Error("No fake response queued");
      }
      return next;
    },
    async *stream() {
      yield { type: "chunk" };
    }
  };
}

function streamingModel(chunks: unknown[]): { create(req: unknown): Promise<unknown>; stream(): AsyncIterable<unknown> } {
  return {
    async create() {
      throw new Error("Unexpected create call");
    },
    async *stream() {
      for (const chunk of chunks) {
        yield chunk;
      }
    }
  };
}

const dateSerializer: ToolValueSerializer = {
  serialize(value) {
    if (!(value instanceof Date)) {
      throw new SerializationError("Expected Date for test serializer", { value });
    }
    return { __agentrewind_type: "Date", value: value.toISOString() };
  },
  deserialize(value) {
    if (value === null || typeof value !== "object" || (value as Record<string, unknown>).__agentrewind_type !== "Date") {
      throw new SerializationError("Expected serialized Date for test serializer", { value });
    }
    return new Date(String((value as Record<string, unknown>).value));
  }
};

function forkWithHarness(replay: Replay, opts: ForkOptions, harness: Harness<unknown>): Promise<ForkResult> {
  return replay.fork({ ...opts, harness });
}

function usage(inputTokens: number, outputTokens: number): Usage {
  return { inputTokens, outputTokens };
}

async function tempStore(): Promise<string> {
  return mkdtemp(join(tmpdir(), "agentrewind-"));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildTestTar(entries: { name: string; data: string; type?: string }[]): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const body = Buffer.from(entry.data, "utf8");
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100, "utf8");
    header.write("0000644\0", 100, 8, "ascii");
    header.write("0000000\0", 108, 8, "ascii");
    header.write("0000000\0", 116, 8, "ascii");
    header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
    header.write("00000000000\0", 136, 12, "ascii");
    header.fill(0x20, 148, 156);
    header.write(entry.type ?? "0", 156, 1, "ascii");
    let checksum = 0;
    for (const byte of header) {
      checksum += byte;
    }
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    chunks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}
