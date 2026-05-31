# AgentRewind — Build Specification

---

## 1. Objective

Build `agentrewind`: a TypeScript library + CLI that **records** an LLM agent run, **replays** it deterministically offline, and **forks** it from any step. It works by intercepting three boundary types — model calls, tool calls, and entropy draws (time/random/uuid) — recording their inputs/outputs, and on replay serving the recorded outputs instead of making live calls.

**Invariant that defines correctness:** a replayed run MUST produce an *identical boundary-event trajectory* (same calls, in the same per-lane order, with the same request fingerprints) as the recording, given the same harness code, with zero live model/tool calls.

---

## 2. Tech constraints

- **Language:** TypeScript 5.x, `strict: true`. No `any` in any exported signature.
- **Modules:** ESM only. Named exports. No default exports.
- **Runtime:** Node ≥ 20.
- **`@agentrewind/core` runtime dependencies:** NONE. Use Node built-ins only (`node:crypto`, `node:async_hooks`, `node:fs/promises`, `node:path`, `node:zlib`). This is a hard requirement.
- **CLI:** MAY use one small argument parser dependency.
- **Codec/tests:** `@anthropic-ai/sdk` as a dev/peer dependency for the first codec and its tests.
- **Build:** `tsup` (or `tsc` + `tsc --build`). **Test runner:** `vitest`.
- **Versions:** Install current stable versions at implementation time. Do NOT hardcode version numbers from this document.
- **Determinism:** core logic MUST be free of ambient nondeterminism. Any clock/random/uuid the *library itself* needs MUST be injectable for tests.

---

## 3. Repo layout

pnpm monorepo. Create exactly:

```
agentrewind/
  package.json                     # workspace root
  pnpm-workspace.yaml
  tsconfig.base.json
  vitest.config.ts
  packages/
    sdk/                           # umbrella: re-exports @agentrewind/core public API
      package.json                 # name "@agentrewind/sdk"; depends on core; bin -> cli
    core/                          # @agentrewind/core
      src/
        index.ts                   # public API surface (§6)
        events.ts                  # event types (§5)
        session-store.ts           # read/write JSONL + blobs + meta + vault (§5, §11)
        fingerprint.ts             # canonicalization + hashing (§7)
        matcher.ts                 # PendingStore + resolve() (§8)
        record.ts                  # Session + record-mode ctx (§9)
        replay.ts                  # Replay + replay-mode ctx (§10)
        fork.ts                    # fork engine (§10.4)
        context.ts                 # AgentContext construction for all 3 modes (§9.1)
        entropy.ts                 # clock/random/uuid virtualization (§9.2)
        redaction.ts               # deterministic redactor + vault (§11)
        migrate.ts                 # schemaVersion migration registry (§5.4)
        tokens.ts                  # tiered token counting (§10.3)
        errors.ts                  # typed error classes (§12)
        codec.ts                   # ProviderCodec interface (§9.5)
      test/                        # vitest specs (§13 acceptance tests)
    codec-anthropic/               # @agentrewind/codec-anthropic
      src/index.ts                 # implements ProviderCodec by reading the installed SDK types
    cli/                           # @agentrewind/cli
      src/index.ts                 # record/replay/inspect/diff/pack (§12)
```

---

## 4. Glossary (terse, normative)

- **Boundary:** an intercepted external interaction — a model call, a tool call, or an entropy draw.
- **Lane:** an async-execution context id from `AsyncLocalStorage`. Root lane = `"0"`. Each `Promise.all` branch etc. gets a child lane id.
- **`seq`:** per-lane monotonic integer, assigned at the moment a boundary is **initiated** (not when it resolves).
- **`callSite`:** a stable string identifying *where in the harness* a call originated (§8.2).
- **Fingerprint:** SHA-256 hex of the canonicalized, redacted request (§7).
- **Session:** a recorded run on disk (§5.5).
- **Step:** an index into the linearized boundary order (root-lane view). `stepTo(n)`, fork `atStep`, drift reports all use this index.

