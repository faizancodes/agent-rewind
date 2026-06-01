export class RewindError extends Error {
  readonly data: unknown;

  constructor(message: string, data?: unknown) {
    super(message);
    this.name = new.target.name;
    this.data = data;
  }
}

export class DriftError extends RewindError {}
export class FingerprintError extends RewindError {}
export class SerializationError extends RewindError {}
export class MigrationError extends RewindError {}
export class CodecError extends RewindError {}
export class ConfigurationError extends RewindError {}
export class SessionStoreError extends RewindError {}
export class VaultError extends RewindError {}
export class PurityLintError extends RewindError {}

export interface RewindErrorExplanationOptions {
  /** Session path to include in suggested CLI commands. */
  sessionPath?: string;
  /** Include raw structured error data after the human-readable summary. */
  includeData?: boolean;
}

/**
 * Convert AgentRewind errors into a message that is useful in test output,
 * application logs, and CI failures.
 */
export function explainRewindError(error: unknown, options: RewindErrorExplanationOptions = {}): string {
  if (!(error instanceof Error)) {
    return `AgentRewind error: ${String(error)}`;
  }

  const data = error instanceof RewindError ? error.data : undefined;
  const record = isRecord(data) ? data : {};
  const lines = [`${error.name}: ${error.message}`];

  const expected = record.expected;
  const actual = record.actual;
  if (expected !== undefined || actual !== undefined) {
    lines.push("");
    if (expected !== undefined) {
      lines.push(`Expected: ${formatBoundary(expected)}`);
    }
    if (actual !== undefined) {
      lines.push(`Actual: ${formatBoundary(actual)}`);
    }
  } else if (record.step !== undefined || record.expectedStep !== undefined || record.actualStep !== undefined) {
    lines.push("");
    lines.push(formatStepLine(record));
  }

  const remaining = Array.isArray(record.remaining) ? record.remaining : undefined;
  if (remaining && remaining.length > 0) {
    lines.push("");
    lines.push("Unconsumed recorded boundaries:");
    for (const item of remaining.slice(0, 5)) {
      lines.push(`- ${formatBoundary(item)}`);
    }
    if (remaining.length > 5) {
      lines.push(`- ...and ${remaining.length - 5} more`);
    }
  }

  const hints = hintsFor(error, record);
  if (hints.length > 0) {
    lines.push("");
    lines.push("What to check:");
    for (const hint of hints) {
      lines.push(`- ${hint}`);
    }
  }

  if (options.sessionPath) {
    const sessionPath = shellArg(options.sessionPath);
    lines.push("");
    lines.push("Useful commands:");
    lines.push(`- agentrewind doctor ${sessionPath}`);
    lines.push(`- agentrewind inspect ${sessionPath}`);
    const site = firstModelSite(expected, record);
    if (site) {
      lines.push(`- agentrewind context ${sessionPath} --site ${shellArg(site)}`);
    }
    const step = firstNumber(record.step, record.expectedStep, isRecord(expected) ? expected.step : undefined);
    if (step !== undefined) {
      lines.push(`- agentrewind context ${sessionPath} --step ${step}`);
    }
  }

  if (options.includeData && data !== undefined) {
    lines.push("");
    lines.push("Raw diagnostic data:");
    lines.push(JSON.stringify(data, null, 2));
  }

  return lines.join("\n");
}

