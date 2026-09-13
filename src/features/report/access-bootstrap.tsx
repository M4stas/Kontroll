"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

interface AccessBootstrapProps {
  publicId: string;
}

export function AccessBootstrap({ publicId }: AccessBootstrapProps) {
  const router = useRouter();
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
      if (response.ok) router.refresh();
    };

    void exchange();
  }, [publicId, router]);

  return null;
}
