import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { JobsRepository } from "@/server/repositories/jobs";

function repository(stageStates: unknown) {
  const partialAssembly = stageStates && typeof stageStates === "object"
    ? (stageStates as { assemble_report?: { output?: { advanceToResearch?: boolean } } })
      .assemble_report?.output?.advanceToResearch === true
    : false;
  const rpc = vi.fn().mockResolvedValue({ data: partialAssembly, error: null });
  const updateQuery = {
    eq: vi.fn(),
    select: vi.fn().mockResolvedValue({ data: [{ id: "assembly-job" }], error: null }),
  };
  updateQuery.eq.mockReturnValue(updateQuery);
  const update = vi.fn().mockReturnValue(updateQuery);
  const upsert = vi.fn().mockResolvedValue({ error: null });
  const runQuery = {
    select: vi.fn(),
    eq: vi.fn(),
    maybeSingle: vi.fn().mockResolvedValue({ data: { stage_states: stageStates }, error: null }),
  };
  runQuery.select.mockReturnValue(runQuery);
  runQuery.eq.mockReturnValue(runQuery);
  const client = {
    rpc,
    from: vi.fn((table: string) => table === "analysis_runs" ? runQuery : { update, upsert }),
  } as unknown as SupabaseClient;
  return { repository: new JobsRepository(client), client, rpc, update, upsert };
}

describe("JobsRepository.enqueue", () => {
  // Catches restoring a separate run-state read before the completed-job update, which lets final persistence land between them.
  it("makes the partial-state check and assembly requeue one atomic operation", async () => {
    const test = repository({
      assemble_report: {
        version: 1,
        status: "complete",
        output: { status: "partial", advanceToResearch: true },
      },
    });

    await test.repository.enqueue({ analysisId: "analysis-1", runId: "run-1", stage: "assemble_report" });

    expect(test.rpc).toHaveBeenCalledWith("requeue_partial_assembly_job", {
      p_analysis_id: "analysis-1",
      p_run_id: "run-1",
    });
    expect(test.client.from).not.toHaveBeenCalledWith("analysis_runs");
    expect(test.update).not.toHaveBeenCalled();
  });

  // Catches an enrich retry reopening final assembly after its partial marker has been replaced by the final result.
  it("does not reopen a completed final assembly job", async () => {
    const test = repository({
      assemble_report: {
        version: 1,
        status: "complete",
        output: { status: "complete", advanceToResearch: false },
      },
    });

    await test.repository.enqueue({ analysisId: "analysis-1", runId: "run-1", stage: "assemble_report" });

    expect(test.update).not.toHaveBeenCalled();
    expect(test.upsert).toHaveBeenCalledWith(expect.objectContaining({ stage: "assemble_report" }), expect.anything());
  });

  // Catches blocking the one required requeue between the persisted partial baseline and final assembly.
  it("reopens completed assembly only while its persisted result is partial", async () => {
    const test = repository({
      assemble_report: {
        version: 1,
        status: "complete",
        output: { status: "partial", advanceToResearch: true },
      },
    });

    await test.repository.enqueue({ analysisId: "analysis-1", runId: "run-1", stage: "assemble_report" });

    expect(test.rpc).toHaveBeenCalledOnce();
    expect(test.update).not.toHaveBeenCalled();
    expect(test.upsert).not.toHaveBeenCalled();
  });

  // Catches broadening the special report requeue behavior to unrelated durable jobs.
  it("keeps non-assembly jobs on normal idempotent enqueue", async () => {
    const test = repository({});

    await test.repository.enqueue({ analysisId: "analysis-1", runId: "run-1", stage: "research" });

    expect(test.client.from).not.toHaveBeenCalledWith("analysis_runs");
    expect(test.rpc).not.toHaveBeenCalled();
    expect(test.update).not.toHaveBeenCalled();
    expect(test.upsert).toHaveBeenCalledOnce();
  });
});
