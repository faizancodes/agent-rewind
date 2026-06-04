import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ForkOverrides } from "./codec.js";
import { isBoundaryEvent, type ModelCallEvent, type RewindEvent, type SerializedError, type Usage } from "./events.js";
import type { ForkOptions, ForkResult, Trace } from "./fork.js";
import { forkReplay } from "./fork.js";
import type { Harness, ToolHandlers, UntypedToolHandlers } from "./record.js";
import type { ReplaySession } from "./replay.js";
import { serializeError } from "./session-store.js";
import { usageAdd } from "./tokens.js";

type MaybePromise<T> = T | Promise<T>;

export type TrajectorySearchStrategy = "monte-carlo" | "beam" | "ucb" | "mcts" | "alpha-zero";
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;
export interface JsonObject {
  [key: string]: JsonValue;
}
export interface JsonArray extends Array<JsonValue> {}
export type TrajectoryBestBranchMetric = "mean" | "lower-confidence-bound" | "pass-rate";

/**
 * Why a bandit/tree rollout's arm or branch was selected:
 * - `"unvisited"`: forced first-time exploration; no finite selection score exists yet.
 * - `"ucb"`: chosen by the UCB/UCT upper-confidence score.
 * - `"puct"`: chosen by the AlphaZero-style PUCT score.
 */
export type TrajectorySelectionReason = "unvisited" | "ucb" | "puct";

export interface TrajectorySearchAction {
  /** Stable action id used in reports and tree nodes. */
  id?: string;
  /**
   * Stable branch key used by diagnostics. AgentRewind generates one from the
   * action shape when omitted, so reused action ids with different prompts do
   * not collapse into one branch.
   */
  actionKey?: string;
  /** Human-readable label for prompt/model/tool-policy experiments. */
  label?: string;
  /** Prompt/model/request changes passed to fork live tail model calls. */
  overrides?: ForkOverrides;
  /** Optional live model client for this action. Defaults to the search model/replay model. */
  model?: unknown;
  /** Optional fork tool policy for this action. */
  tools?: ForkOptions["tools"];
  /** Optional policy prior used by `strategy: "alpha-zero"`. Missing priors are uniform only when no sibling declares one. */
  prior?: number;
  /** User metadata carried through search results. */
  metadata?: JsonValue;
}

export interface TrajectorySearchBudget {
  /** Maximum fork rollouts to execute. Defaults to the number of actions for beam and 10 for other strategies. */
  maxRollouts?: number;
  /** Maximum action-sequence depth. Defaults to 1. */
  maxDepth?: number;
  /** Beam width for `strategy: "beam"`. Defaults to 3. */
  beamWidth?: number;
  /** UCB/UCT exploration weight for `strategy: "ucb"` and `strategy: "mcts"`. Defaults to sqrt(2). */
  explorationWeight?: number;
  /** PUCT exploration weight for `strategy: "alpha-zero"`. Defaults to 1.5. */
  puctExploration?: number;
  /** Stop after live tail token usage reaches or exceeds this input+output token budget. */
  maxTokens?: number;
  /** Stop when a rollout score is at least this value. */
  stopScore?: number;
}

export interface TrajectorySearchActionContext<TResult = unknown> {
  strategy: TrajectorySearchStrategy;
  depth: number;
  rollout: number;
  parent?: TrajectorySearchNode<TResult>;
  best?: TrajectorySearchNode<TResult>;
}

export interface TrajectorySearchScore {
  score: number;
  reason?: string;
  metadata?: JsonValue;
  /** Token/cost usage spent by an external judge used to score this rollout. */
  judgeUsage?: Usage;
}

export interface TrajectorySearchScoreContext<TResult = unknown> {
  action: TrajectorySearchAction;
  actionSequence: TrajectorySearchAction[];
  depth: number;
  rollout: number;
  fork: ForkResult<TResult>;
  trace: Trace;
  result?: TResult;
  tokensSpent: Usage;
}

export interface TrajectorySearchOptions<
  TResult = unknown,
  TTools extends ToolHandlers = UntypedToolHandlers,
  TRequest = unknown,
  TResponse = unknown,
  TStreamChunk = unknown
> {
  /** Recorded boundary step where every rollout begins live execution. */
  atStep: number;
  /** Harness to execute for every rollout. Defaults to the last replay harness, then stored-event tail walk. */
  harness?: Harness<TResult, TTools, TRequest, TResponse, TStreamChunk>;
  /** Live model client for rollout tail calls. Falls back to replay options. */
  model?: unknown;
  /** Candidate prompt/model/tool-policy actions or a dynamic action generator. */
  actions:
    | readonly TrajectorySearchAction[]
    | ((ctx: TrajectorySearchActionContext<TResult>) => MaybePromise<readonly TrajectorySearchAction[]>);
  /** Rollout scoring function. Higher scores are better. */
  score(ctx: TrajectorySearchScoreContext<TResult>): MaybePromise<number | TrajectorySearchScore>;
  /** Search strategy. Defaults to `monte-carlo`. */
  strategy?: TrajectorySearchStrategy;
  /** Rollout, depth, token, and early-stop budgets. */
  budget?: TrajectorySearchBudget;
  /** Default tool policy for every rollout unless an action overrides it. */
  tools?: ForkOptions["tools"];
  /** Deterministic random source for Monte Carlo tests. Defaults to `Math.random`. */
  random?: () => number;
  /** Maximum independent rollouts to run at once when the strategy can parallelize work. Defaults to 1. */
  concurrency?: number;
  /** Abort a long-running search. */
  signal?: AbortSignal;
  /** Retry transient fork/scorer failures before applying `onRolloutError`. */
  retry?: TrajectorySearchRetryOptions;
  /** Limit rollout starts across the search. */
  rateLimit?: TrajectorySearchRateLimitOptions;
  /** Called before and after every rollout attempt. */
  onRollout?: (event: TrajectorySearchRolloutEvent<TResult>) => MaybePromise<void>;
  /** Called after a rollout node is recorded, including error nodes when `onRolloutError: "continue"` is used. */
  onNode?: (node: TrajectorySearchNode<TResult>) => MaybePromise<void>;
  /** Called whenever the highest single-rollout score improves. */
  onBest?: (node: TrajectorySearchNode<TResult>) => MaybePromise<void>;
  /**
   * How `result.bestBranch` is selected from repeated stochastic candidates.
   * `result.best` is still the best single rollout.
   */
  bestBranchBy?: TrajectoryBestBranchMetric;
  /** Score threshold counted as a branch pass-rate hit. Defaults to 1. */
  branchPassScore?: number;
  /**
   * Rollout error policy. Defaults to `"fail"`.
   * Use `"continue"` to keep successful nodes and record failed rollouts as error nodes.
   */
  onRolloutError?: "fail" | "continue";
  /**
   * Persist a JSON search manifest under `<store>/searches/<searchId>.json`.
   * Enabled by default. Pass `false` for purely in-memory tests.
   */
  persist?: boolean | { id?: string; dir?: string };
}

export interface TrajectorySearchRetryOptions {
  /** Total attempts per rollout, including the first try. Defaults to 1. */
  attempts?: number;
  /** Initial backoff delay. Defaults to 100 ms. */
  baseDelayMs?: number;
  /** Maximum backoff delay. Defaults to 2 seconds. */
  maxDelayMs?: number;
  /** Exponential backoff multiplier. Defaults to 2. */
  factor?: number;
  /** Randomize delay by this fraction, or pass false to disable. Defaults to 0.2. */
  jitter?: number | false;
  /** Optional retry predicate. Defaults to retrying every non-abort error. */
  shouldRetry?: (error: unknown, attempt: number) => MaybePromise<boolean>;
}

export interface TrajectorySearchRateLimitOptions {
  /** Maximum rollout starts per interval. */
  maxStarts: number;
  /** Interval in milliseconds. Defaults to 1000. */
  intervalMs?: number;
}

export interface TrajectorySearchRolloutEvent<TResult = unknown> {
  status: "start" | "success" | "error";
  rollout: number;
  depth: number;
  action: TrajectorySearchAction;
  actionSequence: TrajectorySearchAction[];
  node?: TrajectorySearchNode<TResult>;
  error?: SerializedError;
}

export interface TrajectorySearchNode<TResult = unknown> {
  id: string;
  parentId?: string;
  depth: number;
  rollout: number;
  action?: TrajectorySearchAction;
  actionKey?: string;
  actionSequence: TrajectorySearchAction[];
  actionSequenceKeys: string[];
  sessionId?: string;
  sessionPath?: string;
  score?: number;
  reason?: string;
  scoreMetadata?: JsonValue;
  judgeUsage?: Usage;
  result?: TResult;
  tokensSpent: Usage;
  reachedGoal?: boolean;
  divergedAtStep?: number;
  /** Serialized rollout fork/scorer error when `onRolloutError: "continue"` is used. */
  error?: SerializedError;
  /** Number of times this arm/tree path has been evaluated by bandit/tree strategies. */
  visits?: number;
  /** Sum of scores observed for this arm/tree path. */
  valueSum?: number;
  /** Mean score observed for this arm/tree path. */
  meanScore?: number;
  /** Normalized policy prior used by `strategy: "alpha-zero"`. */
  prior?: number;
  /**
   * UCB/UCT/PUCT selection score used before this rollout, when available.
   * Omitted for forced first-time exploration; see `selectionReason`.
   */
  selectionScore?: number;
  /** Why this rollout's arm/branch was selected. JSON-safe alternative to a non-finite `selectionScore`. */
  selectionReason?: TrajectorySelectionReason;
}

