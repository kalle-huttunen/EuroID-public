import { ConfigProvider } from 'antd';
import { type PropsWithChildren, createContext, useEffect, useLayoutEffect, useState } from 'react';
import { lightTheme, darkTheme } from '../../theme';
import { ThemeCssVars } from '../../theme/ThemeCssVars';

type ColorModeContextType = {
  mode: 'light' | 'dark';
  setMode: () => void;
};

export const ColorModeContext = createContext<ColorModeContextType>({} as ColorModeContextType);

export const ColorModeContextProvider: React.FC<PropsWithChildren> = ({ children }) => {
  const colorModeFromLocalStorage = localStorage.getItem('colorMode');
  const isSystemPreferenceDark = window?.matchMedia('(prefers-color-scheme: dark)').matches;

  const systemPreference = isSystemPreferenceDark ? 'dark' : 'light';
  const [mode, setMode] = useState<'light' | 'dark'>(
    (colorModeFromLocalStorage as 'light' | 'dark') || systemPreference,
  );
  const themeConfig = mode === 'light' ? lightTheme : darkTheme;

  useEffect(() => {
    window.localStorage.setItem('colorMode', mode);
  }, [mode]);

  // antd's static message/notification calls render in a root of their own, outside the
  // ConfigProvider below: give them the app theme too, so they follow the colour mode.
  useLayoutEffect(() => {
    ConfigProvider.config({
      holderRender: (children) => <ConfigProvider theme={themeConfig}>{children}</ConfigProvider>,
    });
  }, [themeConfig]);

  const toggleColorMode = () => {
    setMode((prev) => (prev === 'light' ? 'dark' : 'light'));
  };

  return (
    <ColorModeContext.Provider
      value={{
        setMode: toggleColorMode,
        mode,
      }}
    >
      <ConfigProvider theme={themeConfig}>
        <ThemeCssVars mode={mode} />
        {children}
      </ConfigProvider>
    </ColorModeContext.Provider>
  );
};
