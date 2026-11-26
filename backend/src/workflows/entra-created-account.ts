/**
 * The Entra ID account a failed provisionUserToEntra created: the details of its
 * EntraChangesFailed failure (activities/entra-changes-failure.ts), sent when the account was
 * created but a group, directory role or license change was not made. Onboarding and admin-account
 * provisioning write it back to the identity before marking the target ERROR, so their next run
 * finds and updates this account instead of creating a second one. Pure: bundled with workflows.
 */
import { ActivityFailure, ApplicationFailure } from '@temporalio/workflow';
import { ENTRA_CHANGES_FAILED, type EntraCreatedAccount } from '../shared/types/entra-provisioning';

/** The created account carried by an activity failure, or undefined for any other failure. */
export function createdEntraAccount(err: unknown): EntraCreatedAccount | undefined {
  const cause = err instanceof ActivityFailure ? err.cause : undefined;
  if (!(cause instanceof ApplicationFailure) || cause.type !== ENTRA_CHANGES_FAILED) {
    return undefined;
  }
  const account = cause.details?.[0] as Partial<EntraCreatedAccount> | undefined;
  return typeof account?.objectId === 'string' && account.objectId
    ? { objectId: account.objectId, generatedAttributes: account.generatedAttributes }
    : undefined;
}
