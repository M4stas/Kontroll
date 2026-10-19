const DRAFT_KEY = "kontroll:listing:draft";
const jobKey = (jobId: string, field: "url" | "poll-start") => `kontroll:listing:${jobId}:${field}`;
const fallbackValues = new Map<string, string>();
const subscribers = new Map<string, Set<() => void>>();

function sessionStore(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function subscribe(key: string, listener: () => void): () => void {
  let listeners = subscribers.get(key);
  if (!listeners) {
    listeners = new Set();
    subscribers.set(key, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners?.delete(listener);
    if (listeners?.size === 0) subscribers.delete(key);
  };
}

function publish(key: string): void {
  subscribers.get(key)?.forEach((listener) => listener());
}

function read(key: string): string | null {
  if (typeof window === "undefined") return null;
  const fallback = fallbackValues.get(key);
  if (fallback !== undefined) return fallback;
  try {
    return sessionStore()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  if (typeof window === "undefined") return;
  try {
    const store = sessionStore();
    if (store) {
      store.setItem(key, value);
      fallbackValues.delete(key);
    } else {
      fallbackValues.set(key, value);
    }
  } catch {
    fallbackValues.set(key, value);
  }
  publish(key);
}

export function subscribeListingDraft(listener: () => void): () => void {
  return subscribe(DRAFT_KEY, listener);
}

export function getListingDraftSnapshot(): string {
  return read(DRAFT_KEY) ?? "";
}

export function getListingDraftServerSnapshot(): string {
  return "";
}

export function subscribeListingJobUrl(jobId: string, listener: () => void): () => void {
  return subscribe(jobKey(jobId, "url"), listener);
}

export function subscribePollStartedAt(jobId: string, listener: () => void): () => void {
  return subscribe(jobKey(jobId, "poll-start"), listener);
}

export function getListingJobUrlServerSnapshot(): string {
  return "";
}

export function saveListingDraft(value: string): void {
  write(DRAFT_KEY, value);
}

export function saveListingJob(jobId: string, url: string, pollStartedAt: number): void {
  write(jobKey(jobId, "url"), url);
  savePollStartedAt(jobId, pollStartedAt);
}

export function readListingJobUrl(jobId: string): string {
  return read(jobKey(jobId, "url")) ?? "";
}

export function readPollStartedAt(jobId: string): number | null {
  const value = read(jobKey(jobId, "poll-start"));
  if (!value || !/^\d+$/.test(value)) return null;
  const timestamp = Number(value);
  return Number.isSafeInteger(timestamp) ? timestamp : null;
}

export function getPollStartedAtServerSnapshot(): number | null {
  return null;
}

export function savePollStartedAt(jobId: string, timestamp: number): void {
  write(jobKey(jobId, "poll-start"), String(timestamp));
}
