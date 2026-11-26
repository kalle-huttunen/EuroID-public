import { Injectable, Logger } from '@nestjs/common';
import { IdentityService } from '../identity/identity.service';
import { PolicyEngineService, PolicyProvisioningIntent } from '../policy/policy-engine.service';
import type { SodViolation } from '../policy/sod.service';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import {
  IMPACT_ANALYSIS_PAGE_SIZE,
  IMPACT_ANALYSIS_SAMPLE_SIZE,
} from '@infrastructure/config/defaults';
import { BlueprintsService } from './blueprints.service';
import { StandardUserDto, UserStatus } from '@shared/dtos/standard-user.dto';
import {
  aggregateDeltas,
  assessRisk,
  computeUserDelta,
  emptyImpactResult,
  impactTargetSystem,
  toApiDelta,
} from './impact-delta.util';
import type {
  BlueprintCanvasNode,
  EntraUserMetadata,
  IdentityLikeRecord,
  ImpactAnalysisResult,
  ImpactDelta,
} from './impact-analysis.types';
import { ImpactEntraMetadataService } from './impact-entra-metadata.service';

// Re-export public types so existing imports (e.g. controllers, pipeline.service) keep working.
export type {
  AttributeChange,
  EntitlementChange,
  ImpactDelta,
  RiskAssessment,
  ImpactAnalysisResult,
} from './impact-analysis.types';

/**
 * Impact Analysis Service — Real delta computation for "Simulate Before Commit"
 *
 * Compares HR users (from Hub) → Policy Engine output → Identity provisioning state
 * to determine CREATE, UPDATE, REMOVE, DISABLE, NO_CHANGE per user per target system.
 * Uses Identity Hub's stored provisioning state (not live API calls) for demo speed.
 *
 * Thin orchestrator. Pure helpers live in `impact-delta.util.ts`, Entra-specific
 * metadata lives in `ImpactEntraMetadataService`, and shared types in `impact-analysis.types.ts`.
 */
@Injectable()
export class ImpactAnalysisService {
  private readonly logger = new Logger(ImpactAnalysisService.name);

  constructor(
    private readonly identityService: IdentityService,
    private readonly policyEngine: PolicyEngineService,
    private readonly blueprintsService: BlueprintsService,
    private readonly entraMetadata: ImpactEntraMetadataService,
  ) {}

  /**
   * Compute real deltas by comparing Hub users → Policy intent → provisioning state.
   * When options.users is empty, streams pages from Hub to avoid OOM. Accumulates first N users
   * as userSample for Entra metadata generation.
   */
  async computeDeltas(
    tenantId: string,
    options?: {
      users?: StandardUserDto[];
      connectors?: string[];
      blueprintId?: string;
    },
  ): Promise<ImpactAnalysisResult> {
    const targetSystems = await this.getTargetSystems(options?.connectors);

    const deltas: ImpactDelta[] = [];
    const sodViolationsByUser: Array<{
      userId: string;
      email: string;
      violations: SodViolation[];
    }> = [];
    const userSample: StandardUserDto[] = [];

    if (options?.users && options.users.length > 0) {
      for (const user of options.users) {
        const userDto = this.toStandardUserDto(user);
        await this.processUser(userDto, tenantId, targetSystems, deltas, sodViolationsByUser);
      }
    } else {
      let skip = 0;
      let total = 0;
      do {
        const { users, total: pageTotal } =
          await this.identityService.findUsersPageForReconciliation(
            skip,
            IMPACT_ANALYSIS_PAGE_SIZE,
          );
        if (skip === 0) {
          total = pageTotal ?? 0;
        }
        if (total === 0) break;

        for (const user of users) {
          if (userSample.length < IMPACT_ANALYSIS_SAMPLE_SIZE) {
            userSample.push(user as unknown as StandardUserDto);
          }
          const userDto = this.toStandardUserDto(user as unknown as IdentityLikeRecord);
          await this.processUser(userDto, tenantId, targetSystems, deltas, sodViolationsByUser);
        }
        skip += IMPACT_ANALYSIS_PAGE_SIZE;
      } while (skip < total);
    }

    if (deltas.length === 0 && userSample.length === 0) {
      return emptyImpactResult();
    }

    const summary = aggregateDeltas(deltas);
    const risk = assessRisk(deltas);

    const result: ImpactAnalysisResult = { deltas, summary, risk };
    if (sodViolationsByUser.length > 0) {
      result.sodViolationsByUser = sodViolationsByUser;
    }
    if (userSample.length > 0) {
      result.userSample = userSample;
    }
    return result;
  }

