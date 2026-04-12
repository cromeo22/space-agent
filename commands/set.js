import { setServerConfigParam } from "./lib/server_config.js";

const PARAM_ASSIGNMENT_PATTERN = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u;

function parseSetArgs(args) {
  if (!Array.isArray(args) || args.length === 0) {
    throw new Error("Usage: node space set KEY=VALUE [KEY=VALUE ...]");
  }

  return args.map((arg) => {
    const assignmentMatch = String(arg || "").match(PARAM_ASSIGNMENT_PATTERN);

    if (!assignmentMatch) {
      throw new Error(`Invalid set argument: ${arg}. Expected KEY=VALUE.`);
    }

    return {
      paramName: assignmentMatch[1],
      value: assignmentMatch[2]
    };
  });
}

async function applySetArgs(projectRoot, commandsDir, assignments, options = {}) {
  const setter = options.setServerConfigParam || setServerConfigParam;
  const entries = [];

  for (const assignment of assignments) {
    const entry = await setter(
      projectRoot,
      commandsDir,
      assignment.paramName,
      assignment.value
    );
    entries.push(entry);
  }

  return entries;
}

export const help = {
  name: "set",
  summary: "Validate and write a server config parameter to the project .env file.",
  usage: ["node space set KEY=VALUE [KEY=VALUE ...]"],
  description:
    "Validates one or more KEY=VALUE assignments against commands/params.yaml, then writes the parameters into the project .env file used by the local server.",
  arguments: [],
  examples: [
    "node space set HOST=127.0.0.1",
    "node space set PORT=3100",
    "node space set HOST=127.0.0.1 PORT=3100"
  ]
};

export async function execute(context) {
  const assignments = parseSetArgs(context.args);
  const entries = await applySetArgs(context.projectRoot, context.commandsDir, assignments);

  entries.forEach((entry) => {
    console.log(`Set ${entry.name}=${entry.value}`);
  });
  return 0;
}

export const __test = {
  applySetArgs,
  parseSetArgs
};
