import { describe, expect, it } from "vitest";
import { requireLoopbackSupabaseUrl } from "../../e2e/local-supabase";

describe("E2E Supabase safety boundary", () => {
  it.each([
    "https://project.supabase.co", "http://remote.example:54321",
    "http://127.0.0.1.attacker.example:54321", "file:///tmp/database",
  ])("rejects a nonlocal service-role target: %s", (url) => {
    expect(() => requireLoopbackSupabaseUrl(url)).toThrow(/loopback/);
  });

  it.each(["http://127.0.0.1:54321", "http://localhost:54321", "http://[::1]:54321"])
    ("accepts a loopback service-role target: %s", (url) => {
      expect(requireLoopbackSupabaseUrl(url)).toBe(url);
    });

  it("rejects a different loopback service from the running local Supabase instance", () => {
    expect(() => requireLoopbackSupabaseUrl("http://127.0.0.1:9999", "http://127.0.0.1:54321"))
      .toThrow(/local Supabase/);
  });
});