---

## 5. Data model

### 5.1 Event types (`events.ts`)

```ts
export type Hash = string;             // 64-char lowercase sha256 hex
export type EventKind =
  | "session_start" | "model_call" | "tool_call" | "entropy" | "note" | "session_end";

export interface BaseEvent {
  seq: number;            // per-lane, assigned at initiation
  step: number;           // global linearized index (root-lane view)
  ts: number;             // wall-clock ms; informational only; MUST NOT affect matching
  lane: string;
  callSite: string;
  kind: EventKind;
  schemaVersion: number;
}

export interface ModelCallEvent extends BaseEvent {
  kind: "model_call";
  provider: string;
  request: NormalizedRequest;          // §9.5
  requestHash: Hash;
  response?: NormalizedResponse;       // present unless `error`
  error?: SerializedError;
  stream?: ChunkRecord[];              // present iff the call streamed
  usage?: Usage;
  latencyMs: number;
  blobs: Record<string, Hash>;         // path-in-event -> blob hash for externalized large fields
}

export interface ToolCallEvent extends BaseEvent {
  kind: "tool_call";
  name: string;
  args: unknown;                       // serializable per §9.4
  argsHash: Hash;
  result?: unknown;
  error?: SerializedError;
  stream?: ChunkRecord[];              // present iff the tool streamed
  latencyMs: number;
  blobs: Record<string, Hash>;
}

export interface EntropyEvent extends BaseEvent {
  kind: "entropy";
  source: "clock" | "random" | "uuid";
  value: number | string;              // exact value to replay
}

export interface NoteEvent extends BaseEvent { kind: "note"; text: string; }
export interface SessionStartEvent extends BaseEvent { kind: "session_start"; meta: SessionMeta; }
export interface SessionEndEvent extends BaseEvent { kind: "session_end"; ok: boolean; }

export type RewindEvent =
  | ModelCallEvent | ToolCallEvent | EntropyEvent | NoteEvent
  | SessionStartEvent | SessionEndEvent;

export interface ChunkRecord { offsetMs: number; data: unknown; } // data is codec-shaped
export interface Usage { inputTokens: number; outputTokens: number; costUsd?: number; }
export interface SerializedError { name: string; message: string; stack?: string; data?: unknown; }
```

### 5.2 Normalized provider types (`events.ts`)

Provider-neutral. Codecs map to/from real SDK shapes. Keep minimal; extend per codec needs.

```ts
export interface NormalizedMessage { role: "system" | "user" | "assistant" | "tool"; content: unknown; }
export interface NormalizedRequest {
  model: string;
  system?: string;
  messages: NormalizedMessage[];
  params: Record<string, unknown>;     // temperature, max_tokens, tools spec, etc.
}
export interface NormalizedResponse {
  content: unknown;                    // codec-defined content blocks
  stopReason?: string;
  usage?: Usage;
  raw?: unknown;                       // optional original for debugging; NOT used in matching
}
```

### 5.3 `SessionMeta`

```ts
export interface SessionMeta {
  id: string;
  parent?: string;                     // set on forked sessions
  forkedAtStep?: number;
  createdAt: number;
  agentRewindVersion: string;
  schemaVersion: number;
  provider: string;
  fingerprintMode: "strict" | "structural";
  redaction: { enabled: boolean; patterns: string[] };
  eventsHash: Hash;                    // hash of events.jsonl, written on close
}
```

### 5.4 Format versioning (`migrate.ts`)

- `CURRENT_SCHEMA_VERSION` is a constant in `core`.
- On read, if `event.schemaVersion < CURRENT`, run registered forward-migrations in order until current. Migrations are pure functions `(event) => event`.
- A breaking format change increments the major version of `core` and `CURRENT_SCHEMA_VERSION`. Read-migrations MUST be retained for ≥ 1 major version back.

### 5.5 On-disk layout

