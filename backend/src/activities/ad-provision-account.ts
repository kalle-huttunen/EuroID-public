/**
 * The account provisionUserToAd creates or finds in Active Directory, and how its failures reach
 * Temporal.
 *
 * Only the UPN identifies the person's own account (unique in the forest; the display name is
 * not). findOwnAdAccount finds it, so a run for a person whose account exists (a Temporal retry,
 * onboarding again before the DN was written back) reuses its sAMAccountName and DN and creates
 * nothing (ownAccountResult). For a new account, resolveUniqueSam and resolveUniqueCn add a
 * numeric suffix to a sAMAccountName or CN another account holds, so a namesake in the same OU
 * gets an account of their own. LDAP 68 ("already exists") answers success for whatever holds the
 * DN, so after the create assertOwnAccountAt refuses an account with another UPN: another
 * person's account is never used.
 *
 * adProvisionFailure: a failure other than a group change keeps its class, so its retry behaviour
 * is unchanged. Its message names the step and the LDAP result code, with the CN/UID of DNs and
 * email addresses masked, because it reaches workflow history (the stack trace too) and the
 * provisioning entry's errorMsg.
 */
import { ApplicationFailure } from '@temporalio/common';
import type { ProvisioningResult } from '@shared/dtos/provisioning-result.dto';
import { RateLimitedException } from '@shared/errors/rate-limited.exception';
import type { AdClient } from '../modules/connectors/ad-connector/ad.client';
import type { AdConfig, AdUserEntry } from '../modules/connectors/ad-connector/ad.interface';
import { escapeLdapFilter } from '../modules/connectors/ad-connector/ad-utils';
import { maskPersonalData } from './deprovision-failure';

/** AD limit for sAMAccountName. */
const SAM_MAX_LENGTH = 20;

/** ApplicationFailure type: the new account's DN is held by another person's account. */
export const AD_ACCOUNT_NAME_TAKEN = 'AdAccountNameTaken';

/** The step of provisionUserToAd that failed, as its failure message names it. */
export type AdProvisionStep =
  | 'find the account'
  | 'create the account'
  | "read the account's groups";

type UserSearch = Pick<AdClient, 'searchUsers'>;

/** The person's existing account under `baseDn`: the user with the UPN this run sets, or null. */
export async function findOwnAdAccount(
  adClient: UserSearch,
  config: AdConfig,
  baseDn: string,
  userPrincipalName: string,
): Promise<AdUserEntry | null> {
  const upn = userPrincipalName.trim();
  if (!upn) return null;
  const filter = `(&(objectClass=user)(userPrincipalName=${escapeLdapFilter(upn)}))`;
  const users = await adClient.searchUsers(config, baseDn, filter);
  return users.find((u) => sameUpn(u.userPrincipalName, upn)) ?? null;
}

function sameUpn(a: string | undefined, b: string): boolean {
  return !!a && a.toLowerCase() === b.toLowerCase();
}

/** What provisioning returns for the person's existing account: its own names, nothing created. */
export function ownAccountResult(account: AdUserEntry, plannedUpn: string): ProvisioningResult {
  return {
    targetUserId: account.dn,
    generatedAttributes: {
      mail: account.mail || plannedUpn,
      userPrincipalName: account.userPrincipalName || plannedUpn,
      samAccountName: account.sAMAccountName,
      distinguishedName: account.dn,
    },
  };
}

/** `base` (at most 20 characters), or with the lowest numeric suffix no account holds. */
export async function resolveUniqueSam(
  adClient: UserSearch,
  config: AdConfig,
  baseDn: string,
  base: string,
): Promise<string> {
  let candidate = base.slice(0, SAM_MAX_LENGTH);
  let suffix = 0;
  while (await samTaken(adClient, config, baseDn, candidate)) {
    suffix++;
    const tail = String(suffix);
    candidate = (base.slice(0, SAM_MAX_LENGTH - tail.length) + tail).slice(0, SAM_MAX_LENGTH);
  }
  return candidate;
}

/**
 * The CN for a new account: `base`, or `base` with the lowest numeric suffix (" 1", " 2", ...)
 * whose DN (`dnFor`) nothing holds.
 */
export async function resolveUniqueCn(
  adClient: UserSearch,
  config: AdConfig,
  baseDn: string,
  base: string,
  dnFor: (commonName: string) => string,
): Promise<string> {
  let candidate = base;
  let suffix = 0;
  while (await dnTaken(adClient, config, baseDn, dnFor(candidate))) {
    suffix++;
    candidate = `${base} ${suffix}`;
  }
  return candidate;
}

async function dnTaken(
  adClient: UserSearch,
  config: AdConfig,
  baseDn: string,
  dn: string,
): Promise<boolean> {
  return (await adClient.searchUsers(config, baseDn, dnFilter(dn))).length > 0;
}

function dnFilter(dn: string): string {
  return `(distinguishedName=${escapeLdapFilter(dn)})`;
}

/**
 * Refuses (not retried) the account at `dn` when its UPN is not the person's: a create LDAP 68
 * answered for another person's account (one created between the name check and the create).
 * An account not found yet is the one just created, on a domain controller still replicating.
 */
export async function assertOwnAccountAt(
  adClient: UserSearch,
  config: AdConfig,
  baseDn: string,
  dn: string,
  userPrincipalName: string,
): Promise<void> {
  const [account] = await adClient.searchUsers(config, baseDn, dnFilter(dn));
  if (!account || sameUpn(account.userPrincipalName, userPrincipalName)) return;
  throw ApplicationFailure.nonRetryable(
    `ad: ${maskPersonalData(dn)} is another person's account (its UPN differs), so it was not ` +
      'used. Run provisioning again to create the account under a free name.',
    AD_ACCOUNT_NAME_TAKEN,
  );
}

async function samTaken(
  adClient: UserSearch,
  config: AdConfig,
  baseDn: string,
  sAMAccountName: string,
): Promise<boolean> {
  const filter = `(sAMAccountName=${escapeLdapFilter(sAMAccountName)})`;
  const users = await adClient.searchUsers(config, baseDn, filter);
  return users.length > 0;
}

/**
 * The error to throw for a failed `step`: Temporal failures and rate limits pass through; any
 * other error keeps its class and gets the masked message `ad: <step> failed (LDAP result <code>):
 * <reason>`, the code when the error has a numeric one (ldapts result codes).
 */
export function adProvisionFailure(step: AdProvisionStep, err: unknown): unknown {
  if (err instanceof RateLimitedException || err instanceof ApplicationFailure) return err;
  const original = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: unknown } | null | undefined)?.code;
  const result = typeof code === 'number' ? ` (LDAP result ${code})` : '';
  const message = `ad: ${step} failed${result}: ${maskPersonalData(original)}`;
  if (!(err instanceof Error)) return new Error(message);
  // Read before the message changes: V8 builds the stack's first line from the message lazily
  const stack = err.stack;
  err.message = message;
  if (typeof stack === 'string' && original) err.stack = stack.replace(original, () => message);
  return err;
}
