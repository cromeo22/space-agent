const { spawn } = require("node:child_process");
const fsPromises = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { app, BrowserWindow, ipcMain, net, webFrameMain } = require("electron");
const {
  resolveDesktopAuthDataDir,
  resolveDesktopServerTmpDir,
  resolvePackagedDesktopUserDataPath
} = require("./server_storage_paths");
const {
  cleanupDesktopUpdaterArtifacts,
  writeDesktopUpdaterInstallMarker
} = require("./updater_artifacts");
const {
  resolveDesktopUpdaterInstallPlan,
  resolveDesktopUpdaterLogPath
} = require("./updater_install_options");
const {
  stageDesktopDebugRelease
} = require("./updater_debug_release");

const DESKTOP_FRAME_PRELOAD_PATH = path.join(__dirname, "frame-preload.js");
const DESKTOP_FRAME_INJECT_REGISTER_CHANNEL = "space-desktop:frame-inject-register";
const PROJECT_ROOT = path.resolve(__dirname, "../..");
const SERVER_APP_PATH = path.join(PROJECT_ROOT, "server", "app.js");
const BASE_WINDOW_TITLE = "Space Agent";
const DESKTOP_UPDATE_RENDERER_LOG_LIMIT = 48;
const DESKTOP_UPDATE_FAILURE_STATUS_LIMIT = 120;
const AUTH_DATA_DIR_ENV_NAME = "SPACE_AUTH_DATA_DIR";

let serverRuntime;
let mainWindow;
let isQuitting = false;
let updateStatusClearTimer = null;
let desktopAutoUpdater = null;
let desktopPageTitle = BASE_WINDOW_TITLE;
let desktopUpdateStatusMessage = "";
let desktopUpdateRendererLogQueue = [];
let isFlushingDesktopRendererLogs = false;
let lastDesktopUpdateFailureKey = "";
let lastDesktopUpdateFailureAt = 0;
let desktopUpdateCheckPromise = null;
let desktopUpdateDownloadPromise = null;
let desktopFramePreloadRegistrationId = "";
const desktopFrameInjectionRegistry = new Map();
let desktopUpdateState = {
  state: "idle",
  message: "",
  progress: null,
  version: ""
};

function applyPackagedDesktopUserDataOverride() {
  if (!app.isPackaged) {
    return "";
  }

  const currentUserDataPath = String(app.getPath("userData") || "").trim();
  const nextUserDataPath = resolvePackagedDesktopUserDataPath({
    appDataPath: app.getPath("appData"),
    defaultUserDataPath: currentUserDataPath,
    isPackaged: app.isPackaged
  });

  if (!nextUserDataPath || nextUserDataPath === currentUserDataPath) {
    return currentUserDataPath;
  }

  app.setPath("userData", nextUserDataPath);
  console.log(
    `[space-desktop] Using legacy packaged userData path ${nextUserDataPath} to preserve existing runtime state.`
  );
  return nextUserDataPath;
}

applyPackagedDesktopUserDataOverride();

function registerDesktopFramePreload(webContents) {
  if (!app.isPackaged || desktopFramePreloadRegistrationId) {
    return;
  }

  const currentSession = webContents?.session;
  if (!currentSession || typeof currentSession.registerPreloadScript !== "function") {
    return;
  }

  desktopFramePreloadRegistrationId = currentSession.registerPreloadScript({
    filePath: DESKTOP_FRAME_PRELOAD_PATH,
    id: "space-desktop-frame-preload",
    type: "frame"
  });
}

function replaceDesktopFrameInjectionRegistry(webContentsId, frames = []) {
  const nextRegistry = new Map();

  if (Array.isArray(frames)) {
    frames.forEach((entry) => {
      const frameName = String(entry?.frameName || "").trim();
      const injectPath = String(entry?.injectPath || "").trim();
      if (!frameName || !injectPath) {
        return;
      }

      nextRegistry.set(frameName, {
        frameName,
        iframeId: String(entry?.iframeId || frameName).trim() || frameName,
        injectPath
      });
    });
  }

  desktopFrameInjectionRegistry.set(webContentsId, nextRegistry);
}

function clearDesktopFrameInjectionRegistry(webContentsId) {
  desktopFrameInjectionRegistry.delete(webContentsId);
}

function getDesktopFrameInjectionEntry(webContentsId, frameName) {
  const registry = desktopFrameInjectionRegistry.get(webContentsId);
  if (!registry) {
    return null;
  }

  return registry.get(String(frameName || "").trim()) || null;
}

function getDesktopFrameInjectBaseOrigin(frame, webContents) {
  const topOrigin = String(frame?.top?.origin || "").trim();
  if (topOrigin && topOrigin !== "null") {
    return topOrigin;
  }

  try {
    return new URL(webContents?.getURL?.() || serverRuntime?.browserUrl || "").origin;
  } catch {
    return "";
  }
}

