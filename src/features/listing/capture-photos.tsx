import { safeHttpUrl } from "./formatters";
import { listingText, type Locale } from "./messages";

export function CapturePhotos({ locale, photoUrls, waiting }: {
  locale: Locale;
  photoUrls: string[] | null;
  waiting: boolean;
}) {
  if (photoUrls === null && !waiting) return null;
  const photos = (photoUrls ?? []).flatMap((url) => {
    const safeUrl = safeHttpUrl(url);
    return safeUrl ? [safeUrl] : [];
  });
  return (
    <section className="capture-photos" aria-labelledby="photos-heading">
      <h2 id="photos-heading">{listingText(locale, "photos")}</h2>
      {photoUrls === null ? (
        <>
          <div className="photo-grid">
            {Array.from({ length: 8 }, (_, index) => <div key={index} className="photo-tile is-loading" aria-hidden="true" />)}
          </div>
          <p className="sr-only">{listingText(locale, "unavailableForNow")}</p>
        </>
      ) : photos.length > 0 ? (
        <div className="photo-grid">
          {photos.map((url, index) => (
            <a className="photo-tile" href={url} target="_blank" rel="noreferrer" key={`${url}-${index}`}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={url} alt={listingText(locale, "photoAlt", { value: index + 1 })} decoding="async" loading={index === 0 ? "eager" : "lazy"} />
            </a>
          ))}
        </div>
      ) : <p className="description-copy">{listingText(locale, "noPhotos")}</p>}
    </section>
  );
}
