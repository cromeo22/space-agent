import {
  DEFAULT_WIDGET_POSITION,
  SPACE_ASSETS_DIR,
  SPACE_DATA_DIR,
  SPACE_MANIFEST_FILE,
  SPACE_WIDGET_FILE_EXTENSION,
  SPACE_WIDGET_SCHEMA,
  SPACE_WIDGETS_DIR,
  SPACES_ROOT_PATH,
  SPACES_SCHEMA
} from "/mod/_core/spaces/constants.js";
import {
  normalizeWidgetPosition,
  positionToToken,
  resolveSpaceLayout
} from "/mod/_core/spaces/layout.js";
import {
  DEFAULT_WIDGET_SIZE,
  defineWidget,
  normalizeWidgetSize,
  sizeToToken
} from "/mod/_core/spaces/widget-sdk-core.js";

function ensureSpaceRuntime() {
  if (!globalThis.space || !globalThis.space.api || !globalThis.space.utils?.yaml) {
    throw new Error("Spaces runtime requires the authenticated Space browser runtime.");
  }

  return globalThis.space;
}

function isNotFoundError(error) {
  const message = String(error?.message || "").toLowerCase();
  return message.includes("status 404") || message.includes("file not found") || message.includes("path not found");
}

function slugifySegment(value, fallback = "item") {
  const normalizedValue = String(value || "")
    .trim()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase();
  const slug = normalizedValue
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");

  return slug || fallback;
}

function normalizeOptionalSpaceId(value) {
  const rawValue = String(value ?? "").trim();
  return rawValue ? normalizeSpaceId(rawValue) : "";
}

function normalizeOptionalWidgetId(value) {
  const rawValue = String(value ?? "").trim();
  return rawValue ? normalizeWidgetId(rawValue) : "";
}

