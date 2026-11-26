/**
 * GDPR API (backend `modules/compliance-reporting`, GdprComplianceController under /identity).
 * Every route takes the identity's `_id`. Consent list: viewer; consent grant, revoke and the
 * tenant consent report: operator; data subject access export: operator; erasure and its dry
 * run: super-admin, the erasure itself only with the `X-Confirm-Erasure: true` header.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { axiosInstance } from '@api/data';
import { API_BASE } from '@api/constants';
import { identityKeys } from '@api/identity-api';
import type {
  IConsent,
  IConsentGrant,
  IConsentReport,
  IDsarExportPackage,
  IDsarExportSummary,
  IErasureAttestation,
} from '../interfaces';

const identityPath = (id: string, rest: string) =>
  `${API_BASE}/identity/${encodeURIComponent(id)}/${rest}`;

export const gdprKeys = {
  all: ['gdpr'] as const,
  consents: (identityId: string) => [...gdprKeys.all, 'consents', identityId] as const,
  consentReport: () => [...gdprKeys.all, 'consent-report'] as const,
};

/** GET /identity/:id/consent: the identity's consent records, one per purpose. */
export function useConsents(identityId: string | undefined) {
  return useQuery({
    queryKey: gdprKeys.consents(identityId ?? ''),
    queryFn: async () => {
      const { data } = await axiosInstance.get<IConsent[]>(
        identityPath(identityId as string, 'consent'),
      );
      return Array.isArray(data) ? data : [];
    },
    enabled: !!identityId,
  });
}

/** GET /identity/compliance/consent-report (operator): the tenant's consent records per purpose. */
export function useConsentReport(enabled = true) {
  return useQuery({
    queryKey: gdprKeys.consentReport(),
    queryFn: async () => {
      const { data } = await axiosInstance.get<IConsentReport>(
        `${API_BASE}/identity/compliance/consent-report`,
      );
      return data;
    },
    enabled,
  });
}

/** Grant (or grant again) one purpose; the identity's list and the report reload. */
export function useGrantConsent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ identityId, grant }: { identityId: string; grant: IConsentGrant }) => {
      const { data } = await axiosInstance.post<IConsent>(
        identityPath(identityId, 'consent'),
        grant,
      );
      return data;
    },
    onSettled: () => qc.invalidateQueries({ queryKey: gdprKeys.all }),
  });
}

/** Revoke one purpose: the record stays with status revoked. */
export function useRevokeConsent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ identityId, purpose }: { identityId: string; purpose: string }) => {
      const { data } = await axiosInstance.delete<IConsent>(
        identityPath(identityId, `consent/${encodeURIComponent(purpose)}`),
      );
      return data;
    },
    onSettled: () => qc.invalidateQueries({ queryKey: gdprKeys.all }),
  });
}

/** The export's file name: the identity id and the export time, no personal data. */
export const dsarFileName = (identityId: string, exportedAt: string) =>
  `dsar-export-${identityId}-${dayjs(exportedAt).format('YYYYMMDD-HHmmss')}.json`;

/** Saves JSON as a file through the browser (the compliance reports' download pattern). */
function saveJsonFile(fileName: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

const count = (rows: unknown) => (Array.isArray(rows) ? rows.length : 0);

/** What the page keeps of an export: the counts, never the data itself. */
export function summarizeExport(pkg: IDsarExportPackage, fileName: string): IDsarExportSummary {
  return {
    fileName,
    exportedAt: pkg.exportedAt,
    exportedBy: pkg.exportedBy,
    counts: {
      timeline: count(pkg.timeline),
      auditTrail: count(pkg.auditTrail),
      accessReviews: count(pkg.accessReviews),
      accessReviewExclusions: count(pkg.accessReviewExclusions),
      entitlements: count(pkg.entitlements),
      consents: count(pkg.consents),
      records: Object.values(pkg.records ?? {}).reduce((sum, rows) => sum + count(rows), 0),
      linkedAdminIdentities: count(pkg.linkedAdminIdentities),
    },
  };
}

/**
 * GET /identity/:id/dsar-export, saved as a JSON file. The package (unmasked personal data) is
 * not kept in the query cache: the mutation answers only the summary.
 */
export function useDsarExport() {
  return useMutation({
    mutationFn: async (identityId: string): Promise<IDsarExportSummary> => {
      const { data } = await axiosInstance.get<IDsarExportPackage>(
        identityPath(identityId, 'dsar-export'),
      );
      const fileName = dsarFileName(identityId, data.exportedAt);
      saveJsonFile(fileName, data);
      return summarizeExport(data, fileName);
    },
  });
}

/** DELETE /identity/:id/gdpr-erase?dryRun=true: the counts, nothing deleted (audited as a dry run). */
async function previewErasure(identityId: string): Promise<IErasureAttestation> {
  const { data } = await axiosInstance.delete<IErasureAttestation>(
    identityPath(identityId, 'gdpr-erase'),
    { params: { dryRun: 'true' } },
  );
  return data;
}

export interface ErasurePreview {
  data?: IErasureAttestation;
  error?: unknown;
  isError: boolean;
  /** Runs the dry run again (Retry after a failure). */
  retry: () => void;
}

/**
 * The erasure dry run of one identity, run once when the calling component mounts: each run
 * writes an audit entry. The answer goes to component state. It was a mutation fired from an
 * effect, and under React.StrictMode the mutation observer is unsubscribed and resubscribed after
 * that first call, so it never received the answer and the preview stayed a skeleton. The ref
 * keeps StrictMode's second effect run from starting a second dry run.
 */
export function useErasurePreview(identityId: string): ErasurePreview {
  const [state, setState] = useState<{ data?: IErasureAttestation; error?: unknown }>({});
  const start = useCallback(() => {
    previewErasure(identityId).then(
      (data) => setState({ data }),
      (error: unknown) => setState({ error: error ?? new Error('the request failed') }),
    );
  }, [identityId]);
  const retry = useCallback(() => {
    setState({});
    start();
  }, [start]);

  const startedFor = useRef<string | null>(null);
  useEffect(() => {
    if (startedFor.current === identityId) return;
    startedFor.current = identityId;
    start();
  }, [identityId, start]);

  return { ...state, isError: state.error !== undefined, retry };
}

/** The erasure itself; the identity lists and consent views reload (the identity is gone). */
export function useEraseIdentity() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (identityId: string) => {
      const { data } = await axiosInstance.delete<IErasureAttestation>(
        identityPath(identityId, 'gdpr-erase'),
        { headers: { 'X-Confirm-Erasure': 'true' } },
      );
      return data;
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: identityKeys.all() });
      qc.invalidateQueries({ queryKey: gdprKeys.all });
    },
  });
}
