import * as config from "/mod/_core/admin/views/agent/config.js";

function createDefaultConfig() {
  return {
    settings: {
      ...config.DEFAULT_ADMIN_CHAT_SETTINGS
    },
    systemPrompt: ""
  };
}

function getRuntime() {
  const runtime = globalThis.space;

  if (!runtime || typeof runtime !== "object") {
    throw new Error("Space runtime is not available.");
  }

  if (!runtime.api || typeof runtime.api.fileRead !== "function" || typeof runtime.api.fileWrite !== "function") {
    throw new Error("space.api file helpers are not available.");
  }

  if (
    !runtime.utils ||
    typeof runtime.utils !== "object" ||
    !runtime.utils.yaml ||
    typeof runtime.utils.yaml.parse !== "function" ||
    typeof runtime.utils.yaml.stringify !== "function"
  ) {
    throw new Error("space.utils.yaml is not available.");
  }

  return runtime;
}

function isMissingFileError(error) {
  const message = String(error?.message || "");
  return /\bstatus 404\b/u.test(message) || /File not found\./u.test(message);
}

function normalizeStoredConfig(parsedConfig) {
  const storedConfig = parsedConfig && typeof parsedConfig === "object" ? parsedConfig : {};
  const storedMaxTokens =
    storedConfig.max_tokens ?? storedConfig.maxTokens ?? config.DEFAULT_ADMIN_CHAT_SETTINGS.maxTokens;

  return {
    settings: {
      apiEndpoint: String(storedConfig.api_endpoint || storedConfig.apiEndpoint || config.DEFAULT_ADMIN_CHAT_SETTINGS.apiEndpoint || "").trim(),
      apiKey: String(storedConfig.api_key || storedConfig.apiKey || config.DEFAULT_ADMIN_CHAT_SETTINGS.apiKey || "").trim(),
      maxTokens: config.normalizeAdminChatMaxTokens(storedMaxTokens),
      model: String(storedConfig.model || config.DEFAULT_ADMIN_CHAT_SETTINGS.model || "").trim(),
      paramsText: String(storedConfig.params || storedConfig.paramsText || config.DEFAULT_ADMIN_CHAT_SETTINGS.paramsText || "").trim()
    },
    systemPrompt: String(
      storedConfig.custom_system_prompt ||
        storedConfig.customSystemPrompt ||
        storedConfig.system_prompt ||
        storedConfig.systemPrompt ||
        ""
    ).trim()
  };
}

function buildStoredConfigPayload({ settings, systemPrompt }) {
  const normalizedSystemPrompt = typeof systemPrompt === "string" ? systemPrompt.trim() : "";
  const payload = {
    api_endpoint: String(settings?.apiEndpoint || config.DEFAULT_ADMIN_CHAT_SETTINGS.apiEndpoint || "").trim(),
    api_key: String(settings?.apiKey || config.DEFAULT_ADMIN_CHAT_SETTINGS.apiKey || "").trim(),
    max_tokens: config.normalizeAdminChatMaxTokens(settings?.maxTokens),
    model: String(settings?.model || config.DEFAULT_ADMIN_CHAT_SETTINGS.model || "").trim(),
    params: String(settings?.paramsText || config.DEFAULT_ADMIN_CHAT_SETTINGS.paramsText || "").trim()
  };

  if (normalizedSystemPrompt) {
    payload.custom_system_prompt = normalizedSystemPrompt;
  }

  return payload;
}

export async function loadAdminChatConfig() {
  const runtime = getRuntime();

  try {
    const result = await runtime.api.fileRead(config.ADMIN_CHAT_CONFIG_PATH);
    return normalizeStoredConfig(runtime.utils.yaml.parse(String(result?.content || "")));
  } catch (error) {
    if (isMissingFileError(error)) {
      return createDefaultConfig();
    }

    throw new Error(`Unable to load admin chat config: ${error.message}`);
  }
}

export async function saveAdminChatConfig(nextConfig) {
  const runtime = getRuntime();
  const content = runtime.utils.yaml.stringify(buildStoredConfigPayload(nextConfig));

  try {
    await runtime.api.fileWrite(config.ADMIN_CHAT_CONFIG_PATH, content);
  } catch (error) {
    throw new Error(`Unable to save admin chat config: ${error.message}`);
  }
}

export async function loadAdminChatHistory() {
  const runtime = getRuntime();

  try {
    const result = await runtime.api.fileRead(config.ADMIN_CHAT_HISTORY_PATH);
    const parsed = JSON.parse(String(result?.content || "[]"));
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (isMissingFileError(error)) {
      return [];
    }

    if (error instanceof SyntaxError) {
      throw new Error("Unable to load admin chat history: invalid JSON.");
    }

    throw new Error(`Unable to load admin chat history: ${error.message}`);
  }
}

export async function saveAdminChatHistory(history) {
  const runtime = getRuntime();
  const content = `${JSON.stringify(Array.isArray(history) ? history : [], null, 2)}\n`;

  try {
    await runtime.api.fileWrite(config.ADMIN_CHAT_HISTORY_PATH, content);
  } catch (error) {
    throw new Error(`Unable to save admin chat history: ${error.message}`);
  }
}
