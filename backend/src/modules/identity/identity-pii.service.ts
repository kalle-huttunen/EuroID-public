import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import type { IdentityDocument } from './schemas/identity.schema';
import { NOT_DELETED } from './identity.constants';
import type { PiiField } from './identity-pii';
import { AuditService } from '../audit/audit.service';
import { getCurrentTenantId } from '@infrastructure/multi-tenancy/tenant-context.helper';

export interface PiiRevealResult {
  identityId: string;
  field: PiiField;
  /** Clear value; null when the field is empty. */
  value: string | null;
}

/**
 * Audited reveal of one masked PII field (POST /identity/:id/pii/reveal).
 * The PII_REVEALED audit entry is written before the value is returned, in the same
 * request: if the audit write fails, the error propagates and no value leaves.
 */
@Injectable()
export class IdentityPiiService {
  constructor(
    @InjectModel('Identity') private readonly identityModel: Model<IdentityDocument>,
    private readonly auditService: AuditService,
  ) {}

  /** Returns null when the identity is not in the caller's tenant (or is soft-deleted). */
  async reveal(
    identityId: string,
    field: PiiField,
    actor: string,
  ): Promise<PiiRevealResult | null> {
    const tenantId = getCurrentTenantId();
    const identity = await this.identityModel
      .findOne({ _id: identityId, tenantId, ...NOT_DELETED })
      .select(`profile.${field}`)
      .lean()
      .exec();
    if (!identity) return null;

    const raw = (identity.profile as unknown as Record<string, unknown> | undefined)?.[field];
    const value = raw === null || raw === undefined || raw === '' ? null : String(raw);

    await this.auditService.log({
      action: 'PII_REVEALED',
      severity: 'info',
      actor,
      resourceType: 'identity',
      resourceId: identityId,
      resourceName: field,
      description: `PII field "${field}" revealed by ${actor}`,
      payload: { metadata: { field, identityId } },
      tenantId,
    });

    return { identityId, field, value };
  }
}
