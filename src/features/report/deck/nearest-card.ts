export function nearestCardIndex(offsets: number[], scrollLeft: number): number {
  let nearest = 0;
  let distance = Infinity;
  offsets.forEach((offset, index) => {
    const candidate = Math.abs(offset - scrollLeft);
    if (candidate < distance) { nearest = index; distance = candidate; }
  });
  return nearest;
}
