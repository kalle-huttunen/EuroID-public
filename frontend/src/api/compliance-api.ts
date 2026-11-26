/**
 * Compliance Reports API
 *
 * Backend: POST /api/v1/compliance-reports/generate,
 *         GET /api/v1/compliance-reports,
 *         GET /api/v1/compliance-reports/:id/download
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { axiosInstance } from "./data";
import { API_BASE } from "./constants";

export const complianceKeys = {
  all: ["compliance-reports"] as const,
  list: (filters?: { type?: string }) => [...complianceKeys.all, "list", filters] as const,
};

export type ReportType = "SOX" | "ISO27001";
export type ReportFormat = "PDF" | "CSV";

export interface ReportMetadata {
  reportId: string;
  tenantId: string;
  type: ReportType;
  format: ReportFormat;
  dateRange: { from: string; to: string };
  generatedBy: string;
  generatedAt: string;
  fileSize: number;
  filePath: string;
  summary: { criticalFindings: number; complianceScore: number };
}

export interface GenerateReportRequest {
  type: ReportType;
  dateRange: { from: string; to: string };
  format: ReportFormat;
}

export interface GenerateReportResponse {
  reportId: string;
  downloadUrl: string;
  summary: { criticalFindings: number; complianceScore: number };
}

export function useComplianceReports(filters?: { type?: ReportType }) {
  return useQuery({
    queryKey: complianceKeys.list(filters),
    queryFn: async (): Promise<ReportMetadata[]> => {
      const params = new URLSearchParams();
      if (filters?.type) params.set("type", filters.type);
      const { data } = await axiosInstance.get<ReportMetadata[]>(
        `${API_BASE}/compliance-reports${params.toString() ? `?${params.toString()}` : ""}`
      );
      return Array.isArray(data) ? data : [];
    },
  });
}

export function useGenerateComplianceReport() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: GenerateReportRequest): Promise<GenerateReportResponse> => {
      const { data } = await axiosInstance.post<GenerateReportResponse>(
        `${API_BASE}/compliance-reports/generate`,
        body
      );
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: complianceKeys.all });
    },
  });
}

/**
 * Download a report file. Fetches as blob and triggers browser download.
 */
export async function downloadComplianceReport(reportId: string): Promise<void> {
  const { data } = await axiosInstance.get<Blob>(
    `${API_BASE}/compliance-reports/${reportId}/download`,
    { responseType: "blob" }
  );
  const ext = data.type === "application/pdf" ? "pdf" : "csv";
  const url = URL.createObjectURL(data);
  const a = document.createElement("a");
  a.href = url;
  a.download = `compliance-report-${reportId}.${ext}`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
