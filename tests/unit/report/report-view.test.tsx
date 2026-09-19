import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import en from "../../../messages/en.json";
import et from "../../../messages/et.json";
import { ReportView } from "@/features/report/report-view";
import { sampleReport } from "../../fixtures/sample-report";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

function renderReport(locale: "en" | "et" = "en") {
  const messages = locale === "en" ? en : et;
  return render(
    <NextIntlClientProvider locale={locale} messages={messages} timeZone="Europe/Tallinn">
      <ReportView locale={locale} report={{ ...sampleReport, locale }} />
    </NextIntlClientProvider>,
  );
}

describe("ReportView", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  // Catches a layout regression that buries the buying recommendation below detail.
  it("renders the verdict before unresolved findings and labels seller evidence", () => {
    renderReport();

    const verdict = screen.getByRole("heading", { name: "Worth a viewing" });
    const findings = screen.getByRole("heading", { name: "Still needs checking" });

    expect(
      verdict.compareDocumentPosition(findings) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getByText(/Seller claim.*Unverified/)).toBeVisible();
  });

  // Catches evidence being exposed as a dense wall or losing its original-language excerpt.
  it("reveals the original source excerpt from an accessible disclosure", () => {
    renderReport();

    const trigger = screen.getByRole("button", { name: /View evidence/ });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(trigger);

    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Hooldusraamat olemas ja auto on avariivaba.")).toBeVisible();
  });

  // Catches the copy action omitting either questions or requested images.
  it("copies one localized seller request containing questions and image requests", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    renderReport();

    fireEvent.click(screen.getByRole("button", { name: "Copy seller request" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("Questions for the seller"));
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining("When and where was the car last serviced?"),
    );
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("Requested photos"));
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining("Please send dated service-book pages"),
    );
  });

  // Catches a field checklist that cannot retain a buyer's checked state.
  it("lets the buyer check a viewing item with a touch-sized control", () => {
    renderReport();

    const checkbox = screen.getByRole("checkbox", { name: /Start the engine from cold/i });
    expect(checkbox).not.toBeChecked();
    expect(checkbox.closest("label")).toHaveClass("min-h-11");
    fireEvent.click(checkbox);
    expect(checkbox).toBeChecked();
  });

  // Catches the locale switch leaving report chrome or seller-copy headings in English.
  it("renders Estonian interface copy and copies an Estonian seller request", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    renderReport("et");

    expect(screen.getByRole("heading", { name: "Tasub vaatama minna" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Vajab veel kontrollimist" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Kopeeri päring müüjale" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("Küsimused müüjale"));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("Palutud fotod"));
  });
});
