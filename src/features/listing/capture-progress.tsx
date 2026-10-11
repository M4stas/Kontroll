import type { ReactNode } from "react";
import { captureSteps } from "./capture-steps";
import { listingText, type Locale } from "./messages";

export function CaptureProgress({ locale, status, children, "data-state": state = status ?? "running" }: {
  locale: Locale;
  status: "queued" | "running" | "completed" | "failed" | null;
  children: ReactNode;
  "data-state"?: string;
}) {
  const steps = captureSteps(status);
  const labels = ["stepRequest", "stepReading", "stepReady"] as const;
  return (
    <section className="capture-progress" aria-label={listingText(locale, "checking")} data-state={state}>
      <ol className="capture-steps">
        {labels.map((label, index) => (
          <li key={label} data-state={steps[index]} aria-current={steps[index] === "active" || steps[index] === "failed" ? "step" : undefined}>
            <span className="capture-step-bar" aria-hidden="true" />
            {listingText(locale, label)}
          </li>
        ))}
      </ol>
      {children}
    </section>
  );
}
