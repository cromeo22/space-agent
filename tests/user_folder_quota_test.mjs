import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  copyAppPath,
  deleteAppPath,
  writeAppFile,
  writeAppFiles
} from "../server/lib/customware/file_access.js";
import { clearUserFolderSizeCache } from "../server/lib/customware/user_quota.js";
import { createRuntimeParams } from "../server/lib/utils/runtime_params.js";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(TEST_DIR, "..");

function createStaticRuntimeParams(values = {}) {
  return {
    get(name, fallback = undefined) {
      return Object.prototype.hasOwnProperty.call(values, name) ? values[name] : fallback;
    }
  };
}

function collectProjectPaths(projectRoot) {
  const appRoot = path.join(projectRoot, "app");
  const output = [];

  function walk(absolutePath) {
    if (!fs.existsSync(absolutePath)) {
      return;
    }

    const stats = fs.statSync(absolutePath);
    const relativePath = path.relative(appRoot, absolutePath).replaceAll(path.sep, "/");
    const projectPath = relativePath
      ? `/app/${relativePath}${stats.isDirectory() ? "/" : ""}`
      : "/app/";

    output.push(projectPath);

    if (!stats.isDirectory()) {
      return;
    }

    for (const entry of fs.readdirSync(absolutePath, { withFileTypes: true })) {
      walk(path.join(absolutePath, entry.name));
    }
  }

  walk(appRoot);
  return output.sort((left, right) => left.localeCompare(right));
}

function createWatchdog(projectRoot) {
  const paths = collectProjectPaths(projectRoot);
  const pathIndex = Object.create(null);
  const appRoot = path.join(projectRoot, "app");

  for (const projectPath of paths) {
    const isDirectory = projectPath.endsWith("/");
    const relativePath = projectPath
      .slice("/app/".length)
      .replace(/\/$/u, "")
      .replaceAll("/", path.sep);
    const absolutePath = relativePath ? path.join(appRoot, relativePath) : appRoot;
    const stats = fs.statSync(absolutePath);

    pathIndex[projectPath] = {
      isDirectory,
      mtimeMs: Math.trunc(Number(stats.mtimeMs || 0)),
      sizeBytes: isDirectory ? 0 : Number(stats.size || 0)
    };
  }

  return {
    getIndex(name) {
      return name === "path_index" ? pathIndex : Object.create(null);
    },
    getPaths() {
      return [...paths];
    }
  };
}

function createProjectRoot() {
  clearUserFolderSizeCache();
  return fs.mkdtempSync(path.join(os.tmpdir(), "space-user-folder-quota-"));
}

function assertQuotaError(callback) {
  assert.throws(
    callback,
    (error) => {
      assert.equal(error.statusCode, 413);
      assert.match(error.message, /User folder size limit exceeded/u);
      return true;
    }
  );
}

function readUserFile(projectRoot, username, filePath) {
  return fs.readFileSync(path.join(projectRoot, "app", "L2", username, filePath), "utf8");
}

{
  const runtimeParams = await createRuntimeParams(PROJECT_ROOT, {
    env: {},
    overrides: {
      PORT: "0",
      USER_FOLDER_SIZE_LIMIT_BYTES: "0"
    },
    storedValues: {}
  });

  assert.equal(runtimeParams.get("PORT"), 0);
  assert.equal(runtimeParams.get("USER_FOLDER_SIZE_LIMIT_BYTES"), 0);
}

{
  const projectRoot = createProjectRoot();
  const runtimeParams = createStaticRuntimeParams({
    USER_FOLDER_SIZE_LIMIT_BYTES: 10
  });

  writeAppFile({
    content: "1234567890",
    path: "~/notes.txt",
    projectRoot,
    runtimeParams,
    username: "alice"
  });

  assert.equal(readUserFile(projectRoot, "alice", "notes.txt"), "1234567890");
  assertQuotaError(() => {
    writeAppFile({
      content: "12345678901",
      path: "~/notes.txt",
      projectRoot,
      runtimeParams,
      username: "alice"
    });
  });
  assert.equal(readUserFile(projectRoot, "alice", "notes.txt"), "1234567890");
}

{
  const projectRoot = createProjectRoot();
  const runtimeParams = createStaticRuntimeParams({
    USER_FOLDER_SIZE_LIMIT_BYTES: 10
  });

  writeAppFile({
    content: "12345",
    path: "~/notes.txt",
    projectRoot,
    runtimeParams,
    username: "alice"
  });

  assertQuotaError(() => {
    writeAppFile({
      content: "678901",
      operation: "append",
      path: "~/notes.txt",
      projectRoot,
      runtimeParams,
      username: "alice"
    });
  });

  assert.equal(readUserFile(projectRoot, "alice", "notes.txt"), "12345");
}

{
  const projectRoot = createProjectRoot();
  const unboundedRuntimeParams = createStaticRuntimeParams({
    USER_FOLDER_SIZE_LIMIT_BYTES: 0
  });
  const quotaRuntimeParams = createStaticRuntimeParams({
    USER_FOLDER_SIZE_LIMIT_BYTES: 10
  });

  writeAppFile({
    content: "123456789012",
    path: "~/notes.txt",
    projectRoot,
    runtimeParams: unboundedRuntimeParams,
    username: "alice"
  });

  assertQuotaError(() => {
    writeAppFile({
      content: "abcdefghijkl",
      path: "~/notes.txt",
      projectRoot,
      runtimeParams: quotaRuntimeParams,
      username: "alice"
    });
  });

  writeAppFile({
    content: "123456789",
    path: "~/notes.txt",
    projectRoot,
    runtimeParams: quotaRuntimeParams,
    username: "alice"
  });

  assert.equal(readUserFile(projectRoot, "alice", "notes.txt"), "123456789");
}

