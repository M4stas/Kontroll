"use client";

import { useState, type CSSProperties } from "react";
import { safeHttpUrl } from "./formatters";
import { openListingDetails } from "./listing-facts";
import { listingText, type Locale } from "./messages";

const THUMBNAILS = 5;

export function ListingGallery({ locale, photoUrls }: { locale: Locale; photoUrls: string[] | null }) {
  const [selected, setSelected] = useState(0);

  if (photoUrls === null) {
    return (
      <div className="listing-gallery">
        <div className="listing-photo is-reading" aria-hidden="true" />
        <div className="listing-thumbs" aria-hidden="true">
          {Array.from({ length: THUMBNAILS }, (_, index) => <span key={index} className="pulse" />)}
        </div>
        <p className="sr-only">{listingText(locale, "unavailableForNow")}</p>
      </div>
    );
  }

  const photos = photoUrls.flatMap((url) => {
    const safeUrl = safeHttpUrl(url);
    return safeUrl ? [safeUrl] : [];
  });
  if (photos.length === 0) {
    return (
      <div className="listing-gallery">
        <div className="listing-photo is-empty"><p>{listingText(locale, "noPhotos")}</p></div>
      </div>
    );
  }

  const current = Math.min(selected, photos.length - 1);
  const overflow = photos.length > THUMBNAILS;
  const thumbnails = photos.slice(0, overflow ? THUMBNAILS - 1 : THUMBNAILS);
  return (
    <div className="listing-gallery">
      <a className="listing-photo fade-in" href={photos[current]} target="_blank" rel="noreferrer" key={photos[current]}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={photos[current]} alt={listingText(locale, "photoAlt", { value: current + 1 })} decoding="async" />
      </a>
      {photos.length > 1 ? (
        <div className="listing-thumbs">
          {thumbnails.map((url, index) => (
            <button
              type="button"
              key={`${url}-${index}`}
              className="fade-in"
              style={{ "--delay": `${80 + index * 50}ms` } as CSSProperties}
              aria-label={listingText(locale, "showPhoto", { value: index + 1 })}
              aria-pressed={index === current}
              onClick={() => setSelected(index)}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={url} alt="" decoding="async" loading="lazy" />
            </button>
          ))}
          {overflow ? (
            <button
              type="button"
              className="listing-more fade-in"
              style={{ "--delay": `${80 + thumbnails.length * 50}ms` } as CSSProperties}
              onClick={() => openListingDetails("all-photos")}
            >
              {listingText(locale, "morePhotos", { value: photos.length - thumbnails.length })}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
