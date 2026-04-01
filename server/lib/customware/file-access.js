import fs from "node:fs";
import path from "node:path";

import { normalizeAppProjectPath, normalizeEntityId, parseAppProjectPath } from "./layout.js";
import { createEmptyGroupIndex } from "./overrides.js";

function createHttpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function stripTrailingSlash(value) {
  const text = String(value || "");
  return text.endsWith("/") ? text.slice(0, -1) : text;
}

function toAppRelativePath(projectPath) {
  const normalizedProjectPath = normalizeAppProjectPath(projectPath, {
    allowAppRoot: true,
    isDirectory: String(projectPath || "").endsWith("/")
  });

  if (!normalizedProjectPath.startsWith("/app/")) {
    return "";
  }

  return normalizedProjectPath.slice("/app/".length);
}

function getGroupIndex(watchdog) {
  if (!watchdog || typeof watchdog.getIndex !== "function") {
    return createEmptyGroupIndex();
  }

  return watchdog.getIndex("group-index") || createEmptyGroupIndex();
}

function getPathIndex(watchdog) {
  if (!watchdog || typeof watchdog.getIndex !== "function") {
    return Object.create(null);
  }

  return watchdog.getIndex("path-index") || Object.create(null);
}

function hasPath(pathIndex, projectPath) {
  return Boolean(pathIndex && projectPath && pathIndex[projectPath]);
}

function createAppAccessController(options = {}) {
  const groupIndex = options.groupIndex || createEmptyGroupIndex();
  const username = normalizeEntityId(options.username);
  const managedGroups = new Set(
    groupIndex && typeof groupIndex.getManagedGroupsForUser === "function"
      ? groupIndex.getManagedGroupsForUser(username)
      : []
  );
  const isAdmin = Boolean(
    username &&
      groupIndex &&
      typeof groupIndex.isUserInGroup === "function" &&
      groupIndex.isUserInGroup(username, "_admin")
  );

  function canReadProjectPath(projectPath) {
    const pathInfo = parseAppProjectPath(projectPath);

    if (!pathInfo || pathInfo.kind !== "owner-path") {
      return false;
    }

    if (pathInfo.ownerType === "user") {
      return Boolean(username && pathInfo.ownerId === username);
    }

    return Boolean(
      groupIndex &&
        typeof groupIndex.isUserInGroup === "function" &&
        groupIndex.isUserInGroup(username, pathInfo.ownerId)
    );
  }

  function canWriteProjectPath(projectPath) {
    const pathInfo = parseAppProjectPath(projectPath);

    if (!pathInfo || pathInfo.kind !== "owner-path") {
      return false;
    }

    if (pathInfo.layer === "L0") {
      return false;
    }

    if (isAdmin && (pathInfo.layer === "L1" || pathInfo.layer === "L2")) {
      return true;
    }

    if (pathInfo.ownerType === "user") {
      return Boolean(pathInfo.layer === "L2" && username && pathInfo.ownerId === username);
    }

    return Boolean(pathInfo.layer === "L1" && managedGroups.has(pathInfo.ownerId));
  }

  return {
    canReadProjectPath,
    canWriteProjectPath,
    isAdmin,
    managedGroups,
    username
  };
}

function ensureReadableProjectPath(projectPath, accessController) {
  if (!accessController.canReadProjectPath(projectPath)) {
    throw createHttpError("Read access denied.", 403);
  }
}

function ensureWritableProjectPath(projectPath, accessController) {
  if (!accessController.canWriteProjectPath(projectPath)) {
    throw createHttpError("Write access denied.", 403);
  }
}

function resolveExistingProjectPath(pathIndex, inputPath) {
  const rawInput = String(inputPath || "").trim();
  const fileProjectPath = normalizeAppProjectPath(rawInput);
  const directoryProjectPath = normalizeAppProjectPath(rawInput, {
    allowAppRoot: true,
    isDirectory: true
  });
  const prefersDirectory = rawInput.endsWith("/");

  if (prefersDirectory && directoryProjectPath && hasPath(pathIndex, directoryProjectPath)) {
    return {
      exists: true,
      isDirectory: true,
      projectPath: directoryProjectPath
    };
  }

  if (fileProjectPath && hasPath(pathIndex, fileProjectPath)) {
    return {
      exists: true,
      isDirectory: false,
      projectPath: fileProjectPath
    };
  }

  if (directoryProjectPath && hasPath(pathIndex, directoryProjectPath)) {
    return {
      exists: true,
      isDirectory: true,
      projectPath: directoryProjectPath
    };
  }

  return {
    exists: false,
    isDirectory: prefersDirectory,
    projectPath: prefersDirectory ? directoryProjectPath : fileProjectPath
  };
}

function createAbsolutePath(projectRoot, projectPath) {
  return path.join(projectRoot, stripTrailingSlash(String(projectPath || "").slice(1)));
}

function ensureValidReadEncoding(encoding) {
  if (encoding === "utf8" || encoding === "base64") {
    return encoding;
  }

  throw createHttpError(`Unsupported read encoding: ${String(encoding || "")}`, 400);
}

function ensureValidWriteEncoding(encoding) {
  if (encoding === "utf8" || encoding === "base64") {
    return encoding;
  }

  throw createHttpError(`Unsupported write encoding: ${String(encoding || "")}`, 400);
}

