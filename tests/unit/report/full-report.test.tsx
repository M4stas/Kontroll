import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import en from "../../../messages/en.json";
import et from "../../../messages/et.json";
import type { AnalysisReport } from "@/domain/analysis";
import { FullReport } from "@/features/report/full-report";
import { sampleReport } from "../../fixtures/sample-report";
function reportElement(locale: "en" | "et", report: AnalysisReport) {
  const messages = locale === "en" ? en : et;
  return (
    <NextIntlClientProvider locale={locale} messages={messages} timeZone="Europe/Tallinn">
      <FullReport locale={locale} report={report} />
    </NextIntlClientProvider>
  );
}

function renderReport(
  locale: "en" | "et" = "en",
  report: AnalysisReport = { ...sampleReport, locale },
) {
  const view = render(reportElement(locale, report));
  document.querySelectorAll("details").forEach((detail) => { detail.open = true; });
  return view;
}

describe("FullReport", () => {
 afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  it("hydrates a Firefox-restored photo disclosure without resetting it or warning", async () => {
    const report: AnalysisReport = {...sampleReport, review:{state:"complete",text:"complete",final:"complete",images:{supplied:1,selected:1,complete:1,unavailable:0,skipped:0,items:[{evidenceId:"photo",state:"complete"}]}}};
    const element = reportElement("en", report);
    const container = document.createElement("div");
    container.innerHTML = renderToString(element);
    document.body.append(container);
    const photos = [...container.querySelectorAll("details")].find(detail => detail.querySelector("summary")?.textContent?.startsWith("Photos:"))!;
    photos.open = true;
    const errors = vi.spyOn(console,"error").mockImplementation(() => {});
    try {
      render(element,{container,hydrate:true});
      await waitFor(() => expect(container.querySelector(".full-report")).toBeInTheDocument());
      expect(photos.open).toBe(true);
      expect(errors.mock.calls.flat().join(" ")).not.toMatch(/hydrated|hydration|didn't match/i);
    } finally { errors.mockRestore(); }
  });

  it("starts with six collapsed groups and preserves findings when opened", () => {
    render(reportElement("en", sampleReport));
    const groups = document.querySelectorAll("details[data-finding-group]");
    expect(groups).toHaveLength(6);
    expect(Array.from(groups).every(group => !group.hasAttribute("open"))).toBe(true);
    expect(document.querySelector(".full-report")).not.toHaveAttribute("open");
    const history = document.querySelector<HTMLDetailsElement>('details[data-finding-group="identity"]')!;
    expect(history).toHaveTextContent("1 finding");
    screen.getByText("Full report").closest("details")!.open = true;
    history.open = true;
    expect(screen.getAllByRole("heading", { name: sampleReport.findings[0]!.title })[0]!).toBeVisible();
    expect(screen.getAllByText(sampleReport.findings[0]!.explanation).some(item => item.closest("details")?.open || !item.closest("details"))).toBe(true);
  });

  it("keeps only uncategorized observations in Other without losing or duplicating findings", () => {
    const findings = [
      {...sampleReport.findings[0]!, id: "seat", category: "interior", title: "Seat detail", severity: "context" as const},
      {...sampleReport.findings[0]!, id: "unknown", category: "observation", title: "Additional detail", severity: "important" as const},
      {...sampleReport.findings[0]!, id: "cleared", category: "interior", title: "Cleared seat detail", state: "cleared" as const},
    ];
    render(reportElement("en", {...sampleReport, findings}));
    const other = screen.getByText("Other observations (1)").closest("details")!;
    expect(other.querySelector("article h3")).toHaveTextContent("Additional detail");
    expect(other).not.toHaveTextContent("Seat detail");
    for (const finding of findings) {
      expect(screen.getAllByRole("heading", {name: finding.title, hidden: true}).length).toBeGreaterThan(0);
    }
    expect(screen.getByText("Cleared findings (1)")).toBeInTheDocument();
  });

  it("keeps every photo hidden until the photo dropdown opens", () => {
    const report: AnalysisReport = {...sampleReport, review: {state: "running", text: "complete", final: "pending", images: {supplied: 2, selected: 2, complete: 1, unavailable: 0, skipped: 0, items: [{evidenceId: "done", state: "complete"}, {evidenceId: "active", state: "running"}]}}};
    render(reportElement("en", report));
    expect(screen.getByRole("listitem", {name: "Photo 2: Review in progress"})).not.toBeVisible();
    expect(screen.getByRole("listitem", {name: "Photo 1: Review complete"})).not.toBeVisible();
    const photos = screen.getByText("Photos: 1 of 2 reviewed").closest("details")!;
    document.querySelector<HTMLDetailsElement>(".full-report")!.open = true;
    photos.open = true;
    expect(screen.getByRole("listitem", {name: "Photo 1: Review complete"})).toBeVisible();
  });

  it("retains cleared findings in a collapsed disclosure", () => {
    render(reportElement("en", {...sampleReport, findings: [{...sampleReport.findings[0]!, state: "cleared"}]}));
    const cleared = screen.getByText("Cleared findings (1)").closest("details")!;
    expect(cleared).not.toHaveAttribute("open");
    screen.getByText("Full report").closest("details")!.open = true;
    cleared.open = true;
    expect(screen.getAllByText(sampleReport.findings[0]!.explanation).some(item => item.closest("details")?.open || !item.closest("details"))).toBe(true);
  });

  it("renders equal fact values from separate sources without a duplicate-key warning", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    renderReport("en", {
      ...sampleReport,
      vehicleFacts: [
        ...sampleReport.vehicleFacts,
        { ...sampleReport.vehicleFacts[0]!, sourceId: "registry-source" },
      ],
    });

    const output = error.mock.calls.flat().join(" ");
    expect(output).not.toContain("Encountered two children with the same key");
  });

  it("shows each photo review state and a matching authenticated thumbnail", () => {
    const states = ["complete", "running", "pending", "unavailable", "skipped"] as const;
    const evidence = states.map((state, index) => ({
      ...sampleReport.evidence[0]!,
      id: `photo-${index + 1}`,
      sourceClass: "listing" as const,
      claim: `Listing photo ${index + 1}`,
      ...(index === 0 ? { imageUrl: "/api/analyses/private/images/photo-1" } : {}),
    }));
    const report: AnalysisReport = {
      ...sampleReport,
      evidence,
      review: {
        state: "running",
        text: "complete",
        images: {
          supplied: 5,
          selected: 3,
          complete: 1,
          unavailable: 1,
          skipped: 1,
          items: states.map((state, index) => ({ evidenceId: `photo-${index + 1}`, state })),
        },
        final: "pending",
      },
    };

    renderReport("en", report);

    expect(screen.getByText("Photo review: 1 / 3")).toBeVisible();
    expect(screen.getByRole("listitem", { name: "Photo 1: Review complete" })).toBeVisible();
    expect(screen.getByRole("listitem", { name: "Photo 2: Review in progress" })).toBeVisible();
    expect(screen.getByRole("listitem", { name: "Photo 3: Waiting for review" })).toBeVisible();
    expect(screen.getByRole("listitem", { name: "Photo 4: Review unavailable" })).toBeVisible();
    expect(screen.getByRole("listitem", { name: "Photo 5: Not selected" })).toBeVisible();
    const thumbnail = screen.getByRole("img", { name: "Photo 1" });
    expect(new URL(thumbnail.getAttribute("src")!, location.href).pathname).toBe(
      "/api/analyses/private/images/photo-1",
    );
    expect(thumbnail).not.toHaveAttribute("width");
    expect(thumbnail).not.toHaveAttribute("height");
    expect(thumbnail).toHaveClass("object-contain");
    expect(thumbnail.parentElement).toHaveClass("relative", "h-36", "w-full", "sm:h-44");
    expect(screen.getByRole("listitem", { name: "Photo 2: Review in progress" })).toHaveTextContent(
      "Photo 2",
    );
  });

  it("shows a translated unavailable message when a private photo cannot load", () => {
    const report: AnalysisReport = {
      ...sampleReport,
      evidence: [
        {
          ...sampleReport.evidence[0]!,
          id: "unavailable-photo",
          imageUrl: "/api/analyses/private/images/unavailable-photo",
        },
      ],
      review: {
        state: "running",
        text: "complete",
        images: {
          supplied: 1,
          selected: 1,
          complete: 0,
          unavailable: 0,
          skipped: 0,
          items: [{ evidenceId: "unavailable-photo", state: "running" }],
        },
        final: "pending",
      },
    };

    renderReport("en", report);
    fireEvent.error(screen.getByRole("img", { name: "Photo 1" }));

    expect(screen.getByText("Photo unavailable")).toBeVisible();
    expect(screen.queryByRole("link", { name: "View photo 1" })).toBeNull();
  });
  it("lists every finding exactly once, including other and cleared ones", () => {
    const findings = [
      {...sampleReport.findings[0]!, id: "area"},
      {...sampleReport.findings[0]!, id: "other", category: "observation", title: "Additional detail"},
      {...sampleReport.findings[0]!, id: "cleared", state: "cleared" as const},
    ];
    renderReport("en", {...sampleReport, findings});
    for (const finding of findings) expect(document.querySelectorAll(`#finding-${finding.id}`)).toHaveLength(1);
  });
  it("starts closed with six closed area groups inside", () => {
    render(reportElement("en", sampleReport));
    expect(document.querySelector(".full-report")).not.toHaveAttribute("open");
    const groups = document.querySelectorAll("details[data-finding-group]");
    expect(groups).toHaveLength(6);
    for (const group of groups) expect(group).not.toHaveAttribute("open");
  });
  it("keeps photos hidden until the photo list opens", () => {
    render(reportElement("en", {...sampleReport, review: {state: "complete", text: "complete", final: "complete", images: {supplied: 1, selected: 1, complete: 1, unavailable: 0, skipped: 0, items: [{evidenceId: "photo", state: "complete"}]}}}));
    document.querySelector<HTMLDetailsElement>(".full-report")!.open = true;
    const photo = screen.getByRole("listitem", {name: "Photo 1: Review complete"});
    expect(photo).not.toBeVisible();
    screen.getByText("Photos: 1 of 1 reviewed").closest("details")!.open = true;
    expect(photo).toBeVisible();
  });
  it.each(["pending", "running", "incomplete", "disabled", "complete"] as const)("shows each finding's next check only when the review is complete: %s", state => {
    renderReport("en", {...sampleReport, review: {state, text: "complete", final: "complete", images: {supplied: 0, selected: 0, complete: 0, unavailable: 0, skipped: 0}}});
    expect(screen.queryByText(sampleReport.findings[0]!.nextAction!) !== null).toBe(state === "complete");
  });
  it("scopes report text to the report locale", () => {
    renderReport("en", {...sampleReport, locale: "et"});
    expect(screen.getByRole("heading", {name: sampleReport.findings[0]!.title})).toHaveAttribute("lang", "et");
    expect(screen.getByText(sampleReport.findings[0]!.explanation)).toHaveAttribute("lang", "et");
    expect(screen.getByText(sampleReport.findings[0]!.nextAction!)).toHaveAttribute("lang", "et");
  });

});
