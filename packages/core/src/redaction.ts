import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { VaultError } from "./errors.js";

export interface RedactionConfig {
  enabled: boolean;
  patterns?: RegExp[];
  useOnlyPatterns?: boolean;
  includeEnvSecrets?: boolean;
}

export interface RedactionSummary {
  total: number;
  byPattern: Record<string, number>;
}

interface VaultPayload {
  version: 1;
  entries: Record<string, string>;
}

export interface VaultCrypto {
  randomBytes(size: number): Buffer;
}

let vaultCrypto: VaultCrypto = { randomBytes };

const DEFAULT_PATTERNS = [
  /sk-ant-[A-Za-z0-9_-]{16,}/g,
  /sk-[A-Za-z0-9]{20,}/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]{16,}/g,
  /(?:api[_-]?key|token|secret)["'\s:=]+[A-Za-z0-9._~+/=-]{12,}/gi
];

interface RedactionRule {
  pattern: RegExp;
  label: string;
  persisted: boolean;
}

export class Vault {
  private readonly entries = new Map<string, string>();

  add(token: string, secret: string): void {
    this.entries.set(token, secret);
  }

  restore<T>(value: T): T {
    return restoreDeep(value, this.entries);
  }

  redactions(): { token: string; secret: string }[] {
    return [...this.entries].map(([token, secret]) => ({ token, secret }));
  }

  toJSON(): VaultPayload {
    return { version: 1, entries: Object.fromEntries(this.entries) };
  }

  static fromJSON(payload: VaultPayload): Vault {
    assertVaultPayload(payload);
    const vault = new Vault();
    for (const [token, secret] of Object.entries(payload.entries)) {
      vault.add(token, secret);
    }
    return vault;
  }
}

export class Redactor {
  readonly enabled: boolean;
  readonly patterns: RegExp[];
  readonly vault: Vault;
  readonly summary: RedactionSummary = { total: 0, byPattern: {} };
  private readonly rules: RedactionRule[];

  constructor(config?: RedactionConfig, vault = new Vault()) {
    this.enabled = config?.enabled ?? true;
    const providedRules = (config?.patterns ?? []).map((pattern) => {
      const normalized = globalPattern(pattern);
      return rule(normalized, normalized.toString(), true);
    });
    const includeEnvSecrets = config?.includeEnvSecrets ?? !config?.useOnlyPatterns;
    const envRules = includeEnvSecrets ? envSecretRules() : [];
    this.rules = config?.useOnlyPatterns
      ? [...providedRules, ...envRules]
      : [...DEFAULT_PATTERNS.map((pattern) => rule(pattern, pattern.toString(), true)), ...envRules, ...providedRules];
    this.patterns = this.rules.map((entry) => entry.pattern);
    this.vault = vault;
  }

  redactString(value: string): string {
    if (!this.enabled) {
      return value;
    }
    let out = value;
    for (const entry of this.rules) {
      const pattern = entry.pattern;
      pattern.lastIndex = 0;
      out = out.replace(pattern, (secret: string) => {
        const token = `arw:redacted:${sha256hex(secret).slice(0, 12)}`;
        this.vault.add(token, secret);
        this.summary.total += 1;
        this.summary.byPattern[entry.label] = (this.summary.byPattern[entry.label] ?? 0) + 1;
        return token;
      });
    }
    return this.redactKnownVaultSecrets(out);
  }

  redactDeep<T>(value: T): T {
    return mapDeep(value, (leaf) => (typeof leaf === "string" ? this.redactString(leaf) : leaf)) as T;
  }

  patternLabels(): string[] {
    return this.rules.filter((entry) => entry.persisted).map((entry) => entry.label);
  }

  private redactKnownVaultSecrets(value: string): string {
    let out = value;
    const known = this.vault.redactions().sort((a, b) => b.secret.length - a.secret.length);
    for (const { token, secret } of known) {
      if (secret.length === 0 || !out.includes(secret)) {
        continue;
      }
      out = out.split(secret).join(token);
    }
    return out;
  }
}

export function setVaultCryptoForTests(crypto: VaultCrypto): () => void {
  const previous = vaultCrypto;
  vaultCrypto = crypto;
  return () => {
    vaultCrypto = previous;
  };
}

export function patternsFromLabels(labels: string[]): RegExp[] {
  return labels
    .map((label) => regexpFromLabel(label))
    .filter((pattern): pattern is RegExp => pattern !== undefined);
}

export async function saveVault(path: string, vault: Vault): Promise<void> {
  const keyPath = `${path}.key`;
  const key = await getOrCreateLocalKey(keyPath);
  const iv = vaultCrypto.randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(vault.toJSON()), "utf8");
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, Buffer.concat([Buffer.from("ARWV1"), iv, tag, encrypted]));
  await chmod(path, 0o600);
}

