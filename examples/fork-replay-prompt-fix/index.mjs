import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRewind } from "../../packages/core/dist/index.js";
import { openaiChatCodec } from "../../packages/codec-openai/dist/index.js";

// Real-world use case:
// A refund-review agent made the wrong policy decision. You have a recorded run
// and want to test a prompt/policy fix against the exact same historical inputs.
//
// This is the most direct example of "forking a replay":
// 1. Record the original bad run.
// 2. Strictly replay it to prove the recording is usable.
// 3. Fork from the model-call step.
// 4. Reuse the recorded prefix: entropy and tool calls are not run again.
// 5. Send only the tail model call live with a corrected system instruction.
//
// Read this file when you want to answer: "Would this prompt or model change
// have fixed a real historical agent failure?"
//
// What to copy into your own test:
// - One harness that builds the original agent request.
// - One strict replay that proves the recording is stable.
// - One `replay.fork({ atStep, harness, model, overrides, goal })` call that
//   changes only the experimental tail.
const codec = openaiChatCodec();
const store = await mkdtemp(join(tmpdir(), "agentrewind-fork-replay-"));

const refundCase = {
  caseId: "case_refund_42",
  customerTier: "enterprise",
  renewalAgeDays: 21,
  amountUsd: 48000,
  customerMessage: "Our rollout failed after renewal. Can we get a refund or CSM escalation?"
};

let liveToolCalls = 0;
let recordModelCalls = 0;
let forkModelCalls = 0;

