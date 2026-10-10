import { fireEvent, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { expect, it, vi } from "vitest";
import messages from "../../../messages/en.json";
import { DiagnosticsPanel } from "@/features/diagnostics/diagnostics-panel";
vi.mock("@/features/diagnostics/use-diagnostics", () => ({
  useDiagnostics: () => ({ snapshot: null, connection: "loading", lastRefresh: null, retry: vi.fn() }),
}));
it("hides the entry when disabled and opens an accessible dialog when enabled", () => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
  const view = render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <DiagnosticsPanel publicId="owner" enabled={false} />
    </NextIntlClientProvider>,
  );
  expect(screen.queryByRole("button", { name: "Live diagnostics" })).toBeNull();
  view.rerender(
    <NextIntlClientProvider locale="en" messages={messages}>
      <DiagnosticsPanel publicId="owner" enabled />
    </NextIntlClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Live diagnostics" }));
  expect(screen.getByRole("dialog")).toHaveAttribute("open");
  fireEvent.click(screen.getByRole("button", { name: "Close diagnostics" }));
  expect(screen.queryByRole("dialog")).toBeNull();
});
