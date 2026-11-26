/**
 * Uncorrelated Queue interfaces.
 * Mirrors backend identity uncorrelated API contracts.
 */

export type CorrelationStatus = 'correlated' | 'uncorrelated' | 'ambiguous' | 'manual-review';

export interface IUncorrelatedIdentity {
  _id: string;
  firstName: string;
  lastName: string;
  email?: string;
  jobTitle?: string;
  departmentName?: string;
  employeeNumber?: string;
  metadata?: {
    correlationStatus?: CorrelationStatus;
    ambiguousCandidates?: string[];
  };
  sources?: Array<{ sourceName: string; externalId: string; rawData?: Record<string, unknown> }>;
  /**
   * Deleted by its offboarding, with no account left: still in the queue, and Link merges its
   * records into the identity chosen (it stays deleted).
   */
  offboarded?: boolean;
}

export interface IScoredCandidate {
  identityId: string;
  profile: {
    firstName: string;
    lastName: string;
    email?: string;
    jobTitle?: string;
    departmentName?: string;
  };
  matchedBy: string;
  confidence: number;
  sources: Array<{ sourceName: string; externalId: string }>;
}
