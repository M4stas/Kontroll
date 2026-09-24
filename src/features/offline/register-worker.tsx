"use client";

import { useEffect } from "react";

function bounded<T>(operation: Promise<T>): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    operation.catch(() => null),
    new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), 2500); }),
  ]).finally(() => clearTimeout(timer));
}

export async function messageWorker(type: "CACHE_REPORT_SHELL" | "CLEAR_REPORT_SHELL", path: string) {
  if (!("serviceWorker" in navigator)) return false;
  const registration = await bounded(navigator.serviceWorker.ready);
  const active = registration?.active;
  if (!active) return false;
  const channel = new MessageChannel();
  const reply = new Promise<boolean>((resolve) => {
    channel.port1.onmessage = (event: MessageEvent<boolean>) => resolve(event.data);
  });
  try {
    const assets = performance.getEntriesByType("resource")
      .map((entry) => new URL(entry.name).pathname)
      .filter((pathname) => pathname.startsWith("/_next/static/"));
    active.postMessage({ type, path, assets }, [channel.port2]);
    return await bounded(reply) ?? false;
  } catch {
    return false;
  } finally {
    channel.port1.close();
    channel.port2.close();
  }
}

export function RegisterWorker() {
  useEffect(() => {
    if ("serviceWorker" in navigator) void navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => undefined);
  }, []);
  return null;
}
