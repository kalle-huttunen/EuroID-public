/**
 * Tenant Management API
 *
 * React Query hooks for tenant CRUD operations.
 * Platform admin only (PLATFORM_ADMIN_USER_IDS on the API). Uses axiosInstance (includes auth + X-Tenant-Id).
 */
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { axiosInstance } from "./data";
import { API_BASE } from "./constants";

// ── Types ────────────────────────────────────────────────────────────

export interface Tenant {
  _id?: string;
  tenantId: string;
  name: string;
  status: string;
  settings?: {
    maxIdentities?: number;
    retentionDays?: number;
    allowedConnectors?: string[];
    features?: Record<string, boolean>;
  };
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface CreateTenantPayload {
  tenantId: string;
  name: string;
  createdBy?: string;
}

export interface UpdateTenantPayload {
  name?: string;
  settings?: Tenant["settings"];
  status?: "active" | "suspended";
}

// ── React Query Keys ───────────────────────────────────────────────────

export const TENANTS_KEY = ["tenants"] as const;

// ── Hooks ──────────────────────────────────────────────────────────────

/** Fetch list of all tenants (platform admin) */
export function useTenants() {
  return useQuery({
    queryKey: TENANTS_KEY,
    queryFn: async () => {
      const { data } = await axiosInstance.get<Tenant[]>(`${API_BASE}/tenants`);
      return Array.isArray(data) ? data : [];
    },
  });
}

/** Fetch single tenant by ID */
export function useTenantById(id: string | null) {
  return useQuery({
    queryKey: [...TENANTS_KEY, id],
    queryFn: async () => {
      const { data } = await axiosInstance.get<Tenant>(`${API_BASE}/tenants/${id}`);
      return data;
    },
    enabled: !!id,
  });
}

/** Create a new tenant */
export function useCreateTenant() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: CreateTenantPayload) => {
      const { data } = await axiosInstance.post<Tenant>(`${API_BASE}/tenants`, payload, {
        headers: { "Content-Type": "application/json" },
      });
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: TENANTS_KEY });
    },
  });
}

/** Update tenant settings */
export function useUpdateTenant() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      data,
    }: {
      id: string;
      data: UpdateTenantPayload;
    }) => {
      const { data: result } = await axiosInstance.patch<Tenant>(
        `${API_BASE}/tenants/${id}`,
        data,
        { headers: { "Content-Type": "application/json" } }
      );
      return result;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: TENANTS_KEY });
    },
  });
}

/** Suspend tenant (DELETE) */
export function useSuspendTenant() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data } = await axiosInstance.delete<Tenant>(`${API_BASE}/tenants/${id}`);
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: TENANTS_KEY });
    },
  });
}
