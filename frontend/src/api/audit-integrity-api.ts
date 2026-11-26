/**
 * Audit integrity API (backend `modules/audit`): the hash chain check over a time window, Merkle
 * checkpoints, one event's Merkle proof, the checkpoint check, a checkpoint's signed anchor and
 * creating a checkpoint. Every route needs super-admin. The checks only read; creating a
 * checkpoint writes one (and an audit event saying who made it).
 */
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { axiosInstance } from '@api/data';
import { API_BASE } from '@api/constants';
import { PAGE_SIZES } from '@config/pagination';
import type {
  IAnchorProof,
  IChainCheckResult,
  IEventProofResult,
  IMerkleCheckpoint,
  IMerkleCheckpointPage,
  IRootsCheckResult,
} from '../interfaces';

const AUDIT_API = `${API_BASE}/audit`;

/** Checkpoints per page. */
export const CHECKPOINTS_PAGE_SIZE = PAGE_SIZES.MEDIUM;

export const auditIntegrityKeys = {
  all: ['audit-integrity'] as const,
  checkpoints: (page: number) => [...auditIntegrityKeys.all, 'checkpoints', page] as const,
  anchor: (checkpointId: string) => [...auditIntegrityKeys.all, 'anchor', checkpointId] as const,
};

/** The window a chain check covers (ISO times); none means the whole log. */
export interface ChainWindow {
  from?: string;
  to?: string;
}

/** Merkle checkpoints, newest first; `page` is 1-based like the API's. */
export function useCheckpoints(page: number) {
  return useQuery({
    queryKey: auditIntegrityKeys.checkpoints(page),
    queryFn: async () => {
      const { data } = await axiosInstance.get<IMerkleCheckpointPage>(`${AUDIT_API}/merkle-roots`, {
        params: { page, limit: CHECKPOINTS_PAGE_SIZE },
      });
      return { data: data?.data ?? [], total: data?.total ?? 0 };
    },
    placeholderData: keepPreviousData,
  });
}

/**
 * A checkpoint's signed anchor and the server's own check of it. The API answers 400 for a
 * checkpoint that was never signed, which a retry cannot change.
 */
export function useAnchorProof(checkpointId: string | undefined) {
  return useQuery({
    queryKey: auditIntegrityKeys.anchor(checkpointId ?? ''),
    queryFn: async () => {
      const { data } = await axiosInstance.get<IAnchorProof>(
        `${AUDIT_API}/merkle-roots/${encodeURIComponent(checkpointId as string)}/anchor`,
      );
      return data;
    },
    enabled: !!checkpointId,
    retry: false,
  });
}

/**
 * Re-hashes every event of the window and checks the links between them and the chain positions
 * (gaps a GDPR erasure recorded are reported, not counted as tampering).
 */
export function useVerifyChain() {
  return useMutation({
    mutationFn: async (span: ChainWindow) => {
      const { data } = await axiosInstance.get<IChainCheckResult>(`${AUDIT_API}/verify-integrity`, {
        params: {
          ...(span.from ? { from: span.from } : {}),
          ...(span.to ? { to: span.to } : {}),
        },
      });
      return data;
    },
  });
}

/** The Merkle proof that an event's stored hash is in a checkpoint. Takes the event's `_id`. */
export function useVerifyEvent() {
  return useMutation({
    mutationFn: async (eventId: string) => {
      const { data } = await axiosInstance.post<IEventProofResult>(
        `${AUDIT_API}/verify-event/${encodeURIComponent(eventId)}`,
      );
      return data;
    },
  });
}

/**
 * Creates a checkpoint over the audit events written since the last one, then reloads the list
 * (by the prefix key: a page's key alone would miss the others).
 */
export function useCreateCheckpoint() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data } = await axiosInstance.post<IMerkleCheckpoint>(`${AUDIT_API}/merkle-roots`);
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: [...auditIntegrityKeys.all, 'checkpoints'] }),
  });
}

/**
 * Checks every checkpoint: its stored root against its stored event hashes, and the events it
 * covers against those hashes.
 */
export function useCheckRoots() {
  return useMutation({
    mutationFn: async () => {
      const { data } = await axiosInstance.post<IRootsCheckResult>(`${AUDIT_API}/verify`, {});
      return data;
    },
  });
}
