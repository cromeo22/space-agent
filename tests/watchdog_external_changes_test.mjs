import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createUser } from "../server/lib/auth/user_manage.js";
import { createGroup } from "../server/lib/customware/group_files.js";
import { createWatchdog } from "../server/lib/file_watch/watchdog.js";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(TEST_DIR, "..");

function createStaticRuntimeParams(values = {}) {
  return {
    get(name, fallback = undefined) {
      return Object.prototype.hasOwnProperty.call(values, name) ? values[name] : fallback;
    }
  };
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitFor(condition, description, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }

    await wait(25);
  }

  throw new Error(`Timed out waiting for ${description}.`);
}

function createCustomwareRuntimeParams(customwarePath) {
  return createStaticRuntimeParams({
    CUSTOMWARE_GIT_HISTORY: false,
    CUSTOMWARE_PATH: customwarePath
  });
}

test("watchdog tracks raw external nested file changes without periodic reconcile", async (testContext) => {
  const customwarePath = fs.mkdtempSync(path.join(os.tmpdir(), "space-watchdog-external-"));
  const runtimeParams = createCustomwareRuntimeParams(customwarePath);
  const watchdog = createWatchdog({
    projectRoot: PROJECT_ROOT,
    reconcileIntervalMs: 0,
    runtimeParams
  });

  testContext.after(() => {
    watchdog.stop();
    fs.rmSync(customwarePath, { force: true, recursive: true });
  });

  fs.mkdirSync(path.join(customwarePath, "L1"), { recursive: true });
  fs.mkdirSync(path.join(customwarePath, "L2"), { recursive: true });

  await watchdog.start();

  const targetDirectory = path.join(customwarePath, "L2", "alice", "notes", "nested");
  fs.mkdirSync(targetDirectory, { recursive: true });
  fs.writeFileSync(path.join(targetDirectory, "a.txt"), "hello");

  await waitFor(
    () =>
      watchdog.hasPath("/app/L2/alice/notes/nested/") &&
      watchdog.hasPath("/app/L2/alice/notes/nested/a.txt"),
    "the external nested file to appear in the watchdog index"
  );

  assert.equal(
    Boolean(watchdog.getIndex("path_index")["/app/L2/alice/notes/nested/a.txt"]),
    true
  );
});

test("watchdog tracks CLI-style user and group writes without periodic reconcile", async (testContext) => {
  const customwarePath = fs.mkdtempSync(path.join(os.tmpdir(), "space-watchdog-cli-"));
  const runtimeParams = createCustomwareRuntimeParams(customwarePath);
  const watchdog = createWatchdog({
    projectRoot: PROJECT_ROOT,
    reconcileIntervalMs: 0,
    runtimeParams
  });

  testContext.after(() => {
    watchdog.stop();
    fs.rmSync(customwarePath, { force: true, recursive: true });
  });

  fs.mkdirSync(path.join(customwarePath, "L1"), { recursive: true });
  fs.mkdirSync(path.join(customwarePath, "L2"), { recursive: true });

  await watchdog.start();

  createUser(PROJECT_ROOT, "bob", "secret123", {
    runtimeParams
  });
  createGroup(PROJECT_ROOT, "team-red", {
    runtimeParams
  });

  await waitFor(
    () =>
      watchdog.hasPath("/app/L2/bob/user.yaml") &&
      watchdog.hasPath("/app/L2/bob/meta/password.json") &&
      watchdog.hasPath("/app/L2/bob/meta/logins.json") &&
      watchdog.hasPath("/app/L1/team-red/group.yaml"),
    "the CLI-style user and group files to appear in the watchdog index"
  );

  assert.equal(Boolean(watchdog.getIndex("path_index")["/app/L1/team-red/group.yaml"]), true);
  assert.equal(Boolean(watchdog.getIndex("path_index")["/app/L2/bob/meta/password.json"]), true);
});

