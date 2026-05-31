import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { gzip, gunzip } from "node:zlib";
import type { Hash, RewindEvent, SessionMeta } from "./events.js";
import { migrateEvent } from "./migrate.js";
import { loadVault, saveVault, Vault } from "./redaction.js";
import { RewindError, SessionStoreError, SerializationError } from "./errors.js";

export const BLOB_THRESHOLD_BYTES = 16_384;

export interface StoredSession {
  path: string;
  meta: SessionMeta;
  events: RewindEvent[];
  vault: Vault;
}

export interface SessionSelectorOptions {
  /** Store used when the selector is a bare session id or `latest`. Defaults to `.rewind`. */
  store?: string;
}

export type PackSessionOptions = SessionSelectorOptions;

interface BlobRef {
  __agentrewind_blob: Hash;
}

const SHA256_HEX = /^[a-f0-9]{64}$/;

export async function writeSession(
  store: string,
  meta: SessionMeta,
  events: RewindEvent[],
  vault: Vault,
  threshold = BLOB_THRESHOLD_BYTES
): Promise<SessionMeta> {
  const sessionPath = safeSessionPath(store, meta.id);
  const blobsPath = join(sessionPath, "blobs");
  await mkdir(blobsPath, { recursive: true });

  const storedEvents: RewindEvent[] = [];
  for (const event of [...events].sort((a, b) => a.step - b.step)) {
    storedEvents.push(await externalizeEvent(event, blobsPath, threshold));
  }

  const jsonl = `${storedEvents.map((event) => JSON.stringify(event)).join("\n")}\n`;
  const eventsHash = sha256(Buffer.from(jsonl, "utf8"));
  await writeFile(join(sessionPath, "events.jsonl"), jsonl, "utf8");
  await saveVault(join(sessionPath, "vault.enc"), vault);
  const finalMeta: SessionMeta = { ...meta, eventsHash };
  await writeFile(join(sessionPath, "meta.json"), `${JSON.stringify(finalMeta, null, 2)}\n`, "utf8");
  return finalMeta;
}

export async function readSession(sessionPath: string): Promise<StoredSession> {
  assertSessionPath(sessionPath);
  const meta = parseMeta(sessionPath, await readSessionFile(sessionPath, "meta.json"));
  const eventsJsonl = await readSessionFile(sessionPath, "events.jsonl");
  const eventsHash = sha256(Buffer.from(eventsJsonl, "utf8"));
  if (meta.eventsHash && meta.eventsHash !== eventsHash) {
    throw new SessionStoreError("Session events hash does not match meta.json", {
      sessionPath,
      expected: meta.eventsHash,
      actual: eventsHash
    });
  }
  const events = await readSessionEvents(sessionPath, eventsJsonl);
  return {
    path: sessionPath,
    meta: { ...meta, eventsHash },
    events,
    vault: await loadVault(join(sessionPath, "vault.enc"))
  };
}

export async function listSessionPaths(store: string): Promise<string[]> {
  assertStorePath(store);
  let entries: Dirent[];
  try {
    entries = await readdir(store, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }
    if (isNodeError(error) && error.code === "ENOTDIR") {
      throw new SessionStoreError("AgentRewind store path is not a directory", {
        store,
        expected: "Pass the directory that contains session folders, for example .rewind."
      });
    }
    throw error;
  }

  const sessionPaths = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const path = join(store, entry.name);
        return (await looksLikeSession(path)) ? path : undefined;
      })
  );
  return sessionPaths.filter((path): path is string => path !== undefined).sort((a, b) => sessionBasename(a).localeCompare(sessionBasename(b)));
}

export async function resolveSessionPath(selector: string, opts: SessionSelectorOptions = {}): Promise<string> {
  const value = selector.trim();
  const store = opts.store ?? ".rewind";
  if (value.length === 0) {
    throw new SessionStoreError("AgentRewind session selector is required", {
      missing: "session",
      expected: "Pass a session path, a session id with `store`, or `latest` with `store`."
    });
  }

  if (value === "latest") {
    return latestSessionPath(store);
  }

  if (await looksLikeSession(value)) {
    return value;
  }

  if (await isDirectory(value)) {
    const sessions = await listSessionPaths(value);
    if (sessions.length === 1) {
      return sessions[0]!;
    }
    if (sessions.length > 1) {
      throw new SessionStoreError(`${value} is a session store containing ${sessions.length} sessions, not one session`, {
        store: value,
        availableSessions: sessionIds(sessions),
        expected: `Run agentrewind list ${value}, pass one session id with --store ${value}, or use latest --store ${value}.`
      });
    }
    if (await hasAnySessionFile(value)) {
      return value;
    }
    throw new SessionStoreError(`No AgentRewind sessions found in ${value}`, {
      store: value,
      expected: `Record a session first or pass a full session path such as ${join(value, "<session-id>")}.`
    });
  }

  if (isBareSessionId(value)) {
    const candidate = join(store, value);
    if (await looksLikeSession(candidate)) {
      return candidate;
    }
    const sessions = await listSessionPaths(store);
    if (sessions.length > 0) {
      throw new SessionStoreError(`No AgentRewind session "${value}" found in ${store}`, {
        store,
        sessionId: value,
        availableSessions: sessionIds(sessions),
        expected: `Run agentrewind list ${store} or pass a full session path.`
      });
    }
    throw new SessionStoreError(`No AgentRewind sessions found in ${store}`, {
      store,
      sessionId: value,
      expected: `Record one with AgentRewind.recordRun({ store: ${JSON.stringify(store)}, ... }, harness), or pass a full session path.`
    });
  }

  return value;
}

