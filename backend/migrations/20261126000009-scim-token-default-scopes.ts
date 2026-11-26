/**
 * Migration: give stored inbound SCIM tokens that hold none of the scopes the guard reads the
 * default four.
 *
 * ScimAuthGuard now requires the route's scope (`Users:read`, `Users:write`, `Groups:read`,
 * `Groups:write`, SCIM_SCOPES in scim-auth.guard.ts). Before this release it never read the
 * scopes, so every valid token could reach every SCIM route whatever it stored. A token stored
 * with no scopes, or only scopes outside those four (`scim`, `users:read`, ...), would answer 403
 * on every route after the deploy and break the IdP's provisioning. This sets the four default
 * scopes (the schema default) on every such token, in every tenant, which keeps what it could do
 * before, and logs how many. A token holding at least one of the four keeps its scopes as they
 * are. Rerunning it changes nothing (a token it changed holds the four).
 */
import { Db } from 'mongodb';

const SCIM_TOKENS = 'scim_tokens';
/** Must match SCIM_SCOPES (src/modules/scim-inbound/guards/scim-auth.guard.ts). */
export const DEFAULT_SCIM_SCOPES = ['Users:read', 'Users:write', 'Groups:read', 'Groups:write'];

export async function up(db: Db): Promise<void> {
  const result = await db
    .collection(SCIM_TOKENS)
    .updateMany(
      { scopes: { $not: { $elemMatch: { $in: DEFAULT_SCIM_SCOPES } } } },
      { $set: { scopes: DEFAULT_SCIM_SCOPES } },
    );
  console.log(
    `[migration] scim_tokens: ${result.modifiedCount} token(s) with none of the SCIM scopes ` +
      `got the default ${DEFAULT_SCIM_SCOPES.join(', ')} (the guard read no scopes before)`,
  );
}

/**
 * Leaves the scopes: the scopes a token held before cannot be told from ones an admin set since,
 * and taking them away would refuse the token on every route.
 */
export async function down(): Promise<void> {}
