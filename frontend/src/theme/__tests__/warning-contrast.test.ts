import { describe, it, expect } from 'vitest';
import { BRAND, DARK, lightTheme, darkTheme } from '../themeConfig';

// WCAG 2.x relative luminance and contrast ratio.
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const AA_SMALL_TEXT = 4.5;

describe('warning text tokens', () => {
  it('light warning text meets AA on white, the layout background and as a fill under white text', () => {
    for (const bg of [BRAND.bgContainer, BRAND.bgLayout, BRAND.rowHover, '#FFFFFF']) {
      expect(contrast(BRAND.warningText, bg), bg).toBeGreaterThanOrEqual(AA_SMALL_TEXT);
    }
  });

  it('dark warning text meets AA on every dark surface', () => {
    for (const bg of [DARK.bgLayout, DARK.bgContainer, DARK.bgElevated, DARK.rowHover]) {
      expect(contrast(DARK.warningText, bg), bg).toBeGreaterThanOrEqual(AA_SMALL_TEXT);
    }
  });

  it('antd warning text and warning tags use the text shade, not the icon seed', () => {
    expect(lightTheme.token?.colorWarningText).toBe(BRAND.warningText);
    expect(darkTheme.token?.colorWarningText).toBe(DARK.warningText);
    expect(lightTheme.components?.Tag?.colorWarning).toBe(BRAND.warningText);
    expect(darkTheme.components?.Tag?.colorWarning).toBe(DARK.warningText);
    // The seed itself is too light for small text; it stays for icons and large numerals.
    expect(contrast(BRAND.warning, '#FFFFFF')).toBeLessThan(AA_SMALL_TEXT);
  });
});
