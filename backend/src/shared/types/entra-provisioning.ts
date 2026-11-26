/**
 * The failure provisionUserToEntra throws when Entra ID did not make some of the requested
 * group, directory role or license changes (activities/entra-changes-failure.ts). Pure: imported
 * by the Entra ID activities and by the onboarding and admin-account workflows.
 */

/** ApplicationFailure type of that failure. */
export const ENTRA_CHANGES_FAILED = 'EntraChangesFailed';

/**
 * `details[0]` of that failure when the call created the account: what the workflow writes back
 * to the identity, so its next run updates this account instead of creating a second one.
 */
export interface EntraCreatedAccount {
  objectId: string;
  generatedAttributes?: { mail?: string; userPrincipalName?: string };
}
