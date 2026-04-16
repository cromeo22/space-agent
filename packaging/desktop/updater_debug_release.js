const semver = require("semver");
const {
  parseUpdateInfo,
  resolveFiles
} = require("electron-updater/out/providers/Provider");

const DEFAULT_GITHUB_HOST = "github.com";
const WINDOWS_RELEASE_METADATA_FILE = "metadata-latest-windows.yml";
const MAC_RELEASE_METADATA_FILE = "metadata-latest-mac.yml";
const LINUX_RELEASE_METADATA_FILE = "metadata-latest-linux.yml";
const LINUX_ARM64_RELEASE_METADATA_FILE = "metadata-latest-linux-arm64.yml";

function normalizeDesktopDebugReleaseVersion(requestedVersion, currentVersion = "") {
  const fallbackVersion = String(currentVersion || "").trim();
  const rawValue = String(requestedVersion || fallbackVersion).trim().replace(/^v/u, "");

  if (!rawValue) {
    throw new Error("Desktop debug reinstall requires a version or a current packaged app version.");
  }

  if (/^\d+\.\d+$/u.test(rawValue)) {
    return rawValue;
  }

  const parsedVersion = semver.parse(rawValue);
  if (!parsedVersion) {
    throw new Error(`Desktop debug reinstall requires a valid release version, received \"${rawValue}\".`);
  }

  if (!parsedVersion.prerelease.length && !parsedVersion.build.length && parsedVersion.patch === 0) {
    return `${parsedVersion.major}.${parsedVersion.minor}`;
  }

  return parsedVersion.version;
}

function resolveDesktopDebugReleaseTag(requestedVersion, currentVersion = "") {
  return `v${normalizeDesktopDebugReleaseVersion(requestedVersion, currentVersion)}`;
}

function resolveDesktopDebugComparisonVersion(version) {
  const normalizedVersion = String(version || "").trim().replace(/^v/u, "");
  if (!normalizedVersion) {
    throw new Error("Desktop debug reinstall comparison requires a non-empty version.");
  }

  if (/^\d+\.\d+$/u.test(normalizedVersion)) {
    return `${normalizedVersion}.0`;
  }

  const parsedVersion = semver.parse(normalizedVersion);
  if (!parsedVersion) {
    throw new Error(`Desktop debug reinstall comparison received an invalid version \"${normalizedVersion}\".`);
  }

  return parsedVersion.version;
}

function compareDesktopDebugReleaseVersions(targetVersion, currentVersion) {
  return semver.compare(
    resolveDesktopDebugComparisonVersion(targetVersion),
    resolveDesktopDebugComparisonVersion(currentVersion)
  );
}

function resolveDesktopDebugReleaseMetadataFileName({
  platform = process.platform,
  arch = process.arch
} = {}) {
  switch (platform) {
    case "win32":
      return WINDOWS_RELEASE_METADATA_FILE;
    case "darwin":
      return MAC_RELEASE_METADATA_FILE;
    case "linux":
      return arch === "arm64" ? LINUX_ARM64_RELEASE_METADATA_FILE : LINUX_RELEASE_METADATA_FILE;
    default:
      throw new Error(`Desktop debug reinstall does not support platform \"${platform}\".`);
  }
}

