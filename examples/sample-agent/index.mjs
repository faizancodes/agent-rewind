import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRewind } from "../../packages/core/dist/index.js";

// Real-world use case:
// An incident-routing agent made the wrong call during an outage. You want to
// inspect exactly what the model saw, replay the failure deterministically, and
// fork from the bad model step with a corrected prompt.
//
// This example uses a tiny custom codec so the core AgentRewind lifecycle is
// visible without OpenAI/Anthropic SDK details.
const codec = {
  name: "incident-router-demo",
  interceptPoints: ["create"],

  // A provider codec is the adapter between your SDK's raw request/response
  // objects and AgentRewind's normalized event log. Most users should import a
  // ready-made codec, such as `openaiChatCodec()` or `anthropicCodec()`. This
  // custom codec is here only to keep the example focused on the replay flow.
  //
  // The normalized request is what AgentRewind fingerprints. If the same
  // harness builds the same normalized request during replay, AgentRewind can
  // safely return the recorded response instead of calling a provider.
  normalizeRequest(raw) {
    return raw;
  },
  // Forking needs to turn the normalized request back into the provider's raw
  // SDK shape before sending the live tail call. This fake provider already
  // uses the normalized shape, so denormalization is a no-op.
  denormalizeRequest(req) {
    return req;
  },
  // Normalize responses into provider-neutral fields used by inspect, diff,
  // token accounting, and fork goals. The raw response is kept for app code and
  // for engineers who want to debug the original provider payload.
  normalizeResponse(raw) {
    return { content: raw.content, usage: raw.usage, raw };
  },

  // The sample agent does not stream, but a complete codec still defines stream
  // behavior. If your agent streams, see `openai-compatible-streaming`.
  normalizeStream(rawChunks) {
    return { final: { content: rawChunks, raw: rawChunks }, chunks: rawChunks.map((data, offsetMs) => ({ offsetMs, data })) };
  },
  async *rebuildStream(chunks) {
    for (const chunk of chunks) yield chunk.data;
  },
  stripVolatile(req) {
    return JSON.parse(JSON.stringify(req));
  },

  // Return paths that should not affect request matching. This fake request has
  // no volatile leaves. Real codecs often ignore metadata or provider-generated
  // request ids so replay does not drift on harmless values.
  volatileLeafPaths() {
    return [];
  },
  extractUsage(normalizedResponse) {
    return normalizedResponse.usage;
  },
  // Fork overrides are deliberately centralized in the codec. That keeps
  // provider-specific details out of the core fork engine and lets each codec
  // decide how to apply a new system prompt, model id, or request transform.
  applyOverrides(req, overrides, step) {
    const next = { ...req, messages: req.messages.map((message) => ({ ...message })), params: { ...req.params } };
    if (overrides.system !== undefined) next.system = overrides.system;
    if (overrides.model !== undefined) next.model = overrides.model;
    return overrides.transformRequest ? overrides.transformRequest(next, step) : next;
  }
};

// In production this session store would usually be ".rewind" so engineers can
// inspect the recording later. The example uses a temp directory so it leaves no
// files behind.
const store = await mkdtemp(join(tmpdir(), "agentrewind-incident-router-"));

// Treat this object as the historical input that came from your application:
// webhook payload, queue item, ticket, incident snapshot, or test fixture. The
// harness below will combine this input with replayable boundaries to build the
// model request.
const incident = {
  id: "inc_8842",
  service: "checkout-api",
  region: "us-east-1",
  severity: "sev2",
  customerImpact: "Enterprise checkout requests are timing out for 18% of traffic.",
  signals: {
    p95LatencyMs: 4300,
    errorRate: 0.18,
    openEnterpriseTickets: 11
  },
  runbook: "If p95 latency exceeds 2000 ms and enterprise checkout is affected, page the primary on-call."
};