function resolveDesktopFrameInjectUrl(baseOrigin, injectPath) {
  const normalizedPath = String(injectPath || "").trim();
  if (!normalizedPath) {
    throw new Error("Desktop frame injection requires a non-empty inject path.");
  }

  if (!baseOrigin) {
    throw new Error("Desktop frame injection could not resolve the current app origin.");
  }

  let injectUrl = null;
  try {
    injectUrl = new URL(normalizedPath, `${baseOrigin}/`);
  } catch {
    throw new Error(`Desktop frame injection rejected invalid script path \"${normalizedPath}\".`);
  }

  if (!/^https?:$/u.test(injectUrl.protocol)) {
    throw new Error(`Desktop frame injection rejected non-http script path \"${normalizedPath}\".`);
  }

  if (injectUrl.origin !== baseOrigin) {
    throw new Error(`Desktop frame injection rejected cross-origin script path \"${normalizedPath}\".`);
  }

  const decodedPathname = decodeURIComponent(injectUrl.pathname);
  if (!decodedPathname.startsWith("/mod/")) {
    throw new Error(`Desktop frame injection rejected non-module script path \"${normalizedPath}\".`);
  }

  if (
    decodedPathname.includes("\\")
    || decodedPathname.includes("/../")
    || decodedPathname.endsWith("/..")
    || decodedPathname.includes("/./")
    || decodedPathname.endsWith("/.")
  ) {
    throw new Error(`Desktop frame injection rejected unsafe script path \"${normalizedPath}\".`);
  }

  if (injectUrl.username || injectUrl.password || injectUrl.search || injectUrl.hash) {
    throw new Error(`Desktop frame injection rejected decorated script path \"${normalizedPath}\".`);
  }

  return injectUrl;
}

async function fetchDesktopFrameInjectScript(currentSession, baseOrigin, injectPath) {
  const injectUrl = resolveDesktopFrameInjectUrl(baseOrigin, injectPath);
  const response = await currentSession.fetch(injectUrl.href);
  if (!response.ok) {
    throw new Error(`Desktop frame injection could not load ${injectUrl.href} (${response.status}).`);
  }

  return {
    scriptPath: injectUrl.pathname,
    scriptSource: await response.text(),
    scriptUrl: injectUrl.href
  };
}

function buildDesktopFrameInjectionSource(entry, script) {
  const bootstrap = JSON.stringify({
    iframeId: entry.iframeId,
    scriptPath: script.scriptPath,
    scriptUrl: script.scriptUrl
  });
  const sourceUrl = String(script.scriptUrl || script.scriptPath || "space-desktop-injected-script").replace(/[\r\n]+/gu, " ");

  return `(() => {\n  globalThis.__spaceBrowserFrameInjectBootstrap__ = ${bootstrap};\n  try {\n${script.scriptSource}\n  } finally {\n    delete globalThis.__spaceBrowserFrameInjectBootstrap__;\n  }\n})();\n//# sourceURL=${sourceUrl}`;
}

async function injectDesktopFrameScript(frame, entry, webContents) {
  if (!app.isPackaged || !frame || frame.isDestroyed?.()) {
    return;
  }

  const currentSession = webContents?.session;
  if (!currentSession || typeof currentSession.fetch !== "function") {
    throw new Error("Desktop frame injection requires a live renderer session.");
  }

  const baseOrigin = getDesktopFrameInjectBaseOrigin(frame, webContents);
  const script = await fetchDesktopFrameInjectScript(currentSession, baseOrigin, entry.injectPath);
  await frame.executeJavaScript(buildDesktopFrameInjectionSource(entry, script), true);
}

function maybeInjectDesktopFrame(frame, webContents) {
  if (!app.isPackaged || !frame || !webContents || frame.parent == null) {
    return;
  }

  const entry = getDesktopFrameInjectionEntry(webContents.id, frame.name);
  if (!entry) {
    return;
  }

  void injectDesktopFrameScript(frame, entry, webContents).catch((error) => {
    console.error(`[space-desktop/frame-inject] Failed to inject ${entry.injectPath} into frame \"${entry.frameName}\".`, error);
  });
}

function injectRegisteredDesktopFrames(webContents) {
  if (!app.isPackaged || !webContents || webContents.isDestroyed?.()) {
    return;
  }

  const registry = desktopFrameInjectionRegistry.get(webContents.id);
  if (!registry || !registry.size) {
    return;
  }

  const mainFrame = webContents.mainFrame;
  if (!mainFrame || mainFrame.isDestroyed?.()) {
    return;
  }

  mainFrame.framesInSubtree.forEach((frame) => {
    if (frame === mainFrame) {
      return;
    }

    maybeInjectDesktopFrame(frame, webContents);
  });
}

function createDesktopRuntimeParamOverrides() {
  const overrides = {};

  if (app.isPackaged) {
    overrides.WORKERS = "1";
    overrides.SINGLE_USER_APP = "true";
    overrides.CUSTOMWARE_PATH = path.join(app.getPath("userData"), "customware");
  }

  return overrides;
}

function createDesktopServerOptions(runtimeParamOverrides) {
  const serverOptions = {
    host: "127.0.0.1",
    port: 0,
    projectRoot: PROJECT_ROOT,
    runtimeParamOverrides
  };

  const tmpDir = resolveDesktopServerTmpDir({
    isPackaged: app.isPackaged,
    tempPath: app.getPath("temp")
  });

  if (tmpDir) {
    serverOptions.tmpDir = tmpDir;
  }

  return serverOptions;
}

