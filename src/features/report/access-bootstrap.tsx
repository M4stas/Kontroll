"use client";

import { useEffect, useRef } from "react";

interface AccessBootstrapProps {
  publicId: string;
}

export function AccessBootstrap({ publicId }: AccessBootstrapProps) {
  const attempted = useRef(false);

  useEffect(() => {
    if (attempted.current) return;
    attempted.current = true;

    const token = new URLSearchParams(window.location.hash.slice(1)).get("access");
    if (!token) return;

    const exchange = async () => {
      const response = await fetch(`/api/analyses/${publicId}/access`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      if (response.ok) {
        window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}`);
        window.location.reload();
      }
    };

    void exchange().catch(() => {
      // Keep the fragment intact so a reload can retry the private exchange.
    });
  }, [publicId]);

  return null;
}
