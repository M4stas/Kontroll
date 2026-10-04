import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import en from "../../../messages/en.json";
import { ReportActions } from "@/features/submission/report-actions";
const push=vi.fn();vi.mock("next/navigation",()=>({useRouter:()=>({push})}));
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.clearAllMocks();});
function view(jobId?:string){render(<NextIntlClientProvider locale="en" messages={en}><ReportActions locale="en" jobId={jobId} listingUrl="https://www.auto24.ee/soidukid/123456" /></NextIntlClientProvider>);}
describe("report entry actions",()=>{
 it("opens a private captured report with one explicit analysis request",async()=>{
 const fetch=vi.fn().mockResolvedValue({ok:true,json:async()=>({url:"/en/r/report#access=token"})});vi.stubGlobal("fetch",fetch);view("job-123");
 fireEvent.click(screen.getByRole("button",{name:"Open inspection report"}));
 await waitFor(()=>expect(push).toHaveBeenCalledWith("/en/r/report#access=token"));
 expect(fetch).toHaveBeenCalledWith("/api/listings/job-123/analysis",expect.objectContaining({method:"POST"}));
 });
 it("continues manually with buyer text without submitting a scrape",async()=>{
 const fetch=vi.fn().mockResolvedValue({ok:true,json:async()=>({url:"/en/r/manual#access=token"})});vi.stubGlobal("fetch",fetch);view();
 fireEvent.click(screen.getByRole("button",{name:"Continue manually"}));
 fireEvent.change(screen.getByRole("textbox",{name:"Listing description (optional)"}),{target:{value:"Make: Volvo"}});
 fireEvent.click(screen.getByRole("button",{name:"Start analysis"}));
 await waitFor(()=>expect(push).toHaveBeenCalledWith("/en/r/manual#access=token"));
 expect(fetch).toHaveBeenCalledTimes(1);
 expect(fetch.mock.calls[0]![0]).toBe("/api/analyses");
 expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual({locale:"en",listingUrl:"https://www.auto24.ee/soidukid/123456",pastedText:"Make: Volvo"});
 });
});
