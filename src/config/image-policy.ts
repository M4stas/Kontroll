/** Shared bounds for accepted images and their private reviewer copy. */
export const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 40_000_000;
// A 1600px RGBA PNG remains below the accepted byte limit even without compression.
export const REVIEW_IMAGE_DIMENSION = 1600;
