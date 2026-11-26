/** Single source of truth for API base. Use Vite env in production. */
const env = typeof import.meta !== "undefined" ? (import.meta as { env?: Record<string, string> }).env : undefined;
export const API_BASE = env?.VITE_API_BASE_URL ?? env?.VITE_API_BASE ?? "/api/v1";