{
  const projectRoot = createProjectRoot();
  const unboundedRuntimeParams = createStaticRuntimeParams({
    USER_FOLDER_SIZE_LIMIT_BYTES: 0
  });
  const quotaRuntimeParams = createStaticRuntimeParams({
    USER_FOLDER_SIZE_LIMIT_BYTES: 10
  });

  writeAppFile({
    content: "123456789012",
    path: "~/notes.txt",
    projectRoot,
    runtimeParams: unboundedRuntimeParams,
    username: "alice"
  });

  const result = deleteAppPath({
    path: "~/notes.txt",
    projectRoot,
    runtimeParams: quotaRuntimeParams,
    username: "alice",
    watchdog: createWatchdog(projectRoot)
  });

  assert.deepEqual(result, {
    path: "L2/alice/notes.txt"
  });
  assert.equal(fs.existsSync(path.join(projectRoot, "app", "L2", "alice", "notes.txt")), false);
}

{
  const projectRoot = createProjectRoot();
  const runtimeParams = createStaticRuntimeParams({
    USER_FOLDER_SIZE_LIMIT_BYTES: 10
  });

  assertQuotaError(() => {
    writeAppFiles({
      files: [
        {
          content: "123456",
          path: "~/a.txt"
        },
        {
          content: "12345",
          path: "~/b.txt"
        }
      ],
      projectRoot,
      runtimeParams,
      username: "alice"
    });
  });

  assert.equal(fs.existsSync(path.join(projectRoot, "app", "L2", "alice", "a.txt")), false);
  assert.equal(fs.existsSync(path.join(projectRoot, "app", "L2", "alice", "b.txt")), false);
}

{
  const projectRoot = createProjectRoot();
  const runtimeParams = createStaticRuntimeParams({
    USER_FOLDER_SIZE_LIMIT_BYTES: 10
  });

  writeAppFile({
    content: "123456",
    path: "~/a.txt",
    projectRoot,
    runtimeParams,
    username: "alice"
  });
  assertQuotaError(() => {
    writeAppFile({
      content: "12345",
      path: "~/b.txt",
      projectRoot,
      runtimeParams,
      username: "alice"
    });
  });

  writeAppFile({
    content: "123",
    path: "~/a.txt",
    projectRoot,
    runtimeParams,
    username: "alice"
  });
  writeAppFile({
    content: "1234567",
    path: "~/b.txt",
    projectRoot,
    runtimeParams,
    username: "alice"
  });

  assert.equal(readUserFile(projectRoot, "alice", "a.txt"), "123");
  assert.equal(readUserFile(projectRoot, "alice", "b.txt"), "1234567");
}

{
  const projectRoot = createProjectRoot();
  const runtimeParams = createStaticRuntimeParams({
    USER_FOLDER_SIZE_LIMIT_BYTES: 10
  });

  writeAppFile({
    content: "123456",
    path: "~/source.txt",
    projectRoot,
    runtimeParams,
    username: "alice"
  });

  assertQuotaError(() => {
    copyAppPath({
      fromPath: "~/source.txt",
      projectRoot,
      runtimeParams,
      toPath: "~/copy.txt",
      username: "alice",
      watchdog: createWatchdog(projectRoot)
    });
  });
  assert.equal(fs.existsSync(path.join(projectRoot, "app", "L2", "alice", "copy.txt")), false);
}

{
  const projectRoot = createProjectRoot();
  const unboundedRuntimeParams = createStaticRuntimeParams({
    USER_FOLDER_SIZE_LIMIT_BYTES: 0
  });
  const quotaRuntimeParams = createStaticRuntimeParams({
    USER_FOLDER_SIZE_LIMIT_BYTES: 15
  });

  writeAppFile({
    content: "12345",
    path: "~/nested/a.txt",
    projectRoot,
    runtimeParams: unboundedRuntimeParams,
    username: "alice"
  });
  writeAppFile({
    content: "1234",
    path: "~/nested/b.txt",
    projectRoot,
    runtimeParams: unboundedRuntimeParams,
    username: "alice"
  });

  const watchdog = createWatchdog(projectRoot);
  const originalLstatSync = fs.lstatSync;
  const originalReaddirSync = fs.readdirSync;

  fs.lstatSync = () => {
    throw new Error("disk quota crawl is not allowed");
  };
  fs.readdirSync = () => {
    throw new Error("disk quota crawl is not allowed");
  };

  try {
    assertQuotaError(() => {
      copyAppPath({
        fromPath: "~/nested/",
        projectRoot,
        runtimeParams: quotaRuntimeParams,
        toPath: "~/copy/",
        username: "alice",
        watchdog
      });
    });
  } finally {
    fs.lstatSync = originalLstatSync;
    fs.readdirSync = originalReaddirSync;
  }

  assert.equal(fs.existsSync(path.join(projectRoot, "app", "L2", "alice", "copy")), false);
}
