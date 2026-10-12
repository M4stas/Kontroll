import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, expect, it, vi } from "vitest";
import en from "../../../messages/en.json";
import { sampleReport } from "../../fixtures/sample-report";
import { EvidenceRow } from "@/features/report/evidence-row";
import { ReportView } from "@/features/report/report-view";
import type { AnalysisReport } from "@/domain/analysis";
vi.mock("next/navigation", () => ({useRouter: () => ({refresh:vi.fn()})}));
afterEach(cleanup);
const wrap = (child: React.ReactNode) => <NextIntlClientProvider locale="en" messages={en} timeZone="Europe/Tallinn">{child}</NextIntlClientProvider>;
it("keeps the PDF upload visible outside the closed full report", () => {
 render(wrap(<ReportView report={sampleReport} locale="en"/>));
 expect(screen.getByLabelText("Taustakontroll PDF").closest("details")).toBeNull();
 expect(screen.getByText("Full report").closest("details")).not.toHaveAttribute("open");
});
it("opens the supplement dialog from the row action", () => {
 const open = vi.fn(); render(wrap(<EvidenceRow report={sampleReport} diagnosticsEnabled={false} onOpenSupplement={open}/>));
 fireEvent.click(screen.getByRole("button", {name:"Add to the report"})); expect(open).toHaveBeenCalledOnce();
});
it.each([undefined, "running", "queued"] as const)("offers retry only for an incomplete idle review: %s", state => {
 const report: AnalysisReport = {...sampleReport, activity:state ? {state} : undefined, review:{state:"incomplete",text:"complete",final:"unavailable",images:{supplied:0,selected:0,complete:0,unavailable:0,skipped:0}}};
 render(wrap(<EvidenceRow report={report} diagnosticsEnabled={false} onOpenSupplement={()=>{}}/>));
 expect(screen.queryByRole("button", {name:"Retry review"}) !== null).toBe(state === undefined);
});
it("renders no row, dialog or retry when offline", () => {
 render(wrap(<ReportView report={sampleReport} locale="en" offline/>));
 expect(screen.queryByRole("region", {name:"Seller replied or new photos?"})).toBeNull();
 expect(screen.queryByRole("dialog")).toBeNull();
 expect(screen.queryByRole("button", {name:"Retry review"})).toBeNull();
 expect(within(screen.getByRole("region", {name:"Report cards"})).queryByRole("button", {name:"Seller replied"})).toBeNull();
});
