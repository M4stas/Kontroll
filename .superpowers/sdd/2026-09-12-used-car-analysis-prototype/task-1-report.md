# Task 1 Report: Bootstrap the TypeScript application and test harness

Date: 2026-09-12
Worktree: `~/cars/.worktrees/used-car-prototype`
Branch: `codex/used-car-prototype`
Status: Baseline committed as `f4af4cb6f344b8b57d20b79ab8d2e8450193982b`; Fix round 1 completed for a follow-up commit.
Baseline commit message: `build: bootstrap TypeScript web app`

## Outcome

Task 1 was committed as `f4af4cb6f344b8b57d20b79ab8d2e8450193982b`. The application foundation, strict TypeScript configuration, unit-test harness, Playwright configuration, Tailwind/shadcn setup, approved visual tokens, and required shadcn primitives are present. Fix round 1 restores `next build` as the portable default and provides `next build --webpack` separately as the host-compatibility fallback.

The baseline commit contains 22 Task 1 files. Fix round 1 updates the manifest, lockfile, and ignore rules and adds the Node-version pin and standard Next declaration file. The fix is staged but intentionally uncommitted; no commit was attempted during the fix round.

## TDD evidence

- Red evidence, inherited from the predecessor implementation record: before `src/config/app.ts` was created, `npm run test -- tests/unit/app-config.test.ts` failed because the `@/config/app` module did not exist.
- Minimal implementation: `src/config/app.ts` exports `APP_NAME = "Kontroll" as const`.
- Fresh green evidence from this completion pass: the same focused command exited 0 with 1 test file passed and 1 test passed.

This preserves the requested red-to-green history without recreating or falsifying the predecessor's observed failure.

## Initial verification results

These results document the baseline before Fix round 1. All four commands exited 0; the baseline `build` script invoked webpack at that time. Fresh fix-round evidence appears in the appended section below.

### 1. Focused unit test

Command: `npm run test -- tests/unit/app-config.test.ts`

Result:

```text
RUN  v5.0.0 ~/cars/.worktrees/used-car-prototype
Test Files  1 passed (1)
Tests       1 passed (1)
Duration    315ms
```

### 2. TypeScript

Command: `npm run typecheck`

Result:

```text
> tsc --noEmit
Exit code: 0
No diagnostics.
```

### 3. Lint

Command: `npm run lint`

Result:

```text
> eslint .
Exit code: 0
No warnings or errors.
```

### 4. Production build

Command: `npm run build`

Result:

```text
> next build --webpack
▲ Next.js 16.3.5 (webpack)
✓ Running next.config.ts took 10ms
✓ Compiled successfully in 465ms
✓ Finished TypeScript in 708ms
✓ Generating static pages using 2 workers (1/1) in 183ms
Route (pages)
─ ○ /404
Exit code: 0
```

The `/404`-only route output is expected at this bootstrap stage because Task 1 creates the root layout but no application page.

## Changed-file summary

The staged diff contains 22 added files and 13,778 inserted lines; 13,229 lines are the generated npm lockfile.

### Project and dependency configuration

- `.env.example`: empty placeholders for Supabase, cookie, Auto24, OpenAI, model, and worker settings; no credentials are populated.
- `package.json`: private ESM package, all required dependencies, a Node 24 engine constraint, the portable `next build` default, and a separate `next build --webpack` host fallback.
- `package-lock.json`: npm lockfile v3 with 898 package records. Its root dependency metadata matches `package.json`, and all 32 direct dependencies are represented.
- `tsconfig.json`: strict TypeScript, `noUncheckedIndexedAccess`, no JavaScript, no emit, bundler resolution, Next plugin, and `@/*` mapped to `./src/*`.
- `next.config.ts`: minimal typed Next configuration.
- `postcss.config.mjs`: Tailwind CSS PostCSS plugin.
- `eslint.config.mjs`: Next core-web-vitals and TypeScript lint configuration with generated-output ignores. This file is required to preserve the passing lint setup and is included even though the brief's sample `git add` command omitted it.
- `components.json`: shadcn base-nova configuration using CSS variables, Phosphor icons, server components, and project aliases.
- `playwright.config.ts`: Chromium E2E configuration, local web server, retry behavior for CI, and trace-on-first-retry.
- `vitest.config.ts`: React plugin, source alias, jsdom environment, focused unit-test include pattern, and setup file.
- `vitest.setup.ts`: Testing Library DOM matchers.

