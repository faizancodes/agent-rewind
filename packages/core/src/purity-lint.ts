import { createHook, type AsyncHook } from "node:async_hooks";

export interface PurityLintDiagnostic {
  kind: "fs";
  asyncType: string;
  callSite: string;
}

export class PurityLint {
  private hook: AsyncHook | undefined;
  private active = false;
  private readonly found: PurityLintDiagnostic[] = [];

  async run<T>(fn: () => Promise<T>): Promise<T> {
    this.active = true;
    this.hook = createHook({
      init: (_asyncId, type) => {
        if (!this.active || !type.startsWith("FSREQ")) {
          return;
        }
        this.found.push({
          kind: "fs",
          asyncType: type,
          callSite: stackCallSite(new Error().stack)
        });
      }
    });
    this.hook.enable();
    try {
      return await fn();
    } finally {
      this.active = false;
      this.hook.disable();
      this.hook = undefined;
    }
  }

  diagnostics(): PurityLintDiagnostic[] {
    return [...this.found];
  }
}

function stackCallSite(stack: string | undefined): string {
  if (!stack) {
    return "unknown";
  }
  const frame =
    stack
      .split("\n")
      .map((line) => line.trim())
      .find((line) => !line.startsWith("Error") && !line.includes("node:internal") && !line.includes("purity-lint")) ?? "unknown";
  return frame.replace(/\((.*?)([^/()]+):\d+:\d+\)/, "($2)").replace(/(file:\/\/)?(.*?)([^/\s]+):\d+:\d+/, "$3");
}
