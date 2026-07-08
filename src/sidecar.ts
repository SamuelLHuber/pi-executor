import { execFile, spawn, type ChildProcess } from "node:child_process";
import { constants as fsConstants, createWriteStream, existsSync } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { getHealth } from "./http.ts";

export const DEFAULT_PORT_SEED = 4788;
export const PORT_SCAN_LIMIT = 32;
export const HEALTH_TIMEOUT_MS = 2_000;
export const STARTUP_TIMEOUT_MS = 30_000;
export const SHUTDOWN_TIMEOUT_MS = 2_000;
export const LOG_RING_BUFFER_LINES = 200;
export const SIDECAR_REGISTRY_VERSION = 1;

export type PackagePaths = {
  packageJsonPath: string;
  packageRoot: string;
  wrapperPath: string;
  installerPath: string;
  runtimePath: string;
};

export type SidecarRecord = {
  cwd: string;
  registryKey: string;
  port: number;
  baseUrl: string;
  pid?: number;
  ownedByPi: boolean;
  child?: ChildProcess;
  stdoutTail: string[];
  stderrTail: string[];
};

export type RegisteredSidecar = {
  cwd: string;
  pid: number;
  port: number;
  baseUrl: string;
  startedAt: string;
};

export type PortProbe = { port: number; kind: "free" } | { port: number; kind: "occupied" };

export class SidecarError extends Error {
  readonly code:
    | "PACKAGE_RESOLUTION_FAILED"
    | "UNSUPPORTED_PLATFORM"
    | "BOOTSTRAP_FAILED"
    | "RUNTIME_MISSING"
    | "STARTUP_TIMEOUT"
    | "PORT_EXHAUSTED"
    | "LAUNCHER_FAILED";
  readonly details?: Record<string, string | number | boolean>;

  constructor(
    code: SidecarError["code"],
    message: string,
    details?: Record<string, string | number | boolean>,
  ) {
    super(message);
    this.name = "SidecarError";
    this.code = code;
    this.details = details;
  }
}

type SidecarRegistryFile = {
  version: number;
  sidecars: Record<string, RegisteredSidecar>;
};

const require = createRequire(import.meta.url);
const sidecarsByKey = new Map<string, SidecarRecord>();

const normalizeDir = (cwd: string): string => resolve(cwd);

const buildBaseUrl = (port: number): string => `http://127.0.0.1:${port}`;

const emptySidecarRegistry = (): SidecarRegistryFile => ({
  version: SIDECAR_REGISTRY_VERSION,
  sidecars: {},
});

