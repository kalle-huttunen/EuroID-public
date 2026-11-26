/**
 * OktaMapper — Pure mapping: StandardUserDto <-> Okta user profile format.
 *
 * Dumb pipe: no business logic, no HTTP, no side effects.
 * Maps Hub fields to Okta profile attributes and back.
 */

import { Injectable } from '@nestjs/common';
import { StandardUserDto } from '@shared/dtos/standard-user.dto';
import type { OktaUser, OktaUserProfile } from './okta.interface';

@Injectable()
export class OktaMapper {
  /**
   * StandardUserDto -> Okta user profile (for create/update).
   * Maps Hub fields to Okta profile attributes.
   */
  toOktaProfile(user: StandardUserDto): Record<string, unknown> {
    const profile: Record<string, unknown> = {
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      login: user.email, // Okta login = email by default
    };

    if (user.displayName) {
      profile.displayName = user.displayName;
    }

    if (user.mobilePhone) {
      profile.mobilePhone = user.mobilePhone;
    }

    if (user.jobTitle) {
      // Okta uses 'title' for job title
      profile.title = user.jobTitle;
    }

    if (user.departmentName || user.departmentCode) {
      profile.department = user.departmentName || user.departmentCode;
    }

    if (user.employeeId) {
      profile.employeeNumber = user.employeeId;
    }

    if (user.division) {
      profile.division = user.division;
    }

    if (user.city) {
      profile.city = user.city;
    }

    if (user.stateProvince) {
      profile.state = user.stateProvince;
    }

    if (user.countryCode) {
      profile.countryCode = user.countryCode;
    }

    if (user.postalCode) {
      profile.zipCode = user.postalCode;
    }

    if (user.officeName || user.officeLocation || user.location) {
      profile.streetAddress = user.officeName ?? user.officeLocation ?? user.location;
    }

    if (user.managerEmail) {
      profile.manager = user.managerEmail;
    }

    if (user.costCenter) {
      profile.costCenter = user.costCenter;
    }

    // Remove undefined fields to keep payload clean
    Object.keys(profile).forEach((key) => {
      if (profile[key] === undefined || profile[key] === null) {
        delete profile[key];
      }
    });

    return profile;
  }

  /**
   * Okta user profile -> Partial StandardUserDto (for reconciliation / readback).
   */
  fromOktaUser(oktaUser: OktaUser): Partial<StandardUserDto> {
    const p: OktaUserProfile = oktaUser.profile;
    return {
      firstName: p.firstName,
      lastName: p.lastName,
      email: p.email,
      displayName: p.displayName,
      mobilePhone: p.mobilePhone,
      jobTitle: p.title,
      departmentName: p.department,
      employeeId: p.employeeNumber,
    };
  }

  /**
   * StandardUserDto -> Okta update payload (only changed fields).
   * Returns a profile object for PATCH-style updates.
   */
  toOktaUpdatePayload(user: StandardUserDto): Record<string, unknown> {
    // Same as toOktaProfile — Okta merges partial updates
    return this.toOktaProfile(user);
  }
}
