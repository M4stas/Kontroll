"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { nearestCardIndex } from "./nearest-card";

export interface DeckCard { id: string; name: string; content: ReactNode }

export function Deck({ label, cards, firstNextLabel }: { label: string; cards: DeckCard[]; firstNextLabel: string }) {
  const t = useTranslations("Report.deck");
  const track = useRef<HTMLDivElement>(null);
  const progress = useRef<HTMLDivElement>(null);
  const frame = useRef<number | null>(null);
  const order = JSON.stringify(cards.map(card => card.id));
  const previousOrder = useRef(order);
  const [selection, setSelection] = useState({ id: cards[0]?.id, index: 0 });
  const foundIndex = cards.findIndex(card => card.id === selection.id);
  const current = foundIndex >= 0 ? foundIndex : Math.max(0, Math.min(selection.index, cards.length - 1));
  if (cards[current] && (selection.id !== cards[current].id || selection.index !== current)) {
    setSelection({ id: cards[current].id, index: current });
  }

  useEffect(() => () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
  }, []);

  useEffect(() => {
    if (previousOrder.current !== order) {
      if (frame.current !== null) {
        cancelAnimationFrame(frame.current);
        frame.current = null;
      }
      previousOrder.current = order;
      go(current);
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

  function go(index: number) {
    const next = Math.max(0, Math.min(index, cards.length - 1));
    if (!cards[next] || !track.current) return;
    setSelection({ id: cards[next].id, index: next });
    const slide = track.current.children[next] as HTMLElement;
    track.current.scrollTo({
      left: slide.offsetLeft - track.current.offsetLeft,
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    });
  }

  return <section className="report-deck">
    <div ref={progress} className="report-deck-progress">
      {cards.map((card, index) => <button key={card.id} type="button" aria-label={t("goTo", { name: card.name })} aria-current={index === current ? "step" : undefined} className={index < current ? "done" : undefined} onClick={() => go(index)} />)}
    </div>
    <div ref={track} className="report-deck-track" role="region" aria-roledescription="carousel" aria-label={label} tabIndex={0}
      onKeyDown={event => {
        if ((event.target as HTMLElement).closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])")) return;
        if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
          event.preventDefault(); go(current + (event.key === "ArrowRight" ? 1 : -1));
        }
      }}
      onScroll={() => {
        if (frame.current !== null) return;
        frame.current = requestAnimationFrame(() => {
          frame.current = null;
          if (!track.current || !cards.length) return;
          const offsets = Array.from(track.current.children, child => (child as HTMLElement).offsetLeft - track.current!.offsetLeft);
          const index = nearestCardIndex(offsets, track.current.scrollLeft);
          const card = cards[index];
          if (card) setSelection({id: card.id, index});
        });
      }}>
      {cards.map((card, index) => <div key={card.id} className="report-deck-card" role="group" aria-current={index === current ? "true" : undefined} aria-roledescription="slide" aria-label={t("slide", {index: index + 1, total: cards.length, name: card.name})} onFocus={() => go(index)}>{card.content}</div>)}
    </div>
    <div className="report-deck-controls">
      <button type="button" className="secondary-button report-deck-back" disabled={current === 0} onClick={() => go(current - 1)}>{t("back")}</button>
      <span className="report-deck-where">{cards[current]?.name}</span>
      <button type="button" className="primary-button report-deck-next" aria-label={current === 0 ? `${t("nextShort")}: ${firstNextLabel}` : t("next", {name: cards[current + 1]?.name ?? ""})} hidden={!cards.length || current === cards.length - 1} onClick={() => go(current + 1)}><span className="report-deck-next-label">{current === 0 ? firstNextLabel : t("next", {name: cards[current + 1]?.name ?? ""})}</span><span className="report-deck-next-short" aria-hidden="true">{t("nextShort")}</span></button>
    </div>
  </section>;
}
