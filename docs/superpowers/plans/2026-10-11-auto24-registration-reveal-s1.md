# Auto24 registration reveal (service checkpoint S1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The extraction service clicks Auto24's "näita reg. nr." and "näita VIN" links, solves the reCAPTCHA in Python when it appears, and returns the full registration number and VIN with a solve record.

**Architecture:** A browser-free solver (`captcha/solver.py`) decides tiles from upstream CaptchaRaptor data files (two ONNX models, a perceptual-hash table). A Playwright driver (`captcha/recaptcha.py`) reads Google's challenge data from network responses and clicks with real mouse input. `captcha/reveal.py` runs the Auto24 reveal inside the existing Camoufox capture session, with one retry in a fresh session. The worker stores the result in the existing job record and a new `job_reveals` table.

**Tech Stack:** Python 3.12, Camoufox 0.5.6 (Firefox 152 build) through its Playwright API, onnxruntime, Pillow, numpy, Turso (`pyturso`), FastAPI, pytest, Docker Compose.

**Spec:** [2026-10-11-auto24-registration-reveal-design.md](../specs/2026-10-11-auto24-registration-reveal-design.md). This plan covers service checkpoint S1 only. A1 to A3 get their own plans later.

## Global Constraints

- Follow the [development agent policy](../../agent-policy.md) for any delegation. Do not copy its table here.
- No upstream CaptchaRaptor JavaScript is copied, loaded or run. The only upstream inputs are `type.onnx`, `grid.onnx`, `grid.meta.json`, `captcha.sqlite`, the per-label thresholds and indexes in `extension/captcha/recaptcha_ai.js`, and the label aliases in `extension/captcha/recaptcha.js`. Constants copied from upstream carry a comment naming the file and commit `7462474d5fdfda5618becc9ac7a421de3ea69495` (MIT).
- Pinned SHA-256 values (exact):
  - `type.onnx` `3d48dc93d0b1fb3e399096eeaa387f0877a939b0ea0a824a703865234c0a6f0b` (26,094,674 bytes)
  - `grid.onnx` `19afc4fb06af9a20bc920fd728cf556def069a2af8a7760f919fd825c8369e64` (26,943,726 bytes)
  - `grid.meta.json` `d5b788706dca5401564656ab25ccae37898ff4aed96c5b2fb902dd32b4c1df49` (3,763 bytes)
  - `captcha.sqlite` `7689a67eda67fdf242c6eefd23994325d4982c9b66f40fdaad498a1af9a6da08` (6,750,208 bytes)
  - upstream `LICENSE` `f4e35c9a69151d53cc26d8f9881b08f29dc57a5491ed68a4719ad26981140e7e`
- Allowed hosts during a capture: main frame `www.auto24.ee` as today; subresources `www.auto24.ee`, plus `https://www.google.com/recaptcha/` and `https://www.gstatic.com/recaptcha/` path prefixes. Nothing else. No Google request is rewritten.
- Limits: at most 3 CAPTCHA rounds per attempt, 90 seconds per attempt, one retry in a new browser session. A reveal failure never fails the job.
- Revealed values never appear in logs, the solve record, benchmark reports or sandbox reports. Challenge images are written only by the benchmark.
- Claude runs only offline tests. Live captures, the live sandbox and the benchmark are run by the user with commands from Task 12.
- The `captcha-solver-assets` branch is permanent. Never delete it or any other remote branch. Pushing it needs the user's approval in chat.
- Docs and commit messages follow the unslop rules (`~/.claude/skills/unslop/SKILL.md`): no em dashes, sentence-case headings, plain words.
- New Python dependencies, pinned exactly in `pyproject.toml`: `numpy==2.3.2`, `onnxruntime==1.22.0`, `pillow==11.3.0`. If a pin has no wheel for both linux/amd64 and linux/arm64 on Python 3.12, use the newest patch of the same minor that does and note it in the commit message.
- Python tests run in the service image: `scripts/pytest-service <pytest args>` (created in Task 2). Before Task 2 exists, use `docker run --rm --entrypoint sh -v "$PWD:/app" -w /app -e PYTHONPATH=/app/src auto24-extraction-service:compose -c 'python -m pip install --quiet ".[test]" && python -m pytest <args>'`.

## Review Focus

1. **reCAPTCHA asks for a host or path outside the allowlist, or needs an HTTP redirect** (Camoufox runs with `network.http.redirection-limit=0`). Expected: the guard blocks it, the attempt ends with a reason instead of hanging until the timeout, and the blocked host and path prefix appear in the solve record. Test in Task 7: `test_blocked_google_path_is_recorded_and_attempt_fails_cleanly`.
2. **Auto24 refuses the reveal**, for example without a consent cookie, returning `status: 0` or an empty value. Expected: `value_not_found`, the listing still completes. Test in Task 9: `test_auto24_refusal_marks_unavailable_and_keeps_listing`.
3. **Only one of the two rows exists, or a row is already shown in full.** Expected: per-field statuses `not_listed` or `listed_in_full`, and the flow clicks only what needs clicking. Test in Task 9: `test_row_combinations_set_statuses`.
4. **Custom plates, plates with spaces or lowercase, short pre-1981 VINs.** Expected: accepted, prefix compared without spaces and case, `vin_format` set. A paragraph of text is rejected. Test in Task 9: `test_value_checks_accept_custom_plates_and_old_vins`.
5. **An unexpected exception inside the reveal.** Expected: the browser closes, the job completes with the parsed listing, both fields `unavailable` with `browser_error`. Test in Task 10: `test_reveal_exception_completes_job_with_browser_error`.

---

### Task 1: Docs before starting

**Files:**
- Modify: `docs/superpowers/archive/auto24-service/2026-09-26-auto24-extraction-service-design.md` (lines 10 and 111)
- Create: `docs/superpowers/service-roadmap.md`
- Modify: `docs/superpowers/roadmap.md`

- [ ] **Step 1:** In the archived design, replace the clauses about hidden contact controls and CAPTCHA solving (line 10, and "No CAPTCHA-solving or login flow is attempted." on line 111) with one sentence each that says the service now reveals the registration number and VIN and solves reCAPTCHA, linking to the new spec. Keep contacting sellers, logins and photo downloads excluded.
- [ ] **Step 2:** Create `docs/superpowers/service-roadmap.md` in the format of `roadmap.md`: intro, a one-row table for S1 (status "Planned, approved for implementation"), and the S1 section copied from the spec's "Service roadmap" section, linking this plan.
- [ ] **Step 3:** In `roadmap.md`, add rows A1, A2 and A3 after the existing rows with status "After the redesign" (A2 also "after checkpoint 2"), each linking the spec. Add one line under the table linking the service roadmap.
- [ ] **Step 4:** Commit: `git commit -m "docs: plan registration reveal checkpoints and retire the no-CAPTCHA rule"`.

