import { expect, it } from "vitest";
import { nearestCardIndex } from "@/features/report/deck/nearest-card";
it("returns the card closest to the scroll position", () => {
  expect(nearestCardIndex([0, 1000, 2000], 1400)).toBe(1);
  expect(nearestCardIndex([0, 1000, 2000], 1600)).toBe(2);
  expect(nearestCardIndex([], 0)).toBe(0);
});
