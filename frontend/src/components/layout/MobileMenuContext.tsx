import React, { createContext, useContext, useState, useCallback } from 'react';

interface MobileMenuContextValue {
  open: boolean;
  setOpen: (v: boolean) => void;
  toggle: () => void;
}

const MobileMenuContext = createContext<MobileMenuContextValue | null>(null);

export function MobileMenuProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((v) => !v), []);
  return (
    <MobileMenuContext.Provider value={{ open, setOpen, toggle }}>
      {children}
    </MobileMenuContext.Provider>
  );
}

export function useMobileMenu() {
  const ctx = useContext(MobileMenuContext);
  return ctx ?? { open: false, setOpen: () => {}, toggle: () => {} };
}
