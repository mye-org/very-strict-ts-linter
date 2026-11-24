import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import type { ESLint } from "eslint";

const CACHE_SCHEMA_VERSION = 1;

const WORKSPACE_CONFIG_NAMES = [
  "package.json",
  "tsconfig.json",
  "tsconfig.build.json",
  "eslint.config.ts",
  "eslint.config.mts",
  "eslint.config.cts",
  "eslint.config.js",
  "eslint.config.mjs",
  "eslint.config.cjs",
] as const;

const LOCKFILE_NAMES = ["pnpm-lock.yaml", "package-lock.json", "yarn.lock"] as const;

const IGNORED_SCAN_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "coverage",
  ".cache",
  ".turbo",
  ".next",
]);

const TRACKED_SOURCE_EXTS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"]);

export type ProjectFingerprintInput = {
  readonly cwd: string;
  readonly kind: "lint" | "radar";
  readonly tsconfigPath?: string;
  readonly targets?: ReadonlyArray<string>;
  readonly scopeKey: string;
};

type CacheEnvelope<T> = {
  readonly version: number;
  readonly fingerprint: string;
  readonly createdAt: string;
  readonly value: T;
};

export const isRecord = ((value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)) satisfies (
  value: unknown,
) => value is Readonly<Record<string, unknown>>;

export const hashShort = ((value: string) =>
  crypto.createHash("sha256").update(value).digest("hex").slice(0, 16)) satisfies (
  value: string,
) => string;

