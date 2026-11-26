/**
 * An inbound record that cannot get an identity of its own: its email is already a live
 * identity's, and the email is unique among the tenant's live identities. Nothing is minted. The
 * record waits in an identity's `metadata.conflictDetails.incomingSource` until a reviewer merges
 * it there (POST /identity/:id/resolve-conflict); each sync until then stores it again. It is held
 * on the identity a low-confidence correlation match flagged, or, when no correlation rule
 * matched, on the live identity that has its email (`matchedBy: 'email'`, confidence 0).
 */
import { HttpStatus } from '@nestjs/common';
import type { ClientSession } from 'mongoose';
import { IdentityException } from '@shared/exceptions/domain-exceptions';
import type { StandardUserDto } from '@shared/dtos/standard-user.dto';
import type { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import type { IdentityDocument, LinkedAccount } from './schemas/identity.schema';

/** The record is held on the conflict of `identityId` and changed nothing else. */
export class RowHeldForConflictReview extends IdentityException {
  constructor(readonly identityId: string) {
    super(
      `This record's email is already used by an identity and no correlation rule matched it ` +
        `with confidence, so it waits for a conflict review on identity ${identityId}: ` +
        'Merge adds it there, or correct the email in the source',
      HttpStatus.CONFLICT,
    );
  }
}

/** The inbound record of a conflict, as identity correlation received it. */
export interface IncomingRecord {
  dto: StandardUserDto;
  sourceName: string;
  externalId: string;
  rawData: Record<string, unknown>;
  contractType?: string;
  sourceRole: string;
}

/** Why the record is flagged on the identity: the rule that matched, and how sure it is. */
export interface ConflictMatch {
  matchedBy: string | null;
  confidence: number;
  reviewRequired?: boolean;
}

/**
 * What flagCorrelationConflict did: `flagged` a new conflict (correlation.conflict emitted),
 * `refreshed` the open conflict about this same record (its snapshot and held record, no event),
 * or `kept` an open conflict about another record unchanged.
 */
export type ConflictFlagOutcome = 'flagged' | 'refreshed' | 'kept';

/** Whether the open conflict of `identity` is about the record `sourceName`/`externalId`. */
function isAbout(identity: IdentityDocument, sourceName: string, externalId: string): boolean {
  const details = identity.metadata?.conflictDetails;
  const record = (details?.incomingSource ?? details?.incomingSnapshot) as
    | { sourceName?: unknown; externalId?: unknown }
    | undefined;
  return record?.sourceName === sourceName && record?.externalId === externalId;
}

/**
 * Flag `identity` with a correlation conflict about `incoming`: metadata.correlationConflict,
 * requiresReview and conflictDetails (both records' snapshots), saved, then correlation.conflict
 * emitted. `held`: the record cannot get an identity of its own, so it is stored on the conflict
 * (`incomingSource`) for a Merge; the caller then throws RowHeldForConflictReview.
 * An identity holds one conflict at a time: while one is open (requiresReview), a record it is
 * about refreshes it without a new event, and any other record leaves it as it is (a held record
 * waits for its next sync after the review; a minted one waits in the uncorrelated queue).
 */
export async function flagCorrelationConflict(
  identity: IdentityDocument,
  incoming: IncomingRecord,
  match: ConflictMatch,
  held: boolean,
  deps: { eventEmitter: DomainEventEmitterService; tenantId: string; session?: ClientSession },
): Promise<ConflictFlagOutcome> {
  const { dto, sourceName, externalId, rawData, contractType, sourceRole } = incoming;
  const open = identity.metadata?.requiresReview === true && !!identity.metadata.conflictDetails;
  const sameRecord = open && isAbout(identity, sourceName, externalId);
  if (open && !sameRecord) return 'kept';
  const minted = sameRecord ? identity.metadata?.conflictDetails?.incomingIdentityId : undefined;
  const existingProfile = identity.profile as unknown as Record<string, unknown>;
  const incomingSnapshot = {
    sourceName,
    externalId,
    firstName: dto.firstName,
    lastName: dto.lastName,
    email: dto.email,
    departmentName: dto.departmentName ?? (dto as unknown as Record<string, unknown>).department,
    jobTitle: dto.jobTitle,
  };
  const matchedValue =
    match.matchedBy === 'employeeNumber'
      ? dto.employeeNumber
      : match.matchedBy === 'email'
        ? dto.email
        : undefined;
  const incomingSource = held
    ? ({
        sourceName,
        externalId,
        lastSync: new Date(),
        rawData,
        contractType,
        sourceRole,
      } as LinkedAccount)
    : undefined;
  identity.metadata = identity.metadata || {};
  identity.metadata.correlationConflict = true;
  identity.metadata.requiresReview = true;
  identity.metadata.conflictDetails = {
    matchedBy: match.matchedBy ?? '',
    matchedValue: matchedValue ?? '',
    confidence: match.confidence,
    existingSnapshot: {
      sourceName: existingProfile?.sourceSystem,
      firstName: existingProfile?.firstName,
      lastName: existingProfile?.lastName,
      email: existingProfile?.email,
      departmentName: existingProfile?.departmentName ?? existingProfile?.departmentCode,
      jobTitle: existingProfile?.jobTitle,
    },
    incomingSnapshot,
    ...(incomingSource ? { incomingSource } : {}),
    // A refresh keeps the identity minted for the record
    ...(minted ? { incomingIdentityId: minted } : {}),
  };
  // metadata is Mixed (type: Object): Mongoose saves a change inside it only when told so
  identity.markModified('metadata');
  await identity.save(deps.session ? { session: deps.session } : {});
  if (sameRecord) return 'refreshed';
  deps.eventEmitter.emit(
    DomainEventType.CORRELATION_CONFLICT,
    identity._id?.toString() ?? '',
    {
      correlationRule: match.matchedBy,
      matchedBy: match.matchedBy,
      confidence: match.confidence,
      existingIdentityId: identity._id?.toString(),
      incomingSourceSystem: sourceName,
      reviewRequired: match.reviewRequired,
    },
    { tenantId: deps.tenantId },
  );
  return 'flagged';
}