### Task 2: Solver files, fetch script and image build

**Files:**
- Create: branch `captcha-solver-assets` (orphan) with `type.onnx`, `grid.onnx`, `grid.meta.json`, `captcha.sqlite`, `LICENSE`, `SOURCE.md`
- Create: `vendor/captcha-solver/SHA256SUMS`, `scripts/fetch-captcha-solver`, `scripts/pytest-service`, `tests/test_solver_assets.py`
- Modify: `Dockerfile`, `compose.yaml`, `pyproject.toml`, `.gitignore`, `tests/test_compose_contract.py`

**Interfaces:**
- Produces: solver files at `/opt/captcha-solver/` in the image; env `CAPTCHA_SOLVER_DIR` (default `/opt/captcha-solver`); on the host, `~/.cache/auto24/captcha-solver/current` (symlink to `<first 12 hex of sha256(SHA256SUMS)>/`).

- [ ] **Step 1: Write `vendor/captcha-solver/SHA256SUMS`** with four lines in `sha256sum` format (`<hash>  <name>`), names `type.onnx`, `grid.onnx`, `grid.meta.json`, `captcha.sqlite`, using the Global Constraints values.
- [ ] **Step 2: Write the failing test** `tests/test_solver_assets.py`:

```python
def test_sha256sums_lists_exactly_the_four_files():
    entries = read_sums(Path("vendor/captcha-solver/SHA256SUMS"))
    assert sorted(entries) == ["captcha.sqlite", "grid.meta.json", "grid.onnx", "type.onnx"]
    assert all(re.fullmatch(r"[0-9a-f]{64}", h) for h in entries.values())

@pytest.mark.skipif(not SOLVER_DIR.exists(), reason="solver files not installed")
def test_installed_solver_files_match_sha256sums():
    for name, expected in read_sums(SUMS).items():
        assert sha256_file(SOLVER_DIR / name) == expected
```

`SOLVER_DIR = Path(os.environ.get("CAPTCHA_SOLVER_DIR", "/opt/captcha-solver"))`. Put `read_sums` and `sha256_file` in `src/auto24_service/captcha/assets.py` with signatures `read_sums(path: Path) -> dict[str, str]` and `sha256_file(path: Path) -> str`, plus `verify_solver_dir(solver_dir: Path, sums: Path) -> None` that raises `SolverFilesError` naming the first bad file.

- [ ] **Step 3:** Run the fallback docker command from Global Constraints with `tests/test_solver_assets.py -q`. Expected: FAIL (module missing).
- [ ] **Step 4:** Implement `src/auto24_service/captcha/__init__.py` (empty) and `captcha/assets.py`. Run again. Expected: first test PASS, second SKIP.
- [ ] **Step 5: Create the asset branch locally.** Download the five upstream files into a new empty scratch folder with `gh api -H "Accept: application/vnd.github.raw" repos/CaptchaRaptor/captchaplugin/contents/<path>?ref=7462474d5fdfda5618becc9ac7a421de3ea69495`. Check every hash against Global Constraints before going on. Then `git worktree add --orphan -b captcha-solver-assets <scratch>/assets-worktree`, copy the files flat into it, write `SOURCE.md` (upstream URL, commit, original paths, retrieval date, "data files only; no code"), and commit `chore: add pinned CaptchaRaptor solver data files`. Remove the temporary worktree afterwards; keep the branch.
- [ ] **Step 6: Ask the user to approve `git push origin captcha-solver-assets`.** Do not push without a yes. Continue with the local branch meanwhile.
- [ ] **Step 7: Write `scripts/fetch-captcha-solver`** (bash, `set -euo pipefail`). Behavior: `git fetch origin captcha-solver-assets` if the remote branch exists, else use the local branch, else exit 1 with "captcha-solver-assets branch not found". Extract the four files with `git archive <ref> <names> | tar -x -C <tmpdir>`. Verify with `shasum -a 256 -c` (macOS) or `sha256sum -c` (Linux) against `vendor/captcha-solver/SHA256SUMS`. On mismatch delete the tmpdir and exit 1. On success move it to `~/.cache/auto24/captcha-solver/<12 hex>/`, point `current` at it, print the path. Running twice is a no-op that re-verifies. It never contacts GitHub other than through `git fetch origin`.
- [ ] **Step 8: Wire the build.** `compose.yaml`: each service's `build` gets `additional_contexts: {captcha_solver: ${HOME}/.cache/auto24/captcha-solver/current}`; worker `environment` gets `AUTO24_ENV: ${AUTO24_ENV:-production}` and `REVEAL_FORCE_FAILURE: ${REVEAL_FORCE_FAILURE:-false}`. `Dockerfile`: after installing dependencies, `COPY --from=captcha_solver type.onnx grid.onnx grid.meta.json captcha.sqlite /opt/captcha-solver/`, `COPY vendor/captcha-solver/SHA256SUMS /opt/captcha-solver/`, `RUN cd /opt/captcha-solver && sha256sum -c SHA256SUMS`. Add the three dependency pins to `pyproject.toml`. Add `benchmarks/` and `sandbox-reports/` to `.gitignore`.
- [ ] **Step 9: Write `scripts/pytest-service`**: builds nothing, runs the Global Constraints docker command against `auto24-extraction-service:compose` with `"$@"` as pytest args.
- [ ] **Step 10:** Extend `tests/test_compose_contract.py` with `test_services_build_with_captcha_solver_context` (every `build` has `additional_contexts.captcha_solver`) and `test_worker_defaults_to_production_env`.
- [ ] **Step 11:** Run `scripts/fetch-captcha-solver`, then `docker compose --env-file <test env> build`, then `scripts/pytest-service tests/test_solver_assets.py tests/test_compose_contract.py -q`. Expected: all PASS, no skips. Also corrupt one cached file copy in a scratch folder and confirm the script exits 1.
- [ ] **Step 12:** Commit `feat: add pinned solver files with hash-checked fetch and build`.

### Task 3: Contracts and storage

