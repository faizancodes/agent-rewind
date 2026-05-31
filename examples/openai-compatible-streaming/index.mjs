import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRewind } from "../../packages/core/dist/index.js";
import { openaiChatCodec } from "../../packages/codec-openai/dist/index.js";

// Real-world use case:
// An incident-management product streams a customer-facing status page update as
// the model writes it. Engineers want to replay the exact stream later in a test
// or bug report without opening another provider stream.
const codec = openaiChatCodec();

// The same OpenAI Chat Completions codec supports normal responses and streams.
// Use the streaming example when your product consumes chunk-by-chunk output and
// you want replay to exercise that same consumer code.

// The store is temporary for the example. Use a durable store when you want to
// inspect a recorded stream with the CLI or replay it in CI.
const store = await mkdtemp(join(tmpdir(), "agentrewind-status-stream-"));

// This counter is the simplest way to prove the second run is a replay. It
// should increment during record only, never while consuming replayed chunks.
let liveStreams = 0;

const incidentSnapshot = {
  incidentId: "inc_8842",
  service: "checkout-api",
  status: "investigating",
  customerImpact: "Some checkout requests in us-east-1 are timing out.",
  mitigation: "Traffic is being shifted away from unhealthy hosts.",
  nextUpdateMinutes: 15
};

try {
  const harness = async (ctx) => {
    // This harness returns the final string, but the important behavior is the
    // loop below. It proves replay can drive code that expects an async iterable,
    // not just code that waits for a single JSON response.

    // Entropy can be just as important in streaming agents as in normal calls.
    // If an update id or timestamp appears in the prompt, route it through ctx
    // so replay can rebuild the same stream request.
    const updateId = ctx.uuid();
    const generatedAt = ctx.clock();
    let customerVisibleUpdate = "";

    // The call uses `ctx.model.stream()` instead of the raw SDK client. That is
    // the only change application code needs for AgentRewind to capture stream
    // chunks and rebuild them later.
    //
    // Application code consumes the stream exactly as it would from the OpenAI
    // SDK. AgentRewind records each chunk during record and rebuilds the same
    // async iterable during replay.
    for await (const chunk of ctx.model.stream(
      {
        model: "status-copywriter-v1",
        messages: [
          {
            role: "system",
            content: "Write concise, calm incident updates for a public status page. Do not overpromise."
          },
          {
            role: "user",
            content: JSON.stringify({ updateId, generatedAt, incidentSnapshot })
          }
        ],
        temperature: 0.2,
        metadata: { updateId, incidentId: incidentSnapshot.incidentId }
      },

      // Site names are especially useful for streaming applications because a
      // single workflow may stream drafts, summaries, and final responses.
      { site: "stream-status-page-update" }
    )) {
      // Application rendering code can stay unchanged. During replay, these
      // chunks come from AgentRewind's recorded stream, not from the provider.
      //
      // For a web app, this loop could push text into a response stream or UI
      // state. For a CLI, it could write to stdout incrementally.
      //
      // The point is that this consumer code does not need to know whether the
      // chunks are live or replayed.
      customerVisibleUpdate += chunk.choices[0]?.delta?.content ?? "";
    }

    return customerVisibleUpdate;
  };

  const streamChunks = [
    // A realistic OpenAI stream starts with role metadata, then content deltas,
    // then often a final usage-only chunk. Recording the chunk sequence lets you
    // reproduce UI/CLI behavior that depends on incremental output.
    chunk("chatcmpl_status_stream", { role: "assistant", content: "" }),
    chunk("chatcmpl_status_stream", { content: "We are investigating checkout timeouts in us-east-1. " }),
    chunk("chatcmpl_status_stream", { content: "Traffic is being shifted away from affected hosts, " }),
    chunk("chatcmpl_status_stream", { content: "and we will share another update within 15 minutes." }, "stop"),
    {
      id: "chatcmpl_status_stream",
      object: "chat.completion.chunk",
      created: 1,
      model: "status-copywriter-v1",
      choices: [],
      usage: { prompt_tokens: 96, completion_tokens: 31, total_tokens: 127 }
    }
  ];

  const record = AgentRewind.record({
    id: "status-page-stream",
    store,
    codec,

    // This fake implements `chat.completions.stream()`. Replace it with a real
    // OpenAI-compatible client and keep the harness unchanged.
    model: {
      chat: {
        completions: {
          stream() {
            liveStreams += 1;
            // A real SDK returns an async iterable here. Returning the same
            // interface lets AgentRewind exercise the streaming path exactly as
            // production code would.
            return asyncIterable(streamChunks);
          }
        }
      }
    }
  });

  const recorded = await record.run(harness);

  // Close after the stream has been fully consumed. The session needs both the
  // per-chunk timeline and the final normalized response before it can replay.
  // Closing is important for streams because the final assembled response and
  // the chunk list are both persisted in the session.
  await record.close();

  // Replay has no model client. `replayRun()` is enough here because this
  // example only needs the replayed harness result, not inspection or fork APIs.
  // If the result matches and `liveStreams` is still 1, the second run consumed
  // only the recorded stream chunks.
  const replayed = await AgentRewind.replayRun(
    join(store, "status-page-stream"),
    { codec },
    harness
  );

  // These checks are the minimum useful assertions for a streaming regression
  // test: same final text, and no second live provider stream.
  // If replay accidentally opened a provider stream, this counter would be 2.
  // Keeping it at 1 proves the second run was served entirely from the session.
  if (liveStreams !== 1) {
    throw new Error(`Expected one live provider stream during recording only, got ${liveStreams}`);
  }
  if (recorded !== replayed) {
    throw new Error("Replay did not reproduce the status page stream");
  }

  console.log(
    JSON.stringify(
      {
        example: "replay a streamed status page update",
        recorded,
        replayed,
        liveStreams
      },
      null,
      2
    )
  );
} finally {
  await rm(store, { recursive: true, force: true });
}

// Fixture helper for OpenAI ChatCompletionChunk objects.
function chunk(id, delta, finishReason = null) {
  // These fixtures keep the same field names the OpenAI SDK exposes, so the
  // harness exercises real parsing paths such as `chunk.choices[0].delta`.
  return {
    id,
    object: "chat.completion.chunk",
    created: 1,
    model: "status-copywriter-v1",
    choices: [{ index: 0, delta, finish_reason: finishReason }]
  };
}

// The OpenAI SDK stream helper is async-iterable. The fake client returns the
// same interface so app code does not need special testing branches.
async function* asyncIterable(values) {
  for (const value of values) {
    // No artificial delay is used here. AgentRewind records chunk ordering and
    // offsets, and replay can rebuild the sequence without requiring a slow
    // example test.
    yield value;
  }
}
