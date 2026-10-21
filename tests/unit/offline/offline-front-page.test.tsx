import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

const LISTING = "https://www.auto24.ee/soidukid/123456";
const JOB = "12345678-1234-1234-1234-123456789abc";
type Init = RequestInit | undefined;
function serverFetch(probe: (init: Init) => Promise<Response>) {
 return vi.fn((_input: RequestInfo | URL, init?: RequestInit) => init?.method === "HEAD" ? probe(init) : Promise.reject(new TypeError("Failed to fetch")));
}
const probes = (fetcher: ReturnType<typeof serverFetch>) => fetcher.mock.calls.filter(([, init]) => init?.method === "HEAD");
const posts = (fetcher: ReturnType<typeof serverFetch>) => fetcher.mock.calls.filter(([, init]) => init?.method === "POST");
async function tick(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
async function failSubmit(fetcher: ReturnType<typeof serverFetch>) {
 vi.useFakeTimers();
 vi.spyOn(navigator,"onLine","get").mockReturnValue(true);
 vi.stubGlobal("fetch",fetcher);
 const view=render(<SubmissionForm locale="en"/>);
 fireEvent.change(screen.getByRole("textbox",{name:"Auto24 listing URL"}),{target:{value:LISTING}});
 fireEvent.click(screen.getByRole("button",{name:"Get listing details"}));
 await tick(0);
 expect(screen.getByText(/You're offline/)).toBeVisible();
 return view;
}
describe("automatic reconnect", () => {
 afterEach(()=>{vi.useRealTimers();});
 it("probes the server every three seconds and shows no retry button", async () => {
  const fetcher = serverFetch(() => Promise.reject(new TypeError("Failed to fetch")));
  const {container} = await failSubmit(fetcher);
  expect(screen.queryByRole("button",{name:/connection/i})).toBeNull();
  await tick(2_999);
  expect(probes(fetcher)).toHaveLength(0);
  await tick(1);
  expect(probes(fetcher)).toHaveLength(1);
  expect(fetcher).toHaveBeenLastCalledWith("/sw.js", expect.objectContaining({method:"HEAD",cache:"no-store"}));
  expect(container.querySelector("form")).toHaveAttribute("inert");
  await tick(3_000);
  expect(probes(fetcher)).toHaveLength(2);
  expect(container.querySelector("form")).toHaveAttribute("inert");
  expect(posts(fetcher)).toHaveLength(1);
 });
 it("restores the form after a successful probe without an online event or a resubmit", async () => {
  const fetcher = serverFetch(() => Promise.resolve(new Response(null,{status:200})));
  const {container} = await failSubmit(fetcher);
  expect(screen.getByRole("alert")).toBeVisible();
  await tick(3_000);
  expect(container.querySelector("form")).not.toHaveAttribute("inert");
  expect(screen.queryByText(/You're offline/)).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  await tick(9_000);
  expect(probes(fetcher)).toHaveLength(1);
  expect(posts(fetcher)).toHaveLength(1);
 });
 it("keeps the form disabled when the probe gets an error response", async () => {
  const fetcher = serverFetch(() => Promise.resolve(new Response(null,{status:503})));
  const {container} = await failSubmit(fetcher);
  await tick(3_000);
  expect(probes(fetcher)).toHaveLength(1);
  expect(container.querySelector("form")).toHaveAttribute("inert");
 });
 it("submits normally again after recovery", async () => {
  let serverUp = false;
  const fetcher = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
   if (!serverUp) return Promise.reject(new TypeError("Failed to fetch"));
   return Promise.resolve(init?.method === "HEAD" ? new Response(null,{status:200}) : Response.json({jobId:JOB}));
  });
  await failSubmit(fetcher);
  serverUp = true;
  await tick(3_000);
  fireEvent.click(screen.getByRole("button",{name:"Get listing details"}));
  await tick(0);
  expect(posts(fetcher)).toHaveLength(2);
  expect(screen.queryByRole("alert")).toBeNull();
 });
 it("does not probe before a failure or while the browser reports offline", async () => {
  vi.useFakeTimers();
  vi.spyOn(navigator,"onLine","get").mockReturnValue(true);
  const idle = vi.fn();
  vi.stubGlobal("fetch",idle);
  const view = render(<SubmissionForm locale="en"/>);
  await tick(10_000);
  expect(idle).not.toHaveBeenCalled();
  view.unmount();
  const fetcher = serverFetch(() => Promise.reject(new TypeError("Failed to fetch")));
  await failSubmit(fetcher);
  vi.spyOn(navigator,"onLine","get").mockReturnValue(false);
  fireEvent(window,new Event("offline"));
  await tick(10_000);
  expect(probes(fetcher)).toHaveLength(0);
 });
 it("aborts a hung probe and tries again without overlapping", async () => {
  const signals: AbortSignal[] = [];
  const fetcher = serverFetch((init) => new Promise((_resolve, reject) => {
   const signal = init!.signal!;
   signals.push(signal);
   signal.addEventListener("abort", () => reject(new DOMException("Aborted","AbortError")));
  }));
  await failSubmit(fetcher);
  await tick(3_000);
  expect(probes(fetcher)).toHaveLength(1);
  await tick(3_000);
  expect(signals[0]!.aborted).toBe(true);
  expect(probes(fetcher)).toHaveLength(2);
 });
 it("never starts a second probe while one is still running", async () => {
  const fetcher = serverFetch(() => new Promise(() => {}));
  await failSubmit(fetcher);
  await tick(9_000);
  expect(probes(fetcher)).toHaveLength(1);
 });
 it("ignores a probe that answers after the form already recovered", async () => {
  let answer: (response: Response) => void = () => {};
  const fetcher = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
   if (init?.method === "HEAD") return new Promise<Response>((resolve) => { answer = resolve; });
   if (posts(fetcher).length === 1) return Promise.reject(new TypeError("Failed to fetch"));
   return Promise.resolve(Response.json({error:{code:"forbidden"}},{status:403}));
  });
  await failSubmit(fetcher);
  await tick(3_000);
  expect(probes(fetcher)).toHaveLength(1);
  fireEvent(window,new Event("online"));
  fireEvent.click(screen.getByRole("button",{name:"Get listing details"}));
  await tick(0);
  const newer = screen.getByRole("alert").textContent;
  answer(new Response(null,{status:200}));
  await tick(0);
  expect(screen.getByRole("alert")).toHaveTextContent(newer!);
 });
 it("stops probing and aborts the active probe on unmount", async () => {
  const signals: AbortSignal[] = [];
  const fetcher = serverFetch((init) => { signals.push(init!.signal!); return new Promise(() => {}); });
  const {unmount} = await failSubmit(fetcher);
  await tick(3_000);
  unmount();
  expect(signals[0]!.aborted).toBe(true);
  await tick(9_000);
  expect(probes(fetcher)).toHaveLength(1);
 });
});
