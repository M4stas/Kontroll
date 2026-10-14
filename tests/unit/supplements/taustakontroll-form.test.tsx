import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaustakontrollForm } from "@/features/supplements/taustakontroll-form";

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

const messages = {
  Report: {
    taustakontroll: {
      heading: "Add taustakontroll PDF",
      intro: "Completed image reviews stay saved. Only the final assessment will be updated.",
      fileLabel: "Taustakontroll PDF",
      ready: "Ready to upload",
      remove: "Remove PDF",
      upload: "Upload PDF",
      uploading: "Uploading PDF",
      accepted: "PDF received. The final assessment is updating.",
      processed: "The final assessment has been updated.",
      updateFailed: "The PDF was received, but the final assessment could not be updated.",
      invalidPdf: "Choose a valid PDF file.",
      tooLarge: "The PDF must be 12 MiB or smaller.",
      uploadFailed: "The PDF could not be uploaded. Try again.",
    },
  },
};

const publicId = "22222222-2222-4222-8222-222222222222";
const initialUpdatedAt = "2026-09-19T08:00:00.000Z";

function renderForm(reportStatus: "complete" | "running" | "failed" = "complete", reportUpdatedAt = initialUpdatedAt) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <TaustakontrollForm publicId={publicId} reportStatus={reportStatus} reportUpdatedAt={reportUpdatedAt} />
    </NextIntlClientProvider>,
  );
}

function pdf(name = "taustakontroll.pdf", bytes = "%PDF-1.7") {
  return new File([bytes], name, { type: "application/pdf" });
}

