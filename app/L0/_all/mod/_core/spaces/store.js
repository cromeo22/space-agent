import {
  DEFAULT_WIDGET_POSITION,
  MAX_WIDGET_COLS,
  MAX_WIDGET_ROWS,
  SPACES_ROUTE_PATH,
  WIDGET_API_VERSION
} from "/mod/_core/spaces/constants.js";
import {
  buildCenteredFirstFitLayout,
  clampWidgetPosition,
  findFirstFitWidgetPlacement,
  getRenderedWidgetSize,
  normalizeWidgetPosition,
  resolveSpaceLayout
} from "/mod/_core/spaces/layout.js";
import {
  buildSpaceRootPath,
  buildSpaceWidgetFilePath,
  createSpace,
  createWidgetSource,
  listSpaces,
  normalizeRendererSource,
  normalizeSpaceId,
  normalizeWidgetId,
  previewWidgetRecord,
  readSpace,
  removeSpace,
  removeWidget,
  removeWidgets as removeWidgetsFromStorage,
  resolveAppUrl,
  saveSpaceLayout,
  saveSpaceMeta,
  upsertWidget
} from "/mod/_core/spaces/storage.js";
import {
  DEFAULT_WIDGET_SIZE,
  defineWidget,
  normalizeWidgetSize,
  sizeToToken,
} from "/mod/_core/spaces/widget-sdk-core.js";
import { renderWidgetOutput } from "/mod/_core/spaces/widget-render.js";

let activeSpacesStore = null;
const SPACES_STORE_NAME = "spacesPage";
const TAU = Math.PI * 2;
const GRID_BASE_HALF_COLS = 0;
const GRID_BASE_HALF_ROWS = 0;
const GRID_CONTENT_BUFFER_COLS = 6;
const GRID_CONTENT_BUFFER_ROWS = 6;
const GRID_CAMERA_BUFFER_COLS = 2;
const GRID_CAMERA_BUFFER_ROWS = 2;
const GRID_EDGE_SCROLL_THRESHOLD = 72;
const GRID_EDGE_SCROLL_SPEED = 8;
const EMPTY_SPACE_FLOAT_PROFILE = Object.freeze({
  orbitPeriodMs: 12400,
  rotationAmplitude: 3.2,
  rotationPeriodMs: 17600,
  xRadius: 7.2,
  yRadius: 8.2
});

function positiveModulo(value, divisor) {
  if (!Number.isFinite(divisor) || divisor === 0) {
    return 0;
  }

  return ((value % divisor) + divisor) % divisor;
}

function clampNumber(value, min, max) {
  if (min > max) {
    return (min + max) / 2;
  }

  return Math.min(max, Math.max(min, value));
}

function normalizeRenderWidgetRequest(optionsOrId, cols, rows, renderer) {
  if (optionsOrId && typeof optionsOrId === "object" && !Array.isArray(optionsOrId)) {
    return { ...optionsOrId };
  }

  return {
    cols,
    id: optionsOrId,
    rows,
    renderer
  };
}

function normalizeRuntimeWidgetIdList(values) {
  const rawValues = Array.isArray(values) ? values : typeof values === "string" && values ? [values] : [];
  return [...new Set(rawValues.map((value) => String(value ?? "").trim()).filter(Boolean).map((value) => normalizeWidgetId(value)))];
}

function hasExplicitWidgetPosition(options = {}) {
  return (
    options.position !== undefined ||
    options.col !== undefined ||
    options.row !== undefined
  );
}

function mergeWidgetOrder(prioritizedWidgetIds, existingWidgetIds) {
  const merged = [];
  const seen = new Set();

  [...prioritizedWidgetIds, ...existingWidgetIds].forEach((widgetId) => {
    if (!widgetId || seen.has(widgetId)) {
      return;
    }

    seen.add(widgetId);
    merged.push(widgetId);
  });

  return merged;
}

function normalizeWidgetLayoutEntries(entries) {
  const normalizedEntries = [];
  const entryMap = new Map();

  (Array.isArray(entries) ? entries : []).forEach((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return;
    }

    const rawWidgetId = String(entry.widgetId ?? entry.id ?? "").trim();

    if (!rawWidgetId) {
      return;
    }

    const widgetId = normalizeWidgetId(rawWidgetId);
    const positionSource = entry.position && typeof entry.position === "object" && !Array.isArray(entry.position) ? entry.position : entry;
    const sizeSource = entry.size && typeof entry.size === "object" && !Array.isArray(entry.size) ? entry.size : entry;
    const normalizedEntry = {
      id: widgetId
    };

    if (positionSource.col !== undefined || positionSource.row !== undefined) {
      normalizedEntry.position = normalizeWidgetPosition(
        {
          col: positionSource.col,
          row: positionSource.row
        },
        DEFAULT_WIDGET_POSITION
      );
    }

    if (sizeSource.cols !== undefined || sizeSource.rows !== undefined) {
      normalizedEntry.size = normalizeWidgetSize(
        {
          cols: sizeSource.cols,
          rows: sizeSource.rows
        },
        DEFAULT_WIDGET_SIZE
      );
    }

    if (entryMap.has(widgetId)) {
      entryMap.delete(widgetId);
    }

    entryMap.set(widgetId, normalizedEntry);
  });

  entryMap.forEach((entry) => {
    normalizedEntries.push(entry);
  });

  return normalizedEntries;
}

function assertSpaceOwnsWidgets(spaceRecord, widgetIds, actionLabel = "update widgets") {
  const missingWidgetIds = widgetIds.filter((widgetId) => !spaceRecord?.widgetIds?.includes(widgetId));

  if (!missingWidgetIds.length) {
    return;
  }

  throw new Error(`Cannot ${actionLabel}: widget ids not found in space "${spaceRecord?.id || ""}": ${missingWidgetIds.join(", ")}.`);
}

async function rearrangePersistedSpaceWidgets(options = {}) {
  const targetSpaceId = normalizeOptionalSpaceId(options.spaceId ?? options.id);

  if (!targetSpaceId) {
    throw new Error("A target spaceId is required to rearrange widgets.");
  }

  const currentSpace = await readSpace(targetSpaceId);
  const widgetEntries = normalizeWidgetLayoutEntries(options.widgets ?? options.widgetLayouts);

  if (!widgetEntries.length) {
    return currentSpace;
  }

  const widgetIds = widgetEntries.map((entry) => entry.id);
  assertSpaceOwnsWidgets(currentSpace, widgetIds, "rearrange widgets");

  const widgetPositions = { ...currentSpace.widgetPositions };
  const widgetSizes = { ...currentSpace.widgetSizes };
  widgetEntries.forEach((entry) => {
    if (entry.position) {
      widgetPositions[entry.id] = entry.position;
    }

    if (entry.size) {
      widgetSizes[entry.id] = entry.size;
    }
  });

  return saveSpaceLayout({
    id: targetSpaceId,
    minimizedWidgetIds: currentSpace.minimizedWidgetIds,
    widgetIds: mergeWidgetOrder(widgetIds, currentSpace.widgetIds),
    widgetPositions,
    widgetSizes
  });
}

async function togglePersistedSpaceWidgets(options = {}) {
  const targetSpaceId = normalizeOptionalSpaceId(options.spaceId ?? options.id);

  if (!targetSpaceId) {
    throw new Error("A target spaceId is required to toggle widgets.");
  }

  const currentSpace = await readSpace(targetSpaceId);
  const widgetIds = normalizeRuntimeWidgetIdList(options.widgetIds ?? options.widgets);

  if (!widgetIds.length) {
    return currentSpace;
  }

  assertSpaceOwnsWidgets(currentSpace, widgetIds, "toggle widgets");
  const nextMinimizedWidgetIds = new Set(currentSpace.minimizedWidgetIds);
  widgetIds.forEach((widgetId) => {
    if (nextMinimizedWidgetIds.has(widgetId)) {
      nextMinimizedWidgetIds.delete(widgetId);
      return;
    }

    nextMinimizedWidgetIds.add(widgetId);
  });

  return saveSpaceLayout({
    id: targetSpaceId,
    minimizedWidgetIds: [...nextMinimizedWidgetIds]
  });
}

