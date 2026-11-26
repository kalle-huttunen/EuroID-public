/**
 * Access Requests API — self-service access request portal
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { axiosInstance } from '@api/data';
import { API_BASE } from '@api/constants';

export const accessRequestKeys = {
  all: ['access-requests'] as const,
  list: (filters?: { status?: string }) => [...accessRequestKeys.all, 'list', filters] as const,
  removalFailing: (page: number) => [...accessRequestKeys.all, 'removal-failing', page] as const,
  detail: (id: string) => [...accessRequestKeys.all, 'detail', id] as const,
  pendingApprovals: () => [...accessRequestKeys.all, 'pending-approvals'] as const,
  pendingCount: () => [...accessRequestKeys.all, 'pending-count'] as const,
  requestableCatalog: (filters?: Record<string, string | number>) =>
    [...accessRequestKeys.all, 'requestable', filters] as const,
  sodPreCheck: (entryIds: string) => [...accessRequestKeys.all, 'sod-pre-check', entryIds] as const,
};

export interface RequestableCatalogEntry {
  _id: string;
  name: string;
  system: string;
  /** The entitlement's id in its system; absent for an entry not yet linked to one. */
  nativeId?: string;
  type: string;
  riskLevel?: string;
  category?: string;
  userDescription?: string;
  maxDurationDays?: number;
  approvalChain?: Array<{ type: string; value?: string }>;
}

export interface AccessRequestEntitlement {
  catalogEntryId: string;
  system: string;
  entitlementName: string;
  justification: string;
}

export interface ApprovalStep {
  stepOrder: number;
  approverType: string;
  approverEmail?: string;
  status: string;
  decidedAt?: string;
  justification?: string;
}

export interface AccessRequest {
  requestId: string;
  requesterId: string;
  requesterEmail: string;
  entitlements: AccessRequestEntitlement[];
  status: string;
  approvalSteps: ApprovalStep[];
  timeConstraint?: { requestedDurationDays?: number; expiresAt?: string };
  /**
   * Passed with the Warn matches found at request time; passed false with the Block match that
   * rejected the request when its last approval came in.
   */
  sodCheckResult?: { passed: boolean; violations?: StoredSodViolation[] };
  createdAt?: string;
  provisionedAt?: string;
  expiresAt?: string;
  /**
   * Why EuroID ended the request: its end date passed before approval completed (EXPIRED), or
   * its approval workflow had ended when an approver decided (CANCELLED), or its fulfilment
   * failed (REJECTED). On an ACTIVE request: why the removal at its end date waits. On a request
   * an admin closed as removed by hand: their note.
   */
  statusReason?: string;
  /** An admin removed the access by hand and closed the request (EXPIRED). */
  removedManually?: { by: string; at: string; note: string; failureReason?: string };
}

export interface CreateAccessRequestRequest {
  entitlements: Array<{ catalogEntryId: string; justification: string }>;
  requestedDurationDays?: number;
  targetIdentityId?: string;
}

export interface SodViolationItem {
  policyName: string;
  severity: string;
  conflictingEntitlements: string[];
}

/** A match as a request stores it; `action` is absent on requests stored before it was kept. */
export interface StoredSodViolation extends SodViolationItem {
  action?: 'BLOCK' | 'WARN';
}

export interface PreCheckSodResponse {
  blockers: SodViolationItem[];
  warnings: SodViolationItem[];
}

export async function preCheckSod(body: {
  entitlements: Array<{ catalogEntryId: string }>;
  targetIdentityId?: string;
}): Promise<PreCheckSodResponse> {
  const res = await axiosInstance.post(`${API_BASE}/access-requests/pre-check-sod`, body);
  return res.data ?? { blockers: [], warnings: [] };
}

export async function listRequestableCatalog(params?: {
  category?: string;
  search?: string;
  system?: string;
  page?: number;
  limit?: number;
}): Promise<{ data: RequestableCatalogEntry[]; total: number }> {
  const searchParams = new URLSearchParams();
  if (params?.category) searchParams.set('category', params.category);
  if (params?.search) searchParams.set('search', params.search);
  if (params?.system) searchParams.set('system', params.system);
  if (params?.page) searchParams.set('page', String(params.page));
  if (params?.limit) searchParams.set('limit', String(params.limit));
  const res = await axiosInstance.get(
    `${API_BASE}/entitlement-catalog/requestable?${searchParams}`,
  );
  return res.data ?? { data: [], total: 0 };
}

export async function createAccessRequest(
  body: CreateAccessRequestRequest,
): Promise<AccessRequest> {
  const res = await axiosInstance.post(`${API_BASE}/access-requests`, body);
  return res.data;
}

export async function listMyRequests(params?: {
  status?: string;
  page?: number;
  limit?: number;
}): Promise<{ data: AccessRequest[]; total: number }> {
  const searchParams = new URLSearchParams();
  if (params?.status) searchParams.set('status', params.status);
  if (params?.page) searchParams.set('page', String(params.page));
  if (params?.limit) searchParams.set('limit', String(params.limit));
  const res = await axiosInstance.get(`${API_BASE}/access-requests?${searchParams}`);
  return res.data ?? { data: [], total: 0 };
}

/**
 * The tenant's ACTIVE requests past their end date whose removal keeps failing (policy-admin):
 * GET /access-requests?removalFailing=true, oldest end date first.
 */
