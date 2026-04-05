import http from "node:http";

import {
  API_DIR,
  APP_DIR,
  ASSET_DIR,
  FILE_WATCH_CONFIG_PATH,
  PAGES_DIR,
  PROJECT_ROOT,
  SERVER_TMP_DIR
} from "./config.js";
import { loadApiRegistry } from "./lib/api/registry.js";
import { createAuthService } from "./lib/auth/service.js";
import { ensureCustomwareDirectories } from "./lib/customware/layout.js";
import { createWatchdog } from "./lib/file_watch/watchdog.js";
import { createTmpWatch, ensureServerTmpDir } from "./lib/tmp/tmp_watch.js";
import { loadProjectEnvFiles } from "./lib/utils/env_files.js";
import { createRuntimeParams } from "./lib/utils/runtime_params.js";
import { sendJson } from "./router/responses.js";
import { createRequestHandler } from "./router/router.js";

function resolveBrowserHost(host) {
  if (host === "0.0.0.0" || host === "::" || host === "[::]") {
    return "127.0.0.1";
  }

  return host;
}

async function createAgentServer(overrides = {}) {
  const apiDir = overrides.apiDir || API_DIR;
  const appDir = overrides.appDir || APP_DIR;
  const assetDir = overrides.assetDir || ASSET_DIR;
  const pagesDir = overrides.pagesDir || PAGES_DIR;
  const projectRoot = overrides.projectRoot || PROJECT_ROOT;
  const tmpDir = overrides.tmpDir || SERVER_TMP_DIR;
  const runtimeParamEnv = overrides.runtimeParamEnv || { ...process.env };
  const legacyRuntimeParamOverrides = {};

  if (overrides.host !== undefined) {
    legacyRuntimeParamOverrides.HOST = String(overrides.host);
  }

  if (overrides.port !== undefined) {
    legacyRuntimeParamOverrides.PORT = String(overrides.port);
  }

  const runtimeParamOverrides = {
    ...legacyRuntimeParamOverrides,
    ...(overrides.runtimeParamOverrides || {})
  };

  loadProjectEnvFiles(projectRoot);

  const runtimeParams =
    overrides.runtimeParams ||
    await createRuntimeParams(projectRoot, {
      env: runtimeParamEnv,
      overrides: runtimeParamOverrides
    });
  const host = runtimeParams.get("HOST", "0.0.0.0");
  const browserHost = overrides.browserHost || resolveBrowserHost(host);
  const port = Number(runtimeParams.get("PORT", 3000));

  ensureCustomwareDirectories(projectRoot, runtimeParams);
  ensureServerTmpDir(tmpDir);

  const watchdog =
    overrides.watchdog ||
    createWatchdog({
      configPath: overrides.fileWatchConfigPath || FILE_WATCH_CONFIG_PATH,
      projectRoot,
      runtimeParams
    });
  const tmpWatch =
    overrides.tmpWatch ||
    createTmpWatch({
      tmpDir
    });
  const auth = overrides.auth || createAuthService({ projectRoot, runtimeParams, watchdog });

  const apiRegistry = await loadApiRegistry(apiDir);
  const requestHandler = createRequestHandler({
    apiDir,
    apiRegistry,
    appDir,
    auth,
    assetDir,
    pagesDir,
    runtimeParams,
    watchdog,
    host,
    port,
    projectRoot
  });
  const server = http.createServer((req, res) => {
    Promise.resolve(requestHandler(req, res)).catch((error) => {
      console.error("Request handling failed.");
      console.error(error);

      if (res.headersSent) {
        res.destroy(error);
        return;
      }

      sendJson(res, 500, {
        error: "Internal server error"
      });
    });
  });

  return {
    apiDir,
    apiRegistry,
    appDir,
    browserHost,
    host,
    port,
    assetDir,
    pagesDir,
    auth,
    tmpDir,
    tmpWatch,
    watchdog,
    runtimeParams,
    server,
    browserUrl: `http://${browserHost}:${port}`,
    async listen() {
      tmpWatch.start();

      try {
        await watchdog.start();
        if (auth && typeof auth.initialize === "function") {
          await auth.initialize();
        }

        return await new Promise((resolve, reject) => {
          server.once("error", reject);
          server.listen(port, host, () => {
            server.removeListener("error", reject);
            resolve({
              apiDir,
              apiRegistry,
              appDir,
              browserHost,
              host,
              port,
              assetDir,
              pagesDir,
              auth,
              tmpDir,
              tmpWatch,
              watchdog,
              runtimeParams,
              server,
              browserUrl: `http://${browserHost}:${port}`
            });
          });
        });
      } catch (error) {
        tmpWatch.stop();
        watchdog.stop();
        throw error;
      }
    },
    async close() {
      tmpWatch.stop();
      watchdog.stop();

      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    }
  };
}

export { createAgentServer };