function hintsFor(error: Error, data: Record<string, unknown>): string[] {
  const hints: string[] = [];
  if (error instanceof SerializationError) {
    const label = stringValue(data.label);
    const type = stringValue(data.type);
    const prototype = stringValue(data.prototype);
    hints.push("AgentRewind stores recorded boundaries as JSON, so values must be null, strings, finite numbers, booleans, arrays, or plain objects.");
    if (label) {
      hints.push(`Failing value label: \`${label}\`.`);
    }
    if (type) {
      hints.push(`Convert or remove the \`${type}\` value before recording.`);
    }
    if (prototype) {
      hints.push(`Convert \`${prototype}\` instances to JSON values, such as strings or plain objects.`);
    }
    hints.push("For tool args, results, or stream chunks that need Dates, Maps, classes, or Buffers, pass `toolSerializers` with serialize/deserialize functions.");
    hints.push("For model requests or responses, fix the provider codec so `normalizeRequest()` and `normalizeResponse()` return JSON-compatible values.");
    return [...new Set(hints)];
  }
  if (error instanceof FingerprintError) {
    const type = stringValue(data.type);
    const prototype = stringValue(data.prototype);
    hints.push("AgentRewind fingerprints model requests and tool arguments, so fingerprinted values must be stable JSON-compatible data.");
    if (type) {
      hints.push(`Convert or remove the \`${type}\` value before it reaches the fingerprint.`);
    }
    if (prototype) {
      hints.push(`Convert \`${prototype}\` instances to JSON values, such as strings or plain objects.`);
    }
    if (data.value !== undefined) {
      hints.push("Use only finite JSON numbers; NaN, Infinity, and -Infinity cannot be replay fingerprints.");
    }
    hints.push("For model requests, normalize SDK-specific objects in the provider codec and strip changing metadata in `stripVolatile()`.");
    hints.push("For tool arguments, pass JSON-compatible values or configure `toolSerializers` for that tool.");
    return [...new Set(hints)];
  }
  if (error instanceof CodecError) {
    const expected = stringValue(data.expected);
    const path = stringValue(data.path);
    if (expected) {
      hints.push(`Pass a model client that exposes \`${expected}\`.`);
    } else if (path) {
      hints.push(`Pass a model client that exposes \`client.${path}(request)\`.`);
    }
    hints.push("Check that the codec matches the provider SDK shape: OpenAI/OpenRouter use Chat Completions, Anthropic uses Messages.");
    hints.push("Run `assertProviderClient(model, codec)` during setup to fail fast before recording.");
    if (Array.isArray(data.availableKeys) && data.availableKeys.length > 0) {
      hints.push(`Available keys at the failing level: ${data.availableKeys.slice(0, 8).join(", ")}.`);
    }
    return [...new Set(hints)];
  }
  if (error instanceof ConfigurationError) {
    if (stringValue(data.missing) === "codec") {
      const operation = stringValue(data.operation);
      if (operation?.includes("replay") || operation?.includes("fork")) {
        hints.push("Pass the provider codec when running or forking: `AgentRewind.replay(sessionPath, { codec })`.");
      } else if (operation === "assertProviderClient") {
        hints.push("Create the codec before validating the SDK client, for example `const codec = openaiChatCodec(); assertProviderClient(model, codec);`.");
      } else {
        hints.push("Pass the provider codec when recording, for example `AgentRewind.recordRun({ store: \".rewind\", model, codec }, harness)`.");
      }
      hints.push("Use the same codec family that recorded the session, such as `openaiChatCodec()`, `openRouterChatCodec()`, or `anthropicCodec()`.");
      const provider = stringValue(data.provider);
      if (provider) {
        hints.push(`Recorded provider: ${provider}.`);
      }
      if (Array.isArray(data.missingFields) && data.missingFields.length > 0) {
        hints.push(`Missing codec fields: ${data.missingFields.slice(0, 8).join(", ")}.`);
      }
      if (Array.isArray(data.invalidFields) && data.invalidFields.length > 0) {
        hints.push(`Invalid codec fields: ${data.invalidFields.slice(0, 8).join(", ")}.`);
      }
      return [...new Set(hints)];
    }
    if (stringValue(data.missing) === "store") {
      hints.push("Pass a session store directory, for example `store: \".rewind\"`.");
      hints.push("The store is where AgentRewind writes `<store>/<session-id>/meta.json`, `events.jsonl`, blobs, and the local vault.");
      return [...new Set(hints)];
    }
    if (stringValue(data.missing) === "model") {
      hints.push("Pass the live provider SDK client when recording, for example `AgentRewind.recordRun({ store: \".rewind\", model, codec }, harness)`.");
      hints.push("Create the client with the provider SDK first, then run `assertProviderClient(model, codec)` to verify the codec can wrap it.");
      return [...new Set(hints)];
    }
    if (stringValue(data.missing) === "recordOptions") {
      hints.push("Call `AgentRewind.record({ store, model, codec, tools? })` or `AgentRewind.recordRun({ store, model, codec, tools? }, harness)`.");
      return [...new Set(hints)];
    }
    const tool = stringValue(data.tool);
    if (tool) {
      hints.push(`Add a \`${tool}\` handler to your tools object.`);
    }
    hints.push("Pass the same `tools` object to `defineHarness(tools, harness)` and `AgentRewind.record()` or `AgentRewind.recordRun()`.");
    if (Array.isArray(data.availableTools) && data.availableTools.length > 0) {
      hints.push(`Configured tools: ${data.availableTools.slice(0, 8).join(", ")}.`);
    } else {
      hints.push("No tools are configured for this recording session.");
    }
    return [...new Set(hints)];
  }
  if (error instanceof SessionStoreError) {
    const sessionPath = stringValue(data.sessionPath);
    const store = stringValue(data.store);
    const missingFile = stringValue(data.missingFile);
    if (missingFile) {
      hints.push(`Expected to find \`${missingFile}\` inside the session directory.`);
    }
    if (Array.isArray(data.availableSessions) && data.availableSessions.length > 0) {
      hints.push(`Available session ids: ${data.availableSessions.slice(0, 8).join(", ")}${data.availableSessions.length > 8 ? ", ..." : ""}.`);
    }
    if (store) {
      hints.push(`Run \`agentrewind list ${store}\` to see recorded sessions in that store.`);
      hints.push("Single-session commands accept a full path, a session id with `--store`, or `latest --store <dir>`.");
    } else {
      hints.push("Pass the full session directory, for example `.rewind/<session-id>`, not only the `.rewind` store directory.");
      hints.push("Run `agentrewind doctor <session>` after recording to validate the session path.");
    }
    if (sessionPath) {
      hints.push(`Session path checked: ${sessionPath}.`);
    }
    return [...new Set(hints)];
  }
  if (!(error instanceof DriftError)) {
    return [];
  }
  const message = error.message.toLowerCase();
  if (message.includes("model call drifted")) {
    hints.push("Keep the same `ctx.model.create()` or `ctx.model.stream()` request shape during strict replay.");
    hints.push("Use `ctx.uuid()`, `ctx.clock()`, `ctx.random()`, and `ctx.env(key)` for prompt-affecting entropy.");
    hints.push("Give the model call a stable `{ site: \"...\" }` name so drift points to the logical operation.");
  } else if (message.includes("tool call drifted")) {
    hints.push("Route external work through `ctx.tools.<name>()` with stable JSON-serializable arguments.");
    hints.push("Check whether the tool name or arguments changed since the recording.");
  } else if (message.includes("entropy")) {
    hints.push("Use AgentRewind entropy helpers consistently; mixing `Date.now()`, `Math.random()`, or `crypto.randomUUID()` can change replay trajectory.");
  } else if (message.includes("ended before consuming")) {
    hints.push("The replay harness returned early or skipped a recorded model/tool/entropy boundary.");
  } else if (message.includes("out of order")) {
    hints.push("Check for reordered awaits or concurrency changes around model/tool calls.");
  }
  if (data.expectedCallSite !== undefined || data.actualCallSite !== undefined) {
    hints.push("Compare the recorded call site with the call site used by the current harness.");
  }
  return [...new Set(hints)];
}