/** Aggregated visits and mean score for one attempted action sequence. */
export interface TrajectorySearchBranchDiagnostic {
  /** Action ids in order, e.g. `["escalate-prompt", "strong-model"]`. */
  actionSequence: string[];
  /** Stable action keys in order. */
  actionKeys: string[];
  /** Stable key joining action hashes, e.g. `"escalate#abc12345 > strong-model#def67890"`. */
  key: string;
  /** Action-sequence depth of this branch. */
  depth: number;
  /** Number of rollouts that executed exactly this action sequence. */
  visits: number;
  /** Sum of rollout scores observed for this action sequence. */
  valueSum: number;
  /** Mean rollout score observed for this action sequence. */
  meanScore: number;
  /** Lowest rollout score observed for this action sequence. */
  minScore: number;
  /** Highest rollout score observed for this action sequence. */
  maxScore: number;
  /** Population variance of rollout scores for this action sequence. */
  variance: number;
  /** Conservative mean estimate, useful for noisy stochastic branches. */
  lowerConfidenceBound: number;
  /** Number of rollouts whose score met or exceeded `branchPassScore`. */
  passCount: number;
  /** Passes divided by visits. */
  passRate: number;
}

/** Small JSON-safe summary of how rollouts spread across attempted action sequences. */
export interface TrajectorySearchDiagnostics {
  strategy: TrajectorySearchStrategy;
  /** Total rollouts executed across all branches. */
  rollouts: number;
  /** Per-action-sequence branch stats, sorted by mean score then visits. */
  branches: TrajectorySearchBranchDiagnostic[];
}

export interface TrajectorySearchResult<TResult = unknown> {
  /** Durable search id used for persisted manifests and child-session annotations. */
  searchId?: string;
  /** Filesystem path to the persisted search manifest, when persistence is enabled. */
  searchPath?: string;
  strategy: TrajectorySearchStrategy;
  parentSessionId: string;
  parentSessionPath: string;
  atStep: number;
  best?: TrajectorySearchNode<TResult>;
  /** Best aggregate branch according to `bestBranchBy`. */
  bestBranch?: TrajectorySearchBranchDiagnostic;
  bestBranchBy: TrajectoryBestBranchMetric;
  nodes: TrajectorySearchNode<TResult>[];
  rollouts: number;
  tokensSpent: Usage;
  /** Token/cost usage spent by optional external judges, separate from rollout model spend. */
  judgeUsage: Usage;
  stoppedReason: "maxRollouts" | "maxDepth" | "maxTokens" | "stopScore" | "noActions";
  /** Branch visits/means by action sequence. JSON-safe and useful for debugging spend. */
  diagnostics: TrajectorySearchDiagnostics;
}

interface NormalizedBudget {
  maxRollouts: number;
  maxDepth: number;
  beamWidth: number;
  explorationWeight: number;
  puctExploration: number;
  maxTokens: number | undefined;
  stopScore: number | undefined;
}

interface NormalizedRetry {
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  factor: number;
  jitter: number | false;
  shouldRetry?: (error: unknown, attempt: number) => MaybePromise<boolean>;
}

interface NormalizedControls {
  concurrency: number;
  retry: NormalizedRetry;
  rateLimiter?: RolloutRateLimiter;
  signal?: AbortSignal;
}

interface NormalizedPersistence {
  id: string;
  path: string;
}

interface SearchState<TResult> {
  best: TrajectorySearchNode<TResult> | undefined;
  nodes: TrajectorySearchNode<TResult>[];
  rollouts: number;
  tokensSpent: Usage;
  judgeUsage: Usage;
  stoppedReason: TrajectorySearchResult<TResult>["stoppedReason"] | undefined;
}

interface ComposedAction {
  action?: TrajectorySearchAction;
  overrides?: ForkOverrides;
  model?: unknown;
  tools?: ForkOptions["tools"];
}

interface PendingAction {
  action: TrajectorySearchAction;
  prior: number;
}

interface TreeSearchNode<TResult> {
  id: string;
  parent?: TreeSearchNode<TResult>;
  depth: number;
  action?: TrajectorySearchAction;
  actionSequence: TrajectorySearchAction[];
  visits: number;
  valueSum: number;
  prior: number;
  selectionScore?: number;
  selectionReason?: TrajectorySelectionReason;
  children: TreeSearchNode<TResult>[];
  untriedActions?: PendingAction[];
  resultNodeId?: string;
  /** Last public rollout node produced by evaluating this branch, merged into the generator parent context. */
  lastResultNode?: TrajectorySearchNode<TResult>;
  /** Set when this branch has no deeper actions and can only be re-simulated as a leaf. */
  terminal?: boolean;
}

export async function searchReplay<
  TResult = unknown,
  TTools extends ToolHandlers = UntypedToolHandlers,
  TRequest = unknown,
  TResponse = unknown,
  TStreamChunk = unknown
