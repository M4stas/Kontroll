import { describe, expect, it } from "vitest";
import { formatDateTime } from "../src/features/listing/formatters";

describe("listing date display", () => {
  it("shows seconds for the last successful status check", () => {
    const date = Date.UTC(2026, 8, 29, 8, 24, 17);
    expect(formatDateTime(date, "et", true)).toMatch(/:17\b/);
  });

  it("keeps captured listing time compact to the minute", () => {
    const date = Date.UTC(2026, 8, 29, 8, 24, 17);
    expect(formatDateTime(date, "en", false)).not.toMatch(/:17\b/);
  });
});
