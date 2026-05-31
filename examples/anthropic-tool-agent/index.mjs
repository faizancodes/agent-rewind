import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRewind } from "../../packages/core/dist/index.js";
import { anthropicCodec } from "../../packages/codec-anthropic/dist/index.js";

// Real-world use case:
// A customer-support agent reads subscription data, checks refund policy, creates
// an escalation record, and asks Anthropic Messages to draft the customer reply.
// Replay must not create a second escalation or call Anthropic again.
const codec = anthropicCodec();

// Use the Anthropic codec when your real model client exposes
// `client.messages.create()`. The harness can still call `ctx.model.create()`;
// the codec handles the provider-specific request/response shape.

// The example cleans up after itself. In a real support system, keep the session
// long enough to inspect it, pack it, or use it as a regression fixture.
const store = await mkdtemp(join(tmpdir(), "agentrewind-anthropic-refund-"));

// These counters make the safety property visible. Record should call tools and
// Anthropic once. Replay should return the same application result with no new
// provider calls and no duplicated write-like side effects.
let liveModelCalls = 0;
let liveToolCalls = 0;
let escalationSideEffects = 0;

const refundRequest = {
  customerId: "cus_enterprise_123",
  message: "We renewed 21 days ago but need to cancel after a failed rollout. Can you refund the renewal?",
  region: "US"
};

