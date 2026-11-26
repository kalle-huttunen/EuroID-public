/**
 * Shared fixtures of the AuditIntegrityPage tests, split by subject into AuditIntegrityPage*.test.tsx.
 * Each test file mocks `@api/data` with the request mocks below and `usePermission` itself
 * (vi.mock is hoisted per file). The shapes follow the audit services' answers.
 */
import { vi } from 'vitest';
import type {
  IAnchorProof,
  IChainCheckResult,
  IEventProofResult,
  IMerkleCheckpoint,
  IRootsCheckResult,
} from '../../../interfaces';

export const mockGet = vi.fn();
export const mockPost = vi.fn();

/** An audit event `_id` (the API's ObjectId). */
export const EVENT_ID = '6742a1b2c3d4e5f6a7b8c9d0';
export const BROKEN_AT = '2026-11-24T08:15:30.125Z';

const hash = (c: string) => c.repeat(64);

/** Signed at creation and delivered to a witness. */
export const signed: IMerkleCheckpoint = {
  _id: '6742a1b2c3d4e5f6a7b8c901',
  checkpointId: '0f6c2d1e-8a4b-4c3d-9e2f-1a2b3c4d5e6f',
  tenantId: 'tenant-a',
  rootHash: hash('a'),
  eventCount: 128,
  treeDepth: 8,
  firstEventTimestamp: '2026-11-23T00:00:01.000Z',
  lastEventTimestamp: '2026-11-23T23:59:58.000Z',
  firstSeq: 1025,
  lastSeq: 1152,
  previousRootHash: hash('9'),
  archived: false,
  anchorSignature: 'ab'.repeat(64),
  anchorKeyFingerprint: hash('f'),
  anchoredAt: '2026-11-24T00:00:05.000Z',
  externalAnchor: {
    endpoint: 'https://witness.example/anchors',
    deliveredAt: '2026-11-24T00:00:06.000Z',
    responseStatus: 202,
    witness: 'w-17',
  },
  createdAt: '2026-11-24T00:00:04.000Z',
  updatedAt: '2026-11-24T00:00:06.000Z',
};

/** Made while no anchor key was configured, before audit events had chain positions. */
export const unsigned: IMerkleCheckpoint = {
  _id: '6742a1b2c3d4e5f6a7b8c902',
  checkpointId: '7d1e2f3a-4b5c-4d6e-8f70-81a2b3c4d5e6',
  tenantId: 'tenant-a',
  rootHash: hash('b'),
  eventCount: 3,
  treeDepth: 3,
  firstEventTimestamp: '2026-11-22T10:00:00.000Z',
  lastEventTimestamp: '2026-11-22T10:05:00.000Z',
  archived: false,
  createdAt: '2026-11-22T12:00:00.000Z',
  updatedAt: '2026-11-22T12:00:00.000Z',
};

export const anchorOf = (cp: IMerkleCheckpoint, verified = true): IAnchorProof => ({
  envelope: {
    payload: {
      checkpointId: cp.checkpointId,
      tenantId: cp.tenantId,
      rootHash: cp.rootHash,
      previousRootHash: cp.previousRootHash ?? null,
      eventCount: cp.eventCount,
      firstEventTimestamp: cp.firstEventTimestamp,
      lastEventTimestamp: cp.lastEventTimestamp,
    },
    signature: cp.anchorSignature as string,
    keyFingerprint: cp.anchorKeyFingerprint as string,
    algorithm: 'ed25519',
    signedAt: cp.anchoredAt as string,
  },
  verified,
});

export const proofOk: IEventProofResult = {
  valid: true,
  proof: [
    { hash: hash('c'), position: 'right' },
    { hash: hash('d'), position: 'left' },
  ],
  rootHash: signed.rootHash,
  checkpointId: signed.checkpointId,
  legacy: false,
};

/** An intact chain of `n` events, nothing older and no erasure on the way. */
export const chainOk = (n: number): IChainCheckResult => ({
  valid: true,
  eventsChecked: n,
  legacyEventsChecked: 0,
  erasureGaps: [],
});

export const brokenLink: IChainCheckResult = {
  valid: false,
  eventsChecked: 57,
  firstInvalid: EVENT_ID,
  firstInvalidAt: BROKEN_AT,
  firstInvalidSeq: 412,
  reason: 'broken_link',
  legacyEventsChecked: 0,
  erasureGaps: [],
};

