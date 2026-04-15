#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");

const OPENROUTER_CHAT_COMPLETIONS_URL = "https://openrouter.ai/api/v1/chat/completions";
const SYSTEM_PROMPT_PATH = path.join(
  __dirname,
  "..",
  "resources",
  "release-notes",
  "openrouter-system-prompt.md"
);

function writeOutput(name, value) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) {
    return;
  }

  fs.appendFileSync(outputPath, `${name}<<__EOF__\n${value}\n__EOF__\n`, "utf8");
}

function runGit(args, options = {}) {
  return execFileSync("git", args, {
    cwd: options.cwd || process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

function gitSucceeds(args) {
  return (
    spawnSync("git", args, {
      cwd: process.cwd(),
      stdio: "ignore"
    }).status === 0
  );
}

function loadText(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function tagExists(tag) {
  return gitSucceeds(["rev-parse", "--verify", "--quiet", `refs/tags/${tag}`]);
}

function commitIsAncestor(olderRef, newerRef) {
  return gitSucceeds(["merge-base", "--is-ancestor", olderRef, newerRef]);
}

function parseCliArgs(argv) {
  const options = {
    currentTag: "",
    previousTag: "",
    requireAi: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--current-tag") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--current-tag requires a value.");
      }
      options.currentTag = value;
      index += 1;
      continue;
    }

    if (arg.startsWith("--current-tag=")) {
      options.currentTag = arg.slice("--current-tag=".length).trim();
      continue;
    }

    if (arg === "--previous-tag") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error("--previous-tag requires a value.");
      }
      options.previousTag = value;
      index += 1;
      continue;
    }

    if (arg.startsWith("--previous-tag=")) {
      options.previousTag = arg.slice("--previous-tag=".length).trim();
      continue;
    }

    if (arg === "--require-ai") {
      options.requireAi = true;
      continue;
    }

    throw new Error(`Unknown release-notes argument: ${arg}`);
  }

  options.currentTag = options.currentTag || process.env.RELEASE_TAG || process.env.GITHUB_REF_NAME || "";
  options.previousTag = options.previousTag || process.env.PREVIOUS_RELEASE_TAG || "";

  if (!options.currentTag) {
    throw new Error("release-notes requires --current-tag or RELEASE_TAG.");
  }

  return options;
}

function parseCommitEntries(rawLog) {
  return String(rawLog || "")
    .split("\x1e")
    .map((rawEntry) => rawEntry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [heading, description = ""] = entry.split("\x1f");
      return {
        heading: String(heading || "").replace(/\s+/gu, " ").trim(),
        description: String(description || "").trim()
      };
    })
    .filter((entry) => entry.heading);
}

function collectReleaseCommits(previousTag, currentTag) {
  if (!tagExists(currentTag)) {
    throw new Error(`Current tag ${currentTag} is not available in this checkout.`);
  }

  let rangeRef = currentTag;
  if (
    previousTag &&
    tagExists(previousTag) &&
    commitIsAncestor(`refs/tags/${previousTag}^{commit}`, `refs/tags/${currentTag}^{commit}`)
  ) {
    rangeRef = `${previousTag}..${currentTag}`;
  }

  const rawLog = runGit(["log", "--reverse", "--format=%s%x1f%b%x1e", rangeRef]);
  return parseCommitEntries(rawLog);
}

function buildReleaseNotesUserMessage(commits) {
  const lines = ["Commit headings and descriptions:"];

  if (!commits.length) {
    lines.push("No commits were found in this release range.");
    return lines.join("\n");
  }

  commits.forEach((commit, index) => {
    lines.push(`${index + 1}. Heading: ${commit.heading}`);
    if (commit.description) {
      lines.push("Description:");
      lines.push(commit.description);
    } else {
      lines.push("Description: (none)");
    }
    lines.push("");
  });

  return lines.join("\n").trim();
}

