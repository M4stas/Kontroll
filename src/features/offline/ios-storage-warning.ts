export function needsIosStorageWarning(): boolean {
  if (typeof navigator === "undefined") return false;
  const iOSUserAgent = /iPhone|iPad|iPod/i.test(navigator.userAgent);
  const iPadDesktopMode = !iOSUserAgent && navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
  const standalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return (iOSUserAgent || iPadDesktopMode) && !standalone;
}
