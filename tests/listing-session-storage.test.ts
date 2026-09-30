import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getListingDraftSnapshot,
  getPollStartedAtSnapshot,
  readListingJobUrl,
  saveListingDraft,
  saveListingJob,
  subscribeListingDraft,
  subscribePollStartedAt,
} from "../src/features/listing/session-storage";

afterEach(() => vi.unstubAllGlobals());

describe("listing session state", () => {
  it("persists a draft URL and notifies the mounted form", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("window", { sessionStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    } });
    const listener = vi.fn();
    const unsubscribe = subscribeListingDraft(listener);

    saveListingDraft("https://www.auto24.ee/soidukid/123");

    expect(getListingDraftSnapshot()).toBe("https://www.auto24.ee/soidukid/123");
    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
  });

  it("uses available session storage again after a write was blocked", () => {
    const values = new Map<string, string>();
    let blocked = true;
    vi.stubGlobal("window", { sessionStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (blocked) throw new Error("storage blocked");
        values.set(key, value);
      },
    } });

    saveListingDraft("https://www.auto24.ee/soidukid/first");
    blocked = false;
    saveListingDraft("https://www.auto24.ee/soidukid/second");

    expect(values.get("kontroll:listing:draft")).toBe("https://www.auto24.ee/soidukid/second");
    expect(getListingDraftSnapshot()).toBe("https://www.auto24.ee/soidukid/second");
  });

  it("saves the source URL and start time for the same job", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("window", { sessionStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    } });
    const listener = vi.fn();
    const unsubscribe = subscribePollStartedAt("job-123", listener);

    saveListingJob("job-123", "https://www.auto24.ee/soidukid/123", 1_800_000_000_000);

    expect(readListingJobUrl("job-123")).toBe("https://www.auto24.ee/soidukid/123");
    expect(getPollStartedAtSnapshot("job-123")).toBe(1_800_000_000_000);
    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
  });
});
