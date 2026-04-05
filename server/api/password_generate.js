function createHttpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function readPayload(context) {
  return context.body && typeof context.body === "object" && !Buffer.isBuffer(context.body)
    ? context.body
    : {};
}

export function post(context) {
  const payload = readPayload(context);

  if (typeof payload.password !== "string") {
    throw createHttpError("Password must be provided as a string.", 400);
  }

  if (!context.auth || typeof context.auth.generatePasswordVerifier !== "function") {
    throw createHttpError("Password generation is unavailable.", 500);
  }

  return {
    headers: {
      "Cache-Control": "no-store"
    },
    status: 200,
    body: context.auth.generatePasswordVerifier(payload.password)
  };
}
