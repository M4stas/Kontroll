### Task 6: Parse Auto24 listings and support explicit fallback input

**Files:**
- Create: `src/listings/adapter.ts`
- Create: `src/listings/auto24.ts`
- Create: `src/listings/fallback.ts`
- Create: `tests/fixtures/auto24-listing.html`
- Create: `tests/unit/listings/auto24.test.ts`
- Create: `tests/unit/listings/fallback.test.ts`

**Interfaces:**
- Produces: `ListingAdapter.canHandle(url: URL): boolean`.
- Produces: `ListingAdapter.capture(input: ListingCaptureInput): Promise<ListingSnapshot>`.
- Produces: `parseAuto24Html(html: string, url: URL): ListingSnapshot`.
- Produces: `createFallbackSnapshot(input: FallbackInput): ListingSnapshot`.

- [ ] **Step 1: Save a redacted Auto24 fixture and write failing parser tests**

The fixture must contain title, price, year, mileage, fuel, gearbox, description, seller claims, image URLs, and at least one missing optional field. Remove seller contact details.

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseAuto24Html } from "@/listings/auto24";

describe("parseAuto24Html", () => {
  it("extracts facts without treating description claims as verified", () => {
    const html = readFileSync("tests/fixtures/auto24-listing.html", "utf8");
    const result = parseAuto24Html(html, new URL("https://www.auto24.ee/soidukid/123456"));
    expect(result.marketplace).toBe("auto24");
    expect(result.facts.find((fact) => fact.key === "mileage")?.verification).toBe("unverified");
    expect(result.claims).toContainEqual(expect.objectContaining({ sourceClass: "listing" }));
  });
});
```

- [ ] **Step 2: Run parser tests and verify failure**

Run: `npm run test -- tests/unit/listings`

Expected: FAIL because listing adapters do not exist.

- [ ] **Step 3: Implement parser and capture policy**

Parse semantic HTML, JSON-LD, and labeled specification rows in that order. Normalize whitespace but retain a raw content hash. Use a 15-second timeout, a descriptive user agent, no authentication, no CAPTCHA handling, and no attempt to bypass blocking. If `AUTO24_FETCH_ENABLED` is false, the URL is unsupported, response is blocked, or required identity fields are absent, return a typed `ListingFallbackRequired` result.

- [ ] **Step 4: Implement pasted-text and screenshot fallback**

Create a snapshot with source class `buyer`, verification `unverified`, original listing URL, pasted description, and uploaded screenshot references. Do not infer a clean result from missing fields.

- [ ] **Step 5: Run parser regression tests**

Run:

```bash
npm run test -- tests/unit/listings
npm run typecheck
```

Expected: parser and fallback tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/listings tests/fixtures tests/unit/listings
git commit -m "feat(listings): ingest Auto24 with fallback"
```

---

