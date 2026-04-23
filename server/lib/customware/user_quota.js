import fs from "node:fs";
import path from "node:path";

import {
  normalizeAppProjectPath,
  parseAppProjectPath,
  resolveProjectAbsolutePath
} from "./layout.js";
import { getFileIndexShardId } from "../file_watch/state_shards.js";
import { FILE_INDEX_AREA } from "../../runtime/state_areas.js";

const USER_FOLDER_SIZE_LIMIT_PARAM = "USER_FOLDER_SIZE_LIMIT_BYTES";
const userFolderSizeCache = new Map();

function createEmptyRecordMap() {
  return Object.create(null);
}

function createQuotaError(message, statusCode = 413) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function getUserFolderSizeLimitBytes(runtimeParams) {
  const rawLimit =
    runtimeParams && typeof runtimeParams.get === "function"
      ? runtimeParams.get(USER_FOLDER_SIZE_LIMIT_PARAM, 0)
      : 0;
  const limitBytes = Math.floor(Number(rawLimit) || 0);

  return Number.isFinite(limitBytes) && limitBytes > 0 ? limitBytes : 0;
}

function toCacheKey(absolutePath) {
  return path.resolve(String(absolutePath || ""));
}

function stripTrailingSlash(value) {
  const text = String(value || "");
  return text.endsWith("/") ? text.slice(0, -1) : text;
}

function getProjectPathLookupCandidates(projectPath) {
  const normalizedProjectPath = normalizeAppProjectPath(projectPath, {
    allowAppRoot: true,
    isDirectory: String(projectPath || "").endsWith("/")
  });

  if (!normalizedProjectPath) {
    return [];
  }

  const baseProjectPath = stripTrailingSlash(normalizedProjectPath);
  return normalizedProjectPath.endsWith("/")
    ? [normalizedProjectPath, baseProjectPath]
    : [normalizedProjectPath, `${baseProjectPath}/`];
}

function getWatchdogPathIndex(watchdog) {
  if (!watchdog || typeof watchdog.getIndex !== "function") {
    return null;
  }

  const pathIndex = watchdog.getIndex("path_index");
  return pathIndex && typeof pathIndex === "object" && !Array.isArray(pathIndex) ? pathIndex : null;
}

function getStateSystemFileIndexShard(stateSystem, shardId) {
  if (!stateSystem || typeof stateSystem.getValue !== "function") {
    return null;
  }

  const normalizedShardId = String(shardId || "").trim();

  if (!normalizedShardId) {
    return null;
  }

  const shardValue = stateSystem.getValue(FILE_INDEX_AREA, normalizedShardId);
  return shardValue && typeof shardValue === "object" && !Array.isArray(shardValue) ? shardValue : null;
}

function getIndexedProjectPathMap(options = {}, projectPath) {
  const shardId = getFileIndexShardId(projectPath);
  const stateShard = getStateSystemFileIndexShard(options.stateSystem, shardId);

  if (stateShard) {
    return stateShard;
  }

  if (options.pathIndex && typeof options.pathIndex === "object" && !Array.isArray(options.pathIndex)) {
    return options.pathIndex;
  }

  return getWatchdogPathIndex(options.watchdog);
}

function getIndexedProjectPathSize(options = {}, projectPath) {
  const candidates = getProjectPathLookupCandidates(projectPath);

  if (candidates.length === 0) {
    return null;
  }

  const indexedProjectPaths = getIndexedProjectPathMap(options, candidates[0]);

  if (!indexedProjectPaths) {
    return null;
  }

  const existingMetadata = candidates
    .map((candidateProjectPath) => indexedProjectPaths[candidateProjectPath])
    .find((metadata) => metadata && typeof metadata === "object" && !Array.isArray(metadata));

  if (existingMetadata && existingMetadata.isDirectory !== true) {
    return Math.max(0, Number(existingMetadata.sizeBytes) || 0);
  }

  const directoryProjectPath =
    candidates.find((candidateProjectPath) => candidateProjectPath.endsWith("/")) ||
    `${stripTrailingSlash(candidates[0])}/`;
  let totalBytes = 0;
  let matched = false;

  for (const [candidateProjectPath, metadata] of Object.entries(
    indexedProjectPaths || createEmptyRecordMap()
  )) {
    if (!candidateProjectPath.startsWith(directoryProjectPath)) {
      continue;
    }

    matched = true;

    if (metadata && typeof metadata === "object" && !Array.isArray(metadata) && metadata.isDirectory !== true) {
      totalBytes += Math.max(0, Number(metadata.sizeBytes) || 0);
    }
  }

  return matched ? totalBytes : null;
}

function readAbsolutePathSize(absolutePath) {
  const targetPath = String(absolutePath || "");

  if (!targetPath) {
    return 0;
  }

  let stats;

  try {
    stats = fs.lstatSync(targetPath);
  } catch (error) {
    if (error.code === "ENOENT") {
      return 0;
    }

    throw error;
  }

  if (!stats.isDirectory()) {
    return Number(stats.size) || 0;
  }

  let totalBytes = 0;

  for (const entry of fs.readdirSync(targetPath, { withFileTypes: true })) {
    totalBytes += readAbsolutePathSize(path.join(targetPath, entry.name));
  }

  return totalBytes;
}

