/**
 * The approval steps of a new access request (AccessRequestCreationService.createRequest).
 *
 * Chain: each requested entry's catalog `approvalChain`, else MANAGER then OWNER; the chains are
 * merged in order, each link once, so one entry's chain never replaces another's. An OWNER link
 * is one step per distinct owner of the entries.
 *
 * Approvers: MANAGER is the target's `managerEmail`, OWNER an entry's `owner`, ROLE any admin
 * user with the role, SPECIFIC_USER the named user. A step with no approver refuses the request
 * (400): it could never be decided and would time out REJECTED.
 *
 * Segregation of duties: the requester never decides a step after creation
 * (AccessRequestDecisionService). A step whose approver is the requester (a manager requesting
 * for their report is the MANAGER step's approver) is recorded APPROVED by the request itself:
 * asking for the access is that approver's consent. A step whose approver is the person the
 * access is for refuses the request. At least one step must remain for someone who is neither.
 */
import { BadRequestException } from '@nestjs/common';
import type { ApprovalStep, ApproverType } from './schemas/access-request.schema';

/** One link of a catalog entry's approval chain. */
export interface ApprovalChainLink {
  type: string;
  value?: string;
}

/** What the chain needs of a requested catalog entry. */
export interface ApprovalChainEntry {
  name: string;
  owner?: string;
  approvalChain?: ApprovalChainLink[];
}

/** Who asks and for whom. */
export interface ApprovalParties {
  requesterId: string;
  requesterEmail: string;
  targetIdentityId: string;
  targetEmail?: string;
  /** The target's manager (the MANAGER step's approver). */
  managerEmail?: string;
}

/** The justification of a step the request itself approved. */
export const APPROVED_BY_REQUEST =
  'Approved by the request: the requester is the approver of this step.';

const DEFAULT_CHAIN: ApprovalChainLink[] = [{ type: 'MANAGER' }, { type: 'OWNER' }];

const sameEmail = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const sameLink = (a: ApprovalChainLink, b: ApprovalChainLink) =>
  a.type === b.type && a.value === b.value;
const chainOf = (entry: ApprovalChainEntry) =>
  entry.approvalChain?.length ? entry.approvalChain : DEFAULT_CHAIN;

/** Each entry's chain (its own, else MANAGER then OWNER), merged in order, each link once. */
export function mergeApprovalChains(entries: ApprovalChainEntry[]): ApprovalChainLink[] {
  const merged: ApprovalChainLink[] = [];
  for (const entry of entries) {
    for (const link of chainOf(entry)) {
      if (!merged.some((m) => sameLink(m, link))) merged.push(link);
    }
  }
  return merged;
}

/** The approvers a link stands for: email and identity id (the id lookup by email). */
async function linkApprovers(
  link: ApprovalChainLink,
  entries: ApprovalChainEntry[],
  parties: ApprovalParties,
  identityIdOf: (email: string) => Promise<string | undefined>,
): Promise<Array<{ approverEmail: string; approverId: string | undefined }>> {
  if (link.type === 'MANAGER') {
    if (!parties.managerEmail) {
      throw new BadRequestException(
        'No approver for the MANAGER step: the person the access is for has no manager ' +
          '(managerEmail) in the directory.',
      );
    }
    const email = parties.managerEmail;
    return [{ approverEmail: email, approverId: await identityIdOf(email) }];
  }
  if (link.type === 'OWNER') {
    // The owners of the entries whose chain asks for their owner
    entries = entries.filter((e) => chainOf(e).some((l) => sameLink(l, link)));
    const unowned = entries.find((e) => !e.owner?.trim());
    if (unowned) {
      throw new BadRequestException(
        `No approver for the OWNER step: entitlement ${unowned.name} has no owner in the catalog.`,
      );
    }
    const owners: string[] = [];
    for (const e of entries) {
      if (!owners.some((o) => sameEmail(o, e.owner))) owners.push(e.owner!.trim());
    }
    return Promise.all(
      owners.map(async (owner) => ({
        approverEmail: owner,
        approverId: (await identityIdOf(owner)) ?? owner,
      })),
    );
  }
  if ((link.type === 'ROLE' || link.type === 'SPECIFIC_USER') && link.value) {
    return [{ approverEmail: link.value, approverId: link.value }];
  }
  throw new BadRequestException(`No approver for the ${link.type} step of the approval chain.`);
}

/**
 * The steps for `chain`, in order. Throws 400 for a step without an approver, for a step the
 * person the access is for would decide, and when no step is left for anyone but the requester.
 */
export async function resolveApprovalSteps(
  chain: ApprovalChainLink[],
  entries: ApprovalChainEntry[],
  parties: ApprovalParties,
  identityIdOf: (email: string) => Promise<string | undefined>,
  now: Date,
): Promise<ApprovalStep[]> {
  const steps: ApprovalStep[] = [];
  const onBehalf = parties.targetIdentityId !== parties.requesterId;
  for (const link of chain) {
    for (const { approverEmail, approverId } of await linkApprovers(
      link,
      entries,
      parties,
      identityIdOf,
    )) {
      const step: ApprovalStep = {
        stepOrder: steps.length,
        approverType: link.type as ApproverType,
        approverId,
        approverEmail,
        status: 'PENDING',
      };
      if (link.type !== 'ROLE') {
        const isRequester =
          approverId === parties.requesterId || sameEmail(approverEmail, parties.requesterEmail);
        const isTarget =
          onBehalf &&
          (approverId === parties.targetIdentityId ||
            sameEmail(approverEmail, parties.targetEmail));
        if (isRequester) {
          Object.assign(step, {
            status: 'APPROVED',
            decidedAt: now,
            decidedBy: parties.requesterEmail,
            justification: APPROVED_BY_REQUEST,
          });
        } else if (isTarget) {
          throw new BadRequestException(
            `The ${link.type} step's approver is the person the access is for, who cannot ` +
              'approve their own access.',
          );
        }
      }
      steps.push(step);
    }
  }
  if (!steps.some((s) => s.status === 'PENDING')) {
    throw new BadRequestException(
      'This request needs an approver other than you: every approval step names you.',
    );
  }
  return steps;
}
