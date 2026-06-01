#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const packDir = join(root, ".npm-pack");
const temp = mkdtempSync(join(tmpdir(), "agentrewind-package-smoke-"));

try {
  const tarballs = readdirSync(packDir)
    .filter((file) => file.endsWith(".tgz"))
    .map((file) => join(packDir, file))
    .sort();
  if (tarballs.length === 0) {
    throw new Error(`No package tarballs found in ${packDir}. Run pnpm pack:packages first.`);
  }

  writeFileSync(join(temp, "package.json"), JSON.stringify({ type: "module", private: true }, null, 2));
  execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", ...tarballs], {
    cwd: temp,
    stdio: "inherit"
  });

  writeFileSync(
    join(temp, "smoke.mjs"),
    [
      "import { AgentRewind, OpenAI, assertCodecConformance, createOpenAIRewind, openaiChatCodec } from '@agentrewind/sdk';",
      "import { openRouterChatCodec } from '@agentrewind/sdk/codecs';",
      "import { createOpenRouterRewind } from '@agentrewind/sdk/providers';",
      "import { assertReplay } from '@agentrewind/sdk/testing';",
      "import { PendingStore } from '@agentrewind/sdk/advanced';",
      "",
      "const codec = openaiChatCodec();",
      "await assertCodecConformance(codec, {",
      "  name: 'smoke',",
      "  request: { model: 'm', messages: [{ role: 'user', content: 'hello' }] },",
      "  response: { id: 'chatcmpl_smoke', object: 'chat.completion', created: 0, model: 'm', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }",
      "});",
      "if (typeof AgentRewind.recordRun !== 'function') throw new Error('missing AgentRewind.recordRun');",
      "if (typeof createOpenAIRewind !== 'function') throw new Error('missing createOpenAIRewind');",
      "if (typeof createOpenRouterRewind !== 'function') throw new Error('missing createOpenRouterRewind');",
      "if (typeof openRouterChatCodec !== 'function') throw new Error('missing codecs subpath');",
      "if (typeof assertReplay !== 'function') throw new Error('missing testing subpath');",
      "if (typeof PendingStore !== 'function') throw new Error('missing advanced subpath');",
      "new OpenAI({ apiKey: 'test-key' });",
      "console.log('package import smoke ok');",
      ""
    ].join("\n")
  );

  execFileSync("node", [join(temp, "smoke.mjs")], { cwd: temp, stdio: "inherit" });
  const version = execFileSync(join(temp, "node_modules/.bin/agentrewind"), ["--version"], {
    cwd: temp,
    encoding: "utf8"
  }).trim();
  if (!/^\d+\.\d+\.\d+/.test(version)) {
    throw new Error(`agentrewind --version returned unexpected output: ${version}`);
  }
  const cliManifest = JSON.parse(readFileSync(join(temp, "node_modules/@agentrewind/cli/package.json"), "utf8"));
  if (version !== cliManifest.version) {
    throw new Error(`agentrewind --version returned ${version}, expected ${cliManifest.version}`);
  }
  console.log(`package bin smoke ok (${version})`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
