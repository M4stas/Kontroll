import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";

// jsdom does not implement media queries. Tests can override this desktop default.
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
