import { ReportDeck } from "@/features/report/deck/report-deck";
import { sampleReport } from "../../fixtures/sample-report";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import en from "../../../messages/en.json";
import { Deck, type DeckCard } from "@/features/report/deck/deck";
import { latestEmbla } from "../../support/fake-embla";
const cards: DeckCard[] = ["Cover", "Finding", "Message"].map(name => ({id:name,name,content:<button>{name} content</button>}));
const view = (items = cards) => <NextIntlClientProvider locale="en" messages={en}><Deck label="Report cards" cards={items} firstNextLabel="See the findings" /></NextIntlClientProvider>;
beforeEach(() => { HTMLElement.prototype.scrollTo = vi.fn(); window.matchMedia = vi.fn().mockReturnValue({matches:false}); });
afterEach(cleanup);
const embla = () => latestEmbla!;
const current = (name: string) => expect(screen.getByRole("button", {name:`Go to ${name}`})).toHaveAttribute("aria-current", "step");
it("exposes exactly the selected slide as current across navigation and refresh", () => {
 const rendered = render(view());
 const selected = (name: string) => {
   const slides = screen.getAllByRole("group");
   expect(slides.filter(slide => slide.getAttribute("aria-current") === "true")).toHaveLength(1);
   expect(screen.getByRole("button", {name:`${name} content`}).closest('[role="group"]')).toHaveAttribute("aria-current", "true");
 };
 selected("Cover");
 fireEvent.click(screen.getByRole("button", {name:"Next: See the findings"})); selected("Finding");
 fireEvent.keyDown(screen.getByRole("region", {name:"Report cards"}), {key:"ArrowLeft"}); selected("Cover");
 fireEvent.focus(screen.getByRole("button", {name:"Message content"})); selected("Message");
 rendered.rerender(view([cards[2]!, cards[0]!, cards[1]!])); selected("Message");
 rendered.rerender(view(cards.slice(0, 2))); selected("Cover");
});
it("labels Next with the first-card label, then with the next card's name", () => {
 render(view()); fireEvent.click(screen.getByRole("button", {name:"Next: See the findings"})); expect(screen.getByRole("button", {name:"Next: Message"})).toBeVisible();
});
it("disables Back on the first card and Next on the last", () => {
 render(view()); expect(screen.getByRole("button", {name:"Back"})).toBeDisabled(); fireEvent.click(screen.getByRole("button", {name:"Go to Message"}));
 expect(screen.queryByRole("button", {name:/Next:/})).toBeNull(); expect(screen.getByRole("button", {name:"Next"})).toBeDisabled();
});
it("moves with ArrowRight and ArrowLeft", () => {
 render(view()); const track=screen.getByRole("region", {name:"Report cards"}); fireEvent.keyDown(track,{key:"ArrowRight"}); current("Finding"); fireEvent.keyDown(track,{key:"ArrowLeft"}); current("Cover");
});
it("marks the card current when focus moves into it", () => {
 render(view()); fireEvent.focus(screen.getByRole("button",{name:"Message content"})); current("Message"); expect(embla().scrollTo).toHaveBeenLastCalledWith(2, false);
});
it("keeps the current card when the card list re-renders with the same ids", () => {
 const rendered=render(view()); fireEvent.click(screen.getByRole("button",{name:"Go to Finding"})); embla().scrollTo.mockClear(); rendered.rerender(view([cards[2]!,cards[0]!,cards[1]!])); current("Finding"); expect(embla().reInit).toHaveBeenCalledOnce(); expect(embla().scrollTo).toHaveBeenCalledExactlyOnceWith(2, true);
 embla().scrollTo.mockClear(); embla().reInit.mockClear(); rendered.rerender(view([cards[2]!,cards[0]!,cards[1]!])); expect(embla().scrollTo).not.toHaveBeenCalled(); expect(embla().reInit).not.toHaveBeenCalled();
});
it("clamps to the last card when the current card disappears", () => {
 const rendered=render(view()); fireEvent.click(screen.getByRole("button",{name:"Go to Message"})); rendered.rerender(view(cards.slice(0,2))); current("Finding");
});
it("leaves text-editing arrow keys alone", () => {
 render(view([{...cards[0]!,content:<textarea aria-label="Message text"/>},...cards.slice(1)])); fireEvent.keyDown(screen.getByRole("textbox"),{key:"ArrowRight"}); current("Cover");
});
it("jumps without animation under reduced motion", () => {
 vi.mocked(window.matchMedia).mockReturnValue({matches:true} as MediaQueryList); render(view()); fireEvent.click(screen.getByRole("button",{name:"Go to Finding"})); expect(embla().scrollTo).toHaveBeenLastCalledWith(1, true);
});
it("animates between cards without reduced motion", () => {
 render(view()); fireEvent.click(screen.getByRole("button",{name:"Go to Finding"})); expect(embla().scrollTo).toHaveBeenLastCalledWith(1, false);
});