**Files:**
- Modify: `src/auto24_service/contracts.py`, `store.py`, `storage_api.py`, `storage_client.py`, `public_api.py` (only if it rebuilds `JobResponse` field by field)
- Test: `tests/test_contracts.py`, `tests/test_store.py`, `tests/test_storage_api.py`, `tests/test_storage_client.py`, `tests/test_public_api.py`, `tests/listing-registration-compat.test.ts`

**Interfaces:**
- Produces, in `contracts.py`:

```python
FieldStatus = Literal["listed_in_full", "revealed", "not_listed", "unavailable"]
RevealFailureReason = Literal["captcha_rounds_exhausted", "try_again_later", "timeout",
    "widget_not_found", "value_not_found", "value_rejected", "prefix_mismatch",
    "label_unsupported", "browser_error", "listing_changed"]

class Registration(BaseModel):
    reg_number: str | None = None
    reg_number_status: FieldStatus = "not_listed"
    vin: str | None = None
    vin_status: FieldStatus = "not_listed"
    vin_format: Literal["standard", "nonstandard"] | None = None

class TileRecord(BaseModel):
    method: Literal["lookup", "model", "none"]
    score: float | None = None
    selected: bool
    adjusted: bool = False          # changed by the 3-to-4 rule or the 4x4 one-tile rule

class RoundRecord(BaseModel):
    grid: Literal["3x3", "3x3_dynamic", "4x4"]
    instruction: str | None
    label_id: str | None
    label: str | None
    label_source: Literal["id", "name", "instruction", "none"]
    tiles: list[TileRecord]
    tiles_clicked: list[int]
    duration_ms: int
    result: Literal["solved", "incorrect", "try_again_later", "timeout", "label_unsupported"]

class AttemptRecord(BaseModel):
    attempt: Literal[1, 2]
    started_at: datetime
    duration_ms: int
    outcome: Literal["revealed", "no_captcha_needed", "failed"]
    reason: RevealFailureReason | None = None
    checkbox_only: bool | None = None
    rounds: list[RoundRecord] = Field(default_factory=list)
    prefix_check: dict[Literal["reg_number", "vin"], Literal["passed", "failed", "skipped"]] = Field(default_factory=dict)
    blocked_requests: list[str] = Field(default_factory=list)   # "host/first-path-segment/"

class RevealDiagnostics(BaseModel):
    attempts: list[AttemptRecord] = Field(default_factory=list)
```

`ListingResult.registration: Registration | None = None`. `JobResponse.reveal_diagnostics: RevealDiagnostics | None = None`.
- Produces, in storage: `JobStore.complete(job_id, lease_token, listing, warnings, reveal_diagnostics: dict | None = None) -> bool`; `StorageClient.complete(..., reveal_diagnostics: RevealDiagnostics | None = None)`; the storage API complete payload gains optional `reveal_diagnostics`.

- [ ] **Step 1: Write failing tests.**
  - `test_registration_requires_value_exactly_when_listed_or_revealed`: `Registration(reg_number_status="revealed")` raises; `Registration(reg_number="1", reg_number_status="unavailable")` raises; `vin_format` set without `vin` raises.
  - `test_job_response_without_new_fields_still_parses` using a pre-change JSON payload.
  - `test_store_persists_reveal_diagnostics_across_reopen` and `test_store_opens_a_database_created_before_job_reveals_existed` (create the old `jobs` schema by hand, open with `JobStore`, complete a job with diagnostics, read it back).
  - `test_completed_job_returns_reveal_diagnostics` (storage API) and `test_client_sends_reveal_diagnostics` (client).
  - `tests/listing-registration-compat.test.ts`: `listingSchema.parse({...validListing, registration: {...}})` succeeds and the result has no `registration` key; `jobSchema` likewise drops `reveal_diagnostics`.
