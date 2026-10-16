"use client";

import { useState, type CSSProperties, type UIEvent } from "react";
import { safeHttpUrl } from "./formatters";
import { openListingDetails } from "./listing-facts";
import { listingText, type Locale } from "./messages";

const THUMBNAILS = 5;

export function ListingGallery({ locale, photoUrls }: { locale: Locale; photoUrls: string[] | null }) {
  const [selected, setSelected] = useState(0);
  const [phoneSelected, setPhoneSelected] = useState(0);

  if (photoUrls === null) {
    return (
      <div className="listing-gallery">
        <div className="listing-photo is-reading" aria-hidden="true" />
        <div className="listing-thumbs" aria-hidden="true">
          {Array.from({ length: THUMBNAILS }, (_, index) => <span key={index} className="pulse" />)}
        </div>
        <div className="listing-phone-gallery" aria-hidden="true">
          <div className="listing-phone-photo listing-photo is-reading" />
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
        <div className="listing-phone-gallery">
          <div className="listing-phone-photo listing-photo is-empty"><p>{listingText(locale, "noPhotos")}</p></div>
        </div>
      </div>
    );
  }

  const current = Math.min(selected, photos.length - 1);
  const phoneCurrent = Math.min(phoneSelected, photos.length - 1);
  const overflow = photos.length > THUMBNAILS;
  const thumbnails = photos.slice(0, overflow ? THUMBNAILS - 1 : THUMBNAILS);
  const updatePhoneSelection = (event: UIEvent<HTMLDivElement>) => {
    const width = event.currentTarget.clientWidth;
    if (width === 0) return;
    setPhoneSelected(Math.min(photos.length - 1, Math.max(0, Math.round(event.currentTarget.scrollLeft / width))));
  };
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
      <div className="listing-phone-gallery">
        <div
          className="listing-phone-track"
          role="region"
          aria-label={listingText(locale, "photos")}
          tabIndex={0}
          onScroll={updatePhoneSelection}
        >
          {photos.map((url, index) => (
            <a className="listing-phone-photo" href={url} target="_blank" rel="noreferrer" key={`${url}-${index}`}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={url} alt={listingText(locale, "photoAlt", { value: index + 1 })} decoding="async" loading={index === 0 ? "eager" : "lazy"} />
            </a>
          ))}
        </div>
        <span className="listing-phone-count num" role="status" aria-live="polite" aria-atomic="true">
          {phoneCurrent + 1} / {photos.length}
        </span>
      </div>
    </div>
  );
}
