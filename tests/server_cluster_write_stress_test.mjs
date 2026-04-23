#!/usr/bin/env node

import cluster from "node:cluster";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import inspector from "node:inspector";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";

import { startServer } from "../server/server.js";

const execFileAsync = promisify(execFile);
const DEFAULT_SEED_FILE_COUNTS = [0, 2_000, 10_000];
const DEFAULT_WORKERS = 4;
const DEFAULT_REQUESTS = 200;
const DEFAULT_CONCURRENCY = 32;
const DEFAULT_FILES_PER_DIRECTORY = 200;
const DEFAULT_USER_COUNT = 1;
const DEFAULT_RESTART_RUNS = 0;
const DEFAULT_STARTUP_THRESHOLD_MS = 30_000;
const DEFAULT_WATCHDOG_ENABLED = true;

function parseArgs(argv) {
  const args = {};

  for (let index = 0; index < argv.length; index += 1) {
    const entry = String(argv[index] || "");

    if (!entry.startsWith("--")) {
      continue;
    }

    const key = entry.slice(2).replace(/-/g, "_");
    const next = argv[index + 1];

    if (!next || String(next).startsWith("--")) {
      args[key] = true;
      continue;
    }

    args[key] = next;
    index += 1;
  }

  return args;
}

function parseInteger(value, label, fallback = null) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const parsed = Math.floor(Number(value));

  if (!Number.isFinite(parsed)) {
    throw new Error(`${label} must be an integer.`);
  }

  return parsed;
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const normalized = String(value).trim().toLowerCase();

  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  throw new Error(`Expected a boolean value, received "${value}".`);
}

function parseIntegerList(value, label, fallback = []) {
  if (value === undefined || value === null || value === "") {
    return [...fallback];
  }

  const values = String(value)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => parseInteger(entry, label));

  if (values.length === 0) {
    throw new Error(`${label} must include at least one integer.`);
  }

  return values;
}

function summarizeWorkerHits(workerHits = {}) {
  return Object.entries(workerHits)
    .sort(([left], [right]) => Number(left) - Number(right))
    .map(([workerNumber, count]) => `${workerNumber}:${count}`)
    .join(" ");
}

async function getClockTicksPerSecond() {
  try {
    const { stdout } = await execFileAsync("getconf", ["CLK_TCK"]);
    const ticks = Number(String(stdout || "").trim());
    return Number.isFinite(ticks) && ticks > 0 ? ticks : 100;
  } catch {
    return 100;
  }
}

async function readLinuxCpuTicks(pid) {
  try {
    const statText = await fs.readFile(`/proc/${pid}/stat`, "utf8");
    const fields = statText
      .slice(statText.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/u);

    return Number(fields[11] || 0) + Number(fields[12] || 0);
  } catch {
    return null;
  }
}

async function readProcSnapshots(pids = []) {
  const entries = await Promise.all(
    pids.map(async (pid) => [pid, await readLinuxCpuTicks(pid)])
  );

  return Object.fromEntries(entries);
}

function computeProcessCpuMetrics(before = {}, after = {}, elapsedMs, clockTicksPerSecond) {
  const metrics = Object.create(null);

  for (const pid of Object.keys(after)) {
    const beforeTicks = Number(before[pid]);
    const afterTicks = Number(after[pid]);

    if (!Number.isFinite(beforeTicks) || !Number.isFinite(afterTicks)) {
      metrics[pid] = null;
      continue;
    }

    const cpuMs = ((afterTicks - beforeTicks) * 1000) / clockTicksPerSecond;
    metrics[pid] = {
      corePct: elapsedMs > 0 ? (cpuMs / elapsedMs) * 100 : 0,
      cpuMs
    };
  }

  return metrics;
}

async function ensureBenchmarkTree(customwarePath) {
  await fs.mkdir(path.join(customwarePath, "L2"), { recursive: true });
}

function createBenchmarkUsernames(userCount) {
  const normalizedUserCount = Math.max(1, Number(userCount) || 1);

  if (normalizedUserCount === 1) {
    return ["user"];
  }

  const width = Math.max(4, String(normalizedUserCount).length);

  return Array.from({ length: normalizedUserCount }, (_, index) =>
    `user-${String(index + 1).padStart(width, "0")}`
  );
}