- [ ] **Step 2:** Run `scripts/pytest-service tests/test_contracts.py tests/test_store.py tests/test_storage_api.py tests/test_storage_client.py tests/test_public_api.py -q` and `npx vitest run tests/listing-registration-compat.test.ts`. Expected: Python FAIL, TypeScript PASS (it pins today's behavior).
- [ ] **Step 3: Implement.** Store diagnostics in a new table, written in the same transaction as the job update: `CREATE TABLE IF NOT EXISTS job_reveals (job_id TEXT PRIMARY KEY, reveal_json TEXT NOT NULL)`. Insert only when `complete` updated a row and diagnostics are given. `_record` reads it with a left join. Do not alter the `jobs` table.
- [ ] **Step 4:** Run the Step 2 commands. Expected: all PASS.
- [ ] **Step 5:** Commit `feat: add registration and reveal diagnostics to job results`.

### Task 4: Labels, perceptual hash and lookup table

**Files:**
- Create: `src/auto24_service/captcha/labels.py`, `captcha/phash.py`, `captcha/lookup.py`
- Test: `tests/test_captcha_labels.py`, `tests/test_captcha_phash.py`, `tests/test_captcha_lookup.py`

**Interfaces:**
- Produces:

```python
# labels.py
LABELS: tuple[str, ...]   # the 16 upstream names: bicycles boats bridges buses cars chimney crosswalks
                          # hydrants motorcycles mountains palm parkingmeter stairs taxi tractors trafficlights
def resolve_label(label_id: str | None, name: str | None, instruction: str | None
                  ) -> tuple[str | None, Literal["id", "name", "instruction", "none"]]
# phash.py
def phash(image: PIL.Image.Image) -> int          # 63-bit value
def hamming(a: int, b: int) -> int
# lookup.py
class PhashTable:
    def __init__(self, path: Path) -> None        # read-only, immutable; raises SolverFilesError on schema mismatch
    def lookup_tile(self, label: str, value: int) -> bool | None        # phash33
    def lookup_grid(self, label: str, value: int) -> list[bool] | None  # phash44, 16 tiles, tile 0 first
```

- [ ] **Step 1: Write failing label tests.**

```python
@pytest.mark.parametrize("label_id,expected", [("/m/0k4j", "cars"), ("/m/01bjv", "buses"), ("/m/015qff", "trafficlights")])
def test_label_id_wins(label_id, expected):
    assert resolve_label(label_id, "whatever", "Valige kõik pildid") == (expected, "id")

@pytest.mark.parametrize("text,expected", [
    ("Select all images with cars", "cars"), ("Select all squares with traffic lights", "trafficlights"),
    ("Select all images with a fire hydrant", "hydrants"), ("Select all images with parking meters", "parkingmeter"),
    ("Valige kõik pildid, millel on autod", "cars"), ("Valige kõik ruudud autobussidega", "buses"),
    ("Valige kõik pildid valgusfooridega", "trafficlights"), ("Valige kõik pildid taksodega", "taxi"),
    ("Valige kõik pildid mootorratastega", "motorcycles"), ("Valige kõik pildid ülekäiguradadega", "crosswalks")])
def test_instruction_text_in_english_and_estonian(text, expected):
    assert resolve_label(None, None, text) == (expected, "instruction")

def test_name_from_challenge_data_is_used_when_id_is_unknown():
    assert resolve_label("/m/unknown", "Car", None) == ("cars", "name")

def test_unknown_label_is_explicit():
    assert resolve_label("/m/x", "Giraffe", "Select all images with giraffes") == (None, "none")
```

- [ ] **Step 2:** Implement `labels.py`. English parsing follows upstream `extractLabel` and `ALIAS` from `recaptcha.js`. Estonian uses an ordered stem list matched against word starts, longest and most specific first, so `autobuss` maps to buses before `auto` maps to cars. Label ids (from public reCAPTCHA solver write-ups, to be confirmed by the benchmark): `/m/0k4j` cars, `/m/01bjv` buses, `/m/0199g` bicycles, `/m/015qff` trafficlights, `/m/014xcs` crosswalks, `/m/01pns0` hydrants, `/m/04_sv` motorcycles, `/m/019jd` boats, `/m/015kr` bridges, `/m/01jk_4` chimney, `/m/09d_r` mountains, `/m/0cdl1` palm, `/m/015qbp` parkingmeter, `/m/01lynh` stairs, `/m/0pg52` taxi, `/m/013xlm` tractors. Run the label tests. Expected: PASS.
- [ ] **Step 3: Write failing hash tests:** `test_flat_image_hashes_to_zero`, `test_hash_fits_in_63_bits`, `test_recompressed_jpeg_stays_within_distance_6` (a generated photo-like image saved at JPEG quality 95 and 70), `test_different_images_differ_by_more_than_20`.
- [ ] **Step 4:** Implement `phash.py`, porting `extension/captcha/phash-browser.js`. Convert to RGB, resize to 32×32 with `PHASH_RESAMPLE = Image.Resampling.BILINEAR` (module constant; the benchmark's hit rate tunes it), gray = `(r*299 + g*587 + b*114) // 1000`, orthonormal 2D DCT-II with numpy, take coefficients for y in 0..7 and x in 0..7 in row order skipping (0, 0), median = sorted value at index 32, bit = 1 when coefficient > median, first coefficient is the most significant bit. Run. Expected: PASS.
- [ ] **Step 5: Write failing lookup tests** against a small SQLite file built in the test with upstream's schema (`phash33(label, phash, selected, band0, band1, band2, band3)`, `phash44(label, phash, mask, band0..band3)`, phash stored as decimal text):
  - `test_tile_hit_within_distance_9` and `test_tile_miss_at_distance_10`.
  - `test_grid_mask_maps_most_significant_bit_to_tile_0`: mask `0x8001` gives tiles 0 and 15.
  - `test_nearest_candidate_wins_when_several_match`.
  - `test_schema_mismatch_raises_solver_files_error`.
  - `test_real_table_has_expected_schema` (skip when solver files are absent).
- [ ] **Step 6:** Implement `lookup.py`. Open with `sqlite3.connect(f"file:{path}?mode=ro&immutable=1", uri=True)`. Bands are the four 16-bit slices of the 64-bit value, `band0` = bits 48 to 63. Use upstream's query (any two bands equal), then pick the candidate with the smallest Hamming distance below 10. Parse stored hashes with `int(text, 0)`. Run. Expected: PASS.
- [ ] **Step 7:** Commit `feat: add CAPTCHA label mapping, perceptual hash and lookup table`.

### Task 5: Models and tile decisions

**Files:**
- Create: `src/auto24_service/captcha/models.py`, `captcha/solver.py`
- Test: `tests/test_captcha_solver.py`, `tests/test_captcha_models.py`

**Interfaces:**
- Consumes: `PhashTable`, `phash`, `resolve_label` output label.
- Produces:

```python
# models.py
class SolverModels:
    def __init__(self, solver_dir: Path) -> None
    def tile_scores(self, label: str, tiles: list[Image.Image]) -> list[float] | None   # None: label not in type model
    def grid_scores(self, label: str, image: Image.Image) -> list[float] | None         # 16 scores; None: not in grid model
    def grid_thresholds(self, label: str) -> list[float]
# solver.py
@dataclass(frozen=True)
class Decision:
    tiles: list[TileRecord]          # from contracts
    @property
    def lookup_hits(self) -> int: ...
class Solver:
    def __init__(self, table: PhashTable, models: SolverModels, rng: random.Random) -> None
    def solve_grid(self, label: str, kind: Literal["3x3", "4x4"], image: bytes) -> Decision | None
    def solve_tiles(self, label: str, tiles: list[bytes]) -> Decision | None   # refilled 3x3 tiles
def load_solver(solver_dir: Path) -> Solver      # functools.cache: one instance per process
class SolverLike(Protocol):                       # what the driver and reveal accept; tests pass stubs
    def solve_grid(self, label: str, kind: Literal["3x3", "4x4"], image: bytes) -> Decision | None: ...
    def solve_tiles(self, label: str, tiles: list[bytes]) -> Decision | None: ...
```

- [ ] **Step 1: Write failing decision tests** with a fake table and fake models (no ONNX):
  - `test_3x3_uses_lookup_first_and_model_only_for_misses`: tiles 0 to 4 hit the table, 5 to 8 go to the model; methods recorded per tile.
  - `test_3x3_raises_two_selected_to_three_and_marks_adjusted` and `test_3x3_lowers_six_selected_to_four`.
  - `test_refilled_tiles_are_not_forced_to_three`.
  - `test_4x4_lookup_hit_returns_mask`.
  - `test_4x4_single_model_pick_adds_next_best_tile`.
  - `test_4x4_never_applies_random_flips` (100 runs with different seeds give identical results).
  - `test_label_missing_from_model_returns_none_only_when_lookup_misses`.
- [ ] **Step 2:** Run `scripts/pytest-service tests/test_captcha_solver.py -q`. Expected: FAIL.
- [ ] **Step 3: Implement `solver.py`.** Decode with Pillow and convert to RGB. A 3x3 image is split into three equal columns and rows. The 3-to-4 rule picks tiles to add or remove with the injected `rng`. Run. Expected: PASS.
- [ ] **Step 4: Write model tests** (skip when solver files are absent): `test_type_model_scores_nine_tiles_between_0_and_1`, `test_grid_model_returns_16_scores_for_a_known_label`, `test_grid_model_returns_none_for_cars` (the grid model has 11 labels and no cars), `test_load_solver_returns_the_same_instance`.
- [ ] **Step 5: Implement `models.py`.** Two `onnxruntime.InferenceSession`s with `providers=["CPUExecutionProvider"]`, input name `input`. Preprocessing: Pillow bilinear resize to 100×100 (tiles) or `grid.meta.json["image_size"]` (240), float32 RGB / 255, mean `[0.485, 0.456, 0.406]`, std `[0.229, 0.224, 0.225]`, NCHW. Type model: sigmoid of logit `TYPE_INDEX[label]` versus `TYPE_THRESHOLDS[label]`. Grid model: output dims `[1, C, 16]`, sigmoid of `logits[type_to_index[label] * 16 + i]` versus `thresholds_by_type[label][i]`. Copy from `recaptcha_ai.js`: `TYPE_INDEX = {boats: 0, motorcycles: 1, palm: 2, parkingmeter: 3, stairs: 4, taxi: 5, tractors: 6, bicycles: 7, cars: 8, hydrants: 9, crosswalks: 10, buses: 11, trafficlights: 12, bridges: 13, chimney: 14, mountains: 15}` and `TYPE_THRESHOLDS = {hydrants: 0.139, bridges: 0.191, boats: 0.047, cars: 0.994, crosswalks: 0.136, taxi: 0.862, bicycles: 0.065, trafficlights: 0.137, motorcycles: 0.154, stairs: 0.075, mountains: 0.061, tractors: 0.015, buses: 0.618, palm: 0.01, parkingmeter: 0.001, chimney: 0.006}`. Run both test files. Expected: PASS.
- [ ] **Step 6:** Commit `feat: add ONNX tile scoring and CAPTCHA decisions`.

### Task 6: Fake Auto24 and reCAPTCHA test site

**Files:**
- Create: `tests/fakesite/__init__.py`, `tests/fakesite/pages/listing.html`, `tests/fakesite/pages/api.js`, `tests/fakesite/pages/anchor.html`, `tests/fakesite/pages/bframe.html`
- Test: `tests/test_fakesite.py`

**Interfaces:**
- Produces:

```python
@dataclass
class Scenario:
    reg: Literal["hidden", "full", "missing"] = "hidden"
    vin: Literal["hidden", "full", "missing"] = "hidden"
    reg_value: str = "123ABC";  reg_prefix: str | None = "123..."
    vin_value: str = "WVWZZZ1KZAW000001";  vin_prefix: str | None = "WVWZZZ..."
    captcha: Literal["none", "checkbox_only", "challenge"] = "challenge"
    grid: Literal["3x3", "3x3_dynamic", "4x4"] = "3x3"
    incorrect_rounds: int = 0            # verifies rejected before one passes
    try_again_later: bool = False
    hang_checkbox: bool = False
    vin_needs_captcha: bool = False
    label_id: str | None = "/m/0k4j";  label_name: str | None = "Car"
    instruction: str = "Select all images with cars"
    refuse_reveal: bool = False          # data_json answers status 0
    extra_request: str | None = None     # URL the fake api.js also loads, for guard tests
LISTING_URL = "https://www.auto24.ee/soidukid/900001"
class FakeSiteLog:  # requests: list[str]; verifies: int; clicked_tiles: list[list[int]]; posted_tokens: int
def install_fake_site(context: BrowserContext, scenario: Scenario) -> FakeSiteLog
```

- [ ] **Step 1: Build the pages from the saved sample, sanitized.** `listing.html` is `tests/fixtures/auto24-passenger-car.html` plus the two rows exactly as Auto24 marks them up (`tr.field-reg_nr` with `span.value > span.preview + span.service-trigger[data-action=uv_regnr][data-key]`, and `.field-tehasetahis .value .-response` with the `uv_vin` trigger), using made-up values, data keys and site key. Its inline script is our own, not Auto24's: a click on `.service-trigger` calls `/services/data_json.php` and applies `response.value` / `replace` / `redraw` the way the sample shows. No real keys, tokens, cookies or values from `~/auto24 samples/` enter the repo.
- [ ] **Step 2:** `api.js` renders an anchor iframe (`https://www.google.com/recaptcha/api2/anchor?...&hl=et`) into `.germ`. It opens the challenge iframe (`.../api2/bframe?...`) in a positioned div in the top document when the anchor asks, and posts `g-recaptcha-response` and `ikey` with `q=uv_regnr_sec` when the anchor reports success. `anchor.html` has `#recaptcha-anchor.recaptcha-checkbox[role=checkbox][aria-checked]`. `bframe.html` reproduces the DOM the driver reads: `.rc-imageselect-instructions`, a `table` of `td` cells with `img` (`rc-image-tile-33`, `-44`, `-11`), `#recaptcha-verify-button`, `.rc-imageselect-incorrect-response`, `.rc-doscaptcha-header`. It calls `POST .../api2/reload` (answer `)]}'` + `["rresp", "tok", null, 120, ["pmeta", [label_id, null, 3, 3, 3, null, label_name]], "imageselect" or "dynamic"]`), loads images from `.../api2/payload?p=<n>`, refills clicked tiles in dynamic mode from `.../api2/payload?p=<n>&id=<tile>`, and calls `.../api2/userverify` on verify.
- [ ] **Step 3:** `install_fake_site` registers one `context.route("**/*", handler)` that fulfils the URLs above from the pages and generated Pillow images (300×300, 450×450, 100×100 JPEG), records each request in the log, and calls `route.fallback()` for anything else.
- [ ] **Step 4: Write `tests/test_fakesite.py`** with real Camoufox: `test_manual_click_through_reveals_both_values` (scenario `checkbox_only`: click trigger, click checkbox in the anchor frame, see `123ABC`, click VIN trigger, see the VIN without a second CAPTCHA) and `test_challenge_frame_exposes_reload_label_and_images`.
- [ ] **Step 5:** Run `scripts/pytest-service tests/test_fakesite.py -q`. Expected: PASS.
- [ ] **Step 6:** Commit `test: add fake Auto24 and reCAPTCHA pages for offline reveal tests`.

### Task 7: Browser sessions and the request guard

**Files:**
- Modify: `src/auto24_service/browser.py`
- Test: `tests/test_browser.py`

**Interfaces:**
- Consumes: `Scenario`, `install_fake_site` (tests only).
- Produces:

```python
@dataclass
class ListingSession:
    page: Page
    context: BrowserContext
    blocked: list[str]        # "host/first-path-segment/", in request order, no duplicates
@contextmanager
def open_listing(url: str, *, setup: Callable[[BrowserContext], None] | None = None,
                 profile_dir: Path | None = None) -> Iterator[ListingSession]
def capture_html(url: str) -> str    # unchanged behavior, now built on open_listing
```

- [ ] **Step 1: Write failing tests.**
  - `test_guard_allows_only_recaptcha_paths_on_google_hosts` (parametrized: `https://www.google.com/recaptcha/api2/anchor` allowed; `https://www.google.com/js/bg/x.js`, `https://www.gstatic.com/other/x.js`, `https://google.com/recaptcha/x`, `http://www.google.com/recaptcha/x`, `https://www.google.com:443/recaptcha/x` rejected).
  - `test_allowed_request_falls_back_instead_of_continuing` (FakeRoute gains `fallback()`; existing tests expecting `"continue"` change to `"fallback"`).
  - `test_blocked_google_path_is_recorded_and_attempt_fails_cleanly`: real Camoufox, `open_listing(LISTING_URL, setup=lambda c: install_fake_site(c, Scenario(extra_request="https://www.google.com/js/bg/x.js")))`, trigger the reveal click by hand, and assert `"www.google.com/js/" in session.blocked` and that the fake log never saw that URL.
  - `test_open_listing_with_profile_dir_reuses_cookies` (two sessions on one temp dir).
- [ ] **Step 2:** Run `scripts/pytest-service tests/test_browser.py -q`. Expected: FAIL.
- [ ] **Step 3: Implement.** `_allowed_url` adds the two path prefixes for subresources only, with the same scheme, port and credential checks it already does. The guard calls `route.fallback()` for allowed requests, so test routes registered by `setup` before the guard can fulfil them. `open_listing` launches `Camoufox(headless=True, humanize=True, firefox_user_prefs={"network.http.redirection-limit": 0})`, with `persistent_context=True, user_data_dir=profile_dir` when a profile is given, then runs the existing redirect-checked navigation and status checks. `capture_html` keeps its current error codes. Run all of `tests/test_browser.py`. Expected: PASS, including every existing test.
- [ ] **Step 4:** Commit `feat: open listings in reusable sessions and allow reCAPTCHA paths`.

### Task 8: reCAPTCHA driver

**Files:**
- Create: `src/auto24_service/captcha/recaptcha.py`
- Test: `tests/test_captcha_driver.py`

**Interfaces:**
- Consumes: `Solver` (or any object with `solve_grid` and `solve_tiles`), `resolve_label`, `RoundRecord`, `TileRecord`, `ListingSession.page`.
- Produces:

```python
@dataclass
class CaptchaResult:
    passed: bool
    reason: RevealFailureReason | None
    checkbox_only: bool
    rounds: list[RoundRecord]
def solve_recaptcha(page: Page, solver: SolverLike, *, deadline: float, rounds_left: int,
                    clock: Callable[[], float] = time.monotonic, rng: random.Random | None = None,
                    save_image: Callable[[str, bytes], None] | None = None) -> CaptchaResult
```

- [ ] **Step 1: Write failing tests** with real Camoufox on the fake site and a stub solver that returns fixed decisions:
  - `test_checkbox_only_pass_records_no_rounds`.
  - `test_3x3_round_clicks_selected_tiles_and_passes`, `test_dynamic_3x3_solves_refilled_tiles_in_the_same_round`, `test_4x4_round_passes`.
  - `test_incorrect_rounds_retry_until_three_then_stop` (scenario `incorrect_rounds=5`: 3 verifies, reason `captcha_rounds_exhausted`).
  - `test_try_again_later_ends_immediately`.
  - `test_hung_checkbox_times_out` (deadline 5 seconds, reason `timeout`, returns within 7 seconds).
  - `test_unknown_label_ends_with_label_unsupported`.
  - `test_label_comes_from_reload_id_not_text` (Estonian instruction, id `/m/0k4j`, round record `label_source == "id"`).
  - `test_images_come_from_network_responses` (stub solver receives the exact bytes the fake served).
- [ ] **Step 2:** Run `scripts/pytest-service tests/test_captcha_driver.py -q`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Listen to `page.on("response")` for URL paths matching `/recaptcha/(api2|enterprise)/(reload|payload|userverify|replaceimage)` and keep the response objects; read bodies only when needed.
  - Find the anchor frame (URL contains `/anchor`) and click `#recaptcha-anchor` with `page.mouse` at a random point inside it. No anchor frame before the deadline: `widget_not_found`.
  - Poll every 200 ms: anchor `aria-checked="true"` means passed (checkbox only if no challenge opened); a visible challenge frame starts a round; `.rc-doscaptcha-header` means `try_again_later`.
  - A round parses the newest `reload` body (strip the `)]}'` line, JSON): label id and name from `pmeta`, challenge type from element 5. The grid is `4x4` with 16 cells, `3x3_dynamic` when the type is `dynamic` or the instruction has 3 lines, else `3x3`. Image bytes come from the stored response whose URL equals the tile `img` `src`; fall back to an element screenshot.
  - Click tiles whose selection differs from the decision. Order is random for 3x3; delay `300 ms + rng.uniform(0, 300) ms` between clicks except on 4x4. Dynamic: after clicks, wait for refilled `img` sources, `solve_tiles` them, click new picks, repeat until a pass adds none. Then wait `850 ms + rng.uniform(0, 300) ms` and click `#recaptcha-verify-button`.
  - Each verify ends a round. Stop at `rounds_left`. Check the deadline before every wait.
  - `save_image(name, bytes)` is called for each challenge image when given (benchmark only).
  Run. Expected: PASS.
- [ ] **Step 4:** Commit `feat: drive reCAPTCHA challenges from network data with real clicks`.

### Task 9: Reveal flow with retry and value checks

**Files:**
- Create: `src/auto24_service/captcha/reveal.py`
- Test: `tests/test_reveal.py`

**Interfaces:**
- Consumes: `open_listing`, `ListingSession`, `solve_recaptcha`, `CaptchaResult`, contracts.
- Produces:

```python
@dataclass
class RevealOutcome:
    registration: Registration
    diagnostics: RevealDiagnostics
def reveal_registration(first: ListingSession, reopen: Callable[[], ContextManager[ListingSession]],
                        solver: SolverLike, *, attempt_seconds: float = 90.0, force_failure: bool = False,
                        save_image: Callable[[str, bytes], None] | None = None) -> RevealOutcome
def check_reg_number(value: str) -> bool
def vin_format(value: str) -> Literal["standard", "nonstandard"] | None   # None: rejected
def prefix_matches(prefix: str | None, value: str) -> Literal["passed", "failed", "skipped"]
```

- [ ] **Step 1: Write failing tests.**
  - `test_value_checks_accept_custom_plates_and_old_vins`: `check_reg_number` accepts `"123ABC"`, `"ABBA 1"`, `"mÕÄ-1"`, rejects `""`, `"x" * 21`, `"Reg. number: näita"`; `vin_format("WVWZZZ1KZAW000001") == "standard"`, `vin_format("123456") == "nonstandard"`, `vin_format("WVWZZZ1KZAW00000O") == "nonstandard"`, `vin_format("WVW ZZZ") is None`; `prefix_matches("123...", "123ABC") == "passed"`, `prefix_matches("123...", "123 abc") == "passed"`, `prefix_matches("ABB...", "ABBA1") == "passed"`, `prefix_matches("123...", "456DEF") == "failed"`, `prefix_matches(None, "X") == "skipped"`.
  - `test_reveal_with_challenge_returns_both_values` (one attempt, outcome `revealed`, VIN revealed without a second CAPTCHA).
  - `test_no_captcha_needed_outcome`.
  - `test_row_combinations_set_statuses` (parametrized over `hidden`, `full`, `missing` for both rows).
  - `test_first_attempt_fails_then_retry_succeeds` (reopen gives a fresh session; attempt 2 only reveals what attempt 1 missed).
  - `test_two_failed_attempts_mark_fields_unavailable_with_reasons`.
  - `test_auto24_refusal_marks_unavailable_and_keeps_listing` (`refuse_reveal=True`, reason `value_not_found`).
  - `test_prefix_mismatch_rejects_value` (fake reveals `999XYZ` for prefix `123...`).
  - `test_dom_and_json_value_must_agree` (fake writes a different value to the page than in its JSON: `value_rejected`).
  - `test_force_failure_records_two_widget_not_found_attempts_without_clicking`.
  - `test_values_never_appear_in_diagnostics` (serialize the diagnostics and assert neither value string occurs).
- [ ] **Step 2:** Run `scripts/pytest-service tests/test_reveal.py -q`. Expected: FAIL.
- [ ] **Step 3: Implement.** Selectors: registration row `tr.field-reg_nr`, VIN row `.field-tehasetahis`, trigger `.service-trigger[data-action="uv_regnr"]` / `[data-action="uv_vin"]`, prefix `.preview`, value `.value` (registration) and `.value .-response` falling back to `.value` (VIN). A value counts as present when the trigger is gone and the text is non-empty and does not end in `...`. Read Auto24's `/services/data_json.php` JSON `q.response.value` from responses and compare it with the page text after removing spaces and ignoring case. Registration first, then VIN; the 3-round budget is shared within an attempt. The attempt deadline is `clock() + attempt_seconds`. `reveal_registration` never closes `first`; its caller owns it. For attempt 2 it enters `reopen()` and exits it before returning. If `reopen()` raises `CaptureError`, attempt 2 fails with `listing_changed`. Run. Expected: PASS.
- [ ] **Step 4:** Commit `feat: reveal registration number and VIN with retry and value checks`.

### Task 10: Worker integration and the test switch

**Files:**
- Modify: `src/auto24_service/browser.py`, `src/auto24_service/worker.py`
- Test: `tests/test_worker.py`, `tests/test_browser.py`

**Interfaces:**
- Consumes: `open_listing`, `reveal_registration`, `load_solver`, `verify_solver_dir`.
- Produces:

```python
@dataclass
class CaptureResult:
    html: str
    registration: Registration | None
    reveal_diagnostics: RevealDiagnostics | None
def capture_listing(url: str, *, solver: SolverLike, force_failure: bool = False,
                    profile_dir: Path | None = None,
                    save_image: Callable[[str, bytes], None] | None = None) -> CaptureResult
```

`run_once(client, capture, parser)` now takes `capture: Callable[[str], CaptureResult]`.

- [ ] **Step 1: Write failing tests.**
  - `test_worker_merges_registration_into_listing_and_stores_diagnostics`.
  - `test_reveal_exception_completes_job_with_browser_error` (reveal raises; job completes; both hidden fields `unavailable`; attempt reason `browser_error`; the fake capture's browser `close` was called).
  - `test_capture_errors_still_fail_the_job_as_before` (existing codes unchanged).
  - `test_worker_refuses_force_failure_outside_development` (`main` with `REVEAL_FORCE_FAILURE=true`, `AUTO24_ENV=production` exits 2 with a message naming both settings) and `test_worker_allows_force_failure_in_test_env`.
  - `test_worker_refuses_to_start_when_solver_files_fail_verification`.
  - `test_capture_listing_saves_html_before_any_click` (fake site: the returned HTML has the `näita reg. nr.` trigger and no `reCAPTCHA` text).
- [ ] **Step 2:** Run `scripts/pytest-service tests/test_worker.py tests/test_browser.py -q`. Expected: FAIL.
- [ ] **Step 3: Implement.** `capture_listing` opens the session, applies today's HTML checks to the pre-click HTML, then runs `reveal_registration` inside a `try` so any exception becomes an `unavailable`/`browser_error` outcome. The worker parses the HTML, sets `listing.registration`, and calls `client.complete(..., reveal_diagnostics=...)`. `main` reads `AUTO24_ENV` (default `production`), `REVEAL_FORCE_FAILURE` (`true`/`false`, default `false`) and `CAPTCHA_SOLVER_DIR` (default `/opt/captcha-solver`), verifies the solver files before the loop, and loads the solver once. Logs contain job id and per-field status only. Run. Expected: PASS.
- [ ] **Step 4:** Run the full Python suite: `scripts/pytest-service -q`. Expected: all PASS.
- [ ] **Step 5:** Commit `feat: reveal registration during capture in the worker`.

### Task 11: Benchmark command

**Files:**
- Create: `src/auto24_service/captcha_benchmark.py`
- Test: `tests/test_captcha_benchmark.py`

**Interfaces:**
- Consumes: `capture_listing`, `load_solver`, `RevealDiagnostics`.
- Produces: `main(argv: Sequence[str] | None = None) -> int` with `--mode fresh|saved|both`, `--listings FILE` (one URL per line, `#` comments), `--label` (`[A-Za-z0-9_-]{1,40}`), `--reveals` (default 10), `--out` (default `benchmarks`), `--keep-profile`. Exit 0 when every mode passes the gate, 1 otherwise, 2 on bad arguments.

- [ ] **Step 1: Write failing tests** with an injected fake `capture_listing` that returns scripted diagnostics:
  - `test_gate_passes_at_8_of_10_and_fails_at_7_of_10` (success = all needed fields revealed in attempt 1; retries are reported separately).
  - `test_fewer_than_10_reveals_reports_insufficient`.
  - `test_listings_without_reveal_links_are_skipped_not_counted`.
  - `test_report_contains_rates_reasons_and_versions_but_no_values_or_ip` (scan `report.json` and `report.md` for the scripted values and for any IPv4 pattern).
  - `test_images_are_written_under_the_run_folder`.
  - `test_saved_mode_deletes_profile_unless_keep_profile`.
- [ ] **Step 2:** Run `scripts/pytest-service tests/test_captcha_benchmark.py -q`. Expected: FAIL.
- [ ] **Step 3: Implement.** Reveals run one after another, cycling through the listings. Fresh mode passes no profile; saved mode uses one temp profile folder for the whole mode. Per mode, `report.json` records: attempted, skipped, success in attempt 1, success with retry, checkbox-only passes, rounds per success, lookup hit rate (lookup tiles / all decided tiles), label source counts, `try_again_later` count, reason counts, durations, gate `PASS`/`FAIL`/`INSUFFICIENT`. The report also records label, UTC start time, package version, Camoufox version, solver file hashes and the listing URLs. `report.md` is a readable summary of the same. Images go to `images/<mode>-<n>-<round>-<i>.jpg`. Each run writes to `<out>/<label>-<UTC time as YYYYMMDDTHHMMSSZ>/`. Run. Expected: PASS.
- [ ] **Step 4:** Commit `feat: add repeatable reveal benchmark with accuracy gate`.

### Task 12: Network sandbox and run commands

**Files:**
- Create: `compose.sandbox.yaml`, `Dockerfile.netlog`, `scripts/network-sandbox`, `src/auto24_service/sandbox_report.py`
- Modify: `docs/local-development.md`
- Test: `tests/test_sandbox_report.py`

**Interfaces:**
- Produces: `scripts/network-sandbox offline` and `scripts/network-sandbox live --url <listing>`; `sandbox_report.summarize(lines: Iterable[str], mode: Literal["offline", "live"]) -> SandboxReport` with `hosts: list[str]`, `unnamed_ips: list[str]`, `passed: bool`.

- [ ] **Step 1: Write failing analyzer tests** on sample tshark field lines: `test_offline_passes_with_no_outgoing_traffic`, `test_offline_fails_on_any_dns_query`, `test_live_passes_with_only_allowed_hosts`, `test_live_fails_on_extra_host`, `test_connection_without_dns_name_or_sni_fails`.
- [ ] **Step 2:** Run `scripts/pytest-service tests/test_sandbox_report.py -q`. Expected: FAIL.
- [ ] **Step 3: Implement.** `Dockerfile.netlog`: `debian:bookworm-slim` with `tshark` from Debian packages. It captures on `any` with `-T fields` for frame time, destination IP and port, DNS query names and TLS server names, writing lines to `/reports/traffic.txt`. `compose.sandbox.yaml`: `netlog` (capabilities `NET_RAW`, `NET_ADMIN`) and `capture` (the service image, `network_mode: "service:netlog"`). Offline mode puts `netlog` on an `internal: true` network and runs `pytest tests/test_fakesite.py tests/test_captcha_driver.py tests/test_reveal.py`. Live mode uses the default network and runs one `capture_listing` on `--url`, printing only statuses. `scripts/network-sandbox` builds, runs the project `auto24-sandbox`, copies the report to `sandbox-reports/<mode>-<UTC time>/`, tears down, and prints PASS or FAIL with the host list. Allowed live hosts: `www.auto24.ee`, `www.google.com`, `www.gstatic.com`. Run the tests. Expected: PASS.
- [ ] **Step 4:** Run `scripts/network-sandbox offline` yourself (it has no internet access by construction). Expected: PASS with an empty host list. Fix any Firefox background traffic with a Camoufox or Firefox preference in `open_listing` and rerun.
- [ ] **Step 5:** Add a "Registration reveal" section to `docs/local-development.md`: fetching solver files, the sandbox commands, the benchmark command (`docker compose --env-file "$HOME/.config/auto24/auto24.env" -p auto24 run --rm -v "$PWD/benchmarks:/app/benchmarks" --entrypoint python worker -m auto24_service.captcha_benchmark --mode both --listings /app/benchmarks/urls.txt --label <name>`), and where reports land.
- [ ] **Step 6:** Commit `feat: add network sandbox for capture traffic`.

### Task 13: Checkpoint evidence and handoff

**Files:**
- Create: `docs/superpowers/checkpoints/2026-10-XX-registration-reveal-s1.md` (date of completion)
- Modify: `docs/superpowers/service-roadmap.md`

- [ ] **Step 1:** Run `scripts/pytest-service -q`, `npm test`, `npm run lint`, `npm run typecheck`. Record counts in the evidence file.
- [ ] **Step 2:** Request an independent whole-branch review per the agent policy, with privacy (values never logged, allowlist, asset hashes) as the stated focus. Fix findings and rerun Step 1.
- [ ] **Step 3:** Write the evidence file: what was built, test results, offline sandbox report path, and the user's "How to check" steps from S1 with exact commands. Set S1 status in the service roadmap to "Built; user acceptance pending".
- [ ] **Step 4:** Commit `docs: deliver registration reveal checkpoint S1 for acceptance`, then open a PR with the `/pr` skill after the user says to.
- [ ] **Step 5:** Stop. The user runs the live sandbox, the benchmark and the API check, and shares the report folders. If the benchmark gate fails, stop and review approach A with the user before any further work.
