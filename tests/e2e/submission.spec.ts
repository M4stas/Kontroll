import { expect, test } from "@playwright/test";

test("keeps the first viewport compact and left aligned", async ({ page }) => {
  await page.goto("/en");

  const heading = await page.getByRole("heading", { level: 1 }).boundingBox();
  const form = await page.locator("form").boundingBox();

  expect(heading).not.toBeNull();
  expect(form).not.toBeNull();
  expect(heading!.y).toBeLessThan(160);
  expect(Math.abs(form!.x - heading!.x)).toBeLessThan(24);
});
