import { SPACES_ROUTE_PATH } from "/mod/_core/spaces/constants.js";

function buildCurrentSpaceSnapshot(currentSpace) {
  const widgets = Array.isArray(currentSpace?.widgets)
    ? currentSpace.widgets.map((widget, index) => ({
        id: widget.id,
        name: widget.name,
        order: index,
        position: {
          col: widget.position?.col ?? widget.col ?? 0,
          row: widget.position?.row ?? widget.row ?? 0
        },
        renderedSize: {
          cols: widget.renderedSize?.cols ?? widget.cols ?? 0,
          rows: widget.renderedSize?.rows ?? widget.rows ?? 0
        },
        size: {
          cols: widget.size?.cols ?? widget.cols ?? 0,
          rows: widget.size?.rows ?? widget.rows ?? 0
        },
        state: widget.state || (widget.minimized ? "minimized" : "expanded")
      }))
    : [];

  return {
    id: currentSpace?.id || "",
    title: currentSpace?.title || "",
    updatedAt: currentSpace?.updatedAt || "",
    widgetCount: widgets.length,
    widgets
  };
}

function buildCurrentSpacePromptSection(snapshot) {
  return [
    "## Current Open Space",
    "",
    "The routed spaces canvas is currently open with this live widget state:",
    "```json",
    JSON.stringify(snapshot, null, 2),
    "```",
    "",
    "Current-space widget helpers:",
    "- `return await space.current.renderWidget({ id, name, cols, rows, renderer })`",
    "- `return await space.current.rearrangeWidgets([{ id, col, row, cols, rows }, ...])`",
    "- `return await space.current.toggleWidgets([\"widget-id\", ...])`",
    "- `return await space.current.removeWidgets([\"widget-id\", ...])`",
    "- `return await space.current.removeAllWidgets()`",
    "",
    "Rules:",
    "- Widget size is capped at `12x12`; do not request larger `cols` or `rows` values.",
    "- `rearrangeWidgets(...)` uses the provided list order as the requested widget order; widgets you omit keep their relative order after the listed ones.",
    "- `toggleWidgets(...)` flips each listed widget between `expanded` and `minimized`.",
    "- Use widget ids from the snapshot above and `return await ...` when you need confirmation of a mutation."
  ].join("\n");
}

export default function injectCurrentSpacePromptSection(hookContext) {
  const promptContext = hookContext?.result;

  if (!promptContext || !Array.isArray(promptContext.sections)) {
    return;
  }

  if (globalThis.space?.router?.current?.path !== SPACES_ROUTE_PATH) {
    return;
  }

  const currentSpace = globalThis.space?.current;

  if (!currentSpace?.id) {
    return;
  }

  const currentSpacePromptSection = buildCurrentSpacePromptSection(buildCurrentSpaceSnapshot(currentSpace));
  const sections = [...promptContext.sections];
  const skillsSectionIndex = promptContext.skillsSection ? sections.indexOf(promptContext.skillsSection) : -1;
  const insertIndex = skillsSectionIndex >= 0 ? skillsSectionIndex : sections.length;

  sections.splice(insertIndex, 0, currentSpacePromptSection);
  promptContext.currentSpacePromptSection = currentSpacePromptSection;
  promptContext.sections = sections;
}
