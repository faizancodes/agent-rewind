#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagesDir = join(root, "packages");
const outDir = join(root, ".npm-pack");

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const packageDirs = readdirSync(packagesDir)
  .map((name) => join(packagesDir, name))
  .filter((path) => statSync(path).isDirectory())
  .sort();

for (const packageDir of packageDirs) {
  execFileSync("pnpm", ["pack", "--pack-destination", outDir], {
    cwd: packageDir,
    stdio: "inherit"
  });
}

console.log(`Packed ${packageDirs.length} packages into ${outDir}`);
