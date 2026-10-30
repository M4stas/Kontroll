// In development, send browser errors to /api/dev/client-errors, which prints
// them in the dev server's output. Phone browsers hide them behind an overlay
// whose text cannot be copied.
import { startClientErrorReporting } from "@/lib/client-error-reporting";

if (process.env.NODE_ENV === "development") {
  startClientErrorReporting({
    addEventListener: window.addEventListener.bind(window),
    fetch: window.fetch.bind(window),
    location: window.location,
    console,
  });
}
