import { DiagnosticsSnapshotSchema, type DiagnosticReview } from "./contracts";
// Internal input is intentionally separate from the public allowlisted projection.
type Row = Record<string, unknown>;
export interface DiagnosticRecords {
  publicId: string;
  analysisId: string;
  currentRunId: string | null;
  run: Row | null;
  snapshot: Row | null;
  executions: Row[];
  attempts: Row[];
  latestAttempts?: Row[];
  jobs: Row[];
  origins: Row[];
  truncated?: boolean;
}
const text = (value: unknown) => (typeof value === "string" ? value : null);
function elapsed(start: unknown, end: unknown): number | null {
  const a = Date.parse(String(start)),
    b = Date.parse(String(end));
  return Number.isFinite(a) && Number.isFinite(b) && b >= a ? b - a : null;
}
export function projectDiagnostics(records: DiagnosticRecords, serverNow: string) {
  const { snapshot, run } = records;
  const manifest =
    (
      snapshot?.imageManifest as
        | {
            images?: Array<{
              evidenceId: string;
              status: string;
              selected: boolean;
            }>;
          }
        | undefined
    )?.images ?? [];
  const passes = (snapshot?.passes ?? {}) as Record<
    string,
    {
      availability?: string;
      provider?: string;
      model?: string;
      reasoningEffort?: string;
      options?: {
        timeoutMs?: number;
        imageDetail?: "high" | "omitted";
      };
    }
  >;
  const descriptors = [
    {
      pass: "text" as const,
      evidenceId: null as string | null,
      status: "accepted",
      selected: false,
    },
    ...manifest.map((x) => ({
      pass: "image" as const,
      evidenceId: x.evidenceId,
      status: x.status,
      selected: x.selected,
    })),
    {
      pass: "final" as const,
      evidenceId: null as string | null,
      status: "accepted",
      selected: false,
    },
  ];
  const reviews: DiagnosticReview[] = snapshot
    ? descriptors.map(({ pass, evidenceId, status, selected }) => {
        const execution = records.executions.find(
          (x) => x.pass === pass && (x.image_evidence_id ?? null) === evidenceId,
        );
        const reusedId = text(execution?.reused_from_execution_id);
        const origin = records.origins.find((x) => x.id === reusedId);
        const reusedFrom =
          reusedId && origin
            ? {
                runId: String(origin.run_id),
                executionId: reusedId,
                completedAt: text(origin.completed_at),
              }
            : null;
        const projectAttempt = (x: Row) => {
          const job = records.jobs.find((j) => j.id === x.job_id);
          const owned = job?.leased_by === x.worker_id && job?.attempts === x.job_lease_attempt;
          const live =
            owned && job?.status === "leased" && Date.parse(String(job.lease_expires_at)) > Date.parse(serverNow);
          const state = x.state === "started" && !live ? "stale" : x.state;
          return {
            id: String(x.id),
            number: Number(x.attempt_number),
            state: state as DiagnosticReview["attempts"][number]["state"],
            startedAt: String(x.started_at),
            completedAt: text(x.completed_at),
            durationMs: elapsed(
              x.started_at,
              x.completed_at ?? (state === "stale" ? (owned ? job?.lease_expires_at : null) : serverNow),
            ),
            warningCode: ["timeout", "refusal", "invalid_output", "unavailable", "superseded"].includes(
              String(x.warning_code),
            )
              ? (x.warning_code as "timeout" | "refusal" | "invalid_output" | "unavailable" | "superseded")
              : null,
          };
        };
        const attempts = records.attempts
          .filter((x) => x.execution_id === execution?.id)
          .sort((a, b) => Number(a.attempt_number) - Number(b.attempt_number))
          .map(projectAttempt);
        const latestRecord = records.latestAttempts?.find((x) => x.execution_id === execution?.id);
        const latestAttempt = latestRecord ? projectAttempt(latestRecord) : (attempts.at(-1) ?? null);
        const resultAvailable = Boolean(execution?.result_hash && execution?.completed_at);
        const last = latestAttempt,
          pin = passes[pass];
        const job = records.jobs.find((x) => x.stage === "enrich");
        const state = (): DiagnosticReview["state"] => {
          if (reusedId && resultAvailable) return "reused";
          if (resultAvailable) return "complete";
          if (status === "skipped") return "skipped";
          if (status !== "accepted" || pin?.availability === "disabled" || pin?.availability === "unavailable")
            return "unavailable";
          if (last?.state === "stale") return "stale";
          if (last?.state === "started") return "running";
          if (last?.state === "failure" || last?.state === "lost")
            return job?.status === "failed" ? "failed" : "retrying";
          if (last?.state === "unavailable") return "unavailable";
          return job?.status === "failed" ? "failed" : "waiting";
        };
        return {
          key: pass + (evidenceId ? ":" + evidenceId : ""),
          executionId: text(execution?.id),
          pass,
          evidenceId,
          selected,
          state: state(),
          settings: pin
            ? {
                provider: pin.provider ?? null,
                model: pin.model ?? null,
                reasoningEffort: pin.reasoningEffort ?? null,
                timeoutMs: pin.options?.timeoutMs ?? null,
                imageDetail: pin.options?.imageDetail ?? null,
              }
            : null,
          attempts,
          latestAttempt,
          durationMs: reusedId ? null : (last?.durationMs ?? null),
          resultAvailable,
          completedAt: text(execution?.completed_at),
          reusedFrom,
        };
      })
    : [];
  return DiagnosticsSnapshotSchema.parse({
    version: 1,
    serverNow,
    owner: {
      publicId: records.publicId,
      analysisId: records.analysisId,
    },
    currentRunId: records.currentRunId,
    runId: text(run?.id),
    runs: run
      ? [
          {
            id: String(run.id),
            status: String(run.status),
            createdAt: String(run.created_at),
            completedAt: text(run.completed_at),
          },
        ]
      : [],
    stages: records.jobs.map((x) => ({
      id: String(x.id),
      stage: x.stage,
      state:
        x.status === "leased" && Date.parse(String(x.lease_expires_at)) <= Date.parse(serverNow) ? "stale" : x.status,
      leaseExpiresAt: text(x.lease_expires_at),
    })),
    reviews,
    spans: [],
    availability: {
      review: snapshot ? "available" : "not_recorded",
      internalTimings: "not_recorded",
    },
    nextCursor: null,
    truncated: records.truncated ?? false,
  });
}
