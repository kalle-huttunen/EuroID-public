import { Injectable } from '@nestjs/common';
import { StandardUserDto, UserStatus } from '@shared/dtos/standard-user.dto';
import { SCIMUser, SCIMEnterprise } from '@shared/scim';
import { SCIM_SCHEMAS } from '@shared/scim';
import { targetAccountEnabled } from '@shared/utils/linked-admin-profile';

/**
 * Pure mapping: StandardUserDto ↔ SCIMUser.
 * No HTTP, no side effects — used by SCIMService.
 *
 * Field mapping:
 *   firstName/lastName   → name.givenName / name.familyName
 *   email                → emails[0] (primary)
 *   department            → enterprise extension .department
 *   division              → enterprise extension .division
 *   title                 → top-level .title
 *   employeeId            → enterprise extension .employeeNumber
 *   active status         → active boolean
 *   managerEmail          → enterprise extension .manager.displayName
 */
@Injectable()
export class SCIMMapper {
  /**
   * Convert a StandardUserDto to a SCIM 2.0 User resource.
   */
  toSCIMUser(dto: StandardUserDto): SCIMUser {
    const schemas: string[] = [SCIM_SCHEMAS.USER];

    // Build enterprise extension if any enterprise fields exist
    const enterprise = this.buildEnterprise(dto);
    if (enterprise) {
      schemas.push(SCIM_SCHEMAS.ENTERPRISE_USER);
    }

    const scimUser: SCIMUser = {
      schemas,
      userName: dto.userPrincipalName || dto.email,
      externalId: dto.employeeId || dto.sourceUserId,
      name: {
        givenName: dto.firstName,
        familyName: dto.lastName,
        middleName: dto.middleName,
        formatted: dto.displayName || `${dto.firstName} ${dto.lastName}`,
      },
      displayName: dto.displayName || `${dto.firstName} ${dto.lastName}`,
      // A linked admin account (PAM) is inactive unless its session is active
      active: targetAccountEnabled(dto),
      title: dto.jobTitle,
      emails: dto.email ? [{ value: dto.email, type: 'work', primary: true }] : [],
      phoneNumbers: this.buildPhoneNumbers(dto),
    };

    if (enterprise) {
      scimUser['urn:ietf:params:scim:schemas:extension:enterprise:2.0:User'] = enterprise;
    }

    // Strip undefined top-level values for a clean payload
    this.stripUndefined(scimUser as unknown as Record<string, unknown>);
    if (scimUser.name) this.stripUndefined(scimUser.name as unknown as Record<string, unknown>);

    return scimUser;
  }

  /**
   * Convert a SCIM 2.0 User resource back to a partial StandardUserDto.
   * Used for reconciliation / inbound sync.
   */
  fromSCIMUser(scimUser: SCIMUser): Partial<StandardUserDto> {
    const enterprise = scimUser['urn:ietf:params:scim:schemas:extension:enterprise:2.0:User'];
    const primaryEmail =
      scimUser.emails?.find((e) => e.primary)?.value ?? scimUser.emails?.[0]?.value;

    const workPhone = scimUser.phoneNumbers?.find((p) => p.type === 'work')?.value;
    const mobilePhone = scimUser.phoneNumbers?.find((p) => p.type === 'mobile')?.value;

    const dto: Partial<StandardUserDto> = {
      firstName: scimUser.name?.givenName,
      lastName: scimUser.name?.familyName,
      middleName: scimUser.name?.middleName,
      displayName: scimUser.displayName || scimUser.name?.formatted,
      email: primaryEmail,
      userPrincipalName: scimUser.userName,
      jobTitle: scimUser.title,
      status: scimUser.active === false ? UserStatus.INACTIVE : UserStatus.ACTIVE,
    };

    // Enterprise extension fields
    if (enterprise) {
      if (enterprise.employeeNumber) dto.employeeId = enterprise.employeeNumber;
      if (enterprise.department) dto.departmentName = enterprise.department;
      if (enterprise.division) dto.division = enterprise.division;
      if (enterprise.manager?.displayName) dto.managerEmail = enterprise.manager.displayName;
    }

    // Contact fields
    if (workPhone) dto.workPhone = workPhone;
    if (mobilePhone) dto.mobilePhone = mobilePhone;

    return dto;
  }

  // --- Private helpers ---

  private buildEnterprise(dto: StandardUserDto): SCIMEnterprise | null {
    const enterprise: SCIMEnterprise = {};
    let hasFields = false;

    if (dto.employeeId) {
      enterprise.employeeNumber = dto.employeeId;
      hasFields = true;
    }
    if (dto.departmentName || dto.departmentCode) {
      enterprise.department = dto.departmentName || dto.departmentCode;
      hasFields = true;
    }
    if (dto.division) {
      enterprise.division = dto.division;
      hasFields = true;
    }
    if (dto.managerEmail) {
      enterprise.manager = { displayName: dto.managerEmail };
      hasFields = true;
    }

    return hasFields ? enterprise : null;
  }

  private buildPhoneNumbers(
    dto: StandardUserDto,
  ): Array<{ value: string; type: string }> | undefined {
    const phones: Array<{ value: string; type: string }> = [];
    if (dto.workPhone) phones.push({ value: dto.workPhone, type: 'work' });
    if (dto.mobilePhone) phones.push({ value: dto.mobilePhone, type: 'mobile' });
    return phones.length > 0 ? phones : undefined;
  }

  private stripUndefined(obj: Record<string, unknown>): void {
    Object.keys(obj).forEach((key) => {
      if (obj[key] === undefined) {
        delete obj[key];
      }
    });
  }
}
