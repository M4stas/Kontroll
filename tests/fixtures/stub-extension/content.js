// Only the project's fake checkbox and grid are understood.
setInterval(() => {
  const box = document.querySelector('#recaptcha-anchor[aria-checked="false"]');
  if (box && !box.classList.contains('recaptcha-checkbox-loading')) box.click();
  const tiles = document.querySelectorAll('td.rc-imageselect-tile');
  if (tiles.length) {
    [0, 4, 8].forEach(i => { if (tiles[i] && !tiles[i].classList.contains('rc-imageselect-tileselected')) tiles[i].click(); });
    document.querySelector('#recaptcha-verify-button')?.click();
  }
}, 200);
