/**
 * SCIM Token Management API
 *
 * React Query hooks for generating, listing, and revoking SCIM bearer tokens.
 * Used by the SCIM Settings admin page.
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { axiosInstance } from "./data";
import { API_BASE } from "./constants";

// ── Types ────────────────────────────────────────────────────────────

export interface ScimTokenMetadata {
  id: string;
  name: string;
  createdBy: string;
  createdAt: string;
  lastUsedAt?: string;
  expiresAt?: string;
  status: string;
  scopes: string[];
}

export interface GenerateScimTokenResponse {
  id: string;
  name: string;
  token: string;
}

export interface GenerateScimTokenPayload {
  name: string;
  scopes?: string[];
  expiresAt?: string;
}

// ── React Query Keys ───────────────────────────────────────────────────

const SCIM_TOKENS_KEY = ["scim-tokens"] as const;

// ── Hooks ──────────────────────────────────────────────────────────────

/** Fetch list of SCIM tokens (metadata only) */
export function useScimTokens() {
  return useQuery({
    queryKey: SCIM_TOKENS_KEY,
    queryFn: async () => {
      const { data } = await axiosInstance.get<ScimTokenMetadata[]>(`${API_BASE}/scim-tokens`);
      return Array.isArray(data) ? data : [];
    },
  });
}

/** Generate a new SCIM token */
export function useGenerateScimToken() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: GenerateScimTokenPayload) => {
      const { data } = await axiosInstance.post<GenerateScimTokenResponse>(
        `${API_BASE}/scim-tokens`,
        payload,
        { headers: { "Content-Type": "application/json" } }
      );
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: SCIM_TOKENS_KEY });
    },
  });
}

/** Revoke a SCIM token */
export function useRevokeScimToken() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await axiosInstance.delete(`${API_BASE}/scim-tokens/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: SCIM_TOKENS_KEY });
    },
  });
}
