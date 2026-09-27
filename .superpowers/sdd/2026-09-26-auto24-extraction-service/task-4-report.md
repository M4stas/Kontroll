# Task 4: Turso job store report

## Result

Implemented `JobStore`, `JobRecord`, and `ClaimedJob` in `src/auto24_service/store.py`. The store uses the embedded Turso engine through `import turso; turso.connect(path)`. Runtime dependency `pyturso>=0.7.2,<0.8` was added to `pyproject.toml`; the tests ran against version 0.7.2.

The implementation creates the requested `jobs` table and claim index. A reentrant lock serializes access to the store's single connection. Mutating methods use explicit `BEGIN IMMEDIATE` transactions and commit before returning. Claims select the oldest eligible queued or expired-running job, increment attempts, issue a fresh token, and set a two-minute lease. Both completion and failure require a matching, unexpired lease. Successful completion stores listing and warnings as JSON text and sets UTC `parsed_at` at completion. Permanent failures terminate immediately; transient failures retry after 5 and 30 seconds, then become terminal on the third failed attempt. Completed snapshots remain in the database and there is no deletion method.

## TDD and verification

The tests use the real Turso engine and file-backed databases. They cover queued creation, repeated URLs, ordered single claims, same-connection concurrent claim serialization, attempt and lease state, lease expiry, stale and expired completion rejection, permanent failure, the two-retry limit, committed transaction visibility to a separate connection, UTC completion time, and persistence after opening a new `JobStore`.

**RED:** Before creating `store.py`, ran the focused pytest command in Python 3.12 Docker. Pytest exited 2 during collection with `ModuleNotFoundError: No module named 'auto24_service.store'`, as expected while the requested module was absent.

**Focused GREEN:** `pytest tests/test_store.py -q` in Python 3.12 Docker with `pyturso` 0.7.2: **9 passed in 0.17s**.

**Full GREEN:** Installed the project and test extra with `python -m pip install -e ".[test]"`, confirmed the installed `pyturso` version was 0.7.2, then ran `pytest -q` in Python 3.12 Docker: **72 passed in 0.90s**.

`git diff --check` completed with no whitespace errors. Self-review found no remaining implementation issue. The Docker image emitted only pip's root-user and upgrade notices.

## Size and elapsed time

Added source, test, and configuration files contain **454 nonblank LOC**: store 279, tests 159, and `pyproject.toml` 16. This is 34 LOC above the original 420 upper estimate and within the revised 450–500 range. Estimated active time was about 15 minutes, within the 60–120 minute estimate.

## Reference and limitation

The implementation follows the embedded Python quickstart and binding API: [Turso Python quickstart](https://github.com/tursodatabase/turso-docs/blob/main/sdk/python/quickstart.mdx) and [Turso Python binding README](https://github.com/tursodatabase/turso/blob/main/bindings/python/README.md). The binding remains pre-1.0, so the dependency is constrained to the tested 0.7 minor line.