async function seedBenchmarkFiles(customwarePath, seedCount, filesPerDirectory, usernames = []) {
  await ensureBenchmarkTree(customwarePath);

  const writes = [];

  for (const username of usernames) {
    const benchRoot = path.join(customwarePath, "L2", username, "bench");
    const seedRoot = path.join(customwarePath, "L2", username, "seed");

    writes.push(fs.mkdir(benchRoot, { recursive: true }));

    for (let index = 0; index < seedCount; index += 1) {
      const directoryPath = path.join(seedRoot, `d${Math.floor(index / filesPerDirectory)}`);
      const filePath = path.join(directoryPath, `f${index}.txt`);

      writes.push(
        fs
          .mkdir(directoryPath, { recursive: true })
          .then(() => fs.writeFile(filePath, `seed-${index}`))
      );
    }
  }

  await Promise.all(writes);
}

async function writeRequest(baseUrl, request) {
  const response = await fetch(new URL("/api/file_write", baseUrl), {
    body: JSON.stringify({
      content: `payload-${request.index}-${Math.random().toString(16).slice(2)}`,
      path: request.path
    }),
    headers: {
      connection: "close",
      "content-type": "application/json"
    },
    method: "POST"
  });

  const responseText = await response.text();

  if (response.status !== 200) {
    throw new Error(`Write ${request.index} failed with ${response.status}: ${responseText}`);
  }

  return Number(response.headers.get("Space-Worker") || 0);
}

function createWriteRequests(requestCount, usernames = []) {
  const normalizedUsernames = usernames.length > 0 ? usernames : ["user"];

  return Array.from({ length: requestCount }, (_, index) => {
    const username = normalizedUsernames[index % normalizedUsernames.length];
    const pathPrefix = normalizedUsernames.length === 1 ? "~" : `L2/${username}`;

    return {
      index,
      path: `${pathPrefix}/bench/write-${index}.txt`,
      username
    };
  });
}

async function runConcurrentWrites(baseUrl, requestTargets, concurrency) {
  let nextIndex = 0;
  const latenciesMs = [];
  const workerHits = new Map();
  const userHits = new Map();

  async function runner() {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;

      if (currentIndex >= requestTargets.length) {
        return;
      }

      const request = requestTargets[currentIndex];
      const startedAt = performance.now();
      const workerNumber = await writeRequest(baseUrl, request);
      const latencyMs = performance.now() - startedAt;

      latenciesMs.push(latencyMs);
      workerHits.set(workerNumber, (workerHits.get(workerNumber) || 0) + 1);
      userHits.set(request.username, (userHits.get(request.username) || 0) + 1);
    }
  }

  await Promise.all(
    Array.from({ length: concurrency }, () => runner())
  );

  latenciesMs.sort((left, right) => left - right);

  function percentile(fraction) {
    if (latenciesMs.length === 0) {
      return 0;
    }

    const index = Math.min(
      latenciesMs.length - 1,
      Math.floor((latenciesMs.length - 1) * fraction)
    );
    return latenciesMs[index];
  }

  return {
    latenciesMs,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    p99Ms: percentile(0.99),
    requestCount: requestTargets.length,
    userHits: Object.fromEntries(
      [...userHits.entries()].sort(([left], [right]) => left.localeCompare(right))
    ),
    workerHits: Object.fromEntries(
      [...workerHits.entries()].sort(([left], [right]) => left - right)
    )
  };
}

function countIndexedUserRoots(pathIndex = Object.create(null)) {
  const usernames = new Set();

  Object.keys(pathIndex || Object.create(null)).forEach((projectPath) => {
    const match = String(projectPath || "").match(/^\/app\/L2\/([^/]+)\/$/u);

    if (match?.[1]) {
      usernames.add(match[1]);
    }
  });

  return usernames.size;
}

async function startRuntimeWithMetrics(runtimeOverrides = {}) {
  const startedAt = performance.now();
  const primaryCpuStart = process.cpuUsage();
  const runtime = await startServer(runtimeOverrides);
  const elapsedMs = performance.now() - startedAt;
  const primaryCpuUsage = process.cpuUsage(primaryCpuStart);
  const pathIndex = runtime.watchdog?.getIndex?.("path_index") || Object.create(null);

  return {
    metrics: {
      indexedPathCount: Object.keys(pathIndex).length,
      indexedUserCount: countIndexedUserRoots(pathIndex),
      primaryCpuMs: (primaryCpuUsage.user + primaryCpuUsage.system) / 1000,
      startupElapsedMs: elapsedMs
    },
    runtime
  };
}

