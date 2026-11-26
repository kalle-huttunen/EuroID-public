/**
 * Publishes the active theme tokens as CSS custom properties on <html>, so plain
 * stylesheets (src/styles/*.css) can use them without defining colors of their own.
 * Must render inside the antd ConfigProvider.
 */
import { useLayoutEffect } from 'react';
import { theme } from 'antd';
import { LIVE } from './themeConfig';

export function ThemeCssVars({ mode }: { mode: 'light' | 'dark' }) {
  const { token } = theme.useToken();

  useLayoutEffect(() => {
    const root = document.documentElement;
    const vars: Record<string, string> = {
      '--euroid-bg-layout': token.colorBgLayout,
      '--euroid-bg-container': token.colorBgContainer,
      '--euroid-border': token.colorBorder,
      '--euroid-border-hairline': token.colorBorderSecondary,
      '--euroid-text': token.colorText,
      '--euroid-text-secondary': token.colorTextSecondary,
      '--euroid-fill': token.colorFillTertiary,
      '--euroid-focus': token.colorPrimary,
      '--euroid-font-mono': token.fontFamilyCode,
      '--euroid-live': LIVE.color,
      '--euroid-live-glow': LIVE.glow,
      '--euroid-live-glow-soft': LIVE.glowSoft,
    };
    for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
    root.style.colorScheme = mode;
    root.dataset.colorMode = mode;
  }, [token, mode]);

  return null;
}