function ensureSpacesRuntimeNamespace() {
  const runtime = globalThis.space;

  if (!runtime) {
    throw new Error("Space runtime is not available.");
  }

  const previousNamespace = runtime.spaces && typeof runtime.spaces === "object" ? runtime.spaces : {};
  const namespace = {
    ...previousNamespace,
    all: Array.isArray(previousNamespace.all) ? [...previousNamespace.all] : [],
    byId: previousNamespace.byId && typeof previousNamespace.byId === "object" ? { ...previousNamespace.byId } : {},
    createSpace: async (options = {}) => {
      const createdSpace = await createSpace(options);

      if (options.open !== false && globalThis.space.router) {
        await namespace.openSpace(createdSpace.id, {
          replace: options.replace !== false
        });
      }

      if (activeSpacesStore) {
        await activeSpacesStore.handleExternalMutation(createdSpace.id);
      }

      return createdSpace;
    },
    createWidgetSource,
    current: previousNamespace.current || null,
    currentId: String(previousNamespace.currentId || ""),
    defineWidget,
    getCurrentSpace() {
      return globalThis.space?.current || null;
    },
    items: Array.isArray(previousNamespace.items) ? [...previousNamespace.items] : [],
    listSpaces,
    openSpace(spaceId, options = {}) {
      const normalizedSpaceId = normalizeOptionalSpaceId(spaceId);

      if (!normalizedSpaceId) {
        throw new Error("A valid spaceId is required.");
      }

      if (!globalThis.space.router) {
        throw new Error("Router runtime is not available.");
      }

      return options.replace
        ? globalThis.space.router.replaceTo(SPACES_ROUTE_PATH, { params: { id: normalizedSpaceId } })
        : globalThis.space.router.goTo(SPACES_ROUTE_PATH, { params: { id: normalizedSpaceId } });
    },
    readSpace,
    rearrangeWidgets: async (options = {}) => {
      const targetSpaceId = options.spaceId || activeSpacesStore?.currentSpaceId;

      if (!targetSpaceId) {
        throw new Error("A target spaceId is required to rearrange widgets.");
      }

      const savedSpace = await rearrangePersistedSpaceWidgets({
        ...options,
        spaceId: targetSpaceId
      });

      if (activeSpacesStore) {
        await activeSpacesStore.handleExternalMutation(targetSpaceId);
      }

      return savedSpace;
    },
    renderWidget: async (optionsOrId, cols, rows, renderer) => {
      const request = normalizeRenderWidgetRequest(optionsOrId, cols, rows, renderer);
      const targetSpaceId = request.spaceId || activeSpacesStore?.currentSpaceId;

      if (!targetSpaceId) {
        throw new Error("A target spaceId is required to render a widget.");
      }

      const result = await upsertWidget({
        ...(await applyAutoWidgetPlacementToRequest(request, targetSpaceId)),
        name: request.name ?? request.title,
        spaceId: targetSpaceId,
        widgetId: request.widgetId ?? request.id
      });

      if (activeSpacesStore) {
        await activeSpacesStore.handleExternalMutation(targetSpaceId);
      }

      return result;
    },
    repairLayout: async (spaceIdOrOptions = undefined) => {
      const requestedSpaceId =
        typeof spaceIdOrOptions === "string"
          ? spaceIdOrOptions
          : spaceIdOrOptions && typeof spaceIdOrOptions === "object"
            ? spaceIdOrOptions.spaceId ?? spaceIdOrOptions.id ?? activeSpacesStore?.currentSpaceId
            : activeSpacesStore?.currentSpaceId;
      const targetSpaceId = normalizeOptionalSpaceId(requestedSpaceId);

      if (!targetSpaceId) {
        throw new Error("A target spaceId is required to repair a layout.");
      }

      const currentSpace = await readSpace(targetSpaceId);
      const savedSpace = await saveSpaceLayout({
        id: targetSpaceId,
        minimizedWidgetIds: currentSpace.minimizedWidgetIds,
        widgetIds: currentSpace.widgetIds,
        widgetPositions: currentSpace.widgetPositions,
        widgetSizes: currentSpace.widgetSizes
      });

      if (activeSpacesStore) {
        await activeSpacesStore.handleExternalMutation(targetSpaceId);
      }

      return savedSpace;
    },
    reloadCurrentSpace: async () => {
      if (!activeSpacesStore) {
        throw new Error("The spaces view is not currently mounted.");
      }

      await activeSpacesStore.reloadCurrentSpace();
      return activeSpacesStore.currentSpace;
    },
    reloadWidget: async (widgetIdOrOptions = {}) => {
      if (!activeSpacesStore) {
        throw new Error("The spaces view is not currently mounted.");
      }

      const requestedWidgetId =
        typeof widgetIdOrOptions === "string"
          ? widgetIdOrOptions
          : widgetIdOrOptions && typeof widgetIdOrOptions === "object"
            ? widgetIdOrOptions.widgetId ?? widgetIdOrOptions.id
            : "";
      const targetWidgetId = String(requestedWidgetId || "").trim() ? normalizeWidgetId(requestedWidgetId) : "";
      const targetSpaceId =
        typeof widgetIdOrOptions === "object" && widgetIdOrOptions && !Array.isArray(widgetIdOrOptions)
          ? normalizeOptionalSpaceId(widgetIdOrOptions.spaceId ?? activeSpacesStore.currentSpaceId)
          : activeSpacesStore.currentSpaceId;

      if (!targetWidgetId) {
        throw new Error("A widgetId is required to reload a widget.");
      }

      if (!targetSpaceId || targetSpaceId !== activeSpacesStore.currentSpaceId) {
        throw new Error("Widget reload is only available for the currently open space.");
      }

      await activeSpacesStore.reloadWidget(targetWidgetId);
      return activeSpacesStore.currentSpace;
    },
    removeSpace: async (spaceIdOrOptions = undefined) => {
      const requestedSpaceId =
        typeof spaceIdOrOptions === "string"
          ? spaceIdOrOptions
          : spaceIdOrOptions && typeof spaceIdOrOptions === "object"
            ? spaceIdOrOptions.spaceId ?? spaceIdOrOptions.id ?? activeSpacesStore?.currentSpaceId
            : activeSpacesStore?.currentSpaceId;
      const targetSpaceId = normalizeOptionalSpaceId(requestedSpaceId);

      if (!targetSpaceId) {
        throw new Error("A target spaceId is required to remove a space.");
      }

      const result = await removeSpace({
        ...(spaceIdOrOptions && typeof spaceIdOrOptions === "object" ? spaceIdOrOptions : {}),
        spaceId: targetSpaceId
      });

      if (activeSpacesStore) {
        await activeSpacesStore.handleRemovedSpace(targetSpaceId);
      }

      return result;
    },
    removeWidget: async (options = {}) => {
      const targetSpaceId = options.spaceId || activeSpacesStore?.currentSpaceId;

      if (!targetSpaceId) {
        throw new Error("A target spaceId is required to remove a widget.");
      }

      const result = await removeWidget({
        ...options,
        spaceId: targetSpaceId
      });

      if (activeSpacesStore) {
        await activeSpacesStore.handleExternalMutation(targetSpaceId);
      }

      return result;
    },
    removeWidgets: async (options = {}) => {
      const targetSpaceId = options.spaceId || activeSpacesStore?.currentSpaceId;

      if (!targetSpaceId) {
        throw new Error("A target spaceId is required to remove widgets.");
      }

      const result = await removeWidgetsFromStorage({
        ...options,
        spaceId: targetSpaceId
      });

      if (activeSpacesStore) {
        await activeSpacesStore.handleExternalMutation(targetSpaceId);
      }

      return result;
    },
    removeAllWidgets: async (spaceIdOrOptions = undefined) => {
      const requestedSpaceId =
        typeof spaceIdOrOptions === "string"
          ? spaceIdOrOptions
          : spaceIdOrOptions && typeof spaceIdOrOptions === "object"
            ? spaceIdOrOptions.spaceId ?? spaceIdOrOptions.id ?? activeSpacesStore?.currentSpaceId
            : activeSpacesStore?.currentSpaceId;
      const targetSpaceId = normalizeOptionalSpaceId(requestedSpaceId);

      if (!targetSpaceId) {
        throw new Error("A target spaceId is required to remove all widgets.");
      }

      const currentSpace = await readSpace(targetSpaceId);
      const result =
        currentSpace.widgetIds.length > 0
          ? await removeWidgetsFromStorage({
              spaceId: targetSpaceId,
              widgetIds: currentSpace.widgetIds
            })
          : {
              space: currentSpace,
              widgetIds: []
            };

      if (activeSpacesStore) {
        await activeSpacesStore.handleExternalMutation(targetSpaceId);
      }

      return result;
    },
    resolveAppUrl,
    saveSpaceLayout: async (options = {}) => {
      const savedSpace = await saveSpaceLayout(options);

      if (activeSpacesStore) {
        await activeSpacesStore.handleExternalMutation(savedSpace.id);
      }

      return savedSpace;
    },
    saveSpaceMeta: async (options = {}) => {
      const savedSpace = await saveSpaceMeta(options);

      if (activeSpacesStore) {
        await activeSpacesStore.handleExternalMutation(savedSpace.id);
      }

      return savedSpace;
    },
    sizeToToken,
    toggleWidgets: async (options = {}) => {
      const targetSpaceId = options.spaceId || activeSpacesStore?.currentSpaceId;

      if (!targetSpaceId) {
        throw new Error("A target spaceId is required to toggle widgets.");
      }

      const savedSpace = await togglePersistedSpaceWidgets({
        ...options,
        spaceId: targetSpaceId
      });

      if (activeSpacesStore) {
        await activeSpacesStore.handleExternalMutation(targetSpaceId);
      }

      return savedSpace;
    },
    upsertWidget: async (options = {}) => {
      const targetSpaceId = options.spaceId || activeSpacesStore?.currentSpaceId;

      if (!targetSpaceId) {
        throw new Error("A target spaceId is required to save a widget.");
      }

      const result = await upsertWidget({
        ...(await applyAutoWidgetPlacementToRequest(options, targetSpaceId)),
        spaceId: targetSpaceId
      });

      if (activeSpacesStore) {
        await activeSpacesStore.handleExternalMutation(targetSpaceId);
      }

      return result;
    },
    widgetApiVersion: WIDGET_API_VERSION
  };

  runtime.spaces = namespace;
  return namespace;
}

const spacesRuntime = ensureSpacesRuntimeNamespace();

function createElement(tagName, className = "", textContent = "") {
  const element = document.createElement(tagName);

  if (className) {
    element.className = className;
  }

  if (textContent) {
    element.textContent = textContent;
  }

  return element;
}

function formatErrorMessage(error, fallback) {
  const message = String(error?.message || "").trim();
  return message || fallback;
}

function logSpacesError(context, error, details = undefined) {
  if (details === undefined) {
    console.error(`[spaces] ${context}`, error);
    return;
  }

  console.error(`[spaces] ${context}`, details, error);
}

function normalizeOptionalSpaceId(value) {
  const rawValue = String(value ?? "").trim();
  return rawValue ? normalizeSpaceId(rawValue) : "";
}

