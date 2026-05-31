import { createHash } from "node:crypto";
import type { FingerprintMode, Hash, NormalizedRequest } from "./events.js";
import { FingerprintError } from "./errors.js";
import type { ProviderCodec } from "./codec.js";
import type { Redactor } from "./redaction.js";

export function fingerprint(
  req: NormalizedRequest,
  codec: ProviderCodec,
  redactor: Redactor,
  mode: FingerprintMode
): Hash {
  const stripped = codec.stripVolatile(deepClone(req)) as NormalizedRequest;
  assertRetainedJsonCompatible(req, stripped, codec.volatileLeafPaths());
  const structurallyStable =
    mode === "structural" ? replaceVolatileLeaves(stripped, codec.volatileLeafPaths()) : stripped;
  const redacted = redactor.redactDeep(structurallyStable);
  return sha256hex(canonicalize(redacted));
}

export function fingerprintUnknown(value: unknown, redactor: Redactor): Hash {
  return sha256hex(canonicalize(redactor.redactDeep(deepClone(value))));
}

export function canonicalize(value: unknown): string {
  return canonicalizeValue(value, new WeakSet<object>());
}

function canonicalizeValue(value: unknown, seen: WeakSet<object>): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    return JSON.stringify(value.normalize("NFC"));
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new FingerprintError("Cannot fingerprint non-finite number", { value });
    }
    return Object.is(value, -0) ? "0" : String(Number(value));
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "bigint" || typeof value === "symbol" || typeof value === "function") {
    throw new FingerprintError("Cannot fingerprint non-JSON value", { type: typeof value });
  }
  if (typeof value === "undefined") {
    throw new FingerprintError("Cannot fingerprint undefined", {});
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      throw new FingerprintError("Cannot fingerprint circular value", {});
    }
    seen.add(value);
    const out = `[${value.map((item) => canonicalizeValue(item, seen)).join(",")}]`;
    seen.delete(value);
    return out;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new FingerprintError("Cannot fingerprint non-JSON object", {
      type: prototype?.constructor?.name ?? "unknown"
    });
  }
  if (seen.has(value)) {
    throw new FingerprintError("Cannot fingerprint circular value", {});
  }
  seen.add(value);
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object).sort();
  const out = `{${keys.map((key) => `${JSON.stringify(key.normalize("NFC"))}:${canonicalizeValue(object[key], seen)}`).join(",")}}`;
  seen.delete(value);
  return out;
}

export function sha256hex(value: string | Buffer): Hash {
  return createHash("sha256").update(value).digest("hex");
}

export function deepClone<T>(value: T): T {
  return cloneValue(value, new WeakMap<object, unknown>()) as T;
}

function cloneValue(value: unknown, seen: WeakMap<object, unknown>): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  const existing = seen.get(value);
  if (existing) {
    return existing;
  }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    seen.set(value, out);
    for (const item of value) {
      out.push(cloneValue(item, seen));
    }
    return out;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return value;
  }
  const out: Record<string, unknown> = {};
  seen.set(value, out);
  for (const [key, child] of Object.entries(value)) {
    out[key] = cloneValue(child, seen);
  }
  return out;
}

function replaceVolatileLeaves<T>(value: T, paths: string[]): T {
  const cloned = deepClone(value);
  for (const path of paths) {
    replacePath(cloned, path.split("."));
  }
  return cloned;
}

function replacePath(value: unknown, parts: string[]): void {
  if (parts.length === 0) {
    return;
  }
  if (Array.isArray(value)) {
    if (parts[0] === "*") {
      for (const child of value) {
        replacePath(child, parts.slice(1));
      }
      return;
    }
    const index = Number(parts[0]);
    if (Number.isInteger(index) && index >= 0 && index < value.length) {
      replacePath(value[index], parts.slice(1));
    }
    return;
  }
  if (value === null || typeof value !== "object") {
    return;
  }
  const object = value as Record<string, unknown>;
  const [head, ...tail] = parts;
  if (head === undefined) {
    return;
  }
  if (tail.length === 0) {
    if (head === "*") {
      for (const key of Object.keys(object)) {
        object[key] = "\u0000";
      }
    } else if (head in object) {
      object[head] = "\u0000";
    }
    return;
  }
  if (head === "*") {
    for (const child of Object.values(object)) {
      replacePath(child, tail);
    }
  } else if (head in object) {
    replacePath(object[head], tail);
  }
}

function assertRetainedJsonCompatible(original: unknown, stripped: unknown, volatilePaths: string[]): void {
  const volatilePatterns = volatilePaths.map((path) => path.split("."));
  assertRetainedValue(original, stripped, [], volatilePatterns, new WeakSet<object>());
}

function assertRetainedValue(
  value: unknown,
  stripped: unknown,
  path: string[],
  volatilePatterns: string[][],
  seen: WeakSet<object>
): void {
  if (!pathExists(stripped, path) && pathCanBeVolatile(path, volatilePatterns)) {
    return;
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new FingerprintError("Cannot fingerprint non-finite number", { value });
    }
    return;
  }
  if (typeof value === "bigint" || typeof value === "symbol" || typeof value === "function") {
    throw new FingerprintError("Cannot fingerprint non-JSON value", { type: typeof value });
  }
  if (typeof value === "undefined") {
    throw new FingerprintError("Cannot fingerprint undefined", {});
  }
  if (typeof value !== "object") {
    return;
  }
  if (seen.has(value)) {
    throw new FingerprintError("Cannot fingerprint circular value", {});
  }
  if (Array.isArray(value)) {
    seen.add(value);
    for (const [index, child] of value.entries()) {
      assertRetainedValue(child, stripped, [...path, String(index)], volatilePatterns, seen);
    }
    seen.delete(value);
    return;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new FingerprintError("Cannot fingerprint non-JSON object", {
      type: prototype?.constructor?.name ?? "unknown"
    });
  }
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    assertRetainedValue(child, stripped, [...path, key], volatilePatterns, seen);
  }
  seen.delete(value);
}

function pathExists(value: unknown, path: string[]): boolean {
  let current = value;
  for (const part of path) {
    if (Array.isArray(current)) {
      const index = Number(part);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        return false;
      }
      current = current[index];
      continue;
    }
    if (current === null || typeof current !== "object") {
      return false;
    }
    if (!Object.prototype.hasOwnProperty.call(current, part)) {
      return false;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return true;
}

function pathCanBeVolatile(path: string[], volatilePatterns: string[][]): boolean {
  return volatilePatterns.some((pattern) => pathSharesPatternPrefix(path, pattern));
}

function pathSharesPatternPrefix(path: string[], pattern: string[]): boolean {
  const length = Math.min(path.length, pattern.length);
  for (let index = 0; index < length; index += 1) {
    const expected = pattern[index];
    const actual = path[index];
    if (expected !== "*" && expected !== actual) {
      return false;
    }
  }
  return true;
}
