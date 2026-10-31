type Kind = "error" | "unhandledrejection" | "console.error";
export type ReportingTarget = Pick<Window, "addEventListener" | "fetch" | "location"> & { console: Pick<Console, "error"> };

const ENDPOINT = "/api/dev/client-errors";
/** Stops a render loop from flooding the dev server's output. */
const MAX_REPORTS = 50;

function describe(value: unknown): { message: string; stack?: string } {
  if (value instanceof Error) return { message: `${value.name}: ${value.message}`, stack: value.stack };
  if (typeof value === "string") return { message: value };
  try {
    return { message: JSON.stringify(value) ?? String(value) };
  } catch {
    return { message: String(value) };
  }
}

/** Sends uncaught errors, rejections and console.error calls to the dev server. */
export function startClientErrorReporting(target: ReportingTarget) {
  let sent = 0;
  const seen = new Set<string>();
  const send = (kind: Kind, message: string, stack?: string) => {
    const key = `${kind}\n${message}`;
    if (sent >= MAX_REPORTS || seen.has(key)) return;
    seen.add(key);
    sent += 1;
    const body = JSON.stringify({
      kind,
      message: message.slice(0, 4000),
      ...(stack ? { stack: stack.slice(0, 8000) } : {}),
      page: target.location.href.split("#", 1)[0]!.slice(0, 2048),
    });
    target
      .fetch(ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: true })
      .catch(() => {});
  };

  target.addEventListener("error", (event) => {
    const { message, stack } = describe(event.error ?? event.message);
    send("error", message, stack);
  });
  target.addEventListener("unhandledrejection", (event) => {
    const { message, stack } = describe(event.reason);
    send("unhandledrejection", message, stack);
  });
  const consoleError = target.console.error.bind(target.console);
  target.console.error = (...args: unknown[]) => {
    consoleError(...args);
    const parts = args.map(describe);
    send("console.error", parts.map((part) => part.message).join(" "), parts.find((part) => part.stack)?.stack);
  };
}
