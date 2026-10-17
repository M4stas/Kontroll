# Task 2 execution report

Implemented plain IndexedDB database `kontroll-offline`, version 1, `reports` store keyed by publicId. Records include schema version, locale, report, timestamps and checklist. Reads remove expired, incompatible and invalid reports. Writes share a recovering promise queue; deletion only targets the requested ID. Local writes notify subscribers, with cross-tab BroadcastChannel notifications.

Saving renews access with PUT before fetching the report. It validates the report ID, retains the existing checklist, applies the 30-day lifetime (positive finite development override only), and maps authorization, quota, unavailable and general failures. Removal marks all pending saves for that report cancelled before queueing deletion. Authorization failures retain previous records. Storage persistence is requested once per module/page lifetime.

Dependency setup: replaced only this worktree's node_modules symlink with a directory of symlinks to the original packages. Installed fake-indexeddb locally from npm pack, with package-lock-only updating the manifest/lock. Original dependencies and .env.local were untouched. Network download required sandbox escalation after the ordinary install failed DNS.

## RED / GREEN

Initial requested tests were written before implementation. `npx vitest run tests/unit/offline --maxWorkers=2` failed with both suites unable to resolve the absent implementation modules. After implementation and dependency setup, 15 tests passed. Additional edge checks cover ordered concurrent mutations, BroadcastChannel delivery, invalid/production expiry overrides and report-ID mismatch. A focused synchronous IndexedDB open failure regression failed because availability stayed true; the catch was added and all 23 tests passed.

## Gates

- `npx vitest run tests/unit/offline --maxWorkers=2`: 2 files, 23 tests passed.
- `npm run lint`: passed, with the two existing demo walk.js warnings.
- `npm run typecheck`: passed with sandbox escalation for SWC native cache access. Ordinary sandbox run failed because the SWC pruning lock could not be opened.
- `npm test -- --maxWorkers=2`: ordinary sandbox run had 82 files / 800 tests passing and the existing worker CLI IPC sandbox restriction failure. Escalated rerun passed: 83 files, 801 tests, 55.69 seconds.

## Self-review

Verified that saving/deleting A does not change B, unauthorized renewals preserve saved data, storage transactions close their database handles, a rejected write does not poison the queue, validation checks report ownership, and removal queues after any already-enqueued write. No frontend UI was added in this task, so manual browser testing belongs to the later integration checkpoint. No Part B scope included. Independent review remains the coordinator's gate.

## Independent review follow-up: cleanup replacement race

The reviewer identified that an invalid readonly snapshot could be replaced by another tab before unconditional deletion. Added deterministic interleaving tests for both get and list: a second IndexedDB connection writes a fresh record and checklist after the snapshot succeeds and before cleanup opens its transaction. Both regressions failed with `expected null to deeply equal` the fresh record.

Cleanup now re-reads and validates the current record inside the readwrite transaction that conditionally deletes it. If the record is now valid, cleanup preserves and returns it, including its checklist. Explicit user deletion still unconditionally deletes only the requested ID.

- RED: `npx vitest run tests/unit/offline --maxWorkers=2`: 2 failed, 23 passed.
- GREEN: same command: 2 files, 25 tests passed.
- `npm run lint`: passed, same two baseline demo warnings.
- `npm run typecheck`: passed with required SWC cache escalation.
- `git diff --check`: passed.

Full suite was not repeated for this bounded transaction change: the affected suite directly exercises get/list cleanup, ordinary deletion, write queue behavior and save integration. Earlier full-suite result remains recorded above.
