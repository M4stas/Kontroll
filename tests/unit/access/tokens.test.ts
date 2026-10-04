import { describe, expect, it } from "vitest";
import { createAccessToken, hashAccessToken } from "@/server/access/tokens";

describe("analysis access tokens", () => {
  it("stores only a repeatable hash of a random token", () => {
    const first = createAccessToken();
    const second = createAccessToken();
    expect(first.raw).not.toBe(second.raw);
    expect(first.raw).not.toBe(first.hash);
    expect(hashAccessToken(first.raw)).toBe(first.hash);
    expect(first.raw.length).toBeGreaterThanOrEqual(43);
  });
});
