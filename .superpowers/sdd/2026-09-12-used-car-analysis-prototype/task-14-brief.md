### Task 14: Run release gates, independent review, and create the pull request

**Files:**
- Modify: `README.md` to describe setup, Supabase, worker, optional Luna, tests, and prototype limits
- Modify: any task-owned file required to fix a release-gate finding

**Interfaces:**
- Consumes: the complete vertical slice from Tasks 1-13.
- Produces: a clean review result, manual E2E evidence, and a pull request.

- [ ] **Step 1: Document exact local startup**

README commands must be executable in this order:

```bash
npm install
npx supabase start
npx supabase db reset
cp .env.example .env.local
npm run dev
npm run worker
```

Document that direct Auto24 fetching respects `AUTO24_FETCH_ENABLED`, fallback remains available, Luna variables are optional, the price estimate is excluded, and Transport Administration may remain `not_checked`.

- [ ] **Step 2: Run the complete automated gate**

Run:

```bash
npm run test
npm run test:integration
npm run test:e2e
npm run typecheck
npm run lint
npm run build
git diff --check
```

Expected: every command exits 0 with no skipped core journey.

- [ ] **Step 3: Perform manual desktop E2E testing**

At a desktop viewport, verify:

1. Auto24 submission and fallback.
2. Progressive stage updates.
3. Private access in a second browser session fails without the secret.
4. ET/EN switching.
5. Evidence expansion and seller-message copy.
6. Supplement upload and same-report verdict update.
7. Source-unavailable language.

Record the tested commit and result in the pull request body.

- [ ] **Step 4: Perform manual mobile E2E testing**

At 390 x 844, verify no horizontal overflow, 44 px touch targets, usable disclosures, checklist persistence, offline reload, and clear-offline-copy behavior. Fix every issue and repeat the full affected journey.

- [ ] **Step 5: Dispatch a separate reviewer subagent**

Ask the reviewer to inspect the complete branch against the spec and plan, with emphasis on evidence invariants, token leakage, RLS, job idempotency, prompt injection, parser fallback, accessibility, and accidental AI dependency. Require file-and-line findings ordered by severity. Do not accept a self-reported clean result without checking the branch diff and rerunning any command the reviewer identifies.

- [ ] **Step 6: Fix every review or manual-test issue**

For each issue, add or update a regression test, reproduce the failure, apply the narrowest fix, rerun the focused test, then rerun the complete automated gate from Step 2. Repeat review if the fix changes an access boundary, verdict policy, or job orchestration.

- [ ] **Step 7: Commit release documentation and fixes**

```bash
git add README.md src tests public supabase messages
git commit -m "docs: add prototype runbook"
```

If no source or test file changed, stage only `README.md`.

- [ ] **Step 8: Create the pull request**

Run:

```bash
git push -u origin HEAD
gh pr create --title "feat: add used-car analysis prototype" --body-file /tmp/cars-pr-body.md
```

The pull request body must include scope, excluded features, schema migration notes, test command results, manual desktop and mobile journeys, reviewer outcome, Auto24 fallback behavior, and the optional-Luna failure behavior.

- [ ] **Step 9: Verify the pull request state**

Run:

```bash
gh pr view --json url,state,headRefName,statusCheckRollup
git status --short
```

Expected: PR state is OPEN, required checks are passing or running, and the worktree contains no unintended tracked changes.