function applyPackagedDesktopStorageOverrides() {
  const authDataDir = resolveDesktopAuthDataDir({
    isPackaged: app.isPackaged,
    userDataPath: app.getPath("userData")
  });

  if (authDataDir && !process.env[AUTH_DATA_DIR_ENV_NAME]) {
    process.env[AUTH_DATA_DIR_ENV_NAME] = authDataDir;
  }
}

function resolveDesktopLaunchPath() {
  return serverRuntime?.runtimeParams?.get?.("SINGLE_USER_APP", false) ? "/enter" : "/";
}

function showMainWindow() {
  if (!mainWindow) {
    return;
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }

  mainWindow.show();
  mainWindow.focus();
}

function clearUpdateStatusSoon(delayMs = 5000) {
  if (updateStatusClearTimer) {
    clearTimeout(updateStatusClearTimer);
  }

  updateStatusClearTimer = setTimeout(() => {
    updateStatusClearTimer = null;
    setDesktopUpdateStatus("");
  }, delayMs);
}

function normalizeDesktopWindowTitle(value) {
  const normalized = String(value || "").trim();
  return normalized || BASE_WINDOW_TITLE;
}

function formatDesktopDisplayVersion(value) {
  const normalized = String(value || "").trim().replace(/^v/u, "");
  if (!normalized) {
    return "";
  }

  const match = normalized.match(/^(\d+)\.(\d+)\.(\d+)$/u);
  if (!match) {
    return normalized;
  }

  return Number(match[3]) === 0 ? `${match[1]}.${match[2]}` : normalized;
}

function refreshDesktopWindowTitle() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  const titleParts = [normalizeDesktopWindowTitle(desktopPageTitle)];
  if (desktopUpdateStatusMessage) {
    titleParts.push(desktopUpdateStatusMessage);
  }

  mainWindow.setTitle(titleParts.join(" - "));
}

function setDesktopUpdateStatus(message, progress = null) {
  desktopUpdateStatusMessage = String(message || "").trim();

  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  refreshDesktopWindowTitle();

  if (progress === "indeterminate") {
    mainWindow.setProgressBar(2);
    return;
  }

  if (Number.isFinite(progress)) {
    mainWindow.setProgressBar(Math.max(0, Math.min(1, progress)));
    return;
  }

  mainWindow.setProgressBar(-1);
}

function setDesktopUpdateState(nextState = {}) {
  desktopUpdateState = {
    ...desktopUpdateState,
    ...nextState
  };

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("space-desktop:update-status", desktopUpdateState);
  }
}

function prepareDesktopForQuit() {
  isQuitting = true;
}

async function cleanupStaleDesktopUpdaterArtifacts() {
  let cleanupResult = null;

  try {
    cleanupResult = await cleanupDesktopUpdaterArtifacts({
      isPackaged: app.isPackaged,
      userDataPath: app.getPath("userData")
    });
  } catch (error) {
    logDesktopUpdateEvent("Could not clean stale desktop updater artifacts.", {
      level: "warn",
      error
    });
    return {
      cleaned: false,
      clearedPaths: [],
      marker: null,
      markerPath: "",
      removedRoots: [],
      reason: "error"
    };
  }

  if (!cleanupResult.cleaned) {
    return cleanupResult;
  }

  const targetVersion = String(cleanupResult.marker?.targetVersion || "").trim();
  const summary = cleanupResult.clearedPaths.length
    ? cleanupResult.clearedPaths
      .map((entry) => path.join(path.basename(path.dirname(entry)), path.basename(entry)))
      .join(", ")
    : "no pending payloads";
  logDesktopUpdateEvent(
    targetVersion
      ? `Cleaned stale desktop updater artifacts after the previous install attempt for ${targetVersion} (${summary}).`
      : `Cleaned stale desktop updater artifacts after the previous install attempt (${summary}).`
  );
  return cleanupResult;
}


function getDesktopRuntimeInfo() {
  const canCheckForUpdates = shouldEnableDesktopAutoUpdate() && Boolean(loadDesktopAutoUpdater());

  return {
    platform: process.platform,
    isBundledApp: app.isPackaged,
    canCheckForUpdates,
    updateStatus: desktopUpdateState
  };
}

