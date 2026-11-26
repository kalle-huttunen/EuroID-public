import { registerAs } from '@nestjs/config';

export interface AccessReviewConfig {
  defaultReviewer: string;
  /** Review items per revocation batch at campaign close (one list + record round per batch). */
  revocationBatchSize: number;
  /**
   * How long an activation's claim on a campaign holds (ms): a second activation is refused
   * meanwhile, and one older than this (its process stopped) may be taken over.
   */
  activationClaimMs: number;
}

const DEFAULT_REVOCATION_BATCH_SIZE = 50;
const DEFAULT_ACTIVATION_CLAIM_MS = 60 * 60 * 1000;

function positiveInt(value: string | undefined, fallback: number): number {
  const n = parseInt(value ?? '', 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export const accessReviewConfig = registerAs(
  'accessReview',
  (): AccessReviewConfig => ({
    defaultReviewer: process.env.ACCESS_REVIEW_DEFAULT_REVIEWER || 'unassigned@review.pending',
    revocationBatchSize: positiveInt(
      process.env.ACCESS_REVIEW_REVOCATION_BATCH_SIZE,
      DEFAULT_REVOCATION_BATCH_SIZE,
    ),
    activationClaimMs: positiveInt(
      process.env.ACCESS_REVIEW_ACTIVATION_CLAIM_MS,
      DEFAULT_ACTIVATION_CLAIM_MS,
    ),
  }),
);
