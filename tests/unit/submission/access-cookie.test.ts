import { describe, expect, it, vi } from "vitest";
import { hashAccessToken } from "@/server/access/tokens";
import {
  createAnalysisAccessCookie,
  verifyAnalysisAccess,
  verifyAnalysisAccessCookie,
} from "@/server/access/analysis-access";

const publicId = "7c5ad3db-7fdb-469e-a96c-d10bc2dd5fb1";
const otherPublicId = "907b4c4d-dae8-4591-b20b-312f2031c91f";
const rawToken = "n7BZ8nDjMKuQEbPVWJTHXS2G2p5x7G8rFZBGnAbzGzA";
const otherRawToken = "y6dB5t15xYxNh99wX9LcZX_vhfKRvBGIQtJMrd2vJQQ";
const secret = "cookie-secret-that-is-at-least-thirty-two-bytes";

describe("analysis access cookie", () => {
  it("contains the raw capability token and verifies for its public ID", () => {
    const cookie = createAnalysisAccessCookie(publicId, rawToken, secret);

    expect(cookie.startsWith(`${rawToken}.`)).toBe(true);
    expect(
      verifyAnalysisAccessCookie({
        cookie,
        persistedTokenHash: hashAccessToken(rawToken),
        publicId,
        secret,
      }),
    ).toBe(true);
  });

  it("rejects a cookie replayed for another public ID", () => {
    const cookie = createAnalysisAccessCookie(publicId, rawToken, secret);

    expect(
      verifyAnalysisAccessCookie({
        cookie,
        persistedTokenHash: hashAccessToken(rawToken),
        publicId: otherPublicId,
        secret,
      }),
    ).toBe(false);
  });

  it("rejects a valid signature when the token hash does not match persistence", () => {
    const cookie = createAnalysisAccessCookie(publicId, rawToken, secret);

    expect(
      verifyAnalysisAccessCookie({
        cookie,
        persistedTokenHash: hashAccessToken(otherRawToken),
        publicId,
        secret,
      }),
    ).toBe(false);
  });

  it.each([
    "missing-signature",
    `${rawToken}.short`,
    `${rawToken}.${"a".repeat(43)}.extra`,
  ])("rejects malformed cookie value %s", (cookie) => {
    expect(
      verifyAnalysisAccessCookie({
        cookie,
        persistedTokenHash: hashAccessToken(rawToken),
        publicId,
        secret,
      }),
    ).toBe(false);
  });

  it("reloads the persisted hash whenever report access is verified", async () => {
    const cookie = createAnalysisAccessCookie(publicId, rawToken, secret);
    const analyses = {
      loadAccessTokenHash: vi.fn().mockResolvedValue(hashAccessToken(rawToken)),
    };

    await expect(
      verifyAnalysisAccess({ cookie, publicId }, { analyses, secret }),
    ).resolves.toBe(true);
    await expect(
      verifyAnalysisAccess({ cookie, publicId }, { analyses, secret }),
    ).resolves.toBe(true);
    expect(analyses.loadAccessTokenHash).toHaveBeenCalledTimes(2);
  });
});
