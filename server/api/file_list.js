import { createHttpError, listAppPaths } from "../lib/customware/file-access.js";

function readPayload(context) {
  return context.body && typeof context.body === "object" && !Buffer.isBuffer(context.body)
    ? context.body
    : {};
}

function readPath(context) {
  const payload = readPayload(context);
  return String(payload.path || context.params.path || "");
}

function readRecursive(context) {
  const payload = readPayload(context);
  const rawValue =
    payload.recursive !== undefined ? payload.recursive : context.params.recursive !== undefined ? context.params.recursive : false;

  if (typeof rawValue === "boolean") {
    return rawValue;
  }

  return ["1", "true", "yes", "on"].includes(String(rawValue || "").trim().toLowerCase());
}

function handleList(context) {
  try {
    return listAppPaths({
      path: readPath(context),
      recursive: readRecursive(context),
      username: context.user?.username,
      watchdog: context.watchdog
    });
  } catch (error) {
    throw createHttpError(error.message || "File list failed.", Number(error.statusCode) || 500);
  }
}

export function get(context) {
  return handleList(context);
}

export function post(context) {
  return handleList(context);
}
