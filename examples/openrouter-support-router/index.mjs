import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRewind } from "../../packages/core/dist/index.js";
import { openRouterChatCodec, openRouterClientOptions } from "../../packages/codec-openrouter/dist/index.js";

// Real-world use case:
// A support platform uses OpenRouter as a model gateway. High-priority tickets
// should be sent through a specific provider policy, and engineers need replay
// to preserve OpenRouter-only request fields such as provider routing, plugins,
// and JSON response format.
const codec = openRouterChatCodec();

// OpenRouter is OpenAI-compatible at the SDK method path, but it has its own
// request options and provider identity. Use the OpenRouter codec when those
// options are part of what your agent depends on.

// Use a temp store for this runnable example. Use a durable store when you want
// to compare OpenRouter requests across app versions or provider-policy changes.
const store = await mkdtemp(join(tmpdir(), "agentrewind-openrouter-router-"));

// One live call is expected during record. Strict replay should not call the
// OpenRouter-shaped client again.
let liveCalls = 0;

const escalatedTicket = {
  id: "ticket_991",
  accountTier: "enterprise",
  issue: "Database failover caused duplicate invoices for multiple customers.",
  risk: "billing-data-integrity",
  requestedOutcome: "route to the right specialist queue"
};

try {
  // In a real app:
  //
  //   import OpenAI from "openai";
  //   const model = new OpenAI(openRouterClientOptions({ apiKey: process.env.OPENROUTER_API_KEY, ... }));
  //
  // The fake client below does not use this object, but checking it here makes
  // the OpenRouter wiring visible in the runnable example.
  //
  // The OpenRouter package includes this helper so users do not have to remember
  // the base URL and optional attribution-header names every time they create a
  // client.
  const clientOptions = openRouterClientOptions({
    apiKey: "not-used-by-fake-client",
    appUrl: "https://support.example.com",
    appTitle: "Support Routing Agent",
    appCategories: ["support", "operations"]
  });

  // In real code, pass `clientOptions` to the OpenAI SDK constructor. The
  // harness below stays the same because AgentRewind wraps the model boundary,
  // not your application routing logic.

  // This is an example-level guardrail. It teaches what the helper is supposed
  // to do before any model call is made: point the OpenAI SDK at OpenRouter and
  // add optional attribution headers.
  if (clientOptions.baseURL !== "https://openrouter.ai/api/v1") {
    throw new Error("OpenRouter base URL helper returned an unexpected value");
  }
  if (clientOptions.defaultHeaders?.["X-OpenRouter-Title"] !== "Support Routing Agent") {
    throw new Error("OpenRouter attribution headers were not configured");
  }

  const harness = async (ctx) => {
    // The harness represents your product routing workflow. Provider choice is
    // configured inside the request because that choice affects the model call
    // you want to record and replay.

    // Route prompt-affecting entropy through ctx. These values become recorded
    // entropy events, so replay and fork can reconstruct the same request.
    const routingRunId = ctx.uuid();
    const routedAt = ctx.clock();

    // This request intentionally includes OpenRouter-only fields. If you used
    // the generic OpenAI codec for this workflow, you might not notice that
    // routing or plugin settings were dropped from the normalized trace.
    //
    // OpenRouter still uses the OpenAI-compatible `chat.completions.create()`
    // method path, but these extra request fields matter to OpenRouter. The
    // first-class OpenRouter codec records and replays them under the provider
    // identity "openrouter-chat".
    const completion = await ctx.model.create(
      {
        model: "openai/gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "Route support tickets to exactly one queue. Return JSON with queue, confidence, providerPolicy, and rationale."
          },
          {
            role: "user",
            content: JSON.stringify({ routingRunId, routedAt, escalatedTicket })
          }
        ],
        temperature: 0,
        provider: {
          // Provider routing policy is part of the behavior being tested. It is
          // recorded, fingerprinted, and replayed by the OpenRouter codec.
          order: ["OpenAI"],
          allow_fallbacks: true,
          require_parameters: true
        },
        // Plugins and response_format are OpenRouter request extensions. Keeping
        // them in the example shows where to put settings your agent relies on.
        plugins: [{ id: "response-healing", max_retries: 1 }],
        response_format: { type: "json_object" },
        metadata: { routingRunId, ticketId: escalatedTicket.id }
      },

      // The site name should describe the product operation, not the provider.
      // Provider details are already captured by the codec name.
      { site: "openrouter-specialist-routing" }
    );

    return JSON.parse(completion.choices[0].message.content);
  };

  // Recording is the only phase that talks to the OpenRouter-shaped client. The
  // request assertions inside the fake client prove the provider-specific fields
  // survived all the way to the boundary.
  const record = AgentRewind.record({
    id: "openrouter-specialist-routing",
    store,

    // Using the OpenRouter codec means the recorded session says
    // `provider: "openrouter-chat"` instead of looking like generic OpenAI.
    codec,
    model: {
      chat: {
        completions: {
          async create(request) {
            liveCalls += 1;

            // These checks prove the OpenRouter-specific request options reached
            // the provider-shaped client during record. Replay then proves the
            // same request shape can be matched from disk.
            //
            // In your own tests, similar assertions can catch accidental codec
            // regressions or app changes that remove important provider policy.
            if (request.provider?.order?.[0] !== "OpenAI") {
              throw new Error("OpenRouter provider order was not preserved");
            }
            if (request.response_format?.type !== "json_object") {
              throw new Error("OpenRouter response_format was not preserved");
            }
            if (request.plugins?.[0]?.id !== "response-healing") {
              throw new Error("OpenRouter plugin settings were not preserved");
            }

            return chatCompletion(
              "gen_openrouter_specialist",
              JSON.stringify({
                queue: "billing-integrity-specialists",
                confidence: 0.94,
                providerPolicy: "OpenAI first, fallback allowed",
                rationale: "Duplicate invoices are a billing data integrity issue for an enterprise account."
              }),
              { prompt_tokens: 132, completion_tokens: 39, total_tokens: 171 }
            );
          }
        }
      }
    }
  });

  const recorded = await record.run(harness);

  // `recorded` is the application result. The durable value for AgentRewind is
  // the session directory written on close.
  // After close, inspect `events.jsonl` to see that the session provider is
  // `openrouter-chat` and that the OpenRouter-specific request options are
  // represented in the normalized request.
  await record.close();

  // Replay needs the same codec because the request must be normalized the same
  // way it was during record. `replayRun()` keeps the common case to one call:
  // load the session, run the harness, and return the replayed result.
  const replayed = await AgentRewind.replayRun(
    join(store, "openrouter-specialist-routing"),
    { codec },
    harness
  );

  // If a future code change accidentally removes `provider`, `plugins`, or
  // `response_format`, strict replay should drift instead of masking the change.
  // The core value here is that OpenRouter-specific parameters are not lost.
  // The fake client checked them during record, and this replay proves the same
  // request fingerprint can be matched later.
  if (liveCalls !== 1) {
    throw new Error(`Expected one live OpenRouter-shaped call during recording only, got ${liveCalls}`);
  }
  if (JSON.stringify(recorded) !== JSON.stringify(replayed)) {
    throw new Error("OpenRouter replay did not reproduce the specialist route");
  }

  console.log(
    JSON.stringify(
      {
        example: "replay OpenRouter provider routing options",
        provider: codec.name,
        openRouterBaseURL: clientOptions.baseURL,
        recorded,
        replayed,
        liveCalls
      },
      null,
      2
    )
  );
} finally {
  await rm(store, { recursive: true, force: true });
}

// OpenRouter Chat Completions uses the OpenAI-compatible response shape.
function chatCompletion(id, content, usage) {
  // The provider-specific behavior in this example is in the request options.
  // The response can still look like a normal OpenAI Chat Completions response.
  return {
    id,
    object: "chat.completion",
    created: 1,
    model: "openai/gpt-4o-mini",
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        logprobs: null,
        message: { role: "assistant", content, refusal: null }
      }
    ],
    usage
  };
}
