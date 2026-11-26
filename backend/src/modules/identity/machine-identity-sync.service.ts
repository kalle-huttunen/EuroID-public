/**
 * Syncs Admin Users and SCIM Tokens to shadow Identity records for governance.
 * Keeps machine identities visible to Policy Engine and Access Reviews.
 */

import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import type { IdentityDocument } from './schemas/identity.schema';
import type { AdminUserDocument } from '../auth/schemas/admin-user.schema';
import type { ScimTokenDocument } from '../scim-inbound/schemas/scim-token.schema';
import { maskEmail } from './identity-pii';

const SOURCE_LOCAL_AUTH = 'local-auth';
const SOURCE_SCIM_TOKEN = 'scim-token';

function parseName(name: string): { firstName: string; lastName: string } {
  const trimmed = (name || '').trim();
  if (!trimmed) return { firstName: 'Admin', lastName: 'User' };
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0], lastName: parts[0] };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

function sanitizeForEmail(name: string): string {
  return (
    (name || '')
      .replace(/[^a-zA-Z0-9-_]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 50) || 'scim'
  );
}

@Injectable()
export class MachineIdentitySyncService {
  private readonly logger = new Logger(MachineIdentitySyncService.name);

  constructor(
    @InjectModel('Identity')
    private readonly identityModel: Model<IdentityDocument>,
  ) {}

  async syncAdminToIdentity(admin: AdminUserDocument): Promise<void> {
    const tenantId = admin.tenantId || 'dev-tenant';
    const externalId = admin._id.toString();
    const { firstName, lastName } = parseName(admin.name || '');
    const email = (admin.email || '').trim().toLowerCase();
    if (!email) return;

    const status = admin.isActive === true ? 'ACTIVE' : 'SUSPENDED';
    const profile = {
      firstName,
      lastName,
      email,
      employmentType: 'ADMIN_ACCOUNT',
      status,
    };

    const source = {
      sourceName: SOURCE_LOCAL_AUTH,
      externalId,
      lastSync: new Date(),
      rawData: {},
      sourceRole: 'target' as const,
    };
    await this.identityModel.findOneAndUpdate(
      {
        tenantId,
        'sources.sourceName': SOURCE_LOCAL_AUTH,
        'sources.externalId': externalId,
      },
      {
        $set: {
          tenantId,
          profile,
          sources: [source],
          updatedAt: new Date(),
        },
      },
      { upsert: true, new: true },
    );
    this.logger.debug(`Synced admin ${maskEmail(email)} to Identity`);
  }

  async syncScimTokenToIdentity(token: ScimTokenDocument): Promise<void> {
    const tenantId = token.tenantId || 'default';
    const externalId = token._id.toString();
    const name = (token.name || 'SCIM Token').trim();
    const sanitized = sanitizeForEmail(name);
    const email = `scim-${sanitized}-${externalId}@service.internal`;

    const status = token.status === 'active' ? 'ACTIVE' : 'SUSPENDED';
    const profile = {
      firstName: name,
      lastName: 'Service Account',
      displayName: name,
      email,
      employmentType: 'SERVICE_ACCOUNT',
      status,
    };

    const source = {
      sourceName: SOURCE_SCIM_TOKEN,
      externalId,
      lastSync: new Date(),
      rawData: {},
      sourceRole: 'target' as const,
    };
    await this.identityModel.findOneAndUpdate(
      {
        tenantId,
        'sources.sourceName': SOURCE_SCIM_TOKEN,
        'sources.externalId': externalId,
      },
      {
        $set: {
          tenantId,
          profile,
          sources: [source],
          updatedAt: new Date(),
        },
      },
      { upsert: true, new: true },
    );
    this.logger.debug(`Synced SCIM token ${name} to Identity`);
  }
}
