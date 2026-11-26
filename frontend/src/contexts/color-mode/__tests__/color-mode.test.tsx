/**
 * Static antd toasts (`message.*`, still called in about 30 files) render in a root of their own,
 * outside the app's ConfigProvider, so they kept antd's default light theme in dark mode. The
 * colour-mode provider hands them the app theme. antd's CSS-in-JS gives every component under one
 * theme the same hash class, so a toast in the app theme carries the app's hash class.
 */
import React, { useContext } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Button, ConfigProvider, message } from 'antd';
import '../../../config/antd-react19';
import { ColorModeContext, ColorModeContextProvider } from '..';

const hashClass = (el: Element | null) =>
  [...(el?.classList ?? [])].find((c) => c.startsWith('css-'));

function ModeSwitch() {
  const { mode, setMode } = useContext(ColorModeContext);
  return <Button onClick={setMode}>Mode: {mode}</Button>;
}

/** Shows a static toast and returns the hash class of the theme it rendered in. */
async function toastTheme(text: string): Promise<string | undefined> {
  message.info(text);
  const toast = await screen.findByText(text);
  return hashClass(toast.closest('.ant-message'));
}

describe('ColorModeContextProvider and static toasts', () => {
  beforeEach(() => localStorage.setItem('colorMode', 'dark'));

  afterEach(async () => {
    message.destroy();
    ConfigProvider.config({ holderRender: undefined });
    localStorage.removeItem('colorMode');
    // Let the closed toasts unmount before the next test (see config/__tests__/antd-react19).
    for (let turn = 0; turn < 3; turn += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });

  it('renders a static toast in the dark theme in dark mode, and in light after the switch', async () => {
    const user = userEvent.setup();
    render(
      <ColorModeContextProvider>
        <ModeSwitch />
      </ColorModeContextProvider>,
    );
    const darkApp = hashClass(screen.getByRole('button', { name: /Mode: dark/ }));
    // antd's own default theme, which a toast outside the app theme falls back to.
    const { unmount } = render(
      <ConfigProvider>
        <Button>Default</Button>
      </ConfigProvider>,
    );
    const antdDefault = hashClass(screen.getByRole('button', { name: 'Default' }));
    unmount();
    expect(darkApp).toBeDefined();
    expect(darkApp).not.toBe(antdDefault);

    expect(await toastTheme('Saved in dark mode')).toBe(darkApp);

    await user.click(screen.getByRole('button', { name: /Mode: dark/ }));
    const lightApp = hashClass(await screen.findByRole('button', { name: /Mode: light/ }));
    expect(lightApp).not.toBe(darkApp);
    expect(await toastTheme('Saved in light mode')).toBe(lightApp);
  });
});
