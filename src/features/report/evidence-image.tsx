"use client";

import Image from "next/image";
import { useState, type ReactNode } from "react";

interface EvidenceImageBaseProps {
  alt: string;
  className: string;
  fallbackClassName: string;
  src: string;
  unavailableText: string;
  fallback?: ReactNode;
}

type EvidenceImageProps = EvidenceImageBaseProps & (
  | { fill: true; containerClassName: string; sizes?: string }
  | { fill?: false; containerClassName?: never; height: number; width: number }
);

export function EvidenceImage(props: EvidenceImageProps) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <span className={props.fallbackClassName} role="status">
        {props.fallback ?? props.unavailableText}
      </span>
    );
  }

  const image = (
    <Image
      alt={props.alt}
      className={props.className}
      loading="lazy"
      onError={() => setFailed(true)}
      src={props.src}
      unoptimized
      {...(props.fill
        ? { fill: true, sizes: props.sizes ?? "100vw" }
        : { height: props.height, width: props.width })}
    />
  );

  return props.fill ? <div className={props.containerClassName}>{image}</div> : image;
}
