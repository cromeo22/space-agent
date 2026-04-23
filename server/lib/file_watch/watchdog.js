import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  listProjectScanRoots,
  resolveProjectAbsolutePath,
  resolveProjectPathFromAbsolute
} from "../customware/layout.js";
import { globToRegExp, normalizePathSegment } from "../utils/app_files.js";
import { parseSimpleYaml } from "../../../app/L0/_all/mod/_core/framework/js/yaml-lite.js";
import { createStateSystem } from "../../runtime/state_system.js";
import {
  FILE_INDEX_AREA,
  buildFileIndexShards,
  buildGroupIndexShardChanges,
  buildUserIndexShardChanges,
  collectAffectedUsernames,
  collectFileIndexShardIdsFromProjectPaths,
  createRuntimeGroupIndexFromAreas,
  createRuntimeUserIndexFromAreas,
  getFileIndexShardId,
  hasGroupConfigChange
} from "./state_shards.js";

const REFRESH_DEBOUNCE_MS = 75;
const FULL_SCAN_YIELD_INTERVAL_MS = 8;
const RECONCILE_INTERVAL_MS = 5 * 60_000;
const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CUSTOMWARE_WATCHDOG_PARAM = "CUSTOMWARE_WATCHDOG";

export class WatchdogHandler {
  constructor(options = {}) {
    this.name = String(options.name || "");
    this.patterns = Array.isArray(options.patterns) ? [...options.patterns] : [];
    this.projectRoot = String(options.projectRoot || "");
    this.runtimeParams = options.runtimeParams || null;
    this.state = this.createInitialState();
  }

  createInitialState() {
    return null;
  }

  getState() {
    return this.state;
  }

  restoreState(serializedState) {
    this.state = serializedState ?? this.createInitialState();
  }

  serializeState(state = this.state) {
    return state;
  }

  async onStart(_context) {}

  async onChanges(_context) {}
}

