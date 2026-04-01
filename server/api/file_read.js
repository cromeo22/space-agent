import { createHttpError, readAppFile } from "../lib/customware/file-access.js";

function readPayload(context) {
  return context.body && typeof context.body === "object" && !Buffer.isBuffer(context.body)
    ? context.body
    : {};
}

function readPath(context) {
  const payload = readPayload(context);
  return String(payload.path || context.params.path || "");
}

function readEncoding(context) {
  const payload = readPayload(context);
  return String(payload.encoding || context.params.encoding || "utf8");
}

function handleRead(context) {
  try {
    return readAppFile({
      encoding: readEncoding(context),
      path: readPath(context),
      projectRoot: context.projectRoot,
      username: context.user?.username,
      watchdog: context.watchdog
    });
  } catch (error) {
    throw createHttpError(error.message || "File read failed.", Number(error.statusCode) || 500);
  }
}

export function get(context) {
  return handleRead(context);
}

export function post(context) {
  return handleRead(context);
}
