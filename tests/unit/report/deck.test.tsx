import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import en from "../../../messages/en.json";
import { Deck, type DeckCard } from "@/features/report/deck/deck";
const cards: DeckCard[] = ["Cover", "Finding", "Message"].map(name => ({id:name,name,content:<button>{name} content</button>}));
const view = (items = cards) => <NextIntlClientProvider locale="en" messages={en}><Deck label="Report cards" cards={items} firstNextLabel="See the findings" /></NextIntlClientProvider>;
beforeEach(() => { HTMLElement.prototype.scrollTo = vi.fn(); window.matchMedia = vi.fn().mockReturnValue({matches:false}); });
afterEach(cleanup);
const current = (name: string) => expect(screen.getByRole("button", {name:`Go to ${name}`})).toHaveAttribute("aria-current", "step");
it("labels Next with the first-card label, then with the next card's name", () => {
 render(view()); fireEvent.click(screen.getByRole("button", {name:"See the findings"})); expect(screen.getByRole("button", {name:"Next: Message"})).toBeVisible();
});
it("disables Back on the first card and hides Next on the last", () => {
 render(view()); expect(screen.getByRole("button", {name:"Back"})).toBeDisabled(); fireEvent.click(screen.getByRole("button", {name:"Go to Message"})); expect(screen.queryByRole("button", {name:/Next:/})).toBeNull();
});
it("moves with ArrowRight and ArrowLeft", () => {
 render(view()); const track=screen.getByRole("region", {name:"Report cards"}); fireEvent.keyDown(track,{key:"ArrowRight"}); current("Finding"); fireEvent.keyDown(track,{key:"ArrowLeft"}); current("Cover");
});
it("marks the card current when focus moves into it", () => {
 render(view()); fireEvent.focus(screen.getByRole("button",{name:"Message content"})); current("Message"); expect(HTMLElement.prototype.scrollTo).toHaveBeenCalled();
});
it("keeps the current card when the card list re-renders with the same ids", () => {
 const rendered=render(view()); fireEvent.click(screen.getByRole("button",{name:"Go to Finding"})); vi.mocked(HTMLElement.prototype.scrollTo).mockClear(); rendered.rerender(view([cards[2]!,cards[0]!,cards[1]!])); current("Finding"); expect(HTMLElement.prototype.scrollTo).toHaveBeenCalledOnce();
 vi.mocked(HTMLElement.prototype.scrollTo).mockClear(); rendered.rerender(view([cards[2]!,cards[0]!,cards[1]!])); expect(HTMLElement.prototype.scrollTo).not.toHaveBeenCalled();
});
it("clamps to the last card when the current card disappears", () => {
 const rendered=render(view()); fireEvent.click(screen.getByRole("button",{name:"Go to Message"})); rendered.rerender(view(cards.slice(0,2))); current("Finding");
});
it("leaves text-editing arrow keys alone", () => {
 render(view([{...cards[0]!,content:<textarea aria-label="Message text"/>},...cards.slice(1)])); fireEvent.keyDown(screen.getByRole("textbox"),{key:"ArrowRight"}); current("Cover");
});
it("uses immediate scrolling under reduced motion", () => {
 vi.mocked(window.matchMedia).mockReturnValue({matches:true} as MediaQueryList); render(view()); fireEvent.click(screen.getByRole("button",{name:"Go to Finding"})); expect(HTMLElement.prototype.scrollTo).toHaveBeenLastCalledWith({left:0,behavior:"auto"});
});

it("throttles scroll updates to one animation frame", () => {
 const frames: FrameRequestCallback[] = [];
 const request = vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => { frames.push(callback); return frames.length; });
 render(view()); const track = screen.getByRole("region", {name:"Report cards"});
 Array.from(track.children).forEach((child,index) => Object.defineProperty(child,"offsetLeft",{value:index*1000}));
 track.scrollLeft = 1600; fireEvent.scroll(track); fireEvent.scroll(track);
 expect(request).toHaveBeenCalledTimes(1); current("Cover");
 act(() => frames[0]!(0)); current("Message"); request.mockRestore();
});
it("keeps the current id when cards reorder before a pending scroll frame", () => {
 const frames = new Map<number, FrameRequestCallback>();
 const request = vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => { frames.set(1, callback); return 1; });
 const cancel = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(id => { frames.delete(id); });
 const rendered = render(view());
 const track = screen.getByRole("region", {name:"Report cards"});
 Array.from(track.children).forEach(child => Object.defineProperty(child,"offsetLeft", {configurable:true,get:() => Array.from(track.children).indexOf(child)*1000}));
 vi.mocked(HTMLElement.prototype.scrollTo).mockImplementation(function(this: HTMLElement, options) {
   this.scrollLeft = (options as ScrollToOptions).left ?? 0;
 });
 fireEvent.click(screen.getByRole("button", {name:"Go to Finding"}));
 fireEvent.scroll(track);
 rendered.rerender(view([cards[2]!,cards[0]!,cards[1]!]));
 act(() => { frames.forEach(callback => callback(0)); });
 current("Finding"); request.mockRestore(); cancel.mockRestore();
});