### Application foundation

- `src/config/app.ts`: literal `APP_NAME` value `Kontroll`.
- `src/app/layout.tsx`: root layout, Estonian document language, global stylesheet import, and metadata title sourced from `APP_NAME`.
- `src/app/globals.css`: Tailwind/shadcn imports, approved dark inspection-sheet tokens, semantic token mappings, 4px global radius, and minimal global layout defaults.
- `src/lib/utils.ts`: `clsx` and `tailwind-merge` class-name helper.

### shadcn/ui primitives

- `src/components/ui/accordion.tsx`
- `src/components/ui/button.tsx`
- `src/components/ui/checkbox.tsx`
- `src/components/ui/input.tsx`
- `src/components/ui/separator.tsx`
- `src/components/ui/textarea.tsx`

These are the required generated primitives and use the project's semantic tokens and global 4px radius mapping.

### Test

- `tests/unit/app-config.test.ts`: verifies the approved working name is exactly `Kontroll`.

### Existing ignore configuration

The baseline `.gitignore` contained `.env*`, `!.env.example`, `.superpowers/`, `.worktrees/`, `node_modules/`, `.next/`, Playwright reports, and test results. Fix round 1 adds `*.tsbuildinfo`. The standard generated `next-env.d.ts` is now included in the project baseline rather than manually removed after builds.

## Palette and interface audit

The staged CSS contains exactly the approved six literal colors and no other six-digit color values:

- Deep ink navy: `#141D29`
- Raised blue-gray: `#202D3D`
- Cool off-white: `#EDF1F5`
- Steel: `#ABB9C9`
- Muted amber: `#E8B878`
- Pale blue: `#94BCE8`

The original shadcn generated theme color values have been replaced by semantic mappings to this palette. The radius token is `0.25rem` (4px), within the design specification's 3–5px range for controls and genuine raised surfaces. The audit found no Card primitive, rounded-card default, oversized `rounded-2xl`/`rounded-3xl`/`rounded-4xl` treatment, gradient, or backdrop-blur/glass effect.

## Global-constraints audit

- TypeScript-only application and worker scripts: satisfied by configuration and scripts.
- No signup/account behavior introduced: satisfied.
- No Auto24 paid estimate, CAPTCHA solving, or access-control bypass behavior introduced: satisfied.
- No decorative car illustration introduced: satisfied.
- Dark inspection-sheet palette and customized shadcn primitives: satisfied.
- Environment secrets remain placeholders only: satisfied; staged secret scan found no populated service-role/OpenAI values or private-key markers.
- Later-domain constraints for progressive results, verdicts, confidence, claim verification, unavailable-source handling, Luna reasoning, bilingual interfaces, private reports, and hashed tokens are not implemented or contradicted by this bootstrap task.

## Self-review

The complete baseline Task 1 diff was reviewed inline because the user explicitly prohibited subagents.

Checks completed:

- Exactly 22 expected Task 1 files were present in baseline commit `f4af4cb`.
- `git diff --cached --check` reports no whitespace errors.
- No unstaged or untracked files remain.
- Manifest and lockfile are consistent.
- All required scripts exist; after Fix round 1, `build` uses Next's default builder, `build:webpack` provides the host fallback, and `worker` targets the planned TypeScript worker entrypoint.
- Strict TypeScript flags and source alias match the brief.
- Vitest includes `tests/unit/**/*.test.{ts,tsx}`, uses jsdom, and loads Testing Library matchers.
- Root layout uses `APP_NAME`, imports global CSS, renders children, and declares `lang="et"`.
- Palette and visual restrictions pass the audit described above.
- Environment example contains no secrets.
- No unrelated refactor, feature, route, or visual work was added.

Self-review result: clean for Task 1 scope.

