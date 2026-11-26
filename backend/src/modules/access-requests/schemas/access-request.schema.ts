import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

/** FAILED: the approval workflow could not be started when the request was created. */
export type AccessRequestStatus =
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'REJECTED'
  | 'PROVISIONING'
  | 'ACTIVE'
  | 'EXPIRED'
  | 'REVOKED'
  | 'CANCELLED'
  | 'FAILED';

export type ApprovalStepStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'SKIPPED';

export type ApproverType = 'MANAGER' | 'OWNER' | 'ROLE' | 'SPECIFIC_USER';

@Schema({ _id: false })
export class AccessRequestEntitlement {
  @Prop({ required: true })
  catalogEntryId!: string;

  @Prop({ required: true })
  system!: string;

  @Prop({ required: true })
  entitlementName!: string;

  @Prop()
  nativeId?: string;

  @Prop()
  entitlementType?: 'Group' | 'License' | 'DirectoryRole';

  @Prop({ required: true })
  justification!: string;
}

@Schema({ _id: false })
export class ApprovalStep {
  @Prop({ required: true })
  stepOrder!: number;

  @Prop({ required: true, enum: ['MANAGER', 'OWNER', 'ROLE', 'SPECIFIC_USER'] })
  approverType!: ApproverType;

  @Prop()
  approverId?: string;

  @Prop()
  approverEmail?: string;

  @Prop({
    required: true,
    enum: ['PENDING', 'APPROVED', 'REJECTED', 'SKIPPED'],
    default: 'PENDING',
  })
  status!: ApprovalStepStatus;

  @Prop()
  decidedAt?: Date;

  @Prop()
  justification?: string;

  /** Email of the user who approved or rejected the step (for a ROLE step: the role holder). */
  @Prop()
  decidedBy?: string;

  @Prop()
  delegatedFrom?: string;
}

/**
 * The admin role a step waits for: a ROLE step stores the role name (e.g. `policy-admin`) as its
 * approverId and approverEmail, and any active admin user of the tenant with that role decides it.
 * Undefined for other steps and for a delegated ROLE step, which belongs to the delegate.
 */
export function stepRole(
  step: Pick<ApprovalStep, 'approverType' | 'approverId' | 'approverEmail' | 'delegatedFrom'>,
): string | undefined {
  if (step.approverType !== 'ROLE' || step.delegatedFrom) return undefined;
  return step.approverId || step.approverEmail || undefined;
}

/**
 * An admin closed the request as removed by hand (AccessRequestManualRemovalService): its removal
 * at the end date kept failing and the admin removed the access in the target themself. EuroID
 * did not remove it.
 */
@Schema({ _id: false })
export class RemovedManually {
  /** The admin's email (or user id) from the token. */
  @Prop({ required: true })
  by!: string;

  @Prop({ required: true })
  at!: Date;

  /** The admin's note on how the access was removed. */
  @Prop({ required: true })
  note!: string;

  /** The request's statusReason before (why the removal failed), when it had one. */
  @Prop()
  failureReason?: string;
}

const RemovedManuallySchema = SchemaFactory.createForClass(RemovedManually);

@Schema({ _id: false })
export class SodViolationRef {
  @Prop()
  policyName!: string;

  @Prop()
  severity!: string;

  /** BLOCK or WARN. Absent in results stored before plan 2.9 (all of those are Warn matches). */
  @Prop({ enum: ['BLOCK', 'WARN'] })
  action?: 'BLOCK' | 'WARN';

  @Prop({ type: [String] })
  conflictingEntitlements!: string[];
}

const SodViolationRefSchema = SchemaFactory.createForClass(SodViolationRef);

/**
 * SoD result of a request. At creation it is passed true with the Warn matches (a Block match
 * refuses the request before it is stored). When the last approval comes in the request is
 * checked again (AccessRequestSodService.claimForProvisioning); a Block match then rejects it and
 * replaces this with passed false and the matches found at that moment.
 */
@Schema({ _id: false })
export class SodCheckResult {
  @Prop({ required: true })
  passed!: boolean;

  @Prop({ type: [SodViolationRefSchema] })
  violations?: SodViolationRef[];
}

const SodCheckResultSchema = SchemaFactory.createForClass(SodCheckResult);

@Schema({ _id: false })
export class TimeConstraint {
  @Prop()
  requestedDurationDays?: number;

  @Prop()
  expiresAt?: Date;
}

const AccessRequestEntitlementSchema = SchemaFactory.createForClass(AccessRequestEntitlement);
const ApprovalStepSchema = SchemaFactory.createForClass(ApprovalStep);
const TimeConstraintSchema = SchemaFactory.createForClass(TimeConstraint);

export type AccessRequestDocument = HydratedDocument<AccessRequest>;

@Schema({
  timestamps: true,
  collection: 'access_requests',
})
export class AccessRequest {
  @Prop({ required: true, index: true })
  tenantId!: string;

  @Prop({ required: true, unique: true, index: true })
  requestId!: string;

  @Prop({ required: true, index: true })
  requesterId!: string;

  @Prop({ required: true })
  requesterEmail!: string;

  @Prop()
  targetIdentityId?: string;

  @Prop({ type: [AccessRequestEntitlementSchema], required: true })
  entitlements!: AccessRequestEntitlement[];

  @Prop({
    required: true,
    enum: [
      'PENDING_APPROVAL',
      'APPROVED',
      'REJECTED',
      'PROVISIONING',
      'ACTIVE',
      'EXPIRED',
      'REVOKED',
      'CANCELLED',
      'FAILED',
    ],
    default: 'PENDING_APPROVAL',
  })
  status!: AccessRequestStatus;

  @Prop({ type: [ApprovalStepSchema], default: [] })
  approvalSteps!: ApprovalStep[];

  @Prop({ type: TimeConstraintSchema })
  timeConstraint?: TimeConstraint;

  @Prop({ type: SodCheckResultSchema })
  sodCheckResult?: SodCheckResult;

  @Prop()
  workflowId?: string;

  @Prop()
  provisionedAt?: Date;

  @Prop()
  expiresAt?: Date;

  /**
   * Why the system ended the request without a decision that says so itself
   * (AccessRequestClosureService): the end date passed before approval completed (EXPIRED), or
   * the approval workflow no longer ran when an approver decided (CANCELLED); why fulfilment
   * failed (REJECTED: no Entra ID account recorded, or Graph refused); why the removal at the end
   * date waits (ACTIVE: Graph refused it; cleared when a later attempt succeeds); the admin's
   * note on a request closed as removed by hand (EXPIRED, with removedManually). Absent on a
   * request the requester cancelled.
   */
  @Prop()
  statusReason?: string;

  /** Set when an admin closed the request as removed by hand (EXPIRED). */
  @Prop({ type: RemovedManuallySchema })
  removedManually?: RemovedManually;
}

export const AccessRequestSchema = SchemaFactory.createForClass(AccessRequest);

AccessRequestSchema.index({ tenantId: 1, requestId: 1 });
AccessRequestSchema.index({ tenantId: 1, requesterId: 1, status: 1 });
AccessRequestSchema.index({
  tenantId: 1,
  'approvalSteps.approverId': 1,
  'approvalSteps.status': 1,
});
AccessRequestSchema.index({
  tenantId: 1,
  'approvalSteps.approverEmail': 1,
  'approvalSteps.status': 1,
});