>(
  replay: ReplaySession<TTools, TRequest, TResponse, TStreamChunk>,
  opts: TrajectorySearchOptions<TResult, TTools, TRequest, TResponse, TStreamChunk>
): Promise<TrajectorySearchResult<TResult>> {
  assertStep(opts.atStep);
  assertRecordedBoundaryStep(replay, opts.atStep);
  const strategy = opts.strategy ?? "monte-carlo";
  if (!isSearchStrategy(strategy)) {
    throw new TypeError(`Unknown trajectory search strategy "${strategy}". Use monte-carlo, beam, ucb, mcts, or alpha-zero.`);
  }
  const budget = normalizeBudget(opts.budget, strategy, Array.isArray(opts.actions) ? opts.actions.length : undefined);
  const controls = normalizeControls(opts);
  assertBranchControls(opts);
  const persistence = normalizePersistence(replay, opts.persist);
  const root: TrajectorySearchNode<TResult> = {
    id: "root",
    depth: 0,
    rollout: 0,
    actionSequence: [],
    actionSequenceKeys: [],
    tokensSpent: { inputTokens: 0, outputTokens: 0 }
  };
  const state: SearchState<TResult> = {
    best: undefined,
    nodes: [root],
    rollouts: 0,
    tokensSpent: { inputTokens: 0, outputTokens: 0 },
    judgeUsage: { inputTokens: 0, outputTokens: 0 },
    stoppedReason: undefined
  };

  const runNode = async (
    parentId: string,
    action: TrajectorySearchAction,
    actionSequence: TrajectorySearchAction[],
    depth: number
  ): Promise<TrajectorySearchNode<TResult> | undefined> => {
    throwIfAborted(controls.signal);
    const rollout = reserveRollout(state, budget);
    if (rollout === undefined) {
      return undefined;
    }

    const composed = composeAction(actionSequence);
    let fork: ForkResult<TResult> | undefined;
    let tokensRecorded = false;
    try {
      await opts.onRollout?.({ status: "start", rollout, depth, action, actionSequence });
      const forkAndScore = await runWithRetry(
        async () => {
          await controls.rateLimiter?.wait(controls.signal);
          throwIfAborted(controls.signal);
          const nextFork = (await forkReplay(replay, {
            atStep: opts.atStep,
            ...(opts.harness ? { harness: opts.harness } : {}),
            model: composed.model ?? opts.model,
            ...(composed.overrides ? { overrides: composed.overrides } : {}),
            tools: composed.tools ?? opts.tools
          })) as ForkResult<TResult>;
          const nextScore = normalizeScore(
            await opts.score({
              action,
              actionSequence,
              depth,
              rollout,
              fork: nextFork,
              trace: nextFork.trace,
              result: nextFork.result,
              tokensSpent: nextFork.tokensSpent
            })
          );
          return { fork: nextFork, scored: nextScore };
        },
        controls.retry,
        controls.signal
      );
      fork = forkAndScore.fork;
      state.tokensSpent = usageAdd(state.tokensSpent, fork.tokensSpent);
      tokensRecorded = true;
      const scored = forkAndScore.scored;
      if (scored.judgeUsage) {
        state.judgeUsage = usageAdd(state.judgeUsage, scored.judgeUsage);
      }
      const node: TrajectorySearchNode<TResult> = {
        id: `n${rollout}`,
        parentId,
        depth,
        rollout,
        action: composed.action,
        ...(composed.action?.actionKey === undefined ? {} : { actionKey: composed.action.actionKey }),
        actionSequence,
        actionSequenceKeys: actionSequence.map(actionKeyForNode),
        sessionId: fork.sessionId,
        sessionPath: join(dirname(replay.stored.path), fork.sessionId),
        score: scored.score,
        ...(scored.reason === undefined ? {} : { reason: scored.reason }),
        ...(scored.metadata === undefined ? {} : { scoreMetadata: scored.metadata }),
        ...(scored.judgeUsage === undefined ? {} : { judgeUsage: scored.judgeUsage }),
        ...(fork.result === undefined ? {} : { result: fork.result }),
        tokensSpent: fork.tokensSpent,
        ...(fork.reachedGoal === undefined ? {} : { reachedGoal: fork.reachedGoal }),
        ...(fork.divergedAtStep === undefined ? {} : { divergedAtStep: fork.divergedAtStep })
      };
      state.nodes.push(node);
      if (!state.best || scored.score > (state.best.score ?? Number.NEGATIVE_INFINITY)) {
        state.best = node;
        await opts.onBest?.(node);
      }
      await opts.onNode?.(node);
      await opts.onRollout?.({ status: "success", rollout, depth, action, actionSequence, node });
      if (budget.stopScore !== undefined && scored.score >= budget.stopScore) {
        state.stoppedReason = "stopScore";
      } else if (budget.maxTokens !== undefined && tokenTotal(state.tokensSpent) >= budget.maxTokens) {
        state.stoppedReason = "maxTokens";
      }
      await annotateChildSearchMeta(node, replay, opts.atStep, persistence);
      return node;
    } catch (error) {
      if (opts.onRolloutError !== "continue") {
        throw error;
      }
      if (fork && !tokensRecorded) {
        state.tokensSpent = usageAdd(state.tokensSpent, fork.tokensSpent);
      }
      const serialized = serializeError(error);
      const node: TrajectorySearchNode<TResult> = {
        id: `n${rollout}`,
        parentId,
        depth,
        rollout,
        action: composed.action,
        ...(composed.action?.actionKey === undefined ? {} : { actionKey: composed.action.actionKey }),
        actionSequence,
        actionSequenceKeys: actionSequence.map(actionKeyForNode),
        ...(fork ? { sessionId: fork.sessionId, sessionPath: join(dirname(replay.stored.path), fork.sessionId) } : {}),
        ...(fork?.result === undefined ? {} : { result: fork.result }),
        tokensSpent: fork?.tokensSpent ?? { inputTokens: 0, outputTokens: 0 },
        ...(fork?.reachedGoal === undefined ? {} : { reachedGoal: fork.reachedGoal }),
        ...(fork?.divergedAtStep === undefined ? {} : { divergedAtStep: fork.divergedAtStep }),
        error: serialized
      };
      state.nodes.push(node);
      await opts.onNode?.(node);
      await opts.onRollout?.({ status: "error", rollout, depth, action, actionSequence, node, error: serialized });
      if (budget.maxTokens !== undefined && tokenTotal(state.tokensSpent) >= budget.maxTokens) {
        state.stoppedReason = "maxTokens";
      }
      await annotateChildSearchMeta(node, replay, opts.atStep, persistence);
      return node;
    }
  };

  if (strategy === "monte-carlo") {
    const random = opts.random ?? Math.random;
    while (!state.stoppedReason && state.rollouts < budget.maxRollouts) {
      const depth = Math.floor(nextRandomUnit(random) * budget.maxDepth) + 1;
      const sequence: TrajectorySearchAction[] = [];
      for (let level = 1; level <= depth; level += 1) {
        const parent = monteCarloParentNode(root, sequence, state.rollouts + 1);
        const candidates = await resolveActions(opts.actions, {
          strategy,
          depth: level,
          rollout: state.rollouts,
          parent,
          best: state.best
        });
        if (candidates.length === 0) {
          break;
        }
        const index = Math.floor(nextRandomUnit(random) * candidates.length);
        sequence.push(candidates[index]!);
      }
      if (sequence.length === 0) {
        state.stoppedReason = "noActions";
        break;
      }
      await runNode(root.id, sequence.at(-1)!, sequence, sequence.length);
    }
  } else if (strategy === "beam") {
    let frontier: TrajectorySearchNode<TResult>[] = [root];
    for (let depth = 1; depth <= budget.maxDepth && !state.stoppedReason; depth += 1) {
      const expanded: TrajectorySearchNode<TResult>[] = [];
      for (const parent of frontier) {
        const candidates = await resolveActions(opts.actions, {
          strategy,
          depth,
          rollout: state.rollouts,
          parent,
          best: state.best
        });
        if (candidates.length === 0 && depth === 1 && state.rollouts === 0) {
          state.stoppedReason = "noActions";
          break;
        }
        const expandedFromParent = await mapWithConcurrency(candidates, controls.concurrency, async (action) => {
          if (state.stoppedReason) {
            return undefined;
          }
          return runNode(parent.id, action, [...parent.actionSequence, action], depth);
        });
        expanded.push(...expandedFromParent.filter((node): node is TrajectorySearchNode<TResult> => Boolean(node)));
        if (state.stoppedReason) {
          break;
        }
      }
      frontier = expanded
        .sort((a, b) => (b.score ?? Number.NEGATIVE_INFINITY) - (a.score ?? Number.NEGATIVE_INFINITY))
        .slice(0, budget.beamWidth);
      if (frontier.length === 0 && !state.stoppedReason) {
        state.stoppedReason = "noActions";
      }
    }
  } else if (strategy === "ucb") {
    const initialActions = await resolveActions(opts.actions, { strategy, depth: 1, rollout: 0 });
    if (initialActions.length === 0) {
    const result = finishSearch(
      replay,
      opts.atStep,
      strategy,
      state,
      "noActions",
      persistence,
      opts.bestBranchBy ?? "mean",
      opts.branchPassScore ?? 1
    );
      await persistSearchManifest(result);
      return result;
    }
    const arms = initialActions.map((action) => ({
      action,
      visits: 0,
      valueSum: 0
    }));
    type ArmSelection = { arm: (typeof arms)[number]; selectionScore?: number; selectionReason: TrajectorySelectionReason };
    while (!state.stoppedReason && state.rollouts < budget.maxRollouts) {
      const totalVisits = Math.max(1, arms.reduce((sum, arm) => sum + arm.visits, 0));
      const unvisited = arms.find((arm) => arm.visits === 0);
      const selected: ArmSelection = unvisited
        ? { arm: unvisited, selectionReason: "unvisited" }
        : arms.reduce<ArmSelection>(
            (best, arm) => {
              const selectionScore = ucbSelectionScore(arm.valueSum / arm.visits, totalVisits, arm.visits, budget.explorationWeight);
              return selectionScore > (best.selectionScore ?? Number.NEGATIVE_INFINITY)
                ? { arm, selectionScore, selectionReason: "ucb" }
                : best;
            },
            { arm: arms[0]!, selectionReason: "ucb" }
          );
      const node = await runNode(root.id, selected.arm.action, [selected.arm.action], 1);
      if (!node) {
        break;
      }
      const score = node.score ?? 0;
      selected.arm.visits += 1;
      selected.arm.valueSum += score;
      node.visits = selected.arm.visits;
      node.valueSum = selected.arm.valueSum;
      node.meanScore = selected.arm.valueSum / selected.arm.visits;
      if (selected.selectionScore !== undefined) {
        node.selectionScore = selected.selectionScore;
      }
      node.selectionReason = selected.selectionReason;
      if (selected.arm.action.prior !== undefined) {
        node.prior = selected.arm.action.prior;
      }
    }
  } else {
    let treeId = 0;
    const treeRoot: TreeSearchNode<TResult> = {
      id: "t0",
      depth: 0,
      actionSequence: [],
      visits: 0,
      valueSum: 0,
      prior: 1,
      children: []
    };

    while (!state.stoppedReason && state.rollouts < budget.maxRollouts) {
      const selected = await selectTreeNode({
        root: treeRoot,
        strategy,
        budget,
        state,
        actions: opts.actions,
        nextId: () => `t${++treeId}`
      });
      if (!selected?.action) {
        state.stoppedReason = state.rollouts === 0 ? "noActions" : "maxDepth";
        break;
      }
      const parentId = treePublicNodeId(selected.parent, root.id);
      const node = await runNode(parentId, selected.action, selected.actionSequence, selected.depth);
      if (!node) {
        break;
      }
      const score = node.score ?? 0;
      selected.resultNodeId = node.id;
      selected.lastResultNode = node;
      backpropagateTreeScore(selected, score);
      copyTreeStats(node, selected);
    }
  }

  const result = finishSearch(
    replay,
    opts.atStep,
    strategy,
    state,
    state.stoppedReason ?? (state.rollouts >= budget.maxRollouts ? "maxRollouts" : "maxDepth"),
    persistence,
    opts.bestBranchBy ?? "mean",
    opts.branchPassScore ?? 1
  );
  await persistSearchManifest(result);
  return result;
}

export interface TrajectorySearchRunner<
  TTools extends ToolHandlers = UntypedToolHandlers,
  TRequest = unknown,
  TResponse = unknown,
  TStreamChunk = unknown
> {
  search<TResult = unknown>(opts: TrajectorySearchOptions<TResult, TTools, TRequest, TResponse, TStreamChunk>): Promise<TrajectorySearchResult<TResult>>;
}

export interface TrajectoryPromptCandidate {
  id?: string;
  actionKey?: string;
  label?: string;
  system: string;
  /** Optional model id override applied to the forked request. */
  model?: string;
  /** Optional provider client used only for this prompt candidate. */
  client?: unknown;
  prior?: number;
  metadata?: JsonValue;
}

export type TrajectoryPromptSweepOptions<
  TResult = unknown,
  TTools extends ToolHandlers = UntypedToolHandlers,
  TRequest = unknown,
  TResponse = unknown,
  TStreamChunk = unknown
> = Omit<TrajectorySearchOptions<TResult, TTools, TRequest, TResponse, TStreamChunk>, "actions"> & {
  prompts: readonly (string | TrajectoryPromptCandidate)[];
};

export interface TrajectoryModelCandidate {
  id?: string;
  actionKey?: string;
  label?: string;
  /** Model id override applied to the forked request. */
  model: string;
  /** Optional provider client used only for this model candidate. */
  client?: unknown;
  /** Optional system prompt paired with this model. */
  system?: string;
  prior?: number;
  metadata?: JsonValue;
}

export type TrajectoryModelSweepOptions<
  TResult = unknown,
  TTools extends ToolHandlers = UntypedToolHandlers,
  TRequest = unknown,
  TResponse = unknown,
  TStreamChunk = unknown
> = Omit<TrajectorySearchOptions<TResult, TTools, TRequest, TResponse, TStreamChunk>, "actions"> & {
  models: readonly (string | TrajectoryModelCandidate)[];
};

export type TrajectoryRegressionAssertionResult =
  | boolean
  | {
      pass: boolean;
      reason?: string;
      score?: number;
      metadata?: JsonValue;
    };

export type TrajectoryRegressionAssertion<TResult = unknown> = (
  ctx: TrajectorySearchScoreContext<TResult>
) => MaybePromise<TrajectoryRegressionAssertionResult>;