function tryReadTextFile(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

function tryStat(targetPath) {
  try {
    return fs.statSync(targetPath);
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

async function tryStatAsync(targetPath) {
  try {
    return await fs.promises.stat(targetPath);
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

function stripTrailingSlash(value) {
  return String(value || "").endsWith("/") ? String(value).slice(0, -1) : String(value || "");
}

function hasIgnoredPathSegment(value) {
  return String(value || "")
    .split(/[\\/]+/u)
    .filter(Boolean)
    .includes(".git");
}

function isIgnoredProjectPath(projectPath) {
  return hasIgnoredPathSegment(normalizePathSegment(projectPath));
}

function normalizeDirectorySuffix(projectPath, isDirectory = false) {
  if (!projectPath) {
    return "";
  }

  const normalized = stripTrailingSlash(projectPath);
  return isDirectory ? `${normalized}/` : normalized;
}

export function normalizeProjectPath(input, options = {}) {
  const normalized = normalizePathSegment(input);

  if (!normalized) {
    return "";
  }

  const isDirectory = Boolean(options.isDirectory) || normalized.endsWith("/");
  const normalizedPath = `/${stripTrailingSlash(normalized)}`;

  return normalizeDirectorySuffix(normalizedPath, isDirectory);
}

function resolveInitialReplicatedVersion(initialSnapshot, replica) {
  const snapshotVersion = Math.floor(Number(initialSnapshot?.version));

  if (Number.isFinite(snapshotVersion) && snapshotVersion > 0) {
    return snapshotVersion;
  }

  if (replica) {
    return 0;
  }

  // Seed primary-owned state versions from wall-clock time so a restarted runtime
  // does not fall behind a browser's highest previously observed version.
  return Date.now();
}

export function toProjectPath(projectRoot, absolutePath, options = {}) {
  return resolveProjectPathFromAbsolute(projectRoot, absolutePath, options);
}

function getProjectPathLookupCandidates(projectPath) {
  const normalized = normalizeProjectPath(projectPath);

  if (!normalized) {
    return [];
  }

  const basePath = stripTrailingSlash(normalized);
  return normalized.endsWith("/") ? [normalized, basePath] : [normalized, `${basePath}/`];
}

function getStatsSignature(stats) {
  if (!stats) {
    return "";
  }

  return `${Math.trunc(stats.mtimeMs)}:${stats.size}`;
}

function isCustomwareWatchdogEnabled(runtimeParams) {
  const rawValue =
    runtimeParams && typeof runtimeParams.get === "function"
      ? runtimeParams.get(CUSTOMWARE_WATCHDOG_PARAM, true)
      : true;

  if (typeof rawValue === "boolean") {
    return rawValue;
  }

  const normalized = String(rawValue ?? "").trim().toLowerCase();

  if (!normalized) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return true;
}

function clonePathIndex(pathIndex = Object.create(null)) {
  const nextPathIndex = Object.create(null);

  Object.entries(pathIndex || {}).forEach(([projectPath, metadata]) => {
    nextPathIndex[projectPath] =
      metadata && typeof metadata === "object" && !Array.isArray(metadata)
        ? { ...metadata }
        : metadata;
  });

  return nextPathIndex;
}

function createPathIndexEntry(stats, options = {}) {
  if (!stats) {
    return null;
  }

  const isDirectory =
    options.isDirectory === undefined ? stats.isDirectory() : Boolean(options.isDirectory);

  return {
    isDirectory,
    mtimeMs: Math.trunc(Number(stats.mtimeMs || 0)),
    sizeBytes: isDirectory ? 0 : Number(stats.size || 0)
  };
}

function isPathIndexEntryEqual(left, right) {
  if (!left && !right) {
    return true;
  }

  if (!left || !right) {
    return false;
  }

  return (
    Boolean(left.isDirectory) === Boolean(right.isDirectory) &&
    Number(left.mtimeMs || 0) === Number(right.mtimeMs || 0) &&
    Number(left.sizeBytes || 0) === Number(right.sizeBytes || 0)
  );
}

function loadWatchdogConfig(configPath) {
  const sourceText = tryReadTextFile(configPath);

  if (sourceText === null) {
    throw new Error(`Watchdog config not found: ${configPath}`);
  }

  const parsed = parseSimpleYaml(sourceText);
  const handlerConfigs = [];
  const uniquePatterns = [];
  const seenPatterns = new Set();

  for (const [name, rawValue] of Object.entries(parsed)) {
    const handlerName = String(name || "").trim();

    if (!handlerName) {
      continue;
    }

    const rawPatterns = Array.isArray(rawValue) ? rawValue : rawValue ? [rawValue] : [];
    const patterns = rawPatterns
      .filter((value) => typeof value === "string")
      .map((value) => normalizeProjectPath(value))
      .filter(Boolean);

    if (patterns.length === 0) {
      throw new Error(
        `Watchdog config must define at least one path for handler "${handlerName}": ${configPath}`
      );
    }

    handlerConfigs.push({
      name: handlerName,
      patterns
    });

    patterns.forEach((pattern) => {
      if (seenPatterns.has(pattern)) {
        return;
      }

      seenPatterns.add(pattern);
      uniquePatterns.push(pattern);
    });
  }

  if (handlerConfigs.length === 0) {
    throw new Error(`Watchdog config must define at least one handler: ${configPath}`);
  }

  if (!handlerConfigs.some((handlerConfig) => handlerConfig.name === "path_index")) {
    throw new Error(`Watchdog config must define a "path_index" handler: ${configPath}`);
  }

  return {
    configPath,
    handlers: handlerConfigs,
    patterns: uniquePatterns
  };
}

function cloneWatchConfig(watchConfig = {}) {
  return {
    handlers: Array.isArray(watchConfig.handlers)
      ? watchConfig.handlers.map((handler) => ({
          name: String(handler.name || ""),
          patterns: Array.isArray(handler.patterns) ? [...handler.patterns] : []
        }))
      : []
  };
}

function getWatchConfigSignature(watchConfig = {}) {
  return JSON.stringify(cloneWatchConfig(watchConfig));
}

function getFixedPatternPrefix(pattern) {
  const relativePattern = normalizePathSegment(pattern);
  const segments = relativePattern ? relativePattern.split("/") : [];
  const prefixSegments = [];

  for (const segment of segments) {
    if (/[*?[\]{}]/u.test(segment)) {
      break;
    }

    prefixSegments.push(segment);
  }

  return prefixSegments.join("/");
}

function getExistingWatchBase(absolutePath) {
  let currentPath = path.resolve(String(absolutePath || ""));

  while (true) {
    const stats = tryStat(currentPath);
    if (stats && stats.isDirectory()) {
      return currentPath;
    }

    if (currentPath === path.dirname(currentPath)) {
      return currentPath;
    }

    currentPath = path.dirname(currentPath);
  }
}

function walkDirectories(startDir, output) {
  const stats = tryStat(startDir);
  if (!stats || !stats.isDirectory()) {
    return;
  }

  output.add(startDir);

  const entries = fs.readdirSync(startDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    if (entry.name === ".git") {
      continue;
    }

    walkDirectories(path.join(startDir, entry.name), output);
  }
}

function walkFiles(startDir, callback) {
  const stats = tryStat(startDir);
  if (!stats || !stats.isDirectory()) {
    return;
  }

  const entries = fs.readdirSync(startDir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(startDir, entry.name);

    if (entry.name === ".git") {
      continue;
    }

    if (entry.isDirectory()) {
      walkFiles(fullPath, callback);
      continue;
    }

    if (entry.isFile()) {
      callback(fullPath);
    }
  }
}

function dedupeRootPaths(paths = []) {
  const normalizedPaths = [...new Set((Array.isArray(paths) ? paths : []).filter(Boolean))]
    .map((targetPath) => path.resolve(String(targetPath || "")))
    .sort((left, right) => left.length - right.length || left.localeCompare(right));
  const reducedPaths = [];

  for (const candidatePath of normalizedPaths) {
    if (
      reducedPaths.some(
        (existingPath) =>
          candidatePath === existingPath || candidatePath.startsWith(`${existingPath}${path.sep}`)
      )
    ) {
      continue;
    }

    reducedPaths.push(candidatePath);
  }

  return reducedPaths;
}

function createFullScanYieldState() {
  return {
    lastYieldAt: Date.now()
  };
}

async function maybeYieldDuringFullScan(yieldState) {
  if (!yieldState) {
    return;
  }

  if (Date.now() - yieldState.lastYieldAt < FULL_SCAN_YIELD_INTERVAL_MS) {
    return;
  }

  yieldState.lastYieldAt = Date.now();
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
}

function createCompiledPatterns(patterns) {
  return patterns.map((pattern) => {
    const normalized = normalizePathSegment(pattern);

    return {
      pattern: normalizeProjectPath(pattern),
      matcher: globToRegExp(normalized)
    };
  });
}

function collectFullScanRoots(compiledPatterns, projectRoot, runtimeParams) {
  const scanRoots = [];

  for (const { pattern } of compiledPatterns) {
    const fixedPrefix = getFixedPatternPrefix(pattern);

    for (const scanRoot of listProjectScanRoots(projectRoot, fixedPrefix, runtimeParams)) {
      scanRoots.push(getExistingWatchBase(scanRoot));
    }
  }

  return dedupeRootPaths(scanRoots);
}

function matchesCompiledPatterns(compiledPatterns, projectPath) {
  const normalized = normalizePathSegment(projectPath);

  if (!normalized) {
    return false;
  }

  if (hasIgnoredPathSegment(normalized)) {
    return false;
  }

  const candidates = normalized.endsWith("/") ? [normalized, normalized.slice(0, -1)] : [normalized];

  return compiledPatterns.some(({ matcher }) => candidates.some((candidate) => candidate && matcher.test(candidate)));
}

function toAbsolutePath(projectRoot, projectPath, runtimeParams) {
  return resolveProjectAbsolutePath(projectRoot, projectPath, runtimeParams);
}

function inferDeletedProjectPath(projectRoot, absolutePath, currentPathIndex, runtimeParams) {
  const fileProjectPath = toProjectPath(projectRoot, absolutePath, { runtimeParams });
  const directoryProjectPath = toProjectPath(projectRoot, absolutePath, {
    isDirectory: true,
    runtimeParams
  });

  if (directoryProjectPath && currentPathIndex[directoryProjectPath]) {
    return {
      isDirectory: true,
      projectPath: directoryProjectPath
    };
  }

  return {
    isDirectory: false,
    projectPath: fileProjectPath
  };
}

async function loadConfiguredHandlers(handlerDir, handlerConfigs, projectRoot, runtimeParams) {
  const configuredHandlers = [];

  for (const handlerConfig of handlerConfigs) {
    const modulePath = path.join(handlerDir, `${handlerConfig.name}.js`);
    let handlerModule;

    try {
      handlerModule = await import(pathToFileURL(modulePath).href);
    } catch (error) {
      if (error.code === "ERR_MODULE_NOT_FOUND" || error.code === "MODULE_NOT_FOUND") {
        throw new Error(`Watchdog handler "${handlerConfig.name}" was not found at ${modulePath}.`);
      }

      throw error;
    }

    const HandlerClass = handlerModule.default;

    if (
      typeof HandlerClass !== "function" ||
      !(HandlerClass === WatchdogHandler || HandlerClass.prototype instanceof WatchdogHandler)
    ) {
      throw new Error(
        `Watchdog handler "${handlerConfig.name}" must export a default class extending WatchdogHandler.`
      );
    }

    configuredHandlers.push({
      compiledPatterns: createCompiledPatterns(handlerConfig.patterns),
      instance: new HandlerClass({
        name: handlerConfig.name,
        patterns: [...handlerConfig.patterns],
        projectRoot,
        runtimeParams
      }),
      name: handlerConfig.name,
      patterns: [...handlerConfig.patterns]
    });
  }

  return configuredHandlers;
}

function listProjectAncestorDirectories(projectPath = "") {
  const normalizedProjectPath = normalizeProjectPath(projectPath, {
    isDirectory: String(projectPath || "").endsWith("/")
  });

  if (!normalizedProjectPath) {
    return [];
  }

  const segments = stripTrailingSlash(normalizedProjectPath).split("/").filter(Boolean);
  const ancestors = [];

  for (let segmentCount = segments.length - 1; segmentCount >= 2; segmentCount -= 1) {
    ancestors.push(`/${segments.slice(0, segmentCount).join("/")}/`);
  }

  return ancestors;
}

function collectProjectSyncTargets(projectPaths = [], currentPathIndex = Object.create(null)) {
  const syncTargets = new Map();

  function addSyncTarget(projectPath, metadataOnly = false) {
    const normalizedProjectPath = normalizeProjectPath(projectPath, {
      isDirectory: String(projectPath || "").endsWith("/")
    });

    if (!normalizedProjectPath) {
      return;
    }

    const existingMode = syncTargets.get(normalizedProjectPath);

    if (existingMode === false) {
      return;
    }

    syncTargets.set(normalizedProjectPath, Boolean(metadataOnly));
  }

  for (const projectPath of Array.isArray(projectPaths) ? projectPaths : []) {
    const normalizedProjectPath = normalizeProjectPath(projectPath, {
      isDirectory: String(projectPath || "").endsWith("/")
    });

    if (!normalizedProjectPath) {
      continue;
    }

    addSyncTarget(normalizedProjectPath, false);

    for (const ancestorPath of listProjectAncestorDirectories(normalizedProjectPath)) {
      addSyncTarget(ancestorPath, true);

      if (currentPathIndex[ancestorPath]) {
        break;
      }
    }
  }

  return [...syncTargets.entries()].map(([projectPath, metadataOnly]) => ({
    metadataOnly,
    projectPath
  }));
}

export function createWatchdog(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || path.join(CURRENT_DIR, "..", "..", ".."));
  const runtimeParams = options.runtimeParams || null;
  const configPath = path.resolve(options.configPath || path.join(CURRENT_DIR, "config.yaml"));
  const handlerDir = path.resolve(options.handlerDir || path.join(CURRENT_DIR, "handlers"));
  const reconcileIntervalMs = Number(options.reconcileIntervalMs ?? RECONCILE_INTERVAL_MS);
  const watchConfig = options.watchConfig !== false;
  const liveWatchEnabled =
    options.liveWatchEnabled === undefined
      ? isCustomwareWatchdogEnabled(runtimeParams)
      : Boolean(options.liveWatchEnabled);
  const replica = options.replica === true;
  const initialSnapshot = options.initialSnapshot || null;
  const stateSystem =
    options.stateSystem ||
    createStateSystem({
      replica,
      version: resolveInitialReplicatedVersion(initialSnapshot, replica)
    });
  const replicatedAreaState = Object.create(null);
  let compiledPatterns = [];
  let configuredHandlers = [];
  let currentPathIndex = Object.create(null);
  let lastConfigSignature = "";
  let operationQueue = Promise.resolve();
  let pathSyncTimer = null;
  let refreshTimer = null;
  let reconcileTimer = null;
  let configWatcher = null;
  let started = false;
  let watchConfigState = { handlers: [] };
  let watchConfigSignature = getWatchConfigSignature(watchConfigState);
  let cachedGroupIndex = null;
  let cachedGroupIndexVersion = -1;
  let cachedUserIndex = null;
  let cachedUserIndexVersion = -1;
  let configReloadPending = true;
  const pendingChangedPaths = new Set();
  const directoryWatchers = new Map();
  const handlerStates = new Map();
  const snapshotListeners = new Set();

  function cloneValue(value) {
    if (value === null || value === undefined || typeof value !== "object") {
      return value;
    }

    if (typeof structuredClone === "function") {
      return structuredClone(value);
    }

    return JSON.parse(JSON.stringify(value));
  }

  function sortStrings(values = []) {
    return [...new Set((Array.isArray(values) ? values : []).filter(Boolean))].sort((left, right) =>
      left.localeCompare(right)
    );
  }

  function getCurrentVersion() {
    return stateSystem.getVersion();
  }

  function enqueueOperation(task) {
    const operation = operationQueue.then(task, task);
    operationQueue = operation.catch(() => {});
    return operation;
  }

  function emitSnapshotEvent(event = {}) {
    const normalizedEvent = {
      ...event,
      version: Number(event.version ?? getCurrentVersion()) || getCurrentVersion()
    };

    for (const listener of snapshotListeners) {
      try {
        listener(normalizedEvent);
      } catch (error) {
        console.error("Watchdog snapshot subscriber failed.");
        console.error(error);
      }
    }
  }

  function resetDerivedIndexCaches() {
    cachedGroupIndex = null;
    cachedGroupIndexVersion = -1;
    cachedUserIndex = null;
    cachedUserIndexVersion = -1;
  }

  function updateWatchConfigState(handlerConfigs = []) {
    watchConfigState = {
      handlers: handlerConfigs.map((handlerConfig) => ({
        name: handlerConfig.name,
        patterns: [...handlerConfig.patterns]
      }))
    };
    watchConfigSignature = getWatchConfigSignature(watchConfigState);
  }

  async function configureHandlers(nextConfig) {
    configuredHandlers = await loadConfiguredHandlers(
      handlerDir,
      nextConfig.handlers,
      projectRoot,
      runtimeParams
    );
    compiledPatterns = createCompiledPatterns(nextConfig.patterns);
    updateWatchConfigState(nextConfig.handlers);
  }

  async function reloadWatchConfigIfNeeded() {
    if (!configReloadPending && configuredHandlers.length > 0) {
      return false;
    }

    const previousWatchConfigSignature = watchConfigSignature;
    const nextConfig = loadWatchdogConfig(configPath);
    const nextWatchConfigSignature = getWatchConfigSignature(nextConfig);

    if (configuredHandlers.length === 0 || nextWatchConfigSignature !== watchConfigSignature) {
      await configureHandlers(nextConfig);
    }

    lastConfigSignature = getStatsSignature(tryStat(configPath));
    configReloadPending = false;

    return previousWatchConfigSignature !== watchConfigSignature;
  }

  function ensureReplicatedArea(area) {
    if (!replicatedAreaState[area]) {
      replicatedAreaState[area] = Object.create(null);
    }

    return replicatedAreaState[area];
  }

  function removeReplicatedAreaIfEmpty(area) {
    if (replicatedAreaState[area] && Object.keys(replicatedAreaState[area]).length === 0) {
      delete replicatedAreaState[area];
    }
  }

  function rebuildCurrentPathIndexFromReplicatedState() {
    const nextPathIndex = Object.create(null);
    const fileIndexArea = replicatedAreaState[FILE_INDEX_AREA] || Object.create(null);

    Object.values(fileIndexArea).forEach((shardValue) => {
      Object.entries(shardValue || Object.create(null)).forEach(([projectPath, metadata]) => {
        nextPathIndex[projectPath] =
          metadata && typeof metadata === "object" && !Array.isArray(metadata)
            ? { ...metadata }
            : metadata;
      });
    });

    currentPathIndex = nextPathIndex;
  }

  function applyFileShardToCurrentPathIndex(shardId, nextShardValue) {
    const fileIndexArea = ensureReplicatedArea(FILE_INDEX_AREA);
    const previousShardValue = fileIndexArea[shardId] || Object.create(null);

    Object.keys(previousShardValue).forEach((projectPath) => {
      delete currentPathIndex[projectPath];
    });

    if (!nextShardValue || Object.keys(nextShardValue).length === 0) {
      delete fileIndexArea[shardId];
      removeReplicatedAreaIfEmpty(FILE_INDEX_AREA);
      return;
    }

    const clonedShardValue = clonePathIndex(nextShardValue);
    fileIndexArea[shardId] = clonedShardValue;

    Object.entries(clonedShardValue).forEach(([projectPath, metadata]) => {
      currentPathIndex[projectPath] = { ...metadata };
    });
  }

  function hydrateReplicatedAreaState(state = {}) {
    Object.keys(replicatedAreaState).forEach((area) => {
      delete replicatedAreaState[area];
    });

    Object.entries(state || {}).forEach(([area, areaValues]) => {
      if (!areaValues || typeof areaValues !== "object" || Array.isArray(areaValues)) {
        return;
      }

      const nextArea = ensureReplicatedArea(area);

      Object.entries(areaValues).forEach(([id, value]) => {
        nextArea[id] =
          area === FILE_INDEX_AREA
            ? clonePathIndex(value)
            : cloneValue(value);
      });
    });

    rebuildCurrentPathIndexFromReplicatedState();
    resetDerivedIndexCaches();
  }

  function applyReplicatedChangesToAreaState(changes = []) {
    const changedAreas = new Set();

    (Array.isArray(changes) ? changes : []).forEach((change) => {
      const area = String(change?.area || "").trim();
      const id = String(change?.id || "").trim();

      if (!area || !id) {
        return;
      }

      changedAreas.add(area);

      if (area === FILE_INDEX_AREA) {
        applyFileShardToCurrentPathIndex(id, change.deleted ? null : change.value || Object.create(null));
        return;
      }

      const targetArea = ensureReplicatedArea(area);

      if (change.deleted) {
        delete targetArea[id];
        removeReplicatedAreaIfEmpty(area);
        return;
      }

      targetArea[id] = cloneValue(change.value);
    });

    if (
      changedAreas.has("group_index") ||
      changedAreas.has("group_meta") ||
      changedAreas.has("group_user_index") ||
      changedAreas.has("session_index") ||
      changedAreas.has("user_error_index") ||
      changedAreas.has("user_index")
    ) {
      resetDerivedIndexCaches();
    }
  }

  function getRuntimeUserIndex() {
    const currentVersion = getCurrentVersion();

    if (!cachedUserIndex || cachedUserIndexVersion !== currentVersion) {
      cachedUserIndex = createRuntimeUserIndexFromAreas(replicatedAreaState);
      cachedUserIndexVersion = currentVersion;
    }

    return cachedUserIndex;
  }

  function getRuntimeGroupIndex() {
    const currentVersion = getCurrentVersion();

    if (!cachedGroupIndex || cachedGroupIndexVersion !== currentVersion) {
      cachedGroupIndex = createRuntimeGroupIndexFromAreas(replicatedAreaState);
      cachedGroupIndexVersion = currentVersion;
    }

    return cachedGroupIndex;
  }

  function markChangedProjectPath(changedProjectPaths, projectPath) {
    if (changedProjectPaths && projectPath) {
      changedProjectPaths.add(projectPath);
    }
  }

  function removeCurrentEntries(projectPath, changedProjectPaths = null) {
    const normalizedBase = stripTrailingSlash(normalizeProjectPath(projectPath));

    if (!normalizedBase) {
      return false;
    }

    let changed = false;

    for (const existingPath of Object.keys(currentPathIndex)) {
      const existingBase = stripTrailingSlash(existingPath);

      if (existingBase === normalizedBase || existingBase.startsWith(`${normalizedBase}/`)) {
        delete currentPathIndex[existingPath];
        markChangedProjectPath(changedProjectPaths, existingPath);
        changed = true;
      }
    }

    return changed;
  }

  function removeCurrentEntry(projectPath, changedProjectPaths = null) {
    let changed = false;

    for (const candidatePath of getProjectPathLookupCandidates(projectPath)) {
      if (!candidatePath || !(candidatePath in currentPathIndex)) {
        continue;
      }

      delete currentPathIndex[candidatePath];
      markChangedProjectPath(changedProjectPaths, candidatePath);
      changed = true;
    }

    return changed;
  }

  function resolvePathIndexRecord(absolutePath, entryOptions = {}) {
    const stats = entryOptions.stats || tryStat(absolutePath);
    const isDirectory =
      entryOptions.isDirectory === undefined ? stats?.isDirectory() : Boolean(entryOptions.isDirectory);
    const projectPath = stats
      ? toProjectPath(projectRoot, absolutePath, {
          isDirectory,
          runtimeParams
        })
      : "";

    if (!stats || !projectPath) {
      return null;
    }

    if (isIgnoredProjectPath(projectPath) || !matchesCompiledPatterns(compiledPatterns, projectPath)) {
      return {
        entry: null,
        projectPath
      };
    }

    return {
      entry: createPathIndexEntry(stats, {
        isDirectory
      }),
      projectPath
    };
  }

  function upsertCurrentEntry(absolutePath, entryOptions = {}, changedProjectPaths = null) {
    const record = resolvePathIndexRecord(absolutePath, entryOptions);

    if (!record) {
      return false;
    }

    if (!record.entry) {
      return removeCurrentEntries(record.projectPath, changedProjectPaths);
    }

    const existingEntry = currentPathIndex[record.projectPath];

    if (isPathIndexEntryEqual(existingEntry, record.entry)) {
      return false;
    }

    currentPathIndex[record.projectPath] = record.entry;
    markChangedProjectPath(changedProjectPaths, record.projectPath);
    return true;
  }

  function rebuildCurrentPathIndex() {
    const nextPathIndex = Object.create(null);
    const scanRoots = new Set();

    for (const { pattern } of compiledPatterns) {
      const fixedPrefix = getFixedPatternPrefix(pattern);

      for (const scanRoot of listProjectScanRoots(projectRoot, fixedPrefix, runtimeParams)) {
        scanRoots.add(scanRoot);
      }
    }

    for (const scanRoot of scanRoots) {
      const directories = new Set();
      walkDirectories(scanRoot, directories);

      directories.forEach((directoryPath) => {
        const record = resolvePathIndexRecord(directoryPath, {
          isDirectory: true
        });

        if (record?.entry) {
          nextPathIndex[record.projectPath] = record.entry;
        }
      });

      walkFiles(scanRoot, (filePath) => {
        const record = resolvePathIndexRecord(filePath);

        if (record?.entry) {
          nextPathIndex[record.projectPath] = record.entry;
        }
      });
    }

    currentPathIndex = nextPathIndex;
  }

  async function rebuildCurrentPathIndexAsync(scanRoots = []) {
    const nextPathIndex = Object.create(null);
    const nextDirectories = new Set();
    const pendingDirectories = [...dedupeRootPaths(scanRoots)];
    const visitedDirectories = new Set();
    const yieldState = createFullScanYieldState();

    for (let index = 0; index < pendingDirectories.length; index += 1) {
      const directoryPath = path.resolve(String(pendingDirectories[index] || ""));

      if (
        !directoryPath ||
        visitedDirectories.has(directoryPath) ||
        hasIgnoredPathSegment(directoryPath)
      ) {
        continue;
      }

      const directoryStats = await tryStatAsync(directoryPath);

      if (!directoryStats || !directoryStats.isDirectory()) {
        continue;
      }

      visitedDirectories.add(directoryPath);
      nextDirectories.add(directoryPath);

      const directoryRecord = resolvePathIndexRecord(directoryPath, {
        isDirectory: true,
        stats: directoryStats
      });

      if (directoryRecord?.entry) {
        nextPathIndex[directoryRecord.projectPath] = directoryRecord.entry;
      }

      let entries;

      try {
        entries = await fs.promises.readdir(directoryPath, { withFileTypes: true });
      } catch (error) {
        if (error.code === "ENOENT") {
          await maybeYieldDuringFullScan(yieldState);
          continue;
        }

        throw error;
      }

      for (const entry of entries) {
        if (entry.name === ".git") {
          continue;
        }

        const entryPath = path.join(directoryPath, entry.name);

        if (entry.isDirectory()) {
          pendingDirectories.push(entryPath);
          continue;
        }

        if (!entry.isFile()) {
          continue;
        }

        const fileStats = await tryStatAsync(entryPath);

        if (!fileStats) {
          continue;
        }

        const fileRecord = resolvePathIndexRecord(entryPath, {
          isDirectory: false,
          stats: fileStats
        });

        if (fileRecord?.entry) {
          nextPathIndex[fileRecord.projectPath] = fileRecord.entry;
        }

        await maybeYieldDuringFullScan(yieldState);
      }

      await maybeYieldDuringFullScan(yieldState);
    }

    currentPathIndex = nextPathIndex;
    return nextDirectories;
  }

  function createCurrentChangeFromProjectPath(projectPath) {
    const metadata = currentPathIndex[projectPath] || null;

    return {
      absolutePath: toAbsolutePath(projectRoot, projectPath, runtimeParams),
      exists: true,
      isDirectory: Boolean(metadata?.isDirectory ?? projectPath.endsWith("/")),
      kind: "upsert",
      metadata: metadata ? { ...metadata } : null,
      projectPath
    };
  }

  function createChangeEvent(absolutePath) {
    const stats = tryStat(absolutePath);

    if (stats && stats.isDirectory()) {
      return {
        absolutePath,
        exists: true,
        isDirectory: true,
        kind: "upsert",
        metadata: createPathIndexEntry(stats, {
          isDirectory: true
        }),
        projectPath: toProjectPath(projectRoot, absolutePath, {
          isDirectory: true,
          runtimeParams
        })
      };
    }

    if (stats) {
      return {
        absolutePath,
        exists: true,
        isDirectory: false,
        kind: "upsert",
        metadata: createPathIndexEntry(stats, {
          isDirectory: false
        }),
        projectPath: toProjectPath(projectRoot, absolutePath, {
          runtimeParams
        })
      };
    }

    const deletedPath = inferDeletedProjectPath(
      projectRoot,
      absolutePath,
      currentPathIndex,
      runtimeParams
    );

    return {
      absolutePath,
      exists: false,
      isDirectory: deletedPath.isDirectory,
      kind: "delete",
      metadata: null,
      projectPath: deletedPath.projectPath
    };
  }

  function getCurrentPaths() {
    return Object.keys(currentPathIndex).sort((left, right) => left.localeCompare(right));
  }

  function createHandlerContext(configuredHandler, matchingChanges = []) {
    return {
      changes: matchingChanges.map((change) => ({
        ...change,
        metadata:
          change.metadata && typeof change.metadata === "object" && !Array.isArray(change.metadata)
            ? { ...change.metadata }
            : change.metadata
      })),
      getCurrentPathIndex() {
        return clonePathIndex(currentPathIndex);
      },
      peekCurrentPathIndex() {
        return currentPathIndex;
      },
      getCurrentPaths() {
        return getCurrentPaths();
      },
      getIndex(name) {
        if (name === "path_index") {
          return clonePathIndex(currentPathIndex);
        }

        return handlerStates.get(name) || null;
      },
      getSnapshotVersion() {
        return getCurrentVersion();
      },
      getWatchedPaths() {
        return [...configuredHandler.patterns];
      },
      handlerName: configuredHandler.name,
      handlerPatterns: [...configuredHandler.patterns],
      projectRoot,
      runtimeParams
    };
  }

  function getCurrentMatchingChanges(compiledPatternSet) {
    return getCurrentPaths()
      .filter((projectPath) => matchesCompiledPatterns(compiledPatternSet, projectPath))
      .map((projectPath) => createCurrentChangeFromProjectPath(projectPath));
  }

  function syncHandlerState(configuredHandler) {
    handlerStates.set(configuredHandler.name, configuredHandler.instance.getState());
  }

  async function initializeHandlers() {
    handlerStates.clear();

    for (const configuredHandler of configuredHandlers) {
      await configuredHandler.instance.onStart(
        createHandlerContext(
          configuredHandler,
          getCurrentMatchingChanges(configuredHandler.compiledPatterns)
        )
      );
      syncHandlerState(configuredHandler);
    }
  }

  async function notifyHandlers(changes) {
    if (!Array.isArray(changes) || changes.length === 0) {
      return;
    }

    for (const configuredHandler of configuredHandlers) {
      const matchingChanges = changes.filter(
        (change) =>
          change.projectPath &&
          matchesCompiledPatterns(configuredHandler.compiledPatterns, change.projectPath)
      );

      if (matchingChanges.length === 0) {
        continue;
      }

      await configuredHandler.instance.onChanges(createHandlerContext(configuredHandler, matchingChanges));
      syncHandlerState(configuredHandler);
    }
  }

  function removeDirectoryWatchersUnder(directoryPath) {
    const prefix = `${directoryPath}${path.sep}`;

    for (const [watchedPath, watcher] of directoryWatchers.entries()) {
      if (watchedPath === directoryPath || watchedPath.startsWith(prefix)) {
        watcher.close();
        directoryWatchers.delete(watchedPath);
      }
    }
  }

  function schedulePathSync(targetPath) {
    if (replica || !liveWatchEnabled || hasIgnoredPathSegment(targetPath)) {
      return;
    }

    if (targetPath) {
      pendingChangedPaths.add(targetPath);
    }

    if (pathSyncTimer) {
      clearTimeout(pathSyncTimer);
    }

    pathSyncTimer = setTimeout(() => {
      pathSyncTimer = null;
      void processPendingPathChangesSafely();
    }, REFRESH_DEBOUNCE_MS);
  }

  function watchDirectory(directoryPath) {
    if (replica || !liveWatchEnabled || directoryWatchers.has(directoryPath)) {
      return;
    }

    try {
      const watcher = fs.watch(directoryPath, (_eventType, fileName) => {
        if (!fileName) {
          schedulePathSync(directoryPath);
          return;
        }

        schedulePathSync(path.join(directoryPath, String(fileName)));
      });

      watcher.on("error", () => {
        watcher.close();
        directoryWatchers.delete(directoryPath);
        schedulePathSync(directoryPath);
      });

      directoryWatchers.set(directoryPath, watcher);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }

  function watchDirectoryTree(startDir) {
    const directories = new Set();
    walkDirectories(startDir, directories);

    for (const directoryPath of directories) {
      watchDirectory(directoryPath);
    }
  }

  function closeRemovedWatchers(nextDirectorySet) {
    for (const [directoryPath, watcher] of directoryWatchers.entries()) {
      if (nextDirectorySet.has(directoryPath)) {
        continue;
      }

      watcher.close();
      directoryWatchers.delete(directoryPath);
    }
  }

  function syncAbsolutePath(targetPath, options = {}) {
    if (hasIgnoredPathSegment(targetPath)) {
      return false;
    }

    const changedProjectPaths = options.changedProjectPaths || null;
    const stats = tryStat(targetPath);

    if (!stats) {
      const deletedPath = inferDeletedProjectPath(
        projectRoot,
        targetPath,
        currentPathIndex,
        runtimeParams
      );
      removeDirectoryWatchersUnder(targetPath);
      return removeCurrentEntries(deletedPath.projectPath, changedProjectPaths);
    }

    const projectPath = toProjectPath(projectRoot, targetPath, {
      isDirectory: stats.isDirectory(),
      runtimeParams
    });

    if (stats.isDirectory()) {
      let changed = removeCurrentEntries(projectPath, changedProjectPaths);

      if (!replica) {
        if (liveWatchEnabled) {
          watchDirectoryTree(targetPath);
        }
      }

      changed = upsertCurrentEntry(targetPath, {
        isDirectory: true,
        stats
      }, changedProjectPaths) || changed;

      const directories = new Set();
      walkDirectories(targetPath, directories);
      directories.forEach((directoryPath) => {
        changed =
          upsertCurrentEntry(directoryPath, {
            isDirectory: true
          }, changedProjectPaths) || changed;
      });

      walkFiles(targetPath, (filePath) => {
        changed = upsertCurrentEntry(filePath, {}, changedProjectPaths) || changed;
      });

      return changed;
    }

    const directoryProjectPath = normalizeProjectPath(projectPath, {
      isDirectory: true
    });
    const changed = currentPathIndex[directoryProjectPath]
      ? removeCurrentEntries(directoryProjectPath, changedProjectPaths)
      : removeCurrentEntry(projectPath, changedProjectPaths);

    return upsertCurrentEntry(targetPath, {
      isDirectory: false,
      stats
    }, changedProjectPaths) || changed;
  }

  function syncMetadataOnlyPath(targetPath, options = {}) {
    if (hasIgnoredPathSegment(targetPath)) {
      return false;
    }

    const changedProjectPaths = options.changedProjectPaths || null;
    const stats = tryStat(targetPath);

    if (!stats) {
      const deletedPath = inferDeletedProjectPath(
        projectRoot,
        targetPath,
        currentPathIndex,
        runtimeParams
      );
      removeDirectoryWatchersUnder(targetPath);
      return removeCurrentEntry(deletedPath.projectPath, changedProjectPaths);
    }

    if (!stats.isDirectory()) {
      return syncAbsolutePath(targetPath, options);
    }

    const projectPath = toProjectPath(projectRoot, targetPath, {
      isDirectory: true,
      runtimeParams
    });
    const existed = Boolean(projectPath && currentPathIndex[projectPath]);

    if (!replica && liveWatchEnabled) {
      if (existed) {
        watchDirectory(targetPath);
      } else {
        watchDirectoryTree(targetPath);
      }
    }

    return upsertCurrentEntry(targetPath, {
      isDirectory: true,
      stats
    }, changedProjectPaths);
  }

  function buildReplicatedStateChanges(options = {}) {
    const fullReshard = options.fullReshard === true;
    const changes = Array.isArray(options.changes) ? options.changes : [];
    const previousUserIndex = options.previousUserIndex || getRuntimeUserIndex();
    const previousGroupIndex = options.previousGroupIndex || getRuntimeGroupIndex();
    const nextUserIndex = handlerStates.get("user_index") || getRuntimeUserIndex();
    const nextGroupIndex = handlerStates.get("group_index") || getRuntimeGroupIndex();
    const stateChanges = [];
    const previousFileShardIds = Object.keys(replicatedAreaState[FILE_INDEX_AREA] || Object.create(null));
    const nextFileShards = fullReshard ? buildFileIndexShards(currentPathIndex) : null;
    const fileChangeProjectPaths = fullReshard
      ? []
      : [
          ...new Set(
            (Array.isArray(options.fileChangeProjectPaths) ? options.fileChangeProjectPaths : [])
              .map((projectPath) => normalizeProjectPath(projectPath, {
                isDirectory: String(projectPath || "").endsWith("/")
              }))
              .filter(Boolean)
          )
        ];
    const nextFileShardIds = fullReshard ? Object.keys(nextFileShards || Object.create(null)) : [];
    const incrementalFileChangesByShard = new Map();

    if (!fullReshard) {
      fileChangeProjectPaths.forEach((projectPath) => {
        const shardId = getFileIndexShardId(projectPath);

        if (!shardId) {
          return;
        }

        if (!incrementalFileChangesByShard.has(shardId)) {
          incrementalFileChangesByShard.set(shardId, []);
        }

        incrementalFileChangesByShard.get(shardId).push(projectPath);
      });
    }

    const fileShardIds = fullReshard
      ? sortStrings([...previousFileShardIds, ...nextFileShardIds])
      : collectFileIndexShardIdsFromProjectPaths(fileChangeProjectPaths);

    fileShardIds.forEach((shardId) => {
      const shardValue = fullReshard
        ? nextFileShards?.[shardId] || Object.create(null)
        : clonePathIndex(replicatedAreaState[FILE_INDEX_AREA]?.[shardId] || Object.create(null));

      if (!fullReshard) {
        for (const projectPath of incrementalFileChangesByShard.get(shardId) || []) {
          const metadata = currentPathIndex[projectPath];

          if (metadata) {
            shardValue[projectPath] = { ...metadata };
          } else {
            delete shardValue[projectPath];
          }
        }
      }

      stateChanges.push(
        Object.keys(shardValue).length > 0
          ? {
              area: FILE_INDEX_AREA,
              id: shardId,
              value: shardValue
            }
          : {
              area: FILE_INDEX_AREA,
              deleted: true,
              id: shardId
            }
      );
    });

    const affectedUsernames = fullReshard
      ? sortStrings([
          ...Object.keys(previousUserIndex?.users || Object.create(null)),
          ...Object.keys(nextUserIndex?.users || Object.create(null))
        ])
      : collectAffectedUsernames(changes);

    if (affectedUsernames.length > 0) {
      stateChanges.push(
        ...buildUserIndexShardChanges(previousUserIndex, nextUserIndex, affectedUsernames)
      );
    }

    if (fullReshard || hasGroupConfigChange(changes)) {
      stateChanges.push(...buildGroupIndexShardChanges(previousGroupIndex, nextGroupIndex));
    }

    return stateChanges;
  }

  function commitReplicatedState(options = {}) {
    const result = stateSystem.commitEntries(
      buildReplicatedStateChanges({
        changes: options.changes,
        fileChangeProjectPaths: options.fileChangeProjectPaths,
        fullReshard: options.fullReshard,
        previousGroupIndex: options.previousGroupIndex,
        previousUserIndex: options.previousUserIndex
      })
    );

    if (Array.isArray(result.changes) && result.changes.length > 0) {
      applyReplicatedChangesToAreaState(result.changes);
    }

    const forceSnapshot = options.forceSnapshot === true;
    const snapshot = forceSnapshot ? getSnapshot() : null;
    const projectPaths =
      Array.isArray(options.projectPaths) && options.projectPaths.length > 0
        ? [...options.projectPaths]
        : [];

    if (options.emit !== false) {
      if (snapshot) {
        emitSnapshotEvent({
          projectPaths,
          snapshot,
          type: "snapshot",
          version: result.version
        });
      } else if (result.delta) {
        emitSnapshotEvent({
          delta: result.delta,
          projectPaths,
          type: "delta",
          version: result.version
        });
      }
    }

    return {
      delta: result.delta,
      snapshot,
      version: result.version
    };
  }

  async function applyAbsolutePathChanges(absolutePaths, options = {}) {
    if (replica) {
      throw new Error("Replica watchdogs cannot apply filesystem path changes directly.");
    }

    const syncTargets = [];
    const seenTargets = new Map();

    for (const targetValue of Array.isArray(absolutePaths) ? absolutePaths : []) {
      const metadataOnly = Boolean(targetValue?.metadataOnly);
      const rawPath =
        typeof targetValue === "string"
          ? targetValue
          : targetValue?.absolutePath || targetValue?.path || "";
      const absolutePath = rawPath ? path.resolve(String(rawPath)) : "";

      if (!absolutePath) {
        continue;
      }

      if (seenTargets.has(absolutePath)) {
        if (!metadataOnly) {
          syncTargets[seenTargets.get(absolutePath)].metadataOnly = false;
        }
        continue;
      }

      seenTargets.set(absolutePath, syncTargets.length);
      syncTargets.push({
        absolutePath,
        metadataOnly
      });
    }

    if (syncTargets.length === 0) {
      return {
        delta: null,
        projectPaths: [],
        version: getCurrentVersion()
      };
    }

    let changed = false;
    const changes = [];
    const fileChangeProjectPaths = new Set();
    const previousUserIndex = handlerStates.get("user_index") || getRuntimeUserIndex();
    const previousGroupIndex = handlerStates.get("group_index") || getRuntimeGroupIndex();

    for (const target of syncTargets) {
      const change = createChangeEvent(target.absolutePath);

      if (change.projectPath && isIgnoredProjectPath(change.projectPath)) {
        continue;
      }

      const targetChanged = target.metadataOnly
        ? syncMetadataOnlyPath(target.absolutePath, {
            changedProjectPaths: fileChangeProjectPaths
          })
        : syncAbsolutePath(target.absolutePath, {
            changedProjectPaths: fileChangeProjectPaths
          });

      if (targetChanged) {
        changed = true;
        changes.push(change);
      }
    }

    const projectPathsToEmit =
      Array.isArray(options.projectPaths) && options.projectPaths.length > 0
        ? [
            ...new Set(
              options.projectPaths
                .map((value) =>
                  normalizeProjectPath(value, {
                    isDirectory: String(value || "").endsWith("/")
                  })
                )
                .filter(Boolean)
            )
          ]
        : [...new Set(changes.map((change) => change.projectPath).filter(Boolean))];

    if (!changed || changes.length === 0) {
      return {
        changed: false,
        delta: null,
        projectPaths: projectPathsToEmit,
        version: getCurrentVersion()
      };
    }

    await notifyHandlers(changes);

    const stateCommit = commitReplicatedState({
      changes,
      emit: options.emit,
      fileChangeProjectPaths: [...fileChangeProjectPaths],
      projectPaths: projectPathsToEmit,
      previousGroupIndex,
      previousUserIndex
    });

    return {
      changed,
      delta: stateCommit.delta,
      projectPaths: projectPathsToEmit,
      snapshot: stateCommit.snapshot,
      version: stateCommit.version
    };
  }

  function getConfiguredHandlers() {
    return cloneWatchConfig(watchConfigState).handlers;
  }

  function getWatchConfig() {
    return cloneWatchConfig(watchConfigState);
  }

  function getSnapshot() {
    const stateSnapshot = stateSystem.getReplicatedSnapshot();

    return {
      state: stateSnapshot.state,
      version: stateSnapshot.version,
      watchConfig: getWatchConfig()
    };
  }

  async function applySnapshotInternal(snapshot = {}, options = {}) {
    if (Number.isFinite(snapshot.version) && Number(snapshot.version) < getCurrentVersion()) {
      return getSnapshot();
    }

    const nextWatchConfig = cloneWatchConfig(snapshot.watchConfig);
    const nextWatchConfigSignature = getWatchConfigSignature(nextWatchConfig);

    if (
      nextWatchConfig.handlers.length > 0 &&
      (nextWatchConfigSignature !== watchConfigSignature || configuredHandlers.length === 0)
    ) {
      const handlerConfigs = nextWatchConfig.handlers.map((handlerConfig) => ({
        name: handlerConfig.name,
        patterns: [...handlerConfig.patterns]
      }));

      await configureHandlers({
        handlers: handlerConfigs,
        patterns: handlerConfigs.flatMap((handlerConfig) => handlerConfig.patterns)
      });
    }

    stateSystem.applySnapshot({
      state: snapshot.state,
      version: snapshot.version
    });
    hydrateReplicatedAreaState(snapshot.state);

    if (options.emit !== false) {
      emitSnapshotEvent({
        snapshot: getSnapshot(),
        type: "snapshot",
        version: getCurrentVersion()
      });
    }

    return getSnapshot();
  }

  async function applyDeltaInternal(delta = {}, options = {}) {
    const result = stateSystem.applyDelta(delta);

    if (result.applied) {
      applyReplicatedChangesToAreaState(delta.changes);
    }

    if (options.emit !== false && result.applied) {
      emitSnapshotEvent({
        delta,
        type: "delta",
        version: getCurrentVersion()
      });
    }

    return {
      applied: result.applied,
      version: getCurrentVersion()
    };
  }

  async function refreshInternal() {
    if (replica) {
      return getSnapshot();
    }

    const previousUserIndex = handlerStates.get("user_index") || getRuntimeUserIndex();
    const previousGroupIndex = handlerStates.get("group_index") || getRuntimeGroupIndex();
    const configChanged = await reloadWatchConfigIfNeeded();
    const nextDirectories = await rebuildCurrentPathIndexAsync(
      collectFullScanRoots(compiledPatterns, projectRoot, runtimeParams)
    );

    closeRemovedWatchers(nextDirectories);

    for (const directoryPath of nextDirectories) {
      watchDirectory(directoryPath);
    }

    await initializeHandlers();

    commitReplicatedState({
      emit: true,
      forceSnapshot: configChanged,
      fullReshard: true,
      previousGroupIndex,
      previousUserIndex
    });

    return getSnapshot();
  }

  async function refresh() {
    return enqueueOperation(async () => {
      try {
        return await refreshInternal();
      } finally {
        if (!replica && started) {
          scheduleNextReconcile();
        }
      }
    });
  }

  async function refreshSafely() {
    try {
      await refresh();
    } catch (error) {
      console.error("Failed to refresh watchdog state.");
      console.error(error);
    }
  }

  async function processPendingPathChanges() {
    const pathsToSync = [...pendingChangedPaths];
    pendingChangedPaths.clear();

    if (pathsToSync.length === 0) {
      return;
    }

    await enqueueOperation(async () => applyAbsolutePathChanges(pathsToSync));
  }

  async function processPendingPathChangesSafely() {
    try {
      await processPendingPathChanges();
    } catch (error) {
      console.error("Failed to apply watched file changes incrementally.");
      console.error(error);
      scheduleRefresh();
    }
  }

  function scheduleRefresh(options = {}) {
    if (options.reloadConfig) {
      configReloadPending = true;
    }

    if (refreshTimer) {
      return;
    }

    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      void refreshSafely();
    }, REFRESH_DEBOUNCE_MS);
    refreshTimer.unref?.();
  }

  function startConfigWatcher() {
    if (!liveWatchEnabled) {
      return;
    }

    configWatcher = (currentStats) => {
      const nextConfigSignature = getStatsSignature(currentStats);

      if (!nextConfigSignature || nextConfigSignature === lastConfigSignature) {
        return;
      }

      lastConfigSignature = nextConfigSignature;
      scheduleRefresh({ reloadConfig: true });
    };

    fs.watchFile(configPath, { interval: Math.max(REFRESH_DEBOUNCE_MS, 100) }, configWatcher);
  }

  function scheduleNextReconcile() {
    if (
      replica ||
      !liveWatchEnabled ||
      !started ||
      !Number.isFinite(reconcileIntervalMs) ||
      reconcileIntervalMs <= 0
    ) {
      return;
    }

    if (reconcileTimer) {
      clearTimeout(reconcileTimer);
    }

    reconcileTimer = setTimeout(() => {
      reconcileTimer = null;
      void refreshSafely();
    }, reconcileIntervalMs);
    reconcileTimer.unref?.();
  }

  function startReconcileLoop() {
    scheduleNextReconcile();
  }

  async function applyProjectPathChanges(projectPaths, options = {}) {
    const normalizedProjectPaths = [
      ...new Set(
        (Array.isArray(projectPaths) ? projectPaths : [])
          .map((projectPath) =>
            normalizeProjectPath(projectPath, {
              isDirectory: String(projectPath || "").endsWith("/")
            })
          )
          .filter(Boolean)
      )
    ];

    if (normalizedProjectPaths.length === 0) {
      return {
        delta: null,
        projectPaths: [],
        version: getCurrentVersion()
      };
    }

    if (replica) {
      throw new Error("Replica watchdogs cannot scan authoritative filesystem changes.");
    }

    const expandedProjectPaths = collectProjectSyncTargets(normalizedProjectPaths, currentPathIndex);
    const absolutePaths = expandedProjectPaths.map((target) => ({
      absolutePath: toAbsolutePath(projectRoot, target.projectPath, runtimeParams),
      metadataOnly: target.metadataOnly
    }));

    return enqueueOperation(async () =>
      applyAbsolutePathChanges(absolutePaths, {
        emit: options.emit,
        projectPaths: normalizedProjectPaths
      })
    );
  }

  async function applySnapshot(snapshot, options = {}) {
    return enqueueOperation(async () => applySnapshotInternal(snapshot, options));
  }

  async function applyStateDelta(delta, options = {}) {
    return enqueueOperation(async () => applyDeltaInternal(delta, options));
  }

  return {
    applyProjectPathChanges,
    applySnapshot,
    applyStateDelta,
    covers(projectPath) {
      return matchesCompiledPatterns(compiledPatterns, projectPath);
    },
    getConfiguredHandlers,
    getIndex(name) {
      if (name === "group_index") {
        return getRuntimeGroupIndex();
      }

      if (name === "path_index") {
        return currentPathIndex;
      }

      if (name === "user_index") {
        return getRuntimeUserIndex();
      }

      return handlerStates.get(name) || null;
    },
    getPaths() {
      return Object.keys(currentPathIndex).sort((left, right) => left.localeCompare(right));
    },
    getSnapshot,
    getStateSystem() {
      return stateSystem;
    },
    getVersion() {
      return getCurrentVersion();
    },
    getWatchConfig,
    hasPath(projectPath) {
      return getProjectPathLookupCandidates(projectPath).some(
        (candidate) => candidate && Boolean(currentPathIndex[candidate])
      );
    },
    refresh,
    async start() {
      if (started) {
        return;
      }

      if (replica && initialSnapshot) {
        await applySnapshotInternal(initialSnapshot, {
          emit: false
        });
      } else {
        await refresh();
      }

      started = true;

      if (!replica) {
        if (watchConfig) {
          startConfigWatcher();
        }

        startReconcileLoop();
      }
    },
    stop() {
      if (pathSyncTimer) {
        clearTimeout(pathSyncTimer);
        pathSyncTimer = null;
      }

      if (refreshTimer) {
        clearTimeout(refreshTimer);
        refreshTimer = null;
      }

      if (configWatcher) {
        fs.unwatchFile(configPath, configWatcher);
        configWatcher = null;
      }

      if (reconcileTimer) {
        clearTimeout(reconcileTimer);
        reconcileTimer = null;
      }

      for (const watcher of directoryWatchers.values()) {
        watcher.close();
      }

      pendingChangedPaths.clear();
      directoryWatchers.clear();
      started = false;
    },
    subscribe(listener) {
      if (typeof listener !== "function") {
        return () => {};
      }

      snapshotListeners.add(listener);
      return () => {
        snapshotListeners.delete(listener);
      };
    },
    waitForVersion(minVersion, options = {}) {
      return stateSystem.waitForVersion(minVersion, options);
    }
  };
}