function formatTitleFromId(id) {
  return String(id || "")
    .split(/[-_]+/u)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

function isTruthyRouteParam(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function getWidgetRecord(spaceRecord, widgetId) {
  return spaceRecord?.widgets?.[widgetId] || null;
}

function getWidgetDefaultPosition(spaceRecord, widgetId) {
  return normalizeWidgetPosition(getWidgetRecord(spaceRecord, widgetId)?.defaultPosition, DEFAULT_WIDGET_POSITION);
}

function getWidgetDefaultSize(spaceRecord, widgetId) {
  return normalizeWidgetSize(getWidgetRecord(spaceRecord, widgetId)?.defaultSize, DEFAULT_WIDGET_SIZE);
}

function getEffectiveWidgetSize(spaceRecord, widgetId) {
  return normalizeWidgetSize(spaceRecord?.widgetSizes?.[widgetId] || getWidgetDefaultSize(spaceRecord, widgetId), DEFAULT_WIDGET_SIZE);
}

function buildResolvedLayoutInputs(spaceRecord, overrides = {}) {
  const widgetIds = (Array.isArray(overrides.widgetIds) ? overrides.widgetIds : spaceRecord?.widgetIds || []).filter((widgetId) =>
    Boolean(getWidgetRecord(spaceRecord, widgetId))
  );
  const widgetPositions = {};
  const widgetSizes = {};

  widgetIds.forEach((widgetId) => {
    widgetPositions[widgetId] = normalizeWidgetPosition(
      overrides.widgetPositions?.[widgetId] ?? spaceRecord?.widgetPositions?.[widgetId] ?? getWidgetDefaultPosition(spaceRecord, widgetId),
      getWidgetDefaultPosition(spaceRecord, widgetId)
    );
    widgetSizes[widgetId] = normalizeWidgetSize(
      overrides.widgetSizes?.[widgetId] ?? spaceRecord?.widgetSizes?.[widgetId] ?? getWidgetDefaultSize(spaceRecord, widgetId),
      getWidgetDefaultSize(spaceRecord, widgetId)
    );
  });

  return {
    minimizedWidgetIds:
      overrides.minimizedWidgetIds ??
      (Array.isArray(spaceRecord?.minimizedWidgetIds) ? [...spaceRecord.minimizedWidgetIds] : []),
    widgetIds,
    widgetPositions,
    widgetSizes
  };
}

function buildRuntimeWidgetDescriptor(spaceRecord, resolvedLayout, widgetId) {
  const widgetRecord = getWidgetRecord(spaceRecord, widgetId);

  if (!widgetRecord) {
    return null;
  }

  const effectiveSize = getEffectiveWidgetSize(spaceRecord, widgetId);
  const position = normalizeWidgetPosition(
    resolvedLayout?.positions?.[widgetId] ?? getWidgetDefaultPosition(spaceRecord, widgetId),
    getWidgetDefaultPosition(spaceRecord, widgetId)
  );
  const renderedSize = normalizeWidgetSize(
    resolvedLayout?.renderedSizes?.[widgetId] ?? effectiveSize,
    effectiveSize
  );
  const minimized = Boolean(resolvedLayout?.minimizedMap?.[widgetId] ?? spaceRecord?.minimizedWidgetIds?.includes(widgetId));

  return {
    col: position.col,
    cols: renderedSize.cols,
    id: widgetId,
    minimized,
    name: widgetRecord.name || formatTitleFromId(widgetId),
    path: buildSpaceWidgetFilePath(spaceRecord.id, widgetId),
    position,
    renderer: widgetRecord.rendererSource,
    renderedSize,
    row: position.row,
    rows: renderedSize.rows,
    size: effectiveSize,
    state: minimized ? "minimized" : "expanded"
  };
}

async function applyAutoWidgetPlacementToRequest(request = {}, targetSpaceId = "") {
  if (!targetSpaceId || hasExplicitWidgetPosition(request)) {
    return request;
  }

  const widgetPreview = previewWidgetRecord({
    ...request,
    name: request.name ?? request.title,
    widgetId: request.widgetId ?? request.id
  });
  const viewportCols = resolveViewportCols();
  let targetSpace = null;
  let resolvedLayout = null;

  if (activeSpacesStore?.currentSpaceId === targetSpaceId && activeSpacesStore.currentSpace) {
    targetSpace = activeSpacesStore.currentSpace;
    resolvedLayout = activeSpacesStore.currentResolvedLayout || activeSpacesStore.resolveCurrentSpaceLayout(targetSpace);
  } else {
    targetSpace = await readSpace(targetSpaceId);
    resolvedLayout = resolveSpaceLayout(buildResolvedLayoutInputs(targetSpace));
  }

  if (!targetSpace || targetSpace.widgetIds.includes(widgetPreview.id)) {
    return request;
  }

  const suggestedPosition = findFirstFitWidgetPlacement({
    existingWidgetPositions: resolvedLayout?.positions || {},
    existingWidgetSizes: resolvedLayout?.renderedSizes || {},
    viewportCols,
    widgetSize: widgetPreview.defaultSize
  });

  return {
    ...request,
    col: suggestedPosition.col,
    position: suggestedPosition,
    row: suggestedPosition.row
  };
}

function createCurrentSpaceRuntime(namespace) {
  const currentSpace = activeSpacesStore?.currentSpace;

  if (!currentSpace) {
    return null;
  }

  return {
    get byId() {
      return Object.fromEntries(this.widgets.map((widget) => [widget.id, widget]));
    },
    get id() {
      return activeSpacesStore?.currentSpace?.id || "";
    },
    get path() {
      return activeSpacesStore?.currentSpace ? buildSpaceRootPath(activeSpacesStore.currentSpace.id) : "";
    },
    get title() {
      return activeSpacesStore?.currentSpace?.title || "";
    },
    get updatedAt() {
      return activeSpacesStore?.currentSpace?.updatedAt || "";
    },
    get widgets() {
      const nextSpace = activeSpacesStore?.currentSpace;
      const resolvedLayout = activeSpacesStore?.currentResolvedLayout;

      if (!nextSpace) {
        return [];
      }

      return nextSpace.widgetIds
        .map((widgetId) => buildRuntimeWidgetDescriptor(nextSpace, resolvedLayout, widgetId))
        .filter(Boolean);
    },
    reload() {
      return namespace.reloadCurrentSpace();
    },
    reloadWidget(widgetId) {
      return namespace.reloadWidget({
        spaceId: activeSpacesStore?.currentSpaceId,
        widgetId
      });
    },
    removeWidget(widgetId) {
      return namespace.removeWidget({
        spaceId: activeSpacesStore?.currentSpaceId,
        widgetId
      });
    },
    removeWidgets(widgetIds) {
      return namespace.removeWidgets({
        spaceId: activeSpacesStore?.currentSpaceId,
        widgetIds
      });
    },
    removeAllWidgets() {
      return namespace.removeAllWidgets({
        spaceId: activeSpacesStore?.currentSpaceId
      });
    },
    renderWidget(optionsOrId, cols, rows, renderer) {
      return namespace.renderWidget({
        ...normalizeRenderWidgetRequest(optionsOrId, cols, rows, renderer),
        spaceId: activeSpacesStore?.currentSpaceId
      });
    },
    rearrangeWidgets(widgets) {
      return namespace.rearrangeWidgets({
        spaceId: activeSpacesStore?.currentSpaceId,
        widgets
      });
    },
    repairLayout() {
      return namespace.repairLayout({
        spaceId: activeSpacesStore?.currentSpaceId
      });
    },
    rearrange() {
      if (!activeSpacesStore) {
        throw new Error("The spaces view is not currently mounted.");
      }

      return activeSpacesStore.rearrangeCurrentSpace();
    },
    saveLayout(options = {}) {
      return namespace.saveSpaceLayout({
        ...options,
        id: activeSpacesStore?.currentSpaceId
      });
    },
    saveMeta(options = {}) {
      return namespace.saveSpaceMeta({
        ...options,
        id: activeSpacesStore?.currentSpaceId
      });
    },
    toggleWidgets(widgetIds) {
      return namespace.toggleWidgets({
        spaceId: activeSpacesStore?.currentSpaceId,
        widgetIds
      });
    }
  };
}

function syncSpacesRuntimeState() {
  const runtime = globalThis.space;

  if (!runtime?.spaces) {
    return;
  }

  const items = Array.isArray(activeSpacesStore?.spaceList)
    ? activeSpacesStore.spaceList.map((entry) => ({ ...entry }))
    : Array.isArray(runtime.spaces.items)
      ? runtime.spaces.items.map((entry) => ({ ...entry }))
      : [];
  const byId = Object.fromEntries(items.map((entry) => [entry.id, { ...entry }]));
  const current = createCurrentSpaceRuntime(runtime.spaces);

  runtime.spaces.items = items;
  runtime.spaces.all = items;
  runtime.spaces.byId = byId;
  runtime.spaces.current = current;
  runtime.spaces.currentId = current?.id || "";
  runtime.current = current;
}

function createWidgetPlaceholder(textValue) {
  const root = createElement("div", "spaces-widget-placeholder");
  root.appendChild(createElement("p", "spaces-widget-placeholder-copy", textValue));
  return root;
}

function createGridStateCard(titleValue, bodyValue, tone = "info") {
  const root = createElement("section", `spaces-grid-state is-${tone}`);
  root.appendChild(createElement("h2", "spaces-grid-state-title", titleValue));
  root.appendChild(createElement("p", "spaces-grid-state-copy", bodyValue));
  return root;
}

function createEmptyCanvasState() {
  const examplePrompts = [
    "What's the weather here?",
    "Make me a Tetris game",
    "Flip the space upside down slowly",
    "What's the Bitcoin and ETH price?"
  ];
  const root = createElement("section", "spaces-empty-canvas");
  const content = createElement("div", "spaces-empty-canvas-content");
  const title = createElement("h2", "spaces-empty-canvas-title");
  const firstLine = createElement("span", "spaces-empty-canvas-line", "Just an empty space here,");
  const secondLine = createElement("span", "spaces-empty-canvas-line", "tell the Space Agent what to do...");
  const examples = createElement("div", "spaces-empty-canvas-examples");

  title.append(firstLine, secondLine);
  examplePrompts.forEach((promptText) => {
    const button = createElement("button", "spaces-empty-canvas-example", promptText);
    button.type = "button";
    button.addEventListener("click", async () => {
      button.disabled = true;

      try {
        if (!globalThis.space?.onscreenAgent?.submitPrompt) {
          throw new Error("space.onscreenAgent.submitPrompt(...) is not available.");
        }

        await globalThis.space.onscreenAgent.submitPrompt(promptText);
      } catch (error) {
        logSpacesError("empty canvas example click failed", error, {
          promptText
        });
      } finally {
        button.disabled = false;
      }
    });
    examples.appendChild(button);
  });

  content.append(title, examples);
  root.appendChild(content);

  return { root, title };
}

function applyFloatingTitlePose(element, x, y, rotation) {
  if (!element) {
    return;
  }

  element.style.setProperty("--spaces-empty-title-float-x", `${x.toFixed(1)}px`);
  element.style.setProperty("--spaces-empty-title-float-y", `${y.toFixed(1)}px`);
  element.style.setProperty("--spaces-empty-title-rotate", `${rotation.toFixed(1)}deg`);
}

function startFloatingTitleAnimation(element, motionQuery = null) {
  if (!element) {
    return () => {};
  }

  let frame = 0;
  let startTime = 0;

  const resetPose = () => {
    applyFloatingTitlePose(element, 0, 0, 0);
  };

  const step = (timestamp) => {
    if (!element.isConnected) {
      frame = 0;
      return;
    }

    if (motionQuery?.matches) {
      frame = 0;
      startTime = 0;
      resetPose();
      return;
    }

    if (!startTime) {
      startTime = timestamp;
    }

    const elapsed = timestamp - startTime;
    const orbitAngle = ((elapsed / EMPTY_SPACE_FLOAT_PROFILE.orbitPeriodMs) * TAU) + 0.45;
    const rotationAngle = ((elapsed / EMPTY_SPACE_FLOAT_PROFILE.rotationPeriodMs) * TAU) + 1.1;

    applyFloatingTitlePose(
      element,
      Math.cos(orbitAngle) * EMPTY_SPACE_FLOAT_PROFILE.xRadius,
      Math.sin(orbitAngle) * EMPTY_SPACE_FLOAT_PROFILE.yRadius,
      Math.sin(rotationAngle) * EMPTY_SPACE_FLOAT_PROFILE.rotationAmplitude
    );

    frame = window.requestAnimationFrame(step);
  };

  const start = () => {
    window.cancelAnimationFrame(frame);
    frame = 0;
    startTime = 0;
    resetPose();

    if (!element.isConnected || motionQuery?.matches) {
      return;
    }

    frame = window.requestAnimationFrame(step);
  };

  const handleMotionPreferenceChange = () => {
    start();
  };

  if (motionQuery) {
    if (typeof motionQuery.addEventListener === "function") {
      motionQuery.addEventListener("change", handleMotionPreferenceChange);
    } else if (typeof motionQuery.addListener === "function") {
      motionQuery.addListener(handleMotionPreferenceChange);
    }
  }

  start();

  return () => {
    window.cancelAnimationFrame(frame);
    frame = 0;

    if (motionQuery) {
      if (typeof motionQuery.removeEventListener === "function") {
        motionQuery.removeEventListener("change", handleMotionPreferenceChange);
      } else if (typeof motionQuery.removeListener === "function") {
        motionQuery.removeListener(handleMotionPreferenceChange);
      }
    }

    resetPose();
  };
}

function playGridFadeIn(gridElement, motionQuery = null) {
  if (!gridElement || motionQuery?.matches) {
    return () => {};
  }

  const cleanup = () => {
    gridElement.classList.remove("is-render-fading");
    gridElement.removeEventListener("animationend", cleanup);
  };

  gridElement.removeEventListener("animationend", cleanup);
  gridElement.classList.remove("is-render-fading");
  void gridElement.offsetWidth;
  gridElement.classList.add("is-render-fading");
  gridElement.addEventListener("animationend", cleanup, { once: true });

  return () => {
    gridElement.classList.remove("is-render-fading");
    gridElement.removeEventListener("animationend", cleanup);
  };
}

function applyWidgetCardSize(cardElement, size) {
  cardElement.style.setProperty("--spaces-widget-cols", String(size.cols));
  cardElement.style.setProperty("--spaces-widget-rows", String(size.rows));
}

function normalizeCanvasBounds(bounds) {
  const minCol = Number.isFinite(bounds?.minCol) ? Math.floor(bounds.minCol) : -GRID_BASE_HALF_COLS;
  const maxCol = Number.isFinite(bounds?.maxCol) ? Math.ceil(bounds.maxCol) : GRID_BASE_HALF_COLS;
  const minRow = Number.isFinite(bounds?.minRow) ? Math.floor(bounds.minRow) : -GRID_BASE_HALF_ROWS;
  const maxRow = Number.isFinite(bounds?.maxRow) ? Math.ceil(bounds.maxRow) : GRID_BASE_HALF_ROWS;

  return {
    colCount: Math.max(1, maxCol - minCol),
    maxCol,
    maxRow,
    minCol,
    minRow,
    rowCount: Math.max(1, maxRow - minRow)
  };
}

function createLogicalRect(position, size) {
  const normalizedPosition = normalizeWidgetPosition(position, DEFAULT_WIDGET_POSITION);
  const normalizedSize = normalizeWidgetSize(size, DEFAULT_WIDGET_SIZE);

  return {
    bottom: normalizedPosition.row + normalizedSize.rows,
    left: normalizedPosition.col,
    right: normalizedPosition.col + normalizedSize.cols,
    top: normalizedPosition.row
  };
}

function parsePixelValue(value, fallback = 0) {
  const parsedValue = Number.parseFloat(String(value || "").trim());
  return Number.isFinite(parsedValue) ? parsedValue : fallback;
}

function resolveCssLength(value, contextElement, fallback = 0) {
  const normalizedValue = String(value || "").trim();

  if (!normalizedValue) {
    return fallback;
  }

  if (/^-?\d+(\.\d+)?$/u.test(normalizedValue)) {
    return Number.parseFloat(normalizedValue);
  }

  if (/^-?\d+(\.\d+)?px$/u.test(normalizedValue)) {
    return Number.parseFloat(normalizedValue);
  }

  if (/^-?\d+(\.\d+)?rem$/u.test(normalizedValue)) {
    const rootFontSize = parsePixelValue(window.getComputedStyle(document.documentElement).fontSize, 16);
    return Number.parseFloat(normalizedValue) * rootFontSize;
  }

  if (/^-?\d+(\.\d+)?em$/u.test(normalizedValue)) {
    const elementFontSize = parsePixelValue(window.getComputedStyle(contextElement).fontSize, 16);
    return Number.parseFloat(normalizedValue) * elementFontSize;
  }

  const probe = document.createElement("div");
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  probe.style.inlineSize = normalizedValue;
  probe.style.blockSize = "0";
  probe.style.pointerEvents = "none";
  contextElement.appendChild(probe);
  const width = probe.getBoundingClientRect().width;
  probe.remove();

  return Number.isFinite(width) && width > 0 ? width : fallback;
}

function resolveElementLineHeight(element) {
  const contextElement = element instanceof Element ? element : document.documentElement;
  const computedStyle = window.getComputedStyle(contextElement);
  const explicitLineHeight = parsePixelValue(computedStyle.lineHeight, 0);

  if (explicitLineHeight > 0) {
    return explicitLineHeight;
  }

  const probe = document.createElement("span");
  probe.textContent = "A\nB";
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  probe.style.pointerEvents = "none";
  probe.style.whiteSpace = "pre";
  probe.style.margin = "0";
  probe.style.padding = "0";
  probe.style.border = "0";
  probe.style.font = computedStyle.font;
  probe.style.lineHeight = computedStyle.lineHeight;
  contextElement.appendChild(probe);
  const measuredLineHeight = probe.getBoundingClientRect().height / 2;
  probe.remove();

  return measuredLineHeight > 0 ? measuredLineHeight : parsePixelValue(computedStyle.fontSize, 16);
}

function resolveWheelDeltaPixels(event, contextElement, viewportElement) {
  const viewportWidth = Math.max(1, viewportElement?.clientWidth || window.innerWidth || 1);
  const viewportHeight = Math.max(1, viewportElement?.clientHeight || window.innerHeight || 1);

  if (event.deltaMode === 1) {
    const lineHeight = resolveElementLineHeight(contextElement);
    return {
      x: event.deltaX * lineHeight,
      y: event.deltaY * lineHeight
    };
  }

  if (event.deltaMode === 2) {
    return {
      x: event.deltaX * viewportWidth,
      y: event.deltaY * viewportHeight
    };
  }

  return {
    x: event.deltaX,
    y: event.deltaY
  };
}

function getPrimaryWheelAxis(deltaX, deltaY) {
  if (Math.abs(deltaX) > Math.abs(deltaY)) {
    return "x";
  }

  return "y";
}

function canElementScrollInDirection(element, axis, delta) {
  if (!(element instanceof HTMLElement) || Math.abs(delta) < 0.01) {
    return false;
  }

  const computedStyle = window.getComputedStyle(element);
  const overflowValue = axis === "x" ? computedStyle.overflowX : computedStyle.overflowY;

  if (!/(auto|scroll|overlay)/u.test(overflowValue)) {
    return false;
  }

  if (axis === "x") {
    const maxScrollLeft = element.scrollWidth - element.clientWidth;

    if (maxScrollLeft <= 1) {
      return false;
    }

    return delta < 0
      ? element.scrollLeft > 0
      : element.scrollLeft < (maxScrollLeft - 1);
  }

  const maxScrollTop = element.scrollHeight - element.clientHeight;

  if (maxScrollTop <= 1) {
    return false;
  }

  return delta < 0
    ? element.scrollTop > 0
    : element.scrollTop < (maxScrollTop - 1);
}

function shouldAllowNativeWheelScroll(target, boundaryElement, deltaX, deltaY) {
  if (!(target instanceof Element)) {
    return false;
  }

  const primaryAxis = getPrimaryWheelAxis(deltaX, deltaY);
  const secondaryAxis = primaryAxis === "x" ? "y" : "x";
  const primaryDelta = primaryAxis === "x" ? deltaX : deltaY;
  const secondaryDelta = secondaryAxis === "x" ? deltaX : deltaY;
  let element = target;

  while (element && element !== boundaryElement) {
    if (
      canElementScrollInDirection(element, primaryAxis, primaryDelta) ||
      canElementScrollInDirection(element, secondaryAxis, secondaryDelta)
    ) {
      return true;
    }

    element = element.parentElement;
  }

  return false;
}

function readGridMetrics(gridElement) {
  const computedStyle = window.getComputedStyle(gridElement);
  const columnGap = resolveCssLength(computedStyle.getPropertyValue("--spaces-grid-gap"), gridElement, 16);
  const rowGap = columnGap;
  const rowHeight = resolveCssLength(computedStyle.getPropertyValue("--spaces-grid-row-height"), gridElement, 74);
  const rect = gridElement.getBoundingClientRect();
  const canvasElement = activeSpacesStore?.refs?.canvas || gridElement.parentElement;
  const viewportWidth = Math.max(1, canvasElement?.clientWidth || rect.width);
  const viewportHeight = Math.max(1, canvasElement?.clientHeight || rect.height);
  const paddingLeft = parsePixelValue(computedStyle.paddingLeft, 20);
  const paddingRight = parsePixelValue(computedStyle.paddingRight, 20);
  const paddingTop = parsePixelValue(computedStyle.paddingTop, 20);
  const paddingBottom = parsePixelValue(computedStyle.paddingBottom, 20);
  const colWidth = rowHeight;

  return {
    colStep: colWidth + columnGap,
    columnGap,
    colWidth,
    paddingBlock: Math.max(paddingTop, paddingBottom),
    paddingInline: Math.max(paddingLeft, paddingRight),
    rect,
    rowGap,
    rowHeight,
    rowStep: rowHeight + rowGap,
    viewportHeight,
    viewportWidth
  };
}

function resolveViewportCols(gridElement = activeSpacesStore?.refs?.grid) {
  if (gridElement) {
    const metrics = readGridMetrics(gridElement);

    if (metrics.colStep > 0) {
      return Math.max(1, Math.floor(metrics.viewportWidth / metrics.colStep));
    }
  }

  return Math.max(1, Math.floor((window.innerWidth || 1) / 90));
}

function resolveCanvasBounds(resolvedLayout, metrics) {
  const bounds = {
    maxCol: GRID_BASE_HALF_COLS,
    maxRow: GRID_BASE_HALF_ROWS,
    minCol: -GRID_BASE_HALF_COLS,
    minRow: -GRID_BASE_HALF_ROWS
  };

  Object.entries(resolvedLayout?.positions || {}).forEach(([widgetId, position]) => {
    const renderedSize =
      resolvedLayout?.renderedSizes?.[widgetId] || getRenderedWidgetSize(DEFAULT_WIDGET_SIZE, Boolean(resolvedLayout?.minimizedMap?.[widgetId]));
    const rect = createLogicalRect(position, renderedSize);

    bounds.minCol = Math.min(bounds.minCol, rect.left - GRID_CONTENT_BUFFER_COLS);
    bounds.maxCol = Math.max(bounds.maxCol, rect.right + GRID_CONTENT_BUFFER_COLS);
    bounds.minRow = Math.min(bounds.minRow, rect.top - GRID_CONTENT_BUFFER_ROWS);
    bounds.maxRow = Math.max(bounds.maxRow, rect.bottom + GRID_CONTENT_BUFFER_ROWS);
  });

  const viewportCols = Math.max(1, Math.ceil(metrics.viewportWidth / Math.max(metrics.colStep, 1)));
  const viewportRows = Math.max(1, Math.ceil(metrics.viewportHeight / Math.max(metrics.rowStep, 1)));
  bounds.minCol = Math.min(bounds.minCol, -Math.ceil(viewportCols / 2) - GRID_CONTENT_BUFFER_COLS);
  bounds.maxCol = Math.max(bounds.maxCol, Math.ceil(viewportCols / 2) + GRID_CONTENT_BUFFER_COLS);
  bounds.minRow = Math.min(bounds.minRow, -Math.ceil(viewportRows / 2) - GRID_CONTENT_BUFFER_ROWS);
  bounds.maxRow = Math.max(bounds.maxRow, Math.ceil(viewportRows / 2) + GRID_CONTENT_BUFFER_ROWS);

  return normalizeCanvasBounds(bounds);
}

function getCanvasExtent(count, unitSize, gap, padding) {
  return (padding * 2) + (count * unitSize) + (Math.max(0, count - 1) * gap);
}

function applyGridSurfaceLayout(gridElement, bounds, metrics) {
  gridElement.style.width = `${metrics.viewportWidth}px`;
  gridElement.style.height = `${metrics.viewportHeight}px`;
}

function resolveLogicalContentBounds(resolvedLayout) {
  const bounds = {
    maxCol: 0,
    maxRow: 0,
    minCol: 0,
    minRow: 0
  };
  let hasContent = false;

  Object.entries(resolvedLayout?.positions || {}).forEach(([widgetId, position]) => {
    const renderedSize =
      resolvedLayout?.renderedSizes?.[widgetId] || getRenderedWidgetSize(DEFAULT_WIDGET_SIZE, Boolean(resolvedLayout?.minimizedMap?.[widgetId]));
    const rect = createLogicalRect(position, renderedSize);

    if (!hasContent) {
      bounds.minCol = rect.left;
      bounds.maxCol = rect.right;
      bounds.minRow = rect.top;
      bounds.maxRow = rect.bottom;
      hasContent = true;
      return;
    }

    bounds.minCol = Math.min(bounds.minCol, rect.left);
    bounds.maxCol = Math.max(bounds.maxCol, rect.right);
    bounds.minRow = Math.min(bounds.minRow, rect.top);
    bounds.maxRow = Math.max(bounds.maxRow, rect.bottom);
  });

  return hasContent ? bounds : null;
}

function clampCameraOffsetToContent(cameraOffset, resolvedLayout, metrics) {
  const contentBounds = resolveLogicalContentBounds(resolvedLayout);

  if (!contentBounds) {
    return {
      x: 0,
      y: 0
    };
  }

  const visibleHalfCols = metrics.viewportWidth / (2 * Math.max(metrics.colStep, 1));
  const visibleHalfRows = metrics.viewportHeight / (2 * Math.max(metrics.rowStep, 1));
  const minCenterCol = (contentBounds.minCol - GRID_CAMERA_BUFFER_COLS) + visibleHalfCols;
  const maxCenterCol = (contentBounds.maxCol + GRID_CAMERA_BUFFER_COLS) - visibleHalfCols;
  const minCenterRow = (contentBounds.minRow - GRID_CAMERA_BUFFER_ROWS) + visibleHalfRows;
  const maxCenterRow = (contentBounds.maxRow + GRID_CAMERA_BUFFER_ROWS) - visibleHalfRows;
  const currentCenterCol = -cameraOffset.x / Math.max(metrics.colStep, 1);
  const currentCenterRow = -cameraOffset.y / Math.max(metrics.rowStep, 1);
  const clampedCenterCol = clampNumber(currentCenterCol, minCenterCol, maxCenterCol);
  const clampedCenterRow = clampNumber(currentCenterRow, minCenterRow, maxCenterRow);

  return {
    x: -clampedCenterCol * metrics.colStep,
    y: -clampedCenterRow * metrics.rowStep
  };
}

function getWidgetCardFrame(position, size, bounds, metrics) {
  const normalizedPosition = normalizeWidgetPosition(position, DEFAULT_WIDGET_POSITION);
  const normalizedSize = normalizeWidgetSize(size, DEFAULT_WIDGET_SIZE);
  const cameraOffset = activeSpacesStore?.cameraOffsetPx || { x: 0, y: 0 };
  const originX = (metrics.viewportWidth / 2) + cameraOffset.x;
  const originY = (metrics.viewportHeight / 2) + cameraOffset.y;

  return {
    height: (normalizedSize.rows * metrics.rowHeight) + (Math.max(0, normalizedSize.rows - 1) * metrics.rowGap),
    left: originX + (normalizedPosition.col * metrics.colStep),
    top: originY + (normalizedPosition.row * metrics.rowStep),
    width: (normalizedSize.cols * metrics.colWidth) + (Math.max(0, normalizedSize.cols - 1) * metrics.columnGap)
  };
}

function applyWidgetCardFrame(cardElement, frame) {
  cardElement.style.left = `${frame.left}px`;
  cardElement.style.top = `${frame.top}px`;
  cardElement.style.width = `${frame.width}px`;
  cardElement.style.height = `${frame.height}px`;
}

function applyWidgetCardLayout(cardElement, position, size, bounds, metrics) {
  const normalizedSize = normalizeWidgetSize(size, DEFAULT_WIDGET_SIZE);
  applyWidgetCardSize(cardElement, normalizedSize);
  applyWidgetCardFrame(cardElement, getWidgetCardFrame(position, normalizedSize, bounds, metrics));
}

function captureWidgetCardRects(widgetCards) {
  const rects = {};

  Object.entries(widgetCards || {}).forEach(([widgetId, skeleton]) => {
    if (!skeleton?.card?.isConnected) {
      return;
    }

    rects[widgetId] = skeleton.card.getBoundingClientRect();
  });

  return rects;
}

function animateWidgetCardsFromRects(widgetCards, previousRects, motionQuery = null, options = {}) {
  const animateEntering = Boolean(options.animateEntering);

  if ((!previousRects && !animateEntering) || motionQuery?.matches) {
    return;
  }

  Object.entries(widgetCards || {}).forEach(([widgetId, skeleton]) => {
    const previousRect = previousRects?.[widgetId];
    const cardElement = skeleton?.card;

    if (!cardElement?.isConnected) {
      return;
    }

    if (!previousRect) {
      if (!animateEntering) {
        cardElement.style.removeProperty("transition");
        cardElement.style.removeProperty("transform");
        cardElement.style.removeProperty("opacity");
        return;
      }

      cardElement.style.transition = "none";
      cardElement.style.transformOrigin = "center center";
      cardElement.style.opacity = "0";
      cardElement.style.transform = "translateY(10px) scale(0.96)";
      void cardElement.offsetWidth;
      cardElement.style.transition = "transform 220ms cubic-bezier(0.22, 1, 0.36, 1), opacity 180ms ease";
      cardElement.style.opacity = "1";
      cardElement.style.transform = "";

      const cleanup = () => {
        cardElement.style.removeProperty("transition");
        cardElement.style.removeProperty("opacity");
        cardElement.removeEventListener("transitionend", cleanup);
      };

      cardElement.addEventListener("transitionend", cleanup, { once: true });
      return;
    }

    const nextRect = cardElement.getBoundingClientRect();
    const deltaX = previousRect.left - nextRect.left;
    const deltaY = previousRect.top - nextRect.top;
    const scaleX = nextRect.width > 0 ? previousRect.width / nextRect.width : 1;
    const scaleY = nextRect.height > 0 ? previousRect.height / nextRect.height : 1;
    const hasMotion =
      Math.abs(deltaX) > 0.5 ||
      Math.abs(deltaY) > 0.5 ||
      Math.abs(scaleX - 1) > 0.02 ||
      Math.abs(scaleY - 1) > 0.02;

    if (!hasMotion) {
      cardElement.style.removeProperty("transition");
      cardElement.style.removeProperty("transform");
      cardElement.style.removeProperty("opacity");
      return;
    }

    cardElement.style.transition = "none";
    cardElement.style.transformOrigin = "top left";
    cardElement.style.transform = `translate(${deltaX}px, ${deltaY}px) scale(${scaleX}, ${scaleY})`;
    void cardElement.offsetWidth;
    cardElement.style.transition = "transform 220ms cubic-bezier(0.22, 1, 0.36, 1)";
    cardElement.style.transform = "";

    const cleanup = () => {
      cardElement.style.removeProperty("transition");
      cardElement.style.removeProperty("opacity");
      cardElement.removeEventListener("transitionend", cleanup);
    };

    cardElement.addEventListener("transitionend", cleanup, { once: true });
  });
}

function updateCanvasScrollForBoundsChange(canvasElement, previousBounds, nextBounds, metrics) {
  return;
}

function getOriginScrollPosition(bounds, metrics) {
  return {
    left: 0,
    top: 0
  };
}

function autoScrollCanvas(canvasElement, event) {
  activeSpacesStore?.nudgeCameraAtViewportEdge(event);
}

function toggleGridOverlay(gridElement, active, metrics = null, cameraOffset = { x: 0, y: 0 }) {
  if (!gridElement) {
    return;
  }

  gridElement.classList.toggle("is-layout-active", Boolean(active));

  if (!active || !metrics) {
    gridElement.style.removeProperty("--spaces-grid-overlay-col-step");
    gridElement.style.removeProperty("--spaces-grid-overlay-row-step");
    gridElement.style.removeProperty("--spaces-grid-overlay-offset-x");
    gridElement.style.removeProperty("--spaces-grid-overlay-offset-y");
    return;
  }

  const offsetX = positiveModulo((metrics.viewportWidth / 2) + cameraOffset.x, metrics.colStep);
  const offsetY = positiveModulo((metrics.viewportHeight / 2) + cameraOffset.y, metrics.rowStep);
  gridElement.style.setProperty("--spaces-grid-overlay-col-step", `${metrics.colStep}px`);
  gridElement.style.setProperty("--spaces-grid-overlay-row-step", `${metrics.rowStep}px`);
  gridElement.style.setProperty("--spaces-grid-overlay-offset-x", `${offsetX}px`);
  gridElement.style.setProperty("--spaces-grid-overlay-offset-y", `${offsetY}px`);
}

function shouldShowGridOverlay(layoutInteraction) {
  return layoutInteraction?.type === "move" || layoutInteraction?.type === "resize";
}

function createWidgetActionButton(className, label, title) {
  const button = createElement("button", className, label);
  button.type = "button";
  button.title = title;
  button.setAttribute("aria-label", title);
  return button;
}

function getSpaceCardClone(spaceRecord) {
  return {
    ...spaceRecord,
    minimizedWidgetIds: [...spaceRecord.minimizedWidgetIds],
    widgetIds: [...spaceRecord.widgetIds],
    widgetPositions: { ...spaceRecord.widgetPositions },
    widgetSizes: { ...spaceRecord.widgetSizes },
    widgets: Object.fromEntries(
      Object.entries(spaceRecord.widgets || {}).map(([widgetId, widgetRecord]) => [widgetId, { ...widgetRecord }])
    )
  };
}

function buildWidgetHeaderTitle(spaceRecord, widgetId) {
  return getWidgetRecord(spaceRecord, widgetId)?.name || formatTitleFromId(widgetId);
}

function createWidgetContext(spaceRecord, widgetId, size, layoutEntry) {
  const widgetPath = buildSpaceWidgetFilePath(spaceRecord.id, widgetId);
  const widgetRecord = getWidgetRecord(spaceRecord, widgetId);

  return {
    api: globalThis.space.api,
    appFiles: {
      delete: globalThis.space.api.fileDelete.bind(globalThis.space.api),
      info: globalThis.space.api.fileInfo.bind(globalThis.space.api),
      list: globalThis.space.api.fileList.bind(globalThis.space.api),
      read: globalThis.space.api.fileRead.bind(globalThis.space.api),
      write: globalThis.space.api.fileWrite.bind(globalThis.space.api)
    },
    fetchExternal: globalThis.space.fetchExternal?.bind(globalThis.space),
    openSpace: spacesRuntime.openSpace,
    paths: {
      assets: `${buildSpaceRootPath(spaceRecord.id)}assets/`,
      data: `${buildSpaceRootPath(spaceRecord.id)}data/`,
      root: buildSpaceRootPath(spaceRecord.id),
      widget: widgetPath
    },
    reloadSpace: spacesRuntime.reloadCurrentSpace,
    resolveAppUrl,
    router: globalThis.space.router,
    size,
    space: {
      id: spaceRecord.id,
      path: buildSpaceRootPath(spaceRecord.id),
      title: spaceRecord.title,
      updatedAt: spaceRecord.updatedAt
    },
    spaces: globalThis.space.spaces,
    widget: {
      defaultPosition: getWidgetDefaultPosition(spaceRecord, widgetId),
      defaultSize: getWidgetDefaultSize(spaceRecord, widgetId),
      id: widgetId,
      minimized: Boolean(layoutEntry?.minimized),
      name: widgetRecord?.name || formatTitleFromId(widgetId),
      path: widgetPath,
      position: normalizeWidgetPosition(layoutEntry?.position, DEFAULT_WIDGET_POSITION),
      size,
      title: buildWidgetHeaderTitle(spaceRecord, widgetId)
    }
  };
}

function createWidgetCardSkeleton(spaceRecord, widgetId, layoutEntry) {
  const card = createElement("article", "space-card spaces-widget-card");
  const controls = createElement("div", "spaces-widget-card-controls");
  const reloadButton = createWidgetActionButton("spaces-widget-control-button spaces-widget-reload-button", "", "Reload widget");
  const handle = createWidgetActionButton("spaces-widget-drag-handle", "", "Move widget");
  const titleLabel = createElement("span", "spaces-widget-card-title", buildWidgetHeaderTitle(spaceRecord, widgetId));
  const actions = createElement("div", "spaces-widget-card-actions");
  const minimizeButton = createWidgetActionButton(
    "spaces-widget-control-button",
    layoutEntry?.minimized ? "+" : "-",
    layoutEntry?.minimized ? "Restore widget" : "Minimize widget"
  );
  const closeButton = createWidgetActionButton("spaces-widget-control-button", "", "Remove widget");
  const body = createElement("div", "spaces-widget-card-body");
  const resizeHandle = createWidgetActionButton("spaces-widget-resize-handle", "", "Resize widget");
  const reloadIcon = createElement("x-icon", "", "refresh");
  const closeIcon = createElement("x-icon", "", "close");

  reloadButton.appendChild(reloadIcon);
  closeButton.appendChild(closeIcon);
  handle.append(titleLabel);
  card.dataset.widgetId = widgetId;
  body.appendChild(createWidgetPlaceholder("Loading widget..."));
  controls.append(handle, reloadButton, actions);
  actions.append(minimizeButton, closeButton);
  card.append(controls, body, resizeHandle);

  handle.addEventListener("pointerdown", (event) => {
    activeSpacesStore?.beginWidgetMove(event, widgetId);
  });
  reloadButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    void activeSpacesStore?.reloadWidget(widgetId);
  });
  resizeHandle.addEventListener("pointerdown", (event) => {
    activeSpacesStore?.beginWidgetResize(event, widgetId);
  });
  minimizeButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    void activeSpacesStore?.toggleWidgetMinimized(widgetId);
  });
  closeButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    void activeSpacesStore?.closeWidget(widgetId);
  });

  return { body, card, cleanup: null, minimizeButton, reloadButton, titleLabel };
}

