"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

interface AccessBootstrapProps {
  publicId: string;
  pending?: ReactNode;
  unavailable?: ReactNode;
  children?: ReactNode;
}

export function AccessBootstrap({ publicId, pending, unavailable, children }: AccessBootstrapProps) {
  const [state, setState] = useState<"pending" | "denied" | "unavailable">("pending");
  const attempted = useRef(false);

  useEffect(() => {
    if (attempted.current) return;
    attempted.current = true;

    const token = new URLSearchParams(window.location.hash.slice(1)).get("access");
    if (!token) {
      queueMicrotask(() => setState("denied"));
      return;
    }

    const exchange = async () => {
      const response = await fetch(`/api/analyses/${publicId}/access`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      if (response.ok) {
        window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}`);
        window.location.reload();
      } else {
        setState(response.status >= 500 ? "unavailable" : "denied");
      }
    };

    void exchange().catch(() => {
      // Keep the fragment intact so a reload can retry the private exchange.
      setState("unavailable");
    });
  }, [publicId]);

  return state === "pending" ? pending ?? null : state === "unavailable" ? unavailable ?? null : children ?? null;
}
