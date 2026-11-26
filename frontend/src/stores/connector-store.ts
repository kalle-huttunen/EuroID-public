/**
 * Connector Store -- Zustand + persist + backend sync
 *
 * Tracks which connectors from CONNECTOR_REGISTRY are installed. Backend is the
 * source of truth for config. localStorage persists only connector names and
 * install timestamps — never config values. Config is fetched from the backend
 * via syncFromBackend() on mount, or ensureSynced() where a list already loaded
 * in this page session is good enough (the Design studio canvas).
 *
 * install, uninstall and updateConfig change the store only after the backend
 * accepted the change; a refused one rejects with the API's error and leaves the
 * store as it was (callers show apiErrorMessage). A failed GET /connectors (the
 * 503 of a config this process cannot decrypt included) is kept in `syncError`
 * for the pages to show instead of the persisted names with empty configs.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { API_BASE } from '@api/constants';
import { axiosInstance } from '@api/data';

const CONNECTOR_API = `${API_BASE}/connectors`;

export interface ConnectorConfig {
  connectorName: string;
  config: Record<string, string>;
  installedAt: string;
}

interface ConnectorStore {
  installed: ConnectorConfig[];
  /** True once this page session has loaded the installed list from the backend. Not persisted. */
  syncedFromBackend: boolean;
  /** The error of the last failed GET /connectors; null once one succeeded. Not persisted. */
  syncError: unknown;
  install: (name: string, config: Record<string, string>) => Promise<void>;
  uninstall: (name: string) => Promise<void>;
  isInstalled: (name: string) => boolean;
  getConfig: (name: string) => ConnectorConfig | undefined;
  updateConfig: (name: string, config: Record<string, string>) => Promise<void>;
  syncFromBackend: () => Promise<void>;
  /** syncFromBackend() unless this page session already loaded the list (e.g. on the Marketplace). */
  ensureSynced: () => Promise<void>;
  /** Clear store and persisted state (call on logout to prevent cross-user data leak). */
  clearOnLogout: () => void;
}

/** The GET /connectors in flight; concurrent callers share it instead of fetching again. */
let inflightSync: Promise<void> | null = null;
/** Bumped by clearOnLogout: a load started before it belongs to the previous session. */
let session = 0;

export const useConnectorStore = create<ConnectorStore>()(
  persist(
    (set, get) => ({
      installed: [],
      syncedFromBackend: false,
      syncError: null,

      install: async (name, config) => {
        if (get().installed.some((c) => c.connectorName === name)) return;
        await axiosInstance.post(`${CONNECTOR_API}/${encodeURIComponent(name)}/install`, {
          config,
        });
        set({
          installed: [
            ...get().installed,
            { connectorName: name, config, installedAt: new Date().toISOString() },
          ],
        });
      },

      uninstall: async (name) => {
        await axiosInstance.delete(`${CONNECTOR_API}/${encodeURIComponent(name)}`);
        set({ installed: get().installed.filter((c) => c.connectorName !== name) });
      },

      isInstalled: (name) => {
        return get().installed.some((c) => c.connectorName === name);
      },

      getConfig: (name) => {
        return get().installed.find((c) => c.connectorName === name);
      },

      updateConfig: async (name, config) => {
        await axiosInstance.patch(`${CONNECTOR_API}/${encodeURIComponent(name)}`, { config });
        set({
          installed: get().installed.map((c) => (c.connectorName === name ? { ...c, config } : c)),
        });
      },

      syncFromBackend: () => {
        const startedIn = session;
        inflightSync ??= (async () => {
          try {
            const { data } = await axiosInstance.get(CONNECTOR_API);
            if (startedIn !== session) return;
            // The backend is the source of truth: an empty list empties the persisted names too.
            if (Array.isArray(data)) {
              set({
                installed: data.map((c: ConnectorConfig) => ({
                  connectorName: c.connectorName,
                  config: c.config ?? {},
                  installedAt: c.installedAt,
                })),
              });
            }
            set({ syncedFromBackend: true, syncError: null });
          } catch (error: unknown) {
            if (startedIn !== session) return;
            // Kept for the pages to show; the next call tries again
            set({ syncError: error });
          }
        })().finally(() => {
          // A logout may have dropped this load already and a new session started its own.
          if (startedIn === session) inflightSync = null;
        });
        return inflightSync;
      },

      ensureSynced: () => (get().syncedFromBackend ? Promise.resolve() : get().syncFromBackend()),

      clearOnLogout: () => {
        session += 1;
        inflightSync = null;
        set({ installed: [], syncedFromBackend: false, syncError: null });
      },
    }),
    {
      name: 'euroid-connector-store',
      partialize: (state) => ({
        installed: state.installed.map((c) => ({
          connectorName: c.connectorName,
          installedAt: c.installedAt,
        })),
      }),
      merge: (persisted, current) => {
        const p = persisted as
          | { installed?: Array<{ connectorName: string; installedAt: string }> }
          | undefined;
        return {
          ...current,
          installed: (p?.installed ?? []).map((c) => ({
            connectorName: c.connectorName,
            config: {},
            installedAt: c.installedAt,
          })),
        };
      },
    },
  ),
);