try {
  const originalSystemPrompt = "You classify incidents for the on-call team. Return compact JSON.";
  const fixedSystemPrompt =
    "You are an incident commander. Follow runbooks strictly. Enterprise checkout impact with p95 latency above 2000 ms must page the primary on-call.";

  const createHarness = (systemPrompt) => async (ctx) => {
    // The harness is the agent workflow under test. It is run unchanged during
    // record, replay, and fork.
    //
    // A good harness contains the decision-making flow, not the setup code for
    // a particular test. That is what lets you replay a production run and then
    // fork it with a different prompt without rewriting the agent.
    //
    // Copy this structure into real tests: pass business inputs from the outer
    // scope, and route every nondeterministic boundary through `ctx`.

    // Use `ctx.uuid()` and `ctx.clock()` for values that become part of prompts.
    // AgentRewind records them as entropy events so replay receives the same
    // values and can rebuild the exact original model request.
    const runId = ctx.uuid();
    const observedAt = ctx.clock();

    // This model boundary is what AgentRewind records. During replay this exact
    // request is matched to the stored response, so no live model is needed.
    const response = await ctx.model.create(
      {
        model: "ops-routing-model",
        system: systemPrompt,
        messages: [
          {
            role: "user",
            content: JSON.stringify({
              runId,
              observedAt,
              task: "Choose one action: watch, create-ticket, or page-primary.",
              incident
            })
          }
        ],
        params: { temperature: 0 }
      },

      // Give important model calls stable site names. When replay drifts, this
      // label is what tells an engineer which logical call stopped matching.
      { site: "incident-routing-decision" }
    );

    // The library does not care what your harness returns. Return the same
    // domain object your product code would use so replay/fork assertions stay
    // close to the real behavior you are debugging.
    return JSON.parse(response.content);
  };
  const harness = createHarness(originalSystemPrompt);
  const fixedHarness = createHarness(fixedSystemPrompt);

  // The first live model response is intentionally wrong. That gives us a
  // realistic failure to inspect and fork.
  //
  // Step 1: record the original run. This is the only phase that should call
  // the live model for the bad decision.
  const recording = AgentRewind.record({
    id: "incident-routing-bad-decision",

    // Recording writes a session directory under `store/id`. The session stores
    // model calls, tool calls, entropy events, notes, redaction metadata, and a
    // local vault used to restore redacted values during local replay.
    store,
    codec,

    // During record this model is called live. During replay below, we do not
    // pass a model at all, proving the recorded response is enough.
    model: fakeModel([
      {
        content: JSON.stringify({
          action: "watch",
          reason: "The severity is sev2, so wait for more evidence before paging."
        }),
        usage: { inputTokens: 185, outputTokens: 24 }
      }
    ])
  });

  const recordedDecision = await recording.run(harness);

  // Always close a recording. Closing flushes events, metadata, redaction
  // summaries, and vault data to disk.
  await recording.close();

  // Step 2: load the recording for strict replay and inspection.
  //
  // Replay is deliberately loaded without a model client. If this succeeds, the
  // bad decision can be reproduced from the session alone.
  const replay = await AgentRewind.replay(join(store, "incident-routing-bad-decision"), { codec });

  // In real sessions, avoid hard-coding step numbers. Find the step from the
  // recorded event timeline so the example keeps working if earlier tool or
  // entropy events are added to the harness.
  const modelStep = replay.events().find((event) => event.kind === "model_call")?.step;
  if (modelStep === undefined) throw new Error("No incident-routing model step was recorded");

  // `stepTo()` moves the replay cursor for inspection APIs. It does not rerun
  // the provider. It only tells AgentRewind which recorded step you want to
  // inspect.
  replay.stepTo(modelStep);

  // `contextAt(step)` is an inspection API. It lets a developer see the prompt
  // that produced a decision without manually digging through JSONL files.
  const capturedPrompt = replay.contextAt(modelStep);

  // Running the harness against `replay` should produce the same bad decision.
  // If the harness makes a different model/tool/entropy call, strict replay
  // throws a drift error instead of silently calling a live provider.
  const replayedDecision = await replay.run(harness);

  // Step 3: fork from the exact model step that produced the bad decision.
  //
  // Fork from the bad model step. The prefix of the run stays recorded, but the
  // model call is sent live again with a stronger system prompt. This is how an
  // engineer can test prompt fixes against the exact historical failure.
  const fork = await replay.fork({
    atStep: modelStep,

    // Passing the harness makes the fork execute the current agent code
    // explicitly. That is clearer than relying on a previous replay.run() call
    // to remember the harness.
    harness,

    // Fork needs a live model for the tail after `atStep`. The prefix stays
    // recorded; only the model call at/after the fork point spends tokens.
    model: fakeModel([
      {
        content: JSON.stringify({
          action: "page-primary",
          reason: "The runbook requires paging when p95 latency exceeds 2000 ms and enterprise checkout is affected."
        }),
        usage: { inputTokens: 198, outputTokens: 31 }
      }
    ]),
    overrides: {
      // `system` is a common fork override: keep the historical user input, but
      // test a revised system instruction against the exact same situation.
      system: fixedSystemPrompt
    },

    // A goal makes fork output machine-checkable. In real tests, this can assert
    // that the fork reached a tool call, returned a specific route, or stayed
    // under a token budget.
    goal: (trace) =>
      trace.events().some(
        (event) => event.kind === "model_call" && typeof event.response?.content === "string" && event.response.content.includes("page-primary")
      )
  });

  // A fork writes a child session that contains the recorded prefix plus the new
  // tail result. Replaying that child with the full fixed harness is how you
  // turn the prompt experiment into deterministic regression coverage. The
  // workflow shape is still complete; only the prompt code has been updated to
  // match the forked tail request.
  const forkChildReplay = await AgentRewind.replay(join(store, fork.sessionId), { codec });
  const forkChildDecision = await forkChildReplay.run(fixedHarness);

  if (recordedDecision.action !== "watch") {
    throw new Error("The recording did not capture the expected bad decision");
  }
  if (JSON.stringify(recordedDecision) !== JSON.stringify(replayedDecision)) {
    throw new Error("Replay did not reproduce the bad decision");
  }
  if (!fork.reachedGoal) {
    throw new Error("Fork did not reach the corrected paging decision");
  }
  if (forkChildDecision.action !== "page-primary") {
    throw new Error("Child replay did not reproduce the forked paging decision");
  }

  // The printed object is what an engineer usually wants after a debugging
  // run: the original decision, the replayed decision, the inspected prompt
  // context, and the replayable child session created by the fork.
  console.log(
    JSON.stringify(
      {
        example: "debug and fork a bad incident-routing decision",
        recordedDecision,
        replayedDecision,
        inspectedModelStep: modelStep,
        capturedPrompt,
        forkSessionId: fork.sessionId,
        forkReachedGoal: fork.reachedGoal,
        forkChildDecision,
        forkTokensSpent: fork.tokensSpent
      },
      null,
      2
    )
  );
} finally {
  await rm(store, { recursive: true, force: true });
}

// This fake model behaves like a live provider from AgentRewind's perspective:
// it has the configured `create()` method and returns provider-shaped data. The
// queue makes accidental extra live calls fail loudly.
function fakeModel(responses) {
  const queue = [...responses];
  return {
    async create() {
      // Failing on an empty queue is intentional. It turns accidental extra
      // live model calls into obvious test failures instead of silently
      // returning another fixture.
      const next = queue.shift();
      if (!next) throw new Error("No fake incident-routing response queued");
      return next;
    }
  };
}
