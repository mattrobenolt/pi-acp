import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

function isObject(x: unknown): x is Record<string, unknown> {
  return Boolean(x) && typeof x === "object" && !Array.isArray(x);
}

function deepMerge(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const av = out[k];
    if (isObject(av) && isObject(v)) out[k] = deepMerge(av, v);
    else out[k] = v;
  }
  return out;
}

export function readPiSettingsFile(path: string): Record<string, unknown> {
  try {
    if (!existsSync(path)) return {};
    const raw = readFileSync(path, "utf-8");
    const data = JSON.parse(raw);
    return isObject(data) ? data : {};
  } catch {
    return {};
  }
}

export function getGlobalSettingsPath(): string {
  return join(getAgentDir(), "settings.json");
}

export function getProjectSettingsPath(cwd: string): string {
  return resolve(cwd, ".pi", "settings.json");
}

export function getMergedSettings(cwd: string): Record<string, unknown> {
  const global = readPiSettingsFile(getGlobalSettingsPath());
  const project = readPiSettingsFile(getProjectSettingsPath(cwd));
  return deepMerge(global, project);
}

function baseAgentDir(): string {
  return resolve(process.env.PI_PROFILE_BASE_DIR ?? join(homedir(), ".pi", "agent"));
}

function profileDir(name: string, baseDir = baseAgentDir()): string {
  return join(dirname(baseDir), `${basename(baseDir)}-${name}`);
}

function configuredDefaultProfile(baseDir = baseAgentDir()): string | null {
  try {
    const configPath = join(dirname(baseDir), "pi-profile.json");
    if (!existsSync(configPath)) return null;

    const data = JSON.parse(readFileSync(configPath, "utf-8")) as unknown;
    if (!isObject(data) || typeof data.defaultProfile !== "string") return null;

    const name = data.defaultProfile.trim();
    return /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name) ? name : null;
  } catch {
    return null;
  }
}

export function getAgentDir(): string {
  if (process.env.PI_CODING_AGENT_DIR) return resolve(process.env.PI_CODING_AGENT_DIR);

  const baseDir = baseAgentDir();
  const requestedProfile = process.env.PI_ACP_PROFILE?.trim();
  if (requestedProfile === "base") return baseDir;

  const profileName =
    requestedProfile && requestedProfile !== "default"
      ? requestedProfile
      : configuredDefaultProfile(baseDir);

  return profileName ? profileDir(profileName, baseDir) : baseDir;
}

/**
 * Mirror pi settings semantics (global + project merge, project overrides global).
 * Only returns the bits we currently need.
 */
function envBool(name: string): boolean | null {
  const value = process.env[name];
  if (value == null) return null;
  if (["1", "true", "yes", "on"].includes(value.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(value.toLowerCase())) return false;
  return null;
}

export function getEnableSkillCommands(cwd: string): boolean {
  const merged = getMergedSettings(cwd);

  const direct = merged.enableSkillCommands;
  if (typeof direct === "boolean") return direct;

  // Back-compat: some versions used skills.enableSkillCommands
  const nested = isObject(merged.skills) ? merged.skills.enableSkillCommands : undefined;
  if (typeof nested === "boolean") return nested;

  return true;
}

/**
 * Mirror pi's quietStartup setting: if true, pi suppresses the verbose startup prelude.
 * We use it to decide whether to synthesize + emit our own "startup info" message.
 */
export function getEnableExtensionCommands(cwd: string): boolean {
  const fromEnv = envBool("PI_ACP_ENABLE_EXTENSION_COMMANDS");
  if (fromEnv != null) return fromEnv;

  const merged = getMergedSettings(cwd);
  const direct = merged.enableExtensionCommands;
  return typeof direct === "boolean" ? direct : true;
}

export function getQuietStartup(cwd: string): boolean {
  const merged = getMergedSettings(cwd);

  const direct = merged.quietStartup;
  if (typeof direct === "boolean") return direct;

  // Back-compat: some versions used quietStart
  const legacy = (merged as any).quietStart;
  if (typeof legacy === "boolean") return legacy;

  return false;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item).trim()).filter(Boolean);
}

function unique(items: string[]): string[] {
  return [...new Set(items)];
}

export function getConfiguredPackages(cwd: string): string[] {
  const global = readPiSettingsFile(getGlobalSettingsPath());
  const project = readPiSettingsFile(getProjectSettingsPath(cwd));
  return unique([...stringArray(global.packages), ...stringArray(project.packages)]);
}

export function getEnabledModels(cwd: string): string[] | null {
  const merged = getMergedSettings(cwd);
  const enabledModels = merged.enabledModels;

  const models = stringArray(enabledModels);
  return models.length ? models : null;
}
