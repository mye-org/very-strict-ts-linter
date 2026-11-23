import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";

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

export const hashShort = (value: string) =>
  crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);

const safeRealpath = (targetPath: string) => {
  try {
    return fs.realpathSync(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
};

export const resolveCacheDir = (cwd: string, customLocation?: string) => {
  if (customLocation && customLocation.trim().length > 0) {
    return path.resolve(cwd, customLocation);
  }
  const nodeModulesDir = path.join(cwd, "node_modules");
  if (fs.existsSync(nodeModulesDir)) {
    return path.join(nodeModulesDir, ".cache", "strict-fp");
  }
  return path.join(os.tmpdir(), "strict-fp-cache", hashShort(safeRealpath(cwd)));
};

export const resolveTsConfigPath = (cwd: string, tsconfig?: string) => {
  if (tsconfig && tsconfig.trim().length > 0) {
    return path.resolve(cwd, tsconfig);
  }
  return ts.findConfigFile(cwd, (filePath) => ts.sys.fileExists(filePath), "tsconfig.json");
};

export const loadParsedTsConfig = (tsconfigPath: string) => {
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
};

export const resolveTsBuildInfoPath = (
  cacheDir: string,
  kind: "tsc" | "radar",
  tsconfigPath: string,
) => {
  fs.mkdirSync(cacheDir, { recursive: true });
  return path.join(cacheDir, `${kind}-${hashShort(safeRealpath(tsconfigPath))}.tsbuildinfo`);
};

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

const hashTsConfigChain = (hash: crypto.Hash, tsconfigPath: string, visited: Set<string>) => {
  const resolved = path.resolve(tsconfigPath);
  if (visited.has(resolved)) {
    return;
  }
  visited.add(resolved);
  hashFileIfExists(hash, `tsconfig:${resolved}`, resolved);
  const configFile = ts.readConfigFile(resolved, (filePath) => ts.sys.readFile(filePath));
  if (configFile.error) {
    return;
  }
  const configObj = configFile.config as Readonly<Record<string, unknown>>;
  const rawExtends = configObj["extends"];
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
      hashTsConfigChain(hash, extPath, visited);
    }
  }
};

export const computeConfigFingerprint = (cwd: string, tsconfigPath: string | undefined) => {
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
    hashTsConfigChain(hash, tsconfigPath, new Set());
  }

  return hash.digest("hex");
};

const collectDirectorySourceFiles = (dirPath: string, out: Set<string>) => {
  let entries: ReadonlyArray<fs.Dirent>;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!IGNORED_SCAN_DIRS.has(entry.name)) {
        collectDirectorySourceFiles(path.join(dirPath, entry.name), out);
      }
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    if (entry.name.endsWith(".tsbuildinfo")) {
      continue;
    }
    if (TRACKED_SOURCE_EXTS.has(path.extname(entry.name))) {
      out.add(path.resolve(dirPath, entry.name));
    }
  }
};

const collectTargetSourceFiles = (
  cwd: string,
  targets: ReadonlyArray<string>,
  out: Set<string>,
) => {
  for (const target of targets) {
    const resolved = path.resolve(cwd, target);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(resolved);
    } catch {
      continue;
    }
    if (stat.isFile()) {
      out.add(resolved);
    } else if (stat.isDirectory()) {
      collectDirectorySourceFiles(resolved, out);
    }
  }
};

export const computeProjectFingerprint = (input: ProjectFingerprintInput) => {
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
    collectTargetSourceFiles(input.cwd, input.targets, trackedFiles);
  }

  const sortedFiles = Array.from(trackedFiles).sort();
  hash.update(`count:${String(sortedFiles.length)}\0`);
  for (const filePath of sortedFiles) {
    const rel = path.relative(input.cwd, filePath);
    hashFileIfExists(hash, `src:${rel}`, filePath);
  }

  return hash.digest("hex");
};

const resolveArtifactPath = (cacheDir: string, namespace: string, cacheKey: string) =>
  path.join(cacheDir, `${namespace}-${hashShort(cacheKey)}.json`);

export const readCachedArtifact = <T>(
  cacheDir: string,
  namespace: string,
  cacheKey: string,
  fingerprint: string,
): T | undefined => {
  const filePath = resolveArtifactPath(cacheDir, namespace, cacheKey);
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as CacheEnvelope<T>;
    if (parsed.version !== CACHE_SCHEMA_VERSION || parsed.fingerprint !== fingerprint) {
      return undefined;
    }
    return parsed.value;
  } catch {
    return undefined;
  }
};

export const writeCachedArtifact = <T>(
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
};