const safeRealpath = (targetPath: string) => {
  try {
    return fs.realpathSync(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
};

const isNonEmptyString = (value: string | undefined): value is string =>
  value !== undefined && value.trim().length > 0;

export const resolveCacheDir = ((cwd: string, customLocation?: string) => {
  if (isNonEmptyString(customLocation)) {
    return path.resolve(cwd, customLocation);
  }
  const nodeModulesDir = path.join(cwd, "node_modules");
  if (fs.existsSync(nodeModulesDir)) {
    return path.join(nodeModulesDir, ".cache", "strict-fp");
  }
  return path.join(os.tmpdir(), "strict-fp-cache", hashShort(safeRealpath(cwd)));
}) satisfies (cwd: string, customLocation?: string) => string;

export const buildEslintCacheOptions = ((
  enabled: boolean | undefined,
  cacheDir: string | undefined,
) =>
  enabled === true && isNonEmptyString(cacheDir)
    ? {
        cache: true,
        cacheStrategy: "content",
        cacheLocation: path.join(cacheDir, "eslint-cache.json"),
      }
    : {}) satisfies (enabled: boolean | undefined, cacheDir: string | undefined) => ESLint.Options;

export const resolveTsConfigPath = ((
  workspaceDir: string,
  configPath?: string,
) => {
  if (isNonEmptyString(configPath)) {
    return path.resolve(workspaceDir, configPath);
  }
  return ts.findConfigFile(workspaceDir, (filePath) => ts.sys.fileExists(filePath), "tsconfig.json");
}) satisfies (workspaceDir: string, configPath?: string) => string | undefined;

export const loadParsedTsConfig = ((tsconfigPath: string) => {
  const configFile = ts.readConfigFile(tsconfigPath, (filePath) => ts.sys.readFile(filePath));
  if (configFile.error) {
    return undefined;
  }
  return ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    path.dirname(tsconfigPath),
    undefined,
    tsconfigPath,
  );
}) satisfies (tsconfigPath: string) => ts.ParsedCommandLine | undefined;

export const resolveTsBuildInfoPath = ((
  cacheDir: string,
  kind: "tsc" | "radar",
  tsconfigPath: string,
) => {
  fs.mkdirSync(cacheDir, { recursive: true });
  return path.join(cacheDir, `${kind}-${hashShort(safeRealpath(tsconfigPath))}.tsbuildinfo`);
}) satisfies (cacheDir: string, kind: "tsc" | "radar", tsconfigPath: string) => string;

const hashFileIfExists = (hash: crypto.Hash, label: string, filePath: string) => {
  try {
    const content = fs.readFileSync(filePath);
    hash.update(label);
    hash.update("\0");
    hash.update(content);
    hash.update("\0");
  } catch {
    hash.update(label);
    hash.update("\0MISSING\0");
  }
};

const hashFileStatIfExists = (hash: crypto.Hash, label: string, filePath: string) => {
  try {
    const stat = fs.statSync(filePath);
    hash.update(`${label}\0${String(stat.size)}:${String(stat.mtimeMs)}\0`);
  } catch {
    hash.update(`${label}\0MISSING\0`);
  }
};

const hashSelfBuildSignature = (hash: crypto.Hash) => {
  const currentFile = fileURLToPath(import.meta.url);
  const cliDir = path.dirname(currentFile);
  const rootDir = path.dirname(cliDir);
  const trackedSelfFiles = [
    path.join(rootDir, "index.js"),
    path.join(cliDir, "strict-fp-lint.js"),
    path.join(cliDir, "discovery-radar.js"),
    path.join(cliDir, "incremental-cache.js"),
    path.join(cliDir, "strict-fp-daemon.js"),
  ];
  for (const filePath of trackedSelfFiles) {
    hashFileStatIfExists(hash, `self:${path.basename(filePath)}`, filePath);
  }
};

const hashTsConfigChain = (hash: crypto.Hash, entryTsconfigPath: string) => {
  const visited = new Set<string>();
  let queue: ReadonlyArray<string> = [path.resolve(entryTsconfigPath)];
  while (queue.length > 0) {
    const [resolved, ...rest] = queue;
    queue = rest;
    if (!resolved || visited.has(resolved)) {
      continue;
    }
    visited.add(resolved);
    hashFileIfExists(hash, `tsconfig:${resolved}`, resolved);
    const configFile = ts.readConfigFile(resolved, (filePath) => ts.sys.readFile(filePath));
    if (configFile.error || !isRecord(configFile.config)) {
      continue;
    }
    const rawExtends = configFile.config["extends"];
    const extendsList =
      typeof rawExtends === "string"
        ? [rawExtends]
        : Array.isArray(rawExtends)
          ? rawExtends.filter((entry): entry is string => typeof entry === "string")
          : [];
    for (const ext of extendsList) {
      if (ext.startsWith(".")) {
        const candidate = path.resolve(path.dirname(resolved), ext);
        const extPath = fs.existsSync(candidate) ? candidate : `${candidate}.json`;
        queue = [...queue, extPath];
      }
    }
  }
};

export const computeConfigFingerprint = ((
  cwd: string,
  tsconfigPath: string | undefined,
) => {
  const hash = crypto.createHash("sha256");
  hash.update(`schema:${String(CACHE_SCHEMA_VERSION)}\0`);
  hash.update(`ts:${ts.version}\0`);
  hash.update(`node:${process.version}\0`);
  hashSelfBuildSignature(hash);

  for (const name of WORKSPACE_CONFIG_NAMES) {
    hashFileIfExists(hash, `cfg:${name}`, path.join(cwd, name));
  }
  for (const lockName of LOCKFILE_NAMES) {
    hashFileStatIfExists(hash, `lock:${lockName}`, path.join(cwd, lockName));
  }
  if (tsconfigPath) {
    hashTsConfigChain(hash, tsconfigPath);
  }

  return hash.digest("hex");
}) satisfies (cwd: string, tsconfigPath: string | undefined) => string;

const collectDirectorySourceFiles = (entryDirPath: string) => {
  const collected = new Set<string>();
  let queue: ReadonlyArray<string> = [entryDirPath];
  while (queue.length > 0) {
    const [dirPath, ...rest] = queue;
    queue = rest;
    if (!dirPath) {
      continue;
    }
    let entries: ReadonlyArray<fs.Dirent>;
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!IGNORED_SCAN_DIRS.has(entry.name)) {
          queue = [...queue, path.join(dirPath, entry.name)];
        }
        continue;
      }
      if (!entry.isFile() || entry.name.endsWith(".tsbuildinfo")) {
        continue;
      }
      if (TRACKED_SOURCE_EXTS.has(path.extname(entry.name))) {
        collected.add(path.resolve(dirPath, entry.name));
      }
    }
  }
  return [...collected];
};

