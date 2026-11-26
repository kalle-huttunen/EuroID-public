/**
 * Developer pages (/dev/*) exist only in non-production builds. This mirrors the
 * backend DevToolsGuard (backend/src/modules/dev-tools/dev-tools.guard.ts), which
 * answers 404 for every /dev endpoint when NODE_ENV === 'production'.
 * Vite sets import.meta.env.PROD from NODE_ENV, so a production build drops the
 * routes and their nav entries entirely.
 */
export const DEV_TOOLS_ENABLED = !import.meta.env.PROD;