it("follows a swipe to another card", () => {
 render(view()); act(() => embla().swipeTo(2)); current("Message");
 expect(screen.getAllByRole("group").filter(slide => slide.getAttribute("aria-current") === "true")).toHaveLength(1);
});
it("keeps the current card when cards reorder after a swipe", () => {
 const rendered = render(view()); act(() => embla().swipeTo(1)); embla().scrollTo.mockClear();
 rendered.rerender(view([cards[2]!,cards[0]!,cards[1]!]));
 current("Finding"); expect(embla().scrollTo).toHaveBeenLastCalledWith(2, true);
});

it("shows the seller replied button only when a callback is given", () => {
 const callback = vi.fn();
 const wrapper = (onSellerReplied?: () => void) => <NextIntlClientProvider locale="en" messages={en}><ReportDeck report={sampleReport} locale="en" onSellerReplied={onSellerReplied} /></NextIntlClientProvider>;
 const rendered = render(wrapper());
 expect(screen.queryByRole("button", {name:"Seller replied"})).toBeNull();
 rendered.rerender(wrapper(callback));
 fireEvent.click(screen.getByRole("button", {name:"Go to Message"}));
 fireEvent.click(screen.getByRole("button", {name:"Seller replied"}));
 expect(callback).toHaveBeenCalledOnce();
 rendered.rerender(<NextIntlClientProvider locale="en" messages={en}><ReportDeck report={{...sampleReport, actions:[]}} locale="en" onSellerReplied={callback}/></NextIntlClientProvider>);
 expect(screen.queryByRole("button", {name:"Seller replied"})).toBeNull();
});

it("keeps the swiped card current while a card scrolls vertically", () => {
 render(view());
 const slides = screen.getAllByRole("group");
 act(() => embla().swipeTo(1));
 current("Finding");
 slides[1]!.scrollTop = 300;
 fireEvent.scroll(slides[1]!);
 current("Finding");
 expect(slides[1]).toHaveAttribute("aria-current", "true");
 expect(slides.filter(slide => slide.getAttribute("aria-current") === "true")).toHaveLength(1);
});

it("includes the visible short Next label in the first action's accessible name", () => {
 render(view());
 expect(screen.getByRole("button", {name:"Next: See the findings"})).toBeVisible();
});
it("reveals the current phone progress dot after Next and a swipe without scrolling the page", () => {
 vi.mocked(window.matchMedia).mockImplementation(query => ({matches:query === "(max-width: 639px)"}) as MediaQueryList);
 render(view());
 const dots = cards.map(card => screen.getByRole("button", {name:`Go to ${card.name}`}));
 const strip = dots[0]!.parentElement!;
 const bounds = (left: number, right: number) => ({left, right}) as DOMRect;
 vi.spyOn(strip, "getBoundingClientRect").mockReturnValue(bounds(0, 100));
 dots.forEach((dot, index) => vi.spyOn(dot, "getBoundingClientRect").mockReturnValue(bounds(index * 44, (index + 1) * 44)));
 vi.mocked(dots[1]!.getBoundingClientRect).mockReturnValue(bounds(100, 144));
 fireEvent.click(screen.getByRole("button", {name:"Next: See the findings"}));
 expect(vi.mocked(HTMLElement.prototype.scrollTo).mock.instances).toContain(strip);
 expect(HTMLElement.prototype.scrollTo).toHaveBeenLastCalledWith({left:44, behavior:"auto"});
 vi.mocked(HTMLElement.prototype.scrollTo).mockClear();
 act(() => embla().swipeTo(2));
 current("Message");
 expect(vi.mocked(HTMLElement.prototype.scrollTo).mock.instances).toEqual([strip]);
 expect(HTMLElement.prototype.scrollTo).toHaveBeenCalledWith({left:32, behavior:"auto"});
});

it("does not scroll the progress strip on wider layouts", () => {
 render(view());
 const dot = screen.getByRole("button", {name:"Go to Finding"});
 const strip = dot.parentElement!;
 vi.spyOn(strip, "getBoundingClientRect").mockReturnValue({left:0, right:100} as DOMRect);
 vi.spyOn(dot, "getBoundingClientRect").mockReturnValue({left:100, right:144} as DOMRect);
 fireEvent.click(screen.getByRole("button", {name:"Next: See the findings"}));
 expect(vi.mocked(HTMLElement.prototype.scrollTo).mock.instances).not.toContain(strip);
});
