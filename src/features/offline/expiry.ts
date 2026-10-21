export function offlineLifetimeMs(): number {
  const minutes = Number(process.env.NEXT_PUBLIC_OFFLINE_EXPIRY_MINUTES);
  return process.env.NODE_ENV !== "production" && Number.isFinite(minutes) && minutes > 0
    ? minutes * 60_000
    : 30 * 24 * 60 * 60_000;
}
