import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { AnalysesRepository, walkRunLineage } from "@/server/repositories/analyses";

const analysisId = "11111111-1111-4111-8111-111111111111";
const publicId = "22222222-2222-4222-8222-222222222222";
const currentRunId = "33333333-3333-4333-8333-333333333333";
const parentRunId = "44444444-4444-4444-8444-444444444444";
const photoA = "55555555-5555-4555-8555-555555555555";
const photoB = "66666666-6666-4666-8666-666666666666";

type Row = Record<string, unknown>;
interface Query { table: string; select?: string; filters: Array<[string, string, unknown]> }

/** Records every query and answers it from in-memory tables filtered by eq/in/not-null. */
function fakeClient(tables: Record<string, Row[]>) {
  const queries: Query[] = [];
  const from = (table: string) => {
    const query: Query = { table, filters: [] };
    queries.push(query);
    let range: [number, number] | undefined;
    let single = false;
    const result = () => {
      let rows = (tables[table] ?? []).filter((row) => query.filters.every(([op, column, value]) =>
        op === "eq" ? row[column] === value
          : op === "in" ? (value as unknown[]).includes(row[column])
            : row[column] != null));
      if (range) rows = rows.slice(range[0], range[1] + 1);
      return { data: single ? rows[0] ?? null : rows, error: null };
    };
    const builder = {
      select(columns: string) { query.select = columns; return builder; },
      eq(column: string, value: unknown) { query.filters.push(["eq", column, value]); return builder; },
      in(column: string, value: unknown[]) { query.filters.push(["in", column, value]); return builder; },
      not(column: string) { query.filters.push(["not_null", column, null]); return builder; },
      order() { return builder; },
      limit() { return builder; },
      range(start: number, end: number) { range = [start, end]; return builder; },
      maybeSingle() { single = true; return builder; },
      single() { single = true; return builder; },
      then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
        return Promise.resolve(result()).then(resolve, reject);
      },
    };
    return builder;
  };
  return { client: { from } as unknown as SupabaseClient, queries };
}

const legacyReview = { state: "running", text: "complete", images: { supplied: 2, selected: 2, complete: 0, unavailable: 0, skipped: 0 }, final: "pending" };
const manifest = (images: string[]) => ({ images: images.map((evidenceId) => ({ evidenceId, selected: true, status: "accepted", storageKey: `${analysisId}/${evidenceId}.jpg` })) });

function reportTables(): Record<string, Row[]> {
  return {
    analyses: [{ id: analysisId, public_id: publicId, current_run_id: currentRunId, status: "running", locale: "en", verdict: null, confidence: null, updated_at: "2026-10-19T10:00:00.000Z", access_token_hash: "hash" }],
    analysis_runs: [
      { analysis_id: analysisId, id: currentRunId, parent_run_id: parentRunId, failure: null, review_reuse_run_id: null, stage_states: { enrich: { version: 1, status: "complete", output: { review: legacyReview } } } },
      { analysis_id: analysisId, id: parentRunId, parent_run_id: null, failure: null, review_reuse_run_id: null, stage_states: { enrich: { version: 1, status: "complete", output: { review: legacyReview } } } },
    ],
    review_run_snapshots: [
      { analysis_id: analysisId, run_id: currentRunId, snapshot_analysis_id: analysisId, snapshot_images: manifest([photoA, photoB]).images },
      { analysis_id: analysisId, run_id: parentRunId, snapshot_analysis_id: analysisId, snapshot_images: manifest([photoA]).images },
    ],
    review_executions: [
      { analysis_id: analysisId, run_id: currentRunId, pass: "image", image_evidence_id: photoB, result_hash: "b".repeat(64) },
      { analysis_id: analysisId, run_id: currentRunId, pass: "image", image_evidence_id: photoA, result_hash: null },
      { analysis_id: analysisId, run_id: parentRunId, pass: "image", image_evidence_id: photoA, result_hash: "a".repeat(64) },
    ],
    analysis_jobs: [{ analysis_id: analysisId, run_id: currentRunId, stage: "enrich", status: "queued", lease_expires_at: null }],
  };
}

