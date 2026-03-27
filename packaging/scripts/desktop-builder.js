#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { build, Platform, Arch, DIR_TARGET } = require("electron-builder");

const PROJECT_ROOT = path.join(__dirname, "..", "..");
const PACKAGE_JSON_PATH = path.join(PROJECT_ROOT, "package.json");

const PLATFORM_SPECS = {
  macos: {
    key: "macos",
    label: "macOS",
    builderPlatform: Platform.MAC,
    configKey: "mac",
    defaultTargets: ["dmg", "zip"],
    preferredHost: "darwin"
  },
  windows: {
    key: "windows",
    label: "Windows",
    builderPlatform: Platform.WINDOWS,
    configKey: "win",
    defaultTargets: ["nsis", "portable"],
    preferredHost: "win32"
  },
  linux: {
    key: "linux",
    label: "Linux",
    builderPlatform: Platform.LINUX,
    configKey: "linux",
    defaultTargets: ["AppImage", "deb", "tar.gz"],
    preferredHost: "linux"
  }
};

const ARCH_NAMES = new Set(["x64", "arm64", "universal"]);
const ARCH_VALUES = {
  x64: Arch.x64,
  arm64: Arch.arm64,
  universal: Arch.universal
};

function readPackageJson() {
  return JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, "utf8"));
}

function isFlag(value, ...names) {
  return names.includes(value);
}

