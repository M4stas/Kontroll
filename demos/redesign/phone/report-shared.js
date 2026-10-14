// Shared behaviour for the report versions: sheets, copy, checklist, supplement form.
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  $$("[data-open]").forEach(b => b.addEventListener("click", () => $("#" + b.dataset.open)?.showModal()));
  $$("dialog").forEach(d => {
    d.addEventListener("click", e => { if (e.target === d) d.close(); });
    $$("[data-close]", d).forEach(b => b.addEventListener("click", () => d.close()));
  });

  $("#copy")?.addEventListener("click", async () => {
    const out = $("#say");
    try { await navigator.clipboard.writeText($("#msg").value); out.textContent = "Copied. Paste it into Auto24."; }
    catch { out.textContent = "Could not copy. Select the text and copy it by hand."; }
  });

  const boxes = $$("#checklist input");
  boxes.forEach(c => c.addEventListener("change", () => {
    const done = boxes.filter(x => x.checked).length;
    if ($("#count")) $("#count").textContent = `${done} of ${boxes.length} done`;
  }));

  $("#file")?.addEventListener("change", e => {
    const n = e.target.files.length;
    $("#fname").textContent = n ? `${n} file${n > 1 ? "s" : ""}` : "Attach photos or a PDF";
  });
  $("#add-form")?.addEventListener("submit", e => { e.preventDefault(); $("#state").classList.add("on"); });
})();