describe("TaustakontrollForm", () => {
  afterEach(() => {
    cleanup();
    refresh.mockReset();
    vi.unstubAllGlobals();
  });

  it("keeps the dedicated PDF input and upload action visible with image-review preservation copy", () => {
    renderForm("complete");

    expect(screen.getByRole("heading", { name: "Add taustakontroll PDF" })).toBeVisible();
    expect(screen.getByLabelText("Taustakontroll PDF")).toHaveAttribute("accept", "application/pdf,.pdf");
    expect(screen.getByRole("button", { name: "Upload PDF" })).toBeDisabled();
    expect(screen.getByText("Completed image reviews stay saved. Only the final assessment will be updated.")).toBeVisible();
  });

  it("shows a selected filename as ready and lets the user remove it before upload", () => {
    renderForm();
    const input = screen.getByLabelText("Taustakontroll PDF");
    fireEvent.change(input, { target: { files: [pdf()] } });

    expect(screen.getByText("taustakontroll.pdf")).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("Ready to upload");
    expect(screen.getByRole("button", { name: "Upload PDF" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Remove PDF" }));
    expect(screen.queryByText("taustakontroll.pdf")).not.toBeInTheDocument();
    expect(input).toHaveValue("");
    expect(screen.getByRole("button", { name: "Upload PDF" })).toBeDisabled();
  });

  it("rejects non-PDF files before sending", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    renderForm();
    fireEvent.change(screen.getByLabelText("Taustakontroll PDF"), {
      target: { files: [new File(["text"], "report.txt", { type: "text/plain" })] },
    });

    expect(screen.getByRole("alert")).toHaveTextContent("Choose a valid PDF file.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects PDFs larger than 12 MiB before sending", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    renderForm();
    fireEvent.change(screen.getByLabelText("Taustakontroll PDF"), {
      target: { files: [new File([new Uint8Array(12 * 1024 * 1024 + 1)], "large.pdf", { type: "application/pdf" })] },
    });

    expect(screen.getByRole("alert")).toHaveTextContent("The PDF must be 12 MiB or smaller.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts only the PDF and idempotency key, then shows accepted status and refreshes the report", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 202, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);
    renderForm();
    fireEvent.change(screen.getByLabelText("Taustakontroll PDF"), { target: { files: [pdf()] } });
    fireEvent.click(screen.getByRole("button", { name: "Upload PDF" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/analyses/${publicId}/submissions`);
    expect(init.method).toBe("POST");
    const body = init.body as FormData;
    expect(body.get("idempotencyKey")).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.getAll("files")).toHaveLength(1);
    expect(body.get("files")).toBeInstanceOf(File);
    expect(body.get("sellerAnswer")).toBeNull();
    expect(body.get("listingText")).toBeNull();
    expect(body.get("listingScreenshots")).toBeNull();
    expect(await screen.findByRole("status")).toHaveTextContent("PDF received. The final assessment is updating.");
    expect(screen.queryByText("The final assessment has been updated.")).not.toBeInTheDocument();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("reuses the idempotency key for a retry of the same PDF and replaces it for a new file", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("Response lost"));
    vi.stubGlobal("fetch", fetchMock);
    renderForm();
    const input = screen.getByLabelText("Taustakontroll PDF");
    fireEvent.change(input, { target: { files: [pdf()] } });
    fireEvent.click(screen.getByRole("button", { name: "Upload PDF" }));
    await screen.findByRole("alert");
    const first = (fetchMock.mock.calls[0]![1].body as FormData).get("idempotencyKey");

    fireEvent.click(screen.getByRole("button", { name: "Upload PDF" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect((fetchMock.mock.calls[1]![1].body as FormData).get("idempotencyKey")).toBe(first);

    fireEvent.change(input, { target: { files: [pdf("replacement.pdf")] } });
    fireEvent.click(screen.getByRole("button", { name: "Upload PDF" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect((fetchMock.mock.calls[2]![1].body as FormData).get("idempotencyKey")).not.toBe(first);
  });

  it("disables the file controls and prevents duplicate requests while uploading", async () => {
    let resolve!: (value: unknown) => void;
    const fetchMock = vi.fn().mockReturnValue(new Promise((value) => { resolve = value; }));
    vi.stubGlobal("fetch", fetchMock);
    renderForm();
    fireEvent.change(screen.getByLabelText("Taustakontroll PDF"), { target: { files: [pdf()] } });
    const form = screen.getByRole("button", { name: "Upload PDF" }).closest("form")!;

    act(() => { fireEvent.submit(form); fireEvent.submit(form); });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(screen.getByLabelText("Taustakontroll PDF")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Uploading PDF" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Remove PDF" })).toBeDisabled();

    await act(async () => { resolve({ ok: true, status: 202, json: async () => ({}) }); });
    expect(screen.getByRole("button", { name: "Upload PDF" })).toBeDisabled();
  });

  it("maps an invalid PDF response to an accessible, specific error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: "The uploaded PDF cannot be read.", code: "invalid_pdf" }),
    }));
    renderForm();
    fireEvent.change(screen.getByLabelText("Taustakontroll PDF"), { target: { files: [pdf()] } });
    fireEvent.click(screen.getByRole("button", { name: "Upload PDF" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Choose a valid PDF file.");
  });

  it("marks the accepted PDF processed only after the report timestamp changes and completes", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 202, json: async () => ({}) }));
    const view = renderForm("running");
    fireEvent.change(screen.getByLabelText("Taustakontroll PDF"), { target: { files: [pdf()] } });
    fireEvent.click(screen.getByRole("button", { name: "Upload PDF" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("PDF received. The final assessment is updating."));

    view.rerender(
      <NextIntlClientProvider locale="en" messages={messages}>
        <TaustakontrollForm publicId={publicId} reportStatus="running" reportUpdatedAt="2026-09-20T09:00:00.000Z" />
      </NextIntlClientProvider>,
    );
    expect(screen.getByRole("status")).toHaveTextContent("PDF received. The final assessment is updating.");

    view.rerender(
      <NextIntlClientProvider locale="en" messages={messages}>
        <TaustakontrollForm publicId={publicId} reportStatus="complete" reportUpdatedAt="2026-09-20T09:00:00.000Z" finalReviewComplete />
      </NextIntlClientProvider>,
    );
    expect(screen.getByRole("status")).toHaveTextContent("The final assessment has been updated.");
  });

  it("does not claim the PDF was reviewed when a baseline-only report completes", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 202, json: async () => ({}) }));
    const view = renderForm("running");
    fireEvent.change(screen.getByLabelText("Taustakontroll PDF"), { target: { files: [pdf()] } });
    fireEvent.click(screen.getByRole("button", { name: "Upload PDF" }));
    await screen.findByText("PDF received. The final assessment is updating.");
    view.rerender(
      <NextIntlClientProvider locale="en" messages={messages}>
        <TaustakontrollForm publicId={publicId} reportStatus="complete" reportUpdatedAt="2026-09-20T09:00:00.000Z" />
      </NextIntlClientProvider>,
    );
    expect(screen.getByRole("status")).not.toHaveTextContent("The final assessment has been updated.");
  });

  it("shows a failed report update after an accepted upload when the report changes to failed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 202, json: async () => ({}) }));
    const view = renderForm("running");
    fireEvent.change(screen.getByLabelText("Taustakontroll PDF"), { target: { files: [pdf()] } });
    fireEvent.click(screen.getByRole("button", { name: "Upload PDF" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("PDF received. The final assessment is updating."));

    view.rerender(
      <NextIntlClientProvider locale="en" messages={messages}>
        <TaustakontrollForm publicId={publicId} reportStatus="failed" reportUpdatedAt="2026-09-20T09:00:00.000Z" />
      </NextIntlClientProvider>,
    );
    expect(screen.getByRole("status")).toHaveTextContent("The PDF was received, but the final assessment could not be updated.");
  });
});

it("uses a compact PDF label and describes the input with the preservation intro", () => {
 render(<NextIntlClientProvider locale="en" messages={messages}><TaustakontrollForm compact publicId={publicId} reportStatus="complete" reportUpdatedAt={initialUpdatedAt}/></NextIntlClientProvider>);
 expect(screen.queryByRole("heading")).toBeNull();
 expect(screen.getByLabelText("Taustakontroll PDF")).toHaveAccessibleDescription(messages.Report.taustakontroll.intro);
 cleanup();
});
