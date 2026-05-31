import { AssertionError } from "node:assert";
import {
  AgentRewind,
  DriftError,
  explainRewindError,
  type Harness,
  type Replay,
  type ReplayOptions,
  type ToolHandlers,
  type UntypedToolHandlers
} from "@agentrewind/core";

export interface SessionAssertion<TTools extends ToolHandlers = UntypedToolHandlers> {
  /** Original selector passed to `fromSession()`, such as a path, id, or `latest`. */
  selector: string;
  /** Resolved session directory. Use this in logs and CLI commands. */
  path: string;
  /** Loaded replay for direct inspection before running assertions. */
  replay: Replay<TTools>;
  /** Assert that the harness still replays without drift. */
  assertReplay<T>(harness: Harness<T, TTools>): Promise<T>;
  /** @deprecated Use `assertReplay()` for clearer test names. */
  assertSemanticTrajectory<T>(harness: Harness<T, TTools>): Promise<T>;
}

export async function fromSession<TTools extends ToolHandlers = UntypedToolHandlers>(
  session: string,
  opts: ReplayOptions<TTools>
): Promise<SessionAssertion<TTools>> {
  const path = await AgentRewind.resolveSessionPath(session, opts);
  const replay = await AgentRewind.replay<TTools>(path, { ...opts, driftPolicy: "strict" });
  const runAssertion = <T>(harness: Harness<T, TTools>) => assertReplay<T, TTools>(path, opts, harness);
  return {
    selector: session,
    path,
    replay,
    assertReplay: runAssertion,
    assertSemanticTrajectory: runAssertion
  };
}

export async function assertReplay<T = unknown, TTools extends ToolHandlers = UntypedToolHandlers>(
  session: string,
  opts: ReplayOptions<TTools>,
  harness: Harness<T, TTools>
): Promise<T> {
  const path = await AgentRewind.resolveSessionPath(session, opts);
  const replay = await AgentRewind.replay<TTools>(path, { ...opts, driftPolicy: "strict" });
  try {
    return await replay.run(harness);
  } catch (error) {
    if (error instanceof DriftError) {
      throw new AssertionError({
        message: explainRewindError(error, { sessionPath: path }),
        actual: error.data,
        expected: "recorded boundary-event trajectory"
      });
    }
    throw error;
  }
}
