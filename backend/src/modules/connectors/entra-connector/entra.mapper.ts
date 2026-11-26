import { Injectable } from '@nestjs/common';
import { StandardUserDto } from '@shared/dtos/standard-user.dto';
import { EntraUserDto } from './entra.interface';
import type { ProvisioningResult } from '@shared/dtos/provisioning-result.dto';
import { targetAccountEnabled } from '@shared/utils/linked-admin-profile';

/**
 * Extract writeback-worthy attributes from Entra provisioning result.
 * Exported for use by WritebackActivities. Target-generated IDs in payload; mastery controls profile promotion.
 */
export function extractWritebackAttributes(result: ProvisioningResult): Record<string, unknown> {
  const attrs = result.generatedAttributes;
  const payload: Record<string, unknown> = {};
  if (attrs?.mail || attrs?.userPrincipalName) {
    payload.email = attrs.mail || attrs.userPrincipalName;
  }
  if (attrs?.userPrincipalName) {
    payload.userPrincipalName = attrs.userPrincipalName;
  }
  if (result.targetUserId) {
    payload.objectId = result.targetUserId;
  }
  return payload;
}

/**
 * Pure mapping: StandardUserDto → EntraUserDto. No HTTP; used by EntraService.
 */
@Injectable()
export class EntraMapper {
  /**
   * @param user - Standard user from Hub
   * @param defaultUsageLocation - Default country code for licensing
   * @param overrideUpn - Resolved UPN from UpnGenerator
   * @param password - Pre-generated password from CredentialGenerationService (required for new users)
   */
  toEntraProfile(
    user: StandardUserDto,
    defaultUsageLocation: string,
    overrideUpn?: string,
    password?: string,
  ): EntraUserDto {
    const upn = overrideUpn ?? user.userPrincipalName ?? user.email;

    // Fallback logic for nickname
    const nickname = user.samAccountName || upn.split('@')[0];

    // Build the Entra user profile with ALL available fields from StandardUserDto
    const entraUser: EntraUserDto = {
      // A linked admin account (PAM) is created disabled: only its session enables it
      accountEnabled: targetAccountEnabled(user),
      displayName: user.displayName || `${user.firstName} ${user.lastName}`,
      userPrincipalName: upn,
      mailNickname: nickname,
      givenName: user.firstName,
      surname: user.lastName,

      // Employment fields
      jobTitle: user.jobTitle,
      department: user.departmentCode || user.departmentName,
      employeeId: user.employeeId,
      companyName: user.division,

      // Contact fields
      mobilePhone: user.mobilePhone,
      businessPhones: user.workPhone ? [user.workPhone] : undefined,

      // Location fields (Crucial for licensing and user experience)
      officeLocation: user.officeName || user.officeLocation || user.location,
      city: user.city,
      state: user.stateProvince,
      country: user.countryCode,
      postalCode: user.postalCode,
      usageLocation: user.countryCode || defaultUsageLocation,

      // Password (required for new users) — generated externally by CredentialGenerationService
      ...(password && {
        passwordProfile: {
          forceChangePasswordNextSignIn: true,
          password,
        },
      }),
    };

    // Remove undefined fields to keep the payload clean
    const entraUserRecord = entraUser as unknown as Record<string, unknown>;
    Object.keys(entraUserRecord).forEach((key: string) => {
      if (entraUserRecord[key] === undefined) {
        delete entraUserRecord[key];
      }
    });

    return entraUser;
  }

  /**
   * Pure mapping: StandardUserDto → Entra PATCH payload for attribute updates.
   * Single source of truth for field-name mapping and status→accountEnabled rule.
   */
  toEntraUpdatePayload(user: StandardUserDto): Record<string, unknown> {
    const FIELD_MAP: Array<{
      source: string;
      target: string;
      nonEmpty?: boolean;
      transform?: (v: unknown) => unknown;
    }> = [
      { source: 'firstName', target: 'givenName' },
      { source: 'lastName', target: 'surname' },
      { source: 'displayName', target: 'displayName' },
      { source: 'jobTitle', target: 'jobTitle', nonEmpty: true },
      { source: 'employeeId', target: 'employeeId' },
      { source: 'division', target: 'companyName' },
      { source: 'mobilePhone', target: 'mobilePhone' },
      { source: 'workPhone', target: 'businessPhones', transform: (v) => [v] },
      { source: 'city', target: 'city' },
      { source: 'stateProvince', target: 'state' },
      { source: 'postalCode', target: 'postalCode' },
    ];

    const payload: Record<string, unknown> = {};
    const userRecord = user as unknown as Record<string, unknown>;
    for (const { source, target, nonEmpty, transform } of FIELD_MAP) {
      const val = userRecord[source];
      if (val === undefined || val === null) continue;
      if (nonEmpty && val === '') continue;
      payload[target] = transform ? transform(val) : val;
    }

    const dept = user.departmentName || user.departmentCode;
    if (dept) payload.department = dept;

    const office = user.officeName ?? user.officeLocation ?? user.location;
    if (office != null) payload.officeLocation = office;

    if (user.countryCode != null) {
      payload.country = user.countryCode;
      payload.usageLocation = user.countryCode;
    }

    if (user.status != null) {
      payload.accountEnabled = targetAccountEnabled(user);
    }

    return payload;
  }
}