export type TrajectoryRegressionOptions<
  TResult = unknown,
  TTools extends ToolHandlers = UntypedToolHandlers,
  TRequest = unknown,
  TResponse = unknown,
  TStreamChunk = unknown
> = Omit<TrajectorySearchOptions<TResult, TTools, TRequest, TResponse, TStreamChunk>, "score"> & {
  assertions: readonly TrajectoryRegressionAssertion<TResult>[];
  /** Defaults to false. When true, passing 2 of 4 checks scores 0.5 instead of 0. */
  partialCredit?: boolean;
};

export interface TrajectoryJudgeRubricCriterion {
  id: string;
  description: string;
  weight?: number;
  pass?: string;
  fail?: string;
}

export interface TrajectoryJudgeRubric {
  name: string;
  goal: string;
  instructions?: string;
  scoreRange: {
    min: number;
    max: number;
    pass: number;
  };
  criteria: TrajectoryJudgeRubricCriterion[];
}

export interface DefineJudgeRubricOptions {
  name: string;
  goal: string;
  instructions?: string;
  /** Defaults to 0. */
  minScore?: number;
  /** Defaults to 1. */
  maxScore?: number;
  /** Defaults to maxScore. */
  passScore?: number;
  criteria: readonly (string | TrajectoryJudgeRubricCriterion)[];
}

export interface TrajectoryJudgeInput<TResult = unknown> {
  rubric: TrajectoryJudgeRubric;
  action: Record<string, JsonValue> | undefined;
  actionSequence: Record<string, JsonValue>[];
  rollout: number;
  depth: number;
  outputText: string;
  result: JsonValue | undefined;
  trace: {
    modelCalls: number;
    liveModelCalls: number;
    toolCalls: string[];
    errors: number;
  };
  tokensSpent: Usage;
  metadata?: JsonValue;
}

export interface TrajectoryJudgeCriterionResult {
  id: string;
  score?: number;
  pass?: boolean;
  reason?: string;
}

export interface TrajectoryJudgeOutput {
  score: number;
  reason: string;
  confidence?: number;
  criteria?: TrajectoryJudgeCriterionResult[];
  metadata?: JsonValue;
  usage?: Usage;
}

export type TrajectoryJudge<TResult = unknown> = (input: TrajectoryJudgeInput<TResult>) => MaybePromise<TrajectoryJudgeOutput>;

export interface TrajectoryJudgeCache<TResult = unknown> {
  get(key: string): MaybePromise<TrajectoryJudgeOutput | undefined>;
  set(key: string, output: TrajectoryJudgeOutput, input: TrajectoryJudgeInput<TResult>): MaybePromise<void>;
}

export interface TrajectoryJudgeScorerOptions<TResult = unknown> {
  rubric: TrajectoryJudgeRubric;
  judge: TrajectoryJudge<TResult>;
  cache?: TrajectoryJudgeCache<TResult>;
  /** Redacts every string in the judge payload before cache lookup and judge execution. */
  redact?: (value: string) => string;
  /** Extra JSON metadata sent to the judge and returned with each score. */
  metadata?: JsonValue;
}

export type TrajectoryJudgeSearchOptions<
  TResult = unknown,
  TTools extends ToolHandlers = UntypedToolHandlers,
  TRequest = unknown,
  TResponse = unknown,
  TStreamChunk = unknown
> = Omit<TrajectorySearchOptions<TResult, TTools, TRequest, TResponse, TStreamChunk>, "score"> & TrajectoryJudgeScorerOptions<TResult>;

export const search = {
  promptSweep,
  modelSweep,
  judge: judgeSearch,
  regression: regressionSearch,
  defineJudgeRubric,
  createJudgeScorer,
  createMemoryJudgeCache,
  toJsonValue
};

export function promptSweep<
  TResult = unknown,
  TTools extends ToolHandlers = UntypedToolHandlers,
  TRequest = unknown,
  TResponse = unknown,
  TStreamChunk = unknown
>(
  replay: TrajectorySearchRunner<TTools, TRequest, TResponse, TStreamChunk>,
  opts: TrajectoryPromptSweepOptions<TResult, TTools, TRequest, TResponse, TStreamChunk>
): Promise<TrajectorySearchResult<TResult>> {
  const { prompts, ...searchOpts } = opts;
  return replay.search({
    ...searchOpts,
    actions: prompts.map(promptCandidateToAction)
  });
}

export function modelSweep<
  TResult = unknown,
  TTools extends ToolHandlers = UntypedToolHandlers,
  TRequest = unknown,
  TResponse = unknown,
  TStreamChunk = unknown
>(
  replay: TrajectorySearchRunner<TTools, TRequest, TResponse, TStreamChunk>,
  opts: TrajectoryModelSweepOptions<TResult, TTools, TRequest, TResponse, TStreamChunk>
): Promise<TrajectorySearchResult<TResult>> {
  const { models, ...searchOpts } = opts;
  return replay.search({
    ...searchOpts,
    actions: models.map(modelCandidateToAction)
  });
}

export function judgeSearch<
  TResult = unknown,
  TTools extends ToolHandlers = UntypedToolHandlers,
  TRequest = unknown,
  TResponse = unknown,
  TStreamChunk = unknown
>(
  replay: TrajectorySearchRunner<TTools, TRequest, TResponse, TStreamChunk>,
  opts: TrajectoryJudgeSearchOptions<TResult, TTools, TRequest, TResponse, TStreamChunk>
): Promise<TrajectorySearchResult<TResult>> {
  const { rubric, judge, cache, redact, metadata, ...searchOpts } = opts;
  return replay.search({
    ...searchOpts,
    score: createJudgeScorer({ rubric, judge, cache, redact, metadata })
  });
}

export function regressionSearch<
  TResult = unknown,
  TTools extends ToolHandlers = UntypedToolHandlers,
  TRequest = unknown,
  TResponse = unknown,
  TStreamChunk = unknown
>(
  replay: TrajectorySearchRunner<TTools, TRequest, TResponse, TStreamChunk>,
  opts: TrajectoryRegressionOptions<TResult, TTools, TRequest, TResponse, TStreamChunk>
): Promise<TrajectorySearchResult<TResult>> {
  const { assertions, partialCredit, ...searchOpts } = opts;
  if (assertions.length === 0) {
    throw new TypeError("search.regression() needs at least one assertion.");
  }
  return replay.search({
    ...searchOpts,
    score: async (ctx) => {
      const checks = await Promise.all(assertions.map(async (assertion) => normalizeRegressionAssertionResult(await assertion(ctx))));
      const passed = checks.filter((check) => check.pass).length;
      const score = partialCredit ? passed / checks.length : passed === checks.length ? 1 : 0;
      return {
        score,
        reason: checks.map((check, index) => check.reason ?? `check ${index + 1}: ${check.pass ? "pass" : "fail"}`).join(" | "),
        metadata: { checks: checks.map((check) => toJsonValue(check) ?? null) }
      };
    }
  });
}

export function defineJudgeRubric(opts: DefineJudgeRubricOptions): TrajectoryJudgeRubric {
  if (!opts.name.trim()) {
    throw new TypeError("Judge rubric name is required.");
  }
  if (!opts.goal.trim()) {
    throw new TypeError("Judge rubric goal is required.");
  }
  if (opts.criteria.length === 0) {
    throw new TypeError("Judge rubric needs at least one criterion.");
  }
  const min = opts.minScore ?? 0;
  const max = opts.maxScore ?? 1;
  const pass = opts.passScore ?? max;
  if (!Number.isFinite(min) || !Number.isFinite(max) || !Number.isFinite(pass) || max <= min || pass < min || pass > max) {
    throw new TypeError("Judge rubric score range must satisfy minScore < maxScore and minScore <= passScore <= maxScore.");
  }
  return {
    name: opts.name,
    goal: opts.goal,
    ...(opts.instructions === undefined ? {} : { instructions: opts.instructions }),
    scoreRange: { min, max, pass },
    criteria: opts.criteria.map((criterion, index) => normalizeJudgeCriterion(criterion, index))
  };
}

export function createJudgeScorer<TResult = unknown>(
  opts: TrajectoryJudgeScorerOptions<TResult>
): (ctx: TrajectorySearchScoreContext<TResult>) => Promise<TrajectorySearchScore> {
  return async (ctx) => {
    const input = buildJudgeInput(ctx, opts);
    const redacted = opts.redact ? (redactStrings(input, opts.redact) as TrajectoryJudgeInput<TResult>) : input;
    const cacheKey = shortHash({ ...redacted, rollout: 0 });
    const cached = await opts.cache?.get(cacheKey);
    const output = cached ?? (await opts.judge(redacted));
    if (!cached) {
      await opts.cache?.set(cacheKey, output, redacted);
    }
    const normalized = normalizeJudgeOutput(output, opts.rubric);
    return {
      score: normalized.score,
      reason: normalized.reason,
      metadata: {
        judge: {
          cacheHit: Boolean(cached),
          confidence: normalized.confidence ?? null,
          criteria: (normalized.criteria ?? []).map((criterion) => toJsonValue(criterion) ?? null),
          metadata: normalized.metadata ?? null
        }
      },
      ...(cached || normalized.usage === undefined ? {} : { judgeUsage: normalized.usage })
    };
  };
}

export function createMemoryJudgeCache<TResult = unknown>(): TrajectoryJudgeCache<TResult> {
  const cache = new Map<string, TrajectoryJudgeOutput>();
  return {
    get: (key) => cache.get(key),
    set: (key, output) => {
      cache.set(key, output);
    }
  };
}

