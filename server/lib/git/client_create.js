import { createIsomorphicGitClient, createIsomorphicGitCloneClient } from "./isomorphic_handler.js";
import { createNativeGitClient, createNativeGitCloneClient } from "./native_handler.js";
import { assertGitClient } from "./client_interface.js";
import { resolveGitContext, resolveRequestedGitBackend } from "./shared.js";

const BACKEND_FACTORIES = {
  native: createNativeGitClient,
  isomorphic: createIsomorphicGitClient
};

const CLONE_BACKEND_FACTORIES = {
  native: createNativeGitCloneClient,
  isomorphic: createIsomorphicGitCloneClient
};

const DEFAULT_BACKEND_ORDER = ["native", "isomorphic"];

function buildUnavailableBackendMessage(attempts) {
  return attempts
    .map((attempt) => `${attempt.name}: ${attempt.reason}`)
    .join("; ");
}

function resolveBackendOrder(options = {}) {
  const requestedBackend = resolveRequestedGitBackend(options);

  return {
    backendOrder: requestedBackend ? [requestedBackend] : DEFAULT_BACKEND_ORDER,
    requestedBackend
  };
}

export async function createGitClient({ projectRoot, runtimeParams, backendName, env } = {}) {
  const gitContext = await resolveGitContext(projectRoot);
  const { backendOrder, requestedBackend } = resolveBackendOrder({
    backendName,
    env,
    runtimeParams
  });
  const attempts = [];

  for (const backendName of backendOrder) {
    const result = await BACKEND_FACTORIES[backendName]({ projectRoot, gitContext });
    attempts.push(result);

    if (result.available) {
      assertGitClient(result.client, backendName);
      return result.client;
    }
  }

  const message = buildUnavailableBackendMessage(attempts);
  if (requestedBackend) {
    throw new Error(`Requested git backend "${requestedBackend}" is not available: ${message}`);
  }

  throw new Error(`Update could not initialize a Git backend: ${message}`);
}

export async function cloneGitRepository({
  authOptions = {},
  remoteUrl,
  targetDir,
  runtimeParams,
  backendName,
  env
} = {}) {
  const { backendOrder, requestedBackend } = resolveBackendOrder({
    backendName,
    env,
    runtimeParams
  });
  const attempts = [];

  for (const backendName of backendOrder) {
    const result = await CLONE_BACKEND_FACTORIES[backendName]({ remoteUrl, targetDir });
    attempts.push(result);

    if (result.available) {
      await result.client.cloneRepository({
        authOptions,
        remoteUrl,
        targetDir
      });
      return result.client;
    }
  }

  const message = buildUnavailableBackendMessage(attempts);
  if (requestedBackend) {
    throw new Error(`Requested git backend "${requestedBackend}" is not available: ${message}`);
  }

  throw new Error(`Module install could not initialize a Git backend: ${message}`);
}