function truncateDesktopUpdateStatus(value, maxLength = DESKTOP_UPDATE_FAILURE_STATUS_LIMIT) {
  const normalized = String(value || "").replace(/\s+/gu, " ").trim();
  if (!normalized) {
    return "";
  }

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function collectDesktopUpdateErrorDetails(error) {
  const details = [];

  if (!error || typeof error !== "object") {
    return details;
  }

  if (error.name) {
    details.push(`name: ${error.name}`);
  }

  if (error.code) {
    details.push(`code: ${error.code}`);
  }

  if (Number.isFinite(Number(error.statusCode))) {
    details.push(`statusCode: ${Number(error.statusCode)}`);
  }

  if (error.method) {
    details.push(`method: ${error.method}`);
  }

  if (error.url) {
    details.push(`url: ${error.url}`);
  }

  if (error.stack) {
    details.push(String(error.stack));
  }

  return details;
}

function formatDesktopUpdateError(error) {
  if (!error) {
    return {
      summary: "Unknown updater error.",
      details: []
    };
  }

  if (typeof error === "string") {
    const summary = String(error).trim();
    return {
      summary: summary || "Unknown updater error.",
      details: summary ? [summary] : []
    };
  }

  const summary = String(error.message || error.stack || error).trim();
  const details = collectDesktopUpdateErrorDetails(error);

  if (!details.length && summary) {
    details.push(summary);
  }

  return {
    summary: summary || "Unknown updater error.",
    details
  };
}

function queueDesktopRendererLog(level, lines) {
  const entry = {
    level,
    timestamp: new Date().toISOString(),
    lines: Array.isArray(lines) ? lines.filter(Boolean) : []
  };

  desktopUpdateRendererLogQueue.push(entry);
  if (desktopUpdateRendererLogQueue.length > DESKTOP_UPDATE_RENDERER_LOG_LIMIT) {
    desktopUpdateRendererLogQueue = desktopUpdateRendererLogQueue.slice(-DESKTOP_UPDATE_RENDERER_LOG_LIMIT);
  }
}

function flushDesktopRendererLogs() {
  if (!mainWindow || mainWindow.isDestroyed() || !desktopUpdateRendererLogQueue.length || isFlushingDesktopRendererLogs) {
    return;
  }

  const pendingEntries = desktopUpdateRendererLogQueue.slice();
  const script = `(() => {
    const entries = ${JSON.stringify(pendingEntries)};
    for (const entry of entries) {
      const method = entry.level === "error" ? "error" : entry.level === "warn" ? "warn" : "log";
      const prefix = "[space-desktop/updater]";
      const body = Array.isArray(entry.lines) ? entry.lines.join("\\n") : "";
      console[method](prefix + " " + entry.timestamp + "\\n" + body);
    }
  })();`;

  isFlushingDesktopRendererLogs = true;
  mainWindow.webContents
    .executeJavaScript(script, true)
    .then(() => {
      desktopUpdateRendererLogQueue = desktopUpdateRendererLogQueue.slice(pendingEntries.length);
      isFlushingDesktopRendererLogs = false;
      if (desktopUpdateRendererLogQueue.length) {
        flushDesktopRendererLogs();
      }
    })
    .catch(() => {
      isFlushingDesktopRendererLogs = false;
      // Keep the buffered logs so the next page load can print them.
    });
}

function logDesktopUpdateEvent(message, { level = "log", error = null } = {}) {
  const formattedError = error ? formatDesktopUpdateError(error) : null;
  const lines = [`[desktop-updater] ${message}`];

  if (formattedError?.summary) {
    lines.push(`summary: ${formattedError.summary}`);
  }

  if (formattedError?.details?.length) {
    lines.push(...formattedError.details);
  }

  lines.forEach((line) => {
    console[level](line);
  });

  queueDesktopRendererLog(level, lines);
  flushDesktopRendererLogs();

  return formattedError;
}

function buildDesktopUpdateFailureStatus(error) {
  const { summary } = formatDesktopUpdateError(error);
  return truncateDesktopUpdateStatus(`Update check failed: ${summary}`);
}

function reportDesktopUpdateFailure(message, error) {
  const formattedError = formatDesktopUpdateError(error);
  const failureKey = `${message}::${formattedError.summary}`;
  const now = Date.now();

  if (failureKey === lastDesktopUpdateFailureKey && now - lastDesktopUpdateFailureAt < 2000) {
    return formattedError;
  }

  lastDesktopUpdateFailureKey = failureKey;
  lastDesktopUpdateFailureAt = now;

  logDesktopUpdateEvent(message, { level: "error", error });
  setDesktopUpdateStatus(buildDesktopUpdateFailureStatus(error));
  setDesktopUpdateState({
    state: "error",
    message: formattedError.summary,
    progress: null,
    version: ""
  });
  clearUpdateStatusSoon(15000);

  return formattedError;
}

function shouldEnableDesktopAutoUpdate() {
  return app.isPackaged;
}

function loadDesktopAutoUpdater() {
  if (desktopAutoUpdater) {
    return desktopAutoUpdater;
  }

  try {
    ({ autoUpdater: desktopAutoUpdater } = require("electron-updater"));
  } catch (error) {
    logDesktopUpdateEvent("Desktop auto-update is unavailable.", { level: "warn", error });
    desktopAutoUpdater = null;
  }

  return desktopAutoUpdater;
}

function launchDetachedDesktopCommand(command, args = []) {
  return new Promise((resolve, reject) => {
    let childProcess = null;

    try {
      childProcess = spawn(command, args, {
        detached: true,
        stdio: "ignore",
        windowsHide: true
      });
    } catch (error) {
      reject(error);
      return;
    }

    childProcess.once("error", reject);
    childProcess.once("spawn", () => {
      childProcess.unref();
      resolve();
    });
  });
}

async function appendDesktopUpdaterPersistentLog(logPath, message, details = null) {
  const resolvedLogPath = String(logPath || "").trim();
  const normalizedMessage = String(message || "").trim();

  if (!resolvedLogPath || !normalizedMessage) {
    return;
  }

  const lines = [
    `${new Date().toISOString()} [space-desktop/updater] ${normalizedMessage}`
  ];

  if (details && typeof details === "object") {
    try {
      lines.push(JSON.stringify(details));
    } catch {
      // Keep logging best effort only.
    }
  }

  try {
    await fsPromises.mkdir(path.dirname(resolvedLogPath), {
      recursive: true
    });
    await fsPromises.appendFile(resolvedLogPath, `${lines.join("\n")}\n`, "utf8");
  } catch {
    // Persistent updater logging must never block launch or install handoff.
  }
}

function resolveDesktopUpdaterLogPathForCurrentRun() {
  return resolveDesktopUpdaterLogPath({
    userDataPath: app.getPath("userData")
  });
}

function resolveDesktopUpdaterInstallPlanForCurrentRun(autoUpdater) {
  const downloadedUpdateHelper = autoUpdater?.downloadedUpdateHelper || null;
  const downloadedFileInfo = downloadedUpdateHelper?.downloadedFileInfo || null;

  return resolveDesktopUpdaterInstallPlan({
    platform: process.platform,
    installerPath: autoUpdater?.installerPath,
    packagePath: downloadedUpdateHelper?.packageFile,
    currentExecutablePath: process.execPath,
    currentProcessId: process.pid,
    autoRunAppAfterInstall: autoUpdater?.autoRunAppAfterInstall,
    isAdminRightsRequired: downloadedFileInfo?.isAdminRightsRequired === true,
    elevatePath: path.join(process.resourcesPath, "elevate.exe"),
    logPath: resolveDesktopUpdaterLogPathForCurrentRun()
  });
}

function isDesktopNetworkOnline() {
  try {
    return !net || typeof net.isOnline !== "function" || net.isOnline();
  } catch (error) {
    reportDesktopUpdateFailure("Could not determine desktop network status.", error);
    return true;
  }
}

function resolveDesktopDebugReinstallRequestVersion(payload = {}) {
  if (typeof payload === "string") {
    return String(payload || "").trim();
  }

  if (payload && typeof payload === "object") {
    return String(payload.version || "").trim();
  }

  return "";
}

async function fetchDesktopUpdateMetadataText(metadataUrl) {
  const response = await fetch(metadataUrl, {
    headers: {
      accept: "text/yaml, text/x-yaml, text/plain, */*"
    }
  });

  if (!response.ok) {
    throw new Error(
      `Could not download desktop update metadata ${metadataUrl} (${response.status} ${response.statusText || "Unknown"}).`
    );
  }

  return await response.text();
}

async function stageDesktopDebugReinstall(payload = {}) {
  if (!shouldEnableDesktopAutoUpdate()) {
    return { ok: false, reason: "unavailable" };
  }

  const autoUpdater = loadDesktopAutoUpdater();
  if (!autoUpdater) {
    return { ok: false, reason: "unavailable" };
  }

  if (!isDesktopNetworkOnline()) {
    const message = "Debug reinstall skipped while offline.";
    logDesktopUpdateEvent(`Desktop ${message.toLowerCase()}`);
    setDesktopUpdateStatus(message);
    setDesktopUpdateState({
      state: "offline",
      message,
      progress: null,
      version: ""
    });
    clearUpdateStatusSoon();
    return { ok: false, reason: "offline", message };
  }

  const requestedVersion = resolveDesktopDebugReinstallRequestVersion(payload);
  const currentVersion = app.getVersion();
  const requestedLabel = requestedVersion || currentVersion;

  setDesktopUpdateStatus("Preparing debug reinstall...", "indeterminate");
  setDesktopUpdateState({
    state: "checking",
    message: "Preparing debug reinstall...",
    progress: null,
    version: ""
  });

  try {
    const publishConfig = await autoUpdater.configOnDisk.value;
    const stagedRelease = await stageDesktopDebugRelease({
      requestedVersion,
      currentVersion,
      platform: process.platform,
      arch: process.arch,
      publishConfig,
      fetchText: fetchDesktopUpdateMetadataText
    });
    const targetVersion = formatDesktopDisplayVersion(stagedRelease.info?.version || stagedRelease.requestedVersion);
    const action =
      stagedRelease.comparison < 0
        ? "downgrade"
        : stagedRelease.comparison === 0
          ? "reinstall"
          : "update";
    const logPath = resolveDesktopUpdaterLogPathForCurrentRun();

    autoUpdater.allowDowngrade = stagedRelease.comparison < 0;
    autoUpdater.updateInfoAndProvider = {
      info: stagedRelease.info,
      provider: stagedRelease.provider
    };

    logDesktopUpdateEvent(
      `Prepared desktop debug ${action} ${targetVersion || stagedRelease.requestedVersion} from ${stagedRelease.tag} using ${stagedRelease.metadataFileName}.`
    );

    await appendDesktopUpdaterPersistentLog(logPath, "Prepared desktop debug reinstall staging.", {
      action,
      currentVersion,
      metadataFileName: stagedRelease.metadataFileName,
      metadataUrl: stagedRelease.metadataUrl,
      requestedVersion: requestedLabel,
      targetVersion: stagedRelease.info?.version || stagedRelease.requestedVersion,
      tag: stagedRelease.tag
    });

    setDesktopUpdateStatus(targetVersion ? `Update ${targetVersion} available` : "Update available");
    setDesktopUpdateState({
      state: "update-available",
      message: targetVersion ? `Update ${targetVersion} is available.` : "A desktop update is available.",
      progress: null,
      version: targetVersion
    });

    const downloadResult = await downloadDesktopUpdate();
    if (!downloadResult?.ok) {
      return downloadResult;
    }

    return {
      ok: true,
      action,
      metadataUrl: stagedRelease.metadataUrl,
      status: desktopUpdateState.state,
      tag: stagedRelease.tag,
      version: desktopUpdateState.version || targetVersion
    };
  } catch (error) {
    const formattedError = reportDesktopUpdateFailure(
      `Desktop debug reinstall preparation failed for ${requestedLabel}.`,
      error
    );
    return {
      ok: false,
      reason: "error",
      message: formattedError.summary
    };
  }
}

async function checkForDesktopUpdates({ userInitiated = false } = {}) {
  if (!shouldEnableDesktopAutoUpdate()) {
    return { ok: false, reason: "unavailable" };
  }

  const autoUpdater = loadDesktopAutoUpdater();
  if (!autoUpdater) {
    return { ok: false, reason: "unavailable" };
  }

  if (desktopUpdateCheckPromise) {
    return desktopUpdateCheckPromise;
  }

  if (!isDesktopNetworkOnline()) {
    const message = "Update check skipped while offline.";
    logDesktopUpdateEvent(`Desktop ${message.toLowerCase()}`);
    setDesktopUpdateStatus(message);
    setDesktopUpdateState({
      state: "offline",
      message,
      progress: null,
      version: ""
    });
    clearUpdateStatusSoon();
    return { ok: false, reason: "offline", message };
  }

  desktopUpdateCheckPromise = (async () => {
    try {
      const result = await autoUpdater.checkForUpdates();
      const version = formatDesktopDisplayVersion(result?.updateInfo?.version);

      return {
        ok: true,
        status: desktopUpdateState.state || "checked",
        version
      };
    } catch (error) {
      const formattedError = reportDesktopUpdateFailure(
        userInitiated ? "Desktop update check failed." : "Desktop auto-update check failed.",
        error
      );

      return {
        ok: false,
        reason: "error",
        message: formattedError.summary
      };
    } finally {
      desktopUpdateCheckPromise = null;
    }
  })();

  return desktopUpdateCheckPromise;
}

async function downloadDesktopUpdate() {
  if (!shouldEnableDesktopAutoUpdate()) {
    return { ok: false, reason: "unavailable" };
  }

  const autoUpdater = loadDesktopAutoUpdater();
  if (!autoUpdater) {
    return { ok: false, reason: "unavailable" };
  }

  if (desktopUpdateState.state === "downloaded") {
    return { ok: true, status: "downloaded", version: desktopUpdateState.version || "" };
  }

  if (desktopUpdateDownloadPromise) {
    return desktopUpdateDownloadPromise;
  }

  if (desktopUpdateState.state !== "update-available") {
    return { ok: false, reason: "not-ready", message: "No downloaded desktop update is ready yet." };
  }

  desktopUpdateDownloadPromise = (async () => {
    try {
      await autoUpdater.downloadUpdate();
      return {
        ok: true,
        status: "downloading",
        version: desktopUpdateState.version || ""
      };
    } catch (error) {
      const formattedError = reportDesktopUpdateFailure("Desktop update download failed.", error);
      return {
        ok: false,
        reason: "error",
        message: formattedError.summary
      };
    } finally {
      desktopUpdateDownloadPromise = null;
    }
  })();

  return desktopUpdateDownloadPromise;
}

async function installDesktopUpdate() {
  if (!shouldEnableDesktopAutoUpdate()) {
    return { ok: false, reason: "unavailable" };
  }

  const autoUpdater = loadDesktopAutoUpdater();
  if (!autoUpdater) {
    return { ok: false, reason: "unavailable" };
  }

  if (desktopUpdateState.state !== "downloaded") {
    return { ok: false, reason: "not-ready", message: "No downloaded update is ready to install yet." };
  }

  logDesktopUpdateEvent("Installing downloaded desktop update.");
  setDesktopUpdateStatus("Restarting to install update...");
  setDesktopUpdateState({
    state: "installing",
    message: "",
    progress: null
  });

  let installPlan = null;

  try {
    installPlan = resolveDesktopUpdaterInstallPlanForCurrentRun(autoUpdater);
  } catch (error) {
    const formattedError = reportDesktopUpdateFailure("Desktop update install preparation failed.", error);
    return {
      ok: false,
      reason: "error",
      message: formattedError.summary
    };
  }

  if (installPlan.strategy === "deferred-powershell") {
    const logPath = String(installPlan.logPath || "").trim();
    const persistentLogDetails = {
      currentExecutablePath: process.execPath,
      currentProcessId: process.pid,
      installerArgs: installPlan.installerArgs,
      installerPath: autoUpdater?.installerPath || "",
      logPath,
      packagePath: autoUpdater?.downloadedUpdateHelper?.packageFile || "",
      targetVersion: desktopUpdateState.version || ""
    };

    await appendDesktopUpdaterPersistentLog(
      logPath,
      "Preparing deferred Windows NSIS handoff.",
      persistentLogDetails
    );

    try {
      await launchDetachedDesktopCommand(installPlan.command, installPlan.args);
    } catch (error) {
      await appendDesktopUpdaterPersistentLog(logPath, "Deferred Windows updater helper launch failed.", {
        message: String(error?.message || error || "Unknown error")
      });
      const formattedError = reportDesktopUpdateFailure("Desktop update install handoff failed.", error);
      return {
        ok: false,
        reason: "error",
        message: formattedError.summary
      };
    }

    await appendDesktopUpdaterPersistentLog(logPath, "Deferred Windows updater helper launched.", {
      command: installPlan.command
    });

    try {
      await writeDesktopUpdaterInstallMarker({
        fromVersion: app.getVersion(),
        targetVersion: desktopUpdateState.version || "",
        userDataPath: app.getPath("userData")
      });
      await appendDesktopUpdaterPersistentLog(logPath, "Updater cleanup marker written.", {
        fromVersion: app.getVersion(),
        targetVersion: desktopUpdateState.version || ""
      });
    } catch (error) {
      await appendDesktopUpdaterPersistentLog(logPath, "Could not persist the updater cleanup marker.", {
        message: String(error?.message || error || "Unknown error")
      });
      logDesktopUpdateEvent("Could not persist the desktop updater cleanup marker.", {
        level: "warn",
        error
      });
    }

    logDesktopUpdateEvent(
      logPath
        ? `Installing downloaded desktop update with the deferred Windows NSIS handoff after the app exits. Persistent log: ${logPath}`
        : "Installing downloaded desktop update with the deferred Windows NSIS handoff after the app exits."
    );

    await appendDesktopUpdaterPersistentLog(logPath, "Requesting app quit for deferred Windows update install.");

    prepareDesktopForQuit();
    setImmediate(() => {
      app.quit();
    });

    return { ok: true, status: "installing", version: desktopUpdateState.version || "" };
  }

  try {
    await stopServerRuntime();
  } catch (error) {
    const formattedError = reportDesktopUpdateFailure("Desktop update install preparation failed.", error);
    return {
      ok: false,
      reason: "error",
      message: formattedError.summary
    };
  }

  try {
    await writeDesktopUpdaterInstallMarker({
      fromVersion: app.getVersion(),
      targetVersion: desktopUpdateState.version || "",
      userDataPath: app.getPath("userData")
    });
  } catch (error) {
    logDesktopUpdateEvent("Could not persist the desktop updater cleanup marker.", {
      level: "warn",
      error
    });
  }

  logDesktopUpdateEvent("Installing downloaded desktop update with the default updater handoff.");

  // Electron emits before-quit after updater-triggered window close events on macOS,
  // so the host must mark updater restarts as real quits before calling quitAndInstall().
  prepareDesktopForQuit();
  setImmediate(() => {
    autoUpdater.quitAndInstall();
  });

  return { ok: true, status: "installing", version: desktopUpdateState.version || "" };
}

function configureDesktopAutoUpdate() {
  if (!shouldEnableDesktopAutoUpdate()) {
    return;
  }

  const autoUpdater = loadDesktopAutoUpdater();
  if (!autoUpdater) {
    return;
  }

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.disableWebInstaller = true;
  autoUpdater.disableDifferentialDownload = true;
  autoUpdater.logger = console;

  autoUpdater.on("checking-for-update", () => {
    logDesktopUpdateEvent("Checking GitHub Releases for a desktop update...");
    setDesktopUpdateStatus("Checking for updates...", "indeterminate");
    setDesktopUpdateState({
      state: "checking",
      message: "Checking for updates...",
      progress: null,
      version: ""
    });
  });

  autoUpdater.on("update-available", (info) => {
    const version = formatDesktopDisplayVersion(info?.version);
    logDesktopUpdateEvent(version ? `Desktop update available: ${version}` : "Desktop update available.");
    setDesktopUpdateStatus(version ? `Update ${version} available` : "Update available");
    setDesktopUpdateState({
      state: "update-available",
      message: version ? `Update ${version} is available.` : "A desktop update is available.",
      progress: null,
      version
    });
  });

  autoUpdater.on("update-not-available", () => {
    logDesktopUpdateEvent("Desktop app is already up to date.");
    setDesktopUpdateStatus("");
    setDesktopUpdateState({
      state: "up-to-date",
      message: "",
      progress: null,
      version: ""
    });
  });

  autoUpdater.on("error", (error) => {
    reportDesktopUpdateFailure("Desktop auto-update failed.", error);
  });

  autoUpdater.on("download-progress", (progress) => {
    const percent = Number(progress && progress.percent);
    if (!Number.isFinite(percent)) {
      setDesktopUpdateStatus("Downloading update...", "indeterminate");
      setDesktopUpdateState({
        state: "downloading",
        message: "Downloading update...",
        progress: null
      });
      return;
    }

    const message = `Downloading update ${Math.round(percent)}%`;
    setDesktopUpdateStatus(message, percent / 100);
    setDesktopUpdateState({
      state: "downloading",
      message,
      progress: percent / 100
    });
  });

  autoUpdater.on("update-downloaded", (info) => {
    const version = formatDesktopDisplayVersion(info?.version);
    logDesktopUpdateEvent(version ? `Desktop update downloaded: ${version}` : "Desktop update downloaded.");
    setDesktopUpdateStatus("Update ready to install");
    setDesktopUpdateState({
      state: "downloaded",
      message: version ? `Update ${version} is ready to install.` : "Update ready to install.",
      progress: null,
      version
    });
  });
}

async function loadCreateAgentServer() {
  const serverModule = await import(pathToFileURL(SERVER_APP_PATH).href);
  return serverModule.createAgentServer;
}

function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    showMainWindow();
    return mainWindow;
  }

  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 1024,
    minHeight: 720,
    backgroundColor: "#f2efe8",
    title: BASE_WINDOW_TITLE,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  registerDesktopFramePreload(mainWindow.webContents);

  const mainWebContentsId = mainWindow.webContents.id;
  mainWindow.webContents.once("destroyed", () => {
    clearDesktopFrameInjectionRegistry(mainWebContentsId);
  });
  mainWindow.webContents.on("did-frame-finish-load", (_event, isMainFrame, frameProcessId, frameRoutingId) => {
    if (isMainFrame) {
      return;
    }

    const frame = webFrameMain.fromId(frameProcessId, frameRoutingId);
    if (!frame) {
      return;
    }

    maybeInjectDesktopFrame(frame, mainWindow?.webContents);
  });

  desktopPageTitle = BASE_WINDOW_TITLE;
  refreshDesktopWindowTitle();

  mainWindow.on("close", (event) => {
    // On macOS, Cmd+W should hide the app and preserve renderer state.
    if (process.platform === "darwin" && !isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
    desktopPageTitle = BASE_WINDOW_TITLE;
  });

  mainWindow.webContents.on("page-title-updated", (event, title) => {
    event.preventDefault();
    desktopPageTitle = normalizeDesktopWindowTitle(title);
    refreshDesktopWindowTitle();
  });

  mainWindow.webContents.on("did-finish-load", () => {
    desktopPageTitle = normalizeDesktopWindowTitle(mainWindow?.webContents?.getTitle?.() || desktopPageTitle);
    refreshDesktopWindowTitle();
    flushDesktopRendererLogs();
    mainWindow.webContents.send("space-desktop:update-status", desktopUpdateState);
  });

  mainWindow.loadURL(`${serverRuntime.browserUrl}${resolveDesktopLaunchPath()}`);
  return mainWindow;
}

