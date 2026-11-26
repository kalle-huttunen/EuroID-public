import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { BlueprintsService } from './blueprints.service';
import { EntraService } from '../connectors/entra-connector/entra.service';
import { StandardUserDto } from '@shared/dtos/standard-user.dto';
import type { EntraConfig } from '../connectors/entra-connector/entra.interface';
import {
  EntitlementCatalog,
  type EntitlementCatalogDocument,
} from '../entitlement-catalog/schemas/entitlement-catalog.schema';
import { getCurrentTenantId } from '@infrastructure/multi-tenancy/tenant-context.helper';
import type { EntraUserMetadata, IdentityLikeRecord, ImpactDelta } from './impact-analysis.types';
import { entraIntentMetadata, type IntentCatalogEntry } from './impact-entra-intent';

/**
 * Generates Entra ID specific impact metadata: UPN resolution, and the groups, directory roles
 * and licenses the policy intent assigns (the analysis's entra-id deltas), named and counted from
 * the entitlement catalog (impact-entra-intent.ts). Split out of ImpactAnalysisService to keep the
 * orchestrator slim. Without an Entra ID config with a default domain the UPN is not known (null,
 * status `unknown`, a `notKnown` sentence): it is never shown on an invented domain.
 */

const UPN_NOT_KNOWN =
  'UPN: not known: the canvas has no Entra ID connector config with a default domain, or the ' +
  'person has no first and last name to form it from.';
@Injectable()
export class ImpactEntraMetadataService {
  constructor(
    private readonly blueprintsService: BlueprintsService,
    private readonly entraService: EntraService,
    @InjectModel(EntitlementCatalog.name)
    private readonly catalogModel: Model<EntitlementCatalogDocument>,
  ) {}

  /** The catalog's Entra ID entries the deltas' entitlement changes name. */
  private async catalogEntries(deltas: ImpactDelta[]): Promise<IntentCatalogEntry[]> {
    const ids = [...new Set(deltas.flatMap((d) => d.entitlementChanges.map((c) => c.targetId)))];
    if (ids.length === 0) return [];
    return (await this.catalogModel
      .find({
        tenantId: getCurrentTenantId(),
        system: 'entra-id',
        $or: [{ nativeId: { $in: ids } }, { name: { $in: ids } }],
      })
      .select('nativeId name type licenseUnits')
      .lean()
      .exec()) as IntentCatalogEntry[];
  }

  /**
   * `deltas`: the analysis's deltas; a person's entra-id delta holds what the policy assigns
   * them in Entra ID (computeUserDelta), matched by the person's id, else their email.
   */
  async generate(
    users: (StandardUserDto | IdentityLikeRecord)[],
    dryRun: boolean,
    deltas: ImpactDelta[] = [],
  ): Promise<EntraUserMetadata[]> {
    const config = await this.blueprintsService.getConnectorConfigForImpact('entra-id');
    const entraDeltas = deltas.filter((d) => d.targetSystem === 'entra-id');
    const catalog = await this.catalogEntries(entraDeltas);
    const extractProfile = (user: StandardUserDto | IdentityLikeRecord): Record<string, unknown> =>
      ('profile' in user && user.profile ? user.profile : user) as Record<string, unknown>;

    return Promise.all(
      users.map(async (user) => {
        const p = extractProfile(user);
        const firstName = (p.firstName as string) || '';
        const lastName = (p.lastName as string) || '';
        const middleName = p.middleName as string | undefined;
        const email = p.email as string | undefined;
        const departmentCode = p.departmentCode as string | undefined;
        const rawId = user._id ?? ('id' in user ? user.id : undefined);
        const userId =
          typeof rawId === 'object' && rawId !== null ? rawId.toString() : String(rawId ?? '');
        const intent = entraDeltas.find(
          (d) => (userId && d.userId === userId) || (!!email && d.email === email),
        );
        const location = p.location as string | undefined;
        const userPrincipalName = p.userPrincipalName as string | undefined;

        const displayName = `${firstName} ${lastName}`.trim();
        const domain = config?.defaultDomain as string | undefined;
        let upn: string | null =
          domain && firstName && lastName
            ? `${firstName.toLowerCase()}.${lastName.toLowerCase()}@${domain}`
            : null;
        let upnStatus: EntraUserMetadata['upnStatus'] = upn ? 'valid' : 'unknown';
        let upnIssue: string | undefined;
        let suggestedUpn: string | undefined;
        let candidatesChecked: string[] | undefined;

        if (!dryRun && config && firstName && lastName) {
          try {
            const standardUser: Pick<
              StandardUserDto,
              'firstName' | 'lastName' | 'middleName' | 'email' | 'userPrincipalName'
            > = {
              firstName,
              lastName,
              middleName,
              email: email ?? '',
              userPrincipalName,
            };
            const result = await this.entraService.resolveAvailableUpn(
              standardUser as StandardUserDto,
              config as unknown as EntraConfig,
            );
            upn = result.chosenUpn;
            upnStatus = 'valid';
            candidatesChecked = result.candidatesChecked;
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            upnStatus = 'conflict';
            upnIssue = message || 'UPN resolution failed';
            const obj =
              err && typeof err === 'object'
                ? (err as { candidatesChecked?: string[]; suggestedUpn?: string })
                : null;
            if (obj?.candidatesChecked?.length) {
              candidatesChecked = obj.candidatesChecked;
              suggestedUpn =
                obj.suggestedUpn ?? obj.candidatesChecked[obj.candidatesChecked.length - 1];
            }
          }
        }

        const metadata = entraIntentMetadata(intent?.entitlementChanges ?? [], catalog);
        return {
          userId,
          displayName,
          upn,
          upnStatus,
          upnIssue,
          suggestedUpn,
          candidatesChecked,
          ...metadata,
          notKnown: upn === null ? [UPN_NOT_KNOWN, ...metadata.notKnown] : metadata.notKnown,
          department: departmentCode,
          location,
        };
      }),
    );
  }
}
