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
    if (!bar || !spacer || typeof ResizeObserver === "undefined") return;

    const reserveBarHeight = () => {
      const height = Math.ceil(bar.getBoundingClientRect().height);
      if (height > 0) spacer.style.height = `${height}px`;
    };
    const observer = new ResizeObserver(reserveBarHeight);
    observer.observe(bar);
    reserveBarHeight();

    return () => observer.disconnect();
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