export async function listRemovalFailing(params: {
  page: number;
  limit: number;
}): Promise<{ data: AccessRequest[]; total: number }> {
  const searchParams = new URLSearchParams({
    removalFailing: 'true',
    page: String(params.page),
    limit: String(params.limit),
  });
  const res = await axiosInstance.get(`${API_BASE}/access-requests?${searchParams}`);
  return res.data ?? { data: [], total: 0 };
}

export async function getRequestDetail(requestId: string): Promise<AccessRequest> {
  const res = await axiosInstance.get(`${API_BASE}/access-requests/${requestId}`);
  return res.data;
}

export async function listPendingApprovals(): Promise<AccessRequest[]> {
  const res = await axiosInstance.get(`${API_BASE}/access-requests/pending-approvals`);
  return res.data ?? [];
}

export async function getPendingApprovalsCount(): Promise<{ count: number }> {
  const res = await axiosInstance.get(`${API_BASE}/access-requests/pending-approvals/count`);
  return res.data ?? { count: 0 };
}

export async function approveRequest(
  requestId: string,
  body: { stepIndex: number; decision: 'approve'; justification?: string },
): Promise<void> {
  await axiosInstance.put(`${API_BASE}/access-requests/${requestId}/approve`, body);
}

export async function rejectRequest(
  requestId: string,
  body: { stepIndex: number; decision: 'reject'; justification?: string },
): Promise<void> {
  await axiosInstance.put(`${API_BASE}/access-requests/${requestId}/reject`, body);
}

export async function cancelRequest(requestId: string): Promise<void> {
  await axiosInstance.put(`${API_BASE}/access-requests/${requestId}/cancel`);
}

export async function delegateRequest(
  requestId: string,
  body: { stepIndex: number; delegateTo: string },
): Promise<void> {
  await axiosInstance.put(`${API_BASE}/access-requests/${requestId}/delegate`, body);
}

/**
 * Close an ACTIVE request past its end date whose removal keeps failing: an admin removed the
 * access by hand (policy-admin; note required, audited). Answers the request, now EXPIRED.
 */
export async function markRemovedManually(
  requestId: string,
  body: { note: string },
): Promise<AccessRequest> {
  const res = await axiosInstance.post(
    `${API_BASE}/access-requests/${requestId}/removed-manually`,
    body,
  );
  return res.data;
}

export function useRequestableCatalog(params?: {
  category?: string;
  search?: string;
  system?: string;
  page?: number;
  limit?: number;
}) {
  return useQuery({
    queryKey: accessRequestKeys.requestableCatalog(params),
    queryFn: () => listRequestableCatalog(params),
  });
}

export function useMyRequests(filters?: { status?: string; page?: number; limit?: number }) {
  return useQuery({
    queryKey: accessRequestKeys.list(filters),
    queryFn: () => listMyRequests(filters),
  });
}

export function useRemovalFailingRequests(page: number, limit: number) {
  return useQuery({
    queryKey: accessRequestKeys.removalFailing(page),
    queryFn: () => listRemovalFailing({ page, limit }),
  });
}

export function useRequestDetail(requestId: string | undefined) {
  return useQuery({
    queryKey: accessRequestKeys.detail(requestId ?? ''),
    queryFn: () => getRequestDetail(requestId!),
    enabled: !!requestId,
  });
}

/**
 * SoD pre-check for the entitlements about to be requested. Keyed on the
 * comma-joined catalog entry ids; never cached across opens (staleTime 0)
 * because the result depends on the requester's current access.
 */
export function useSodPreCheck(entryIds: string[]) {
  const key = entryIds.join(',');
  return useQuery({
    queryKey: accessRequestKeys.sodPreCheck(key),
    queryFn: () =>
      preCheckSod({ entitlements: entryIds.map((catalogEntryId) => ({ catalogEntryId })) }),
    enabled: entryIds.length > 0,
    staleTime: 0,
    retry: false,
  });
}

export function usePendingApprovals() {
  return useQuery({
    queryKey: accessRequestKeys.pendingApprovals(),
    queryFn: listPendingApprovals,
  });
}

export function usePendingApprovalsCount() {
  return useQuery({
    queryKey: accessRequestKeys.pendingCount(),
    queryFn: () => getPendingApprovalsCount().then((r) => r.count),
  });
}

export function useCreateAccessRequest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createAccessRequest,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: accessRequestKeys.all });
    },
  });
}

export function useApproveRequest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      requestId,
      body,
    }: {
      requestId: string;
      body: { stepIndex: number; justification?: string };
    }) => approveRequest(requestId, { ...body, decision: 'approve' }),
    // Also on an error: a 409 means EuroID closed the request, so it leaves the queue
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: accessRequestKeys.all });
    },
  });
}

export function useRejectRequest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      requestId,
      body,
    }: {
      requestId: string;
      body: { stepIndex: number; justification?: string };
    }) => rejectRequest(requestId, { ...body, decision: 'reject' }),
    // Also on an error: a 409 means EuroID closed the request, so it leaves the queue
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: accessRequestKeys.all });
    },
  });
}

export function useCancelRequest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: cancelRequest,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: accessRequestKeys.all });
    },
  });
}

export function useDelegateRequest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      requestId,
      body,
    }: {
      requestId: string;
      body: { stepIndex: number; delegateTo: string };
    }) => delegateRequest(requestId, body),
    // Also on an error: a 409 means EuroID closed the request, so it leaves the queue
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: accessRequestKeys.all });
    },
  });
}

export function useMarkRemovedManually() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ requestId, note }: { requestId: string; note: string }) =>
      markRemovedManually(requestId, { note }),
    // Also on an error: a 409 means the request changed meanwhile
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: accessRequestKeys.all });
    },
  });
}