```
<store>/<session-id>/
  meta.json          # SessionMeta
  events.jsonl       # one RewindEvent per line, in record (initiation) order
  blobs/<hash>       # content-addressed payloads (sha256 of stored bytes)
  vault.enc          # encrypted secret<->token map (§11); NEVER included in pack output
```

- A **packed session** is a single gzip tarball `<name>.rewind` containing `meta.json`, `events.jsonl`, `blobs/` — and explicitly NOT `vault.enc`.
- Blobs are addressed by SHA-256 of their **stored** (post-redaction) bytes. Any event field whose serialized size exceeds `BLOB_THRESHOLD_BYTES` (default 16384) MUST be externalized to a blob and referenced in `event.blobs`.

---

## 6. Public API (`core/src/index.ts`)

```ts
export const AgentRewind: {
  record(opts: RecordOptions): Session;
  replay(sessionPath: string, opts?: ReplayOptions): Promise<Replay>;
};

export interface RecordOptions {
  id?: string;                         // default: generated
  store: string;                       // directory
  model: unknown;                      // live provider client to wrap
  tools?: ToolHandlers;
  codec: ProviderCodec;
  redaction?: RedactionConfig;
  fingerprintMode?: "strict" | "structural"; // default "strict"
  purityLint?: boolean;                // default false
}

export interface ReplayOptions {
  model?: unknown;                     // live client; REQUIRED for fork/passthrough, else omit
  tools?: ToolHandlers;
  codec: ProviderCodec;
  driftPolicy?: "strict" | "warn" | "passthrough"; // default "strict"
}

export interface Session {
  readonly id: string;
  run<T>(harness: Harness<T>): Promise<T>;
  wrapModel(client: unknown): WrappedModel;   // low-level alternative to run()
  wrapTools(handlers: ToolHandlers): ToolHandlers;
  note(text: string): void;
  close(): Promise<void>;                      // flush events/blobs/meta/vault
  pack(outPath: string): Promise<void>;        // vault excluded
}

export interface Replay {
  run<T>(harness: Harness<T>): Promise<T>;
  events(): RewindEvent[];
  stepTo(n: number): void;
  contextAt(n: number): NormalizedMessage[];   // prompt context at step n
  diffContext(a: number, b: number): ContextDiff;
  fork(opts: ForkOptions): Promise<ForkResult>;
}

export type Harness<T = unknown> = (ctx: AgentContext) => Promise<T>;
```

### 6.1 `AgentContext` (the harness contract)

```ts
export interface AgentContext {
  model: WrappedModel;                 // record: live+capture · replay: serve recorded · fork: per-mode
  tools: ToolHandlers;
  clock(): number;                     // entropy virtualized HERE
  random(): number;
  uuid(): string;
  env(key: string): string | undefined;
  note(text: string): void;
}
export type ToolHandlers = Record<string, (args: any) => Promise<unknown> | AsyncIterable<unknown>>;
export interface WrappedModel {
  create(req: unknown, opts?: { site?: string }): Promise<unknown>;
  stream(req: unknown, opts?: { site?: string }): AsyncIterable<unknown>;
}
```

- The harness MUST obtain time/randomness/uuids from `ctx`, never from globals. (The purity lint and the entropy tests enforce this.)
- `ctx.model`/`ctx.tools` are the only sanctioned I/O surfaces; any other I/O re-executes on replay and is the user's responsibility (document this).

### 6.2 Fork / diff types

