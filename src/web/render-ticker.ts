// A dedicated-worker clock for the Studio render job. Browsers pause animation frames and throttle page
// timers in background tabs; dedicated-worker timers are not throttled the same way in Chromium.
const scope = globalThis as unknown as { onmessage: ((event: MessageEvent<number>) => void) | null; postMessage(message: unknown): void };
let timer: ReturnType<typeof setInterval> | undefined;
scope.onmessage = event => {
  if (timer !== undefined) clearInterval(timer);
  timer = event.data > 0 ? setInterval(() => scope.postMessage(0), event.data) : undefined;
};
