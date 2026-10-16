import { useState } from "react";
import { vi } from "vitest";

// jsdom has no layout, so the real Embla cannot measure slides. This fake keeps
// the selected index and the events the deck listens to.
export class FakeEmbla {
  selected = 0;
  private listeners = new Map<string, Set<() => void>>();
  scrollTo = vi.fn((...[index]: [index: number, jump?: boolean]) => { this.select(index); });
  reInit = vi.fn();
  selectedScrollSnap = () => this.selected;
  on(event: string, listener: () => void) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(listener);
    return this;
  }
  off(event: string, listener: () => void) {
    this.listeners.get(event)?.delete(listener);
    return this;
  }
  /** A finger swipe: Embla changes the selected card without the deck asking. */
  swipeTo(index: number) { this.select(index); }
  private select(index: number) {
    if (index === this.selected) return;
    this.selected = index;
    this.listeners.get("select")?.forEach(listener => listener());
  }
}

export let latestEmbla: FakeEmbla | undefined;

export function useFakeEmblaCarousel() {
  const [api] = useState(() => (latestEmbla = new FakeEmbla()));
  const [ref] = useState(() => vi.fn());
  return [ref, api] as const;
}