try {
  const tools = {
    // Each tool models a boundary you do not want to repeat during replay. Reads
    // are captured for determinism; writes are captured so replay does not
    // duplicate side effects.
    loadSubscription: async ({ customerId }) => {
      liveToolCalls += 1;

      // Return the exact shape your agent normally consumes. Replay feeds this
      // object back through `ctx.tools.loadSubscription()` without running the
      // handler again.
      // Billing state can change after the original support interaction. The
      // recorded result freezes the facts that the model actually saw.
      return {
        customerId,
        plan: "enterprise",
        renewalAmountUsd: 48000,
        renewalAgeDays: 21,
        namedCsm: "alex@example.com"
      };
    },
    lookupRefundPolicy: async ({ plan, region }) => {
      liveToolCalls += 1;

      // Policy tools are good candidates for recording because the current
      // policy may differ from the policy that existed when the customer wrote.
      // Policy configuration is another common source of replay drift. Capture
      // the policy used by the original decision, not whatever policy exists
      // when an engineer investigates later.
      return {
        plan,
        region,
        refundWindowDays: plan === "enterprise" ? 30 : 14,
        requiresCsmApproval: plan === "enterprise"
      };
    },
    createEscalation: async ({ customerId, reason }) => {
      liveToolCalls += 1;

      // This counter stands in for a real write, such as creating a CRM ticket
      // or sending a message. The replay assertion below proves the write only
      // happened during the original recording.
      //
      // Write-like tools are where strict replay is most useful: engineers can
      // reproduce downstream behavior without sending duplicate emails, tickets,
      // refunds, or Slack messages.
      escalationSideEffects += 1;
      return {
        escalationId: "esc_7001",
        customerId,
        reason,
        assignedTeam: "enterprise-csm"
      };
    }
  };

  const harness = async (ctx) => {
    // The harness should look like normal agent code. The only discipline is
    // that provider calls and external I/O go through `ctx`.
    //
    // That discipline is especially important for write-like tools. Replaying
    // the agent should exercise downstream logic without creating another CRM
    // escalation, refund, email, or ticket.

    // These tools represent real systems: billing, policy config, and CRM. They
    // are intentionally routed through `ctx.tools` so replay can return the
    // recorded outputs without repeating reads or writes.
    const subscription = await ctx.tools.loadSubscription({ customerId: refundRequest.customerId });
    const policy = await ctx.tools.lookupRefundPolicy({
      plan: subscription.plan,
      region: refundRequest.region
    });
    const escalation = await ctx.tools.createEscalation({
      customerId: refundRequest.customerId,
      reason: "Refund request inside enterprise refund window"
    });

    // Notes are optional, but they are useful when an event timeline needs
    // human-readable breadcrumbs. Use them for facts you would want in a bug
    // report or audit trail.
    // They are not inputs to replay matching, so adding a note does not change
    // which model or tool boundary is served from the log.
    ctx.note(`Created escalation ${escalation.escalationId} before drafting the reply.`);

    // This model call sees both read results and the write result. Because all
    // three tools were recorded first, replay can rebuild the same Anthropic
    // request without calling those external systems again.
    // Anthropic's real SDK method is `client.messages.create()`. The harness
    // stays provider-neutral by calling `ctx.model.create()`, while the codec
    // maps the boundary to Anthropic's Messages shape during record/replay.
    const message = await ctx.model.create(
      {
        model: "claude-opus-4-8",
        max_tokens: 300,
        system:
          "You are a careful support agent. Draft a concise reply. Mention the next step, but do not expose raw policy JSON.",
        messages: [
          {
            role: "user",
            content: JSON.stringify({ refundRequest, subscription, policy, escalation })
          }
        ]
      },

      // Use a stable site name for the model call. If a future prompt edit makes
      // this request drift, the error will point at this logical operation.
      { site: "draft-refund-reply" }
    );

    return {
      escalationId: escalation.escalationId,
      reply: textFromAnthropicMessage(message)
    };
  };

  const record = AgentRewind.record({
    id: "anthropic-refund-escalation",
    store,
    codec,

    // AgentRewind records the tool outputs and model response in one ordered
    // trace. That matters for agents where tool results are fed into prompts.
    tools,

    // Real Anthropic clients expose `client.messages.create(request)`. This fake
    // preserves that shape so the example exercises the same codec path.
    model: {
      messages: {
        async create(request) {
          liveModelCalls += 1;

          // The fake provider is also a contract check. If the harness stops
          // producing an Anthropic-shaped request, the recording fails before
          // replay can hide the mistake.
          // Keep request assertions close to the fake provider. That way the
          // example fails at record time if the codec or harness stops sending
          // the Anthropic-shaped request you expect.
          if (request.model !== "claude-opus-4-8") {
            throw new Error("Anthropic request did not preserve the requested model");
          }
          return anthropicMessage(
            "msg_refund_escalation",
            "Thanks for the context. Your renewal is still inside the enterprise refund window, so I have escalated this to your named CSM for approval and next steps.",
            { input_tokens: 212, output_tokens: 34 }
          );
        }
      }
    }
  });

  const recorded = await record.run(harness);

  // Close before replay so the full ordered trace is available on disk. This is
  // the same pattern you want in tests: record, close, then replay or inspect.
  // Closing persists both the tool-call trace and the Anthropic model boundary.
  // Without this, replay would not have a completed session to read.
  await record.close();

  // Replay supplies no tools and no model. `replayRun()` is the simple helper
  // for this case: load the session, run the harness once, and return the
  // replayed application result. Strict replay should not create a second
  // escalation record or spend Anthropic tokens while reproducing the reply.
  const replayed = await AgentRewind.replayRun(
    join(store, "anthropic-refund-escalation"),
    { codec },
    harness
  );

  // These checks make side-effect safety explicit. A useful replay test should
  // assert both the returned value and the absence of repeated external effects.
  // These counters are user-facing proof of safety. Replay produced the same
  // customer reply without running any tool handlers or model calls again.
  if (liveToolCalls !== 3) {
    throw new Error(`Expected three live tool calls during recording only, got ${liveToolCalls}`);
  }
  if (escalationSideEffects !== 1) {
    throw new Error(`Expected one escalation side effect during recording only, got ${escalationSideEffects}`);
  }
  if (liveModelCalls !== 1) {
    throw new Error(`Expected one live Anthropic call during recording only, got ${liveModelCalls}`);
  }
  if (JSON.stringify(recorded) !== JSON.stringify(replayed)) {
    throw new Error("Replay did not reproduce the refund reply");
  }

  console.log(
    JSON.stringify(
      {
        example: "replay an Anthropic support agent without duplicating side effects",
        recorded,
        replayed,
        liveToolCalls,
        liveModelCalls,
        escalationSideEffects
      },
      null,
      2
    )
  );
} finally {
  await rm(store, { recursive: true, force: true });
}

// Fixture with the same high-level shape as Anthropic Messages responses.
function anthropicMessage(id, text, usage) {
  // This mirrors the parts of an Anthropic Messages response that typical app
  // code reads: content blocks, stop reason, model, and usage.
  return {
    id,
    type: "message",
    role: "assistant",
    model: "claude-opus-4-8",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage
  };
}

// Anthropic returns content blocks. Most application code wants plain assistant
// text, so the harness uses this same extraction helper in record and replay.
function textFromAnthropicMessage(message) {
  // Keeping provider-specific parsing in a helper is a useful pattern for real
  // harnesses too. The same helper runs in record and replay, which keeps the
  // test focused on boundary behavior instead of response-shape plumbing.
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}
