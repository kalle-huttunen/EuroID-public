/**
 * User display and formatting helpers.
 * Works with StandardUserDto (generated) and IStandardUser (legacy alias).
 */

import type { components } from "../generated/api.types";

export type StandardUser = components["schemas"]["StandardUserDto"];
export type UserStatus = StandardUser["status"];
export type EmploymentType = NonNullable<StandardUser["employmentType"]>;

/** User display name helper */
export const getUserDisplayName = (user: StandardUser): string => {
  if (user.displayName) return user.displayName;
  if (user.preferredName) return `${user.preferredName} ${user.lastName}`;
  return `${user.firstName} ${user.lastName}`;
};

/** User status color helper (for badges) */
export const getUserStatusColor = (status: UserStatus): string => {
  const colorMap: Record<string, string> = {
    ACTIVE: "green",
    INACTIVE: "default",
    PENDING: "blue",
    SUSPENDED: "orange",
    TERMINATED: "red",
    DELETED: "red",
    GUEST: "purple",
  };
  return colorMap[status] || "default";
};

/** Employment type display helper */
export const getEmploymentTypeLabel = (type?: string): string => {
  if (!type) return "Unknown";
  const labelMap: Record<string, string> = {
    FULL_TIME: "Full-Time",
    PART_TIME: "Part-Time",
    CONTRACTOR: "Contractor",
    INTERN: "Intern",
    CONSULTANT: "Consultant",
    SERVICE_ACCOUNT: "Service Account",
    ADMIN_ACCOUNT: "Admin Account",
  };
  return labelMap[type] || type;
};
