import fs from "node:fs";
import { randomBytes } from "node:crypto";

import { createPasswordVerifier } from "./passwords.js";
import {
  buildUserAbsolutePath,
  ensureUserStructure,
  normalizeUsername,
  readUserConfig,
  writeUserConfig,
  writeUserLogins
} from "./user-files.js";

const GUEST_USERNAME_PREFIX = "guest_";
const GUEST_USERNAME_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const GENERATED_PASSWORD_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
const GUEST_USERNAME_SUFFIX_LENGTH = 6;
const GENERATED_PASSWORD_LENGTH = 18;
const GUEST_CREATION_MAX_ATTEMPTS = 64;

function createRandomString(length, alphabet) {
  const normalizedLength = Number(length);
  const sourceAlphabet = String(alphabet || "");

  if (!Number.isInteger(normalizedLength) || normalizedLength <= 0 || !sourceAlphabet) {
    return "";
  }

  const bytes = randomBytes(normalizedLength);
  let output = "";

  for (let index = 0; index < normalizedLength; index += 1) {
    output += sourceAlphabet[bytes[index] % sourceAlphabet.length];
  }

  return output;
}

function removeLegacyPasswordFields(config = {}) {
  const {
    password_iterations: _passwordIterations,
    password_salt: _passwordSalt,
    password_scheme: _passwordScheme,
    password_server_key: _passwordServerKey,
    password_stored_key: _passwordStoredKey,
    ...rest
  } = config;

  return rest;
}

function createUser(projectRoot, username, password, options = {}) {
  const normalizedUsername = normalizeUsername(username);

  if (!normalizedUsername) {
    throw new Error(`Invalid username: ${String(username || "")}`);
  }

  const userDir = buildUserAbsolutePath(projectRoot, normalizedUsername);

  if (fs.existsSync(userDir)) {
    if (!options.force) {
      throw new Error(`User already exists: ${normalizedUsername}`);
    }

    fs.rmSync(userDir, { force: true, recursive: true });
  }

  ensureUserStructure(projectRoot, normalizedUsername);
  writeUserConfig(projectRoot, normalizedUsername, {
    password: createPasswordVerifier(password)
  });
  writeUserLogins(projectRoot, normalizedUsername, {});

  return {
    userDir,
    username: normalizedUsername
  };
}

function setUserPassword(projectRoot, username, password) {
  const normalizedUsername = normalizeUsername(username);

  if (!normalizedUsername) {
    throw new Error(`Invalid username: ${String(username || "")}`);
  }

  const currentConfig = readUserConfig(projectRoot, normalizedUsername);
  const userDir = buildUserAbsolutePath(projectRoot, normalizedUsername);

  if (!fs.existsSync(userDir)) {
    throw new Error(`User does not exist: ${normalizedUsername}`);
  }

  ensureUserStructure(projectRoot, normalizedUsername);

  writeUserConfig(projectRoot, normalizedUsername, {
    ...removeLegacyPasswordFields(currentConfig),
    password: createPasswordVerifier(password)
  });
  writeUserLogins(projectRoot, normalizedUsername, {});

  return {
    userDir,
    username: normalizedUsername
  };
}

function createGuestUser(projectRoot, options = {}) {
  const password = String(options.password || createRandomString(GENERATED_PASSWORD_LENGTH, GENERATED_PASSWORD_ALPHABET));

  for (let attempt = 0; attempt < GUEST_CREATION_MAX_ATTEMPTS; attempt += 1) {
    const username = `${GUEST_USERNAME_PREFIX}${createRandomString(
      GUEST_USERNAME_SUFFIX_LENGTH,
      GUEST_USERNAME_ALPHABET
    )}`;

    if (fs.existsSync(buildUserAbsolutePath(projectRoot, username))) {
      continue;
    }

    try {
      createUser(projectRoot, username, password);
    } catch (error) {
      if (String(error?.message || "").startsWith("User already exists:")) {
        continue;
      }

      throw error;
    }

    return {
      password,
      username
    };
  }

  throw new Error("Failed to create guest account. Try again.");
}

export { createGuestUser, createUser, setUserPassword };
