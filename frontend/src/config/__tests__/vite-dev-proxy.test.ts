/**
 * Real-time updates in `vite dev`. The gateway is the socket.io namespace /events on socket.io's
 * default path /socket.io (backend/src/infrastructure/realtime/events.gateway.ts). The dev server
 * proxied /events only, so the polling requests to /socket.io got the SPA's 200 and the top bar
 * said "Connecting..." forever.
 */
import { describe, it, expect, vi } from 'vitest';
import type { ProxyOptions, UserConfig } from 'vite';
import viteConfig from '../../../vite.config';

// Only the config object matters here. The real modules load esbuild, which refuses to run
// under jsdom (its TextEncoder check), so the file would fail before any assertion.
vi.mock('vite', () => ({ defineConfig: (config: unknown) => config }));
vi.mock('@vitejs/plugin-react', () => ({ default: () => ({ name: 'vite:react' }) }));
vi.mock('rollup-plugin-visualizer', () => ({ visualizer: () => ({ name: 'visualizer' }) }));

const proxy = (viteConfig as UserConfig).server?.proxy as Record<string, ProxyOptions>;

describe('vite dev proxy', () => {
  it('sends socket.io requests and websocket upgrades to the backend', () => {
    expect(proxy['/socket.io']).toMatchObject({
      target: proxy['/api'].target,
      changeOrigin: true,
      ws: true,
    });
  });
});