function readAppFile(options = {}) {
  const projectRoot = String(options.projectRoot || "");
  const pathIndex = getPathIndex(options.watchdog);
  const accessController = createAppAccessController({
    groupIndex: getGroupIndex(options.watchdog),
    username: options.username
  });
  const resolvedPath = resolveExistingProjectPath(pathIndex, options.path);

  if (!resolvedPath.projectPath || !resolvedPath.exists) {
    throw createHttpError("File not found.", 404);
  }

  if (resolvedPath.isDirectory) {
    throw createHttpError("Expected a file path.", 400);
  }

  ensureReadableProjectPath(resolvedPath.projectPath, accessController);

  const encoding = ensureValidReadEncoding(String(options.encoding || "utf8").toLowerCase());
  const buffer = fs.readFileSync(createAbsolutePath(projectRoot, resolvedPath.projectPath));

  return {
    content: encoding === "base64" ? buffer.toString("base64") : buffer.toString("utf8"),
    encoding,
    path: toAppRelativePath(resolvedPath.projectPath)
  };
}

function writeAppFile(options = {}) {
  const projectRoot = String(options.projectRoot || "");
  const normalizedProjectPath = normalizeAppProjectPath(options.path);

  if (!normalizedProjectPath || normalizedProjectPath.endsWith("/")) {
    throw createHttpError("Expected a writable file path.", 400);
  }

  const accessController = createAppAccessController({
    groupIndex: getGroupIndex(options.watchdog),
    username: options.username
  });

  ensureWritableProjectPath(normalizedProjectPath, accessController);

  const encoding = ensureValidWriteEncoding(String(options.encoding || "utf8").toLowerCase());
  const content = options.content;
  const absolutePath = createAbsolutePath(projectRoot, normalizedProjectPath);
  const buffer =
    encoding === "base64"
      ? Buffer.from(String(content || ""), "base64")
      : Buffer.from(String(content ?? ""), "utf8");

  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, buffer);

  return {
    bytesWritten: buffer.length,
    encoding,
    path: toAppRelativePath(normalizedProjectPath)
  };
}

function isDescendantPath(ancestorDirectoryPath, candidatePath) {
  const ancestorBase = stripTrailingSlash(ancestorDirectoryPath);
  const candidateBase = stripTrailingSlash(candidatePath);

  return Boolean(
    ancestorBase &&
      candidateBase &&
      candidateBase !== ancestorBase &&
      candidateBase.startsWith(`${ancestorBase}/`)
  );
}

function getDirectChildPath(directoryPath, descendantPath, pathIndex) {
  const directorySegments = stripTrailingSlash(directoryPath).split("/").filter(Boolean);
  const descendantSegments = stripTrailingSlash(descendantPath).split("/").filter(Boolean);

  if (descendantSegments.length <= directorySegments.length) {
    return "";
  }

  const childBasePath = `/${descendantSegments.slice(0, directorySegments.length + 1).join("/")}`;
  const childDirectoryPath = `${childBasePath}/`;

  return hasPath(pathIndex, childDirectoryPath) ? childDirectoryPath : childBasePath;
}

function collectAncestorDirectories(targetDirectoryPath, descendantPath, pathIndex) {
  const targetSegments = stripTrailingSlash(targetDirectoryPath).split("/").filter(Boolean);
  const descendantSegments = stripTrailingSlash(descendantPath).split("/").filter(Boolean);
  const output = [];

  for (let length = targetSegments.length + 1; length < descendantSegments.length; length += 1) {
    const candidatePath = `/${descendantSegments.slice(0, length).join("/")}/`;

    if (hasPath(pathIndex, candidatePath)) {
      output.push(candidatePath);
    }
  }

  return output;
}

function listAppPaths(options = {}) {
  const pathIndex = getPathIndex(options.watchdog);
  const accessController = createAppAccessController({
    groupIndex: getGroupIndex(options.watchdog),
    username: options.username
  });
  const resolvedPath = resolveExistingProjectPath(pathIndex, options.path || "/app/");

  if (!resolvedPath.projectPath || !resolvedPath.exists) {
    throw createHttpError("Path not found.", 404);
  }

  if (!resolvedPath.isDirectory) {
    ensureReadableProjectPath(resolvedPath.projectPath, accessController);

    return {
      path: toAppRelativePath(resolvedPath.projectPath),
      paths: [toAppRelativePath(resolvedPath.projectPath)],
      recursive: false
    };
  }

  const targetPathInfo = parseAppProjectPath(resolvedPath.projectPath);

  if (targetPathInfo && targetPathInfo.kind === "owner-path") {
    ensureReadableProjectPath(resolvedPath.projectPath, accessController);
  }

  const recursive = Boolean(options.recursive);
  const allPaths = Object.keys(pathIndex).sort((left, right) => left.localeCompare(right));
  const accessibleDescendants = allPaths.filter((projectPath) => {
    if (!isDescendantPath(resolvedPath.projectPath, projectPath)) {
      return false;
    }

    const pathInfo = parseAppProjectPath(projectPath);

    if (!pathInfo || pathInfo.kind !== "owner-path") {
      return false;
    }

    return accessController.canReadProjectPath(projectPath);
  });
  const outputPaths = new Set();

  if (recursive) {
    for (const projectPath of accessibleDescendants) {
      outputPaths.add(projectPath);

      for (const ancestorPath of collectAncestorDirectories(resolvedPath.projectPath, projectPath, pathIndex)) {
        outputPaths.add(ancestorPath);
      }
    }
  } else {
    for (const projectPath of accessibleDescendants) {
      const directChildPath = getDirectChildPath(resolvedPath.projectPath, projectPath, pathIndex);

      if (directChildPath) {
        outputPaths.add(directChildPath);
      }
    }
  }

  return {
    path: toAppRelativePath(resolvedPath.projectPath),
    paths: [...outputPaths]
      .sort((left, right) => left.localeCompare(right))
      .map((projectPath) => toAppRelativePath(projectPath)),
    recursive
  };
}

export {
  createAppAccessController,
  createHttpError,
  listAppPaths,
  readAppFile,
  toAppRelativePath,
  writeAppFile
};