## Concerns and deferred production gates

- Baseline commit `f4af4cb6f344b8b57d20b79ab8d2e8450193982b` exists. Fix round 1 remains staged and uncommitted per user instruction.
- The global production-completion gates requiring a separate subagent review, manual desktop/mobile E2E testing, and a pull request remain deferred. The user explicitly required no subagents for this task, and Task 1 does not yet provide an application page for meaningful desktop/mobile E2E inspection. These do not block the narrower completed-for-commit Task 1 handoff.
- Turbopack remains unusable on this host because its internal local-port bind receives `EPERM`; this is documented as an environment limitation, while the portable default script remains intact and the separate webpack fallback is verified.

## Fix round 1

Date: 2026-09-12
Baseline: `f4af4cb6f344b8b57d20b79ab8d2e8450193982b`
Status: Completed for fix commit; staged and intentionally uncommitted.

### Reviewer-finding mapping

1. **Portable default build path — fixed.** `package.json` now restores `"build": "next build"`. The host workaround is isolated as `"build:webpack": "next build --webpack"`, so other environments retain Turbopack coverage.
2. **Generated TypeScript/Next files — fixed.** `.gitignore` now includes `*.tsbuildinfo`, while the standard generated `next-env.d.ts` is included in the staged baseline. Repeated typechecks no longer expose the incremental cache, and Next's declarations are present in a fresh checkout.
3. **Node compatibility declaration — fixed.** `package.json` and the lockfile root declare `"node": ">=24 <25"`; `.nvmrc` pins major `24`. The active runtime is `v24.11.1`. This range matches the current compatible major and avoids Node 25, which is outside Vitest 5's declared range.
4. **Report provenance — fixed.** This report now identifies `f4af4cb6f344b8b57d20b79ab8d2e8450193982b` as the completed baseline commit and distinguishes the staged, uncommitted fix round.

### Fix files

- Modified: `.gitignore`
- Added: `.nvmrc`
- Added: `next-env.d.ts`
- Modified: `package.json`
- Modified: `package-lock.json`

This report is stored under the intentionally ignored `.superpowers/` directory and is not part of the staged code fix.

### Exact fix-round verification evidence

`npm run test -- tests/unit/app-config.test.ts` — exit 0:

```text
RUN  v5.0.0 ~/cars/.worktrees/used-car-prototype
Test Files  1 passed (1)
Tests       1 passed (1)
Duration    492ms
```

`npm run typecheck` — exit 0:

```text
> tsc --noEmit
No diagnostics.
```

`npm run lint` — exit 0:

```text
> eslint .
No warnings or errors.
```

`npm run build:webpack` — exit 0:

```text
> next build --webpack
▲ Next.js 16.3.5 (webpack)
✓ Running next.config.ts took 48ms
✓ Compiled successfully in 512ms
✓ Finished TypeScript in 651ms
✓ Generating static pages using 2 workers (1/1) in 172ms
Route (pages)
─ ○ /404
```

`npm run build` — not counted as code success:

```text
The restored Turbopack build was launched with elevated host access and was
manually stopped at the user's direction after approximately 175.6 seconds.
No completion output was captured from that interrupted invocation. The prior
host evidence remains the documented internal local-port bind failure with
EPERM. Per user instruction, the fix round did not wait on or retry it.
```

### Additional checks and concerns

- `package.json` and the package-lock root both contain the exact Node range `>=24 <25`.
- The required default and fallback scripts resolve to `next build` and `next build --webpack`, respectively.
- `next-env.d.ts` retained the exact content generated by Next 16.3.5 after the successful webpack build.
- `tsconfig.tsbuildinfo` may be generated locally but is ignored and is not staged.
- An attempted offline `npm install --package-lock-only --ignore-scripts` first hit restricted cache access and then, with cache access, npm 11.6.2 failed while recalculating the existing optional sharp WASM dependency tree with `Invalid Version`. Because no dependency or version changed, the lockfile was updated deterministically only at its root `engines` metadata; all dependency-resolution records were preserved.
- No source, dependency version, UI theme, or application behavior changed in this fix round.
