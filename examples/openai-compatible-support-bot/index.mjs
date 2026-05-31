import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRewind } from "../../packages/core/dist/index.js";
import { openaiChatCodec } from "../../packages/codec-openai/dist/index.js";

// Real-world use case:
// A SaaS support triage agent enriches a ticket with account data and current
// incident state, then asks an OpenAI-compatible Chat Completions model to route
// the case. Engineers want to replay the exact classification later without
// calling the CRM, incident service, or model again.
const codec = openaiChatCodec();

// Most OpenAI-compatible users should import this codec instead of writing one.
// It knows how to normalize Chat Completions requests/responses for matching,
// redaction, inspection, replay, and fork.

// This example uses a temporary store so it can be run repeatedly. In a real
// service or test suite, use a stable directory such as ".rewind" when you want
// to inspect or commit a sanitized session bundle later.
const store = await mkdtemp(join(tmpdir(), "agentrewind-openai-support-"));

// This is normal app input, not an AgentRewind concept. In production it might
// be a queue message, HTTP request body, webhook payload, or fixture loaded by a
// test. The harness captures how the agent used this input.
const ticket = {
  id: "ticket_42",
  accountId: "acct_enterprise_7",
  subject: "Checkout API timing out",
  // The pasted token is intentional. This example proves AgentRewind can record
  // useful debugging context while redacting API-key-shaped values on disk.
  body:
    "We are seeing production checkout failures. A customer accidentally pasted token sk-123456789012345678901234 in the thread."
};

let liveModelCalls = 0;
let liveToolCalls = 0;