function promptCandidateToAction(candidate: string | TrajectoryPromptCandidate, index: number): TrajectorySearchAction {
  if (typeof candidate === "string") {
    return {
      id: `prompt-${index + 1}`,
      label: `Prompt ${index + 1}`,
      overrides: { system: candidate }
    };
  }
  const id = candidate.id ?? (slugId(candidate.label ?? `prompt-${index + 1}`) || `prompt-${index + 1}`);
  return {
    id,
    ...(candidate.actionKey === undefined ? {} : { actionKey: candidate.actionKey }),
    ...(candidate.label === undefined ? {} : { label: candidate.label }),
    overrides: {
      system: candidate.system,
      ...(candidate.model === undefined ? {} : { model: candidate.model })
    },
    ...(candidate.client === undefined ? {} : { model: candidate.client }),
    ...(candidate.prior === undefined ? {} : { prior: candidate.prior }),
    ...(candidate.metadata === undefined ? {} : { metadata: candidate.metadata })
  };
}

function modelCandidateToAction(candidate: string | TrajectoryModelCandidate, index: number): TrajectorySearchAction {
  if (typeof candidate === "string") {
    return {
      id: slugId(candidate) || `model-${index + 1}`,
      label: candidate,
      overrides: { model: candidate }
    };
  }
  const id = candidate.id ?? (slugId(candidate.label ?? candidate.model) || `model-${index + 1}`);
  return {
    id,
    ...(candidate.actionKey === undefined ? {} : { actionKey: candidate.actionKey }),
    ...(candidate.label === undefined ? {} : { label: candidate.label }),
    overrides: {
      model: candidate.model,
      ...(candidate.system === undefined ? {} : { system: candidate.system })
    },
    ...(candidate.client === undefined ? {} : { model: candidate.client }),
    ...(candidate.prior === undefined ? {} : { prior: candidate.prior }),
    ...(candidate.metadata === undefined ? {} : { metadata: candidate.metadata })
  };
}

function normalizeRegressionAssertionResult(value: TrajectoryRegressionAssertionResult): {
  pass: boolean;
  reason?: string;
  score?: number;
  metadata?: JsonValue;
} {
  if (typeof value === "boolean") {
    return { pass: value };
  }
  if (value.score !== undefined && !Number.isFinite(value.score)) {
    throw new TypeError(`Regression assertion score must be finite, got ${String(value.score)}.`);
  }
  return {
    pass: value.pass,
    ...(value.reason === undefined ? {} : { reason: value.reason }),
    ...(value.score === undefined ? {} : { score: value.score }),
    ...(value.metadata === undefined ? {} : { metadata: value.metadata })
  };
}

function normalizeJudgeCriterion(criterion: string | TrajectoryJudgeRubricCriterion, index: number): TrajectoryJudgeRubricCriterion {
  if (typeof criterion === "string") {
    return {
      id: `criterion-${index + 1}`,
      description: criterion
    };
  }
  if (!criterion.id.trim()) {
    throw new TypeError(`Judge rubric criterion ${index + 1} needs an id.`);
  }
  if (!criterion.description.trim()) {
    throw new TypeError(`Judge rubric criterion ${criterion.id} needs a description.`);
  }
  if (criterion.weight !== undefined && (!Number.isFinite(criterion.weight) || criterion.weight < 0)) {
    throw new TypeError(`Judge rubric criterion ${criterion.id} weight must be a non-negative finite number.`);
  }
  return { ...criterion };
}

function buildJudgeInput<TResult>(
  ctx: TrajectorySearchScoreContext<TResult>,
  opts: TrajectoryJudgeScorerOptions<TResult>
): TrajectoryJudgeInput<TResult> {
  const events = ctx.trace.events();
  return {
    rubric: opts.rubric,
    action: ctx.action ? (toJsonValue(searchManifestAction(ctx.action)) as Record<string, JsonValue>) : undefined,
    actionSequence: ctx.actionSequence.map((action) => toJsonValue(searchManifestAction(action)) as Record<string, JsonValue>),
    rollout: ctx.rollout,
    depth: ctx.depth,
    outputText: modelOutputText(events),
    result: toJsonValue(ctx.result),
    trace: summarizeTraceForJudge(events),
    tokensSpent: ctx.tokensSpent,
    ...(opts.metadata === undefined ? {} : { metadata: opts.metadata })
  };
}

function summarizeTraceForJudge(events: RewindEvent[]): TrajectoryJudgeInput["trace"] {
  return {
    modelCalls: events.filter((event) => event.kind === "model_call").length,
    liveModelCalls: events.filter((event) => event.kind === "model_call" && event.provenance === "live").length,
    toolCalls: events.filter((event) => event.kind === "tool_call").map((event) => event.name),
    errors: events.filter((event) => ("error" in event && event.error ? true : false)).length
  };
}

function normalizeJudgeOutput(output: TrajectoryJudgeOutput, rubric: TrajectoryJudgeRubric): TrajectoryJudgeOutput {
  if (!Number.isFinite(output.score)) {
    throw new TypeError(`Judge output score must be finite, got ${String(output.score)}.`);
  }
  if (output.score < rubric.scoreRange.min || output.score > rubric.scoreRange.max) {
    throw new TypeError(
      `Judge output score ${output.score} is outside rubric range ${rubric.scoreRange.min}..${rubric.scoreRange.max}.`
    );
  }
  if (!output.reason.trim()) {
    throw new TypeError("Judge output reason is required.");
  }
  if (output.confidence !== undefined && (!Number.isFinite(output.confidence) || output.confidence < 0 || output.confidence > 1)) {
    throw new TypeError("Judge output confidence must be between 0 and 1.");
  }
  if (output.usage) {
    assertUsage("judge output usage", output.usage);
  }
  return {
    score: output.score,
    reason: output.reason,
    ...(output.confidence === undefined ? {} : { confidence: output.confidence }),
    ...(output.criteria === undefined ? {} : { criteria: output.criteria.map(normalizeJudgeCriterionResult) }),
    ...(output.metadata === undefined ? {} : { metadata: toJsonValue(output.metadata) ?? null }),
    ...(output.usage === undefined ? {} : { usage: output.usage })
  };
}

function normalizeJudgeCriterionResult(criterion: TrajectoryJudgeCriterionResult): TrajectoryJudgeCriterionResult {
  if (!criterion.id.trim()) {
    throw new TypeError("Judge criterion result id is required.");
  }
  if (criterion.score !== undefined && !Number.isFinite(criterion.score)) {
    throw new TypeError(`Judge criterion ${criterion.id} score must be finite.`);
  }
  return { ...criterion };
}

function redactStrings(value: unknown, redact: (value: string) => string): unknown {
  if (typeof value === "string") {
    return redact(value);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactStrings(item, redact));
  }
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redactStrings(child, redact)]));
}

function modelOutputText(events: RewindEvent[]): string {
  return events
    .filter((event): event is ModelCallEvent => event.kind === "model_call" && event.provenance === "live")
    .map((event) => contentToText(event.response?.content))
    .filter(Boolean)
    .join("\n");
}

function contentToText(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map(contentToText).filter(Boolean).join("\n");
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.text === "string") {
      return record.text;
    }
    if (typeof record.content === "string") {
      return record.content;
    }
    return JSON.stringify(toJsonSafe(value));
  }
  return String(value);
}