export async function loadVault(path: string): Promise<Vault> {
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return new Vault();
    }
    throw new VaultError("Unable to inspect vault file", {
      path,
      cause: error instanceof Error ? error.message : String(error)
    });
  }
  if (!info.isFile()) {
    throw new VaultError("Vault path is not a file", { path });
  }

  try {
    const key = await readLocalKey(`${path}.key`);
    const payload = await readFile(path);
    if (payload.subarray(0, 5).toString("utf8") !== "ARWV1") {
      throw new VaultError("Unsupported vault format", { path });
    }
    const iv = payload.subarray(5, 17);
    const tag = payload.subarray(17, 33);
    const encrypted = payload.subarray(33);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return Vault.fromJSON(JSON.parse(plaintext.toString("utf8")) as VaultPayload);
  } catch (error) {
    if (error instanceof VaultError) {
      throw error;
    }
    throw new VaultError("Unable to read or decrypt vault", {
      path,
      cause: error instanceof Error ? error.message : String(error)
    });
  }
}

function sha256hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function getOrCreateLocalKey(path: string): Promise<Buffer> {
  try {
    const existing = await readFile(path);
    if (existing.length !== 32) {
      throw new VaultError("Invalid local vault key length", { path });
    }
    return existing;
  } catch (error) {
    if (error instanceof VaultError) {
      throw error;
    }
    if (isNodeError(error) && error.code === "ENOENT") {
      await mkdir(dirname(path), { recursive: true });
      const key = vaultCrypto.randomBytes(32);
      await writeFile(path, key, { mode: 0o600 });
      await chmod(path, 0o600);
      return key;
    }
    throw new VaultError("Unable to read local vault key", {
      path,
      cause: error instanceof Error ? error.message : String(error)
    });
  }
}

async function readLocalKey(path: string): Promise<Buffer> {
  try {
    const existing = await readFile(path);
    if (existing.length !== 32) {
      throw new VaultError("Invalid local vault key length", { path });
    }
    return existing;
  } catch (error) {
    if (error instanceof VaultError) {
      throw error;
    }
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new VaultError("Missing local vault key for encrypted vault", { path });
    }
    throw new VaultError("Unable to read local vault key", {
      path,
      cause: error instanceof Error ? error.message : String(error)
    });
  }
}

function assertVaultPayload(payload: VaultPayload): void {
  if (
    payload === null ||
    typeof payload !== "object" ||
    payload.version !== 1 ||
    payload.entries === null ||
    typeof payload.entries !== "object" ||
    Array.isArray(payload.entries) ||
    !Object.values(payload.entries).every((secret) => typeof secret === "string")
  ) {
    throw new VaultError("Invalid vault payload", {
      expected: "Vault payload must have version=1 and string entries."
    });
  }
}

function envSecretRules(): RedactionRule[] {
  return Object.entries(process.env)
    .filter(([key, value]) => value && /(?:key|token|secret|password|credential)/i.test(key) && value.length >= 8)
    .map(([key, value]) => {
      const secret = value ?? "";
      return rule(new RegExp(escapeRegExp(secret), "g"), `env:${key}:${sha256hex(secret).slice(0, 12)}`, false);
    });
}

function rule(pattern: RegExp, label: string, persisted: boolean): RedactionRule {
  return { pattern, label, persisted };
}

function globalPattern(pattern: RegExp): RegExp {
  const withoutSticky = pattern.flags.replace("y", "");
  const flags = withoutSticky.includes("g") ? withoutSticky : `${withoutSticky}g`;
  return new RegExp(pattern.source, flags);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function regexpFromLabel(label: string): RegExp | undefined {
  if (!label.startsWith("/")) {
    return undefined;
  }
  const lastSlash = label.lastIndexOf("/");
  if (lastSlash <= 0) {
    return undefined;
  }
  const source = label.slice(1, lastSlash);
  const flags = label.slice(lastSlash + 1);
  try {
    return new RegExp(source, flags);
  } catch {
    return undefined;
  }
}

function mapDeep(value: unknown, mapLeaf: (value: unknown) => unknown, seen = new WeakMap<object, unknown>()): unknown {
  if (value === null || typeof value !== "object") {
    return mapLeaf(value);
  }
  if (seen.has(value)) {
    return seen.get(value);
  }
  if (Array.isArray(value)) {
    const arr: unknown[] = [];
    seen.set(value, arr);
    for (const item of value) {
      arr.push(mapDeep(item, mapLeaf, seen));
    }
    return arr;
  }
  const out: Record<string, unknown> = {};
  seen.set(value, out);
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out[key] = mapDeep(child, mapLeaf, seen);
  }
  return out;
}

function restoreDeep<T>(value: T, entries: Map<string, string>): T {
  return mapDeep(value, (leaf) => {
    if (typeof leaf !== "string") {
      return leaf;
    }
    let out = leaf;
    for (const [token, secret] of entries) {
      out = out.split(token).join(secret);
    }
    return out;
  }) as T;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