/** A GDPR_ERASURE_EXECUTED entry's `_id`. */
export const ERASURE_ID = '6742a1b2c3d4e5f6a7b8c9ee';

export const rootsOk: IRootsCheckResult = {
  valid: true,
  checkpointsVerified: 2,
  eventsVerified: 131,
  eventsMissing: 0,
  legacyCheckpointsChecked: 0,
};

/** The daily run's checkpoint over the events written before hash version 2. */
export const legacyPart: IMerkleCheckpoint = {
  _id: '6742a1b2c3d4e5f6a7b8c903',
  checkpointId: '3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f',
  tenantId: 'tenant-a',
  rootHash: hash('e'),
  eventCount: 9500,
  treeDepth: 15,
  firstEventTimestamp: '2025-11-25T08:00:00.000Z',
  lastEventTimestamp: '2026-11-24T14:59:59.000Z',
  legacy: true,
  legacyPart: 1,
  previousRootHash: hash('a'),
  archived: false,
  createdAt: '2026-11-25T03:00:02.000Z',
  updatedAt: '2026-11-25T03:00:02.000Z',
};

/** What the API says a legacy checkpoint proves (LEGACY_CHECKPOINT_NOTE). */
export const LEGACY_CHECKPOINT_NOTE =
  'A legacy checkpoint covers audit events written before hash version 2 (no chain position) by ' +
  'the hashes they had when it was made, in time order. It proves that those stored hashes, and ' +
  'the event fields they cover, have not changed since it was made. It cannot show a change made ' +
  'before then, and their hash does not cover the payload: a changed payload goes unnoticed.';

export const CHAIN = /\/audit\/verify-integrity$/;
export const ROOTS_LIST = /\/audit\/merkle-roots$/;

interface Answers {
  chain?: IChainCheckResult;
  /** Answers the chain check with this request instead (a pending or failing one). */
  chainRequest?: () => Promise<unknown>;
  checkpoints?: IMerkleCheckpoint[];
  checkpointsError?: unknown;
  anchor?: IAnchorProof;
  anchorError?: unknown;
  proof?: IEventProofResult;
  proofError?: unknown;
  roots?: IRootsCheckResult;
  /** Answers POST /audit/merkle-roots. */
  created?: IMerkleCheckpoint;
  createError?: unknown;
}

/** Serves each route; an error is rejected when the route is called, as axios would. */
export function serve(answers: Answers = {}) {
  mockGet.mockImplementation((url: string) => {
    if (CHAIN.test(url)) {
      if (answers.chainRequest) return answers.chainRequest();
      return Promise.resolve({ data: answers.chain ?? chainOk(0) });
    }
    if (ROOTS_LIST.test(url)) {
      if (answers.checkpointsError) return Promise.reject(answers.checkpointsError);
      const data = answers.checkpoints ?? [];
      return Promise.resolve({ data: { data, total: data.length } });
    }
    if (url.endsWith('/anchor')) {
      if (answers.anchorError) return Promise.reject(answers.anchorError);
      if (answers.anchor) return Promise.resolve({ data: answers.anchor });
    }
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
  mockPost.mockImplementation((url: string) => {
    if (url.includes('/audit/verify-event/')) {
      if (answers.proofError) return Promise.reject(answers.proofError);
      if (answers.proof) return Promise.resolve({ data: answers.proof });
    }
    if (url.endsWith('/audit/verify') && answers.roots)
      return Promise.resolve({ data: answers.roots });
    if (ROOTS_LIST.test(url)) {
      if (answers.createError) return Promise.reject(answers.createError);
      if (answers.created) return Promise.resolve({ data: answers.created });
    }
    return Promise.reject(new Error(`unexpected POST ${url}`));
  });
}

/** The params of the last chain check request. */
export function lastChainParams(): Record<string, string> {
  const calls = mockGet.mock.calls.filter(([url]) => CHAIN.test(url as string));
  return (calls.at(-1)?.[1] as { params: Record<string, string> }).params;
}

/** An API error as axios rejects it. */
export const apiError = (status: number, message: string) => ({
  response: { status, data: { message } },
});
