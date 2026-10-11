export type CaptureStepState = "waiting" | "active" | "done" | "failed";

export function captureSteps(
  status: "queued" | "running" | "completed" | "failed" | null,
): [CaptureStepState, CaptureStepState, CaptureStepState] {
  switch (status) {
    case "running":
      return ["done", "active", "waiting"];
    case "completed":
      return ["done", "done", "done"];
    case "failed":
      return ["done", "failed", "waiting"];
    default:
      return ["active", "waiting", "waiting"];
  }
}