function summarizeProfile(profile, limit = 10) {
  const grouped = new Map();

  for (const node of Array.isArray(profile?.nodes) ? profile.nodes : []) {
    const hitCount = Number(node?.hitCount || 0);

    if (!hitCount) {
      continue;
    }

    const functionName = String(node?.callFrame?.functionName || "(anonymous)");
    const url = String(node?.callFrame?.url || "");
    const line = Number(node?.callFrame?.lineNumber || 0) + 1;
    const column = Number(node?.callFrame?.columnNumber || 0) + 1;
    const key = `${functionName}|${url}|${line}|${column}`;
    const existing = grouped.get(key) || {
      column,
      functionName,
      hitCount: 0,
      line,
      url
    };

    existing.hitCount += hitCount;
    grouped.set(key, existing);
  }

  return [...grouped.values()]
    .sort((left, right) => right.hitCount - left.hitCount)
    .slice(0, limit);
}

function summarizeHotspots(profileSummary = [], options = {}) {
  const labels = [];
  const primaryBound = options.primaryBound === true;

  if (
    profileSummary.some(
      (entry) =>
        entry.url.includes("state_shards.js") &&
        ["buildFileIndexShardValue", "collectFileIndexShardIds", "sortStrings"].includes(
          entry.functionName
        )
    )
  ) {
    labels.push("file_index shard publication");
  }

  if (
    profileSummary.some(
      (entry) =>
        entry.functionName === "structuredClone" ||
        (entry.functionName === "cloneStateValue" && entry.url.includes("state_system.js"))
    )
  ) {
    labels.push("replicated-state cloning");
  }

  if (
    profileSummary.some(
      (entry) =>
        entry.functionName === "stat" ||
        ["removeCurrentEntries", "upsertCurrentEntry"].includes(entry.functionName)
    )
  ) {
    labels.push("watchdog path resync");
  }

  return [...new Set(labels)];
}

function buildScenarioAnalysis(result) {
  const primaryMetrics = result.processCpu?.[String(result.primaryPid)] || null;
  const workerMetrics = Object.entries(result.processCpu || {})
    .filter(([pid]) => Number(pid) !== result.primaryPid)
    .map(([, metrics]) => metrics)
    .filter(Boolean);
  const maxWorkerCorePct = workerMetrics.reduce(
    (current, metrics) => Math.max(current, Number(metrics?.corePct || 0)),
    0
  );
  const primaryBound = Boolean(primaryMetrics && primaryMetrics.corePct >= 80 && maxWorkerCorePct <= 25);
  const hotspots = summarizeHotspots(result.profileSummary, {
    primaryBound,
    seedFiles: result.seedFiles
  });

  if (primaryBound && hotspots.length > 0) {
    return `Primary-bound write path: ${hotspots.join(", ")}.`;
  }

  if (primaryBound) {
    return "Primary-bound write path under clustered load.";
  }

  return "No dominant primary-side hotspot detected from this run.";
}