describe("walkRunLineage", () => {
  it("orders a run and its ancestors newest first", () => {
    const runs = [
      { id: "root", parent_run_id: null },
      { id: "child", parent_run_id: "root" },
      { id: "grandchild", parent_run_id: "child" },
      { id: "sibling", parent_run_id: "root" },
    ];
    expect(walkRunLineage(runs, "grandchild")).toEqual(["grandchild", "child", "root"]);
    expect(walkRunLineage(runs, "root")).toEqual(["root"]);
  });

  it("rejects cycles", () => {
    expect(() => walkRunLineage([{ id: "a", parent_run_id: "b" }, { id: "b", parent_run_id: "a" }], "a"))
      .toThrow("Invalid analysis run lineage");
  });

  it("rejects chains longer than 100 runs", () => {
    const chain = (length: number) => Array.from({ length }, (_, index) => ({ id: `run-${index}`, parent_run_id: index ? `run-${index - 1}` : null }));
    expect(walkRunLineage(chain(100), "run-99")).toHaveLength(100);
    expect(() => walkRunLineage(chain(101), "run-100")).toThrow("Invalid analysis run lineage");
  });

  it("rejects a missing run or a parent outside the analysis", () => {
    expect(() => walkRunLineage([], "a")).toThrow("Could not load analysis run lineage");
    expect(() => walkRunLineage([{ id: "a", parent_run_id: "foreign" }], "a")).toThrow("Could not load analysis run lineage");
  });
});

describe("AnalysesRepository round trips", () => {
  it("loads a multi-run report with one lineage query and one review progress query", async () => {
    const { client, queries } = fakeClient(reportTables());
    const report = await new AnalysesRepository(client).loadReport(publicId);

    // Photo A finished only in the parent run; saved progress carries it into the current run.
    expect(report?.review?.images.items).toEqual([
      { evidenceId: photoA, state: "complete" },
      { evidenceId: photoB, state: "complete" },
    ]);
    expect(report?.warnings).toEqual([]);
    const lineageQueries = queries.filter((query) => query.table === "analysis_runs" && query.select === "id, parent_run_id");
    expect(lineageQueries).toHaveLength(1);
    expect(queries.filter((query) => query.table === "analysis_runs")).toHaveLength(2);
    const progress = queries.filter((query) => query.table === "review_executions");
    expect(progress).toHaveLength(1);
    expect(progress[0]!.filters).toContainEqual(["in", "run_id", [currentRunId, parentRunId]]);
    expect(queries).toHaveLength(12);
  });

  it("keeps each run's committed photos apart after batching", async () => {
    const tables = reportTables();
    tables.review_executions = tables.review_executions!.filter((row) => row.run_id === currentRunId);
    const { client } = fakeClient(tables);
    expect((await new AnalysesRepository(client).loadReport(publicId))?.review?.images.items).toEqual([
      { evidenceId: photoA, state: "pending" },
      { evidenceId: photoB, state: "complete" },
    ]);
  });

  it("reports the current run's failure from the lineage runs query", async () => {
    const tables = reportTables();
    tables.analysis_runs![0]!.failure = { code: "worker_failed" };
    const { client } = fakeClient(tables);
    expect((await new AnalysesRepository(client).loadReport(publicId))?.warnings).toEqual(["analysis_run_unavailable"]);
  });

  it("resolves a photo with three queries and only the manifest columns", async () => {
    const { client, queries } = fakeClient(reportTables());
    const image = await new AnalysesRepository(client).loadImageSource(publicId, photoA);

    expect(image).toEqual({ storageKey: `${analysisId}/${photoA}.jpg`, analysisId });
    expect(queries.map((query) => query.table)).toEqual(["analyses", "analysis_runs", "review_run_snapshots"]);
    expect(queries[2]!.select).not.toMatch(/(^|, )snapshot(,|$)/);
  });
});