function slugId(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

async function resolveActions<TResult>(
  actions: TrajectorySearchOptions<TResult>["actions"],
  ctx: TrajectorySearchActionContext<TResult>
): Promise<TrajectorySearchAction[]> {
  const resolved = typeof actions === "function" ? await actions(ctx) : actions;
  return [...resolved].map((action, index) => {
    const normalized = normalizeAction(action, index);
    assertAction(normalized);
    return normalized;
  });
}

function normalizeAction(action: TrajectorySearchAction, index: number): TrajectorySearchAction {
  const id = action.id ?? `action-${index + 1}`;
  const actionKey = action.actionKey ?? stableActionKey({ ...action, id });
  return {
    ...action,
    id,
    actionKey,
    ...(action.metadata === undefined ? {} : { metadata: toJsonValue(action.metadata) ?? null })
  };
}

function stableActionKey(action: TrajectorySearchAction): string {
  const id = action.id ?? "action";
  const digest = shortHash({
    id,
    label: action.label,
    overrides: {
      system: action.overrides?.system,
      model: action.overrides?.model,
      transformRequest: action.overrides?.transformRequest ? String(action.overrides.transformRequest) : undefined
    },
    hasModelClient: action.model !== undefined,
    tools: action.tools,
    prior: action.prior,
    metadata: action.metadata
  });
  return `${id}#${digest}`;
}

function actionKeyForNode(action: TrajectorySearchAction): string {
  return action.actionKey ?? stableActionKey(action);
}

function shortHash(value: unknown): string {
  return createHash("sha256").update(stableStringify(toJsonSafe(value))).digest("hex").slice(0, 10);
}

async function resolvePendingActions<TResult>(
  actions: TrajectorySearchOptions<TResult>["actions"],
  ctx: TrajectorySearchActionContext<TResult>
): Promise<PendingAction[]> {
  return normalizePendingActions(await resolveActions(actions, ctx));
}

function normalizePendingActions(actions: readonly TrajectorySearchAction[]): PendingAction[] {
  if (actions.length === 0) {
    return [];
  }
  const uniform = 1 / actions.length;
  // Explicit prior semantics: when no action declares a prior, every sibling shares a
  // uniform prior. When at least one action declares a prior, a missing prior counts as 0
  // so that `[{ prior: 0.8 }, {}]` does not hand the omitted action the larger weight. If
  // the declared priors sum to 0, fall back to uniform rather than dividing by zero.
  const hasExplicitPrior = actions.some((action) => action.prior !== undefined);
  if (!hasExplicitPrior) {
    return actions.map((action) => ({ action, prior: uniform }));
  }
  const rawPriors = actions.map((action) => action.prior ?? 0);
  const total = rawPriors.reduce((sum, prior) => sum + prior, 0);
  return actions.map((action, index) => ({
    action,
    prior: total > 0 ? rawPriors[index]! / total : uniform
  }));
}

async function selectTreeNode<TResult>(params: {
  root: TreeSearchNode<TResult>;
  strategy: "mcts" | "alpha-zero";
  budget: NormalizedBudget;
  state: {
    best: TrajectorySearchNode<TResult> | undefined;
    rollouts: number;
  };
  actions: TrajectorySearchOptions<TResult>["actions"];
  nextId: () => string;
}): Promise<TreeSearchNode<TResult> | undefined> {
  let current = params.root;
  while (current.depth < params.budget.maxDepth) {
    if (current.untriedActions === undefined) {
      current.untriedActions = await resolvePendingActions(params.actions, {
        strategy: params.strategy,
        depth: current.depth + 1,
        rollout: params.state.rollouts,
        parent: treeNodeToPublicNode(current),
        best: params.state.best
      });
    }
    if (current.untriedActions.length > 0) {
      const pending = takePendingAction(current.untriedActions, params.strategy);
      if (!pending) {
        break;
      }
      const child: TreeSearchNode<TResult> = {
        id: params.nextId(),
        parent: current,
        depth: current.depth + 1,
        action: pending.action,
        actionSequence: [...current.actionSequence, pending.action],
        visits: 0,
        valueSum: 0,
        prior: pending.prior,
        selectionReason: "unvisited",
        children: []
      };
      current.children.push(child);
      return child;
    }
    if (current.children.length === 0) {
      // This branch has no deeper actions. Mark it terminal and stop descending so it is
      // re-simulated as a leaf instead of returning undefined and stopping the entire search.
      // UCT selection from the root still moves on to any branch that can still expand.
      current.terminal = true;
      break;
    }
    current = selectVisitedTreeChild(current, params.strategy, params.budget);
  }
  return current.depth > 0 ? current : undefined;
}

function takePendingAction(actions: PendingAction[], strategy: "mcts" | "alpha-zero"): PendingAction | undefined {
  if (actions.length === 0) {
    return undefined;
  }
  if (strategy !== "alpha-zero") {
    return actions.shift();
  }
  let bestIndex = 0;
  for (let index = 1; index < actions.length; index += 1) {
    if (actions[index]!.prior > actions[bestIndex]!.prior) {
      bestIndex = index;
    }
  }
  return actions.splice(bestIndex, 1)[0];
}

function selectVisitedTreeChild<TResult>(
  parent: TreeSearchNode<TResult>,
  strategy: "mcts" | "alpha-zero",
  budget: NormalizedBudget
): TreeSearchNode<TResult> {
  const reason: TrajectorySelectionReason = strategy === "alpha-zero" ? "puct" : "ucb";
  let best = parent.children[0]!;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const child of parent.children) {
    const selectionScore =
      strategy === "alpha-zero"
        ? puctSelectionScore(treeMeanScore(child), Math.max(1, parent.visits), child.visits, child.prior, budget.puctExploration)
        : ucbSelectionScore(treeMeanScore(child), Math.max(1, parent.visits), child.visits, budget.explorationWeight);
    // Keep stored stats JSON-safe: a forced-exploration child reports `selectionReason`
    // instead of a non-finite `selectionScore`.
    if (Number.isFinite(selectionScore)) {
      child.selectionScore = selectionScore;
      child.selectionReason = reason;
    } else {
      delete child.selectionScore;
      child.selectionReason = "unvisited";
    }
    if (selectionScore > bestScore) {
      bestScore = selectionScore;
      best = child;
    }
  }
  return best;
}

function ucbSelectionScore(meanScore: number, parentVisits: number, visits: number, explorationWeight: number): number {
  if (visits === 0) {
    return Number.POSITIVE_INFINITY;
  }
  return meanScore + explorationWeight * Math.sqrt(Math.log(Math.max(2, parentVisits)) / visits);
}

function puctSelectionScore(meanScore: number, parentVisits: number, visits: number, prior: number, puctExploration: number): number {
  return meanScore + puctExploration * prior * (Math.sqrt(Math.max(1, parentVisits)) / (1 + visits));
}

function backpropagateTreeScore<TResult>(node: TreeSearchNode<TResult>, score: number): void {
  let current: TreeSearchNode<TResult> | undefined = node;
  while (current) {
    current.visits += 1;
    current.valueSum += score;
    current = current.parent;
  }
}

function treeMeanScore<TResult>(node: TreeSearchNode<TResult>): number {
  return node.visits === 0 ? 0 : node.valueSum / node.visits;
}

function copyTreeStats<TResult>(target: TrajectorySearchNode<TResult>, source: TreeSearchNode<TResult>): void {
  target.visits = source.visits;
  target.valueSum = source.valueSum;
  target.meanScore = treeMeanScore(source);
  target.prior = source.prior;
  if (source.selectionScore !== undefined) {
    target.selectionScore = source.selectionScore;
  }
  if (source.selectionReason !== undefined) {
    target.selectionReason = source.selectionReason;
  }
}

function treeNodeToPublicNode<TResult>(node: TreeSearchNode<TResult>, publicRootId = "root"): TrajectorySearchNode<TResult> {
  // Merge the actual last evaluated rollout node (score, result, sessionPath, reason, tokens)
  // with the branch's aggregate tree stats so dynamic action generators see a `parent` as
  // useful as the real rollout node beam search already passes.
  const last = node.lastResultNode;
  return {
    id: treePublicNodeId(node, publicRootId),
    ...(node.parent ? { parentId: treePublicNodeId(node.parent, publicRootId) } : {}),
    depth: node.depth,
    rollout: last?.rollout ?? 0,
    ...(node.action ? { action: node.action } : {}),
    ...(node.action?.actionKey === undefined ? {} : { actionKey: node.action.actionKey }),
    actionSequence: node.actionSequence,
    actionSequenceKeys: node.actionSequence.map(actionKeyForNode),
    ...(last?.sessionId === undefined ? {} : { sessionId: last.sessionId }),
    ...(last?.sessionPath === undefined ? {} : { sessionPath: last.sessionPath }),
    ...(last?.score === undefined ? {} : { score: last.score }),
    ...(last?.reason === undefined ? {} : { reason: last.reason }),
    ...(last?.scoreMetadata === undefined ? {} : { scoreMetadata: last.scoreMetadata }),
    ...(last?.judgeUsage === undefined ? {} : { judgeUsage: last.judgeUsage }),
    ...(last?.result === undefined ? {} : { result: last.result }),
    ...(last?.reachedGoal === undefined ? {} : { reachedGoal: last.reachedGoal }),
    ...(last?.divergedAtStep === undefined ? {} : { divergedAtStep: last.divergedAtStep }),
    tokensSpent: last?.tokensSpent ?? { inputTokens: 0, outputTokens: 0 },
    visits: node.visits,
    valueSum: node.valueSum,
    meanScore: treeMeanScore(node),
    prior: node.prior,
    ...(node.selectionScore === undefined ? {} : { selectionScore: node.selectionScore }),
    ...(node.selectionReason === undefined ? {} : { selectionReason: node.selectionReason })
  };
}

function treePublicNodeId<TResult>(node: TreeSearchNode<TResult> | undefined, publicRootId: string): string {
  if (!node || node.depth === 0) {
    return publicRootId;
  }
  return node.resultNodeId ?? node.id;
}

function monteCarloParentNode<TResult>(
  root: TrajectorySearchNode<TResult>,
  sequence: TrajectorySearchAction[],
  rollout: number
): TrajectorySearchNode<TResult> {
  if (sequence.length === 0) {
    return root;
  }
  return {
    id: `mc${rollout}-d${sequence.length}`,
    parentId: sequence.length === 1 ? root.id : `mc${rollout}-d${sequence.length - 1}`,
    depth: sequence.length,
    rollout,
    action: sequence.at(-1),
    ...(sequence.at(-1)?.actionKey === undefined ? {} : { actionKey: sequence.at(-1)?.actionKey }),
    actionSequence: [...sequence],
    actionSequenceKeys: sequence.map(actionKeyForNode),
    tokensSpent: { inputTokens: 0, outputTokens: 0 }
  };
}

function composeAction(sequence: TrajectorySearchAction[]): ComposedAction {
  const transforms = sequence.map((action) => action.overrides?.transformRequest).filter((fn): fn is NonNullable<ForkOverrides["transformRequest"]> => Boolean(fn));
  const overrides = sequence.reduce<ForkOverrides>((merged, action) => {
    if (!action.overrides) {
      return merged;
    }
    return {
      ...merged,
      ...(action.overrides.system === undefined ? {} : { system: action.overrides.system }),
      ...(action.overrides.model === undefined ? {} : { model: action.overrides.model })
    };
  }, {});
  if (transforms.length > 0) {
    overrides.transformRequest = (req, step) => transforms.reduce((current, transform) => transform(current, step), req);
  }
  const lastWithModel = [...sequence].reverse().find((action) => action.model !== undefined);
  const lastWithTools = [...sequence].reverse().find((action) => action.tools !== undefined);
  return {
    action: sequence.at(-1),
    ...(Object.keys(overrides).length === 0 ? {} : { overrides }),
    ...(lastWithModel ? { model: lastWithModel.model } : {}),
    ...(lastWithTools ? { tools: lastWithTools.tools } : {})
  };
}