export const getExecutorDataDir = (cwd: string, dataDir?: string): string => {
  if (dataDir) {
    return resolve(dataDir.replace(/^~($|\/)\//, homedir() + "$1"));
  }
  return join(normalizeDir(cwd), ".executor");
};

const computeRegistryKey = (cwd: string, dataDir?: string): string => {
  if (dataDir) {
    return resolve(dataDir.replace(/^~($|\/)\//, homedir() + "$1"));
  }
  return normalizeDir(cwd);
};

export const readAuthToken = async (dataDir: string): Promise<string | undefined> => {
  try {
    const raw = await readFile(join(dataDir, "server-control", "auth.json"), "utf8");
    const parsed = JSON.parse(raw) as { token?: string };
    return typeof parsed.token === "string" && parsed.token.length > 0 ? parsed.token : undefined;
  } catch {
    return undefined;
  }
};

export const getSidecarRegistryPath = (): string =>
  join(process.env.HOME || homedir(), ".pi", "agent", "executor-sidecars.json");

const readSidecarRegistry = async (): Promise<SidecarRegistryFile> => {
  try {
    const raw = await readFile(getSidecarRegistryPath(), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return emptySidecarRegistry();
    }

    const sidecarsValue = "sidecars" in parsed ? parsed.sidecars : undefined;
    const sidecars =
      typeof sidecarsValue === "object" && sidecarsValue !== null && !Array.isArray(sidecarsValue)
        ? (sidecarsValue as Record<string, RegisteredSidecar>)
        : {};

    return {
      version:
        "version" in parsed && typeof parsed.version === "number"
          ? parsed.version
          : SIDECAR_REGISTRY_VERSION,
      sidecars,
    };
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    if (code === "ENOENT") {
      return emptySidecarRegistry();
    }
    throw error;
  }
};

const writeSidecarRegistry = async (registry: SidecarRegistryFile): Promise<void> => {
  const path = getSidecarRegistryPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(registry, null, 2) + "\n", "utf8");
};

export const getRegisteredSidecar = async (
  cwdInput: string,
  registryKey?: string,
): Promise<RegisteredSidecar | undefined> => {
  const key = registryKey ?? normalizeDir(cwdInput);
  const registry = await readSidecarRegistry();
  return registry.sidecars[key];
};

export const registerSidecarForCwd = async (
  record: RegisteredSidecar,
  registryKey?: string,
): Promise<void> => {
  const key = registryKey ?? normalizeDir(record.cwd);
  const registry = await readSidecarRegistry();
  registry.sidecars[key] = {
    ...record,
    cwd: record.cwd,
  };
  await writeSidecarRegistry(registry);
};

export const unregisterSidecarForCwd = async (
  cwdInput: string,
  pid?: number,
  registryKey?: string,
): Promise<void> => {
  const key = registryKey ?? normalizeDir(cwdInput);
  const registry = await readSidecarRegistry();
  const registered = registry.sidecars[key];
  if (!registered) {
    return;
  }
  if (pid !== undefined && registered.pid !== pid) {
    return;
  }
  delete registry.sidecars[key];
  await writeSidecarRegistry(registry);
};

const registerRuntimeSidecar = async (record: SidecarRecord): Promise<void> => {
  if (!record.pid) {
    return;
  }

  await registerSidecarForCwd(
    {
      cwd: record.cwd,
      pid: record.pid,
      port: record.port,
      baseUrl: record.baseUrl,
      startedAt: new Date().toISOString(),
    },
    record.registryKey,
  );
};

export const isSupportedRuntimePlatform = (platform: NodeJS.Platform, arch: string): boolean => {
  const supportedPlatform = platform === "darwin" || platform === "linux" || platform === "win32";
  const supportedArch = arch === "x64" || arch === "arm64";
  return supportedPlatform && supportedArch;
};

export const getRuntimeBinaryFileName = (platform: NodeJS.Platform): string =>
  platform === "win32" ? "executor.exe" : "executor";

export const shouldBootstrapRuntime = async (runtimePath: string): Promise<boolean> => {
  try {
    await access(runtimePath, fsConstants.X_OK);
    return false;
  } catch {
    return true;
  }
};

export const createPackagePaths = (
  packageJsonPath: string,
  platform: NodeJS.Platform = process.platform,
): PackagePaths => {
  const packageRoot = dirname(packageJsonPath);
  return {
    packageJsonPath,
    packageRoot,
    wrapperPath: join(packageRoot, "bin", "executor"),
    installerPath: join(packageRoot, "postinstall.cjs"),
    runtimePath: join(packageRoot, "bin", "runtime", getRuntimeBinaryFileName(platform)),
  };
};

const isMusl = (): boolean => {
  if (process.platform !== "linux") return false;
  try {
    if (existsSync("/etc/alpine-release")) return true;
    const { spawnSync } = require("node:child_process");
    const r = spawnSync("ldd", ["--version"], { encoding: "utf8" });
    if (((r.stdout || "") + (r.stderr || "")).toLowerCase().includes("musl")) return true;
  } catch {}
  return false;
};

const platformPackageName = (): string => {
  const platformMap: Record<string, string> = {
    darwin: "darwin",
    linux: "linux",
    win32: "windows",
  };
  const archMap: Record<string, string> = { x64: "x64", arm64: "arm64" };
  const platform = platformMap[process.platform] || process.platform;
  const arch = archMap[process.arch] || process.arch;
  const base = `executor-${platform}-${arch}`;
  if (platform === "linux") {
    return isMusl() ? `${base}-musl` : base;
  }
  return base;
};

export const resolveExecutorPackagePaths = (): PackagePaths => {
  try {
    const packageJsonPath = require.resolve("executor/package.json");

    try {
      const platformPkg = platformPackageName();
      const runtimePackageJson = require.resolve(`${platformPkg}/package.json`);
      const platformPkgRoot = dirname(runtimePackageJson);
      const binaryName = getRuntimeBinaryFileName(process.platform);
      const runtimePath = join(platformPkgRoot, "bin", binaryName);
      const installerPath = join(platformPkgRoot, "postinstall.cjs");

      return {
        packageJsonPath,
        packageRoot: platformPkgRoot,
        wrapperPath: join(dirname(packageJsonPath), "bin", "executor"),
        installerPath,
        runtimePath,
      };
    } catch {
      // Fall back to the main executor package root and old bin/runtime path
    }

    return createPackagePaths(packageJsonPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new SidecarError(
      "PACKAGE_RESOLUTION_FAILED",
      `Unable to resolve executor/package.json: ${message}`,
    );
  }
};

const joinTail = (lines: string[]): string => lines.join("\n").trim();

const pushLogChunk = (tail: string[], chunk: string): void => {
  for (const line of chunk.split(/\r?\n/)) {
    const trimmed = line.trimEnd();
    if (trimmed.length === 0) {
      continue;
    }
    tail.push(trimmed);
    if (tail.length > LOG_RING_BUFFER_LINES) {
      tail.splice(0, tail.length - LOG_RING_BUFFER_LINES);
    }
  }
};

const runInstaller = async (
  paths: PackagePaths,
): Promise<{ stdoutTail: string[]; stderrTail: string[] }> => {
  if (!existsSync(paths.installerPath)) {
    return { stdoutTail: [], stderrTail: [] };
  }

  const stdoutTail: string[] = [];
  const stderrTail: string[] = [];

  const child = spawn(process.execPath, [paths.installerPath], {
    cwd: paths.packageRoot,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => pushLogChunk(stdoutTail, chunk));
  child.stderr.on("data", (chunk: string) => pushLogChunk(stderrTail, chunk));

  const exitCode = await new Promise<number>((resolveExitCode, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolveExitCode(code ?? -1));
  });

  if (exitCode !== 0) {
    throw new SidecarError("BOOTSTRAP_FAILED", "Executor runtime bootstrap failed", {
      exitCode,
      stdoutTail: joinTail(stdoutTail),
      stderrTail: joinTail(stderrTail),
    });
  }

  return { stdoutTail, stderrTail };
};

export const resolveRuntimeBinary = async (): Promise<string> => {
  if (!isSupportedRuntimePlatform(process.platform, process.arch)) {
    throw new SidecarError(
      "UNSUPPORTED_PLATFORM",
      `Unsupported platform ${process.platform}/${process.arch} for executor runtime`,
      { platform: process.platform, arch: process.arch },
    );
  }

  const paths = resolveExecutorPackagePaths();
  if (await shouldBootstrapRuntime(paths.runtimePath)) {
    await runInstaller(paths);
  }

  if (await shouldBootstrapRuntime(paths.runtimePath)) {
    throw new SidecarError(
      "RUNTIME_MISSING",
      `Executor runtime is still missing after bootstrap at ${paths.runtimePath}`,
      { runtimePath: paths.runtimePath },
    );
  }

  return paths.runtimePath;
};

const isPortFree = async (port: number): Promise<boolean> => {
  const server = createServer();
  try {
    await new Promise<void>((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => resolveListen());
    });
    return true;
  } catch {
    return false;
  } finally {
    await new Promise<void>((resolveClose) => {
      server.close(() => resolveClose());
    });
  }
};

export const isPidRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error) {
      return error.code !== "ESRCH";
    }
    return false;
  }
};