describe("background update reports", () => {
  it("links the fetched PDF under the canonical official source key", async () => {
    const tables = reportTables();
    const sourceId = "77777777-7777-4777-8777-777777777777";
    tables.analysis_runs![0]!.stage_states = {...tables.analysis_runs![0]!.stage_states as object, research: {version: 1, status: "complete"}};
    tables.source_snapshots = [{id: "research-source", analysis_id: analysisId, run_id: currentRunId, source_type: "transportAdministration", extraction_status: "complete", source_url: "https://example.test/research"}, {id: sourceId, analysis_id: analysisId, run_id: currentRunId,
      source_type: "transportAdministration", extraction_status: "complete",
      source_url: null, metadata: {background_check: true, providedBy: "transpordiamet"}}];
    tables.evidence = [{id: "official-evidence", analysis_id: analysisId, run_id: currentRunId,
      source_snapshot_id: sourceId, source_class: "official_registry", producer_stage: "enrich", verification: "official"}];
    const {client} = fakeClient(tables);
    const report = await new AnalysesRepository(client).loadReport(publicId);
    expect(report?.sources.transportAdministration).toEqual({verification: "official",
      label: "Estonian Transport Administration vehicle background check", url: `/api/analyses/${publicId}/background-check/pdf`});
    expect(report?.sources["research-source"]?.url).toBe("https://example.test/research");
    expect(report?.evidence[0]).toMatchObject({sourceId, sourceUrl: `/api/analyses/${publicId}/background-check/pdf`});
  });

  it.each(["queued", "leased"])("switches activity and inherited progress to the %s background child", async (status) => {
    const tables = reportTables();
    const {client} = fakeClient(tables);
    tables.analyses![0]!.current_run_id = parentRunId;
    tables.analysis_jobs = [{analysis_id: analysisId, run_id: parentRunId, status: "complete"}];
    const repository = new AnalysesRepository(client);
    expect((await repository.loadReport(publicId))?.activity).toEqual({state: "stopped", runId: parentRunId});
    tables.analyses![0]!.current_run_id = currentRunId;
    Object.assign(tables.analysis_runs![0]!, {trigger: "background_update", review_reuse_run_id: parentRunId, stage_states: {}});
    tables.analysis_jobs!.push({analysis_id: analysisId, run_id: currentRunId, stage: "enrich", status,
      lease_expires_at: "2099-01-01T00:00:00.000Z"});
    const report = await repository.loadReport(publicId);
    expect(report?.activity).toEqual({state: status === "leased" ? "running" : "queued", runId: currentRunId,
      ...(status === "leased" ? {leaseExpiresAt: "2099-01-01T00:00:00.000Z"} : {})});
    expect(report?.review).toMatchObject({state: "pending", text: "complete", final: "pending"});
  });
});

it("hydrates the stored PDF hash for content deduplication", async () => {
  const { AnalysisUploads } = await import("@/server/storage/uploads");
  const hash = vi.spyOn(AnalysisUploads.prototype, "getStoredContentHash").mockResolvedValue("a".repeat(64));
  try {
    const tables = reportTables();
    tables.analysis_inputs = [{analysis_id: analysisId, listing_url: "https://example.test/car"}];
    tables.submissions = [{id: "pdf", analysis_id: analysisId, run_id: currentRunId, kind: "document", provided_by: "buyer", mime_type: "application/pdf", storage_key: `${analysisId}/fixture.pdf`, source_snapshot_id: "pdf-source"}];
    const {client} = fakeClient(tables);
    const context = await new AnalysesRepository(client).loadRunContext(analysisId, currentRunId, {hydrateImageCapabilities: true});
    expect(context.supplements[0]?.contentHash).toBe("a".repeat(64));
  } finally { hash.mockRestore(); }
});