try {
  const tools = {
    // This tool stands in for a policy database or config service. In a real
    // incident, the historical policy snapshot matters: you do not want today's
    // policy table to change the facts while testing a prompt fix.
    loadPolicySnapshot: async ({ caseId }) => {
      liveToolCalls += 1;
      return {
        caseId,
        policyVersion: "2026-05-enterprise-refunds",
        defaultRefundWindowDays: 14,
        enterpriseExceptionWindowDays: 30,
        enterpriseExceptionAction: "escalate-to-csm"
      };
    }
  };

  const harness = async (ctx) => {
    // The harness is intentionally the same for record, replay, and fork. A fork
    // should change the request through explicit overrides, not by changing the
    // historical input-building code.
    //
    // That discipline is what makes fork results meaningful: the input facts are
    // historical, while the tail model behavior is the experiment.
    const reviewId = ctx.uuid();

    // This lookup is deliberately before the model call. Forking at the model
    // call lets AgentRewind reuse this historical policy snapshot while trying
    // a new prompt. That is the core value of a forked replay.
    // Because this tool is called before the model step, a fork at the model
    // step should serve this result from the recording. The live counter below
    // verifies that the policy lookup is not repeated.
    const policy = await ctx.tools.loadPolicySnapshot({ caseId: refundCase.caseId });

    // This is the boundary we will fork from. During the original recording it
    // returns the bad denial. During fork it becomes the first live tail call
    // after the recorded prefix has been reconstructed.
    const completion = await ctx.model.create(
      {
        model: "policy-reviewer-v1",
        messages: [
          {
            role: "system",
            content:
              "Decide refund requests from the supplied policy snapshot. Return JSON with decision, reason, and nextStep."
          },
          {
            role: "user",
            content: JSON.stringify({ reviewId, refundCase, policy })
          }
        ],
        temperature: 0,
        metadata: { reviewId, caseId: refundCase.caseId }
      },
      // Use a stable site name for every important model call. If you later add
      // another model call to this harness, the site name keeps replay matching
      // and drift messages tied to the logical operation.
      { site: "refund-policy-decision" }
    );

    return JSON.parse(completion.choices[0].message.content);
  };

  // Recording creates the baseline session. In a production workflow this
  // session might come from a failing CI test, a production incident capture, or
  // a manually saved debugging run.
  const record = AgentRewind.record({
    id: "fork-replay-refund-policy",
    store,
    codec,
    tools,
    model: fakeOpenAICompatibleClient(() => {
      recordModelCalls += 1;
      // This fixture simulates the historical bad response. AgentRewind records
      // it once and should never call this record model again during replay.
      return chatCompletion(
        "chatcmpl_refund_bad",
        JSON.stringify({
          decision: "deny",
          reason: "The default refund window is 14 days and the renewal is 21 days old.",
          nextStep: "send-denial-template"
        }),
        { prompt_tokens: 154, completion_tokens: 34, total_tokens: 188 }
      );
    })
  });

  const recorded = await record.run(harness);

  // Close before replay/fork. A fork reads the completed parent session from
  // disk and writes a separate child session for the changed tail.
  await record.close();

  // Step 1 after recording: strict replay should reproduce the denial without
  // passing tools or a model. If this step fails, the session is not a reliable
  // baseline for a fork.
  //
  // Replay is loaded without tools or a model. This proves the session has the
  // complete historical prefix needed for a fork: UUID, policy tool result, and
  // original model response.
  const replay = await AgentRewind.replay(join(store, "fork-replay-refund-policy"), { codec });
  const replayed = await replay.run(harness);

  // The event list is the map of possible fork points. For prompt experiments,
  // choose the model-call step that produced the bad answer. For tool behavior
  // experiments, choose the tool-call step you want to replace.
  // The fork point is expressed as a recorded step number. Here we choose the
  // model call because the policy lookup should stay historical, while the model
  // answer is exactly what we want to experiment with.
  const modelStep = replay.events().find((event) => event.kind === "model_call")?.step;
  if (modelStep === undefined) throw new Error("No refund policy model step was recorded");

  // Step 2: fork the replay.
  //
  // The fork starts at the recorded model call. AgentRewind serves earlier
  // entropy/tool events from the recording, applies the override below, then
  // calls the live model for the tail. That is the key distinction from replay:
  // replay returns recorded outputs; fork reuses a recorded prefix and explores
  // a new live tail.
  const fork = await replay.fork({
    atStep: modelStep,

    // `atStep` is inclusive for the live tail in this example: the recorded
    // model call at `modelStep` is replaced by the live fork model call below.
    // Earlier UUID/tool events are still served from the parent recording.
    //
    // Pass the harness when the fork should execute your current agent code.
    // Without it, fork can still walk stored events, but prompt-fix experiments
    // are easier to reason about when the harness is explicit.
    harness,
    model: fakeOpenAICompatibleClient(() => {
      forkModelCalls += 1;
      // This is the only live provider call in the forked run. In a real test it
      // would be your actual provider/model with the changed prompt or model id.
      return chatCompletion(
        "chatcmpl_refund_fixed",
        JSON.stringify({
          decision: "escalate-to-csm",
          reason: "Enterprise renewals inside 30 days qualify for CSM escalation.",
          nextStep: "create-csm-escalation"
        }),
        { prompt_tokens: 169, completion_tokens: 35, total_tokens: 204 }
      );
    }),
    overrides: {
      // A fork override lets you test a prompt or model change against the same
      // recorded facts. Here the historical policy snapshot is unchanged, but
      // the system instruction now emphasizes the enterprise exception.
      //
      // For OpenAI Chat Completions, the codec maps `overrides.system` onto the
      // system message in the request before the live tail call is made.
      system:
        "Decide refund requests from the supplied policy snapshot. Enterprise renewals inside the exception window must use the enterpriseExceptionAction. Return JSON with decision, reason, and nextStep."
    },
    // The goal converts the fork from a manual experiment into an assertion.
    // A CI test can fail if the prompt change stops producing the desired
    // decision for this recorded historical case.
    goal: (trace) =>
      trace.events().some(
        (event) => event.kind === "model_call" && modelEventText(event).includes('"decision":"escalate-to-csm"')
      )
  });

  // After the fork, inspect the child trace rather than the parent replay. The
  // child trace contains the live tail events created by the prompt experiment.
  // The fork result contains a trace for the child session. Reading the model
  // event from that trace lets the example report what the changed prompt did.
  const forkedDecision = fork.trace
    .events()
    .filter((event) => event.kind === "model_call")
    .map(modelEventJson)
    .find((decision) => decision?.decision === "escalate-to-csm");

  if (recorded.decision !== "deny") {
    throw new Error("The recording did not capture the expected bad refund decision");
  }
  if (JSON.stringify(recorded) !== JSON.stringify(replayed)) {
    throw new Error("Strict replay did not reproduce the original refund decision");
  }
  if (!fork.reachedGoal || !forkedDecision) {
    throw new Error("Fork did not reach the corrected refund decision");
  }
  // This is the key safety assertion for forked replays: the historical policy
  // lookup was not repeated, but the fork did make one new model call for the
  // changed tail.
  if (liveToolCalls !== 1) {
    throw new Error(`Expected the policy tool to run only during recording, got ${liveToolCalls}`);
  }
  if (recordModelCalls !== 1 || forkModelCalls !== 1) {
    throw new Error(`Expected one record model call and one fork model call, got ${recordModelCalls}/${forkModelCalls}`);
  }

  // In a real regression test you might assert only the fields above. The JSON
  // output is included so running this example shows the full fork story:
  // original result, strict replay result, fork result, and token spend.
  console.log(
    JSON.stringify(
      {
        example: "fork a replay to test a prompt fix",
        recorded,
        replayed,
        forkedDecision,
        forkStartedAtStep: modelStep,
        liveToolCalls,
        recordModelCalls,
        forkModelCalls,
        forkTokensSpent: fork.tokensSpent
      },
      null,
      2
    )
  );
} finally {
  await rm(store, { recursive: true, force: true });
}

function fakeOpenAICompatibleClient(createResponse) {
  // The real OpenAI SDK nests Chat Completions at this path. The codec wraps
  // this method path, so the fake must preserve the same shape.
  return {
    chat: {
      completions: {
        async create() {
          return createResponse();
        }
      }
    }
  };
}

function chatCompletion(id, content, usage) {
  // Keep fixtures close to the provider's real response shape. That makes the
  // example useful as a template for app code that already parses SDK responses.
  return {
    id,
    object: "chat.completion",
    created: 1,
    model: "policy-reviewer-v1",
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

function modelEventText(event) {
  // Fork goals often inspect recorded events rather than application return
  // values. This helper handles the raw OpenAI shape plus the normalized shape
  // so the example stays readable.
  const content = event.response?.raw?.choices?.[0]?.message?.content ?? event.response?.content?.content ?? event.response?.content;
  return typeof content === "string" ? content : JSON.stringify(content);
}

function modelEventJson(event) {
  try {
    return JSON.parse(modelEventText(event));
  } catch {
    return undefined;
  }
}