function runWidgetCleanup(skeleton) {
  if (typeof skeleton?.cleanup !== "function") {
    skeleton.cleanup = null;
    return;
  }

  try {
    skeleton.cleanup();
  } catch (error) {
    logSpacesError("widget cleanup failed", error, {
      widgetId: skeleton.card?.dataset?.widgetId
    });
  } finally {
    skeleton.cleanup = null;
  }
}

function cleanupWidgetCards(widgetCards) {
  Object.values(widgetCards || {}).forEach((skeleton) => {
    runWidgetCleanup(skeleton);
  });
}

function tryCompileRendererMethod(rendererSource) {
  const methodObject = Function(`return ({ ${rendererSource} });`)();

  if (typeof methodObject?.renderer === "function") {
    return methodObject.renderer;
  }

  const functionValues = Object.values(methodObject || {}).filter((value) => typeof value === "function");

  if (functionValues.length === 1) {
    return functionValues[0];
  }

  return null;
}

function compileWidgetRenderer(widgetRecord, widgetId) {
  const rendererSource = normalizeRendererSource(widgetRecord?.rendererSource || "");

  if (!rendererSource) {
    throw new Error(`Widget "${widgetId}" is missing a renderer function.`);
  }

  let compiledRenderer = null;

  try {
    compiledRenderer = Function(`return (${rendererSource});`)();
  } catch (directCompileError) {
    try {
      compiledRenderer = tryCompileRendererMethod(rendererSource);
    } catch {
      throw directCompileError;
    }

    if (!compiledRenderer) {
      throw directCompileError;
    }
  }

  if (typeof compiledRenderer !== "function") {
    throw new Error(`Widget "${widgetId}" renderer must evaluate to a function.`);
  }

  return compiledRenderer;
}

