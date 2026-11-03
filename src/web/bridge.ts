import type { RuntimeClient } from "../cad/runtime";
export interface ConnectionState {
  phase: "connecting" | "connected" | "offline" | "rejected";
  message: string;
  code?: string;
}
/** Connection status only. Tabs no longer register as command controllers. */
export class BrowserBridge {
  private unsubscribe?: () => void;
  constructor(
    private runtime: RuntimeClient,
    private status: (state: ConnectionState) => void,
  ) {}
  start() {
    const update = () => {
      const state = this.runtime.getSnapshot();
      this.status(
        state.phase === "ready" && !state.persistence.includes("unavailable")
          ? { phase: "connected", message: "Node geometry authority connected" }
          : {
              phase: state.phase === "initializing" ? "connecting" : "offline",
              message: state.error ?? state.persistence,
            },
      );
    };
    this.unsubscribe = this.runtime.subscribe(update);
    update();
  }
  stop() {
    this.unsubscribe?.();
  }
  reconnect() {
    void this.runtime.retryInitialization();
  }
}
