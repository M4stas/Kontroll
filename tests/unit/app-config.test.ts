import { describe, expect, it } from "vitest";
import { APP_NAME } from "@/config/app";

describe("app config", () => {
  it("uses the approved working name", () => {
    expect(APP_NAME).toBe("Kontroll");
  });
});
