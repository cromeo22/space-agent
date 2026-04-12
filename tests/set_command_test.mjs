import assert from "node:assert/strict";
import test from "node:test";

import { __test as setCommandTest } from "../commands/set.js";

test("set parses one or more KEY=VALUE assignments", () => {
  assert.deepEqual(setCommandTest.parseSetArgs(["HOST=127.0.0.1"]), [
    {
      paramName: "HOST",
      value: "127.0.0.1"
    }
  ]);
  assert.deepEqual(setCommandTest.parseSetArgs(["HOST=127.0.0.1", "PORT=3100"]), [
    {
      paramName: "HOST",
      value: "127.0.0.1"
    },
    {
      paramName: "PORT",
      value: "3100"
    }
  ]);
});

test("set rejects non assignment arguments", () => {
  assert.throws(() => {
    setCommandTest.parseSetArgs(["HOST", "127.0.0.1"]);
  }, /Expected KEY=VALUE/);
});

test("set apply helper executes assignments in order", async () => {
  const calls = [];
  const result = await setCommandTest.applySetArgs(
    "/workspace/agent-one",
    "/workspace/agent-one/commands",
    setCommandTest.parseSetArgs(["HOST=127.0.0.1", "PORT=3100"]),
    {
      setServerConfigParam: async (projectRoot, commandsDir, paramName, value) => {
        calls.push({
          commandsDir,
          paramName,
          projectRoot,
          value
        });

        return {
          name: paramName,
          value
        };
      }
    }
  );

  assert.deepEqual(calls, [
    {
      commandsDir: "/workspace/agent-one/commands",
      paramName: "HOST",
      projectRoot: "/workspace/agent-one",
      value: "127.0.0.1"
    },
    {
      commandsDir: "/workspace/agent-one/commands",
      paramName: "PORT",
      projectRoot: "/workspace/agent-one",
      value: "3100"
    }
  ]);
  assert.deepEqual(result, [
    {
      name: "HOST",
      value: "127.0.0.1"
    },
    {
      name: "PORT",
      value: "3100"
    }
  ]);
});