try {
  const tools = {
    // Tools should represent external boundaries that affect prompts or control
    // flow: database reads, CRM calls, search, billing lookups, HTTP APIs, etc.
    // During record these handlers run normally. During strict replay, their
    // recorded results are returned and these functions are not invoked.
    lookupAccount: async ({ accountId }) => {
      liveToolCalls += 1;

      // Return structured data exactly as your application expects it. The
      // recorded tool result is what replay will feed back into the harness.
      // In production this might be a CRM or billing-system request. Recording
      // the result means replay does not depend on the account's current state.
      return {
        accountId,
        plan: "enterprise",
        annualContractValue: 240000,
        supportTier: "24x7",
        namedCsm: "alex@example.com"
      };
    },
    lookupIncidentStatus: async ({ service }) => {
      liveToolCalls += 1;

      // Do not mock away important context when recording an actual bug. If the
      // model saw this incident state, capture it so the replay can explain the
      // model's decision later.
      // This data is time-sensitive. Capturing it in the session lets engineers
      // replay the triage decision after the incident has changed or closed.
      return {
        service,
        activeIncident: true,
        incidentId: "inc_8842",
        customerVisible: true,
        summary: "Elevated latency and timeouts in us-east-1 checkout-api."
      };
    }
  };

  const harness = async (ctx) => {
    // Think of the harness as the code you want to regression-test. The cleaner
    // this function is, the easier it is to replay a production incident later.
    //
    // The harness should not know whether it is recording or replaying. That
    // property is what makes the same function useful for local debugging, CI
    // regression tests, and fork experiments.

    // Everything that can affect the prompt goes through AgentRewind:
    // tool results, clock, and UUID. Replay receives the same values from the
    // session log, so the model request stays identical.
    const account = await ctx.tools.lookupAccount({ accountId: ticket.accountId });
    const incident = await ctx.tools.lookupIncidentStatus({ service: "checkout-api" });

    // These values often show up in provider metadata and prompts. If you used
    // crypto.randomUUID() or Date.now() directly, strict replay would build a
    // different request and report drift.
    const caseRunId = ctx.uuid();
    const triagedAt = ctx.clock();

    // The real production client would be `new OpenAI({ apiKey, baseURL })`.
    // The harness still calls `ctx.model.create()` so AgentRewind can record and
    // replay the boundary regardless of the concrete OpenAI-compatible vendor.
    const completion = await ctx.model.create(
      {
        model: "support-triage-v1",
        messages: [
          {
            role: "system",
            content:
              "You are a support operations triage agent. Return JSON with queue, priority, customerImpact, and nextAction."
          },
          {
            role: "user",
            content: JSON.stringify({ caseRunId, triagedAt, ticket, account, incident })
          }
        ],
        temperature: 0,
        metadata: { caseRunId, ticketId: ticket.id }
      },

      // Stable site names matter in real applications with multiple model
      // calls. They make drift reports point to a logical operation rather than
      // a stack location or request hash.
      { site: "triage-support-ticket" }
    );

    // Keep provider-specific parsing in ordinary app code. AgentRewind returns
    // the raw provider response during replay so this line does not need a test
    // double or replay-specific branch.
    // Replay returns the original raw Chat Completions response shape, so normal
    // application parsing code can stay exactly the same in record and replay.
    return JSON.parse(completion.choices[0].message.content);
  };

  const record = AgentRewind.record({
    id: "support-triage-enterprise-outage",
    store,
    codec,

    // Tools are passed once when recording. AgentRewind wraps them and exposes
    // the wrapped versions inside the harness as `ctx.tools.*`.
    tools,

    // This fake object has the same method path the OpenAI SDK exposes:
    // `client.chat.completions.create(request)`. Replace it with a real OpenAI
    // or OpenAI-compatible client in production.
    model: fakeOpenAICompatibleClient(() => {
      liveModelCalls += 1;
      // The callback is the only place the fake "provider" is allowed to run.
      // The counter lets the example prove replay did not spend another model
      // call after the recording was written.
      return chatCompletion(
        "chatcmpl_support_triage",
        JSON.stringify({
          queue: "enterprise-escalations",
          priority: "p1",
          customerImpact: "Enterprise checkout failures during an active incident.",
          nextAction: "Page support manager and attach incident inc_8842."
        }),
        { prompt_tokens: 221, completion_tokens: 38, total_tokens: 259 }
      );
    })
  });

  const recorded = await record.run(harness);

  // The value returned from `record.run()` is your app-level result. The session
  // on disk contains the lower-level timeline that makes replay possible.
  // After this close, the session directory is self-contained for strict replay:
  // events.jsonl, metadata, blobs, and the local redaction vault have been
  // written.
  await record.close();

  // `replayRun()` is the shortest path for a one-shot strict replay. It loads
  // the session with no `model` and no `tools`, runs the same harness, and
  // returns the harness result. If the trajectory matches, AgentRewind serves
  // both tool results and the model response from disk.
  const replayed = await AgentRewind.replayRun(
    join(store, "support-triage-enterprise-outage"),
    { codec },
    harness
  );

  // This direct file read is only for demonstration. Normal application tests
  // can use `AgentRewind.replay()` and the CLI without opening the JSONL file.
  // Reading events.jsonl is not required for normal use. This example does it
  // to prove a user-facing property: secrets that look like API keys should not
  // be written in clear text to the portable event log.
  //
  // The local vault can restore redacted values for local replay, but packed
  // sessions intentionally exclude the vault.
  const eventsJsonl = await readFile(join(store, "support-triage-enterprise-outage", "events.jsonl"), "utf8");

  // These assertions are the teaching point of the example. Replay did real
  // work from the caller's perspective, but it did not call the CRM tools or the
  // model a second time.
  if (liveToolCalls !== 2) {
    throw new Error(`Expected two live tool calls during recording only, got ${liveToolCalls}`);
  }
  if (liveModelCalls !== 1) {
    throw new Error(`Expected one live model call during recording only, got ${liveModelCalls}`);
  }
  if (JSON.stringify(recorded) !== JSON.stringify(replayed)) {
    throw new Error("Replay did not reproduce the support triage decision");
  }
  if (eventsJsonl.includes("sk-123456789012345678901234")) {
    throw new Error("Secret token leaked into events.jsonl");
  }

  console.log(
    JSON.stringify(
      {
        example: "replay a support triage agent without repeating CRM/model calls",
        recorded,
        replayed,
        liveToolCalls,
        liveModelCalls,
        redactedTicketSecretOnDisk: true,
        session: join(store, "support-triage-enterprise-outage")
      },
      null,
      2
    )
  );
} finally {
  await rm(store, { recursive: true, force: true });
}

// Minimal OpenAI-compatible fake. AgentRewind only needs the SDK method path
// listed by the codec: `chat.completions.create(request)`.
function fakeOpenAICompatibleClient(createResponse) {
  // If you are using Azure OpenAI, a local gateway, or another compatible
  // provider, the object can still work as long as it exposes the same method
  // path and request/response shape that the codec understands.
  return {
    chat: {
      completions: {
        async create() {
          // The fake ignores the request, but a real client would receive the
          // exact Chat Completions request built inside the harness.
          return createResponse();
        }
      }
    }
  };
}

// Realistic Chat Completions fixture. The codec stores a normalized version for
// matching, but replay returns this raw provider shape to the harness.
function chatCompletion(id, content, usage) {
  return {
    id,
    object: "chat.completion",
    created: 1,
    model: "support-triage-v1",
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
