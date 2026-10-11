import { expect, it } from "vitest";
import { captureSteps } from "@/features/listing/capture-steps";

it.each([
  [null, ["active", "waiting", "waiting"]],
  ["queued", ["active", "waiting", "waiting"]],
  ["running", ["done", "active", "waiting"]],
  ["completed", ["done", "done", "done"]],
  ["failed", ["done", "failed", "waiting"]],
] as const)("maps %s to the three steps", (status, expected) => {
  expect(captureSteps(status)).toEqual(expected);
});
