import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(process.cwd(), 'src/app/[locale]/styles/tokens.css'), 'utf8');
function parseTokens(block: string | undefined): Record<string, string> {
  expect(block, 'theme root block must exist').toBeDefined();
  return Object.fromEntries([...block!.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((match) => [match[1], match[2].trim()]));
}
const themes = {
  light: parseTokens(css.match(/:root\s*\{([^}]+)\}/)?.[1]),
  dark: parseTokens(css.match(/@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root\s*\{([^}]+)\}/)?.[1]),
};
function luminance(hex: string): number {
  expect(hex).toMatch(/^#[\da-f]{6}$/i);
  const channels = [1, 3, 5].map((offset) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}
function contrast(foreground: string, background: string): number {
  const values = [luminance(foreground), luminance(background)];
  return (Math.max(...values) + 0.05) / (Math.min(...values) + 0.05);
}
const names = ['--bg', '--surface', '--surface-2', '--text', '--text-2', '--line', '--accent', '--accent-text', '--accent-soft', '--attention', '--shadow'];
const pairs = [
  ['--text', '--bg'], ['--text', '--surface'],
  ['--text-2', '--bg'], ['--text-2', '--surface'], ['--text-2', '--surface-2'],
  ['--accent', '--bg'], ['--accent', '--surface'], ['--accent-text', '--accent'],
  ['--attention', '--bg'], ['--attention', '--surface'],
];
for (const [name, tokens] of Object.entries(themes)) {
  describe(`${name} design tokens`, () => {
    it.each(names)('defines %s', (token) => {
      expect(tokens[token]).toBeTruthy();
    });
    it.each(pairs)('%s on %s meets WCAG AA contrast', (foreground, background) => {
      expect(contrast(tokens[foreground], tokens[background])).toBeGreaterThanOrEqual(4.5);
    });
  });
}
