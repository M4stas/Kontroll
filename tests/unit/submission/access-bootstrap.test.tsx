import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccessBootstrap } from "@/features/report/access-bootstrap";

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

describe("AccessBootstrap", () => {
  afterEach(() => {
    cleanup();
    history.replaceState(null, "", "/");
    refresh.mockReset();
    vi.unstubAllGlobals();
  });

  it("posts the fragment token once without removing it from the URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    history.replaceState(
      null,
      "",
      "/en/a/7c5ad3db-7fdb-469e-a96c-d10bc2dd5fb1#access=private-token",
    );

    const view = render(
      <AccessBootstrap publicId="7c5ad3db-7fdb-469e-a96c-d10bc2dd5fb1" />,
    );
    view.rerender(
      <AccessBootstrap publicId="7c5ad3db-7fdb-469e-a96c-d10bc2dd5fb1" />,
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/analyses/7c5ad3db-7fdb-469e-a96c-d10bc2dd5fb1/access",
      {
        body: JSON.stringify({ token: "private-token" }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      },
    );
    expect(window.location.hash).toBe("#access=private-token");
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  });

  // Catches a rejected exchange escaping as an unhandled promise and a retry token being lost.
  it("handles a rejected exchange and keeps the fragment available for reload retry", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("network unavailable"));
    vi.stubGlobal("fetch", fetchMock);
    history.replaceState(
      null,
      "",
      "/en/a/7c5ad3db-7fdb-469e-a96c-d10bc2dd5fb1#access=private-token",
    );

    render(<AccessBootstrap publicId="7c5ad3db-7fdb-469e-a96c-d10bc2dd5fb1" />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(window.location.hash).toBe("#access=private-token");
    expect(refresh).not.toHaveBeenCalled();
  });
});