```ts
export interface ForkOptions {
  atStep: number;
  overrides?: ForkOverrides;
  tools?: { onMatch?: "serve-recorded" | "live"; onMiss?: "error" | "stub" | "simulate" | "live" };
  goal?: (trace: Trace) => boolean;
  sandbox?: Sandbox;                   // REQUIRED if any policy resolves to "live"
}
export interface ForkOverrides {
  system?: string;
  model?: string;
  transformRequest?: (req: NormalizedRequest, step: number) => NormalizedRequest;
}
export interface ForkResult {
  sessionId: string;
  reachedGoal?: boolean;               // undefined if no goal given
  tokensSpent: Usage;
  divergedAtStep?: number;             // set when onMiss="error" halted the fork
  trace: Trace;
}
export interface Trace {
  events(): RewindEvent[];
  reached(toolName: string, argsMatch?: Record<string, unknown>): boolean;
}
export interface ContextDiff {
  added: NormalizedMessage[];
  removed: NormalizedMessage[];
  tokenDelta: number;
  tokenDeltaIsEstimate: boolean;
}
export interface Sandbox { /* opaque in MVP; presence gates "live" policies. */ }
```

---

## 7. Fingerprinting (`fingerprint.ts`)

`fingerprint(req: NormalizedRequest, codec, redactor, mode): Hash` — deterministic. Steps, in order:

1. `req = codec.stripVolatile(req)` — remove provider-volatile fields (returns a copy; does not mutate).
2. If `mode === "structural"`, replace the leaf *values* (not keys) of fields flagged volatile by the codec with the constant `"\u0000"`.
3. Apply `redactor.redactDeep(req)` — replace secret substrings in all string leaves with deterministic tokens (§11). Same secret → same token, always.
4. **Canonicalize:** produce canonical JSON:
   - object keys sorted lexicographically (recursively);
   - numbers serialized via shortest round-trip (`String(Number(x))`), `-0` → `0`, reject `NaN`/`Infinity` (throw `FingerprintError`);
   - strings NFC-normalized;
   - no insignificant whitespace.
5. `return sha256hex(utf8Bytes(canonicalJson))`.

Tool calls use the same algorithm over `args` to produce `argsHash`.

**MUST hold:** `fingerprint(R) === fingerprint(R')` whenever R and R' are logically identical, on both record and replay, regardless of key order, cosmetic number formatting, or secret values.

---

## 8. The matcher (`matcher.ts`)

### 8.1 Resolution

```ts
type ResolveCtx = { kind: "model_call" | "tool_call"; callSite: string; lane: string };
type Resolution = { hit: RewindEvent } | { miss: { fp: Hash; callSite: string } };

class PendingStore {
  // Built from a loaded session: events grouped into FIFO buckets keyed by
  //   primary:  `${kind}\u0000${callSite}\u0000${fp}`
  //   fallback: `${kind}\u0000${fp}`
  // Each event is inserted into BOTH its primary and fallback bucket (same object reference).
  resolve(fp: Hash, ctx: ResolveCtx): Resolution;     // pops from primary bucket if present, else fallback
  expectedNextSeq(lane: string): number;              // next unconsumed seq within a lane
}
```

- `resolve` MUST pop the matched event from *all* buckets it appears in (use a `consumed` flag to avoid double-serving).
- On a hit, if a per-lane sequential check is enabled and `ctx.lane === ev.lane` and `ev.seq !== expectedNextSeq(ev.lane)`, emit a `reorder` diagnostic (non-fatal).
- On a miss, return `{ miss }`; the caller applies the drift policy (replay) or fork-miss policy (fork).

### 8.2 `callSite` derivation, in priority order

1. Explicit `opts.site` passed to `ctx.model.create/stream`.
2. A normalized stack-trace fingerprint captured at call time (strip line/column noise; keep function + file basenames).
3. Per-`(kind, lane)` ordinal counter.

Matching with the primary key (incl. callSite) is a strengthening; the fallback key keeps matching working when callSite is absent or shifts.

---

## 9. Recording (`record.ts`, `context.ts`, `entropy.ts`, `codec.ts`)

### 9.1 Record-mode ctx
`Session.run(harness)` builds an `AgentContext` whose:
- `model` wraps the live client via the codec's intercept points; each call: enter/create a lane (via `AsyncLocalStorage`), assign per-lane `seq` and global `step` at initiation, normalize the request, compute fingerprint, call live, capture the response (assemble stream chunks if streaming), record a `model_call` event, return the live response unchanged to the harness.
- `tools` wraps each handler analogously (`tool_call` events).
- `clock/random/uuid` are recorded via §9.2.
- `env(k)` returns `process.env[k]` and (SHOULD) records a `note` for auditing; values that match redaction patterns are tokenized in storage.

