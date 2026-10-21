// Only the project's fake checkbox and grid are understood.
// Like the real extension, it asks its worker before it picks tiles, so a stopped
// worker has to wake up for the solve to go on.
const clicks = new WeakMap();  // grid table -> per-tile [count, src at last click]
const submitted = new WeakSet();
let busy = false;
setInterval(async () => {
  const box = document.querySelector('#recaptcha-anchor[aria-checked="false"]');
  if (box && !box.classList.contains('recaptcha-checkbox-loading')) box.click();
  const table = document.querySelector('#rc-imageselect-target table');
  if (!table || submitted.has(table) || busy) return;
  busy = true;
  try {
    if (!(await chrome.runtime.sendMessage('ready').catch(() => false))) return;
    const tiles = table.querySelectorAll('td.rc-imageselect-tile');
    if (!clicks.has(table)) clicks.set(table, {});
    const seen = clicks.get(table);
    let clicked = false;
    // A dynamic grid refills a clicked tile; each tile gets at most two clicks.
    [0, 4, 8].forEach(i => {
      const tile = tiles[i];
      if (!tile || tile.classList.contains('rc-imageselect-tileselected')) return;
      const src = tile.querySelector('img')?.src;
      const [count, last] = seen[i] || [0, null];
      if (count >= 2 || src === last) return;
      seen[i] = [count + 1, src];
      tile.click();
      clicked = true;
    });
    if (!clicked) {
      submitted.add(table);
      document.querySelector('#recaptcha-verify-button')?.click();
    }
  } finally {
    busy = false;
  }
}, 200);
