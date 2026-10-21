import { describe, expect, it } from "vitest";
import { projectDiagnostics } from "@/diagnostics/project";
import { parseApplicationEnv } from "@/config/application";
const now = "2026-10-09T12:00:10.000Z";
const records = {
  publicId: "public",
  analysisId: "analysis",
  currentRunId: "run",
  run: {
    id: "run",
    status: "running",
    created_at: "2026-10-09T12:00:00.000Z",
    completed_at: null,
  },
  snapshot: {
    imageManifest: {
      images: [
        {
          evidenceId: "b",
          selected: true,
          status: "accepted",
        },
        {
          evidenceId: "a",
          selected: true,
          status: "accepted",
        },
      ],
    },
    passes: {},
  },
  executions: [
    {
      id: "e",
      pass: "image",
      image_evidence_id: "a",
      completed_at: null,
      result_hash: null,
      reused_from_execution_id: null,
    },
  ],
  attempts: [
    {
      id: "t",
      execution_id: "e",
      job_id: "j",
      attempt_number: 1,
      state: "started",
      started_at: "2026-10-09T12:00:01.000Z",
      completed_at: null,
    },
  ],
  jobs: [
    {
      id: "j",
      stage: "enrich",
      status: "leased",
      lease_expires_at: "2026-10-09T12:00:05.000Z",
    },
  ],
  origins: [],
};
describe("diagnostic projection", () => {
  it("orders photos by manifest and marks expired attempts stale", () => {
    const data = projectDiagnostics(records, now);
    expect(data.reviews.filter((x) => x.pass === "image").map((x) => x.evidenceId)).toEqual(["b", "a"]);
    expect(data.reviews[2]!.state).toBe("stale");
    expect(data.reviews[2]!.resultAvailable).toBe(false);
  });
  it("exposes only allowlisted fields", () => {
    expect(
      JSON.stringify(
        projectDiagnostics(
          {
            ...records,
            snapshot: {
              ...records.snapshot,
              prompt: "secret",
              storageKey: "private",
            },
          },
          now,
        ),
      ),
    ).not.toContain("secret");
  });
  it("defaults feature off", () =>
    expect(
      parseApplicationEnv({
        NEXT_PUBLIC_SUPABASE_URL: "https://example.com",
        SUPABASE_SERVICE_ROLE_KEY: "x",
        ANALYSIS_COOKIE_SECRET: "x".repeat(32),
      }).LIVE_DIAGNOSTICS_ENABLED,
    ).toBe(false));
});
it("uses explicit reused provenance without new-call duration", () => {
  const data = projectDiagnostics(
    {
      ...records,
      executions: [
        {
          id: "e",
          pass: "image",
          image_evidence_id: "a",
          completed_at: "2026-10-08T12:00:00.000Z",
          result_hash: "hash",
          reused_from_execution_id: "original",
        },
      ],
      attempts: [],
      origins: [
        {
          id: "original",
          run_id: "previous",
          completed_at: "2026-10-08T12:00:00.000Z",
        },
      ],
    },
    now,
  );
  expect(data.reviews[2]).toMatchObject({
    state: "reused",
    durationMs: null,
    resultAvailable: true,
    reusedFrom: {
      runId: "previous",
      executionId: "original",
    },
  });
});
it("keeps failed attempts separate while queued for retry", () => {
  const data = projectDiagnostics(
    {
      ...records,
      attempts: [
        {
          ...records.attempts[0],
          state: "failure",
          completed_at: "2026-10-09T12:00:03.000Z",
        },
      ],
      jobs: [
        {
          id: "j",
          stage: "enrich",
          status: "queued",
          lease_expires_at: null,
        },
      ],
    },
    now,
  );
  expect(data.reviews[2]).toMatchObject({
    state: "retrying",
    durationMs: 2000,
  });
});

it("recognizes capture jobs and finite run statuses", () => {
  const snapshot = projectDiagnostics(
    { ...records, jobs: [{ id: "capture", stage: "capture_listing", status: "complete", lease_expires_at: null }] },
    now,
  );
  expect(snapshot.stages[0]?.stage).toBe("capture_listing");
});
it("does not treat an attempt owned by an earlier lease as active", () => {
  const snapshot = projectDiagnostics(
    {
      ...records,
      attempts: [{ ...records.attempts[0], worker_id: "old", job_lease_attempt: 1 }],
      jobs: [{ ...records.jobs[0], leased_by: "new", attempts: 2, lease_expires_at: "2026-10-09T12:01:00Z" }],
    },
    now,
  );
  expect(snapshot.reviews[2]?.state).toBe("stale");
  expect(snapshot.reviews[2]?.durationMs).toBeNull();
});

it("projects current state independently of a paginated attempt history", () => {
  const data = projectDiagnostics(
    {
      ...records,
      attempts: [{ ...records.attempts[0], state: "failure", completed_at: "2026-10-09T12:00:03Z" }],
      latestAttempts: [
        {
          ...records.attempts[0],
          id: "latest",
          attempt_number: 501,
          worker_id: "current",
          job_lease_attempt: 501,
          started_at: "2026-10-09T12:00:06Z",
        },
      ],
      jobs: [
        {
          ...records.jobs[0],
          status: "leased",
          leased_by: "current",
          attempts: 501,
          lease_expires_at: "2026-10-09T12:01:00Z",
        },
      ],
    },
    now,
  );
  expect(data.reviews[2]?.state).toBe("running");
  expect(data.reviews[2]?.durationMs).toBe(4000);
  expect(data.reviews[2]?.attempts[0]?.number).toBe(1);
});

it('shows capture preparation before a review snapshot exists and drops unsafe rows', () => {
  const result = projectDiagnostics({ ...records, snapshot: null, spans: [
    { id: 'span', evidence_id: 'photo', parent_id: null, phase: 'download', state: 'complete', started_at: now, completed_at: now, duration_ms: 12, error_code: null, job_lease_attempt: 1 },
    { id: 'unsafe', evidence_id: 'photo', phase: 'https://private.test?token=secret' },
  ] }, now);
  expect(result.reviews).toEqual([expect.objectContaining({ pass: 'image', evidenceId: 'photo', resultAvailable: false })]);
  expect(result.spans).toEqual([expect.objectContaining({ phase: 'download', durationMs: 12 })]);
  expect(result.availability).toMatchObject({ internalTimings: 'partial', omittedSpans: 1 });
  expect(JSON.stringify(result)).not.toContain('private.test');
});
it('retains healthy reviews when the timing table is unavailable', () => {
  const result = projectDiagnostics({ ...records, timingUnavailable: true }, now);
  expect(result.reviews).toHaveLength(4);
  expect(result.availability.internalTimings).toBe('unavailable');
});
it('bounds timing history independently of review pagination', () => {
  const result = projectDiagnostics({ ...records, spans: Array.from({length: 501}, (_,i) => ({ id: String(i), evidence_id: 'a', parent_id: null, phase: 'download', state: 'complete', started_at: now, completed_at: now, duration_ms: 1, error_code: null })) }, now);
  expect(result.spans).toHaveLength(500);
  expect(result.availability.omittedSpans).toBe(1);
  expect(result.availability.internalTimings).toBe('partial');
});

it("includes capture timings without changing reviews",()=>{const capture={availability:"available" as const,spans:[],omitted:0};const result=projectDiagnostics({...records,capture},now);expect(result.capture).toEqual(capture);expect(result.reviews).toHaveLength(4);});