async function renderWidgetCard(spaceRecord, widgetId, skeleton, loadToken, layoutEntry) {
  const widgetRecord = getWidgetRecord(spaceRecord, widgetId);

  if (!widgetRecord) {
    throw new Error(`Widget "${widgetId}" could not be found.`);
  }

  const storedSize = getEffectiveWidgetSize(spaceRecord, widgetId);
  const size = layoutEntry?.renderedSize || getRenderedWidgetSize(storedSize, Boolean(layoutEntry?.minimized));
  const context = createWidgetContext(spaceRecord, widgetId, size, layoutEntry);
  const renderer = compileWidgetRenderer(widgetRecord, widgetId);

  skeleton.card.classList.toggle("is-minimized", Boolean(layoutEntry?.minimized));
  skeleton.minimizeButton.textContent = layoutEntry?.minimized ? "+" : "-";
  skeleton.minimizeButton.title = layoutEntry?.minimized ? "Restore widget" : "Minimize widget";
  skeleton.minimizeButton.setAttribute("aria-label", skeleton.minimizeButton.title);
  skeleton.titleLabel.textContent = buildWidgetHeaderTitle(spaceRecord, widgetId);
  runWidgetCleanup(skeleton);
  skeleton.body.replaceChildren();

  const rendered = await renderer(skeleton.body, globalThis.space, context);

  if (loadToken !== activeSpacesStore?.widgetLoadToken) {
    if (typeof rendered === "function") {
      rendered();
      return;
    }

    if (rendered && typeof rendered === "object" && !Array.isArray(rendered) && typeof rendered.cleanup === "function") {
      rendered.cleanup();
    }

    return;
  }

  if (typeof rendered === "function") {
    skeleton.cleanup = rendered;
    return;
  }

  if (rendered && typeof rendered === "object" && !Array.isArray(rendered) && typeof rendered.cleanup === "function") {
    skeleton.cleanup = rendered.cleanup;

    if (rendered.output !== undefined) {
      renderWidgetOutput(rendered.output, skeleton.body);
    }

    return;
  }

  if (rendered !== undefined) {
    renderWidgetOutput(rendered, skeleton.body);
  }
}

