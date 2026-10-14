import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SiteHeader } from "@/components/site-header";
import { listingText } from "@/features/listing/messages";

afterEach(cleanup);

const languageHrefs = { et: "/et/r/report-id", en: "/en/r/report-id" };

describe("SiteHeader", () => {
  it.each(["et", "en"] as const)("links the %s brand to its start page", (locale) => {
    render(<SiteHeader locale={locale} languageHrefs={languageHrefs} />);
    expect(screen.getByRole("link", { name: /Kontroll/ }).getAttribute("href")).toBe(`/${locale}`);
  });

  it("marks only the current language", () => {
    render(<SiteHeader locale="et" languageHrefs={languageHrefs} />);
    expect(screen.getByRole("link", { name: "ET" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "EN" }).hasAttribute("aria-current")).toBe(false);
  });

  it("uses the supplied language addresses", () => {
    render(<SiteHeader locale="en" languageHrefs={languageHrefs} />);
    expect(screen.getByRole("link", { name: "ET" }).getAttribute("href")).toBe(languageHrefs.et);
    expect(screen.getByRole("link", { name: "EN" }).getAttribute("href")).toBe(languageHrefs.en);
  });

  it("hides the new listing link by default", () => {
    render(<SiteHeader locale="et" languageHrefs={languageHrefs} />);
    expect(screen.queryByRole("link", { name: listingText("et", "newListing") })).toBeNull();
  });

  it.each(["et", "en"] as const)("shows the localized %s new listing link when requested", (locale) => {
    render(<SiteHeader locale={locale} languageHrefs={languageHrefs} showNewListing />);
    const link = screen.getByRole("link", { name: listingText(locale, "newListing") });
    expect(link.getAttribute("href")).toBe(`/${locale}`);
    expect(link.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(link).toHaveAttribute("aria-label", listingText(locale, "newListing"));
  });
});