  private async processUser(
    userDto: StandardUserDto,
    tenantId: string,
    targetSystems: string[],
    deltas: ImpactDelta[],
    sodViolationsByUser: Array<{ userId: string; email: string; violations: SodViolation[] }>,
  ): Promise<void> {
    const policyResult: PolicyProvisioningIntent = await withTenantContext(tenantId, () =>
      this.policyEngine.evaluate(userDto, tenantId),
    );

    if (policyResult.sodValidation && !policyResult.sodValidation.passed) {
      sodViolationsByUser.push({
        userId: userDto._id?.toString() ?? userDto.email,
        email: userDto.email ?? '',
        violations: policyResult.sodValidation.blockers,
      });
      return;
    }

    const identity = await this.identityService.findIdentityByEmail(userDto.email);
    const provisioning = identity?.provisioning ?? [];

    for (const system of targetSystems) {
      deltas.push(computeUserDelta(userDto, policyResult, provisioning, system));
    }
  }

  /**
   * The systems to compute deltas for: the requested connectors, else the canvas's target nodes
   * (`data.role: 'target'`; HR source nodes and the hub are none), named by impactTargetSystem.
   */
  private async getTargetSystems(connectors?: string[]): Promise<string[]> {
    if (connectors && connectors.length > 0) {
      return connectors.map(impactTargetSystem);
    }

    const blueprint = await this.blueprintsService.getLatestBlueprint();
    const systems = new Set<string>();
    for (const rawNode of blueprint.nodes ?? []) {
      const node = rawNode as BlueprintCanvasNode;
      const type = node.data?.type;
      if (typeof type !== 'string' || !type) continue;
      // A canvas saved before nodes had a role: every node but the hub is a target
      const legacyTarget = node.data?.role === undefined && node.type !== 'hub' && type !== 'hub';
      if (node.data?.role !== 'target' && !legacyTarget) continue;
      systems.add(impactTargetSystem(type));
    }
    return systems.size > 0 ? Array.from(systems) : ['entra-id'];
  }

  private toStandardUserDto(user: IdentityLikeRecord | StandardUserDto): StandardUserDto {
    if ('profile' in user && user.profile) {
      const p = user.profile;
      const record = user as IdentityLikeRecord;
      return {
        ...p,
        sourceSystem: p.sourceSystem ?? record.sources?.[0]?.sourceName ?? 'hr-feed',
        sourceUserId: p.sourceUserId ?? record.sources?.[0]?.externalId ?? p.email,
        tenantId: record.tenantId ?? p.tenantId ?? 'default',
        firstName: p.firstName,
        lastName: p.lastName,
        email: p.email,
        status: (p.status as UserStatus) ?? UserStatus.ACTIVE,
        _id: typeof record._id === 'string' ? record._id : record._id?.toString(),
      } as StandardUserDto;
    }
    const idStr = typeof user._id === 'string' ? user._id : user._id?.toString();
    return {
      ...user,
      _id: idStr,
    } as StandardUserDto;
  }

  /** Convert internal ImpactDelta → API IUserDelta. Thin pass-through to pure util. */
  toApiDelta(d: ImpactDelta): ReturnType<typeof toApiDelta> {
    return toApiDelta(d);
  }

  /**
   * Generate Entra ID specific metadata (UPN validation, and the groups and licenses the policy
   * assigns: the entra-id deltas of `deltas`). When dryRun=true the UPN is the pattern's, without
   * live API calls (RC-3); when dryRun=false, resolveAvailableUpn checks it.
   */
  generateEntraMetadata(
    users: (StandardUserDto | IdentityLikeRecord)[],
    dryRun: boolean,
    deltas: ImpactDelta[] = [],
  ): Promise<EntraUserMetadata[]> {
    return this.entraMetadata.generate(users, dryRun, deltas);
  }
}
