"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import useEmblaCarousel from "embla-carousel-react";
import { WheelGesturesPlugin } from "embla-carousel-wheel-gestures";

export interface DeckCard { id: string; name: string; content: ReactNode }

// Embla slides the row with a transform. A native horizontal scroller holding
// vertically scrolling cards stuttered on phones.
const OPTIONS = { align: "start", containScroll: "trimSnaps", skipSnaps: false, watchSlides: false } as const;
const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function Deck({ label, cards, firstNextLabel }: { label: string; cards: DeckCard[]; firstNextLabel: string }) {
  const t = useTranslations("Report.deck");
  const [plugins] = useState(() => [WheelGesturesPlugin({ forceWheelAxis: "x" })]);
  const [emblaRef, embla] = useEmblaCarousel(OPTIONS, plugins);
  const track = useRef<HTMLDivElement | null>(null);
  const setTrack = useCallback((node: HTMLDivElement | null) => { track.current = node; emblaRef(node); }, [emblaRef]);
  const progress = useRef<HTMLDivElement>(null);
  const latestCards = useRef(cards);
  const order = JSON.stringify(cards.map(card => card.id));
  const previousOrder = useRef(order);
  const [selection, setSelection] = useState({ id: cards[0]?.id, index: 0 });
  const foundIndex = cards.findIndex(card => card.id === selection.id);
  const current = foundIndex >= 0 ? foundIndex : Math.max(0, Math.min(selection.index, cards.length - 1));
  if (cards[current] && (selection.id !== cards[current].id || selection.index !== current)) {
    setSelection({ id: cards[current].id, index: current });
  }

  const last = current === cards.length - 1;

  useEffect(() => { latestCards.current = cards; });

  useEffect(() => {
    if (!embla) return;
    const select = () => {
      const index = embla.selectedScrollSnap();
      const card = latestCards.current[index];
      if (card) setSelection({ id: card.id, index });
    };
    embla.on("select", select);
    return () => { embla.off("select", select); };
  }, [embla]);

  useEffect(() => {
    if (previousOrder.current !== order) {
      previousOrder.current = order;
      embla?.reInit();
      go(current, true);
    }
  });

  useEffect(() => {
    if (!window.matchMedia("(max-width: 639px)").matches) return;
    const strip = progress.current;
    const dot = strip?.children[current];
    if (!strip || !dot) return;
    const viewport = strip.getBoundingClientRect();
    const target = dot.getBoundingClientRect();
    const delta = target.left < viewport.left ? target.left - viewport.left
      : target.right > viewport.right ? target.right - viewport.right : 0;
    if (delta) strip.scrollTo({left: strip.scrollLeft + delta, behavior: "auto"});
  }, [current, order]);

  function go(index: number, jump = reducedMotion()) {
    const next = Math.max(0, Math.min(index, cards.length - 1));
    if (!cards[next]) return;
    setSelection({ id: cards[next].id, index: next });
    // Focus can scroll the clipped viewport natively; Embla positions the row itself.
    if (track.current) track.current.scrollLeft = 0;
    embla?.scrollTo(next, jump);
  }

  return <section className="report-deck">
    <div ref={progress} className="report-deck-progress">
      {cards.map((card, index) => <button key={card.id} type="button" aria-label={t("goTo", { name: card.name })} aria-current={index === current ? "step" : undefined} className={index < current ? "done" : undefined} onClick={() => go(index)} />)}
    </div>
    <div ref={setTrack} className="report-deck-track" role="region" aria-roledescription="carousel" aria-label={label} tabIndex={0}
      onKeyDown={event => {
        if ((event.target as HTMLElement).closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])")) return;
        if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
          event.preventDefault(); go(current + (event.key === "ArrowRight" ? 1 : -1));
        }
      }}>
      <div className="report-deck-row">
        {cards.map((card, index) => <div key={card.id} className="report-deck-card" role="group" aria-current={index === current ? "true" : undefined} aria-roledescription="slide" aria-label={t("slide", {index: index + 1, total: cards.length, name: card.name})} onFocus={() => { if (index !== current) go(index); }}>{card.content}</div>)}
      </div>
    </div>
    <div className="report-deck-controls">
      <button type="button" className="secondary-button report-deck-back" disabled={current === 0} onClick={() => go(current - 1)}>{t("back")}</button>
      <span className="report-deck-where">{cards[current]?.name}</span>
      {/* Next stays on the last card, disabled, so the dots between Back and Next keep their place. */}
      <button type="button" className="primary-button report-deck-next" aria-label={last ? t("nextShort") : current === 0 ? `${t("nextShort")}: ${firstNextLabel}` : t("next", {name: cards[current + 1]?.name ?? ""})} hidden={!cards.length} disabled={last} onClick={() => go(current + 1)}><span className="report-deck-next-label">{last ? t("nextShort") : current === 0 ? firstNextLabel : t("next", {name: cards[current + 1]?.name ?? ""})}</span><span className="report-deck-next-short" aria-hidden="true">{t("nextShort")}</span></button>
    </div>
  </section>;
}
