const path = require("node:path");

const WINDOWS_INSTALL_WAIT_TIMEOUT_MS = 60000;
const DESKTOP_UPDATER_LOG_RELATIVE_PATH = path.join("logs", "desktop-updater.log");
const DEFAULT_DESKTOP_UPDATER_INSTALL_PLAN = Object.freeze({
  strategy: "electron-updater"
});

function escapePowerShellSingleQuoted(value) {
  return String(value || "").replace(/'/gu, "''");
}

function encodePowerShellCommand(command) {
  return Buffer.from(String(command || ""), "utf16le").toString("base64");
}

function buildPowerShellArrayLiteral(values = []) {
  return `@(${values.map((value) => `'${escapePowerShellSingleQuoted(value)}'`).join(", ")})`;
}

function resolveDesktopUpdaterLogPath(options = {}) {
  const userDataPath = String(options.userDataPath || "").trim();
  if (!userDataPath) {
    return "";
  }

  const platform = String(options.platform || "").trim();
  const pathModule = platform === "win32" || /\\/u.test(userDataPath) ? path.win32 : path;

  return pathModule.join(userDataPath, DESKTOP_UPDATER_LOG_RELATIVE_PATH);
}

function resolveWindowsUpdaterInstallerArgs(options = {}) {
  const args = ["--updated"];
  const isSilent = options.isSilent === true;
  const shouldForceRunAfter = isSilent
    ? options.isForceRunAfter === true
    : options.autoRunAppAfterInstall !== false;
  const packagePath = String(options.packagePath || "").trim();

  if (isSilent) {
    args.push("/S");
  }

  if (shouldForceRunAfter) {
    args.push("--force-run");
  }

  if (packagePath) {
    args.push(`--package-file=${packagePath}`);
  }

  return args;
}

function buildWindowsDesktopUpdaterLaunchScript(options = {}) {
  const installerPath = String(options.installerPath || "").trim();
  const currentExecutablePath = String(options.currentExecutablePath || "").trim();
  const currentProcessId = Number(options.currentProcessId);
  const waitTimeoutMs = Number(options.waitTimeoutMs) > 0
    ? Math.round(Number(options.waitTimeoutMs))
    : WINDOWS_INSTALL_WAIT_TIMEOUT_MS;
  const elevatePath = String(options.elevatePath || "").trim();
  const isAdminRightsRequired = options.isAdminRightsRequired === true;
  const logPath = String(options.logPath || "").trim();
  const appProcessName = path.win32.basename(currentExecutablePath);
  const installerArgs = resolveWindowsUpdaterInstallerArgs(options);

  if (!installerPath) {
    throw new Error("Windows desktop updater install requires an installer path.");
  }

  if (!currentExecutablePath) {
    throw new Error("Windows desktop updater install requires the current executable path.");
  }

  if (!Number.isInteger(currentProcessId) || currentProcessId <= 0) {
    throw new Error("Windows desktop updater install requires the current process id.");
  }

  if (!appProcessName) {
    throw new Error("Windows desktop updater install could not resolve the current process name.");
  }

  const scriptLines = [
    "$ErrorActionPreference = 'Stop'",
    `$parentPid = ${currentProcessId}`,
    `$appExePath = '${escapePowerShellSingleQuoted(currentExecutablePath)}'`,
    `$appProcessName = '${escapePowerShellSingleQuoted(appProcessName)}'`,
    `$installerPath = '${escapePowerShellSingleQuoted(installerPath)}'`,
    `$installerArgs = ${buildPowerShellArrayLiteral(installerArgs)}`,
    `$logPath = '${escapePowerShellSingleQuoted(logPath)}'`,
    `$waitDeadline = (Get-Date).ToUniversalTime().AddMilliseconds(${waitTimeoutMs})`,
    "function Write-SpaceAgentUpdaterLog {",
    "  param([string]$Message)",
    "",
    "  if (-not $logPath) {",
    "    return",
    "  }",
    "",
    "  try {",
    "    $logDirectory = Split-Path -LiteralPath $logPath -Parent",
    "    if ($logDirectory) {",
    "      New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null",
    "    }",
    "    $timestamp = [DateTime]::UtcNow.ToString('o')",
    "    Add-Content -LiteralPath $logPath -Value ($timestamp + ' [space-desktop/updater] ' + $Message) -Encoding UTF8",
    "  } catch {",
    "    # Best effort only. Logging failures must not block the installer handoff.",
    "  }",
    "}",
    "",
    "function Test-SpaceAgentAppProcessRunning {",
    "  param(",
    "    [int]$Pid,",
    "    [string]$ExecutablePath,",
    "    [string]$ProcessName",
    "  )",
    "",
    "  if (Get-Process -Id $Pid -ErrorAction SilentlyContinue) {",
    "    return $true",
    "  }",
    "",
    "  try {",
    "    $matchingProcess = Get-CimInstance Win32_Process -Filter (\"Name = '$ProcessName'\") -ErrorAction SilentlyContinue |",
    "      Where-Object { $_.ExecutablePath -and ([string]::Equals($_.ExecutablePath, $ExecutablePath, [System.StringComparison]::OrdinalIgnoreCase)) } |",
    "      Select-Object -First 1",
    "",
    "    if ($matchingProcess) {",
    "      return $true",
    "    }",
    "  } catch {",
    "    Write-SpaceAgentUpdaterLog ('Process lookup fallback failed: ' + $_.Exception.Message)",
    "  }",
    "",
    "  return $false",
    "}",
    "",
    "try {",
    "  Write-SpaceAgentUpdaterLog ('Helper started. Waiting for PID ' + $parentPid + ' (' + $appProcessName + ').')",
    "",
    "  if (-not (Test-Path -LiteralPath $installerPath)) {",
    "    Write-SpaceAgentUpdaterLog ('Installer path is missing: ' + $installerPath)",
    "    exit 1",
    "  }",
    "",
    "  while ((Get-Date).ToUniversalTime() -lt $waitDeadline -and (Test-SpaceAgentAppProcessRunning -Pid $parentPid -ExecutablePath $appExePath -ProcessName $appProcessName)) {",
    "    Start-Sleep -Milliseconds 500",
    "  }",
    "",
    "  if (Test-SpaceAgentAppProcessRunning -Pid $parentPid -ExecutablePath $appExePath -ProcessName $appProcessName) {",
    "    Write-SpaceAgentUpdaterLog ('Wait timeout reached; continuing with installer launch for ' + $appExePath)",
    "  } else {",
    "    Write-SpaceAgentUpdaterLog ('App exit confirmed for ' + $appExePath)",
    "  }",
    "",
    "  $installerWorkingDirectory = Split-Path -LiteralPath $installerPath -Parent"
  ];

  if (isAdminRightsRequired) {
    if (elevatePath) {
      scriptLines.push(`$elevatePath = '${escapePowerShellSingleQuoted(elevatePath)}'`);
      scriptLines.push("if ($elevatePath -and (Test-Path -LiteralPath $elevatePath)) {");
      scriptLines.push("  Write-SpaceAgentUpdaterLog ('Launching installer via elevate.exe: ' + $installerPath)");
      scriptLines.push("  $elevateArgs = @($installerPath) + $installerArgs");
      scriptLines.push("  Start-Process -FilePath $elevatePath -ArgumentList $elevateArgs -WorkingDirectory $installerWorkingDirectory | Out-Null");
      scriptLines.push("} else {");
      scriptLines.push("  Write-SpaceAgentUpdaterLog ('Launching installer with RunAs fallback: ' + $installerPath)");
      scriptLines.push("  Start-Process -FilePath $installerPath -ArgumentList $installerArgs -WorkingDirectory $installerWorkingDirectory -Verb RunAs | Out-Null");
      scriptLines.push("}");
    } else {
      scriptLines.push("Write-SpaceAgentUpdaterLog ('Launching installer with RunAs fallback: ' + $installerPath)");
      scriptLines.push("Start-Process -FilePath $installerPath -ArgumentList $installerArgs -WorkingDirectory $installerWorkingDirectory -Verb RunAs | Out-Null");
    }
  } else {
    scriptLines.push("Write-SpaceAgentUpdaterLog ('Launching installer directly: ' + $installerPath)");
    scriptLines.push("Start-Process -FilePath $installerPath -ArgumentList $installerArgs -WorkingDirectory $installerWorkingDirectory | Out-Null");
  }

  scriptLines.push("Write-SpaceAgentUpdaterLog ('Installer start command submitted. Args: ' + ($installerArgs -join ' '))");
  scriptLines.push("} catch {");
  scriptLines.push("  Write-SpaceAgentUpdaterLog ('Helper failed: ' + $_.Exception.Message)");
  scriptLines.push("  exit 1");
  scriptLines.push("}");

  return {
    installerArgs,
    logPath,
    script: `${scriptLines.join("\n")}\n`
  };
}

function resolveDesktopUpdaterInstallPlan(options = {}) {
  const platform = String(options.platform || process.platform).trim() || process.platform;

  if (platform !== "win32") {
    return {
      ...DEFAULT_DESKTOP_UPDATER_INSTALL_PLAN
    };
  }

  const logPath = String(options.logPath || resolveDesktopUpdaterLogPath({
    ...options,
    platform
  })).trim();
  const { installerArgs, script } = buildWindowsDesktopUpdaterLaunchScript({
    ...options,
    logPath
  });

  return {
    strategy: "deferred-powershell",
    command: "powershell.exe",
    args: [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-WindowStyle",
      "Hidden",
      "-EncodedCommand",
      encodePowerShellCommand(script)
    ],
    installerArgs,
    logPath,
    script
  };
}

module.exports = {
  DESKTOP_UPDATER_LOG_RELATIVE_PATH,
  WINDOWS_INSTALL_WAIT_TIMEOUT_MS,
  buildWindowsDesktopUpdaterLaunchScript,
  resolveDesktopUpdaterInstallPlan,
  resolveDesktopUpdaterLogPath,
  resolveWindowsUpdaterInstallerArgs
};
