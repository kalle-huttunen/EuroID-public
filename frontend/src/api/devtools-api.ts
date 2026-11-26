/**
 * Dev Tools API – React Query hooks for Workflow Debugger & Transaction Viewer.
 * Backend: GET /api/v1/dev/workflows, GET /api/v1/dev/transactions
 */

import { useQuery } from "@tanstack/react-query";
import { axiosInstance } from "./data";
import { API_BASE } from "./constants";
import type { IWorkflowExecution, IDistributedTransaction } from "../interfaces/developer.interface";

export const devToolsKeys = {
  workflows: (filters?: Record<string, unknown>) => ["dev", "workflows", filters] as const,
  transactions: (filters?: Record<string, unknown>) => ["dev", "transactions", filters] as const,
};

export function useWorkflows(filters?: { status?: string; type?: string }) {
  return useQuery({
    queryKey: devToolsKeys.workflows(filters as Record<string, unknown>),
    queryFn: async (): Promise<IWorkflowExecution[]> => {
      const { data } = await axiosInstance.get<IWorkflowExecution[] | { data: IWorkflowExecution[] }>(
        `${API_BASE}/dev/workflows`,
        { params: filters }
      );
      if (Array.isArray(data)) return data;
      return (data as { data: IWorkflowExecution[] }).data ?? [];
    },
    retry: (failureCount, error: unknown) => {
      const status = error && typeof error === "object" && "response" in error
        ? (error as { response?: { status?: number } }).response?.status
        : undefined;
      if (status === 404 || status === 501) return false;
      return failureCount < 2;
    },
  });
}

export function useTransactions(filters?: { phase?: string }) {
  return useQuery({
    queryKey: devToolsKeys.transactions(filters as Record<string, unknown>),
    queryFn: async (): Promise<IDistributedTransaction[]> => {
      const { data } = await axiosInstance.get<IDistributedTransaction[] | { data: IDistributedTransaction[] }>(
        `${API_BASE}/dev/transactions`,
        { params: filters }
      );
      if (Array.isArray(data)) return data;
      return (data as { data: IDistributedTransaction[] }).data ?? [];
    },
    retry: (failureCount, error: unknown) => {
      const status = error && typeof error === "object" && "response" in error
        ? (error as { response?: { status?: number } }).response?.status
        : undefined;
      if (status === 404 || status === 501) return false;
      return failureCount < 2;
    },
  });
}