test("watchdog explicit project-path sync hydrates missing ancestors without a full layer rescan", async (testContext) => {
  const customwarePath = fs.mkdtempSync(path.join(os.tmpdir(), "space-watchdog-project-sync-"));
  const runtimeParams = createCustomwareRuntimeParams(customwarePath);
  const watchdog = createWatchdog({
    liveWatchEnabled: false,
    projectRoot: PROJECT_ROOT,
    reconcileIntervalMs: 0,
    runtimeParams
  });

  testContext.after(() => {
    watchdog.stop();
    fs.rmSync(customwarePath, { force: true, recursive: true });
  });

  fs.mkdirSync(path.join(customwarePath, "L1"), { recursive: true });
  fs.mkdirSync(path.join(customwarePath, "L2"), { recursive: true });

  await watchdog.start();

  const targetDirectory = path.join(customwarePath, "L2", "alice", "notes", "nested");
  const targetFile = path.join(targetDirectory, "a.txt");

  fs.mkdirSync(targetDirectory, { recursive: true });
  fs.writeFileSync(targetFile, "hello");

  await watchdog.applyProjectPathChanges(["/app/L2/alice/notes/nested/a.txt"]);

  const pathIndex = watchdog.getIndex("path_index");

  assert.equal(Boolean(pathIndex["/app/L2/alice/"]), true);
  assert.equal(Boolean(pathIndex["/app/L2/alice/notes/"]), true);
  assert.equal(Boolean(pathIndex["/app/L2/alice/notes/nested/"]), true);
  assert.equal(Boolean(pathIndex["/app/L2/alice/notes/nested/a.txt"]), true);
});

test("watchdog schedules reconciles from the previous completion instead of queuing overlap", async (testContext) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "space-watchdog-reconcile-"));
  const projectRoot = path.join(tempRoot, "project");
  const handlerDir = path.join(tempRoot, "handlers");
  const configPath = path.join(tempRoot, "watchdog.yaml");
  const pathIndexHandlerUrl = pathToFileURL(
    path.join(PROJECT_ROOT, "server", "lib", "file_watch", "handlers", "path_index.js")
  ).href;
  const watchdogModuleUrl = pathToFileURL(
    path.join(PROJECT_ROOT, "server", "lib", "file_watch", "watchdog.js")
  ).href;
  const runtimeParams = createStaticRuntimeParams({
    CUSTOMWARE_GIT_HISTORY: false
  });

  testContext.after(() => {
    fs.rmSync(tempRoot, { force: true, recursive: true });
  });

  fs.mkdirSync(path.join(projectRoot, "app", "L0"), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, "app", "L0", "seed.txt"), "seed\n");
  fs.mkdirSync(handlerDir, { recursive: true });
  fs.writeFileSync(
    path.join(handlerDir, "path_index.js"),
    `export { default } from ${JSON.stringify(pathIndexHandlerUrl)};\n`
  );
  fs.writeFileSync(
    path.join(handlerDir, "slow_counter.js"),
    `import { WatchdogHandler } from ${JSON.stringify(watchdogModuleUrl)};\n\nlet refreshCount = 0;\n\nfunction wait(ms) {\n  return new Promise((resolve) => {\n    setTimeout(resolve, ms);\n  });\n}\n\nexport function getRefreshCount() {\n  return refreshCount;\n}\n\nexport default class SlowCounterHandler extends WatchdogHandler {\n  createInitialState() {\n    return { count: refreshCount };\n  }\n\n  async onStart() {\n    refreshCount += 1;\n    await wait(80);\n    this.state = { count: refreshCount };\n  }\n}\n`
  );
  fs.writeFileSync(
    configPath,
    `path_index:\n  - /app/**/*\nslow_counter:\n  - /app/**/*\n`
  );

  const slowCounterModule = await import(pathToFileURL(path.join(handlerDir, "slow_counter.js")).href);

  const watchdog = createWatchdog({
    configPath,
    handlerDir,
    projectRoot,
    reconcileIntervalMs: 50,
    runtimeParams,
    watchConfig: false
  });

  testContext.after(() => {
    watchdog.stop();
  });

  await watchdog.start();
  await wait(230);

  const refreshCount = Number(slowCounterModule.getRefreshCount() || 0);

  assert.ok(refreshCount >= 2, `Expected at least 2 full refreshes, saw ${refreshCount}.`);
  assert.ok(
    refreshCount < 4,
    `Expected completion-anchored reconcile scheduling, saw ${refreshCount} full refreshes.`
  );
});
