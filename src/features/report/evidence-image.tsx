"use client";

import Image from "next/image";
import { useState } from "react";

interface EvidenceImageProps {
  alt: string;
  className: string;
  fallbackClassName: string;
  height: number;
  src: string;
  unavailableText: string;
  width: number;
}

export function EvidenceImage({
  alt,
  className,
  fallbackClassName,
  height,
  src,
  unavailableText,
  width,
}: EvidenceImageProps) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <span className={fallbackClassName} role="status">
        {unavailableText}
      </span>
    );
  }

  return (
    <Image
      alt={alt}
      className={className}
      height={height}
      loading="lazy"
      onError={() => setFailed(true)}
      src={src}
      unoptimized
      width={width}
    />
  );
}
