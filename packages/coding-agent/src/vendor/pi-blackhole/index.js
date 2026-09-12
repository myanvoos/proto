import { mkdirSync, appendFileSync, existsSync, statSync, unlinkSync, renameSync, readFileSync, writeFileSync, rmSync, mkdtempSync, realpathSync, readdirSync, openSync, readSync, closeSync } from 'fs';
import { join, dirname, sep, isAbsolute, resolve, relative, basename, parse } from 'path';
import { tmpdir } from 'os';
import { getAgentDir, getSelectListTheme, convertToLlm, AgentSession } from '@oh-my-pi/pi-coding-agent';
import { fuzzyMatch, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, Editor, SelectList, decodeKittyPrintable } from '@oh-my-pi/pi-tui';
import { AsyncLocalStorage } from 'async_hooks';
import { appendFile } from 'fs/promises';
import { pathToFileURL, fileURLToPath } from 'url';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { agentLoop, calculateContextTokens, Tokenizer } from '@oh-my-pi/pi-agent-core';
import { streamSimple } from '@oh-my-pi/pi-ai';
import { Type } from 'typebox';
import { createHash } from 'crypto';

const blackholeTokenizer = new Tokenizer();
const estimateTokens = message => blackholeTokenizer.countMessage(message);
const StringEnum = (values, options) => Type.Unsafe({
  type: "string",
  enum: values,
  ...(options?.description && { description: options.description }),
  ...(options?.default && { default: options.default })
});

// src/core/unified-config.ts
var lastEnvVal = void 0;
var cachedPiAgentDir = null;
var cachedVitestExtensionsDir;
function vitestExtensionsDir() {
  const existing = cachedVitestExtensionsDir;
  if (existing) return existing;
  const dir = mkdtempSync(join(tmpdir(), "pi-agent-extensions-"));
  cachedVitestExtensionsDir = dir;
  process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function getPiAgentDir() {
  const currentEnvVal = process.env.PI_CODING_AGENT_DIR;
  if (cachedPiAgentDir !== null && currentEnvVal === lastEnvVal) {
    return cachedPiAgentDir;
  }
  lastEnvVal = currentEnvVal;
  cachedPiAgentDir = currentEnvVal?.trim() || getAgentDir();
  return cachedPiAgentDir;
}
function getExtensionsDir() {
  if (process.env.VITEST === "true" && !process.env.PI_CODING_AGENT_DIR) {
    return vitestExtensionsDir();
  }
  return join(getPiAgentDir(), "extensions");
}

// src/pi-base/session.ts
function getAncestorChain(entries, leafId) {
  const byId = /* @__PURE__ */ new Map();
  for (const entry of entries) {
    if (entry.type === "session") continue;
    byId.set(entry.id, { id: entry.id, parentId: entry.parentId ?? null });
  }
  const chain = [];
  let current = byId.get(leafId);
  const visited = /* @__PURE__ */ new Set();
  while (current) {
    if (visited.has(current.id)) break;
    visited.add(current.id);
    chain.push(current.id);
    current = current.parentId ? byId.get(current.parentId) : void 0;
  }
  return chain;
}

// src/pi-base/config.ts
var _configCache = /* @__PURE__ */ new Map();
var CACHE_LIMIT = 128;
function cacheSet(key, value) {
  _configCache.delete(key);
  _configCache.set(key, value);
  if (_configCache.size > CACHE_LIMIT) {
    const firstKey = _configCache.keys().next().value;
    if (firstKey !== void 0) {
      _configCache.delete(firstKey);
    }
  }
}
var PROTECTED_KEYS = /* @__PURE__ */ new Set(["__proto__", "constructor", "prototype"]);
function resolveConfigDir(configDir) {
  return configDir ?? getExtensionsDir();
}
function isRealDir(dir) {
  if (dir.startsWith("/tmp") || dir.startsWith("/var/folders")) return false;
  const systemTmp = tmpdir();
  return dir !== systemTmp && !dir.startsWith(systemTmp + sep);
}
function guardRealDir(filename, configDir, operation) {
  if (configDir !== void 0) return true;
  if (process.env.VITEST !== "true") return true;
  const dir = resolveConfigDir(configDir);
  if (isRealDir(dir)) {
    console.warn(
      `[pi-base] Blocked ${operation} of "${filename}" \u2014 running in vitest without explicit configDir, and the target directory (${dir}) looks like a real user home. Pass an explicit configDir parameter to enable ${operation}s in tests.`
    );
    return false;
  }
  return true;
}
function readConfig(filename, configDir) {
  const path = join(resolveConfigDir(configDir), filename);
  try {
    const stats = statSync(path, { throwIfNoEntry: false });
    if (!stats) {
      _configCache.delete(path);
      return null;
    }
    const hit = _configCache.get(path);
    if (hit && hit.mtime === stats.mtimeMs && hit.size === stats.size) {
      _configCache.delete(path);
      _configCache.set(path, hit);
      return structuredClone(hit.data);
    }
    const raw = readFileSync(path, "utf-8");
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      cacheSet(path, { data: null, mtime: stats.mtimeMs, size: stats.size });
      return null;
    }
    const parsed = JSON.parse(trimmed);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      cacheSet(path, { data: null, mtime: stats.mtimeMs, size: stats.size });
      return null;
    }
    cacheSet(path, {
      data: structuredClone(parsed),
      mtime: stats.mtimeMs,
      size: stats.size
    });
    return parsed;
  } catch {
    _configCache.delete(path);
    return null;
  }
}
function writeConfig(filename, data, configDir) {
  if (!guardRealDir(filename, configDir, "write")) return false;
  const path = join(resolveConfigDir(configDir), filename);
  _configCache.delete(path);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(data, null, 2)}
`, "utf-8");
    return true;
  } catch (error) {
    console.warn(
      `[pi-base] Failed to write "${path}": ${error instanceof Error ? error.message : String(error)}`
    );
    return false;
  }
}
function deleteConfig(filename, configDir) {
  if (!guardRealDir(filename, configDir, "delete")) return;
  const path = join(resolveConfigDir(configDir), filename);
  _configCache.delete(path);
  try {
    rmSync(path, { force: true });
  } catch {
  }
}
function deepMerge(base, overrides) {
  if (!overrides || typeof overrides !== "object") {
    return { ...base };
  }
  const result = { ...base };
  for (const key of Object.keys(overrides)) {
    if (PROTECTED_KEYS.has(key)) continue;
    const overrideVal = overrides[key];
    if (overrideVal === void 0) {
      continue;
    }
    if (overrideVal === null) {
      result[key] = null;
      continue;
    }
    const baseVal = result[key];
    if (isPlainObject(baseVal) && isPlainObject(overrideVal)) {
      result[key] = deepMerge(
        baseVal,
        overrideVal
      );
    } else {
      result[key] = overrideVal;
    }
  }
  return result;
}
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
var SESSION_KEY_SEP = "\0";
var PENDING_SENTINEL = "__pending__";
var _sessionConfigs = /* @__PURE__ */ new Map();
var MAX_SESSION_CONFIGS = 500;
function sessionKey(namespace, cwd, sessionId, leafId) {
  return `${namespace}${SESSION_KEY_SEP}${cwd}${SESSION_KEY_SEP}${sessionId}${SESSION_KEY_SEP}${leafId}`;
}
function getSessionConfig(namespace, cwd, sessionId, leafId, entries) {
  const chain = getAncestorChain(entries, leafId);
  for (const id of chain) {
    const key = sessionKey(namespace, cwd, sessionId, id);
    const found = _sessionConfigs.get(key);
    if (found) return found;
  }
  return {};
}
function setSessionConfig(namespace, cwd, sessionId, leafId, config2) {
  const key = sessionKey(namespace, cwd, sessionId, leafId);
  _sessionConfigs.set(key, structuredClone(config2));
  if (_sessionConfigs.size > MAX_SESSION_CONFIGS) {
    const oldestKey = _sessionConfigs.keys().next().value;
    _sessionConfigs.delete(oldestKey);
  }
}
function getRawSessionConfig(namespace, cwd, sessionId, leafId) {
  return _sessionConfigs.get(sessionKey(namespace, cwd, sessionId, leafId));
}
function clearSessionConfig(namespace, cwd, sessionId, leafId) {
  _sessionConfigs.delete(sessionKey(namespace, cwd, sessionId, leafId));
}
function deepEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (a === null || b === null || typeof a !== typeof b) return false;
  if (a instanceof Date && b instanceof Date) {
    return a.getTime() === b.getTime();
  }
  if (a instanceof RegExp && b instanceof RegExp) {
    return a.source === b.source && a.flags === b.flags;
  }
  if (a instanceof Map && b instanceof Map) {
    if (a.size !== b.size) return false;
    for (const [k, v] of a) {
      if (!b.has(k) || !deepEqual(v, b.get(k))) return false;
    }
    return true;
  }
  if (a instanceof Set && b instanceof Set) {
    if (a.size !== b.size) return false;
    for (const v of a) {
      if (!b.has(v)) return false;
    }
    return true;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    for (const key of keysA) {
      if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
      if (!deepEqual(a[key], b[key])) return false;
    }
    return true;
  }
  return false;
}
function checkConfigFile(filename, configDir) {
  const path = join(resolveConfigDir(configDir), filename);
  try {
    const stats = statSync(path, { throwIfNoEntry: false });
    if (!stats) {
      return { exists: false, valid: true };
    }
    const raw = readFileSync(path, "utf-8");
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      return { exists: true, valid: false, error: "Config file is empty" };
    }
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch (e) {
      return {
        exists: true,
        valid: false,
        error: `Invalid JSON: ${e.message}`
      };
    }
    if (!isPlainObject(parsed)) {
      return {
        exists: true,
        valid: false,
        error: "Config file must contain a plain JSON object at the top level"
      };
    }
    return { exists: true, valid: true };
  } catch {
    return { exists: true, valid: false, error: "Cannot read config file" };
  }
}
function loadConfig(filename, defaults, opts = {}) {
  const dir = resolveConfigDir(opts.configDir);
  const mergeFn = opts.merge === "deep" ? (base, over) => deepMerge(
    base,
    over
  ) : shallowMerge;
  let config2 = defaults;
  config2 = mergeFn(config2, readConfig(filename, dir) ?? {});
  if (opts.cwd) {
    const projectDir = join(opts.cwd, ".pi");
    config2 = mergeFn(config2, readConfig(filename, projectDir) ?? {});
  }
  return config2;
}
function shallowMerge(base, overrides) {
  const result = { ...base };
  for (const key of Object.keys(overrides)) {
    if (PROTECTED_KEYS.has(key)) continue;
    const val = overrides[key];
    if (val !== void 0) {
      result[key] = val;
    }
  }
  return result;
}
function readBooleanEnv(name, fallback) {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return fallback;
}
function readPositiveIntEnv(name, fallback) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

// src/core/config-env.ts
function applyEnvOverrides(config2, env, defaults) {
  const result = {
    ...config2
  };
  for (const [key, value] of Object.entries(env)) {
    if (!value) continue;
    const defaultValue = defaults[key];
    if (typeof value === "string") {
      if (typeof defaultValue === "boolean") {
        result[key] = readBooleanEnv(value, result[key] ?? defaultValue);
      } else if (typeof defaultValue === "number") {
        if (Number.isInteger(defaultValue) && defaultValue > 0) {
          result[key] = readPositiveIntEnv(
            value,
            result[key] ?? defaultValue
          );
        } else {
          const raw = process.env[value]?.trim();
          if (raw) {
            const parsed = Number.parseFloat(raw);
            if (Number.isFinite(parsed)) {
              result[key] = parsed;
            }
          }
        }
      }
    } else {
      const raw = process.env[value.var]?.trim();
      if (raw) {
        const parsed = value.parse(raw, result[key]);
        if (parsed !== void 0) {
          result[key] = parsed;
        }
      }
    }
  }
  return result;
}
var DECLARATIVE_ENV_OVERRIDES = {
  // Booleans
  memory: "PI_BLACKHOLE_MEMORY",
  debug: "PI_BLACKHOLE_DEBUG",
  debugLog: "PI_BLACKHOLE_DEBUG_LOG",
  fullFoldAlways: "PI_BLACKHOLE_FULL_FOLD_ALWAYS",
  // Positive integers
  compactAfterTokens: "PI_BLACKHOLE_COMPACT_AFTER_TOKENS",
  observeAfterTokens: "PI_BLACKHOLE_OBSERVE_AFTER_TOKENS",
  reflectAfterTokens: "PI_BLACKHOLE_REFLECT_AFTER_TOKENS",
  observationsPoolMaxTokens: "PI_BLACKHOLE_OBSERVATIONS_POOL_MAX_TOKENS",
  observationsPoolTargetTokens: "PI_BLACKHOLE_OBSERVATIONS_POOL_TARGET_TOKENS",
  reflectorInputMaxTokens: "PI_BLACKHOLE_REFLECTOR_INPUT_MAX_TOKENS",
  dropperInputMaxTokens: "PI_BLACKHOLE_DROPPER_INPUT_MAX_TOKENS",
  observerChunkMaxTokens: "PI_BLACKHOLE_OBSERVER_CHUNK_MAX_TOKENS",
  observerPreambleMaxTokens: "PI_BLACKHOLE_OBSERVER_PREAMBLE_MAX_TOKENS",
  agentMaxTurns: "PI_BLACKHOLE_AGENT_MAX_TURNS",
  // Non-negative integer (0 = disabled, unset = inherit pi default)
  providerIdleTimeoutMs: {
    var: "PI_BLACKHOLE_PROVIDER_IDLE_TIMEOUT_MS",
    parse: (raw) => {
      const n = Number(raw);
      return Number.isInteger(n) && n >= 0 ? n : void 0;
    }
  },
  // Float in (0, 1]
  dropperPressureThreshold: {
    var: "PI_BLACKHOLE_DROPPER_PRESSURE_THRESHOLD",
    parse: (raw) => {
      const n = Number.parseFloat(raw);
      return Number.isFinite(n) && n > 0 && n <= 1 ? n : void 0;
    }
  },
  // Float in (0, 1]
  dropperPoolFullnessThreshold: {
    var: "PI_BLACKHOLE_DROPPER_POOL_FULLNESS_THRESHOLD",
    parse: (raw) => {
      const n = Number.parseFloat(raw);
      return Number.isFinite(n) && n > 0 && n <= 1 ? n : void 0;
    }
  },
  // Comma-separated provider skip list ("provider" or "provider:api")
  skipForProviders: {
    var: "PI_BLACKHOLE_SKIP_PROVIDERS",
    parse: (raw) => raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
  },
  // Enum overrides — custom parsers because canonical only auto-handles
  // booleans and positive integers.
  compaction: {
    var: "PI_BLACKHOLE_COMPACTION",
    parse: (raw) => {
      const trimmed = raw.trim().toLowerCase();
      return ["auto", "manual", "off"].includes(trimmed) ? trimmed : void 0;
    }
  },
  compactionEngine: {
    var: "PI_BLACKHOLE_COMPACTION_ENGINE",
    parse: (raw) => {
      const trimmed = raw.trim().toLowerCase();
      return ["blackhole", "pi-default"].includes(trimmed) ? trimmed : void 0;
    }
  },
  compactionSummaryMode: {
    var: "PI_BLACKHOLE_COMPACTION_SUMMARY_MODE",
    parse: (raw) => {
      const trimmed = raw.trim().toLowerCase();
      return ["default", "append"].includes(trimmed) ? trimmed : void 0;
    }
  },
  midRunCompaction: {
    var: "PI_BLACKHOLE_MID_RUN_COMPACTION",
    parse: (raw) => {
      const trimmed = raw.trim().toLowerCase();
      return ["resume", "pause", "off"].includes(trimmed) ? trimmed : void 0;
    }
  }
};
var __lastAgentDirEnv;
var __cachedAgentDir = null;
function getAgentDir2() {
  const current = process.env.PI_CODING_AGENT_DIR?.trim();
  if (current === __lastAgentDirEnv && __cachedAgentDir !== null) return __cachedAgentDir;
  __lastAgentDirEnv = current;
  __cachedAgentDir = current || getAgentDir();
  return __cachedAgentDir;
}
var CONFIG_DIR = "pi-blackhole";
var CONFIG_FILE = "pi-blackhole-config.json";
function configPath() {
  return join(getAgentDir2(), CONFIG_DIR, CONFIG_FILE);
}
var DEFAULTS = {
  debug: false,
  // New config surface
  compaction: "auto",
  compactionEngine: "blackhole",
  compactionSummaryMode: "default",
  skipForProviders: [],
  tailBehavior: "minimal",
  midRunCompaction: "off",
  observeAfterTokens: 15e3,
  reflectAfterTokens: 25e3,
  compactAfterTokens: 81e3,
  observationsPoolMaxTokens: 2e4,
  fullFoldAlways: true,
  observationsPoolTargetTokens: 1e4,
  reflectorInputMaxTokens: 8e4,
  dropperInputMaxTokens: 8e4,
  dropperPressureThreshold: 0.7,
  dropperPoolFullnessThreshold: 0.1,
  observerChunkMaxTokens: 4e4,
  observerPreambleMaxTokens: 0,
  agentMaxTurns: 16,
  memory: true,
  debugLog: false
};
var COMPACTION_VALUES = ["auto", "manual", "off"];
var COMPACTION_ENGINE_VALUES = ["blackhole", "pi-default"];
var COMPACTION_SUMMARY_MODE_VALUES = ["default", "append"];
var TAIL_BEHAVIOR_VALUES = ["pi-default", "minimal"];
var MID_RUN_COMPACTION_VALUES = ["resume", "pause", "off"];
function isCompaction(v) {
  return typeof v === "string" && COMPACTION_VALUES.includes(v);
}
function isCompactionEngine(v) {
  return typeof v === "string" && COMPACTION_ENGINE_VALUES.includes(v);
}
function isCompactionSummaryMode(v) {
  return typeof v === "string" && COMPACTION_SUMMARY_MODE_VALUES.includes(v);
}
function isTailBehavior(v) {
  return typeof v === "string" && TAIL_BEHAVIOR_VALUES.includes(v);
}
function isMidRunCompaction(v) {
  return typeof v === "string" && MID_RUN_COMPACTION_VALUES.includes(v);
}
function isRecord(v) {
  return typeof v === "object" && v !== null;
}
function positiveInt(v) {
  return Number.isInteger(v) && typeof v === "number" && v > 0 ? v : void 0;
}
function nonNegativeInt(v) {
  return Number.isInteger(v) && typeof v === "number" && v >= 0 ? v : void 0;
}
function parseConfig(raw) {
  const c = {};
  if (isCompaction(raw.compaction)) c.compaction = raw.compaction;
  if (isCompactionEngine(raw.compactionEngine)) c.compactionEngine = raw.compactionEngine;
  if (isCompactionSummaryMode(raw.compactionSummaryMode))
    c.compactionSummaryMode = raw.compactionSummaryMode;
  if (isTailBehavior(raw.tailBehavior)) c.tailBehavior = raw.tailBehavior;
  if (isMidRunCompaction(raw.midRunCompaction)) c.midRunCompaction = raw.midRunCompaction;
  if (Array.isArray(raw.skipForProviders)) {
    const list = raw.skipForProviders.filter((v) => typeof v === "string").map((v) => v.trim()).filter((v) => v.length > 0);
    if (list.length > 0) c.skipForProviders = list;
  }
  if (typeof raw.overrideDefaultCompaction === "boolean")
    c.overrideDefaultCompaction = raw.overrideDefaultCompaction;
  if (typeof raw.debug === "boolean") c.debug = raw.debug;
  if (typeof raw.noAutoCompact === "boolean") c.noAutoCompact = raw.noAutoCompact;
  if (typeof raw.passive === "boolean") c.passive = raw.passive;
  if (typeof raw.memory === "boolean") c.memory = raw.memory;
  if (typeof raw.fullFoldAlways === "boolean") c.fullFoldAlways = raw.fullFoldAlways;
  if (typeof raw.debugLog === "boolean") c.debugLog = raw.debugLog;
  const numKeys = [
    "observeAfterTokens",
    "reflectAfterTokens",
    "compactAfterTokens",
    "observationsPoolMaxTokens",
    "observationsPoolTargetTokens",
    "reflectorInputMaxTokens",
    "dropperInputMaxTokens",
    "observerChunkMaxTokens",
    "observerPreambleMaxTokens",
    "agentMaxTurns",
    "providerIdleTimeoutMs"
  ];
  if (typeof raw.dropperPressureThreshold === "number" && Number.isFinite(raw.dropperPressureThreshold) && raw.dropperPressureThreshold > 0 && raw.dropperPressureThreshold <= 1) {
    c.dropperPressureThreshold = raw.dropperPressureThreshold;
  }
  if (typeof raw.dropperPoolFullnessThreshold === "number" && Number.isFinite(raw.dropperPoolFullnessThreshold) && raw.dropperPoolFullnessThreshold > 0 && raw.dropperPoolFullnessThreshold <= 1) {
    c.dropperPoolFullnessThreshold = raw.dropperPoolFullnessThreshold;
  }
  for (const k of numKeys) {
    const validator = k === "observerPreambleMaxTokens" || k === "providerIdleTimeoutMs" ? nonNegativeInt : positiveInt;
    const v = validator(raw[k]);
    if (v !== void 0) c[k] = v;
  }
  return c;
}
function migrateOldKnobs(parsed) {
  if (parsed.compaction !== void 0 || parsed.compactionEngine !== void 0) {
    return;
  }
  if (parsed.passive === true) {
    parsed.compaction = "off";
    parsed.memory = false;
  } else if (parsed.noAutoCompact === true) {
    parsed.compaction = "manual";
  }
  if (parsed.overrideDefaultCompaction === true) {
    parsed.compactionEngine = "blackhole";
    if (parsed.tailBehavior === void 0) {
      parsed.tailBehavior = "minimal";
    }
  } else if (parsed.overrideDefaultCompaction === false) {
    parsed.compactionEngine = "pi-default";
  }
  delete parsed.passive;
  delete parsed.noAutoCompact;
  delete parsed.overrideDefaultCompaction;
}
function readJson(path) {
  if (!existsSync(path)) return { data: null, error: null };
  try {
    return { data: JSON.parse(readFileSync(path, "utf-8")), error: null };
  } catch (e) {
    const msg = `Config file at ${path} has invalid JSON: ${e.message}. Using defaults.`;
    console.warn(msg);
    return { data: null, error: msg };
  }
}
function loadUnifiedConfig(cwd, onWarn) {
  const path = configPath();
  let raw;
  let primaryError = null;
  const result = readJson(path);
  raw = result.data;
  primaryError = result.error;
  if (primaryError && onWarn) onWarn(primaryError);
  if (!raw) {
    const piVccPath = join(getAgentDir2(), "pi-vcc-config.json");
    const piVccResult = readJson(piVccPath);
    const piVccRaw = piVccResult.data;
    if (piVccResult.error && onWarn) onWarn(piVccResult.error);
    const settingsPath = join(getAgentDir2(), "settings.json");
    const settingsResult = readJson(settingsPath);
    const settingsRaw = settingsResult.data;
    if (settingsResult.error && onWarn) onWarn(settingsResult.error);
    const omRaw = settingsRaw?.["pi-blackhole"] ?? settingsRaw?.["observational-memory"];
    const projectSettingsPath = join(cwd, ".pi", "settings.json");
    const projectResult2 = readJson(projectSettingsPath);
    const projectRaw2 = projectResult2.data;
    if (projectResult2.error && onWarn) onWarn(projectResult2.error);
    const projectOmRaw = projectRaw2?.["pi-blackhole"] ?? projectRaw2?.["observational-memory"];
    const merged2 = {};
    if (piVccRaw && isRecord(piVccRaw)) Object.assign(merged2, piVccRaw);
    if (omRaw && isRecord(omRaw)) Object.assign(merged2, omRaw);
    if (projectOmRaw && isRecord(projectOmRaw)) Object.assign(merged2, projectOmRaw);
    raw = merged2;
  }
  const projectConfigPath = join(cwd, ".pi", CONFIG_FILE);
  const projectResult = readJson(projectConfigPath);
  const projectRaw = projectResult.data;
  if (projectResult.error && onWarn) onWarn(projectResult.error);
  if (projectRaw && isRecord(projectRaw)) {
    raw = { ...raw, ...projectRaw };
  }
  const parsed = parseConfig(raw);
  migrateOldKnobs(parsed);
  const envPassive = process.env.PI_BLACKHOLE_PASSIVE ?? process.env.PI_VCC_OM_PASSIVE ?? process.env.PI_OBSERVATIONAL_MEMORY_PASSIVE;
  if (envPassive !== void 0) {
    const v = envPassive.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(v)) {
      parsed.compaction = "off";
      parsed.memory = false;
    } else if (["0", "false", "no", "off"].includes(v)) {
      if (raw?.passive === true) {
        delete parsed.compaction;
        delete parsed.memory;
      }
    }
  }
  const merged = { ...DEFAULTS, ...parsed };
  const envCompaction = process.env.PI_BLACKHOLE_COMPACTION;
  if (envCompaction !== void 0) {
    const trimmed = envCompaction.trim().toLowerCase();
    if (isCompaction(trimmed)) {
      merged.compaction = trimmed;
    } else {
      console.warn(`Invalid PI_BLACKHOLE_COMPACTION value "${envCompaction}"; ignoring`);
    }
  }
  const envCompactionEngine = process.env.PI_BLACKHOLE_COMPACTION_ENGINE;
  if (envCompactionEngine !== void 0) {
    const trimmed = envCompactionEngine.trim().toLowerCase();
    if (isCompactionEngine(trimmed)) {
      merged.compactionEngine = trimmed;
    } else {
      console.warn(
        `Invalid PI_BLACKHOLE_COMPACTION_ENGINE value "${envCompactionEngine}"; ignoring`
      );
    }
  }
  const envMidRunCompaction = process.env.PI_BLACKHOLE_MID_RUN_COMPACTION;
  if (envMidRunCompaction !== void 0) {
    const trimmed = envMidRunCompaction.trim().toLowerCase();
    if (isMidRunCompaction(trimmed)) {
      merged.midRunCompaction = trimmed;
    } else {
      console.warn(
        `Invalid PI_BLACKHOLE_MID_RUN_COMPACTION value "${envMidRunCompaction}"; ignoring`
      );
    }
  }
  const withEnv = applyEnvOverrides(
    merged,
    DECLARATIVE_ENV_OVERRIDES,
    DEFAULTS
  );
  return withEnv;
}
function scaffoldConfig() {
  try {
    const path = configPath();
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    if (!existsSync(path)) {
      writeFileSync(path, `${JSON.stringify(DEFAULTS, null, 2)}
`);
    }
  } catch (e) {
    console.error("memory: config scaffold failed", e);
  }
}
function configFileNeedsMigration() {
  try {
    const path = configPath();
    if (!existsSync(path)) return false;
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    if (raw.compaction !== void 0 || raw.compactionEngine !== void 0 || raw.tailBehavior !== void 0) {
      return false;
    }
    return raw.passive !== void 0 || raw.noAutoCompact !== void 0 || raw.overrideDefaultCompaction !== void 0;
  } catch {
    return false;
  }
}
function isManualMode(config2) {
  return config2.compaction === "manual" || config2.noAutoCompact === true;
}

// src/core/settings.ts
function scaffoldSettings() {
  scaffoldConfig();
}

// src/core/tool-args.ts
var PATH_KEYS = ["path", "file_path", "filePath", "file"];
var extractPath = (args) => {
  for (const key of PATH_KEYS) {
    if (typeof args[key] === "string") return args[key];
  }
  return null;
};
var summarizeToolArgs = (args) => {
  const path = extractPath(args);
  if (path) return `path=${path}`;
  if (typeof args.command === "string") return `command=${args.command}`;
  if (typeof args.query === "string") return `query=${args.query}`;
  return Object.keys(args).join(", ");
};

// src/core/content.ts
var clip = (text, max = 200) => {
  if (text.length <= max) return text;
  const cut = text.lastIndexOf(" ", max);
  let end = cut > max * 0.6 ? cut : max;
  if (end > 0 && end < text.length) {
    const code = text.charCodeAt(end - 1);
    if (code >= 55296 && code <= 56319) end--;
  }
  return text.slice(0, end);
};
var clipSentence = (text, max = 200) => {
  if (text.length <= max) return text;
  const window = text.slice(0, max);
  const matches = [...window.matchAll(/[.!?](?:\s|$)/g)];
  if (matches.length > 0) {
    const last = matches[matches.length - 1];
    const end = (last.index ?? 0) + 1;
    if (end >= max * 0.5) return text.slice(0, end);
  }
  return clip(text, max);
};
var nonEmptyLines = (text) => text.split("\n").map((line) => line.trim()).filter(Boolean);
var firstLine = (text, max = 200) => clip(text.split("\n")[0] ?? "", max);
var textParts = (content) => {
  if (!content) return [];
  if (typeof content === "string") return [content];
  return content.filter((part) => part.type === "text").map((part) => part.text);
};
var textOf = (content) => textParts(content).join("\n");
var isContentBearing = (args) => {
  if (!args || typeof args !== "object") return false;
  const hasPath = PATH_KEYS.some((k) => typeof args[k] === "string");
  if (!hasPath) return false;
  if (typeof args.content === "string" && args.content.length > 0) return true;
  if (Array.isArray(args.edits) && args.edits.length > 0 && args.edits.every((e) => typeof e === "object" && e !== null))
    return true;
  if (typeof args.oldText === "string" && args.oldText.length > 0 && args.edits === void 0)
    return true;
  if (typeof args.newText === "string" && args.newText.length > 0 && args.edits === void 0)
    return true;
  return false;
};
var toolCallArgsText = (content, maxBytesPerCall = 10240) => {
  if (!content || typeof content === "string") return "";
  const parts = [];
  for (const part of content) {
    if (!part || typeof part !== "object" || part.type !== "toolCall") continue;
    const args = part.arguments;
    if (!isContentBearing(args)) continue;
    let extracted = "";
    if (typeof args.content === "string") {
      extracted += args.content.slice(0, maxBytesPerCall) + "\n";
    }
    if (Array.isArray(args.edits)) {
      for (const edit of args.edits) {
        if (extracted.length >= maxBytesPerCall) break;
        if (edit && typeof edit === "object") {
          if (typeof edit.oldText === "string") {
            extracted += edit.oldText.slice(0, Math.floor(maxBytesPerCall / 2)) + "\n";
          }
          if (extracted.length >= maxBytesPerCall) break;
          if (typeof edit.newText === "string") {
            extracted += edit.newText.slice(0, Math.floor(maxBytesPerCall / 2)) + "\n";
          }
        }
      }
    }
    if (typeof args.oldText === "string" && !Array.isArray(args.edits)) {
      extracted += args.oldText.slice(0, maxBytesPerCall) + "\n";
    }
    if (typeof args.newText === "string" && !Array.isArray(args.edits)) {
      extracted += args.newText.slice(0, maxBytesPerCall) + "\n";
    }
    if (extracted) {
      parts.push(extracted.slice(0, maxBytesPerCall));
    }
  }
  return parts.join("\n");
};

// src/core/sanitize.ts
var ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;
var CTRL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f]/g;
var sanitize = (text) => text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(ANSI_RE, "").replace(CTRL_RE, "");

// src/core/normalize.ts
var normalizeOne = (msg, msgIndex) => {
  if (msg.role === "user") {
    const blocks = [];
    const text = sanitize(textOf(msg.content));
    if (text) blocks.push({ kind: "user", text, sourceIndex: msgIndex });
    if (msg.content && typeof msg.content !== "string") {
      for (const part of msg.content) {
        if (part.type === "image") {
          blocks.push({
            kind: "user",
            text: `[image: ${part.mimeType}]`,
            sourceIndex: msgIndex
          });
        }
      }
    }
    return blocks.length > 0 ? blocks : [{ kind: "user", text: "", sourceIndex: msgIndex }];
  }
  if (msg.role === "bashExecution") {
    const bashMsg = msg;
    return [
      {
        kind: "bash",
        command: bashMsg.command ?? "",
        output: bashMsg.output ?? "",
        exitCode: bashMsg.exitCode,
        sourceIndex: msgIndex
      }
    ];
  }
  if (msg.role === "toolResult") {
    return [
      {
        kind: "tool_result",
        name: msg.toolName,
        text: sanitize(textOf(msg.content)),
        isError: msg.isError,
        sourceIndex: msgIndex
      }
    ];
  }
  if (msg.role === "assistant") {
    if (!msg.content) return [];
    if (typeof msg.content === "string") {
      return [
        {
          kind: "assistant",
          text: sanitize(msg.content),
          sourceIndex: msgIndex
        }
      ];
    }
    const blocks = [];
    for (const part of msg.content) {
      if (part.type === "text") {
        blocks.push({
          kind: "assistant",
          text: sanitize(part.text),
          sourceIndex: msgIndex
        });
      } else if (part.type === "thinking") {
        blocks.push({
          kind: "thinking",
          text: sanitize(part.thinking),
          redacted: part.redacted ?? false,
          sourceIndex: msgIndex
        });
      } else if (part.type === "toolCall") {
        blocks.push({
          kind: "tool_call",
          name: part.name,
          args: part.arguments,
          sourceIndex: msgIndex
        });
      }
    }
    return blocks;
  }
  return [];
};
var normalize = (messages) => messages.flatMap((msg, i) => normalizeOne(msg, i));

// src/core/filter-noise.ts
var NOISE_TOOLS = /* @__PURE__ */ new Set([
  "TodoWrite",
  "TodoRead",
  "ToolSearch",
  "WebSearch",
  "AskUser",
  "ExitSpecMode",
  "GenerateDroid"
]);
var NOISE_STRINGS = [
  "Continue from where you left off.",
  "No response requested.",
  "IMPORTANT: TodoWrite was not called yet."
];
var XML_WRAPPER_RE = /<(system-reminder|ide_opened_file|command-message|context-window-usage)[^>]*>[\s\S]*?<\/\1>/g;
var cleanOrNull = (text) => {
  const trimmed = text.trim();
  if (NOISE_STRINGS.some((s) => trimmed.includes(s))) return null;
  const cleaned = trimmed.replace(XML_WRAPPER_RE, "").trim();
  return cleaned.length > 0 ? cleaned : null;
};
var filterNoise = (blocks) => {
  const out = [];
  for (const b of blocks) {
    if (b.kind === "thinking") continue;
    if (b.kind === "tool_call" && NOISE_TOOLS.has(b.name)) continue;
    if (b.kind === "tool_result" && NOISE_TOOLS.has(b.name)) continue;
    if (b.kind === "user") {
      const cleaned = cleanOrNull(b.text);
      if (!cleaned) continue;
      out.push({ ...b, text: cleaned });
      continue;
    }
    out.push(b);
  }
  return out;
};

// src/core/skill-collapse.ts
var SKILL_TAG_RE = /^-?\s*<skill\s+name="([^"]+)"/;
var SKILL_CLOSE_RE = /^-?\s*<\/skill>/;
var collapseSkillLines = (lines) => {
  const result = [];
  const seenSkills = /* @__PURE__ */ new Set();
  let insideSkill = false;
  for (const line of lines) {
    const skillMatch = line.match(SKILL_TAG_RE);
    if (skillMatch) {
      insideSkill = true;
      const name = skillMatch[1];
      if (!seenSkills.has(name)) {
        seenSkills.add(name);
        result.push(`[skill: ${name}]`);
      }
      continue;
    }
    if (insideSkill) {
      if (SKILL_CLOSE_RE.test(line)) insideSkill = false;
      continue;
    }
    result.push(line);
  }
  return result;
};
var SKILL_BLOCK_RE = /<skill\s+name="([^"]+)"[^>]*>[\s\S]*?(?:<\/skill>|$)/g;
var collapseSkillText = (text) => text.replace(SKILL_BLOCK_RE, (_, name) => `[skill: ${name}]`);

// src/extract/goals.ts
var SCOPE_CHANGE_RE = /\b(instead|actually|change of plan|forget that|new task|switch to|now I want|pivot|let'?s do|stop .* and)\b/i;
var TASK_RE = /\b(fix|implement|add|create|build|refactor|debug|investigate|update|remove|delete|migrate|deploy|test|write|set up)\b/i;
var NOISE_SHORT_RE = /^(ok|yes|no|sure|yeah|yep|go|hi|hey|thx|thanks|ok\b.*|y|n|k)\s*[.!?]*$/i;
var NON_GOAL_RE = /^\s*[\[│├└─╭╰]|```|^\s*(=[A-Z]+\(|function |const |let |var |import |export |class )|^(https?:|file:|\/[A-Za-z])|\\n|^\s*For each\b|\bin full\b[^\n]*\b(comments|issue|issues|PRs?|linked)\b/;
var TEMPLATE_SIGNAL_RE = /^\s*(For each\b|Do NOT implement\b|Analyze and propose\b|If Task\/context\b|Output:\s*$)/i;
var truncateAtTemplate = (lines) => {
  const idx = lines.findIndex((l) => TEMPLATE_SIGNAL_RE.test(l));
  return idx >= 0 ? lines.slice(0, idx) : lines;
};
var stripLeadingBullet = (line) => line.replace(/^\s*(?:[-*+]|\d+\.)\s+/, "").trim();
var MAX_GOAL_CHARS = 200;
var isSubstantiveGoal = (text) => {
  const t = text.trim();
  if (t.length <= 5) return false;
  if (t.length > MAX_GOAL_CHARS) return false;
  if (NOISE_SHORT_RE.test(t)) return false;
  if (NON_GOAL_RE.test(t)) return false;
  return true;
};
var FIRST_MSG_CLIP = 80;
var indexSuffix = (sourceIndex) => sourceIndex != null ? ` (#${sourceIndex})` : "";
var LEADING_CHARS = 200;
var extractGoals = (blocks) => {
  const goals = [];
  let latestScopeChange = null;
  let latestScopeIndex;
  for (const b of blocks) {
    if (b.kind !== "user") continue;
    const rawLines = nonEmptyLines(b.text);
    const truncated = truncateAtTemplate(rawLines);
    const lines = collapseSkillLines(truncated.filter(isSubstantiveGoal)).map(stripLeadingBullet).filter((l) => l.length > 5);
    if (lines.length === 0) continue;
    if (goals.length === 0) {
      goals.push(
        ...lines.slice(0, 6).map((l) => clip(l, FIRST_MSG_CLIP) + indexSuffix(b.sourceIndex))
      );
      continue;
    }
    const leading = b.text.slice(0, LEADING_CHARS);
    if (SCOPE_CHANGE_RE.test(leading)) {
      latestScopeChange = lines.slice(0, 3).map((l) => clip(l, MAX_GOAL_CHARS));
      latestScopeIndex = b.sourceIndex;
    } else if (TASK_RE.test(leading) && lines[0].length > 15) {
      latestScopeChange = lines.slice(0, 2).map((l) => clip(l, MAX_GOAL_CHARS));
      latestScopeIndex = b.sourceIndex;
    }
  }
  if (latestScopeChange && latestScopeChange.length > 0) {
    goals.push("[Scope change]");
    for (const line of latestScopeChange) {
      goals.push(line + indexSuffix(latestScopeIndex));
    }
  }
  return goals.slice(0, 8);
};

// src/extract/files.ts
var FILE_READ_TOOLS = /* @__PURE__ */ new Set(["Read", "read_file", "View"]);
var FILE_WRITE_TOOLS = /* @__PURE__ */ new Set([
  "Edit",
  "Write",
  "edit",
  "write",
  "edit_file",
  "write_file",
  "MultiEdit"
]);
var FILE_CREATE_TOOLS = /* @__PURE__ */ new Set();
var longestCommonDirPrefix = (paths) => {
  const normalized = paths.map((p) => p.replace(/\\/g, "/"));
  const abs = normalized.filter((p) => p.startsWith("/") || /^[A-Za-z]:\//.test(p));
  if (abs.length < 2) return "";
  const split = abs.map((p) => p.split("/"));
  const min = Math.min(...split.map((s) => s.length));
  let i = 0;
  while (i < min - 1) {
    const seg = split[0][i];
    if (!split.every((s) => s[i] === seg)) break;
    i++;
  }
  if (i < 2) return "";
  return split[0].slice(0, i).join("/") + "/";
};
var trimPaths = (set, prefix) => {
  if (!prefix) return set;
  const out = /* @__PURE__ */ new Set();
  for (const p of set) {
    out.add(p.startsWith(prefix) ? p.slice(prefix.length) : p);
  }
  return out;
};
var extractFiles = (blocks, fileOps) => {
  const act = {
    read: new Set([]),
    modified: new Set([]),
    created: new Set([])
  };
  for (const b of blocks) {
    if (b.kind !== "tool_call") continue;
    const p = extractPath(b.args);
    if (!p) continue;
    if (FILE_READ_TOOLS.has(b.name)) act.read.add(p);
    if (FILE_WRITE_TOOLS.has(b.name)) act.modified.add(p);
    if (FILE_CREATE_TOOLS.has(b.name)) act.created.add(p);
  }
  const all = [...act.read, ...act.modified, ...act.created];
  const prefix = longestCommonDirPrefix(all);
  if (prefix) {
    act.read = trimPaths(act.read, prefix);
    act.modified = trimPaths(act.modified, prefix);
    act.created = trimPaths(act.created, prefix);
  }
  return act;
};

// src/extract/preferences.ts
var PREF_PATTERNS = [
  /\bprefer(?:s|red|ring)?\s+\w/i,
  /\bdon'?t want\b/i,
  /\balways (?:use|do|run|prefer|keep|make|format|write|add|set|put|prefix|start|include|append)\b/i,
  /\bnever (?:use|do|run|push|commit|write|ignore|add|set|put|remove|delete|include|deploy)\b/i,
  /\bplease (?:use|avoid|keep|make|don'?t|do not|format|write)\b/i,
  /\b(?:style|format|language|naming)\s*[:=]\s*\S/i
];
var extractPreferences = (blocks) => {
  const prefs = [];
  const seen = /* @__PURE__ */ new Set();
  for (const b of blocks) {
    if (b.kind !== "user") continue;
    let perBlock = 0;
    for (const line of nonEmptyLines(b.text)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.length < 5) continue;
      if (trimmed.length > 200) continue;
      if (trimmed.endsWith("?") || trimmed.includes("?...")) continue;
      if (!PREF_PATTERNS.some((p) => p.test(trimmed))) continue;
      const clipped = clip(trimmed, 200);
      const key = clipped.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      prefs.push(clipped);
      if (++perBlock >= 1) break;
    }
  }
  return prefs.slice(0, 10);
};
var dedupPreferencesAgainstGoals = (prefs, goals) => {
  const norm = (s) => s.trim().toLowerCase();
  const goalSet = new Set(goals.map(norm));
  return prefs.filter((p) => !goalSet.has(norm(p)));
};

// src/extract/commits.ts
var COMMIT_MSG_RE = /git\s+commit[^\n]*?-m\s+(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|\$?'((?:[^'\\]|\\.)*)')/;
var HASH_RE = /\b([0-9a-f]{8,12})\b/;
var firstLineOf = (text) => {
  const line = text.split(/\\n|\n/)[0] ?? "";
  return line.trim();
};
var cleanMessage = (msg) => msg.replace(/\\"/g, '"').replace(/\\'/g, "'").trim();
var extractHashFromOutput = (text) => {
  const bracket = text.match(/\[\S+\s+([0-9a-f]{7,12})\]/);
  if (bracket) return bracket[1];
  const range = text.match(/\b([0-9a-f]{7,12})\.\.([0-9a-f]{7,12})\b/);
  if (range) return range[2];
  const plain = text.match(HASH_RE);
  if (plain) return plain[1];
  return void 0;
};
var tryExtractMessage = (cmd) => {
  if (!/\bgit\s+commit\b/.test(cmd)) return void 0;
  const m = cmd.match(COMMIT_MSG_RE);
  if (!m) return void 0;
  const message = firstLineOf(cleanMessage(m[1] ?? m[2] ?? m[3] ?? ""));
  return message || void 0;
};
var extractCommits = (blocks) => {
  const commits = [];
  const addCommit = (hash, message) => {
    const key = `${hash ?? ""}::${message}`;
    if (!commits.some((c) => `${c.hash ?? ""}::${c.message}` === key)) {
      commits.push({ hash, message });
    }
  };
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.kind === "tool_call" && b.name === "bash") {
      const cmd = b.args && typeof b.args.command === "string" ? b.args.command : "";
      const message = tryExtractMessage(cmd);
      if (!message) continue;
      let hash;
      for (let j = i + 1; j < Math.min(blocks.length, i + 3); j++) {
        const r = blocks[j];
        if (r.kind !== "tool_result") continue;
        hash = extractHashFromOutput(r.text);
        if (hash) break;
      }
      addCommit(hash, message);
      continue;
    }
    if (b.kind === "bash") {
      const message = tryExtractMessage(b.command);
      if (!message) continue;
      const hash = extractHashFromOutput(b.output);
      addCommit(hash, message);
      continue;
    }
    if (b.kind === "user") {
      const ranCmd = b.text.match(/Ran\s+`((?:[^`\\]|\\.)*)`/);
      if (!ranCmd) continue;
      const message = tryExtractMessage(ranCmd[1]);
      if (!message) continue;
      const codeBlock = b.text.match(/```\n([\s\S]*?)```/);
      const hash = codeBlock ? extractHashFromOutput(codeBlock[1]) : void 0;
      addCommit(hash, message);
    }
  }
  return commits;
};
var formatCommits = (commits, limit = 8) => {
  const lines = [];
  const items = commits.slice(-limit);
  for (const c of items) {
    const prefix = c.hash ? `${c.hash}: ` : "";
    lines.push(`${prefix}${c.message}`);
  }
  return lines;
};

// src/core/brief.ts
var TRUNCATE_USER = 256;
var TRUNCATE_ASSISTANT = 200;
var SELF_TALK_PREFIX_RE = /^\s*(?:hmm|wait|actually|oh|okay|ok|well|so)[,.!\s-]+/i;
var isNoiseUser = (text) => {
  return !text.trim();
};
var _segmenter = void 0;
var wordSegments = (text) => {
  if (_segmenter) return Array.from(_segmenter.segment(text));
  if (_segmenter === null) {
    const parts = [];
    let idx = 0;
    for (const part of text.split(/(\s+)/)) {
      if (!part) continue;
      parts.push({ segment: part, index: idx, isWordLike: /\S/.test(part) });
      idx += part.length;
    }
    return parts;
  }
  try {
    _segmenter = new Intl.Segmenter(void 0, { granularity: "word" });
    return Array.from(_segmenter.segment(text));
  } catch {
    _segmenter = null;
    const parts = [];
    let idx = 0;
    for (const part of text.split(/(\s+)/)) {
      if (!part) continue;
      parts.push({ segment: part, index: idx, isWordLike: /\S/.test(part) });
      idx += part.length;
    }
    return parts;
  }
};
var isWord = (seg) => !!seg.isWordLike || /[\p{L}\p{N}]/u.test(seg.segment);
var STOP_WORDS = /* @__PURE__ */ new Set([
  "a",
  "an",
  "the",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "shall",
  "can",
  "need",
  "must",
  "to",
  "of",
  "in",
  "for",
  "on",
  "with",
  "at",
  "by",
  "from",
  "as",
  "into",
  "through",
  "during",
  "before",
  "after",
  "above",
  "below",
  "between",
  "under",
  "over",
  "and",
  "but",
  "or",
  "nor",
  "not",
  "so",
  "yet",
  "both",
  "either",
  "neither",
  "each",
  "every",
  "all",
  "any",
  "few",
  "more",
  "most",
  "other",
  "some",
  "such",
  "no",
  "that",
  "this",
  "these",
  "those",
  "it",
  "its",
  "i",
  "me",
  "my",
  "we",
  "our",
  "you",
  "your",
  "he",
  "him",
  "his",
  "she",
  "her",
  "they",
  "them",
  "their",
  "who",
  "which",
  "what",
  "if",
  "then",
  "than",
  "when",
  "where",
  "how",
  "just",
  "also"
]);
var truncateTokens = (text, limit) => {
  const flat = text.replace(/\s+/g, " ").trim();
  let count = 0;
  let lastEnd = 0;
  for (const seg of wordSegments(flat)) {
    if (isWord(seg)) {
      if (!STOP_WORDS.has(seg.segment.toLowerCase())) {
        count++;
        if (count > limit) {
          return flat.slice(0, lastEnd).trimEnd() + "...(truncated)";
        }
      }
    }
    lastEnd = seg.index + seg.segment.length;
  }
  return flat;
};
var BASH_CAP = 120;
var PIPE_TAIL_RE = /\s*\|\s*(?:head|tail|sort|wc|column|tr|cut|uniq)(?:\s[^|]*)?$/;
var compressBash = (raw) => {
  let cmd = raw.split("\n").map((l) => l.trim()).filter(Boolean).join("; ");
  cmd = cmd.replace(/^cd\s+\S+\s*&&\s*/, "");
  for (let i = 0; i < 10; i++) {
    const stripped = cmd.replace(PIPE_TAIL_RE, "");
    if (stripped === cmd) break;
    cmd = stripped;
  }
  if (cmd.length > BASH_CAP) {
    const cut = cmd.lastIndexOf(" ", BASH_CAP - 2);
    const end = cut > BASH_CAP * 0.6 ? cut : BASH_CAP - 3;
    return cmd.slice(0, end).trimEnd() + "...";
  }
  return cmd;
};
var TOOL_SUMMARY_FIELDS = {
  Read: "file_path",
  Edit: "file_path",
  Write: "file_path",
  read: "path",
  edit: "path",
  write: "path",
  Glob: "pattern",
  Grep: "pattern"
};
var toolOneLiner = (name, args) => {
  const field = TOOL_SUMMARY_FIELDS[name];
  if (field && typeof args[field] === "string") {
    return `* ${name} "${args[field]}"`;
  }
  const path = extractPath(args);
  if (path) return `* ${name} "${path}"`;
  if (name === "bash" || name === "Bash") {
    const raw = args.command ?? args.description ?? "";
    const cmd = compressBash(raw);
    return `* ${name} "${cmd}"`;
  }
  if (typeof args.query === "string") {
    return `* ${name} "${clip(args.query, 60)}"`;
  }
  return `* ${name}`;
};
var buildBriefSections = (blocks) => {
  const sections = [];
  let lastHeader = "";
  const push = (header, line) => {
    if (header === lastHeader && sections.length > 0) {
      sections[sections.length - 1].lines.push(line);
      return;
    }
    sections.push({ header, lines: [line] });
    lastHeader = header;
  };
  for (const b of blocks) {
    switch (b.kind) {
      case "user": {
        if (isNoiseUser(b.text)) break;
        const text = truncateTokens(collapseSkillText(b.text), TRUNCATE_USER);
        if (text) {
          const ref = b.sourceIndex != null ? ` (#${b.sourceIndex})` : "";
          push("[user]", text + ref);
        }
        lastHeader = "[user]";
        break;
      }
      case "bash": {
        const cmd = compressBash(b.command);
        const ref = b.sourceIndex != null ? ` (#${b.sourceIndex})` : "";
        if (cmd) {
          push("[user]", `$ ${cmd}${ref}`);
        }
        lastHeader = "[user]";
        break;
      }
      case "assistant": {
        let raw = b.text;
        for (let i = 0; i < 2; i++) {
          const stripped = raw.replace(SELF_TALK_PREFIX_RE, "");
          if (stripped === raw) break;
          raw = stripped;
        }
        const text = truncateTokens(raw, TRUNCATE_ASSISTANT);
        if (text) {
          const ref = b.sourceIndex != null ? ` (#${b.sourceIndex})` : "";
          push("[assistant]", text + ref);
        }
        break;
      }
      case "tool_call": {
        if (!b.name || b.name.trim() === "") break;
        const ref = b.sourceIndex != null ? ` (#${b.sourceIndex})` : "";
        const summary = toolOneLiner(b.name, b.args) + ref;
        push("[assistant]", summary);
        break;
      }
      case "tool_result": {
        if (b.isError) {
          const body = firstLine(b.text, 150);
          if (!body || body === "(no output)") break;
          const ref = b.sourceIndex != null ? ` (#${b.sourceIndex})` : "";
          const header = `[tool_error] ${b.name}${ref}`;
          push(header, body);
          lastHeader = header;
        }
        break;
      }
    }
  }
  for (const sec of sections) {
    if (sec.header !== "[assistant]") continue;
    const out = [];
    for (const line of sec.lines) {
      if (!line.startsWith("* ")) {
        out.push(line);
        continue;
      }
      const ref = line.match(/\(#(\d+)\)$/)?.[1] ?? "";
      const base = ref ? line.slice(0, -(ref.length + 3)).trimEnd() : line;
      const last = out.length > 0 ? out[out.length - 1] : "";
      const m = last.match(/^(.*) \((#[\d, #]+)\) x(\d+)$/);
      if (m && m[1] === base) {
        out[out.length - 1] = `${base} (${m[2]}, #${ref}) x${parseInt(m[3]) + 1}`;
      } else if (last.match(/\(#\d+\)$/) && last.replace(/\s*\(#\d+\)$/, "") === base) {
        const prevRef = last.match(/\(#(\d+)\)$/)?.[1];
        out[out.length - 1] = `${base} (#${prevRef}, #${ref}) x2`;
      } else {
        out.push(line);
      }
    }
    sec.lines = out;
  }
  const TOOL_CALLS_PER_TURN = 8;
  for (const sec of sections) {
    if (sec.header !== "[assistant]") continue;
    const toolIdxs = sec.lines.map((l, i) => l.startsWith("* ") ? i : -1).filter((i) => i >= 0);
    if (toolIdxs.length <= TOOL_CALLS_PER_TURN) continue;
    const dropCount = toolIdxs.length - TOOL_CALLS_PER_TURN;
    const dropSet = new Set(toolIdxs.slice(0, dropCount));
    const firstKeptToolIdx = toolIdxs[dropCount];
    const next = [];
    let inserted = false;
    for (let i = 0; i < sec.lines.length; i++) {
      if (dropSet.has(i)) continue;
      if (!inserted && i === firstKeptToolIdx) {
        next.push(`* (${dropCount} earlier tool-call entries omitted)`);
        inserted = true;
      }
      next.push(sec.lines[i]);
    }
    sec.lines = next;
  }
  const collapsedErrors = [];
  for (const sec of sections) {
    const m = sec.header.match(/^\[tool_error\]\s+(\S+?)(?:\s*\(#(\d+)\))?$/);
    if (!m || sec.lines.length !== 1) {
      collapsedErrors.push(sec);
      continue;
    }
    const tool = m[1];
    const ref = m[2];
    const body = sec.lines[0];
    const prev = collapsedErrors[collapsedErrors.length - 1];
    const prevMatch = prev?.header.match(
      /^\[tool_error\]\s+(\S+?)\s*\(((?:#\d+(?:,\s*)?)+)\)(?:\s*x(\d+))?$/
    );
    if (prev && prevMatch && prevMatch[1] === tool && prev.lines.length === 1 && prev.lines[0] === body) {
      const refs = prevMatch[2] + (ref ? `, #${ref}` : "");
      const count = prevMatch[3] ? parseInt(prevMatch[3]) + 1 : 2;
      prev.header = `[tool_error] ${tool} (${refs}) x${count}`;
    } else {
      collapsedErrors.push(sec);
    }
  }
  sections.length = 0;
  sections.push(...collapsedErrors);
  return sections;
};
var stringifyBrief = (sections) => {
  const out = [];
  for (let i = 0; i < sections.length; i++) {
    const sec = sections[i];
    if (i > 0) {
      const prev = sections[i - 1];
      const prevIsToolLike = prev.header === "[assistant]" && prev.lines.every((l) => l.startsWith("* ")) || prev.header.startsWith("[tool_error]");
      const curIsToolLike = sec.header === "[assistant]" && sec.lines.every((l) => l.startsWith("* ")) || sec.header.startsWith("[tool_error]");
      if (!(prevIsToolLike && curIsToolLike)) {
        out.push("");
      }
    }
    out.push(sec.header);
    for (const line of sec.lines) {
      out.push(line);
    }
  }
  return out.join("\n");
};

// src/core/build-sections.ts
var BLOCKER_RE = /\b(fail(ed|s|ure|ing)?|broken|cannot|can't|won't work|does not work|doesn't work|still (broken|failing|wrong)|blocked|blocker|not (fixed|resolved|working)|crash(es|ed|ing)?)\b/i;
var extractOutstandingContext = (blocks) => {
  const items = [];
  const tail = blocks.slice(-20);
  for (const b of tail) {
    if (b.kind === "tool_result" && b.isError) {
      items.push(`[${b.name}] ${firstLine(b.text, 150)}`);
      continue;
    }
    if (b.kind === "assistant" || b.kind === "user") {
      for (const line of nonEmptyLines(b.text)) {
        if (!BLOCKER_RE.test(line)) continue;
        if (line.length < 15) continue;
        if (/^\s*[-*+>]\s/.test(line)) continue;
        if (/^\s*\(/.test(line)) continue;
        if (!/^\s*["'`*_]?[A-Z`]/.test(line)) continue;
        const clipped = b.kind === "user" ? `[user] ${clipSentence(line, 150)}` : clipSentence(line, 150);
        if (!items.includes(clipped)) items.push(clipped);
        break;
      }
    }
  }
  return items.slice(0, 5);
};
var formatFileActivity = (blocks) => {
  const act = extractFiles(blocks);
  for (const p of act.modified) act.created.delete(p);
  const lines = [];
  const cap = (set, limit) => {
    const arr = [...set];
    if (arr.length <= limit) return arr.join(", ");
    return arr.slice(0, limit).join(", ") + ` (+${arr.length - limit} more)`;
  };
  if (act.modified.size > 0) lines.push(`Modified: ${cap(act.modified, 10)}`);
  if (act.created.size > 0) lines.push(`Created: ${cap(act.created, 10)}`);
  if (act.read.size > 0) lines.push(`Read: ${cap(act.read, 10)}`);
  return lines;
};
var buildSections = (input) => {
  const { blocks } = input;
  const briefSections = buildBriefSections(blocks);
  const sessionGoal = extractGoals(blocks);
  const userPreferences = dedupPreferencesAgainstGoals(extractPreferences(blocks), sessionGoal);
  return {
    sessionGoal,
    outstandingContext: extractOutstandingContext(blocks),
    filesAndChanges: formatFileActivity(blocks),
    commits: formatCommits(extractCommits(blocks)),
    userPreferences,
    briefTranscript: stringifyBrief(briefSections)
  };
};
var section = (title, items) => {
  if (items.length === 0) return "";
  const body = items.map((i) => `- ${i}`).join("\n");
  return `[${title}]
${body}`;
};
var BRIEF_MAX_LINES = 120;
var TUI_SAFE_LINE_CHARS = 120;
function wrapLineWithContinuation(line, maxChars) {
  const indent = line.match(/^\s*(?:[-*]\s+|\d+\.\s+)?/)?.[0] ?? "";
  const continuationIndent = indent ? " ".repeat(Math.min(indent.length, 8)) : "";
  const safeMaxChars = continuationIndent ? maxChars - continuationIndent.length : maxChars;
  const wrapped = wrapTextWithAnsi(line, safeMaxChars);
  if (wrapped.length <= 1 || !continuationIndent) return wrapped;
  return [wrapped[0], ...wrapped.slice(1).map((l) => continuationIndent + l)];
}
var wrapLongLines = (text, maxChars = TUI_SAFE_LINE_CHARS) => text.split("\n").flatMap((line) => wrapLineWithContinuation(line, maxChars)).join("\n");
var capBrief = (text) => {
  const lines = text.split("\n");
  if (lines.length <= BRIEF_MAX_LINES) return text;
  const kept = lines.slice(-BRIEF_MAX_LINES);
  let firstHeader = kept.findIndex((l) => /^\[.+\]/.test(l));
  if (firstHeader < 0) {
    const anyAnchor = kept.findIndex((l) => /^\[[^\]]+\]/.test(l));
    if (anyAnchor > 0) firstHeader = anyAnchor;
  }
  const clean = firstHeader > 0 ? kept.slice(firstHeader) : kept;
  const omitted = lines.length - clean.length;
  return `...(${omitted} earlier lines omitted)

${clean.join("\n")}`;
};
var RECALL_NOTE = "The conversation before this point has been compacted into the summary above. Details not captured here \u2014 exact code, error messages, file paths \u2014 are only recoverable via `recall`. Use `recall` to search the session history. Do not redo work already completed.";
var formatSummary = (data) => {
  const headerParts = [
    section("Session Goal", data.sessionGoal),
    section("Files And Changes", data.filesAndChanges),
    section("Commits", data.commits),
    section("Outstanding Context", data.outstandingContext),
    section("User Preferences", data.userPreferences)
  ].filter(Boolean);
  const parts = [];
  if (headerParts.length > 0) {
    parts.push(headerParts.join("\n\n"));
  }
  if (data.briefTranscript) {
    parts.push(capBrief(data.briefTranscript));
  }
  if (parts.length === 0) return "";
  return wrapLongLines(parts.join("\n\n---\n\n"));
};

// src/core/summarize.ts
var HEADER_NAMES = [
  "Session Goal",
  "Files And Changes",
  "Commits",
  "Outstanding Context",
  "User Preferences"
];
var SEPARATOR = "\n\n---\n\n";
var sectionOf = (text, header) => {
  const tag = `[${header}]`;
  const start = text.indexOf(tag);
  if (start < 0) return "";
  const after = text.slice(start);
  const nextSection = HEADER_NAMES.filter((h) => h !== header).map((h) => {
    const escaped = h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(?:^|\\n)\\[${escaped}\\]`);
    const m = after.match(re);
    if (!m) return -1;
    return m.index + (m[0].startsWith("\n") ? 1 : 0);
  }).filter((n) => n >= 0);
  const nextSep = after.indexOf("\n\n---\n\n");
  const candidates = [...nextSection, ...nextSep > 0 ? [nextSep] : []].sort((a, b) => a - b);
  const end = candidates[0];
  return (end ? after.slice(0, end) : after).trim();
};
var briefOf = (text) => {
  const idx = text.indexOf(SEPARATOR);
  if (idx < 0) return "";
  return text.slice(idx + SEPARATOR.length).trim();
};
var mergeHeaderSection = (header, prev, fresh) => {
  if (header === "Outstanding Context") return fresh;
  if (!prev) return fresh;
  if (!fresh) return prev;
  if (header === "Files And Changes") {
    return mergeFileLines(prev, fresh);
  }
  const isClean = (l) => l.startsWith("- ") && !l.includes("<skill") && !l.includes("</skill");
  const prevLines = prev.split("\n").filter(isClean);
  const freshLines = fresh.split("\n").filter(isClean);
  const combined = [.../* @__PURE__ */ new Set([...prevLines, ...freshLines])];
  const CAP = header === "Session Goal" ? 8 : header === "Commits" ? 8 : 15;
  const capped = combined.length > CAP ? header === "Session Goal" ? combined.slice(0, CAP) : combined.slice(-CAP) : combined;
  if (capped.length === 0) return "";
  return `[${header}]
${capped.join("\n")}`;
};
var mergeFileLines = (prev, fresh) => {
  const categories = ["Modified", "Created", "Read"];
  const merged = {};
  for (const cat of categories) merged[cat] = /* @__PURE__ */ new Set();
  for (const text of [prev, fresh]) {
    for (const line of text.split("\n")) {
      for (const cat of categories) {
        const prefix = `- ${cat}: `;
        if (!line.startsWith(prefix)) continue;
        let rest = line.slice(prefix.length);
        rest = rest.replace(/\s*\(\+\d+ more\)\s*$/, "");
        for (const p of rest.split(",")) {
          const trimmed = p.trim();
          if (trimmed) merged[cat].add(trimmed);
        }
      }
    }
  }
  for (const p of merged.Modified) merged.Created.delete(p);
  for (const p of merged.Modified) merged.Read.delete(p);
  const cap = (set, limit) => {
    const arr = [...set];
    if (arr.length <= limit) return arr.join(", ");
    return arr.slice(0, limit).join(", ") + ` (+${arr.length - limit} more)`;
  };
  const lines = [];
  if (merged.Modified.size > 0) lines.push(`- Modified: ${cap(merged.Modified, 10)}`);
  if (merged.Created.size > 0) lines.push(`- Created: ${cap(merged.Created, 10)}`);
  if (merged.Read.size > 0) lines.push(`- Read: ${cap(merged.Read, 10)}`);
  if (lines.length === 0) return "";
  return `[Files And Changes]
${lines.join("\n")}`;
};
var mergeBriefTranscript = (prev, fresh) => {
  if (!prev) return fresh;
  if (!fresh) return prev;
  return prev + "\n\n" + fresh;
};
var mergePrevious = (prev, fresh) => {
  const headers = HEADER_NAMES.map((header) => {
    const freshSec = sectionOf(fresh, header);
    const prevSec = sectionOf(prev, header);
    return mergeHeaderSection(header, prevSec, freshSec);
  }).filter(Boolean);
  const prevBrief = briefOf(prev);
  const freshBrief = briefOf(fresh);
  const mergedBrief = mergeBriefTranscript(prevBrief, freshBrief);
  const parts = [];
  if (headers.length > 0) {
    parts.push(headers.join("\n\n"));
  }
  if (mergedBrief) {
    parts.push(capBrief(mergedBrief));
  }
  return parts.join(SEPARATOR);
};
var compileFresh = (input) => {
  const blocks = filterNoise(normalize(input.messages));
  const data = buildSections({ blocks });
  return formatSummary(data);
};
var compileSegment = (input) => {
  const fresh = compileFresh(input);
  return fresh ? wrapLongLines(fresh) : "";
};
var compile = (input) => {
  const fresh = compileFresh(input);
  let prev = input.previousSummary ? stripOMContent(input.previousSummary) : void 0;
  prev = prev ? stripRecallNotes(prev) : void 0;
  const merged = prev ? mergePrevious(prev, fresh) : fresh;
  if (!merged) return "";
  const cleaned = stripRecallNotes(merged);
  return wrapLongLines(cleaned + SEPARATOR + RECALL_NOTE);
};
var RECALL_NOTE_MARKER = "The conversation before this point has been compacted";
var extractRecallNote = (text) => text.split(/\n\n+/).find((paragraph) => paragraph.includes(RECALL_NOTE_MARKER))?.trim() ?? "";
var stripRecallNotes = (text) => {
  const paragraphs = text.split(/\n\n+/);
  const kept = paragraphs.filter((p) => !p.includes(RECALL_NOTE_MARKER));
  return kept.join("\n\n");
};
var stripOMContent = (text) => {
  const reflMatch = text.match(/^## Reflections/m);
  const reflIdx = reflMatch ? reflMatch.index : -1;
  const obsMatch = text.match(/^## Observations/m);
  const obsIdx = obsMatch ? obsMatch.index : -1;
  const basicFooterIdx = text.indexOf(
    "Use `recall` with an id to retrieve original context, or `#N:path` drill-down"
  );
  let stripFrom = -1;
  if (reflIdx >= 0 || obsIdx >= 0) {
    const preambleIdx = text.indexOf("These are condensed memories from earlier in this session.");
    const minSectionIdx = Math.min(
      reflIdx >= 0 ? reflIdx : Infinity,
      obsIdx >= 0 ? obsIdx : Infinity
    );
    if (preambleIdx >= 0 && preambleIdx < minSectionIdx) {
      stripFrom = preambleIdx;
    } else if (minSectionIdx < Infinity) {
      stripFrom = minSectionIdx;
    }
  } else if (basicFooterIdx >= 0) {
    stripFrom = basicFooterIdx;
  }
  if (stripFrom < 0) return text;
  let end = stripFrom;
  while (end > 0 && /\s/.test(text[end - 1])) end--;
  const beforeEnd = text.slice(0, end).trimEnd();
  if (beforeEnd.endsWith("---")) {
    return beforeEnd.slice(0, beforeEnd.length - 3).trimEnd();
  }
  return beforeEnd;
};

// src/details.ts
var isRecord2 = (value) => typeof value === "object" && value !== null;
var isStringArray = (value) => Array.isArray(value) && value.every((item) => typeof item === "string");
function isPiVccCompactionDetailsV2(value) {
  if (!isRecord2(value)) return false;
  if (value.compactor !== "blackhole" || value.version !== 2 || value.summaryMode !== "append" || typeof value.chainStart !== "boolean" || typeof value.trailingSummary !== "string" || !isStringArray(value.sections) || !Number.isInteger(value.sourceMessageCount) || value.sourceMessageCount < 1 || typeof value.previousSummaryUsed !== "boolean") {
    return false;
  }
  if (!isRecord2(value.segment)) return false;
  const segment = value.segment;
  if (!Number.isInteger(segment.sequence) || segment.sequence < 1 || typeof segment.summary !== "string" || segment.summary.trim().length === 0 || !Number.isFinite(segment.tokensBefore) || segment.tokensBefore < 0 || !isRecord2(segment.coverage)) {
    return false;
  }
  const sequence = segment.sequence;
  if (value.chainStart && sequence !== 1 || !value.chainStart && sequence === 1) {
    return false;
  }
  const coverage = segment.coverage;
  if (typeof coverage.firstCoveredEntryId !== "string" || coverage.firstCoveredEntryId.length === 0 || typeof coverage.lastCoveredEntryId !== "string" || coverage.lastCoveredEntryId.length === 0 || typeof coverage.firstKeptEntryId !== "string" || !Number.isInteger(coverage.sourceMessageCount) || coverage.sourceMessageCount < 1) {
    return false;
  }
  if (coverage.includesLegacySummary !== void 0 && typeof coverage.includesLegacySummary !== "boolean") {
    return false;
  }
  if (coverage.rebasedFromCompactionId !== void 0 && (typeof coverage.rebasedFromCompactionId !== "string" || coverage.rebasedFromCompactionId.length === 0)) {
    return false;
  }
  return true;
}
function estimateStringTokens(text) {
  return Math.ceil(text.length / 4);
}
function getUsageTokens(msg) {
  if (typeof msg !== "object" || msg === null) return void 0;
  const record = msg;
  if (record.role !== "assistant") return void 0;
  if (record.stopReason === "error" || record.stopReason === "aborted") return void 0;
  if (record.usage === void 0) return void 0;
  try {
    const tokens = calculateContextTokens(
      record.usage
    );
    if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens <= 0) return void 0;
    return tokens;
  } catch {
    return void 0;
  }
}
function estimateEntryTokens(entry) {
  if (entry.type === "message" && entry.message) {
    return estimateTokens(entry.message);
  }
  if (entry.type === "custom_message" && entry.content) {
    const content = entry.content;
    if (typeof content === "string") return estimateStringTokens(content);
    if (Array.isArray(content)) {
      let total = 0;
      for (const block of content) {
        if (block.type === "text" && block.text) total += estimateStringTokens(block.text);
      }
      return total;
    }
  }
  if (entry.type === "branch_summary" && typeof entry.summary === "string") {
    return estimateStringTokens(entry.summary);
  }
  return 0;
}

// src/core/compaction-chain.ts
var MAX_CHAIN_WINDOW_RATIO = 0.5;
function estimateChainTokens(segments, freshSummary, trailingSummary) {
  const chars = segments.reduce((total, item) => total + item.segment.summary.length, 0);
  return Math.ceil((chars + freshSummary.length + trailingSummary.length) / 4);
}
var SOURCE_ENTRY_TYPES = /* @__PURE__ */ new Set(["message", "custom_message", "branch_summary"]);
function projectChainTokens(segments, freshSummary, trailingSummary, branchEntries, coverage) {
  const fallback = estimateChainTokens(segments, freshSummary, trailingSummary);
  const latestEntry = segments[segments.length - 1]?.entry;
  if (!latestEntry || segments.length === 0) return fallback;
  let latestIndex = -1;
  for (let index = branchEntries.length - 1; index >= 0; index -= 1) {
    if (branchEntries[index] === latestEntry) {
      latestIndex = index;
      break;
    }
  }
  if (latestIndex < 0) return fallback;
  let usageTokens;
  for (let index = branchEntries.length - 1; index > latestIndex; index -= 1) {
    const candidate = getUsageTokens(branchEntries[index]?.message);
    if (candidate !== void 0) {
      usageTokens = candidate;
      break;
    }
  }
  if (usageTokens === void 0) return fallback;
  let firstIndex = -1;
  let lastIndex = -1;
  for (let index = latestIndex + 1; index < branchEntries.length; index += 1) {
    const id = branchEntries[index]?.id;
    if (id === coverage.firstCoveredEntryId) firstIndex = index;
    if (id === coverage.lastCoveredEntryId) lastIndex = index;
  }
  if (firstIndex < 0 || lastIndex < firstIndex) return fallback;
  let coveredTokens = 0;
  for (let index = firstIndex; index <= lastIndex; index += 1) {
    const entry = branchEntries[index];
    if (!entry || typeof entry.type !== "string" || !SOURCE_ENTRY_TYPES.has(entry.type)) {
      continue;
    }
    const { type, message, summary } = entry;
    coveredTokens += estimateEntryTokens({ type, message, summary });
  }
  const projected = usageTokens - coveredTokens + Math.ceil(freshSummary.length / 4);
  if (!Number.isFinite(projected) || projected < 0) return fallback;
  return projected;
}
var findLatestCompactionEntry = (branchEntries) => {
  for (let index = branchEntries.length - 1; index >= 0; index -= 1) {
    if (branchEntries[index]?.type === "compaction") {
      return branchEntries[index];
    }
  }
  return void 0;
};
function collectActiveSegments(branchEntries) {
  let latestIndex = -1;
  for (let index = branchEntries.length - 1; index >= 0; index -= 1) {
    if (branchEntries[index]?.type === "compaction") {
      latestIndex = index;
      break;
    }
  }
  if (latestIndex < 0) return { ok: false, reason: "no-compaction" };
  const latest = branchEntries[latestIndex];
  if (!isPiVccCompactionDetailsV2(latest?.details)) {
    return { ok: false, reason: "latest-not-append" };
  }
  const reversed = [];
  let expectedSequence = latest.details.segment.sequence;
  for (let index = latestIndex; index >= 0; index -= 1) {
    const entry = branchEntries[index];
    if (entry?.type !== "compaction") continue;
    if (!isPiVccCompactionDetailsV2(entry.details)) {
      return { ok: false, reason: "invalid-chain-entry" };
    }
    if (entry.details.segment.sequence !== expectedSequence) {
      return { ok: false, reason: "invalid-sequence" };
    }
    reversed.push({
      entry,
      details: entry.details,
      segment: entry.details.segment
    });
    if (entry.details.chainStart) {
      if (entry.details.segment.sequence !== 1) {
        return { ok: false, reason: "invalid-sequence" };
      }
      return { ok: true, segments: reversed.reverse() };
    }
    expectedSequence -= 1;
    if (expectedSequence < 1) {
      return { ok: false, reason: "invalid-sequence" };
    }
  }
  return { ok: false, reason: "missing-chain-start" };
}
function coverageForMessages(branchEntries, selectedIds, firstKeptEntryId) {
  if (selectedIds.length === 0) return void 0;
  const wanted = new Set(selectedIds);
  if (wanted.size !== selectedIds.length) return void 0;
  const covered = branchEntries.filter(
    (entry) => entry.type === "message" && entry.id && wanted.has(entry.id)
  );
  if (covered.length !== wanted.size) return void 0;
  const first = covered[0]?.id;
  const last = covered[covered.length - 1]?.id;
  if (!first || !last) return void 0;
  return {
    firstCoveredEntryId: first,
    lastCoveredEntryId: last,
    firstKeptEntryId,
    sourceMessageCount: covered.length
  };
}
var mergeRebaseCoverage = (activeSegments, current, legacyCompactionId, markLegacy = Boolean(legacyCompactionId)) => {
  const firstPrior = activeSegments[0]?.segment.coverage;
  const priorCount = activeSegments.reduce(
    (total, item) => total + item.segment.coverage.sourceMessageCount,
    0
  );
  const inheritedLegacy = activeSegments.some(
    (item) => item.segment.coverage.includesLegacySummary === true
  );
  const inheritedLegacyId = activeSegments.map((item) => item.segment.coverage.rebasedFromCompactionId).find((id) => typeof id === "string" && id.length > 0);
  return {
    firstCoveredEntryId: firstPrior?.firstCoveredEntryId ?? current.firstCoveredEntryId,
    lastCoveredEntryId: current.lastCoveredEntryId,
    firstKeptEntryId: current.firstKeptEntryId,
    sourceMessageCount: priorCount + current.sourceMessageCount,
    ...inheritedLegacy || markLegacy ? { includesLegacySummary: true } : {},
    ...inheritedLegacyId || legacyCompactionId ? {
      rebasedFromCompactionId: inheritedLegacyId ?? legacyCompactionId
    } : {}
  };
};
function renderSegmentCoverageMarker(sequence, coverage) {
  const firstKept = coverage.firstKeptEntryId || "<compact-all>";
  const legacy = coverage.includesLegacySummary ? `; legacySummary=true${coverage.rebasedFromCompactionId ? `; rebasedFrom=${coverage.rebasedFromCompactionId}` : ""}` : "";
  return [
    `[Memory Append Segment ${sequence}]`,
    `Coverage: ${coverage.firstCoveredEntryId}..${coverage.lastCoveredEntryId}; firstKept=${firstKept}; sourceMessages=${coverage.sourceMessageCount}${legacy}`,
    "Read segments in sequence. Later segments override earlier conflicting state."
  ].join("\n");
}
var createSegment = (sequence, vccSummary, coverage, tokensBefore) => {
  const content = vccSummary.trim();
  if (!content) throw new Error("append segment summary is empty");
  return {
    sequence,
    summary: `${renderSegmentCoverageMarker(sequence, coverage)}

${content}`,
    coverage,
    tokensBefore
  };
};
function buildAppendOnlyDetails(input) {
  const chain = collectActiveSegments(input.branchEntries);
  const latestCompaction = findLatestCompactionEntry(input.branchEntries);
  if (latestCompaction && !input.previousSummaryUsed) {
    throw new Error("append compaction requires the previous complete fallback summary");
  }
  const latestDetails = latestCompaction?.details;
  const latestClaimsAppendOnly = typeof latestDetails === "object" && latestDetails !== null && (latestDetails.version === 2 || latestDetails.summaryMode === "append");
  if (!chain.ok && (chain.reason === "invalid-chain-entry" || chain.reason === "invalid-sequence" || chain.reason === "missing-chain-start" || chain.reason === "latest-not-append" && latestClaimsAppendOnly)) {
    throw new Error(`append chain is invalid: ${chain.reason}`);
  }
  const chainOvergrown = chain.ok && input.contextWindowTokens !== void 0 && projectChainTokens(
    chain.segments,
    input.freshSummary,
    input.trailingSummary,
    input.branchEntries,
    input.currentCoverage
  ) > Math.floor(input.contextWindowTokens * MAX_CHAIN_WINDOW_RATIO);
  const mustRebase = input.manualRebase || !chain.ok || chainOvergrown;
  let segment;
  let chainStart;
  if (mustRebase) {
    const activeSegments = chain.ok ? chain.segments : [];
    const inheritedOffChain = !chain.ok && input.previousSummaryUsed;
    const legacyCompactionId = inheritedOffChain && latestCompaction?.id ? latestCompaction.id : void 0;
    const coverage = mergeRebaseCoverage(
      activeSegments,
      input.currentCoverage,
      legacyCompactionId,
      inheritedOffChain
    );
    segment = createSegment(1, input.aggregateSummary, coverage, input.tokensBefore);
    chainStart = true;
  } else {
    const last = chain.segments[chain.segments.length - 1];
    if (!last) throw new Error("append chain has no active segment");
    segment = createSegment(
      last.segment.sequence + 1,
      input.freshSummary,
      input.currentCoverage,
      input.tokensBefore
    );
    chainStart = false;
  }
  return {
    compactor: "blackhole",
    version: 2,
    summaryMode: "append",
    chainStart,
    segment,
    trailingSummary: input.trailingSummary,
    sections: input.sections,
    sourceMessageCount: input.currentCoverage.sourceMessageCount,
    previousSummaryUsed: input.previousSummaryUsed
  };
}
var timestampOf = (entry, fallback) => {
  if (typeof entry.timestamp === "number" && Number.isFinite(entry.timestamp)) {
    return entry.timestamp;
  }
  if (typeof entry.timestamp === "string") {
    const parsed = Date.parse(entry.timestamp);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
};
function projectAppendOnlyContext(messages, branchEntries) {
  const latest = findLatestCompactionEntry(branchEntries);
  if (!latest || !isPiVccCompactionDetailsV2(latest.details)) return messages;
  if (typeof latest.summary !== "string") return messages;
  const chain = collectActiveSegments(branchEntries);
  if (!chain.ok) return messages;
  const fallbackIndexes = messages.map(
    (message, index) => message?.role === "compactionSummary" && message?.summary === latest.summary ? index : -1
  ).filter((index) => index >= 0);
  if (fallbackIndexes.length !== 1) return messages;
  const fallbackIndex = fallbackIndexes[0];
  const segmentMessages = chain.segments.map((item, index) => ({
    role: "compactionSummary",
    summary: item.segment.summary,
    tokensBefore: item.segment.tokensBefore,
    timestamp: timestampOf(item.entry, index)
  }));
  const trailing = latest.details.trailingSummary.trim();
  const tailMessages = trailing ? [
    {
      role: "custom",
      customType: "blackhole-compaction-tail",
      content: trailing,
      display: false,
      details: { compactor: "blackhole", version: 2 },
      timestamp: timestampOf(latest, segmentMessages.length)
    }
  ] : [];
  return [
    ...messages.slice(0, fallbackIndex),
    ...segmentMessages,
    ...tailMessages,
    ...messages.slice(fallbackIndex + 1)
  ];
}

// src/core/provider-skip.ts
function isProviderModel(model) {
  if (model === null || typeof model !== "object" || !("provider" in model)) {
    return false;
  }
  const { provider } = model;
  return typeof provider === "string" && provider.length > 0;
}
function getModelProvider(model) {
  return isProviderModel(model) ? model.provider : void 0;
}
function matchesSkippedProvider(config2, model) {
  const list = config2.skipForProviders;
  if (!list || list.length === 0 || !isProviderModel(model)) return false;
  for (const entry of list) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    const [entryProvider, entryApi] = trimmed.split(":", 2);
    if (entryProvider !== model.provider) continue;
    if (entryApi === void 0 || (entryApi === "" ? model.api === void 0 : entryApi === model.api)) {
      return true;
    }
  }
  return false;
}

// src/om/ledger/types.ts
var OM_OBSERVATIONS_RECORDED = "om.observations.recorded";
var OM_REFLECTIONS_RECORDED = "om.reflections.recorded";
var OM_OBSERVATIONS_DROPPED = "om.observations.dropped";
var OM_FOLDED = "om.folded";
var RELEVANCE_VALUES = ["low", "medium", "high", "critical"];
var MEMORY_ID_PATTERN = /^[a-f0-9]{12}$/i;
function isRelevance(value) {
  return typeof value === "string" && RELEVANCE_VALUES.includes(value);
}
function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}
function isNonEmptyStringArray(value) {
  return Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString);
}
function isMemoryId(value) {
  return typeof value === "string" && MEMORY_ID_PATTERN.test(value);
}
function isTokenCount(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function isPlainRecord(value) {
  return !!value && typeof value === "object";
}
function isObservation(value) {
  if (!isPlainRecord(value)) return false;
  return isMemoryId(value.id) && isNonEmptyString(value.content) && isNonEmptyString(value.timestamp) && isRelevance(value.relevance) && isNonEmptyStringArray(value.sourceEntryIds) && isTokenCount(value.tokenCount);
}
function isReflection(value) {
  if (!isPlainRecord(value)) return false;
  return isMemoryId(value.id) && isNonEmptyString(value.content) && !/\r|\n/.test(value.content) && isNonEmptyStringArray(value.supportingObservationIds) && isTokenCount(value.tokenCount);
}
function isObservationsRecordedData(value) {
  if (!isPlainRecord(value)) return false;
  return Array.isArray(value.observations) && value.observations.length > 0 && value.observations.every(isObservation) && isNonEmptyString(value.coversUpToId);
}
function isReflectionsRecordedData(value) {
  if (!isPlainRecord(value)) return false;
  return Array.isArray(value.reflections) && value.reflections.length > 0 && value.reflections.every(isReflection) && isNonEmptyString(value.coversUpToId);
}
function isObservationsDroppedData(value) {
  if (!isPlainRecord(value)) return false;
  return isNonEmptyStringArray(value.observationIds) && isNonEmptyString(value.coversUpToId);
}
function isMemoryDetails(value) {
  if (!isPlainRecord(value)) return false;
  return value.type === OM_FOLDED && value.version === 1 && typeof value.fullFold === "boolean" && Array.isArray(value.observations) && value.observations.every(isObservation) && Array.isArray(value.reflections) && value.reflections.every(isReflection);
}
function isObservationsRecordedEntry(entry) {
  return entry.type === "custom" && entry.customType === OM_OBSERVATIONS_RECORDED && isObservationsRecordedData(entry.data);
}
function isReflectionsRecordedEntry(entry) {
  return entry.type === "custom" && entry.customType === OM_REFLECTIONS_RECORDED && isReflectionsRecordedData(entry.data);
}
function isObservationsDroppedEntry(entry) {
  return entry.type === "custom" && entry.customType === OM_OBSERVATIONS_DROPPED && isObservationsDroppedData(entry.data);
}
function buildObservationsRecordedData(observations, coversUpToId) {
  if (observations.length === 0 || !isNonEmptyString(coversUpToId)) return void 0;
  return { observations, coversUpToId };
}
function buildReflectionsRecordedData(reflections, coversUpToId) {
  if (reflections.length === 0 || !isNonEmptyString(coversUpToId)) return void 0;
  return { reflections, coversUpToId };
}
function buildObservationsDroppedData(observationIds, coversUpToId) {
  if (observationIds.length === 0 || !isNonEmptyString(coversUpToId)) return void 0;
  return { observationIds, coversUpToId };
}

// src/om/ledger/progress.ts
var SOURCE_ENTRY_TYPES2 = /* @__PURE__ */ new Set(["message", "custom_message", "branch_summary"]);
function isSourceEntry(entry) {
  return SOURCE_ENTRY_TYPES2.has(entry.type);
}
function entryIndexById(entries) {
  const idToIndex = /* @__PURE__ */ new Map();
  for (let i = 0; i < entries.length; i++) idToIndex.set(entries[i].id, i);
  return idToIndex;
}
function entryIndexForId(entries, entryId) {
  if (!entryId) return -1;
  const idx = entryIndexById(entries).get(entryId);
  return idx ?? -1;
}
function isObject(value) {
  return typeof value === "object" && value !== null;
}
function isNonEmptyArray(value) {
  return Array.isArray(value) && value.length > 0;
}
function isValidCoverageEntry(entry, customType) {
  if (entry.type !== "custom" || entry.customType !== customType) return false;
  if (!isObject(entry.data) || typeof entry.data.coversUpToId !== "string") return false;
  if (customType === OM_OBSERVATIONS_RECORDED) return isNonEmptyArray(entry.data.observations);
  if (customType === OM_REFLECTIONS_RECORDED) return isNonEmptyArray(entry.data.reflections);
  return isNonEmptyArray(entry.data.observationIds);
}
function latestCoverageIndex(entries, customType) {
  const idToIndex = entryIndexById(entries);
  let latest = -1;
  for (const entry of entries) {
    if (!isValidCoverageEntry(entry, customType)) continue;
    const coveredIndex = idToIndex.get(entry.data.coversUpToId);
    if (coveredIndex === void 0) continue;
    if (coveredIndex > latest) latest = coveredIndex;
  }
  return latest;
}
function latestCoverageMarkerId(entries, customType) {
  const idToIndex = entryIndexById(entries);
  let latestIndex = -1;
  let latestMarkerId;
  for (const entry of entries) {
    if (!isValidCoverageEntry(entry, customType)) continue;
    const coveredIndex = idToIndex.get(entry.data.coversUpToId);
    if (coveredIndex === void 0) continue;
    if (coveredIndex > latestIndex) {
      latestIndex = coveredIndex;
      latestMarkerId = entry.data.coversUpToId;
    }
  }
  return latestMarkerId;
}
function earlierCoverageMarkerId(entries, firstId, secondId) {
  if (!firstId) return secondId;
  if (!secondId) return firstId;
  const idToIndex = entryIndexById(entries);
  const firstIndex = idToIndex.get(firstId);
  const secondIndex = idToIndex.get(secondId);
  if (firstIndex === void 0) return secondIndex === void 0 ? void 0 : secondId;
  if (secondIndex === void 0) return firstId;
  return firstIndex <= secondIndex ? firstId : secondId;
}
function rawTokensAfterIndex(entries, index) {
  let total = 0;
  for (let i = Math.max(0, index + 1); i < entries.length; i++) {
    if (isSourceEntry(entries[i])) total += estimateEntryTokens(entries[i]);
  }
  return total;
}
function rawTokensSinceCoverage(entries, customType) {
  return rawTokensAfterIndex(entries, latestCoverageIndex(entries, customType));
}
function rawTokensSinceObservationCoverage(entries) {
  return rawTokensSinceCoverage(entries, OM_OBSERVATIONS_RECORDED);
}
function rawTokensSinceReflectionCoverage(entries) {
  return rawTokensSinceCoverage(entries, OM_REFLECTIONS_RECORDED);
}
function rawTokensSinceDropCoverage(entries) {
  return rawTokensSinceCoverage(entries, OM_OBSERVATIONS_DROPPED);
}
function findLastCompactionIndex(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].type === "compaction") return i;
  }
  return -1;
}
function lastValidUsageIndex(entries, beforeIndex, fromIndex = 0) {
  for (let i = Math.min(beforeIndex, entries.length - 1); i >= fromIndex; i--) {
    if (getUsageTokens(entries[i].message) !== void 0) return i;
  }
  return -1;
}
function realContextTokens(entries) {
  const compactionIndex = findLastCompactionIndex(entries);
  const scanStart = compactionIndex === -1 ? 0 : compactionIndex + 1;
  const usageIndex = lastValidUsageIndex(entries, entries.length - 1, scanStart);
  if (usageIndex === -1) return void 0;
  const usage = getUsageTokens(entries[usageIndex].message);
  if (usage === void 0) return void 0;
  return usage + rawTokensAfterIndex(entries, usageIndex);
}
function rawTokensSinceLastCompaction(entries) {
  const real = realContextTokens(entries);
  if (real !== void 0) return real;
  const compactionIndex = findLastCompactionIndex(entries);
  if (compactionIndex === -1) return rawTokensAfterIndex(entries, -1);
  const firstKeptEntryId = entries[compactionIndex].firstKeptEntryId;
  const firstKeptIndex = entryIndexForId(entries, firstKeptEntryId);
  if (firstKeptIndex === -1) return rawTokensAfterIndex(entries, compactionIndex);
  return rawTokensAfterIndex(entries, firstKeptIndex - 1);
}
function observationsCreatedAfterIndex(entries, sinceIndex) {
  const observations = [];
  const seen = /* @__PURE__ */ new Set();
  for (let i = sinceIndex + 1; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.type !== "custom") continue;
    if (entry.customType !== OM_OBSERVATIONS_RECORDED) continue;
    if (!isObservationsRecordedData(entry.data)) continue;
    for (const obs of entry.data.observations) {
      if (!seen.has(obs.id)) {
        seen.add(obs.id);
        observations.push(obs);
      }
    }
  }
  return observations;
}
function reflectionsCreatedAfterIndex(entries, sinceIndex) {
  const reflections = [];
  const seen = /* @__PURE__ */ new Set();
  for (let i = sinceIndex + 1; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.type !== "custom") continue;
    if (entry.customType !== OM_REFLECTIONS_RECORDED) continue;
    if (!isReflectionsRecordedData(entry.data)) continue;
    for (const ref of entry.data.reflections) {
      if (!seen.has(ref.id)) {
        seen.add(ref.id);
        reflections.push(ref);
      }
    }
  }
  return reflections;
}
function buildExistingObservationsSummary(observations, maxTokens) {
  const lines = [];
  let tokens = 0;
  for (const obs of observations) {
    const line = `[${obs.id}] ${obs.timestamp} [${obs.relevance}] ${obs.content}`;
    const lineTokens = Math.ceil(line.length / 4);
    if (tokens + lineTokens > maxTokens && lines.length > 0) break;
    lines.push(line);
    tokens += lineTokens;
  }
  return lines.join("\n");
}
function buildExistingReflectionsSummary(reflections, maxTokens) {
  const lines = [];
  let tokens = 0;
  for (const ref of reflections) {
    const line = `[${ref.id}] ${ref.content}`;
    const lineTokens = Math.ceil(line.length / 4);
    if (tokens + lineTokens > maxTokens && lines.length > 0) break;
    lines.push(line);
    tokens += lineTokens;
  }
  return lines.join("\n");
}
var DEBUG_LOG_MAX_BYTES = 10 * 1024 * 1024;
var DEBUG_LOG_RELATIVE_PATH = join("pi-blackhole", "debug.ndjson");
var storage = new AsyncLocalStorage();
function withDebugLogContext(context, fn) {
  const parent = storage.getStore();
  return storage.run({ ...parent, ...context }, fn);
}
var BUFFER_FLUSH_MS = 1e3;
var FLUSH_IDLE_MS = 1e4;
var buffer = [];
var flushTimer = null;
var flushing = false;
var lastWriteMs = 0;
function ensureFlushTimer() {
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    if (buffer.length === 0 && lastWriteMs > 0 && Date.now() - lastWriteMs > FLUSH_IDLE_MS) {
      clearInterval(flushTimer);
      flushTimer = null;
      return;
    }
    flushBuffer().catch(() => {
    });
  }, BUFFER_FLUSH_MS);
  if (flushTimer && typeof flushTimer === "object" && "unref" in flushTimer) {
    flushTimer.unref();
  }
}
async function flushBuffer() {
  if (flushing) return;
  if (buffer.length === 0) return;
  flushing = true;
  const batch = buffer;
  buffer = [];
  try {
    const path = join(getAgentDir(), DEBUG_LOG_RELATIVE_PATH);
    mkdirSync(dirname(path), { recursive: true });
    rotateIfNeeded(path);
    await appendFile(path, batch.join(""), "utf-8");
  } catch (error) {
    console.error("memory: debug log write failed", error);
  } finally {
    flushing = false;
  }
}
process.on("exit", () => {
  flushDebugLog();
});
function debugLog(event, data = {}, forceEnabled) {
  const context = storage.getStore();
  const enabled = forceEnabled ?? context?.enabled ?? false;
  if (enabled !== true) return;
  const payload = {
    ts: (/* @__PURE__ */ new Date()).toISOString(),
    event,
    cwd: context?.cwd,
    runId: context?.runId,
    data
  };
  buffer.push(JSON.stringify(payload) + "\n");
  lastWriteMs = Date.now();
  ensureFlushTimer();
}
function flushDebugLog() {
  if (flushing || buffer.length === 0) return;
  const batch = buffer;
  buffer = [];
  try {
    const path = join(getAgentDir(), DEBUG_LOG_RELATIVE_PATH);
    mkdirSync(dirname(path), { recursive: true });
    rotateIfNeeded(path);
    appendFileSync(path, batch.join(""), "utf-8");
  } catch (error) {
    console.error("memory: debug log flush failed", error);
  }
}
function rotateIfNeeded(path) {
  if (!existsSync(path)) return;
  if (statSync(path).size < DEBUG_LOG_MAX_BYTES) return;
  const backupPath = `${path}.1`;
  if (existsSync(backupPath)) unlinkSync(backupPath);
  renameSync(path, backupPath);
}

// src/om/ledger/fold.ts
function foldEndIndex(entries, upToEntryId) {
  if (!upToEntryId) return entries.length - 1;
  const idx = entries.findIndex((entry) => entry.id === upToEntryId);
  return idx === -1 ? entries.length - 1 : idx;
}
function isCustomEntry(entry, customType) {
  return entry.type === "custom" && entry.customType === customType;
}
function foldLedger(entries, options = {}) {
  const observationsById = /* @__PURE__ */ new Map();
  const reflectionsById = /* @__PURE__ */ new Map();
  const droppedObservationIds = /* @__PURE__ */ new Set();
  const endIdx = foldEndIndex(entries, options.upToEntryId);
  for (let i = 0; i <= endIdx; i++) {
    const entry = entries[i];
    if (!entry) continue;
    if (isCustomEntry(entry, OM_OBSERVATIONS_RECORDED)) {
      if (!isObservationsRecordedData(entry.data)) continue;
      for (const observation of entry.data.observations) {
        if (!observationsById.has(observation.id)) {
          observationsById.set(observation.id, observation);
        }
      }
      continue;
    }
    if (isCustomEntry(entry, OM_REFLECTIONS_RECORDED)) {
      if (!isReflectionsRecordedData(entry.data)) continue;
      for (const reflection of entry.data.reflections) {
        if (!reflectionsById.has(reflection.id)) {
          reflectionsById.set(reflection.id, reflection);
        }
      }
      continue;
    }
    if (isCustomEntry(entry, OM_OBSERVATIONS_DROPPED)) {
      if (!isObservationsDroppedData(entry.data)) continue;
      for (const observationId of entry.data.observationIds) {
        droppedObservationIds.add(observationId);
      }
      continue;
    }
    if (entry.type === "custom" && entry.customType) {
      debugLog("fold.unknown_custom_type", {
        customType: entry.customType,
        entryId: entry.id
      });
    }
  }
  const observations = Array.from(observationsById.values());
  const activeObservations = observations.filter(
    (observation) => !droppedObservationIds.has(observation.id)
  );
  const reflections = Array.from(reflectionsById.values());
  return {
    observations,
    activeObservations,
    droppedObservationIds,
    reflections,
    observationsById,
    reflectionsById
  };
}

// src/om/ledger/render-summary.ts
var OM_INSTRUCTIONS_FULL = `Bracketed ids in reflections and observations connect to their source session entries. These are condensed memories from earlier in this session.
When entries conflict, the most recent observation reflects the latest known state.
Use \`recall\` with an id to retrieve original context, or \`#N:path\` drill-down to explore file content from referenced entries.
When exact source context is needed for precision or traceability, use the \`recall\` tool with the relevant observation or reflection id. This is especially useful when a reflection materially affects a decision or is too compressed to continue confidently.`;
var OM_INSTRUCTIONS_BASIC = `Use \`recall\` with an id to retrieve original context, or \`#N:path\` drill-down to explore file content from referenced entries.
When entries conflict, the most recent entry reflects the latest known state.`;
var OM_FOOTER_FULL = `----
${OM_INSTRUCTIONS_FULL}
----`;
var OM_FOOTER_BASIC = `----
${OM_INSTRUCTIONS_BASIC}
----`;
function observationToSummaryLine(observation) {
  return `[${observation.id}] ${observation.timestamp} [${observation.relevance}] ${observation.content}`;
}
function scoreObservation(obs, index, total) {
  const base = obs.relevance === "high" || obs.relevance === "critical" ? 10 : obs.relevance === "medium" ? 5 : 1;
  const recency = total > 1 ? index / (total - 1) : 1;
  return base + recency;
}
function selectPriorObservations(observations, maxTokens) {
  const indexed = observations.map((obs, i) => ({ obs, originalIndex: i }));
  const high = indexed.filter(
    (item) => item.obs.relevance === "high" || item.obs.relevance === "critical"
  );
  const rest = indexed.filter(
    (item) => item.obs.relevance !== "high" && item.obs.relevance !== "critical"
  );
  let budget = maxTokens;
  const selected = /* @__PURE__ */ new Set();
  for (const item of high) {
    const lineTokens = Math.ceil(observationToSummaryLine(item.obs).length / 4);
    selected.add(item);
    budget -= lineTokens;
  }
  if (rest.length > 0 && budget > 0) {
    const scored = rest.map((item, i) => ({
      item,
      score: scoreObservation(item.obs, i, rest.length)
    }));
    scored.sort((a, b) => b.score - a.score);
    for (const { item } of scored) {
      const lineTokens = Math.ceil(observationToSummaryLine(item.obs).length / 4);
      if (budget - lineTokens < 0) break;
      selected.add(item);
      budget -= lineTokens;
    }
  }
  return Array.from(selected).sort((a, b) => a.originalIndex - b.originalIndex).map((item) => item.obs);
}
function reflectionToSummaryLine(reflection) {
  return `[${reflection.id}] ${reflection.content}`;
}
function renderSummary(reflections, observations) {
  const hasContent = reflections.length > 0 || observations.length > 0;
  const parts = [];
  if (reflections.length > 0) {
    parts.push(`## Reflections
${reflections.map(reflectionToSummaryLine).join("\n")}`);
  }
  if (observations.length > 0) {
    parts.push(`## Observations
${observations.map(observationToSummaryLine).join("\n")}`);
  }
  const footer = hasContent ? OM_FOOTER_FULL : OM_FOOTER_BASIC;
  if (parts.length > 0) {
    parts.push(footer);
    return parts.join("\n\n");
  }
  return footer;
}

// src/om/ledger/projection.ts
function entryIndexById2(entries) {
  const indexes = /* @__PURE__ */ new Map();
  for (let i = 0; i < entries.length; i++) indexes.set(entries[i].id, i);
  return indexes;
}
function entryBoundary(entryId) {
  return { kind: "entry", entryId };
}
function tipBoundary() {
  return { kind: "tip" };
}
function noneBoundary() {
  return { kind: "none" };
}
function boundaryIndex(entries, indexes, boundary) {
  if (boundary.kind === "tip") return entries.length - 1;
  if (boundary.kind === "none") return -1;
  return indexes.get(boundary.entryId) ?? -1;
}
function coverageIndex(entry, indexes) {
  return indexes.get(entry.data.coversUpToId) ?? -1;
}
function isAtOrBefore(index, boundaryIndex2) {
  return index >= 0 && boundaryIndex2 >= 0 && index <= boundaryIndex2;
}
function isCoveredAtOrBefore(entry, indexes, boundaryIndex2) {
  return isAtOrBefore(coverageIndex(entry, indexes), boundaryIndex2);
}
function foldProjection(entries, options) {
  const indexes = entryIndexById2(entries);
  const observationsBoundary = boundaryIndex(entries, indexes, options.observationsBoundary);
  const reflectionsBoundary = boundaryIndex(entries, indexes, options.reflectionsBoundary);
  const dropsBoundary = boundaryIndex(entries, indexes, options.dropsBoundary);
  const observations = [];
  const reflections = [];
  const observationsById = /* @__PURE__ */ new Set();
  const reflectionsById = /* @__PURE__ */ new Set();
  const droppedObservationIds = /* @__PURE__ */ new Set();
  for (const entry of entries) {
    if (isObservationsRecordedEntry(entry) && isCoveredAtOrBefore(entry, indexes, observationsBoundary)) {
      for (const observation of entry.data.observations) {
        if (observationsById.has(observation.id)) continue;
        observationsById.add(observation.id);
        observations.push(observation);
      }
      continue;
    }
    if (isReflectionsRecordedEntry(entry) && isCoveredAtOrBefore(entry, indexes, reflectionsBoundary)) {
      for (const reflection of entry.data.reflections) {
        if (reflectionsById.has(reflection.id)) continue;
        reflectionsById.add(reflection.id);
        reflections.push(reflection);
      }
      continue;
    }
    if (isObservationsDroppedEntry(entry) && isCoveredAtOrBefore(entry, indexes, dropsBoundary)) {
      for (const observationId of entry.data.observationIds)
        droppedObservationIds.add(observationId);
    }
  }
  return {
    observations: observations.filter((observation) => !droppedObservationIds.has(observation.id)),
    reflections
  };
}
function projectionFromMemoryDetails(details) {
  return {
    observations: [...details.observations],
    reflections: [...details.reflections]
  };
}
function latestV3CompactionDetails(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "compaction") continue;
    const details = unwrapMemoryDetails(entry);
    if (details) return details;
  }
  return void 0;
}
function fullProjection(entries, upToEntryId) {
  const boundary = upToEntryId ? entryBoundary(upToEntryId) : tipBoundary();
  return foldProjection(entries, {
    observationsBoundary: boundary,
    reflectionsBoundary: boundary,
    dropsBoundary: boundary
  });
}
function visibleProjection(entries, upToEntryId) {
  {
    const details = latestV3CompactionDetails(entries);
    if (details) return projectionFromMemoryDetails(details);
    return fullProjection(entries);
  }
}
function unwrapMemoryDetails(entry) {
  if (isMemoryDetails(entry.details)) return entry.details;
  if (entry.details && typeof entry.details === "object" && !Array.isArray(entry.details)) {
    const nested = entry.details["om.folded"];
    if (isMemoryDetails(nested)) return nested;
  }
  return void 0;
}
function latestFullFoldBoundaryId(entries) {
  const indexes = entryIndexById2(entries);
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "compaction") continue;
    const details = unwrapMemoryDetails(entry);
    if (!details) continue;
    if (!details.fullFold) continue;
    if (!entry.firstKeptEntryId) continue;
    if (!indexes.has(entry.firstKeptEntryId)) continue;
    return entry.firstKeptEntryId;
  }
  return void 0;
}
function buildCompactionProjection(entries, firstKeptEntryId, config2) {
  const fullFoldBoundaryId = latestFullFoldBoundaryId(entries);
  const maintenanceBoundary = fullFoldBoundaryId ? entryBoundary(fullFoldBoundaryId) : config2.fullFoldAlways ? entryBoundary(firstKeptEntryId) : noneBoundary();
  const normalProjection = foldProjection(entries, {
    observationsBoundary: entryBoundary(firstKeptEntryId),
    reflectionsBoundary: maintenanceBoundary,
    dropsBoundary: maintenanceBoundary
  });
  const observationTokens = normalProjection.observations.reduce(
    (total, observation) => total + observation.tokenCount,
    0
  );
  const fullFold = observationTokens >= config2.observationsPoolMaxTokens;
  let projection = fullFold ? fullProjection(entries, firstKeptEntryId) : normalProjection;
  if (config2.observationsPoolMaxTokens > 0 && observationTokens >= config2.observationsPoolMaxTokens) {
    projection = {
      observations: selectPriorObservations(
        projection.observations,
        config2.observationsPoolMaxTokens
      ),
      reflections: projection.reflections
    };
  }
  const details = {
    type: OM_FOLDED,
    version: 1,
    fullFold,
    observations: projection.observations,
    reflections: projection.reflections
  };
  return {
    fullFold,
    observations: projection.observations,
    reflections: projection.reflections,
    details
  };
}
function diffProjection(visible, full) {
  const visibleObservationIds = new Set(visible.observations.map((observation) => observation.id));
  const fullObservationIds = new Set(full.observations.map((observation) => observation.id));
  const visibleReflectionIds = new Set(visible.reflections.map((reflection) => reflection.id));
  return {
    observationsOnlyInFull: full.observations.filter(
      (observation) => !visibleObservationIds.has(observation.id)
    ),
    reflectionsOnlyInFull: full.reflections.filter(
      (reflection) => !visibleReflectionIds.has(reflection.id)
    ),
    droppedOnlyInFull: visible.observations.filter(
      (observation) => !fullObservationIds.has(observation.id)
    )
  };
}

// src/om/ledger/recall.ts
var SOURCE_TYPES = /* @__PURE__ */ new Set(["message", "custom_message", "branch_summary"]);
function isSourceEntry2(entry) {
  return SOURCE_TYPES.has(entry.type);
}
function uniqueById(entries) {
  const seen = /* @__PURE__ */ new Set();
  const result = [];
  for (const entry of entries) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    result.push(entry);
  }
  return result;
}
function uniqueStrings(values) {
  return Array.from(new Set(values));
}
function indexLedger(entries) {
  const observations = [];
  const reflections = [];
  const droppedIds = /* @__PURE__ */ new Set();
  for (let entryIndex = 0; entryIndex < entries.length; entryIndex++) {
    const entry = entries[entryIndex];
    if (isObservationsRecordedEntry(entry)) {
      entry.data.observations.forEach((observation, recordIndex) => {
        observations.push({
          observation,
          entryId: entry.id,
          entryIndex,
          recordIndex
        });
      });
      continue;
    }
    if (isReflectionsRecordedEntry(entry)) {
      entry.data.reflections.forEach((reflection, recordIndex) => {
        reflections.push({
          reflection,
          entryId: entry.id,
          entryIndex,
          recordIndex
        });
      });
      continue;
    }
    if (isObservationsDroppedEntry(entry)) {
      entry.data.observationIds.forEach((id) => droppedIds.add(id));
    }
  }
  return { observations, reflections, droppedIds };
}
function resolveObservationSources(entries, observation, location) {
  const sourceEntryIds = uniqueStrings(observation.sourceEntryIds);
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const sourceEntries = [];
  const missingSourceEntryIds = [];
  const nonSourceEntryIds = [];
  for (const sourceEntryId of sourceEntryIds) {
    const sourceEntry = byId.get(sourceEntryId);
    if (!sourceEntry) {
      missingSourceEntryIds.push(sourceEntryId);
      continue;
    }
    if (!isSourceEntry2(sourceEntry)) {
      nonSourceEntryIds.push(sourceEntryId);
      continue;
    }
    sourceEntries.push(sourceEntry);
  }
  return {
    observation,
    observationEntryId: location.entryId,
    observationRecordIndex: location.recordIndex,
    status: "active",
    sourceEntryIds,
    sourceEntries,
    missingSourceEntryIds,
    nonSourceEntryIds
  };
}
function notFound(memoryId) {
  return {
    status: "not_found",
    memoryId,
    kind: void 0,
    reflections: [],
    observations: [],
    sourceEntries: [],
    missingSourceEntryIds: [],
    nonSourceEntryIds: [],
    missingSupportingObservationIds: [],
    collision: false,
    partial: false
  };
}
function recallMemorySources(entries, memoryId) {
  const {
    observations: indexedObservations,
    reflections: indexedReflections,
    droppedIds
  } = indexLedger(entries);
  const directObservationMatches = indexedObservations.filter(
    ({ observation }) => observation.id === memoryId
  );
  const reflectionMatches = indexedReflections.filter(
    ({ reflection }) => reflection.id === memoryId
  );
  if (directObservationMatches.length === 0 && reflectionMatches.length === 0)
    return notFound(memoryId);
  const observationsById = /* @__PURE__ */ new Map();
  for (const indexed of indexedObservations) {
    if (!observationsById.has(indexed.observation.id))
      observationsById.set(indexed.observation.id, indexed);
  }
  const recalledByKey = /* @__PURE__ */ new Map();
  const rawMissingSupportingObservationIds = [];
  function addObservation(indexed) {
    const key = `${indexed.entryId}:${indexed.recordIndex}`;
    if (recalledByKey.has(key)) return;
    const recalled = resolveObservationSources(entries, indexed.observation, indexed);
    recalled.status = droppedIds.has(indexed.observation.id) ? "dropped" : "active";
    recalledByKey.set(key, recalled);
  }
  for (const match of directObservationMatches) addObservation(match);
  for (const { reflection } of reflectionMatches) {
    for (const observationId of uniqueStrings(reflection.supportingObservationIds)) {
      const indexed = observationsById.get(observationId);
      if (!indexed) {
        rawMissingSupportingObservationIds.push(observationId);
        continue;
      }
      addObservation(indexed);
    }
  }
  const recalledObservations = Array.from(recalledByKey.values());
  const recalledReflections = reflectionMatches.map(
    ({ reflection, entryId, recordIndex }) => ({
      reflection,
      reflectionEntryId: entryId,
      reflectionRecordIndex: recordIndex
    })
  );
  const sourceEntries = uniqueById(recalledObservations.flatMap((match) => match.sourceEntries));
  const missingSourceEntryIds = uniqueStrings(
    recalledObservations.flatMap((match) => match.missingSourceEntryIds)
  );
  const nonSourceEntryIds = uniqueStrings(
    recalledObservations.flatMap((match) => match.nonSourceEntryIds)
  );
  const uniqueMissingSupportingObservationIds = uniqueStrings(rawMissingSupportingObservationIds);
  const matchCount = directObservationMatches.length + reflectionMatches.length;
  return {
    status: "found",
    memoryId,
    kind: directObservationMatches.length > 0 && reflectionMatches.length > 0 ? "mixed" : reflectionMatches.length > 0 ? "reflection" : "observation",
    reflections: recalledReflections,
    observations: recalledObservations,
    sourceEntries,
    missingSourceEntryIds,
    nonSourceEntryIds,
    missingSupportingObservationIds: uniqueMissingSupportingObservationIds,
    collision: matchCount > 1,
    partial: missingSourceEntryIds.length > 0 || nonSourceEntryIds.length > 0 || uniqueMissingSupportingObservationIds.length > 0
  };
}

// src/om/model-budget.ts
var AGENT_LOOP_MAX_TOKENS = 32e3;
function boundedMaxTokens(model, requested = AGENT_LOOP_MAX_TOKENS) {
  return typeof model.maxTokens === "number" && model.maxTokens > 0 ? Math.min(model.maxTokens, requested) : requested;
}
function effectiveContextWindow(resolvedModel, modelConfig) {
  if (modelConfig?.contextWindow !== void 0 && modelConfig.contextWindow > 0) {
    return modelConfig.contextWindow;
  }
  if (resolvedModel && typeof resolvedModel.contextWindow === "number" && resolvedModel.contextWindow > 0) {
    return resolvedModel.contextWindow;
  }
  return 128e3;
}

// src/hooks/before-compact.ts
var PI_VCC_COMPACT_INSTRUCTION = "__pi_vcc__";
var migrationNotifyCount = /* @__PURE__ */ new Map();
function notifyMigrationReminder(sessionId, notify) {
  const count = migrationNotifyCount.get(sessionId) ?? 0;
  if (count >= 2) return;
  if (!configFileNeedsMigration()) return;
  migrationNotifyCount.set(sessionId, count + 1);
  notify("Use `/memory settings` to save your updated configuration.", "info");
}
var formatTokens = (n) => {
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
};
var formatCompactionStats = (stats) => {
  const parts = [`${stats.summarized} source entries processed`];
  parts.push(`tail kept ${stats.keptUserTurns}/${stats.totalUserTurns} user turns`);
  if (stats.smartKeepAdjusted) {
    parts.push(`smart keep:${stats.smartFromKeep}\u2192${stats.keptUserTurns}`);
  }
  if (stats.keepFallbackToCompactAll) {
    parts.push(`compact-all`);
  }
  return `${parts.join("; ")} (~${formatTokens(stats.keptTokensEst)} tok).`;
};
var dbg = (debug, data) => {
  if (!debug) return;
  try {
    writeFileSync("/tmp/pi-blackhole-debug.json", JSON.stringify(data, null, 2));
  } catch {
  }
};
var previewContent = (content) => {
  if (typeof content === "string") return content.slice(0, 300);
  if (Array.isArray(content)) {
    return content.map((c) => {
      if (c?.type === "text") return c.text ?? "";
      if (c?.type === "toolCall") return `[toolCall:${c.name}]`;
      if (c?.type === "thinking") return `[thinking]`;
      if (c?.type === "image") return `[image:${c.mimeType}]`;
      return `[${c?.type ?? "unknown"}]`;
    }).join("\n").slice(0, 300);
  }
  return "";
};
function buildOwnCut(branchEntries, piFirstKeptEntryId, tailBehavior) {
  let lastCompactionIdx = -1;
  let lastKeptId;
  for (let i = branchEntries.length - 1; i >= 0; i--) {
    if (branchEntries[i].type === "compaction") {
      lastCompactionIdx = i;
      lastKeptId = branchEntries[i].firstKeptEntryId;
      break;
    }
  }
  const hasPriorCompaction = lastCompactionIdx >= 0;
  const hasValidKeptId = !!lastKeptId && branchEntries.some((e) => e.id === lastKeptId);
  const orphanRecovery = hasPriorCompaction && !hasValidKeptId;
  const liveMessages = [];
  if (orphanRecovery) {
    for (let i = lastCompactionIdx + 1; i < branchEntries.length; i++) {
      const e = branchEntries[i];
      if (e.type === "compaction") continue;
      if (e.type === "message" && e.message) {
        liveMessages.push({ entry: e, message: e.message });
      }
    }
  } else {
    let foundKept = !lastKeptId;
    for (const e of branchEntries) {
      if (!foundKept && e.id === lastKeptId) foundKept = true;
      if (!foundKept) continue;
      if (e.type === "compaction") continue;
      if (e.type === "message" && e.message) {
        liveMessages.push({ entry: e, message: e.message });
      }
    }
  }
  let minimalCutIdx = liveMessages.length - 1;
  while (minimalCutIdx > 0 && liveMessages[minimalCutIdx]?.message.role !== "user") {
    minimalCutIdx--;
  }
  if (minimalCutIdx <= 0) minimalCutIdx = liveMessages.length;
  if (piFirstKeptEntryId) {
    const cutInBranch = branchEntries.findIndex((e) => e.id === piFirstKeptEntryId);
    if (cutInBranch >= 0) {
      const liveCutIdx = liveMessages.findIndex((lm) => lm.entry.id === piFirstKeptEntryId);
      if (liveCutIdx > 0 && (tailBehavior === "pi-default" || liveCutIdx > minimalCutIdx)) {
        return {
          ok: true,
          messages: liveMessages.slice(0, liveCutIdx).map((e) => e.message),
          selectedIds: liveMessages.slice(0, liveCutIdx).map((e) => e.entry.id),
          firstKeptEntryId: piFirstKeptEntryId,
          compactAll: false
        };
      }
      if (liveCutIdx === 0 && tailBehavior === "pi-default") {
        let lastUserIdx = liveMessages.length - 1;
        while (lastUserIdx > 0 && liveMessages[lastUserIdx].message.role !== "user") {
          lastUserIdx--;
        }
        if (lastUserIdx > 0) {
          return { ok: false, reason: "too_few_live_messages" };
        }
      }
      if (liveCutIdx < 0) {
        const nextMsgEntry = branchEntries.find(
          (e, i) => i > cutInBranch && e.type === "message" && e.message
        );
        if (nextMsgEntry) {
          const resolvedId = nextMsgEntry.id;
          const resolvedLiveIdx = liveMessages.findIndex((lm) => lm.entry.id === resolvedId);
          if (resolvedLiveIdx > 0 && (tailBehavior === "pi-default" || resolvedLiveIdx > minimalCutIdx)) {
            return {
              ok: true,
              messages: liveMessages.slice(0, resolvedLiveIdx).map((e) => e.message),
              selectedIds: liveMessages.slice(0, resolvedLiveIdx).map((e) => e.entry.id),
              firstKeptEntryId: resolvedId,
              compactAll: false
            };
          }
          if (resolvedLiveIdx === 0 && tailBehavior === "pi-default") {
            let lastUserIdx = liveMessages.length - 1;
            while (lastUserIdx > 0 && liveMessages[lastUserIdx].message.role !== "user") {
              lastUserIdx--;
            }
            if (lastUserIdx > 0) {
              return { ok: false, reason: "too_few_live_messages" };
            }
          }
        }
      }
    }
  }
  if (liveMessages.length === 0) return { ok: false, reason: "no_live_messages" };
  if (liveMessages.length <= 2) return { ok: false, reason: "too_few_live_messages" };
  let cutIdx = liveMessages.length - 1;
  while (cutIdx > 0 && liveMessages[cutIdx].message.role !== "user") {
    cutIdx--;
  }
  if (cutIdx <= 0) {
    return {
      ok: true,
      messages: liveMessages.map((e) => e.message),
      selectedIds: liveMessages.map((e) => e.entry.id),
      firstKeptEntryId: "",
      compactAll: true
    };
  }
  return {
    ok: true,
    messages: liveMessages.slice(0, cutIdx).map((e) => e.message),
    selectedIds: liveMessages.slice(0, cutIdx).map((e) => e.entry.id),
    firstKeptEntryId: liveMessages[cutIdx].entry.id,
    compactAll: false
  };
}
var REASON_MESSAGES = {
  no_live_messages: "Nothing to compact (no live messages)",
  too_few_live_messages: `Too few live messages \u2014 Pi's default logic preserves visible context. Set tailBehavior to "minimal" in config to force compaction with fewer messages.`
};
var registerBeforeCompactHook = (pi, omRuntime) => {
  pi.on("session_before_compact", (event, ctx) => {
    const { preparation, branchEntries, customInstructions } = event;
    const isPiVcc = customInstructions === PI_VCC_COMPACT_INSTRUCTION;
    omRuntime.compactWasPiVcc = isPiVcc;
    omRuntime.lastCompactCancelled = false;
    omRuntime.ensureConfig(ctx.cwd ?? process.cwd(), (msg) => ctx.ui?.notify?.(msg, "warning"));
    const trace = (ev, d) => debugLog(ev, d, omRuntime.config.debugLog === true);
    if (matchesSkippedProvider(omRuntime.config, ctx.model)) {
      trace("before_compact.provider_skipped", {
        provider: getModelProvider(ctx.model),
        skipForProviders: omRuntime.config.skipForProviders
      });
      return;
    }
    trace("before_compact.enter", {
      customInstructions,
      isPiVcc,
      overrideDefaultCompaction: omRuntime.config.overrideDefaultCompaction,
      manualMode: omRuntime.config.compaction === "manual" || omRuntime.config.noAutoCompact === true,
      branchLength: branchEntries.length,
      hasPreviousSummary: !!preparation.previousSummary
    });
    if (omRuntime.config.compaction === "off" && !isPiVcc) {
      trace("before_compact.return_early", { reason: "compaction_off" });
      return;
    }
    if (omRuntime.config.compactionEngine === "pi-default" && !isPiVcc) {
      trace("before_compact.return_early", {
        reason: "compactionEngine_pi_default"
      });
      return;
    }
    if (omRuntime.config.compaction === "manual" && !isPiVcc) {
      trace("before_compact.return_early", { reason: "compaction_manual" });
      return;
    }
    if (omRuntime.config.compaction === void 0 && omRuntime.config.compactionEngine === void 0) {
      if (!isPiVcc && !omRuntime.config.overrideDefaultCompaction) {
        trace("before_compact.return_early", {
          reason: "overrideDefaultCompaction=false and not /memory"
        });
        return;
      }
      if ((omRuntime.config.compaction === "manual" || omRuntime.config.noAutoCompact) && !isPiVcc) {
        trace("before_compact.cancel", {
          reason: "manual mode and not /memory"
        });
        omRuntime.lastCompactCancelled = true;
        return { cancel: true };
      }
    }
    const effectiveTailBehavior = omRuntime.config.tailBehavior ?? "minimal";
    trace("before_compact.tail_behavior", {
      effectiveTailBehavior,
      configTailBehavior: omRuntime.config.tailBehavior,
      isPiVcc,
      piFirstKeptEntryId: preparation.firstKeptEntryId
    });
    const ownCut = buildOwnCut(
      branchEntries,
      preparation.firstKeptEntryId,
      effectiveTailBehavior
    );
    if (!ownCut.ok) {
      const lastComp = [...branchEntries].reverse().find((e) => e.type === "compaction");
      const lastCompIdx = lastComp ? branchEntries.indexOf(lastComp) : -1;
      const lastKeptId = lastComp?.firstKeptEntryId;
      const hasPriorCompaction = lastCompIdx >= 0;
      const hasValidKeptId = !!lastKeptId && branchEntries.some((e) => e.id === lastKeptId);
      const diagOrphan = hasPriorCompaction && !hasValidKeptId;
      const liveRoles = [];
      if (diagOrphan) {
        for (let i = lastCompIdx + 1; i < branchEntries.length; i++) {
          const e = branchEntries[i];
          if (e.type === "compaction") continue;
          if (e.type === "message" && e.message) liveRoles.push(e.message.role);
        }
      } else {
        let foundKept = !lastKeptId;
        for (const e of branchEntries) {
          if (!foundKept && e.id === lastKeptId) foundKept = true;
          if (!foundKept) continue;
          if (e.type === "compaction") continue;
          if (e.type === "message" && e.message) liveRoles.push(e.message.role);
        }
      }
      const userIndices = liveRoles.reduce(
        (acc, r, i) => r === "user" ? (acc.push(i), acc) : acc,
        []
      );
      dbg(omRuntime.config.debug, {
        cancelled: true,
        reason: ownCut.reason,
        isPiVcc,
        counts: {
          total: branchEntries.length,
          messages: branchEntries.filter((e) => e.type === "message").length,
          compactions: branchEntries.filter((e) => e.type === "compaction").length,
          entriesAfterLastCompaction: lastCompIdx >= 0 ? branchEntries.length - lastCompIdx - 1 : null
        },
        liveMessages: {
          count: liveRoles.length,
          userCount: userIndices.length,
          firstUserIdx: userIndices[0] ?? null,
          lastUserIdx: userIndices[userIndices.length - 1] ?? null,
          roleSequence: liveRoles.length <= 30 ? liveRoles : [...liveRoles.slice(0, 10), "...", ...liveRoles.slice(-10)]
        },
        lastCompaction: lastComp ? {
          hasFirstKeptEntryId: !!lastComp.firstKeptEntryId,
          foundInBranch: lastComp.firstKeptEntryId ? branchEntries.some(
            (e) => e.id === lastComp.firstKeptEntryId
          ) : null
        } : null,
        tail: branchEntries.slice(-5).map((e) => ({
          type: e.type,
          role: e.type === "message" ? e.message?.role : void 0,
          hasContent: e.type === "message" ? e.message?.content != null : void 0
        }))
      });
      trace("before_compact.cancel", { reason: ownCut.reason, isPiVcc });
      try {
        ctx?.ui?.notify?.(REASON_MESSAGES[ownCut.reason], "warning");
      } catch {
      }
      omRuntime.lastCompactCancelled = true;
      return { cancel: true };
    }
    trace("before_compact.proceeding", {
      messageCount: ownCut.messages.length,
      firstKeptEntryId: ownCut.firstKeptEntryId,
      compactAll: ownCut.compactAll,
      isPiVcc
    });
    const agentMessages = ownCut.messages;
    const agentSelectedIds = ownCut.selectedIds;
    const firstKeptEntryId = ownCut.firstKeptEntryId;
    const messages = convertToLlm(agentMessages);
    const keptIdx = branchEntries.findIndex((e) => e.id === firstKeptEntryId);
    const keptEntries = keptIdx >= 0 ? branchEntries.slice(keptIdx).filter((e) => e.type === "message") : [];
    const keptChars = keptEntries.reduce((sum, e) => {
      const c = e.message?.content;
      if (typeof c === "string") return sum + c.length;
      if (Array.isArray(c))
        return sum + c.reduce((s, p) => {
          if (p.text) return s + p.text.length;
          if (p.type === "toolCall")
            return s + (p.name?.length ?? 0) + (typeof p.input === "string" ? p.input.length : JSON.stringify(p.input ?? "").length);
          if (p.type === "toolResult")
            return s + (typeof p.content === "string" ? p.content.length : JSON.stringify(p.content ?? "").length);
          return s;
        }, 0);
      return sum;
    }, 0);
    const totalUserTurns = branchEntries.filter(
      (e) => e.type === "message" && e.message?.role === "user"
    ).length;
    const keptUserTurns = ownCut.compactAll ? 0 : branchEntries.slice(keptIdx).filter((e) => e.type === "message" && e.message?.role === "user").length;
    omRuntime.compactionStats = {
      summarized: agentMessages.length,
      kept: keptEntries.length,
      keptTokensEst: Math.round(keptChars / 4),
      compactAll: ownCut.compactAll,
      totalUserTurns,
      keptUserTurns,
      requestedKeepUserTurns: 1,
      keepUserTurnsExplicit: false,
      keepFallbackToCompactAll: ownCut.compactAll,
      smartKeepAdjusted: false,
      smartFromKeep: 1
    };
    ({
      readFiles: [...preparation.fileOps.read],
      modifiedFiles: [...preparation.fileOps.written, ...preparation.fileOps.edited]
    });
    const summary = compile({
      messages,
      previousSummary: preparation.previousSummary});
    const freshSegmentSummary = omRuntime.config.compactionSummaryMode === "append" ? compileSegment({ messages}) : "";
    const branchIds = branchEntries.map((e) => e.id);
    const cutIdx = branchIds.indexOf(firstKeptEntryId);
    const cutWindow = cutIdx >= 0 ? branchEntries.slice(Math.max(0, cutIdx - 3), Math.min(branchEntries.length, cutIdx + 3)).map((e) => ({
      id: e.id,
      type: e.type,
      role: e.type === "message" ? e.message?.role : void 0,
      preview: e.type === "message" ? previewContent(e.message?.content) : void 0
    })) : [];
    dbg(omRuntime.config.debug, {
      usedOwnCut: true,
      messagesToSummarize: agentMessages.length,
      messagesPreviewHead: agentMessages.slice(0, 3).map((m) => ({
        role: m.role,
        preview: previewContent(m.content)
      })),
      messagesPreviewTail: agentMessages.slice(-3).map((m) => ({
        role: m.role,
        preview: previewContent(m.content)
      })),
      convertedMessages: messages.length,
      firstKeptEntryId,
      cutWindow,
      tokensBefore: preparation.tokensBefore,
      summaryLength: summary.length,
      summaryPreview: summary.slice(0, 500),
      sections: [...summary.matchAll(/^\[(.+?)\]/gm)].map((m) => m[1])
    });
    trace("before_compact.summary_generated", {
      summaryLength: summary.length,
      messageCount: agentMessages.length
    });
    const legacyDetails = {
      compactor: "blackhole",
      version: 1,
      sections: [...summary.matchAll(/^\[(.+?)\]/gm)].map((m) => m[1]),
      sourceMessageCount: agentMessages.length,
      previousSummaryUsed: Boolean(preparation.previousSummary)
    };
    let omContent;
    let omDetails;
    trace("before_compact.om_injection", {
      memoryEnabled: omRuntime.config.memory !== false
    });
    if (omRuntime.config.memory !== false) {
      const projection = buildCompactionProjection(branchEntries, firstKeptEntryId, {
        observationsPoolMaxTokens: omRuntime.config.observationsPoolMaxTokens,
        fullFoldAlways: omRuntime.config.fullFoldAlways
      });
      omContent = renderSummary(projection.reflections, projection.observations);
      omDetails = projection.details;
    } else {
      omContent = renderSummary([], []);
    }
    const fallbackSummary = summary + "\n\n" + omContent;
    const warnAppendFallback = (reason) => {
      trace("before_compact.append_fallback", { reason });
      if (omRuntime.appendFallbackNotified) return;
      omRuntime.appendFallbackNotified = true;
      ctx?.ui?.notify?.(
        `Append summary mode fell back to a complete replacement summary (${reason}); run /memory to rebase back into append segments`,
        "warning"
      );
    };
    let details = legacyDetails;
    if (omRuntime.config.compactionSummaryMode === "append") {
      const currentCoverage = coverageForMessages(
        branchEntries,
        agentSelectedIds,
        firstKeptEntryId
      );
      const aggregateSummary = stripRecallNotes(stripOMContent(summary)).trim();
      const hasPriorCompaction = branchEntries.some((entry) => entry.type === "compaction");
      const hasCompletePreviousSummary = !hasPriorCompaction || Boolean(preparation.previousSummary);
      if (currentCoverage && freshSegmentSummary.trim().length > 0 && aggregateSummary.length > 0 && hasCompletePreviousSummary) {
        const trailingSummary = [extractRecallNote(summary), omContent].map((part) => part.trim()).filter((part) => part.length > 0).join("\n\n");
        try {
          details = buildAppendOnlyDetails({
            branchEntries,
            manualRebase: isPiVcc,
            freshSummary: freshSegmentSummary,
            aggregateSummary,
            trailingSummary,
            currentCoverage,
            tokensBefore: preparation.tokensBefore,
            sections: legacyDetails.sections,
            previousSummaryUsed: legacyDetails.previousSummaryUsed,
            contextWindowTokens: ctx.model ? effectiveContextWindow(ctx.model) : void 0
          });
        } catch (error) {
          warnAppendFallback(
            `invalid-chain: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      } else {
        warnAppendFallback(
          !currentCoverage ? "coverage" : !hasCompletePreviousSummary ? "missing-previous-summary" : "empty-summary"
        );
      }
    }
    return {
      compaction: {
        summary: fallbackSummary,
        details: { ...details, "om.folded": omDetails },
        tokensBefore: preparation.tokensBefore,
        firstKeptEntryId
      }
    };
  });
  pi.on("session_compact", (event, ctx) => {
    const compactWasPiVcc = omRuntime.compactWasPiVcc;
    omRuntime.compactWasPiVcc = false;
    if (!event.fromExtension) return;
    if (compactWasPiVcc) return;
    const stats = omRuntime.compactionStats;
    if (!stats) return;
    const sessionId = ctx.sessionManager.getSessionId();
    setTimeout(() => {
      try {
        ctx?.ui?.notify?.(formatCompactionStats(stats), "info");
        notifyMigrationReminder(sessionId, (msg, level) => ctx?.ui?.notify?.(msg, level));
      } catch {
      }
    }, 500);
  });
};

// src/hooks/compact-failed.ts
function getErrorMessage(error) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    return String(error.message);
  }
  return String(error);
}
function isStaleExtensionContextError(error) {
  const message = getErrorMessage(error);
  return message.includes("extension ctx is stale") || message.includes("ctx is stale");
}
function notifySafely(hasUI, ui, message, level) {
  if (!hasUI) return;
  try {
    ui?.notify(message, level);
  } catch (error) {
    if (!isStaleExtensionContextError(error)) throw error;
  }
}
function registerCompactFailedHook(pi, runtime) {
  const onAny = pi.on;
  onAny.call(pi, "session_compact_failed", (event, ctx) => {
    try {
      handleCompactFailed(event, ctx, runtime);
    } catch (error) {
      if (isStaleExtensionContextError(error)) return;
      throw error;
    }
  });
}
function handleCompactFailed(event, ctx, runtime) {
  runtime.ensureConfig(ctx?.cwd ?? process.cwd());
  const trace = (ev, d) => debugLog(ev, d, runtime.config.debugLog === true);
  const hasUI = ctx?.hasUI === true;
  const ui = ctx?.ui;
  let sessionId;
  try {
    sessionId = ctx?.sessionManager?.getSessionId?.();
  } catch {
    sessionId = void 0;
  }
  const reason = event?.reason;
  const errorMessage = event?.errorMessage;
  const aborted = event?.aborted === true;
  const willRetry = event?.willRetry === true;
  const fromExtension = event?.fromExtension === true;
  const compactWasPiVcc = runtime.compactWasPiVcc === true;
  const lastCompactCancelled = runtime.lastCompactCancelled === true;
  const attributedFromExtension = fromExtension || compactWasPiVcc || lastCompactCancelled;
  runtime.compactWasPiVcc = false;
  runtime.lastCompactCancelled = false;
  trace("compact_failed.received", {
    reason,
    aborted,
    willRetry,
    fromExtension,
    compactWasPiVcc,
    lastCompactCancelled,
    attributedFromExtension,
    errorMessage,
    sessionId
  });
  const pendingController = runtime.autoCompactionController;
  if ((aborted || errorMessage) && (runtime.compactInFlight || pendingController)) {
    pendingController?.abort();
    runtime.compactInFlight = false;
    if (runtime.autoCompactionController === pendingController) {
      runtime.autoCompactionController = null;
    }
    trace("compact_failed.compactInFlight_reset", {
      reason,
      abortedPendingWait: pendingController !== null
    });
  }
  if (reason === "overflow" && aborted && willRetry) {
    notifySafely(hasUI, ui, "Overflow compaction aborted, retrying turn", "info");
  }
  if (runtime.config.compactionEngine === "pi-default" && !attributedFromExtension) {
    trace("compact_failed.skipped_pi_default", { reason });
    return;
  }
  if (!aborted && errorMessage && attributedFromExtension) {
    notifySafely(hasUI, ui, `Compaction failed \u2014 ${errorMessage}`, "error");
  }
}

// src/hooks/compaction-context.ts
function registerCompactionContextHook(pi, runtime) {
  pi.on("context", (event, ctx) => {
    runtime.ensureConfig(ctx.cwd ?? process.cwd());
    const dbg2 = (ev, data) => debugLog(ev, data, runtime.config.debugLog === true);
    try {
      const branchEntries = ctx.sessionManager.getBranch();
      const messages = projectAppendOnlyContext(event.messages, branchEntries);
      if (messages === event.messages) return;
      return { messages };
    } catch (error) {
      dbg2("compaction_context.projection_failed", {
        error: error instanceof Error ? error.message : String(error)
      });
      return;
    }
  });
}
var PENDING_DIR = "pi-blackhole";
var PENDING_SUFFIX = "-pending.json";
var STALE_SUFFIX = "-pending.stale.json";
function pendingPath(sessionId) {
  return join(getAgentDir(), PENDING_DIR, `${sessionId}${PENDING_SUFFIX}`);
}
function stalePath(sessionId) {
  return join(getAgentDir(), PENDING_DIR, `${sessionId}${STALE_SUFFIX}`);
}
function ensureDir() {
  const dir = join(getAgentDir(), PENDING_DIR);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}
function defaultState() {
  return {};
}
function isEmptyState(s) {
  const hasCursors = s.cursors && (s.cursors.observer || s.cursors.reflector || s.cursors.dropper);
  if (hasCursors) return false;
  return !s.observation && !s.reflection && !s.dropped && (!s.observationBatches || s.observationBatches.length === 0) && (!s.reflectionBatches || s.reflectionBatches.length === 0) && (!s.droppedBatches || s.droppedBatches.length === 0);
}
function readSessionState(sessionId) {
  const path = pendingPath(sessionId);
  if (!existsSync(path)) return defaultState();
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    if (isPendingOMState(raw)) return sanitizePendingState(raw);
    return defaultState();
  } catch {
    return defaultState();
  }
}
function writeSessionState(sessionId, state) {
  const path = pendingPath(sessionId);
  if (isEmptyState(state)) {
    try {
      if (existsSync(path)) unlinkSync(path);
    } catch {
    }
    try {
      const stale = stalePath(sessionId);
      if (existsSync(stale)) unlinkSync(stale);
    } catch {
    }
    return;
  }
  ensureDir();
  try {
    if (existsSync(path)) {
      renameSync(path, stalePath(sessionId));
    }
  } catch {
  }
  try {
    writeFileSync(path, `${JSON.stringify(state, null, 2)}
`);
  } catch {
  }
}
function isPendingOMState(value) {
  if (!value || typeof value !== "object") return false;
  const v = value;
  const hasObs = !!(v.observation && typeof v.observation === "object" && typeof v.observation.coversUpToId === "string");
  const hasRef = !!(v.reflection && typeof v.reflection === "object" && typeof v.reflection.coversUpToId === "string");
  const hasDrop = !!(v.dropped && typeof v.dropped === "object" && typeof v.dropped.coversUpToId === "string");
  const hasBatches = Array.isArray(v.observationBatches) || Array.isArray(v.reflectionBatches) || Array.isArray(v.droppedBatches);
  const hasCursors = !!(v.cursors && typeof v.cursors === "object");
  return hasObs || hasRef || hasDrop || hasBatches || hasCursors;
}
function sanitizePendingState(raw) {
  const sanitized = {
    ...raw,
    observation: raw.observation ?? void 0,
    reflection: raw.reflection ?? void 0,
    dropped: raw.dropped ?? void 0
  };
  if (Array.isArray(raw.observationBatches)) {
    sanitized.observationBatches = raw.observationBatches.filter(
      (b) => !!b && typeof b === "object" && typeof b.coversUpToId === "string" && b.data !== void 0
    );
  }
  if (Array.isArray(raw.reflectionBatches)) {
    sanitized.reflectionBatches = raw.reflectionBatches.filter(
      (b) => !!b && typeof b === "object" && typeof b.coversUpToId === "string" && b.data !== void 0
    );
  }
  if (Array.isArray(raw.droppedBatches)) {
    sanitized.droppedBatches = raw.droppedBatches.filter(
      (b) => !!b && typeof b === "object" && typeof b.coversUpToId === "string" && b.data !== void 0
    );
  }
  return sanitized;
}
function savePendingObservation(sessionId, entry) {
  const state = readSessionState(sessionId);
  state.observation = entry;
  state.observationBatches = [...state.observationBatches ?? [], entry];
  writeSessionState(sessionId, state);
}
function savePendingReflection(sessionId, entry) {
  const state = readSessionState(sessionId);
  state.reflection = entry;
  state.reflectionBatches = [...state.reflectionBatches ?? [], entry];
  writeSessionState(sessionId, state);
}
function savePendingDropped(sessionId, entry) {
  const state = readSessionState(sessionId);
  state.dropped = entry;
  state.droppedBatches = [...state.droppedBatches ?? [], entry];
  writeSessionState(sessionId, state);
}
function isObservationChunkPending(sessionId, coversUpToId) {
  const s = readSessionState(sessionId);
  return s.observation?.coversUpToId === coversUpToId;
}
function readPendingState(sessionId) {
  return readSessionState(sessionId);
}
function clearPendingState(sessionId) {
  writeSessionState(sessionId, defaultState());
}
function hasPendingData(sessionId) {
  return !isEmptyState(readSessionState(sessionId));
}
function readPendingCursors(sessionId) {
  const state = readSessionState(sessionId);
  return state.cursors;
}
function writePendingCursors(sessionId, cursors) {
  const state = readSessionState(sessionId);
  state.cursors = { ...cursors };
  writeSessionState(sessionId, state);
}
var PENDING_DIR2 = "pi-blackhole";
var PENDING_SUFFIX2 = "-pending.json";
var STALE_SUFFIX2 = "-pending.stale.json";
function extractSessionId(filename) {
  if (filename.endsWith(STALE_SUFFIX2)) {
    return filename.slice(0, -STALE_SUFFIX2.length) || null;
  }
  if (filename.endsWith(PENDING_SUFFIX2)) {
    return filename.slice(0, -PENDING_SUFFIX2.length) || null;
  }
  return null;
}
function scanPendingFiles(agentDir = getAgentDir()) {
  const dir = join(agentDir, PENDING_DIR2);
  if (!existsSync(dir)) return [];
  const results = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  for (const filename of entries) {
    const sessionId = extractSessionId(filename);
    if (!sessionId) continue;
    const filePath = join(dir, filename);
    let stat;
    try {
      stat = statSync(filePath);
    } catch {
      continue;
    }
    results.push({
      sessionId,
      filename,
      path: filePath,
      isStale: filename.endsWith(STALE_SUFFIX2),
      sizeBytes: stat.size,
      mtimeMs: stat.mtimeMs
    });
  }
  results.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return results;
}
function scanSessionDir(dir) {
  const ids = /* @__PURE__ */ new Set();
  if (!existsSync(dir)) return ids;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let names;
    try {
      names = readdirSync(current);
    } catch {
      continue;
    }
    for (const name of names) {
      const fullPath = join(current, name);
      let st;
      try {
        st = statSync(fullPath);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        stack.push(fullPath);
      } else if (st.isFile() && name.endsWith(".jsonl")) {
        try {
          const fd = readFileSync(fullPath, "utf-8");
          const newlineIdx = fd.indexOf("\n");
          const firstLine2 = newlineIdx >= 0 ? fd.slice(0, newlineIdx) : fd;
          const header = JSON.parse(firstLine2);
          if (header.type === "session" && typeof header.id === "string" && header.id.length > 0) {
            ids.add(header.id);
          }
        } catch {
        }
      }
    }
  }
  return ids;
}
function readSettingsSessionDir() {
  try {
    const settingsPath = join(getAgentDir(), "settings.json");
    if (!existsSync(settingsPath)) return void 0;
    const raw = JSON.parse(readFileSync(settingsPath, "utf-8"));
    const dir = raw.sessionDir;
    if (typeof dir === "string" && dir.trim().length > 0) {
      const expanded = dir.startsWith("~") ? join(process.env.HOME ?? "/home", dir.slice(2)) : dir;
      return resolve(expanded);
    }
  } catch {
  }
  return void 0;
}
function getDefaultSessionsDir() {
  return join(getAgentDir(), "sessions");
}
function findSessionDirs() {
  const dirs = [];
  const default_ = getDefaultSessionsDir();
  dirs.push(default_);
  const custom = readSettingsSessionDir();
  if (custom && custom !== default_ && existsSync(custom)) {
    dirs.push(custom);
  }
  return dirs;
}
function collectAllSessionIds(sessionDirs) {
  const dirs = findSessionDirs();
  const allIds = /* @__PURE__ */ new Set();
  for (const dir of dirs) {
    const ids = scanSessionDir(dir);
    for (const id of ids) allIds.add(id);
  }
  return allIds;
}
function crossReference(pending, sessionIds) {
  const orphaned = [];
  const active = [];
  for (const pf of pending) {
    if (sessionIds.has(pf.sessionId)) {
      active.push(pf);
    } else {
      orphaned.push(pf);
    }
  }
  return { all: pending, orphaned, active };
}
function analyzeOrphaned(agentDir, sessionDirs) {
  const pending = scanPendingFiles(agentDir);
  if (pending.length === 0) {
    return { all: [], orphaned: [], active: [] };
  }
  const sessionIds = collectAllSessionIds();
  return crossReference(pending, sessionIds);
}
var SAFE_SESSION_ID_RE = /^[a-zA-Z0-9][-a-zA-Z0-9]*$/;
function validateDeletionPaths(sessionId, pendingDir) {
  if (!sessionId || typeof sessionId !== "string") return { ok: false };
  if (!SAFE_SESSION_ID_RE.test(sessionId)) return { ok: false };
  const resolvedDir = resolve(pendingDir);
  const pendingPath2 = join(resolvedDir, `${sessionId}${PENDING_SUFFIX2}`);
  const stalePath2 = join(resolvedDir, `${sessionId}${STALE_SUFFIX2}`);
  const resolvedPending = resolve(pendingPath2);
  const resolvedStale = resolve(stalePath2);
  if (!resolvedPending.startsWith(resolvedDir + sep)) return { ok: false };
  if (!resolvedStale.startsWith(resolvedDir + sep)) return { ok: false };
  return { ok: true, pendingPath: resolvedPending, stalePath: resolvedStale };
}
function deletePendingFiles(sessionId, agentDir) {
  const dir = join(getAgentDir(), PENDING_DIR2);
  const valid = validateDeletionPaths(sessionId, dir);
  if (!valid.ok) return false;
  const { pendingPath: pendingPath2, stalePath: stalePath2 } = valid;
  let deleted = false;
  try {
    if (existsSync(pendingPath2)) {
      unlinkSync(pendingPath2);
      deleted = true;
    }
  } catch {
  }
  try {
    if (existsSync(stalePath2)) {
      unlinkSync(stalePath2);
      deleted = true;
    }
  } catch {
  }
  return deleted;
}
function deleteOrphanedBatch(orphaned, agentDir) {
  let count = 0;
  for (const pf of orphaned) {
    if (deletePendingFiles(pf.sessionId)) {
      count++;
    }
  }
  return count;
}
function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
function formatAge(mtimeMs, nowMs = Date.now()) {
  const diffMs = nowMs - mtimeMs;
  const seconds = Math.floor(diffMs / 1e3);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 365) return `${days}d ago`;
  const years = Math.floor(days / 365);
  return `${years}y ago`;
}
function describeFile(pf, nowMs) {
  const label = pf.isStale ? "stale" : "pending";
  return `${pf.sessionId.slice(0, 8)}\u2026 ${label}  ${formatSize(pf.sizeBytes)}  ${formatAge(pf.mtimeMs, nowMs)}`;
}

// src/commands/cleanup.ts
var LIST_ROWS = 10;
function clampIndex(idx, length) {
  if (length === 0) return 0;
  return Math.max(0, Math.min(idx, length - 1));
}
function buildTopBorder(width, border, dim, title, right) {
  const innerW = Math.max(1, width - 2);
  if (!title && !right) {
    return border(`\u250F${"\u2501".repeat(innerW)}\u2513`);
  }
  const rightText = right ? ` ${right} ` : "";
  const titleBudget = Math.max(1, innerW - visibleWidth(rightText) - 1);
  const titleFitted = title ? ` ${title.slice(0, Math.max(1, titleBudget - 2))}${title.length > titleBudget - 2 ? "\u2026" : ""} ` : "";
  const fill = Math.max(1, innerW - visibleWidth(titleFitted) - visibleWidth(rightText));
  return border(`\u250F${titleFitted}${"\u2501".repeat(fill)}${right ? dim(rightText) : ""}\u2513`);
}
function createCleanupPicker(orphaned, theme, done) {
  let selectedIndex = 0;
  let scrollOffset = 0;
  let confirmDeleteAll = false;
  function clampScroll() {
    const count = orphaned.length;
    selectedIndex = clampIndex(selectedIndex, count);
    const maxOffset = Math.max(0, count - LIST_ROWS);
    scrollOffset = Math.max(0, Math.min(scrollOffset, maxOffset));
    if (selectedIndex < scrollOffset) scrollOffset = selectedIndex;
    if (selectedIndex >= scrollOffset + LIST_ROWS && count > 0) {
      scrollOffset = selectedIndex - LIST_ROWS + 1;
    }
  }
  const bdr = (t) => theme.fg("border", t);
  const dim = (t) => theme.fg("dim", t);
  const accent = (t) => theme.fg("accent", t);
  const err = (t) => theme.fg("error", t);
  const now = Date.now();
  function itemLine(pf, isSel, cw) {
    const desc = describeFile(pf, now);
    const prefix = isSel ? accent(" \u25B6") : "  ";
    const main = isSel ? accent(desc) : desc;
    const line = `${prefix} ${main}`;
    return ` ${line}${" ".repeat(Math.max(0, cw - visibleWidth(line)))} `;
  }
  return {
    invalidate() {
    },
    render(width) {
      const w = Math.max(40, width);
      const innerW = Math.max(1, w - 2);
      const PX = 1;
      const cw = Math.max(1, innerW - PX * 2);
      const lines = [];
      if (confirmDeleteAll) {
        const title = `Delete ${orphaned.length} orphaned file${orphaned.length === 1 ? "" : "s"}?`;
        lines.push(buildTopBorder(w, bdr, dim, "Cleanup Pending Files"));
        lines.push(bdr(`\u2503${" ".repeat(innerW)}\u2503`));
        lines.push(bdr(`\u2503 ${err(title)}${" ".repeat(Math.max(0, cw - visibleWidth(title)))} \u2503`));
        lines.push(bdr(`\u2503${" ".repeat(innerW)}\u2503`));
        const hint = "Enter confirm \xB7 Esc cancel";
        lines.push(bdr(`\u2503 ${dim(hint)}${" ".repeat(Math.max(0, cw - visibleWidth(hint)))} \u2503`));
        lines.push(bdr(`\u2517${"\u2501".repeat(innerW)}\u251B`));
        return lines;
      }
      clampScroll();
      const sizeLabel = `${orphaned.length} file${orphaned.length === 1 ? "" : "s"}`;
      lines.push(buildTopBorder(w, bdr, dim, "Orphaned Pending Files", sizeLabel));
      lines.push(bdr(`\u2503${" ".repeat(innerW)}\u2503`));
      if (orphaned.length === 0) {
        lines.push(
          bdr(`\u2503 ${dim("No orphaned pending files found")}${" ".repeat(Math.max(0, cw - 29))} \u2503`)
        );
      } else {
        const visible = orphaned.slice(scrollOffset, scrollOffset + LIST_ROWS);
        for (let vi = 0; vi < visible.length; vi++) {
          const idx = scrollOffset + vi;
          const pf = visible[vi];
          if (!pf) continue;
          const isSel = idx === selectedIndex;
          const row = itemLine(pf, isSel, cw);
          lines.push(isSel ? theme.bg("selectedBg", bdr(`\u2503${row}\u2503`)) : bdr(`\u2503${row}\u2503`));
        }
      }
      for (let i = Math.min(orphaned.length, LIST_ROWS); i < LIST_ROWS; i++) {
        lines.push(bdr(`\u2503${" ".repeat(innerW)}\u2503`));
      }
      lines.push(bdr(`\u2503${" ".repeat(innerW)}\u2503`));
      if (orphaned.length > 0) {
        const totalBytes = orphaned.reduce((s, pf) => s + pf.sizeBytes, 0);
        const kb = totalBytes > 0 ? (totalBytes / 1024).toFixed(1) : "0.0";
        const totalStr = `Total: ${kb} KB`;
        const hint = "\u2191\u2193 navigate  Enter delete  D delete all  Esc cancel";
        lines.push(
          bdr(`\u2503 ${dim(totalStr)}${" ".repeat(Math.max(0, cw - visibleWidth(totalStr)))} \u2503`)
        );
        lines.push(bdr(`\u2503 ${dim(hint)}${" ".repeat(Math.max(0, cw - visibleWidth(hint)))} \u2503`));
      } else {
        const hint = "Esc close";
        lines.push(bdr(`\u2503 ${dim(hint)}${" ".repeat(Math.max(0, cw - visibleWidth(hint)))} \u2503`));
      }
      lines.push(bdr(`\u2517${"\u2501".repeat(innerW)}\u251B`));
      return lines;
    },
    handleInput(data) {
      const key = decodeKittyPrintable(data) ?? data;
      if (confirmDeleteAll) {
        if (matchesKey(data, "enter") || matchesKey(data, "return")) {
          done("deleteAll");
          return;
        }
        if (matchesKey(data, "escape")) {
          confirmDeleteAll = false;
          return;
        }
        return;
      }
      if (orphaned.length === 0) {
        if (matchesKey(data, "escape")) done("cancel");
        return;
      }
      if (matchesKey(data, "up")) {
        selectedIndex = clampIndex(selectedIndex - 1, orphaned.length);
        clampScroll();
        return;
      }
      if (matchesKey(data, "down")) {
        selectedIndex = clampIndex(selectedIndex + 1, orphaned.length);
        clampScroll();
        return;
      }
      if (matchesKey(data, "pageUp") || key === "-") {
        selectedIndex = clampIndex(selectedIndex - LIST_ROWS, orphaned.length);
        clampScroll();
        return;
      }
      if (matchesKey(data, "pageDown") || key === "=") {
        selectedIndex = clampIndex(selectedIndex + LIST_ROWS, orphaned.length);
        clampScroll();
        return;
      }
      if (matchesKey(data, "home")) {
        selectedIndex = 0;
        scrollOffset = 0;
        return;
      }
      if (matchesKey(data, "end")) {
        selectedIndex = Math.max(0, orphaned.length - 1);
        clampScroll();
        return;
      }
      if (matchesKey(data, "enter") || matchesKey(data, "return")) {
        const pf = orphaned[selectedIndex];
        if (pf) {
          deletePendingFiles(pf.sessionId);
          orphaned.splice(selectedIndex, 1);
          if (orphaned.length === 0) {
            done("cancel");
            return;
          }
          selectedIndex = clampIndex(selectedIndex, orphaned.length);
          clampScroll();
        }
        return;
      }
      if (key === "d" || key === "D") {
        confirmDeleteAll = true;
        return;
      }
      if (matchesKey(data, "escape")) {
        done("cancel");
        return;
      }
    }
  };
}
async function handleCleanup(ctx) {
  const { orphaned } = analyzeOrphaned();
  if (orphaned.length === 0) {
    ctx.ui.notify("No orphaned pending files found.", "info");
    return;
  }
  const isRpc = ctx.mode === "rpc" || ctx.mode === "json" || ctx.mode === "print";
  if (isRpc) {
    const totalSize = orphaned.reduce((s, pf) => s + pf.sizeBytes, 0);
    const lines = [
      `Orphaned pending files: ${orphaned.length} (${(totalSize / 1024).toFixed(1)} KB)`,
      "",
      ...orphaned.map((pf) => `  ${describeFile(pf)}`),
      "",
      "Use /memory cleanup in TUI mode to delete these files."
    ];
    ctx.ui.notify(lines.join("\n"), "warning");
    return;
  }
  const items = [...orphaned];
  const result = await ctx.ui.custom(
    (_tui, theme, _kb, done) => {
      return createCleanupPicker(items, theme, done);
    },
    { overlay: true }
  );
  if (result === "deleteAll") {
    const deleted = deleteOrphanedBatch(items);
    const intended = items.length;
    if (deleted === intended) {
      ctx.ui.notify(
        `Deleted ${intended} orphaned pending file${intended === 1 ? "" : "s"}.`,
        "info"
      );
    } else {
      ctx.ui.notify(
        `Deleted ${deleted}/${intended} orphaned pending file${intended === 1 ? "" : "s"} (${intended - deleted} failed).`,
        "warning"
      );
    }
  } else if (items.length > 0 && items.length < orphaned.length) {
    const remainingSize = items.reduce((s, pf) => s + pf.sizeBytes, 0);
    ctx.ui.notify(
      `${orphaned.length - items.length} deleted, ${items.length} remain (${(remainingSize / 1024).toFixed(1)} KB).`,
      "info"
    );
  } else if (items.length === 0 && orphaned.length > 0) {
    ctx.ui.notify(
      `All ${orphaned.length} orphaned pending file${orphaned.length === 1 ? "" : "s"} removed.`,
      "info"
    );
  }
}

// src/pi-base/core/config-env.ts
function applyEnvOverrides2(config2, env, defaults) {
  const result = {
    ...config2
  };
  for (const [key, value] of Object.entries(env)) {
    if (!value) continue;
    const defaultValue = defaults[key];
    if (typeof value === "string") {
      if (typeof defaultValue === "boolean") {
        result[key] = readBooleanEnv(value, result[key] ?? defaultValue);
      } else if (typeof defaultValue === "number") {
        if (Number.isInteger(defaultValue) && defaultValue > 0) {
          result[key] = readPositiveIntEnv(
            value,
            result[key] ?? defaultValue
          );
        } else {
          const raw = process.env[value]?.trim();
          if (raw) {
            const parsed = Number.parseFloat(raw);
            if (Number.isFinite(parsed)) {
              result[key] = parsed;
            }
          }
        }
      }
    } else {
      const raw = process.env[value.var]?.trim();
      if (raw) {
        const parsed = value.parse(raw, result[key]);
        if (parsed !== void 0) {
          result[key] = parsed;
        }
      }
    }
  }
  return result;
}
var DEFAULT_PADDING_X = 1;
var DEFAULT_PADDING_Y = 1;
var FRAME_VERTICAL_CHROME = 2 + DEFAULT_PADDING_Y * 2;
function frameContentWidth(width, paddingX = DEFAULT_PADDING_X) {
  return Math.max(1, width - 2 - paddingX * 2);
}
function pad(text, width) {
  const truncated = truncateToWidth(text, width, "");
  return `${truncated}${" ".repeat(Math.max(0, width - visibleWidth(truncated)))}`;
}
function wrapLine(line, width) {
  const safeWidth = Math.max(1, width);
  const rawStr = String(line ?? "");
  const normalized = rawStr.includes("	") ? rawStr.replace(/\t/g, "  ") : rawStr;
  const parts = normalized.includes("\n") || normalized.includes("\r") ? normalized.split(/\r?\n/) : [normalized];
  const wrapped = parts.flatMap((part) => {
    const rows = wrapTextWithAnsi(part, safeWidth);
    return rows.length > 0 ? rows : [""];
  });
  return wrapped.map((part) => truncateToWidth(part, safeWidth, ""));
}
function divider(width, theme) {
  return theme.fg("dim", "\u2500".repeat(Math.max(1, width)));
}
function formatHintLine(hints, theme) {
  return hints.map((h) => `${theme.fg("accent", h.key)} ${theme.fg("dim", h.label)}`).join(theme.fg("dim", " \xB7 "));
}
function frame(lines, width, theme, options = {}) {
  const paddingX = options.paddingX ?? DEFAULT_PADDING_X;
  const paddingY = options.paddingY ?? DEFAULT_PADDING_Y;
  const inner = Math.max(1, width - 2);
  const contentWidth = frameContentWidth(width, paddingX);
  const border = (s) => theme.fg("borderAccent", s);
  let body = lines;
  if (options.fixedInnerRows !== void 0 && body.length > options.fixedInnerRows) {
    const hidden = body.length - options.fixedInnerRows + 1;
    body = [
      ...body.slice(0, Math.max(0, options.fixedInnerRows - 1)),
      theme.fg("dim", `\u2193 ${hidden} more line(s)`)
    ].slice(0, options.fixedInnerRows);
  }
  const blank = `${border("\u2502")}${" ".repeat(inner)}${border("\u2502")}`;
  const top = () => {
    if (!options.title) return `${border("\u256D")}${border("\u2500".repeat(inner))}${border("\u256E")}`;
    const titlePlain = ` ${truncateToWidth(options.title, Math.max(1, inner - 4), "\u2026")} `;
    const titleVisible = visibleWidth(titlePlain);
    const leftDash = 2;
    const rightDash = Math.max(1, inner - leftDash - titleVisible);
    return `${border("\u256D")}${border("\u2500".repeat(leftDash))}${theme.fg("accent", theme.bold(titlePlain))}${border("\u2500".repeat(rightDash))}${border("\u256E")}`;
  };
  const out = [top()];
  if (options.subtitle) {
    for (const line of options.subtitle.split(/\r?\n/)) {
      const text = theme.fg("dim", pad(truncateToWidth(line, contentWidth, "\u2026"), contentWidth));
      out.push(`${border("\u2502")}${" ".repeat(paddingX)}${text}${" ".repeat(paddingX)}${border("\u2502")}`);
    }
  }
  for (let i = 0; i < paddingY; i += 1) out.push(blank);
  for (const line of body) {
    out.push(
      `${border("\u2502")}${" ".repeat(paddingX)}${pad(line, contentWidth)}${" ".repeat(paddingX)}${border("\u2502")}`
    );
  }
  for (let i = 0; i < paddingY; i += 1) out.push(blank);
  out.push(`${border("\u2570")}${border("\u2500".repeat(inner))}${border("\u256F")}`);
  return out.map((line) => truncateToWidth(line, width, ""));
}
function responsiveInnerRows(terminalRows, preferred, minimum = 12, ratio = 0.85) {
  const available = Math.max(
    minimum + FRAME_VERTICAL_CHROME,
    Math.floor(Math.max(1, terminalRows) * ratio)
  );
  return Math.max(minimum, Math.min(preferred, available - FRAME_VERTICAL_CHROME));
}

// src/pi-base/settings/confirm.ts
function createConfirm(options, done, args) {
  const confirmLabel = options.confirmLabel ?? "Confirm";
  const cancelLabel = options.cancelLabel ?? "Cancel";
  const isDanger = options.danger ?? false;
  const items = isDanger ? [
    { label: cancelLabel, confirmed: false },
    { label: confirmLabel, confirmed: true }
  ] : [
    { label: confirmLabel, confirmed: true },
    { label: cancelLabel, confirmed: false }
  ];
  let selectedIndex = 0;
  const render = (width) => {
    const contentWidth = Math.max(1, width - 2);
    const lines = [];
    lines.push("");
    for (const raw of options.message) {
      for (const wrapped of wrapLine(raw, contentWidth)) {
        const text = isDanger ? args.theme.fg("warning", wrapped) : wrapped;
        lines.push(`  ${text}`);
      }
    }
    lines.push("");
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      const isSelected = i === selectedIndex;
      const prefix = isSelected ? args.theme.fg("accent", "\u258C ") : "  ";
      const rawLabel = `${i + 1}. ${item.label}`;
      const label = isSelected ? args.theme.fg("text", rawLabel) : args.theme.fg("muted", rawLabel);
      const rowText = `${prefix}${label}`;
      if (isSelected) {
        lines.push(args.theme.bg("selectedBg", rowText));
      } else {
        lines.push(rowText);
      }
    }
    lines.push("");
    const hints = [
      { key: "\u2191\u2193", label: "select" },
      { key: "1-2/y/n", label: "choose" },
      { key: "enter/space", label: "confirm" },
      { key: "esc", label: "cancel" }
    ];
    lines.push(args.theme.fg("muted", `  ${formatHintLine(hints, args.theme)}`));
    return lines;
  };
  const handleInput = (data) => {
    if (matchesKey(data, "up") || matchesKey(data, "left")) {
      selectedIndex = (selectedIndex - 1 + items.length) % items.length;
      args.tui.requestRender();
      return;
    }
    if (matchesKey(data, "down") || matchesKey(data, "right")) {
      selectedIndex = (selectedIndex + 1) % items.length;
      args.tui.requestRender();
      return;
    }
    if (matchesKey(data, "enter") || matchesKey(data, "return") || data === " ") {
      done(items[selectedIndex].confirmed);
      return;
    }
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      done(false);
      return;
    }
    if (data === "1" || data === "2") {
      const idx = parseInt(data, 10) - 1;
      if (idx >= 0 && idx < items.length) {
        done(items[idx].confirmed);
        return;
      }
    }
    if (data === "y" || data === "Y") {
      const confirmItem = items.find((i) => i.confirmed);
      if (confirmItem) {
        done(confirmItem.confirmed);
        return;
      }
    }
    if (data === "n" || data === "N") {
      const cancelItem = items.find((i) => !i.confirmed);
      if (cancelItem) {
        done(cancelItem.confirmed);
        return;
      }
    }
  };
  return { render, handleInput, invalidate: () => {
  } };
}
var UNFRAMED_CHROME_COLUMNS = 2;
function createScopeSelector(args) {
  const availableEntries = args.entries.filter((e) => e.available);
  let selectedAvailableIndex = 0;
  const render = (width) => {
    if (args.frame !== false) {
      const innerWidth = frameContentWidth(width);
      const bodyLines = [];
      bodyLines.push(divider(innerWidth, args.theme));
      for (let i = 0; i < args.entries.length; i += 1) {
        const entry = args.entries[i];
        const availableIndex = availableEntries.indexOf(entry);
        const isSelected = entry.available && availableIndex === selectedAvailableIndex;
        if (i > 0) bodyLines.push("");
        const prefix = isSelected ? args.theme.fg("accent", "\u258C ") : "  ";
        const numPrefix = availableIndex >= 0 && availableEntries.length <= 9 ? `${availableIndex + 1}. ` : "";
        let label = `${numPrefix}${entry.label}`;
        if (!entry.available) {
          label = args.theme.fg("dim", label);
        } else if (isSelected) {
          label = args.theme.fg("text", label);
        } else {
          label = args.theme.fg("muted", label);
        }
        const note = entry.note ? ` ${args.theme.fg("dim", entry.note)}` : "";
        bodyLines.push(`${prefix}${label}${note}`);
      }
      bodyLines.push("");
      const hints2 = [];
      if (availableEntries.length > 0) {
        hints2.push({ key: "\u2191\u2193", label: "select" });
        if (availableEntries.length > 1 && availableEntries.length <= 9) {
          hints2.push({ key: `1-${availableEntries.length}`, label: "choose" });
        }
        if (availableEntries.length > 2) {
          hints2.push({ key: "home/end", label: "top/bottom" });
        }
        hints2.push({ key: "enter/space", label: "confirm" });
      }
      hints2.push({ key: "esc", label: "cancel" });
      bodyLines.push(args.theme.fg("muted", `  ${formatHintLine(hints2, args.theme)}`));
      return frame(bodyLines, width, args.theme, {
        title: args.title,
        subtitle: args.subtitle
      });
    }
    const contentWidth = Math.max(1, width - UNFRAMED_CHROME_COLUMNS);
    const lines = [];
    lines.push("");
    if (args.subtitle) {
      for (const raw of args.subtitle.split(/\r?\n/)) {
        const text = args.theme.fg("dim", raw);
        lines.push(`  ${text}`);
      }
    }
    lines.push("");
    lines.push(divider(contentWidth, args.theme));
    for (let i = 0; i < args.entries.length; i += 1) {
      const entry = args.entries[i];
      const availableIndex = availableEntries.indexOf(entry);
      const isSelected = entry.available && availableIndex === selectedAvailableIndex;
      if (i > 0) lines.push("");
      const prefix = isSelected ? args.theme.fg("accent", "\u258C ") : "  ";
      const numPrefix = availableIndex >= 0 && availableEntries.length <= 9 ? `${availableIndex + 1}. ` : "";
      let label = `${numPrefix}${entry.label}`;
      if (!entry.available) {
        label = args.theme.fg("dim", label);
      } else if (isSelected) {
        label = args.theme.fg("text", label);
      } else {
        label = args.theme.fg("muted", label);
      }
      const note = entry.note ? ` ${args.theme.fg("dim", entry.note)}` : "";
      lines.push(`${prefix}${label}${note}`);
    }
    lines.push("");
    const hints = [];
    if (availableEntries.length > 0) {
      hints.push({ key: "\u2191\u2193", label: "select" });
      if (availableEntries.length > 1 && availableEntries.length <= 9) {
        hints.push({ key: `1-${availableEntries.length}`, label: "choose" });
      }
      if (availableEntries.length > 2) {
        hints.push({ key: "home/end", label: "top/bottom" });
      }
      hints.push({ key: "enter/space", label: "confirm" });
    }
    hints.push({ key: "esc", label: "cancel" });
    lines.push(args.theme.fg("muted", `  ${formatHintLine(hints, args.theme)}`));
    return lines;
  };
  const handleInput = (data) => {
    if (availableEntries.length === 0) {
      if (matchesKey(data, "escape")) {
        args.done({ kind: "cancel" });
      }
      return;
    }
    if (matchesKey(data, "up")) {
      selectedAvailableIndex = (selectedAvailableIndex - 1 + availableEntries.length) % availableEntries.length;
      args.tui.requestRender();
      return;
    }
    if (matchesKey(data, "home")) {
      selectedAvailableIndex = 0;
      args.tui.requestRender();
      return;
    }
    if (matchesKey(data, "end")) {
      selectedAvailableIndex = availableEntries.length - 1;
      args.tui.requestRender();
      return;
    }
    if (matchesKey(data, "down")) {
      selectedAvailableIndex = (selectedAvailableIndex + 1) % availableEntries.length;
      args.tui.requestRender();
      return;
    }
    if (matchesKey(data, "enter") || matchesKey(data, "return") || data === " ") {
      const selected = availableEntries[selectedAvailableIndex];
      args.done({ kind: "select", id: selected.id });
      return;
    }
    if (matchesKey(data, "escape")) {
      args.done({ kind: "cancel" });
      return;
    }
    if (/^[1-9]$/.test(data)) {
      const idx = parseInt(data, 10) - 1;
      if (idx >= 0 && idx < availableEntries.length) {
        const selected = availableEntries[idx];
        args.done({ kind: "select", id: selected.id });
        return;
      }
    }
  };
  return { render, handleInput, invalidate: () => {
  } };
}
var actionRenderer = {
  type: "action",
  renderValue(row, { selected, ctx }) {
    const text = row.field.display ?? "(run)";
    if (row.field.disabled) {
      return ctx.theme.fg("muted", `${text} (unavailable)`);
    }
    return ctx.theme.fg(selected ? "accent" : "muted", text);
  },
  hints(row) {
    if (row.field.disabled) return [];
    return [{ key: "enter/space", label: "run" }];
  },
  handleKey(row, data, { ctx }) {
    if (row.field.disabled) return {};
    if (matchesKey(data, "enter") || matchesKey(data, "return") || data === " ") {
      try {
        const ret = row.field.onActivate(ctx.ctx);
        if (ret && typeof ret.then === "function") {
          ret.catch(() => {
          });
        }
      } catch {
      }
      return { consumed: true };
    }
    return {};
  }
};
var booleanRenderer = {
  type: "boolean",
  renderValue(row, { selected, ctx }) {
    if (row.field.disabled) {
      const text = row.value ? "[\u2713] on" : "[ ] off";
      return ctx.theme.fg("muted", text);
    }
    if (row.value) {
      const indicator = ctx.theme.fg(selected ? "accent" : "success", "\u2713");
      const label = ctx.theme.fg(selected ? "accent" : "success", "on");
      return `[${indicator}] ${label}`;
    } else {
      const indicator = ctx.theme.fg(selected ? "accent" : "muted", " ");
      const label = ctx.theme.fg(selected ? "accent" : "muted", "off");
      return `[${indicator}] ${label}`;
    }
  },
  hints(row) {
    if (row.field.disabled) return [];
    return [
      { key: "enter/space", label: row.value ? "turn off" : "turn on" },
      { key: "\u2190/\u2192", label: "toggle" }
    ];
  },
  handleKey(row, data) {
    if (row.field.disabled) return {};
    if (matchesKey(data, "enter") || matchesKey(data, "return") || data === " ") {
      return { consumed: true, commit: !row.value };
    }
    if (matchesKey(data, "left")) {
      if (row.value === false) return { consumed: true };
      return { consumed: true, commit: false };
    }
    if (matchesKey(data, "right")) {
      if (row.value === true) return { consumed: true };
      return { consumed: true, commit: true };
    }
    return {};
  }
};
var customRenderer = {
  type: "custom",
  renderValue(row, args) {
    const text = row.field.render({
      value: row.value,
      width: args.width,
      selected: args.selected && !row.field.disabled,
      theme: args.ctx.theme
    });
    if (row.field.disabled) {
      return args.ctx.theme.fg("muted", text);
    }
    return text;
  },
  hints(row) {
    if (row.field.disabled) return [];
    if (row.field.hints) return row.field.hints;
    if (row.field.openSubmenu) return [{ key: "enter/space", label: "open" }];
    if (row.field.handleInput) return [{ key: "enter/space", label: "edit" }];
    return [];
  },
  handleKey(row, data, args) {
    if (row.field.disabled) return {};
    if (row.field.handleInput) {
      const consumed = row.field.handleInput(data, {
        value: row.value,
        width: 0,
        selected: true,
        theme: args.ctx.theme
      });
      if (consumed) return { consumed: true };
    }
    if (matchesKey(data, "enter") || matchesKey(data, "return") || data === " ") {
      if (row.field.openSubmenu) {
        const factory = (done) => row.field.openSubmenu({
          value: row.value,
          theme: args.ctx.theme,
          tui: args.ctx.tui,
          done
        });
        return { consumed: true, submenu: factory };
      }
    }
    return {};
  }
};
var GRAPHEME_SEGMENTER = new Intl.Segmenter(void 0, { granularity: "grapheme" });
var yankBuffer = "";
function inlineEditChars(text) {
  const out = [];
  for (const { segment, index } of GRAPHEME_SEGMENTER.segment(text)) {
    out.push({ ch: segment, start: index, end: index + segment.length });
  }
  return out;
}
function clampInlineCursor(editing) {
  editing.cursor = Math.max(0, Math.min(editing.cursor, editing.buffer.length));
}
function codeUnitToCharIndex(chars, cursor) {
  let index = 0;
  while (index < chars.length && chars[index].end <= cursor) index += 1;
  return index;
}
function charIndexToCodeUnit(chars, index, textLength) {
  if (index <= 0) return 0;
  if (index >= chars.length) return textLength;
  return chars[index].start;
}
function inlineCharKind(ch) {
  if (/\s/u.test(ch)) return "space";
  if (/[A-Za-z0-9_]/.test(ch)) return "word";
  return "punct";
}
function moveInlineCursorByChars(editing, delta) {
  const chars = inlineEditChars(editing.buffer);
  const index = codeUnitToCharIndex(chars, editing.cursor);
  editing.cursor = charIndexToCodeUnit(chars, index + delta, editing.buffer.length);
}
function moveInlineCursorWordLeft(editing) {
  const chars = inlineEditChars(editing.buffer);
  let index = codeUnitToCharIndex(chars, editing.cursor);
  while (index > 0 && inlineCharKind(chars[index - 1].ch) === "space") index -= 1;
  if (index <= 0) {
    editing.cursor = 0;
    return;
  }
  const kind = inlineCharKind(chars[index - 1].ch);
  while (index > 0 && inlineCharKind(chars[index - 1].ch) === kind) index -= 1;
  editing.cursor = charIndexToCodeUnit(chars, index, editing.buffer.length);
}
function moveInlineCursorWordRight(editing) {
  const chars = inlineEditChars(editing.buffer);
  let index = codeUnitToCharIndex(chars, editing.cursor);
  while (index < chars.length && inlineCharKind(chars[index].ch) === "space") index += 1;
  if (index >= chars.length) {
    editing.cursor = editing.buffer.length;
    return;
  }
  const kind = inlineCharKind(chars[index].ch);
  while (index < chars.length && inlineCharKind(chars[index].ch) === kind) index += 1;
  editing.cursor = charIndexToCodeUnit(chars, index, editing.buffer.length);
}
function insertInlineText(editing, text) {
  clampInlineCursor(editing);
  editing.buffer = `${editing.buffer.slice(0, editing.cursor)}${text}${editing.buffer.slice(editing.cursor)}`;
  editing.cursor += text.length;
}
function deleteInlineRange(editing, start, end) {
  const safeStart = Math.max(0, Math.min(start, editing.buffer.length));
  const safeEnd = Math.max(safeStart, Math.min(end, editing.buffer.length));
  editing.buffer = `${editing.buffer.slice(0, safeStart)}${editing.buffer.slice(safeEnd)}`;
  editing.cursor = safeStart;
}
function isPlainSearchInput(data) {
  const decoded = decodeKittyPrintable(data) ?? data;
  return decoded.length === 1 && decoded >= " " && decoded !== "\x7F";
}
function handleInlineEditInput(editing, data) {
  clampInlineCursor(editing);
  if (matchesKey(data, "left") || matchesKey(data, "ctrl+b")) {
    moveInlineCursorByChars(editing, -1);
    return true;
  }
  if (matchesKey(data, "right") || matchesKey(data, "ctrl+f")) {
    moveInlineCursorByChars(editing, 1);
    return true;
  }
  if (matchesKey(data, "alt+left") || matchesKey(data, "ctrl+left") || matchesKey(data, "alt+b")) {
    moveInlineCursorWordLeft(editing);
    return true;
  }
  if (matchesKey(data, "alt+right") || matchesKey(data, "ctrl+right") || matchesKey(data, "alt+f")) {
    moveInlineCursorWordRight(editing);
    return true;
  }
  if (matchesKey(data, "home") || matchesKey(data, "ctrl+a")) {
    editing.cursor = 0;
    return true;
  }
  if (matchesKey(data, "end") || matchesKey(data, "ctrl+e")) {
    editing.cursor = editing.buffer.length;
    return true;
  }
  if (matchesKey(data, "backspace") || matchesKey(data, "ctrl+h")) {
    const before = editing.cursor;
    moveInlineCursorByChars(editing, -1);
    deleteInlineRange(editing, editing.cursor, before);
    return true;
  }
  if (matchesKey(data, "delete")) {
    const start = editing.cursor;
    moveInlineCursorByChars(editing, 1);
    deleteInlineRange(editing, start, editing.cursor);
    return true;
  }
  if (matchesKey(data, "ctrl+u")) {
    editing.buffer = "";
    editing.cursor = 0;
    return true;
  }
  if (matchesKey(data, "ctrl+w")) {
    const current = editing.cursor;
    moveInlineCursorWordLeft(editing);
    const target = editing.cursor;
    const killedText = editing.buffer.slice(target, current);
    if (killedText) {
      yankBuffer = killedText;
    }
    deleteInlineRange(editing, target, current);
    return true;
  }
  if (matchesKey(data, "alt+d")) {
    const current = editing.cursor;
    moveInlineCursorWordRight(editing);
    const target = editing.cursor;
    const killedText = editing.buffer.slice(current, target);
    if (killedText) {
      yankBuffer = killedText;
    }
    deleteInlineRange(editing, current, target);
    return true;
  }
  if (matchesKey(data, "ctrl+k")) {
    const killedText = editing.buffer.slice(editing.cursor);
    if (killedText) {
      yankBuffer = killedText;
    }
    deleteInlineRange(editing, editing.cursor, editing.buffer.length);
    return true;
  }
  if (matchesKey(data, "ctrl+y")) {
    if (yankBuffer) {
      insertInlineText(editing, yankBuffer);
    }
    return true;
  }
  if (isPlainSearchInput(data)) {
    const decoded = decodeKittyPrintable(data) ?? data;
    insertInlineText(editing, decoded);
    return true;
  }
  return false;
}
function renderInlineEditValue(editing) {
  clampInlineCursor(editing);
  return `${editing.buffer.slice(0, editing.cursor)}\u2588${editing.buffer.slice(editing.cursor)}`;
}
function deleteWordBackward(text) {
  let i = text.length;
  while (i > 0 && /\s/.test(text[i - 1])) {
    i--;
  }
  if (i === 0) return "";
  const charKind = (ch) => {
    if (/\s/.test(ch)) return "space";
    if (/[A-Za-z0-9_]/.test(ch)) return "word";
    return "punct";
  };
  const kind = charKind(text[i - 1]);
  while (i > 0 && charKind(text[i - 1]) === kind) {
    i--;
  }
  return text.slice(0, i);
}

// src/pi-base/settings/fields/enum.ts
var DEFAULT_CYCLE_THRESHOLD = 4;
var MAX_VISIBLE_ROWS = 12;
function labelFor(field, value) {
  return field.optionLabels?.[value] ?? value;
}
function nextCycleValue(field, current) {
  if (field.options.length === 0) return current;
  const idx = field.options.indexOf(current);
  const nextIdx = (idx + 1 + field.options.length) % field.options.length;
  return field.options[nextIdx];
}
function prevCycleValue(field, current) {
  if (field.options.length === 0) return current;
  const idx = field.options.indexOf(current);
  const prevIdx = (idx - 1 + field.options.length) % field.options.length;
  return field.options[prevIdx];
}
function makeEnumSubmenu(field, current, ctx) {
  if (field.search) {
    return makeSearchableEnumSubmenu(field, current, ctx);
  }
  return (done) => {
    const items = field.options.map((value, idx2) => {
      const isActive = value === current;
      const activeSuffix = isActive ? `  ${ctx.theme.fg("success", "\u2714")}` : "";
      return {
        value,
        label: `${idx2 + 1}. ${labelFor(field, value)}${activeSuffix}`
      };
    });
    const list = new SelectList(
      items,
      Math.min(items.length, MAX_VISIBLE_ROWS),
      getSelectListTheme()
    );
    const idx = field.options.indexOf(current);
    list.setSelectedIndex(idx >= 0 ? idx : 0);
    list.onSelect = (item) => done(item.value);
    list.onCancel = () => done();
    const component = {
      render(width) {
        const lines = [...list.render(width)];
        lines.push("");
        const hints = [
          { key: "\u2191\u2193", label: "select" },
          ...items.length > 1 ? [{ key: `1-${Math.min(9, items.length)}`, label: "choose" }] : [],
          { key: "enter/space", label: "save" },
          ...field.default !== void 0 ? [{ key: "alt+r", label: "reset" }] : [],
          { key: "esc", label: "cancel" }
        ];
        const hintText = `  ${formatHintLine(hints, ctx.theme)}`;
        lines.push(truncateToWidth(hintText, width, "\u2026", true));
        return lines;
      },
      invalidate() {
        list.invalidate();
      },
      handleInput(data) {
        if (matchesKey(data, "alt+r") && field.default !== void 0) {
          const defaultIdx = field.options.indexOf(field.default);
          if (defaultIdx >= 0) {
            list.setSelectedIndex(defaultIdx);
            ctx.tui.requestRender();
          }
          return;
        }
        if (data === " ") {
          const item = list.getSelectedItem();
          if (item) {
            done(item.value);
            return;
          }
        }
        const num = parseInt(data, 10);
        if (data.length === 1 && !isNaN(num) && num >= 1 && num <= Math.min(9, items.length)) {
          const item = items[num - 1];
          if (item) {
            done(item.value);
            return;
          }
        }
        list.handleInput(data);
        ctx.tui.requestRender();
      }
    };
    return component;
  };
}
function makeSearchableEnumSubmenu(field, current, ctx) {
  return (done) => {
    const allItems = field.options.map((value) => ({
      value,
      label: labelFor(field, value)
    }));
    let search = "";
    let selected = 0;
    function filteredItems() {
      if (!search.trim()) {
        return allItems.map((item, idx) => ({
          ...item,
          label: `${idx + 1}. ${item.label}`
        }));
      }
      const q = search.toLowerCase();
      return allItems.filter(
        (item) => item.label.toLowerCase().includes(q) || item.value.toLowerCase().includes(q)
      );
    }
    const component = {
      render(width) {
        const lines = [];
        const items = filteredItems();
        const cursor = ctx.theme.inverse(" ");
        const hasMatches = items.length > 0;
        let searchPrompt;
        if (!search) {
          searchPrompt = `Search: ${cursor}${ctx.theme.fg("muted", "type to filter\u2026")}`;
        } else {
          const queryColor = hasMatches ? "accent" : "warning";
          searchPrompt = `Search: ${ctx.theme.fg(queryColor, search)}${cursor}`;
        }
        lines.push(ctx.theme.bg("toolPendingBg", truncateToWidth(searchPrompt, width, "\u2026", true)));
        lines.push("");
        if (items.length === 0) {
          if (search) {
            const prefix = ctx.theme.fg("muted", "  No matching options for '");
            const q = ctx.theme.fg("warning", search);
            const suffix = ctx.theme.fg("muted", "'. (press esc or ctrl+u to clear)");
            lines.push(`${prefix}${q}${suffix}`);
          } else {
            lines.push(ctx.theme.fg("muted", "  No options available. (press esc to cancel)"));
          }
        } else {
          const maxVisible = MAX_VISIBLE_ROWS;
          const scroll = Math.max(
            0,
            Math.min(selected - Math.floor(maxVisible / 2), Math.max(0, items.length - maxVisible))
          );
          const slice = items.slice(scroll, scroll + maxVisible);
          for (let i = 0; i < slice.length; i++) {
            const isSelected = scroll + i === selected;
            const prefix = isSelected ? ctx.theme.fg("accent", "\u258C ") : "  ";
            const item = slice[i];
            const isActive = item.value === current;
            const activeSuffix = isActive ? `  ${ctx.theme.fg("success", "\u2714")}` : "";
            const display = isSelected ? ctx.theme.fg("accent", item.label) : ctx.theme.fg("muted", item.label);
            const line = `${prefix}${display}${activeSuffix}`;
            lines.push(
              isSelected ? ctx.theme.bg("selectedBg", truncateToWidth(line, width, "\u2026", true)) : truncateToWidth(line, width, "\u2026", true)
            );
          }
        }
        lines.push("");
        const hints = [{ key: "\u2191\u2193", label: "select" }];
        if (!search && items.length > 1) {
          hints.push({ key: `1-${Math.min(9, items.length)}`, label: "choose" });
        }
        hints.push({ key: "enter", label: "save" });
        if (field.default !== void 0) {
          hints.push({ key: "alt+r", label: "reset" });
        }
        if (search) {
          hints.push({ key: "ctrl+w", label: "delete word" });
          hints.push({ key: "ctrl+u", label: "clear" });
          hints.push({ key: "esc", label: "clear filter" });
        } else {
          hints.push({ key: "esc", label: "cancel" });
        }
        const hintText = formatHintLine(hints, ctx.theme);
        lines.push(`  ${truncateToWidth(hintText, width, "\u2026", true)}`);
        return lines;
      },
      invalidate() {
      },
      handleInput(data) {
        const items = filteredItems();
        if (matchesKey(data, "alt+r") && field.default !== void 0) {
          search = "";
          const newItems = filteredItems();
          const defaultIdx = newItems.findIndex((item) => item.value === field.default);
          if (defaultIdx >= 0) {
            selected = defaultIdx;
          }
          ctx.tui.requestRender();
          return;
        }
        if (matchesKey(data, "home")) {
          selected = 0;
          ctx.tui.requestRender();
          return;
        }
        if (matchesKey(data, "end")) {
          selected = Math.max(0, items.length - 1);
          ctx.tui.requestRender();
          return;
        }
        if (matchesKey(data, "pageUp")) {
          selected = Math.max(0, selected - MAX_VISIBLE_ROWS);
          ctx.tui.requestRender();
          return;
        }
        if (matchesKey(data, "pageDown")) {
          selected = Math.min(Math.max(0, items.length - 1), selected + MAX_VISIBLE_ROWS);
          ctx.tui.requestRender();
          return;
        }
        if (!search.trim()) {
          const num = parseInt(data, 10);
          if (data.length === 1 && !isNaN(num) && num >= 1 && num <= Math.min(9, items.length)) {
            const item = items[num - 1];
            if (item) {
              done(item.value);
              return;
            }
          }
        }
        if (matchesKey(data, "up")) {
          selected = Math.max(0, selected - 1);
          ctx.tui.requestRender();
          return;
        }
        if (matchesKey(data, "down")) {
          selected = Math.min(selected + 1, Math.max(0, items.length - 1));
          ctx.tui.requestRender();
          return;
        }
        if (matchesKey(data, "enter") || matchesKey(data, "return")) {
          if (items.length > 0) {
            done(items[Math.min(selected, items.length - 1)].value);
          }
          return;
        }
        if (matchesKey(data, "escape")) {
          if (search !== "") {
            const selectedValue = items[selected]?.value;
            search = "";
            const newItems = filteredItems();
            const newIndex = selectedValue ? newItems.findIndex((item) => item.value === selectedValue) : -1;
            selected = newIndex >= 0 ? newIndex : 0;
            ctx.tui.requestRender();
          } else {
            done();
          }
          return;
        }
        if (matchesKey(data, "ctrl+u")) {
          search = "";
          selected = 0;
          ctx.tui.requestRender();
          return;
        }
        if (matchesKey(data, "ctrl+w")) {
          search = deleteWordBackward(search);
          selected = 0;
          ctx.tui.requestRender();
          return;
        }
        if (matchesKey(data, "backspace") || matchesKey(data, "ctrl+h")) {
          search = search.slice(0, -1);
          selected = 0;
          ctx.tui.requestRender();
          return;
        }
        if (data.length === 1 && data >= " " && data !== "\x7F") {
          search += data;
          selected = 0;
          ctx.tui.requestRender();
        }
      }
    };
    return component;
  };
}
var enumRenderer = {
  type: "enum",
  renderValue(row, { selected, ctx }) {
    const text = labelFor(row.field, row.value);
    if (row.field.disabled) {
      const desc2 = row.field.valueDescriptions?.[row.value];
      const suffix2 = desc2 ? ` (${desc2})` : "";
      return ctx.theme.fg("muted", text + suffix2);
    }
    const desc = row.field.valueDescriptions?.[row.value];
    const suffix = desc ? ` ${ctx.theme.fg("dim", `(${desc})`)}` : "";
    return ctx.theme.fg(selected ? "accent" : "muted", text) + suffix;
  },
  hints(row) {
    if (row.field.disabled) return [];
    if (row.field.search) {
      return [{ key: "enter/space", label: "open list" }];
    }
    const threshold = row.field.cycleThreshold ?? DEFAULT_CYCLE_THRESHOLD;
    if (row.field.options.length > threshold) {
      return [{ key: "enter/space", label: "open list" }];
    }
    return [
      { key: "enter/space", label: "cycle" },
      { key: "\u2190/\u2192", label: "prev/next" }
    ];
  },
  handleKey(row, data, { ctx }) {
    if (row.field.disabled) return {};
    if (row.field.search) {
      if (matchesKey(data, "enter") || matchesKey(data, "return") || data === " ") {
        return {
          consumed: true,
          submenu: makeEnumSubmenu(row.field, row.value, ctx)
        };
      }
      return {};
    }
    const threshold = row.field.cycleThreshold ?? DEFAULT_CYCLE_THRESHOLD;
    const isLongList = row.field.options.length > threshold;
    if (matchesKey(data, "enter") || matchesKey(data, "return") || data === " ") {
      if (isLongList) {
        return {
          consumed: true,
          submenu: makeEnumSubmenu(row.field, row.value, ctx)
        };
      }
      return { consumed: true, commit: nextCycleValue(row.field, row.value) };
    }
    if (!isLongList) {
      if (matchesKey(data, "left")) {
        const prev = prevCycleValue(row.field, row.value);
        if (prev === row.value) return { consumed: true };
        return { consumed: true, commit: prev };
      }
      if (matchesKey(data, "right")) {
        const next = nextCycleValue(row.field, row.value);
        if (next === row.value) return { consumed: true };
        return { consumed: true, commit: next };
      }
    }
    return {};
  }
};
var ALL_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max"
];
var LEVEL_FALLBACK_LABELS = {
  off: "off",
  minimal: "min",
  low: "low",
  medium: "med",
  high: "high",
  xhigh: "xhigh",
  max: "max"
};
var DEFAULT_SESSION_LABEL = "(session model)";
var MAX_VISIBLE_MODELS = 12;
function effortDisplayLabel(level, thinkingLevelMap) {
  const mapped = thinkingLevelMap?.[level];
  if (typeof mapped === "string" && mapped.length > 0) return mapped;
  return LEVEL_FALLBACK_LABELS[level] ?? level;
}
function listModelOptions(field, ctx) {
  if (field.models) return field.models;
  const sessionLabel = field.sessionLabel ?? DEFAULT_SESSION_LABEL;
  const available = ctx.ctx.modelRegistry.getAvailable();
  const filtered = field.filter ? available.filter(field.filter) : available;
  const live = filtered.map((m) => ({
    value: `${m.provider}/${m.id}`,
    label: `${m.name}  [${m.provider}]`,
    model: m
  }));
  return field.hideSession ? live : [{ value: "", label: sessionLabel }, ...live];
}
function resolveModelForValue(field, value, ctx) {
  if (!value.id) return void 0;
  if (field.models) {
    const opt = field.models.find((o) => o.value === value.id);
    if (opt?.model) return opt.model;
  }
  const slash = value.id.indexOf("/");
  if (slash <= 0) return void 0;
  const provider = value.id.slice(0, slash);
  const id = value.id.slice(slash + 1);
  return ctx.ctx.modelRegistry.find(provider, id);
}
function supportedEfforts(model) {
  if (!model || !model.thinkingLevelMap) return ALL_THINKING_LEVELS;
  const map = model.thinkingLevelMap;
  return ALL_THINKING_LEVELS.filter((lvl) => !(lvl in map && map[lvl] === null));
}
function clampEffort(desired, supported) {
  if (desired && supported.includes(desired)) return desired;
  return supported.includes("medium") ? "medium" : supported[0] ?? "off";
}
function modelDisplay(field, value) {
  if (value.id === "") return field.sessionLabel ?? DEFAULT_SESSION_LABEL;
  return value.id;
}
function rowLabel(field, value, ctx) {
  const left = modelDisplay(field, value);
  if (field.hideEffort) return left;
  if (!value.thinking) return left;
  const model = resolveModelForValue(field, value, ctx);
  const label = effortDisplayLabel(value.thinking, model?.thinkingLevelMap);
  return `${left}  \xB7  ${label}`;
}
function makeSubmenu(field, current, ctx) {
  return (done) => {
    const allOptions = listModelOptions(field, ctx);
    const showEffort = !field.hideEffort;
    const filter = { buffer: "", cursor: 0 };
    let list;
    let visibleOptions = [];
    let effortIndex = 0;
    let supported = [];
    const refreshEffort = (preferred) => {
      if (!showEffort) return;
      const item = list.getSelectedItem();
      const opt = visibleOptions.find((m) => m.value === item?.value);
      supported = supportedEfforts(opt?.model);
      if (supported.length === 0) supported = ["off"];
      const clamped = clampEffort(preferred, supported);
      effortIndex = Math.max(0, supported.indexOf(clamped));
    };
    const buildList = (preserveValue) => {
      const query = filter.buffer.trim().toLowerCase();
      visibleOptions = query ? allOptions.filter(
        (o) => o.label.toLowerCase().includes(query) || o.value.toLowerCase().includes(query)
      ) : allOptions;
      const items = visibleOptions.map((m, idx2) => ({
        value: m.value,
        label: !query ? `${idx2 + 1}. ${m.label}` : m.label,
        description: m.value || void 0
      }));
      list = new SelectList(
        items,
        Math.min(Math.max(items.length, 1), MAX_VISIBLE_MODELS),
        getSelectListTheme()
      );
      const idx = preserveValue !== void 0 ? items.findIndex((i) => i.value === preserveValue) : -1;
      list.setSelectedIndex(idx >= 0 ? idx : 0);
      list.onSelect = (item) => {
        if (showEffort) {
          refreshEffort(supported[effortIndex]);
          const effort = supported[effortIndex] ?? "off";
          done({ id: item.value, thinking: effort });
        } else {
          done({ id: item.value });
        }
      };
      list.onCancel = () => done();
      list.onSelectionChange = () => {
        if (showEffort) {
          const previous = supported[effortIndex];
          refreshEffort(previous);
        }
        ctx.tui.requestRender();
      };
    };
    buildList(current.id);
    refreshEffort(current.thinking);
    const renderEffortRow = (width) => {
      const currentLevel = supported[effortIndex] ?? "off";
      const item = list.getSelectedItem();
      const opt = visibleOptions.find((m) => m.value === item?.value);
      const displayLabel = effortDisplayLabel(currentLevel, opt?.model?.thinkingLevelMap);
      const left = effortIndex > 0 ? ctx.theme.fg("accent", "\u2039") : ctx.theme.fg("dim", "\u2039");
      const right = effortIndex < supported.length - 1 ? ctx.theme.fg("accent", "\u203A") : ctx.theme.fg("dim", "\u203A");
      const label = ctx.theme.fg("muted", "  effort: ");
      const valueText = displayLabel === currentLevel ? displayLabel : `${displayLabel} ${ctx.theme.fg("dim", `(${currentLevel})`)}`;
      const value = ctx.theme.fg("accent", ctx.theme.bold(valueText));
      const counter = ctx.theme.fg("dim", `  (${effortIndex + 1}/${supported.length})`);
      return truncateToWidth(`${label}${left} ${value} ${right}${counter}`, width, "\u2026", true);
    };
    const renderFilterRow = (width) => {
      const cursorBlock = ctx.theme.inverse(" ");
      const buf = filter.buffer;
      const before = buf.slice(0, filter.cursor);
      const after = buf.slice(filter.cursor);
      const placeholder = !buf ? ctx.theme.fg("dim", "  filter models\u2026") : "";
      const hasMatches = visibleOptions.length > 0;
      const colorKey = hasMatches ? "accent" : "warning";
      const text = buf ? `  ${ctx.theme.fg("muted", "filter:")} ${ctx.theme.fg(colorKey, before)}${cursorBlock}${ctx.theme.fg(colorKey, after)}` : `  ${ctx.theme.fg("muted", "filter:")} ${cursorBlock}${placeholder}`;
      return truncateToWidth(text, width, "\u2026", true);
    };
    const renderHints = (width) => {
      const hints = [{ key: "\u2191\u2193", label: "model" }];
      if (showEffort) hints.push({ key: "\u2190\u2192", label: "effort" });
      if (!filter.buffer && visibleOptions.length > 1) {
        hints.push({ key: `1-${Math.min(9, visibleOptions.length)}`, label: "choose" });
      }
      hints.push({ key: "type", label: "filter" });
      if (field.default !== void 0) {
        hints.push({ key: "alt+r", label: "reset" });
      }
      hints.push({ key: "enter", label: "save" });
      if (filter.buffer !== "") {
        hints.push({ key: "ctrl+w", label: "delete word" });
        hints.push({ key: "ctrl+u", label: "clear" });
        hints.push({ key: "esc", label: "clear filter" });
      } else {
        hints.push({ key: "esc", label: "cancel" });
      }
      return truncateToWidth(`  ${formatHintLine(hints, ctx.theme)}`, width, "\u2026", true);
    };
    return {
      render(width) {
        const lines = [];
        lines.push(renderFilterRow(width));
        lines.push("");
        if (visibleOptions.length === 0) {
          if (filter.buffer) {
            const prefix = ctx.theme.fg("muted", "  No matching models for '");
            const q = ctx.theme.fg("warning", filter.buffer);
            const suffix = ctx.theme.fg("muted", "'. (press esc or ctrl+u to clear)");
            lines.push(`${prefix}${q}${suffix}`);
          } else {
            lines.push(ctx.theme.fg("muted", "  No models available. (press esc to cancel)"));
          }
        } else {
          for (const line of list.render(width)) lines.push(line);
        }
        lines.push("");
        if (showEffort) {
          lines.push(renderEffortRow(width));
          lines.push("");
        }
        lines.push(renderHints(width));
        return lines;
      },
      invalidate() {
        list.invalidate();
      },
      handleInput(data) {
        if (matchesKey(data, "alt+r") && field.default !== void 0) {
          filter.buffer = "";
          filter.cursor = 0;
          buildList(field.default.id);
          refreshEffort(field.default.thinking);
          ctx.tui.requestRender();
          return;
        }
        if (!filter.buffer) {
          const num = parseInt(data, 10);
          if (data.length === 1 && !isNaN(num) && num >= 1 && num <= Math.min(9, visibleOptions.length)) {
            const item = visibleOptions[num - 1];
            if (item) {
              if (showEffort) {
                const idx = visibleOptions.findIndex((m) => m.value === item.value);
                if (idx >= 0) list.setSelectedIndex(idx);
                refreshEffort(supported[effortIndex]);
                const effort = supported[effortIndex] ?? "off";
                done({ id: item.value, thinking: effort });
              } else {
                done({ id: item.value });
              }
              return;
            }
          }
        }
        if (showEffort) {
          if (matchesKey(data, "left")) {
            if (effortIndex > 0) {
              effortIndex -= 1;
              ctx.tui.requestRender();
            }
            return;
          }
          if (matchesKey(data, "right")) {
            if (effortIndex < supported.length - 1) {
              effortIndex += 1;
              ctx.tui.requestRender();
            }
            return;
          }
        }
        if (matchesKey(data, "escape") && filter.buffer !== "") {
          const previousValue2 = list.getSelectedItem()?.value;
          filter.buffer = "";
          filter.cursor = 0;
          buildList(previousValue2);
          refreshEffort(supported[effortIndex]);
          ctx.tui.requestRender();
          return;
        }
        if (matchesKey(data, "up") || matchesKey(data, "down") || matchesKey(data, "enter") || matchesKey(data, "return") || matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
          list.handleInput(data);
          ctx.tui.requestRender();
          return;
        }
        const previousValue = list.getSelectedItem()?.value;
        const consumed = handleInlineEditInput(filter, data);
        if (consumed) {
          buildList(previousValue);
          refreshEffort(supported[effortIndex]);
          ctx.tui.requestRender();
        }
      }
    };
  };
}
var modelRenderer = {
  type: "model",
  renderValue(row, { selected, ctx }) {
    const text = rowLabel(row.field, row.value, ctx);
    if (row.field.disabled) {
      return ctx.theme.fg("muted", text);
    }
    return ctx.theme.fg(selected ? "accent" : "muted", text);
  },
  hints(row) {
    if (row.field.disabled) return [];
    return [{ key: "enter/space", label: "open" }];
  },
  handleKey(row, data, { ctx }) {
    if (row.field.disabled) return {};
    if (matchesKey(data, "enter") || matchesKey(data, "return") || data === " ") {
      return { consumed: true, submenu: makeSubmenu(row.field, row.value, ctx) };
    }
    return {};
  }
};
function getEditState(args, key) {
  const registry = args.ctx.editStates;
  return registry?.get(key);
}
function setEditState(args, key, state) {
  const registry = args.ctx.editStates;
  if (!registry) return;
  if (state === void 0) registry.delete(key);
  else registry.set(key, state);
}
function maskedSecret(value) {
  if (!value) return "(unset)";
  return "\u2022\u2022\u2022\u2022\u2022\u2022";
}
function placeholderOrEmpty(field, value, dim) {
  if (value) return value;
  const placeholder = field.placeholder;
  if (placeholder) return dim(placeholder);
  return dim("(unset)");
}
var stringRenderer = {
  type: "string",
  renderValue(row, args) {
    const dim = (s) => args.ctx.theme.fg("dim", s);
    if (row.field.disabled) {
      const text2 = placeholderOrEmpty(row.field, row.value, dim);
      return args.ctx.theme.fg("muted", text2);
    }
    if (args.isEditing) {
      const state = getEditState(args, row.field.key);
      if (state) {
        return args.ctx.theme.fg("accent", renderInlineEditValue(state));
      }
    }
    const text = placeholderOrEmpty(row.field, row.value, dim);
    return args.selected ? args.ctx.theme.fg("text", text) : args.ctx.theme.fg("muted", text);
  },
  hints(row, { isEditing }) {
    if (row.field.disabled) return [];
    if (isEditing) {
      const hints = [
        { key: "enter", label: "save" },
        { key: "esc", label: "cancel" },
        { key: "\u2190/\u2192", label: "move" },
        { key: "ctrl+w", label: "delete word" },
        { key: "ctrl+u", label: "clear" }
      ];
      if (row.field.default !== void 0) {
        hints.push({ key: "alt+r", label: "reset" });
      }
      return hints;
    }
    return [{ key: "enter", label: "edit" }];
  },
  handleKey(row, data, args) {
    if (row.field.disabled) return {};
    return handleStringLikeKey(
      row.field.key,
      row.value,
      data,
      args,
      (buf) => buf,
      row.field.default
    );
  }
};
var pathRenderer = {
  type: "path",
  renderValue(row, args) {
    return stringRenderer.renderValue(row, args);
  },
  hints(row, args) {
    return stringRenderer.hints(
      row,
      args
    );
  },
  handleKey(row, data, args) {
    if (row.field.disabled) return {};
    return handleStringLikeKey(
      row.field.key,
      row.value,
      data,
      args,
      (buf) => buf,
      row.field.default
    );
  }
};
var secretRenderer = {
  type: "secret",
  renderValue(row, args) {
    if (row.field.disabled) {
      const display2 = maskedSecret(row.value);
      return args.ctx.theme.fg("muted", display2);
    }
    if (args.isEditing) {
      const state = getEditState(args, row.field.key);
      if (state) {
        const masked = "\u2022".repeat(state.buffer.length);
        const view = {
          buffer: masked,
          cursor: state.cursor
        };
        return args.ctx.theme.fg("accent", renderInlineEditValue(view));
      }
    }
    const display = maskedSecret(row.value);
    return args.selected ? args.ctx.theme.fg("text", display) : args.ctx.theme.fg(row.value ? "success" : "muted", display);
  },
  hints(row, args) {
    return stringRenderer.hints(
      row,
      args
    );
  },
  handleKey(row, data, args) {
    if (row.field.disabled) return {};
    return handleStringLikeKey(
      row.field.key,
      row.value,
      data,
      args,
      (buf) => buf,
      row.field.default
    );
  }
};
function nextValue(values, current) {
  if (values.length === 0) return current;
  const idx = values.indexOf(current);
  return values[(idx + 1 + values.length) % values.length];
}
function prevValue(values, current) {
  if (values.length === 0) return current;
  const idx = values.indexOf(current);
  return values[(idx - 1 + values.length) % values.length];
}
function stepUp(value, step, min, max) {
  const next = value + step;
  if (max !== void 0 && next > max) return min ?? value;
  return next;
}
function stepDown(value, step, min, max) {
  const prev = value - step;
  if (min !== void 0 && prev < min) return max ?? value;
  return prev;
}
function getValueDesc(field) {
  return field.valueDescriptions?.[String(field.value)];
}
function makeNumberValuesSubmenu(field, current, _valueDesc, ctx) {
  const values = field.values ?? [];
  return (done) => {
    const items = values.map((v, idx2) => {
      const isActive = v === current;
      const activeSuffix = isActive ? `  ${ctx.theme.fg("success", "\u2714")}` : "";
      return {
        value: String(v),
        label: `${idx2 + 1}. ${v}${activeSuffix}`
      };
    });
    const list = new SelectList(items, Math.min(items.length, 12), getSelectListTheme());
    const idx = items.findIndex((i) => Number(i.value) === current);
    list.setSelectedIndex(idx >= 0 ? idx : 0);
    list.onSelect = (item) => done(Number(item.value));
    list.onCancel = () => done();
    const component = {
      render(width) {
        const lines = [...list.render(width)];
        lines.push("");
        const hints = [
          { key: "\u2191\u2193", label: "select" },
          ...items.length > 1 ? [{ key: `1-${Math.min(9, items.length)}`, label: "choose" }] : [],
          { key: "enter/space", label: "save" },
          ...field.default !== void 0 ? [{ key: "alt+r", label: "reset" }] : [],
          { key: "esc", label: "cancel" }
        ];
        const hintText = `  ${formatHintLine(hints, ctx.theme)}`;
        lines.push(truncateToWidth(hintText, width, "\u2026", true));
        return lines;
      },
      invalidate() {
        list.invalidate();
      },
      handleInput(data) {
        if (matchesKey(data, "alt+r") && field.default !== void 0) {
          const defaultIdx = values.indexOf(field.default);
          if (defaultIdx >= 0) {
            list.setSelectedIndex(defaultIdx);
            ctx.tui.requestRender();
          }
          return;
        }
        if (data === " ") {
          const item = list.getSelectedItem();
          if (item) {
            done(Number(item.value));
            return;
          }
        }
        const num = parseInt(data, 10);
        if (data.length === 1 && !isNaN(num) && num >= 1 && num <= Math.min(9, items.length)) {
          const item = items[num - 1];
          if (item) {
            done(Number(item.value));
            return;
          }
        }
        list.handleInput(data);
        ctx.tui.requestRender();
      }
    };
    return component;
  };
}
var numberRenderer = {
  type: "number",
  renderValue(row, args) {
    if (row.field.disabled) {
      const text2 = String(row.value);
      return args.ctx.theme.fg("muted", text2);
    }
    if (args.isEditing) {
      const state = getEditState(args, row.field.key);
      if (state) {
        return args.ctx.theme.fg("accent", renderInlineEditValue(state));
      }
    }
    const text = String(row.value);
    return args.selected ? args.ctx.theme.fg("text", text) : args.ctx.theme.fg("muted", text);
  },
  hints(row, args) {
    if (row.field.disabled) return [];
    if (args.isEditing) {
      return [
        { key: "enter", label: "save" },
        { key: "esc", label: "cancel" },
        { key: "\u2190/\u2192", label: "move" },
        { key: "ctrl+w", label: "delete word" },
        { key: "ctrl+u", label: "clear" },
        ...row.field.default !== void 0 ? [{ key: "alt+r", label: "reset" }] : []
      ];
    }
    const { values, step } = row.field;
    if (values && values.length > 4) return [{ key: "enter", label: "open list" }];
    if (values && values.length > 0) {
      return [
        { key: "enter/space", label: "cycle" },
        { key: "\u2190/\u2192", label: "prev/next" }
      ];
    }
    if (step !== void 0) {
      return [
        { key: "enter/space", label: "edit" },
        { key: "\u2190/\u2192", label: "step" }
      ];
    }
    return stringRenderer.hints(
      row,
      args
    );
  },
  handleKey(row, data, args) {
    if (row.field.disabled) return {};
    const { values, step } = row.field;
    if (values && values.length > 0) {
      if (matchesKey(data, "enter") || matchesKey(data, "return") || data === " ") {
        if (values.length > 4) {
          return {
            consumed: true,
            submenu: makeNumberValuesSubmenu(
              row.field,
              row.value,
              getValueDesc(row.field),
              args.ctx
            )
          };
        }
        return { consumed: true, commit: nextValue(values, row.value) };
      }
      if (matchesKey(data, "left")) {
        return { consumed: true, commit: prevValue(values, row.value) };
      }
      if (matchesKey(data, "right")) {
        return { consumed: true, commit: nextValue(values, row.value) };
      }
      return {};
    }
    if (step !== void 0) {
      if (!args.isEditing) {
        if (matchesKey(data, "left")) {
          return {
            consumed: true,
            commit: stepDown(row.value, step, row.field.min, row.field.max)
          };
        }
        if (matchesKey(data, "right")) {
          return {
            consumed: true,
            commit: stepUp(row.value, step, row.field.min, row.field.max)
          };
        }
      }
      return handleStringLikeKey(
        row.field.key,
        String(row.value),
        data,
        args,
        (buffer2) => {
          const trimmed = buffer2.trim();
          if (trimmed === "") throw new Error("Expected a number");
          const parsed = Number(trimmed);
          if (!Number.isFinite(parsed)) throw new Error(`Not a number: '${buffer2}'`);
          if (row.field.integer && !Number.isInteger(parsed))
            throw new Error("Expected an integer");
          if (typeof row.field.min === "number" && parsed < row.field.min)
            throw new Error(`Must be \u2265 ${row.field.min}`);
          if (typeof row.field.max === "number" && parsed > row.field.max)
            throw new Error(`Must be \u2264 ${row.field.max}`);
          return parsed;
        },
        row.field.default
      );
    }
    return handleStringLikeKey(
      row.field.key,
      String(row.value),
      data,
      args,
      (buffer2) => {
        const trimmed = buffer2.trim();
        if (trimmed === "") throw new Error("Expected a number");
        const parsed = Number(trimmed);
        if (!Number.isFinite(parsed)) throw new Error(`Not a number: '${buffer2}'`);
        if (row.field.integer && !Number.isInteger(parsed)) throw new Error("Expected an integer");
        if (typeof row.field.min === "number" && parsed < row.field.min)
          throw new Error(`Must be \u2265 ${row.field.min}`);
        if (typeof row.field.max === "number" && parsed > row.field.max)
          throw new Error(`Must be \u2264 ${row.field.max}`);
        if (values && !values.includes(parsed))
          throw new Error(`Must be one of: ${values.join(", ")}`);
        return parsed;
      },
      row.field.default
    );
  }
};
function handleStringLikeKey(key, initialBuffer, data, args, parse2, defaultValue) {
  const initialStr = String(initialBuffer);
  if (!args.isEditing) {
    if (matchesKey(data, "enter") || matchesKey(data, "return")) {
      setEditState(args, key, { buffer: initialStr, cursor: initialStr.length });
      args.setEditing(true);
      return { consumed: true };
    }
    return {};
  }
  if (matchesKey(data, "alt+r") && defaultValue !== void 0) {
    const defaultStr = String(defaultValue);
    setEditState(args, key, { buffer: defaultStr, cursor: defaultStr.length });
    return { consumed: true };
  }
  if (matchesKey(data, "enter") || matchesKey(data, "return")) {
    const state2 = getEditState(args, key);
    if (!state2) {
      args.setEditing(false);
      return { consumed: true };
    }
    try {
      const value = parse2(state2.buffer);
      setEditState(args, key, void 0);
      args.setEditing(false);
      return { consumed: true, commit: value };
    } catch (error) {
      throw error;
    }
  }
  if (matchesKey(data, "escape")) {
    setEditState(args, key, void 0);
    args.setEditing(false);
    return { consumed: true };
  }
  const state = getEditState(args, key);
  if (!state) {
    setEditState(args, key, { buffer: initialStr, cursor: initialStr.length });
    return { consumed: true };
  }
  if (handleInlineEditInput(state, data)) {
    return { consumed: true };
  }
  return { consumed: true };
}

// src/pi-base/settings/fields/readonly.ts
var readonlyRenderer = {
  type: "readonly",
  renderValue(row, args) {
    const value = row.value;
    if (row.field.disabled) {
      return args.ctx.theme.fg("muted", value);
    }
    if (row.field.emphasis) {
      return args.ctx.theme.fg("accent", value);
    }
    return args.selected ? args.ctx.theme.fg("text", value) : args.ctx.theme.fg("muted", value);
  },
  hints(row) {
    if (row.field.disabled) {
      return [];
    }
    if (row.field.hint) {
      return [{ key: "info", label: row.field.hint }];
    }
    return [];
  },
  handleKey() {
    return {};
  }
};
var textRenderer = {
  type: "text",
  renderValue(row, { selected, ctx }) {
    const display = formatTextPreview(row.value);
    if (row.field.disabled) {
      return ctx.theme.fg("muted", display);
    }
    return ctx.theme.fg(selected ? "accent" : "muted", display);
  },
  hints(row) {
    if (row.field.disabled) return [];
    return [{ key: "enter", label: "open editor" }];
  },
  handleKey(row, data, { ctx }) {
    if (row.field.disabled) return {};
    if (data === "\r" || data === "\n") {
      return {
        consumed: true,
        submenu: makeTextSubmenu(row.value, ctx)
      };
    }
    return {};
  }
};
function formatTextPreview(value) {
  const lineCount = value.split("\n").length;
  const preview = value.replace(/\s+/g, " ").trim();
  const quoted = preview ? JSON.stringify(preview) : '""';
  const suffix = lineCount > 1 ? ` (${lineCount} lines)` : "";
  return `${truncateToWidth(quoted, 48, "...")}${suffix}`;
}
function makeTextSubmenu(current, ctx) {
  return (done) => {
    const editor = new Editor(
      ctx.tui,
      {
        borderColor: (s) => ctx.theme.fg("muted", s),
        selectList: getSelectListTheme()
      },
      {
        paddingX: 0
      }
    );
    editor.setText(current);
    editor.focused = true;
    editor.disableSubmit = true;
    editor.onChange = () => ctx.tui.requestRender();
    const component = {
      render(width) {
        const lines = editor.render(width);
        lines.push("");
        const hints = [
          { key: "ctrl+s", label: "save" },
          { key: "esc", label: "cancel" },
          { key: "ctrl+w", label: "delete word" },
          { key: "ctrl+u", label: "clear" },
          { key: "alt+r", label: "reset" }
        ];
        const hintLine = ctx.theme.fg("dim", formatHintLine(hints, ctx.theme));
        lines.push(truncateToWidth(hintLine, width, "\u2026", true));
        return lines;
      },
      invalidate() {
        editor.invalidate();
      },
      handleInput(data) {
        if (matchesKey(data, "ctrl+s")) {
          done(editor.getExpandedText());
          return;
        }
        if (matchesKey(data, "escape")) {
          done();
          return;
        }
        if (matchesKey(data, "ctrl+u")) {
          editor.setText("");
          ctx.tui.requestRender();
          return;
        }
        if (matchesKey(data, "alt+r")) {
          editor.setText(current);
          ctx.tui.requestRender();
          return;
        }
        let inputData = data;
        if (matchesKey(data, "backspace") || matchesKey(data, "ctrl+h") || data === "\x7F" || data === "\b") {
          inputData = "\x7F";
        }
        editor.handleInput(inputData);
        ctx.tui.requestRender();
      }
    };
    return component;
  };
}

// src/pi-base/settings/fields/index.ts
var RENDERERS = {
  boolean: booleanRenderer,
  enum: enumRenderer,
  string: stringRenderer,
  number: numberRenderer,
  secret: secretRenderer,
  path: pathRenderer,
  text: textRenderer,
  action: actionRenderer,
  model: modelRenderer,
  custom: customRenderer,
  readonly: readonlyRenderer
};

// src/pi-base/settings/helpers.ts
function notifyError(_state, ctx, err) {
  const message = err instanceof Error ? err.message : String(err);
  try {
    ctx.ui.notify(message, "error");
  } catch {
  }
}
function extractInitialValue(field) {
  if (field.type === "action") return void 0;
  return field.value;
}
function totalVisibleItems(state) {
  return state.cachedVisibleIndices.length;
}
function updateVisibleIndices(state, buildCtx) {
  const query = state.search.trim().toLowerCase();
  const out = [];
  const scope = state.activeTabId ?? "global";
  let visCtx;
  for (let i = 0; i < state.rows.length; i += 1) {
    const row = state.rows[i];
    if (state.activeTabId !== void 0 && state.tabs.length > 0) {
      const fallbackTab = state.tabs[0].id;
      const rowTab = row.field.tab ?? fallbackTab;
      if (rowTab !== state.activeTabId) continue;
    }
    if (row.field.visibleWhen) {
      if (!visCtx) {
        visCtx = buildCtx(state, row.field, scope);
      }
      if (!row.field.visibleWhen(visCtx)) continue;
    }
    if (!query) {
      out.push(i);
      continue;
    }
    const fuzzy = fuzzyMatch(query, row.searchIndex);
    if (fuzzy.matches) out.push(i);
  }
  state.cachedVisibleIndices = out;
}
function visibleRowIndices(state) {
  return state.cachedVisibleIndices;
}
function clampSelection(state, visibleRows) {
  const count = totalVisibleItems(state);
  state.fieldSelected = Math.max(0, Math.min(state.fieldSelected, Math.max(0, count - 1)));
  if (state.fieldSelected < state.scroll) state.scroll = state.fieldSelected;
  else if (state.fieldSelected >= state.scroll + visibleRows)
    state.scroll = state.fieldSelected - visibleRows + 1;
  state.scroll = Math.max(0, Math.min(state.scroll, Math.max(0, count - visibleRows)));
}
function focusedIndex(state) {
  const indices = visibleRowIndices(state);
  if (indices.length === 0) return void 0;
  const safe = Math.max(0, Math.min(state.fieldSelected, indices.length - 1));
  return indices[safe];
}
function focusedRow(state) {
  const idx = focusedIndex(state);
  return idx === void 0 ? void 0 : state.rows[idx];
}

// src/pi-base/settings/values.ts
var INITIAL_JSON_CACHE = /* @__PURE__ */ new WeakMap();
var KEY_TO_ROW_CACHE = /* @__PURE__ */ new WeakMap();
function buildVisibilityContext(_state, _field, scope) {
  let cache2 = KEY_TO_ROW_CACHE.get(_state);
  if (!cache2 || cache2.rows !== _state.rows || cache2.rows.length !== _state.rows.length) {
    const map = /* @__PURE__ */ new Map();
    for (let i = 0; i < _state.rows.length; i += 1) {
      const r = _state.rows[i];
      map.set(r.field.key, r);
    }
    cache2 = { rows: _state.rows, map };
    KEY_TO_ROW_CACHE.set(_state, cache2);
  }
  const rowsMap = cache2.map;
  return {
    get: (key) => rowsMap.get(key)?.value,
    scope
  };
}
function isDirty(state) {
  if (!state.isBuffered) return false;
  return state.dirtyKeys.size > 0;
}
function syncDirtyState(state, key, row) {
  if (!state.isBuffered) return;
  const initial = state.initialValues.get(key);
  const targetRow = row ?? state.rows.find((r) => r.field.key === key);
  const current = targetRow?.value;
  let isClean;
  if (typeof initial === "object" && initial !== null) {
    let initialJson = INITIAL_JSON_CACHE.get(initial);
    if (initialJson === void 0) {
      initialJson = JSON.stringify(initial);
      INITIAL_JSON_CACHE.set(initial, initialJson);
    }
    if (current === void 0) {
      isClean = initial === void 0;
    } else {
      const currentJson = JSON.stringify(current);
      isClean = currentJson === initialJson;
    }
  } else {
    isClean = current === initial;
  }
  if (isClean) {
    state.dirtyKeys.delete(key);
  } else {
    state.dirtyKeys.add(key);
  }
}
function commitValue(state, row, value) {
  const previous = row.value;
  const key = row.field.key;
  row.value = value;
  if (state.isBuffered) {
    syncDirtyState(state, key, row);
  }
  updateVisibleIndices(state, buildVisibilityContext);
  try {
    const ret = state.options.onChange?.(
      row.field.key,
      value,
      row.field
    );
    if (ret && typeof ret.then === "function") {
      ret.then(() => {
        if (state.isBuffered) {
          state.args.tui.requestRender();
        }
      }).catch((err) => {
        if (row.value === value) {
          row.value = previous;
        }
        if (state.isBuffered) {
          syncDirtyState(state, key, row);
        }
        notifyError(state, state.args.ctx, err);
        state.args.tui.requestRender();
      });
    }
  } catch (err) {
    row.value = previous;
    if (state.isBuffered) {
      syncDirtyState(state, key, row);
    }
    notifyError(state, state.args.ctx, err);
    state.args.tui.requestRender();
  }
}
function allValues(state) {
  const out = {};
  for (const row of state.rows) {
    out[row.field.key] = row.value;
  }
  return out;
}

// src/pi-base/settings/validate-field.ts
function validateFieldValue(field, value) {
  if (value === void 0 || value === null) return void 0;
  switch (field.type) {
    case "enum": {
      if (typeof value !== "string") return `Must be a string, got ${typeof value}`;
      if (!field.options.includes(value))
        return `Must be one of: ${field.options.join(", ")}`;
      return void 0;
    }
    case "boolean": {
      if (typeof value !== "boolean") return `Must be a boolean, got ${typeof value}`;
      return void 0;
    }
    case "string": {
      if (typeof value !== "string") return `Must be a string, got ${typeof value}`;
      if (value.includes("\n") || value.includes("\r"))
        return "Must be a single-line string (no newlines)";
      return void 0;
    }
    case "text": {
      if (typeof value !== "string") return `Must be a string, got ${typeof value}`;
      return void 0;
    }
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value))
        return `Must be a finite number, got ${typeof value === "number" ? String(value) : typeof value}`;
      if (field.integer && !Number.isInteger(value)) return "Must be an integer";
      if (field.values !== void 0 && field.values.length > 0) {
        if (!field.values.includes(value)) return `Must be one of: ${field.values.join(", ")}`;
      }
      if (typeof field.min === "number" && value < field.min)
        return `Must be at least ${field.min}`;
      if (typeof field.max === "number" && value > field.max) return `Must be at most ${field.max}`;
      if (field.step !== void 0 && field.step > 0) {
        const min = field.min ?? 0;
        const offset = value - min;
        const rem = offset % field.step;
        if (rem > 1e-9 && field.step - rem > 1e-9) {
          return `Must be aligned to step ${field.step}`;
        }
      }
      return void 0;
    }
    case "secret": {
      if (typeof value !== "string") return `Must be a string, got ${typeof value}`;
      return void 0;
    }
    case "path": {
      if (typeof value !== "string") return `Must be a string, got ${typeof value}`;
      return void 0;
    }
    case "model": {
      if (typeof value !== "object" || value === null)
        return `Must be an object with id, got ${typeof value}`;
      const v = value;
      if (typeof v.id !== "string") return `Must have a string id, got ${typeof v.id}`;
      return void 0;
    }
    case "action":
    case "custom":
      return void 0;
    default:
      return void 0;
  }
}

// src/pi-base/settings/render.ts
function renderTabBar(state, width) {
  if (state.tabs.length === 0) return "";
  const cells = [];
  let cache2 = state._keyToTabCache;
  if (!cache2 || cache2.rows !== state.rows || cache2.rows.length !== state.rows.length) {
    const keyToTab = /* @__PURE__ */ new Map();
    const fallbackTab = state.tabs[0]?.id;
    for (const r of state.rows) {
      keyToTab.set(r.field.key, r.field.tab ?? fallbackTab);
    }
    cache2 = { rows: state.rows, map: keyToTab };
    state._keyToTabCache = cache2;
  }
  const dirtyTabIds = /* @__PURE__ */ new Set();
  if (state.isBuffered && state.dirtyKeys.size > 0) {
    for (const key of state.dirtyKeys) {
      const tabId = cache2.map.get(key);
      if (tabId !== void 0) {
        dirtyTabIds.add(tabId);
      }
    }
  }
  for (const tab of state.tabs) {
    let label = tab.label;
    if (state.isBuffered && dirtyTabIds.has(tab.id)) {
      label += " \u25CF Unsaved";
    }
    const isFocused = state.tabActionFocus >= 0 && state.tabActionFocus < state.tabs.length && state.tabs[state.tabActionFocus]?.id === tab.id;
    if (tab.id === state.activeTabId) {
      const prefix = isFocused ? "\u25B6" : "\u25B8";
      const padded = ` ${prefix} ${label} `;
      cells.push(
        state.args.theme.fg("accent", state.args.theme.inverse(state.args.theme.bold(padded)))
      );
    } else if (isFocused) {
      const padded = ` \u25B6 ${label} `;
      cells.push(
        state.args.theme.fg("accent", state.args.theme.inverse(state.args.theme.bold(padded)))
      );
    } else {
      const padded = `   ${label} `;
      cells.push(state.args.theme.bg("selectedBg", state.args.theme.fg("accent", padded)));
    }
  }
  return pad(cells.join(" "), width);
}
function renderSearchBar(state, width, hasMatches = true) {
  const cursor = state.args.theme.inverse(" ");
  let text;
  if (state.search === "") {
    let placeholderText = state.options.searchPlaceholder;
    if (!placeholderText) {
      const activeTab = state.tabs.find((t) => t.id === state.activeTabId) ?? state.tabs[0];
      placeholderText = activeTab ? `Search ${activeTab.label}...` : "Search settings...";
    }
    const placeholder = state.args.theme.fg("muted", placeholderText);
    text = ` > ${cursor}${placeholder}`;
  } else {
    if (!hasMatches) {
      text = ` > ${state.args.theme.fg("warning", state.search)}${cursor}`;
    } else {
      text = ` > ${state.search}${cursor}`;
    }
  }
  return state.args.theme.bg("toolPendingBg", pad(text, width));
}
function renderFooter(state, rendererFor, _width) {
  const row = focusedRow(state);
  let rowHints = [];
  if (row && !state.options.readOnly && row.field.type !== "section" && !row.field.disabled) {
    const renderer = rendererFor(row.field);
    rowHints = [
      ...renderer.hints(
        { field: row.field, value: row.value },
        { isEditing: row.isEditing }
      )
    ];
    if (!row.isEditing && row.field.default !== void 0) {
      if (!rowHints.some((h) => h.key === "alt+r" || h.key === "ctrl+r")) {
        rowHints.push({ key: "alt+r", label: "reset" });
      }
    }
  }
  const line1 = [];
  if (state.tabs.length > 0 || (state.options.actions?.length ?? 0) > 0) {
    line1.push({ key: "tab/shift+tab", label: "cycle" });
  }
  if (state.tabActionFocus >= 0 && !state.options.readOnly) {
    line1.push({ key: "\u2190/\u2192", label: "navigate" });
  }
  line1.push({ key: "\u2191\u2193", label: "move" });
  if (!state.options.readOnly && !row?.isEditing && row?.field.reorderable) {
    line1.push({ key: "alt+\u2191\u2193", label: "reorder" });
  }
  let anyFieldHasDefault = state._anyFieldHasDefault;
  if (anyFieldHasDefault === void 0) {
    anyFieldHasDefault = state.fields.some(
      (f) => f.default !== void 0
    );
    state._anyFieldHasDefault = anyFieldHasDefault;
  }
  if (anyFieldHasDefault && !state.options.readOnly && !row?.isEditing) {
    line1.push({ key: "ctrl+r", label: "reset field" });
  }
  if (state.options.readOnly && state.tabs.length > 0 && (state.options.actions?.length ?? 0) > 0) {
    line1.push({ key: "\u2190 \u2192", label: "navigate" });
  }
  if (state.isBuffered) {
    line1.push({ key: "ctrl+s", label: "save" });
  }
  if (state.options.enableSearch && !row?.isEditing) {
    if (state.search === "") {
      line1.push({ key: "type", label: "to search" });
    } else {
      line1.push({ key: "ctrl+w", label: "delete word" });
      line1.push({ key: "ctrl+u", label: "clear" });
    }
  }
  const line2 = [];
  const actionCount = state.options.actions?.length ?? 0;
  if (state.tabActionFocus >= state.tabs.length && state.tabActionFocus < state.tabs.length + actionCount && actionCount > 0) {
    line2.push({ key: "enter", label: "trigger action" });
  } else {
    line2.push(...rowHints);
  }
  if (state.confirm) {
    line2.push({ key: "\u2191\u2193", label: "select" });
    line2.push({ key: "enter/space", label: "confirm" });
    line2.push({ key: "esc", label: "cancel" });
  } else if (state.options.enableSearch && state.search !== "" && !row?.isEditing) {
    line2.push({ key: "esc", label: "clear search" });
  } else if (state.isBuffered && isDirty(state)) {
    line2.push({ key: "esc", label: "confirm \u2192" });
  } else {
    line2.push({ key: "esc", label: "close" });
  }
  const lines = [formatHintLine(line1, state.args.theme)];
  if (line2.length > 1 || line2.length === 1 && line2[0].key !== "esc") {
    lines.push(formatHintLine(line2, state.args.theme));
  }
  return lines;
}
function renderRow(state, rendererFor, fieldRenderContext, row, width, isSelected) {
  if (row.field.type === "section") {
    const title = row.field.value;
    const prefix2 = isSelected ? state.args.theme.fg("accent", "\u258C ") : "  ";
    const composed2 = `${prefix2}${state.args.theme.fg("dim", title)}`;
    if (isSelected) return state.args.theme.bg("selectedBg", pad(composed2, width));
    return truncateToWidth(composed2, width, "\u2026");
  }
  let labelCache = row._labelCache;
  if (!labelCache || labelCache.width !== width) {
    const labelAlloc2 = Math.min(55, Math.max(28, Math.floor(width * 0.5)));
    const labelText2 = truncateToWidth(row.field.label, labelAlloc2, "\u2026");
    const labelPadding2 = " ".repeat(Math.max(1, labelAlloc2 - visibleWidth(labelText2)));
    labelCache = { width, labelText: labelText2, labelPadding: labelPadding2, labelAlloc: labelAlloc2 };
    row._labelCache = labelCache;
  }
  const { labelText, labelPadding, labelAlloc } = labelCache;
  const valueWidth = Math.max(1, width - labelAlloc - 4);
  const dimRaw = row.field.disabled ? true : row.field.dim;
  const dimFlag = typeof dimRaw === "function" ? dimRaw() : dimRaw;
  const labelColor = dimFlag === true ? "muted" : dimFlag === false ? "text" : isSelected ? "text" : "muted";
  const label = state.args.theme.fg(labelColor, labelText);
  const renderer = rendererFor(row.field);
  const valueText = renderer.renderValue(
    { field: row.field, value: row.value },
    {
      width: valueWidth,
      selected: isSelected,
      isEditing: row.isEditing,
      ctx: fieldRenderContext
    }
  );
  const padding = labelPadding;
  let depthIndent = row._depthIndent;
  if (depthIndent === void 0) {
    depthIndent = "  ".repeat(row.field.depth ?? 0);
    row._depthIndent = depthIndent;
  }
  const prefix = isSelected ? state.args.theme.fg("accent", `${depthIndent}\u258C `) : `${depthIndent}  `;
  let note = "";
  const rawValueNote = row.field.valueNote;
  if (rawValueNote) {
    const resolved = typeof rawValueNote === "function" ? rawValueNote() : rawValueNote;
    if (resolved) note += ` ${state.args.theme.fg("dim", resolved)}`;
  }
  const composed = `${prefix}${label}${padding}${valueText}${note}`;
  if (isSelected) return state.args.theme.bg("selectedBg", pad(composed, width));
  return truncateToWidth(composed, width, "\u2026");
}
function renderBody(state, rendererFor, fieldRenderContext, width, innerRows) {
  const lines = [];
  if (state.tabs.length > 0) {
    lines.push(renderTabBar(state, width));
  }
  const indices = visibleRowIndices(state);
  if (state.options.enableSearch) {
    if (lines.length > 0) lines.push("");
    lines.push(renderSearchBar(state, width, indices.length > 0));
  }
  if (lines.length > 0) {
    lines.push("");
    lines.push(divider(width, state.args.theme));
  }
  const pathNote = state.pathNoteRef.current ?? state.pathNote;
  if (pathNote) {
    lines.push(state.args.theme.fg("dim", truncateToWidth(pathNote, width, "\u2026")));
  }
  const visibleListRows = Math.max(
    3,
    innerRows - lines.length - 2 - estimateDescriptionRows(state)
  );
  clampSelection(state, visibleListRows);
  const fieldCount = indices.length;
  const slice = indices.slice(state.scroll, state.scroll + visibleListRows);
  if (slice.length === 0) {
    if (state.search) {
      const prefix = state.args.theme.fg("muted", "  No matching settings for '");
      const q = state.args.theme.fg("warning", state.search);
      const suffix = state.args.theme.fg("muted", "'. (press esc or ctrl+u to clear)");
      lines.push(`${prefix}${q}${suffix}`);
    } else {
      lines.push(state.args.theme.fg("muted", "  No settings available in this tab."));
    }
  } else {
    if (state.scroll > 0) lines.push(state.args.theme.fg("dim", `  \u2191 ${state.scroll} earlier`));
    for (let visIdx = 0; visIdx < slice.length; visIdx++) {
      const idx = slice[visIdx];
      const realIdx = state.scroll + visIdx;
      const row = state.rows[idx];
      lines.push(
        renderRow(
          state,
          rendererFor,
          fieldRenderContext,
          row,
          width,
          realIdx === state.fieldSelected
        )
      );
    }
    const hidden = Math.max(0, fieldCount - (state.scroll + visibleListRows));
    if (hidden > 0) lines.push(state.args.theme.fg("dim", `  \u2193 ${hidden} more`));
  }
  const focused = focusedRow(state);
  if (focused) {
    renderFieldDesc(state, lines, width, focused);
  }
  while (lines.length < innerRows) lines.push("");
  return lines;
}
function renderFieldDesc(state, lines, width, focused) {
  let desc = focused.field.description ?? "";
  const field = focused.field;
  if (field.disabled) {
    const disabledNote = "This setting is currently disabled.";
    desc = desc ? `${desc} (${disabledNote})` : disabledNote;
  }
  if (field.type === "number") {
    const parts = [];
    if (field.values) {
      parts.push(`values: ${field.values.join(", ")}`);
    } else {
      if (typeof field.min === "number" && typeof field.max === "number") {
        parts.push(`range: ${field.min} to ${field.max}`);
      } else if (typeof field.min === "number") {
        parts.push(`min: ${field.min}`);
      } else if (typeof field.max === "number") {
        parts.push(`max: ${field.max}`);
      }
      if (field.integer) parts.push("integer only");
    }
    if (parts.length > 0) {
      const suffix = `(${parts.join(", ")})`;
      desc = desc ? `${desc} ${suffix}` : suffix;
    }
  }
  if (desc) {
    lines.push("");
    for (const line of wrapLine(desc, Math.max(1, width - 4))) {
      lines.push(state.args.theme.fg("muted", `  ${line}`));
    }
  }
  let vdText;
  if (field.type === "boolean") {
    const vd = field.valueDescriptions;
    if (vd) {
      const key = focused.value ? "on" : "off";
      vdText = vd[key];
    }
  } else if (field.type === "enum") {
    const vd = field.valueDescriptions;
    if (vd) {
      vdText = vd[focused.value];
    }
  } else if (field.type === "number") {
    const vd = field.valueDescriptions;
    if (vd) {
      vdText = vd[String(focused.value)];
    }
  }
  if (vdText) {
    lines.push("");
    const vdColor = field.disabled ? "muted" : "accent";
    for (const line of wrapLine(state.args.theme.fg(vdColor, vdText), Math.max(1, width - 4))) {
      lines.push(`  ${line}`);
    }
  }
  const warning = validateFieldValue(focused.field, focused.value);
  if (warning) {
    lines.push("");
    for (const line of wrapLine(warning, Math.max(1, width - 4))) {
      lines.push(state.args.theme.fg("warning", `  ${line}`));
    }
  }
}
function estimateDescriptionRows(state) {
  const focused = focusedRow(state);
  if (!focused) return 0;
  let estimate = 0;
  if (focused.field.description || focused.field.disabled) estimate = 2;
  const field = focused.field;
  if (field.type === "number") {
    if (typeof field.min === "number" || typeof field.max === "number" || field.integer) {
      estimate = Math.max(estimate, 2);
    }
  }
  const warning = validateFieldValue(focused.field, focused.value);
  if (warning) estimate = Math.max(estimate, 1);
  return estimate;
}

// src/pi-base/settings/body.ts
var PREFERRED_INNER_ROWS = 45;
function createSettingsModalBody(options, args) {
  const tabs = options.tabs ?? [];
  const fields = options.fields;
  const mode = options.mode ?? "immediate";
  const isBuffered = mode === "buffered";
  const readOnly = options.readOnly ?? false;
  let activeTabId = options.initialTab ?? tabs[0]?.id;
  const rows = fields.map((field) => ({
    field,
    value: extractInitialValue(field),
    isEditing: false,
    searchIndex: `${field.label}
${field.description ?? ""}
${field.key}`.toLowerCase()
  }));
  const editStates = /* @__PURE__ */ new Map();
  const initialValues = /* @__PURE__ */ new Map();
  const dirtyKeys = /* @__PURE__ */ new Set();
  if (isBuffered) {
    for (const row of rows) {
      const val = row.value;
      initialValues.set(
        row.field.key,
        typeof val === "object" && val !== null ? structuredClone(val) : val
      );
    }
  }
  let overlay;
  let confirm;
  const fieldRenderContext = {
    theme: args.theme,
    tui: args.tui,
    ctx: args.ctx,
    requestRender: () => args.tui.requestRender(),
    editStates
  };
  const state = {
    options,
    args,
    tabs,
    fields,
    rows,
    editStates,
    isBuffered,
    initialValues,
    dirtyKeys,
    cachedVisibleIndices: [],
    activeTabId,
    search: "",
    fieldSelected: 0,
    scroll: 0,
    tabActionFocus: readOnly && tabs.length > 0 && (options.actions?.length ?? 0) > 0 ? tabs.length : -1,
    pathNote: options.pathNote ?? "",
    pathNoteRef: { current: options.pathNote ?? "" },
    overlay,
    confirm
  };
  updateVisibleIndices(state, buildVisibilityContext);
  function mountOverlay(c, title) {
    state.overlay = { component: c, title };
    state.args.tui.requestRender();
  }
  function dismissOverlay() {
    state.overlay = void 0;
    state.args.tui.requestRender();
  }
  function getActiveTabId() {
    return state.activeTabId;
  }
  function setValues(values) {
    for (const row of state.rows) {
      if (values[row.field.key] !== void 0) {
        row.value = values[row.field.key];
      }
    }
    state.dirtyKeys.clear();
    state.initialValues.clear();
    for (const row of state.rows) {
      const val = row.value;
      state.initialValues.set(
        row.field.key,
        typeof val === "object" && val !== null ? structuredClone(val) : val
      );
    }
    state.args.tui.requestRender();
  }
  function mountDirtyConfirm() {
    state.confirm = createConfirm(
      {
        message: ["You have unsaved changes."],
        confirmLabel: "Discard",
        cancelLabel: "Cancel",
        danger: true
      },
      (confirmed) => {
        state.confirm = void 0;
        if (confirmed) {
          state.options.onCancel?.();
          state.args.close();
        }
        state.args.tui.requestRender();
      },
      { tui: state.args.tui, theme: state.args.theme }
    );
    state.args.tui.requestRender();
  }
  function setEditing(row, value) {
    row.isEditing = value;
  }
  function rendererFor(field) {
    return RENDERERS[field.type];
  }
  function actionLabel(action) {
    if (typeof action.disabled === "function") {
      return action.disabled() ? `${action.label} (disabled)` : action.label;
    }
    if (action.disabled) return `${action.label} (disabled)`;
    return action.label;
  }
  function dispatchKey(data) {
    if (readOnly) return;
    const row = focusedRow(state);
    if (!row) return;
    const renderer = rendererFor(row.field);
    try {
      if (renderer) {
        const result = renderer.handleKey(
          { field: row.field, value: row.value },
          data,
          {
            isEditing: row.isEditing,
            ctx: fieldRenderContext,
            setEditing: (v) => setEditing(row, v)
          }
        );
        if (result.commit !== void 0) commitValue(state, row, result.commit);
        if (result.submenu) {
          mountOverlay(
            result.submenu((value) => {
              dismissOverlay();
              if (value !== void 0) commitValue(state, row, value);
            }),
            `${row.field.key} \u2192`
          );
        }
      }
    } catch (err) {
      notifyError(state, state.args.ctx, err);
    }
  }
  function handleReorder(direction) {
    if (readOnly) return true;
    const focusedIdx = focusedIndex(state);
    if (focusedIdx === void 0) return false;
    const focusedRowInternal = state.rows[focusedIdx];
    if (!focusedRowInternal?.field.reorderable) return false;
    const indices = visibleRowIndices(state);
    const visiblePos = indices.indexOf(focusedIdx);
    const targetVisiblePos = visiblePos + direction;
    if (targetVisiblePos < 0 || targetVisiblePos >= indices.length) {
      return true;
    }
    const targetIdx = indices[targetVisiblePos];
    const targetRow = state.rows[targetIdx];
    if (!targetRow?.field.reorderable) {
      return true;
    }
    const reorderablePeerIdxs = indices.filter((i) => state.rows[i]?.field.reorderable);
    const fromPeerPos = reorderablePeerIdxs.indexOf(focusedIdx);
    const toPeerPos = reorderablePeerIdxs.indexOf(targetIdx);
    state.rows[focusedIdx] = targetRow;
    state.rows[targetIdx] = focusedRowInternal;
    state.fieldSelected = targetVisiblePos;
    updateVisibleIndices(state, buildVisibilityContext);
    try {
      state.options.onReorder?.({
        fieldKey: focusedRowInternal.field.key,
        fromIndex: fromPeerPos,
        toIndex: toPeerPos
      });
    } catch (err) {
      notifyError(state, state.args.ctx, err);
    }
    state.args.tui.requestRender();
    return true;
  }
  async function performSave() {
    if (!state.options.onSave) return;
    try {
      const values = allValues(state);
      const result = state.options.onSave(values);
      if (result && typeof result.then === "function") {
        await result;
      }
      if (state.options.closeOnSave !== false) {
        state.args.close();
      }
    } catch (err) {
      notifyError(state, state.args.ctx, err);
    }
  }
  function handleInput(data) {
    if (state.confirm) {
      state.confirm.handleInput?.(data);
      return;
    }
    if (state.overlay) {
      state.overlay.component.handleInput?.(data);
      return;
    }
    const row = focusedRow(state);
    if (matchesKey(data, "ctrl+s")) {
      if (state.isBuffered && state.options.onSave) {
        void performSave();
      }
      return;
    }
    if (matchesKey(data, "ctrl+r") || matchesKey(data, "alt+r")) {
      if (readOnly) return;
      const row2 = focusedRow(state);
      if (row2 && !row2.field.disabled && !row2.isEditing) {
        const def = row2.field.default;
        if (def !== void 0) {
          const clonedDef = typeof def === "object" && def !== null ? structuredClone(def) : def;
          commitValue(state, row2, clonedDef);
          state.args.tui.requestRender();
          return;
        }
      }
      state.args.tui.requestRender();
      return;
    }
    if (matchesKey(data, "alt+up")) {
      if (handleReorder(-1)) return;
    }
    if (matchesKey(data, "alt+down")) {
      if (handleReorder(1)) return;
    }
    if (row?.isEditing && matchesKey(data, "ctrl+c")) {
      if (state.isBuffered && isDirty(state)) {
        mountDirtyConfirm();
      } else {
        state.args.close();
      }
      return;
    }
    if (row?.isEditing) {
      dispatchKey(data);
      state.args.tui.requestRender();
      return;
    }
    if (matchesKey(data, "escape")) {
      if (state.tabActionFocus >= 0) {
        state.tabActionFocus = -1;
        state.args.tui.requestRender();
        return;
      }
      if (state.options.enableSearch && state.search !== "") {
        state.search = "";
        state.fieldSelected = 0;
        updateVisibleIndices(state, buildVisibilityContext);
        state.args.tui.requestRender();
        return;
      }
      if (state.isBuffered && isDirty(state)) {
        if (state.options.onRequestExit) {
          state.options.onRequestExit();
        } else {
          mountDirtyConfirm();
        }
      } else {
        state.args.close();
      }
      return;
    }
    if (matchesKey(data, "ctrl+c")) {
      if (state.isBuffered && isDirty(state)) {
        if (state.options.onRequestExit) {
          state.options.onRequestExit();
        } else {
          mountDirtyConfirm();
        }
      } else {
        state.args.close();
      }
      return;
    }
    const actions = state.options.actions ?? [];
    const stopCount = readOnly ? state.tabs.length : state.tabs.length + actions.length;
    if (matchesKey(data, "tab")) {
      if (stopCount === 0) {
        state.args.tui.requestRender();
        return;
      }
      if (state.tabActionFocus === -1) {
        const currentTabIdx = state.tabs.findIndex((t) => t.id === state.activeTabId);
        if (currentTabIdx >= 0) {
          state.tabActionFocus = (currentTabIdx + 1) % stopCount;
        } else {
          state.tabActionFocus = 0;
        }
      } else if (state.tabActionFocus < state.tabs.length) {
        state.tabActionFocus = (state.tabActionFocus + 1) % stopCount;
      } else if (readOnly) {
        const currentTabIdx = state.tabs.findIndex((t) => t.id === state.activeTabId);
        const nextTabIdx = currentTabIdx >= 0 ? (currentTabIdx + 1) % state.tabs.length : 0;
        const nextTab = state.tabs[nextTabIdx];
        if (nextTab && nextTab.id !== state.activeTabId) {
          state.activeTabId = nextTab.id;
          state.fieldSelected = 0;
          state.scroll = 0;
          updateVisibleIndices(state, buildVisibilityContext);
          state.options.onActiveTabChange?.(nextTab.id);
        }
        state.args.tui.requestRender();
        return;
      } else {
        state.tabActionFocus = (state.tabActionFocus + 1) % stopCount;
      }
      if (state.tabActionFocus < state.tabs.length) {
        const tab = state.tabs[state.tabActionFocus];
        if (tab && tab.id !== state.activeTabId) {
          state.activeTabId = tab.id;
          state.fieldSelected = 0;
          state.scroll = 0;
          updateVisibleIndices(state, buildVisibilityContext);
          state.options.onActiveTabChange?.(tab.id);
        }
      }
      state.args.tui.requestRender();
      return;
    }
    if (matchesKey(data, "shift+tab")) {
      if (stopCount === 0) {
        state.args.tui.requestRender();
        return;
      }
      if (state.tabActionFocus === -1) {
        const currentTabIdx = state.tabs.findIndex((t) => t.id === state.activeTabId);
        if (currentTabIdx >= 0) {
          state.tabActionFocus = (currentTabIdx - 1 + stopCount) % stopCount;
        } else {
          state.tabActionFocus = stopCount - 1;
        }
      } else if (state.tabActionFocus < state.tabs.length) {
        state.tabActionFocus = (state.tabActionFocus - 1 + stopCount) % stopCount;
      } else if (readOnly) {
        const currentTabIdx = state.tabs.findIndex((t) => t.id === state.activeTabId);
        const prevTabIdx = currentTabIdx >= 0 ? (currentTabIdx - 1 + state.tabs.length) % state.tabs.length : state.tabs.length - 1;
        const prevTab = state.tabs[prevTabIdx];
        if (prevTab && prevTab.id !== state.activeTabId) {
          state.activeTabId = prevTab.id;
          state.fieldSelected = 0;
          state.scroll = 0;
          updateVisibleIndices(state, buildVisibilityContext);
          state.options.onActiveTabChange?.(prevTab.id);
        }
        state.args.tui.requestRender();
        return;
      } else {
        state.tabActionFocus = (state.tabActionFocus - 1 + stopCount) % stopCount;
      }
      if (state.tabActionFocus < state.tabs.length) {
        const tab = state.tabs[state.tabActionFocus];
        if (tab && tab.id !== state.activeTabId) {
          state.activeTabId = tab.id;
          state.fieldSelected = 0;
          state.scroll = 0;
          updateVisibleIndices(state, buildVisibilityContext);
          state.options.onActiveTabChange?.(tab.id);
        }
      }
      state.args.tui.requestRender();
      return;
    }
    const ringActions = state.options.actions ?? [];
    const ringStopCount = state.tabs.length + ringActions.length;
    if ((matchesKey(data, "left") || matchesKey(data, "right")) && ringStopCount > 0) {
      if (state.tabActionFocus >= 0) {
        const forward = matchesKey(data, "right");
        if (readOnly && state.tabs.length > 0 && ringActions.length > 0) {
          if (state.tabActionFocus < state.tabs.length) {
            if (forward) {
              state.tabActionFocus = state.tabs.length;
            } else {
              state.tabActionFocus = state.tabs.length + ringActions.length - 1;
            }
          } else {
            const actionCount = ringActions.length;
            const currentActionIdx = state.tabActionFocus - state.tabs.length;
            state.tabActionFocus = state.tabs.length + (forward ? (currentActionIdx + 1) % actionCount : (currentActionIdx - 1 + actionCount) % actionCount);
          }
        } else {
          state.tabActionFocus = forward ? (state.tabActionFocus + 1) % ringStopCount : (state.tabActionFocus - 1 + ringStopCount) % ringStopCount;
          if (state.tabActionFocus < state.tabs.length) {
            const tab = state.tabs[state.tabActionFocus];
            if (tab && tab.id !== state.activeTabId) {
              state.activeTabId = tab.id;
              state.fieldSelected = 0;
              state.scroll = 0;
              updateVisibleIndices(state, buildVisibilityContext);
              state.options.onActiveTabChange?.(tab.id);
            }
          }
        }
        state.args.tui.requestRender();
        return;
      }
      if (state.tabActionFocus === -1 && readOnly && ringActions.length > 0) {
        if (matchesKey(data, "right")) {
          state.tabActionFocus = state.tabs.length;
        } else {
          state.tabActionFocus = state.tabs.length + ringActions.length - 1;
        }
        state.args.tui.requestRender();
        return;
      }
    }
    const totalCount = totalVisibleItems(state);
    const lastIndex = Math.max(0, totalCount - 1);
    if (matchesKey(data, "up") || matchesKey(data, "down") || matchesKey(data, "pageUp") || matchesKey(data, "pageDown")) {
      state.tabActionFocus = -1;
    }
    if (matchesKey(data, "up")) {
      state.fieldSelected = Math.max(0, state.fieldSelected - 1);
      state.args.tui.requestRender();
      return;
    }
    if (matchesKey(data, "down")) {
      state.fieldSelected = Math.min(lastIndex, state.fieldSelected + 1);
      state.args.tui.requestRender();
      return;
    }
    if (matchesKey(data, "pageUp")) {
      state.fieldSelected = Math.max(0, state.fieldSelected - 5);
      state.args.tui.requestRender();
      return;
    }
    if (matchesKey(data, "pageDown")) {
      state.fieldSelected = Math.min(lastIndex, state.fieldSelected + 5);
      state.args.tui.requestRender();
      return;
    }
    if ((matchesKey(data, "enter") || matchesKey(data, "return")) && state.tabActionFocus >= 0) {
      if (state.tabActionFocus < state.tabs.length) {
        state.tabActionFocus = -1;
      } else if (actions.length > 0) {
        const actionIdx = state.tabActionFocus - state.tabs.length;
        const action = actions[actionIdx];
        if (action) {
          const disabled = typeof action.disabled === "function" ? action.disabled() : action.disabled;
          if (!disabled) {
            state.options.onAction?.(action.id);
          }
        }
        state.args.tui.requestRender();
        return;
      }
    }
    if (state.options.enableSearch) {
      if (matchesKey(data, "backspace") || matchesKey(data, "ctrl+h")) {
        state.search = state.search.slice(0, -1);
        state.fieldSelected = 0;
        updateVisibleIndices(state, buildVisibilityContext);
        state.args.tui.requestRender();
        return;
      }
      if (matchesKey(data, "ctrl+u")) {
        state.search = "";
        state.fieldSelected = 0;
        updateVisibleIndices(state, buildVisibilityContext);
        state.args.tui.requestRender();
        return;
      }
      if (matchesKey(data, "ctrl+w")) {
        state.search = deleteWordBackward(state.search);
        state.fieldSelected = 0;
        updateVisibleIndices(state, buildVisibilityContext);
        state.args.tui.requestRender();
        return;
      }
    }
    dispatchKey(data);
    if (state.options.enableSearch && data.length === 1 && data >= " " && data !== "\x7F" && !row?.isEditing) {
      if (!row || !row.isEditing) {
        state.search += data;
        state.fieldSelected = 0;
        updateVisibleIndices(state, buildVisibilityContext);
      }
    }
    state.args.tui.requestRender();
  }
  return {
    render(width) {
      const inner = responsiveInnerRows(
        state.args.tui.terminal.rows ?? 24,
        PREFERRED_INNER_ROWS,
        14
      );
      if (state.confirm) {
        const lines = state.confirm.render(frameContentWidth(width));
        const title2 = state.options.title ? `${state.options.title} \u2014 Discard changes?` : "Discard changes?";
        const opts = {
          title: title2,
          fixedInnerRows: inner
        };
        return frame(lines, width, state.args.theme, opts);
      }
      if (state.overlay) {
        const lines = state.overlay.component.render(frameContentWidth(width));
        const title2 = state.overlay.title ?? state.options.title;
        const opts = {
          title: title2,
          fixedInnerRows: inner
        };
        return frame(lines, width, state.args.theme, opts);
      }
      const contentWidth = frameContentWidth(width);
      const footerRows = renderFooter(state, rendererFor);
      const footerSectionHeight = 1 + footerRows.length;
      const actions = state.options.actions ?? [];
      const actionSectionHeight = actions.length > 0 ? 2 : 0;
      const bottomSectionHeight = footerSectionHeight + actionSectionHeight;
      const bodyInnerRows = inner - bottomSectionHeight;
      const bodyLines = renderBody(
        state,
        rendererFor,
        fieldRenderContext,
        contentWidth,
        bodyInnerRows
      );
      const dirtyDot = state.isBuffered && isDirty(state) ? ` ${state.args.theme.fg("accent", "\u25CF Unsaved")}` : "";
      const title = state.options.title ? `${state.options.title}${dirtyDot}` : state.options.title;
      const frameLines = frame(bodyLines, width, state.args.theme, {
        title,
        fixedInnerRows: bodyInnerRows
      });
      const bottomBorder = frameLines.pop();
      const bottomPadding = frameLines.pop();
      const borderAccent = (s) => state.args.theme.fg("borderAccent", s);
      const paddingX = DEFAULT_PADDING_X;
      const footDiv = `${borderAccent("\u2502")}${" ".repeat(paddingX)}${state.args.theme.fg("dim", "\u2500".repeat(Math.max(1, contentWidth)))}${" ".repeat(paddingX)}${borderAccent("\u2502")}`;
      frameLines.push(footDiv);
      for (const line of footerRows) {
        const paddedLine = `  ${line}`;
        frameLines.push(
          `${borderAccent("\u2502")}${" ".repeat(paddingX)}${pad(paddedLine, contentWidth)}${" ".repeat(paddingX)}${borderAccent("\u2502")}`
        );
      }
      if (actions.length > 0) {
        const actDiv = `${borderAccent("\u2502")}${" ".repeat(paddingX)}${state.args.theme.fg("dim", "\u2500".repeat(Math.max(1, contentWidth)))}${" ".repeat(paddingX)}${borderAccent("\u2502")}`;
        frameLines.push(actDiv);
        const cells = [];
        for (let ai = 0; ai < actions.length; ai++) {
          const action = actions[ai];
          const isFocused = state.tabActionFocus >= state.tabs.length && state.tabActionFocus - state.tabs.length === ai;
          const rawLabel = actionLabel(action);
          const padded = ` ${rawLabel} `;
          if (isFocused) {
            cells.push(
              state.args.theme.fg(
                "accent",
                state.args.theme.inverse(state.args.theme.bold(padded))
              )
            );
          } else if (action.danger) {
            cells.push(state.args.theme.bg("selectedBg", state.args.theme.fg("warning", padded)));
          } else {
            cells.push(state.args.theme.bg("selectedBg", state.args.theme.fg("accent", padded)));
          }
        }
        const line = pad(cells.join(" "), contentWidth);
        frameLines.push(
          `${borderAccent("\u2502")}${" ".repeat(paddingX)}${line}${" ".repeat(paddingX)}${borderAccent("\u2502")}`
        );
      }
      frameLines.push(bottomPadding);
      frameLines.push(bottomBorder);
      return frameLines;
    },
    invalidate() {
      state.overlay?.component.invalidate?.();
      state.confirm?.invalidate?.();
    },
    handleInput,
    mountOverlay,
    dismissOverlay,
    getActiveTabId,
    setValues
  };
}

// src/pi-base/settings/config-flow.ts
var SCOPE_IDS = ["global", "project", "session"];
var SCOPE_LABELS = {
  global: "Global",
  project: "Project Local",
  env: "env",
  session: "Session",
  defaults: "default"
};
var EDIT_MODE_TITLES = {
  global: "Global",
  project: "Project Local",
  session: "Session"
};
var SELECTOR_ENTRY_LABELS = {
  global: "Configure Global settings",
  project: "Configure Project local settings",
  session: "Configure Session settings"
};
function buildSelectorEntries(params, includeDisplayAll = true, extraEntries = []) {
  const available = {
    global: params.scopes.global,
    project: params.scopes.project,
    session: params.scopes.session && params.sessionInitialized
  };
  const entries = [];
  if (includeDisplayAll) {
    entries.push({ id: "display-all", label: "Display all settings", available: true });
  }
  for (const id of SCOPE_IDS) {
    const ok = available[id];
    const entry = {
      id,
      label: SELECTOR_ENTRY_LABELS[id],
      available: ok,
      note: !ok ? id === "session" ? params.scopes.session ? "(session not initialized)" : "(disabled by extension)" : "(disabled by extension)" : void 0
    };
    entries.push(entry);
  }
  if (extraEntries.length > 0) {
    entries.push(...extraEntries);
  }
  return entries;
}
function winnerLabel(winner) {
  return SCOPE_LABELS[winner] ?? winner;
}
async function openConfigFlow(params, extraEntries = [], onExtraSelect) {
  const result = await openSelector(params, true, extraEntries);
  if (result.kind === "cancel") return;
  if (result.id === "display-all") {
    await openDisplayAll(params);
  } else if (extraEntries.some((e) => e.id === result.id)) {
    if (onExtraSelect) await onExtraSelect(result.id);
  } else {
    await openEditMode(params, result.id);
  }
}
function openSelector(params, includeDisplayAll = true, extraEntries = []) {
  const entries = buildSelectorEntries(params, includeDisplayAll, extraEntries);
  const { ctx } = params;
  return new Promise((resolve3) => {
    const factory = (tui, theme, _keybindings, done) => {
      const component = createScopeSelector({
        title: params.label,
        subtitle: `Configure settings for ${params.label}`,
        entries,
        tui,
        theme,
        done(result) {
          done(void 0);
          resolve3(result);
        }
      });
      return component;
    };
    void ctx.ui.custom(factory, {
      overlay: true,
      overlayOptions: modalOverlay()
    });
  });
}
async function openEditMode(params, scope) {
  const values = params.layerValues(scope);
  let inspection = params.inspect();
  const fields = params.buildFields(values);
  const currentValues = { ...values };
  const dirtyKeys = /* @__PURE__ */ new Set();
  function valueNote(field) {
    const key = String(field.key);
    const winner = inspection.winners[key];
    if (!winner || winner === scope) return void 0;
    if (!dirtyKeys.has(key)) return `(from ${winnerLabel(winner)})`;
    return void 0;
  }
  const scopeLabel = EDIT_MODE_TITLES[scope] ?? scope;
  const sources = params.scopeSources();
  const sourceEntry = sources.find((s) => s.scope === scope);
  scope === "session" ? params.sessionNote : sourceEntry?.note ?? "";
  const editPathNote = scope === "env" ? "environment variables (read-only)" : scope === "defaults" ? "built-in defaults" : scope === "session" ? sourceEntry?.path ?? sourceEntry?.note ?? "" : sourceEntry?.exists && sourceEntry.path ? sourceEntry.path : sourceEntry?.note ?? "";
  const wrappedFields = fields.map((f) => ({
    ...f,
    valueNote: () => valueNote(f)
  }));
  let activeEditBody;
  async function saveEdit(tui, theme, done) {
    const confirmed = await new Promise((resolve3) => {
      const c = createConfirm(
        {
          message: [`Really save to ${scopeLabel}?`],
          confirmLabel: "Save",
          danger: false
        },
        resolve3,
        { tui, theme }
      );
      (activeEditBody ?? {}).mountOverlay(
        c,
        `Save to ${scopeLabel}`
      );
    });
    if (!confirmed) {
      activeEditBody?.dismissOverlay();
      return;
    }
    try {
      const res = await params.save(
        { ...currentValues },
        scope
      );
      if (res.created && scope === "project") {
        params.ctx.ui.notify(`Project config written to ${res.path}`, "info");
      }
      params.onSaved(currentValues);
      dirtyKeys.clear();
      done(void 0);
    } catch (err) {
      params.ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
    }
  }
  async function discardEdit(tui, theme, done) {
    const confirmed = await new Promise((resolve3) => {
      const c = createConfirm(
        {
          message: ["Discard changes?"],
          confirmLabel: "Discard",
          danger: true
        },
        resolve3,
        { tui, theme }
      );
      (activeEditBody ?? {}).mountOverlay(c);
    });
    if (confirmed) {
      done(void 0);
    } else {
      activeEditBody?.dismissOverlay();
    }
  }
  async function resetEdit(tui, theme) {
    const scopeLabel2 = EDIT_MODE_TITLES[scope] ?? scope;
    const confirmed = await new Promise((resolve3) => {
      const c = createConfirm(
        {
          message: [`Really reset ${scopeLabel2} to defaults?`],
          confirmLabel: "Reset",
          danger: true
        },
        resolve3,
        { tui, theme }
      );
      (activeEditBody ?? {}).mountOverlay(c);
    });
    if (!confirmed) {
      activeEditBody?.dismissOverlay();
      return;
    }
    try {
      await params.resetScope(scope);
      const fresh = params.layerValues(scope);
      activeEditBody?.setValues(fresh);
      dirtyKeys.clear();
      inspection = params.inspect();
      activeEditBody?.dismissOverlay();
    } catch (err) {
      params.ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
    }
  }
  async function deleteEdit(tui, theme) {
    const scopeLabel2 = EDIT_MODE_TITLES[scope] ?? scope;
    const confirmed = await new Promise((resolve3) => {
      const c = createConfirm(
        {
          message: [`Really delete the ${scopeLabel2} config file?`],
          confirmLabel: "Delete",
          danger: true
        },
        resolve3,
        { tui, theme }
      );
      (activeEditBody ?? {}).mountOverlay(c);
    });
    if (!confirmed) {
      activeEditBody?.dismissOverlay();
      return;
    }
    try {
      await params.deleteScope(scope);
      const fresh = params.layerValues(scope);
      activeEditBody?.setValues(fresh);
      dirtyKeys.clear();
      inspection = params.inspect();
      activeEditBody?.dismissOverlay();
    } catch (err) {
      params.ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
    }
  }
  const handlers = {
    onChange(key, value) {
      currentValues[key] = value;
      dirtyKeys.add(key);
      params.onChange?.(key, value);
    },
    onSave(tui, theme, done) {
      return saveEdit(tui, theme, done);
    },
    onRequestExit(tui, theme, done) {
      return discardEdit(tui, theme, done);
    },
    onAction(id, tui, theme, done) {
      switch (id) {
        case "save":
          void saveEdit(tui, theme, done).catch(
            (err) => params.ctx.ui.notify(err instanceof Error ? err.message : String(err), "error")
          );
          break;
        case "discard":
          void discardEdit(tui, theme, done).catch(
            (err) => params.ctx.ui.notify(err instanceof Error ? err.message : String(err), "error")
          );
          break;
        case "reset":
          void resetEdit(tui, theme).catch(
            (err) => params.ctx.ui.notify(err instanceof Error ? err.message : String(err), "error")
          );
          break;
        case "delete":
          void deleteEdit(tui, theme).catch(
            (err) => params.ctx.ui.notify(err instanceof Error ? err.message : String(err), "error")
          );
          break;
      }
    }
  };
  await params.ctx.ui.custom(
    (tui, theme, _keybindings, done) => {
      const body = createSettingsModalBody(
        {
          title: `${params.label} \u2014 ${scopeLabel}`,
          fields: wrappedFields,
          mode: "buffered",
          closeOnSave: false,
          enableSearch: true,
          pathNote: editPathNote,
          actions: scope === "session" ? [
            { id: "save", label: "Save" },
            { id: "discard", label: "Discard" },
            { id: "reset", label: "Reset", danger: true }
          ] : [
            { id: "save", label: "Save" },
            { id: "discard", label: "Discard" },
            { id: "reset", label: "Reset", danger: true },
            { id: "delete", label: "Delete", danger: true }
          ],
          onSave: () => handlers.onSave(tui, theme, done),
          onChange: handlers.onChange,
          onRequestExit: () => handlers.onRequestExit(tui, theme, done),
          onAction: (id) => handlers.onAction(id, tui, theme, done)
        },
        {
          tui,
          theme,
          ctx: params.ctx,
          close: () => done(void 0)
        }
      );
      activeEditBody = body;
      return body;
    },
    { overlay: true, overlayOptions: modalOverlay() }
  );
}
async function openDisplayAll(params) {
  const inspection = params.inspect();
  const sources = params.scopeSources();
  const tabDefs = [];
  if (params.scopes.global !== false) {
    tabDefs.push({ id: "global", scope: "global", label: "Global" });
  }
  if (params.scopes.project !== false) {
    tabDefs.push({ id: "project", scope: "project", label: "Project Local" });
  }
  if (params.env && Object.keys(params.env).length > 0) {
    tabDefs.push({ id: "env", scope: "env", label: "Env" });
  }
  if (params.scopes.session && params.sessionInitialized) {
    tabDefs.push({ id: "session", scope: "session", label: "Session" });
  }
  tabDefs.push({ id: "defaults", scope: "defaults", label: "Defaults" });
  sources.map((s) => `${s.label}: ${s.note}`).join("\n");
  const tabPathNotes = {};
  for (const source of sources) {
    if (source.scope === "session") {
      tabPathNotes["session"] = source.path ?? source.note;
    } else {
      tabPathNotes[source.scope] = source.exists && source.path ? source.path : source.note;
    }
  }
  tabPathNotes["env"] = "environment variables (read-only)";
  tabPathNotes["defaults"] = "built-in defaults";
  const tabFields = {};
  for (const tab of tabDefs) {
    let layerVals;
    if (tab.scope === "defaults") {
      layerVals = { ...params.defaults };
    } else {
      layerVals = params.layerValues(tab.scope);
    }
    const raw = params.buildFields(layerVals);
    tabFields[tab.id] = raw.map((f) => ({
      ...f,
      tab: tab.id,
      valueNote: displayValueNote(f, tab.id, inspection, params.env)
    }));
  }
  let currentTabId = tabDefs[0].id;
  const allFields = tabDefs.flatMap((tab) => tabFields[tab.id] ?? []);
  await params.ctx.ui.custom(
    (tui, theme, _keybindings, done) => {
      const pathNoteRef = { current: tabPathNotes[currentTabId] };
      const body = createSettingsModalBody(
        {
          title: params.label,
          tabs: tabDefs.map((t) => ({ id: t.id, label: t.label })),
          initialTab: currentTabId,
          fields: allFields,
          readOnly: true,
          pathNote: pathNoteRef.current,
          actions: [
            { id: "edit", label: "Edit" },
            { id: "cancel", label: "Cancel" }
          ],
          onAction(id) {
            switch (id) {
              case "cancel":
                queueMicrotask(() => done(void 0));
                break;
              case "edit":
                queueMicrotask(() => done(void 0));
                const isEditableScope = currentTabId === "global" && params.scopes.global || currentTabId === "project" && params.scopes.project || currentTabId === "session" && params.scopes.session;
                if (isEditableScope) {
                  void openEditMode(params, currentTabId).catch(
                    (err) => params.ctx.ui.notify(err instanceof Error ? err.message : String(err), "error")
                  );
                } else {
                  void openSelector(params, false).then((result) => {
                    if (result.kind === "cancel") {
                      return openDisplayAll(params);
                    }
                    if (result.id !== "display-all") {
                      return openEditMode(params, result.id);
                    }
                    return void 0;
                  }).catch(
                    (err) => params.ctx.ui.notify(
                      err instanceof Error ? err.message : String(err),
                      "error"
                    )
                  );
                }
                break;
            }
          },
          onActiveTabChange(tabId) {
            currentTabId = tabId;
            pathNoteRef.current = tabPathNotes[tabId] ?? "";
          }
        },
        {
          tui,
          theme,
          ctx: params.ctx,
          close: () => done(void 0)
        }
      );
      return body;
    },
    {
      overlay: true,
      overlayOptions: modalOverlay()
    }
  );
}
function displayValueNote(field, tabId, inspection, env) {
  const key = String(field.key);
  const winner = inspection.winners[key];
  if (tabId === "env" && env?.[key]) {
    const def = env[key];
    const envWins = winner === "env";
    if (typeof def === "string") {
      const isSet2 = !!process.env[def]?.trim();
      if (!isSet2) return `(${def}: unset)`;
      return envWins ? `(${def}) \u25B8 effective` : `(${def})`;
    }
    const isSet = !!process.env[def.var]?.trim();
    if (!isSet) return `(${def.var}: unset)`;
    return envWins ? `(${def.var}) \u25B8 effective` : `(${def.var})`;
  }
  if (winner === tabId) return "\u25B8 effective";
  if (winner) return `(from ${winnerLabel(winner)})`;
  return void 0;
}
function modalOverlay() {
  return { anchor: "center", width: "92%", maxHeight: "95%" };
}

// src/pi-base/config-manager.ts
var ConfigManager = class {
  opts;
  _sessionId;
  _leafId;
  _entries;
  _appendEntry;
  _getEntries;
  _filename;
  // Pending-mode session persistence state
  _sessionPersist = "unavailable";
  _sessionManager;
  _pendingCwd;
  _defaultConfigDir;
  constructor(opts) {
    this.opts = opts;
    this._defaultConfigDir = opts.configDir;
    if (!opts.filename && !opts.id) {
      throw new Error(
        "ConfigManager requires either `id` or `filename` in options. Provide one so the config file can be resolved."
      );
    }
    this._filename = opts.filename ?? `${opts.id}-config.json`;
  }
  /** Resolved scope availability (opts.scopes with defaults applied). */
  getScopes() {
    const s = this.opts.scopes ?? { global: true, project: true, session: true };
    return {
      global: s.global !== false,
      project: s.project !== false,
      session: s.session !== false && this.opts.sessionConfig !== false
    };
  }
  /** True when session config scope is available (persisted or pending). */
  hasSession() {
    return this._sessionPersist === "persisted" || this._sessionPersist === "pending";
  }
  /**
   * Lazily detect and initialize session state from the live context.
   *
   * Persistence states:
   * - "persisted": JSONL exists, leafId known, appendEntry available.
   *   Session config is keyed to the real leafId and appended to JSONL on save.
   * - "pending": session file path is known but not yet persistable
   *   (file missing, leafId null, or appendEntry absent). Session scope is
   *   available; saves go to the in-memory store under PENDING_SENTINEL.
   *   _tryFlushSession() migrates the pending config to the real leafId
   *   exactly once once the session file materializes.
   * - "unavailable": inMemory session or session opt-out. Session scope
   *   is hidden from the selector.
   *
   * Identity change guard: if we already hold session state for a DIFFERENT
   * sessionId (user switched sessions in-process), reset persistence state
   * and re-detect for the new session.
   */
  _ensureSession(ctx, cwd) {
    if (this._sessionManager && this._sessionId) {
      const currentSessionId = ctx.sessionManager?.getSessionId?.();
      if (currentSessionId && this._sessionId !== currentSessionId) {
        const oldSessionId = this._sessionId;
        const oldPendingCwd = this._pendingCwd ?? process.cwd();
        clearSessionConfig(this._getEntryType(), oldPendingCwd, oldSessionId, PENDING_SENTINEL);
        this._sessionId = void 0;
        this._leafId = void 0;
        this._entries = void 0;
        this._appendEntry = void 0;
        this._getEntries = void 0;
        this._sessionPersist = "unavailable";
        this._sessionManager = void 0;
        this._pendingCwd = void 0;
      }
    }
    if (this._sessionPersist === "persisted" && !this._sessionManager) {
      this._tryFlushSession(cwd);
      return true;
    }
    if (this._sessionPersist !== "unavailable" && this._sessionManager) {
      const sm2 = ctx.sessionManager;
      if (!sm2) {
        return true;
      }
      this._tryFlushSession(cwd);
      return true;
    }
    const sm = ctx.sessionManager;
    if (!sm) {
      this._sessionPersist = "unavailable";
      return false;
    }
    if (this.opts.scopes?.session === false || this.opts.sessionConfig === false) {
      this._sessionPersist = "unavailable";
      return false;
    }
    const file = sm.getSessionFile?.();
    if (typeof file !== "string") {
      this._sessionPersist = "unavailable";
      return false;
    }
    const leafId = sm.getLeafId?.() ?? null;
    const mutable = sm;
    const hasAppend = typeof mutable.appendCustomEntry === "function";
    const persistable = existsSync(file) && leafId != null && hasAppend;
    if (persistable) {
      const appendEntryFn2 = (type, data) => {
        mutable.appendCustomEntry(type, data);
      };
      this.initSession(
        sm.getSessionId(),
        leafId,
        sm.getEntries?.() ?? [],
        appendEntryFn2,
        () => sm.getEntries?.()
      );
      this._sessionPersist = "persisted";
      this._sessionManager = mutable;
      this._pendingCwd = cwd;
      return true;
    }
    const appendEntryFn = hasAppend ? (type, data) => {
      mutable.appendCustomEntry(type, data);
    } : void 0;
    this._sessionId = sm.getSessionId() ?? void 0;
    this._leafId = PENDING_SENTINEL;
    this._entries = sm.getEntries?.();
    this._appendEntry = appendEntryFn;
    this._getEntries = () => sm.getEntries?.() ?? [];
    this._sessionPersist = "pending";
    this._sessionManager = mutable;
    this._pendingCwd = cwd;
    this._tryFlushSession(cwd);
    return true;
  }
  /**
   * Attempt to flush pending session config to the session JSONL.
   *
   * Only acts when _sessionPersist === "pending". The flush reads the
   * pending config from the in-memory store (keyed under PENDING_SENTINEL),
   * writes it to the real leafId via setSessionConfig, APPENDS a single
   * custom entry to the JSONL via appendCustomEntry, clears the sentinel
   * key, and transitions to persisted. Returns true only when an append
   * actually occurred (so callers can fall back to their own append when
   * flush transitioned without content).
   *
   * NEVER reads/scans the JSONL (existsSync only). The appended entry
   * uses appendCustomEntry which creates "custom" entries excluded from
   * LLM context. appendCustomMessageEntry is never used.
   *
   * Side-effect-on-read: called from _ensureSession (via load/openSettings)
   * so that config is appended to JSONL as soon as the session file
   * materializes — even without an explicit user save.
   *
   * The exactly-once guard is the _sessionPersist transition: once
   * "persisted", subsequent calls return immediately.
   *
   * @param cwd Working directory for the pending store key. Callers pass
   *   their resolved cwd (save passes its explicit targetCwd;
   *   loadWithWarnings/layerValues pass their cwd; _ensureSession passes
   *   its detection cwd).
   */
  _tryFlushSession(cwd) {
    if (this._sessionPersist !== "pending") return false;
    if (!this._sessionManager) return false;
    const sm = this._sessionManager;
    const hasAppend = typeof sm.appendCustomEntry === "function";
    const appendEntryFn = hasAppend ? (type, data) => {
      sm.appendCustomEntry(type, data);
    } : void 0;
    this._appendEntry = appendEntryFn;
    const file = sm.getSessionFile();
    if (typeof file !== "string" || !existsSync(file)) return false;
    const leaf = sm.getLeafId();
    if (leaf == null) return false;
    if (!appendEntryFn) return false;
    const targetCwd = cwd ?? this._pendingCwd ?? process.cwd();
    const pendingConfig = getRawSessionConfig(this._getEntryType(), targetCwd, this._sessionId, PENDING_SENTINEL) ?? {};
    if (Object.keys(pendingConfig).length > 0) {
      setSessionConfig(this._getEntryType(), targetCwd, this._sessionId, leaf, pendingConfig);
      clearSessionConfig(this._getEntryType(), targetCwd, this._sessionId, PENDING_SENTINEL);
      appendEntryFn(this._getEntryType(), {
        leafId: leaf,
        config: pendingConfig
      });
    }
    this._leafId = leaf;
    this._sessionPersist = "persisted";
    return Object.keys(pendingConfig).length > 0;
  }
  initSession(sessionId, leafId, entries, appendEntry2, getEntries) {
    if (this.opts.scopes?.session === false || this.opts.sessionConfig === false) return;
    this._sessionId = sessionId;
    this._leafId = leafId;
    this._entries = entries;
    this._appendEntry = appendEntry2;
    this._getEntries = getEntries;
    this._sessionPersist = "persisted";
    this._sessionManager = void 0;
    this._pendingCwd = void 0;
    const entryType = this._getEntryType();
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry.type === "custom" && entry.customType === entryType) {
        const data = entry.data;
        if (data && data.leafId === leafId) {
          setSessionConfig(entryType, process.cwd(), sessionId, leafId, data.config);
          break;
        }
      }
    }
  }
  /**
   * Load config with layered resolution:
   *   defaults ← global file ← project file ← env overrides
   *
   * @param cwd Working directory for project-local override
   * @param configDir Global config directory (defaults to getExtensionsDir())
   */
  load(cwd, configDir) {
    return this.loadWithWarnings(cwd, configDir).config;
  }
  /**
   * Load config with warnings. Same as `load()` but also returns per-field
   * validation warnings and unknown-key warnings discovered during loading.
   *
   * Extensions that open a modal can surface these warnings in the UI;
   * extensions that load config programmatically can log or inspect them.
   */
  loadWithWarnings(cwd, configDir) {
    const warnings = [];
    const loaded = loadConfig(this._filename, this.opts.defaults, {
      cwd,
      configDir: configDir ?? this._defaultConfigDir,
      merge: "deep"
    });
    const config2 = this.opts.validate ? this.opts.validate(loaded) : loaded;
    try {
      const fields = this.opts.fields(config2);
      const scope = "global";
      for (const field of fields) {
        if (field.type === "action" || field.type === "custom") continue;
        const warning = validateFieldValue(field, field.value);
        if (warning) {
          warnings.push({
            scope,
            key: String(field.key),
            message: `"${field.label}": ${warning}`
          });
        }
      }
    } catch {
    }
    const withEnv = this.applyEnvOverrides(config2);
    const scopes = this.opts.scopes ?? { session: true };
    const sessionEnabled = this.opts.sessionConfig !== false && scopes.session !== false;
    const namespace = this._getEntryType();
    const final = sessionEnabled ? this.applySessionOverrides(withEnv, cwd, namespace) : withEnv;
    this._tryFlushSession(cwd);
    return { config: final, warnings };
  }
  applyEnvOverrides(config2) {
    const env = this.opts.env;
    if (!env) return config2;
    return applyEnvOverrides2(
      config2,
      env,
      this.opts.defaults
    );
  }
  applySessionOverrides(config2, cwd, namespace) {
    const sessionId = this._sessionId;
    const leafId = this._leafId;
    const entries = this._getEntries?.() ?? this._entries;
    if (!sessionId || !leafId || !entries) return config2;
    let session;
    if (leafId === PENDING_SENTINEL) {
      session = getRawSessionConfig(namespace, cwd ?? process.cwd(), sessionId, PENDING_SENTINEL) ?? {};
    } else {
      session = getSessionConfig(namespace, cwd ?? process.cwd(), sessionId, leafId, entries);
    }
    const merged = deepMerge(
      config2,
      session
    );
    return this.opts.validate ? this.opts.validate(merged) : merged;
  }
  _applyValidation(config2) {
    return this.opts.validate ? this.opts.validate(config2) : config2;
  }
  /**
   * Return merged config values up to and including the given scope.
   *
   * Composition:
   *   "global"  = defaults ← global file
   *   "project" = layerValues("global") ← project file
   *   "env"     = layerValues("project") ← env overrides
   *   "session" = layerValues("env") ← session store
   */
  layerValues(scope, cwd, configDir) {
    const dir = configDir ?? this._defaultConfigDir ?? getExtensionsDir();
    const defaults = this.opts.defaults;
    let result = { ...defaults };
    const globalData = readConfig(this._filename, dir) ?? {};
    result = deepMerge(result, globalData);
    if (scope === "global") {
      return this._applyValidation(result);
    }
    if (cwd) {
      const projectDir = join(cwd, ".pi");
      const projectData = readConfig(this._filename, projectDir) ?? {};
      result = deepMerge(result, projectData);
    }
    if (scope === "project" && !cwd) {
      throw new Error("cwd is required for project-scoped layerValues");
    }
    if (scope === "project") {
      return this._applyValidation(result);
    }
    if (this.opts.env) {
      const envResult = applyEnvOverrides2(
        result,
        this.opts.env,
        this.opts.defaults
      );
      result = envResult;
    }
    if (scope === "env") {
      return this._applyValidation(result);
    }
    const scopes = this.opts.scopes ?? { session: true };
    const sessionEnabled = this.opts.sessionConfig !== false && scopes.session !== false;
    const namespace = this._getEntryType();
    if (sessionEnabled) {
      const sessionResult = this.applySessionOverrides(result, cwd, namespace);
      result = sessionResult;
    }
    this._tryFlushSession(cwd);
    return this._applyValidation(result);
  }
  /**
   * Inspect per-layer contributions and per-key winners.
   */
  inspect(cwd, configDir) {
    const dir = configDir ?? this._defaultConfigDir ?? getExtensionsDir();
    const defaultsLayer = { ...this.opts.defaults };
    const globalLayer = readConfig(this._filename, dir) ?? {};
    const projectLayer = cwd ? readConfig(this._filename, join(cwd, ".pi")) ?? {} : {};
    const envLayer = {};
    if (this.opts.env) {
      const envApplied = applyEnvOverrides2(
        projectLayer,
        this.opts.env,
        this.opts.defaults
      );
      const envRecord = envApplied;
      for (const [key, value] of Object.entries(
        this.opts.env
      )) {
        if (this._envKeyIsActive(key, value, this.opts.defaults)) {
          envLayer[key] = envRecord[key];
        }
      }
    }
    const sessionLayer = {};
    const scopes = this.opts.scopes ?? { session: true };
    const sessionEnabled = this.opts.sessionConfig !== false && scopes.session !== false;
    const namespace = this._getEntryType();
    if (sessionEnabled && this._sessionId && this._leafId) {
      let sessionConfig;
      if (this._leafId === PENDING_SENTINEL) {
        sessionConfig = getRawSessionConfig(namespace, cwd ?? process.cwd(), this._sessionId, PENDING_SENTINEL) ?? {};
      } else {
        sessionConfig = getSessionConfig(
          namespace,
          cwd ?? process.cwd(),
          this._sessionId,
          this._leafId,
          this._getEntries?.() ?? this._entries ?? []
        );
      }
      Object.assign(sessionLayer, sessionConfig);
    }
    const layers = {
      defaults: defaultsLayer,
      global: globalLayer,
      project: projectLayer,
      env: envLayer,
      session: sessionLayer
    };
    const allKeys = /* @__PURE__ */ new Set();
    for (const layer of Object.values(layers)) {
      for (const key of Object.keys(layer)) {
        allKeys.add(key);
      }
    }
    const winners = {};
    const precedence = ["session", "env", "project", "global", "defaults"];
    for (const key of allKeys) {
      for (const layer of precedence) {
        if (key in layers[layer]) {
          winners[key] = layer;
          break;
        }
      }
    }
    return { layers, winners };
  }
  /**
   * Return provenance sources for enabled scopes.
   */
  scopeSources(cwd, configDir) {
    const sources = [];
    const scopes = this.opts.scopes ?? { global: true, project: true, session: true };
    if (scopes.global !== false) {
      const globalDir = configDir ?? this._defaultConfigDir ?? getExtensionsDir();
      const globalPath = join(globalDir, this._filename);
      const globalExists = existsSync(globalPath);
      sources.push({
        scope: "global",
        label: "Global",
        path: globalPath,
        exists: globalExists,
        note: globalExists ? globalPath : "(nonexistent \u2014 will be created on save)"
      });
    }
    if (scopes.project !== false && cwd) {
      const projectPath = join(cwd, ".pi", this._filename);
      const projectExists = existsSync(projectPath);
      sources.push({
        scope: "project",
        label: "Project Local",
        path: projectPath,
        exists: projectExists,
        note: projectExists ? projectPath : "(nonexistent \u2014 will be created on save)"
      });
    }
    if (scopes.session !== false && this.opts.sessionConfig !== false) {
      const entryType = this._getEntryType();
      const sessionFile = this._sessionManager?.getSessionFile?.();
      const pending = this._sessionPersist === "pending";
      sources.push({
        scope: "session",
        label: "Session",
        exists: false,
        path: sessionFile,
        note: pending ? sessionFile ? `in-memory until session file exists \u2014 will persist automatically` : "in-memory until session file exists \u2014 will persist automatically" : `in-memory per-leaf overrides (persisted to session JSONL as ${entryType})`
      });
    }
    return sources;
  }
  _envKeyIsActive(key, envValue, defaults) {
    if (typeof envValue === "string") {
      const raw = process.env[envValue]?.trim();
      if (!raw) return false;
      const defaultValue = defaults[key];
      if (typeof defaultValue === "boolean") {
        return ["1", "true", "yes", "on", "0", "false", "no", "off"].includes(raw.toLowerCase());
      }
      if (typeof defaultValue === "number") {
        if (Number.isInteger(defaultValue) && defaultValue > 0) {
          const parsed2 = Number.parseInt(raw, 10);
          return Number.isFinite(parsed2) && parsed2 > 0;
        }
        const parsed = Number.parseFloat(raw);
        return Number.isFinite(parsed);
      }
      return false;
    } else {
      const raw = process.env[envValue.var]?.trim();
      if (!raw) return false;
      try {
        return envValue.parse(raw, void 0) !== void 0;
      } catch {
        return false;
      }
    }
  }
  /**
   * Save config scoped to global or project directory.
   *
   * Writes only the fields that differ from the existing file content
   * (diff-based save against the file). This means:
   *
   * - **First save** (no file exists): writes ALL fields — the file is
   *   fully populated with every value the user confirmed.
   * - **Subsequent saves**: only the fields that actually changed in the
   *   current session are written. Everything else stays untouched.
   * - **Unknown keys** (hand-edited extras outside the schema) are
   *   automatically preserved by the read-patch-write cycle.
   * - **No automatic removal**: only explicit reset/delete removes keys
   *   from the file.
   *
   * Reads the existing file, patches it with the deltas, and writes the
   * merged result. This prevents accidental overwrites of fields the user
   * never touched while keeping the file consistent with the UI.
   *
   * @param config Config to persist
   * @param scope Target scope
   * @param cwd Working directory (required for "project" scope)
   * @param configDir Override the global config dir (for tests)
   */
  save(config2, scope, cwd, configDir) {
    if (scope === "session") {
      if (!this._sessionId) {
        throw new Error(
          "Cannot save session config: session not initialized. Call initSession() first."
        );
      }
      const targetCwd = cwd ?? process.cwd();
      setSessionConfig(
        this._getEntryType(),
        targetCwd,
        this._sessionId,
        this._leafId,
        config2
      );
      this._pendingCwd = targetCwd;
      const flushed = this._tryFlushSession(targetCwd);
      if (!flushed && this._sessionPersist === "persisted" && this._appendEntry) {
        this._appendEntry(this._getEntryType(), {
          leafId: this._leafId,
          config: config2
        });
      }
      return { path: "", created: false, changed: true };
    }
    if (scope === "project" && !cwd) {
      throw new Error("cwd is required for project-scoped config save");
    }
    const dir = scope === "project" && cwd ? join(cwd, ".pi") : configDir ?? this._defaultConfigDir ?? getExtensionsDir();
    const targetPath = join(dir, this._filename);
    const created = !existsSync(targetPath);
    const knownKeys = new Set(Object.keys(this.opts.defaults));
    const existing = readConfig(this._filename, dir) ?? {};
    const fieldMap = /* @__PURE__ */ new Map();
    try {
      const fields = this.opts.fields(config2);
      for (const f of fields) fieldMap.set(String(f.key), f);
    } catch {
    }
    const diff = {};
    let hasDiff = false;
    for (const key of Object.keys(this.opts.defaults)) {
      const modalVal = config2[key];
      const fileVal = existing[String(key)];
      if (deepEqual(modalVal, fileVal)) continue;
      const field = fieldMap.get(String(key));
      if (field && !(field.type === "action" || field.type === "custom")) {
        const warning = validateFieldValue(field, modalVal);
        if (warning) continue;
      }
      diff[String(key)] = modalVal;
      hasDiff = true;
    }
    for (const [key, val] of Object.entries(existing)) {
      if (!knownKeys.has(key)) {
        diff[key] = val;
        hasDiff = true;
      }
    }
    if (!hasDiff) {
      return { path: targetPath, created, changed: false };
    }
    const merged = { ...existing, ...diff };
    const wrote = writeConfig(this._filename, merged, dir);
    if (!wrote) {
      throw new Error(
        `Failed to save ${this._filename} \u2014 the config file may be read-only (e.g., managed by Nix). Runtime state was updated for this session only.`
      );
    }
    return { path: targetPath, created, changed: true };
  }
  /**
   * Open the settings modal with scope tabs, auto-generated onSave, etc.
   *
   * Before opening the modal, checks global and project-local config files
   * for malformed JSON. If either is invalid, a warning notification is
   * shown so the user knows their config couldn't be fully loaded.
   *
   * @param ctx Extension context
   * @param cwd Working directory for project-local override
   * @param onSave Called with the validated config after the user saves
   * @param configDir Override the global config dir (for tests)
   */
  _getEntryType() {
    if (typeof this.opts.sessionConfig === "object" && this.opts.sessionConfig.entryType) {
      return this.opts.sessionConfig.entryType;
    }
    return `session-config-${this.opts.id}`;
  }
  /**
   * Open the settings with the config flow (pre-selector →
   * edit mode / display-all).
   *
   * Signature is stable. Before opening, checks global and
   * project-local config files for malformed JSON and warns.
   *
   * The consumer's `onSave` is called with the validated config
   * after persist. Validation runs inside the save wrapper.
   *
   * @param ctx Extension context
   * @param cwd Working directory for project-local override
   * @param onSave Called with the validated config after the user saves
   * @param configDir Override the global config dir (for tests)
   * @param onChange Optional per-field change handler passed through
   */
  async openSettings(ctx, cwd, onSave, configDir, onChange, extraEntries, onExtraSelect) {
    configDir = configDir ?? this._defaultConfigDir;
    this.warnOnMalformedConfig(ctx, cwd, configDir);
    const scopes = this.getScopes();
    const sessionInitialized = this._ensureSession(ctx, cwd);
    const sources = this.scopeSources(cwd, configDir);
    await openConfigFlow(
      {
        label: this.opts.label,
        ctx,
        cwd,
        scopes,
        sessionInitialized,
        sessionNote: sources.find((s) => s.scope === "session")?.note ?? "",
        defaults: this.opts.defaults,
        env: this.opts.env,
        buildFields: (values) => {
          const fields = this.opts.fields(values);
          const configDefaults = this.opts.defaults;
          for (const field of fields) {
            if (field.type === "action" || field.type === "custom") continue;
            if (field.default === void 0) {
              const key = String(field.key);
              if (key in configDefaults) {
                field.default = configDefaults[key];
              }
            }
          }
          return fields;
        },
        layerValues: (s) => this.layerValues(s, cwd, configDir),
        inspect: () => this.inspect(cwd, configDir),
        scopeSources: () => this.scopeSources(cwd, configDir),
        save: async (values, scope) => {
          const updated = this.opts.validate ? this.opts.validate(values) : values;
          const res = this.save(updated, scope, cwd, configDir);
          onSave(updated);
          return res;
        },
        resetScope: (scope) => this.resetScope(scope, cwd, configDir),
        deleteScope: (scope) => this.deleteScope(scope, cwd, configDir),
        onSaved: () => {
        },
        onChange
      },
      extraEntries,
      onExtraSelect
    );
  }
  /**
   * Reset a scope's configuration to defaults. Known config keys
   * (those defined in the schema) are removed from the file; unknown
   * keys (from future versions or user additions) are preserved so
   * forward-compatibility is maintained. Next load will use defaults
   * for all known fields.
   *
   * After this call, the file contains only unknown keys. If no
   * unknown keys exist, the file is deleted entirely.
   */
  resetScope(scope, cwd, configDir) {
    if (scope === "session") {
      if (!this._sessionId) {
        throw new Error("Cannot reset session config: session not initialized.");
      }
      const targetCwd = cwd ?? process.cwd();
      if (this._sessionPersist === "pending") {
        clearSessionConfig(this._getEntryType(), targetCwd, this._sessionId, PENDING_SENTINEL);
      } else {
        clearSessionConfig(this._getEntryType(), targetCwd, this._sessionId, this._leafId);
      }
      return;
    }
    if (scope === "project" && !cwd) {
      throw new Error("cwd is required for project-scoped config reset");
    }
    const dir = scope === "project" && cwd ? join(cwd, ".pi") : configDir ?? this._defaultConfigDir ?? getExtensionsDir();
    const knownKeys = new Set(Object.keys(this.opts.defaults));
    const existing = readConfig(this._filename, dir);
    const unknownKeys = {};
    if (existing && typeof existing === "object") {
      for (const [key, val] of Object.entries(existing)) {
        if (!knownKeys.has(key)) unknownKeys[key] = val;
      }
    }
    if (Object.keys(unknownKeys).length > 0) {
      writeConfig(this._filename, unknownKeys, dir);
    } else {
      deleteConfig(this._filename, dir);
    }
  }
  /**
   * Delete the entire config file for a scope. Unlike `resetScope`,
   * this removes unknown keys as well — the file is completely gone.
   * Next load will use nothing but defaults.
   */
  deleteScope(scope, cwd, configDir) {
    if (scope === "session") {
      if (!this._sessionId) {
        throw new Error("Cannot delete session config: session not initialized.");
      }
      const targetCwd = cwd ?? process.cwd();
      if (this._sessionPersist === "pending") {
        clearSessionConfig(this._getEntryType(), targetCwd, this._sessionId, PENDING_SENTINEL);
      } else {
        clearSessionConfig(this._getEntryType(), targetCwd, this._sessionId, this._leafId);
      }
      return;
    }
    if (scope === "project" && !cwd) {
      throw new Error("cwd is required for project-scoped config delete");
    }
    const dir = scope === "project" && cwd ? join(cwd, ".pi") : configDir ?? this._defaultConfigDir ?? getExtensionsDir();
    deleteConfig(this._filename, dir);
  }
  /**
   * Check global and project-local config files for malformed JSON.
   * Warns via ctx.ui.notify if any are found.
   */
  warnOnMalformedConfig(ctx, cwd, configDir) {
    const filename = this._filename;
    const globalStatus = checkConfigFile(filename, configDir);
    if (globalStatus.exists && !globalStatus.valid) {
      ctx.ui.notify(
        `Config file "${filename}" is ${globalStatus.error}. Using defaults.`,
        "warning"
      );
    }
    const projectDir = join(cwd, ".pi");
    const projectStatus = checkConfigFile(filename, projectDir);
    if (projectStatus.exists && !projectStatus.valid) {
      ctx.ui.notify(
        `Project config file ".pi/${filename}" is ${projectStatus.error}. Using defaults.`,
        "warning"
      );
    }
  }
};
var BUNDLED_CHANGELOG_TEXT = '## [Unreleased]\n\n---\n\n## [0.4.10] - 2026-08-29\n\n### Changed\n\n- **Upgraded recall & export algorithms (BM25+, SimHash64, c-TF-IDF, and technical density scoring).**\n  - Upgraded session history search to **BM25+** with lower-bound delta term ($\\delta = 0.5$) preventing length bias against concise observations.\n  - Added lightweight morphological stemming (`stemToken`) to `dedup.ts` for higher token-set overlap across grammatical variants.\n  - Added 64-bit SimHash locality-sensitive fingerprinting (`computeSimHash64`, `simHashHammingDistance`) and cluster drift guards to speed up pairwise candidate filtering and prevent transitive clustering drift.\n  - Added technical entity density scoring (`technicalDensityFactor`) in `format-export.ts` to reward concrete code artifacts (paths, symbols, flags, hashes) over conversational transcripts.\n  - Expanded stemming and technical-artifact detection for common software terminology, major language file types, framework constructs, API routes, DevOps/configuration signals, errors, and semantic versions.\n  - Topic labels now preserve readable surface words while using stems only for internal matching and scoring.\n  - Upgraded topic labeling from standard TF-IDF to **c-TF-IDF** (Class-based TF-IDF with sublinear saturation).\n  - Export preamble now shows a best-effort heuristic warning instead of a Key Topics index.\n\n### Fixed\n\n- **Git-based installs no longer require interactive `pnpm approve-builds`.** `simple-git-hooks` is explicitly trusted through pnpm 11\'s workspace `allowBuilds` configuration, and the prepare lifecycle now initializes hooks and builds the bundle exactly once.\n- **Export pipeline hardening for large corpora.** Fixed `token.charCodeAt is not a function` crash caused by `TECHNICAL_ROOTS` prototype pollution on tokens like `constructor`/`toString` (now guarded with `hasOwnProperty`) and added a malformed-token guard in `computeSimHash64`; topic labels now preserve surface forms and the export warning clarifies heuristic ranking.\n\n---\n\n## [0.4.9] - 2026-08-28\n\n### Added\n\n- **Distilled project-memory export (`/blackhole-export`).** ([#65](https://github.com/k0valik/pi-blackhole/pull/65)) New command that scans project-scoped session JSONL files plus global OM pending buffers, deduplicates/clusters observations, and writes a single import-ready Markdown file (tiered as `Reflections \u2192 Critical \u2192 High \u2192 Medium \u2192 Low` plus an `Unattributed pending memory` section for orphaned buffers). Scoring is tier-weighted with recency decay, log-scaled recurrence and evidence-mass boosts, consensus rerank, burst penalty and length factor; viability gating keeps low/medium only with multi-session support or length/quality, high/critical always. Hierarchical topic assignment via S\xF8rensen-Dice graph + TF-IDF labeling; three-pass dedup (exact normalized, Levenshtein@0.88 after bigram-Jaccard prefilter, S\xF8rensen-Dice@0.70 with Levenshtein floor). Output parsing via `out:<path>.md` or a timestamped default; deterministic and stateless. New modules `src/project-recall/corpus.ts`, `dedup.ts`, `format-export.ts`, `session-dir.ts` and handler `src/commands/blackhole-export.ts` (wired in `index.ts`). Appendix A slice of the project-recall plan \u2014 future project-aware recall search remains out of scope for this release.\n\n### Fixed\n\n- **Capture `AgentSession` from bundled Pi CLI entrypoint.** ([#62](https://github.com/k0valik/pi-blackhole/pull/62), thanks @daoguademeng) `installHostInlineCompactionAdapter` now resolves the host `AgentSession` from the bundled CLI\'s runtime chunk (when the entrypoint is `dist/bundle/cli.js`) in addition to `dist/index.js`, so inline (mid-run) compaction works when Pi is launched via its bundled CLI instead of silently falling back to settled compaction.\n- **Unified `session_compact_failed` handling (pi >=0.84.3).** Ported from [ceblan/pi-blackhole#ceb-dev](https://github.com/ceblan/pi-blackhole/compare/main...ceblan:pi-blackhole:ceb-dev) (thanks @ceblan / Carlos Estrada): new `src/hooks/compact-failed.ts` closes gaps in failure coverage \u2014 structured `compact_failed.received` trace with corrected `attributedFromExtension` (`fromExtension || compactWasPiVcc || lastCompactCancelled`), defensive `compactInFlight` + `autoCompactionController` reset (aborts orphaned idle-wait so it cannot launch a second compaction after a later turn), overflow-retry `willRetry` visibility (`"overflow compaction aborted, retrying turn"`), and `compactionEngine: pi-default` noise filtering. `Runtime.lastCompactCancelled` is set on every `{ cancel: true }` from `before-compact` and consumed attempt-scoped with `compactWasPiVcc` (leak-free lifecycle: set at `session_before_compact` start, consumed on `session_compact` success or `session_compact_failed`). Covers pi #8328 overflow path.\n\n---\n\n## [0.4.8] - 2026-08-23\n\n### Added\n\n- **Opt-in append compaction (`compactionSummaryMode`).** New config key (`default` | `append`; `default` is the default) plus `PI_BLACKHOLE_COMPACTION_SUMMARY_MODE` override. In append mode each automatic Blackhole compaction appends one immutable provider-visible segment (`S1 | S2 | \u2026`) while every stored summary stays a complete fallback; `/blackhole` rebases the active chain into one clean segment; a legacy v1 summary enters through one marked rebase. A new `context` hook projects segments before each model call and fails closed to the fallback on any malformed state. When the projected chain passes half of the model\'s context window, the next automatic compaction folds it back into one segment. Falls back to rewrite surgery once per session when append mode encounters unsupported state. See `docs/APPEND_COMPACTION.md`. ([#58](https://github.com/k0valik/pi-blackhole/pull/58), thanks @sonSunnoi)\n\n### Changed\n\n- **Mid-run compaction failures now use exponential backoff** (1s doubling to a 30s cap) instead of suspending retries until context pressure drops. A single transient failure no longer wedges auto-compaction for the rest of the pressure episode; failure notices now include "retrying in Xs".\n- **Permanent inline-compaction unavailability (pi version lacks the adapter API) is now classified once** and reported as a single warning ("using settled compaction fallback") instead of surfacing as a retryable failure every episode. With `midRunCompaction: resume`, later turn-end attempts skip the adapter immediately, and agent start warns once if resume mode is configured against a known-unsupported adapter.\n- **Compaction token counting now uses real provider usage when available.** `rawTokensSinceLastCompaction` reads the last valid assistant message\'s usage (`calculateContextTokens`: `totalTokens` or the input/output/cache component sum) after the latest compaction entry, plus a chars/4 estimate for trailing entries, instead of estimating the whole window from characters. Chars/4 remains the fallback for sessions without usage data. Error/aborted assistant turns are never used as baselines; usage from before the latest compaction is ignored (it reflects the pre-compaction context). Approach from tavasti@360f24a (pi-vcc upstream PR #40); hardened implementation ported from plan-01 of the token-rework work.\n- **Minimal tails honor later Pi split-turn boundaries.** An oversized current turn can now be cut at Pi\'s safe assistant/user boundary instead of being retained whole after compaction.\n\n### Fixed\n\n- **Inline compaction ignores aborted/errored assistant turns.** Assistant messages with `stopReason: "error"` or `"aborted"` are now skipped when checking for trailing in-flight tool calls, matching Pi\'s own transform-messages behavior.\n- **Inline compaction ignores stale tool calls** that reference cleared state from a prior turn ([#57](https://github.com/k0valik/pi-blackhole/pull/57), thanks @daoguademeng)\n- **Settings modal footer and key dispatch guard against section rows.** Prevents a crash when the focused row in `/blackhole configure` is a section header instead of an editable field.\n\n---\n\n## [0.4.7] - 2026-08-15\n\n### Fixed\n\n- **Installation from git now works without a prebuilt `dist/`.** The package manifest entrypoint now points at `./index.ts` instead of `./dist/index.js`. Because `dist/` is gitignored, direct Git installs were missing the extension entrypoint and failing to load. Pi can load the TypeScript entrypoint directly, so this restores functionality for `npm install github:k0valik/pi-blackhole` and similar Git-based installs. Registry installs are unaffected (npm/pnpm/bun ship the prebuilt `dist/` bundle).\n\n---\n\n## [0.4.6] - 2026-08-14\n\n### Added\n\n- **Session-local config.** Config values can now be set at session scope via `/blackhole configure` or the config modal\'s scope selector. Session config is ephemeral \u2014 it lives only for the current session and overrides project-local and env values, so you can experiment with settings like `midRunCompaction` or `compactionEngine` without touching files or environment variables.\n\n- **All env overrides are visible in the config modal.** `PI_BLACKHOLE_MID_RUN_COMPACTION`, `PI_BLACKHOLE_COMPACTION`, and `PI_BLACKHOLE_COMPACTION_ENGINE` (alongside existing overrides like `PI_BLACKHOLE_SKIP_PROVIDERS` and `PI_BLACKHOLE_PROVIDER_IDLE_TIMEOUT_MS`) now appear in the env tab of the config modal with their current effective values, so you can see at a glance what the environment is contributing.\n\n### Changed\n\n- **Config modal migrated to the canonical `pi-base` config-rework surface.** The modal now uses the upstream scope-selector and config-flow, replacing the legacy `openSettingsModal` path. The layer precedence is: global \u2192 project \u2192 env \u2192 session, matching pi-utils behavior.\n\n### Removed\n\n- **Dead monolith-era config code.** Removed `src/pi-base/config-settings.ts`, `settings-registry.ts`, `settings-ui.ts`, `registry.ts`, `report.ts`, `llm.ts`, `hash.ts`, `context-provider.ts`, `once.ts`, `debug.ts`, `config-manager-howto.md`, `settings/README.md`, and the obsolete `scope-action.test.ts`. Blackhole-specific wiring (kitty decode, NixOS read-only warnings, key migration, clamping) remains in `blackhole-settings.ts`.\n\n### Fixed\n\n- **Recall drill-down honors lineage scope.** ([#54](https://github.com/k0valik/pi-blackhole/issues/54)) `#N:path` drill-down now checks the active lineage before expanding off-lineage entries, matching every other recall path. Off-lineage indices are blocked under the default `scope:"lineage"` and require `scope:"all"` to access.\n- **Inline compaction restores the Working indicator.** ([#52](https://github.com/k0valik/pi-blackhole/pull/52), thanks @daoguademeng) After inline compaction completes, the UI "Working" indicator is restored so the user sees activity resumed.\n\n### Dependencies\n\n- Bumped dev-dependency group across 2 PRs (#45, #53): `@typescript-eslint/eslint-plugin` to `8.66.0`, `eslint` to `10.8.0`, `lint-staged` to `17.3.0`, `typebox` to `1.3.10`, `typescript` to `6.0.3` (pinned for `@typescript-eslint` v8 compatibility), and `vitest` to `4.1.10`.\n\n## [0.4.4] - 2026-08-06\n\n### Added\n\n- **Experimental compatibility shim for pi-codex-compaction coexistence.** ([#47](https://github.com/k0valik/pi-blackhole/pull/47), thanks @danielmrdev) Optional `skipForProviders` (config key or `PI_BLACKHOLE_SKIP_PROVIDERS` env override) makes blackhole step aside entirely \u2014 no compaction, no observational-memory consolidation \u2014 for listed providers, giving exactly-one-engine semantics when pi-codex-compaction also registers a `session_before_compact` handler. **Niche surface by design**: unsurfaced in README/CONFIG.md until a second consumer exists (see shim notes in `src/core/provider-skip.ts`); surfaced only in example-config.json.\n\n- **Isolated provider idle timeout for background memory jobs.** ([#48](https://github.com/k0valik/pi-blackhole/pull/48), thanks @FelikZ) Optional `providerIdleTimeoutMs` lets observer/reflector/dropper worker HTTP requests tolerate longer silent provider intervals without forcing interactive Pi requests to wait equally long, by wrapping the provider `fetch` with an undici dispatcher that injects `bodyTimeout`. Unset inherits pi\'s global default; `0` disables; `> 0` sets a millisecond cap. Configurable via config file, `/blackhole configure`, or `PI_BLACKHOLE_PROVIDER_IDLE_TIMEOUT_MS`.\n\n### Fixed\n\n- **Credential-resolved provider endpoints are preserved for observational-memory workers on Pi versions whose registry exposes `getProviderAuth()`.** Observer, reflector, and dropper now use the endpoint selected by Pi\'s auth resolver, preventing GitHub Copilot Business/Enterprise requests from falling back to the Individual endpoint and returning HTTP 421. On older registries without `getProviderAuth()`, the fix degrades silently to the previous behavior.\n- **`midRunCompaction: "resume"` no longer aborts or replaces the active run.** ([#50](https://github.com/k0valik/pi-blackhole/pull/50), thanks @daoguademeng) The old `ctx.compact()` + `blackhole-resume` path propagated a false interrupt to background/subagent extensions and let nested child runners resolve before Blackhole\'s detached resume run finished. Resume mode now performs Pi\'s native compaction pipeline inline from the awaited `turn_end` handler, refreshes the next low-level turn from the compacted messages, and continues inside the original `session.prompt()` promise. Completed tool calls remain paired; no synthetic user/custom message is injected. `"resume"` is an **experimental opt-in** \u2014 it monkey-patches Pi host internals and can silently deactivate on host drift.\n- **Mid-run compaction compatibility fails closed.** A reload-idempotent, weakly referenced runtime adapter recognizes the known Pi 0.81 and 0.84 `AgentSession.compact()` shapes. Unknown internal drift refuses transparent compaction and leaves the active run alive instead of falling back to the unsafe aborting path. External abort/cancellation still passes through normally.\n\n### Testing\n\n- Added adapter contract coverage for Pi 0.81/0.84 compact shapes, no-abort behavior, compacted next-turn context refresh, external cancellation, unpaired-tool rejection, fail-closed drift handling, and reload idempotency. A real `AgentSession` + faux-provider integration test runs on both the 0.81.1 compatibility baseline and 0.84.0 dev baseline, proving the active run signal stays live, the next provider request receives the compacted context, and the original `session.prompt()` remains pending through compaction. Trigger tests prove no `ctx.compact()` or `blackhole-resume` dispatch.\n\n### Dependencies\n\n- Bumped `@oh-my-pi/pi-*` devDependencies from `0.83.0` to `0.84.0`; the peer range remains `>=0.81.1 <1.0.0`, and the adapter retains a tested legacy-shape path for the minimum supported host.\n\n## [0.4.3] - 2026-08-01\n\n### Added\n\n- **pi-base config modal for `/blackhole configure`.** ([#41](https://github.com/k0valik/pi-blackhole/pull/41)) The hand-rolled configure overlay is replaced with pi-base\'s ConfigManager + settings modal (vendored into `src/pi-base/`), with scope-aware editing: global config lives at `<agentDir>/pi-blackhole/` (respecting `PI_CODING_AGENT_DIR`), project config overlays `<cwd>/.pi/pi-blackhole-config.json`.\n\n### Changed\n\n- **Number fields edit inline in `/blackhole configure`.** Number fields (e.g. `compactAfterTokens`, `observeAfterTokens`) no longer cycle in fixed steps on every Enter \u2014 pressing Enter drops into inline editing where you type the value directly; `\u2190`/`\u2192` still fine-tune by step when not editing.\n- **Destructive-action confirmations are safer.** The delete/reset scope confirm now lists **Cancel first (pre-selected)** and shows a warning-color line stating what the action will do \u2014 tabbing into the confirm can never land on a destructive action by accident.\n- **Custom provider streams discovered through pi\'s model registry.** ([#42](https://github.com/k0valik/pi-blackhole/pull/42), thanks @FelikZ) The bridge that lets OM agents (observer/reflector/dropper) use custom providers (e.g. claude-bridge) now captures `streamSimple` functions from pi\'s public registry API (`getRegisteredProviderIds`/`getRegisteredProviderConfig`) on every `agent_start`, instead of wrapping `pi.registerProvider` and reading the private `registeredProviders` field. Works regardless of extension load order and includes providers added after startup; the legacy discovery path remains available for older pi releases.\n- **Precompiled extension bundle for faster startup.** The extension now ships a prebuilt `dist/index.js` bundle (tsup/esbuild) instead of being transpiled file-by-file by jiti at startup \u2014 module loading drops from ~85 source files to a single ESM file, measured ~1.6\u20132\xD7 faster extension load. The `@oh-my-pi/pi-*` packages and `typebox` stay external and resolve to the host pi\'s copies at runtime via its loader aliases. `pnpm build` produces the bundle; `prepare` builds automatically on install. The package manifest points at `./dist/index.js` and falls back to `index.ts` (slow path) when `dist/` is absent, so a fresh checkout still works pre-build.\n\n### Fixed\n\n- **Manual-mode pending files now contain full observation payloads.** ([#41](https://github.com/k0valik/pi-blackhole/pull/41)) The `noAutoCompact` \u2192 `compaction:\'manual\'` migration is completed: `isManualMode()` now checks both keys across all save/load gates, so manual-mode observations are written to the pending file (`savePendingObservation`) instead of falling through to `appendEntry()` (JSONL) \u2014 restoring crash-safe mid-run interruption recovery and `/blackhole flush` parity.\n- **Config modal could overwrite the user\'s config with defaults.** `openSettings` did not pass `globalConfigDir` to the settings modal, so the modal initialized every field from the schema default (it read a nonexistent config in the extensions dir) instead of the actual config file. Saving then wrote those defaults over the real values (e.g. `compactAfterTokens` 185000 \u2192 81000) while the runtime kept the correct values in memory \u2014 a confusing half-applied state. The modal now initializes from the real config file.\n- **Number-field editing could get stuck.** While inline-editing a number field, typing/backspace/escape were swallowed by the step-cycling branch, leaving the modal in an editing state with no way out (Enter showed a cursor but nothing worked, and `ctrl+c` couldn\'t close it). All editing keys now flow through the inline editor, and `ctrl+c` closes the modal even mid-edit.\n- **Typed input failed in Kitty terminals.** Kitty reports printable characters as CSI-u sequences (e.g. `5` arrives as `\\x1b[53u`); they were rejected by the input filter \u2014 and after the first fix, inserted as raw escape bytes. The input filter and the insert path now decode them, so typing works in Kitty terminals.\n- **Config save failures on read-only filesystems are now visible.** `ConfigManager.save()` throws when the write fails (e.g. config managed by Nix), and `/blackhole om-off`/`om-on` surface a warning \u2014 previously the failure was silently swallowed while the in-memory runtime state changed, diverging from disk without explanation.\n- **`PI_BLACKHOLE_*` env overrides now apply at runtime.** The declarative env map (`memory`, `debug`, `compactAfterTokens`, \u2026) was only honored by the modal path; the runtime config loader ignored it. The env map + application logic moved to a shared module used by both paths, so e.g. `PI_BLACKHOLE_COMPACT_AFTER_TOKENS=200000` now affects the actual compaction threshold, not just the modal display.\n\n### Testing\n\n- **Ported the upstream pi-base test suite (246 tests)** from `pi-utils/packages/pi-base` \u2014 config manager, settings modal (buffered mode, smoke, inline-edit, field validation) plus the 4 small modules (env, shell, types, ui) they cover. Only import-path adaptation was needed; zero semantic drift, which also confirms the vendored modal is behaviorally aligned with upstream.\n- **New regression tests pin this release\'s fixes:** config-manager `globalConfigDir` forwarding, number-field inline editing (including a Kitty CSI-u integration case driving the full renderer path), Kitty decode, and runtime env overrides.\n- **Tests no longer touch the system clipboard.** The memory-command tests ran the real `copyTextToClipboard` (spawning `wl-copy`/`xclip`/`xsel`) and overwrote the user\'s clipboard with fixture data; the module is now mocked and the mock\'s use is asserted so a regression fails the suite instead of mutating the clipboard.\n\n### Dependencies\n\n- **Bumped `@oh-my-pi/pi-*` devDependencies to `0.83.0`** (agent-core, ai, coding-agent, tui); the peer range stays `>=0.81.1 <1.0.0`. CI re-verifies typecheck + tests against the minimum supported `0.81.1` on every push/PR, so both the oldest and newest supported pi versions stay green.\n\n### Packaging\n\n- **Tolerant `prepare` build hook.** The `prepare` script is now a dependency-free `node scripts/prepare.mjs` that builds `dist/` only when the toolchain is present, and otherwise skips silently \u2014 it can never abort an install for git/checkout consumers running npm, pnpm, or bun in any devDependency configuration. Husky hooks install best-effort (dev checkouts only). Registry installs are unaffected (npm/pnpm/bun never run `prepare` on registry packages).\n- **npm publishing now uses provenance.** The publish workflow runs `npm publish --provenance` (GitHub OIDC attestation), so every tarball carries a signed signature linking it to this repo + workflow \u2014 verifiable with `npm audit signatures` / `gh attestation verify`. The release gate now matches CI (build, typecheck, lint, test, format check).\n- **Dev tooling.** Prettier (repo normalized once, enforced via lint-staged), husky pre-commit (lint+format staged files, then typecheck) and pre-push (typecheck + full test suite), ESLint extended to `tests/` and root configs, and CI now runs tests + format check alongside the build.\n\n---\n\n## [0.4.2] - 2026-07-27\n\n### Changed\n\n- **`midRunCompaction` default changed from `"resume"` to `"off"`.** ([#40](https://github.com/k0valik/pi-blackhole/issues/40), thanks @daoguademeng) `ctx.compact()` aborts the active agent operation before compacting, which is not lifecycle-safe at `turn_end` for subagent/background-work extensions: it propagates through the shared `AbortSignal` and cannot be distinguished from user cancellation. This affects both parent-side subagent workflows (active/queued children aborted, parent stalled) and child-side nested sessions (runner terminated, orphan transcript continues, `blackhole-resume` resumes a session the parent already sees as completed). `off` defers compaction to `agent_end`, which is the only currently safe boundary for extension-owned work. `resume` and `pause` are preserved as explicit opt-in for users without subagent workflows.\n\n---\n\n## [0.4.1] - 2026-07-24\n\n### Added\n\n- **Mid-run auto-compaction (`midRunCompaction`).** ([#38](https://github.com/k0valik/pi-blackhole/pull/38), thanks @daoguademeng) The threshold trigger previously only ran on `agent_end`, which never fires while the agent is looping through tool calls \u2014 during long runs `compactAfterTokens` could be exceeded many times over without a single evaluation, and the post-run wait was aborted by any new `agent_start`, deferring compaction indefinitely under continuous use. The threshold is now also evaluated at every `turn_end` (after each assistant message + tool executions). New config enum `midRunCompaction: "resume" | "pause" | "off"` (default `"resume"`): `resume` compacts at the threshold and injects a `blackhole-resume` message (`triggerTurn`) so the agent continues the task with the compacted context; `pause` compacts and hands control back; `off` restores the old end-of-run-only behavior. Available in `/blackhole configure`.\n- **`/blackhole <text>` follow-up prompt.** After compaction, `/blackhole` optionally sends `<text>` as a follow-up message so the model continues the task without re-typing. Wrapped in `void Promise.resolve(...).catch(() => {})` for robust error handling.\n- **Subcommand near-miss detection.** `/blackhole configure foo` now shows a warning instead of silently becoming a follow-up prompt.\n\n- **`/blackhole cleanup` command for orphaned pending files.** Per-session pending files (`*-pending.json`, `*-pending.stale.json`) accumulate when compaction is manual and sessions are abandoned or deleted. The command scans the `pi-blackhole/` directory, cross-references session IDs against all session JSONL files, and provides an interactive TUI picker to safely remove orphaned files. Non-TUI modes (RPC/JSON/print) list orphaned files as a notification without deleting.\n\n### Command formatting cleanup\n\n- `/blackhole` and `/blackhole-memory` subcommands and modes now use `[bracketed]` syntax (e.g. `[om-on]`, `[hybrid]`) with shortened descriptions, making the command palette visually consistent and easier to scan.\n\n### Notification & session goal reorg\n\n- Session goal now derives from the first user message and is persisted at the top across compactions, with `(#N)` entry indexing for traceability.\n- OM info notifications are gated to one per phase/turn \u2014 warnings and errors still fire immediately.\n- Git commit extraction now handles tool_call, bash, and post-convert user-text formats.\n- Cooldown skip messages now strip raw JSON from the reason for cleaner display, with a log pointer for debugging.\n\n### Fixed\n\n- **Mid-run compaction failure resilience.** ([#38](https://github.com/k0valik/pi-blackhole/pull/38), thanks @daoguademeng) If the before-compact hook cancels (or compaction errors) after `ctx.compact()` has already aborted the run, resume mode still re-triggers the agent so the task doesn\'t stall, and further mid-run attempts are suspended until a compaction lowers pressure below the threshold (prevents abort/cancel thrash loops).\n- **Early-session reflection/drop starvation on first compaction.** Added `fullFoldAlways` config flag (default `true`). When no prior full-fold boundary exists, reflections and drops now use the observation boundary instead of being excluded. Previously, fresh sessions silently lost all durable memory on the first compaction because there was no full-fold history to anchor the maintenance boundary.\n- **`capBrief` omission count now computed after `firstHeader` trim.** Previously the "N earlier lines omitted" header was computed before the section-header anchor trim, so the count was understated when headers caused additional trimming. This matched an upstream bug that was already fixed there.\n\n- **Recall-note bloat across multiple compactions.** `compile()` now strips OM content first, then removes all recall-note paragraphs from the previous summary using paragraph-level matching (instead of only stripping a trailing exact match). After 3+ compactions, the summary no longer accumulates 3+ embedded copies of the recall note.\n\n## [0.4.0] - 2026-07-24\n\n### Added\n\n- **`/blackhole cleanup` command for orphaned pending files.** Per-session pending files (`*-pending.json`, `*-pending.stale.json`) accumulate when compaction is manual and sessions are abandoned or deleted. Provides an interactive TUI picker to safely remove orphaned files. Non-TUI modes (RPC/JSON/print) list them without deleting.\n- **`dropperPressureThreshold` in configure overlay.** Already in config schema but missing from `/blackhole configure` TUI. Now editable alongside other OM thresholds.\n- **`fullFoldAlways` in TUI overlay.** Added to the configure overlay under Observational Memory section.\n- **Session goal from first user message.** Persisted at the top across compactions with `(#N)` entry indexing for traceability.\n- **OM info notifications gated to one per phase/turn.** Warnings and errors still fire immediately.\n- **Git commit extraction expanded.** Now handles `tool_call`, `bash`, and post-convert user-text formats.\n- **Cooldown skip messages strip raw JSON** from the reason for cleaner display, with a log pointer for debugging.\n- **`/blackhole` and `/blackhole-memory` subcommands now use `[bracketed]` syntax** (e.g. `[om-on]`, `[hybrid]`) with shortened descriptions for visual consistency.\n\n### Fixed\n\n- **Early-session reflection/drop starvation on first compaction.** Added `fullFoldAlways` config flag (default `true`). When no prior full-fold boundary exists, reflections and drops use the observation boundary instead of being excluded.\n- **Recall-note bloat across multiple compactions.** `compile()` strips OM content first, then removes all recall-note paragraphs using paragraph-level matching (instead of only stripping a trailing exact match).\n- **OAuth/ADC-backed providers (Vertex, custom OAuth) now accepted by OM pipeline.** `resolveModel` uses `modelRegistry.hasConfiguredAuth()` instead of requiring a truthy `auth.apiKey`. Falls back to legacy behavior on older pi versions. ([#38](https://github.com/k0valik/pi-blackhole/issues/38))\n- **`ResolveResult.apiKey` is always a string.** Defaults to `""` instead of casting `undefined`.\n- **jiti provider bridge type-safe for pi 0.81.1+.** `pi.registerProvider` wrapper satisfies the overloaded signature in pi-coding-agent 0.81.1.\n- **Config overlay blocks save on invalid JSON.** Red error banner and Ctrl+S block prevent wiping model configs on corrupt files. ([#35](https://github.com/k0valik/pi-blackhole/issues/35))\n- **Config reloads after overlay save.** `Runtime.reloadConfig()` forces a fresh disk read after `/blackhole configure` saves. ([#36](https://github.com/k0valik/pi-blackhole/issues/36))\n- **Invalid JSON warning surfaced via TUI.** Yellow warning notification shown at every config load point instead of only `console.warn`.\n- **Defensive null guards for `b.args` and `ui.notify`.** Prevents crashes from stale extension context.\n- **`streamSimple` import updated to `pi-ai/compat`.** Removed from main export in pi 0.80.3.\n- **Legacy fallback config errors now passed to `onWarn` callback.** JSON parse errors in legacy fallback files (`pi-vcc-config.json`, `settings.json`, `.pi/settings.json`) are surfaced via the warning callback, not just `console.warn`.\n- **`saveUnifiedConfig` warns before overwriting corrupt config.** If the config file has invalid JSON, a warning is logged before overwriting.\n- **`dropperPressureThreshold` clamped to `[0.01, 1]` in overlay save.** Previously could silently lose value on reload.\n- **`deleteOrphanedBatch` reports partial failures.** "Delete all" now shows `Deleted X/Y (Y-X failed)` when individual unlinks fail.\n- 4 new tests for `fullFoldAlways` behavior in `buildCompactionProjection`: reflections survive first compaction when enabled, excluded when disabled, full-fold boundary still takes precedence, and post-boundary reflections remain excluded.\n- 3 new tests for recall-note deduplication in `compile`: wrapped recall note stripped, OM content stripped before recall note, and three-cycle accumulation produces exactly one recall note.\n- 5 new tests for follow-up prompt: extraction, subcommand exclusion, empty-args suppression, send after completion, compaction-failure suppression.\n- 6 new tests for CompactionStats population: all fields populated, compactAll flag, totalUserTurns count, keptUserTurns count, compactAll zero kept, and format string coverage.\n- 2 new tests for capBrief omission count: header-trimmed count is correct (99 for 200 lines with header at line 100), and no-header fallback still correct.\n\n### Changed\n\n- **New config key:** `fullFoldAlways` (boolean, default `true`). Added to `UnifiedConfig` schema, defaults, and config file parsing.\n- **CompactionStats expanded from 3 to 11 fields.** Added `compactAll`, `totalUserTurns`, `keptUserTurns`, `requestedKeepUserTurns`, `keepUserTurnsExplicit`, `keepFallbackToCompactAll`, `smartKeepAdjusted`, `smartFromKeep`. All populated from `buildOwnCut` return data (Bug A fix).\n- **Shared `formatCompactionStats` exported.** Both the `/blackhole` command handler and hook\'s `session_compact` handler now use a single shared formatter, eliminating the duplicate inline toast strings and the private `formatTokens` helper.\n- **Dead ternary collapsed.** `effectiveTailBehavior` no longer has an `isPiVcc` branch with identical values on both sides (Bug B fix).\n- **Dependencies: bumped `@oh-my-pi/pi-*` packages to `0.81.1`** (agent-core, ai, coding-agent, tui).\n- **Removed 6 unused exports from `om/cleanup.ts`** (`scanPendingFiles`, `findSessionDirs`, `collectAllSessionIds`, `crossReference`, `formatSize`, `formatAge`).\n\n### Tests\n\n- 4 new tests for `fullFoldAlways` behavior in `buildCompactionProjection`.\n- 3 new tests for recall-note deduplication in `compile`.\n- 6 new tests for OAuth/ADC auth paths.\n- Tightened capping assertions in robust tests.\n- Added robust coverage for OM and CCC pipelines.\n\n---\n\n## [0.3.9] - 2026-06-24\n\n### Auto-compaction idle race fix (#31, #33)\n\nThe auto-compaction trigger used to bail permanently when `ctx.isIdle()`\nreturned `false` at the first `setTimeout(0)` check after `agent_end`.\nWhen another extension (e.g. pi-rewind) registered an async `agent_end`\nhandler whose I/O kept the agent state busy past the next macrotask,\nthe trigger logged `"bail: not_idle"` and never retried \u2014 auto-compaction\neffectively never fired in this configuration.\n\n**New behavior:** the trigger keeps `compactInFlight = true` and polls\n`isIdle()` every 200ms (in 50ms slices) until the agent truly settles,\nor one of two cancellation signals:\n\n- `agent_start` fires \u2014 the user (or another extension) started a new\n  turn. `AbortController.abort()` cancels the wait; the new turn\'s own\n  `agent_end` will re-evaluate and start a fresh wait if still needed.\n- Session change (e.g. `/resume`) \u2014 detected inside the wait loop.\n\nOnly the cell `compaction:auto + compactionEngine:blackhole` is affected.\nAll other config combinations (off, manual, pi-default) are unchanged.\n\n### CI: fallow audit job\n\n- Added `fallow-audit` CI job (PR only, changed-code audit with compact\n  format, review comments, no SARIF)\n\n### Test cleanup\n\n- Removed stale `transcript-mode` tests left orphaned when the feature\n  was deliberately dropped in v0.3.7 as redundant with hybrid search.\n\n---\n\n## [0.3.8] - 2026-06-19\n\n### Pipeline progress cursors - fix re-run loop (#28, #29)\n\nThe pipeline previously coupled progress tracking to output markers: if a stage\nproduced empty output or errored, no marker was written, causing the stage to\nre-process the same data on every `agent_start`/`turn_end` trigger. In real-world\nlogs the dropper ran 8,350\xD7 vs observer 1,124\xD7, with zero drops selected.\n\n- **Per-stage progress cursors** decouple progress from output. Each stage\n  (observer, reflector, dropper) gets a cursor entry ID that advances whenever\n  the stage runs - regardless of whether it produced output. "I looked and\n  found nothing" is a valid answer that blocks re-processing.\n- **Cursor `state` field** (`recorded` | `empty` | `error` | `skipped` | `not_due` | `initial`)\n  distinguishes empty runs from skipped stages from actual output.\n- **Reflector gates on new data.** If no new `OM_OBSERVATIONS_RECORDED` batches\n  exist since the reflector cursor, and `reflectAfterTokens` threshold not met,\n  skip entirely - no LLM call.\n- **Dropper gates on pressure or new data.** Runs only when pool \u2265 10% fullness AND\n  (new data exists OR pool \u2265 `dropperPressureThreshold` \xD7 `reflectorInputMaxTokens`).\n  Previously always returned `not_over_target` with 0 drops - now correctly skipped.\n- **Cursor storage:** in-memory primary (zero-I/O gating), async flush to\n  `{sessionId}-pending.json` for durability across restarts. Degrades gracefully\n  on read-only filesystems.\n- **Stale cursor recovery:** if a cursor\'s entry ID disappears (fork, navigation,\n  compaction), falls back to coverage-marker logic for one run, then writes fresh cursors.\n\n### New config key: `dropperPressureThreshold`\n\n- Fraction of `reflectorInputMaxTokens` at which the dropper fires even without\n  new data (pressure relief valve). Default `0.70` (70%). Set to `1.0` to disable\n  pressure-driven dropper entirely.\n\n### Debug log additions\n\n- `observer.skip`, `reflector.start`, `reflector.skip`, `dropper.start`,\n  `dropper.skip`, `cursor.loaded`, `cursor.saved`\n\n### Deferred pipeline concerns (pre-merge review)\n\nAudit surfaced 7 correctness/performance edge cases in the cursor pipeline.\nFour were fixed; three were deferred as harmless or cosmetic.\n\n**Fixed:**\n- **Session fork cursor bleed (#2).** `cursorsLoaded` was a one-shot boolean\n  \u2014 on session fork, stale cursors bled into the new branch because\n  `validateCursors` was never re-invoked. Now keyed by `cursorsLoadedSessionId`\n  so cursors are re-loaded and re-validated whenever the session ID changes.\n- **Manual-mode pool fullness underestimation (#1).** `anyStageDue` had no\n  visibility into pending observations in `compaction: "manual"` mode (branch\n  has no OM markers). Reflector and dropper due checks now accept an optional\n  `PendingOMState` so pending batches contribute to new-data scans and pool\n  token counts. Prevents the pipeline from stalling after the first run in\n  manual mode.\n- **foldLedger on every agent_start/turn_end (#3).** `dropperDue` called\n  `foldLedger` (O(n) on branch) unconditionally \u2014 even when the observer or\n  reflector alone made the pipeline due. Now short-circuits: the fold is\n  only computed when both observer and reflector are not due.\n- **Observer cursor to non-source entry (#6).** When the observer skipped\n  (not due), the cursor advanced to `entries.at(-1)` which could be a custom\n  OM marker rather than a conversation source entry. Now advances to the\n  last source entry (`findLast(isSourceEntry)`).\n\n**Deferred:**\n- **"unknown" magic entry ID (#4).** Functional but cosmetic \u2014 the sentinel\n  triggers fallback on next load. 9 call sites; zero behavioral change.\n- **Observer re-checks tokens (#5).** Harmless \u2014 only reached when pipeline\n  launched for a different stage. Correctly advances cursor to `not_due`.\n- **Dropper cursor fallback cascade (#7).** The 4-step `coversUpToId ??`\n  `observationCoverageId ?? entries.at(-1)?.id` cascade is already reasonable\n  fallback ordering.\n\n### Tests\n\n- 17 new tests for cursor gating, persistence, stale recovery, and debug log events\n- 3 new tests for manual-mode pending awareness (reflector, dropper, post-first-run)\n- `dropperPressureThreshold` added to config validation tests\n\n\n\n# Changelog\n\n## [0.3.7] - 2026-06-10\n\n### Recall tool simplification (#27)\n\n- Dropped `mode:transcript` \u2014 strict subset of `mode:hybrid` with no unique capability. (#27)\n- Consolidated 5 scattered `promptGuidelines` into 2 focused entries; removed "NOT semantic" redundancy and JSONL implementation leak. (#27)\n- Removed internal taxonomy from mode descriptions ("transcript + file indicators" \u2192 "all session content"). (#27)\n- Added `mode:touched` support to `/blackhole-recall` command (previously only worked via agent tool). (#27)\n- Collapsed drill-down examples to `#N:path with optional :offset:limit or :full`. (#27)\n\n### Stale context crash protection (#26)\n\n- Added `getErrorMessage()` to normalize cross-process error serialization (Error objects, plain objects with `message`, arbitrary thrown values). (#26)\n- Added `isStaleExtensionContextError()` to detect stale-context error patterns. (#26)\n- Added `notifySafely()` wrapper around `ui.notify()` calls to prevent stale-context notification errors from propagating. (#26)\n- Wrapped `agent_end` handler, async compaction callbacks (`onComplete`, `onError`), and deferred timer callback to silently bail on stale-context errors. (#26)\n\n### Lockstep sync \u2014 2026-06-05 (#25)\n\n- Ported [pi-observational-memory/58f05fa](https://github.com/elpapi42/pi-observational-memory/commit/58f05fa): remove `Math.min(100)` cap from `pct()` helper so overfull observation pool (>100%) is displayed accurately instead of silently capping at 100%. (#25)\n- Skipped [pi-observational-memory/58f05fa](https://github.com/elpapi42/pi-observational-memory/commit/58f05fa) command renames (`/om-status`\u2192`/om:status`, `/om-view`\u2192`/om:view`) \u2014 our equivalent commands (`/blackhole-memory`) already use a different naming scheme. (#25)\n- Deferred [pi-observational-memory/bf79ff7](https://github.com/elpapi42/pi-observational-memory/commit/bf79ff7) and [pi-observational-memory/52b5844](https://github.com/elpapi42/pi-observational-memory/commit/52b5844): pool metrics extraction + `budgetTokens`\u2192`targetTokens` rename. Blocking branch (`noautocompact-reflector-dropper`) is now stale/dropped, but changes touch heavily diverged files. (#25)\n\n## [0.3.5] - 2026-06-04\n\n### Added\n\n- **`sessionFallback` config option.** When `false`, skip the main session model as last-resort fallback when all OM-specific model candidates are exhausted. Default `true` for backward compatibility. Useful for keeping OM workers on cheaper/faster models. ([#20](https://github.com/k0valik/pi-blackhole/pull/20))\n- **Session-file LRU cache.** `loadAllMessages` now caches up to 3 session files with mtime + TTL (2s) invalidation. Reduces redundant I/O on repeated recall searches in the same session. ([#20](https://github.com/k0valik/pi-blackhole/pull/20))\n- **Pending state sanitization.** `readSessionState` now filters corrupted batch entries (missing `coversUpToId` or `data` fields) instead of returning them as-is. Prevents crashes from edge cases like a partial write to `pending.json`. ([#20](https://github.com/k0valik/pi-blackhole/pull/20))\n- **Shared `isRetryableError` / `RETRYABLE_ERROR_RE`.** Extracted from `cooldown.ts` and `compaction-trigger.ts` into `retryable-error.ts` \u2014 single source of truth, re-exports Pi\'s `isContextOverflow` for provider-specific overflow detection. ([#20](https://github.com/k0valik/pi-blackhole/pull/20))\n- **Shared provider-stream bridge.** `createBridgeStreamFn` extracted from all three OM agents (observer, reflector, dropper) into `provider-stream.ts`. Custom providers registered by other extensions (e.g., claude-bridge) continue working through jiti-loaded consolidation agents. ([#21](https://github.com/k0valik/pi-blackhole/pull/21))\n- **Async buffered debug logging.** `debugLog()` now buffers JSONL writes in memory and flushes on a 1-second background timer, with synchronous flush on `exit`. Reduces event-loop blocking during high-frequency debug events. ([#20](https://github.com/k0valik/pi-blackhole/pull/20))\n- **Windows path support in file extraction.** `longestCommonDirPrefix` normalizes backslashes and recognizes `C:\\`-style drive letters. ([#20](https://github.com/k0valik/pi-blackhole/pull/20))\n\n### Fixed\n\n- **Context window check uses actual input size, not configured cap.** Observer/reflector/dropper now compute `observerEstimatedInput` from the actual chunk tokens after capping, not from `observerChunkMaxTokens`. More accurate \u2014 fewer false "context window exceeded" rejections on smaller-than-cap inputs. ([#20](https://github.com/k0valik/pi-blackhole/pull/20))\n- **`coversUpToId` now points past capping, not before.** Observer stage captured the last entry ID before capping source entries to `maxChunkTokens`, so the coverage marker could point to an entry that was dropped. Now captured after capping. ([#20](https://github.com/k0valik/pi-blackhole/pull/20))\n- **`capSourceEntriesToTokens` counts all entry types.** Previously only `"message"` entries counted toward the token budget \u2014 custom OM entries (`observations_recorded`, `reflections_recorded`, etc.) and summary-bearing entries were invisible, risking context overflow in the observer. ([#20](https://github.com/k0valik/pi-blackhole/pull/20))\n- **Reflector/dropper avoid redundant disk reads.** Both stages now use the outer-scope `pending` variable (already read in the `noAutoCompact` block) instead of calling `readPendingState(sessionId)` again inside the for loop. Neutral correctness win. ([#20](https://github.com/k0valik/pi-blackhole/pull/20))\n- **Observer rejects invalid observation IDs gracefully.** `normalizeSourceEntryIds` now filters out unknown/duplicate IDs instead of returning `undefined` and discarding the entire observation batch. One hallucinated ID from the LLM no longer loses valid observations. ([#20](https://github.com/k0valik/pi-blackhole/pull/20))\n- **`pendingObservationsCreatedAfter` properly typed.** Changed from `pending: any` to `pending: PendingOMState` \u2014 catches type mismatches at compile time. ([#20](https://github.com/k0valik/pi-blackhole/pull/20))\n- **Section headers in summaries use line-boundary regex.** `sectionOf` and `stripOMContent` now match `## Reflections` / `## Observations` at the start of a line instead of using bare `indexOf`. Prevents false positives when those phrases appear inside file paths or conversation text. ([#20](https://github.com/k0valik/pi-blackhole/pull/20))\n- **Read+same-path-Modified dedup in file summaries.** `mergeFileLines` now removes a path from `Read` if it also appears in `Modified` \u2014 a file that was read then edited shouldn\'t show twice. ([#20](https://github.com/k0valik/pi-blackhole/pull/20))\n- **`reverse-recall` outputs related reflections.** The `_reflections` dead parameter is now used \u2014 related reflections are shown alongside observations when expanding session entries. ([#20](https://github.com/k0valik/pi-blackhole/pull/20))\n- **Cooldown reason in UI notification.** The `getCooldownEntry` function now returns the actual entry (with reason), so the status notification shows *why* a model was cooled down, not just "cooldown active". ([#20](https://github.com/k0valik/pi-blackhole/pull/20))\n- **Env override validation.** Invalid `PI_BLACKHOLE_COMPACTION` / `PI_BLACKHOLE_COMPACTION_ENGINE` values now print a warning instead of being silently ignored. ([#20](https://github.com/k0valik/pi-blackhole/pull/20))\n- **`observerPreambleMaxTokens` accepts 0.** Now uses `nonNegativeInt` validator instead of `positiveInt` \u2014 0 means "auto-compute", which was the intended semantics. ([#20](https://github.com/k0valik/pi-blackhole/pull/20))\n\n### Changed\n\n- **Replaced hand-rolled text wrapping with `wrapTextWithAnsi` from pi-tui.** The custom `wrapLine` function was replaced with `wrapLineWithContinuation` using pi-tui\'s ANSI-aware wrapping. Handles list continuation indentation and ANSI mid-sequence splits correctly. ([#21](https://github.com/k0valik/pi-blackhole/pull/21))\n- **`visibleWidth` re-exported from pi-tui.** The local CJK-width implementation in `key-matcher.ts` was replaced with a re-export from `@oh-my-pi/pi-tui`. Fallback note retained if the import fails in overlay context. ([#21](https://github.com/k0valik/pi-blackhole/pull/21))\n- **Bash command compression improved.** Multi-line commands joined with semicolons instead of first-line-only. Pipe tails strip `awk`/`python3`/`node`/`bun` excluded (their output carries semantic meaning). Word-boundary truncation instead of mid-word cut. Up to 10 tail-strip iterations with stability guard. ([#20](https://github.com/k0valik/pi-blackhole/pull/20))\n- **`fuzzyMatch` \u2192 `prefixMatch`.** The `/blackhole` subcommand filter changed from fuzzy/subsequence matching to simple prefix matching. Predictable narrowing: typing "om" matches "om-on" and "om-off". ([#21](https://github.com/k0valik/pi-blackhole/pull/21))\n- **`read` tool summary field corrected.** `TOOL_SUMMARY_FIELDS` now maps lowercase `read` \u2192 `"path"` (not `"file_path"`), matching the actual tool argument. ([#20](https://github.com/k0valik/pi-blackhole/pull/20))\n- **Tool error blank-line suppression.** `stringifyBrief` now suppresses blank lines between consecutive tool/error summaries (previously only between consecutive tool summaries). ([#20](https://github.com/k0valik/pi-blackhole/pull/20))\n- **Recall header distinguishes matches vs expands.** The search result header now shows `"X matches (+ Y expanded)"` when entries were pulled in via `#N` expand rather than matching the query. ([#20](https://github.com/k0valik/pi-blackhole/pull/20))\n- **Compaction output instructions split into full/basic variants.** `CONTEXT_USAGE_INSTRUCTIONS` shortened to 4 lines (previously 10). When observations/reflections are present, the full version includes the bracketed-ids preamble + recall footer. When none exist (or OM is off), a basic 2-line recall-guidance footer is appended instead. `renderSummary` always returns a footer, and `stripOMContent` handles both variants to prevent compounding. ([#23](https://github.com/k0valik/pi-blackhole/pull/23))\n\n### Removed\n\n- **Dead `loadSettings()` / `PiVccSettings`.** Config loading unified in `unified-config.ts` \u2014 the `settings.ts` wrapper had zero callers. ([#20](https://github.com/k0valik/pi-blackhole/pull/20))\n- **Dead `transcriptEntries` from `SectionData`.** Removed from `sections.ts` and `build-sections.ts`. (dead since v0.3.3) ([#20](https://github.com/k0valik/pi-blackhole/pull/20))\n- **Dead toggle helpers.** `toggleCompaction`, `toggleCompactionEngine`, `toggleTailBehavior` removed from `unified-config.ts` (zero callers \u2014 toggling is handled by the configure overlay). ([#20](https://github.com/k0valik/pi-blackhole/pull/20))\n- **Dead `vcc-report.test.ts`.** Test file was testing a non-existent `src/core/report.js` module. ([#20](https://github.com/k0valik/pi-blackhole/pull/20))\n- **Dead `config-simplification.test.ts`.** Tested old config migration that\'s been stable since v0.3.3. ([#20](https://github.com/k0valik/pi-blackhole/pull/20))\n\n### Docs\n\n- **Renamed example configs.** `example-config-v2.json` \u2192 canonical `example-config.json` (new config surface). Old `example-config.json` \u2192 `example-config-old.json` (legacy keys). ([#21](https://github.com/k0valik/pi-blackhole/pull/21))\n- **README: updated "What the agent sees" example** to match actual output ordering and expanded RECALL_NOTE text. ([#21](https://github.com/k0valik/pi-blackhole/pull/21))\n- **README: added `sessionFallback` to settings table.** ([#20](https://github.com/k0valik/pi-blackhole/pull/20))\n- **example-config.json: added `sessionFallback` field.** ([#20](https://github.com/k0valik/pi-blackhole/pull/20))\n- **README: updated "What the agent sees" example** to match the new shorter CONTEXT_USAGE_INSTRUCTIONS text and note about basic footer when OM is off. ([#23](https://github.com/k0valik/pi-blackhole/pull/23))\n\n## [0.3.4] - 2026-06-02\n\n### Added\n\n- **`cooldownHours: 0` disables cooldown without disk writes.** Previously `cooldownHours: 0` was rejected by the positive-int validator and silently replaced with a 1-hour cooldown. Now 0 is a valid value that disables cooldown entirely \u2014 no disk writes, no persistent state. Failed models are tracked in-memory within each consolidation stage (via `failedInCycle` set) so the fallback chain still advances past them. ([#16](https://github.com/k0valik/pi-blackhole/issues/16), [#18](https://github.com/k0valik/pi-blackhole/pull/18))\n- **Kitty CSI-u keyboard protocol support for overlays.** The configure and status overlays use pi-tui\'s `matchesKey` (which handles both legacy terminal sequences and Kitty\'s CSI-u protocol) instead of the homegrown `matchKey`. Digit input uses `decodeKittyPrintable` to decode CSI-u encoded characters. ([#17](https://github.com/k0valik/pi-blackhole/issues/17), [#19](https://github.com/k0valik/pi-blackhole/pull/19))\n- **Per-stage failure notification isolation.** When cooldown is disabled, each consolidation stage (observer, reflector, dropper) now shows its own failure notification \u2014 observer failure no longer suppresses reflector/dropper notifications. ([#19](https://github.com/k0valik/pi-blackhole/pull/19))\n\n### Fixed\n\n- **Keyboard freeze in `/blackhole configure` on Kitty terminal.** The homegrown `matchKey` function did not recognize Kitty\'s CSI-u keyboard protocol sequences (used by Kitty, WezTerm, and other modern terminals). Switched to pi-tui\'s `matchesKey` which supports both legacy and CSI-u input. ([#17](https://github.com/k0valik/pi-blackhole/issues/17), [#19](https://github.com/k0valik/pi-blackhole/pull/19))\n- **Config error notifications no longer downgraded to info.** When a session model has no API key configured, the notification correctly shows a "warning" level message instead of the misleading "info" message previously shown when `failedInCycle` was non-empty. ([#16](https://github.com/k0valik/pi-blackhole/issues/16), [#18](https://github.com/k0valik/pi-blackhole/pull/18))\n\n### Changed\n\n- **Removed `key-matcher.ts` `matchKey` export** (replaced by pi-tui\'s `matchesKey`). The `visibleWidth` export is retained.\n\n## [0.3.3] - 2026-06-02\n\n### Added\n\n- **New config surface:** `compaction` (`"auto"` | `"manual"` | `"off"`), `compactionEngine` (`"blackhole"` | `"pi-default"`), `tailBehavior` (`"pi-default"` | `"minimal"`). These replace the old `overrideDefaultCompaction`, `noAutoCompact`, and `passive` keys. See [`MIGRATION-GUIDE.md`](MIGRATION-GUIDE.md) for the full mapping. ([#14](https://github.com/k0valik/pi-blackhole/pull/14))\n- **Config overlay (`/blackhole configure`):** interactive TUI with \u2191\u2193 navigation, Enter to edit/toggle, Ctrl+S to save. 17 fields across 3 sections (Compaction, Observational Memory, Debug) with inline help text. ([#14](https://github.com/k0valik/pi-blackhole/pull/14))\n- **Status overlay (`/blackhole-memory`):** new render with compaction config readout, OM pipeline state, and inline actions (configure, om-off/on). ([#14](https://github.com/k0valik/pi-blackhole/pull/14))\n- **Tail behavior control:** `tailBehavior: "minimal"` keeps only the last user message (aggressive pi-vcc cut, default); `tailBehavior: "pi-default"` keeps Pi\'s ~20k token tail visible (opt-in). Both auto-triggered and `/blackhole` now default to `"minimal"`. ([#14](https://github.com/k0valik/pi-blackhole/pull/14))\n- **12 permutation tests** covering all compaction \xD7 memory \xD7 threshold combinations for the new config keys. ([#14](https://github.com/k0valik/pi-blackhole/pull/14))\n- **Documentation:** CONFIG.md (new reference), OLD_CONFIG.md (legacy docs), MIGRATION-GUIDE.md (migration path from old keys), README.md and llms.txt updated for the new surface. ([#14](https://github.com/k0valik/pi-blackhole/pull/14))\n- **Per-model context window override:** `OmModelConfig` now supports an optional `contextWindow` field. When set on any stage model or fallback, it overrides Pi\'s model registry value for the context window check. Unset models inherit from Pi normally. ([#14](https://github.com/k0valik/pi-blackhole/pull/14))\n- **Context window pre-check:** before calling each OM stage agent (observer, reflector, dropper), the estimated input tokens (stage cap + 8K reserve for system prompt/tools/turns) are checked against the model\'s effective context window. If the input exceeds the window, the model is skipped and the next fallback is tried. If all models are exhausted, a warning is shown. Strictly opt-in \u2014 with default caps (40K\u201380K) and typical models (128K+), the check is a no-op unless a `contextWindow` override is explicitly set. ([#14](https://github.com/k0valik/pi-blackhole/pull/14))\n- **8 tests** covering context window parsing from config, priority resolution, rejection of invalid values, and `effectiveContextWindow` logic. ([#14](https://github.com/k0valik/pi-blackhole/pull/14))\n\n### Changed\n\n- **`memory: false` no longer blocks auto-compaction.** Memory and compaction are now truly independent \u2014 `memory: false` stops OM workers but compaction still runs. Use `compaction: "manual"` or `compaction: "off"` to control compaction separately. ([#14](https://github.com/k0valik/pi-blackhole/pull/14))\n- **`compaction: "off"` semantics refined:** blocks blackhole\'s auto-trigger and returns early from the before-compact hook for auto-triggered compactions (letting Pi handle them), but explicit `/blackhole` still uses blackhole\'s pipeline. ([#14](https://github.com/k0valik/pi-blackhole/pull/14))\n- **Config migration is automatic:** old keys (`overrideDefaultCompaction`, `noAutoCompact`, `passive`) are migrated to new keys in memory at load time. The on-disk file is never mutated. New keys take priority when present. ([#14](https://github.com/k0valik/pi-blackhole/pull/14))\n- **Permutation tests updated** to reflect the new behavior: `overrideDefaultCompaction` now gates the legacy trigger path, `memory` no longer gates the trigger, and the 16-permutation matrix uses the correct formula. ([#14](https://github.com/k0valik/pi-blackhole/pull/14))\n\n### Fixed\n\n- **Save error handling:** `save()` returns boolean and wraps writes in try/catch \u2014 read-only filesystems (e.g., Nix-managed config) no longer crash with an unhandled exception. ([#14](https://github.com/k0valik/pi-blackhole/pull/14))\n- **Number input restriction:** configure overlay now only accepts digits for number fields, preventing garbage values from being entered. ([#14](https://github.com/k0valik/pi-blackhole/pull/14))\n- **Defensive bounds:** section header pads in configure-overlay and status-overlay use `Math.max(0, ...)` / `Math.max(2, ...)` to prevent negative `.repeat()` counts on tiny terminals. ([#14](https://github.com/k0valik/pi-blackhole/pull/14))\n- **Config save failure warning:** `/blackhole configure` now shows a "warning" notification when the config file can\'t be written instead of a misleading "info" notification. ([#14](https://github.com/k0valik/pi-blackhole/pull/14))\n- **Legacy config tests:** updated `config.test.ts` to check new config keys (`compaction`, `compactionEngine`, `memory`) instead of deleted legacy fields (`passive`, `overrideDefaultCompaction`), fixing 10 pre-existing test failures. ([#14](https://github.com/k0valik/pi-blackhole/pull/14))\n- **pi-default non-message firstKeptEntryId resolution:** when Pi\'s `firstKeptEntryId` points to a non-message entry (e.g., OM metadata or compaction), `buildOwnCut` now resolves to the next actual message entry instead of falling through to the minimal cut. ([#15](https://github.com/k0valik/pi-blackhole/pull/15))\n- **Array micro-optimization in buildOwnCut:** replaced `branchEntries.slice(cutInBranch + 1).find()` with `branchEntries.find()` using an index check, avoiding a temporary array allocation. ([#15](https://github.com/k0valik/pi-blackhole/pull/15))\n\n## [0.3.2] - 2026-06-01\n\n### Fixed\n\n- **Auto-compaction gating:** added explicit guard at the top of the compaction trigger that returns early when `overrideDefaultCompaction` is `false` (the default). Previously, blackhole would still evaluate token thresholds and call Pi\'s default compaction hook even when not opted in \u2014 causing confusing log entries and unnecessary evaluations. Now blackhole stays completely out of Pi\'s compaction unless the user explicitly opts in. ([#13](https://github.com/k0valik/pi-blackhole/pull/13))\n\n### Added\n\n- **README top banner:** prominent NOTE at the top instructing users to set `"overrideDefaultCompaction": true` for blackhole to handle compaction automatically. Existing config matrix in the IMPORTANT section retained for reference.\n\n## [0.3.1] - 2026-05-31\n\n### Fixed\n\n- **Auto-compaction idle detection timing:** changed compaction scheduling from `queueMicrotask` to `setTimeout(..., 0)`. The microtask fired before Pi completed its post-response processing cycle, causing `ctx.isIdle()` to always return `false` and compaction to be deferred indefinitely. `setTimeout` yields to the event loop, allowing Pi to mark itself idle before the callback runs. ([#13](https://github.com/k0valik/pi-blackhole/pull/13))\n\n### Added\n\n- **Debug logging for compaction pipeline:** structured `debugLog` instrumentation at every decision point \u2014 guard checks, token threshold evaluation, branch entry inspection, session identity validation, idle check, and compaction completion/error. Opt-in via `"debugLog": true` in config, zero overhead otherwise. ([#13](https://github.com/k0valik/pi-blackhole/pull/13))\n- **Permutation test suite:** 36 new tests covering all 16 configuration knob combinations for auto-compaction trigger behavior. ([#13](https://github.com/k0valik/pi-blackhole/pull/13))\n\n## [0.2.4] - 2026-05-29\n\n### Recall: progressive discovery\n\n- **Touched mode (`mode:touched`):** aggregate view of all files written/edited across the session, grouped by path with entry indices. Accessible via `recall` tool and `/blackhole-recall` command. ([#12](https://github.com/k0valik/pi-blackhole/pull/12))\n- **Drill-down (`#N:path`):** read file content from tool call arguments in any transcript entry. Supports `#42:auth.ts` (preview first 30 lines), `#42:auth.ts:full` (all lines), `#42:auth.ts:offset:limit` (paged). Path auto-selects when unique; ambiguous paths list options. ([#12](https://github.com/k0valik/pi-blackhole/pull/12))\n- **Search mode filtering (`mode:file`, `mode:transcript`, `mode:hybrid`):** `mode:file` searches only write/edit file content; `mode:transcript` searches only conversation text; `mode:hybrid` (default) searches both. ([#12](https://github.com/k0valik/pi-blackhole/pull/12))\n- **Merged expand + search:** `#N` expand entries are now merged into search results (rather than being mutually exclusive), with proper pagination and sorting. ([#12](https://github.com/k0valik/pi-blackhole/pull/12))\n- **`scope` parameter as `StringEnum`:** tool schema now uses `StringEnum` (strict literal union) instead of `Type.Union` for `scope` and `mode` parameters. ([#12](https://github.com/k0valik/pi-blackhole/pull/12))\n\n### Fixed\n\n- **Null-safe entry IDs in `load-messages.ts`:** gracefully handles entries with `null` IDs instead of crashing with `String(null)` \u2192 `"null"`. ([#12](https://github.com/k0valik/pi-blackhole/pull/12))\n- **`formatRecallOutput` preserves legacy `files:[...]` format:** the expand-only path (no query) was silently dropping file info from entries that have the `files` field but no `fileMatches` \u2014 now falls back to the old `files:[path1, path2]` suffix. ([#12](https://github.com/k0valik/pi-blackhole/pull/12))\n\n### Crash protection \u2014 jiti bridge, EACCES guards, config safety\n\n- **Jiti bridge for custom providers:** `index.ts` now wraps `pi.registerProvider` to capture `streamSimple` functions into a `Symbol.for()` global, and scans `modelRegistry.registeredProviders` once on `agent_start`. This prevents crashes when consolidation agents (loaded via jiti with `moduleCache: false`) resolve a custom provider like `claude-bridge` \u2014 previously the jiti-loaded pi-ai instance had an empty `apiProviderRegistry` and threw `"No API provider registered"`. ([#11](https://github.com/k0valik/pi-blackhole/pull/11))\n- **Lazy bridge evaluation:** the bridge stream function now checks the provider map at call time instead of at import time, fixing an IIFE race condition where the bridge was permanently disabled because provider registration hadn\'t happened yet at module load. ([#11](https://github.com/k0valik/pi-blackhole/pull/11))\n- **Always-run fallback scan:** replaced `providerStreams.size > 0` guard with a dedicated `hasScannedFallback` flag \u2014 the fallback scan now always runs once regardless of how many providers the wrapper already captured, handling extensions that register before blackhole loads. ([#11](https://github.com/k0valik/pi-blackhole/pull/11))\n- **EACCES guards:** `writeCooldownMap()` and `writeSessionState()` now wrapped in try/catch. Prevents process crash on read-only filesystems (e.g., Nix-managed config). Cooldown loss is advisory (slightly more API traffic); pending state loss is safe (idempotent re-processing). ([#11](https://github.com/k0valik/pi-blackhole/pull/11))\n- **Numeric config validation:** all numeric fields are validated at load \u2014 NaN, infinity, and negative values are reset to defaults. Prevents silent math errors in pipeline logic. ([#11](https://github.com/k0valik/pi-blackhole/pull/11))\n- **`observerPreambleMaxTokens=0` explicitly allowed** in numeric validation (means "auto-compute"). ([#11](https://github.com/k0valik/pi-blackhole/pull/11))\n- **Better error messages for config save failures:** `/blackhole om-on` / `om-off` now use `"warning"`-level notification with an explanation about read-only filesystems when the config save fails, instead of a misleading `"info"`-level "Failed to save config.". ([#11](https://github.com/k0valik/pi-blackhole/pull/11))\n\n## [0.2.3] - 2026-05-27\n\n### Lockstep sync \u2014 2026-05-27\n\n- Ported upstream OM prompt refinements: coverage tiers in dropper prompt, "highest-resistance" critical framing in observer, coverage stewardship in reflector (#safe)\n- Ported upstream debug logging: `dropper.agent_start`, `dropper.tool_call`, `dropper.result` with full coverage/relevance diagnostics (#d6b02c0)\n- Ported upstream coverage-aware pruning: new `coverage.ts` module, drop candidate sort by coverage\u2192relevance\u2192age, critical observations no longer hard-rejected (#e00363a)\n- Adapted config: added `observationsPoolTargetTokens` as forward-compat no-op (upstream 52b5844 budgetTokens\u2192targetTokens rename)\n- Skipped upstream pool refactor (bf79ff7) and rename (52b5844): kept our ratio-based urgency algorithm\n- Recovered output cap from feat/compaction-output-cap: `buildCompactionProjection` now caps rendered observations to `observationsPoolMaxTokens` budget via relevance+recency scoring\n\n## [0.2.2] - 2026-05-26\n\n### Added\n\n- `/blackhole-memory` pipeline display reworked: renamed "Coverage" to "Pipeline", replaced percentage-based metrics with `X tokens (triggers at Y)` format to eliminate false-alarm 100% readings, added `[auto-disabled]` annotation for compaction in noAutoCompact mode, and show preamble cap in Pending section ([#7](https://github.com/k0valik/pi-blackhole/pull/7))\n- Default `observeAfterTokens` increased from 10,000 to 15,000 and `reflectAfterTokens` from 20,000 to 25,000 for better cost-efficiency on mid/high context sessions ([#7](https://github.com/k0valik/pi-blackhole/pull/7))\n- Observer preamble cap in noAutoCompact mode: the observer stage\'s `CURRENT OBSERVATIONS` preamble is now capped to prevent unbounded prompt growth from accumulated observation batches. High-relevance observations are always kept; medium and low observations are scored by relevance tier and relative recency (array position, not wall-clock time), with the best-scoring kept within the token budget. Reflections are never trimmed. The cap is governed by the new `observerPreambleMaxTokens` config setting (default `0` = auto-compute 30% of `observerChunkMaxTokens`). Only applies in `noAutoCompact` mode \u2014 the auto-compact path is unchanged. ([#7](https://github.com/k0valik/pi-blackhole/pull/7))\n- Accumulated batch history for noAutoCompact mode: the observer, reflector, and dropper stages now feed accumulated pending.json batches (observationBatches/reflectionBatches) to the LLM instead of reading from the (empty) branch. This restores the same historical context the pipeline receives in autoCompact mode \u2014 prior observations/reflections, existing summaries \u2014 but without writing markers to the visible branch. Each pipeline run appends its output batch to the pending store; on /blackhole flush, all accumulated batches are written as separate branch markers, preserving per-run coverage. ([#7](https://github.com/k0valik/pi-blackhole/pull/7))\n- Accumulated dropper batches (`droppedBatches`) in pending.json so that earlier dropper runs are not lost when a subsequent cycle overwrites `pending.dropped` before a /blackhole flush. The flush now writes all accumulated dropper batches to the branch, preventing observations dropped in earlier cycles from being "un-dropped" on compaction. ([#7](https://github.com/k0valik/pi-blackhole/pull/7))\n\n### Fixed\n\n- Reflector and dropper now read from `pending.json` in `noAutoCompact` mode instead of scanning the branch for observation markers that are never written there. Previously the early-exit gates in both stages returned immediately because `latestCoverageMarkerId(entries, OM_OBSERVATIONS_RECORDED)` found nothing in the branch (observations are saved to pending only). This caused the reflector and dropper to skip entirely, leaving the pipeline half-functional \u2014 no reflections were ever generated, the dropper never pruned, and the display showed misleading pool values. The fix adds `noAutoCompact`-aware early-exit gates that check `pending.observation`, `pending.reflection`, and `pending.dropped` state, using their `coversUpToId` values to calculate token gaps and gate correctly on `reflectAfterTokens`. Observations and reflections are fed from pending data instead of the empty branch. The notification token-adjustment logic (which already existed for all three stages) is now effective because the stages actually run. ([#6](https://github.com/k0valik/pi-blackhole/pull/6))\n\n## [0.2.1] - 2026-05-24\n\n### Fixed\n\n- Prevent repeated `Intl.Segmenter` constructor fallback retries on unsupported runtimes ([#5](https://github.com/k0valik/pi-blackhole/pull/5))\n- `/blackhole-memory` accumulated token counts now factor in pending `coversUpToId` as virtual coverage markers in `noAutoCompact` mode ([#5](https://github.com/k0valik/pi-blackhole/pull/5))\n- Pipeline notifications (observer/reflector/dropper) show accurate accumulated values accounting for pending coverage ([#5](https://github.com/k0valik/pi-blackhole/pull/5))\n- `stageThinkingLevel()` resolves per-model thinking config instead of using the primary stage model\'s setting for all fallback attempts ([#5](https://github.com/k0valik/pi-blackhole/pull/5))\n- Move `@earendil-works/*` packages to `peerDependencies` (provided by pi host at runtime), `typebox` to `devDependencies` (import type only) ([#5](https://github.com/k0valik/pi-blackhole/pull/5))\n- Dead code removal: deleted `src/om/compaction-hook.ts` and `src/core/report.ts` ([#5](https://github.com/k0valik/pi-blackhole/pull/5))\n- Module-level state leak: compaction stats moved to `Runtime` instance for session isolation ([#5](https://github.com/k0valik/pi-blackhole/pull/5))\n- Unified config loading: removed dual `loadSettings` path, `ensureConfig` called at handler start ([#5](https://github.com/k0valik/pi-blackhole/pull/5))\n- Stale context in deferred compaction: replaced `setTimeout(..., 0)` with `queueMicrotask` and session ID validation ([#5](https://github.com/k0valik/pi-blackhole/pull/5))\n- Silent JSON parse failures in `load-messages.ts` \u2014 now logged ([#5](https://github.com/k0valik/pi-blackhole/pull/5))\n- Silent `scaffoldConfig` errors \u2014 now logged ([#5](https://github.com/k0valik/pi-blackhole/pull/5))\n- `visibleProjection` falls through to `fullProjection` when no compaction has run ([#5](https://github.com/k0valik/pi-blackhole/pull/5))\n- `renderMessage` calls in `report.ts` and test types missing required `Message` properties ([#5](https://github.com/k0valik/pi-blackhole/pull/5))\n- CI publish workflow uses `npm` instead of `pnpm` (not available in runner) ([#5](https://github.com/k0valik/pi-blackhole/pull/5))\n- Added `typescript` devDependency for CI `tsc` check ([#5](https://github.com/k0valik/pi-blackhole/pull/5))\n\n### Changed\n\n- Improved model fallback: `resolveModel` iterates fallback chain (stage \u2192 fallbacks \u2192 base \u2192 session), records per-model cooldown on retryable errors ([#5](https://github.com/k0valik/pi-blackhole/pull/5))\n\n### Added\n\n- Bi-directional recall coupling: `#N` transcript expansion shows related OM observations/reflections; OM hex-id recall shows `#N` entry index annotations ([#5](https://github.com/k0valik/pi-blackhole/pull/5))\n- `id` field on `RenderedEntry` for cross-referencing with session entries ([#5](https://github.com/k0valik/pi-blackhole/pull/5))\n\n## [0.2.0] - 2026-05-24\n\n### Added\n\n- Initial release: unified compaction (pi-vcc) + observational memory (pi-observational-memory)\n- `/blackhole` command for manual compaction with OM content injection\n- `/blackhole-memory` command for pipeline status display\n- `/blackhole-recall` command for unified recall (transcript + OM)\n- Three-stage consolidation pipeline: observer \u2192 reflector \u2192 dropper with fallback retry\n- Per-session pending file isolation\n- Model cooldown persistence across restarts\n- CI/CD publish workflow for npm\n';
function getOwnPackageRoot() {
  try {
    const metaUrl = import.meta.url;
    if (typeof metaUrl === "string" && metaUrl.length > 0) {
      let dir = dirname(fileURLToPath(metaUrl));
      while (dir !== dirname(dir)) {
        try {
          const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
          if (pkg.name === "pi-blackhole") return dir;
        } catch {
        }
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    }
  } catch {
  }
  try {
    let dir = process.cwd();
    while (dir !== dirname(dir)) {
      try {
        const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
        if (pkg.name === "pi-blackhole") return dir;
      } catch {
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
  }
  try {
    const entry = process.argv[1];
    if (entry) {
      let dir = dirname(entry);
      while (dir !== dirname(dir)) {
        try {
          const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
          if (pkg.name === "pi-blackhole") return dir;
        } catch {
        }
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    }
  } catch {
  }
  return process.cwd();
}
function getPackageVersion(packageRoot) {
  const root = packageRoot ?? getOwnPackageRoot();
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
    if (typeof pkg.version === "string" && pkg.version.length > 0) return pkg.version;
  } catch {
  }
  return void 0;
}
function stripMarkdownInline(text) {
  let s = text;
  s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  s = s.replace(/`([^`]+)`/g, "$1");
  s = s.replace(/\*\*\*([^*]+)\*\*\*/g, "$1");
  s = s.replace(/\*\*([^*]+)\*\*/g, "$1");
  s = s.replace(/__([^_]+)__/g, "$1");
  s = s.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "$1");
  s = s.replace(/(?<!\w)_([^_\n]+)_(?!\w)/g, "$1");
  s = s.replace(/~~([^~]+)~~/g, "$1");
  return s;
}
function readChangelogText(packageRoot) {
  const explicitRoot = packageRoot !== void 0;
  const root = packageRoot ?? getOwnPackageRoot();
  const candidates = [join(root, "CHANGELOG.md"), join(root, "docs/CHANGELOG.md")];
  for (const p of candidates) {
    try {
      if (existsSync(p)) return readFileSync(p, "utf-8");
    } catch {
    }
  }
  if (explicitRoot) return void 0;
  try {
    const fallback = join(process.cwd(), "docs/CHANGELOG.md");
    if (existsSync(fallback)) return readFileSync(fallback, "utf-8");
  } catch {
  }
  return BUNDLED_CHANGELOG_TEXT;
}
function parseChangelogEntries(text, maxEntries) {
  const lines = text.split(/\r?\n/);
  const entries = [];
  let current;
  let currentSection;
  const versionRe = /^##\s+\[([^\]]+)\]\s*-?\s*(.*)\s*$/;
  const sectionRe = /^###\s+(.+)\s*$/;
  const bulletRe = /^\s*-\s+(.*)\s*$/;
  for (const raw of lines) {
    const versionMatch = raw.match(versionRe);
    if (versionMatch) {
      if (current) entries.push(current);
      current = {
        version: versionMatch[1].trim(),
        date: versionMatch[2].trim() || void 0,
        sections: []
      };
      currentSection = void 0;
      if (maxEntries !== void 0 && entries.length >= maxEntries) ;
      continue;
    }
    if (!current) continue;
    const sectionMatch = raw.match(sectionRe);
    if (sectionMatch) {
      currentSection = {
        heading: stripMarkdownInline(sectionMatch[1].trim()),
        items: []
      };
      current.sections.push(currentSection);
      continue;
    }
    const bulletMatch = raw.match(bulletRe);
    if (bulletMatch && currentSection) {
      currentSection.items.push(stripMarkdownInline(bulletMatch[1].trim()));
      continue;
    }
    if (currentSection && currentSection.items.length > 0 && raw.length > 0 && /^\s{2,}\S/.test(raw) && !raw.startsWith("##") && !raw.startsWith("###")) {
      const last = currentSection.items.length - 1;
      currentSection.items[last] = `${currentSection.items[last]} ${stripMarkdownInline(raw.trim())}`;
    }
  }
  if (current) entries.push(current);
  if (maxEntries !== void 0) return entries.slice(0, maxEntries);
  return entries;
}
function entriesToPlainLines(entries) {
  const out = [];
  for (const entry of entries) {
    const header = entry.date ? `## [${entry.version}] - ${entry.date}` : `## [${entry.version}]`;
    out.push(header);
    out.push("");
    if (entry.sections.length === 0) {
      out.push("(no details)");
      out.push("");
      continue;
    }
    for (const sec of entry.sections) {
      out.push(`### ${sec.heading}`);
      if (sec.items.length === 0) {
        out.push("(no items)");
      } else {
        for (const item of sec.items) {
          out.push(`- ${item}`);
        }
      }
      out.push("");
    }
  }
  return out;
}
function renderChangelogEntries(entries, width, theme) {
  const plain = entriesToPlainLines(entries);
  const wrapped = [];
  for (const line of plain) {
    if (line.startsWith("## [")) {
      const styled = theme.fg("accent", theme.bold(line));
      wrapped.push(...wrapLine(styled, width));
    } else if (line.startsWith("### ")) {
      wrapped.push(...wrapLine(theme.fg("accent", line), width));
    } else if (line.startsWith("- ")) {
      const chunks = wrapLine(line, width);
      for (let i = 0; i < chunks.length; i++) {
        if (i === 0) wrapped.push(chunks[i]);
        else wrapped.push(`  ${chunks[i]}`);
      }
    } else if (line === "") {
      wrapped.push("");
    } else {
      wrapped.push(...wrapLine(line, width));
    }
  }
  return wrapped;
}
var PREFERRED_INNER_ROWS2 = 45;
function createChangelogViewer(args) {
  const { tui, theme, done, packageRoot, maxEntries } = args;
  const version = getPackageVersion(packageRoot);
  const title = version ? `Changelog \u2014 v${version}` : "Changelog";
  const raw = readChangelogText(packageRoot);
  let allLines;
  if (!raw) {
    allLines = ["Changelog not found.", "Expected CHANGELOG.md at package root."];
  } else {
    const entries = parseChangelogEntries(raw, maxEntries);
    if (entries.length === 0) {
      const stripped = raw.split(/\r?\n/).map((l) => stripMarkdownInline(l));
      allLines = stripped;
    } else {
      const entriesRef = entries;
      return createLazyChangelogViewer({
        tui,
        theme,
        done,
        title,
        entries: entriesRef
      });
    }
  }
  let scroll = 0;
  const PAGE = 5;
  const render = (width) => {
    const inner = responsiveInnerRows(tui.terminal.rows ?? 24, PREFERRED_INNER_ROWS2, 14);
    const cw = frameContentWidth(width);
    const wrapped = [];
    for (const line of allLines) {
      if (line === "") wrapped.push("");
      else wrapped.push(...wrapLine(line, cw));
    }
    const visible = Math.max(1, inner - 2);
    const maxScroll = Math.max(0, wrapped.length - visible);
    scroll = Math.min(scroll, maxScroll);
    const slice = wrapped.slice(scroll, scroll + visible);
    while (slice.length < visible) slice.push("");
    const body = [];
    if (scroll > 0) body.push(theme.fg("dim", `  \u2191 ${scroll} earlier`));
    body.push(...slice);
    if (scroll + visible < wrapped.length) {
      body.push(theme.fg("dim", `  \u2193 ${wrapped.length - scroll - visible} more`));
    }
    const hints = "\u2191\u2193 scroll \xB7 PgUp/PgDn \xB7 Esc close";
    const footer = theme.fg("dim", hints);
    const withFooter = [...body, "", footer];
    return frame(withFooter, width, theme, {
      title,
      fixedInnerRows: inner
    });
  };
  const handleInput = (data) => {
    const inner = responsiveInnerRows(tui.terminal.rows ?? 24, PREFERRED_INNER_ROWS2, 14);
    const cw = frameContentWidth(80);
    const wrapped = [];
    for (const line of allLines) {
      if (line === "") wrapped.push("");
      else wrapped.push(...wrapLine(line, cw));
    }
    const visible = Math.max(1, inner - 2);
    const maxScroll = Math.max(0, wrapped.length - visible);
    if (matchesKey(data, "up")) {
      scroll = Math.max(0, scroll - 1);
      tui.requestRender();
    } else if (matchesKey(data, "down")) {
      scroll = Math.min(maxScroll, scroll + 1);
      tui.requestRender();
    } else if (matchesKey(data, "pageUp")) {
      scroll = Math.max(0, scroll - PAGE);
      tui.requestRender();
    } else if (matchesKey(data, "pageDown")) {
      scroll = Math.min(maxScroll, scroll + PAGE);
      tui.requestRender();
    } else if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      done();
    }
  };
  return { render, handleInput, invalidate: () => {
  } };
}
function createLazyChangelogViewer(params) {
  const { tui, theme, done, title, entries } = params;
  let scroll = 0;
  const PAGE = 5;
  let lastWidth = 80;
  let cachedWrapped = [];
  function getWrapped(width) {
    if (width === lastWidth && cachedWrapped.length > 0) return cachedWrapped;
    lastWidth = width;
    const cw = frameContentWidth(width);
    cachedWrapped = renderChangelogEntries(entries, cw, theme);
    return cachedWrapped;
  }
  const render = (width) => {
    const inner = responsiveInnerRows(tui.terminal.rows ?? 24, PREFERRED_INNER_ROWS2, 14);
    const wrapped = getWrapped(width);
    const visible = Math.max(1, inner - 3);
    const maxScroll = Math.max(0, wrapped.length - visible);
    scroll = Math.min(scroll, maxScroll);
    const slice = wrapped.slice(scroll, scroll + visible);
    while (slice.length < visible) slice.push("");
    const body = [];
    if (scroll > 0) body.push(theme.fg("dim", `  \u2191 ${scroll} earlier`));
    body.push(...slice);
    if (scroll + visible < wrapped.length) {
      body.push(theme.fg("dim", `  \u2193 ${wrapped.length - scroll - visible} more`));
    }
    body.push("");
    body.push(theme.fg("dim", "  \u2191\u2193 scroll \xB7 PgUp/PgDn \xB7 Esc close"));
    return frame(body, width, theme, { title, fixedInnerRows: inner });
  };
  const handleInput = (data) => {
    const inner = responsiveInnerRows(tui.terminal.rows ?? 24, PREFERRED_INNER_ROWS2, 14);
    const wrapped = getWrapped(lastWidth);
    const visible = Math.max(1, inner - 3);
    const maxScroll = Math.max(0, wrapped.length - visible);
    if (matchesKey(data, "up")) {
      scroll = Math.max(0, scroll - 1);
      tui.requestRender();
    } else if (matchesKey(data, "down")) {
      scroll = Math.min(maxScroll, scroll + 1);
      tui.requestRender();
    } else if (matchesKey(data, "pageUp")) {
      scroll = Math.max(0, scroll - PAGE);
      tui.requestRender();
    } else if (matchesKey(data, "pageDown")) {
      scroll = Math.min(maxScroll, scroll + PAGE);
      tui.requestRender();
    } else if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      done();
    }
  };
  return { render, handleInput, invalidate: () => {
  } };
}
async function openChangelogView(ctx) {
  await ctx.ui.custom(
    (tui, theme, _kb, done) => createChangelogViewer({ tui, theme, done: () => done(void 0) }),
    {
      overlay: true,
      overlayOptions: { anchor: "center", width: "92%", maxHeight: "95%" }
    }
  );
}

// src/pi-base/blackhole-settings.ts
var CONFIG_FILENAME = "pi-blackhole-config.json";
var GLOBAL_CONFIG_DIR = join(getPiAgentDir(), "pi-blackhole");
var config = new ConfigManager({
  id: "pi-blackhole",
  label: "Memory",
  filename: CONFIG_FILENAME,
  configDir: GLOBAL_CONFIG_DIR,
  defaults: DEFAULTS,
  scopes: { global: true, project: true, session: true },
  sessionConfig: { entryType: "session-config-pi-blackhole" },
  fields: (cfg) => [
    // ── Compaction ──
    {
      key: "compaction",
      type: "enum",
      label: "Compaction mode",
      description: "auto=trigger on threshold, manual=only /memory, off=auto:Pi handles, /memory:structural pipeline",
      value: cfg.compaction,
      options: ["auto", "manual", "off"],
      optionLabels: {
        auto: "auto \u2014 trigger on threshold",
        manual: "manual \u2014 only /memory",
        off: "off \u2014 auto:Pi handles, /memory:structural pipeline"
      }
    },
    {
      key: "compactionEngine",
      type: "enum",
      label: "Compaction engine",
      description: "structural=structured summary+OM, pi-default=built-in Pi summarization",
      value: cfg.compactionEngine,
      options: ["blackhole", "pi-default"],
      optionLabels: {
        blackhole: "structural \u2014 structured summary + OM",
        "pi-default": "pi-default \u2014 built-in Pi summarization"
      }
    },
    {
      key: "compactionSummaryMode",
      type: "enum",
      label: "Summary history",
      description: "default=replace one complete summary, append=freeze automatic segments and rebase on /memory",
      value: cfg.compactionSummaryMode,
      options: ["default", "append"],
      optionLabels: {
        default: "default \u2014 one complete replacement summary",
        append: "append \u2014 immutable auto segments; /memory rebases"
      }
    },
    {
      key: "tailBehavior",
      type: "enum",
      label: "Visible tail",
      description: "minimal=keep last user message only (default), pi-default=keep Pi's preserved visible context",
      value: cfg.tailBehavior,
      options: ["minimal", "pi-default"],
      optionLabels: {
        minimal: "minimal \u2014 keep last user message only (default)",
        "pi-default": "pi-default \u2014 keep Pi's preserved visible context"
      }
    },
    {
      key: "midRunCompaction",
      type: "enum",
      label: "Mid-run compaction",
      description: "resume=compact transparently and continue the same run, pause=interrupt and stop, off=only check when run ends (default)",
      value: cfg.midRunCompaction,
      options: ["resume", "pause", "off"],
      optionLabels: {
        resume: "resume \u2014 transparent compact, same run (experimental)",
        pause: "pause \u2014 interrupt, compact, and stop",
        off: "off \u2014 only check when run ends (default)"
      }
    },
    {
      key: "compactAfterTokens",
      type: "number",
      label: "Auto-compact threshold",
      description: "Token count that triggers auto-compaction when reached",
      value: cfg.compactAfterTokens,
      min: 1e3,
      max: 5e5,
      step: 1e3
    },
    // ── Observational Memory ──
    {
      key: "memory",
      type: "boolean",
      label: "Observational memory",
      description: "Enable OM workers (observer, reflector, dropper) and content injection",
      value: cfg.memory,
      valueDescriptions: {
        on: "Active \u2014 OM workers + content injection enabled",
        off: "Suspended \u2014 OM disabled"
      }
    },
    {
      key: "observeAfterTokens",
      type: "number",
      label: "Observer threshold",
      description: "Tokens accumulated since last observer run before triggering next observe",
      value: cfg.observeAfterTokens,
      min: 1e3,
      max: 2e5,
      step: 1e3
    },
    {
      key: "reflectAfterTokens",
      type: "number",
      label: "Reflect + dropper threshold",
      description: "Tokens accumulated since last reflect before triggering reflector and dropper",
      value: cfg.reflectAfterTokens,
      min: 1e3,
      max: 2e5,
      step: 1e3
    },
    {
      key: "observationsPoolMaxTokens",
      type: "number",
      label: "Observation pool max",
      description: "Max tokens in observation pool before dropper prunes (fold pressure)",
      value: cfg.observationsPoolMaxTokens,
      min: 1e3,
      max: 2e5,
      step: 1e3
    },
    {
      key: "observationsPoolTargetTokens",
      type: "number",
      label: "Observation pool target",
      description: "Target tokens after dropper prunes (defaults to half of pool max)",
      value: cfg.observationsPoolTargetTokens,
      min: 500,
      max: 2e5,
      step: 500
    },
    {
      key: "reflectorInputMaxTokens",
      type: "number",
      label: "Reflector input max",
      description: "Max prompt tokens for reflector model input (rolling window cap)",
      value: cfg.reflectorInputMaxTokens,
      min: 1e3,
      max: 5e5,
      step: 1e3
    },
    {
      key: "dropperInputMaxTokens",
      type: "number",
      label: "Dropper input max",
      description: "Max prompt tokens for dropper model input (rolling window cap)",
      value: cfg.dropperInputMaxTokens,
      min: 1e3,
      max: 5e5,
      step: 1e3
    },
    {
      key: "observerChunkMaxTokens",
      type: "number",
      label: "Observer chunk max",
      description: "Max source entry tokens sent to observer per chunk",
      value: cfg.observerChunkMaxTokens,
      min: 1e3,
      max: 2e5,
      step: 1e3
    },
    {
      key: "observerPreambleMaxTokens",
      type: "number",
      label: "Observer preamble max",
      description: "Preamble budget in manual compaction mode (0=auto-compute 30% of chunk)",
      value: cfg.observerPreambleMaxTokens,
      min: 0,
      max: 1e5,
      step: 500
    },
    {
      key: "dropperPressureThreshold",
      type: "number",
      label: "Dropper pressure threshold",
      description: "Fraction of reflectorInputMaxTokens that triggers pressure-driven dropper (0-1, default 0.70)",
      value: cfg.dropperPressureThreshold,
      min: 0.01,
      max: 1,
      step: 0.01
    },
    {
      key: "dropperPoolFullnessThreshold",
      type: "number",
      label: "Dropper pool fullness threshold",
      description: "Min observation-pool fullness (fraction of pool max) before the dropper runs (0-1, default 0.10)",
      value: cfg.dropperPoolFullnessThreshold,
      min: 0.01,
      max: 1,
      step: 0.01
    },
    {
      key: "agentMaxTurns",
      type: "number",
      label: "Max turns per agent",
      description: "Shared turn cap for background memory agents",
      value: cfg.agentMaxTurns,
      min: 1,
      max: 100,
      step: 1
    },
    {
      key: "providerIdleTimeoutMs",
      type: "number",
      label: "Provider idle timeout (ms)",
      description: "Body-idle timeout for background provider streams; 0 = disabled, unset = inherit pi's default",
      value: cfg.providerIdleTimeoutMs ?? 0,
      min: 0,
      max: 36e5,
      step: 1e3
    },
    {
      key: "fullFoldAlways",
      type: "boolean",
      label: "Preserve OM on first compaction",
      description: "When true, early reflections/drops survive the first compaction in a fresh session",
      value: cfg.fullFoldAlways
    },
    // ── Debug ──
    {
      key: "debug",
      type: "boolean",
      label: "Debug snapshots",
      description: "Write detailed debug snapshots to /tmp/pi-blackhole-debug.json",
      value: cfg.debug
    },
    {
      key: "debugLog",
      type: "boolean",
      label: "Debug JSONL logging",
      description: "Write structured JSONL debug logs to agent directory",
      value: cfg.debugLog
    }
  ],
  /**
   * Validate raw loaded data, apply legacy migration, clamp numeric fields,
   * and apply all env-var overrides (both declarative env-map and legacy
   * passive/compaction env vars).
   */
  validate: (raw) => {
    const parsed = { ...raw };
    if (parsed.compaction === void 0 && parsed.compactionEngine === void 0) {
      if (parsed.passive === true) {
        parsed.compaction = "off";
        parsed.memory = false;
      } else if (parsed.noAutoCompact === true) {
        parsed.compaction = "manual";
      }
      if (parsed.overrideDefaultCompaction === true) {
        parsed.compactionEngine = "blackhole";
        if (parsed.tailBehavior === void 0) {
          parsed.tailBehavior = "minimal";
        }
      } else if (parsed.overrideDefaultCompaction === false) {
        parsed.compactionEngine = "pi-default";
      }
      delete parsed.passive;
      delete parsed.noAutoCompact;
      delete parsed.overrideDefaultCompaction;
    }
    const envPassive = process.env.PI_BLACKHOLE_PASSIVE ?? process.env.PI_VCC_OM_PASSIVE ?? process.env.PI_OBSERVATIONAL_MEMORY_PASSIVE;
    if (envPassive !== void 0) {
      const v = envPassive.trim().toLowerCase();
      if (["1", "true", "yes", "on"].includes(v)) {
        parsed.compaction = "off";
        parsed.memory = false;
      } else if (["0", "false", "no", "off"].includes(v)) {
        if (raw.passive === true) {
          delete parsed.compaction;
          delete parsed.memory;
        }
      }
    }
    const envCompaction = process.env.PI_BLACKHOLE_COMPACTION;
    if (envCompaction !== void 0) {
      const trimmed = envCompaction.trim().toLowerCase();
      if (!["auto", "manual", "off"].includes(trimmed)) {
        console.warn(
          `blackhole: invalid PI_BLACKHOLE_COMPACTION value "${envCompaction}"; ignoring`
        );
      }
    }
    const envCompactionEngine = process.env.PI_BLACKHOLE_COMPACTION_ENGINE;
    if (envCompactionEngine !== void 0) {
      const trimmed = envCompactionEngine.trim().toLowerCase();
      if (!["blackhole", "pi-default"].includes(trimmed)) {
        console.warn(
          `Invalid PI_BLACKHOLE_COMPACTION_ENGINE value "${envCompactionEngine}"; ignoring`
        );
      }
    }
    const envCompactionSummaryMode = process.env.PI_BLACKHOLE_COMPACTION_SUMMARY_MODE;
    if (envCompactionSummaryMode !== void 0) {
      const trimmed = envCompactionSummaryMode.trim().toLowerCase();
      if (!["default", "append"].includes(trimmed)) {
        console.warn(
          `blackhole: invalid PI_BLACKHOLE_COMPACTION_SUMMARY_MODE value "${envCompactionSummaryMode}"; ignoring`
        );
      }
    }
    const envMidRunCompaction = process.env.PI_BLACKHOLE_MID_RUN_COMPACTION;
    if (envMidRunCompaction !== void 0) {
      const trimmed = envMidRunCompaction.trim().toLowerCase();
      if (!["resume", "pause", "off"].includes(trimmed)) {
        console.warn(
          `Invalid PI_BLACKHOLE_MID_RUN_COMPACTION value "${envMidRunCompaction}"; ignoring`
        );
      }
    }
    const merged = { ...DEFAULTS, ...parsed };
    const REQUIRED_NUMERIC_KEYS = [
      "observeAfterTokens",
      "reflectAfterTokens",
      "compactAfterTokens",
      "observationsPoolMaxTokens",
      "observationsPoolTargetTokens",
      "reflectorInputMaxTokens",
      "dropperInputMaxTokens",
      "observerChunkMaxTokens",
      "observerPreambleMaxTokens",
      "agentMaxTurns"
    ];
    for (const k of REQUIRED_NUMERIC_KEYS) {
      const v = merged[k];
      const minVal = k === "observerPreambleMaxTokens" ? 0 : 1;
      if (typeof v !== "number" || !Number.isFinite(v) || v < minVal) {
        merged[k] = DEFAULTS[k];
      }
    }
    const dpt = merged.dropperPressureThreshold;
    if (typeof dpt !== "number" || !Number.isFinite(dpt) || dpt <= 0 || dpt > 1) {
      merged.dropperPressureThreshold = DEFAULTS.dropperPressureThreshold;
    }
    const dpf = merged.dropperPoolFullnessThreshold;
    if (typeof dpf !== "number" || !Number.isFinite(dpf) || dpf <= 0 || dpf > 1) {
      merged.dropperPoolFullnessThreshold = DEFAULTS.dropperPoolFullnessThreshold;
    }
    if (merged.observationsPoolTargetTokens === void 0 || merged.observationsPoolTargetTokens >= merged.observationsPoolMaxTokens) {
      merged.observationsPoolTargetTokens = Math.floor(merged.observationsPoolMaxTokens / 2);
    }
    return merged;
  },
  env: DECLARATIVE_ENV_OVERRIDES
});
async function openBlackholeSettings(ctx) {
  await config.openSettings(
    ctx,
    ctx.cwd,
    (_updated) => {
    },
    GLOBAL_CONFIG_DIR,
    void 0,
    [
      {
        id: "changelog",
        label: "Display Changelog",
        available: true
      }
    ],
    async (id) => {
      if (id === "changelog") await openChangelogView(ctx);
    }
  );
}

// src/commands/pi-vcc.ts
var registerPiVccCommand = (pi, runtime) => {
  const prefixMatch = (value, prefix) => {
    return value.toLowerCase().startsWith(prefix.toLowerCase());
  };
  pi.registerCommand("memory", {
    description: "Manual compact with structural summary. Subcommands: [settings] config overlay, [changelog] display changelog, [cleanup] remove orphaned files, [om-off]/[om-on] disable/enable observational memory.",
    getArgumentCompletions: (prefix) => {
      const subcommands = [
        {
          value: "settings",
          label: "Open configuration overlay [settings]"
        },
        {
          value: "changelog",
          label: "Display changelog [changelog]"
        },
        {
          value: "cleanup",
          label: "Remove orphaned pending files [cleanup]"
        },
        { value: "om-off", label: "Disable observational memory [om-off]" },
        { value: "om-on", label: "Enable observational memory [om-on]" }
      ];
      if (!prefix) return subcommands;
      return subcommands.filter(
        (s) => prefixMatch(s.value, prefix) || s.value === "settings" && prefixMatch("configure", prefix)
      );
    },
    handler: async (args, ctx) => {
      const sessionId = ctx.sessionManager.getSessionId();
      const trimmed = (typeof args === "string" ? args : "").trim();
      if (trimmed === "configure" || trimmed === "settings") {
        await openBlackholeSettings(ctx);
        return;
      }
      if (trimmed === "changelog") {
        await openChangelogView(ctx);
        return;
      }
      if (trimmed === "cleanup") {
        await handleCleanup(ctx);
        return;
      }
      if (trimmed === "om-off") {
        try {
          config.save(
            { ...config.load(ctx.cwd, GLOBAL_CONFIG_DIR), memory: false },
            "global",
            ctx.cwd,
            GLOBAL_CONFIG_DIR
          );
          runtime.config = config.loadWithWarnings(ctx.cwd, GLOBAL_CONFIG_DIR).config;
          ctx.ui.notify(
            "Observational memory disabled. Use /memory om-on to re-enable.",
            "info"
          );
        } catch {
          ctx.ui.notify(
            "Failed to save config \u2014 the config file may be read-only (e.g., managed by Nix). Runtime state updated for this session only.",
            "warning"
          );
        }
        return;
      }
      if (trimmed === "om-on") {
        try {
          config.save(
            { ...config.load(ctx.cwd, GLOBAL_CONFIG_DIR), memory: true },
            "global",
            ctx.cwd,
            GLOBAL_CONFIG_DIR
          );
          runtime.config = config.loadWithWarnings(ctx.cwd, GLOBAL_CONFIG_DIR).config;
          ctx.ui.notify("Observational memory enabled.", "info");
        } catch {
          ctx.ui.notify(
            "Failed to save config \u2014 the config file may be read-only (e.g., managed by Nix). Runtime state updated for this session only.",
            "warning"
          );
        }
        return;
      }
      const SUBCOMMAND_NAMES = ["configure", "settings", "changelog", "cleanup", "om-off", "om-on"];
      const nearMiss = SUBCOMMAND_NAMES.find(
        (name) => trimmed.toLowerCase().startsWith(name.toLowerCase()) && trimmed.length > name.length
      );
      if (nearMiss) {
        ctx.ui.notify(
          `/memory ${nearMiss} accepts no arguments. Did you mean "/memory ${nearMiss}"?`,
          "warning"
        );
        return;
      }
      const followUpPrompt = trimmed ? trimmed : null;
      if (runtime.config.compaction === "manual" && hasPendingData(sessionId)) {
        const pending = readPendingState(sessionId);
        const obsBatches = pending.observationBatches?.length ? pending.observationBatches : pending.observation ? [pending.observation] : [];
        for (const batch of obsBatches) {
          pi.appendEntry(OM_OBSERVATIONS_RECORDED, batch.data);
        }
        const reflBatches = pending.reflectionBatches?.length ? pending.reflectionBatches : pending.reflection ? [pending.reflection] : [];
        for (const batch of reflBatches) {
          pi.appendEntry(OM_REFLECTIONS_RECORDED, batch.data);
        }
        const dropBatches = pending.droppedBatches?.length ? pending.droppedBatches : pending.dropped ? [pending.dropped] : [];
        for (const batch of dropBatches) {
          pi.appendEntry(OM_OBSERVATIONS_DROPPED, batch.data);
        }
        clearPendingState(sessionId);
        ctx.ui.notify("Observational memory: pending entries flushed", "info");
      }
      ctx.compact({
        customInstructions: PI_VCC_COMPACT_INSTRUCTION,
        onComplete: () => {
          const stats = runtime.compactionStats;
          if (stats) {
            ctx.ui.notify(formatCompactionStats(stats), "info");
          } else {
            ctx.ui.notify("Compacted", "info");
          }
          notifyMigrationReminder(sessionId, (msg, level) => ctx.ui.notify(msg, level));
          if (followUpPrompt) {
            try {
              void Promise.resolve(pi.sendUserMessage(followUpPrompt)).catch(() => {
              });
            } catch {
            }
          }
        },
        onError: (err) => {
          if (err.message === "Compaction cancelled" || err.message === "Already compacted") {
            ctx.ui.notify("Nothing to compact", "warning");
          } else {
            ctx.ui.notify(`Compaction failed: ${err.message}`, "error");
          }
        }
      });
    }
  });
};
function getClipboardCommands(platform = process.platform) {
  switch (platform) {
    case "darwin":
      return [{ command: "pbcopy", args: [] }];
    case "win32":
      return [{ command: "clip", args: [] }];
    default:
      return [
        { command: "wl-copy", args: [] },
        { command: "xclip", args: ["-selection", "clipboard"] },
        { command: "xsel", args: ["--clipboard", "--input"] },
        { command: "termux-clipboard-set", args: [] }
      ];
  }
}
async function copyTextToClipboard(text, runner = runClipboardCommand, commands = getClipboardCommands()) {
  for (const command of commands) {
    if (await runner(command, text)) return true;
  }
  return false;
}
function runClipboardCommand(command, text) {
  return new Promise((resolve3) => {
    let settled = false;
    let timeout;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve3(ok);
    };
    const child = spawn(command.command, command.args, {
      stdio: ["pipe", "ignore", "ignore"]
    });
    timeout = setTimeout(() => {
      child.kill();
      finish(false);
    }, 2e3);
    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0));
    child.stdin.on("error", () => void 0);
    child.stdin.end(text, "utf8");
  });
}

// src/commands/memory.ts
function firstArg(args) {
  if (Array.isArray(args)) return typeof args[0] === "string" ? args[0] : void 0;
  if (typeof args === "string") return args.trim().split(/\s+/)[0];
  if (args && typeof args === "object" && "mode" in args) {
    const mode = args.mode;
    return typeof mode === "string" ? mode : void 0;
  }
  return void 0;
}
function pct(current, total) {
  return total > 0 ? Math.round(current / total * 100) : 0;
}
function tokenSum(items) {
  return items.reduce((sum, item) => sum + item.tokenCount, 0);
}
function addedSuffix(count) {
  return count > 0 ? `+${count.toLocaleString()}` : void 0;
}
function removedSuffix(count) {
  return count > 0 ? `-${count.toLocaleString()}` : void 0;
}
function appendSuffixes(line, suffixes) {
  const rendered = suffixes.filter((s) => s !== void 0);
  return rendered.length > 0 ? `${line} ${rendered.join(" ")}` : line;
}
function renderList(items, render, empty) {
  return items.length > 0 ? items.map(render).join("\n") : empty;
}
function renderContentOnlyProjection(projection, emptyScope) {
  return [
    "\u2500\u2500 Reflections \u2500\u2500",
    renderList(projection.reflections, reflectionToSummaryLine, `No ${emptyScope} reflections.`),
    "",
    "\u2500\u2500 Observations \u2500\u2500",
    renderList(projection.observations, observationToSummaryLine, `No ${emptyScope} observations.`)
  ].join("\n");
}
function registerMemoryCommand(pi, runtime) {
  pi.registerCommand("observations", {
    description: "Show memory pipeline status & token counters. /observations [view] visible observations & reflections, [full] complete recorded memory (copies to clipboard).",
    handler: async (args, ctx) => {
      runtime.ensureConfig(ctx.cwd, (msg) => ctx.ui?.notify?.(msg, "warning"));
      const entries = ctx.sessionManager.getBranch();
      const sessionId = ctx.sessionManager.getSessionId();
      const mode = firstArg(args);
      if (mode === "full") {
        const projection = fullProjection(entries);
        const output = renderContentOnlyProjection(projection, "recorded");
        const copied = await copyTextToClipboard(output).catch(() => false);
        ctx.ui.notify(
          copied ? `${output}

Copied to clipboard.` : `${output}

Failed to copy to clipboard.`,
          "info"
        );
        return;
      }
      if (mode === "view") {
        const projection = visibleProjection(entries);
        const output = renderContentOnlyProjection(projection, "visible");
        const copied = await copyTextToClipboard(output).catch(() => false);
        ctx.ui.notify(
          copied ? `${output}

Copied to clipboard.` : `${output}

Failed to copy to clipboard.`,
          "info"
        );
        return;
      }
      if (mode && mode !== "status") {
        ctx.ui.notify("Usage: /observations [status|view|full]", "info");
        return;
      }
      const folded = foldLedger(entries);
      const visible = visibleProjection(entries);
      const full = fullProjection(entries);
      const drift = diffProjection(visible, full);
      const visibleObservationTokens = tokenSum(visible.observations);
      const visibleReflectionTokens = tokenSum(visible.reflections);
      const observationLine = appendSuffixes(
        `Observations: ${folded.observations.length} recorded / ${folded.droppedObservationIds.size} dropped / ${visible.observations.length} visible`,
        [
          addedSuffix(drift.observationsOnlyInFull.length),
          removedSuffix(drift.droppedOnlyInFull.length)
        ]
      );
      const reflectionLine = appendSuffixes(
        `Reflections:  ${folded.reflections.length} recorded / ${visible.reflections.length} visible`,
        [addedSuffix(drift.reflectionsOnlyInFull.length)]
      );
      let obsProgress = rawTokensSinceObservationCoverage(entries);
      let reflectionProgress = rawTokensSinceReflectionCoverage(entries);
      let dropProgress = rawTokensSinceDropCoverage(entries);
      const compactionProgress = rawTokensSinceLastCompaction(entries);
      if (isManualMode(runtime.config)) {
        const pending = readPendingState(sessionId);
        if (pending.observation?.coversUpToId) {
          const idx = entryIndexForId(entries, pending.observation.coversUpToId);
          if (idx >= 0) obsProgress = rawTokensAfterIndex(entries, idx);
        }
        if (pending.reflection?.coversUpToId) {
          const idx = entryIndexForId(entries, pending.reflection.coversUpToId);
          if (idx >= 0) reflectionProgress = rawTokensAfterIndex(entries, idx);
        }
        if (pending.dropped?.coversUpToId) {
          const idx = entryIndexForId(entries, pending.dropped.coversUpToId);
          if (idx >= 0) dropProgress = rawTokensAfterIndex(entries, idx);
        }
      }
      const passiveLines = runtime.config.passive === true ? ["\u2500\u2500 Mode \u2500\u2500", "Passive: automatic memory workers and auto-compaction disabled", ""] : [];
      const lines = [
        ...passiveLines,
        "\u2500\u2500 Memory \u2500\u2500",
        observationLine,
        reflectionLine,
        "",
        "\u2500\u2500 Pipeline \u2500\u2500",
        "Transcript accumulated since last run. Triggers when exceeding threshold.",
        `Observer:       ~${obsProgress.toLocaleString()} tokens (triggers at ${runtime.config.observeAfterTokens.toLocaleString()})`,
        `Reflector:      ~${reflectionProgress.toLocaleString()} tokens (triggers at ${runtime.config.reflectAfterTokens.toLocaleString()})`,
        `Dropper:        pool ${pct(visibleObservationTokens, runtime.config.observationsPoolMaxTokens)}% \u2014 prunes at \u2265${Math.round(runtime.config.dropperPoolFullnessThreshold * 100)}% pool (${dropProgress.toLocaleString()}/${runtime.config.reflectAfterTokens.toLocaleString()} new tokens)`,
        `Compaction:     ~${compactionProgress.toLocaleString()} tokens` + (isManualMode(runtime.config) ? " [manual]" : ` (triggers at ${runtime.config.compactAfterTokens.toLocaleString()})`),
        `Obs pool:       ~${visibleObservationTokens.toLocaleString()} / ${runtime.config.observationsPoolMaxTokens.toLocaleString()} tokens (${pct(visibleObservationTokens, runtime.config.observationsPoolMaxTokens)}%)`,
        `Reflect pool:   ~${visibleReflectionTokens.toLocaleString()} tokens`
      ];
      if (isManualMode(runtime.config)) {
        const pending = readPendingState(sessionId);
        const hasObs = !!pending.observation;
        const hasRef = !!pending.reflection;
        const hasDrop = !!pending.dropped;
        if (hasObs || hasRef || hasDrop) {
          lines.push("", "\u2500\u2500 Pending (manual mode) \u2500\u2500");
          if (hasObs) lines.push("Observation:  waiting in pending.json");
          if (hasRef) lines.push("Reflection:   waiting in pending.json");
          if (hasDrop) lines.push("Dropper:      waiting in pending.json");
          const preambleCap = runtime.config.observerPreambleMaxTokens > 0 ? runtime.config.observerPreambleMaxTokens : Math.round(runtime.config.observerChunkMaxTokens * 0.3);
          const pctNote = runtime.config.observerPreambleMaxTokens > 0 ? "" : ` (30% of ${runtime.config.observerChunkMaxTokens.toLocaleString()} chunk)`;
          lines.push(
            `Preamble cap: ${preambleCap.toLocaleString()} tokens for observations${pctNote}`
          );
          lines.push("Run /memory to flush and compact.");
        }
      }
      if (runtime.consolidationInFlight || runtime.compactInFlight || runtime.compactHookInFlight) {
        lines.push("", "\u2500\u2500 In flight \u2500\u2500");
        if (runtime.consolidationInFlight) {
          const phase = runtime.consolidationPhase ? ` (${runtime.consolidationPhase})` : "";
          lines.push(`Consolidation: running${phase}`);
        }
        if (runtime.compactInFlight) lines.push("Auto-compaction: running");
        if (runtime.compactHookInFlight) lines.push("Compaction hook: running");
      }
      if (runtime.lastObserverError || runtime.lastReflectorError || runtime.lastDropperError) {
        lines.push("", "\u2500\u2500 Last error \u2500\u2500");
        if (runtime.lastObserverError) lines.push(`Observer: ${runtime.lastObserverError}`);
        if (runtime.lastReflectorError) lines.push(`Reflector: ${runtime.lastReflectorError}`);
        if (runtime.lastDropperError) lines.push(`Dropper: ${runtime.lastDropperError}`);
      }
      ctx.ui.notify(lines.join("\n"), "info");
    }
  });
}

// src/core/render-entries.ts
var toolCalls = (content) => {
  if (!content || typeof content === "string") return "";
  return content.filter((c) => c.type === "toolCall").map((c) => `${c.name}(${summarizeToolArgs(c.arguments)})`).join(", ");
};
var extractFilesFromContent = (content) => {
  if (!content || typeof content === "string") return [];
  return content.filter((c) => c.type === "toolCall").map((c) => extractPath(c.arguments)).filter((p) => p !== null);
};
var renderMessage = (msg, index, id, full = false) => {
  if (msg.role === "user") {
    return {
      index,
      id,
      role: "user",
      summary: full ? textOf(msg.content) : clip(textOf(msg.content), 300)
    };
  }
  if (msg.role === "toolResult") {
    const prefix = msg.isError ? "ERROR " : "";
    const text2 = full ? textOf(msg.content) : clip(textOf(msg.content), 200);
    return {
      index,
      id,
      role: "tool_result",
      summary: `${prefix}[${msg.toolName}] ${text2}`
    };
  }
  if (msg.role === "bashExecution") {
    const bashMsg = msg;
    const cmd = bashMsg.command ?? "";
    const out = bashMsg.output ?? "";
    const text2 = full ? `$ ${cmd}
${out}` : clip(`$ ${cmd}
${out}`, 300);
    return { index, id, role: "bash", summary: text2 };
  }
  const text = full ? textOf(msg.content) : clip(textOf(msg.content), 300);
  const tools = toolCalls(msg.content);
  const files = extractFilesFromContent(msg.content);
  const summary = tools ? `${tools}
${text}` : text;
  return {
    index,
    id,
    role: "assistant",
    summary,
    ...files.length > 0 && { files }
  };
};

// src/core/load-messages.ts
var MAX_CACHE_SIZE = 3;
var CACHE_TTL_MS = 2e3;
var cache = /* @__PURE__ */ new Map();
function cacheKey(sessionFile, full, allowedEntryIds) {
  let hash = `${sessionFile}::${full}`;
  if (allowedEntryIds && allowedEntryIds.size > 0) {
    hash += `::${JSON.stringify([...allowedEntryIds].sort())}`;
  }
  return hash;
}
function getCached(sessionFile, full, allowedEntryIds) {
  const key = cacheKey(sessionFile, full, allowedEntryIds);
  const entry = cache.get(key);
  if (!entry) return void 0;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    cache.delete(key);
    return void 0;
  }
  try {
    const mtimeMs = statSync(sessionFile).mtimeMs;
    if (mtimeMs !== entry.mtimeMs) {
      cache.delete(key);
      return void 0;
    }
  } catch {
    cache.delete(key);
    return void 0;
  }
  return entry.result;
}
function setCache(sessionFile, full, allowedEntryIds, result) {
  if (cache.size >= MAX_CACHE_SIZE) {
    const oldest = cache.entries().next();
    if (!oldest.done) cache.delete(oldest.value[0]);
  }
  try {
    const mtimeMs = statSync(sessionFile).mtimeMs;
    const key = cacheKey(sessionFile, full, allowedEntryIds);
    cache.set(key, { result, mtimeMs, timestamp: Date.now() });
  } catch {
  }
}
var loadAllMessages = (sessionFile, full, allowedEntryIds) => {
  const cached = getCached(sessionFile, full, allowedEntryIds);
  if (cached) return cached;
  const content = readFileSync(sessionFile, "utf-8");
  const entries = [];
  let parseErrors = 0;
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      parseErrors++;
    }
  }
  if (parseErrors > 0) {
    console.warn(`memory: ${parseErrors} malformed JSONL line(s) in ${sessionFile}`);
  }
  const rendered = [];
  const rawMessages = [];
  const entryIds = [];
  let messageIndex = 0;
  for (const e of entries) {
    const isMessage = e.type === "message" && e.message;
    if (!isMessage) continue;
    const allowed = !allowedEntryIds || allowedEntryIds.has(e.id);
    if (allowed) {
      const entryId = e.id != null ? String(e.id) : "";
      rendered.push(renderMessage(e.message, messageIndex, entryId, full));
      rawMessages.push(e.message);
      entryIds.push(entryId);
    }
    messageIndex++;
  }
  const result = { rendered, rawMessages, entryIds };
  setCache(sessionFile, full, allowedEntryIds, result);
  return result;
};

// src/core/search-entries.ts
var escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
var safeRegex = (pattern) => {
  try {
    return new RegExp(pattern, "i");
  } catch {
    return new RegExp(escapeRegex(pattern), "i");
  }
};
var looksLikeRegex = (query) => /[|*+?{}()[\]\\^$.]/.test(query);
var snippetRegex = (terms) => {
  const alts = terms.map((t) => {
    try {
      new RegExp(t, "i");
      return t;
    } catch {
      return escapeRegex(t);
    }
  });
  return new RegExp(alts.join("|"), "i");
};
var STOPWORDS = /* @__PURE__ */ new Set([
  // English
  "the",
  "a",
  "an",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "can",
  "shall",
  "of",
  "in",
  "to",
  "for",
  "with",
  "on",
  "at",
  "from",
  "by",
  "as",
  "into",
  "through",
  "during",
  "before",
  "after",
  "above",
  "below",
  "between",
  "out",
  "off",
  "over",
  "under",
  "again",
  "further",
  "then",
  "once",
  "here",
  "there",
  "when",
  "where",
  "why",
  "how",
  "all",
  "both",
  "each",
  "few",
  "more",
  "most",
  "other",
  "some",
  "such",
  "no",
  "nor",
  "not",
  "only",
  "own",
  "same",
  "so",
  "than",
  "too",
  "very",
  "just",
  "about",
  "it",
  "its",
  "that",
  "this",
  "what",
  "which",
  "who",
  "whom",
  "these",
  "those"
]);
var filterStopwords = (terms) => {
  const meaningful = terms.filter((t) => !STOPWORDS.has(t.toLowerCase()) && t.length > 1);
  return meaningful.length > 0 ? meaningful : terms;
};
var countMatches = (hay, terms) => {
  let count = 0;
  for (const t of terms) {
    if (safeRegex(t).test(hay)) count++;
  }
  return count;
};
var BM25_K = 1.2;
var BM25_B = 0.75;
var BM25_DELTA = 0.5;
var termFreq = (text, pattern) => {
  const matches = text.match(new RegExp(pattern.source, "gi"));
  return matches ? matches.length : 0;
};
var buildBM25Context = (docs, terms) => {
  const n = docs.length;
  const df = /* @__PURE__ */ new Map();
  let totalLen = 0;
  for (const doc of docs) {
    totalLen += doc.split(/\s+/).length;
    for (const t of terms) {
      if (safeRegex(t).test(doc)) {
        df.set(t, (df.get(t) ?? 0) + 1);
      }
    }
  }
  return { n, avgDl: totalLen / Math.max(n, 1), df };
};
var bm25Score = (doc, terms, ctx) => {
  const dl = doc.split(/\s+/).length;
  let score = 0;
  for (const t of terms) {
    const tf = termFreq(doc, safeRegex(t));
    if (tf === 0) continue;
    const docFreq = ctx.df.get(t) ?? 0;
    const idf = Math.log((ctx.n - docFreq + 0.5) / (docFreq + 0.5) + 1);
    const tfNorm = tf * (BM25_K + 1) / (tf + BM25_K * (1 - BM25_B + BM25_B * dl / Math.max(ctx.avgDl, 1)));
    score += idf * (tfNorm + BM25_DELTA);
  }
  return score;
};
var lineSnippet = (text, regex, contextLines = 2) => {
  const lines = text.split("\n");
  let matchIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (regex.test(lines[i])) {
      matchIdx = i;
      break;
    }
  }
  if (matchIdx === -1) return void 0;
  const start = Math.max(0, matchIdx - contextLines);
  const end = Math.min(lines.length, matchIdx + contextLines + 1);
  const slice = lines.slice(start, end);
  const parts = [];
  if (start > 0) parts.push(`...(${start} lines above)`);
  parts.push(...slice);
  if (end < lines.length) parts.push(`...(${lines.length - end} lines below)`);
  return parts.join("\n");
};
var fullText = (msg, mode) => {
  if (msg.role === "bashExecution") {
    if (mode === "file") return "";
    const bashMsg = msg;
    return `${bashMsg.command ?? ""} ${bashMsg.output ?? ""}`;
  }
  if (mode === "file") {
    return toolCallArgsText(msg.content);
  }
  const text = textOf(msg.content);
  const toolArgs = toolCallArgsText(msg.content);
  return toolArgs ? `${text}
${toolArgs}` : text;
};
function extractToolCallText(args) {
  let text = "";
  if (typeof args.content === "string") text += args.content + "\n";
  if (Array.isArray(args.edits)) {
    for (const edit of args.edits) {
      if (edit && typeof edit === "object") {
        if (typeof edit.oldText === "string") text += edit.oldText + "\n";
        if (typeof edit.newText === "string") text += edit.newText + "\n";
      }
    }
  }
  if (typeof args.oldText === "string" && !Array.isArray(args.edits)) text += args.oldText + "\n";
  if (typeof args.newText === "string" && !Array.isArray(args.edits)) text += args.newText + "\n";
  return text;
}
function getFileIndicators(msg) {
  if (!msg?.content || typeof msg.content === "string") return [];
  const fileMatches = [];
  for (const part of msg.content) {
    if (!part || typeof part !== "object" || part.type !== "toolCall") continue;
    const args = part.arguments;
    if (!isContentBearing(args)) continue;
    const path = ["path", "filePath", "file_path", "file"].map((k) => args[k]).find((v) => typeof v === "string");
    const totalText = extractToolCallText(args);
    const nonEmpty = totalText.split("\n").filter((l) => l.trim().length > 0);
    fileMatches.push({
      toolName: part.name || "",
      path,
      lineCount: nonEmpty.length
    });
  }
  return fileMatches;
}
function computeFileMatches(msg, query) {
  if (!msg?.content || typeof msg.content === "string") return [];
  const rawQuery = query.trim();
  const hasQuery = rawQuery.length > 0;
  if (!hasQuery) return getFileIndicators(msg);
  const regex = looksLikeRegex(rawQuery) ? safeRegex(rawQuery) : snippetRegex(rawQuery.split(/\s+/));
  const fileMatches = [];
  for (const part of msg.content) {
    if (!part || typeof part !== "object" || part.type !== "toolCall") continue;
    const args = part.arguments;
    if (!isContentBearing(args)) continue;
    const path = ["path", "filePath", "file_path", "file"].map((k) => args[k]).find((v) => typeof v === "string");
    const searchText = extractToolCallText(args);
    if (!searchText) continue;
    const lines = searchText.split("\n");
    const matchingLines = lines.filter((line) => regex.test(line));
    if (matchingLines.length > 0) {
      fileMatches.push({
        toolName: part.name || "",
        path,
        lineCount: matchingLines.length,
        snippet: matchingLines[0]
      });
    }
  }
  return fileMatches;
}
function getTouchedFiles(messages, rendered) {
  const map = /* @__PURE__ */ new Map();
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const indicators = getFileIndicators(msg);
    for (const fm of indicators) {
      const index = rendered[i]?.index ?? i;
      if (!map.has(fm.path)) {
        map.set(fm.path, { path: fm.path, entries: [] });
      }
      map.get(fm.path).entries.push({ index, toolName: fm.toolName });
    }
  }
  return Array.from(map.values());
}
var searchEntries = (entries, messages, query, _page, mode) => {
  if (!query?.trim()) return entries;
  const rawQuery = query.trim();
  if (looksLikeRegex(rawQuery)) {
    const regex = safeRegex(rawQuery);
    const hits = [];
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const msg = messages[i];
      const text = msg ? fullText(msg, mode) : e.summary;
      const filePart = e.files?.join(" ") ?? "";
      const hay = `${e.role} ${text} ${filePart}`;
      if (regex.test(hay)) {
        const snip = lineSnippet(text, regex);
        const fileMatches = computeFileMatches(msg, rawQuery);
        const extra = fileMatches.length > 0 ? { fileMatches } : {};
        hits.push({ ...e, snippet: snip, matchCount: 1, ...extra });
      }
    }
    return hits;
  }
  const rawTerms = rawQuery.split(/\s+/);
  const terms = filterStopwords(rawTerms);
  const snipRe = snippetRegex(terms);
  const docs = [];
  const fullTextCache = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const msg = messages[i];
    const text = msg ? fullText(msg, mode) : e.summary;
    fullTextCache.push(text);
    const filePart = e.files?.join(" ") ?? "";
    docs.push(`${e.role} ${text} ${filePart}`);
  }
  const ctx = buildBM25Context(docs, terms);
  const scored = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const hay = docs[i];
    const mc = countMatches(hay, terms);
    if (mc === 0) continue;
    const score = bm25Score(hay, terms, ctx);
    const text = fullTextCache[i];
    const snip = lineSnippet(text, snipRe);
    const fileMatches = computeFileMatches(messages[i], rawQuery);
    const extra = fileMatches.length > 0 ? { fileMatches } : {};
    scored.push({
      hit: { ...e, snippet: snip, matchCount: mc, ...extra },
      score
    });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.hit);
};

// src/core/format-recall.ts
var CWD = process.cwd();
function shortPath(fullPath) {
  const normalized = fullPath.replace(/\\/g, "/");
  const cwdNormalized = CWD.replace(/\\/g, "/");
  if (normalized.startsWith(cwdNormalized + "/")) {
    return "." + normalized.slice(cwdNormalized.length);
  }
  const parts = normalized.split("/");
  if (parts.length > 3) {
    return ".../" + parts.slice(-3).join("/");
  }
  return normalized;
}
function formatFileMatch(fm, index, isQuery) {
  const label = isQuery ? fm.lineCount === 1 ? "match" : "matches" : fm.lineCount === 1 ? "line" : "lines";
  const displayPath = shortPath(fm.path);
  let line = `  [${fm.toolName}] ${displayPath} \u2014 ${fm.lineCount} ${label}    use #${index}:${fm.path}`;
  if (fm.snippet) {
    line += `
    | ${fm.snippet}`;
  }
  return line;
}
var TOUCHED_PAGE_SIZE = 5;
function formatTouchedOutput(touched, page, pageSize) {
  if (touched.length === 0) {
    return "No file operations found in session history.";
  }
  const ps = TOUCHED_PAGE_SIZE;
  const totalPages = Math.ceil(touched.length / ps);
  const currentPage = Math.max(1, page ?? 1);
  const start = (currentPage - 1) * ps;
  const pageFiles = touched.slice(start, start + ps);
  const header = totalPages > 1 ? `Page ${currentPage}/${totalPages} (${touched.length} total files)` : `${touched.length} files touched`;
  const lines = pageFiles.map((tf) => {
    const displayPath = shortPath(tf.path);
    const indices = tf.entries.map((e) => `#${e.index} (${e.toolName})`).join(", ");
    return `  ${displayPath}    ${indices}`;
  });
  let result = `${header}:

${lines.join("\n")}`;
  if (currentPage < totalPages) {
    result += `

--- Use page:${currentPage + 1} for more results ---`;
  }
  return result;
}
var formatRecallOutput = (entries, query, headerOverride) => {
  if (entries.length === 0) {
    return query ? `No matches for "${query}" in session history.` : "No entries in session history.";
  }
  const header = headerOverride ? `${headerOverride} for "${query}":` : query ? `Found ${entries.length} matches for "${query}":` : `Session history (${entries.length} entries):`;
  const lines = entries.map((e) => {
    const body = query && e.snippet ? e.snippet : e.summary;
    let line = `#${e.index} [${e.role}]`;
    if (e.fileMatches?.length) {
      line += `
  ${body}`;
      const isQuery = Boolean(query);
      const topFileMatches = e.fileMatches.slice(0, 3);
      for (const fm of topFileMatches) {
        line += `
${formatFileMatch(fm, e.index, isQuery)}`;
      }
      if (e.fileMatches.length > 3) {
        line += `
  ...(${e.fileMatches.length - 3} more file matches)`;
      }
    } else if (e.files?.length) {
      const fileSuffix = ` files:[${e.files.join(", ")}]`;
      line += `${fileSuffix} ${body}`;
    } else {
      line += ` ${body}`;
    }
    return line;
  });
  return `${header}

${lines.join("\n\n")}`;
};

// src/core/lineage.ts
var getActiveLineageEntryIds = (sessionManager) => {
  try {
    const branch = sessionManager.getBranch() ?? [];
    if (branch.length > 0) {
      return new Set(branch.map((e) => e.id).filter((id) => Boolean(id)));
    }
  } catch {
  }
  try {
    const all = sessionManager.getEntries?.() ?? [];
    return new Set(all.map((e) => e.id).filter((id) => Boolean(id)));
  } catch {
    return /* @__PURE__ */ new Set();
  }
};

// src/core/recall-scope.ts
var SCOPE_RE = /\bscope:(lineage|all)\b/i;
var MODE_RE = /\bmode:(hybrid|file|touched)\b/i;
var VALID_MODES = /* @__PURE__ */ new Set(["hybrid", "file", "touched"]);
var normalizeRecallScope = (scope) => typeof scope === "string" && scope.toLowerCase() === "all" ? "all" : "lineage";
var normalizeRecallMode = (mode) => typeof mode === "string" && VALID_MODES.has(mode.toLowerCase()) ? mode.toLowerCase() : "hybrid";
var parseRecallScope = (text) => {
  const scopeMatch = text.match(SCOPE_RE);
  const modeMatch = text.match(MODE_RE);
  return {
    scope: normalizeRecallScope(scopeMatch?.[1]),
    mode: normalizeRecallMode(modeMatch?.[1]),
    text: text.replace(SCOPE_RE, "").replace(MODE_RE, "").replace(/\s+/g, " ").trim()
  };
};

// src/om/reverse-recall.ts
function findObservationsForEntryIds(entries, targetEntryIds) {
  if (targetEntryIds.length === 0) return [];
  const { observations, droppedIds } = indexLedger(entries);
  const targetSet = new Set(targetEntryIds);
  const result = [];
  for (const indexed of observations) {
    const matched = indexed.observation.sourceEntryIds.filter((id) => targetSet.has(id));
    if (matched.length > 0) {
      result.push({
        memoryId: indexed.observation.id,
        content: indexed.observation.content,
        timestamp: indexed.observation.timestamp,
        relevance: indexed.observation.relevance,
        status: droppedIds.has(indexed.observation.id) ? "dropped" : "active",
        matchedEntryIds: matched
      });
    }
  }
  return result;
}
function findReflectionsForEntryIds(entries, targetEntryIds) {
  if (targetEntryIds.length === 0) return [];
  const { reflections, observations } = indexLedger(entries);
  const targetSet = new Set(targetEntryIds);
  const matchingObsIds = /* @__PURE__ */ new Set();
  for (const indexed of observations) {
    if (indexed.observation.sourceEntryIds.some((id) => targetSet.has(id))) {
      matchingObsIds.add(indexed.observation.id);
    }
  }
  if (matchingObsIds.size === 0) return [];
  return reflections.filter((r) => r.reflection.supportingObservationIds.some((id) => matchingObsIds.has(id))).map((r) => ({
    memoryId: r.reflection.id,
    content: r.reflection.content
  }));
}
function formatRelatedObservations(observations, reflections) {
  const parts = [];
  if (observations.length > 0) {
    parts.push("Related observations:");
    for (const obs of observations) {
      const dropped = obs.status === "dropped" ? " [dropped]" : "";
      const entryRefs = obs.matchedEntryIds.length > 0 ? ` (${obs.matchedEntryIds.join(", ")})` : "";
      parts.push(
        `  [${obs.memoryId}]${dropped} ${obs.timestamp} [${obs.relevance}] ${obs.content}${entryRefs}`
      );
    }
  }
  if (reflections.length > 0) {
    if (parts.length > 0) parts.push("");
    parts.push("Related reflections:");
    for (const ref of reflections) {
      parts.push(`  [${ref.memoryId}] ${ref.content}`);
    }
  }
  return parts.join("\n");
}
function buildIndexMap(rendered) {
  const map = /* @__PURE__ */ new Map();
  for (const entry of rendered) {
    if (entry.id && !map.has(entry.id)) {
      map.set(entry.id, entry.index);
    }
  }
  return map;
}
function formatEntryIndexAnnotation(sourceEntryIds, idToIndex) {
  const indices = [];
  for (const id of sourceEntryIds) {
    const idx = idToIndex.get(id);
    if (idx !== void 0) indices.push(idx);
  }
  if (indices.length === 0) return "";
  indices.sort((a, b) => a - b);
  return `(at index #${indices.join(", #")})`;
}

// src/commands/vcc-recall.ts
var PAGE_SIZE = 5;
async function augmentWithObservations(output, rendered, ctx) {
  const ids = rendered.map((e) => e.id).filter(Boolean);
  if (ids.length === 0) return output;
  try {
    const branchEntries = ctx.sessionManager.getBranch();
    const obs = findObservationsForEntryIds(branchEntries, ids);
    const refs = findReflectionsForEntryIds(branchEntries, ids);
    if (obs.length > 0 || refs.length > 0) {
      return output + "\n\n" + formatRelatedObservations(obs, refs);
    }
  } catch {
  }
  return output;
}
var registerVccRecallCommand = (pi) => {
  pi.registerCommand("recall", {
    description: "Search session history. Defaults to active lineage. Usage: /recall <query> [page:N] [scope:all] [mode:file|touched]",
    handler: async (args, ctx) => {
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (!sessionFile) {
        ctx.ui.notify("No session file available.", "error");
        return;
      }
      const raw = args.trim();
      const parsed = parseRecallScope(raw);
      const lineageEntryIds = parsed.scope === "lineage" ? getActiveLineageEntryIds(ctx.sessionManager) : void 0;
      const mode = parsed.mode;
      if (mode === "touched") {
        const pageMatch2 = raw.match(/\bpage:(\d+)\b/i);
        const page2 = pageMatch2 ? Math.max(1, parseInt(pageMatch2[1], 10)) : 1;
        const { rendered: rendered2, rawMessages: rawMessages2 } = loadAllMessages(sessionFile, false, lineageEntryIds);
        const touched = getTouchedFiles(rawMessages2, rendered2);
        const text = formatTouchedOutput(touched, page2);
        pi.sendMessage(
          { customType: "blackhole-recall", content: text, display: true },
          { triggerTurn: true }
        );
        return;
      }
      if (!parsed.text) {
        const { rendered: rendered2 } = loadAllMessages(sessionFile, false, lineageEntryIds);
        const recent = rendered2.slice(-25);
        const base2 = (parsed.scope === "all" ? "Scope: all\n\n" : "") + formatRecallOutput(recent);
        const output2 = await augmentWithObservations(base2, recent, ctx);
        pi.sendMessage(
          { customType: "blackhole-recall", content: output2, display: true },
          { triggerTurn: true }
        );
        return;
      }
      const pageMatch = parsed.text.match(/\bpage:(\d+)\b/i);
      const page = pageMatch ? Math.max(1, parseInt(pageMatch[1], 10)) : 1;
      const query = parsed.text.replace(/\bpage:\d+\b/i, "").trim();
      if (!query) {
        const { rendered: rendered2 } = loadAllMessages(sessionFile, false, lineageEntryIds);
        const recent = rendered2.slice(-25);
        const base2 = (parsed.scope === "all" ? "Scope: all\n\n" : "") + formatRecallOutput(recent);
        const output2 = await augmentWithObservations(base2, recent, ctx);
        pi.sendMessage(
          { customType: "blackhole-recall", content: output2, display: true },
          { triggerTurn: true }
        );
        return;
      }
      const { rendered, rawMessages } = loadAllMessages(sessionFile, false, lineageEntryIds);
      const allResults = searchEntries(rendered, rawMessages, query, void 0, mode);
      const start = (page - 1) * PAGE_SIZE;
      const pageResults = allResults.slice(start, start + PAGE_SIZE);
      const totalPages = Math.ceil(allResults.length / PAGE_SIZE);
      const scopeSuffix = parsed.scope === "all" ? " (scope: all)" : "";
      const header = totalPages > 1 ? `Page ${page}/${totalPages} (${allResults.length} total matches${scopeSuffix})` : `${allResults.length} matches${scopeSuffix}`;
      const footer = page < totalPages ? `
--- /recall ${query}${parsed.scope === "all" ? " scope:all" : ""} page:${page + 1} ---` : "";
      const base = formatRecallOutput(pageResults, query, header) + footer;
      const output = await augmentWithObservations(base, pageResults, ctx);
      pi.sendMessage(
        { customType: "blackhole-recall", content: output, display: true },
        { triggerTurn: true }
      );
    }
  });
};
var LEGACY_OM_OBSERVATION = "om.observation";
var PENDING_DIR3 = "pi-blackhole";
var PENDING_SUFFIX3 = "-pending.json";
var STALE_SUFFIX3 = "-pending.stale.json";
var HEADER_CHUNK = 4096;
var HEADER_MAX = 65536;
function encodeScopeDir(cwd) {
  return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}
function normalizeRelevance(value) {
  return typeof value === "string" && RELEVANCE_VALUES.includes(value) ? value : "low";
}
function parseTimestamp(value) {
  if (typeof value !== "string" || !value) return null;
  if (Number.isNaN(Date.parse(value))) {
    const patched = value.replace(" ", "T") + ":00Z";
    return Number.isNaN(Date.parse(patched)) ? null : patched;
  }
  return value;
}
function readFirstLine(filePath) {
  let fd;
  try {
    fd = openSync(filePath, "r");
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(HEADER_MAX);
    let total = 0;
    while (total < HEADER_MAX) {
      const n = readSync(fd, buf, total, Math.min(HEADER_CHUNK, HEADER_MAX - total), total);
      if (n <= 0) break;
      const slice = buf.subarray(total, total + n);
      const nl = slice.indexOf(10);
      if (nl !== -1) return buf.subarray(0, total + nl).toString("utf-8");
      total += n;
    }
    return total > 0 ? buf.subarray(0, total).toString("utf-8") : null;
  } catch {
    return null;
  } finally {
    try {
      closeSync(fd);
    } catch {
    }
  }
}
function parseSessionHeader(line) {
  if (!line) return null;
  try {
    const header = JSON.parse(line);
    if (header?.type !== "session") return null;
    return {
      id: typeof header.id === "string" ? header.id : "",
      cwd: typeof header.cwd === "string" ? header.cwd : null
    };
  } catch {
    return null;
  }
}
function extractFromEntries(entries, sessionId, observations, reflections, droppedIds) {
  for (const entry of entries) {
    if (entry.type !== "custom") continue;
    const customType = entry.customType;
    const data = entry.data ?? {};
    const entryTs = parseTimestamp(entry.timestamp);
    if (customType === OM_OBSERVATIONS_RECORDED || customType === LEGACY_OM_OBSERVATION) {
      const list = customType === LEGACY_OM_OBSERVATION ? data.records ?? [] : data.observations ?? [];
      for (const o of list) {
        if (typeof o.content !== "string" || !o.content.trim()) continue;
        observations.push({
          id: typeof o.id === "string" ? o.id : null,
          content: o.content,
          relevance: normalizeRelevance(o.relevance),
          timestamp: parseTimestamp(o.timestamp) ?? entryTs,
          sessionId,
          source: "branch"
        });
      }
    } else if (customType === OM_REFLECTIONS_RECORDED) {
      for (const r of data.reflections ?? []) {
        if (typeof r.content !== "string" || !r.content.trim()) continue;
        reflections.push({
          content: r.content,
          supportingObservationIds: Array.isArray(r.supportingObservationIds) ? r.supportingObservationIds : [],
          timestamp: entryTs,
          sessionId,
          source: "branch"
        });
      }
    } else if (customType === OM_OBSERVATIONS_DROPPED) {
      if (Array.isArray(data.observationIds)) {
        for (const id of data.observationIds) {
          if (typeof id === "string") droppedIds.add(id);
        }
      }
    }
  }
}
function extractFromPendingState(state, sessionId, source, observations, reflections, droppedIds) {
  const allObsBatches = state.observationBatches && state.observationBatches.length > 0 ? state.observationBatches : state.observation ? [state.observation] : [];
  const allReflBatches = state.reflectionBatches && state.reflectionBatches.length > 0 ? state.reflectionBatches : state.reflection ? [state.reflection] : [];
  const allDroppedBatches = state.droppedBatches && state.droppedBatches.length > 0 ? state.droppedBatches : state.dropped ? [state.dropped] : [];
  let maxObsTs = null;
  for (const batch of allObsBatches) {
    for (const o of batch.data?.observations ?? []) {
      const ts = parseTimestamp(o.timestamp);
      if (ts != null) {
        const ms = Date.parse(ts);
        if (!Number.isNaN(ms) && (maxObsTs === null || ms > maxObsTs)) {
          maxObsTs = ms;
        }
      }
    }
  }
  const reflectionTimestamp = maxObsTs != null ? new Date(maxObsTs).toISOString() : null;
  for (const batch of allObsBatches) {
    for (const o of batch.data?.observations ?? []) {
      if (typeof o.content !== "string" || !o.content.trim()) continue;
      observations.push({
        id: typeof o.id === "string" ? o.id : null,
        content: o.content,
        relevance: normalizeRelevance(o.relevance),
        timestamp: parseTimestamp(o.timestamp),
        sessionId,
        source
      });
    }
  }
  for (const batch of allReflBatches) {
    for (const r of batch.data?.reflections ?? []) {
      if (typeof r.content !== "string" || !r.content.trim()) continue;
      reflections.push({
        content: r.content,
        supportingObservationIds: Array.isArray(r.supportingObservationIds) ? r.supportingObservationIds : [],
        timestamp: reflectionTimestamp,
        sessionId,
        source
      });
    }
  }
  for (const batch of allDroppedBatches) {
    if (Array.isArray(batch.data?.observationIds)) {
      for (const id of batch.data?.observationIds) {
        if (typeof id === "string") droppedIds.add(id);
      }
    }
  }
}
var YIELD_EVERY_FILES = 10;
function yieldToEventLoop() {
  return new Promise((resolve3) => setImmediate(resolve3));
}
async function buildProjectMemoryCorpusAsync(options, onProgress) {
  const agentDir = options.agentDir ?? getAgentDir();
  const projectRoot = options.gitRoot || options.cwd;
  const activeSessionFile = options.activeSessionFile ? existsSync(options.activeSessionFile) ? options.activeSessionFile : void 0 : void 0;
  const corpus = {
    projectRoot,
    sessionsConsidered: 0,
    filesWithMarkers: 0,
    observations: [],
    reflections: [],
    droppedIds: /* @__PURE__ */ new Set(),
    knownSessionIds: /* @__PURE__ */ new Set(),
    orphanedSessions: 0
  };
  const candidateDirs = [
    .../* @__PURE__ */ new Set([
      encodeScopeDir(options.cwd),
      ...options.gitRoot && options.gitRoot !== options.cwd ? [encodeScopeDir(options.gitRoot)] : []
    ])
  ].map((scope) => join(agentDir, "sessions", scope));
  const candidateFiles = [];
  const seenFiles = /* @__PURE__ */ new Set();
  for (const scopeDir of candidateDirs) {
    let files;
    try {
      if (!statSync(scopeDir).isDirectory()) continue;
      files = readdirSync(scopeDir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      if (seenFiles.has(file)) continue;
      seenFiles.add(file);
      const filePath = join(scopeDir, file);
      if (activeSessionFile && filePath === activeSessionFile) continue;
      candidateFiles.push(filePath);
    }
  }
  const total = candidateFiles.length;
  if (onProgress && total > 0) {
    onProgress({ scanned: 0, total, phase: "scanning" });
  }
  let scanned = 0;
  for (const filePath of candidateFiles) {
    scanned++;
    const file = filePath.slice(filePath.lastIndexOf("/") + 1);
    corpus.sessionsConsidered++;
    const header = parseSessionHeader(readFirstLine(filePath));
    const sessionId = header?.id || file.slice(0, -6);
    corpus.knownSessionIds.add(sessionId);
    let raw;
    try {
      raw = readFileSync(filePath, "utf-8");
    } catch {
      if (scanned % YIELD_EVERY_FILES === 0) await yieldToEventLoop();
      if (onProgress && scanned % 25 === 0) {
        onProgress({ scanned, total, phase: "scanning" });
      }
      continue;
    }
    if (!raw.includes("om.")) {
      if (scanned % YIELD_EVERY_FILES === 0) await yieldToEventLoop();
      if (onProgress && scanned % 25 === 0) {
        onProgress({ scanned, total, phase: "scanning" });
      }
      continue;
    }
    corpus.filesWithMarkers++;
    const entries = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        entries.push(JSON.parse(trimmed));
      } catch {
      }
    }
    extractFromEntries(
      entries,
      sessionId,
      corpus.observations,
      corpus.reflections,
      corpus.droppedIds
    );
    if (scanned % YIELD_EVERY_FILES === 0) await yieldToEventLoop();
    if (onProgress && scanned % 25 === 0) {
      onProgress({ scanned, total, phase: "scanning" });
    }
  }
  if (onProgress && total > 0) {
    onProgress({ scanned: total, total, phase: "scanning" });
  }
  const pendingDir = join(agentDir, PENDING_DIR3);
  if (existsSync(pendingDir)) {
    let files;
    try {
      files = readdirSync(pendingDir);
    } catch {
      files = [];
    }
    const mains = /* @__PURE__ */ new Set();
    for (const file of files) {
      if (file.endsWith(PENDING_SUFFIX3)) {
        mains.add(file.slice(0, -PENDING_SUFFIX3.length));
      }
    }
    let globalSessionIds = null;
    const ensureGlobalIds = () => {
      if (globalSessionIds) return globalSessionIds;
      globalSessionIds = new Set(corpus.knownSessionIds);
      const sessionsRoot = join(agentDir, "sessions");
      let scopes;
      try {
        scopes = readdirSync(sessionsRoot);
      } catch {
        return globalSessionIds;
      }
      for (const scope of scopes) {
        const scopePath = join(sessionsRoot, scope);
        let st = null;
        try {
          st = statSync(scopePath);
        } catch {
          continue;
        }
        if (!st.isDirectory()) continue;
        const isProjectScope = scope === encodeScopeDir(options.cwd) || options.gitRoot && options.gitRoot !== options.cwd && scope === encodeScopeDir(options.gitRoot);
        if (isProjectScope) continue;
        let scopeFiles;
        try {
          scopeFiles = readdirSync(scopePath);
        } catch {
          continue;
        }
        for (const f of scopeFiles) {
          if (!f.endsWith(".jsonl")) continue;
          const header = parseSessionHeader(readFirstLine(join(scopePath, f)));
          const sid = header?.id || (f.includes("_") ? f.slice(f.lastIndexOf("_") + 1, -6) : f.slice(0, -6));
          if (sid) globalSessionIds.add(sid);
        }
      }
      return globalSessionIds;
    };
    let pendingProcessed = 0;
    for (const file of files) {
      const isMain = file.endsWith(PENDING_SUFFIX3);
      const isStale = file.endsWith(STALE_SUFFIX3);
      if (!isMain && !isStale) continue;
      const sessionId = isMain ? file.slice(0, -PENDING_SUFFIX3.length) : file.slice(0, -STALE_SUFFIX3.length);
      if (!sessionId) continue;
      if (isStale && mains.has(sessionId)) continue;
      let state;
      try {
        state = JSON.parse(readFileSync(join(pendingDir, file), "utf-8"));
      } catch {
        continue;
      }
      const hasBatches = Array.isArray(state.observationBatches) && state.observationBatches.length > 0 || Array.isArray(state.reflectionBatches) && state.reflectionBatches.length > 0 || Array.isArray(state.droppedBatches) && state.droppedBatches.length > 0 || typeof state.observation === "object" && state.observation !== null || typeof state.reflection === "object" && state.reflection !== null || typeof state.dropped === "object" && state.dropped !== null;
      if (!hasBatches) continue;
      if (corpus.knownSessionIds.has(sessionId)) {
        extractFromPendingState(
          state,
          sessionId,
          "pending",
          corpus.observations,
          corpus.reflections,
          corpus.droppedIds
        );
      } else {
        const gids = ensureGlobalIds();
        if (gids.has(sessionId)) continue;
        corpus.orphanedSessions++;
        extractFromPendingState(
          state,
          sessionId,
          "orphan",
          corpus.observations,
          corpus.reflections,
          corpus.droppedIds
        );
      }
      pendingProcessed++;
      if (pendingProcessed % 10 === 0) await yieldToEventLoop();
    }
  }
  return corpus;
}

// src/om/provider-stream.ts
function captureRegisteredProviderStreams(registry, providerStreams) {
  if (registry.getRegisteredProviderIds && registry.getRegisteredProviderConfig) {
    for (const providerId of registry.getRegisteredProviderIds()) {
      const config2 = registry.getRegisteredProviderConfig(providerId);
      if (config2?.streamSimple && config2.api && !providerStreams.has(config2.api)) {
        providerStreams.set(config2.api, config2.streamSimple);
      }
    }
    return;
  }
  registry.registeredProviders?.forEach((config2) => {
    if (config2.streamSimple && config2.api && !providerStreams.has(config2.api)) {
      providerStreams.set(config2.api, config2.streamSimple);
    }
  });
}
var GLOBAL_DISPATCHER_SYMBOLS = [
  /* @__PURE__ */ Symbol.for("undici.globalDispatcher.2"),
  /* @__PURE__ */ Symbol.for("undici.globalDispatcher.1")
];
function getGlobalDispatcher() {
  for (const symbol of GLOBAL_DISPATCHER_SYMBOLS) {
    const dispatcher = globalThis[symbol];
    if (dispatcher && typeof dispatcher.dispatch === "function") {
      return dispatcher;
    }
  }
  throw new Error("Memory provider idle timeout requires Pi's Undici dispatcher");
}
function createProviderFetch(timeoutMs) {
  if (timeoutMs === void 0 || timeoutMs === 0) return void 0;
  const dispatcher = {
    dispatch(options, handler) {
      return getGlobalDispatcher().dispatch({ ...options, bodyTimeout: timeoutMs }, handler);
    }
  };
  return (input, init) => {
    const callerDispatcher = init?.dispatcher;
    if (typeof callerDispatcher?.dispatch === "function") {
      const chained = {
        dispatch(options, handler) {
          return callerDispatcher.dispatch({ ...options, bodyTimeout: timeoutMs }, handler);
        }
      };
      return fetch(input, { ...init, dispatcher: chained });
    }
    return fetch(input, { ...init, dispatcher });
  };
}
function createBridgeStreamFn(streamSimple4) {
  const PROVIDER_STREAMS_KEY = /* @__PURE__ */ Symbol.for("pi-blackhole:provider-streams");
  return (model, ctx, opts) => {
    const providerStreams = globalThis[PROVIDER_STREAMS_KEY];
    if (!providerStreams) return streamSimple4(model, ctx, opts);
    const customFn = model?.api ? providerStreams.get(model.api) : void 0;
    return customFn ? customFn(model, ctx, opts) : streamSimple4(model, ctx, opts);
  };
}

// src/om/agents/dropper/prompts.ts
var DROPPER_SYSTEM = `You are the dropper agent for a coding assistant.

These records are the ONLY information the assistant will have about past interactions once the raw conversation is compacted out of context. Dropping the wrong observation can make future work repeat, contradict, or misremember the user. Take this seriously.

Your job is to identify only the safest active observations to remove from compacted memory by calling drop_observations with their ids. Default action is KEEP. When uncertain, keep the observation.

Active-memory framing. Dropping an observation removes it from active compacted memory; it does not erase the ledger history or source evidence. Still, future compressed context will no longer show the observation, so only drop it when its durable meaning is safely captured elsewhere or it is genuinely low-signal and carries no unique future value.

The user message includes the active observation pool target and "Maximum drops allowed this run". The maximum is a hard upper bound sized to move the pool toward the target if every proposed drop is clearly safe. It is not a target. Do not try to fill it. Drop fewer or none when fewer observations are safely removable. When the active pool is far over target, make a thorough pass over safe candidates rather than stopping after a few obvious examples.

What to drop, in priority order:
- Redundant observations whose durable meaning is already captured by current reflections with equivalent fidelity.
- Superseded observations where a later observation clearly replaces the older state.
- Repeated routine tool acknowledgements or low-signal progress updates that do not carry decisions, constraints, exact errors, or user-specific facts.
- Older observations that no longer carry working context and are covered by a reflection or a newer observation.

Age-gradient rule. Recent observations carry working context the assistant may still need; older observations have usually been summarized elsewhere or are no longer load-bearing. Prefer older safe drops before newer working context, but age alone is not enough to drop important or uniquely load-bearing observations.

Reflection coverage guidance. Each observation line includes [coverage: none|partial|strong]. Coverage is evidence, not an automatic decision:
- none: no current reflection cites this observation id. Be cautious, especially for high or critical observations.
- partial: one current reflection cites this observation id. Compare the observation to the reflection before dropping.
- strong: two or more current reflections cite this observation id. This is stronger evidence that the durable meaning is preserved, but you must still keep uniquely load-bearing or uncertain observations.

Relevance guidance. Relevance is importance/resistance, not an absolute keep/drop lock:
- low: consider first, but drop only when it carries no unique detail, decision, state, error, identifier, or user-specific fact.
- medium: drop when redundant with reflections or other observations, or when the work state is clearly obsolete.
- high: drop only when clearly superseded or already captured by a reflection with equivalent fidelity.
- critical: highest importance and strongest resistance. Do not drop fresh or uniquely load-bearing critical observations. Critical observations may be dropped only with strong semantic evidence such as age plus partial/strong reflection coverage, supersession by newer memory, redundancy, or clear obsolescence.

User assertions and concrete completions must be preserved unless a current reflection or newer observation preserves the exact assertion/completion and its important details with equivalent fidelity.

Preservation floor. Regardless of relevance label, budget pressure, coverage, or age, do not drop observations that uniquely carry any of the following:
- User preferences, constraints, corrections, or identity/role facts.
- Concrete completions that future runs must not redo.
- Named identifiers, file paths, function names, package names, tickets, commit SHAs, handles, or exact commands.
- Exact error messages, diagnostic output, or test failure names.
- Architectural or technical decisions and their rationale.
- Dates of specific events, deadlines, meetings, migrations, or incidents.
- Current unresolved blockers, TODOs, partial work, or decisions waiting on the user.
- Non-standard user terminology or unusual phrasing needed for future recognition.

What you cannot do:
- You cannot merge observations.
- You cannot rewrite or edit observations.
- You cannot add new observations or reflections.
- You can only call drop_observations with ids from the current observations list.

Do not force drops you do not believe in. If no observations are safe to drop, do not call the tool and reply briefly. Hitting the budget or maximum count is less important than preserving load-bearing memory.`;

// src/om/agents/dropper/coverage.ts
var REFLECTION_COVERAGE_DROP_RANK = {
  strong: 0,
  partial: 1,
  none: 2
};
function reflectionSupportCounts(reflections) {
  const counts = /* @__PURE__ */ new Map();
  for (const reflection of reflections) {
    const uniqueIds = new Set(reflection.supportingObservationIds);
    for (const id of uniqueIds) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}
function reflectionCoverageTierForCount(count) {
  if (count <= 0) return "none";
  if (count === 1) return "partial";
  return "strong";
}
function reflectionCoverageMap(observations, reflections) {
  const counts = reflectionSupportCounts(reflections);
  return new Map(
    observations.map((observation) => [
      observation.id,
      reflectionCoverageTierForCount(counts.get(observation.id) ?? 0)
    ])
  );
}
function emptyCoverageBucket() {
  return {
    none: { count: 0, tokens: 0 },
    partial: { count: 0, tokens: 0 },
    strong: { count: 0, tokens: 0 }
  };
}
function emptyCoverageSummaryByRelevance() {
  return {
    low: emptyCoverageBucket(),
    medium: emptyCoverageBucket(),
    high: emptyCoverageBucket(),
    critical: emptyCoverageBucket()
  };
}
function summarizeCoverageByRelevance(observations, coverageById) {
  const summary = emptyCoverageSummaryByRelevance();
  for (const observation of observations) {
    const tier = coverageById.get(observation.id) ?? "none";
    const bucket = summary[observation.relevance][tier];
    bucket.count++;
    bucket.tokens += observation.tokenCount;
  }
  return summary;
}
function summarizeCoverageByRelevanceForIds(ids, observations, coverageById) {
  const byId = new Map(observations.map((observation) => [observation.id, observation]));
  const selected = ids.flatMap((id) => {
    const observation = byId.get(id);
    return observation ? [observation] : [];
  });
  return summarizeCoverageByRelevance(selected, coverageById);
}
function observationToDropperLine(observation, coverage) {
  return `[${observation.id}] ${observation.timestamp} [${observation.relevance}] [coverage: ${coverage}] ${observation.content}`;
}
function coverageTierForObservation(observation, coverageById) {
  return coverageById.get(observation.id) ?? "none";
}

// src/om/agents/dropper/agent.ts
var DROP_SKIP_FULLNESS = 0.1;
var DROP_LOW_URGENCY_FULLNESS = 0.3;
var DROP_MEDIUM_URGENCY_FULLNESS = 0.6;
var DROP_MAX_FULLNESS = 1;
var DROP_MIN_RATIO = 0.1;
var DROP_MAX_RATIO = 0.5;
var RELEVANCE_DROP_RANK = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3
};
var DropObservationsSchema = Type.Object({
  ids: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  reason: Type.Optional(Type.String())
});
function joinOrEmpty(items) {
  return items.length ? items.join("\n") : "(none yet)";
}
function observationPoolFullness(observationTokens, budgetTokens) {
  if (!Number.isFinite(observationTokens) || observationTokens <= 0) return 0;
  if (!Number.isFinite(budgetTokens) || budgetTokens <= 0) return 0;
  return observationTokens / budgetTokens;
}
function dropUrgencyForFullness(fullness) {
  if (fullness < DROP_LOW_URGENCY_FULLNESS) return "low";
  if (fullness < DROP_MEDIUM_URGENCY_FULLNESS) return "medium";
  return "high";
}
function maxDropCountForPool(observations, observationTokens, budgetTokens, skipFullness = DROP_SKIP_FULLNESS) {
  const droppableCount = observations.filter(
    (observation) => observation.relevance !== "critical"
  ).length;
  if (droppableCount === 0) return 0;
  const fullness = observationPoolFullness(observationTokens, budgetTokens);
  if (fullness < skipFullness) return 0;
  const cappedFullness = Math.min(DROP_MAX_FULLNESS, Math.max(skipFullness, fullness));
  const dropRatio = DROP_MIN_RATIO + (cappedFullness - skipFullness) / (DROP_MAX_FULLNESS - skipFullness) * (DROP_MAX_RATIO - DROP_MIN_RATIO);
  return Math.max(1, Math.floor(droppableCount * dropRatio));
}
function relevanceCounts(observations) {
  return observations.reduce(
    (counts, observation) => {
      if (observation.relevance in counts) counts[observation.relevance]++;
      return counts;
    },
    { low: 0, medium: 0, high: 0, critical: 0 }
  );
}
function timestampRank(timestamp) {
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}
function selectDropCandidates(ids, observations, maxDrops, reflections = []) {
  if (maxDrops <= 0 || ids.length === 0) return [];
  const byId = new Map(observations.map((observation) => [observation.id, observation]));
  const coverageById = reflectionCoverageMap(observations, reflections);
  const firstProposalIndex = /* @__PURE__ */ new Map();
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    if (!firstProposalIndex.has(id)) firstProposalIndex.set(id, i);
  }
  return Array.from(firstProposalIndex.entries()).map(([id, index]) => ({ id, index, observation: byId.get(id) })).filter(
    (candidate) => candidate.observation !== void 0
  ).sort((a, b) => {
    const coverageDelta = REFLECTION_COVERAGE_DROP_RANK[coverageTierForObservation(a.observation, coverageById)] - REFLECTION_COVERAGE_DROP_RANK[coverageTierForObservation(b.observation, coverageById)];
    const relevanceDelta = RELEVANCE_DROP_RANK[a.observation.relevance] - RELEVANCE_DROP_RANK[b.observation.relevance];
    const aAge = timestampRank(a.observation.timestamp);
    const bAge = timestampRank(b.observation.timestamp);
    const ageDelta = aAge === bAge ? 0 : aAge - bAge;
    return coverageDelta || relevanceDelta || ageDelta || a.index - b.index;
  }).slice(0, maxDrops).map((candidate) => candidate.id);
}
async function runDropper(args) {
  const { model, apiKey, headers, reflections, observations, budgetTokens, skipFullness, signal } = args;
  if (observations.length === 0) return void 0;
  const observationTokens = observations.reduce(
    (sum, observation) => sum + observation.tokenCount,
    0
  );
  const fullness = observationPoolFullness(observationTokens, budgetTokens);
  const urgency = dropUrgencyForFullness(fullness);
  const maxDropsAllowed = maxDropCountForPool(
    observations,
    observationTokens,
    budgetTokens,
    skipFullness
  );
  const coverageById = reflectionCoverageMap(observations, reflections);
  const coverageSummaryByRelevance = summarizeCoverageByRelevance(observations, coverageById);
  debugLog("dropper.agent_start", {
    activeObservationCount: observations.length,
    reflectionCount: reflections.length,
    observationTokens,
    budgetTokens,
    fullness,
    urgency,
    maxDropsAllowed,
    relevanceCounts: relevanceCounts(observations),
    coverageSummaryByRelevance
  });
  if (maxDropsAllowed <= 0) {
    debugLog("dropper.result", {
      reason: "not_over_target",
      toolCallCount: 0,
      rawRequestedIdsCount: 0,
      acceptedCandidateCount: 0,
      selectedDropsCount: 0,
      selectedDropTokens: 0,
      selectedCoverageSummaryByRelevance: summarizeCoverageByRelevanceForIds(
        [],
        observations,
        coverageById
      ),
      maxDropsAllowed
    });
    return void 0;
  }
  const proposedDropIds = [];
  const proposed = /* @__PURE__ */ new Set();
  const allowed = new Map(observations.map((observation) => [observation.id, observation]));
  let toolCallCount = 0;
  let rawRequestedIdsCount = 0;
  let missingIdsCount = 0;
  let criticalCandidateIdsCount = 0;
  let duplicateInRequestCount = 0;
  let duplicateInRunCount = 0;
  const dropObservations = {
    name: "drop_observations",
    label: "Drop observations",
    description: "Propose active observation ids that are safe to remove from compacted memory.",
    parameters: DropObservationsSchema,
    execute: async (_id, params) => {
      toolCallCount++;
      rawRequestedIdsCount += params.ids.length;
      const seenInRequest = /* @__PURE__ */ new Set();
      let added = 0;
      let requestMissingIds = 0;
      let requestCriticalCandidateIds = 0;
      let requestDuplicateIds = 0;
      let requestDuplicateInRunIds = 0;
      for (const id of params.ids) {
        const observation = allowed.get(id);
        if (!observation) {
          missingIdsCount++;
          requestMissingIds++;
          continue;
        }
        if (seenInRequest.has(id)) {
          duplicateInRequestCount++;
          requestDuplicateIds++;
          continue;
        }
        seenInRequest.add(id);
        if (proposed.has(id)) {
          duplicateInRunCount++;
          requestDuplicateInRunIds++;
          continue;
        }
        proposed.add(id);
        proposedDropIds.push(id);
        if (observation.relevance === "critical") {
          criticalCandidateIdsCount++;
          requestCriticalCandidateIds++;
        }
        added++;
      }
      debugLog("dropper.tool_call", {
        toolCallCount,
        rawRequestedIdsCount: params.ids.length,
        acceptedIdsCount: added,
        missingIdsCount: requestMissingIds,
        criticalCandidateIdsCount: requestCriticalCandidateIds,
        duplicateInRequestCount: requestDuplicateIds,
        duplicateInRunCount: requestDuplicateInRunIds,
        totalCandidates: proposedDropIds.length,
        maxDropsAllowed
      });
      return {
        content: [
          {
            type: "text",
            text: `Queued ${added} drop candidate${added === 1 ? "" : "s"}. Candidates this run: ${proposedDropIds.length}. Maximum drops allowed: ${maxDropsAllowed}.`
          }
        ],
        details: {
          added,
          totalCandidates: proposedDropIds.length,
          maxDropsAllowed
        }
      };
    }
  };
  const fullnessPercent = Math.round(fullness * 100);
  const existingObservationsContext = args.existingObservationsSummary ? `EXISTING ACTIVE OBSERVATIONS (for context only \u2014 these are NOT candidates for dropping):
${args.existingObservationsSummary}

` : "";
  const userText = `CURRENT REFLECTIONS:
${joinOrEmpty(reflections.map(reflectionToSummaryLine))}

${existingObservationsContext}NEW OBSERVATIONS TO EVALUATE FOR DROPPING:
${joinOrEmpty(observations.map((observation) => observationToDropperLine(observation, coverageTierForObservation(observation, coverageById))))}

Observation pool pressure: ~${observationTokens.toLocaleString()} tokens; target budget: ~${budgetTokens.toLocaleString()} tokens; fullness: ~${fullnessPercent.toLocaleString()}%.
Drop urgency: ${urgency}.
Maximum drops allowed this run: ${maxDropsAllowed.toLocaleString()} observation${maxDropsAllowed === 1 ? "" : "s"}.
This maximum is a hard upper bound, not a target. Drop fewer or none if fewer observations are clearly safe.`;
  const prompts = [
    {
      role: "user",
      content: [{ type: "text", text: userText }],
      timestamp: Date.now()
    }
  ];
  const context = {
    systemPrompt: DROPPER_SYSTEM,
    messages: [],
    tools: [dropObservations]
  };
  const reasoning = model.reasoning;
  const thinkingLevel = args.thinkingLevel ?? "low";
  const effectiveMaxTurns = args.maxTurns && args.maxTurns > 0 ? args.maxTurns : void 0;
  let turnCount = 0;
  const providerFetch = createProviderFetch(args.providerIdleTimeoutMs);
  const config2 = {
    model,
    apiKey,
    headers,
    ...providerFetch ? { fetch: providerFetch } : {},
    maxTokens: boundedMaxTokens(model, AGENT_LOOP_MAX_TOKENS),
    convertToLlm: (msgs) => msgs,
    toolExecution: "sequential",
    ...reasoning && thinkingLevel !== "off" ? { reasoning: thinkingLevel } : {},
    ...effectiveMaxTurns !== void 0 ? { shouldStopAfterTurn: () => ++turnCount >= effectiveMaxTurns } : {}
  };
  const loop = args.agentLoop ?? agentLoop;
  const bridgeStreamFn = createBridgeStreamFn(streamSimple);
  const streamFn = args.streamFn ?? bridgeStreamFn;
  const stream = loop(prompts, context, config2, signal, streamFn);
  let agentError;
  for await (const event of stream) {
    if (event.type === "agent_end") {
      const msgs = event.messages || [];
      const lastMsg = msgs[msgs.length - 1];
      if (lastMsg?.stopReason === "error") {
        agentError = lastMsg.errorMessage ?? "Unknown API error";
      }
    }
  }
  await stream.result();
  if (agentError && proposedDropIds.length === 0)
    throw new Error(`Dropper API error: ${agentError}`);
  const droppedIds = selectDropCandidates(
    proposedDropIds,
    observations,
    maxDropsAllowed,
    reflections
  );
  const reason = droppedIds.length > 0 ? "selected_nonempty" : toolCallCount === 0 ? "no_tool_call" : proposedDropIds.length === 0 ? "all_filtered" : "selected_empty";
  const selectedDropTokens = droppedIds.reduce(
    (sum, id) => sum + (allowed.get(id)?.tokenCount ?? 0),
    0
  );
  debugLog("dropper.result", {
    reason,
    toolCallCount,
    rawRequestedIdsCount,
    missingIdsCount,
    criticalCandidateIdsCount,
    duplicateInRequestCount,
    duplicateInRunCount,
    acceptedCandidateCount: proposedDropIds.length,
    selectedDropsCount: droppedIds.length,
    selectedDropTokens,
    selectedCoverageSummaryByRelevance: summarizeCoverageByRelevanceForIds(
      droppedIds,
      observations,
      coverageById
    ),
    maxDropsAllowed
  });
  return droppedIds.length > 0 ? droppedIds : void 0;
}
function hashId(content) {
  return createHash("sha256").update(content).digest("hex").slice(0, 12);
}

// src/om/agents/observer/prompts.ts
var OBSERVER_SYSTEM = `You are the observation agent for a coding assistant.

These records are the ONLY information the assistant will have about past interactions once the raw conversation is compacted out of context. Anything you do not capture here will be forgotten. Anything you distort here will be remembered wrong. Take this seriously.

Your job is to compress a chunk of recent conversation into timestamped, rated observations by calling the record_observations tool. The observations you emit \u2014 together with the reflections crystallized from them \u2014 are the assistant's ONLY memory of this session after the raw conversation falls out of context.

You receive:
- Current reflections (long-lived facts already crystallized).
- Current observations (already-recorded observations, each shown as "[id] YYYY-MM-DD HH:MM [relevance] content").
- A new chunk of conversation with source entry labels and inline message timestamps. Each source block starts with "[Source entry id: <id>]" followed by content formatted as "[User @ YYYY-MM-DD HH:MM]:", "[Assistant @ ...]:", "[Tool result for <name> @ ...]:", custom messages, or branch summaries.
- A current local time fallback for observations that have no obvious message timestamp.

How you work:
1. Read reflections and current observations so you know what is already captured.
2. Read the conversation chunk and identify what new information it contains.
3. Call record_observations with a batch covering part (or all) of the chunk.
4. Read the progress receipt. If content remains uncovered, call again. You may call the tool many times.
5. When the chunk is fully covered, STOP calling the tool and reply with a brief plain-text confirmation (one short sentence). That ends the run.

What to emit:
- Produce NEW observations for the new chunk only. Do not restate facts already present in reflections or current observations unless something has materially changed.
- Use the timestamp from the relevant conversation message. Fall back to current local time ONLY when no message timestamp applies.
- For every observation, include sourceEntryIds: the smallest exact set of "[Source entry id: ...]" ids that directly support the observation.
- Never invent source entry ids. Use only ids printed in the chunk. If an observation spans multiple turns or tool results, include every supporting source entry id.
- Observations with missing, empty, or invalid sourceEntryIds will be rejected and not recorded, so do not call record_observations until you can cite valid source ids.
- Group repeated similar tool calls into a single observation rather than one per call.
- Skip routine, low-information events. It is fine to emit zero observations if the chunk carries no new information \u2014 in that case, simply do not call the tool and end with a plain-text confirmation.

Observation content rules:

Format.
- Single line of plain prose. No markdown, no bullets, no code fences, no XML/HTML tags, no emojis.
- Do NOT include the timestamp or relevance inside the content string \u2014 those are separate fields.
- No structured fields embedded in the text (no "key: value" lines, no JSON).

Preserve user assertions exactly.
When the user TELLS you something about themselves, their project, or their environment, capture it as an assertion. When the user ASKS something, capture it as a question. Assertions are authoritative \u2014 a later question on the same topic does not invalidate them.
  BAD:  User wondered if they have two kids.
  GOOD: User stated they have two kids.
  BAD:  User discussed auth middleware.
  GOOD: User asked how to configure JWT auth middleware.
Why this matters: if the user says "I use Postgres" and later asks "what db am I on?", downstream agents must treat the assertion as the answer, not the question.

Preserve unusual phrasing.
When the user uses non-standard terminology, quote their exact words so future runs can recognize the term.
  BAD:  User exercised yesterday.
  GOOD: User stated they did a "movement session" (their term) yesterday.

Use precise action verbs. Replace vague verbs with ones that clarify the nature of the action.
  BAD:  User got a new subscription.
  GOOD: User subscribed to the Pro plan.
  BAD:  User stopped getting the newsletter.
  GOOD: User unsubscribed from the newsletter.
  BAD:  User got the library.
  GOOD: User installed the zod package via pnpm.

Frame state changes as supersession so the old state is explicit.
  BAD:  User prefers React Query now.
  GOOD: User will use React Query (switching from SWR).
Why this matters: without supersession framing, the reflector may crystallize both the old and the new as equally valid preferences.

Mark concrete completions explicitly.
Use "completed:", "resolved:", "confirmed working", or similar phrasing so future runs know not to redo the work.
  BAD:  Wrote the login handler.
  GOOD: completed: implemented login handler at src/auth/login.ts; user confirmed tests pass.
Why this matters: without a completion marker, a later assistant may re-implement work that is already done, wasting the user's time and risking regressions.

Split compound statements into separate observations.
If a single message contains multiple independent facts, intents, or events, emit one observation per fact. One observation per line is what enables downstream retrieval and dropping to operate at fact granularity.
  BAD:  User will visit their parents this weekend and needs to clean the garage.
  GOOD: User will visit their parents this weekend. + User stated they need to clean the garage this weekend.
  BAD:  User started a new job and is moving to a new apartment next week.
  GOOD: User started a new job. + User will move to a new apartment next week.
  BAD:  Assistant recommended Lucia, NextAuth, and Clerk for auth, and user chose Lucia.
  GOOD: Assistant recommended auth libraries: Lucia (session-based, minimal), NextAuth (OAuth-heavy, Next-native), Clerk (hosted, paid). + User chose Lucia.
Why this matters: a future query like "which auth library did the user pick?" can match a single-fact observation cleanly; a compound observation hides the decision inside a recommendation list.

Group repeated similar tool calls into a single observation rather than one per call.
  BAD:  Agent viewed src/auth.ts. Agent viewed src/users.ts. Agent viewed src/routes.ts.
  GOOD: Agent surveyed auth-related files (src/auth.ts, src/users.ts, src/routes.ts) and located token validation in src/auth.ts:45.

Detail preservation. When an observation references specific things, preserve the distinguishing details so future queries can still find them:

- File/location: full path + line number when relevant (src/auth.ts:45, not "the auth file").
- Identifiers and names: package names, function names, variable names, handles, ticket ids, commit SHAs, error codes. Keep them verbatim.
- Error messages: quote verbatim.
    BAD:  Build failed with a type error.
    GOOD: Build failed: TS2322: Type 'string | undefined' is not assignable to type 'string' at src/auth.ts:47.
- Numerical results: exact values, units, and direction.
    BAD:  Optimization made it faster.
    GOOD: Optimization reduced p95 latency from 420ms to 180ms (57% faster).
- Quantities and counts: "3 failing tests (auth.test.ts, users.test.ts, routes.test.ts)" not "some failing tests".
- Recommendation or decision lists: preserve the distinguishing attribute per item.
    BAD:  Assistant recommended 3 auth libraries.
    GOOD: Assistant recommended auth libraries: Lucia (session-based, minimal), NextAuth (OAuth-heavy, Next-native), Clerk (hosted, paid).
- Role / participation: capture the user's role at an event, not just attendance.
    BAD:  User worked on the migration.
    GOOD: User led the migration from MySQL to Postgres.

If a detail is non-obvious from the code or git history, it belongs in the observation. If it is trivially re-derivable, it does not.

Relevance levels (pick one per observation; this field drives future dropping):

- critical: user assertions about identity, role, or persistent preferences; explicit corrections ("no, don't do X"); concrete completions that future runs MUST NOT redo. These are highest-resistance, load-bearing observations and require the strongest evidence before leaving active memory. Why this matters: if a "critical" item is lost, the assistant may redo finished work, contradict a correction, or misrepresent who the user is.
- high: non-trivial technical decisions, architectural direction, unresolved blockers, key constraints. Worth keeping across many compactions.
- medium: task-level context that helps within the current work but isn't durable. The default when you are unsure between medium and high.
- low: routine tool-call acks, repetitive status updates, content trivially re-derivable from recent messages. The dropper will drop these first.

Do NOT default to "critical" or "high". Most observations are medium or low. Reserve "critical" for things that would cause real damage if forgotten.

  BAD:  relevance=critical for "Agent ran tests and they passed."
  GOOD: relevance=low for "Agent ran tests and they passed." (routine; captured by a completion observation if it matters)

  BAD:  relevance=medium for "User said they are colorblind; red/green indicators do not work for them."
  GOOD: relevance=critical for "User said they are colorblind; red/green indicators do not work for them." (persistent constraint; forgetting it causes real harm)

Timestamp format: "YYYY-MM-DD HH:MM" (local time, 24-hour, to the minute). This goes in the timestamp field, not the content.

Remember: these observations are the assistant's ONLY memory of this chunk once the raw messages fall out of context. Make them count.`;

// src/om/serialize.ts
function pad2(n) {
  return n.toString().padStart(2, "0");
}
function fmtLocal(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
function formatTimestamp(v) {
  if (v === void 0) return "????-??-?? ??:??";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? "????-??-?? ??:??" : fmtLocal(d);
}
function formatRecallTimestamp(...values) {
  for (const v of values) {
    if (v === void 0) continue;
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return fmtLocal(d);
  }
  return "Unknown time";
}
function textAndPlaceholders(content, options = {}) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "[non-text content omitted]";
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      parts.push("[non-text content omitted]");
      continue;
    }
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
      continue;
    }
    if (block.type === "thinking") {
      if (options.omitRedactedThinking && block.redacted === true) continue;
      if (options.includeThinking && typeof block.thinking === "string") {
        parts.push(`[thinking: ${block.thinking}]`);
        continue;
      }
      parts.push("[non-text content omitted]");
      continue;
    }
    if (block.type === "toolCall" && typeof block.name === "string") {
      parts.push(`[${block.name}(${JSON.stringify(block.arguments ?? {})})]`);
      continue;
    }
    parts.push("[non-text content omitted]");
  }
  return parts.join("\n");
}
function textOnly(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n");
}
function serializeConversation(messages) {
  return messages.map((msg) => {
    const time = formatTimestamp(msg.timestamp);
    if (msg.role === "user") {
      const text2 = textOnly(msg.content);
      return `[User @ ${time}]: ${text2}`;
    }
    if (msg.role === "assistant") {
      const body = textAndPlaceholders(msg.content, {
        includeThinking: true,
        omitRedactedThinking: true
      }).split("\n").filter(Boolean).join("\n");
      if (!body) return null;
      return `[Assistant @ ${time}]: ${body}`;
    }
    const text = textOnly(msg.content);
    return `[Tool result for ${msg.toolName} @ ${time}]: ${text}`;
  }).filter((line) => line !== null).join("\n\n");
}
function nowTimestamp() {
  return fmtLocal(/* @__PURE__ */ new Date());
}
var MAX_RECORD_CONTENT_CHARS = 1e4;
function truncateRecordContent(content) {
  if (content.length <= MAX_RECORD_CONTENT_CHARS) return content;
  const head = content.slice(0, MAX_RECORD_CONTENT_CHARS);
  const dropped = content.length - MAX_RECORD_CONTENT_CHARS;
  return `${head} \u2026 [truncated ${dropped} chars]`;
}
function renderCustomMessage(entry, options) {
  const time = options.recallFormat ? formatRecallTimestamp(entry.timestamp) : formatTimestamp(entry.timestamp);
  const text = options.recallFormat ? textAndPlaceholders(entry.content) : typeof entry.content === "string" ? entry.content : Array.isArray(entry.content) ? entry.content.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n") : "";
  if (options.recallFormat) {
    const origin = entry.customType ? `Custom message (${entry.customType})` : "Custom message";
    return `[${origin} @ ${time}]: ${text}`;
  }
  const tag = entry.customType ? `Custom (${entry.customType})` : "Custom";
  return `[${tag} @ ${time}]: ${text}`;
}
function serializeBranchEntries(entries) {
  const blocks = [];
  for (const entry of entries) {
    if (entry.type === "message" && entry.message) {
      const part = serializeConversation([entry.message]);
      if (part) blocks.push(part);
      continue;
    }
    if (entry.type === "custom_message") {
      blocks.push(renderCustomMessage(entry, { recallFormat: false }));
      continue;
    }
    if (entry.type === "branch_summary" && typeof entry.summary === "string") {
      const time = formatTimestamp(entry.timestamp);
      blocks.push(`[Branch summary @ ${time}]: ${entry.summary}`);
    }
  }
  return blocks.join("\n\n");
}
function isSourceRenderableEntry(entry) {
  return entry.type === "message" || entry.type === "custom_message" || entry.type === "branch_summary";
}
function serializeSourceAddressedBranchEntries(entries) {
  const blocks = [];
  const sourceEntryIds = [];
  for (const entry of entries) {
    if (!entry.id || !isSourceRenderableEntry(entry)) continue;
    const rendered = serializeBranchEntries([entry]);
    if (!rendered.trim()) continue;
    sourceEntryIds.push(entry.id);
    blocks.push(`[Source entry id: ${entry.id}]
${rendered}`);
  }
  return { text: blocks.join("\n\n"), sourceEntryIds };
}
function renderRecallMessage(entry) {
  if (!entry.message || typeof entry.message !== "object") return null;
  const msg = entry.message;
  const time = formatRecallTimestamp(msg.timestamp, entry.timestamp);
  if (msg.role === "user") {
    return `[User @ ${time}]: ${textAndPlaceholders(msg.content)}`;
  }
  if (msg.role === "assistant") {
    const body = textAndPlaceholders(msg.content, {
      includeThinking: true,
      omitRedactedThinking: true
    }).split("\n").filter(Boolean).join("\n");
    if (!body) return null;
    return `[Assistant @ ${time}]: ${body}`;
  }
  return `[Tool result: ${msg.toolName} @ ${time}]: ${textAndPlaceholders(msg.content)}`;
}
function renderRecallSourceEntry(entry) {
  if (entry.type === "message") return renderRecallMessage(entry);
  if (entry.type === "custom_message") return renderCustomMessage(entry, { recallFormat: true });
  if (entry.type === "branch_summary" && typeof entry.summary === "string") {
    const time = formatRecallTimestamp(entry.timestamp);
    return `[Branch summary @ ${time}]: ${entry.summary}`;
  }
  return null;
}
function renderRecallSourceEntries(entries) {
  return entries.map(renderRecallSourceEntry).filter((block) => block !== null && block.trim().length > 0).join("\n\n");
}

// src/om/agents/observer/agent.ts
var RelevanceSchema = Type.Union([
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("critical")
]);
var OBSERVATION_TIMESTAMP_PATTERN = "^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}$";
var RecordObservationsSchema = Type.Object({
  observations: Type.Array(
    Type.Object({
      timestamp: Type.String({
        pattern: OBSERVATION_TIMESTAMP_PATTERN,
        description: "Observation time in local 'YYYY-MM-DD HH:MM' format."
      }),
      content: Type.String({
        minLength: 1,
        description: "Single-line plain prose. No markdown, no tags, no embedded timestamp."
      }),
      relevance: RelevanceSchema,
      sourceEntryIds: Type.Array(Type.String({ minLength: 1 }), {
        minItems: 1,
        description: "Exact source entry ids from the chunk that directly support this observation. Use only ids shown in '[Source entry id: ...]' labels; never invent ids."
      })
    }),
    {
      description: "Batch of new observations. May be empty only if the tool is not called at all."
    }
  )
});
function joinOrEmpty2(items) {
  return items.length ? items.join("\n") : "(none yet)";
}
function normalizeSourceEntryIds(sourceEntryIds, allowedSourceEntryIds) {
  if (!sourceEntryIds || sourceEntryIds.length === 0) return void 0;
  const allowedOrder = /* @__PURE__ */ new Map();
  for (let i = 0; i < allowedSourceEntryIds.length; i++)
    allowedOrder.set(allowedSourceEntryIds[i], i);
  const seen = /* @__PURE__ */ new Set();
  const valid = [];
  for (const id of sourceEntryIds) {
    if (!allowedOrder.has(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    valid.push(id);
  }
  if (valid.length === 0) return void 0;
  return valid.sort((a, b) => (allowedOrder.get(a) ?? 0) - (allowedOrder.get(b) ?? 0));
}
async function runObserver(args) {
  const {
    model,
    apiKey,
    headers,
    priorReflections,
    priorObservations,
    chunk,
    allowedSourceEntryIds,
    signal
  } = args;
  const conversation = chunk.trim();
  if (!conversation) return { observations: void 0 };
  const accumulated = /* @__PURE__ */ new Map();
  let toolCalled = false;
  let totalAdded = 0;
  let totalDuplicates = 0;
  let totalRejected = 0;
  let totalProposed = 0;
  const recordObservations = {
    name: "record_observations",
    label: "Record observations",
    description: "Record a batch of new observations distilled from the conversation chunk. Call this multiple times as you work through the chunk. Stop calling when coverage is complete, then emit a short plain-text confirmation to end the run.",
    parameters: RecordObservationsSchema,
    execute: async (_id, params) => {
      toolCalled = true;
      let added = 0;
      let duplicates = 0;
      let rejected = 0;
      for (const obs of params.observations) {
        totalProposed++;
        const sourceEntryIds = normalizeSourceEntryIds(obs.sourceEntryIds, allowedSourceEntryIds);
        if (!sourceEntryIds) {
          rejected++;
          continue;
        }
        const content = truncateRecordContent(obs.content);
        const id = hashId(content);
        if (accumulated.has(id)) {
          duplicates++;
          continue;
        }
        accumulated.set(id, {
          id,
          content,
          timestamp: obs.timestamp,
          relevance: obs.relevance,
          sourceEntryIds,
          tokenCount: estimateStringTokens(content)
        });
        added++;
      }
      totalAdded += added;
      totalDuplicates += duplicates;
      totalRejected += rejected;
      const rejectedPart = rejected > 0 ? ` ${rejected} observation${rejected === 1 ? "" : "s"} rejected for missing or invalid sourceEntryIds.` : "";
      const ack = `Recorded ${added} new observation${added === 1 ? "" : "s"} ` + (duplicates > 0 ? `(${duplicates} duplicate${duplicates === 1 ? "" : "s"} skipped).` : ".") + rejectedPart + ` Total so far this run: ${accumulated.size}. Continue if the chunk still has uncovered content; otherwise stop calling the tool and emit a short plain-text confirmation.`;
      return {
        content: [{ type: "text", text: ack }],
        details: { added, duplicates, rejected, total: accumulated.size }
      };
    }
  };
  const now = nowTimestamp();
  const userText = `Current local time: ${now}

CURRENT REFLECTIONS:
${joinOrEmpty2(priorReflections)}

CURRENT OBSERVATIONS:
${joinOrEmpty2(priorObservations)}

Compress the following new conversation chunk into observations by calling record_observations one or more times. Do not restate facts already present in current reflections or current observations. Prefer inline conversation timestamps when assigning times; fall back to the current local time above only if no message timestamp applies. Stop calling the tool and reply with a short plain-text confirmation once the chunk is fully covered.

NEW CONVERSATION CHUNK:
${conversation}`;
  const prompts = [
    {
      role: "user",
      content: [{ type: "text", text: userText }],
      timestamp: Date.now()
    }
  ];
  const context = {
    systemPrompt: OBSERVER_SYSTEM,
    messages: [],
    tools: [recordObservations]
  };
  const reasoning = model.reasoning;
  const thinkingLevel = args.thinkingLevel ?? "low";
  const effectiveMaxTurns = args.maxTurns && args.maxTurns > 0 ? args.maxTurns : void 0;
  let turnCount = 0;
  const providerFetch = createProviderFetch(args.providerIdleTimeoutMs);
  const config2 = {
    model,
    apiKey,
    headers,
    ...providerFetch ? { fetch: providerFetch } : {},
    maxTokens: boundedMaxTokens(model, AGENT_LOOP_MAX_TOKENS),
    convertToLlm: (msgs) => msgs,
    toolExecution: "sequential",
    ...reasoning && thinkingLevel !== "off" ? { reasoning: thinkingLevel } : {},
    ...effectiveMaxTurns !== void 0 ? {
      shouldStopAfterTurn: () => {
        turnCount++;
        return turnCount >= effectiveMaxTurns;
      }
    } : {}
  };
  const loop = args.agentLoop ?? agentLoop;
  const bridgeStreamFn = createBridgeStreamFn(streamSimple);
  const streamFn = args.streamFn ?? bridgeStreamFn;
  const stream = loop(prompts, context, config2, signal, streamFn);
  let agentError;
  for await (const event of stream) {
    if (event.type === "agent_end") {
      const msgs = event.messages || [];
      const lastMsg = msgs[msgs.length - 1];
      if (lastMsg?.stopReason === "error") {
        agentError = lastMsg.errorMessage ?? "Unknown API error";
      }
    }
  }
  await stream.result();
  if (agentError && accumulated.size === 0) {
    throw new Error(`Observer API error: ${agentError}`);
  }
  if (accumulated.size === 0) {
    let emptyReason;
    if (!toolCalled) {
      emptyReason = { kind: "tool_not_called" };
    } else if (totalRejected > 0 && totalAdded === 0) {
      emptyReason = { kind: "all_rejected", count: totalRejected };
    } else if (totalDuplicates > 0 && totalAdded === 0) {
      emptyReason = { kind: "all_duplicates", count: totalDuplicates };
    } else if (totalProposed === 0) {
      emptyReason = { kind: "empty_array", count: 0 };
    } else {
      emptyReason = { kind: "no_new_content" };
    }
    return { observations: void 0, emptyReason };
  }
  return { observations: Array.from(accumulated.values()) };
}

// src/om/agents/reflector/prompts.ts
var REFLECTOR_SYSTEM = `You are the reflection agent for a coding assistant.

These records are the ONLY information the assistant will have about past interactions once the raw conversation is compacted out of context. Anything you fail to preserve may be forgotten. Anything you distort may be remembered wrong. Take this seriously. Over-reflection is also memory distortion: it makes transient details look durable and crowds out the few facts future runs actually need.

Your task is different from the observer's: you are not recording events, you are distilling stable, long-lived facts and patterns from active observations into new reflections by calling record_reflections. Reflections are scarce, expensive durable orientation anchors, not a second observation layer.

You receive:
- Current reflections: durable facts already crystallized.
- Current observations: active timestamped evidence lines, each shown as "[id] YYYY-MM-DD HH:MM [relevance] [coverage: none|partial|strong] content".
- Coverage tiers are review context: none means no current reflection supports the observation id, partial means exactly one current reflection supports it, and strong means two or more current reflections support it. Coverage is not a quota, target, priority score, or instruction to emit reflections.

What to emit:
- Emit only new durable reflections not already present in current reflections.
- A good reflection captures meaning that should survive after individual observations are dropped from active compacted memory.
- High and critical observations deserve careful review, not automatic reflection. Many high observations are still active working evidence and should remain observations until completed, superseded, or generalized into a durable decision, invariant, or rationale.
- Ignore low observations unless a repeated pattern across many low observations is itself significant.
- Do not lightly reword existing reflections. Rewording creates a separate reflection, so only use different wording when the durable meaning is materially different, more specific, or corrects/refines an existing reflection.
- Do not emit update-style records or provenance metadata. Reflections are plain durable facts, not patches.
- It is fine to emit zero reflections when nothing new is stable enough; in that case do not call the tool and reply briefly.

Decision procedure:
1. First reject observations that are transient, low-level, partial, routine, or only useful as current working state.
2. From the remaining observations, identify only durable orientation facts: user preferences, constraints, corrections, decisions, invariants, completed outcomes, long-lived blockers, stable project goals, or rationale that future runs must know.
3. Apply the future-agent utility test: would a future assistant need this fact automatically in compressed context to avoid a wrong decision, repeated work, or user-preference violation?
4. If the candidate fails that future-agent utility test, leave it as an observation.
5. If unsure, emit no reflection.

Abstraction gate:
- Do not turn each observation into a reflection. Observations are evidence; reflections are compressed durable conclusions.
- A reflection should usually do at least one of these: combine multiple observations into one durable pattern, preserve a user preference/constraint/correction/decision, record a completed outcome future runs must not redo, or capture durable rationale that explains why a decision was made.
- Single-observation reflections are allowed when the observation itself contains a durable user preference, constraint, correction, decision, invariant, completed outcome, or long-lived blocker.
- Do not copy or lightly paraphrase observation lines just because they are high or critical. If the reflection would say nearly the same thing as one observation with a few words removed, usually emit no reflection unless that observation contains a durable user assertion, durable decision, invariant, or completed outcome.
- Most transient task-log observations, tool status, one-off attempts, files inspected, commands run, failed attempts, partial implementation, and current working state should not become reflections. Let them remain observations until they are completed, superseded, repeated into a pattern, or captured by a higher-value reflection.
- Prefer fewer, higher-value reflections. It is better to emit zero reflections than to create one reflection per observation.

Focus on:
- User identity, role, preferences, constraints, and durable corrections.
- Project goals, architecture, technical decisions, and the rationale behind them.
- Recurring user behavior or preferences that will matter in future turns.
- Completed outcomes future runs must not redo.
- Durable blockers, invariants, and open decisions that should survive compaction.

Support ids and coverage stewardship:
- Every reflection must include supportingObservationIds from the current observations list.
- First decide whether the reflection content passes the durable-value bar. Then audit support ids for that already-worthy reflection.
- supportingObservationIds are a coverage/provenance set and downstream dropper coverage evidence: include all current observation ids whose durable meaning is preserved by the reflection with equivalent fidelity and can later be treated as redundant active-memory detail.
- supportingObservationIds are not a checklist to cover every observation. Do not add ids merely to improve coverage counts, maximize support ids, maximize strong coverage, or unlock the dropper.
- False or inflated support ids can cause unsafe downstream dropper pruning, including removal of high-resistance active observations whose meaning was not actually preserved.
- Include additional observation ids only when the reflection preserves their durable meaning with equivalent fidelity.
- Leave observations unsupported when their details are still active working state, too specific to compress safely, or not yet durable enough.
- Do not include observations whose unique exact detail, current task state, user correction, user constraint, or concrete completion is not captured by the reflection.
- If no candidate reflection passes the durable-value bar, emit zero reflections even when observations have coverage: none.
- Never invent observation ids. Proposals with missing, empty, or invalid supportingObservationIds are rejected.

User assertions are authoritative. If the observation pool contains both "User stated they use Postgres" and a later "User asked which db they are on", the assertion answers the question \u2014 crystallize the assertion, never the question, as the durable fact.

Reflection content rules:
- Single line of plain prose. No markdown, no bullets, no code fences, no XML/HTML tags, no emojis.
- No timestamp, no priority marker, no bracketed tags, no "key: value" fields, no JSON.
- Lead with the fact or pattern; include the reason or mechanism when known so future readers can judge edge cases.
- Preserve user assertions exactly. Use the user's exact words when non-standard.
- Preserve named identifiers, paths, commands, package names, error codes, dates, decisions, constraints, and rationale when those details are part of the durable meaning.

Examples:
- BAD: User discussed databases.
- GOOD: User stated they use Postgres for the project database.
- BAD: User asked about database setup.
- GOOD: User stated they use Postgres for the project database.
- BAD: User ran npm test and it failed.
- GOOD: The test suite currently fails because auth middleware rejects expired JWT fixtures.
- BAD: User prefers React Query.
- BAD: User switched from SWR.
- GOOD: User chose React Query over SWR for server-state caching.
- BAD: completed: edited src/hooks/reflect-drop-trigger.ts.
- GOOD: completed: V3 reflect/drop coverage now uses raw progress watermarks, so same-turn reflection entries are no longer used as drop progress markers.
- BAD: npm test passed.
- GOOD: completed: V3 package namespace migration passed full tests and typecheck.
- BAD: Observation aaaaaaaaaaaa says the user likes short answers.
- GOOD: User prefers short answers without generic summaries.
- ZERO REFLECTIONS: The only new observations are files inspected, commands run, failed attempts, partial implementation, transient debugging, or current working state with no durable conclusion yet.
- ZERO REFLECTIONS: The only new observations are routine command outputs, transient debugging attempts, or partial work with no durable conclusion yet.`;

// src/om/agents/reflector/agent.ts
var RecordReflectionsSchema = Type.Object({
  reflections: Type.Array(
    Type.Object({
      content: Type.String({ minLength: 1 }),
      supportingObservationIds: Type.Array(Type.String({ minLength: 1 }), {
        minItems: 1
      })
    }),
    { minItems: 1 }
  )
});
function joinOrEmpty3(items) {
  return items.length ? items.join("\n") : "(none yet)";
}
function normalizeSupportingObservationIds(supportingObservationIds, allowedObservationIds) {
  if (!supportingObservationIds || supportingObservationIds.length === 0) return void 0;
  const allowedOrder = /* @__PURE__ */ new Map();
  for (let i = 0; i < allowedObservationIds.length; i++) {
    if (!allowedOrder.has(allowedObservationIds[i])) allowedOrder.set(allowedObservationIds[i], i);
  }
  const seen = /* @__PURE__ */ new Set();
  for (const id of supportingObservationIds) {
    if (!allowedOrder.has(id)) return void 0;
    seen.add(id);
  }
  if (seen.size === 0) return void 0;
  return Array.from(seen).sort((a, b) => (allowedOrder.get(a) ?? 0) - (allowedOrder.get(b) ?? 0));
}
function normalizeReflectionContent(content) {
  const normalized = truncateRecordContent(content.trim());
  if (!normalized || /\r|\n/.test(normalized)) return void 0;
  return normalized;
}
async function runReflector(args) {
  const { model, apiKey, headers, reflections, observations, signal } = args;
  if (observations.length === 0) return void 0;
  const allowedObservationIds = observations.map((observation) => observation.id);
  const existingReflectionIds = new Set(reflections.map((reflection) => reflection.id));
  const accumulated = /* @__PURE__ */ new Map();
  const recordReflections = {
    name: "record_reflections",
    label: "Record reflections",
    description: "Record new durable reflections with supporting observation ids.",
    parameters: RecordReflectionsSchema,
    execute: async (_id, params) => {
      let added = 0;
      let duplicates = 0;
      let rejected = 0;
      for (const proposal of params.reflections) {
        const content = normalizeReflectionContent(proposal.content);
        const supportingObservationIds = normalizeSupportingObservationIds(
          proposal.supportingObservationIds,
          allowedObservationIds
        );
        if (!content || !supportingObservationIds) {
          rejected++;
          continue;
        }
        const id = hashId(content);
        if (existingReflectionIds.has(id) || accumulated.has(id)) {
          duplicates++;
          continue;
        }
        accumulated.set(id, {
          id,
          content,
          supportingObservationIds,
          tokenCount: estimateStringTokens(content)
        });
        added++;
      }
      return {
        content: [
          {
            type: "text",
            text: `Recorded ${added} reflection${added === 1 ? "" : "s"}; ${duplicates} duplicate${duplicates === 1 ? "" : "s"}; ${rejected} rejected. Total this run: ${accumulated.size}.`
          }
        ],
        details: { added, duplicates, rejected, total: accumulated.size }
      };
    }
  };
  const existingReflectionsContext = args.existingReflectionsSummary ? `EXISTING REFLECTIONS (for context only \u2014 do NOT re-process these):
${args.existingReflectionsSummary}

` : "";
  const existingObservationsContext = args.existingObservationsSummary ? `EXISTING OBSERVATIONS (for context only \u2014 do NOT re-process these):
${args.existingObservationsSummary}

` : "";
  const userText = `${existingReflectionsContext}${existingObservationsContext}NEW REFLECTIONS TO PROCESS:
${joinOrEmpty3(reflections.map(reflectionToSummaryLine))}

NEW OBSERVATIONS TO PROCESS:
${joinOrEmpty3(observations.map(observationToSummaryLine))}

Crystallize any missing durable facts or patterns into new reflections. If nothing is stable enough, do not call the tool.`;
  const prompts = [
    {
      role: "user",
      content: [{ type: "text", text: userText }],
      timestamp: Date.now()
    }
  ];
  const context = {
    systemPrompt: REFLECTOR_SYSTEM,
    messages: [],
    tools: [recordReflections]
  };
  const reasoning = model.reasoning;
  const thinkingLevel = args.thinkingLevel ?? "low";
  const effectiveMaxTurns = args.maxTurns && args.maxTurns > 0 ? args.maxTurns : void 0;
  let turnCount = 0;
  const providerFetch = createProviderFetch(args.providerIdleTimeoutMs);
  const config2 = {
    model,
    apiKey,
    headers,
    ...providerFetch ? { fetch: providerFetch } : {},
    maxTokens: boundedMaxTokens(model, AGENT_LOOP_MAX_TOKENS),
    convertToLlm: (msgs) => msgs,
    toolExecution: "sequential",
    ...reasoning && thinkingLevel !== "off" ? { reasoning: thinkingLevel } : {},
    ...effectiveMaxTurns !== void 0 ? { shouldStopAfterTurn: () => ++turnCount >= effectiveMaxTurns } : {}
  };
  const loop = args.agentLoop ?? agentLoop;
  const bridgeStreamFn = createBridgeStreamFn(streamSimple);
  const streamFn = args.streamFn ?? bridgeStreamFn;
  const stream = loop(prompts, context, config2, signal, streamFn);
  let agentError;
  for await (const event of stream) {
    if (event.type === "agent_end") {
      const msgs = event.messages || [];
      const lastMsg = msgs[msgs.length - 1];
      if (lastMsg?.stopReason === "error") {
        agentError = lastMsg.errorMessage ?? "Unknown API error";
      }
    }
  }
  await stream.result();
  if (agentError && accumulated.size === 0) throw new Error(`Reflector API error: ${agentError}`);
  return accumulated.size > 0 ? Array.from(accumulated.values()) : void 0;
}

// src/om/retryable-error.ts
var RETRYABLE_ERROR_RE = /overloaded|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|connection.?lost|websocket.?closed|websocket.?error|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|ended without|http2 request did not get a response|timed? out|timeout|terminated|retry delay/i;
function isRetryableError(error) {
  const message = error instanceof Error ? error.message : String(error || "");
  return RETRYABLE_ERROR_RE.test(message);
}
function isStaleExtensionContextError2(error) {
  let message;
  if (error instanceof Error) {
    message = error.message;
  } else if (error && typeof error === "object" && "message" in error) {
    message = String(error.message);
  } else {
    message = String(error || "");
  }
  return message.includes("extension ctx is stale") || message.includes("ctx is stale");
}

// src/om/consolidation.ts
var AGENT_LOOP_RESERVE = 8e3;
var MAX_STAGE_ATTEMPTS = 10;
function sourceEntriesAfter(entries, index) {
  return entries.slice(index + 1).filter(isSourceEntry);
}
function capSourceEntriesToTokens(entries, maxTokens) {
  let totalTokens = 0;
  const kept = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    let chars = 0;
    if (entry.type === "message" && entry.message) {
      const msg = entry.message;
      if (typeof msg.content === "string") chars = msg.content.length;
      else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.text) chars += block.text.length;
        }
      }
    } else if (entry.type === "custom" && (entry.customType === OM_OBSERVATIONS_RECORDED || entry.customType === OM_REFLECTIONS_RECORDED || entry.customType === OM_OBSERVATIONS_DROPPED)) {
      chars = String(JSON.stringify(entry.data ?? {})).length;
    } else if (entry.summary) {
      chars = String(entry.summary).length;
    }
    const estTokens = Math.ceil(chars / 4);
    if (totalTokens + estTokens > maxTokens && kept.length > 0) break;
    if (totalTokens + estTokens > maxTokens && kept.length === 0) {
      kept.unshift(entry);
      break;
    }
    kept.unshift(entry);
    totalTokens += estTokens;
  }
  return kept;
}
function appendEntry(pi, customType, data) {
  pi.appendEntry(customType, data);
}
function mergeReflections(existing, additional) {
  const seen = new Set(existing.map((reflection) => reflection.id));
  const merged = [...existing];
  for (const reflection of additional) {
    if (seen.has(reflection.id)) continue;
    seen.add(reflection.id);
    merged.push(reflection);
  }
  return merged;
}
function pendingObservationsCreatedAfter(pending, entries, afterCoversUpToId) {
  const batches = pending.observationBatches ?? [];
  if (!afterCoversUpToId || entryIndexForId(entries, afterCoversUpToId) < 0) {
    return batches.flatMap((b) => b.data?.observations ?? []);
  }
  const afterIdx = entryIndexForId(entries, afterCoversUpToId);
  const newObs = [];
  for (const batch of batches) {
    const batchIdx = entryIndexForId(entries, batch.coversUpToId);
    if (batchIdx >= 0 && batchIdx > afterIdx) {
      newObs.push(...batch.data?.observations ?? []);
    }
  }
  return newObs;
}
function anyStageDue(entries, runtime, pending) {
  const config2 = runtime.config;
  const cursors = runtime.cursors ?? {};
  const observerDue = (() => {
    const cursor = cursors.observer;
    if (!cursor) {
      return rawTokensSinceObservationCoverage(entries) >= config2.observeAfterTokens;
    }
    const idx = entryIndexForId(entries, cursor.entryId);
    const tokensSince = idx >= 0 ? rawTokensAfterIndex(entries, idx) : rawTokensSinceObservationCoverage(entries);
    return tokensSince >= config2.observeAfterTokens;
  })();
  const reflectorDue = (() => {
    const cursor = cursors.reflector;
    if (!cursor) {
      return rawTokensSinceReflectionCoverage(entries) >= config2.reflectAfterTokens;
    }
    const idx = entryIndexForId(entries, cursor.entryId);
    if (idx < 0) {
      return rawTokensSinceReflectionCoverage(entries) >= config2.reflectAfterTokens;
    }
    const tokensSince = rawTokensAfterIndex(entries, idx);
    if (tokensSince < config2.reflectAfterTokens) {
      return false;
    }
    for (let i = idx + 1; i < entries.length; i++) {
      const e = entries[i];
      if (e.type === "custom" && e.customType === OM_OBSERVATIONS_RECORDED) {
        const markerCoversUpTo = e.data?.coversUpToId;
        if (markerCoversUpTo) {
          const markerCoversIdx = entryIndexForId(entries, markerCoversUpTo);
          if (markerCoversIdx >= 0 && markerCoversIdx <= idx) continue;
        }
        return true;
      }
    }
    if (pending) {
      const pendingBatches = pending.observationBatches ?? [];
      for (const batch of pendingBatches) {
        if (batch.coversUpToId) {
          const batchIdx = entryIndexForId(entries, batch.coversUpToId);
          if (batchIdx >= 0 && batchIdx > idx) return true;
        }
      }
    }
    return false;
  })();
  const dropperDue = observerDue || reflectorDue ? false : (() => {
    const folded = foldLedger(entries);
    let poolTokens = folded.activeObservations.reduce(
      (s, o) => s + (o.tokenCount ?? 0),
      0
    );
    if (pending) {
      const pendingBatches = pending.observationBatches ?? [];
      for (const batch of pendingBatches) {
        poolTokens += (batch.data?.observations ?? []).reduce(
          (s, o) => s + (o.tokenCount ?? 0),
          0
        );
      }
    }
    const fullnessVsPool = config2.observationsPoolMaxTokens > 0 ? poolTokens / config2.observationsPoolMaxTokens : 0;
    if (fullnessVsPool < (config2.dropperPoolFullnessThreshold ?? 0.1)) return false;
    const pressure = poolTokens >= config2.dropperPressureThreshold * config2.reflectorInputMaxTokens;
    if (pressure) return true;
    const cursor = cursors.dropper;
    if (!cursor) {
      const hasPendingNewData = pending ? (pending.observationBatches?.length ?? 0) > 0 || (pending.reflectionBatches?.length ?? 0) > 0 : false;
      if (hasPendingNewData) return true;
      return rawTokensSinceDropCoverage(entries) >= config2.reflectAfterTokens;
    }
    const idx = entryIndexForId(entries, cursor.entryId);
    if (idx < 0) {
      return rawTokensSinceDropCoverage(entries) >= config2.reflectAfterTokens;
    }
    const tokensSince = rawTokensAfterIndex(entries, idx);
    if (tokensSince < config2.reflectAfterTokens) {
      return false;
    }
    for (let i = idx + 1; i < entries.length; i++) {
      const e = entries[i];
      if (e.type === "custom" && (e.customType === OM_OBSERVATIONS_RECORDED || e.customType === OM_REFLECTIONS_RECORDED)) {
        const markerCoversUpTo = e.data?.coversUpToId;
        if (markerCoversUpTo) {
          const markerCoversIdx = entryIndexForId(entries, markerCoversUpTo);
          if (markerCoversIdx >= 0 && markerCoversIdx <= idx) continue;
        }
        return true;
      }
    }
    if (pending) {
      const pendingObs = pending.observationBatches ?? [];
      const pendingRef = pending.reflectionBatches ?? [];
      for (const batch of [...pendingObs, ...pendingRef]) {
        if (batch.coversUpToId) {
          const batchIdx = entryIndexForId(entries, batch.coversUpToId);
          if (batchIdx >= 0 && batchIdx > idx) return true;
        }
      }
    }
    return false;
  })();
  return observerDue || reflectorDue || dropperDue;
}
function resolveMemoryModelCandidates(ctx) {
  const current = ctx.model;
  const roles = [ctx.models.resolve("@smol"), ctx.models.resolve("@tiny")].filter(Boolean);
  const currentUsesMemoryRole = current && roles.some((model) => model.provider === current.provider && model.id === current.id);
  const ordered = currentUsesMemoryRole ? [current, ...roles] : [...roles, current];
  const seen = /* @__PURE__ */ new Set();
  return ordered.filter((model) => {
    if (!model) return false;
    const key = modelKey(model);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function stageThinkingLevel(runtime, stage, modelConfig) {
  return modelConfig?.thinking ?? "low";
}
function makeModelResolver(runtime, ctx) {
  return async (stage) => {
    const candidates = resolveMemoryModelCandidates(ctx);
    const resolved = await runtime.resolveModel({
      modelRegistry: ctx.modelRegistry,
      hasUI: ctx.hasUI,
      ui: ctx.ui,
      candidates
    });
    if (resolved.ok) {
      runtime.resolveFailureNotified = false;
      return resolved;
    }
    debugLog(`${stage}.model_unavailable`, { reason: resolved.reason });
    if (!runtime.resolveFailureNotified && ctx.hasUI && ctx.ui) {
      if (runtime.failedInCycle.size > 0 && resolved.reason.includes("all candidates exhausted")) {
        runtime.tryEmitInfo(
          true,
          ctx.ui,
          `Observational memory: ${stage} skipped \u2014 model unavailable (cooldown set to 0, smol/tiny role candidates exhausted, will retry next run)`
        );
      } else {
        ctx.ui.notify(`Observational memory: ${stage} skipped \u2014 ${resolved.reason}`, "warning");
      }
      runtime.resolveFailureNotified = true;
    }
    return void 0;
  };
}
function registerConsolidationTrigger(pi, runtime) {
  const launch = (_event, ctx) => {
    maybeLaunchConsolidation(pi, runtime, ctx);
  };
  pi.on("agent_start", launch);
  pi.on("turn_end", launch);
}
function validateCursors(entries, runtime) {
  const cursors = runtime.cursors ?? {};
  if (cursors.observer && entryIndexForId(entries, cursors.observer.entryId) < 0) {
    const markerId = latestCoverageMarkerId(entries, OM_OBSERVATIONS_RECORDED);
    if (markerId) {
      cursors.observer = { entryId: markerId, state: "initial" };
    } else {
      delete cursors.observer;
    }
  }
  if (cursors.reflector && entryIndexForId(entries, cursors.reflector.entryId) < 0) {
    const markerId = latestCoverageMarkerId(entries, OM_REFLECTIONS_RECORDED);
    if (markerId) {
      cursors.reflector = { entryId: markerId, state: "initial" };
    } else {
      delete cursors.reflector;
    }
  }
  if (cursors.dropper && entryIndexForId(entries, cursors.dropper.entryId) < 0) {
    const markerId = latestCoverageMarkerId(entries, OM_OBSERVATIONS_DROPPED);
    if (markerId) {
      cursors.dropper = { entryId: markerId, state: "initial" };
    } else {
      delete cursors.dropper;
    }
  }
}
function maybeLaunchConsolidation(pi, runtime, ctx) {
  runtime.ensureConfig(ctx.cwd, (msg) => ctx.ui?.notify?.(msg, "warning"));
  if (runtime.config.memory === false) return;
  if (matchesSkippedProvider(runtime.config, ctx.model)) return;
  if (runtime.config.compaction === void 0 && runtime.config.compactionEngine === void 0) {
    if (runtime.config.passive === true) return;
  }
  if (runtime.consolidationInFlight) return;
  if (runtime.isConsolidationRetryGated()) return;
  let sessionId;
  try {
    sessionId = ctx.sessionManager.getSessionId();
  } catch (error) {
    if (isStaleExtensionContextError2(error)) return;
    throw error;
  }
  if (runtime.cursorsLoadedSessionId !== sessionId) {
    if (typeof runtime.loadCursorsFromPending === "function") {
      runtime.loadCursorsFromPending(sessionId);
    }
    let entries2;
    try {
      entries2 = ctx.sessionManager.getBranch();
    } catch (error) {
      if (isStaleExtensionContextError2(error)) return;
      throw error;
    }
    validateCursors(entries2, runtime);
    runtime.cursorsLoadedSessionId = sessionId;
    const c = runtime.cursors ?? {};
    debugLog("cursor.loaded", {
      observer: c.observer ?? null,
      reflector: c.reflector ?? null,
      dropper: c.dropper ?? null
    });
  }
  let entries;
  try {
    entries = ctx.sessionManager.getBranch();
  } catch (error) {
    if (isStaleExtensionContextError2(error)) return;
    throw error;
  }
  const pending = isManualMode(runtime.config) ? readPendingState(sessionId) : void 0;
  if (!anyStageDue(entries, runtime, pending)) return;
  const runId = `consolidation-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
  const consolidationCtx = {
    cwd: ctx.cwd,
    hasUI: ctx.hasUI,
    ui: ctx.ui,
    model: ctx.model,
    modelRegistry: ctx.modelRegistry,
    sessionManager: ctx.sessionManager
  };
  void runtime.launchConsolidationTask(
    ctx,
    async () => withDebugLogContext(
      { enabled: runtime.config.debugLog === true, cwd: ctx.cwd, runId },
      async () => {
        await runConsolidationPipeline(pi, runtime, consolidationCtx);
      }
    )
  );
}
async function runConsolidationPipeline(pi, runtime, ctx) {
  const resolveModel = makeModelResolver(runtime, ctx);
  runtime.consolidationPhase = "observer";
  runtime.failedInCycle.clear();
  runtime.resolveFailureNotified = false;
  try {
    const observerOutcome = await runObserverStage(pi, runtime, ctx, resolveModel);
    if (observerOutcome === "abort") return;
  } catch (error) {
    debugLog("observer.error", {
      errorMessage: runtime.recordConsolidationStageError(ctx, "observer", error)
    });
    return;
  }
  runtime.consolidationPhase = "reflector";
  runtime.failedInCycle.clear();
  runtime.resolveFailureNotified = false;
  let reflectorResult;
  try {
    reflectorResult = await runReflectorStage(pi, runtime, ctx, resolveModel);
    if (reflectorResult.outcome === "abort") return;
  } catch (error) {
    debugLog("reflector.error", {
      errorMessage: runtime.recordConsolidationStageError(ctx, "reflector", error)
    });
    return;
  }
  runtime.consolidationPhase = "dropper";
  runtime.failedInCycle.clear();
  runtime.resolveFailureNotified = false;
  try {
    await runDropperStage(
      pi,
      runtime,
      ctx,
      resolveModel,
      reflectorResult.sameRunReflections,
      reflectorResult.effectiveReflectionCoverageId
    );
  } catch (error) {
    debugLog("dropper.error", {
      errorMessage: runtime.recordConsolidationStageError(ctx, "dropper", error)
    });
  }
  let sessionId;
  try {
    sessionId = ctx.sessionManager.getSessionId();
  } catch (error) {
    if (isStaleExtensionContextError2(error)) {
      debugLog("pipeline.stale_ctx", { error: String(error) });
      return;
    }
    throw error;
  }
  runtime.scheduleCursorFlush(sessionId);
  const c = runtime.cursors ?? {};
  debugLog("cursor.saved", {
    observer: c.observer ?? null,
    reflector: c.reflector ?? null,
    dropper: c.dropper ?? null
  });
}
async function runObserverStage(pi, runtime, ctx, resolveModel) {
  let entries;
  let sessionId;
  try {
    entries = ctx.sessionManager.getBranch();
    sessionId = ctx.sessionManager.getSessionId();
  } catch (error) {
    if (isStaleExtensionContextError2(error)) {
      debugLog("observer.stale_ctx", { error: String(error) });
      return "abort";
    }
    throw error;
  }
  const observerCursor = runtime.getCursor("observer");
  let effectiveStart;
  if (observerCursor) {
    const cursorIdx = entryIndexForId(entries, observerCursor.entryId);
    effectiveStart = cursorIdx >= 0 ? cursorIdx : latestCoverageIndex(entries, OM_OBSERVATIONS_RECORDED);
  } else {
    const lastCoverageIdx = latestCoverageIndex(entries, OM_OBSERVATIONS_RECORDED);
    effectiveStart = lastCoverageIdx >= 0 ? lastCoverageIdx : findLastCompactionIndex(entries);
  }
  const tokens = effectiveStart >= 0 ? rawTokensAfterIndex(entries, effectiveStart) : 0;
  if (tokens < runtime.config.observeAfterTokens) {
    const lastSourceId = [...entries].reverse().find((e) => isSourceEntry(e))?.id;
    if (lastSourceId) runtime.advanceCursor("observer", lastSourceId, "not_due");
    return "continue";
  }
  let chunkEntries = sourceEntriesAfter(entries, effectiveStart);
  const maxChunkTokens = runtime.config.observerChunkMaxTokens;
  if (tokens > maxChunkTokens) {
    chunkEntries = capSourceEntriesToTokens(chunkEntries, maxChunkTokens);
  }
  const coversUpToId = chunkEntries.at(-1)?.id;
  if (!coversUpToId) return "continue";
  const { text: chunk, sourceEntryIds } = serializeSourceAddressedBranchEntries(chunkEntries);
  if (!chunk.trim() || sourceEntryIds.length === 0) return "continue";
  const chunkTokens = Math.ceil(chunk.length / 4);
  const memory = fullProjection(entries);
  let priorReflections = memory.reflections.map(reflectionToSummaryLine);
  let priorObservations = memory.observations.map(observationToSummaryLine);
  if (isManualMode(runtime.config)) {
    const pendingCtx = readPendingState(sessionId);
    const accumulatedReflections = (pendingCtx.reflectionBatches ?? []).flatMap(
      (b) => b.data.reflections ?? []
    );
    const accumulatedObservations = (pendingCtx.observationBatches ?? []).flatMap(
      (b) => b.data.observations ?? []
    );
    const preambleMaxTokens = runtime.config.observerPreambleMaxTokens > 0 ? runtime.config.observerPreambleMaxTokens : Math.round(runtime.config.observerChunkMaxTokens * 0.3);
    const allObservations = [...memory.observations, ...accumulatedObservations];
    priorObservations = selectPriorObservations(allObservations, preambleMaxTokens).map(
      observationToSummaryLine
    );
    priorReflections = [
      ...priorReflections,
      ...accumulatedReflections.map(reflectionToSummaryLine)
    ];
  }
  if (isManualMode(runtime.config) && isObservationChunkPending(sessionId, coversUpToId)) {
    debugLog("observer.pending_skip", { coversUpToId, sessionId });
    return "continue";
  }
  for (let attempt = 0; attempt < MAX_STAGE_ATTEMPTS; attempt++) {
    const resolved = await resolveModel("observer");
    if (!resolved) return "abort";
    let effectiveTokens = tokens;
    if (isManualMode(runtime.config)) {
      const pending = readPendingState(sessionId);
      if (pending.observation?.coversUpToId) {
        const idx = entryIndexForId(entries, pending.observation.coversUpToId);
        if (idx >= 0) effectiveTokens = rawTokensAfterIndex(entries, idx);
      }
    }
    runtime.tryEmitInfo(
      ctx.hasUI,
      ctx.ui,
      `Observational memory: observer running on ~${chunkTokens.toLocaleString()}-token chunk (of ${effectiveTokens.toLocaleString()} accumulated)`
    );
    debugLog("observer.start", {
      tokens,
      coversUpToId,
      sourceEntryIds,
      sourceEntryCount: sourceEntryIds.length,
      priorReflections: priorReflections.length,
      priorObservations: priorObservations.length
    });
    const stageModelForThinking = runtime.findCandidateConfig(resolved.model, {
      candidates: resolveMemoryModelCandidates(ctx)
    });
    const effectiveObsCtx = effectiveContextWindow(resolved.model, stageModelForThinking);
    const observerEstimatedInput = chunkTokens + AGENT_LOOP_RESERVE;
    if (observerEstimatedInput > effectiveObsCtx) {
      debugLog("observer.context_window_exceeded", {
        estimatedInput: observerEstimatedInput,
        effectiveCtx: effectiveObsCtx,
        model: `${resolved.model.provider}/${resolved.model.id}`
      });
      runtime.recordRetryableError(
        stageModelForThinking,
        new Error(
          `context window ${effectiveObsCtx} too small for estimated input ${observerEstimatedInput}`
        ),
        "observer"
      );
      runtime.tryEmitInfo(
        ctx.hasUI,
        ctx.ui,
        `Observational memory: observer skipping ${resolved.model.provider}/${resolved.model.id} (context window ${effectiveObsCtx.toLocaleString()} too small for ~${observerEstimatedInput.toLocaleString()}-token input)`
      );
      continue;
    }
    try {
      const result = await runObserver({
        model: resolved.model,
        apiKey: resolved.apiKey,
        headers: resolved.headers,
        priorReflections,
        priorObservations,
        chunk,
        allowedSourceEntryIds: sourceEntryIds,
        maxTurns: runtime.config.agentMaxTurns,
        thinkingLevel: stageThinkingLevel(runtime, "observer", stageModelForThinking),
        providerIdleTimeoutMs: runtime.config.providerIdleTimeoutMs
      });
      if (result.observations && result.observations.length > 0) {
        const data = buildObservationsRecordedData(result.observations, coversUpToId);
        if (!data) {
          runtime.advanceCursor("observer", coversUpToId, "empty");
          return "continue";
        }
        debugLog("observer.records", {
          count: result.observations.length,
          observationTokens: result.observations.reduce((s, o) => s + o.tokenCount, 0),
          coversUpToId
        });
        if (isManualMode(runtime.config)) {
          savePendingObservation(sessionId, { coversUpToId, data });
          debugLog("observer.pending", {
            count: result.observations.length,
            coversUpToId,
            sessionId
          });
        } else {
          appendEntry(pi, OM_OBSERVATIONS_RECORDED, data);
          debugLog("observer.appended", {
            count: result.observations.length,
            coversUpToId
          });
        }
        runtime.advanceCursor("observer", coversUpToId, "recorded");
        runtime.tryEmitInfo(
          ctx.hasUI,
          ctx.ui,
          `Observational memory: ${result.observations.length} observation${result.observations.length === 1 ? "" : "s"} recorded`
        );
        return "continue";
      }
      const reason = result.emptyReason;
      const reasonLabel = reason ? reason.kind === "tool_not_called" ? "model did not call the observation tool" : reason.kind === "all_rejected" ? `${reason.count} observation(s) rejected for invalid sourceEntryIds` : reason.kind === "all_duplicates" ? `${reason.count} observation(s) were duplicates of already-recorded entries` : reason.kind === "empty_array" ? "model called the tool but submitted an empty observations array" : "nothing new to record" : "unknown reason";
      const reasonLevel = reason ? reason.kind === "no_new_content" || reason.kind === "all_duplicates" ? "info" : "warning" : "warning";
      debugLog("observer.empty", { coversUpToId, reason: reason?.kind });
      runtime.advanceCursor("observer", coversUpToId, "empty");
      if (reasonLevel === "warning") {
        if (ctx.hasUI)
          ctx.ui?.notify(`Observational memory: no observations \u2014 ${reasonLabel}`, "warning");
      } else {
        runtime.tryEmitInfo(
          ctx.hasUI,
          ctx.ui,
          `Observational memory: no observations \u2014 ${reasonLabel}`
        );
      }
      return "continue";
    } catch (error) {
      if (isStaleExtensionContextError2(error)) {
        debugLog("observer.stale_ctx", { error: String(error) });
        return "abort";
      }
      const candidateConfig = runtime.findCandidateConfig(resolved.model, {
        candidates: resolveMemoryModelCandidates(ctx)
      });
      runtime.recordRetryableError(candidateConfig, error, "observer");
      debugLog("observer.error", {
        error: String(error),
        retryable: isRetryableError(error)
      });
      continue;
    }
  }
  runtime.recordConsolidationStageError(
    ctx,
    "observer",
    new Error("Observer: all model candidates exhausted")
  );
  return "abort";
}
async function runReflectorStage(pi, runtime, ctx, resolveModel) {
  let entries;
  let sessionId;
  try {
    entries = ctx.sessionManager.getBranch();
    sessionId = ctx.sessionManager.getSessionId();
  } catch (error) {
    if (isStaleExtensionContextError2(error)) {
      debugLog("reflector.stale_ctx", { error: String(error) });
      return { outcome: "abort", sameRunReflections: [] };
    }
    throw error;
  }
  let reflectionTokens = 0;
  let observationCoverageId;
  if (isManualMode(runtime.config)) {
    const pending = readPendingState(sessionId);
    const hasPendingObs = (pending.observationBatches ?? []).some(
      (b) => b.data?.observations?.length
    );
    if (!hasPendingObs) {
      runtime.advanceCursor("reflector", entries.at(-1)?.id ?? "unknown", "skipped");
      return { outcome: "continue", sameRunReflections: [] };
    }
    observationCoverageId = pending.observation?.coversUpToId;
    if (pending.reflection?.coversUpToId) {
      const obsIdx = entryIndexForId(entries, pending.observation?.coversUpToId ?? "");
      const refIdx = entryIndexForId(entries, pending.reflection.coversUpToId);
      if (obsIdx >= 0 && refIdx >= 0 && obsIdx <= refIdx) {
        runtime.advanceCursor("reflector", pending.reflection.coversUpToId, "skipped");
        return { outcome: "continue", sameRunReflections: [] };
      }
      if (refIdx >= 0) {
        reflectionTokens = rawTokensAfterIndex(entries, refIdx);
        if (reflectionTokens < runtime.config.reflectAfterTokens) {
          runtime.advanceCursor("reflector", pending.reflection.coversUpToId, "not_due");
          return { outcome: "continue", sameRunReflections: [] };
        }
      } else {
        reflectionTokens = rawTokensSinceObservationCoverage(entries);
      }
    } else {
      reflectionTokens = rawTokensSinceObservationCoverage(entries);
    }
  } else {
    reflectionTokens = rawTokensSinceReflectionCoverage(entries);
    if (reflectionTokens < runtime.config.reflectAfterTokens) {
      runtime.advanceCursor("reflector", entries.at(-1)?.id ?? "unknown", "not_due");
      return { outcome: "continue", sameRunReflections: [] };
    }
    observationCoverageId = latestCoverageMarkerId(entries, OM_OBSERVATIONS_RECORDED);
    if (!observationCoverageId) {
      runtime.advanceCursor("reflector", entries.at(-1)?.id ?? "unknown", "skipped");
      return { outcome: "continue", sameRunReflections: [] };
    }
  }
  for (let attempt = 0; attempt < MAX_STAGE_ATTEMPTS; attempt++) {
    const resolved = await resolveModel("reflector");
    if (!resolved) return { outcome: "abort", sameRunReflections: [] };
    const folded = foldLedger(entries);
    const pending = isManualMode(runtime.config) ? readPendingState(sessionId) : void 0;
    const lastReflectionIdx = pending ? -1 : latestCoverageIndex(entries, OM_REFLECTIONS_RECORDED);
    const newObservations = pending ? pendingObservationsCreatedAfter(pending, entries, pending.reflection?.coversUpToId) : observationsCreatedAfterIndex(entries, lastReflectionIdx);
    const newReflections = pending ? [] : reflectionsCreatedAfterIndex(entries, lastReflectionIdx);
    const newItemsTokens = Math.ceil(
      (newObservations.reduce((s, o) => s + o.content.length, 0) + newReflections.reduce((s, r) => s + r.content.length, 0)) / 4
    );
    const summaryBudget = Math.floor(runtime.config.reflectorInputMaxTokens * 0.15) * 2;
    const reflectorInputTokens = Math.min(
      newItemsTokens + summaryBudget,
      runtime.config.reflectorInputMaxTokens
    );
    let effectiveReflectionTokens = reflectionTokens;
    if (isManualMode(runtime.config)) {
      if (pending?.reflection?.coversUpToId) {
        const idx = entryIndexForId(entries, pending.reflection.coversUpToId);
        if (idx >= 0) effectiveReflectionTokens = rawTokensAfterIndex(entries, idx);
      }
    }
    debugLog("reflector.start", {
      tokens: effectiveReflectionTokens,
      inputTokens: reflectorInputTokens,
      newObsCount: newObservations.length,
      newRefCount: newReflections.length
    });
    runtime.tryEmitInfo(
      ctx.hasUI,
      ctx.ui,
      `Observational memory: reflector running (~${effectiveReflectionTokens.toLocaleString()} tokens accumulated, ~${reflectorInputTokens.toLocaleString()}-token input)`
    );
    const stageModelForThinking = runtime.findCandidateConfig(resolved.model, {
      candidates: resolveMemoryModelCandidates(ctx)
    });
    const effectiveRefCtx = effectiveContextWindow(resolved.model, stageModelForThinking);
    const reflectorEstimatedInput = reflectorInputTokens + AGENT_LOOP_RESERVE;
    if (reflectorEstimatedInput > effectiveRefCtx) {
      debugLog("reflector.context_window_exceeded", {
        estimatedInput: reflectorEstimatedInput,
        effectiveCtx: effectiveRefCtx,
        model: `${resolved.model.provider}/${resolved.model.id}`
      });
      runtime.recordRetryableError(
        stageModelForThinking,
        new Error(
          `context window ${effectiveRefCtx} too small for estimated input ${reflectorEstimatedInput}`
        ),
        "reflector"
      );
      runtime.tryEmitInfo(
        ctx.hasUI,
        ctx.ui,
        `Observational memory: reflector skipping ${resolved.model.provider}/${resolved.model.id} (context window ${effectiveRefCtx.toLocaleString()} too small for ~${reflectorEstimatedInput.toLocaleString()}-token input)`
      );
      continue;
    }
    try {
      const sourceReflections = pending ? [
        ...folded.reflections,
        ...(pending.reflectionBatches ?? []).flatMap(
          (b) => b.data?.reflections ?? []
        )
      ] : folded.reflections;
      const sourceObservations = pending ? [
        ...folded.activeObservations,
        ...(pending.observationBatches ?? []).flatMap(
          (b) => b.data?.observations ?? []
        )
      ] : folded.activeObservations;
      const existingReflectionsSummary = buildExistingReflectionsSummary(
        sourceReflections,
        Math.floor(runtime.config.reflectorInputMaxTokens * 0.15)
      );
      const existingObservationsSummary = buildExistingObservationsSummary(
        sourceObservations.filter((o) => !newObservations.some((no) => no.id === o.id)),
        Math.floor(runtime.config.reflectorInputMaxTokens * 0.15)
      );
      const reflections = await runReflector({
        model: resolved.model,
        apiKey: resolved.apiKey,
        headers: resolved.headers,
        reflections: newReflections,
        observations: newObservations,
        existingReflectionsSummary: existingReflectionsSummary || void 0,
        existingObservationsSummary: existingObservationsSummary || void 0,
        maxTurns: runtime.config.agentMaxTurns,
        thinkingLevel: stageThinkingLevel(runtime, "reflector", stageModelForThinking),
        providerIdleTimeoutMs: runtime.config.providerIdleTimeoutMs
      });
      if (!reflections || reflections.length === 0) {
        runtime.advanceCursor(
          "reflector",
          observationCoverageId ?? entries.at(-1)?.id ?? "unknown",
          "empty"
        );
        return { outcome: "continue", sameRunReflections: [] };
      }
      if (!observationCoverageId) {
        runtime.advanceCursor("reflector", entries.at(-1)?.id ?? "unknown", "empty");
        return { outcome: "continue", sameRunReflections: [] };
      }
      const data = buildReflectionsRecordedData(reflections, observationCoverageId);
      if (!data) {
        runtime.advanceCursor("reflector", observationCoverageId, "empty");
        return { outcome: "continue", sameRunReflections: [] };
      }
      if (isManualMode(runtime.config)) {
        savePendingReflection(sessionId, {
          coversUpToId: data.coversUpToId,
          data
        });
      } else {
        appendEntry(pi, OM_REFLECTIONS_RECORDED, data);
      }
      runtime.advanceCursor("reflector", data.coversUpToId, "recorded");
      return {
        outcome: "continue",
        sameRunReflections: reflections,
        effectiveReflectionCoverageId: data.coversUpToId
      };
    } catch (error) {
      if (isStaleExtensionContextError2(error)) {
        debugLog("reflector.stale_ctx", { error: String(error) });
        return { outcome: "abort", sameRunReflections: [] };
      }
      const candidateConfig = runtime.findCandidateConfig(resolved.model, {
        candidates: resolveMemoryModelCandidates(ctx)
      });
      runtime.recordRetryableError(candidateConfig, error, "reflector");
      debugLog("reflector.error", {
        error: String(error),
        retryable: isRetryableError(error)
      });
      continue;
    }
  }
  runtime.recordConsolidationStageError(
    ctx,
    "reflector",
    new Error("Reflector: all model candidates exhausted")
  );
  return { outcome: "abort", sameRunReflections: [] };
}
async function runDropperStage(pi, runtime, ctx, resolveModel, sameRunReflections, sameRunReflectionCoverageId) {
  let entries;
  let sessionId;
  try {
    entries = ctx.sessionManager.getBranch();
    sessionId = ctx.sessionManager.getSessionId();
  } catch (error) {
    if (isStaleExtensionContextError2(error)) {
      debugLog("dropper.stale_ctx", { error: String(error) });
      return "abort";
    }
    throw error;
  }
  let dropTokens = 0;
  let observationCoverageId;
  if (isManualMode(runtime.config)) {
    const pending = readPendingState(sessionId);
    const hasPendingObs = (pending.observationBatches ?? []).some(
      (b) => b.data?.observations?.length
    );
    if (!hasPendingObs) {
      runtime.advanceCursor("dropper", entries.at(-1)?.id ?? "unknown", "skipped");
      return "continue";
    }
    observationCoverageId = pending.observation?.coversUpToId;
    if (pending.dropped?.coversUpToId) {
      const obsIdx = entryIndexForId(entries, pending.observation?.coversUpToId ?? "");
      const dropIdx = entryIndexForId(entries, pending.dropped.coversUpToId);
      if (obsIdx >= 0 && dropIdx >= 0 && obsIdx <= dropIdx) {
        runtime.advanceCursor("dropper", pending.dropped.coversUpToId, "skipped");
        return "continue";
      }
      if (dropIdx >= 0) {
        dropTokens = rawTokensAfterIndex(entries, dropIdx);
        if (dropTokens < runtime.config.reflectAfterTokens) {
          runtime.advanceCursor("dropper", pending.dropped.coversUpToId, "not_due");
          return "continue";
        }
      } else {
        dropTokens = rawTokensSinceDropCoverage(entries);
      }
    } else {
      dropTokens = rawTokensSinceDropCoverage(entries);
    }
  } else {
    dropTokens = rawTokensSinceDropCoverage(entries);
    if (dropTokens < runtime.config.reflectAfterTokens) {
      runtime.advanceCursor("dropper", entries.at(-1)?.id ?? "unknown", "not_due");
      return "continue";
    }
    observationCoverageId = latestCoverageMarkerId(entries, OM_OBSERVATIONS_RECORDED);
    if (!observationCoverageId) {
      runtime.advanceCursor("dropper", entries.at(-1)?.id ?? "unknown", "skipped");
      return "continue";
    }
  }
  for (let attempt = 0; attempt < MAX_STAGE_ATTEMPTS; attempt++) {
    const resolved = await resolveModel("dropper");
    if (!resolved) return "abort";
    const folded = foldLedger(entries);
    const pending = isManualMode(runtime.config) ? readPendingState(sessionId) : void 0;
    const lastDropIdx = pending ? -1 : latestCoverageIndex(entries, OM_OBSERVATIONS_DROPPED);
    const newObservations = pending ? pendingObservationsCreatedAfter(pending, entries, pending.dropped?.coversUpToId) : observationsCreatedAfterIndex(entries, lastDropIdx);
    const dropperNewObsTokens = Math.ceil(
      newObservations.reduce((s, o) => s + o.content.length, 0) / 4
    );
    const dropperSummaryBudget = Math.floor(runtime.config.dropperInputMaxTokens * 0.2);
    const dropperInputTokens = Math.min(
      dropperNewObsTokens + dropperSummaryBudget,
      runtime.config.dropperInputMaxTokens
    );
    let effectiveDropTokens = dropTokens;
    if (isManualMode(runtime.config)) {
      if (pending?.dropped?.coversUpToId) {
        const idx = entryIndexForId(entries, pending.dropped.coversUpToId);
        if (idx >= 0) effectiveDropTokens = rawTokensAfterIndex(entries, idx);
      }
    }
    runtime.tryEmitInfo(
      ctx.hasUI,
      ctx.ui,
      `Observational memory: dropper running (~${effectiveDropTokens.toLocaleString()} tokens accumulated, ~${dropperInputTokens.toLocaleString()}-token input)`
    );
    try {
      const sourceObsForDropper = pending ? [
        ...folded.activeObservations,
        ...(pending.observationBatches ?? []).flatMap(
          (b) => b.data?.observations ?? []
        )
      ] : folded.activeObservations;
      const existingObservationsSummary = buildExistingObservationsSummary(
        sourceObsForDropper.filter((o) => !newObservations.some((no) => no.id === o.id)),
        Math.floor(runtime.config.dropperInputMaxTokens * 0.2)
      );
      const pendingReflections = pending ? [
        ...folded.reflections,
        ...(pending.reflectionBatches ?? []).flatMap(
          (b) => b.data?.reflections ?? []
        )
      ] : folded.reflections;
      const reflectionsForDropper = mergeReflections(pendingReflections, sameRunReflections);
      const stageModelForThinking = runtime.findCandidateConfig(resolved.model, {
        candidates: resolveMemoryModelCandidates(ctx)
      });
      const effectiveDropCtx = effectiveContextWindow(resolved.model, stageModelForThinking);
      const dropperEstimatedInput = dropperInputTokens + AGENT_LOOP_RESERVE;
      if (dropperEstimatedInput > effectiveDropCtx) {
        debugLog("dropper.context_window_exceeded", {
          estimatedInput: dropperEstimatedInput,
          effectiveCtx: effectiveDropCtx,
          model: `${resolved.model.provider}/${resolved.model.id}`
        });
        runtime.recordRetryableError(
          stageModelForThinking,
          new Error(
            `context window ${effectiveDropCtx} too small for estimated input ${dropperEstimatedInput}`
          ),
          "dropper"
        );
        runtime.tryEmitInfo(
          ctx.hasUI,
          ctx.ui,
          `Observational memory: dropper skipping ${resolved.model.provider}/${resolved.model.id} (context window ${effectiveDropCtx.toLocaleString()} too small for ~${dropperEstimatedInput.toLocaleString()}-token input)`
        );
        continue;
      }
      const droppedIds = await runDropper({
        model: resolved.model,
        apiKey: resolved.apiKey,
        headers: resolved.headers,
        reflections: reflectionsForDropper,
        observations: newObservations,
        existingObservationsSummary: existingObservationsSummary || void 0,
        budgetTokens: runtime.config.observationsPoolMaxTokens,
        skipFullness: runtime.config.dropperPoolFullnessThreshold,
        maxTurns: runtime.config.agentMaxTurns,
        thinkingLevel: stageThinkingLevel(runtime, "dropper", stageModelForThinking),
        providerIdleTimeoutMs: runtime.config.providerIdleTimeoutMs
      });
      const latestReflectionCoverageId = isManualMode(runtime.config) ? pending?.reflection?.coversUpToId : latestCoverageMarkerId(entries, OM_REFLECTIONS_RECORDED);
      const effectiveReflectionCoverageId = sameRunReflectionCoverageId ?? latestReflectionCoverageId;
      const coversUpToId = earlierCoverageMarkerId(
        entries,
        observationCoverageId,
        effectiveReflectionCoverageId
      );
      const data = coversUpToId && droppedIds ? buildObservationsDroppedData(droppedIds, coversUpToId) : void 0;
      if (data && coversUpToId) {
        if (isManualMode(runtime.config)) {
          savePendingDropped(sessionId, { coversUpToId, data });
        } else {
          appendEntry(pi, OM_OBSERVATIONS_DROPPED, data);
        }
        runtime.advanceCursor("dropper", coversUpToId, "recorded");
      } else {
        runtime.advanceCursor(
          "dropper",
          coversUpToId ?? observationCoverageId ?? entries.at(-1)?.id ?? "unknown",
          "empty"
        );
      }
      return "continue";
    } catch (error) {
      if (isStaleExtensionContextError2(error)) {
        debugLog("dropper.stale_ctx", { error: String(error) });
        return "abort";
      }
      const candidateConfig = runtime.findCandidateConfig(resolved.model, {
        candidates: resolveMemoryModelCandidates(ctx)
      });
      runtime.recordRetryableError(candidateConfig, error, "dropper");
      debugLog("dropper.error", {
        error: String(error),
        retryable: isRetryableError(error)
      });
      continue;
    }
  }
  runtime.recordConsolidationStageError(
    ctx,
    "dropper",
    new Error("Dropper: all model candidates exhausted")
  );
  return "abort";
}
var REGISTRY_KEY = /* @__PURE__ */ Symbol.for("pi-blackhole:inline-compaction-adapter:v1");
var InlineCompactionUnavailableError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "InlineCompactionUnavailableError";
  }
};
function getRegistry() {
  const host = globalThis;
  const existing = host[REGISTRY_KEY];
  if (existing) {
    existing.hostCandidateCount ??= 0;
    existing.capturedSessionCount ??= 0;
    return existing;
  }
  const registry = {
    installs: /* @__PURE__ */ new WeakMap(),
    sessions: /* @__PURE__ */ new WeakMap(),
    refreshInstalled: /* @__PURE__ */ new WeakSet(),
    refreshPending: /* @__PURE__ */ new WeakSet(),
    compactionInFlight: /* @__PURE__ */ new WeakSet(),
    hostCandidateCount: 0,
    capturedSessionCount: 0
  };
  host[REGISTRY_KEY] = registry;
  return registry;
}
function maskNonCodeText(source) {
  const masked = source.split("");
  const blank = (position) => {
    if (masked[position] !== "\n" && masked[position] !== "\r") {
      masked[position] = " ";
    }
  };
  const maskQuoted = (start, delimiter) => {
    let index2 = start;
    blank(index2++);
    while (index2 < source.length) {
      const value = source[index2];
      blank(index2++);
      if (value === "\\" && index2 < source.length) {
        blank(index2++);
        continue;
      }
      if (value === delimiter) break;
    }
    return index2;
  };
  const maskLineComment = (start) => {
    let index2 = start;
    blank(index2++);
    blank(index2++);
    while (index2 < source.length && source[index2] !== "\n") blank(index2++);
    return index2;
  };
  const maskBlockComment = (start) => {
    let index2 = start;
    blank(index2++);
    blank(index2++);
    while (index2 < source.length) {
      const value = source[index2];
      const next = source[index2 + 1];
      blank(index2++);
      if (value === "*" && next === "/") {
        blank(index2++);
        break;
      }
    }
    return index2;
  };
  function maskTemplateExpression(start) {
    let index2 = start;
    let braceDepth = 1;
    while (index2 < source.length && braceDepth > 0) {
      const current = source[index2];
      const next = source[index2 + 1];
      if (current === '"' || current === "'") {
        index2 = maskQuoted(index2, current);
        continue;
      }
      if (current === "`") {
        index2 = maskTemplate(index2);
        continue;
      }
      if (current === "/" && next === "/") {
        index2 = maskLineComment(index2);
        continue;
      }
      if (current === "/" && next === "*") {
        index2 = maskBlockComment(index2);
        continue;
      }
      if (current === "{") braceDepth += 1;
      if (current === "}") braceDepth -= 1;
      blank(index2++);
    }
    return index2;
  }
  function maskTemplate(start) {
    let index2 = start;
    blank(index2++);
    while (index2 < source.length) {
      const current = source[index2];
      const next = source[index2 + 1];
      if (current === "\\") {
        blank(index2++);
        if (index2 < source.length) blank(index2++);
        continue;
      }
      if (current === "`") {
        blank(index2++);
        break;
      }
      if (current === "$" && next === "{") {
        blank(index2++);
        blank(index2++);
        index2 = maskTemplateExpression(index2);
        continue;
      }
      blank(index2++);
    }
    return index2;
  }
  let index = 0;
  while (index < source.length) {
    const current = source[index];
    const next = source[index + 1];
    if (current === '"' || current === "'") {
      index = maskQuoted(index, current);
      continue;
    }
    if (current === "`") {
      index = maskTemplate(index);
      continue;
    }
    if (current === "/" && next === "/") {
      index = maskLineComment(index);
      continue;
    }
    if (current === "/" && next === "*") {
      index = maskBlockComment(index);
      continue;
    }
    index += 1;
  }
  return masked.join("");
}
function countMethodCalls(source, method) {
  const pattern = new RegExp(`this\\.${method}\\s*\\(\\s*\\)`, "g");
  return source.match(pattern)?.length ?? 0;
}
function detectCompactShape(prototype) {
  if (typeof prototype.compact !== "function") {
    return "AgentSession.compact() is missing";
  }
  if (typeof prototype.abort !== "function") {
    return "AgentSession.abort() is missing";
  }
  if (typeof prototype._bindExtensionCore !== "function") {
    return "AgentSession._bindExtensionCore() is missing";
  }
  const source = maskNonCodeText(Function.prototype.toString.call(prototype.compact));
  const abortCalls = countMethodCalls(source, "abort");
  if (abortCalls !== 1 || !source.includes("appendCompaction") || !source.includes("agent.state.messages")) {
    return "unsupported AgentSession.compact() shape";
  }
  const disconnectCalls = countMethodCalls(source, "_disconnectFromAgent");
  const reconnectCalls = countMethodCalls(source, "_reconnectToAgent");
  if (disconnectCalls === 0 && reconnectCalls === 0) {
    return { disconnectsAgent: false };
  }
  if (disconnectCalls === 1 && reconnectCalls === 1 && typeof prototype._disconnectFromAgent === "function" && typeof prototype._reconnectToAgent === "function") {
    return { disconnectsAgent: true };
  }
  return "unsupported AgentSession disconnect/reconnect shape";
}
function shadowProperty(target, key, value) {
  const record = target;
  const ownDescriptor = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: ownDescriptor?.enumerable ?? false,
    writable: true,
    value
  });
  return () => {
    if (ownDescriptor) {
      Object.defineProperty(target, key, ownDescriptor);
    } else {
      delete record[key];
    }
  };
}
function installNextTurnRefresh(session, registry) {
  const agent = session.agent;
  if (registry.refreshInstalled.has(agent)) return;
  const previous = agent.prepareNextTurnWithContext;
  agent.prepareNextTurnWithContext = async (turn, signal) => {
    const snapshot = await previous?.call(agent, turn, signal);
    if (!registry.refreshPending.has(session)) return snapshot;
    registry.refreshPending.delete(session);
    const context = snapshot?.context ?? turn.context;
    return {
      ...snapshot,
      context: {
        ...context,
        messages: session.agent.state.messages.slice()
      }
    };
  };
  registry.refreshInstalled.add(agent);
}
function registerSession(session, installed, registry) {
  if (!installed.originalCompact || !installed.shape) return;
  if (!session.sessionManager || typeof session.sessionManager !== "object" || typeof session.sessionManager.buildSessionContext !== "function") {
    return;
  }
  if (!registry.sessions.has(session.sessionManager)) {
    registry.capturedSessionCount = (registry.capturedSessionCount ?? 0) + 1;
  }
  registry.sessions.set(session.sessionManager, {
    session,
    originalCompact: installed.originalCompact,
    shape: installed.shape
  });
  installNextTurnRefresh(session, registry);
}
function findPiPackageRoot(startPath) {
  let current;
  try {
    current = dirname(realpathSync(startPath));
  } catch {
    return void 0;
  }
  const filesystemRoot = parse(current).root;
  while (current !== filesystemRoot) {
    const packagePath = join(current, "package.json");
    if (existsSync(packagePath)) {
      try {
        const manifest = JSON.parse(readFileSync(packagePath, "utf8"));
        if (manifest.name === "@oh-my-pi/pi-coding-agent") return current;
      } catch {
      }
    }
    current = dirname(current);
  }
  return void 0;
}
function parseHostFramePaths(stack) {
  const paths = [];
  for (const line of stack.split("\n")) {
    const match = line.match(/\((.+):\d+:\d+\)\s*$/) ?? line.match(/\bat (.+):\d+:\d+\s*$/);
    if (!match?.[1]) continue;
    const rawPath = match[1].trim();
    const normalizedPath = rawPath.replaceAll("\\", "/");
    if (!normalizedPath.includes("@oh-my-pi/pi-coding-agent")) {
      continue;
    }
    if (!rawPath.startsWith("file://") && !rawPath.startsWith("/") && !rawPath.startsWith("\\\\") && !/^[A-Za-z]:[\\/]/.test(rawPath)) {
      continue;
    }
    try {
      paths.push(rawPath.startsWith("file://") ? fileURLToPath(rawPath) : rawPath);
    } catch {
    }
  }
  return paths;
}
function findBundledRuntimeModule(entrypoint, packageRoot) {
  let resolvedEntrypoint;
  let source;
  try {
    resolvedEntrypoint = realpathSync(entrypoint);
    source = readFileSync(resolvedEntrypoint, "utf8");
  } catch {
    return void 0;
  }
  const namedImport = /\bimport\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;
  for (const match of source.matchAll(namedImport)) {
    const names = match[1].split(",").map((name) => name.trim().split(/\s+as\s+/)[0]);
    const specifier = match[2];
    if (!names.includes("main") || !specifier.startsWith(".")) continue;
    try {
      const candidate = realpathSync(join(dirname(resolvedEntrypoint), specifier));
      if (findPiPackageRoot(candidate) === packageRoot) return candidate;
    } catch {
    }
  }
  return void 0;
}
async function installHostInlineCompactionAdapter(options = {}) {
  const packageRoots = /* @__PURE__ */ new Set();
  const hostPaths = /* @__PURE__ */ new Set();
  const stack = options.stack ?? new Error().stack ?? "";
  for (const framePath of parseHostFramePaths(stack)) hostPaths.add(framePath);
  const entrypoint = options.entrypoint ?? process.argv[1];
  if (entrypoint) hostPaths.add(entrypoint);
  for (const hostPath of hostPaths) {
    const root = findPiPackageRoot(hostPath);
    if (root) packageRoots.add(root);
  }
  const modulePaths = /* @__PURE__ */ new Set();
  for (const packageRoot of packageRoots) {
    modulePaths.add(join(packageRoot, "dist", "index.js"));
    for (const hostPath of hostPaths) {
      if (findPiPackageRoot(hostPath) !== packageRoot) continue;
      const bundledRuntime = findBundledRuntimeModule(hostPath, packageRoot);
      if (bundledRuntime) modulePaths.add(bundledRuntime);
    }
  }
  getRegistry().hostCandidateCount = modulePaths.size;
  let supportedStatus;
  const failureReasons = [];
  for (const modulePath of modulePaths) {
    try {
      const hostModule = await import(pathToFileURL(modulePath).href);
      if (!hostModule.AgentSession) {
        failureReasons.push(`${modulePath}: AgentSession export missing`);
        continue;
      }
      const status = installInlineCompactionAdapter({
        sessionClass: hostModule.AgentSession
      });
      if (status.supported) supportedStatus ??= status;
      else failureReasons.push(`${modulePath}: ${status.reason ?? "unsupported"}`);
    } catch (error) {
      failureReasons.push(
        `${modulePath}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  if (supportedStatus) return supportedStatus;
  const details = failureReasons.length > 0 ? ` (${failureReasons.join("; ")})` : "";
  return {
    supported: false,
    reason: "Inline compaction is unavailable: host AgentSession module could not be resolved" + details
  };
}
function installInlineCompactionAdapter(options = {}) {
  const sessionClass = options.sessionClass ?? AgentSession;
  const prototype = sessionClass.prototype;
  const registry = getRegistry();
  const existing = registry.installs.get(prototype);
  if (existing) return existing.status;
  const shape = detectCompactShape(prototype);
  if (typeof shape === "string") {
    const status = { supported: false, reason: shape };
    registry.installs.set(prototype, { status });
    return status;
  }
  const originalCompact = prototype.compact;
  const originalBindExtensionCore = prototype._bindExtensionCore;
  const installed = {
    status: { supported: true },
    originalCompact,
    shape
  };
  prototype._bindExtensionCore = function patchedBindExtensionCore(runner) {
    registerSession(this, installed, registry);
    return originalBindExtensionCore.call(this, runner);
  };
  registry.installs.set(prototype, installed);
  return installed.status;
}
function getToolCallId(block) {
  if (!block || typeof block !== "object") return void 0;
  const value = block;
  return value.type === "toolCall" && typeof value.id === "string" ? value.id : void 0;
}
function hasTrailingUnpairedToolCall(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== "object") continue;
    const value = message;
    if (value.role !== "assistant") continue;
    if (!Array.isArray(value.content)) return false;
    const stopReason = value.stopReason;
    if (stopReason === "error" || stopReason === "aborted") continue;
    const pending = /* @__PURE__ */ new Set();
    for (const block of value.content) {
      const id = getToolCallId(block);
      if (id) pending.add(id);
    }
    if (pending.size === 0) return false;
    for (let resultIndex = index + 1; resultIndex < messages.length; resultIndex += 1) {
      const result = messages[resultIndex];
      if (!result || typeof result !== "object") continue;
      const resultValue = result;
      if (resultValue.role === "toolResult" && typeof resultValue.toolCallId === "string") {
        pending.delete(resultValue.toolCallId);
      }
    }
    return pending.size > 0;
  }
  return false;
}
async function compactInlineAtTurnBoundary(sessionManager, customInstructions) {
  const registry = getRegistry();
  const record = registry.sessions.get(sessionManager);
  if (!record) {
    throw new InlineCompactionUnavailableError(
      `Inline compaction is unavailable: owning AgentSession was not captured or Pi internals are unsupported (host candidates: ${registry.hostCandidateCount ?? 0}; captured sessions: ${registry.capturedSessionCount ?? 0})`
    );
  }
  const { session, originalCompact, shape } = record;
  if (registry.compactionInFlight.has(session) || session._compactionAbortController || session._autoCompactionAbortController) {
    throw new Error("Compaction already in progress");
  }
  const activeMessages = session.sessionManager.buildSessionContext().messages;
  if (hasTrailingUnpairedToolCall(activeMessages)) {
    throw new Error("Cannot compact inline while a tool call is still in flight");
  }
  registry.compactionInFlight.add(session);
  const restores = [];
  const realAbort = session.abort;
  let abortSuppressed = false;
  let disconnectSuppressed = false;
  const messagesBefore = session.agent.state.messages;
  let result;
  let operationFailed = false;
  let operationError;
  const cleanupErrors = [];
  try {
    try {
      if (shape.disconnectsAgent) {
        const realDisconnect = session._disconnectFromAgent;
        if (!realDisconnect) {
          throw new InlineCompactionUnavailableError(
            "Inline compaction is unavailable: disconnect hook disappeared"
          );
        }
        restores.push(
          shadowProperty(
            session,
            "_disconnectFromAgent",
            function inlineDisconnect() {
              if (!disconnectSuppressed) {
                disconnectSuppressed = true;
                return;
              }
              realDisconnect.call(this);
            }
          )
        );
      }
      restores.push(
        shadowProperty(
          session,
          "abort",
          async function inlineAbort() {
            if (!abortSuppressed) {
              abortSuppressed = true;
              return;
            }
            this._compactionAbortController?.abort();
            await realAbort.call(this);
          }
        )
      );
      result = await originalCompact.call(session, customInstructions);
      registry.refreshPending.add(session);
      if (!abortSuppressed || shape.disconnectsAgent && !disconnectSuppressed) {
        throw new InlineCompactionUnavailableError(
          "Inline compaction invariant failed: Pi quiesce hooks were not invoked as expected"
        );
      }
    } catch (error) {
      if (session.agent.state.messages !== messagesBefore) {
        registry.refreshPending.add(session);
      }
      operationFailed = true;
      operationError = error;
    }
  } finally {
    registry.compactionInFlight.delete(session);
    for (let index = restores.length - 1; index >= 0; index -= 1) {
      try {
        restores[index]();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
  }
  if (operationFailed) {
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [operationError, ...cleanupErrors],
        "Inline compaction failed and could not restore all session properties"
      );
    }
    throw operationError;
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      cleanupErrors,
      "Inline compaction could not restore all session properties"
    );
  }
  return result;
}

// src/om/compaction-trigger.ts
function getErrorMessage2(error) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    return String(error.message);
  }
  return String(error);
}
function isStaleExtensionContextError3(error) {
  const message = getErrorMessage2(error);
  return message.includes("extension ctx is stale") || message.includes("ctx is stale");
}
function notifySafely2(hasUI, ui, message, level) {
  if (!hasUI) return;
  try {
    ui?.notify(message, level);
  } catch (error) {
    if (!isStaleExtensionContextError3(error)) throw error;
  }
}
function autoCompactionSkipReason(runtime) {
  if (runtime.config.compaction === "off") return "compaction_off";
  if (runtime.config.compaction === "manual") return "compaction_manual";
  if (runtime.config.compactionEngine === "pi-default") return "compactionEngine_pi_default";
  if (runtime.config.compaction === void 0 && runtime.config.compactionEngine === void 0) {
    if (runtime.config.passive === true) return "passive";
    if (runtime.config.noAutoCompact === true) return "manual";
    if (runtime.config.overrideDefaultCompaction === false)
      return "overrideDefaultCompaction_false";
  }
  return null;
}
var MID_RUN_RETRY_MAX_DELAY_MS = 3e4;
function resetMidRunRetry(runtime) {
  runtime.midRunCompactionRetry = { failures: 0, retryAfter: 0 };
}
function recordMidRunFailure(runtime) {
  const failures = runtime.midRunCompactionRetry.failures + 1;
  const delay = Math.min(MID_RUN_RETRY_MAX_DELAY_MS, 1e3 * 2 ** (failures - 1));
  runtime.midRunCompactionRetry = {
    failures,
    retryAfter: Date.now() + delay
  };
  return delay;
}
var retryInSeconds = (delayMs) => `; retrying in ${Math.ceil(delayMs / 1e3)}s`;
function registerCompactionTrigger(pi, runtime, inlineCompact = compactInlineAtTurnBoundary) {
  pi.on("agent_start", (_event, ctx) => {
    runtime.resetInfoGate();
    if (runtime.autoCompactionController) {
      runtime.autoCompactionController.abort();
      runtime.autoCompactionController = null;
      runtime.compactInFlight = false;
    }
    if (runtime.config.midRunCompaction === "resume" && runtime.inlineCompactionAdapterStatus?.supported === false && !runtime.inlineCompactionWarningEmitted) {
      runtime.inlineCompactionWarningEmitted = true;
      notifySafely2(
        ctx?.hasUI ?? false,
        ctx?.ui,
        `Observational memory: mid-run compaction (resume) unavailable: ${runtime.inlineCompactionAdapterStatus.reason}; using settled compaction fallback`,
        "warning"
      );
    }
  });
  pi.on("agent_end", (event, ctx) => {
    try {
      handleAgentEnd(event, ctx, runtime);
    } catch (error) {
      if (isStaleExtensionContextError3(error)) return;
      throw error;
    }
  });
  pi.on("turn_end", async (_event, ctx) => {
    try {
      await handleTurnEnd(ctx, runtime, inlineCompact);
    } catch (error) {
      if (isStaleExtensionContextError3(error)) return;
      throw error;
    }
  });
}
async function handleTurnEnd(ctx, runtime, inlineCompact) {
  runtime.ensureConfig(ctx.cwd, (msg) => ctx.ui?.notify?.(msg, "warning"));
  const dbg2 = (ev, d) => debugLog(ev, d, runtime.config.debugLog === true);
  const mode = runtime.config.midRunCompaction ?? "off";
  if (mode === "off") {
    dbg2("compaction_trigger.turn_end.skip", { reason: "midRunCompaction_off" });
    return;
  }
  const skipReason = autoCompactionSkipReason(runtime);
  if (skipReason) {
    dbg2("compaction_trigger.turn_end.skip", { reason: skipReason });
    return;
  }
  if (runtime.compactInFlight) {
    dbg2("compaction_trigger.turn_end.skip", { reason: "compactInFlight" });
    return;
  }
  if (ctx.signal?.aborted === true) {
    dbg2("compaction_trigger.turn_end.skip", { reason: "active_run_aborted" });
    return;
  }
  const entries = ctx.sessionManager.getBranch();
  const tokens = rawTokensSinceLastCompaction(entries);
  if (tokens < runtime.config.compactAfterTokens) {
    resetMidRunRetry(runtime);
    return;
  }
  if (Date.now() < runtime.midRunCompactionRetry.retryAfter) {
    dbg2("compaction_trigger.turn_end.skip", {
      reason: "inline_retry_backoff",
      tokens,
      failures: runtime.midRunCompactionRetry.failures,
      retryAfter: runtime.midRunCompactionRetry.retryAfter
    });
    return;
  }
  if (mode === "resume" && runtime.inlineCompactionAdapterStatus?.supported === false) {
    dbg2("compaction_trigger.turn_end.skip", {
      reason: "inline_adapter_unsupported",
      tokens,
      reason_detail: runtime.inlineCompactionAdapterStatus.reason
    });
    return;
  }
  const hasUI = ctx.hasUI;
  const ui = ctx.ui;
  dbg2("compaction_trigger.turn_end.threshold_reached", {
    tokens,
    threshold: runtime.config.compactAfterTokens,
    mode
  });
  runtime.tryEmitInfo(
    hasUI,
    ui,
    `Observational memory: compaction threshold reached mid-run (~${tokens.toLocaleString()} tokens); compacting${mode === "resume" ? " inline" : " and pausing"}`
  );
  runtime.compactInFlight = true;
  if (mode === "resume") {
    try {
      await inlineCompact(ctx.sessionManager);
      resetMidRunRetry(runtime);
      dbg2("compaction_trigger.turn_end.inline_complete");
      runtime.tryEmitInfo(
        hasUI,
        ui,
        "Observational memory: transparent mid-run compaction complete"
      );
    } catch (error) {
      if (isStaleExtensionContextError3(error)) throw error;
      const message = getErrorMessage2(error);
      if (error instanceof InlineCompactionUnavailableError) {
        runtime.inlineCompactionAdapterStatus = {
          supported: false,
          reason: message
        };
        dbg2("compaction_trigger.turn_end.inline_adapter_unavailable", {
          message
        });
        if (!runtime.inlineCompactionWarningEmitted) {
          runtime.inlineCompactionWarningEmitted = true;
          notifySafely2(
            hasUI,
            ui,
            `Observational memory: ${message}; using settled compaction fallback`,
            "warning"
          );
        }
        return;
      }
      const delay = recordMidRunFailure(runtime);
      dbg2("compaction_trigger.turn_end.inline_error", {
        message,
        failures: runtime.midRunCompactionRetry.failures,
        retryAfter: runtime.midRunCompactionRetry.retryAfter
      });
      if (message !== "Compaction cancelled") {
        notifySafely2(
          hasUI,
          ui,
          `Observational memory: transparent mid-run compaction failed: ${message}${retryInSeconds(delay)}`,
          "error"
        );
      }
    } finally {
      runtime.compactInFlight = false;
      if (hasUI && ctx.signal?.aborted !== true) {
        ui?.setWorkingVisible?.(true);
      }
    }
    return;
  }
  ctx.compact({
    onComplete: () => {
      runtime.compactInFlight = false;
      resetMidRunRetry(runtime);
      dbg2("compaction_trigger.turn_end.pause_complete");
      runtime.tryEmitInfo(
        hasUI,
        ui,
        "Observational memory: mid-run compaction complete; agent paused"
      );
    },
    onError: (error) => {
      runtime.compactInFlight = false;
      const delay = recordMidRunFailure(runtime);
      const message = error?.message ?? String(error);
      dbg2("compaction_trigger.turn_end.pause_error", {
        message,
        failures: runtime.midRunCompactionRetry.failures,
        retryAfter: runtime.midRunCompactionRetry.retryAfter
      });
      if (message !== "Compaction cancelled") {
        notifySafely2(
          hasUI,
          ui,
          `Observational memory: mid-run compaction failed: ${message}${retryInSeconds(delay)}`,
          "error"
        );
      }
    }
  });
}
function handleAgentEnd(event, ctx, runtime) {
  runtime.ensureConfig(ctx.cwd, (msg) => ctx.ui?.notify?.(msg, "warning"));
  runtime.resetInfoGate();
  const dbg2 = (ev, d) => debugLog(ev, d, runtime.config.debugLog === true);
  dbg2("compaction_trigger.agent_end", {
    passive: runtime.config.passive,
    memory: runtime.config.memory,
    manualMode: runtime.config.compaction === "manual" || runtime.config.noAutoCompact === true,
    overrideDefaultCompaction: runtime.config.overrideDefaultCompaction,
    compactInFlight: runtime.compactInFlight,
    compactAfterTokens: runtime.config.compactAfterTokens
  });
  const skipReason = autoCompactionSkipReason(runtime);
  if (skipReason) {
    dbg2("compaction_trigger.skip", { reason: skipReason });
    return;
  }
  if (runtime.compactInFlight) {
    dbg2("compaction_trigger.skip", { reason: "compactInFlight" });
    return;
  }
  const lastAssistant = [...event.messages].reverse().find((m) => m.role === "assistant");
  if (lastAssistant && lastAssistant.stopReason === "error" && lastAssistant.errorMessage && RETRYABLE_ERROR_RE.test(lastAssistant.errorMessage)) {
    return;
  }
  const entries = ctx.sessionManager.getBranch();
  dbg2("compaction_trigger.branch_check", {
    branchLength: entries.length,
    hasLastEntry: entries.length > 0,
    lastEntryType: entries.length > 0 ? entries[entries.length - 1].type : "none"
  });
  const tokens = rawTokensSinceLastCompaction(entries);
  dbg2("compaction_trigger.tokens", {
    tokens,
    compactAfterTokens: runtime.config.compactAfterTokens,
    branchLength: entries.length
  });
  if (tokens < runtime.config.compactAfterTokens) {
    dbg2("compaction_trigger.skip", {
      reason: "below_threshold",
      tokens,
      threshold: runtime.config.compactAfterTokens
    });
    return;
  }
  if (Date.now() < runtime.midRunCompactionRetry.retryAfter) {
    dbg2("compaction_trigger.skip", {
      reason: "mid_run_retry_backoff",
      tokens,
      failures: runtime.midRunCompactionRetry.failures,
      retryAfter: runtime.midRunCompactionRetry.retryAfter
    });
    return;
  }
  const hasUI = ctx.hasUI;
  const ui = ctx.ui;
  const sessionId = ctx.sessionManager.getSessionId();
  dbg2("compaction_trigger.threshold_reached", { tokens, sessionId, hasUI });
  runtime.tryEmitInfo(
    hasUI,
    ui,
    `Observational memory: compaction threshold reached (~${tokens.toLocaleString()} tokens); triggering compaction`
  );
  runtime.compactInFlight = true;
  const controller = new AbortController();
  runtime.autoCompactionController = controller;
  const signal = controller.signal;
  dbg2("compaction_trigger.scheduled", {
    compactInFlight: runtime.compactInFlight
  });
  void (async () => {
    try {
      await new Promise((resolve3) => setTimeout(resolve3, 0));
      let isIdle = false;
      while (!isIdle) {
        if (signal.aborted) {
          dbg2("compaction_trigger.microtask.bail", {
            reason: "aborted_agent_start"
          });
          return;
        }
        let currentSessionId;
        try {
          currentSessionId = ctx.sessionManager.getSessionId();
        } catch (error) {
          if (isStaleExtensionContextError3(error)) {
            runtime.compactInFlight = false;
            runtime.autoCompactionController = null;
            dbg2("compaction_trigger.microtask.bail", { reason: "stale_ctx" });
            return;
          }
          throw error;
        }
        dbg2("compaction_trigger.microtask.session_check", {
          currentSessionId,
          expectedSessionId: sessionId,
          match: currentSessionId === sessionId
        });
        if (currentSessionId !== sessionId) {
          runtime.compactInFlight = false;
          runtime.autoCompactionController = null;
          dbg2("compaction_trigger.microtask.bail", {
            reason: "session_changed"
          });
          runtime.tryEmitInfo(
            hasUI,
            ui,
            "Observational memory: compaction cancelled \u2014 session changed before compaction"
          );
          return;
        }
        isIdle = ctx.isIdle();
        dbg2("compaction_trigger.microtask.idle_check", { isIdle });
        if (!isIdle) {
          const sliceMs = 50;
          const end = Date.now() + 200;
          while (Date.now() < end) {
            if (signal.aborted) {
              dbg2("compaction_trigger.microtask.bail", {
                reason: "aborted_agent_start"
              });
              return;
            }
            await new Promise((resolve3) => setTimeout(resolve3, sliceMs));
          }
        }
      }
      if (signal.aborted) {
        dbg2("compaction_trigger.microtask.bail", {
          reason: "aborted_agent_start"
        });
        return;
      }
      const currentEntries = ctx.sessionManager.getBranch();
      const currentTokens = rawTokensSinceLastCompaction(currentEntries);
      dbg2("compaction_trigger.microtask.recheck_tokens", {
        currentTokens,
        threshold: runtime.config.compactAfterTokens,
        ok: currentTokens >= runtime.config.compactAfterTokens
      });
      if (currentTokens < runtime.config.compactAfterTokens) {
        runtime.compactInFlight = false;
        runtime.autoCompactionController = null;
        dbg2("compaction_trigger.microtask.bail", {
          reason: "pressure_relieved",
          currentTokens,
          threshold: runtime.config.compactAfterTokens
        });
        runtime.tryEmitInfo(
          hasUI,
          ui,
          "Observational memory: compaction skipped \u2014 another compaction already ran before deferred compaction"
        );
        return;
      }
      dbg2("compaction_trigger.microtask.calling_compact", {});
      runtime.autoCompactionController = null;
      ctx.compact({
        onComplete: (result) => {
          runtime.compactInFlight = false;
          dbg2("compaction_trigger.onComplete", { result: !!result });
          runtime.tryEmitInfo(hasUI, ui, "Observational memory: compaction complete");
        },
        onError: (error) => {
          runtime.compactInFlight = false;
          dbg2("compaction_trigger.onError", {
            message: error?.message ?? String(error)
          });
          if (error.message === "Compaction cancelled") {
            return;
          }
          notifySafely2(hasUI, ui, `Observational memory: ${error.message}`, "error");
        }
      });
    } catch (error) {
      runtime.compactInFlight = false;
      runtime.autoCompactionController = null;
      const msg = getErrorMessage2(error);
      if (isStaleExtensionContextError3(error)) {
        dbg2("compaction_trigger.microtask.bail", {
          reason: "stale_ctx",
          message: msg
        });
        return;
      }
      dbg2("compaction_trigger.microtask.error", { message: msg });
      notifySafely2(hasUI, ui, `Observational memory: compact threw: ${msg}`, "error");
    }
  })();
}

// src/core/drill-down.ts
function findContentBearingCalls(content) {
  if (!Array.isArray(content)) return [];
  const results = [];
  for (const part of content) {
    if (!part || part.type !== "toolCall") continue;
    const args = part.arguments ?? {};
    if (!isContentBearing(args)) continue;
    const path = extractPath(args);
    if (!path) continue;
    const entry = { name: part.name ?? "", path };
    if (typeof args.content === "string") entry.content = args.content;
    if (Array.isArray(args.edits)) {
      entry.edits = args.edits.filter(
        (e) => e !== null && typeof e === "object"
      );
    }
    if (typeof args.oldText === "string" && !Array.isArray(args.edits))
      entry.oldText = args.oldText;
    if (typeof args.newText === "string" && !Array.isArray(args.edits))
      entry.newText = args.newText;
    results.push(entry);
  }
  return results;
}
function formatToolCallContent(tc, entryIndex, options) {
  let body;
  if (tc.content) {
    body = tc.content;
  } else if (tc.edits) {
    body = tc.edits.map(
      (e, i) => `--- edit ${i + 1} ---
${e.oldText ?? ""}
--- becomes ---
${e.newText ?? ""}`
    ).join("\n\n");
  } else if (tc.oldText && tc.newText) {
    body = `--- old ---
${tc.oldText}
--- new ---
${tc.newText}`;
  } else {
    body = "(no file content found in tool call arguments)";
  }
  const full = options?.full ?? false;
  const offset = options?.offset;
  const limit = options?.limit;
  const allLines = body.split("\n");
  const totalLines = allLines.length;
  const previewLimit = 30;
  const MAX_FULL_BYTES = 50 * 1024;
  if (full) {
    if (Buffer.byteLength(body, "utf8") > MAX_FULL_BYTES) {
      const truncated = body.slice(0, MAX_FULL_BYTES);
      return `File: ${tc.path}
Tool: ${tc.name}

${truncated}

... (${Buffer.byteLength(body, "utf8") - MAX_FULL_BYTES} more bytes \u2014 file exceeds 50KB display limit. Use #${entryIndex}:${tc.path}:${previewLimit} for next page.)`;
    }
    return `File: ${tc.path}
Tool: ${tc.name}

${body}`;
  }
  if (offset !== void 0) {
    const startLine = Math.max(0, offset);
    const maxLines = limit ?? 30;
    const endLine = Math.min(startLine + maxLines, totalLines);
    const visible = allLines.slice(startLine, endLine);
    const displayStart = startLine + 1;
    if (visible.length === 0) {
      return `Offset ${startLine} is beyond file length ${totalLines}. Use #${entryIndex}:${tc.path} for the first ${previewLimit} lines.`;
    }
    let result = `File: ${tc.path}
Tool: ${tc.name}
Lines ${displayStart}-${endLine} (of ${totalLines}):

`;
    result += visible.join("\n");
    if (endLine < totalLines) {
      result += `

--- Use #${entryIndex}:${tc.path}:${endLine} or #${entryIndex}:${tc.path}:${endLine}:${maxLines} for next ${maxLines} lines, #${entryIndex}:${tc.path}:full for complete ---`;
    } else if (offset > 0) {
      result += `

(End of file)`;
    }
    return result;
  }
  if (totalLines > previewLimit) {
    const preview = allLines.slice(0, previewLimit).join("\n");
    return `File: ${tc.path}
Tool: ${tc.name}

${preview}

...(${totalLines - previewLimit} more lines \u2014 use #${entryIndex}:${tc.path}:full for complete content, or #${entryIndex}:${tc.path}:${previewLimit} for next ${previewLimit} lines)`;
  }
  return `File: ${tc.path}
Tool: ${tc.name}

${body}`;
}
var DRILLDOWN_PATTERN = /^#(\d+):(.+?)(?::(full|\d+(?::\d+)?))?$/;
function parseDrillDown(query) {
  const match = query.match(DRILLDOWN_PATTERN);
  if (!match) return null;
  const index = parseInt(match[1], 10);
  const pathPattern = match[2];
  const suffix = match[3];
  if (suffix === "full") {
    return {
      index,
      pathPattern,
      full: true,
      offset: void 0,
      limit: void 0
    };
  }
  if (suffix !== void 0) {
    const parts = suffix.split(":");
    const offset = parseInt(parts[0], 10);
    const limit = parts[1] !== void 0 ? parseInt(parts[1], 10) : void 0;
    if (!Number.isNaN(offset)) {
      return { index, pathPattern, full: false, offset, limit };
    }
  }
  return {
    index,
    pathPattern,
    full: false,
    offset: void 0,
    limit: void 0
  };
}
function expandEntryFile(sessionFile, entryIndex, pathPattern, full = false, offset, limit) {
  const { rawMessages } = loadAllMessages(sessionFile, true);
  if (entryIndex < 0 || entryIndex >= rawMessages.length) {
    return `Entry #${entryIndex} not found in session history.`;
  }
  const msg = rawMessages[entryIndex];
  const content = msg.content;
  const calls = findContentBearingCalls(content);
  if (pathPattern === "file") {
    if (calls.length === 0) {
      return `No file content found in entry #${entryIndex}.`;
    }
    if (calls.length === 1) {
      return formatToolCallContent(calls[0], entryIndex, {
        full,
        offset,
        limit
      });
    }
    const items = calls.map((tc) => `  [#${entryIndex}:${tc.path}] ${tc.name}(${tc.path})`);
    return `Entry #${entryIndex} has ${calls.length} file operations:
${items.join("\n")}

Use #${entryIndex}:path to drill into a specific file.`;
  }
  const matched = calls.filter((tc) => tc.path.includes(pathPattern));
  if (matched.length === 0) {
    return `No file content found in entry #${entryIndex} for "${pathPattern}".`;
  }
  if (matched.length > 1) {
    const items = matched.map((tc) => `  [#${entryIndex}:${tc.path}] ${tc.name}(${tc.path})`);
    return `Entry #${entryIndex} has ${matched.length} file operations matching "${pathPattern}":
${items.join("\n")}

Use #${entryIndex}:<more-specific-path> to drill into a specific file.`;
  }
  return formatToolCallContent(matched[0], entryIndex, { full, offset, limit });
}

// src/tools/recall.ts
var DEFAULT_RECENT2 = 25;
var PAGE_SIZE2 = 5;
var invalidExpandIndices = (requested, available) => requested.filter((i) => !Number.isInteger(i) || !available.has(i));
function mergeExpandedIntoSearchResults(searchResults, expandedEntries) {
  if (expandedEntries.length === 0) return searchResults;
  const expandedByIndex = new Map(expandedEntries.map((e) => [e.index, e]));
  const merged = searchResults.map((r) => {
    const full = expandedByIndex.get(r.index);
    return full ? { ...r, summary: full.summary } : r;
  });
  for (const fe of expandedEntries) {
    if (!merged.some((r) => r.index === fe.index)) {
      merged.push(fe);
    }
  }
  merged.sort((a, b) => a.index - b.index);
  return merged;
}
async function vccRecall(params, ctx) {
  const sessionFile = ctx.sessionManager.getSessionFile();
  if (!sessionFile) {
    return {
      content: [{ type: "text", text: "No session file available." }],
      details: void 0
    };
  }
  const scope = normalizeRecallScope(params.scope);
  const mode = normalizeRecallMode(params.mode);
  const lineageEntryIds = scope === "lineage" ? getActiveLineageEntryIds(ctx.sessionManager) : void 0;
  if (mode === "touched") {
    const { rendered, rawMessages: rawMessages2 } = loadAllMessages(sessionFile, false, lineageEntryIds);
    const touched = getTouchedFiles(rawMessages2, rendered);
    const text = formatTouchedOutput(touched, params.page);
    return { content: [{ type: "text", text }], details: void 0 };
  }
  const expandSet = new Set(params.expand ?? []);
  const hasExpand = expandSet.size > 0;
  let expandedFullEntries;
  if (hasExpand) {
    const { rendered: fullMsgs } = loadAllMessages(sessionFile, true, lineageEntryIds);
    const requested = [...expandSet];
    const byIndex = new Map(fullMsgs.map((m) => [m.index, m]));
    const invalid = invalidExpandIndices(requested, new Set(byIndex.keys()));
    if (invalid.length > 0) {
      return {
        content: [
          {
            type: "text",
            text: `Cannot expand indices outside ${scope === "all" ? "session history" : "active lineage"}: ${invalid.join(", ")}`
          }
        ],
        details: void 0
      };
    }
    expandedFullEntries = requested.map((i) => byIndex.get(i)).filter((m) => Boolean(m));
    if (!params.query) {
      let output2 = (scope === "all" ? "Scope: all\n\n" : "") + formatRecallOutput(expandedFullEntries);
      const expandedIds = expandedFullEntries.map((e) => e.id).filter(Boolean);
      if (expandedIds.length > 0) {
        try {
          const branchEntries = ctx.sessionManager.getBranch();
          const obs = findObservationsForEntryIds(branchEntries, expandedIds);
          const refs = findReflectionsForEntryIds(branchEntries, expandedIds);
          if (obs.length > 0 || refs.length > 0) {
            output2 += "\n\n" + formatRelatedObservations(obs, refs);
          }
        } catch {
        }
      }
      return {
        content: [{ type: "text", text: output2 }],
        details: void 0
      };
    }
  }
  const { rendered: msgs, rawMessages } = loadAllMessages(sessionFile, false, lineageEntryIds);
  let allResults = params.query?.trim() ? searchEntries(msgs, rawMessages, params.query, void 0, mode) : msgs.slice(-DEFAULT_RECENT2).map((entry, i) => {
    const msgIndex = Math.max(0, msgs.length - DEFAULT_RECENT2) + i;
    const msg = rawMessages[msgIndex];
    if (msg) {
      const indicators = getFileIndicators(msg);
      if (indicators.length > 0) {
        return { ...entry, fileMatches: indicators };
      }
    }
    return entry;
  });
  let appendedExpandCount = 0;
  if (expandedFullEntries) {
    const existingIndices = new Set(allResults.map((r) => r.index));
    appendedExpandCount = expandedFullEntries.filter((fe) => !existingIndices.has(fe.index)).length;
    allResults = mergeExpandedIntoSearchResults(allResults, expandedFullEntries);
  }
  if (params.query?.trim()) {
    const page = Math.max(1, params.page ?? 1);
    const start = (page - 1) * PAGE_SIZE2;
    const pageResults = allResults.slice(start, start + PAGE_SIZE2);
    const totalPages = Math.ceil(allResults.length / PAGE_SIZE2);
    const scopeSuffix = scope === "all" ? " (scope: all)" : "";
    const matchCount = allResults.length - appendedExpandCount;
    const header = totalPages > 1 ? `Page ${page}/${totalPages} (${matchCount} matches${appendedExpandCount > 0 ? ` + ${appendedExpandCount} expanded` : ""}${scopeSuffix})` : `${matchCount} matches${appendedExpandCount > 0 ? ` (+ ${appendedExpandCount} expanded)` : ""}${scopeSuffix}`;
    const footer = page < totalPages ? `
--- Use page:${page + 1}${scope === "all" ? " with scope:'all'" : ""} for more results ---` : "";
    let output2 = formatRecallOutput(pageResults, params.query, header) + footer;
    const pageResultIds = pageResults.map((r) => r.id).filter(Boolean);
    if (pageResultIds.length > 0) {
      try {
        const branchEntries = ctx.sessionManager.getBranch();
        const obs = findObservationsForEntryIds(branchEntries, pageResultIds);
        const refs = findReflectionsForEntryIds(branchEntries, pageResultIds);
        if (obs.length > 0 || refs.length > 0) {
          output2 += "\n\n" + formatRelatedObservations(obs, refs);
        }
      } catch {
      }
    }
    return {
      content: [{ type: "text", text: output2 }],
      details: void 0
    };
  }
  const output = (scope === "all" ? "Scope: all\n\n" : "") + formatRecallOutput(allResults, params.query);
  return {
    content: [{ type: "text", text: output }],
    details: void 0
  };
}
var MEMORY_ID_PATTERN2 = /^[a-f0-9]{12}$/;
var VCC_ENTRY_PATTERN = /^#(\d+)$/;
async function omRecall(memoryId, ctx) {
  if (!MEMORY_ID_PATTERN2.test(memoryId)) {
    return {
      content: [
        {
          type: "text",
          text: `Memory id must be 12 lowercase hex characters. Received: ${memoryId}`
        }
      ],
      details: void 0
    };
  }
  const branchEntries = ctx.sessionManager.getBranch();
  const result = recallMemorySources(branchEntries, memoryId);
  if (result.status === "not_found") {
    return {
      content: [
        {
          type: "text",
          text: `No observation or reflection with id ${memoryId} was found on the current branch.`
        }
      ],
      details: void 0
    };
  }
  const lines = [];
  if (result.collision) lines.push(`ID ${result.memoryId} matched multiple items.`);
  for (const ref of result.reflections) {
    lines.push(`[${ref.reflection.id}] ${ref.reflection.content}`);
  }
  for (const obs of result.observations) {
    const dropped = obs.status === "dropped" ? " [dropped]" : "";
    lines.push(
      `[${obs.observation.id}]${dropped} ${obs.observation.timestamp} [${obs.observation.relevance}] ${obs.observation.content}`
    );
  }
  if (result.sourceEntries.length > 0) {
    lines.push("");
    lines.push("Sources:");
    try {
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (sessionFile) {
        const { rendered } = await Promise.resolve(loadAllMessages(sessionFile, false));
        const idToIndex = buildIndexMap(rendered);
        const indexAnnotation = formatEntryIndexAnnotation(
          result.observations.flatMap((o) => o.sourceEntryIds),
          idToIndex
        );
        if (indexAnnotation) lines.push(indexAnnotation);
      }
    } catch {
    }
    lines.push(renderRecallSourceEntries(result.sourceEntries));
  }
  const text = lines.join("\n") || `Memory ${memoryId} found, but no evidence rendered.`;
  return { content: [{ type: "text", text }], details: void 0 };
}
function registerRecallTool(pi) {
  pi.registerTool({
    name: "recall",
    label: "Recall",
    description: "Search session history and earlier lines omitted, file write/edit content by text/regex. Expand entries (#N), drill-down file content (#N:path) with paging, or aggregate touched files (mode:touched).",
    promptSnippet: "Search session history + file write/edit content by text/regex. #N expand, #N:path drill-down with optional :offset:limit or :full, mode:file/touched.",
    promptGuidelines: [
      "Use recall \u2014 literal text/regex search across session history and file write/edit content. #N expands an entry; #N:path with optional :offset:limit or :full drills down into file content; 12-char hex ids recover observation/reflection sources. mode:file for file-content-only, mode:touched for aggregated files-by-path. scope:'all' to search the full session. If no results, try fewer terms or a regex pattern.",
      "Use recall \u2014 when a drill-down path matches multiple files, options are listed. Narrow with a more specific path substring. Only full-file writes are indexed for text search (edit diffs are not)."
    ],
    parameters: Type.Object({
      query: Type.Optional(
        Type.String({
          description: "Text/regex search; #N expands entry; #N:path drills file (#N:file auto-selects); #N:path:full all lines; #N:path:offset:limit range; 12-char hex for observations. Only full-file writes indexed."
        })
      ),
      expand: Type.Optional(
        Type.Array(Type.Number(), {
          description: "Entry indices to return full untruncated content for. Standalone or with query."
        })
      ),
      page: Type.Optional(
        Type.Number({
          description: "Page number (1-based) for paginated results. Default: 1."
        })
      ),
      scope: Type.Optional(
        StringEnum(["lineage", "all"], {
          description: "Search scope. lineage = active lineage (default), all = entire session."
        })
      ),
      mode: Type.Optional(
        StringEnum(["hybrid", "file", "touched"], {
          description: "What content to search. hybrid (default) = all session content. file = file content only. touched = files-by-path summary with entry indices."
        })
      )
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (!sessionFile) {
        return {
          content: [{ type: "text", text: "No session file available." }],
          details: void 0
        };
      }
      const scope = normalizeRecallScope(params.scope);
      const lineageEntryIds = scope === "lineage" ? getActiveLineageEntryIds(ctx.sessionManager) : void 0;
      const q = params.query?.trim();
      if (q && parseDrillDown(q)) {
        const parsed = parseDrillDown(q);
        if (lineageEntryIds) {
          const { rendered } = loadAllMessages(sessionFile, false, lineageEntryIds);
          if (!rendered.some((m) => m.index === parsed.index)) {
            return {
              content: [
                {
                  type: "text",
                  text: `Cannot expand indices outside active lineage: ${parsed.index}. Use scope:'all' to reach other branches.`
                }
              ],
              details: void 0
            };
          }
        }
        const text = expandEntryFile(
          sessionFile,
          parsed.index,
          parsed.pathPattern,
          parsed.full,
          parsed.offset,
          parsed.limit
        );
        return {
          content: [{ type: "text", text }],
          details: void 0
        };
      }
      if (q && VCC_ENTRY_PATTERN.test(q)) {
        const match = q.match(VCC_ENTRY_PATTERN);
        const index = match ? parseInt(match[1], 10) : NaN;
        if (!Number.isNaN(index)) {
          return vccRecall({ query: "", expand: [index] }, ctx);
        }
      }
      if (q && MEMORY_ID_PATTERN2.test(q)) {
        return omRecall(q, ctx);
      }
      return vccRecall(params, ctx);
    }
  });
}

// src/om/config.ts
var DEFAULTS2 = DEFAULTS;
var CONFIG_DIR2 = "pi-blackhole";
var COOLDOWN_FILE = "pi-blackhole-cooldown.json";
function cooldownPath() {
  return join(getAgentDir(), CONFIG_DIR2, COOLDOWN_FILE);
}
function modelKey(model) {
  return `${model.provider}/${model.id}`;
}
function readCooldownMap() {
  const path = cooldownPath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return {};
  }
}
function writeCooldownMap(map) {
  try {
    const path = cooldownPath();
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, `${JSON.stringify(map, null, 2)}
`);
  } catch {
  }
}
function isCooldownActive(model, now = /* @__PURE__ */ new Date()) {
  return getCooldownEntry(model, now) !== void 0;
}
function getCooldownEntry(model, now = /* @__PURE__ */ new Date()) {
  if (model.cooldownHours === 0) return void 0;
  const map = readCooldownMap();
  const key = modelKey(model);
  const entry = map[key];
  if (!entry) return void 0;
  const until = new Date(entry.until);
  if (isNaN(until.getTime())) return void 0;
  if (now >= until) {
    delete map[key];
    writeCooldownMap(map);
    return void 0;
  }
  return entry;
}
function recordCooldown(model, reason, stage) {
  if (model.cooldownHours === 0) return;
  const hours = model.cooldownHours ?? 1;
  const until = new Date(Date.now() + hours * 36e5).toISOString();
  const map = readCooldownMap();
  map[modelKey(model)] = { until, reason, stage };
  writeCooldownMap(map);
}
function expireCooldowns() {
  const map = readCooldownMap();
  const now = /* @__PURE__ */ new Date();
  let changed = false;
  for (const [key, entry] of Object.entries(map)) {
    const until = new Date(entry.until);
    if (isNaN(until.getTime()) || now >= until) {
      delete map[key];
      changed = true;
    }
  }
  if (changed) writeCooldownMap(map);
}

// src/om/runtime.ts
async function resolveAuthBaseUrl(modelRegistry, model, auth) {
  const directBaseUrl = typeof auth.baseUrl === "string" ? auth.baseUrl.trim() : "";
  if (directBaseUrl) return directBaseUrl;
  if (typeof modelRegistry.getProviderAuth !== "function") return void 0;
  try {
    const resolved = await modelRegistry.getProviderAuth(model.provider);
    const baseUrl = resolved?.auth?.baseUrl;
    return typeof baseUrl === "string" && baseUrl.trim() ? baseUrl.trim() : void 0;
  } catch {
    return void 0;
  }
}
async function withResolvedAuthEndpoint(modelRegistry, model, auth) {
  const baseUrl = await resolveAuthBaseUrl(modelRegistry, model, auth);
  return baseUrl && baseUrl !== model.baseUrl ? { ...model, baseUrl } : model;
}
var CONSOLIDATION_RETRY_COOLDOWN_MS = 3e4;
var Runtime = class {
  config = { ...DEFAULTS2 };
  configLoaded = false;
  consolidationInFlight = false;
  consolidationPromise = null;
  consolidationPhase;
  /**
   * Models that failed in the current consolidation stage (in-memory only).
   * Used when cooldownHours is 0 — avoids disk writes while still letting
   * the retry loop advance past the failed model within this stage.
   * Cleared between stages at the pipeline level.
   */
  failedInCycle = /* @__PURE__ */ new Set();
  compactInFlight = false;
  compactHookInFlight = false;
  /** AbortController for the pending auto-compaction wait loop, or null if none.
   * Set when handleAgentEnd schedules a wait; cleared on abort, success, or terminal bail.
   * agent_start handlers read this to abort the pending wait when a new turn starts. */
  autoCompactionController = null;
  /** Exponential backoff state for failed/cancelled mid-run compaction attempts.
   * `retryAfter` gates re-triggering; failures reset when a compaction succeeds,
   * pressure drops below the threshold, or an auto-compaction completes.
   * Replaces the earlier permanent-suspension latch (PR #38) so transient
   * failures self-heal instead of wedging compaction until pressure drops. */
  midRunCompactionRetry = {
    failures: 0,
    retryAfter: 0
  };
  /** Set when the host inline-compaction adapter reports permanent
   * unavailability (pi version lacks the API). Mirrors the structural
   * shape of InlineCompactionAdapterStatus without importing it. */
  inlineCompactionAdapterStatus;
  /** One-shot guard for the settled-fallback user notification. */
  inlineCompactionWarningEmitted = false;
  resolveFailureNotified = false;
  lastObserverError;
  lastReflectorError;
  lastDropperError;
  /** Epoch ms of the last failed consolidation run (any stage). */
  lastConsolidationErrorAt;
  /** Stats from the most recent compaction run (session-scoped via handler closure). */
  compactionStats = null;
  /** Whether the current compaction attempt was triggered by /memory.
   *  Overwritten at every session_before_compact and consumed by either the
   *  session_compact or session_compact_failed handler, preventing stale
   *  attribution from leaking into a later pi-default attempt. */
  compactWasPiVcc = false;
  /** True when the current session_before_compact returned { cancel: true } from
   *  blackhole's own-cut guards. Set immediately before the cancel return and reset
   *  at the start of every session_before_compact; consumed by the
   *  session_compact_failed handler to attribute aborted compactions that pi
   *  mislabels as fromExtension: false (pi only flags content-bearing compactions). */
  lastCompactCancelled = false;
  /** Set after the first append-mode fallback warning; one signal per session. */
  appendFallbackNotified = false;
  /** In‑memory pipeline cursors — authoritative copy for gating decisions. */
  cursors = {};
  /** Session ID for which cursors have been loaded/validated.  Undefined until first load. */
  cursorsLoadedSessionId = void 0;
  /** Info-notification gate: only the first info-level notification per turn/phase is emitted. */
  hasEmittedInfoThisTurn = false;
  /**
   * Emit an info-level notification if none has been emitted this turn/phase yet.
   * Returns true if emitted, false if suppressed (already emitted earlier).
   */
  tryEmitInfo(hasUI, ui, message) {
    if (!hasUI || !ui || typeof ui.notify !== "function") return false;
    if (this.hasEmittedInfoThisTurn) return false;
    this.hasEmittedInfoThisTurn = true;
    try {
      ui.notify(message, "info");
    } catch {
    }
    return true;
  }
  /** Reset the info gate — call at agent_start and agent_end to allow one
   *  notification per phase. */
  resetInfoGate() {
    this.hasEmittedInfoThisTurn = false;
  }
  ensureConfig(cwd, warn) {
    if (this.configLoaded) return;
    this.config = loadUnifiedConfig(cwd, warn);
    this.configLoaded = true;
    expireCooldowns();
  }
  /**
   * Force reload config from disk, discarding cached values.
   * Call this after external config changes (e.g., overlay save, manual edit).
   */
  reloadConfig(cwd, warn) {
    this.configLoaded = false;
    this.ensureConfig(cwd, warn);
  }
  /**
   * Resolve a model for an observational-memory stage from Proto's shared model roles.
   * The caller orders candidates as smol, tiny, then the active session model, except
   * that an active model already assigned to smol or tiny remains first.
   */
  async resolveModel(ctx) {
    const candidates = ctx.candidates;
    const stageName = this.consolidationPhase ?? "unknown";
    for (const candidate of candidates) {
      const key = modelKey(candidate);
      if (this.failedInCycle.has(key)) {
        this.tryEmitInfo(
          ctx.hasUI,
          ctx.ui,
          `Observational memory: ${stageName} skipping ${key} (failed this cycle, cooldown disabled)`
        );
        continue;
      }
      if (isCooldownActive(candidate)) {
        const entry = getCooldownEntry(candidate);
        const reason = entry ? `: ${entry.reason}` : "";
        this.tryEmitInfo(
          ctx.hasUI,
          ctx.ui,
          `Observational memory: ${stageName} skipping ${key} (cooldown${reason} \u2014 details in cooldown log)`
        );
        continue;
      }
      const configured = ctx.modelRegistry.find(candidate.provider, candidate.id);
      if (!configured) {
        if (ctx.hasUI && ctx.ui) {
          ctx.ui.notify(
            `Observational memory: ${stageName} model ${candidate.provider}/${candidate.id} not found`,
            "warning"
          );
        }
        continue;
      }
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(configured);
      const hasAuth = ctx.modelRegistry.hasConfiguredAuth?.(configured) ?? true;
      if (!auth.ok || !hasAuth) {
        if (ctx.hasUI && ctx.ui) {
          ctx.ui.notify(
            `Observational memory: ${stageName} no auth for ${candidate.provider}`,
            "warning"
          );
        }
        continue;
      }
      const resolvedModel = await withResolvedAuthEndpoint(ctx.modelRegistry, configured, auth);
      return {
        ok: true,
        model: resolvedModel,
        apiKey: auth.apiKey ?? "",
        headers: auth.headers,
        cooldownApplied: false
      };
    }
    this.resolveFailureNotified = true;
    return {
      ok: false,
      reason: `no model available for ${stageName} (smol, tiny, and session candidates exhausted)`
    };
  }
  /**
   * Get the model config for the currently resolved model (used for cooldown recording).
   * Returns the matching role/session candidate for cooldown handling.
   */
  findCandidateConfig(resolvedModel, ctx) {
    const candidates = ctx.candidates;
    const model = resolvedModel;
    if (!model.provider || !model.id) return void 0;
    return candidates.find((candidate) => candidate.provider === model.provider && candidate.id === model.id);
  }
  /**
   * Record a retryable error for a role/session candidate.
   *
   * When cooldownHours is explicitly 0, the model is tracked in-memory for the
   * current consolidation stage (no disk writes). Otherwise a persisted cooldown
   * is recorded.
   */
  recordRetryableError(modelConfig, error, stage) {
    if (!modelConfig) return;
    if (modelConfig.cooldownHours === 0) {
      this.failedInCycle.add(modelKey(modelConfig));
      return;
    }
    const rawReason = error instanceof Error ? error.message : String(error || "unknown error");
    const brief = rawReason.replace(/\s*\{[\s\S]*?\}\s*$/, "").trim();
    recordCooldown(modelConfig, brief, stage);
  }
  /**
   * Record that a consolidation stage error occurred.
   * Sets the retry-gate timestamp so the next trigger is delayed.
   */
  markConsolidationError() {
    this.lastConsolidationErrorAt = Date.now();
  }
  /** Check if the consolidation retry gate is active (too soon after last error). */
  isConsolidationRetryGated() {
    if (!this.lastConsolidationErrorAt) return false;
    return Date.now() - this.lastConsolidationErrorAt < CONSOLIDATION_RETRY_COOLDOWN_MS;
  }
  /** Get the current cursor for a pipeline stage. */
  getCursor(stage) {
    return this.cursors[stage];
  }
  /** Advance a stage's cursor to a new entry ID with the given state. */
  advanceCursor(stage, entryId, state) {
    this.cursors[stage] = { entryId, state };
  }
  /** Load cursors from the per‑session pending file into the in‑memory map. */
  loadCursorsFromPending(sessionId) {
    try {
      const stored = readPendingCursors(sessionId);
      if (!stored) return;
      if (stored.observer?.entryId && stored.observer?.state) {
        this.cursors.observer = {
          entryId: stored.observer.entryId,
          state: stored.observer.state
        };
      }
      if (stored.reflector?.entryId && stored.reflector?.state) {
        this.cursors.reflector = {
          entryId: stored.reflector.entryId,
          state: stored.reflector.state
        };
      }
      if (stored.dropper?.entryId && stored.dropper?.state) {
        this.cursors.dropper = {
          entryId: stored.dropper.entryId,
          state: stored.dropper.state
        };
      }
    } catch {
    }
  }
  /** Save in‑memory cursors to the per‑session pending file (synchronous, for tests). */
  saveCursorsToPending(sessionId) {
    try {
      writePendingCursors(sessionId, this.cursors);
    } catch {
    }
  }
  /** Schedule an async flush of cursors to the pending file.
   *  Uses a micro‑task to avoid blocking the pipeline. */
  scheduleCursorFlush(sessionId) {
    const cursors = { ...this.cursors };
    queueMicrotask(() => {
      try {
        writePendingCursors(sessionId, cursors);
      } catch {
      }
    });
  }
  launchConsolidationTask(ctx, work) {
    this.consolidationInFlight = true;
    this.consolidationPhase = void 0;
    const promise = this.launchTrackedTask(ctx, "consolidation", work, () => {
      this.consolidationInFlight = false;
      this.consolidationPhase = void 0;
      if (this.consolidationPromise === promise) this.consolidationPromise = null;
    });
    this.consolidationPromise = promise;
    return promise;
  }
  recordConsolidationStageError(ctx, phase, error) {
    const message = error instanceof Error ? error.message : String(error);
    if (phase === "observer") this.lastObserverError = message;
    if (phase === "reflector") this.lastReflectorError = message;
    if (phase === "dropper") this.lastDropperError = message;
    if (ctx.hasUI && ctx.ui) {
      try {
        ctx.ui.notify(`Observational memory: ${phase} failed: ${message}`, "warning");
      } catch {
      }
    }
    this.markConsolidationError();
    return message;
  }
  launchTrackedTask(ctx, label, work, onFinally) {
    const hasUI = ctx.hasUI;
    const ui = ctx.ui;
    return (async () => {
      let errorMessage;
      try {
        await work();
      } catch (error) {
        errorMessage = error instanceof Error ? error.message : String(error);
        if (hasUI && ui) {
          try {
            ui.notify(`Observational memory: ${label} failed: ${errorMessage}`, "warning");
          } catch {
          }
        }
      } finally {
        onFinally(errorMessage);
      }
    })();
  }
};

// index.ts
var index_default = async (pi) => {
  await installHostInlineCompactionAdapter();
  const PROVIDER_STREAMS_KEY = /* @__PURE__ */ Symbol.for("pi-blackhole:provider-streams");
  const providerStreams = globalThis[PROVIDER_STREAMS_KEY] ??= /* @__PURE__ */ new Map();
  pi.on("agent_start", (_event, ctx) => {
    captureRegisteredProviderStreams(ctx.modelRegistry, providerStreams);
  });
  scaffoldSettings();
  const omRuntime = new Runtime();
  registerConsolidationTrigger(pi, omRuntime);
  registerCompactionTrigger(pi, omRuntime);
  registerBeforeCompactHook(pi, omRuntime);
  registerCompactFailedHook(pi, omRuntime);
  registerCompactionContextHook(pi, omRuntime);
  registerPiVccCommand(pi, omRuntime);
  registerMemoryCommand(pi, omRuntime);
  registerVccRecallCommand(pi);
  registerRecallTool(pi);
};

export { index_default as default, resolveMemoryModelCandidates };
//# sourceMappingURL=index.js.map
//# sourceMappingURL=index.js.map