function buildRunSummary(results = []) {
  if (results.length < 2) {
    const onlyResult = results[0] || null;
    const restartTimes = Array.isArray(onlyResult?.restarts)
      ? onlyResult.restarts.map((restart) => Number(restart.startupElapsedMs) || 0)
      : [];

    return [
      onlyResult
        ? `seeded ${onlyResult.totalSeedFiles} files across ${onlyResult.userCount} users`
        : null,
      onlyResult
        ? `startup ${onlyResult.startup.startupElapsedMs.toFixed(1)}ms${onlyResult.startup.timedOut ? " (exceeds threshold)" : ""}`
        : null,
      restartTimes.length > 0
        ? `restart max ${Math.max(...restartTimes).toFixed(1)}ms over ${restartTimes.length} runs`
        : null,
      onlyResult ? `likely bottleneck: ${onlyResult.analysis}` : null
    ].filter(Boolean);
  }

  const ordered = [...results].sort((left, right) => left.seedFiles - right.seedFiles);
  const baseline = ordered[0];
  const stress = ordered[ordered.length - 1];

  const throughputDrop = stress.throughputPerSec > 0
    ? baseline.throughputPerSec / stress.throughputPerSec
    : Infinity;
  const baselinePrimary = baseline.processCpu?.[String(baseline.primaryPid)] || null;
  const stressPrimary = stress.processCpu?.[String(stress.primaryPid)] || null;
  const maxStressRestartMs = Math.max(
    0,
    ...(Array.isArray(stress.restarts)
      ? stress.restarts.map((restart) => Number(restart.startupElapsedMs) || 0)
      : [])
  );
  const thresholdExceeded =
    Boolean(stress.startup?.timedOut) ||
    (Array.isArray(stress.restarts) ? stress.restarts.some((restart) => restart.timedOut) : false);

  return [
    `throughput ${baseline.throughputPerSec.toFixed(1)} -> ${stress.throughputPerSec.toFixed(1)} req/s (${throughputDrop.toFixed(1)}x slower) as seeded files per user rose ${baseline.seedFiles} -> ${stress.seedFiles} across ${stress.userCount} users (${baseline.totalSeedFiles} -> ${stress.totalSeedFiles} total files)`,
    baselinePrimary && stressPrimary
      ? `primary core usage ${baselinePrimary.corePct.toFixed(1)}% -> ${stressPrimary.corePct.toFixed(1)}% over the same range`
      : null,
    stress.startup
      ? `startup ${baseline.startup.startupElapsedMs.toFixed(1)}ms -> ${stress.startup.startupElapsedMs.toFixed(1)}ms${maxStressRestartMs > 0 ? `, restart max ${maxStressRestartMs.toFixed(1)}ms` : ""}${thresholdExceeded ? " (threshold exceeded)" : ""}`
      : null,
    `likely bottleneck: ${stress.analysis}`
  ].filter(Boolean);
}