const waitForPidExit = async (pid: number, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (!isPidRunning(pid)) {
      return true;
    }
    await delay(50);
  }
  return !isPidRunning(pid);
};

const terminatePid = async (pid: number): Promise<void> => {
  if (!isPidRunning(pid)) {
    return;
  }

  process.kill(pid, "SIGTERM");
  if (await waitForPidExit(pid, SHUTDOWN_TIMEOUT_MS)) {
    return;
  }

  process.kill(pid, "SIGKILL");
  await waitForPidExit(pid, SHUTDOWN_TIMEOUT_MS);
};

const execFileText = async (command: string, args: string[]): Promise<string> => {
  const result = await new Promise<{ stdout: string; stderr: string }>((resolveExec, reject) => {
    execFile(command, args, { encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolveExec({ stdout, stderr });
    });
  });

  return [result.stdout, result.stderr].filter((part) => part.trim().length > 0).join("\n");
};

const findPidByPort = async (port: number): Promise<number | undefined> => {
  try {
    if (process.platform === "win32") {
      const output = await execFileText("netstat", ["-ano", "-p", "tcp"]);
      for (const line of output.split(/\r?\n/)) {
        if (!line.includes(`127.0.0.1:${port}`) && !line.includes(`0.0.0.0:${port}`)) {
          continue;
        }
        if (!line.toUpperCase().includes("LISTENING")) {
          continue;
        }
        const parts = line.trim().split(/\s+/);
        const pid = Number(parts.at(-1));
        if (Number.isInteger(pid) && pid > 0) {
          return pid;
        }
      }
      return undefined;
    }

    const output = await execFileText("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]);
    for (const line of output.split(/\r?\n/)) {
      const pid = Number(line.trim());
      if (Number.isInteger(pid) && pid > 0) {
        return pid;
      }
    }
  } catch {
    return undefined;
  }

  return undefined;
};

const isHealthyRecord = async (record: SidecarRecord): Promise<boolean> => {
  try {
    return await getHealth(record.baseUrl, HEALTH_TIMEOUT_MS);
  } catch {
    return false;
  }
};

export const analyzePortProbe = (port: number, free = false): PortProbe => {
  if (free) {
    return { port, kind: "free" };
  }
  return { port, kind: "occupied" };
};

export const selectPortCandidate = (probes: PortProbe[]): { freePort?: number } => {
  const freeProbe = probes.find((probe) => probe.kind === "free");
  return freeProbe ? { freePort: freeProbe.port } : {};
};

export const collectOwnedSidecars = (records: Iterable<SidecarRecord>): SidecarRecord[] =>
  Array.from(records).filter((record) => record.ownedByPi && record.child !== undefined);

const hydrateRegisteredPid = async (record: SidecarRecord): Promise<SidecarRecord> => {
  const registered = await getRegisteredSidecar(record.cwd, record.registryKey);
  if (registered && registered.port === record.port && registered.baseUrl === record.baseUrl) {
    if (!isPidRunning(registered.pid)) {
      await unregisterSidecarForCwd(record.cwd, registered.pid, record.registryKey);
    } else {
      record.pid = registered.pid;
      return record;
    }
  }

  const pid = await findPidByPort(record.port);
  if (pid !== undefined) {
    record.pid = pid;
    await registerSidecarForCwd(
      {
        cwd: record.cwd,
        pid,
        port: record.port,
        baseUrl: record.baseUrl,
        startedAt: new Date().toISOString(),
      },
      record.registryKey,
    );
  }

  return record;
};

const probePort = async (_cwd: string, port: number): Promise<PortProbe> => {
  const baseUrl = buildBaseUrl(port);
  try {
    const alive = await getHealth(baseUrl, HEALTH_TIMEOUT_MS);
    if (alive) {
      return analyzePortProbe(port, false);
    }
  } catch {
    // not an executor we can talk to
  }

  const free = await isPortFree(port);
  return analyzePortProbe(port, free);
};

const scanPorts = async (cwd: string): Promise<{ freePort?: number }> => {
  const probes: PortProbe[] = [];
  for (let offset = 0; offset < PORT_SCAN_LIMIT; offset += 1) {
    const port = DEFAULT_PORT_SEED + offset;
    probes.push(await probePort(cwd, port));
  }

  return selectPortCandidate(probes);
};

const attachExitCleanup = (record: SidecarRecord): void => {
  const child = record.child;
  if (!child) {
    return;
  }

  const clear = (): void => {
    const current = sidecarsByKey.get(record.registryKey);
    if (current === record) {
      sidecarsByKey.delete(record.registryKey);
    }

    void unregisterSidecarForCwd(record.cwd, record.pid, record.registryKey);
  };

  child.once("exit", clear);
  child.once("close", clear);
};

export const getExecutorLogPath = (
  cwd: string,
  dataDir?: string,
): { stdout: string; stderr: string } => {
  const resolvedDataDir = getExecutorDataDir(cwd, dataDir);
  return {
    stdout: join(resolvedDataDir, "executor.stdout.log"),
    stderr: join(resolvedDataDir, "executor.stderr.log"),
  };
};

const spawnOwnedSidecar = async (
  cwd: string,
  port: number,
  registryKey: string,
  dataDir: string,
): Promise<SidecarRecord> => {
  const runtimePath = await resolveRuntimeBinary();
  await mkdir(dataDir, { recursive: true });

  const logPaths = getExecutorLogPath(cwd, dataDir);
  const stdoutLog = createWriteStream(logPaths.stdout, { flags: "a" });
  const stderrLog = createWriteStream(logPaths.stderr, { flags: "a" });

  const child = spawn(runtimePath, ["web", "--port", String(port), "--foreground"], {
    cwd,
    env: { ...process.env, EXECUTOR_DATA_DIR: dataDir },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const record: SidecarRecord = {
    cwd,
    registryKey,
    port,
    baseUrl: buildBaseUrl(port),
    pid: child.pid,
    ownedByPi: true,
    child,
    stdoutTail: [],
    stderrTail: [],
  };

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  child.stdout.on("data", (chunk: string) => {
    pushLogChunk(record.stdoutTail, chunk);
    stdoutLog.write(chunk);
  });
  child.stderr.on("data", (chunk: string) => {
    pushLogChunk(record.stderrTail, chunk);
    stderrLog.write(chunk);
  });

  child.once("exit", () => {
    stdoutLog.end();
    stderrLog.end();
  });
  child.once("close", () => {
    stdoutLog.end();
    stderrLog.end();
  });

  attachExitCleanup(record);

  return record;
};

export const findRunningSidecarForCwd = async (
  cwdInput: string,
  dataDir?: string,
): Promise<SidecarRecord | undefined> => {
  const cwd = normalizeDir(cwdInput);
  const registryKey = computeRegistryKey(cwd, dataDir);
  const cached = sidecarsByKey.get(registryKey);
  if (cached && (await isHealthyRecord(cached))) {
    return cached;
  }
  if (cached) {
    sidecarsByKey.delete(registryKey);
  }

  const registered = await getRegisteredSidecar(cwd, registryKey);
  if (registered) {
    const record = await hydrateRegisteredPid({
      cwd,
      registryKey,
      port: registered.port,
      baseUrl: registered.baseUrl,
      ownedByPi: false,
      stdoutTail: [],
      stderrTail: [],
    });
    if (await isHealthyRecord(record)) {
      sidecarsByKey.set(registryKey, record);
      return record;
    }
    await unregisterSidecarForCwd(cwd, registered.pid, registryKey);
  }

  return undefined;
};

export const ensureSidecar = async (cwdInput: string, dataDir?: string): Promise<SidecarRecord> => {
  const cwd = normalizeDir(cwdInput);
  const registryKey = computeRegistryKey(cwd, dataDir);
  const actualDataDir = getExecutorDataDir(cwd, dataDir);
  const reusable = await findRunningSidecarForCwd(cwd, dataDir);
  if (reusable) {
    return reusable;
  }

  const scanned = await scanPorts(cwd);
  if (scanned.freePort === undefined) {
    throw new SidecarError(
      "PORT_EXHAUSTED",
      `No free executor sidecar port found in ${DEFAULT_PORT_SEED}-${DEFAULT_PORT_SEED + PORT_SCAN_LIMIT - 1}`,
    );
  }

  const record = await spawnOwnedSidecar(cwd, scanned.freePort, registryKey, actualDataDir);
  sidecarsByKey.set(registryKey, record);

  try {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const alive = await getHealth(record.baseUrl, HEALTH_TIMEOUT_MS);
      if (alive) {
        await registerRuntimeSidecar(record);
        return record;
      }
      await delay(100);
    }

    throw new SidecarError(
      "STARTUP_TIMEOUT",
      `Executor sidecar startup timed out after ${STARTUP_TIMEOUT_MS}ms. stdout: ${joinTail(record.stdoutTail)} stderr: ${joinTail(record.stderrTail)}`,
      { port: record.port },
    );
  } catch (error) {
    await stopSidecar(record);
    if (error instanceof SidecarError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new SidecarError("STARTUP_TIMEOUT", `Executor sidecar failed to start: ${message}`, {
      port: record.port,
    });
  }
};

export const stopSidecar = async (record: SidecarRecord): Promise<void> => {
  const current = sidecarsByKey.get(record.registryKey);
  if (current === record) {
    sidecarsByKey.delete(record.registryKey);
  }

  if (record.pid) {
    await unregisterSidecarForCwd(record.cwd, record.pid, record.registryKey);
  }

  const child = record.child;
  if (!record.ownedByPi || !child) {
    if (record.pid) {
      await terminatePid(record.pid);
    }
    return;
  }

  child.kill("SIGTERM");
  await new Promise<void>((resolveClose) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      resolveClose();
    }, SHUTDOWN_TIMEOUT_MS);

    child.once("close", () => {
      clearTimeout(timeout);
      resolveClose();
    });
  });
};

