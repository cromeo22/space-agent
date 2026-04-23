import { WatchdogHandler } from "../watchdog.js";

export default class PathIndexHandler extends WatchdogHandler {
  createInitialState() {
    return Object.create(null);
  }

  async onStart(context) {
    this.state = context.peekCurrentPathIndex();
  }

  async onChanges(context) {
    this.state = context.peekCurrentPathIndex();
  }

  restoreState(state) {
    this.state =
      state && typeof state === "object" && !Array.isArray(state)
        ? Object.fromEntries(
            Object.entries(state).map(([projectPath, metadata]) => [projectPath, { ...metadata }])
          )
        : Object.create(null);
  }

  serializeState(state) {
    return Object.fromEntries(
      Object.entries(state || Object.create(null)).map(([projectPath, metadata]) => [
        projectPath,
        { ...metadata }
      ])
    );
  }
}
