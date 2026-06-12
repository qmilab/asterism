// The CLI's configuration file: install-wide and per-agent model defaults, kept
// at the surface where all model wiring already lives. This stays OUT of the
// kernel by design — the kernel knows nothing about models or providers (it is
// handed a pre-built adapter), so a per-agent model is surface config keyed by
// agent NAME, never a column on the kernel's Agent entity. Keeping it here is
// what lets the substrate stay replaceable.
//
// SECURITY (issue note): this file holds only a model's id / provider / endpoint
// / wire protocol — never an API key. Provider keys stay infrastructure
// (environment variables, e.g. OPENAI_API_KEY), never written to this
// plaintext, possibly-shared file. `config set` exposes no way to set a key.

import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { configPath } from "./paths.js";

/**
 * A model's coordinates. Every field is optional so one layer can override a
 * single field and inherit the rest — a per-agent override that sets only `id`
 * still picks up the provider's endpoint and protocol from the lower layers.
 */
export interface ModelSettings {
  id?: string;
  provider?: string;
  baseUrl?: string;
  /** The wire protocol (e.g. "anthropic-messages"). NOT an API key. */
  api?: string;
}

/** The on-disk config: an install-wide default plus per-agent overrides. */
export interface AsterismConfig {
  /** Install-wide default model, used by any agent without its own override. */
  model?: ModelSettings;
  /** Per-agent model overrides, keyed by agent name. */
  agents?: Record<string, { model?: ModelSettings }>;
}

/** Validate a value expected to be an optional string, or throw a clear error. */
function asString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(`config: ${path} must be a string`);
  }
  return value;
}

/** Validate and extract a {@link ModelSettings} object, ignoring unknown keys. */
function parseModelSettings(value: unknown, path: string): ModelSettings | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`config: ${path} must be an object`);
  }
  const v = value as Record<string, unknown>;
  const out: ModelSettings = {};
  const id = asString(v.id, `${path}.id`);
  if (id !== undefined) out.id = id;
  const provider = asString(v.provider, `${path}.provider`);
  if (provider !== undefined) out.provider = provider;
  const baseUrl = asString(v.baseUrl, `${path}.baseUrl`);
  if (baseUrl !== undefined) out.baseUrl = baseUrl;
  const api = asString(v.api, `${path}.api`);
  if (api !== undefined) out.api = api;
  return out;
}

/**
 * Validate raw parsed JSON into an {@link AsterismConfig}. Throws on a malformed
 * shape rather than silently dropping config — a typo in the file must surface,
 * not quietly run the wrong model.
 */
export function parseConfig(raw: unknown): AsterismConfig {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("config: the top level must be an object");
  }
  const r = raw as Record<string, unknown>;
  const config: AsterismConfig = {};

  const model = parseModelSettings(r.model, "model");
  if (model !== undefined) config.model = model;

  if (r.agents !== undefined) {
    if (typeof r.agents !== "object" || r.agents === null || Array.isArray(r.agents)) {
      throw new Error("config: agents must be an object");
    }
    const agents: Record<string, { model?: ModelSettings }> = {};
    for (const [name, entry] of Object.entries(r.agents as Record<string, unknown>)) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        throw new Error(`config: agents.${name} must be an object`);
      }
      const m = parseModelSettings((entry as Record<string, unknown>).model, `agents.${name}.model`);
      agents[name] = m !== undefined ? { model: m } : {};
    }
    config.agents = agents;
  }

  return config;
}

/**
 * Read and validate the install's config file. A missing file is not an error —
 * it just means no config, so callers fall back to env vars and provider
 * defaults. A present-but-malformed file IS an error, surfaced with its path.
 */
export function loadConfig(home: string): AsterismConfig {
  const path = configPath(home);
  if (!existsSync(path)) return {};
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`could not read config at ${path}: ${reason}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`config at ${path} is not valid JSON — fix or remove it.`);
  }
  return parseConfig(raw);
}

/** Write the config file (pretty-printed, trailing newline), creating it if absent. */
export function saveConfig(home: string, config: AsterismConfig): void {
  writeFileSync(configPath(home), `${JSON.stringify(config, null, 2)}\n`);
}
