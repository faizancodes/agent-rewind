import type { ForkOverrides, ProviderCodec } from "./codec.js";
import { CodecError } from "./errors.js";
import { assertJsonSerializable } from "./session-store.js";
import { assertProviderCodec } from "./record.js";

export interface CodecConformanceCase {
  /** Label included in thrown conformance errors. */
  name?: string;
  /** Provider SDK request fixture. */
  request: unknown;
  /** Provider SDK response fixture for non-streaming calls. */
  response?: unknown;
  /** Provider SDK stream chunks fixture. */
  streamChunks?: unknown[];
  /** Optional fork overrides fixture. */
  overrides?: ForkOverrides;
}

export interface CodecConformanceOptions {
  /** Operation label used in provider-codec shape errors. */
  operation?: string;
}

/** Validate that a custom provider codec can normalize, denormalize, stream-rebuild, and JSON-store fixtures. */
export async function assertCodecConformance(
  codec: ProviderCodec,
  cases: CodecConformanceCase | CodecConformanceCase[],
  opts: CodecConformanceOptions = {}
): Promise<void> {
  assertProviderCodec(codec, opts.operation ?? "codec conformance");
  for (const testCase of Array.isArray(cases) ? cases : [cases]) {
    await assertCodecCase(codec, testCase);
  }
}

async function assertCodecCase(codec: ProviderCodec, testCase: CodecConformanceCase): Promise<void> {
  const label = testCase.name ? `${codec.name}/${testCase.name}` : codec.name;
  try {
    const normalizedRequest = codec.normalizeRequest(testCase.request);
    assertJsonSerializable(normalizedRequest, `${label}.request.normalized`);
    codec.normalizeRequest(codec.denormalizeRequest(normalizedRequest));
    codec.stripVolatile(normalizedRequest);
    codec.volatileLeafPaths();

    const overridden = codec.applyOverrides(normalizedRequest, testCase.overrides ?? {}, 0);
    assertJsonSerializable(overridden, `${label}.request.overridden`);
    codec.normalizeRequest(codec.denormalizeRequest(overridden));

    if ("response" in testCase) {
      const normalizedResponse = codec.normalizeResponse(testCase.response);
      assertJsonSerializable(normalizedResponse, `${label}.response.normalized`);
      codec.extractUsage(normalizedResponse);
    }

    if (testCase.streamChunks) {
      const normalizedStream = codec.normalizeStream(testCase.streamChunks);
      assertJsonSerializable(normalizedStream.final, `${label}.stream.final`);
      assertJsonSerializable(normalizedStream.chunks, `${label}.stream.chunks`);
      await consume(codec.rebuildStream(normalizedStream.chunks));
    }
  } catch (error) {
    if (error instanceof CodecError) {
      throw error;
    }
    throw new CodecError(`Provider codec failed conformance case "${label}"`, {
      codec: codec.name,
      case: testCase.name,
      cause: error instanceof Error ? { name: error.name, message: error.message } : String(error)
    });
  }
}

async function consume(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _chunk of stream) {
    // Exhaust the rebuilt stream to catch async iterator failures.
  }
}
