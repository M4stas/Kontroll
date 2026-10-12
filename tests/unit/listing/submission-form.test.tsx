import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SubmissionForm } from "@/features/listing/submission-form";
import { listingText } from "@/features/listing/messages";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

beforeEach(() => window.sessionStorage.clear());
afterEach(cleanup);

describe("listing submission form", () => {
  it("groups the URL input and submit action inside one address bar", () => {
    render(<SubmissionForm locale="en" />);
    const input = screen.getByRole("textbox", { name: "Auto24 listing URL" });
    const button = screen.getByRole("button", { name: "Get listing details" });
    const bar = input.closest(".url-bar");
    expect(bar).not.toBeNull();
    expect(bar).toContainElement(button);
  });

  it("marks an invalid URL and explains the error", () => {
    render(<SubmissionForm locale="en" />);
    const input = screen.getByRole("textbox", { name: "Auto24 listing URL" });
    fireEvent.change(input, { target: { value: "not a link" } });
    fireEvent.click(screen.getByRole("button", { name: "Get listing details" }));
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toHaveTextContent(listingText("en", "invalidUrl"));
  });

  it("offers manual entry as a text button", () => {
    render(<SubmissionForm locale="en" />);
    expect(screen.getByRole("button", { name: "Continue manually" })).toHaveClass("text-button");
  });
});