const RELEASE_BODY_REDUNDANT_HEADING_PATTERNS = [
  /^(?:#{1,6}\s*)?v?\d+\.\d+(?:\.\d+)?(?:\s+latest)?$/iu,
  /^(?:#{1,6}\s*)?release notes(?:\s*(?:—|-|:)\s*(?:for\s+)?v?\d+\.\d+(?:\.\d+)?)?$/iu,
  /^(?:#{1,6}\s*)?space agent(?:\s+desktop)?\s+release notes(?:\s*(?:—|-|:)\s*v?\d+\.\d+(?:\.\d+)?)?$/iu
];

function isRedundantReleaseBodyHeading(line) {
  const normalized = String(line || "").trim();
  if (!normalized) {
    return false;
  }

  return RELEASE_BODY_REDUNDANT_HEADING_PATTERNS.some((pattern) => pattern.test(normalized));
}

function sanitizeReleaseBody(body) {
  const lines = String(body || "")
    .replace(/\r\n?/gu, "\n")
    .split("\n");

  while (lines.length && !lines[0].trim()) {
    lines.shift();
  }

  while (lines.length && isRedundantReleaseBodyHeading(lines[0])) {
    lines.shift();
    while (lines.length && !lines[0].trim()) {
      lines.shift();
    }
  }

  return lines.join("\n").trim();
}

function extractOpenRouterMessageContent(payload) {
  if (!payload || typeof payload !== "object") {
    return "";
  }

  if (typeof payload.content === "string") {
    return payload.content;
  }

  if (!Array.isArray(payload.content)) {
    return "";
  }

  return payload.content
    .filter((part) => part && typeof part === "object" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

async function generateReleaseBodyWithOpenRouter(commits, options = {}) {
  const apiKey = String(process.env.OPENROUTER_API_KEY || "").trim();
  const model = String(process.env.OPENROUTER_MODEL_NAME || process.env.OPENROUTER_MODEL || "").trim();

  if (!apiKey || !model) {
    if (options.requireAi) {
      throw new Error("OPENROUTER_API_KEY and OPENROUTER_MODEL_NAME are required when --require-ai is set.");
    }

    return "";
  }

  const payload = {
    model,
    messages: [
      {
        role: "system",
        content: loadText(SYSTEM_PROMPT_PATH)
      },
      {
        role: "user",
        content: buildReleaseNotesUserMessage(commits)
      }
    ],
    temperature: 0.2
  };

  const response = await fetch(OPENROUTER_CHAT_COMPLETIONS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": `https://github.com/${process.env.GITHUB_REPOSITORY || ""}`,
      "X-OpenRouter-Title": "Space Agent Desktop Release Notes"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`OpenRouter request failed: ${response.status} ${response.statusText}\n${details}`.trim());
  }

  const responsePayload = await response.json();
  if (!responsePayload || typeof responsePayload !== "object" || !Array.isArray(responsePayload.choices)) {
    throw new Error("OpenRouter response did not include choices.");
  }

  const firstChoice = responsePayload.choices[0];
  const body = sanitizeReleaseBody(extractOpenRouterMessageContent(firstChoice && firstChoice.message));
  return body || "";
}

function buildFallbackReleaseBody(currentTag, previousTag, commits) {
  const lines = ["This release includes the commit-level changes below.", "", "## Commits"];

  if (!commits.length) {
    lines.push("- No commits were found in this release range.");
    return lines.join("\n");
  }

  commits.forEach((commit) => {
    if (commit.description) {
      lines.push(`- ${commit.heading}: ${commit.description.replace(/\s+/gu, " ").trim()}`);
      return;
    }

    lines.push(`- ${commit.heading}`);
  });

  return lines.join("\n");
}

async function main() {
  const options = parseCliArgs(process.argv.slice(2));
  let commits = [];
  let body = "";

  try {
    commits = collectReleaseCommits(options.previousTag, options.currentTag);
    body = await generateReleaseBodyWithOpenRouter(commits, {
      requireAi: options.requireAi
    });
  } catch (error) {
    if (options.requireAi) {
      throw error;
    }

    console.error(`Release note generation failed for ${options.currentTag}. Falling back to static notes.`);
    console.error(error.message || error);
  }

  body = sanitizeReleaseBody(body);

  if (options.requireAi && !body) {
    throw new Error("AI release note generation returned an empty body.");
  }

  if (!body) {
    body = buildFallbackReleaseBody(options.currentTag, options.previousTag, commits);
  }

  body = sanitizeReleaseBody(body);

  writeOutput("release_body", body);
  writeOutput("release_commit_count", String(commits.length));
  process.stdout.write(body);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
