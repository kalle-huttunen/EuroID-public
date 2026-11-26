import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { createHash, randomBytes } from 'crypto';
import { ScimToken, ScimTokenDocument } from './schemas/scim-token.schema';
import { MachineIdentitySyncService } from '../identity/machine-identity-sync.service';

@Injectable()
export class ScimTokenService {
  private readonly logger = new Logger(ScimTokenService.name);

  constructor(
    @InjectModel(ScimToken.name)
    private readonly tokenModel: Model<ScimTokenDocument>,
    private readonly machineIdentitySync: MachineIdentitySyncService,
  ) {}

  /**
   * Generate a new SCIM bearer token.
   * - Creates a random 48-byte token (base64url encoded)
   * - Stores SHA-256 hash in DB
   * - Returns the plaintext token ONCE (never stored, never retrievable)
   */
  async generateToken(
    name: string,
    createdBy: string,
    scopes?: string[],
    expiresAt?: Date,
  ): Promise<{ token: string; id: string; name: string }> {
    const rawToken = randomBytes(48);
    const token = rawToken.toString('base64url');
    const tokenHash = createHash('sha256').update(token).digest('hex');

    const doc = await this.tokenModel.create({
      tokenHash,
      name: name.trim(),
      createdBy,
      status: 'active',
      scopes: scopes ?? ['Users:read', 'Users:write', 'Groups:read', 'Groups:write'],
      expiresAt,
    });

    await this.machineIdentitySync.syncScimTokenToIdentity(doc).catch((err) => {
      this.logger.error(
        `syncScimTokenToIdentity failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });

    return {
      token,
      id: doc._id.toString(),
      name: doc.name,
    };
  }

  /**
   * Validate a bearer token.
   * - Hash the provided token with SHA-256
   * - Look up in DB by tokenHash (skipTenantScope: we don't know tenant yet — token discovers it)
   * - Check status is 'active' and not expired
   * - Update lastUsedAt on success
   * - Returns token metadata (name, scopes, tenantId) or null if invalid
   */
  async validateToken(
    bearerToken: string,
  ): Promise<{ id: string; name: string; scopes: string[]; tenantId: string } | null> {
    const tokenHash = createHash('sha256').update(bearerToken).digest('hex');

    // Skip tenant scope — we don't know the tenant yet, that's what we're looking up
    const doc = await this.tokenModel
      .findOne({ tokenHash })
      .setOptions({ skipTenantScope: true })
      .exec();

    if (!doc) return null;
    if (doc.status === 'revoked') return null;
    if (doc.expiresAt && new Date() > doc.expiresAt) return null;

    await this.tokenModel
      .updateOne({ _id: doc._id }, { $set: { lastUsedAt: new Date() } })
      .setOptions({ skipTenantScope: true })
      .exec();

    return {
      id: doc._id.toString(),
      name: doc.name,
      scopes: doc.scopes ?? [],
      tenantId: doc.tenantId,
    };
  }

  /**
   * Revoke a token by ID. Sets status to 'revoked'. 404 for a token the tenant does not have, so
   * a script that revokes a wrong id is not told it succeeded.
   */
  async revokeToken(id: string): Promise<void> {
    const doc = await this.tokenModel
      .findByIdAndUpdate(id, { $set: { status: 'revoked' } }, { new: true })
      .exec();
    if (!doc) throw new NotFoundException('SCIM token not found');
    await this.machineIdentitySync.syncScimTokenToIdentity(doc).catch((err) => {
      this.logger.error(
        `syncScimTokenToIdentity failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  /**
   * List all tokens (metadata only — no plaintext, no hash).
   */
  async listTokens(): Promise<
    Array<{
      id: string;
      name: string;
      createdBy: string;
      createdAt: Date;
      lastUsedAt?: Date;
      expiresAt?: Date;
      status: string;
      scopes: string[];
    }>
  > {
    const docs = await this.tokenModel
      .find()
      .select('name createdBy createdAt lastUsedAt expiresAt status scopes')
      .sort({ createdAt: -1 })
      .lean()
      .exec();

    type LeanDoc = {
      _id: unknown;
      name: string;
      createdBy: string;
      createdAt?: Date;
      lastUsedAt?: Date;
      expiresAt?: Date;
      status: string;
      scopes?: string[];
    };
    return (docs as LeanDoc[]).map((d) => ({
      id: String(d._id),
      name: d.name,
      createdBy: d.createdBy,
      createdAt: d.createdAt ?? new Date(0),
      lastUsedAt: d.lastUsedAt,
      expiresAt: d.expiresAt,
      status: d.status,
      scopes: d.scopes ?? [],
    }));
  }
}