export const getSidecarRecord = (cwdInput: string, dataDir?: string): SidecarRecord | undefined =>
  sidecarsByKey.get(computeRegistryKey(normalizeDir(cwdInput), dataDir));

export const stopSidecarForCwd = async (
  cwdInput: string,
  dataDir?: string,
): Promise<"stopped" | "missing"> => {
  const cwd = normalizeDir(cwdInput);
  const registryKey = computeRegistryKey(cwd, dataDir);
  const running = await findRunningSidecarForCwd(cwd, dataDir);
  if (running && (running.ownedByPi || running.pid !== undefined)) {
    await stopSidecar(running);
    return "stopped";
  }
  if (running) {
    sidecarsByKey.delete(registryKey);
  }

  const registered = await getRegisteredSidecar(cwd, registryKey);
  if (!registered) {
    return "missing";
  }

  if (!isPidRunning(registered.pid)) {
    await unregisterSidecarForCwd(cwd, registered.pid, registryKey);
    return "missing";
  }

  sidecarsByKey.delete(registryKey);
  await unregisterSidecarForCwd(cwd, registered.pid, registryKey);
  await terminatePid(registered.pid);
  return "stopped";
};

export const shutdownOwnedSidecars = async (): Promise<void> => {
  const owned = collectOwnedSidecars(sidecarsByKey.values());
  await Promise.all(owned.map((record) => stopSidecar(record)));
};

export const getSidecarRecords = (): SidecarRecord[] => Array.from(sidecarsByKey.values());
