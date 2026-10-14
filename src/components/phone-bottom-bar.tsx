"use client";

import { useEffect, useRef, type ReactNode } from "react";

export function PhoneBottomBar({ children, className = "" }: {
  children: ReactNode;
  className?: string;
}) {
  const barRef = useRef<HTMLDivElement>(null);
  const spacerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const bar = barRef.current;
    const spacer = spacerRef.current;
    if (!bar || !spacer) return;
    const pageShell = bar.closest<HTMLElement>(".page-shell");
    const property = "--phone-bottom-bar-height";
    const previousHeight = pageShell?.style.getPropertyValue(property) ?? "";
    const previousPriority = pageShell?.style.getPropertyPriority(property) ?? "";
    let appliedHeight = "";

    const reserveBarHeight = () => {
      const height = Math.ceil(bar.getBoundingClientRect().height);
      if (height <= 0) return;
      appliedHeight = `${height}px`;
      spacer.style.height = appliedHeight;
      pageShell?.style.setProperty(property, appliedHeight);
    };
    const restorePageHeight = () => {
      if (!pageShell || !appliedHeight || pageShell.style.getPropertyValue(property) !== appliedHeight) return;
      if (previousHeight) pageShell.style.setProperty(property, previousHeight, previousPriority);
      else pageShell.style.removeProperty(property);
    };

    reserveBarHeight();
    if (typeof ResizeObserver === "undefined") return restorePageHeight;

    const observer = new ResizeObserver(reserveBarHeight);
    observer.observe(bar);

    return () => {
      observer.disconnect();
      restorePageHeight();
    };
  }, []);

  return (
    <div className="phone-bottom-bar-slot">
      <div ref={barRef} className={`phone-bottom-bar ${className}`.trim()}>
        {children}
      </div>
      <div ref={spacerRef} className="phone-bottom-bar-spacer" aria-hidden="true" />
    </div>
  );
}