const collectTargetSourceFiles = (
  baseDir: string,
  targetPaths: ReadonlyArray<string>,
) => {
  const collected = new Set<string>();
  for (const target of targetPaths) {
    const resolved = path.resolve(baseDir, target);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(resolved);
    } catch {
      continue;
    }
    if (stat.isFile()) {
      collected.add(resolved);
    } else if (stat.isDirectory()) {
      for (const filePath of collectDirectorySourceFiles(resolved)) {
        collected.add(filePath);
      }
    }
  }
  return [...collected];
};

export const computeProjectFingerprint = ((input: ProjectFingerprintInput) => {
  const hash = crypto.createHash("sha256");
  hash.update(`kind:${input.kind}\0`);
  hash.update(`scope:${input.scopeKey}\0`);
  hash.update(`cfg:${computeConfigFingerprint(input.cwd, input.tsconfigPath)}\0`);

  const trackedFiles = new Set<string>();
  if (input.tsconfigPath && fs.existsSync(input.tsconfigPath)) {
    const parsed = loadParsedTsConfig(input.tsconfigPath);
    if (parsed) {
      for (const fileName of parsed.fileNames) {
        trackedFiles.add(path.resolve(fileName));
      }
    }
  }
  if (input.targets && input.targets.length > 0) {
    for (const filePath of collectTargetSourceFiles(input.cwd, input.targets)) {
      trackedFiles.add(filePath);
    }
  }

  const sortedFiles = Array.from(trackedFiles).sort();
  hash.update(`count:${String(sortedFiles.length)}\0`);
  for (const filePath of sortedFiles) {
    const rel = path.relative(input.cwd, filePath);
    hashFileIfExists(hash, `src:${rel}`, filePath);
  }

  return hash.digest("hex");
}) satisfies (input: ProjectFingerprintInput) => string;

const resolveArtifactPath = (dir: string, scope: string, key: string) =>
  path.join(dir, `${scope}-${hashShort(key)}.json`);

export const readCachedArtifact = (<T>(
  cacheDir: string,
  namespace: string,
  cacheKey: string,
  fingerprint: string,
  isValue: (value: unknown) => value is T,
) => {
  const filePath = resolveArtifactPath(cacheDir, namespace, cacheKey);
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (
      !isRecord(parsed) ||
      parsed["version"] !== CACHE_SCHEMA_VERSION ||
      parsed["fingerprint"] !== fingerprint ||
      !isValue(parsed["value"])
    ) {
      return undefined;
    }
    return parsed["value"];
  } catch {
    return undefined;
  }
}) satisfies <T>(
  cacheDir: string,
  namespace: string,
  cacheKey: string,
  fingerprint: string,
  isValue: (value: unknown) => value is T,
) => T | undefined;

export const writeCachedArtifact = (<T>(
  cacheDir: string,
  namespace: string,
  cacheKey: string,
  fingerprint: string,
  value: T,
) => {
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    const filePath = resolveArtifactPath(cacheDir, namespace, cacheKey);
    const tmpPath = `${filePath}.${String(process.pid)}.${String(Date.now())}.tmp`;
    const envelope: CacheEnvelope<T> = {
      version: CACHE_SCHEMA_VERSION,
      fingerprint,
      createdAt: new Date().toISOString(),
      value,
    };
    fs.writeFileSync(tmpPath, JSON.stringify(envelope), "utf8");
    fs.renameSync(tmpPath, filePath);
  } catch {
    // Cache writes are best-effort and must never fail linting or radar runs.
  }
}) satisfies <T>(
  cacheDir: string,
  namespace: string,
  cacheKey: string,
  fingerprint: string,
  value: T,
) => void;
