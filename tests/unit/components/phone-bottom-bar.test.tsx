import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PhoneBottomBar } from "@/components/phone-bottom-bar";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  MockResizeObserver.latest = undefined;
});

class MockResizeObserver {
  static latest: MockResizeObserver | undefined;
  private readonly callback: ResizeObserverCallback;
  observe = vi.fn();
  disconnect = vi.fn();

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    MockResizeObserver.latest = this;
  }

  notify() {
    this.callback([], this as unknown as ResizeObserver);
  }
}

describe("PhoneBottomBar", () => {
  it("renders its action children and reserves space after the bar", () => {
    const { container } = render(
      <PhoneBottomBar className="existing-actions">
        <button type="button">Open report</button>
        <p role="status">Checking review</p>
      </PhoneBottomBar>,
    );

    const bar = container.querySelector(".phone-bottom-bar");
    const spacer = container.querySelector(".phone-bottom-bar-spacer");

    expect(screen.getByRole("button", { name: "Open report" })).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("Checking review");
    expect(bar).toHaveClass("existing-actions");
    expect(spacer).toHaveAttribute("aria-hidden", "true");
    expect(bar?.nextElementSibling).toBe(spacer);
  });

  it("resizes the spacer when the action bar wraps to more rows", () => {
    vi.stubGlobal("ResizeObserver", MockResizeObserver);
    const { container } = render(
      <PhoneBottomBar>
        <button type="button">Open report</button>
        <p role="status">Checking review</p>
      </PhoneBottomBar>,
    );
    const bar = container.querySelector(".phone-bottom-bar") as HTMLDivElement;
    const spacer = container.querySelector(".phone-bottom-bar-spacer") as HTMLDivElement;
    vi.spyOn(bar, "getBoundingClientRect").mockReturnValue({ height: 104 } as DOMRect);

    act(() => MockResizeObserver.latest?.notify());

    expect(spacer.style.height).toBe("104px");
  });
});
