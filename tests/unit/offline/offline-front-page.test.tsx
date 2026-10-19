import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SavedReportRecord } from "@/features/offline/saved-reports-db";
import { SubmissionForm } from "@/features/listing/submission-form";
vi.mock("next/navigation",()=>({useRouter:()=>({push:vi.fn()})}));
beforeEach(()=>{sessionStorage.clear(); vi.spyOn(navigator,"onLine","get").mockReturnValue(false);});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});
it("offline shows the notice and makes the form inert and aria-disabled",()=>{
 const {container}=render(<SubmissionForm locale="en"/>);
 expect(screen.getByText(/You're offline/)).toBeVisible();
 expect(container.querySelector("form")).toHaveAttribute("inert");
 expect(container.querySelector("form")).toHaveAttribute("aria-disabled","true");
});
it("the online event restores the form",()=>{
 const {container}=render(<SubmissionForm locale="en"/>);
 vi.spyOn(navigator,"onLine","get").mockReturnValue(true);
 fireEvent(window,new Event("online"));
 expect(container.querySelector("form")).not.toHaveAttribute("inert");
});
it("a submit failing with a network error shows the notice",async()=>{
 vi.spyOn(navigator,"onLine","get").mockReturnValue(true);
 vi.stubGlobal("fetch",vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
 render(<SubmissionForm locale="en"/>);
 fireEvent.change(screen.getByRole("textbox",{name:"Auto24 listing URL"}),{target:{value:"https://www.auto24.ee/soidukid/123456"}});
 fireEvent.click(screen.getByRole("button",{name:"Get listing details"}));
 await waitFor(()=>expect(screen.getByText(/You're offline/)).toBeVisible());
 fireEvent(window,new Event("online"));
 expect(screen.queryByText(/You're offline/)).toBeNull();
});
it("renders the notice in Estonian",()=>{
 render(<SubmissionForm locale="et"/>);expect(screen.getByText(/Internetiühendus puudub/)).toBeVisible();
});
it("worker boot tolerates unsupported service workers with a saved report", async () => {
 const db = await import("@/features/offline/saved-reports-db");
 const worker = await import("@/features/offline/worker-client");
 const {OfflineWorkerBoot} = await import("@/features/offline/offline-worker-boot");
 vi.spyOn(db,"listSavedReports").mockResolvedValue([{} as SavedReportRecord]);
 vi.spyOn(db,"hasLiveSavedReports").mockResolvedValue(true);
 const ensure = vi.spyOn(worker,"ensureWorker");
 render(<OfflineWorkerBoot/>);
 await waitFor(()=>expect(ensure).toHaveBeenCalledOnce());
 await expect(ensure.mock.results[0]!.value).resolves.toBeNull();
});
