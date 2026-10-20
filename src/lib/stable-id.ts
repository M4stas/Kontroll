import { createHash } from "node:crypto";

/** Deterministic UUID-shaped identity derived from a scoped key. */
export function stableId(value: string): string {
  const hash = createHash("sha256").update(value).digest("hex");
  const variant = ((Number.parseInt(hash[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-${variant}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

/** Evidence identity of a supplement, owned by the run that accepted it. */
export function supplementEvidenceId(
  analysisId: string,
  runId: string,
  supplement: { id: string; acceptedRunId?: string },
): string {
  return stableId(`${analysisId}:${supplement.acceptedRunId ?? runId}:supplement:${supplement.id}`);
}
