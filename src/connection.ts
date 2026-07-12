import { resolveExecutorSettings, hasProjectExecutorSettings } from "./settings.ts";
import { ensureSidecar, ensureGlobalExecutor, readAuthToken, getExecutorDataDir } from "./sidecar.ts";

export type ExecutorEndpoint = {
  mode: "local" | "remote";
  baseUrl: string;
  ownedByPi: boolean;
  token?: string;
};

const assertRemoteUrl = (remoteUrl: string): string => {
  if (remoteUrl.length === 0) {
    throw new Error("piExecutor.remoteUrl is required when piExecutor.mode is 'remote'");
  }

  try {
    return new URL(remoteUrl).toString().replace(/\/+$/, "");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid piExecutor.remoteUrl: ${message}`);
  }
};

export const resolveExecutorEndpoint = async (cwd: string): Promise<ExecutorEndpoint> => {
  const settings = await resolveExecutorSettings(cwd);

  if (settings.mode === "remote") {
    const baseUrl = assertRemoteUrl(settings.remoteUrl);
    const token = await readAuthToken(getExecutorDataDir(cwd, settings.dataDir || undefined));
    return {
      mode: "remote",
      baseUrl,
      ownedByPi: false,
      token,
    };
  }

  const hasProjectOverride = await hasProjectExecutorSettings(cwd);
  if (!hasProjectOverride) {
    const dataDir = getExecutorDataDir(cwd, settings.dataDir || undefined);
    const global = await ensureGlobalExecutor(dataDir, settings.scopeDir || undefined);
    const token = await readAuthToken(dataDir);
    return {
      mode: "local",
      baseUrl: global.baseUrl,
      ownedByPi: false,
      token,
    };
  }

  const sidecar = await ensureSidecar(cwd, settings.dataDir || undefined);
  const token = await readAuthToken(getExecutorDataDir(cwd, settings.dataDir || undefined));

  return {
    mode: "local",
    baseUrl: sidecar.baseUrl,
    ownedByPi: sidecar.ownedByPi,
    token,
  };
};