async function latestSessionPath(store: string): Promise<string> {
  const sessions = await listSessionPaths(store);
  if (sessions.length === 0) {
    throw new SessionStoreError(`No AgentRewind sessions found in ${store}`, {
      store,
      expected: `Record one with AgentRewind.recordRun({ store: ${JSON.stringify(store)}, ... }, harness), then run agentrewind list ${store}.`
    });
  }
  const rows = await Promise.all(
    sessions.map(async (path) => ({
      path,
      createdAt: parseMeta(path, await readSessionFile(path, "meta.json")).createdAt
    }))
  );
  return rows.sort((a, b) => b.createdAt - a.createdAt || sessionBasename(a.path).localeCompare(sessionBasename(b.path)))[0]!.path;
}

function assertStorePath(store: string): void {
  if (typeof store !== "string" || store.trim().length === 0) {
    throw new SessionStoreError("AgentRewind store path is required", {
      missing: "store",
      expected: "Pass the directory that contains session folders, for example .rewind."
    });
  }
}

function assertSessionPath(sessionPath: string): void {
  if (typeof sessionPath !== "string" || sessionPath.trim().length === 0) {
    throw new SessionStoreError("AgentRewind session path is required", {
      missing: "sessionPath",
      expected: "Pass the full session directory, for example .rewind/<session-id>."
    });
  }
}

async function readSessionFile(sessionPath: string, fileName: "meta.json" | "events.jsonl"): Promise<string> {
  try {
    return await readFile(join(sessionPath, fileName), "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new SessionStoreError(`No AgentRewind session found at ${sessionPath}`, {
        sessionPath,
        missingFile: fileName,
        expected: `Expected ${join(sessionPath, fileName)} to exist.`
      });
    }
    if (isNodeError(error) && error.code === "EISDIR") {
      throw new SessionStoreError(`AgentRewind session file is a directory: ${join(sessionPath, fileName)}`, {
        sessionPath,
        invalidFile: fileName
      });
    }
    throw error;
  }
}

async function looksLikeSession(sessionPath: string): Promise<boolean> {
  const [meta, events] = await Promise.all([isFile(join(sessionPath, "meta.json")), isFile(join(sessionPath, "events.jsonl"))]);
  return meta && events;
}

async function hasAnySessionFile(sessionPath: string): Promise<boolean> {
  const [meta, events] = await Promise.all([isFile(join(sessionPath, "meta.json")), isFile(join(sessionPath, "events.jsonl"))]);
  return meta || events;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if (isNodeError(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
      return false;
    }
    throw error;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (isNodeError(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
      return false;
    }
    throw error;
  }
}

function isBareSessionId(value: string): boolean {
  return !value.includes("/") && !value.includes("\\") && !value.startsWith(".");
}

function sessionIds(paths: string[]): string[] {
  return paths.map((path) => sessionBasename(path)).sort((a, b) => a.localeCompare(b));
}

function parseMeta(sessionPath: string, raw: string): SessionMeta {
  try {
    return JSON.parse(raw) as SessionMeta;
  } catch (error) {
    throw new SessionStoreError("Session meta.json is not valid JSON", {
      sessionPath,
      file: "meta.json",
      cause: error instanceof Error ? error.message : String(error)
    });
  }
}

async function readSessionEvents(sessionPath: string, eventsJsonl: string): Promise<RewindEvent[]> {
  const lines = eventsJsonl
    .split("\n")
    .map((line, index) => ({ line, index: index + 1 }))
    .filter(({ line }) => line.trim().length > 0);
  return Promise.all(
    lines.map(async ({ line, index }) => {
      try {
        return migrateEvent((await hydrateBlobs(JSON.parse(line), join(sessionPath, "blobs"))) as RewindEvent);
      } catch (error) {
        if (error instanceof RewindError) {
          throw error;
        }
        throw new SessionStoreError("Session events.jsonl contains an unreadable event", {
          sessionPath,
          file: "events.jsonl",
          line: index,
          cause: error instanceof Error ? error.message : String(error)
        });
      }
    })
  );
}

export async function packSession(session: string, outPath: string, opts: PackSessionOptions = {}): Promise<void> {
  const sessionPath = await resolveSessionPath(session, opts);
  const files = await listPackFiles(sessionPath);
  const tar = buildTar(
    await Promise.all(
      files.map(async (file) => ({
        name: relative(sessionPath, file).replaceAll("\\", "/"),
        data: await readFile(file)
      }))
    )
  );
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, await gzipAsync(tar));
}

