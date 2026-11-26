/**
 * Command palette open state — shared by the Ctrl/Cmd+K shortcut, the top bar
 * search pill and the palette itself.
 */
import { create } from 'zustand';

interface CommandPaletteStore {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
}

export const useCommandPaletteStore = create<CommandPaletteStore>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
  toggle: () => set((s) => ({ open: !s.open })),
}));
