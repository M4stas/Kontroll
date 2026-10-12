import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import en from "../../../messages/en.json";
import et from "../../../messages/et.json";
import type { AnalysisReport } from "@/domain/analysis";
import { ReportView } from "@/features/report/report-view";
import { sampleReport } from "../../fixtures/sample-report";
import { runBaselineChecks } from "@/analysis/baseline-checks";
import { normalizeVehicle } from "@/analysis/normalize";
import type { ListingSnapshot } from "@/listings/adapter";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

function reportElement(locale: "en" | "et", report: AnalysisReport) {
  const messages = locale === "en" ? en : et;
  return (
    <NextIntlClientProvider locale={locale} messages={messages} timeZone="Europe/Tallinn">
      <ReportView locale={locale} report={report} />
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

describe("ReportView", () => {
  it.each(["running", "complete"] as const)("keeps the PDF upload visible before other checks for a %s report", (status) => {
    render(reportElement("en", {...sampleReport, status}));
    const upload = screen.getByRole("region", {name: "Add taustakontroll PDF"});
    expect(within(upload).getByLabelText("Taustakontroll PDF")).toBeEnabled();
    expect(upload.closest("details")).toBeNull();
    const checks = screen.getByText("All checks");
    expect(upload.compareDocumentPosition(checks) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

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
      await waitFor(() => expect(container.querySelector(".activity-journal")).toBeInTheDocument());
      expect(photos.open).toBe(true);
      expect(errors.mock.calls.flat().join(" ")).not.toMatch(/hydrated|hydration|didn't match/i);
    } finally { errors.mockRestore(); }
  });

  it("shows each primary finding as a card with its explanation in the report language", () => {
    renderReport("en", {...sampleReport, locale: "et"});
    const deck = screen.getByRole("region", {name: "Report cards"});
    expect(within(deck).getByRole("heading", {name: sampleReport.findings[0]!.title})).toHaveAttribute("lang", "et");
    expect(within(deck).getByText(sampleReport.findings[0]!.explanation)).toHaveAttribute("lang", "et");
    expect(document.querySelector(".vehicle-summary")).toHaveTextContent("Toyota Avensis · 2016 · 184,000 km");
    expect(within(deck).queryByText(sampleReport.findings[0]!.nextAction!)).toBeNull();
  });

  it("never drops a finding: every title appears on a card or below the cards", () => {
    const findings = Array.from({length: 7}, (_, index) => ({...sampleReport.findings[0]!, id: `f-${index}`, title: `Check ${index}`, state: index === 6 ? "cleared" as const : "open" as const}));
    renderReport("en", {...sampleReport, findings});
    for (const finding of findings) expect(screen.getAllByText(finding.title).length).toBeGreaterThan(0);
  });

  it("omits message and checklist cards when no actions apply", () => {
    renderReport("en", {...sampleReport, actions: []});
    expect(screen.queryByRole("heading", {name: "Send it in one message"})).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("keeps cards offline while hiding retry and upload controls", () => {
    const report: AnalysisReport = {...sampleReport, review: {state: "incomplete", text: "complete", final: "unavailable", images: {supplied: 0, selected: 0, complete: 0, unavailable: 0, skipped: 0}}};
    render(<NextIntlClientProvider locale="en" messages={en}><ReportView locale="en" report={report} offline /></NextIntlClientProvider>);
    expect(screen.getByRole("region", {name: "Report cards"})).toBeVisible();
    expect(screen.queryByRole("button", {name: /retry/i})).toBeNull();
    expect(screen.queryByRole("region", {name: "Add taustakontroll PDF"})).toBeNull();
  });

  it("opens a finding's source dialog from its card", () => {
    renderReport();
    const deck = screen.getByRole("region", {name: "Report cards"});
    fireEvent.click(within(deck).getByRole("button", {name: "Seller claim"}));
    expect(screen.getByRole("dialog")).toHaveTextContent(sampleReport.evidence[0]!.claim);
  });

  it("renders long finding text in full on its card", () => {
    const explanation = "Pikk eestikeelne tähelepanek. ".repeat(50).slice(0, 1200).trim();
    renderReport("en", {...sampleReport, locale: "et", findings: [{...sampleReport.findings[0]!, explanation}]});
    const text = within(screen.getByRole("region", {name: "Report cards"})).getByText(explanation);
    expect(text).toHaveAttribute("lang", "et");
    expect(text.className).not.toMatch(/clamp/);
    expect(text.getAttribute("style") ?? "").not.toMatch(/clamp/);
  });

  it("falls back to the area icon when the finding photo fails", () => {
    const photo = {...sampleReport.evidence[0]!, imageUrl: "/photo.jpg"};
    renderReport("en", {...sampleReport, evidence: [photo]});
    const card = document.querySelector("[data-finding-id]")!;
    fireEvent.error(within(card as HTMLElement).getByRole("img"));
    expect(card.querySelector("[data-area-icon]")).not.toBeNull();
  });

  it("shows readable captured facts while keeping the original JSON collapsed in evidence", () => {
    const claim = JSON.stringify({title: "Volkswagen Passat", year: 2005, mileageKm: 442000, otherFields: {"VIN-kood": "ABC123"}});
    renderReport("en", {...sampleReport, evidence: [{...sampleReport.evidence[0]!, claim}]});
    fireEvent.click(screen.getAllByRole("button", {name: /View evidence/})[0]!);
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("Volkswagen Passat");
    const original = screen.getByText("Original captured listing").closest("details")!;
    expect(original).not.toHaveAttribute("open");
    expect(screen.getByText(claim)).not.toBeVisible();
    original.open = true;
    expect(screen.getByText(claim)).toBeVisible();
  });

  it("starts with six collapsed groups and preserves findings when opened", () => {
    render(reportElement("en", sampleReport));
    const groups = document.querySelectorAll("details[data-finding-group]");
    expect(groups).toHaveLength(6);
    expect(Array.from(groups).every(group => !group.hasAttribute("open"))).toBe(true);
    expect(screen.getByRole("region", { name: "Report cards" })).toBeVisible();
    const history = document.querySelector<HTMLDetailsElement>('details[data-finding-group="identity"]')!;
    expect(history).toHaveTextContent("1 finding");
    screen.getByText("All checks").closest("details")!.open = true;
    history.open = true;
    expect(screen.getAllByRole("heading", { name: sampleReport.findings[0]!.title })[0]!).toBeVisible();
    expect(screen.getAllByText(sampleReport.findings[0]!.explanation).some(item => item.closest("details")?.open || !item.closest("details"))).toBe(true);
  });

  it.each([
    {category: "image_observation", title: "Seat creasing", explanation: "Leather is creased", group: "Interior"},
    {category: "image_observation", title: "Image observation", explanation: "Paint damage on the rear panel", group: "Bodywork"},
    {category: "image_observation", title: "Photo observation", explanation: "The hood and bumper are visible; the interior and mileage cannot be established.", group: "Bodywork"},
    {category: "image_observation", title: "Photo observation", explanation: "The hood and bumper are visible, but the interior and mileage cannot be established.", group: "Bodywork"},
    {category: "image_observation", title: "Photo observation", explanation: "The head-up display shows 0 km/h. However, mileage is not established.", group: "Equipment"},
    {category: "interior", title: "Seat upholstery damage", explanation: "Damage visible", group: "Interior"},
    {category: "mechanical", title: "Engine damage", explanation: "Damage visible", group: "Mechanical & servicing"},
    {category: "salong", title: "Kulunud iste", explanation: "Nähtav kulumine", group: "Interior"},
    {category: "hooldus", title: "Hoolduse tõend", explanation: "Vajab tõendit", group: "Mechanical & servicing"},
  ])("groups original findings by subject ($title)", ({category, title, explanation, group}) => {
    render(reportElement("en", {...sampleReport, findings: [{...sampleReport.findings[0]!, category, title, explanation}]}));
    const disclosure = document.querySelector<HTMLDetailsElement>(`details[data-finding-group="${({"Equipment":"equipment", "Interior":"interior", "Bodywork":"bodywork", "Mechanical & servicing":"mechanical"} as Record<string,string>)[group]}"]`)!;
    expect(disclosure).toHaveTextContent("1 finding");
    expect(disclosure.querySelector("summary")).toHaveTextContent(title);
    disclosure.open = true;
    expect(within(disclosure).getByText(explanation)).toBeInTheDocument();
  });

  it.each([
    ["Speaker grille", "equipment"], ["Infotainment display", "equipment"],
    ["Rear camera", "equipment"], ["Exterior lighting", "equipment"],
    ["Tailgate alignment", "bodywork"], ["Rear bumper", "bodywork"],
    ["Quarter panel paint", "bodywork"], ["Door pull trim", "interior"],
    ["Seat creasing", "interior"], ["Technical-check report", "mileage"],
    ["Transmission service", "mechanical"], ["VIN identity", "identity"],
    ["Instrument cluster displays 121,105 km", "mileage"],
    ["Dashboard display matches listed mileage", "mileage"],
    ["Door-open status visible in instrument cluster", "equipment"],
    ["Streaked pattern on dashboard trim; finish unclear", "interior"],
    ["Gear-selector surface is worn", "interior"],
    ["No report is provided for stated technical check", "mileage"],
    ["Registration and import details are not supported by supplied documents", "identity"],
    ["Registration and import details are listing claims only", "identity"],
    ["Red vehicle-shaped indicator is visible in the instrument cluster", "equipment"],
    ["Red indicator visible in instrument cluster", "equipment"],
  ])("categorizes context checks by their subject: %s", (title, group) => {
    const finding = {...sampleReport.findings[0]!, category: "image_observation", title,
      severity: "context" as const, explanation: "Photo lighting prevents verifying paint, mileage, or service history.",
      evidenceIds: ["context-photo"]};
    render(reportElement("en", {...sampleReport, findings: [finding], evidence: [
      {...sampleReport.evidence[0]!, id: "context-photo", imageUrl: "/api/analyses/private/images/context-photo"},
    ]}));
    const disclosure = document.querySelector(`details[data-finding-group="${group}"]`)!;
    expect(disclosure).toHaveTextContent("1 finding");
    expect(disclosure).toHaveTextContent("1 photo");
    expect(disclosure.querySelector("article h3")).toHaveTextContent(title);
    expect(screen.queryByText(/Other observations/)).toBeNull();
  });

  it.each([
    {title: "Front bumper visible; mileage cannot be verified", explanation: "Visible bumper", group: "bodywork"},
    {title: "Head-up display shows 0 km/h", explanation: "Visible display", group: "equipment"},
    {title: "Underbody surface marks", explanation: "Visible surface marks", group: "bodywork"},
    {title: "Lower-body condition", explanation: "Visible surface marks", group: "bodywork"},
    {title: "Towbar detail", explanation: "Visible surface marks", group: "bodywork"},
    {title: "Front and side surfaces", explanation: "Visible surface marks", group: "bodywork"},
    {title: "Body-style appearance", explanation: "Visible surface marks", group: "bodywork"},
    {title: "Dashboard condition", explanation: "Visible surface marks", group: "equipment"},
    {title: "Battery-shaped indicator", explanation: "Visible indicator", group: "equipment"},
    {title: "Comfort controls", explanation: "Visible controls", group: "equipment"},
    {title: "Cargo-area carpet", explanation: "Visible surface marks", group: "interior"},
    {title: "Photo shows only a limited dashboard view", explanation: "The head-up display shows 0 km/h; interior condition is not established.", group: "equipment"},
    {title: "Front view only; no obvious damage discernible", explanation: "The hood and bumper are visible; the interior and mileage cannot be established.", group: "bodywork"},
  ])("categorizes generic stored photo titles without interpreting caveats: $title", ({title, explanation, group}) => {
    render(reportElement("en", {...sampleReport, findings: [{...sampleReport.findings[0]!,
      category: "photo_check", severity: "context", title, explanation}]}));
    const disclosure = document.querySelector(`details[data-finding-group="${group}"]`)!;
    expect(disclosure.querySelector("article h3")).toHaveTextContent(title);
    expect(screen.queryByText(/Other observations/)).toBeNull();
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
    photos.open = true;
    expect(screen.getByRole("listitem", {name: "Photo 1: Review complete"})).toBeVisible();
  });

  it("retains cleared findings in a collapsed disclosure", () => {
    render(reportElement("en", {...sampleReport, findings: [{...sampleReport.findings[0]!, state: "cleared"}]}));
    const cleared = screen.getByText("Cleared findings (1)").closest("details")!;
    expect(cleared).not.toHaveAttribute("open");
    screen.getByText("All checks").closest("details")!.open = true;
    cleared.open = true;
    expect(screen.getAllByText(sampleReport.findings[0]!.explanation).some(item => item.closest("details")?.open || !item.closest("details"))).toBe(true);
  });

  it("limits distinct default review paragraphs to three and collapses secondary sections", () => {
    const findings = Array.from({length: 5}, (_, index) => ({...sampleReport.findings[0]!, id: `finding-${index}`, title: `Check title ${index}`, nextAction: `Check ${index}`}));
    render(reportElement("en", {...sampleReport, findings}));
    expect(screen.getByRole("region", {name: "Report cards"}).querySelectorAll("[data-finding-id]")).toHaveLength(3);
    for (const title of ["Listing & methodology"]) {
      expect(screen.getByText(title).closest("details")).not.toHaveAttribute("open");
    }
  });

  it.each([
    { locale: "en" as const, labels: ["Make", "Model", "Gearbox", "Power", "Drivetrain"] },
    { locale: "et" as const, labels: ["Mark", "Mudel", "Käigukast", "Võimsus", "Veoskeem"] },
  ])("translates captured listing fact keys in $locale", ({ locale, labels }) => {
    const capturedFacts = [
      { key: "make", value: "Toyota" },
      { key: "model", value: "Avensis" },
      { key: "gearbox", value: "Automaat" },
      { key: "power", value: "110" },
      { key: "drivetrain", value: "Esivedu" },
    ].map((fact) => ({
      ...sampleReport.vehicleFacts[0]!,
      ...fact,
      sourceId: "listing-source",
    }));

    renderReport(locale, { ...sampleReport, locale, vehicleFacts: capturedFacts });

    for (const label of labels) {
      expect(screen.getByText(label, { selector: "dt" })).toBeVisible();
    }
    expect(screen.getByText("110 kW", { selector: "dd" })).toBeVisible();
  });
  it("retries an incomplete review at the existing private report", async () => {
    const fetch=vi.fn().mockResolvedValue({ok:true});vi.stubGlobal("fetch",fetch);
    const failedReport: AnalysisReport = {...sampleReport,review:{state:"incomplete",text:"unavailable",images:{supplied:0,selected:0,complete:0,unavailable:0,skipped:0},final:"unavailable"}};
    const {rerender} = renderReport("en", failedReport);
    fireEvent.click(screen.getByRole("button",{name:"Retry review"}));
    await waitFor(()=>expect(fetch).toHaveBeenCalledWith(`/api/analyses/${sampleReport.publicId}/retry`, {method:"POST"}));
    expect(await screen.findByRole("button",{name:"Review queued"})).toBeDisabled();
    rerender(reportElement("en", {...failedReport,updatedAt:new Date(Date.parse(failedReport.updatedAt)+1000).toISOString()}));
    expect(screen.getByRole("button",{name:"Retry review"})).toBeEnabled();
  });

  it.each(["running", "queued"] as const)("does not offer retry while incomplete work is %s", state => {
    renderReport("en", {...sampleReport, status:"partial", activity:{state, ...(state === "running" ? {leaseExpiresAt:"2099-01-01T00:00:00Z"} : {})}, review:{state:"incomplete",text:"complete",images:{supplied:2,selected:2,complete:1,unavailable:1,skipped:0},final:"pending"}});
    expect(screen.queryByRole("button",{name:"Retry review"})).not.toBeInTheDocument();
  });

  it("shows translated incomplete review progress without provider warnings", () => {
    renderReport("et", {...sampleReport, warnings:["private_provider_error"], review:{state:"incomplete",text:"complete",images:{supplied:2,selected:2,complete:1,unavailable:1,skipped:0},final:"unavailable"}});
    expect(screen.getByText("Tehisintellekti ülevaatus jäi poolikuks. Esialgsed kontrollid on alles.")).toBeVisible();
    expect(screen.getByText(/Teksti ülevaatus:/)).toBeVisible();
    expect(screen.getByText("Fotode ülevaatus: 1 / 2")).toBeVisible();
    expect(screen.queryByText("private_provider_error")).toBeNull();
  });

  it("copies seller instructions generated by an Estonian deterministic report", async () => {
    const source: ListingSnapshot = {
      type: "snapshot", marketplace: "fallback", sourceId: "buyer-listing", sourceUrl: "https://www.auto24.ee/soidukid/123456",
      capturedAt: "2026-09-25T09:00:00.000Z", contentHash: "et-fallback", description: "Suurhooldus tehtud.",
      imageUrls: [], screenshotRefs: [], facts: [], warnings: [],
      claims: [{ text: "Suurhooldus tehtud.", sourceClass: "seller", verification: "unverified" }],
    };
    const baseline = runBaselineChecks(normalizeVehicle(source), source, "et");
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    renderReport("et", { ...sampleReport, locale: "et", findings: baseline.findings,
      evidence: baseline.evidence, actions: baseline.actions });
    expect(screen.getAllByRole("heading", { name: "Suure hoolduse väide vajab tõendit" })[0]!).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Kopeeri päring müüjale" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("Palu müüjal saata arved või hooldusdokumendid"));
    expect(writeText).not.toHaveBeenCalledWith(expect.stringContaining("Ask the seller"));
  });
  it("shows confirmed conflicts that drive a skip verdict", () => {
    const finding = { ...sampleReport.findings[0]!, id: "confirmed-conflict", state: "confirmed" as const, title: "Listing VINs disagree" };
    renderReport("en", { ...sampleReport, verdict: "likely_skip", findings: [finding] });
    expect(screen.getAllByRole("heading", { name: "Listing VINs disagree" })[0]!).toBeVisible();
  });
  it("places the seller-information action after the existing inspection report", () => {
    renderReport();

    const action = screen.getByRole("button", { name: "Add seller information" });
    const report = document.querySelector("article");
    expect(report).not.toBeNull();
    expect((report?.compareDocumentPosition(action) ?? 0) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // Catches a layout regression that buries the buying recommendation below detail.
  it("renders the verdict before unresolved findings and labels seller evidence", () => {
    renderReport();

    const verdict = screen.getByRole("heading", { name: "Worth a viewing" });
    const findings = screen.getByRole("heading", { name: "Still needs checking" });

    expect(
      verdict.compareDocumentPosition(findings) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", {name: /View evidence/})[0]!);
    expect(screen.getByRole("dialog")).toHaveTextContent(/Seller claim.*Unverified/);
  });

  // Catches evidence being exposed as a dense wall or losing its original-language excerpt.
  it("reveals the original source excerpt from an accessible disclosure", () => {
    renderReport();

    const trigger = screen.getAllByRole("button", { name: /View evidence/ })[0]!;
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(trigger);

    expect(screen.getByRole("dialog", { name: "View evidence" })).toBeVisible();
    expect(screen.getByText("Hooldusraamat olemas ja auto on avariivaba.")).toBeVisible();
  });

  // Catches the copy action omitting either questions or requested images.
  it("includes each exact seller instruction once in the visible and copied request", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const question = sampleReport.actions.find(action => action.kind === "seller_question")!;
    const request = sampleReport.actions.find(action => action.kind === "photo_request")!;
    renderReport("en", {...sampleReport, actions: [question, {...question, id: "duplicate-question"}, request, {...request, id: "duplicate-request"}]});
    expect(screen.getByRole("textbox", {name: "Send it in one message"})).toHaveValue(`Questions for the seller\n- ${question.instructions}\n\nRequested photos\n- ${request.instructions}`);
    fireEvent.click(screen.getByRole("button", {name: "Copy seller request"}));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0]![0]).toBe(`Questions for the seller\n- ${question.instructions}\n\nRequested photos\n- ${request.instructions}`);
  });

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

  it("shows inspection actions as checklist rows and counts ticks", () => {
    renderReport();
    expect(screen.getByText("Cold start")).toBeVisible();
    expect(screen.getByText("0 of 1 checked")).toBeVisible();
    fireEvent.click(screen.getByRole("checkbox"));
    expect(screen.getByText("1 of 1 checked")).toBeVisible();
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

  it("localizes progress and captured listing controls without relabeling saved content", () => {
    const claim = JSON.stringify({title: "Volkswagen Passat", year: 2005, mileageKm: 442000,
      firstRegistration: "2005-03", price: {amount: 2400, currency: "EUR"},
      otherFields: {"VIN-kood": "ABC123", "Reg. number": "123ABC", status: "Registered",
        "brought from": "Germany", location: "Tartu"}});
    const report: AnalysisReport = {
      ...sampleReport,
      status: "partial",
      evidence: [{...sampleReport.evidence[0]!, claim}],
      activity: {state: "stopped"},
      review: {state: "incomplete", text: "complete", final: "unavailable",
        images: {supplied: 3, selected: 3, complete: 1, unavailable: 1, skipped: 0}},
    };
    renderReport("et", report);

    expect(screen.getByRole("region", {name: "Raporti kaardid"})).toBeVisible();
    expect(screen.getByRole("region", {name: "Ülevaatuse edenemine"})).toBeVisible();
    expect(screen.getByText("1 / 3 üle vaadatud · 1 pole saadaval")).toBeVisible();
    expect(screen.getByText("Kõik kontrollid")).toBeVisible();
    expect(screen.getByText("Sõiduk")).toBeVisible();

    fireEvent.click(screen.getAllByRole("button", {name: "Vaata tõendeid"})[0]!);
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("Esmane registreerimine");
    expect(dialog).toHaveTextContent("Registreerimisnumber");
    expect(dialog).toHaveTextContent("Registered");
    expect(dialog).toHaveTextContent("Germany");
    expect(dialog).toHaveTextContent("Asukoht");
    expect(dialog).toHaveTextContent("Volkswagen Passat");
    expect(screen.getByRole("button", {name: "Sulge tõendid"})).toBeVisible();
    expect(screen.getByText("Volkswagen Passat").closest("dd")).toHaveAttribute("lang", "en");
    expect(screen.getByText("Germany").closest("dd")).toHaveAttribute("lang", "en");
  });

  // Catches persisted Estonian report content being pronounced as active English UI chrome.
  it("scopes report-authored content to the report locale when the UI locale differs", () => {
    renderReport("en", { ...sampleReport, locale: "et" });

    expect(
      screen.getByRole("heading", { name: "Worth a viewing" }).closest("article"),
    ).toHaveAttribute("lang", "en");
    expect(
      screen.getAllByRole("heading", { name: "Service history is claimed but not documented" })[0]!,
    ).toHaveAttribute("lang", "et");
    expect(
      screen.getAllByText("The listing mentions a service book, but no dated pages are visible.")[0]!,
    ).toHaveAttribute("lang", "et");
    expect(screen.getByText("Cold start").parentElement).toHaveAttribute("lang", "et");
  });

  // Catches route-localized seller headings being mislabeled as report-authored content.
  it("keeps seller headings outside report-locale instruction controls", () => {
    renderReport("en", { ...sampleReport, locale: "et" });

    const heading = screen.getByRole("heading", {name: "Send it in one message"});
    expect(heading.closest('[lang="et"]')).toBeNull();
    const message = screen.getByRole("textbox", {name: "Send it in one message"});
    expect(message).toHaveAttribute("lang", "et");
    expect((message as HTMLTextAreaElement).value).toContain("When and where was the car last serviced?");
  });

  // Catches evidence text being relabeled as the active route locale after a locale switch.
  it("scopes evidence claim and applicability to the persisted report locale", () => {
    renderReport("en", { ...sampleReport, locale: "et" });

    fireEvent.click(screen.getAllByRole("button", { name: /View evidence/ })[0]!);

    expect(screen.getByText("Hooldusraamat olemas ja auto on avariivaba.")).toHaveAttribute(
      "lang",
      "et",
    );
    expect(screen.getByText("The listing describes this vehicle directly.")).toHaveAttribute(
      "lang",
      "et",
    );
  });

  // Catches browsers without Clipboard API support failing silently or throwing from the click handler.
  it("shows retry guidance when the Clipboard API is unavailable", async () => {
    vi.stubGlobal("navigator", { ...navigator, clipboard: undefined });
    renderReport();

    fireEvent.click(screen.getByRole("button", { name: "Copy seller request" }));

    expect(
      await screen.findByText(
        "Could not copy. Select all text in the field below and copy it manually.",
      ),
    ).toBeVisible();
  });

  // Catches clipboard permission or platform rejection escaping without visible recovery.
  it("shows retry guidance when clipboard writing is rejected", async () => {
    const writeText = vi.fn().mockRejectedValue(new DOMException("Denied", "NotAllowedError"));
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    renderReport();

    fireEvent.click(screen.getByRole("button", { name: "Copy seller request" }));

    expect(
      await screen.findByText(
        "Could not copy. Select all text in the field below and copy it manually.",
      ),
    ).toBeVisible();
  });

  // Catches a successful state describing stale clipboard content after progressive report changes.
  it("resets copied state when the composed seller message changes", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const view = renderReport();
    fireEvent.click(screen.getByRole("button", { name: "Copy seller request" }));
    await screen.findByRole("button", { name: "Seller request copied" });

    const changedReport = {
      ...sampleReport,
      actions: sampleReport.actions.map((action) =>
        action.id === "ask-history"
          ? { ...action, instructions: "Please confirm the latest service date." }
          : action,
      ),
    };
    view.rerender(reportElement("en", changedReport));

    expect(screen.getByRole("button", { name: "Copy seller request" })).toBeVisible();
  });

  // Catches manual recovery differing from the attempted payload or surviving a message change.
  it("shows the exact failed payload for manual copy and resets it when the message changes", async () => {
    const writeText = vi.fn().mockRejectedValue(new DOMException("Denied", "NotAllowedError"));
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const view = renderReport();
    fireEvent.click(screen.getByRole("button", { name: "Copy seller request" }));

    const attemptedMessage =
      "Questions for the seller\n- When and where was the car last serviced?\n\n" +
      "Requested photos\n- Please send dated service-book pages and the VIN page.";
    const fallback = await screen.findByRole("textbox", {
      name: "Seller request for manual copy",
    });
    expect(writeText).toHaveBeenCalledWith(attemptedMessage);
    expect(fallback).toBeVisible();
    expect(fallback).toHaveValue(attemptedMessage);
    expect(fallback).toHaveAttribute("lang", "");

    const changedReport = {
      ...sampleReport,
      actions: sampleReport.actions.map((action) =>
        action.id === "request-book"
          ? { ...action, instructions: "Please send a clear VIN photo." }
          : action,
      ),
    };
    view.rerender(reportElement("en", changedReport));

    expect(
      screen.queryByText(
        "Could not copy. Select all text in the field below and copy it manually.",
      ),
    ).toBeNull();
    expect(
      screen.queryByRole("textbox", { name: "Seller request for manual copy" }),
    ).toBeNull();
  });

  // Catches React receiving duplicate fact keys when equal facts come from separate sources.
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

  it.each(["pending", "running", "incomplete", "disabled"] as const)(
    "hides recommendations while evidence review is %s",
    (state) => {
      const report: AnalysisReport = {
        ...sampleReport,
        review: {
          state,
          text: "complete",
          images: { supplied: 0, selected: 0, complete: 0, unavailable: 0, skipped: 0 },
          final: "unavailable",
        },
      };

      renderReport("en", report);

      expect(screen.queryByRole("heading", { name: "Worth a viewing" })).toBeNull();
      expect(screen.queryByText("Confidence: moderate")).toBeNull();
      expect(screen.getAllByRole("heading", { name: "Service history is claimed but not documented" })[0]!).toBeVisible();
      expect(screen.queryByText("Next check")).toBeNull();
      expect(screen.queryByRole("heading", { name: "Send it in one message" })).toBeNull();
      expect(screen.queryByText("Cold start")).toBeNull();
    },
  );

  it("keeps legacy recommendations available only for a complete analysis", () => {
    renderReport("en", { ...sampleReport, status: "queued", review: undefined });
    expect(screen.queryByRole("heading", { name: "Worth a viewing" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Send it in one message" })).toBeNull();

    cleanup();
    renderReport("en", { ...sampleReport, status: "complete", review: undefined });
    expect(screen.getByRole("heading", { name: "Worth a viewing" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Send it in one message" })).toBeVisible();
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

  it("shows the finding explanation with its cited photo and uses the authenticated photo URL", () => {
    const photo = {
      ...sampleReport.evidence[0]!,
      id: "cited-photo",
      sourceClass: "listing" as const,
      claim: "The rear panel is visible in the listing photo.",
      imageUrl: "/api/analyses/private/images/cited-photo",
    };
    const finding = {
      ...sampleReport.findings[0]!,
      evidenceIds: [photo.id],
      explanation: "The rear panel appears uneven around the wheel arch.",
    };

    renderReport("en", { ...sampleReport, evidence: [photo], findings: [finding] });
    fireEvent.click(screen.getAllByRole("button", { name: /View evidence/ })[0]!);

    expect(screen.getByText("Issue description")).toBeVisible();
    expect(screen.getByRole("dialog")).toHaveTextContent(finding.explanation);
    expect(
      new URL(screen.getByRole("img", { name: "Photo 1" }).getAttribute("src")!, location.href)
        .pathname,
    ).toBe(photo.imageUrl);
    expect(screen.getByRole("figure", { name: "Photo 1" })).toBeVisible();
    expect(screen.queryByRole("link", { name: "Open source" })).toBeNull();
  });

  it("retains generic links for non-image evidence sources", () => {
    renderReport();
    fireEvent.click(screen.getAllByRole("button", { name: /View evidence/ })[0]!);

    expect(screen.getByRole("link", { name: "Open source" })).toHaveAttribute(
      "href",
      "https://www.auto24.ee/soidukid/123456",
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
});
