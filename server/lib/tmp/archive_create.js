import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import archiver from "archiver";

import { SERVER_TMP_DIR } from "../../config.js";
import { ensureServerTmpDir } from "./tmp_watch.js";

function createArchiveError(message, statusCode = 500) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function sanitizeArchiveBaseName(value) {
  const candidate = String(value || "")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return candidate || "download";
}

function createAsciiFilename(value) {
  const candidate = String(value || "")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "");

  return candidate || "download.zip";
}

function ensureZipFilename(value) {
  const candidate = String(value || "").trim() || "download";
  return candidate.toLowerCase().endsWith(".zip") ? candidate : `${candidate}.zip`;
}

function createArchiveToken() {
  return `${Date.now()}-${randomBytes(6).toString("hex")}`;
}

function createArchivePath(baseName, options = {}) {
  const tmpDir = ensureServerTmpDir(options.tmpDir || SERVER_TMP_DIR);
  return path.join(tmpDir, `${sanitizeArchiveBaseName(baseName)}-${createArchiveToken()}.zip`);
}

function removeArchiveQuietly(archivePath) {
  fs.rm(archivePath, { force: true }, () => {});
}

function createArchiveFailureMessage(error) {
  const detail = String(error?.message || "").trim();

  if (!detail) {
    return "ZIP archive creation failed.";
  }

  return `ZIP archive creation failed: ${detail}`;
}

function writeZipArchive(options = {}) {
  const archivePath = String(options.archivePath || "");
  const sourceAbsolutePath = String(options.sourceAbsolutePath || "");
  const sourceName = String(options.sourceName || "");

  return new Promise((resolve, reject) => {
    const outputStream = fs.createWriteStream(archivePath);
    const archive = archiver("zip", {
      zlib: {
        level: 1
      }
    });
    let settled = false;

    function resolveOnce() {
      if (settled) {
        return;
      }

      settled = true;
      resolve();
    }

    function rejectOnce(error) {
      if (settled) {
        return;
      }

      settled = true;
      archive.destroy();
      outputStream.destroy();
      removeArchiveQuietly(archivePath);
      reject(createArchiveError(createArchiveFailureMessage(error)));
    }

    outputStream.once("close", resolveOnce);
    outputStream.once("error", rejectOnce);
    archive.once("warning", rejectOnce);
    archive.once("error", rejectOnce);
    archive.pipe(outputStream);

    archive.directory(sourceAbsolutePath, sourceName);

    try {
      const finalizeResult = archive.finalize();

      if (finalizeResult && typeof finalizeResult.then === "function") {
        finalizeResult.catch(rejectOnce);
      }
    } catch (error) {
      rejectOnce(error);
    }
  });
}

function createDirectoryZipArchive(options = {}) {
  const sourceAbsolutePath = path.resolve(String(options.sourceAbsolutePath || ""));

  if (!sourceAbsolutePath) {
    throw createArchiveError("Folder archive source path must not be empty.", 400);
  }

  let stats;

  try {
    stats = fs.statSync(sourceAbsolutePath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw createArchiveError("Folder archive source path was not found.", 404);
    }

    throw error;
  }

  if (!stats.isDirectory()) {
    throw createArchiveError("Folder archive source path must be a directory.", 400);
  }

  const sourceName = path.basename(sourceAbsolutePath);
  const archivePath = createArchivePath(options.archiveBaseName || sourceName, options);

  return writeZipArchive({
    archivePath,
    sourceAbsolutePath,
    sourceName
  }).then(() => ({
    archivePath,
    downloadFilename: ensureZipFilename(options.downloadFilename || sourceName)
  }));
}

function createArchiveReadStream(archivePath) {
  const stream = fs.createReadStream(archivePath);
  let cleaned = false;

  function cleanup() {
    if (cleaned) {
      return;
    }

    cleaned = true;
    removeArchiveQuietly(archivePath);
  }

  stream.once("close", cleanup);
  stream.once("error", cleanup);
  return stream;
}

function createAttachmentDisposition(filename) {
  const normalizedFilename = ensureZipFilename(filename);
  const asciiFilename = createAsciiFilename(normalizedFilename);
  return `attachment; filename="${asciiFilename}"; filename*=UTF-8''${encodeURIComponent(normalizedFilename)}`;
}

export {
  createArchiveReadStream,
  createAttachmentDisposition,
  createDirectoryZipArchive
};
