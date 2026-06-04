import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRewind, search as trajectorySearch } from "../../packages/core/dist/index.js";
import { openaiChatCodec } from "../../packages/codec-openai/dist/index.js";

// Real-world use case:
// A support-routing agent made a bad refund decision. You do not want to rerun
// CRM or policy tools repeatedly while guessing at prompt fixes. Instead, you
// want to reuse the recorded prefix, try several candidate tail prompts, rank
// the outcomes, and keep the best child run as regression coverage.
//
// This example shows trajectory search:
// 1. Record one bad agent run.
// 2. Strictly replay it to prove the recording is stable.
// 3. Search candidate prompt tails from the bad model-call step.
// 4. Pick the best child session by a scoring function.
// 5. Replay the best child with the fixed harness that now builds that prompt.
//
// Read this file when one fork is not enough and you want a small beam or
// Monte Carlo search over prompt/model choices from a real historical step.
const codec = openaiChatCodec();
const store = await mkdtemp(join(tmpdir(), "agentrewind-trajectory-search-"));

const refundTicket = {
  id: "ticket_219",
  customerTier: "enterprise",
  renewalAgeDays: 21,
  message: "Our launch was blocked after renewal. Can support route this to our CSM?"
};

let policyLookups = 0;
let recordModelCalls = 0;
let searchModelCalls = 0;

try {
  const originalSystemPrompt = "Classify refund requests. If the policy is unclear, choose hold.";
  const escalationSystemPrompt = "Classify refund requests. Enterprise exceptions inside 30 days must escalate-to-csm.";

  const tools = {
    // This tool stands in for CRM, billing, policy, or database work. It is
    // deliberately before the model call so every search rollout can reuse the
    // same historical facts instead of calling live systems again.
    loadPolicy: async ({ ticketId }) => {
      policyLookups += 1;
      return {
        ticketId,
        defaultRefundWindowDays: 14,
        enterpriseExceptionWindowDays: 30,
        enterpriseExceptionAction: "escalate-to-csm"
      };
    }
  };

  const createHarness = (systemPrompt) => async (ctx) => {
    const policy = await ctx.tools.loadPolicy({ ticketId: refundTicket.id });

    // This is the decision boundary where the original run went wrong. Search
    // starts from this recorded step. Everything before it is served from the
    // recording; only the tail model call is live during each rollout.
    const completion = await ctx.model.create(
      {
        model: "support-router-v1",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: JSON.stringify({ refundTicket, policy }) }
        ],
        temperature: 0
      },
      { site: "refund-routing-decision" }
    );

    return completion.choices[0].message.content;
  };

  const originalHarness = createHarness(originalSystemPrompt);
  const fixedHarness = createHarness(escalationSystemPrompt);

  const record = AgentRewind.record({
    id: "trajectory-search-refund",
    store,
    codec,
    tools,
    model: fakeOpenAICompatibleClient(() => {
      recordModelCalls += 1;
      return chatCompletion("chatcmpl_bad", "hold", { prompt_tokens: 120, completion_tokens: 8, total_tokens: 128 });
    })
  });

  const recorded = await record.run(originalHarness);
  await record.close();

  // Strict replay should reproduce the bad decision with no tools or model. If
  // this fails, the parent session is not a reliable base for search.
  const replay = await AgentRewind.replay(join(store, "trajectory-search-refund"), { codec });
  const replayed = await replay.run(originalHarness);

  const modelStep = replay.events().find((event) => event.kind === "model_call")?.step;
  if (modelStep === undefined) throw new Error("No refund-routing model step was recorded");

  const prompts = [
    {
      id: "baseline-hold",
      label: "Keep hold policy",
      system: "Classify refund requests. If the policy is unclear, choose hold."
    },
    {
      id: "enterprise-escalation",
      label: "Escalate enterprise exceptions",
      system: escalationSystemPrompt
    },
    {
      id: "refund-first",
      label: "Approve refunds first",
      system: "Classify refund requests. Prefer refund-approved whenever the customer is enterprise."
    }
  ];

  const search = await trajectorySearch.promptSweep(replay, {
    atStep: modelStep,
    harness: originalHarness,
    model: fakeOpenAICompatibleClient((request) => {
      searchModelCalls += 1;
      const system = request.messages.find((message) => message.role === "system")?.content ?? "";
      const content = system.includes("escalate-to-csm")
        ? "escalate-to-csm"
        : system.includes("refund-approved")
          ? "refund-approved"
          : "hold";
      return chatCompletion(`chatcmpl_search_${searchModelCalls}`, content, {
        prompt_tokens: 135,
        completion_tokens: 9,
        total_tokens: 144
      });
    }),
    strategy: "beam",
    budget: { maxRollouts: prompts.length, stopScore: 1 },
    prompts,
    // The scorer is where your product goal becomes executable. It can inspect
    // the harness result, the child trace, token spend, tool events, or any
    // domain-specific invariant. Higher scores win.
    score: ({ result }) => ({
      score: result === "escalate-to-csm" ? 1 : result === "refund-approved" ? 0.5 : 0,
      reason: `decision=${String(result)}`
    })
  });

  const best = search.best;
  if (!best?.sessionPath) throw new Error("Trajectory search did not produce a best child session");

  // A prompt-changing child should be replayed with the harness code that now
  // builds the prompt tested by the search. That turns the chosen fork into a
  // deterministic regression test for this historical ticket.
  const childReplay = await AgentRewind.replay(best.sessionPath, { codec });
  const replayedBest = await childReplay.run(fixedHarness);

  if (recorded !== "hold" || replayed !== "hold") {
    throw new Error("The parent recording did not reproduce the original bad decision");
  }
  if (best.action?.id !== "enterprise-escalation" || best.score !== 1) {
    throw new Error(`Expected enterprise-escalation to win, got ${best.action?.id ?? "none"}`);
  }
  if (replayedBest !== "escalate-to-csm") {
    throw new Error("The best child session did not replay with the fixed harness");
  }
  if (policyLookups !== 1 || recordModelCalls !== 1 || searchModelCalls !== 2) {
    throw new Error(`Unexpected live calls: policy=${policyLookups} record=${recordModelCalls} search=${searchModelCalls}`);
  }

  console.log(
    JSON.stringify(
      {
        example: "search candidate prompt tails from a bad agent step",
        recorded,
        replayed,
        bestAction: best.action.label,
        bestScore: best.score,
        bestReason: best.reason,
        replayedBest,
        rollouts: search.rollouts,
        stoppedReason: search.stoppedReason,
        searchTokensSpent: search.tokensSpent,
        searchManifest: search.searchPath,
        childSession: best.sessionPath,
        liveCalls: {
          policyLookups,
          recordModelCalls,
          searchModelCalls
        }
      },
      null,
      2
    )
  );
} finally {
  await rm(store, { recursive: true, force: true });
}

function fakeOpenAICompatibleClient(nextCompletion) {
  return {
    chat: {
      completions: {
        async create(request) {
          return nextCompletion(request);
        }
      }
    }
  };
}

function chatCompletion(id, content, usage) {
  return {
    id,
    object: "chat.completion",
    created: 0,
    model: "support-router-fixture",
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: { role: "assistant", content }
      }
    ],
    usage
  };
}