function getCachedUserFolderSize(target, options = {}) {
  const cacheKey = toCacheKey(target?.rootAbsolutePath || target);
  const cachedEntry = userFolderSizeCache.get(cacheKey);

  if (cachedEntry) {
    return cachedEntry.bytes;
  }

  const indexedBytes = getIndexedProjectPathSize(options, target?.rootProjectPath);
  const bytes =
    indexedBytes === null ? readAbsolutePathSize(target?.rootAbsolutePath || cacheKey) : indexedBytes;

  userFolderSizeCache.set(cacheKey, {
    bytes
  });
  return bytes;
}

function resolveUserFolderQuotaTarget(projectRoot, projectPath, runtimeParams) {
  const pathInfo = parseAppProjectPath(projectPath);

  if (
    !pathInfo ||
    pathInfo.kind !== "owner-path" ||
    pathInfo.layer !== "L2" ||
    pathInfo.ownerType !== "user" ||
    !pathInfo.ownerId
  ) {
    return null;
  }

  const rootProjectPath = `/app/L2/${pathInfo.ownerId}/`;
  const rootAbsolutePath = resolveProjectAbsolutePath(projectRoot, rootProjectPath, runtimeParams);

  if (!rootAbsolutePath) {
    return null;
  }

  return {
    appPath: `L2/${pathInfo.ownerId}/`,
    cacheKey: toCacheKey(rootAbsolutePath),
    ownerId: pathInfo.ownerId,
    rootAbsolutePath,
    rootProjectPath
  };
}

function formatByteCount(bytes) {
  return `${Math.max(0, Number(bytes) || 0)} bytes`;
}

function createUserFolderQuotaPlan(options = {}, deltas = []) {
  const limitBytes = getUserFolderSizeLimitBytes(options.runtimeParams);

  if (!limitBytes) {
    return {
      enabled: false,
      entries: [],
      limitBytes
    };
  }

  const entriesByCacheKey = new Map();

  for (const delta of Array.isArray(deltas) ? deltas : []) {
    const deltaBytes = Number(delta?.deltaBytes) || 0;

    if (!delta?.projectPath) {
      continue;
    }

    const target = resolveUserFolderQuotaTarget(
      String(options.projectRoot || ""),
      delta.projectPath,
      options.runtimeParams
    );

    if (!target) {
      continue;
    }

    const entry =
      entriesByCacheKey.get(target.cacheKey) || {
        ...target,
        currentBytes: getCachedUserFolderSize(target, options),
        deltaBytes: 0,
        limitBytes
      };

    entry.deltaBytes += deltaBytes;
    entriesByCacheKey.set(target.cacheKey, entry);
  }

  const entries = [...entriesByCacheKey.values()].map((entry) => ({
    ...entry,
    projectedBytes: Math.max(0, entry.currentBytes + entry.deltaBytes)
  }));

  for (const entry of entries) {
    if (entry.currentBytes > limitBytes) {
      if (entry.projectedBytes < entry.currentBytes) {
        continue;
      }

      throw createQuotaError(
        `User folder size limit exceeded for ${entry.appPath}: current size is ${formatByteCount(entry.currentBytes)}, limit is ${formatByteCount(limitBytes)}, and this write would not reduce it.`
      );
    }

    if (entry.projectedBytes > limitBytes) {
      throw createQuotaError(
        `User folder size limit exceeded for ${entry.appPath}: projected size is ${formatByteCount(entry.projectedBytes)}, limit is ${formatByteCount(limitBytes)}.`
      );
    }
  }

  return {
    enabled: true,
    entries,
    limitBytes
  };
}

function applyUserFolderQuotaPlan(plan) {
  if (!plan?.enabled) {
    return;
  }

  for (const entry of Array.isArray(plan.entries) ? plan.entries : []) {
    userFolderSizeCache.set(entry.cacheKey, {
      bytes: Math.max(0, Number(entry.projectedBytes) || 0)
    });
  }
}

function invalidateUserFolderSizeCacheForProjectPaths(options = {}, projectPaths = []) {
  for (const projectPath of Array.isArray(projectPaths) ? projectPaths : []) {
    const target = resolveUserFolderQuotaTarget(
      String(options.projectRoot || ""),
      projectPath,
      options.runtimeParams
    );

    if (target) {
      userFolderSizeCache.delete(target.cacheKey);
    }
  }
}

function clearUserFolderSizeCache() {
  userFolderSizeCache.clear();
}

export {
  USER_FOLDER_SIZE_LIMIT_PARAM,
  applyUserFolderQuotaPlan,
  clearUserFolderSizeCache,
  createUserFolderQuotaPlan,
  getUserFolderSizeLimitBytes,
  invalidateUserFolderSizeCacheForProjectPaths,
  getIndexedProjectPathSize,
  readAbsolutePathSize
};