function normalizeScore(value: number | TrajectorySearchScore): TrajectorySearchScore {
  const scored = typeof value === "number" ? { score: value } : value;
  if (!Number.isFinite(scored.score)) {
    throw new TypeError(`Trajectory search score must be a finite number, got ${String(scored.score)}.`);
  }
  if (scored.judgeUsage) {
    assertUsage("score.judgeUsage", scored.judgeUsage);
  }
  return {
    score: scored.score,
    ...(scored.reason === undefined ? {} : { reason: scored.reason }),
    ...(scored.metadata === undefined ? {} : { metadata: toJsonValue(scored.metadata) ?? null }),
    ...(scored.judgeUsage === undefined ? {} : { judgeUsage: scored.judgeUsage })
  };
}

function normalizeBudget(budget: TrajectorySearchBudget | undefined, strategy: TrajectorySearchStrategy, actionCount: number | undefined): NormalizedBudget {
  const maxRollouts = budget?.maxRollouts ?? (strategy === "beam" ? Math.max(1, actionCount ?? 10) : 10);
  const maxDepth = budget?.maxDepth ?? 1;
  const beamWidth = budget?.beamWidth ?? 3;
  const explorationWeight = budget?.explorationWeight ?? Math.SQRT2;
  const puctExploration = budget?.puctExploration ?? 1.5;
  assertPositiveInteger("budget.maxRollouts", maxRollouts);
  assertPositiveInteger("budget.maxDepth", maxDepth);
  assertPositiveInteger("budget.beamWidth", beamWidth);
  assertNonNegativeFinite("budget.explorationWeight", explorationWeight);
  assertNonNegativeFinite("budget.puctExploration", puctExploration);
  if (budget?.maxTokens !== undefined) {
    assertPositiveInteger("budget.maxTokens", budget.maxTokens);
  }
  if (budget?.stopScore !== undefined && !Number.isFinite(budget.stopScore)) {
    throw new TypeError("budget.stopScore must be a finite number.");
  }
  return {
    maxRollouts,
    maxDepth,
    beamWidth,
    explorationWeight,
    puctExploration,
    maxTokens: budget?.maxTokens,
    stopScore: budget?.stopScore
  };
}

function normalizeControls<
  TResult,
  TTools extends ToolHandlers,
  TRequest,
  TResponse,
  TStreamChunk
>(opts: TrajectorySearchOptions<TResult, TTools, TRequest, TResponse, TStreamChunk>): NormalizedControls {
  const concurrency = opts.concurrency ?? 1;
  assertPositiveInteger("concurrency", concurrency);
  const retry = normalizeRetry(opts.retry);
  const rateLimiter = opts.rateLimit ? new RolloutRateLimiter(opts.rateLimit) : undefined;
  return {
    concurrency,
    retry,
    ...(rateLimiter ? { rateLimiter } : {}),
    ...(opts.signal ? { signal: opts.signal } : {})
  };
}

function normalizeRetry(retry: TrajectorySearchRetryOptions | undefined): NormalizedRetry {
  const attempts = retry?.attempts ?? 1;
  const baseDelayMs = retry?.baseDelayMs ?? 100;
  const maxDelayMs = retry?.maxDelayMs ?? 2_000;
  const factor = retry?.factor ?? 2;
  const jitter = retry?.jitter ?? 0.2;
  assertPositiveInteger("retry.attempts", attempts);
  assertNonNegativeFinite("retry.baseDelayMs", baseDelayMs);
  assertNonNegativeFinite("retry.maxDelayMs", maxDelayMs);
  assertNonNegativeFinite("retry.factor", factor);
  if (jitter !== false) {
    assertNonNegativeFinite("retry.jitter", jitter);
  }
  return {
    attempts,
    baseDelayMs,
    maxDelayMs,
    factor,
    jitter,
    ...(retry?.shouldRetry ? { shouldRetry: retry.shouldRetry } : {})
  };
}

function assertBranchControls<
  TResult,
  TTools extends ToolHandlers,
  TRequest,
  TResponse,
  TStreamChunk
>(opts: TrajectorySearchOptions<TResult, TTools, TRequest, TResponse, TStreamChunk>): void {
  const metric = opts.bestBranchBy ?? "mean";
  if (metric !== "mean" && metric !== "lower-confidence-bound" && metric !== "pass-rate") {
    throw new TypeError(`Unknown bestBranchBy "${String(metric)}". Use mean, lower-confidence-bound, or pass-rate.`);
  }
  if (opts.branchPassScore !== undefined && !Number.isFinite(opts.branchPassScore)) {
    throw new TypeError("branchPassScore must be a finite number.");
  }
}

function reserveRollout<TResult>(state: SearchState<TResult>, budget: NormalizedBudget): number | undefined {
  if (state.rollouts >= budget.maxRollouts) {
    state.stoppedReason = "maxRollouts";
    return undefined;
  }
  if (budget.maxTokens !== undefined && tokenTotal(state.tokensSpent) >= budget.maxTokens) {
    state.stoppedReason = "maxTokens";
    return undefined;
  }
  state.rollouts += 1;
  return state.rollouts;
}

async function runWithRetry<T>(fn: () => Promise<T>, retry: NormalizedRetry, signal: AbortSignal | undefined): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= retry.attempts; attempt += 1) {
    throwIfAborted(signal);
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (isAbortError(error) || attempt >= retry.attempts) {
        throw error;
      }
      const shouldRetry = retry.shouldRetry ? await retry.shouldRetry(error, attempt) : true;
      if (!shouldRetry) {
        throw error;
      }
      await sleep(backoffDelay(retry, attempt), signal);
    }
  }
  throw lastError;
}

function backoffDelay(retry: NormalizedRetry, attempt: number): number {
  const raw = Math.min(retry.maxDelayMs, retry.baseDelayMs * Math.pow(retry.factor, attempt - 1));
  if (retry.jitter === false || retry.jitter === 0 || raw === 0) {
    return raw;
  }
  const spread = raw * retry.jitter;
  return Math.max(0, raw - spread + Math.random() * spread * 2);
}

async function mapWithConcurrency<T, R>(items: readonly T[], concurrency: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
}

class RolloutRateLimiter {
  private starts: number[] = [];

  constructor(private readonly opts: TrajectorySearchRateLimitOptions) {
    assertPositiveInteger("rateLimit.maxStarts", opts.maxStarts);
    if (opts.intervalMs !== undefined) {
      assertPositiveInteger("rateLimit.intervalMs", opts.intervalMs);
    }
  }

  async wait(signal: AbortSignal | undefined): Promise<void> {
    const intervalMs = this.opts.intervalMs ?? 1_000;
    while (true) {
      throwIfAborted(signal);
      const now = Date.now();
      this.starts = this.starts.filter((startedAt) => now - startedAt < intervalMs);
      if (this.starts.length < this.opts.maxStarts) {
        this.starts.push(now);
        return;
      }
      const waitMs = Math.max(0, intervalMs - (now - this.starts[0]!));
      await sleep(waitMs, signal);
    }
  }
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(cleanupResolve, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(abortError(signal));
    };
    function cleanupResolve() {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw abortError(signal);
  }
}

function abortError(signal: AbortSignal | undefined): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) {
    return reason;
  }
  const error = new Error(reason === undefined ? "Trajectory search aborted." : String(reason));
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function finishSearch<
  TResult,
  TTools extends ToolHandlers,
  TRequest,
  TResponse,
  TStreamChunk
>(
  replay: ReplaySession<TTools, TRequest, TResponse, TStreamChunk>,
  atStep: number,
  strategy: TrajectorySearchStrategy,
  state: {
    best: TrajectorySearchNode<TResult> | undefined;
    nodes: TrajectorySearchNode<TResult>[];
    rollouts: number;
    tokensSpent: Usage;
    judgeUsage: Usage;
  },
  stoppedReason: TrajectorySearchResult<TResult>["stoppedReason"],
  persistence: NormalizedPersistence | undefined,
  bestBranchBy: TrajectoryBestBranchMetric,
  branchPassScore: number
): TrajectorySearchResult<TResult> {
  const diagnostics = buildDiagnostics(strategy, state.nodes, state.rollouts, branchPassScore);
  const bestBranch = selectBestBranch(diagnostics.branches, bestBranchBy);
  return {
    ...(persistence ? { searchId: persistence.id, searchPath: persistence.path } : {}),
    strategy,
    parentSessionId: replay.stored.meta.id,
    parentSessionPath: replay.stored.path,
    atStep,
    ...(state.best ? { best: state.best } : {}),
    ...(bestBranch ? { bestBranch } : {}),
    bestBranchBy,
    nodes: state.nodes,
    rollouts: state.rollouts,
    tokensSpent: state.tokensSpent,
    judgeUsage: state.judgeUsage,
    stoppedReason,
    diagnostics
  };
}

function normalizePersistence<
  TTools extends ToolHandlers,
  TRequest,
  TResponse,
  TStreamChunk
>(
  replay: ReplaySession<TTools, TRequest, TResponse, TStreamChunk>,
  persist: TrajectorySearchOptions["persist"]
): NormalizedPersistence | undefined {
  if (persist === false) {
    return undefined;
  }
  const id = typeof persist === "object" && persist.id ? persist.id : randomUUID();
  const dir = typeof persist === "object" && persist.dir ? persist.dir : join(dirname(replay.stored.path), "searches");
  return { id, path: join(dir, `${id}.json`) };
}

