import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".htm": "text/html; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".webp": "image/webp",
  ".xhtml": "application/xhtml+xml; charset=utf-8",
  ".xml": "application/xml; charset=utf-8"
};

function createNoStoreHeaders(headers = {}) {
  return {
    ...headers,
    "Cache-Control": "no-store, max-age=0, must-revalidate",
    Expires: "0",
    Pragma: "no-cache"
  };
}

function sendRedirect(res, location, headers = {}) {
  res.writeHead(302, {
    ...headers,
    Location: location
  });
  res.end();
}

function sendJson(res, statusCode, payload, headers = {}) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    ...headers,
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

function sendNotFound(res, headers = {}) {
  sendJson(res, 404, { error: "File not found" }, headers);
}

function sendFile(res, filePath, options = {}) {
  if (options.knownMissing) {
    sendNotFound(res, options.headers);
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || "application/octet-stream";
  const headers = options.headers || {};

  fs.stat(filePath, (statError, stats) => {
    if (statError || !stats.isFile()) {
      sendNotFound(res, headers);
      return;
    }

    const stream = fs.createReadStream(filePath);
    let responseStarted = false;

    stream.once("open", () => {
      if (res.writableEnded) {
        stream.destroy();
        return;
      }

      responseStarted = true;
      res.writeHead(200, {
        ...headers,
        "Content-Type": contentType,
        "Content-Length": stats.size
      });
      stream.pipe(res);
    });

    stream.once("error", () => {
      if (!responseStarted && !res.headersSent) {
        sendNotFound(res, headers);
        return;
      }

      if (!res.writableEnded) {
        res.destroy();
      }
    });

    res.once("close", () => {
      if (!stream.destroyed) {
        stream.destroy();
      }
    });
  });
}

function normalizeHeaders(headers) {
  if (!headers) {
    return {};
  }

  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }

  return { ...headers };
}

function isWebResponse(value) {
  return (
    value &&
    typeof value === "object" &&
    typeof Response !== "undefined" &&
    value instanceof Response
  );
}

function isHttpResponseShape(value) {
  return (
    value &&
    typeof value === "object" &&
    ("status" in value || "headers" in value || "body" in value || "stream" in value)
  );
}

async function pipeReadableToResponse(res, stream) {
  await new Promise((resolve, reject) => {
    const readable =
      stream && typeof stream.pipe === "function"
        ? stream
        : typeof Readable.fromWeb === "function"
          ? Readable.fromWeb(stream)
          : stream;

    readable.once("error", reject);
    res.once("error", reject);
    res.once("finish", resolve);
    readable.pipe(res);
  });
}

async function sendWebResponse(res, response) {
  res.writeHead(response.status || 200, normalizeHeaders(response.headers));

  if (!response.body) {
    res.end();
    return;
  }

  await pipeReadableToResponse(res, response.body);
}

async function sendHttpResponse(res, response) {
  const status = Number(response.status || 200);
  const headers = normalizeHeaders(response.headers);

  if (response.stream) {
    res.writeHead(status, headers);
    await pipeReadableToResponse(res, response.stream);
    return;
  }

  if (response.body === undefined) {
    res.writeHead(status, headers);
    res.end();
    return;
  }

  if (
    typeof response.body === "object" &&
    !Buffer.isBuffer(response.body) &&
    !(response.body instanceof Uint8Array)
  ) {
    const body = JSON.stringify(response.body, null, 2);
    res.writeHead(status, {
      ...headers,
      "Content-Type": headers["Content-Type"] || headers["content-type"] || "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(body)
    });
    res.end(body);
    return;
  }

  if (Buffer.isBuffer(response.body)) {
    res.writeHead(status, {
      ...headers,
      "Content-Length": response.body.length
    });
    res.end(response.body);
    return;
  }

  if (response.body instanceof Uint8Array) {
    const body = Buffer.from(response.body);
    res.writeHead(status, {
      ...headers,
      "Content-Length": body.length
    });
    res.end(body);
    return;
  }

  const textBody = String(response.body);
  res.writeHead(status, {
    ...headers,
    "Content-Type": headers["Content-Type"] || headers["content-type"] || "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(textBody)
  });
  res.end(textBody);
}

async function sendApiResult(res, result) {
  if (res.writableEnded) {
    return;
  }

  if (result === undefined) {
    res.writeHead(204);
    res.end();
    return;
  }

  if (isWebResponse(result)) {
    await sendWebResponse(res, result);
    return;
  }

  if (isHttpResponseShape(result)) {
    await sendHttpResponse(res, result);
    return;
  }

  sendJson(res, 200, result);
}

export { createNoStoreHeaders, sendApiResult, sendFile, sendJson, sendNotFound, sendRedirect };
