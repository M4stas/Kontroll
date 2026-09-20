import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SupplementForm } from "@/features/supplements/supplement-form";

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

const messages = {
  Report: {
    supplement: {
      action: "Add seller information",
      heading: "Add seller information",
      intro: "Seller answers and files remain unverified until checked.",
      answerLabel: "Seller answer",
      answerPlaceholder: "What did the seller confirm?",
      filesLabel: "Documents or images",
      filesHint: "Add up to eight JPEG, PNG, WebP, or PDF files.",
      identityLabel: "Identity correction",
      identityNone: "No correction",
      identityVin: "VIN",
      identityPlate: "Registration plate",
      identityValueLabel: "Correct value",
      submit: "Update analysis",
      pending: "Uploading information",
      ready: "Ready",
      processing: "Processing",
      success: "Information added. The report is updating.",
      invalid: "Add an answer or at least one file.",
      tooManyFiles: "Add no more than eight files.",
      failed: "The information could not be added. Try again.",
    },
  },
};

function renderForm() {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <SupplementForm publicId="22222222-2222-4222-8222-222222222222" />
    </NextIntlClientProvider>,
  );
}

describe("SupplementForm", () => {
  afterEach(() => {
    cleanup();
    refresh.mockReset();
    vi.unstubAllGlobals();
  });

  it("reveals an unverified seller-information form after the report action", () => {
    renderForm();

    expect(screen.queryByRole("textbox", { name: "Seller answer" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add seller information" }));

    expect(screen.getByText("Seller answers and files remain unverified until checked.")).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Seller answer" })).toHaveAttribute("maxlength", "10000");
    expect(screen.getByLabelText("Documents or images")).toHaveAttribute("multiple");
  });

  it("submits a client UUID and refreshes the same report without exposing file paths", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        runId: "44444444-4444-4444-8444-444444444444",
        queuedStages: ["baseline_checks", "enrich", "assemble_report"],
        files: [{ type: "application/pdf", state: "processing" }],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    renderForm();
    fireEvent.click(screen.getByRole("button", { name: "Add seller information" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Seller answer" }), {
      target: { value: "Timing belt changed in 2024." },
    });
    fireEvent.change(screen.getByLabelText("Documents or images"), {
      target: { files: [new File(["%PDF-1.7"], "service.pdf", { type: "application/pdf" })] },
    });
    fireEvent.click(screen.getByRole("button", { name: "Update analysis" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/analyses/22222222-2222-4222-8222-222222222222/submissions");
    const body = init.body as FormData;
    expect(body.get("sellerAnswer")).toBe("Timing belt changed in 2024.");
    expect(body.get("idempotencyKey")).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.getAll("files")).toHaveLength(1);
    const fileRow = (await screen.findByText("PDF")).closest("li");
    expect(fileRow).toHaveTextContent("PDFProcessing");
    expect(screen.queryByText(/service\.pdf/)).not.toBeInTheDocument();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("rejects more than eight files before sending", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    renderForm();
    fireEvent.click(screen.getByRole("button", { name: "Add seller information" }));
    fireEvent.change(screen.getByLabelText("Documents or images"), {
      target: {
        files: Array.from({ length: 9 }, (_, index) => new File(["x"], `${index}.jpg`, { type: "image/jpeg" })),
      },
    });

    expect(screen.getByRole("alert")).toHaveTextContent("Add no more than eight files.");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
