#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const packageDirs = readdirSync(join(root, "packages"))
  .map((name) => join(root, "packages", name))
  .filter((path) => statSync(path).isDirectory())
  .sort();

const alreadyPublished = [];

for (const packageDir of packageDirs) {
  const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
  const spec = `${manifest.name}@${manifest.version}`;
  const exists = npmView(spec);
  if (exists) {
    alreadyPublished.push(spec);
  }
}

if (alreadyPublished.length > 0) {
  console.error("Refusing to publish versions that already exist on npm:");
  for (const spec of alreadyPublished) {
    console.error(`- ${spec}`);
  }
  console.error("Bump changed package versions before running publish:npm.");
  process.exit(1);
}

console.log(`Version gate passed for ${packageDirs.length} packages.`);

function npmView(spec) {
  try {
    execFileSync("npm", ["view", spec, "version", "--silent"], { stdio: "ignore" });
    return true;
  } catch (error) {
    const status = error && typeof error === "object" && "status" in error ? error.status : undefined;
    if (status === 1) {
      return false;
    }
    throw error;
  }
}
