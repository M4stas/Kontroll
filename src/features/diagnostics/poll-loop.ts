const INTERVAL_MS = 3000;
const BACKOFF_MS = [6000, 12000, 30000];

export function startPollLoop({
  fetchOnce,
  isActive,
  onFailure,
}: {
  fetchOnce: (signal: AbortSignal) => Promise<void>;
  isActive: () => boolean;
  onFailure: () => void;
}) {
  let stopped = false,
    timer: ReturnType<typeof setTimeout> | undefined,
    controller: AbortController | null = null,
    failures = 0;
  const visible = () => document.visibilityState !== "hidden";
  const pause = () => {
    clearTimeout(timer);
    controller?.abort();
    controller = null;
  };
  const refresh = async () => {
    clearTimeout(timer);
    if (stopped || !isActive() || !visible() || controller) return;
    const request = new AbortController();
    controller = request;
    try {
      await fetchOnce(request.signal);
      if (request.signal.aborted) return;
      failures = 0;
    } catch {
      if (stopped || request.signal.aborted) return;
      failures++;
      onFailure();
    } finally {
      if (controller === request) controller = null;
      if (!stopped && !request.signal.aborted && isActive() && visible())
        timer = setTimeout(refresh, failures ? BACKOFF_MS[Math.min(failures - 1, BACKOFF_MS.length - 1)] : INTERVAL_MS);
    }
  };
  const wake = () => {
    if (!visible()) pause();
    else void refresh();
  };
  document.addEventListener("visibilitychange", wake);
  window.addEventListener("focus", wake);
  window.addEventListener("online", wake);
  void refresh();
  return {
    stop() {
      stopped = true;
      pause();
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("focus", wake);
      window.removeEventListener("online", wake);
    },
    retry() {
      failures = 0;
      void refresh();
    },
  };
}
