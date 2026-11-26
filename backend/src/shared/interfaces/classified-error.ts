/**
 * Classified error for activity/workflow retry decisions.
 * Activities can return this so workflows can make intelligent retry choices.
 */
export interface ClassifiedError {
  code: 'TRANSIENT' | 'PERMANENT' | 'RATE_LIMIT' | 'CONFLICT';
  message: string;
  retryable: boolean;
  originalError?: string;
}
