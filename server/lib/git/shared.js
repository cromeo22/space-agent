import fs from "node:fs";
import { promises as fsPromises } from "node:fs";
import path from "node:path";

export const COMMIT_HASH_PATTERN = /^[0-9a-f]{7,40}$/i;
export const SUPPORTED_GIT_BACKENDS = new Set(["native", "nodegit", "isomorphic"]);

export function createAvailableBackendResult(name, client) {
  return {
    name,
    available: true,
    client
  };
}

export function createUnavailableBackendResult(name, reason) {
  return {
    name,
    available: false,
    reason
  };
}

export function createSourceCheckoutError() {
  return new Error("The update command is only available for source installs in a real Git checkout.");
}

export function normalizeBackendName(rawValue) {
  if (!rawValue) {
    return null;
  }

  const normalizedValue = String(rawValue).trim().toLowerCase();
  if (!normalizedValue) {
    return null;
  }

  if (!SUPPORTED_GIT_BACKENDS.has(normalizedValue)) {
    throw new Error(
      `Unsupported SPACE_GIT_BACKEND value "${rawValue}". Expected one of: native, nodegit, isomorphic.`
    );
  }

  return normalizedValue;
}

export function normalizeBranchName(rawValue) {
  const value = String(rawValue || "").trim();
  if (!value) {
    return null;
  }

  if (value.startsWith("refs/heads/")) {
    return value.slice("refs/heads/".length) || null;
  }

  return value;
}

export function shortenOid(oid) {
  return String(oid || "").slice(0, 7);
}

export function normalizeGitRelativePath(value) {
  return String(value || "")
    .trim()
    .replace(/\\/gu, "/")
    .replace(/^\/+/u, "")
    .replace(/^\.\//u, "");
}

export function normalizeHistoryIgnoredPaths(ignoredPaths = []) {
  return new Set(
    (Array.isArray(ignoredPaths) ? ignoredPaths : [])
      .map((entry) => normalizeGitRelativePath(entry))
      .filter(Boolean)
  );
}

export function isHistoryIgnoredPath(filePath, ignoredPaths) {
  return ignoredPaths.has(normalizeGitRelativePath(filePath));
}

export function filterHistoryChangedFiles(files = [], ignoredPaths = []) {
  const ignoredPathSet = normalizeHistoryIgnoredPaths(ignoredPaths);

  return files.filter((filePath) => !isHistoryIgnoredPath(filePath, ignoredPathSet));
}

export function normalizeHistoryFileAction(status = "") {
  const value = String(status || "").trim().toUpperCase();

  if (value.startsWith("A")) {
    return "added";
  }

  if (value.startsWith("D")) {
    return "deleted";
  }

  return "modified";
}

export function normalizeHistoryFileEntry(entry) {
  if (typeof entry === "string") {
    const pathValue = normalizeGitRelativePath(entry);

    return pathValue
      ? {
          action: "modified",
          path: pathValue,
          status: "M"
        }
      : null;
  }

  if (!entry || typeof entry !== "object") {
    return null;
  }

  const pathValue = normalizeGitRelativePath(entry.path || entry.filePath || entry.newPath);
  const oldPath = normalizeGitRelativePath(entry.oldPath || "");
  const status = String(entry.status || "").trim().toUpperCase() || "M";

  if (!pathValue) {
    return null;
  }

  return {
    action: normalizeHistoryFileAction(status),
    oldPath,
    path: pathValue,
    status
  };
}

export function normalizeHistoryFileEntries(files = []) {
  const entriesByPath = new Map();

  for (const file of Array.isArray(files) ? files : []) {
    const entry = normalizeHistoryFileEntry(file);

    if (entry) {
      entriesByPath.set(entry.path, entry);
    }
  }

  return [...entriesByPath.values()].sort((left, right) => left.path.localeCompare(right.path));
}

export function filterHistoryFileEntries(files = [], ignoredPaths = []) {
  const ignoredPathSet = normalizeHistoryIgnoredPaths(ignoredPaths);

  return normalizeHistoryFileEntries(files).filter((entry) => !isHistoryIgnoredPath(entry.path, ignoredPathSet));
}

export function getHistoryChangedFilePaths(files = []) {
  return normalizeHistoryFileEntries(files).map((entry) => entry.path);
}

export function normalizeHistoryFileFilter(value = "") {
  const filterValue = normalizeGitRelativePath(value);

  if (!filterValue) {
    return "";
  }

  if (/[*?[\]]/u.test(filterValue)) {
    return filterValue;
  }

  return `*${filterValue}*`;
}

export function buildHistoryFilterPathspecs(value = "") {
  const filterValue = normalizeHistoryFileFilter(value);

  if (!filterValue) {
    return [];
  }

  const pathspecs = new Set([`:(glob)${filterValue}`]);

  if (!filterValue.includes("/")) {
    pathspecs.add(`:(glob)**/${filterValue}`);
  }

  return [...pathspecs];
}

export async function resolveGitContext(projectRoot) {
  const dotGitPath = path.join(projectRoot, ".git");

  let stat;
  try {
    stat = await fsPromises.stat(dotGitPath);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      throw createSourceCheckoutError();
    }
    throw error;
  }

  if (stat.isDirectory()) {
    return {
      dir: projectRoot,
      gitdir: dotGitPath
    };
  }

  if (!stat.isFile()) {
    throw createSourceCheckoutError();
  }

  const pointerFile = await fsPromises.readFile(dotGitPath, "utf8");
  const match = /^gitdir:\s*(.+)\s*$/im.exec(pointerFile);
  if (!match) {
    throw createSourceCheckoutError();
  }

  return {
    dir: projectRoot,
    gitdir: path.resolve(projectRoot, match[1].trim())
  };
}

