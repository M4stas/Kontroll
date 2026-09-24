"use client";

import { useEffect } from "react";

export async function messageWorker(type: "CACHE_REPORT_SHELL" | "CLEAR_REPORT_SHELL", path: string) {
  if (!("serviceWorker" in navigator)) return false;
  const registration = await navigator.serviceWorker.ready;
  if (!registration.active) return false;
  return await new Promise<boolean>((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = (event: MessageEvent<boolean>) => { channel.port1.close(); resolve(event.data); };
    const assets = performance.getEntriesByType("resource")
      .map((entry) => new URL(entry.name).pathname)
      .filter((pathname) => pathname.startsWith("/_next/static/"));
    registration.active?.postMessage({ type, path, assets }, [channel.port2]);
  });
}

export function RegisterWorker() {
  useEffect(() => {
    if ("serviceWorker" in navigator) void navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => undefined);
  }, []);
  return null;
}