const spacesModel = {
  cameraOffsetPx: {
    x: 0,
    y: 0
  },
  creatingSpace: false,
  currentCanvasBounds: null,
  currentSpace: null,
  currentSpaceId: "",
  currentResolvedLayout: null,
  currentSpaceTitleDraft: "",
  emptyCanvasCleanup: null,
  hasCenteredCurrentSpace: false,
  layoutInteraction: null,
  layoutPersistPromise: Promise.resolve(),
  layoutPointerMoveHandler: null,
  layoutPointerUpHandler: null,
  loaded: false,
  loadingList: false,
  loadingSpace: false,
  motionQuery: null,
  noticeText: "",
  noticeTone: "info",
  canvasPointerDownHandler: null,
  canvasWheelHandler: null,
  renderFadeCleanup: null,
  refs: {},
  savingTitle: false,
  spaceList: [],
  viewportResizeHandler: null,
  widgetCards: {},
  widgetErrorCount: 0,
  widgetLoadToken: 0,

  mount(refs = {}) {
    this.refs = refs;
    this.motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    this.viewportResizeHandler = () => {
      this.handleViewportResize();
    };
    window.addEventListener("resize", this.viewportResizeHandler);
    this.canvasPointerDownHandler = (event) => {
      this.handleCanvasPointerDown(event);
    };
    this.refs.canvas?.addEventListener("pointerdown", this.canvasPointerDownHandler);
    this.canvasWheelHandler = (event) => {
      this.handleCanvasWheel(event);
    };
    this.refs.canvas?.addEventListener("wheel", this.canvasWheelHandler, { passive: false });
    activeSpacesStore = this;
    syncSpacesRuntimeState();
    void this.refreshFromRoute();
  },

  unmount() {
    this.cleanupEmptyCanvas();
    this.cleanupRenderFade();
    this.cleanupLayoutInteraction({
      restoreLayout: false
    });
    cleanupWidgetCards(this.widgetCards);

    if (activeSpacesStore === this) {
      activeSpacesStore = null;
    }

    this.widgetLoadToken += 1;
    this.cameraOffsetPx = {
      x: 0,
      y: 0
    };
    this.currentCanvasBounds = null;
    this.currentResolvedLayout = null;
    this.currentSpace = null;
    this.refs.grid?.replaceChildren();
    this.motionQuery = null;
    this.hasCenteredCurrentSpace = false;

    if (this.viewportResizeHandler) {
      window.removeEventListener("resize", this.viewportResizeHandler);
      this.viewportResizeHandler = null;
    }

    if (this.canvasPointerDownHandler && this.refs.canvas) {
      this.refs.canvas.removeEventListener("pointerdown", this.canvasPointerDownHandler);
      this.canvasPointerDownHandler = null;
    }

    if (this.canvasWheelHandler && this.refs.canvas) {
      this.refs.canvas.removeEventListener("wheel", this.canvasWheelHandler);
      this.canvasWheelHandler = null;
    }

    this.widgetCards = {};
    this.refs = {};
    this.renderFadeCleanup = null;
    syncSpacesRuntimeState();
  },

  get hasCurrentSpace() {
    return Boolean(this.currentSpace);
  },

  get hasSpaces() {
    return this.spaceList.length > 0;
  },

  get isBusy() {
    return this.loadingList || this.loadingSpace || this.creatingSpace || this.savingTitle;
  },

  get currentSpaceFolderPath() {
    return this.currentSpace ? buildSpaceRootPath(this.currentSpace.id) : "";
  },

  get currentSpaceUpdatedLabel() {
    return this.currentSpace?.updatedAt ? new Date(this.currentSpace.updatedAt).toLocaleString() : "";
  },

  get currentSpaceWidgetCountLabel() {
    const count = this.currentSpace?.widgetIds?.length || 0;
    return `${count} ${count === 1 ? "widget" : "widgets"}`;
  },

  get canSaveTitle() {
    const nextTitle = String(this.currentSpaceTitleDraft || "").trim();
    return Boolean(this.currentSpace && nextTitle && nextTitle !== this.currentSpace.title && !this.savingTitle);
  },

  setNotice(textValue, tone = "info") {
    this.noticeText = String(textValue || "").trim();
    this.noticeTone = tone === "error" ? "error" : "info";
  },

  clearNotice() {
    this.noticeText = "";
    this.noticeTone = "info";
  },

  cleanupRenderFade() {
    if (typeof this.renderFadeCleanup === "function") {
      this.renderFadeCleanup();
    }

    this.renderFadeCleanup = null;
  },

  cleanupEmptyCanvas() {
    if (typeof this.emptyCanvasCleanup === "function") {
      this.emptyCanvasCleanup();
    }

    this.emptyCanvasCleanup = null;
  },

  resolveCurrentSpaceLayout(spaceRecord = this.currentSpace, overrides = {}) {
    if (!spaceRecord) {
      return null;
    }

    const layoutInputs = buildResolvedLayoutInputs(spaceRecord, {
      minimizedWidgetIds: overrides.minimizedWidgetIds,
      widgetIds: overrides.widgetIds,
      widgetPositions: overrides.widgetPositions,
      widgetSizes: overrides.widgetSizes
    });

    return resolveSpaceLayout({
      anchorMinimized: overrides.anchorMinimized,
      anchorPosition: overrides.anchorPosition,
      anchorSize: overrides.anchorSize,
      anchorWidgetId: overrides.anchorWidgetId,
      minimizedWidgetIds: layoutInputs.minimizedWidgetIds,
      widgetIds: layoutInputs.widgetIds,
      widgetPositions: layoutInputs.widgetPositions,
      widgetSizes: layoutInputs.widgetSizes
    });
  },

  centerCanvasOnOrigin(force = false) {
    if (!this.refs.grid) {
      return;
    }

    if (this.hasCenteredCurrentSpace && !force && this.cameraOffsetPx.x === 0 && this.cameraOffsetPx.y === 0) {
      return;
    }

    this.cameraOffsetPx = {
      x: 0,
      y: 0
    };
    this.hasCenteredCurrentSpace = true;
  },

  applyResolvedLayoutToCards(resolvedLayout, spaceRecord = this.currentSpace, options = {}) {
    if (!resolvedLayout || !spaceRecord || !this.refs.grid) {
      return;
    }

    const metrics = readGridMetrics(this.refs.grid);
    const previousRects = options.previousRects || null;

    if (options.centerOrigin) {
      this.centerCanvasOnOrigin(true);
    }

    this.cameraOffsetPx = clampCameraOffsetToContent(this.cameraOffsetPx, resolvedLayout, metrics);

    applyGridSurfaceLayout(this.refs.grid, null, metrics);
    this.currentResolvedLayout = resolvedLayout;
    this.currentCanvasBounds = null;
    spaceRecord.widgetPositions = { ...resolvedLayout.positions };
    spaceRecord.minimizedWidgetIds = spaceRecord.widgetIds.filter((widgetId) => resolvedLayout.minimizedMap[widgetId]);

    spaceRecord.widgetIds.forEach((widgetId) => {
      const skeleton = this.widgetCards[widgetId];

      if (!skeleton) {
        return;
      }

      const renderedSize = resolvedLayout.renderedSizes[widgetId] || getRenderedWidgetSize(getEffectiveWidgetSize(spaceRecord, widgetId));
      applyWidgetCardLayout(skeleton.card, resolvedLayout.positions[widgetId], renderedSize, null, metrics);
      skeleton.card.classList.toggle("is-minimized", Boolean(resolvedLayout.minimizedMap[widgetId]));
      skeleton.minimizeButton.textContent = resolvedLayout.minimizedMap[widgetId] ? "+" : "-";
      skeleton.minimizeButton.title = resolvedLayout.minimizedMap[widgetId] ? "Restore widget" : "Minimize widget";
      skeleton.minimizeButton.setAttribute("aria-label", skeleton.minimizeButton.title);
      skeleton.card.style.removeProperty("transition");
      skeleton.card.style.removeProperty("transform");
    });

    if (!options.skipAnimation) {
      animateWidgetCardsFromRects(this.widgetCards, previousRects, this.motionQuery, {
        animateEntering: options.animateEntering
      });
    }

    toggleGridOverlay(this.refs.grid, shouldShowGridOverlay(this.layoutInteraction), metrics, this.cameraOffsetPx);
    syncSpacesRuntimeState();
  },

  cleanupLayoutInteraction(options = {}) {
    const interaction = this.layoutInteraction;

    if (this.layoutPointerMoveHandler) {
      window.removeEventListener("pointermove", this.layoutPointerMoveHandler);
      this.layoutPointerMoveHandler = null;
    }

    if (this.layoutPointerUpHandler) {
      window.removeEventListener("pointerup", this.layoutPointerUpHandler);
      window.removeEventListener("pointercancel", this.layoutPointerUpHandler);
      this.layoutPointerUpHandler = null;
    }

    toggleGridOverlay(this.refs.grid, false);
    this.refs.canvas?.classList.remove("is-panning");

    if (interaction?.widgetId && this.widgetCards[interaction.widgetId]) {
      this.widgetCards[interaction.widgetId].card.classList.remove("is-layout-active");

      if (options.clearPreview !== false) {
        this.widgetCards[interaction.widgetId].card.style.removeProperty("transform");
      }
    }

    this.layoutInteraction = null;

    if (options.restoreLayout !== false && this.currentResolvedLayout && this.currentSpace) {
      this.applyResolvedLayoutToCards(this.currentResolvedLayout, this.currentSpace);
    }
  },

  handleCanvasPointerDown(event) {
    if (event.button !== 0 || !this.currentSpace?.widgetIds?.length) {
      return;
    }

    if (event.target?.closest(".spaces-widget-card, .spaces-empty-canvas-example, .spaces-canvas-debug-button")) {
      return;
    }

    if (event.target !== this.refs.canvas && event.target !== this.refs.grid) {
      return;
    }

    this.beginCanvasPan(event);
  },

  panCameraByPixels(deltaX, deltaY, options = {}) {
    if (!this.currentResolvedLayout || !this.currentSpace || !this.refs.grid) {
      return false;
    }

    if (Math.abs(deltaX) < 0.01 && Math.abs(deltaY) < 0.01) {
      return false;
    }

    const metrics = readGridMetrics(this.refs.grid);
    const nextCameraOffset = clampCameraOffsetToContent(
      {
        x: this.cameraOffsetPx.x + deltaX,
        y: this.cameraOffsetPx.y + deltaY
      },
      this.currentResolvedLayout,
      metrics
    );
    const changed =
      Math.abs(nextCameraOffset.x - this.cameraOffsetPx.x) > 0.01 ||
      Math.abs(nextCameraOffset.y - this.cameraOffsetPx.y) > 0.01;

    this.cameraOffsetPx = nextCameraOffset;

    if (changed || options.forceRender) {
      this.applyResolvedLayoutToCards(this.currentResolvedLayout, this.currentSpace, {
        skipAnimation: true
      });
    }

    return changed;
  },

  handleCanvasWheel(event) {
    if (!this.currentSpace?.widgetIds?.length || !this.refs.canvas || !this.refs.grid) {
      return;
    }

    if (event.ctrlKey || this.layoutInteraction) {
      return;
    }

    const delta = resolveWheelDeltaPixels(event, this.refs.canvas, this.refs.canvas);

    if (shouldAllowNativeWheelScroll(event.target, this.refs.canvas, delta.x, delta.y)) {
      return;
    }

    event.preventDefault();
    this.panCameraByPixels(-delta.x, -delta.y, {
      forceRender: true
    });
  },

  beginCanvasPan(event) {
    if (!this.refs.canvas || !this.refs.grid) {
      return;
    }

    event.preventDefault();
    this.cleanupLayoutInteraction();

    this.refs.canvas.classList.add("is-panning");

    this.layoutInteraction = {
      pointerId: event.pointerId,
      startCameraOffset: { ...this.cameraOffsetPx },
      startX: event.clientX,
      startY: event.clientY,
      type: "pan"
    };

    this.layoutPointerMoveHandler = (nextEvent) => {
      this.handleLayoutPointerMove(nextEvent);
    };
    this.layoutPointerUpHandler = (nextEvent) => {
      void this.handleLayoutPointerUp(nextEvent);
    };
    window.addEventListener("pointermove", this.layoutPointerMoveHandler);
    window.addEventListener("pointerup", this.layoutPointerUpHandler);
    window.addEventListener("pointercancel", this.layoutPointerUpHandler);
  },

  nudgeCameraAtViewportEdge(event) {
    if (!this.refs.canvas || !this.refs.grid) {
      return;
    }

    const rect = this.refs.canvas.getBoundingClientRect();
    const computeDelta = (distancePastEdge) => {
      const ratio = Math.min(1, Math.max(0, distancePastEdge / GRID_EDGE_SCROLL_THRESHOLD));
      return Math.max(0, Math.round(ratio * ratio * GRID_EDGE_SCROLL_SPEED));
    };
    let deltaX = 0;
    let deltaY = 0;

    if (event.clientX < rect.left + GRID_EDGE_SCROLL_THRESHOLD) {
      deltaX = computeDelta(rect.left + GRID_EDGE_SCROLL_THRESHOLD - event.clientX);
    } else if (event.clientX > rect.right - GRID_EDGE_SCROLL_THRESHOLD) {
      deltaX = -computeDelta(event.clientX - (rect.right - GRID_EDGE_SCROLL_THRESHOLD));
    }

    if (event.clientY < rect.top + GRID_EDGE_SCROLL_THRESHOLD) {
      deltaY = computeDelta(rect.top + GRID_EDGE_SCROLL_THRESHOLD - event.clientY);
    } else if (event.clientY > rect.bottom - GRID_EDGE_SCROLL_THRESHOLD) {
      deltaY = -computeDelta(event.clientY - (rect.bottom - GRID_EDGE_SCROLL_THRESHOLD));
    }

    if (!deltaX && !deltaY) {
      return;
    }
    this.panCameraByPixels(deltaX, deltaY);
  },

  handleViewportResize() {
    if (!this.currentResolvedLayout || !this.currentSpace || !this.refs.grid) {
      return;
    }

    this.applyResolvedLayoutToCards(this.currentResolvedLayout, this.currentSpace, {
      skipAnimation: true
    });
  },

  beginWidgetMove(event, widgetId) {
    if (event.button !== 0 || !this.currentSpace || !this.refs.grid) {
      return;
    }

    const resolvedLayout = this.currentResolvedLayout || this.resolveCurrentSpaceLayout();
    const layoutPosition = resolvedLayout?.positions?.[widgetId];
    const layoutSize = resolvedLayout?.renderedSizes?.[widgetId];

    if (!layoutPosition || !layoutSize) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    this.cleanupLayoutInteraction();

    const gridMetrics = readGridMetrics(this.refs.grid);
    const skeleton = this.widgetCards[widgetId];

    if (!skeleton) {
      return;
    }

    skeleton.card.classList.add("is-layout-active");
    skeleton.card.style.removeProperty("transition");
    toggleGridOverlay(this.refs.grid, true, gridMetrics, this.cameraOffsetPx);

    this.layoutInteraction = {
      gridMetrics,
      originPosition: layoutPosition,
      pointerId: event.pointerId,
      previewPosition: layoutPosition,
      renderedSize: layoutSize,
      startCameraOffset: { ...this.cameraOffsetPx },
      startX: event.clientX,
      startY: event.clientY,
      type: "move",
      widgetId
    };

    this.layoutPointerMoveHandler = (nextEvent) => {
      this.handleLayoutPointerMove(nextEvent);
    };
    this.layoutPointerUpHandler = (nextEvent) => {
      void this.handleLayoutPointerUp(nextEvent);
    };
    window.addEventListener("pointermove", this.layoutPointerMoveHandler);
    window.addEventListener("pointerup", this.layoutPointerUpHandler);
    window.addEventListener("pointercancel", this.layoutPointerUpHandler);
  },

  beginWidgetResize(event, widgetId) {
    if (event.button !== 0 || !this.currentSpace || !this.refs.grid || this.currentSpace.minimizedWidgetIds.includes(widgetId)) {
      return;
    }

    const resolvedLayout = this.currentResolvedLayout || this.resolveCurrentSpaceLayout();
    const layoutPosition = resolvedLayout?.positions?.[widgetId];
    const storedSize = getEffectiveWidgetSize(this.currentSpace, widgetId);

    if (!layoutPosition || !storedSize) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    this.cleanupLayoutInteraction();

    const gridMetrics = readGridMetrics(this.refs.grid);
    const skeleton = this.widgetCards[widgetId];

    if (!skeleton) {
      return;
    }

    skeleton.card.classList.add("is-layout-active");
    skeleton.card.style.removeProperty("transition");
    toggleGridOverlay(this.refs.grid, true, gridMetrics, this.cameraOffsetPx);

    const originFrame = getWidgetCardFrame(layoutPosition, storedSize, this.currentCanvasBounds, gridMetrics);

    this.layoutInteraction = {
      gridMetrics,
      originFrame,
      originPosition: layoutPosition,
      originSize: normalizeWidgetSize(storedSize, DEFAULT_WIDGET_SIZE),
      pointerId: event.pointerId,
      previewSize: normalizeWidgetSize(storedSize, DEFAULT_WIDGET_SIZE),
      startCameraOffset: { ...this.cameraOffsetPx },
      startX: event.clientX,
      startY: event.clientY,
      type: "resize",
      widgetId
    };

    this.layoutPointerMoveHandler = (nextEvent) => {
      this.handleLayoutPointerMove(nextEvent);
    };
    this.layoutPointerUpHandler = (nextEvent) => {
      void this.handleLayoutPointerUp(nextEvent);
    };
    window.addEventListener("pointermove", this.layoutPointerMoveHandler);
    window.addEventListener("pointerup", this.layoutPointerUpHandler);
    window.addEventListener("pointercancel", this.layoutPointerUpHandler);
  },

  handleLayoutPointerMove(event) {
    const interaction = this.layoutInteraction;

    if (!interaction || event.pointerId !== interaction.pointerId) {
      return;
    }

    event.preventDefault();

    if (interaction.type === "pan") {
      this.panCameraByPixels(
        (interaction.startCameraOffset.x + (event.clientX - interaction.startX)) - this.cameraOffsetPx.x,
        (interaction.startCameraOffset.y + (event.clientY - interaction.startY)) - this.cameraOffsetPx.y
      );
      return;
    }

    autoScrollCanvas(this.refs.canvas, event);
    const skeleton = this.widgetCards[interaction.widgetId];

    if (!skeleton) {
      return;
    }

    const cameraDeltaX = this.cameraOffsetPx.x - interaction.startCameraOffset.x;
    const cameraDeltaY = this.cameraOffsetPx.y - interaction.startCameraOffset.y;
    const deltaX = (event.clientX - interaction.startX) - cameraDeltaX;
    const deltaY = (event.clientY - interaction.startY) - cameraDeltaY;

    if (interaction.type === "move") {
      const previewPosition = clampWidgetPosition(
        {
          col: interaction.originPosition.col + Math.round(deltaX / Math.max(interaction.gridMetrics.colStep, 1)),
          row: interaction.originPosition.row + Math.round(deltaY / Math.max(interaction.gridMetrics.rowStep, 1))
        },
        interaction.renderedSize
      );

      interaction.previewPosition = previewPosition;
      skeleton.card.style.transform = `translate(${deltaX}px, ${deltaY}px)`;
      return;
    }

    const minWidth = interaction.gridMetrics.colWidth;
    const minHeight = interaction.gridMetrics.rowHeight;
    const maxWidth = (MAX_WIDGET_COLS * interaction.gridMetrics.colWidth) + (Math.max(0, MAX_WIDGET_COLS - 1) * interaction.gridMetrics.columnGap);
    const maxHeight = (MAX_WIDGET_ROWS * interaction.gridMetrics.rowHeight) + (Math.max(0, MAX_WIDGET_ROWS - 1) * interaction.gridMetrics.rowGap);
    const previewWidth = Math.min(maxWidth, Math.max(minWidth, interaction.originFrame.width + deltaX));
    const previewHeight = Math.min(maxHeight, Math.max(minHeight, interaction.originFrame.height + deltaY));
    const previewSize = normalizeWidgetSize(
      {
        cols: Math.min(MAX_WIDGET_COLS, Math.max(1, Math.round((previewWidth + interaction.gridMetrics.columnGap) / Math.max(interaction.gridMetrics.colStep, 1)))),
        rows: Math.min(MAX_WIDGET_ROWS, Math.max(1, Math.round((previewHeight + interaction.gridMetrics.rowGap) / Math.max(interaction.gridMetrics.rowStep, 1))))
      },
      interaction.originSize
    );

    interaction.previewSize = previewSize;
    skeleton.card.style.width = `${previewWidth}px`;
    skeleton.card.style.height = `${previewHeight}px`;
  },

  async handleLayoutPointerUp(event) {
    const interaction = this.layoutInteraction;

    if (!interaction || event.pointerId !== interaction.pointerId) {
      return;
    }

    if (interaction.type === "pan") {
      this.cleanupLayoutInteraction({
        restoreLayout: false
      });
      return;
    }

    const widgetId = interaction.widgetId;
    const positionChanged =
      interaction.type === "move" &&
      (interaction.previewPosition.col !== interaction.originPosition.col ||
        interaction.previewPosition.row !== interaction.originPosition.row);
    const sizeChanged =
      interaction.type === "resize" &&
      (interaction.previewSize.cols !== interaction.originSize.cols ||
        interaction.previewSize.rows !== interaction.originSize.rows);

    if (positionChanged) {
      const previousRects = captureWidgetCardRects(this.widgetCards);
      this.cleanupLayoutInteraction({
        clearPreview: false,
        restoreLayout: false
      });
      await this.commitWidgetLayout(widgetId, {
        position: interaction.previewPosition
      }, {
        previousRects
      });
      return;
    }

    if (sizeChanged) {
      const previousRects = captureWidgetCardRects(this.widgetCards);
      this.cleanupLayoutInteraction({
        clearPreview: false,
        restoreLayout: false
      });
      await this.commitWidgetLayout(widgetId, {
        size: interaction.previewSize
      }, {
        previousRects
      });
      return;
    }

    this.cleanupLayoutInteraction();
  },

  async commitWidgetLayout(widgetId, changes = {}, options = {}) {
    if (!this.currentSpace) {
      return;
    }

    const nextSpace = getSpaceCardClone(this.currentSpace);
    const previousRects = options.previousRects || captureWidgetCardRects(this.widgetCards);

    if (changes.position !== undefined) {
      nextSpace.widgetPositions[widgetId] = normalizeWidgetPosition(
        changes.position,
        nextSpace.widgetPositions[widgetId] || getWidgetDefaultPosition(nextSpace, widgetId)
      );
    }

    if (changes.size !== undefined) {
      nextSpace.widgetSizes[widgetId] = normalizeWidgetSize(
        changes.size,
        nextSpace.widgetSizes[widgetId] || getEffectiveWidgetSize(nextSpace, widgetId)
      );
    }

    if (changes.minimized !== undefined) {
      const nextMinimized = new Set(nextSpace.minimizedWidgetIds);

      if (changes.minimized) {
        nextMinimized.add(widgetId);
      } else {
        nextMinimized.delete(widgetId);
      }

      nextSpace.minimizedWidgetIds = [...nextMinimized];
    }

    const resolvedLayout = this.resolveCurrentSpaceLayout(nextSpace, {
      anchorMinimized: changes.minimized,
      anchorPosition: changes.position,
      anchorSize: changes.size,
      anchorWidgetId: widgetId,
      minimizedWidgetIds: nextSpace.minimizedWidgetIds,
      widgetPositions: nextSpace.widgetPositions,
      widgetSizes: nextSpace.widgetSizes
    });

    nextSpace.widgetPositions = { ...resolvedLayout.positions };
    nextSpace.minimizedWidgetIds = nextSpace.widgetIds.filter((entry) => resolvedLayout.minimizedMap[entry]);
    this.currentSpace = nextSpace;
    this.applyResolvedLayoutToCards(resolvedLayout, nextSpace, {
      previousRects
    });
    void this.persistLayoutSnapshot(nextSpace);
  },

  persistLayoutSnapshot(spaceSnapshot) {
    const snapshot = getSpaceCardClone(spaceSnapshot);
    const enqueue = this.layoutPersistPromise
      .catch(() => {})
      .then(async () => {
        const savedSpace = await saveSpaceLayout({
          id: snapshot.id,
          minimizedWidgetIds: snapshot.minimizedWidgetIds,
          widgetIds: snapshot.widgetIds,
          widgetPositions: snapshot.widgetPositions,
          widgetSizes: snapshot.widgetSizes
        });

        if (this.currentSpace?.id === savedSpace.id) {
          this.currentSpace.updatedAt = savedSpace.updatedAt;
          await this.loadSpacesList();
        }
      })
      .catch((error) => {
        logSpacesError("persistLayoutSnapshot failed", error, {
          spaceId: snapshot.id
        });
        this.setNotice(formatErrorMessage(error, "Unable to persist widget layout."), "error");

        if (this.currentSpace?.id === snapshot.id) {
          void this.loadCurrentSpace(snapshot.id);
        }
      });

    this.layoutPersistPromise = enqueue;
    return enqueue;
  },

  async toggleWidgetMinimized(widgetId) {
    if (!this.currentSpace) {
      return;
    }

    const isMinimized = this.currentSpace.minimizedWidgetIds.includes(widgetId);
    await this.commitWidgetLayout(widgetId, {
      minimized: !isMinimized
    });
  },

  async closeWidget(widgetId) {
    if (!this.currentSpace) {
      return;
    }

    try {
      await removeWidget({
        spaceId: this.currentSpace.id,
        widgetId
      });
      await this.handleExternalMutation(this.currentSpace.id);
    } catch (error) {
      logSpacesError("closeWidget failed", error, {
        spaceId: this.currentSpace.id,
        widgetId
      });
      this.setNotice(formatErrorMessage(error, `Unable to remove widget "${widgetId}".`), "error");
    }
  },

  async reloadWidget(widgetId) {
    if (!this.currentSpace || !this.refs.grid) {
      return;
    }

    const skeleton = this.widgetCards[widgetId];
    const widgetRecord = getWidgetRecord(this.currentSpace, widgetId);

    if (!skeleton || !widgetRecord) {
      throw new Error(`Widget "${widgetId}" was not found in the current space.`);
    }

    const resolvedLayout = this.currentResolvedLayout || this.resolveCurrentSpaceLayout(this.currentSpace);
    const layoutEntry = {
      minimized: Boolean(resolvedLayout?.minimizedMap?.[widgetId]),
      position: resolvedLayout?.positions?.[widgetId],
      renderedSize: resolvedLayout?.renderedSizes?.[widgetId]
    };
    const loadToken = this.widgetLoadToken;

    skeleton.card.classList.remove("is-error");
    skeleton.body.replaceChildren(createWidgetPlaceholder("Reloading widget..."));

    try {
      await renderWidgetCard(this.currentSpace, widgetId, skeleton, loadToken, layoutEntry);
    } catch (error) {
      if (loadToken !== this.widgetLoadToken) {
        return;
      }

      logSpacesError("reloadWidget failed", error, {
        spaceId: this.currentSpace.id,
        widgetId
      });
      this.setNotice(formatErrorMessage(error, `Unable to reload widget "${widgetId}".`), "error");
      skeleton.body.replaceChildren(
        createWidgetPlaceholder(formatErrorMessage(error, `Unable to render widget "${widgetId}".`))
      );
      skeleton.card.classList.add("is-error");
    }
  },

  async consolidateCurrentSpace() {
    return this.rearrangeCurrentSpace();
  },

  async rearrangeCurrentSpace() {
    if (!this.currentSpace?.widgetIds?.length) {
      return;
    }

    const previousRects = captureWidgetCardRects(this.widgetCards);
    const nextSpace = getSpaceCardClone(this.currentSpace);
    const viewportCols = resolveViewportCols(this.refs.grid);
    const positions = buildCenteredFirstFitLayout({
      viewportCols,
      widgetIds: nextSpace.widgetIds,
      widgetSizes: Object.fromEntries(
        nextSpace.widgetIds.map((widgetId) => [
          widgetId,
          getRenderedWidgetSize(
            getEffectiveWidgetSize(nextSpace, widgetId),
            nextSpace.minimizedWidgetIds.includes(widgetId)
          )
        ])
      )
    }).positions;

    nextSpace.widgetPositions = positions;
    this.cameraOffsetPx = {
      x: 0,
      y: 0
    };

    const resolvedLayout = this.resolveCurrentSpaceLayout(nextSpace, {
      minimizedWidgetIds: nextSpace.minimizedWidgetIds,
      widgetPositions: nextSpace.widgetPositions,
      widgetSizes: nextSpace.widgetSizes
    });

    nextSpace.widgetPositions = { ...resolvedLayout.positions };
    nextSpace.minimizedWidgetIds = nextSpace.widgetIds.filter((widgetId) => resolvedLayout.minimizedMap[widgetId]);
    this.currentSpace = nextSpace;
    this.applyResolvedLayoutToCards(resolvedLayout, nextSpace, {
      previousRects
    });
    void this.persistLayoutSnapshot(nextSpace);
  },

  buildNextSpaceTitle() {
    const baseTitle = "Untitled Space";
    const existingTitles = new Set(this.spaceList.map((spaceRecord) => String(spaceRecord.title || "")));

    if (!existingTitles.has(baseTitle)) {
      return baseTitle;
    }

    let suffix = 2;

    while (existingTitles.has(`${baseTitle} ${suffix}`)) {
      suffix += 1;
    }

    return `${baseTitle} ${suffix}`;
  },

  async loadSpacesList() {
    this.loadingList = true;

    try {
      this.spaceList = await listSpaces();
      this.loaded = true;
      syncSpacesRuntimeState();
    } finally {
      this.loadingList = false;
    }
  },

  async refreshFromRoute() {
    try {
      await this.loadSpacesList();

      const routeId = normalizeOptionalSpaceId(globalThis.space.router?.getParam("id", "") || "");
      const wantsNewSpace = isTruthyRouteParam(globalThis.space.router?.getParam("new", ""));

      if (wantsNewSpace) {
        await this.createSpaceFromRoute();
        return;
      }

      if (routeId) {
        await this.loadCurrentSpace(routeId);
        return;
      }

      if (this.spaceList.length > 0) {
        await spacesRuntime.openSpace(this.spaceList[0].id, { replace: true });
        return;
      }

      this.currentSpace = null;
      this.currentSpaceId = "";
      this.currentSpaceTitleDraft = "";
      syncSpacesRuntimeState();
      this.renderGridState("No spaces yet.", "Create a space to start building persisted widgets.");
    } catch (error) {
      logSpacesError("refreshFromRoute failed", error);
      this.currentSpace = null;
      this.currentSpaceId = "";
      this.currentSpaceTitleDraft = "";
      syncSpacesRuntimeState();
      this.renderGridState("Unable to load spaces.", formatErrorMessage(error, "Unknown spaces error."), "error");
      this.setNotice(formatErrorMessage(error, "Unable to load spaces."), "error");
    }
  },

  async createSpaceFromRoute() {
    if (this.creatingSpace) {
      return;
    }

    this.creatingSpace = true;

    try {
      const createdSpace = await createSpace({
        title: this.buildNextSpaceTitle()
      });

      await this.loadSpacesList();
      await spacesRuntime.openSpace(createdSpace.id, { replace: true });
    } catch (error) {
      logSpacesError("createSpaceFromRoute failed", error);
      this.setNotice(formatErrorMessage(error, "Unable to create a new space."), "error");
      this.renderGridState("Unable to create space.", formatErrorMessage(error, "Unknown create error."), "error");
    } finally {
      this.creatingSpace = false;
    }
  },

  async createSpaceFromUi() {
    if (this.creatingSpace) {
      return;
    }

    this.creatingSpace = true;

    try {
      const createdSpace = await createSpace({
        title: this.buildNextSpaceTitle()
      });

      await spacesRuntime.openSpace(createdSpace.id);
    } catch (error) {
      logSpacesError("createSpaceFromUi failed", error);
      this.setNotice(formatErrorMessage(error, "Unable to create a new space."), "error");
    } finally {
      this.creatingSpace = false;
    }
  },

  async selectSpace(spaceId) {
    if (!spaceId || spaceId === this.currentSpaceId) {
      return;
    }

    await spacesRuntime.openSpace(spaceId);
  },

  renderGridState(titleValue, bodyValue, tone = "info") {
    if (!this.refs.grid) {
      return;
    }

    this.cleanupEmptyCanvas();
    this.cleanupRenderFade();
    cleanupWidgetCards(this.widgetCards);
    this.cameraOffsetPx = {
      x: 0,
      y: 0
    };
    this.widgetCards = {};
    this.currentCanvasBounds = null;
    this.currentResolvedLayout = null;
    this.hasCenteredCurrentSpace = false;
    this.refs.grid.style.removeProperty("width");
    this.refs.grid.style.removeProperty("height");
    this.refs.grid.replaceChildren(createGridStateCard(titleValue, bodyValue, tone));
    syncSpacesRuntimeState();
  },

  async loadCurrentSpace(spaceId) {
    this.loadingSpace = true;
    this.widgetLoadToken += 1;
    const loadToken = this.widgetLoadToken;
    cleanupWidgetCards(this.widgetCards);
    this.currentSpaceId = spaceId;
    this.currentSpace = null;
    this.cameraOffsetPx = {
      x: 0,
      y: 0
    };
    this.currentCanvasBounds = null;
    this.currentResolvedLayout = null;
    this.currentSpaceTitleDraft = "";
    this.hasCenteredCurrentSpace = false;
    this.widgetCards = {};
    this.widgetErrorCount = 0;
    this.renderGridState("Loading space...", `Reading ${buildSpaceRootPath(spaceId)} and replaying its widgets.`);

    try {
      const spaceRecord = await readSpace(spaceId);

      if (loadToken !== this.widgetLoadToken) {
        return;
      }

      this.currentSpace = spaceRecord;
      this.currentSpaceId = spaceRecord.id;
      this.currentSpaceTitleDraft = spaceRecord.title;
      syncSpacesRuntimeState();
      await this.renderCurrentSpace(spaceRecord, loadToken);
    } catch (error) {
      if (loadToken !== this.widgetLoadToken) {
        return;
      }

      this.currentSpace = null;
      this.currentSpaceTitleDraft = "";
      syncSpacesRuntimeState();
      this.renderGridState(
        "Unable to open this space.",
        formatErrorMessage(error, "The requested space could not be loaded."),
        "error"
      );
      logSpacesError("loadCurrentSpace failed", error, { spaceId });
      this.setNotice(formatErrorMessage(error, "Unable to open this space."), "error");
    } finally {
      if (loadToken === this.widgetLoadToken) {
        this.loadingSpace = false;
      }
    }
  },

  async renderCurrentSpace(spaceRecord, loadToken, options = {}) {
    const grid = this.refs.grid;

    if (!grid) {
      return;
    }

    this.cleanupEmptyCanvas();
    this.cleanupRenderFade();
    cleanupWidgetCards(this.widgetCards);
    this.widgetCards = {};
    grid.replaceChildren();

    if (!spaceRecord.widgetIds.length) {
      const emptyCanvas = createEmptyCanvasState();

      this.currentCanvasBounds = null;
      this.currentResolvedLayout = null;
      this.hasCenteredCurrentSpace = false;
      grid.style.removeProperty("width");
      grid.style.removeProperty("height");
      grid.appendChild(emptyCanvas.root);
      this.emptyCanvasCleanup = startFloatingTitleAnimation(emptyCanvas.title, this.motionQuery);
      this.renderFadeCleanup = playGridFadeIn(grid, this.motionQuery);
      syncSpacesRuntimeState();
      return;
    }

    const resolvedLayout = this.resolveCurrentSpaceLayout(spaceRecord);
    const renderJobs = spaceRecord.widgetIds.map(async (widgetId) => {
      const layoutEntry = {
        minimized: Boolean(resolvedLayout.minimizedMap[widgetId]),
        position: resolvedLayout.positions[widgetId],
        renderedSize: resolvedLayout.renderedSizes[widgetId]
      };
      const skeleton = createWidgetCardSkeleton(spaceRecord, widgetId, layoutEntry);
      this.widgetCards[widgetId] = skeleton;
      grid.appendChild(skeleton.card);

      try {
        await renderWidgetCard(spaceRecord, widgetId, skeleton, loadToken, layoutEntry);
      } catch (error) {
        if (loadToken !== this.widgetLoadToken) {
          return;
        }

        logSpacesError("renderWidgetCard failed", error, {
          spaceId: spaceRecord.id,
          widgetId
        });
        this.widgetErrorCount += 1;
        skeleton.body.replaceChildren(
          createWidgetPlaceholder(formatErrorMessage(error, `Unable to render widget "${widgetId}".`))
        );
        skeleton.card.classList.add("is-error");
      }
    });

    this.applyResolvedLayoutToCards(resolvedLayout, spaceRecord, {
      animateEntering: options.animateEntering,
      centerOrigin: options.centerOrigin !== false,
      previousRects: options.previousRects || null
    });
    this.renderFadeCleanup = playGridFadeIn(grid, this.motionQuery);
    await Promise.allSettled(renderJobs);
  },

  async saveCurrentTitle() {
    if (!this.canSaveTitle) {
      return;
    }

    this.savingTitle = true;

    try {
      await saveSpaceMeta({
        id: this.currentSpaceId,
        title: this.currentSpaceTitleDraft.trim()
      });
      await this.handleExternalMutation(this.currentSpaceId);
      this.setNotice("Space title saved.");
    } catch (error) {
      logSpacesError("saveCurrentTitle failed", error, {
        spaceId: this.currentSpaceId
      });
      this.setNotice(formatErrorMessage(error, "Unable to save the current space title."), "error");
    } finally {
      this.savingTitle = false;
    }
  },

  async reloadCurrentSpace() {
    await this.handleExternalMutation(this.currentSpaceId);
  },

  async refreshCurrentSpaceFromStorage(spaceId, options = {}) {
    if (!spaceId || !this.currentSpace || this.currentSpaceId !== spaceId) {
      await this.loadCurrentSpace(spaceId);
      return;
    }

    this.widgetLoadToken += 1;
    const loadToken = this.widgetLoadToken;
    const previousRects = options.previousRects || captureWidgetCardRects(this.widgetCards);
    const preservedCameraOffset = options.preserveCamera === false
      ? { x: 0, y: 0 }
      : { ...this.cameraOffsetPx };

    try {
      const spaceRecord = await readSpace(spaceId);

      if (loadToken !== this.widgetLoadToken) {
        return;
      }

      this.currentSpace = spaceRecord;
      this.currentSpaceId = spaceRecord.id;
      this.currentSpaceTitleDraft = spaceRecord.title;
      this.cameraOffsetPx = preservedCameraOffset;
      syncSpacesRuntimeState();
      await this.renderCurrentSpace(spaceRecord, loadToken, {
        animateEntering: options.animateEntering !== false,
        centerOrigin: options.centerOrigin === true,
        previousRects
      });
    } catch (error) {
      if (loadToken !== this.widgetLoadToken) {
        return;
      }

      logSpacesError("refreshCurrentSpaceFromStorage failed", error, { spaceId });
      this.setNotice(formatErrorMessage(error, "Unable to refresh the current space."), "error");
    }
  },

  async handleRemovedSpace(spaceId) {
    await this.loadSpacesList();

    if (!spaceId || this.currentSpaceId !== spaceId) {
      return;
    }

    this.currentSpace = null;
    this.currentSpaceId = "";
    this.currentSpaceTitleDraft = "";
    syncSpacesRuntimeState();

    if (this.spaceList.length > 0) {
      await globalThis.space.router?.replaceTo(SPACES_ROUTE_PATH, {
        params: {
          id: this.spaceList[0].id
        }
      });
      return;
    }

    if (globalThis.space.router) {
      await globalThis.space.router.replaceTo(SPACES_ROUTE_PATH);
      return;
    }

    this.renderGridState("No spaces yet.", "Create a space to start building persisted widgets.");
  },

  async handleExternalMutation(spaceId) {
    await this.loadSpacesList();

    if (spaceId && this.currentSpaceId === spaceId) {
      await this.refreshCurrentSpaceFromStorage(spaceId, {
        animateEntering: true,
        preserveCamera: true
      });
      return;
    }

    syncSpacesRuntimeState();
  },

  async refreshFromUi() {
    this.clearNotice();
    await this.reloadCurrentSpace();
  }
};

space.fw.createStore(SPACES_STORE_NAME, spacesModel);