export function isSshLikeRemoteUrl(remoteUrl) {
  const value = String(remoteUrl || "").trim();
  if (!value) {
    return false;
  }

  return /^[^/@\s]+@[^:/\s]+:.+$/.test(value) || /^ssh:\/\//i.test(value);
}

export function sanitizeRemoteUrl(remoteUrl) {
  const value = String(remoteUrl || "").trim();

  if (!value) {
    return "";
  }

  try {
    const parsedUrl = new URL(value);

    if (/^https?:$/i.test(parsedUrl.protocol)) {
      parsedUrl.username = "";
      parsedUrl.password = "";
      return parsedUrl.toString();
    }

    parsedUrl.password = "";
    return parsedUrl.toString();
  } catch {
    return value;
  }
}

export function isGitHubRemoteUrl(remoteUrl) {
  try {
    const parsedUrl = new URL(String(remoteUrl || "").trim());
    return /^github\.com$/i.test(parsedUrl.hostname);
  } catch {
    const value = String(remoteUrl || "").trim();
    return /(?:^|@)github\.com(?::|\/)/i.test(value);
  }
}

export function normalizeRemoteUrl(remoteUrl) {
  const value = String(remoteUrl || "").trim();
  if (!value) {
    throw new Error("The configured Git remote URL is empty.");
  }

  if (/^https?:\/\//i.test(value)) {
    return value;
  }

  if (/^git:\/\//i.test(value) || /^ssh:\/\//i.test(value)) {
    const url = new URL(value);
    return `https://${url.host}${url.pathname}`;
  }

  const scpLikeMatch = /^(?:[^@]+@)?([^:]+):(.+)$/.exec(value);
  if (scpLikeMatch) {
    return `https://${scpLikeMatch[1]}/${scpLikeMatch[2].replace(/^\/+/, "")}`;
  }

  throw new Error(
    `isomorphic-git requires an HTTP(S) remote. Unsupported remote URL: ${value}`
  );
}

function decodeUrlCredential(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function resolveGitAuth(remoteUrl, options = {}, env = process.env) {
  const explicitToken = String(options?.token || "").trim();
  const explicitUsername = String(options?.username || "").trim();

  if (explicitToken) {
    return {
      token: explicitToken,
      username: explicitUsername || env.SPACE_GIT_USERNAME || env.GIT_USERNAME || "git"
    };
  }

  try {
    const parsedUrl = new URL(String(remoteUrl || ""));
    if (parsedUrl.username || parsedUrl.password) {
      return {
        token: decodeUrlCredential(parsedUrl.password),
        username:
          decodeUrlCredential(parsedUrl.username) ||
          explicitUsername ||
          env.SPACE_GIT_USERNAME ||
          env.GIT_USERNAME ||
          "git"
      };
    }
  } catch {
    // Ignore URL parsing problems here. The caller already validated the URL.
  }

  const envToken = isGitHubRemoteUrl(remoteUrl)
    ? env.SPACE_GITHUB_TOKEN || ""
    : env.SPACE_GIT_TOKEN || env.GITHUB_TOKEN || env.GH_TOKEN || "";

  return {
    token: String(envToken || "").trim(),
    username: explicitUsername || env.SPACE_GIT_USERNAME || env.GIT_USERNAME || "git"
  };
}

export function buildHttpAuthOptions(remoteUrl, options = {}, env = process.env) {
  const auth = resolveGitAuth(remoteUrl, options, env);

  if (!auth.token) {
    return {};
  }

  return {
    onAuth() {
      return {
        username: auth.username,
        password: auth.token
      };
    }
  };
}

export function buildBasicAuthHeader(remoteUrl, options = {}, env = process.env) {
  const auth = resolveGitAuth(remoteUrl, options, env);

  if (!auth.token) {
    return "";
  }

  return `Basic ${Buffer.from(`${auth.username}:${auth.token}`).toString("base64")}`;
}

export { fs };