function readFlagValue(argv, index, flagName) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flagName} requires a value.`);
  }

  return value;
}

function normalizeArchName(value) {
  if (!value) {
    return null;
  }

  const normalized = String(value).trim().toLowerCase();
  if (normalized === "x64") {
    return "x64";
  }
  if (normalized === "arm64") {
    return "arm64";
  }
  if (normalized === "universal") {
    return "universal";
  }

  return null;
}

function defaultArchName(platformSpec) {
  if (platformSpec.key === "macos") {
    const normalized = normalizeArchName(process.arch);
    return normalized || "x64";
  }

  return "x64";
}

function addArchName(targetArchs, archName, platformSpec) {
  if (!ARCH_NAMES.has(archName)) {
    throw new Error(`Unsupported arch "${archName}". Use x64, arm64, or universal.`);
  }

  if (archName === "universal" && platformSpec.key !== "macos") {
    throw new Error("The universal arch target is only supported for macOS packaging.");
  }

  if (!targetArchs.includes(archName)) {
    targetArchs.push(archName);
  }
}

function parseArchList(rawValue, platformSpec) {
  const parts = String(rawValue)
    .split(",")
    .map((part) => normalizeArchName(part))
    .filter(Boolean);

  if (!parts.length) {
    throw new Error("Expected at least one arch value.");
  }

  const archs = [];
  parts.forEach((archName) => addArchName(archs, archName, platformSpec));
  return archs;
}

function parsePackagingArgs(argv, platformSpec) {
  const options = {
    dir: false,
    dryRun: false,
    help: false,
    publish: "never",
    archs: [defaultArchName(platformSpec)]
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (isFlag(arg, "--help", "-h")) {
      options.help = true;
      continue;
    }

    if (arg === "--dir") {
      options.dir = true;
      continue;
    }

    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }

    if (isFlag(arg, "--x64", "--arm64", "--universal")) {
      const archName = arg.replace(/^--/, "");
      options.archs = [];
      addArchName(options.archs, archName, platformSpec);
      continue;
    }

    if (arg === "--arch") {
      options.archs = parseArchList(readFlagValue(argv, index, "--arch"), platformSpec);
      index += 1;
      continue;
    }

    if (arg.startsWith("--arch=")) {
      options.archs = parseArchList(arg.slice("--arch=".length), platformSpec);
      continue;
    }

    if (arg === "--publish") {
      options.publish = readFlagValue(argv, index, "--publish");
      index += 1;
      continue;
    }

    if (arg.startsWith("--publish=")) {
      options.publish = arg.slice("--publish=".length).trim() || "never";
      continue;
    }

    throw new Error(`Unknown packaging argument: ${arg}`);
  }

  return options;
}

function cloneBuildConfig(packageJson) {
  return JSON.parse(JSON.stringify(packageJson.build || {}));
}

function resolveProjectPath(relativePath) {
  return path.join(PROJECT_ROOT, relativePath);
}

function maybeStripMissingPath(object, key, warnings, description) {
  if (!object || typeof object[key] !== "string") {
    return;
  }

  if (fs.existsSync(resolveProjectPath(object[key]))) {
    return;
  }

  warnings.push(`Skipping missing ${description}: ${object[key]}`);
  delete object[key];
}

function createBuildConfig(platformSpec) {
  const packageJson = readPackageJson();
  const buildConfig = cloneBuildConfig(packageJson);
  const platformConfig = {
    ...(buildConfig[platformSpec.configKey] || {})
  };
  const warnings = [];

  maybeStripMissingPath(platformConfig, "icon", warnings, `${platformSpec.label} icon`);
  maybeStripMissingPath(platformConfig, "entitlements", warnings, `${platformSpec.label} entitlements`);
  maybeStripMissingPath(
    platformConfig,
    "entitlementsInherit",
    warnings,
    `${platformSpec.label} inherited entitlements`
  );

  buildConfig[platformSpec.configKey] = platformConfig;
  buildConfig.directories = {
    ...(buildConfig.directories || {}),
    output: path.join("dist", "desktop", platformSpec.key)
  };

  return {
    buildConfig,
    warnings
  };
}

function createTargets(platformSpec, options) {
  const targetNames = options.dir ? DIR_TARGET : platformSpec.defaultTargets;
  const archValues = options.archs.map((archName) => ARCH_VALUES[archName]);
  return platformSpec.builderPlatform.createTarget(targetNames, ...archValues);
}

function printHelp(platformSpec) {
  console.log(`${platformSpec.label} packaging script`);
  console.log("");
  console.log("Usage:");
  console.log(`  node packaging/scripts/package-${platformSpec.key}.js [options]`);
  console.log("");
  console.log("Options:");
  console.log("  --dir              Build an unpacked app directory instead of installers.");
  console.log("  --arch <list>      Arch list: x64, arm64, universal (macOS only).");
  console.log("  --x64              Shortcut for --arch x64.");
  console.log("  --arm64            Shortcut for --arch arm64.");
  console.log("  --universal        Shortcut for --arch universal (macOS only).");
  console.log("  --publish <mode>   electron-builder publish mode. Defaults to never.");
  console.log("  --dry-run          Print the resolved packaging plan without building.");
}

function printPlan(platformSpec, options, warnings, buildConfig) {
  console.log(`${platformSpec.label} packaging plan`);
  console.log("");
  console.log(`Host platform: ${process.platform}`);
  console.log(`Preferred host: ${platformSpec.preferredHost}`);
  console.log(`Output directory: ${buildConfig.directories.output}`);
  console.log(`Targets: ${(options.dir ? [DIR_TARGET] : platformSpec.defaultTargets).join(", ")}`);
  console.log(`Archs: ${options.archs.join(", ")}`);
  console.log(`Publish mode: ${options.publish}`);

  if (warnings.length) {
    console.log("");
    warnings.forEach((warning) => {
      console.log(`Warning: ${warning}`);
    });
  }
}

function printHostNote(platformSpec) {
  if (process.platform === platformSpec.preferredHost) {
    return;
  }

  console.warn(
    `Packaging ${platformSpec.label} from ${process.platform} may require additional host tooling or may be unsupported by the target toolchain.`
  );
}

async function runDesktopPackaging(platformKey, argv = process.argv.slice(2)) {
  const platformSpec = PLATFORM_SPECS[platformKey];
  if (!platformSpec) {
    throw new Error(`Unknown desktop packaging platform: ${platformKey}`);
  }

  const options = parsePackagingArgs(argv, platformSpec);
  if (options.help) {
    printHelp(platformSpec);
    return [];
  }

  const { buildConfig, warnings } = createBuildConfig(platformSpec);
  printHostNote(platformSpec);

  if (options.dryRun) {
    printPlan(platformSpec, options, warnings, buildConfig);
    return [];
  }

  warnings.forEach((warning) => {
    console.warn(`Warning: ${warning}`);
  });

  console.log(`Packaging Agent One for ${platformSpec.label}...`);

  const artifacts = await build({
    projectDir: PROJECT_ROOT,
    config: buildConfig,
    targets: createTargets(platformSpec, options),
    publish: options.publish
  });

  if (options.dir) {
    console.log(`Created unpacked app output in ${buildConfig.directories.output}.`);
  } else {
    console.log(`Created ${artifacts.length} artifact(s) in ${buildConfig.directories.output}.`);
    artifacts.forEach((artifactPath) => {
      console.log(`- ${path.relative(PROJECT_ROOT, artifactPath)}`);
    });
  }

  return artifacts;
}

module.exports = {
  runDesktopPackaging
};
