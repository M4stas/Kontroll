// Walkthrough deck. Works for any [data-deck] with [data-track], [data-dots], [data-prev], [data-next], [data-where].
(() => {
  const smooth = () => matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
  document.querySelectorAll("[data-deck]").forEach(deck => {
    const track = deck.querySelector("[data-track]");
    const cards = [...track.children];
    const dots = deck.querySelector("[data-dots]");
    const prev = deck.querySelector("[data-prev]"), next = deck.querySelector("[data-next]"), where = deck.querySelector("[data-where]");
    let cur = 0;
    if (dots) cards.forEach((c, i) => {
      const b = document.createElement("button");
      b.type = "button"; b.setAttribute("aria-label", `Go to ${c.dataset.name}`);
      b.onclick = () => go(i); dots.append(b);
    });
    function update(i) {
      cur = i;
      if (dots) [...dots.children].forEach((d, j) => { d.classList.toggle("done", j < i); j === i ? d.setAttribute("aria-current", "step") : d.removeAttribute("aria-current"); });
      if (prev) prev.disabled = i === 0;
      if (next) {
        next.hidden = i === cards.length - 1;
        const label = i === 0 && next.dataset.first ? next.dataset.first : `Next: ${cards[i + 1]?.dataset.name ?? ""}`;
        next.firstChild.textContent = label + " ";
      }
      if (where) where.textContent = cards[i].dataset.name;
      deck.dispatchEvent(new CustomEvent("deck:change", { detail: { index: i, card: cards[i] } }));
    }
    function go(i) {
      i = Math.max(0, Math.min(cards.length - 1, i));
      update(i);
      track.scrollTo({ left: cards[i].offsetLeft - track.offsetLeft, behavior: smooth() });
    }
    deck.go = go;
    track.addEventListener("scroll", () => {
      if (!track.clientWidth) return;
      const x = track.scrollLeft;
      let i = 0, best = Infinity;
      cards.forEach((c, j) => { const d = Math.abs(c.offsetLeft - track.offsetLeft - x); if (d < best) { best = d; i = j; } });
      if (i !== cur) update(i);
    }, { passive: true });
    prev?.addEventListener("click", () => go(cur - 1));
    next?.addEventListener("click", () => go(cur + 1));
    deck.querySelectorAll("[data-go]").forEach(b => b.addEventListener("click", () => go(+b.dataset.go)));
    track.addEventListener("keydown", e => {
      if (e.key === "ArrowRight") { e.preventDefault(); go(cur + 1); }
      if (e.key === "ArrowLeft") { e.preventDefault(); go(cur - 1); }
    });
    update(0);
  });
})();