async function persistSearchManifest<TResult>(result: TrajectorySearchResult<TResult>): Promise<void> {
  if (!result.searchPath) {
    return;
  }
  await mkdir(dirname(result.searchPath), { recursive: true });
  const manifest = {
    schema: "agentrewind.trajectory-search",
    version: 1,
    searchId: result.searchId,
    parentSessionId: result.parentSessionId,
    parentSessionPath: result.parentSessionPath,
    atStep: result.atStep,
    strategy: result.strategy,
    rollouts: result.rollouts,
    tokensSpent: result.tokensSpent,
    judgeUsage: result.judgeUsage,
    stoppedReason: result.stoppedReason,
    bestBranchBy: result.bestBranchBy,
    bestBranch: result.bestBranch,
    bestNodeId: result.best?.id,
    bestSessionId: result.best?.sessionId,
    bestSessionPath: result.best?.sessionPath,
    diagnostics: result.diagnostics,
    nodes: result.nodes.filter((node) => node.id !== "root").map(searchManifestNode)
  };
  await writeFile(result.searchPath, `${JSON.stringify(toJsonSafe(manifest), null, 2)}\n`, "utf8");
}

function searchManifestNode<TResult>(node: TrajectorySearchNode<TResult>): Record<string, unknown> {
  return {
    id: node.id,
    parentId: node.parentId,
    depth: node.depth,
    rollout: node.rollout,
    action: searchManifestAction(node.action),
    actionKey: node.actionKey,
    actionSequence: node.actionSequence.map(searchManifestAction),
    actionSequenceKeys: node.actionSequenceKeys,
    sessionId: node.sessionId,
    sessionPath: node.sessionPath,
    score: node.score,
    reason: node.reason,
    scoreMetadata: node.scoreMetadata,
    judgeUsage: node.judgeUsage,
    tokensSpent: node.tokensSpent,
    reachedGoal: node.reachedGoal,
    divergedAtStep: node.divergedAtStep,
    error: node.error,
    visits: node.visits,
    valueSum: node.valueSum,
    meanScore: node.meanScore,
    prior: node.prior,
    selectionScore: node.selectionScore,
    selectionReason: node.selectionReason
  };
}

function searchManifestAction(action: TrajectorySearchAction | undefined): Record<string, unknown> | undefined {
  if (!action) {
    return undefined;
  }
  return {
    id: action.id,
    actionKey: action.actionKey,
    label: action.label,
    overrides: {
      system: action.overrides?.system,
      model: action.overrides?.model,
      transformRequest: action.overrides?.transformRequest ? "[Function transformRequest]" : undefined
    },
    hasModelClient: action.model !== undefined,
    tools: action.tools,
    prior: action.prior,
    metadata: action.metadata
  };
}

async function annotateChildSearchMeta<TResult, TTools extends ToolHandlers, TRequest, TResponse, TStreamChunk>(
  node: TrajectorySearchNode<TResult>,
  replay: ReplaySession<TTools, TRequest, TResponse, TStreamChunk>,
  atStep: number,
  persistence: NormalizedPersistence | undefined
): Promise<void> {
  if (!persistence || !node.sessionPath) {
    return;
  }
  const metaPath = join(node.sessionPath, "meta.json");
  const meta = JSON.parse(await readFile(metaPath, "utf8")) as Record<string, unknown>;
  meta.search = toJsonSafe({
    searchId: persistence.id,
    searchPath: persistence.path,
    parentSessionId: replay.stored.meta.id,
    atStep,
    rollout: node.rollout,
    nodeId: node.id,
    actionSequence: node.actionSequence.map((action, index) => action.id ?? `action-${index + 1}`),
    actionSequenceKeys: node.actionSequenceKeys,
    score: node.score,
    reason: node.reason,
    error: node.error
  });
  await writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
}

function buildDiagnostics<TResult>(
  strategy: TrajectorySearchStrategy,
  nodes: TrajectorySearchNode<TResult>[],
  rollouts: number,
  branchPassScore: number
): TrajectorySearchDiagnostics {
  const branches = new Map<
    string,
    {
      actionSequence: string[];
      actionKeys: string[];
      depth: number;
      visits: number;
      valueSum: number;
      valueSquares: number;
      minScore: number;
      maxScore: number;
      passCount: number;
    }
  >();
  for (const node of nodes) {
    if (node.id === "root" || node.actionSequence.length === 0) {
      continue;
    }
    const actionSequence = node.actionSequence.map((action, index) => action.id ?? `action-${index + 1}`);
    const actionKeys = node.actionSequenceKeys.length > 0 ? node.actionSequenceKeys : node.actionSequence.map(actionKeyForNode);
    const key = actionKeys.join(" > ");
    const branch =
      branches.get(key) ??
      {
        actionSequence,
        actionKeys,
        depth: actionSequence.length,
        visits: 0,
        valueSum: 0,
        valueSquares: 0,
        minScore: Number.POSITIVE_INFINITY,
        maxScore: Number.NEGATIVE_INFINITY,
        passCount: 0
      };
    const score = node.score ?? 0;
    branch.visits += 1;
    branch.valueSum += score;
    branch.valueSquares += score * score;
    branch.minScore = Math.min(branch.minScore, score);
    branch.maxScore = Math.max(branch.maxScore, score);
    if (score >= branchPassScore) {
      branch.passCount += 1;
    }
    branches.set(key, branch);
  }
  const summary = [...branches.entries()]
    .map(([key, branch]) => {
      const meanScore = branch.visits === 0 ? 0 : branch.valueSum / branch.visits;
      const variance = branch.visits === 0 ? 0 : Math.max(0, branch.valueSquares / branch.visits - meanScore * meanScore);
      const standardError = branch.visits === 0 ? 0 : Math.sqrt(variance / branch.visits);
      return {
        actionSequence: branch.actionSequence,
        actionKeys: branch.actionKeys,
        key,
        depth: branch.depth,
        visits: branch.visits,
        valueSum: branch.valueSum,
        meanScore,
        minScore: branch.visits === 0 ? 0 : branch.minScore,
        maxScore: branch.visits === 0 ? 0 : branch.maxScore,
        variance,
        lowerConfidenceBound: meanScore - 1.96 * standardError,
        passCount: branch.passCount,
        passRate: branch.visits === 0 ? 0 : branch.passCount / branch.visits
      };
    })
    .sort((a, b) => b.meanScore - a.meanScore || b.visits - a.visits || a.key.localeCompare(b.key));
  return { strategy, rollouts, branches: summary };
}

function selectBestBranch(
  branches: TrajectorySearchBranchDiagnostic[],
  metric: TrajectoryBestBranchMetric
): TrajectorySearchBranchDiagnostic | undefined {
  const scoreFor = (branch: TrajectorySearchBranchDiagnostic) => {
    switch (metric) {
      case "lower-confidence-bound":
        return branch.lowerConfidenceBound;
      case "pass-rate":
        return branch.passRate;
      case "mean":
        return branch.meanScore;
    }
  };
  return [...branches].sort((a, b) => scoreFor(b) - scoreFor(a) || b.visits - a.visits || b.meanScore - a.meanScore || a.key.localeCompare(b.key))[0];
}

/**
 * Read one value from a Monte Carlo `random()` source and enforce the `Math.random`
 * contract. Out-of-range values would otherwise produce biased samples or undefined
 * array indexes, so fail fast with an actionable message.
 */
function nextRandomUnit(random: () => number): number {
  const value = random();
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value >= 1) {
    throw new TypeError(`Trajectory search random() must return a finite number in [0, 1), got ${String(value)}.`);
  }
  return value;
}

function tokenTotal(usage: Usage): number {
  return usage.inputTokens + usage.outputTokens;
}

function assertStep(step: number): void {
  if (!Number.isInteger(step) || step < 0) {
    throw new TypeError(`Trajectory search atStep must be a non-negative integer, got ${String(step)}.`);
  }
}

function assertRecordedBoundaryStep<
  TTools extends ToolHandlers,
  TRequest,
  TResponse,
  TStreamChunk
>(replay: ReplaySession<TTools, TRequest, TResponse, TStreamChunk>, step: number): void {
  const event = replay.stored.events.find((candidate) => candidate.step === step);
  if (!event || !isBoundaryEvent(event)) {
    const available = replay.stored.events.filter(isBoundaryEvent).map((candidate) => candidate.step);
    throw new RangeError(
      `Trajectory search atStep ${step} is not a recorded boundary step. Available boundary steps: ${available.join(", ") || "none"}.`
    );
  }
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive integer, got ${String(value)}.`);
  }
}

function assertNonNegativeFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative finite number, got ${String(value)}.`);
  }
}

function assertUsage(name: string, usage: Usage): void {
  assertNonNegativeFinite(`${name}.inputTokens`, usage.inputTokens);
  assertNonNegativeFinite(`${name}.outputTokens`, usage.outputTokens);
  if (usage.costUsd !== undefined) {
    assertNonNegativeFinite(`${name}.costUsd`, usage.costUsd);
  }
}

function assertAction(action: TrajectorySearchAction): void {
  if (action.prior !== undefined) {
    assertNonNegativeFinite(`trajectory search action ${action.id ?? "<unnamed>"}.prior`, action.prior);
  }
}

function isSearchStrategy(value: string): value is TrajectorySearchStrategy {
  return value === "monte-carlo" || value === "beam" || value === "ucb" || value === "mcts" || value === "alpha-zero";
}

export function toJsonValue(value: unknown): JsonValue | undefined {
  return toJsonSafe(value) as JsonValue | undefined;
}

function toJsonSafe(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : String(value);
  }
  if (typeof value === "undefined") {
    return undefined;
  }
  if (typeof value === "bigint" || typeof value === "symbol" || typeof value === "function") {
    return String(value);
  }
  if (value instanceof Error) {
    return toJsonSafe(serializeError(value), seen);
  }
  if (typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);
  if (Array.isArray(value)) {
    const out = value.map((item) => toJsonSafe(item, seen));
    seen.delete(value);
    return out;
  }
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const safe = toJsonSafe(child, seen);
    if (safe !== undefined) {
      out[key] = safe;
    }
  }
  seen.delete(value);
  return out;
}

function stableStringify(value: unknown): string {
  if (value === undefined) {
    return "undefined";
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}
