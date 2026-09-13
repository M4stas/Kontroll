import { describe, expect, it } from "vitest";
import en from "../../../messages/en.json";
import et from "../../../messages/et.json";
import { POST } from "@/app/api/analyses/route";

describe("POST /api/analyses", () => {
  it.each([
    ["et", et.Submission.invalidUrl],
    ["en", en.Submission.invalidUrl],
  ] as const)("returns the %s validation message", async (locale, message) => {
    const response = await POST(
      new Request("http://localhost/api/analyses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locale, listingUrl: "http://example.com/car" }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: message });
  });
});