export async function unpackSession(packPath: string, dir: string): Promise<void> {
  const archive = await gunzipAsync(await readFile(packPath));
  for (const entry of readTar(archive)) {
    const outPath = safeArchiveOutputPath(dir, entry.name);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, entry.data);
  }
}

export function assertJsonSerializable(value: unknown, label: string): void {
  validateJsonSerializable(value, label, new WeakSet<object>());
}

export function serializeError(error: unknown): { name: string; message: string; stack?: string; data?: unknown } {
  if (error instanceof Error) {
    const withData = error as Error & { data?: unknown };
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      ...(withData.data === undefined ? {} : { data: withData.data })
    };
  }
  return { name: "ThrownValue", message: String(error), data: error };
}

export function sessionPath(store: string, id: string): string {
  return safeSessionPath(store, id);
}

async function externalizeEvent(event: RewindEvent, blobsPath: string, threshold: number): Promise<RewindEvent> {
  const clone = JSON.parse(JSON.stringify(event)) as RewindEvent & { blobs?: Record<string, Hash> };
  const blobs = { ...(clone.blobs ?? {}) };
  await externalizeLargeFields(clone, blobs, blobsPath, threshold);
  if (Object.keys(blobs).length > 0) {
    clone.blobs = blobs;
  }
  return clone;
}

async function externalizeLargeFields(
  value: unknown,
  blobs: Record<string, Hash>,
  blobsPath: string,
  threshold: number,
  path: string[] = []
): Promise<void> {
  if (value === null || typeof value !== "object") {
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (path.length === 0 && key === "blobs") {
      continue;
    }
    if (child === undefined || isBlobRef(child)) {
      continue;
    }
    const childPath = [...path, key];
    const blobPath = childPath.join(".");
    const childBytes = Buffer.from(JSON.stringify(child), "utf8");
    if (childBytes.length <= threshold) {
      await externalizeLargeFields(child, blobs, blobsPath, threshold, childPath);
      continue;
    }
    const hash = sha256(childBytes);
    await writeFile(join(blobsPath, hash), childBytes);
    (value as Record<string, unknown>)[key] = { __agentrewind_blob: hash };
    blobs[blobPath] = hash;
  }
}

async function hydrateBlobs(value: unknown, blobsPath: string): Promise<unknown> {
  if (Array.isArray(value)) {
    return Promise.all(value.map((item) => hydrateBlobs(item, blobsPath)));
  }
  if (isBlobRef(value)) {
    const blobPath = blobPathForHash(blobsPath, value.__agentrewind_blob);
    try {
      const blob = await readFile(blobPath);
      const actual = sha256(blob);
      if (actual !== value.__agentrewind_blob) {
        throw new SessionStoreError("Session blob hash does not match its filename", {
          blob: value.__agentrewind_blob,
          path: blobPath,
          actual
        });
      }
      return JSON.parse(blob.toString("utf8"));
    } catch (error) {
      if (error instanceof SessionStoreError) {
        throw error;
      }
      throw new SessionStoreError("Session references a missing or unreadable blob", {
        blob: value.__agentrewind_blob,
        path: blobPath,
        cause: error instanceof Error ? error.message : String(error)
      });
    }
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = await hydrateBlobs(child, blobsPath);
    }
    return out;
  }
  return value;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isBlobRef(value: unknown): value is BlobRef {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as Record<string, unknown>).__agentrewind_blob === "string"
  );
}

function safeSessionPath(store: string, id: string): string {
  assertStorePath(store);
  assertSessionId(id);
  return join(store, id);
}

function assertSessionId(id: string): void {
  if (typeof id !== "string" || id.trim().length === 0 || !isBareSessionId(id)) {
    throw new SessionStoreError("AgentRewind session id must be a single path segment", {
      sessionId: id,
      expected: "Use an id without slashes, backslashes, leading dots, or path traversal segments."
    });
  }
}

