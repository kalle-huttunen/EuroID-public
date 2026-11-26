/**
 * What the DSAR export (GDPR Art. 15) gives of each document a GDPR erasure reaches
 * (gdpr-erasure-scope.ts, each target's `dsar`): the subject's own record with its fields, minus
 * bookkeeping (tenant, version), secrets and other people's personal data (Art. 15(4)): the admin
 * who decided or dismissed something, an approver, another requester, other members of a group.
 * No collection in the scope stores credential material (credential_inventory keeps metadata:
 * password dates and status, MFA methods, passkey devices, certificate thumbprints and dates);
 * an NHI agent's credential fingerprint is left out all the same.
 */
type Doc = Record<string, unknown>;

/** A document as the export gives it; `identityId` is the subject's. */
export type DsarView = (doc: Doc, identityId: string) => Doc;

const BOOKKEEPING = ['tenantId', '__v'];

/** `value` without the field at `path` (dotted; through arrays, element by element). */
function omitPath(value: unknown, path: string[]): unknown {
  if (Array.isArray(value)) return value.map((item) => omitPath(item, path));
  if (value === null || typeof value !== 'object' || value instanceof Date) return value;
  const [head, ...rest] = path;
  const out: Doc = { ...(value as Doc) };
  if (rest.length === 0) delete out[head];
  else if (head in out) out[head] = omitPath(out[head], rest);
  return out;
}

/** Every field but bookkeeping and `others` (dotted paths naming another person's data). */
export const ownFields =
  (...others: string[]): DsarView =>
  (doc) =>
    [...BOOKKEEPING, ...others].reduce<Doc>(
      (out, path) => omitPath(out, path.split('.')) as Doc,
      doc,
    );

/** Only `keys`: for a record that belongs to something else and names the subject. */
export const pickedFields =
  (...keys: string[]): DsarView =>
  (doc) =>
    Object.fromEntries(keys.filter((key) => doc[key] !== undefined).map((key) => [key, doc[key]]));

/**
 * An access request for the subject: the requester stays only when it is the subject (a
 * manager who requested for them is another person); approval steps keep their order, type,
 * status, time and justification, not who decided (a ROLE step names its role, which is kept); an
 * admin's manual close keeps when and why, not who.
 */
export const accessRequestView: DsarView = (doc, identityId) => {
  const view = ownFields('removedManually.by')(doc, identityId);
  if (view.requesterId !== identityId) {
    delete view.requesterId;
    delete view.requesterEmail;
  }
  const steps = (view.approvalSteps as Doc[] | undefined) ?? [];
  view.approvalSteps = steps.map((step) => {
    const { approverEmail: _e, decidedBy: _d, delegatedFrom: _f, approverId, ...kept } = step;
    return step.approverType === 'ROLE' ? { ...kept, approverId } : kept;
  });
  return view;
};

/** A peer group the subject is in: the group and the subject's own outlier entry, no members. */
export const peerGroupView: DsarView = (doc, identityId) => ({
  ...pickedFields(
    'groupKey',
    'attributes',
    'memberCount',
    'computedAt',
    'updatedAt',
  )(doc, identityId),
  outliers: ((doc.outliers as Doc[] | undefined) ?? []).filter((o) => o.identityId === identityId),
});

/**
 * The subject's NHI agent: the agent is the organisation's, so what it is and its state, owned by
 * the subject; not its credential fingerprint or metadata. Who created or revoked it only when
 * that was the subject (the owner's email, in any case), else it is another person's data.
 */
export const agentView: DsarView = (doc, identityId) => {
  const view = pickedFields(
    'agentId',
    'displayName',
    'kind',
    'owner',
    'scope',
    'parentAgentId',
    'expiresAt',
    'status',
    'revokedAt',
    'revocationReason',
    'killSwitchEngaged',
    'riskTier',
    'ownerlessSince',
    'ownerlessReason',
    'lastRotatedAt',
    'createdAt',
  )(doc, identityId);
  const ownerEmail = (doc.owner as Doc | undefined)?.email;
  const isOwner = (value: unknown) =>
    typeof value === 'string' &&
    typeof ownerEmail === 'string' &&
    value.toLowerCase() === ownerEmail.toLowerCase();
  for (const field of ['createdBy', 'revokedBy']) {
    if (isOwner(doc[field])) view[field] = doc[field];
  }
  return view;
};
