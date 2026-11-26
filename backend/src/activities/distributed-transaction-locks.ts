/**
 * The locks of a distributed transaction (DistributedTransactionActivities): one per tenant,
 * system and account, held by the transaction (owner token: tenant and transaction id).
 */
import { createHash } from 'crypto';
import type { DistributedTransactionRequestInput } from '@shared/dtos/distributed-transaction.dto';

export const LOCK_PREFIX = 'disttx:lock:';
export const LOCK_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * The lock key of a user's account on a system: scoped by tenant, so transactions of different
 * tenants never block each other, and keyed by a SHA-256 of the normalised email, not the email.
 */
export function lockKeyOf(tenantId: string, system: string, email: string): string {
  const subject = createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
  return `${tenantId}:${system}:${subject}`;
}

/** The owner token of a transaction's locks. */
export function lockOwner(request: DistributedTransactionRequestInput, tenantId?: string): string {
  return `${tenantId ?? ''}:${request.transactionId}`;
}