async function runScenario({
  clockTicksPerSecond,
  concurrency,
  filesPerDirectory,
  gitHistoryEnabled,
  profileEnabled,
  requests,
  restartRuns,
  seedFiles: seedFileCount,
  startupThresholdMs,
  userCount,
  watchdogEnabled,
  workers
}) {
  const customwarePath = await fs.mkdtemp(path.join(os.tmpdir(), "space-cluster-write-stress-"));
  const usernames = createBenchmarkUsernames(userCount);
  const requestTargets = createWriteRequests(requests, usernames);
  const runtimeParamOverrides = {
    CUSTOMWARE_GIT_HISTORY: gitHistoryEnabled ? "true" : "false",
    CUSTOMWARE_PATH: customwarePath,
    CUSTOMWARE_WATCHDOG: watchdogEnabled ? "true" : "false",
    HOST: "127.0.0.1",
    PORT: "0",
    SINGLE_USER_APP: "true",
    WORKERS: String(workers)
  };
  let runtime = null;
  let profiler = null;
  let primaryCpuStart = process.cpuUsage();

  try {
    await seedBenchmarkFiles(customwarePath, seedFileCount, filesPerDirectory, usernames);

    const startupResult = await startRuntimeWithMetrics({
      runtimeParamOverrides
    });
    runtime = startupResult.runtime;

    const workerPids = Object.values(cluster.workers || {})
      .map((worker) => worker?.process?.pid)
      .filter((pid) => Number.isFinite(pid));
    const expectedWorkerPids = workers > 1 ? workers : 0;

    if (workerPids.length !== expectedWorkerPids) {
      throw new Error(`Expected ${expectedWorkerPids} worker processes, started ${workerPids.length}.`);
    }

    const trackedPids = [process.pid, ...workerPids];
    const procCpuBefore = await readProcSnapshots(trackedPids);
    let profileSummary = [];

    if (profileEnabled) {
      profiler = new inspector.Session();
      profiler.connect();
      const post = (method, params = {}) =>
        new Promise((resolve, reject) => {
          profiler.post(method, params, (error, result) => {
            if (error) {
              reject(error);
              return;
            }

            resolve(result);
          });
        });

      await post("Profiler.enable");
      await post("Profiler.start");
      profiler.postAsync = post;
    }

    primaryCpuStart = process.cpuUsage();
    const startedAt = performance.now();
    const writeResults = await runConcurrentWrites(runtime.browserUrl, requestTargets, concurrency);
    const elapsedMs = performance.now() - startedAt;
    const primaryCpuUsage = process.cpuUsage(primaryCpuStart);

    if (profileEnabled && profiler?.postAsync) {
      const { profile } = await profiler.postAsync("Profiler.stop");
      profileSummary = summarizeProfile(profile);
    }

    const procCpuAfter = await readProcSnapshots(trackedPids);
    const processCpu = computeProcessCpuMetrics(
      procCpuBefore,
      procCpuAfter,
      elapsedMs,
      clockTicksPerSecond
    );
    const primaryWorkerCount = Object.keys(writeResults.workerHits).length;

    if (workers > 1 && writeResults.requestCount >= workers * 4 && primaryWorkerCount < 2) {
      throw new Error(`Expected writes to reach multiple workers, observed ${primaryWorkerCount}.`);
    }

    const result = {
      analysis: "",
      concurrency,
      elapsedMs,
      filesPerDirectory,
      gitHistoryEnabled,
      p50Ms: writeResults.p50Ms,
      p95Ms: writeResults.p95Ms,
      p99Ms: writeResults.p99Ms,
      primaryCpuMs: (primaryCpuUsage.user + primaryCpuUsage.system) / 1000,
      primaryPid: process.pid,
      processCpu,
      profileSummary,
      requests: writeResults.requestCount,
      restarts: [],
      seedFiles: seedFileCount,
      startup: {
        ...startupResult.metrics,
        timedOut: startupResult.metrics.startupElapsedMs > startupThresholdMs
      },
      throughputPerSec: writeResults.requestCount / (elapsedMs / 1000),
      totalSeedFiles: seedFileCount * usernames.length,
      userCount: usernames.length,
      userHits: writeResults.userHits,
      watchdogEnabled,
      workerHits: writeResults.workerHits,
      workerPids,
      workers
    };

    result.analysis = buildScenarioAnalysis(result);

    if (runtime) {
      await runtime.close();
      runtime = null;
    }

    for (let restartIndex = 0; restartIndex < restartRuns; restartIndex += 1) {
      const restartResult = await startRuntimeWithMetrics({
        runtimeParamOverrides
      });

      runtime = restartResult.runtime;
      result.restarts.push({
        ...restartResult.metrics,
        restartIndex: restartIndex + 1,
        timedOut: restartResult.metrics.startupElapsedMs > startupThresholdMs
      });

      await runtime.close();
      runtime = null;
    }

    return result;
  } finally {
    if (profiler) {
      try {
        profiler.disconnect();
      } catch {}
    }

    if (runtime) {
      await runtime.close();
    }

    await fs.rm(customwarePath, { force: true, recursive: true });
  }
}

