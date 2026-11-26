import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { InjectModel, InjectConnection } from '@nestjs/mongoose';
import { Model, Connection } from 'mongoose';
import { Tenant, TenantDocument } from './schemas/tenant.schema';
import {
  migrateTenantData,
  tenantDataCollections,
  type TenantDataMigrationResult,
} from './migrate-tenant-data';
import type { TenantSettingsPatch } from './tenant.dtos';
import { TenantStatusService } from './tenant-status.service';

export interface CreateTenantDto {
  tenantId: string;
  name: string;
  createdBy: string;
}

@Injectable()
export class TenantService {
  constructor(
    @InjectModel(Tenant.name) private readonly tenantModel: Model<TenantDocument>,
    @InjectConnection() private readonly connection: Connection,
    private readonly tenantStatus: TenantStatusService,
  ) {}

  async create(data: CreateTenantDto): Promise<TenantDocument> {
    const existing = await this.tenantModel.findOne({ tenantId: data.tenantId }).exec();
    if (existing) {
      throw new ConflictException(`Tenant ${data.tenantId} already exists`);
    }
    return this.tenantModel.create({
      tenantId: data.tenantId,
      name: data.name,
      createdBy: data.createdBy,
      status: 'active',
    });
  }

  async findAll(): Promise<TenantDocument[]> {
    return this.tenantModel.find().sort({ tenantId: 1 }).exec();
  }

  async findById(tenantId: string): Promise<TenantDocument> {
    const doc = await this.tenantModel.findOne({ tenantId }).exec();
    if (!doc) {
      throw new NotFoundException(`Tenant ${tenantId} not found`);
    }
    return doc;
  }

  /**
   * Name and status are set when given. Settings are merged key by key (`settings.<key>`), so a
   * PATCH of one setting keeps the others (mfaRequired among them); a setting sent as null is
   * removed.
   */
  async update(
    tenantId: string,
    data: { name?: string; status?: Tenant['status']; settings?: TenantSettingsPatch },
  ): Promise<TenantDocument> {
    const $set: Record<string, unknown> = {};
    const $unset: Record<string, 1> = {};
    if (data.name !== undefined) $set.name = data.name;
    if (data.status !== undefined) $set.status = data.status;
    for (const [key, value] of Object.entries(data.settings ?? {})) {
      if (value === undefined) continue;
      if (value === null) $unset[`settings.${key}`] = 1;
      else $set[`settings.${key}`] = value;
    }
    const doc = await this.tenantModel
      .findOneAndUpdate(
        { tenantId },
        {
          ...(Object.keys($set).length && { $set }),
          ...(Object.keys($unset).length && { $unset }),
        },
        { new: true },
      )
      .exec();
    if (!doc) {
      throw new NotFoundException(`Tenant ${tenantId} not found`);
    }
    this.tenantStatus.forget(tenantId);
    return doc;
  }

  async suspend(tenantId: string): Promise<TenantDocument> {
    const doc = await this.tenantModel
      .findOneAndUpdate({ tenantId }, { $set: { status: 'suspended' } }, { new: true })
      .exec();
    if (!doc) {
      throw new NotFoundException(`Tenant ${tenantId} not found`);
    }
    this.tenantStatus.forget(tenantId);
    return doc;
  }

  /**
   * Assign documents stored without a tenant to `targetTenantId` (migrate-tenant-data.ts); with
   * dryRun (the default) only count them. The target must be a tenant (404 otherwise). Documents
   * tagged `default` move only while `default` is no live tenant: not in `tenants`, not
   * DEFAULT_TENANT_ID (whose default is `default`), not the target. Audit events never move.
   */
  async migrateDatabase(targetTenantId: string, dryRun = true): Promise<TenantDataMigrationResult> {
    if (!(await this.tenantModel.exists({ tenantId: targetTenantId }))) {
      throw new NotFoundException(
        `Tenant ${targetTenantId} not found. Create it first (POST /tenants).`,
      );
    }
    const db = this.connection.db;
    if (!db) {
      throw new Error('Database connection not available');
    }
    const defaultIsLive =
      targetTenantId === 'default' ||
      (process.env.DEFAULT_TENANT_ID || 'default') === 'default' ||
      !!(await this.tenantModel.exists({ tenantId: 'default' }));
    return migrateTenantData(
      db as unknown as Parameters<typeof migrateTenantData>[0],
      tenantDataCollections(this.connection.models),
      targetTenantId,
      {
        dryRun,
        includeLegacyDefault: !defaultIsLive,
      },
    );
  }
}
