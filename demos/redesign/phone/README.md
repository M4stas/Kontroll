# Phone design round

Design demos for roadmap checkpoint 6. The approved layouts are implemented in the app; the comparisons retain the original alternatives.

Serve from the worktree:

```sh
python3 -m http.server 4318 --directory demos/redesign/phone
```

Open http://localhost:4318/. All screens and the five A/B comparisons have light and dark frames at 390x844. `screen.html` accepts `screen`, `theme`, `choice` and `option` query parameters. Use the full-size links at 360x740, 430x932 and landscape.

The Passat is synthetic; photos and credits are copied unchanged from the approved desktop demo. Gallery counts reflect the three actual demonstration photos. Diagnostics timings are illustrative. Language controls are illustrative; this design round shows English UI with the existing Estonian seller-message example. Real implementation will preserve both locales and the current diagnostics behavior.

The `*-reference.html` pages retain the copied desktop demo. Active phone screens use `phone.css` and `phone.js`, with palette and type from the copied `style.css`.

The user approved 1A, 2A, 3A, 4B and 5A. The default screen frames show those choices.

## Historical Part A verification

- Baseline: 80 test files, 757 tests passed with `npm test -- --maxWorkers=2`. The sandboxed run blocked the worker CLI IPC pipe; the unrestricted rerun passed.
- Worktree created from `origin/main` at `afc7c1f`; first commit `13a3248` copies the supplied plan.
- App baselines: eight internal-browser JPEGs plus routes and capture metadata in `/private/tmp/redesign-6-baseline/manifest.json`. Desktop viewport 1440x900; tablet viewport 768x1024. Start, listing, running review and completed report. User-supplied Auto24 listing 4028601.
- Baseline captures are dark. System appearance access was denied; the user will check themes manually. Scrollable captures omit browser gutters, as recorded in the manifest. No before/after claim is made yet.
- Independent demo source review found two touch-target issues. Logo and report dots were enlarged to 44px; source re-review is clean. At 360px, bottom navigation uses 344px including padding.
- Production source, tests, dependencies, DESIGN.md and agent-policy.md have no changes relative to origin/main.
- Demos stay uncommitted until Step 2, which explicitly commits the demos with the approved spec and DESIGN.md decisions. No designs have been approved and Part B has not started.
- Internal-browser demo sizing pass: all 11 routes at 390x844, 360x740, 430x932 and 844x390. No page-width overflow. Dark proposal palette rendered at 390x844; human theme acceptance remains pending.
- All five A/B pairs load. Expanded height A scrolls inside its 640px card; B grows to 736px. Navigation B uses static page-flow placement, confirmed from computed style.
- Back, Next, dots and arrow keys change cards. Checklist count updates from 0 to 1 to 4. Native gallery horizontal scrolling updates the count from 1 / 3 to 2 / 3.
- Copy message returns the success feedback. The internal clipboard reader did not expose the copied text, so paste into Auto24 remains a human check.
- Representative demo screenshots are in `/private/tmp/redesign-6-demo/`: frame-page.jpg, finding-light.jpg, message-light.jpg, checklist-light.jpg and height-B-expanded.jpg.

## Approved choices

On 2026-10-14 the user chose 1A, 2A, 3A, 4B, 5A. Report navigation uses page flow below the cards. See spec decisions 10 to 14. Part B is now authorized.