function normalizeDesktopDebugGitHubHost(host) {
  const normalizedHost = String(host || "").trim();
  if (!normalizedHost) {
    return DEFAULT_GITHUB_HOST;
  }

  return normalizedHost.replace(/^https?:\/\//u, "").replace(/\/+$/u, "");
}

function validateDesktopDebugGitHubPublishConfig(publishConfig = {}) {
  const provider = String(publishConfig.provider || "").trim();
  const owner = String(publishConfig.owner || "").trim();
  const repo = String(publishConfig.repo || "").trim();

  if (provider !== "github") {
    throw new Error(`Desktop debug reinstall requires a GitHub publish config, received provider \"${provider || "unknown"}\".`);
  }

  if (!owner || !repo) {
    throw new Error("Desktop debug reinstall requires GitHub publish owner and repo metadata.");
  }

  return {
    host: normalizeDesktopDebugGitHubHost(publishConfig.host),
    owner,
    repo
  };
}

function resolveDesktopDebugGitHubBaseUrl(publishConfig = {}) {
  const { host } = validateDesktopDebugGitHubPublishConfig(publishConfig);
  return new URL(`https://${host}`);
}

function resolveDesktopDebugGitHubBasePath(publishConfig = {}) {
  const { owner, repo } = validateDesktopDebugGitHubPublishConfig(publishConfig);
  return `/${owner}/${repo}/releases`;
}

function resolveDesktopDebugReleaseAssetUrl({
  publishConfig,
  tag,
  fileName
}) {
  const normalizedTag = String(tag || "").trim();
  const normalizedFileName = String(fileName || "").trim();

  if (!normalizedTag || !normalizedFileName) {
    throw new Error("Desktop debug reinstall requires both a release tag and an asset file name.");
  }

  const baseUrl = resolveDesktopDebugGitHubBaseUrl(publishConfig);
  const releasePath = resolveDesktopDebugGitHubBasePath(publishConfig);
  return new URL(`${releasePath}/download/${normalizedTag}/${normalizedFileName}`, baseUrl).href;
}

function escapeDesktopDebugRegExp(value) {
  return String(value || "").replace(/[|\\{}()[\]^$+*?.]/gu, "\\$&");
}

function getDesktopDebugReleaseBlockMapFiles(baseFileUrl, oldVersion, newVersion, oldBlockMapFileBaseUrl = null) {
  const normalizedBaseFileUrl = baseFileUrl instanceof URL ? baseFileUrl : new URL(baseFileUrl);
  const oldBlockMapBaseUrl = oldBlockMapFileBaseUrl ? new URL(oldBlockMapFileBaseUrl) : normalizedBaseFileUrl;
  const normalizedOldVersion = String(oldVersion || "").trim();
  const normalizedNewVersion = String(newVersion || "").trim();
  const oldBlockMapPath = `${normalizedBaseFileUrl.pathname.replace(
    new RegExp(escapeDesktopDebugRegExp(normalizedNewVersion), "g"),
    normalizedOldVersion
  )}.blockmap`;

  return [
    new URL(oldBlockMapPath, oldBlockMapBaseUrl),
    new URL(`${normalizedBaseFileUrl.pathname}.blockmap`, normalizedBaseFileUrl)
  ];
}

function createDesktopDebugReleaseProvider({
  publishConfig
}) {
  const baseUrl = resolveDesktopDebugGitHubBaseUrl(publishConfig);
  const releasePath = resolveDesktopDebugGitHubBasePath(publishConfig);

  return {
    fileExtraDownloadHeaders: null,
    isUseMultipleRangeRequest: false,
    requestHeaders: null,
    setRequestHeaders(value) {
      this.requestHeaders = value || null;
    },
    resolveFiles(updateInfo) {
      return resolveFiles(
        updateInfo,
        baseUrl,
        (assetPath) => `${releasePath}/download/${updateInfo.tag}/${String(assetPath || "").replace(/ /gu, "-")}`
      );
    },
    getBlockMapFiles(baseFileUrl, oldVersion, newVersion, oldBlockMapFileBaseUrl = null) {
      return getDesktopDebugReleaseBlockMapFiles(baseFileUrl, oldVersion, newVersion, oldBlockMapFileBaseUrl);
    }
  };
}

function parseDesktopDebugReleaseInfo({
  rawData,
  tag,
  metadataFileName,
  metadataUrl
}) {
  const parsedInfo = parseUpdateInfo(rawData, metadataFileName, metadataUrl);
  return {
    tag,
    ...parsedInfo
  };
}

async function stageDesktopDebugRelease({
  requestedVersion = "",
  currentVersion = "",
  platform = process.platform,
  arch = process.arch,
  publishConfig,
  fetchText
}) {
  if (typeof fetchText !== "function") {
    throw new Error("Desktop debug reinstall requires a metadata fetch function.");
  }

  const normalizedTargetVersion = normalizeDesktopDebugReleaseVersion(requestedVersion, currentVersion);
  const tag = resolveDesktopDebugReleaseTag(normalizedTargetVersion, currentVersion);
  const metadataFileName = resolveDesktopDebugReleaseMetadataFileName({
    platform,
    arch
  });
  const metadataUrl = resolveDesktopDebugReleaseAssetUrl({
    publishConfig,
    tag,
    fileName: metadataFileName
  });
  const rawData = await fetchText(metadataUrl);
  const info = parseDesktopDebugReleaseInfo({
    rawData,
    tag,
    metadataFileName,
    metadataUrl
  });

  return {
    comparison: compareDesktopDebugReleaseVersions(info.version || normalizedTargetVersion, currentVersion),
    info,
    metadataFileName,
    metadataUrl,
    provider: createDesktopDebugReleaseProvider({
      publishConfig
    }),
    requestedVersion: normalizedTargetVersion,
    tag
  };
}

module.exports = {
  LINUX_ARM64_RELEASE_METADATA_FILE,
  LINUX_RELEASE_METADATA_FILE,
  MAC_RELEASE_METADATA_FILE,
  WINDOWS_RELEASE_METADATA_FILE,
  compareDesktopDebugReleaseVersions,
  createDesktopDebugReleaseProvider,
  getDesktopDebugReleaseBlockMapFiles,
  normalizeDesktopDebugReleaseVersion,
  parseDesktopDebugReleaseInfo,
  resolveDesktopDebugComparisonVersion,
  resolveDesktopDebugGitHubBasePath,
  resolveDesktopDebugGitHubBaseUrl,
  resolveDesktopDebugReleaseAssetUrl,
  resolveDesktopDebugReleaseMetadataFileName,
  resolveDesktopDebugReleaseTag,
  stageDesktopDebugRelease,
  validateDesktopDebugGitHubPublishConfig
};
