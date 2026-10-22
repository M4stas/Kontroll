import { act, cleanup, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../../../messages/en.json";
import { ReportRefresh } from "@/features/report/report-refresh";
import { sampleReport } from "../../fixtures/sample-report";

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

function renderRefresh(status: typeof sampleReport.status) {
  return render(
    <NextIntlClientProvider locale="en" messages={en} timeZone="Europe/Tallinn">
      <ReportRefresh status={status} />
    </NextIntlClientProvider>,
  );
}

describe("ReportRefresh", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    refresh.mockReset();
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    vi.useRealTimers();
  });

  // Catches polling intervals that continue after the report reaches a terminal state.
  it("refreshes an active report every three seconds and stops when complete", () => {
    const view = renderRefresh("running");

    act(() => vi.advanceTimersByTime(3_000));
    expect(refresh).toHaveBeenCalledOnce();

    view.rerender(
      <NextIntlClientProvider locale="en" messages={en}>
        <ReportRefresh status="complete" />
      </NextIntlClientProvider>,
    );
    act(() => vi.advanceTimersByTime(6_000));
    expect(refresh).toHaveBeenCalledOnce();
  });

  // Catches silent stage changes that assistive technology cannot perceive.
  it("announces material report stage changes through one polite live region", () => {
    const view = renderRefresh("running");
    const liveRegion = screen.getByRole("status");
    expect(liveRegion).toHaveAttribute("aria-live", "polite");
    expect(liveRegion).toHaveTextContent("Analysis in progress");

    view.rerender(
      <NextIntlClientProvider locale="en" messages={en}>
        <ReportRefresh status="partial" />
      </NextIntlClientProvider>,
    );

    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(liveRegion).toHaveTextContent("Initial report ready; further checks are running");
  });

  // Catches a terminal failure continuing to issue refresh requests.
  it("does not refresh a failed report", () => {
    renderRefresh("failed");

    act(() => vi.advanceTimersByTime(9_000));

    expect(refresh).not.toHaveBeenCalled();
  });

  // Catches polling that fails to resume when someone returns to a long-hidden report.
  it("refreshes immediately when visible again and resumes three-second polling", () => {
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    renderRefresh("running");

    act(() => vi.advanceTimersByTime(31_000));
    expect(refresh).not.toHaveBeenCalled();

    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(refresh).toHaveBeenCalledOnce();

    act(() => vi.advanceTimersByTime(2_999));
    expect(refresh).toHaveBeenCalledOnce();

    act(() => vi.advanceTimersByTime(1));
    expect(refresh).toHaveBeenCalledTimes(2);

    act(() => vi.advanceTimersByTime(3_000));
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  // Catches an interval surviving component teardown and refreshing an unrelated screen.
  it("clears the refresh interval on unmount", () => {
    const view = renderRefresh("running");

    view.unmount();
    act(() => vi.advanceTimersByTime(6_000));

    expect(refresh).not.toHaveBeenCalled();
  });
});

it('keeps polling a completed report until its background check finishes',()=>{
 vi.useFakeTimers();
 const view=render(<NextIntlClientProvider locale="en" messages={en}><ReportRefresh status="complete" backgroundCheckPending /></NextIntlClientProvider>);
 act(()=>vi.advanceTimersByTime(3000));expect(refresh).toHaveBeenCalledOnce();
 view.rerender(<NextIntlClientProvider locale="en" messages={en}><ReportRefresh status="complete" backgroundCheckPending={false}/></NextIntlClientProvider>);
 act(()=>vi.advanceTimersByTime(6000));expect(refresh).toHaveBeenCalledOnce();
 cleanup();refresh.mockReset();vi.useRealTimers();
});
