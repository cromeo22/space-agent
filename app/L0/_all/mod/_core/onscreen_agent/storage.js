import * as config from "/mod/_core/onscreen_agent/config.js";

const DISPLAY_MODE_FULL = "full";
const DISPLAY_MODE_COMPACT = "compact";

function normalizeDisplayMode(value) {
  if (value === DISPLAY_MODE_FULL || value === DISPLAY_MODE_COMPACT) {
    return value;
  }

  return "";
}

function normalizeStoredCoordinate(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    const parsedValue = Number(value);

    if (Number.isFinite(parsedValue)) {
      return parsedValue;
    }
  }

  return null;
}

function createDefaultConfig() {
  return {
    settings: { ...config.DEFAULT_ONSCREEN_AGENT_SETTINGS },
    systemPrompt: "",
    agentX: null,
    agentY: null,
    historyHeight: null,
    displayMode: DISPLAY_MODE_COMPACT
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
    storedConfig.max_tokens ?? storedConfig.maxTokens ?? config.DEFAULT_ONSCREEN_AGENT_SETTINGS.maxTokens;
  const rawX = storedConfig.agent_x ?? storedConfig.agentX;
  const rawY = storedConfig.agent_y ?? storedConfig.agentY;
  const rawHistoryHeight = storedConfig.history_height ?? storedConfig.historyHeight;
  const storedDisplayMode = normalizeDisplayMode(storedConfig.display_mode ?? storedConfig.displayMode);
  const legacyDisplayMode =
    storedConfig.collapsed === true
      ? DISPLAY_MODE_COMPACT
      : storedConfig.collapsed === false
        ? DISPLAY_MODE_FULL
        : "";

  return {
    settings: {
      apiEndpoint: String(storedConfig.api_endpoint || storedConfig.apiEndpoint || config.DEFAULT_ONSCREEN_AGENT_SETTINGS.apiEndpoint || "").trim(),
      apiKey: String(storedConfig.api_key || storedConfig.apiKey || config.DEFAULT_ONSCREEN_AGENT_SETTINGS.apiKey || "").trim(),
      maxTokens: config.normalizeOnscreenAgentMaxTokens(storedMaxTokens),
      model: String(storedConfig.model || config.DEFAULT_ONSCREEN_AGENT_SETTINGS.model || "").trim(),
      paramsText: String(storedConfig.params || storedConfig.paramsText || config.DEFAULT_ONSCREEN_AGENT_SETTINGS.paramsText || "").trim()
    },
    systemPrompt: String(
      storedConfig.custom_system_prompt ||
        storedConfig.customSystemPrompt ||
        storedConfig.system_prompt ||
        storedConfig.systemPrompt ||
        ""
    ).trim(),
    agentX: normalizeStoredCoordinate(rawX),
    agentY: normalizeStoredCoordinate(rawY),
    historyHeight: config.normalizeOnscreenAgentHistoryHeight(rawHistoryHeight),
    displayMode: storedDisplayMode || legacyDisplayMode || DISPLAY_MODE_COMPACT
  };
}

function buildStoredConfigPayload({ settings, systemPrompt, agentX, agentY, historyHeight, displayMode }) {
  const normalizedSystemPrompt = typeof systemPrompt === "string" ? systemPrompt.trim() : "";
  const normalizedDisplayMode = normalizeDisplayMode(displayMode) || DISPLAY_MODE_COMPACT;
  const normalizedHistoryHeight = config.normalizeOnscreenAgentHistoryHeight(historyHeight);
  const payload = {
    api_endpoint: String(settings?.apiEndpoint || config.DEFAULT_ONSCREEN_AGENT_SETTINGS.apiEndpoint || "").trim(),
    api_key: String(settings?.apiKey || config.DEFAULT_ONSCREEN_AGENT_SETTINGS.apiKey || "").trim(),
    max_tokens: config.normalizeOnscreenAgentMaxTokens(settings?.maxTokens),
    model: String(settings?.model || config.DEFAULT_ONSCREEN_AGENT_SETTINGS.model || "").trim(),
    params: String(settings?.paramsText || config.DEFAULT_ONSCREEN_AGENT_SETTINGS.paramsText || "").trim(),
    display_mode: normalizedDisplayMode,
    collapsed: normalizedDisplayMode === DISPLAY_MODE_COMPACT
  };

  if (typeof agentX === "number" && Number.isFinite(agentX)) {
    payload.agent_x = Math.round(agentX);
  }

  if (typeof agentY === "number" && Number.isFinite(agentY)) {
    payload.agent_y = Math.round(agentY);
  }

  if (normalizedHistoryHeight !== null) {
    payload.history_height = normalizedHistoryHeight;
  }

  if (normalizedSystemPrompt) {
    payload.custom_system_prompt = normalizedSystemPrompt;
  }

  return payload;
}

export async function loadOnscreenAgentConfig() {
  const runtime = getRuntime();

  try {
    const result = await runtime.api.fileRead(config.ONSCREEN_AGENT_CONFIG_PATH);
    return normalizeStoredConfig(runtime.utils.yaml.parse(String(result?.content || "")));
  } catch (error) {
    if (isMissingFileError(error)) {
      return createDefaultConfig();
    }

    throw new Error(`Unable to load onscreen agent config: ${error.message}`);
  }
}

export async function saveOnscreenAgentConfig(nextConfig) {
  const runtime = getRuntime();
  const content = runtime.utils.yaml.stringify(buildStoredConfigPayload(nextConfig));

  try {
    await runtime.api.fileWrite(config.ONSCREEN_AGENT_CONFIG_PATH, content);
  } catch (error) {
    throw new Error(`Unable to save onscreen agent config: ${error.message}`);
  }
}

export async function loadOnscreenAgentHistory() {
  const runtime = getRuntime();

  try {
    const result = await runtime.api.fileRead(config.ONSCREEN_AGENT_HISTORY_PATH);
    const parsed = JSON.parse(String(result?.content || "[]"));
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (isMissingFileError(error)) {
      return [];
    }

    if (error instanceof SyntaxError) {
      throw new Error("Unable to load onscreen agent history: invalid JSON.");
    }

    throw new Error(`Unable to load onscreen agent history: ${error.message}`);
  }
}

export async function saveOnscreenAgentHistory(history) {
  const runtime = getRuntime();
  const content = `${JSON.stringify(Array.isArray(history) ? history : [], null, 2)}\n`;

  try {
    await runtime.api.fileWrite(config.ONSCREEN_AGENT_HISTORY_PATH, content);
  } catch (error) {
    throw new Error(`Unable to save onscreen agent history: ${error.message}`);
  }
}
