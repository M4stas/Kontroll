import { describe, expect, it, vi } from "vitest";
import { createAnalysis } from "@/features/submission/create-analysis";

describe("createAnalysis", () => {
  it("creates an initial job and returns a fragment secret", async () => {
    const createToken = vi.fn().mockReturnValue({
      raw: "private-token",
      hash: "stored-token-hash",
    });
    const repo = {
      create: vi
        .fn()
        .mockResolvedValue({ publicId: "7c5ad3db-7fdb-469e-a96c-d10bc2dd5fb1" }),
    };
    const result = await createAnalysis(
      { locale: "et", listingUrl: "https://www.auto24.ee/soidukid/123456" },
      { analyses: repo as never, createToken },
    );
    expect(repo.create).toHaveBeenCalledWith({
      accessTokenHash: "stored-token-hash",
      inputType: "url",
      listingUrl: "https://www.auto24.ee/soidukid/123456",
      locale: "et",
    });
    expect(result.url).toBe(
      "/et/a/7c5ad3db-7fdb-469e-a96c-d10bc2dd5fb1#access=private-token",
    );
  });

  it("rejects non-http URLs", async () => {
    await expect(
      createAnalysis({ locale: "en", listingUrl: "javascript:alert(1)" }, {} as never),
    ).rejects.toThrow("valid http URL");
  });

  it("rejects insecure http listing URLs", async () => {
    await expect(
      createAnalysis({ locale: "en", listingUrl: "http://www.auto24.ee/soidukid/123456" }, {} as never),
    ).rejects.toThrow("valid http URL");
  });

  it("marks other HTTPS hosts for the fallback path", async () => {
    const repo = {
      create: vi.fn().mockResolvedValue({ publicId: "7c5ad3db-7fdb-469e-a96c-d10bc2dd5fb1" }),
    };

    await createAnalysis(
      { locale: "en", listingUrl: "https://example.com/used-car" },
      { analyses: repo as never },
    );

    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ inputType: "url_with_fallback" }),
    );
  });
});