async function stopServerRuntime() {
  if (!serverRuntime) {
    return;
  }

  const runtime = serverRuntime;
  serverRuntime = null;

  if (typeof runtime.close === "function") {
    try {
      await runtime.close();
      return;
    } catch (error) {
      logDesktopUpdateEvent("Desktop server runtime close failed; falling back to best-effort shutdown.", {
        level: "warn",
        error
      });
    }
  }

  if (runtime.jobRunner && typeof runtime.jobRunner.stop === "function") {
    runtime.jobRunner.stop();
  }

  if (runtime.watchdog && typeof runtime.watchdog.stop === "function") {
    runtime.watchdog.stop();
  }

  if (runtime.tmpWatch && typeof runtime.tmpWatch.stop === "function") {
    runtime.tmpWatch.stop();
  }

  if (runtime.server && runtime.server.listening) {
    await new Promise((resolve) => {
      runtime.server.close(() => {
        resolve();
      });
    });
  }
}

async function startDesktop() {
  await app.whenReady();
  await cleanupStaleDesktopUpdaterArtifacts();
  applyPackagedDesktopStorageOverrides();
  const runtimeParamOverrides = createDesktopRuntimeParamOverrides();
  const createAgentServer = await loadCreateAgentServer();
  serverRuntime = await createAgentServer(createDesktopServerOptions(runtimeParamOverrides));
  await serverRuntime.listen();
  createWindow();
  configureDesktopAutoUpdate();

  app.on("activate", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      showMainWindow();
      return;
    }

    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

ipcMain.handle("space-desktop:get-runtime-info", () => getDesktopRuntimeInfo());
ipcMain.on(DESKTOP_FRAME_INJECT_REGISTER_CHANNEL, (event, payload = {}) => {
  replaceDesktopFrameInjectionRegistry(event.sender.id, payload.frames);
  injectRegisteredDesktopFrames(event.sender);
});
ipcMain.handle("space-desktop:check-for-updates", () => checkForDesktopUpdates({ userInitiated: true }));
ipcMain.handle("space-desktop:download-update", () => downloadDesktopUpdate());
ipcMain.handle("space-desktop:install-update", () => installDesktopUpdate());
ipcMain.handle("space-desktop:debug-reinstall", (_event, payload) => stageDesktopDebugReinstall(payload));

app.on("before-quit", () => {
  prepareDesktopForQuit();
  void stopServerRuntime();
});

startDesktop().catch((error) => {
  console.error("Failed to start desktop harness.");
  console.error(error);
  app.quit();
});
