import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";

// jsdom does not implement media queries. Tests can override this desktop default.
if (typeof window !== "undefined") {
  window.matchMedia = vi.fn((query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(() => true),
  }));
}

// jsdom cannot lay out the report deck, so Embla is replaced with a fake that tracks the selected card.
vi.mock("embla-carousel-react", async () => ({ default: (await import("./tests/support/fake-embla")).useFakeEmblaCarousel }));
vi.mock("embla-carousel-wheel-gestures", () => ({ WheelGesturesPlugin: () => ({ name: "wheelGestures", options: {}, init: () => {}, destroy: () => {} }) }));