function safeArchiveOutputPath(root: string, entryName: string): string {
  assertSafeArchiveEntryName(entryName);
  const rootPath = resolve(root);
  const outPath = resolve(rootPath, entryName);
  if (outPath !== rootPath && !outPath.startsWith(`${rootPath}${sep}`)) {
    throw new SessionStoreError("Packed session contains a path outside the unpack directory", {
      entry: entryName,
      output: outPath,
      root: rootPath
    });
  }
  return outPath;
}

function assertSafeArchiveEntryName(entryName: string): void {
  const parts = entryName.split("/");
  if (
    entryName.length === 0 ||
    entryName.includes("\\") ||
    entryName.includes("\0") ||
    entryName.startsWith("/") ||
    /^[A-Za-z]:/.test(entryName) ||
    parts.some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    throw new SessionStoreError("Packed session contains an unsafe path", {
      entry: entryName,
      expected: "Archive entries must be relative file paths without empty, dot, or traversal segments."
    });
  }
}

function blobPathForHash(blobsPath: string, hash: Hash): string {
  if (!SHA256_HEX.test(hash)) {
    throw new SessionStoreError("Session references an invalid blob id", {
      blob: hash,
      expected: "Blob ids must be lowercase SHA-256 hex strings."
    });
  }
  return join(blobsPath, hash);
}

async function listPackFiles(sessionPathValue: string): Promise<string[]> {
  const out: string[] = [];
  async function visit(path: string): Promise<void> {
    const info = await stat(path);
    if (info.isDirectory()) {
      for (const child of await readdir(path)) {
        if (child === "vault.enc" || child === "vault.enc.key") {
          continue;
        }
        await visit(join(path, child));
      }
      return;
    }
    out.push(path);
  }
  await visit(sessionPathValue);
  return out.sort();
}

function sha256(value: Buffer): Hash {
  return createHash("sha256").update(value).digest("hex");
}

function validateJsonSerializable(value: unknown, label: string, seen: WeakSet<object>): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new SerializationError("Non-finite numbers are not JSON-serializable", { label });
    }
    return;
  }
  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
    throw new SerializationError("Value is not JSON-serializable", { label, type: typeof value });
  }
  if (typeof value !== "object") {
    return;
  }
  if (seen.has(value)) {
    throw new SerializationError("Circular values are not JSON-serializable", { label });
  }
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      validateJsonSerializable(item, label, seen);
    }
    seen.delete(value);
    return;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new SerializationError("Only plain objects are JSON-serializable", {
      label,
      prototype: Object.getPrototypeOf(value)?.constructor?.name
    });
  }
  for (const [key, child] of Object.entries(value)) {
    validateJsonSerializable(child, `${label}.${key}`, seen);
  }
  seen.delete(value);
}

interface TarEntry {
  name: string;
  data: Buffer;
}

function buildTar(entries: TarEntry[]): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    chunks.push(tarHeader(entry.name, entry.data.length));
    chunks.push(entry.data);
    const padding = (512 - (entry.data.length % 512)) % 512;
    if (padding > 0) {
      chunks.push(Buffer.alloc(padding));
    }
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

function readTar(buffer: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      break;
    }
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const sizeText = header.subarray(124, 136).toString("utf8").replace(/\0.*$/, "").trim();
    const size = Number.parseInt(sizeText || "0", 8);
    const dataStart = offset + 512;
    entries.push({ name, data: buffer.subarray(dataStart, dataStart + size) });
    offset = dataStart + size + ((512 - (size % 512)) % 512);
  }
  return entries;
}

function tarHeader(name: string, size: number): Buffer {
  if (Buffer.byteLength(name) > 100) {
    throw new SerializationError("Packed session path is too long for MVP tar writer", { name });
  }
  const header = Buffer.alloc(512);
  header.write(name, 0, "utf8");
  header.write(octal(0o644, 7), 100, "ascii");
  header.write(octal(0, 7), 108, "ascii");
  header.write(octal(0, 7), 116, "ascii");
  header.write(octal(size, 11), 124, "ascii");
  header.write(octal(0, 11), 136, "ascii");
  header.fill(" ", 148, 156);
  header.write("0", 156, "ascii");
  header.write("ustar", 257, "ascii");
  header.write("00", 263, "ascii");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(octal(checksum, 6), 148, "ascii");
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function octal(value: number, width: number): string {
  return value.toString(8).padStart(width, "0");
}

export function sessionBasename(path: string): string {
  return basename(path);
}

function gzipAsync(input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    gzip(input, (error, result) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(result);
    });
  });
}

function gunzipAsync(input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    gunzip(input, (error, result) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(result);
    });
  });
}