`close()` writes `events.jsonl`, blobs, `vault.enc`, then `meta.json` (with `eventsHash`).

### 9.2 Entropy virtualization (`entropy.ts`)
- Record mode: `clock()` calls real `Date.now()`, records an `EntropyEvent{source:"clock", value}`, returns it. Same pattern for `random()` (→ `Math.random()`), `uuid()` (→ `crypto.randomUUID()`).
- Replay/fork prefix: each accessor pops the next unconsumed `EntropyEvent` of the matching `source` within the current lane (FIFO) and returns its `value`. On miss → drift policy.
- This makes any request built from these values reproduce identically (so fingerprints match).

### 9.3 Streaming
- The codec converts a provider stream into `{ final: NormalizedResponse, chunks: ChunkRecord[] }`. `chunks[i].offsetMs` is relative to stream start.
- Replay returns a codec-rebuilt async iterable yielding recorded chunks: instantly by default; if `preserveTiming` is set, await each `offsetMs`. The assembled `final` is also available.

### 9.4 Tool serialization
- Tool `args`/`result` MUST be JSON-serializable, or a user-registered (de)serializer MUST handle them.
- Streaming tools (async iterables) are recorded as `ChunkRecord[]` and re-emitted on replay.
- Non-serializable returns (file handles, sockets) → throw `SerializationError` at record time. Do NOT silently record a broken value.

### 9.5 Provider codec interface (`codec.ts`)

```ts
export interface ProviderCodec {
  name: string;
  interceptPoints: string[];                 // SDK method paths to wrap, e.g. ["messages.create","messages.stream"]
  normalizeRequest(raw: unknown): NormalizedRequest;
  denormalizeRequest(req: NormalizedRequest): unknown;     // rebuild SDK args for live calls (fork/passthrough)
  normalizeResponse(raw: unknown): NormalizedResponse;
  normalizeStream(rawChunks: unknown[]): { final: NormalizedResponse; chunks: ChunkRecord[] };
  rebuildStream(chunks: ChunkRecord[]): AsyncIterable<unknown>;
  stripVolatile(req: NormalizedRequest): NormalizedRequest;
  volatileLeafPaths(): string[];             // for "structural" mode
  extractUsage(resp: NormalizedResponse): Usage | undefined;
  applyOverrides(req: NormalizedRequest, o: ForkOverrides, step: number): NormalizedRequest;
}
```

> **Implementing the Anthropic codec:** read the installed `@anthropic-ai/sdk` types and map them. Do NOT infer request/response/stream shapes from this document or from training data — verify against the SDK source/types in the repo.

---

## 10. Replay, inspection, fork (`replay.ts`, `fork.ts`, `tokens.ts`)

### 10.1 Replay engine
- `AgentRewind.replay(path)` loads the session, runs migrations, builds a `PendingStore`.
- `Replay.run(harness)` builds a **replay-mode ctx**: `model`/`tools`/entropy accessors call `matcher.resolve`. On hit → return the recorded value (responses/tool-results are de-tokenized via the vault first, §11). On miss → drift policy:
  - `strict`: throw `DriftError` with `{ step, expectedCallSite?, actualFingerprint }`.
  - `warn`: log the drift, attempt fallback-key match, else throw.
  - `passthrough`: make a live call (REQUIRES `opts.model`); record nothing.
- Replay MUST make zero live calls under `strict`. Un-wrapped harness I/O still executes (documented limitation).

### 10.2 Inspection
- `events()` returns the migrated event list.
- `stepTo(n)` sets an internal cursor; `contextAt(n)` returns `request.messages` of the model call at step `n` (throw `RangeError` if step `n` is not a model call).
- `diffContext(a,b)` returns added/removed messages (structural diff by deep-equal identity of messages) and `tokenDelta`.

