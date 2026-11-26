/**
 * Standard User types - re-exported from generated API types.
 * Source: swagger-spec.json -> StandardUserDto
 * Run `npm run generate:api` to regenerate when backend DTOs change.
 */

import type { components } from "../generated/api.types";

export type StandardUserDto = components["schemas"]["StandardUserDto"];
/** Extracted from StandardUserDto.contracts[] since the backend schema inlines it. */
export type EmploymentContractDto = NonNullable<StandardUserDto["contracts"]>[number];

/** Alias for backward compatibility */
export type IStandardUser = StandardUserDto;

/** Alias for backward compatibility */
export type IEmploymentContract = EmploymentContractDto;

/** User status - const object for enum-like usage (UserStatus.ACTIVE) */
export const UserStatus = {
  ACTIVE: "ACTIVE",
  INACTIVE: "INACTIVE",
  PENDING: "PENDING",
  SUSPENDED: "SUSPENDED",
  TERMINATED: "TERMINATED",
  DELETED: "DELETED",
  GUEST: "GUEST",
} as const;
export type UserStatus = (typeof UserStatus)[keyof typeof UserStatus];

/** Employment type */
export const EmploymentType = {
  FULL_TIME: "FULL_TIME",
  PART_TIME: "PART_TIME",
  CONTRACTOR: "CONTRACTOR",
  INTERN: "INTERN",
  CONSULTANT: "CONSULTANT",
  SERVICE_ACCOUNT: "SERVICE_ACCOUNT",
  ADMIN_ACCOUNT: "ADMIN_ACCOUNT",
} as const;
export type EmploymentType = (typeof EmploymentType)[keyof typeof EmploymentType];

/** User priority */
export const UserPriority = {
  VIP: "VIP",
  STANDARD: "STANDARD",
  SERVICE_ACCOUNT: "SERVICE_ACCOUNT",
} as const;
export type UserPriority = (typeof UserPriority)[keyof typeof UserPriority];

/** Contract lifecycle (multi-contract / persona support) */
export const ContractStatus = {
  ACTIVE: "ACTIVE",
  TERMINATED: "TERMINATED",
} as const;
export type ContractStatus = (typeof ContractStatus)[keyof typeof ContractStatus];
