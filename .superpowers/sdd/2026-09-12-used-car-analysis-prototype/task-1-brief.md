### Task 1: Bootstrap the TypeScript application and test harness

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `next.config.ts`
- Create: `postcss.config.mjs`
- Create: `vitest.config.ts`
- Create: `vitest.setup.ts`
- Create: `playwright.config.ts`
- Create: `components.json`
- Create: `.env.example`
- Create: `src/app/layout.tsx`
- Create: `src/app/globals.css`
- Create: `src/config/app.ts`
- Create: `tests/unit/app-config.test.ts`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `APP_NAME: "Kontroll"` and project scripts used by every later task.
- Produces: `npm run test`, `npm run test:integration`, `npm run test:e2e`, `npm run lint`, `npm run typecheck`, `npm run build`, and `npm run worker`.

- [ ] **Step 1: Install the application dependencies**

Run:

```bash
npm install next@latest react@latest react-dom@latest next-intl @supabase/supabase-js zod openai @phosphor-icons/react clsx tailwind-merge class-variance-authority cheerio file-type sharp
npm install -D typescript @types/node @types/react @types/react-dom tailwindcss @tailwindcss/postcss eslint eslint-config-next vitest @vitejs/plugin-react jsdom @testing-library/react @testing-library/jest-dom @playwright/test tsx
npx shadcn@latest init -d
npx shadcn@latest add button input textarea accordion checkbox separator
```

Expected: npm creates `package-lock.json`; shadcn creates `components.json`, `src/lib/utils.ts`, and the listed primitives.

- [ ] **Step 2: Add scripts and strict project configuration**

Use these scripts in `package.json`:

```json
{
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "worker": "tsx src/worker/index.ts",
    "lint": "eslint .",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:integration": "vitest run tests/integration",
    "test:e2e": "playwright test"
  }
}
```

Set `strict: true`, `noUncheckedIndexedAccess: true`, and alias `@/*` to `./src/*` in `tsconfig.json`. Configure Vitest to include `tests/unit/**/*.test.{ts,tsx}` by default, use jsdom for `.tsx` tests, and load Testing Library matchers from a setup file. Add `.superpowers/`, `.env*`, and `!.env.example` to `.gitignore`.

- [ ] **Step 3: Write the failing configuration test**

```ts
import { describe, expect, it } from "vitest";
import { APP_NAME } from "@/config/app";

describe("app config", () => {
  it("uses the approved working name", () => {
    expect(APP_NAME).toBe("Kontroll");
  });
});
```

- [ ] **Step 4: Run the test and verify the missing module failure**

Run: `npm run test -- tests/unit/app-config.test.ts`

Expected: FAIL because `src/config/app.ts` does not exist.

- [ ] **Step 5: Add the minimal app shell and config**

```ts
// src/config/app.ts
export const APP_NAME = "Kontroll" as const;
```

Use a root layout that imports `globals.css`, exports metadata with the same name, and renders `children`. Define the approved palette as CSS variables in `globals.css`; do not add gradients, glass effects, or rounded-card defaults.

- [ ] **Step 6: Verify the foundation**

Run:

```bash
npm run test -- tests/unit/app-config.test.ts
npm run typecheck
npm run lint
npm run build
```

Expected: all four commands exit 0.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json tsconfig.json next.config.ts postcss.config.mjs vitest.config.ts vitest.setup.ts playwright.config.ts components.json .env.example .gitignore src tests/unit/app-config.test.ts
git commit -m "build: bootstrap TypeScript web app"
```

---