### 10.3 Token counting (`tokens.ts`)
Tiered: (1) exact from `event.usage` when present; (2) a registered per-model tokenizer if available; (3) `Math.ceil(chars/4)` fallback. Set `ContextDiff.tokenDeltaIsEstimate = true` whenever tier 3 is used for either endpoint.

### 10.4 Fork engine (`fork.ts`)
`replay.fork(opts)`:
1. Create a child session (`parent = this.id`, `forkedAtStep = atStep`).
2. **Prefix phase (`step < atStep`):** run in replay-serve mode (entropy replayed, model/tools served from log). This reconstructs harness state.
3. **Tail phase (`step >= atStep`):**
   - **Model calls:** go live via `opts.model` (REQUIRED). Apply `overrides` through `codec.applyOverrides` before the live call. Record each into the child session; sum `usage` into `tokensSpent`.
   - **Tool calls:** resolve against the recording.
     - On **hit**: behavior per `tools.onMatch` (default `serve-recorded`; `live` requires sandbox).
     - On **miss**: behavior per `tools.onMiss` (default `error`):
       - `error`: stop, set `divergedAtStep`, return.
       - `stub`: return a `{ __agentrewind_unavailable: true }` sentinel.
       - `simulate`: produce an LLM-generated result, tagged `synthetic: true` on the event. (v1; not MVP.)
       - `live`: execute for real; requires `sandbox`. (v1; not MVP.)
   - Tag every tail event with provenance: `recorded` | `live` | `stub` | `synthetic`.
4. If `goal` given, evaluate `goal(trace)` after the run → `reachedGoal`.
5. Return `ForkResult`.

Step indexing for `atStep` uses the same root-lane linearization as `stepTo`. Behavior of `atStep` landing inside a concurrent region is best-effort; document it.

---

## 11. Redaction & vault (`redaction.ts`)

```ts
export interface RedactionConfig { enabled: boolean; patterns?: RegExp[]; }
```
- Built-in patterns: common API-key/bearer-token shapes, plus values of `process.env` that look secret.
- `redactDeep(obj)` walks all string leaves; each matched secret → a deterministic token `arw:redacted:<sha256(secret).slice(0,12)>`. Same secret → same token (so fingerprints are stable).
- **Vault:** an in-session map `token -> secret`, persisted to `vault.enc` (AES-256-GCM; key derived from a per-session random key stored in the OS keychain or a local key file — MVP MAY use a local key file with 0600 perms).
- On replay, before a recorded **response/tool-result** is handed to the harness, run `vault.restore(value)` to swap tokens back to real secrets, preserving fidelity locally.
- `pack()` MUST exclude `vault.enc`. After packing, fingerprints still match because they are computed over the tokenized form.
- "No network egress" applies to the library itself: AgentRewind MUST NOT make any network calls of its own.

---

## 12. CLI (`@agentrewind/cli`)

Binary `agentrewind` (alias `arw`). Commands:

- `agentrewind inspect <session>` — print the event timeline: step, kind, lane, callSite, fingerprint (short), tokens.
- `agentrewind context <session> --step <n>` — print the prompt context at step n.
- `agentrewind diff <session> --from <a> --to <b>` — print a context diff.
- `agentrewind pack <session> <out.rewind>` — produce a vault-excluded bundle; print a redaction summary (counts by pattern) before writing.
- `agentrewind unpack <out.rewind> <dir>` — restore a bundle.

