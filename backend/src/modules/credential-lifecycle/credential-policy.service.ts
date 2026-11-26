/**
 * Credential Policy Service
 *
 * CRUD for credential policies + policy resolution for a given target/employment type.
 */

import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  CredentialPolicy,
  type CredentialPolicyDocument,
} from './schemas/credential-policy.schema';
import {
  MfaRequirementSchema,
  PasswordPolicySchema,
  RotationPolicySchema,
  TargetScopeSchema,
  type CreateCredentialPolicyDto,
  type UpdateCredentialPolicyDto,
} from './dtos/credential-lifecycle.dto';

/** The unique { tenantId, name } index refused the write. */
const isDuplicateKey = (err: unknown) =>
  typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 11000;

/** The settings objects a PATCH may send part of, each with the defaults a create gives it. */
const SETTINGS = {
  targetScope: TargetScopeSchema,
  passwordPolicy: PasswordPolicySchema,
  rotationPolicy: RotationPolicySchema,
  mfaRequirement: MfaRequirementSchema,
} as const;
type SettingsKey = keyof typeof SETTINGS;

const nameTaken = (name: string | undefined) =>
  new ConflictException(
    `A credential policy named "${name ?? ''}" already exists. Choose another name.`,
  );

@Injectable()
export class CredentialPolicyService {
  private readonly logger = new Logger(CredentialPolicyService.name);

  constructor(
    @InjectModel(CredentialPolicy.name)
    private readonly model: Model<CredentialPolicyDocument>,
  ) {}

  async create(
    tenantId: string,
    dto: CreateCredentialPolicyDto,
  ): Promise<CredentialPolicyDocument> {
    try {
      return await this.model.create({ tenantId, ...dto });
    } catch (err: unknown) {
      if (isDuplicateKey(err)) throw nameTaken(dto.name);
      throw err;
    }
  }

  async findAll(tenantId: string): Promise<CredentialPolicyDocument[]> {
    return this.model.find({ tenantId }).lean().exec();
  }

  async findOne(tenantId: string, id: string): Promise<CredentialPolicyDocument> {
    const doc = await this.model.findOne({ _id: id, tenantId }).lean().exec();
    if (!doc) throw new NotFoundException(`Credential policy ${id} not found`);
    return doc;
  }

  async update(
    tenantId: string,
    id: string,
    dto: UpdateCredentialPolicyDto,
  ): Promise<CredentialPolicyDocument> {
    const set = await this.updateSet(tenantId, id, dto);
    let doc: CredentialPolicyDocument | null;
    try {
      doc = await this.model
        .findOneAndUpdate({ _id: id, tenantId }, { $set: set }, { new: true })
        .lean()
        .exec();
    } catch (err: unknown) {
      if (isDuplicateKey(err)) throw nameTaken(dto.name);
      throw err;
    }
    if (!doc) throw new NotFoundException(`Credential policy ${id} not found`);
    return doc;
  }

  /**
   * The $set of a PATCH. A settings object sent changes only the fields it names (dotted paths),
   * so its other fields keep their stored values. One the policy does not have yet is stored whole,
   * with the defaults a create gives it. Read and write are two steps: two PATCHes of one policy
   * at once can each find a settings object missing, and the later one wins.
   */
  private async updateSet(
    tenantId: string,
    id: string,
    dto: UpdateCredentialPolicyDto,
  ): Promise<Record<string, unknown>> {
    const set: Record<string, unknown> = {};
    const sent: Array<[SettingsKey, Record<string, unknown>]> = [];
    for (const [key, value] of Object.entries(dto)) {
      if (value === undefined) continue;
      if (key in SETTINGS) sent.push([key as SettingsKey, value as Record<string, unknown>]);
      else set[key] = value;
    }
    if (sent.length === 0) return set;

    const current = await this.findOne(tenantId, id);
    for (const [key, value] of sent) {
      if (current[key] == null) {
        set[key] = SETTINGS[key].parse(value);
        continue;
      }
      for (const [field, fieldValue] of Object.entries(value)) {
        if (fieldValue !== undefined) set[`${key}.${field}`] = fieldValue;
      }
    }
    return set;
  }

  async delete(tenantId: string, id: string): Promise<void> {
    const result = await this.model.deleteOne({ _id: id, tenantId });
    if (result.deletedCount === 0) {
      throw new NotFoundException(`Credential policy ${id} not found`);
    }
  }

  /**
   * Resolve the most specific credential policy for a target system and employment type.
   * A policy scoped to connector types or employment types applies only to those (an identity
   * without an employment type matches no employment scope). Priority: connector match (2) plus
   * employment type match (1); of equally specific policies the oldest wins.
   */
  async resolvePolicy(
    tenantId: string,
    targetSystem: string,
    employmentType?: string,
  ): Promise<CredentialPolicyDocument | null> {
    const policies = await this.model.find({ tenantId, isActive: true }).lean().exec();
    // Oldest first (an ObjectId's hex order is its creation order), so a tie does not depend on
    // the order MongoDB returns
    policies.sort((a, b) => String(a._id).localeCompare(String(b._id)));

    // Score each policy by specificity
    let best: CredentialPolicyDocument | null = null;
    let bestScore = -1;

    for (const policy of policies) {
      let score = 0;

      // Check connector scope
      const connectorTypes = policy.targetScope?.connectorTypes;
      if (connectorTypes && connectorTypes.length > 0) {
        if (!connectorTypes.includes(targetSystem)) continue;
        score += 2; // Exact match bonus
      }

      // Check employment type scope
      const empTypes = policy.targetScope?.employmentTypes;
      if (empTypes && empTypes.length > 0) {
        if (!employmentType || !empTypes.includes(employmentType)) continue;
        score += 1;
      }

      if (score > bestScore) {
        bestScore = score;
        best = policy;
      }
    }

    return best;
  }
}