function formatTitleFromId(id) {
  return String(id || "")
    .split(/[-_]+/u)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

function uniqueList(values) {
  return [...new Set(values)];
}

function parseManifestSpaceId(path) {
  const match = String(path || "").match(/\/spaces\/([^/]+)\/space\.yaml$/u);
  return match ? match[1] : "";
}

function parseWidgetIdFromPath(path) {
  const match = String(path || "").match(/\/spaces\/[^/]+\/widgets\/([^/]+?)(?:\.yaml|\.js)$/u);
  return match ? normalizeOptionalWidgetId(match[1]) : "";
}

function normalizeWidgetMap(source, parser = (value) => value) {
  const entries = source && typeof source === "object" && !Array.isArray(source) ? Object.entries(source) : [];
  const output = {};

  entries.forEach(([key, value]) => {
    const normalizedKey = normalizeOptionalWidgetId(key);

    if (!normalizedKey) {
      return;
    }

    output[normalizedKey] = parser(value);
  });

  return output;
}

function pickWidgetMap(source, widgetIds) {
  const widgetIdSet = new Set(Array.isArray(widgetIds) ? widgetIds : []);
  const output = {};

  Object.entries(source || {}).forEach(([widgetId, value]) => {
    if (!widgetIdSet.has(widgetId)) {
      return;
    }

    output[widgetId] = value;
  });

  return output;
}

function normalizeWidgetIdList(values) {
  const rawValues = Array.isArray(values) ? values : typeof values === "string" && values ? [values] : [];
  return uniqueList(
    rawValues
      .map((value) => normalizeOptionalWidgetId(value))
      .filter(Boolean)
  );
}

function cloneWidgetRecord(widgetRecord) {
  return {
    ...widgetRecord,
    defaultPosition: normalizeWidgetPosition(widgetRecord?.defaultPosition, DEFAULT_WIDGET_POSITION),
    defaultSize: normalizeWidgetSize(widgetRecord?.defaultSize, DEFAULT_WIDGET_SIZE)
  };
}

function cloneSpaceRecord(spaceRecord) {
  return {
    ...spaceRecord,
    minimizedWidgetIds: [...spaceRecord.minimizedWidgetIds],
    widgetIds: [...spaceRecord.widgetIds],
    widgetPositions: { ...spaceRecord.widgetPositions },
    widgetSizes: { ...spaceRecord.widgetSizes },
    widgets: Object.fromEntries(
      Object.entries(spaceRecord.widgets || {}).map(([widgetId, widgetRecord]) => [widgetId, cloneWidgetRecord(widgetRecord)])
    )
  };
}

function formatSpaceListEntry(spaceRecord, widgetCount = spaceRecord.widgetIds.length) {
  return {
    ...spaceRecord,
    updatedAtLabel: spaceRecord.updatedAt ? new Date(spaceRecord.updatedAt).toLocaleString() : "Unknown update time",
    widgetCount,
    widgetCountLabel: `${widgetCount} ${widgetCount === 1 ? "widget" : "widgets"}`
  };
}

function normalizeManifest(rawManifest, fallbackId = "") {
  const now = new Date().toISOString();
  const id = normalizeSpaceId(rawManifest?.id || fallbackId || rawManifest?.title || `space-${Date.now().toString(36)}`);
  const widgetIds = normalizeWidgetIdList(
    rawManifest?.layout_order ?? rawManifest?.widget_order ?? rawManifest?.widgets ?? rawManifest?.widgetIds
  );
  const minimizedWidgetIds = normalizeWidgetIdList(
    rawManifest?.minimized ?? rawManifest?.collapsed ?? rawManifest?.minimizedWidgetIds
  );
  const widgetPositions = pickWidgetMap(
    normalizeWidgetMap(rawManifest?.positions ?? rawManifest?.widgetPositions, (value) =>
      normalizeWidgetPosition(value, DEFAULT_WIDGET_POSITION)
    ),
    widgetIds
  );
  const widgetSizes = pickWidgetMap(
    normalizeWidgetMap(rawManifest?.sizes ?? rawManifest?.widgetSizes, (value) => normalizeWidgetSize(value, DEFAULT_WIDGET_SIZE)),
    widgetIds
  );

  return {
    createdAt: String(rawManifest?.created_at || rawManifest?.createdAt || now),
    dataPath: buildSpaceDataPath(id),
    id,
    manifestPath: buildSpaceManifestPath(id),
    minimizedWidgetIds,
    path: buildSpaceRootPath(id),
    schema: String(rawManifest?.schema || SPACES_SCHEMA),
    title: String(rawManifest?.title || formatTitleFromId(id) || "Untitled Space"),
    updatedAt: String(rawManifest?.updated_at || rawManifest?.updatedAt || now),
    widgetIds,
    widgetPositions,
    widgetSizes,
    widgets: {},
    widgetsPath: buildSpaceWidgetsPath(id),
    assetsPath: buildSpaceAssetsPath(id)
  };
}

function serializeManifest(spaceRecord) {
  const runtime = ensureSpaceRuntime();
  const yamlSource = {
    created_at: spaceRecord.createdAt,
    id: spaceRecord.id,
    schema: SPACES_SCHEMA,
    title: spaceRecord.title,
    updated_at: spaceRecord.updatedAt
  };

  if (spaceRecord.widgetIds.length) {
    yamlSource.layout_order = [...spaceRecord.widgetIds];
  }

  const sizeEntries = spaceRecord.widgetIds
    .filter((widgetId) => spaceRecord.widgetSizes[widgetId])
    .map((widgetId) => [widgetId, sizeToToken(spaceRecord.widgetSizes[widgetId])]);

  if (sizeEntries.length) {
    yamlSource.sizes = Object.fromEntries(sizeEntries);
  }

  const positionEntries = spaceRecord.widgetIds
    .filter((widgetId) => spaceRecord.widgetPositions[widgetId])
    .map((widgetId) => [widgetId, positionToToken(spaceRecord.widgetPositions[widgetId])]);

  if (positionEntries.length) {
    yamlSource.positions = Object.fromEntries(positionEntries);
  }

  const minimizedWidgetIds = normalizeWidgetIdList(spaceRecord.minimizedWidgetIds).filter((widgetId) =>
    spaceRecord.widgetIds.includes(widgetId)
  );

  if (minimizedWidgetIds.length) {
    yamlSource.minimized = minimizedWidgetIds;
  }

  return runtime.utils.yaml.stringify(yamlSource);
}

function normalizeWidgetRecord(rawWidget, fallback = {}) {
  const widgetId = normalizeWidgetId(rawWidget?.id || fallback.id || rawWidget?.name || "widget");
  const name = String(rawWidget?.name || rawWidget?.title || fallback.name || formatTitleFromId(widgetId) || "Untitled Widget").trim();
  const sizeSource =
    rawWidget?.size ??
    rawWidget?.default_size ??
    rawWidget?.defaultSize ??
    (rawWidget?.cols !== undefined || rawWidget?.rows !== undefined
      ? {
          cols: rawWidget?.cols,
          rows: rawWidget?.rows
        }
      : fallback.defaultSize);
  const positionSource =
    rawWidget?.position ??
    rawWidget?.default_position ??
    rawWidget?.defaultPosition ??
    (rawWidget?.col !== undefined || rawWidget?.row !== undefined
      ? {
          col: rawWidget?.col,
          row: rawWidget?.row
        }
      : fallback.defaultPosition);

  return {
    defaultPosition: normalizeWidgetPosition(positionSource, DEFAULT_WIDGET_POSITION),
    defaultSize: normalizeWidgetSize(sizeSource, DEFAULT_WIDGET_SIZE),
    id: widgetId,
    name: name || formatTitleFromId(widgetId) || "Untitled Widget",
    path: String(fallback.path || ""),
    rendererSource: normalizeRendererSource(rawWidget?.renderer ?? rawWidget?.render ?? fallback.rendererSource),
    schema: String(rawWidget?.schema || fallback.schema || SPACE_WIDGET_SCHEMA)
  };
}

function serializeWidgetRecord(widgetRecord) {
  const runtime = ensureSpaceRuntime();
  const yamlSource = {
    cols: widgetRecord.defaultSize.cols,
    id: widgetRecord.id,
    name: widgetRecord.name,
    renderer: widgetRecord.rendererSource,
    rows: widgetRecord.defaultSize.rows,
    schema: SPACE_WIDGET_SCHEMA
  };

  if (widgetRecord.defaultPosition.col !== DEFAULT_WIDGET_POSITION.col) {
    yamlSource.col = widgetRecord.defaultPosition.col;
  }

  if (widgetRecord.defaultPosition.row !== DEFAULT_WIDGET_POSITION.row) {
    yamlSource.row = widgetRecord.defaultPosition.row;
  }

  return runtime.utils.yaml.stringify(yamlSource);
}

function createHtmlRendererSource(htmlSource) {
  return [
    "(parent) => {",
    `  parent.innerHTML = ${JSON.stringify(String(htmlSource || '<div class="spaces-raw-demo"></div>'))};`,
    "}"
  ].join("\n");
}

async function deleteAppPathIfExists(path) {
  const runtime = ensureSpaceRuntime();

  try {
    await runtime.api.fileDelete(path);
  } catch (error) {
    if (isNotFoundError(error)) {
      return false;
    }

    throw error;
  }

  return true;
}

function normalizeLegacyFunctionSource(sourceText) {
  const trimmedSource = String(sourceText || "").trim();

  if (!trimmedSource) {
    return "";
  }

  if (
    /^(async\s+)?function\b/u.test(trimmedSource) ||
    trimmedSource.startsWith("(") ||
    trimmedSource.includes("=>")
  ) {
    return trimmedSource;
  }

  const methodMatch = trimmedSource.match(/^(async\s+)?([A-Za-z_$][\w$]*)\s*\(/u);

  if (methodMatch) {
    const asyncPrefix = methodMatch[1] || "";
    const methodName = methodMatch[2];
    return `${asyncPrefix}function ${methodName}${trimmedSource.slice(methodMatch[0].length - 1)}`;
  }

  return trimmedSource;
}

export function normalizeRendererSource(value, fallback = "") {
  const sourceText =
    typeof value === "function"
      ? value.toString()
      : value ?? fallback ?? "";
  const normalizedValue = normalizeLegacyFunctionSource(sourceText);

  if (!normalizedValue) {
    throw new Error("Widgets require a renderer function.");
  }

  return normalizedValue;
}

function createDefaultRendererSource() {
  return [
    "(parent) => {",
    "  const copy = document.createElement(\"p\");",
    "  copy.className = \"spaces-widget-placeholder-copy\";",
    "  copy.textContent = \"Replace this widget renderer with your own DOM code.\";",
    "  parent.appendChild(copy);",
    "}"
  ].join("\n");
}

function createWidgetRecordFromOptions(options = {}, fallback = {}) {
  const rendererSource =
    options.renderer ??
    options.render ??
    options.source ??
    (options.html !== undefined ? createHtmlRendererSource(options.html) : fallback.rendererSource ?? createDefaultRendererSource());
  const sizeSource =
    options.size ??
    (options.cols !== undefined || options.rows !== undefined
      ? {
          cols: options.cols,
          rows: options.rows
        }
      : fallback.defaultSize);
  const positionSource =
    options.position ??
    (options.col !== undefined || options.row !== undefined
      ? {
          col: options.col,
          row: options.row
        }
      : fallback.defaultPosition);

  return normalizeWidgetRecord(
    {
      col: options.col,
      cols: options.cols,
      defaultPosition: positionSource,
      defaultSize: sizeSource,
      id: options.widgetId || options.id || fallback.id,
      name: options.name || options.title || fallback.name,
      renderer: rendererSource,
      row: options.row,
      rows: options.rows,
      schema: options.schema || fallback.schema || SPACE_WIDGET_SCHEMA
    },
    fallback
  );
}

function parseWidgetSource(sourceText, fallback = {}) {
  const runtime = ensureSpaceRuntime();
  const normalizedSource = String(sourceText || "");
  const parsed = runtime.utils.yaml.parse(normalizedSource);

  if (
    parsed &&
    typeof parsed === "object" &&
    !Array.isArray(parsed) &&
    (parsed.renderer !== undefined || parsed.render !== undefined || parsed.id !== undefined || parsed.name !== undefined)
  ) {
    return normalizeWidgetRecord(parsed, fallback);
  }

  return normalizeWidgetRecord(
    {
      id: fallback.id,
      name: fallback.name,
      renderer: normalizedSource
    },
    fallback
  );
}

async function readManifestFile(spaceId) {
  const runtime = ensureSpaceRuntime();
  const response = await runtime.api.fileRead(buildSpaceManifestPath(spaceId));
  const parsed = runtime.utils.yaml.parse(String(response?.content || ""));
  return normalizeManifest(parsed, spaceId);
}

async function writeManifestFile(spaceRecord) {
  const runtime = ensureSpaceRuntime();
  const normalizedRecord = normalizeManifest(spaceRecord, spaceRecord?.id);
  normalizedRecord.widgetIds = [...spaceRecord.widgetIds];
  normalizedRecord.widgetPositions = pickWidgetMap(spaceRecord.widgetPositions, normalizedRecord.widgetIds);
  normalizedRecord.widgetSizes = pickWidgetMap(spaceRecord.widgetSizes, normalizedRecord.widgetIds);
  normalizedRecord.minimizedWidgetIds = normalizeWidgetIdList(spaceRecord.minimizedWidgetIds).filter((widgetId) =>
    normalizedRecord.widgetIds.includes(widgetId)
  );
  normalizedRecord.updatedAt = String(spaceRecord?.updatedAt || normalizedRecord.updatedAt);
  normalizedRecord.createdAt = String(spaceRecord?.createdAt || normalizedRecord.createdAt);
  normalizedRecord.title = String(spaceRecord?.title || normalizedRecord.title);

  await runtime.api.fileWrite({
    content: serializeManifest(normalizedRecord),
    path: buildSpaceManifestPath(normalizedRecord.id)
  });

  return normalizedRecord;
}

async function spaceExists(spaceId) {
  const runtime = ensureSpaceRuntime();

  try {
    await runtime.api.fileInfo(buildSpaceManifestPath(spaceId));
    return true;
  } catch (error) {
    if (isNotFoundError(error)) {
      return false;
    }

    throw error;
  }
}

async function createUniqueSpaceId(baseId) {
  const normalizedBaseId = normalizeSpaceId(baseId, "space");
  let nextId = normalizedBaseId;
  let suffix = 2;

  while (await spaceExists(nextId)) {
    nextId = `${normalizedBaseId}-${suffix}`;
    suffix += 1;
  }

  return nextId;
}

async function listSpaceWidgetPaths(spaceId) {
  const runtime = ensureSpaceRuntime();

  try {
    const listResult = await runtime.api.fileList(buildSpaceWidgetsPath(spaceId), false);
    return Array.isArray(listResult?.paths) ? listResult.paths : [];
  } catch (error) {
    if (isNotFoundError(error)) {
      return [];
    }

    throw error;
  }
}

async function loadLegacyWidgetDefinition(spaceId, widgetId) {
  const moduleUrl = new URL(resolveAppUrl(buildLegacySpaceWidgetFilePath(spaceId, widgetId)), globalThis.location.origin);
  moduleUrl.searchParams.set("v", `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);

  const module = await import(moduleUrl.toString());
  const candidate = module?.default ?? module?.widget ?? module;

  if (!candidate || typeof candidate !== "object" || typeof candidate.render !== "function") {
    throw new Error(`Legacy widget "${widgetId}" does not export a valid definition.`);
  }

  return defineWidget(candidate);
}

function createLegacyRendererSource(definition) {
  const loadSource = typeof definition.load === "function" ? normalizeLegacyFunctionSource(definition.load.toString()) : "";
  const renderSource = normalizeLegacyFunctionSource(definition.render.toString());

  return [
    "async (parent, space, context) => {",
    loadSource ? `  const load = ${loadSource};` : "  const load = null;",
    `  const render = ${renderSource};`,
    "  const data = load ? await load(context) : undefined;",
    "  return render({ ...context, data });",
    "}"
  ].join("\n");
}

async function migrateLegacyWidgetModules(spaceId) {
  const runtime = ensureSpaceRuntime();
  const widgetPaths = await listSpaceWidgetPaths(spaceId);
  const legacyPaths = widgetPaths.filter((path) => String(path || "").endsWith(".js"));

  if (!legacyPaths.length) {
    return;
  }

  const nextFiles = [];
  const deletePaths = [];

  for (const legacyPath of legacyPaths) {
    const widgetId = parseWidgetIdFromPath(legacyPath);

    if (!widgetId) {
      continue;
    }

    const definition = await loadLegacyWidgetDefinition(spaceId, widgetId);
    const widgetRecord = normalizeWidgetRecord(
      {
        id: widgetId,
        name: definition.title,
        renderer: createLegacyRendererSource(definition),
        size: definition.size
      },
      {
        id: widgetId,
        path: buildSpaceWidgetFilePath(spaceId, widgetId)
      }
    );

    nextFiles.push({
      content: serializeWidgetRecord(widgetRecord),
      path: buildSpaceWidgetFilePath(spaceId, widgetId)
    });
    deletePaths.push(legacyPath);
  }

  if (nextFiles.length) {
    await runtime.api.fileWrite({ files: nextFiles });
  }

  if (deletePaths.length) {
    await runtime.api.fileDelete({ paths: deletePaths });
  }
}

async function readWidgetFiles(spaceId) {
  const runtime = ensureSpaceRuntime();
  const widgetPaths = (await listSpaceWidgetPaths(spaceId)).filter((path) => String(path || "").endsWith(SPACE_WIDGET_FILE_EXTENSION));

  if (!widgetPaths.length) {
    return {};
  }

  const readResult = await runtime.api.fileRead({
    files: widgetPaths
  });
  const files = Array.isArray(readResult?.files) ? readResult.files : [];
  const widgets = {};

  files.forEach((file) => {
    const widgetId = parseWidgetIdFromPath(file?.path);

    if (!widgetId) {
      return;
    }

    const parsed = runtime.utils.yaml.parse(String(file?.content || ""));
    widgets[widgetId] = normalizeWidgetRecord(parsed, {
      id: widgetId,
      path: buildSpaceWidgetFilePath(spaceId, widgetId)
    });
  });

  return widgets;
}

function buildResolvedLayoutInputs(spaceRecord, overrides = {}) {
  const widgetIds = normalizeWidgetIdList(overrides.widgetIds ?? spaceRecord.widgetIds).filter((widgetId) => spaceRecord.widgets[widgetId]);
  const widgetPositions = {};
  const widgetSizes = {};

  widgetIds.forEach((widgetId) => {
    const widgetRecord = overrides.widgets?.[widgetId] || spaceRecord.widgets?.[widgetId];
    const defaultPosition = widgetRecord?.defaultPosition || DEFAULT_WIDGET_POSITION;
    const defaultSize = widgetRecord?.defaultSize || DEFAULT_WIDGET_SIZE;
    const sourcePositions = overrides.widgetPositions ?? spaceRecord.widgetPositions;
    const sourceSizes = overrides.widgetSizes ?? spaceRecord.widgetSizes;

    widgetPositions[widgetId] = normalizeWidgetPosition(sourcePositions?.[widgetId] ?? defaultPosition, defaultPosition);
    widgetSizes[widgetId] = normalizeWidgetSize(sourceSizes?.[widgetId] ?? defaultSize, defaultSize);
  });

  return {
    minimizedWidgetIds: normalizeWidgetIdList(overrides.minimizedWidgetIds ?? spaceRecord.minimizedWidgetIds).filter((widgetId) =>
      widgetIds.includes(widgetId)
    ),
    widgetIds,
    widgetPositions,
    widgetSizes
  };
}

function syncManifestWithResolvedLayout(spaceRecord, resolvedLayout) {
  const widgetIds = normalizeWidgetIdList(spaceRecord.widgetIds).filter((widgetId) => spaceRecord.widgets[widgetId]);
  spaceRecord.widgetIds = widgetIds;
  spaceRecord.widgetPositions = pickWidgetMap(resolvedLayout.positions, widgetIds);
  spaceRecord.widgetSizes = pickWidgetMap(spaceRecord.widgetSizes, widgetIds);
  spaceRecord.minimizedWidgetIds = widgetIds.filter((widgetId) => resolvedLayout.minimizedMap[widgetId]);
}

export function normalizeSpaceId(value, fallback = "space") {
  const fallbackId = slugifySegment(fallback, "space");
  return slugifySegment(value, fallbackId);
}

export function normalizeWidgetId(value, fallback = "widget") {
  return slugifySegment(value, fallback);
}

export function buildSpaceRootPath(spaceId) {
  const normalizedSpaceId = normalizeOptionalSpaceId(spaceId);

  if (!normalizedSpaceId) {
    throw new Error("A spaceId is required.");
  }

  return `${SPACES_ROOT_PATH}${normalizedSpaceId}/`;
}

export function buildSpaceManifestPath(spaceId) {
  return `${buildSpaceRootPath(spaceId)}${SPACE_MANIFEST_FILE}`;
}

export function buildSpaceWidgetsPath(spaceId) {
  return `${buildSpaceRootPath(spaceId)}${SPACE_WIDGETS_DIR}`;
}

export function buildSpaceWidgetFilePath(spaceId, widgetId) {
  const normalizedWidgetId = normalizeOptionalWidgetId(widgetId);

  if (!normalizedWidgetId) {
    throw new Error("A widgetId is required.");
  }

  return `${buildSpaceWidgetsPath(spaceId)}${normalizedWidgetId}${SPACE_WIDGET_FILE_EXTENSION}`;
}

function buildLegacySpaceWidgetFilePath(spaceId, widgetId) {
  const normalizedWidgetId = normalizeOptionalWidgetId(widgetId);

  if (!normalizedWidgetId) {
    throw new Error("A widgetId is required.");
  }

  return `${buildSpaceWidgetsPath(spaceId)}${normalizedWidgetId}.js`;
}

export function buildSpaceDataPath(spaceId) {
  return `${buildSpaceRootPath(spaceId)}${SPACE_DATA_DIR}`;
}

export function buildSpaceAssetsPath(spaceId) {
  return `${buildSpaceRootPath(spaceId)}${SPACE_ASSETS_DIR}`;
}

export function resolveAppUrl(path) {
  const normalizedPath = String(path || "").trim();

  if (!normalizedPath) {
    throw new Error("A logical app path is required.");
  }

  if (normalizedPath === "~") {
    return "/~/";
  }

  if (normalizedPath.startsWith("~/")) {
    return `/${normalizedPath}`;
  }

  if (normalizedPath.startsWith("/app/")) {
    return resolveAppUrl(normalizedPath.slice("/app/".length));
  }

  if (normalizedPath.startsWith("/~/")) {
    return normalizedPath;
  }

  if (/^\/(L0|L1|L2)\//u.test(normalizedPath)) {
    return normalizedPath;
  }

  if (/^(L0|L1|L2)\//u.test(normalizedPath)) {
    return `/${normalizedPath}`;
  }

  throw new Error(`Unsupported app path "${normalizedPath}".`);
}

export function createWidgetSource(options = {}) {
  const widgetRecord = createWidgetRecordFromOptions(
    {
      ...options,
      renderer:
        options.renderer ??
        options.render ??
        options.source ??
        (options.html !== undefined ? createHtmlRendererSource(options.html) : undefined)
    },
    {
      id: normalizeWidgetId(options.widgetId || options.id || options.name || options.title || "widget"),
      name: String(options.name || options.title || "Untitled Widget").trim() || "Untitled Widget",
      rendererSource: createDefaultRendererSource()
    }
  );

  return serializeWidgetRecord(widgetRecord);
}

export function previewWidgetRecord(options = {}, fallback = {}) {
  const widgetFallbackId = normalizeWidgetId(options.widgetId || options.id || options.name || options.title || fallback.id || "widget");

  return options.source !== undefined
    ? parseWidgetSource(options.source, {
        ...fallback,
        id: fallback.id || widgetFallbackId,
        name: options.name || options.title || fallback.name || formatTitleFromId(widgetFallbackId),
        rendererSource: fallback.rendererSource || createDefaultRendererSource()
      })
    : createWidgetRecordFromOptions(options, {
        ...fallback,
        defaultPosition: fallback.defaultPosition || DEFAULT_WIDGET_POSITION,
        defaultSize: fallback.defaultSize || DEFAULT_WIDGET_SIZE,
        id: fallback.id || widgetFallbackId,
        name: fallback.name || formatTitleFromId(widgetFallbackId),
        rendererSource: fallback.rendererSource || createDefaultRendererSource()
      });
}

export async function listSpaces() {
  const runtime = ensureSpaceRuntime();
  let matchedPaths = [];

  try {
    const listResult = await runtime.api.fileList(SPACES_ROOT_PATH, true);
    matchedPaths = Array.isArray(listResult?.paths) ? listResult.paths : [];
  } catch (error) {
    if (isNotFoundError(error)) {
      return [];
    }

    throw error;
  }

  const manifestPaths = matchedPaths.filter((path) => /\/spaces\/[^/]+\/space\.yaml$/u.test(String(path || "")));

  if (!manifestPaths.length) {
    return [];
  }

  const widgetCounts = {};
  matchedPaths.forEach((path) => {
    const normalizedPath = String(path || "");

    if (!/\/spaces\/[^/]+\/widgets\/[^/]+\.(?:yaml|js)$/u.test(normalizedPath)) {
      return;
    }

    const widgetSpaceId = normalizedSpaceIdFromWidgetPath(normalizedPath);

    if (!widgetSpaceId) {
      return;
    }

    if (!widgetCounts[widgetSpaceId]) {
      widgetCounts[widgetSpaceId] = new Set();
    }

    widgetCounts[widgetSpaceId].add(parseWidgetIdFromPath(normalizedPath));
  });

  const readResult = await runtime.api.fileRead({
    files: manifestPaths
  });
  const files = Array.isArray(readResult?.files) ? readResult.files : [];

  return files
    .map((file) => {
      const fallbackId = parseManifestSpaceId(file?.path);
      const parsedContent = runtime.utils.yaml.parse(String(file?.content || ""));
      const normalizedSpace = normalizeManifest(parsedContent, fallbackId);
      return formatSpaceListEntry(normalizedSpace, widgetCounts[normalizedSpace.id]?.size || normalizedSpace.widgetIds.length);
    })
    .sort((left, right) => {
      const leftTime = Date.parse(left.updatedAt || left.createdAt || "");
      const rightTime = Date.parse(right.updatedAt || right.createdAt || "");

      if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
        return rightTime - leftTime;
      }

      return left.title.localeCompare(right.title, undefined, {
        numeric: true,
        sensitivity: "base"
      });
    });
}

function normalizedSpaceIdFromWidgetPath(path) {
  const match = String(path || "").match(/\/spaces\/([^/]+)\/widgets\/[^/]+\.(?:yaml|js)$/u);
  return match ? normalizeOptionalSpaceId(match[1]) : "";
}

export async function readSpace(spaceId) {
  const manifest = await readManifestFile(spaceId);
  await migrateLegacyWidgetModules(manifest.id);
  const widgets = await readWidgetFiles(manifest.id);
  const discoveredWidgetIds = Object.keys(widgets);
  const widgetIds = uniqueList([...manifest.widgetIds.filter((widgetId) => widgets[widgetId]), ...discoveredWidgetIds]);

  return {
    ...manifest,
    minimizedWidgetIds: manifest.minimizedWidgetIds.filter((widgetId) => widgetIds.includes(widgetId)),
    widgetIds,
    widgetPositions: pickWidgetMap(manifest.widgetPositions, widgetIds),
    widgetSizes: pickWidgetMap(manifest.widgetSizes, widgetIds),
    widgets
  };
}

export async function createSpace(options = {}) {
  const runtime = ensureSpaceRuntime();
  const title = String(options.title || "Untitled Space").trim() || "Untitled Space";
  const id = await createUniqueSpaceId(options.id || title);
  const timestamp = new Date().toISOString();
  const manifest = normalizeManifest(
    {
      created_at: timestamp,
      id,
      schema: SPACES_SCHEMA,
      title,
      updated_at: timestamp
    },
    id
  );

  await runtime.api.fileWrite({
    files: [
      { path: buildSpaceRootPath(id) },
      { path: buildSpaceWidgetsPath(id) },
      { path: buildSpaceDataPath(id) },
      { path: buildSpaceAssetsPath(id) }
    ]
  });

  await runtime.api.fileWrite({
    content: serializeManifest(manifest),
    path: buildSpaceManifestPath(id)
  });

  return manifest;
}

export async function removeSpace(spaceIdOrOptions = {}) {
  const runtime = ensureSpaceRuntime();
  const requestedSpaceId =
    typeof spaceIdOrOptions === "string"
      ? spaceIdOrOptions
      : spaceIdOrOptions && typeof spaceIdOrOptions === "object"
        ? spaceIdOrOptions.spaceId ?? spaceIdOrOptions.id
        : "";
  const spaceId = normalizeOptionalSpaceId(requestedSpaceId);

  if (!spaceId) {
    throw new Error("A target spaceId is required to remove a space.");
  }

  const spacePath = buildSpaceRootPath(spaceId);
  await runtime.api.fileDelete(spacePath);

  return {
    id: spaceId,
    path: spacePath
  };
}

export async function saveSpaceMeta(options = {}) {
  const currentSpace = cloneSpaceRecord(await readSpace(options.id));
  const nextSpace = cloneSpaceRecord(currentSpace);

  if (options.title !== undefined) {
    nextSpace.title = String(options.title || "").trim() || currentSpace.title;
  }

  nextSpace.updatedAt = new Date().toISOString();
  return writeManifestFile(nextSpace);
}

export async function saveSpaceLayout(options = {}) {
  const currentSpace = cloneSpaceRecord(await readSpace(options.id));
  const nextSpace = cloneSpaceRecord(currentSpace);

  if (Array.isArray(options.widgetIds)) {
    nextSpace.widgetIds = normalizeWidgetIdList(options.widgetIds).filter((widgetId) => nextSpace.widgets[widgetId]);
  }

  if (options.widgetPositions && typeof options.widgetPositions === "object") {
    nextSpace.widgetPositions = normalizeWidgetMap(options.widgetPositions, (value) =>
      normalizeWidgetPosition(value, DEFAULT_WIDGET_POSITION)
    );
  }

  if (options.widgetSizes && typeof options.widgetSizes === "object") {
    nextSpace.widgetSizes = normalizeWidgetMap(options.widgetSizes, (value) =>
      normalizeWidgetSize(value, DEFAULT_WIDGET_SIZE)
    );
  }

  if (Array.isArray(options.minimizedWidgetIds)) {
    nextSpace.minimizedWidgetIds = normalizeWidgetIdList(options.minimizedWidgetIds);
  }

  const layoutInputs = buildResolvedLayoutInputs(nextSpace);
  const resolvedLayout = resolveSpaceLayout(layoutInputs);

  syncManifestWithResolvedLayout(nextSpace, resolvedLayout);
  nextSpace.updatedAt = new Date().toISOString();

  return writeManifestFile(nextSpace);
}

export async function upsertWidget(options = {}) {
  const runtime = ensureSpaceRuntime();
  const spaceId = normalizeOptionalSpaceId(options.spaceId);

  if (!spaceId) {
    throw new Error("A target spaceId is required to upsert a widget.");
  }

  const currentSpace = cloneSpaceRecord(await readSpace(spaceId));
  const widgetFallbackId = normalizeWidgetId(options.widgetId || options.id || options.name || options.title || "widget");
  const existingWidget = currentSpace.widgets[widgetFallbackId] || null;
  const widgetRecord = previewWidgetRecord(options, {
    ...existingWidget,
    defaultPosition: existingWidget?.defaultPosition || DEFAULT_WIDGET_POSITION,
    defaultSize: existingWidget?.defaultSize || DEFAULT_WIDGET_SIZE,
    id: existingWidget?.id || widgetFallbackId,
    name: options.name || options.title || existingWidget?.name || formatTitleFromId(widgetFallbackId),
    path: buildSpaceWidgetFilePath(spaceId, widgetFallbackId),
    rendererSource: existingWidget?.rendererSource || createDefaultRendererSource()
  });
  const widgetId = widgetRecord.id;
  const nextSpace = cloneSpaceRecord(currentSpace);
  const hasExistingWidget = nextSpace.widgetIds.includes(widgetId);

  nextSpace.widgets[widgetId] = {
    ...widgetRecord,
    path: buildSpaceWidgetFilePath(spaceId, widgetId)
  };

  if (!hasExistingWidget) {
    nextSpace.widgetIds.push(widgetId);
  }

  nextSpace.widgetPositions = pickWidgetMap(nextSpace.widgetPositions, nextSpace.widgetIds);
  nextSpace.widgetSizes = pickWidgetMap(nextSpace.widgetSizes, nextSpace.widgetIds);
  nextSpace.updatedAt = new Date().toISOString();

  const files = [
    {
      content: serializeManifest(nextSpace),
      path: buildSpaceManifestPath(spaceId)
    },
    {
      content: serializeWidgetRecord(nextSpace.widgets[widgetId]),
      path: buildSpaceWidgetFilePath(spaceId, widgetId)
    }
  ];

  await runtime.api.fileWrite({ files });

  return {
    space: nextSpace,
    widgetId,
    widgetPath: buildSpaceWidgetFilePath(spaceId, widgetId)
  };
}

export async function removeWidget(options = {}) {
  const result = await removeWidgets({
    ...options,
    widgetIds: [options.widgetId]
  });

  return {
    space: result.space,
    widgetId: result.widgetIds[0] || normalizeOptionalWidgetId(options.widgetId)
  };
}

export async function removeWidgets(options = {}) {
  const runtime = ensureSpaceRuntime();
  const spaceId = normalizeOptionalSpaceId(options.spaceId);
  const widgetIds = normalizeWidgetIdList(options.widgetIds ?? options.widgetId);

  if (!spaceId) {
    throw new Error("A target spaceId is required to remove widgets.");
  }

  const currentSpace = cloneSpaceRecord(await readSpace(spaceId));
  const existingWidgetIds = new Set(currentSpace.widgetIds);
  const missingWidgetIds = widgetIds.filter((widgetId) => !existingWidgetIds.has(widgetId));

  if (!widgetIds.length) {
    return {
      space: currentSpace,
      widgetIds: []
    };
  }

  if (missingWidgetIds.length) {
    throw new Error(`Widgets "${missingWidgetIds.join('", "')}" were not found in space "${spaceId}".`);
  }

  const widgetIdSet = new Set(widgetIds);
  currentSpace.widgetIds = currentSpace.widgetIds.filter((entry) => !widgetIdSet.has(entry));
  currentSpace.minimizedWidgetIds = currentSpace.minimizedWidgetIds.filter((entry) => !widgetIdSet.has(entry));
  widgetIds.forEach((widgetId) => {
    delete currentSpace.widgetPositions[widgetId];
    delete currentSpace.widgetSizes[widgetId];
    delete currentSpace.widgets[widgetId];
  });
  currentSpace.updatedAt = new Date().toISOString();

  await runtime.api.fileWrite({
    content: serializeManifest(currentSpace),
    path: buildSpaceManifestPath(spaceId)
  });

  await runtime.api.fileDelete({
    paths: widgetIds.map((widgetId) => buildSpaceWidgetFilePath(spaceId, widgetId))
  });
  await Promise.all(widgetIds.map((widgetId) => deleteAppPathIfExists(buildLegacySpaceWidgetFilePath(spaceId, widgetId))));

  return {
    space: currentSpace,
    widgetIds
  };
}