function printHumanSummary(settings, results) {
  process.stdout.write("Clustered Write Stress Test\n");
  process.stdout.write(
    `workers=${settings.workers} requests=${settings.requests} concurrency=${settings.concurrency} gitHistory=${settings.gitHistoryEnabled} watchdog=${settings.watchdogEnabled}\n`
  );
  process.stdout.write(
    `users=${settings.userCount} restartRuns=${settings.restartRuns} startupThresholdMs=${settings.startupThresholdMs}\n`
  );
  process.stdout.write(`seedFilesPerUser=${settings.seedFileCounts.join(",")}\n\n`);

  for (const result of results) {
    const primaryProcessCpu = result.processCpu?.[String(result.primaryPid)] || null;

    process.stdout.write(
      [
        `seedPerUser=${result.seedFiles}`,
        `totalSeeded=${result.totalSeedFiles}`,
        `users=${result.userCount}`,
        `watchdog=${result.watchdogEnabled}`,
        `startup=${result.startup.startupElapsedMs.toFixed(1)}ms${result.startup.timedOut ? " (exceeds threshold)" : ""}`,
        `elapsed=${result.elapsedMs.toFixed(1)}ms`,
        `throughput=${result.throughputPerSec.toFixed(1)} req/s`,
        `latency p50=${result.p50Ms.toFixed(1)}ms p95=${result.p95Ms.toFixed(1)}ms p99=${result.p99Ms.toFixed(1)}ms`,
        `primaryCpu=${result.primaryCpuMs.toFixed(1)}ms${primaryProcessCpu ? ` (${primaryProcessCpu.corePct.toFixed(1)}% core)` : ""}`,
        `indexedPaths=${result.startup.indexedPathCount}`,
        `indexedUsers=${result.startup.indexedUserCount}`,
        `workerHits=${summarizeWorkerHits(result.workerHits)}`,
        `analysis=${result.analysis}`
      ].join(" | ") + "\n"
    );

    if (result.restarts.length > 0) {
      process.stdout.write(
        `  restarts: ${result.restarts
          .map(
            (restart) =>
              `#${restart.restartIndex} ${restart.startupElapsedMs.toFixed(1)}ms${restart.timedOut ? " !" : ""}`
          )
          .join(" | ")}\n`
      );
    }

    if (result.profileSummary.length > 0) {
      process.stdout.write("  profile hotspots:\n");

      for (const hotspot of result.profileSummary.slice(0, 5)) {
        const location = hotspot.url ? `${hotspot.url}:${hotspot.line}` : "native";
        process.stdout.write(
          `  - ${hotspot.functionName} @ ${location} hits=${hotspot.hitCount}\n`
        );
      }
    }
  }

  const summaryLines = buildRunSummary(results);

  if (summaryLines.length > 0) {
    process.stdout.write("\nsummary\n");
    summaryLines.forEach((line) => {
      process.stdout.write(`- ${line}\n`);
    });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const seedFileCounts = parseIntegerList(
    args.seed_files,
    "seed-files",
    DEFAULT_SEED_FILE_COUNTS
  );
  const workers = parseInteger(args.workers, "workers", DEFAULT_WORKERS);
  const requests = parseInteger(args.requests, "requests", DEFAULT_REQUESTS);
  const concurrency = parseInteger(args.concurrency, "concurrency", DEFAULT_CONCURRENCY);
  const filesPerDirectory = parseInteger(
    args.files_per_directory,
    "files-per-directory",
    DEFAULT_FILES_PER_DIRECTORY
  );
  const gitHistoryEnabled = parseBoolean(args.git_history, false);
  const jsonOnly = parseBoolean(args.json, false);
  const profileEnabled = parseBoolean(args.profile, false);
  const restartRuns = parseInteger(args.restart_runs, "restart-runs", DEFAULT_RESTART_RUNS);
  const profileSeedFiles = parseInteger(
    args.profile_seed_files,
    "profile-seed-files",
    seedFileCounts[seedFileCounts.length - 1]
  );
  const startupThresholdMs = parseInteger(
    args.startup_threshold_ms,
    "startup-threshold-ms",
    DEFAULT_STARTUP_THRESHOLD_MS
  );
  const userCount = parseInteger(args.user_count, "user-count", DEFAULT_USER_COUNT);
  const watchdogEnabled = parseBoolean(args.watchdog, DEFAULT_WATCHDOG_ENABLED);

  if (workers < 1) {
    throw new Error("workers must be at least 1.");
  }

  if (
    requests <= 0 ||
    concurrency <= 0 ||
    filesPerDirectory <= 0 ||
    restartRuns < 0 ||
    userCount <= 0
  ) {
    throw new Error(
      "requests, concurrency, files-per-directory, and user-count must be positive, and restart-runs must be non-negative."
    );
  }

  const clockTicksPerSecond = await getClockTicksPerSecond();
  const settings = {
    clockTicksPerSecond,
    concurrency,
    filesPerDirectory,
    gitHistoryEnabled,
    profileEnabled,
    profileSeedFiles,
    requests,
    restartRuns,
    seedFileCounts,
    startupThresholdMs,
    watchdogEnabled,
    userCount,
    workers
  };
  const results = [];

  for (const seedFiles of seedFileCounts) {
    results.push(
      await runScenario({
        clockTicksPerSecond,
        concurrency,
        filesPerDirectory,
        gitHistoryEnabled,
        profileEnabled: profileEnabled && seedFiles === profileSeedFiles,
        requests,
        restartRuns,
        seedFiles,
        startupThresholdMs,
        userCount,
        watchdogEnabled,
        workers
      })
    );
  }

  if (!jsonOnly) {
    printHumanSummary(settings, results);
    process.stdout.write("\n");
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        results,
        settings,
        summary: buildRunSummary(results)
      },
      null,
      2
    )}\n`
  );
}

await main();
