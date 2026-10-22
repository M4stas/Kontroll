import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ListingDashboard, ListingAccessFallback, browserListingJobSchema } from "../src/features/listing/dashboard";
import { ReportActions } from "../src/features/submission/report-actions";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

const sourceUrl = "https://www.auto24.ee/soidukid/123456";

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("listing dashboard UI", () => {
  it("offers check-again recovery for a known job when the service is unavailable", () => {
    const html = renderToStaticMarkup(createElement(ListingAccessFallback, {
      locale: "en",
      jobId: "job-123",
      code: "service_auth_error",
      sourceUrl,
      onCheckAgain: vi.fn(),
    }));

    expect(html).toContain("listing service");
    expect(html).toContain("Check again");
    expect(html).toContain(`href="${sourceUrl}"`);
  });
});


describe('dashboard source recovery', () => {
  it.each(['queued', 'running', 'failed'])('retains the authenticated source URL for a %s job without captured listing data', (status) => {
    const job = browserListingJobSchema.parse({job_id: 'job-123', status, submitted_at: '2026-09-29T08:00:00Z', source_url: sourceUrl, ...(status === 'failed' ? {error: {code: 'parse_failed'}} : {})});
    expect(job.listing).toBeNull();
    expect(job.source_url).toBe(sourceUrl);
  });
});

describe("captured listing phone actions", () => {
  it("keeps captured actions in the phone bar and the manual form in page flow", () => {
    const { container } = render(
      createElement(ReportActions, {
        locale: "en",
        jobId: "job-123",
        note: createElement("p", null, "Reading the Auto24 listing"),
        phoneBottomBar: true,
      }),
    );
    const slot = container.querySelector(".phone-bottom-bar-slot");

    expect(slot).not.toBeNull();
    expect(within(slot as HTMLElement).getByRole("button", { name: "Open inspection report" })).toBeInTheDocument();
    expect(within(slot as HTMLElement).getByText("Reading the Auto24 listing")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Continue manually" }));
    const form = container.querySelector(".manual-panel");
    expect(form).toBeInTheDocument();
    expect(slot?.contains(form)).toBe(false);
  });

  it("keeps standalone manual actions out of the phone bar", () => {
    const { container } = render(createElement(ReportActions, { locale: "en", listingUrl: sourceUrl }));

    expect(container.querySelector(".phone-bottom-bar-slot")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Continue manually" }));
    expect(container.querySelector(".manual-panel")).toBeInTheDocument();
    expect(container.querySelector(".phone-bottom-bar-slot")).toBeNull();
  });
});

function dashboardJob(status: string, parsedAt = Date.now()) {
  return {job_id:"job-123",status:"completed",submitted_at:new Date(parsedAt-1000).toISOString(),parsed_at:new Date(parsedAt).toISOString(),listing:{source_url:sourceUrl,listing_id:"123456",title:"Test vehicle",registration:{reg_number:status==="revealed"?"123ABC":null,reg_number_status:status,vin:null,vin_status:"not_listed",vin_format:null}}};
}
describe("dashboard identity", () => {
  it.each(["pending","revealed","not_listed"])("renders %s identity and gates the report", async status => {
    vi.useFakeTimers(); vi.stubGlobal("fetch",vi.fn().mockResolvedValue({ok:true,json:async()=>dashboardJob(status)}));
    const {container}=render(createElement(ListingDashboard,{locale:"en",jobId:"job-123"}));
    await act(async()=>{await Promise.resolve();await Promise.resolve();});
    const identity=container.querySelector(".listing-identity")!;
    expect(identity).not.toBeNull();
    if(status==="pending") {expect(identity.querySelector(".pulse")).not.toBeNull();expect(screen.getByText("Waiting for the registration number and VIN")).toBeInTheDocument();}
    if(status==="revealed") expect(within(identity as HTMLElement).getByText("123ABC")).toBeInTheDocument();
    if(status==="not_listed") expect(within(identity as HTMLElement).getAllByText("Not found")).toHaveLength(2);
    expect(screen.getByRole("button",{name:"Open inspection report"})).toHaveProperty("disabled",status==="pending");
  });
  it("does not call the identity wait slow",async()=>{
    vi.useFakeTimers(); const body={...dashboardJob("pending"),submitted_at:new Date(Date.now()-60000).toISOString()};
    vi.stubGlobal("fetch",vi.fn().mockResolvedValue({ok:true,json:async()=>body}));
    render(createElement(ListingDashboard,{locale:"en",jobId:"job-123"}));
    await act(async()=>{await Promise.resolve();await Promise.resolve();});
    await act(async()=>{await vi.advanceTimersByTimeAsync(2000);});
    expect(screen.getByText("Waiting for the registration number and VIN")).toBeInTheDocument();
    expect(screen.queryByText("This is taking longer than usual.")).toBeNull();
  });
  it("ends the pulse and enables the report at expiry even while a later request hangs",async()=>{
    vi.useFakeTimers(); const body=dashboardJob("pending",Date.now()-118000);
    vi.stubGlobal("fetch",vi.fn().mockResolvedValueOnce({ok:true,json:async()=>body}).mockImplementation(()=>new Promise(()=>{})));
    const {container}=render(createElement(ListingDashboard,{locale:"en",jobId:"job-123"}));
    await act(async()=>{await Promise.resolve();await Promise.resolve();});
    expect(container.querySelector(".listing-identity .pulse")).not.toBeNull();
    await act(async()=>{await vi.advanceTimersByTimeAsync(2000);});
    expect(container.querySelector(".listing-identity .pulse")).toBeNull();
    expect(screen.getByRole("button",{name:"Open inspection report"})).toBeEnabled();
    expect(screen.queryByText("Waiting for the registration number and VIN")).toBeNull();
  });
});