Record/replay/fork are driven programmatically (the CLI does not run the user's harness). Exit non-zero on `DriftError`.

### 12.1 Typed errors (`errors.ts`)
`RewindError` (base) → `DriftError`, `FingerprintError`, `SerializationError`, `MigrationError`, `CodecError`, `VaultError`. Each carries structured `data`.

---

## 13. Milestones & acceptance tests

Build in order. A milestone is complete only when its listed `vitest` tests pass. Tests use a synthetic in-memory codec and a fake model client (deterministic), except where the Anthropic codec is named.

### M1 — Schema, store, fingerprint, record (Week 1)
Files: `events.ts`, `session-store.ts`, `fingerprint.ts`, `entropy.ts`, `context.ts`, `record.ts`, `codec.ts`, `errors.ts`, `migrate.ts`; `codec-anthropic`.
Tests:
- `fingerprint is stable across key reorder, number formatting, and secret value` — two logically identical requests hash equal.
- `record writes events.jsonl + blobs + meta with eventsHash`.
- `large payload (> threshold) is externalized to a blob and referenced`.
- `entropy: clock/random/uuid are recorded as events in initiation order`.
- `non-serializable tool return throws SerializationError at record time`.
- `anthropic codec round-trips request/response/stream against real SDK-shaped fixtures`.

### M2 — Matcher, replay, inspect, CLI (Week 2)
Files: `matcher.ts`, `replay.ts`, `tokens.ts`, `cli`.
Tests:
- `replay of a pure harness reproduces an identical boundary-event trajectory with zero live calls`.
- `replay N times is identical every time` (determinism property test).
- `in-request entropy: a uuid drawn from ctx and embedded in the prompt yields byte-identical requests on record and replay`.
- `duplicate request with two different recorded responses is disambiguated by callSite`.
- `concurrent tool calls with shuffled completion order resolve correctly (content+lane keyed)`.
- `harness control-flow change is reported as DriftError at the correct step`.
- `stepTo/contextAt returns the exact messages at step n; diffContext reports added/removed + tokenDelta`.
- `cli inspect/context/diff produce correct output on a fixture session`.

### M3 — Tools replay, strict fork, redaction + vault (Week 3)
Files: `fork.ts`, `redaction.ts`.
Tests:
- `tool calls replay from the log (no handler execution)`.
- `fork(atStep=k, onMiss="error") reaches goal when the tail coincides with the recording`.
- `fork halts with divergedAtStep when the forked model issues an unrecorded tool call (onMiss="error")`.
- `fork model calls go live with overrides applied; tokensSpent counts only the tail`.
- `tail events are provenance-tagged (recorded/live/stub)`.
- `redaction: secret in a model response is tokenized in storage; local replay restores it via vault; packed bundle contains only the token`.
- `replay/fork require a live client only when needed; pure strict replay needs none`.

### M4 — Pack, cost, test helper, migration (Week 4)
Files: `@agentrewind/test` helper; finalize `migrate.ts`, `session-store.ts` pack/unpack.
Tests:
- `pack excludes vault.enc; unpack restores a replayable session; fingerprints still match`.
- `cost accounting: per-step and per-run token/cost totals are correct`.
- `@agentrewind/test fromSession() asserts semantic trajectory and surfaces drift as an explained test failure`.
- `a vN fixture replays unchanged on vN+1 via the migration registry`.

### M5 — Purity lint, sample, docs (buffer)
Files: purity-lint module; `examples/` sample agent; READMEs.
Tests:
- `purity lint flags an un-wrapped fs.writeFile during recording with the correct call site`.
- `examples/sample-agent: record → step to a bad decision → fork a one-line prompt fix → assert reachedGoal`.

---

## 14. Non-goals (do NOT build in this scope)

- Transport-level (`fetch`/`node:http`) interception — v1.
- Fork `onMiss` policies `simulate` and `live`, and `onMatch: "live"` / sandbox execution — v1.
- More than one provider codec (ship Anthropic only) — v1.
- Web viewer UI, workspace/filesystem snapshotting — v2.
- Any network feature, telemetry, or account system — never.

---

## 15. Definition of done (MVP)

All M1–M4 tests pass; `examples/sample-agent` runs end-to-end; `@agentrewind/sdk` (umbrella) installs and exposes the §6 API; the CLI binary works; `@agentrewind/core` has zero runtime dependencies. M5 is desirable but not blocking.