function formatBoundary(value: unknown): string {
  if (!isRecord(value)) {
    return JSON.stringify(value);
  }
  const parts: string[] = [];
  const kind = stringValue(value.kind);
  if (kind) parts.push(kind);
  const step = numberValue(value.step);
  if (step !== undefined) parts.push(`step=${step}`);
  const callSite = stringValue(value.callSite) ?? stringValue(value.site);
  if (callSite) parts.push(`site=${callSite}`);
  const name = stringValue(value.name);
  if (name) parts.push(`name=${name}`);
  const source = stringValue(value.source);
  if (source) parts.push(`source=${source}`);
  const model = stringValue(value.model);
  if (model) parts.push(`model=${model}`);
  const fingerprint = stringValue(value.requestHash) ?? stringValue(value.argsHash) ?? stringValue(value.actualFingerprint);
  if (fingerprint) parts.push(`fingerprint=${fingerprint.slice(0, 12)}`);
  const messages = numberValue(value.messages);
  if (messages !== undefined) parts.push(`messages=${messages}`);
  const streamed = booleanValue(value.streamed);
  if (streamed) parts.push("stream=true");
  return parts.length > 0 ? parts.join(" ") : JSON.stringify(value);
}

function formatStepLine(record: Record<string, unknown>): string {
  const parts: string[] = [];
  const step = firstNumber(record.step, record.expectedStep);
  if (step !== undefined) parts.push(`Recorded step: ${step}`);
  const actualStep = numberValue(record.actualStep);
  if (actualStep !== undefined) parts.push(`Actual step: ${actualStep}`);
  const expectedCallSite = stringValue(record.expectedCallSite);
  if (expectedCallSite) parts.push(`Expected site: ${expectedCallSite}`);
  const actualCallSite = stringValue(record.actualCallSite);
  if (actualCallSite) parts.push(`Actual site: ${actualCallSite}`);
  const source = stringValue(record.source);
  if (source) parts.push(`Entropy source: ${source}`);
  return parts.join("\n");
}

function firstModelSite(expected: unknown, record: Record<string, unknown>): string | undefined {
  const expectedSite = modelSite(expected);
  if (expectedSite) {
    return expectedSite;
  }

  const remaining = Array.isArray(record.remaining) ? record.remaining : [];
  for (const item of remaining) {
    const site = modelSite(item);
    if (site) {
      return site;
    }
  }

  return undefined;
}

function modelSite(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (value.kind !== "model_call") {
    return undefined;
  }
  return stringValue(value.callSite) ?? stringValue(value.site);
}

function shellArg(value: string): string {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const parsed = numberValue(value);
    if (parsed !== undefined) {
      return parsed;
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}
