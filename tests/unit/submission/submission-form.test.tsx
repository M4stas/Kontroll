import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SubmissionForm } from "@/features/submission/submission-form";

const { push } = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

const messages = {
  Submission: {
    label: "Listing URL",
    placeholder: "https://www.auto24.ee/soidukid/123456",
    action: "Start analysis",
    pendingAction: "Starting analysis",
    explanation: "Add the listing link. The first checks start immediately.",
    invalidUrl: "Enter a secure listing URL beginning with https://.",
    requestFailed: "The analysis could not be started. Try again.",
    fallbackTitle: "This source needs more information",
    fallbackDescription:
      "Start the analysis, then add the pasted description and screenshots.",
    inspectionWaiting: "Waiting for a complete HTTPS listing address.",
    inspectionAuto24: "Auto24 recognized. The listing is ready for automatic capture.",
    inspectionFallback: "HTTPS accepted. Description and screenshots may be needed.",
    inspectionInvalid: "This address cannot be inspected. Use a complete HTTPS address.",
  },
};

function renderForm() {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <SubmissionForm locale="en" />
    </NextIntlClientProvider>,
  );
}

describe("SubmissionForm", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    push.mockReset();
  });

  it("keeps the URL as the only primary input", () => {
    renderForm();

    expect(screen.getByRole("textbox", { name: "Listing URL" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start analysis" })).toBeInTheDocument();
    expect(screen.queryByText("This source needs more information")).not.toBeInTheDocument();
  });

  it("reveals fallback guidance for another HTTPS host", () => {
    renderForm();

    fireEvent.change(screen.getByRole("textbox", { name: "Listing URL" }), {
      target: { value: "https://example.com/used-car" },
    });

    expect(screen.getByText("This source needs more information")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: /description/i })).not.toBeInTheDocument();
  });

  it("navigates to the private fragment URL returned by creation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({
          url: "/en/a/7c5ad3db-7fdb-469e-a96c-d10bc2dd5fb1#access=private-token",
        }),
      }),
    );
    renderForm();

    fireEvent.change(screen.getByRole("textbox", { name: "Listing URL" }), {
      target: { value: "https://www.auto24.ee/soidukid/123456" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start analysis" }));

    await waitFor(() =>
      expect(push).toHaveBeenCalledWith(
        "/en/a/7c5ad3db-7fdb-469e-a96c-d10bc2dd5fb1#access=private-token",
      ),
    );
  });
});
