/**
 * StandardUserDto - The Golden Record Contract (2026 Edition)
 *
 * This is the universal user schema for the Identity Hub.
 * All inbound HR systems normalize to this format (Step B).
 * All outbound connectors receive this format (Step D).
 *
 * ARCHITECTURE PRINCIPLES:
 * 1. IMMUTABLE IDENTIFIERS: sourceSystem + sourceUserId = unique key
 * 2. EXTENSIBILITY: customAttributes for org-specific fields
 * 3. PRIVACY-AWARE: Fields tagged as PII for compliance
 * 4. AUDIT TRAIL: Who changed what and when
 * 5. VERSIONING: Schema version for migrations
 */

import { createZodDto } from '@anatine/zod-nestjs';
import { z } from 'zod';

// ========================================
// ENUMS
// ========================================

export enum UserStatus {
  ACTIVE = 'ACTIVE',
  INACTIVE = 'INACTIVE',
  PENDING = 'PENDING',
  SUSPENDED = 'SUSPENDED',
  TERMINATED = 'TERMINATED',
  DELETED = 'DELETED',
  GUEST = 'GUEST',
}

export enum EmploymentType {
  FULL_TIME = 'FULL_TIME',
  PART_TIME = 'PART_TIME',
  CONTRACTOR = 'CONTRACTOR',
  INTERN = 'INTERN',
  CONSULTANT = 'CONSULTANT',
  SERVICE_ACCOUNT = 'SERVICE_ACCOUNT',
  ADMIN_ACCOUNT = 'ADMIN_ACCOUNT',
}

export enum UserPriority {
  VIP = 'VIP',
  STANDARD = 'STANDARD',
  SERVICE_ACCOUNT = 'SERVICE_ACCOUNT',
}

export enum ContractStatus {
  ACTIVE = 'ACTIVE',
  TERMINATED = 'TERMINATED',
}

// ========================================
// EMPLOYMENT CONTRACT (Multi-Persona)
// ========================================

export const EmploymentContractSchema = z.object({
  id: z.string(),
  title: z.string(),
  department: z.string(),
  isPrimary: z.boolean().default(false),
  status: z.enum(['ACTIVE', 'TERMINATED']),
});

export type EmploymentContract = z.infer<typeof EmploymentContractSchema>;
export class EmploymentContractDto extends createZodDto(EmploymentContractSchema) {}

// ========================================
// CORE SCHEMA
// ========================================

const userStatusEnum = z.nativeEnum(UserStatus);
const userPriorityEnum = z.nativeEnum(UserPriority);
const employmentTypeEnum = z.nativeEnum(EmploymentType);

export const StandardUserSchema = z.object({
  sourceSystem: z.string().min(1),
  sourceUserId: z.string().min(1),
  contractType: z.enum(['primary', 'secondary']).optional(),
  tenantId: z.string().min(1),
  firstName: z.string().min(1).max(200),
  middleName: z.string().max(200).optional(),
  lastName: z.string().min(1).max(200),
  preferredName: z.string().max(200).optional(),
  displayName: z.string().max(200).optional(),
  // Stored and compared trimmed and lower-cased (shared/utils/email.ts)
  email: z.string().trim().toLowerCase().email().max(320),
  personalEmail: z.string().email().max(320).optional(),
  mobilePhone: z.string().max(50).optional(),
  workPhone: z.string().max(50).optional(),
  officeExtension: z.string().max(20).optional(),
  contracts: z.array(EmploymentContractSchema).max(50).optional(),
  jobTitle: z.string().max(200).optional(),
  departmentCode: z.string().max(200).optional(),
  departmentName: z.string().max(200).optional(),
  division: z.string().max(200).optional(),
  costCenter: z.string().max(200).optional(),
  employeeId: z.string().max(200).optional(),
  employmentType: employmentTypeEnum.optional(),
  managerEmail: z.string().email().max(320).optional(),
  managerId: z.string().max(200).optional(),
  startDate: z.coerce.date().optional(),
  endDate: z.coerce.date().optional(),
  location: z.string().max(200).optional(),
  officeName: z.string().max(200).optional(),
  officeLocation: z.string().max(200).optional(),
  countryCode: z.string().max(3).optional(),
  stateProvince: z.string().max(200).optional(),
  city: z.string().max(200).optional(),
  address: z.string().max(200).optional(),
  postalCode: z.string().max(200).optional(),
  timezone: z.string().max(100).optional(),
  status: userStatusEnum,
  priority: userPriorityEnum.optional(),
  userPrincipalName: z.string().max(200).optional(),
  samAccountName: z.string().max(200).optional(),
  employeeNumber: z.string().max(200).optional(),
  correlationId: z.string().max(200).optional(),
  requiresBackgroundCheck: z.boolean().optional(),
  backgroundCheckCompleted: z.boolean().optional(),
  securityClearance: z.string().max(200).optional(),
  dataClassification: z.string().max(200).optional(),
  customAttributes: z
    .record(z.string().max(100), z.union([z.string().max(1000), z.number(), z.boolean()]))
    .optional()
    .refine((val) => val === undefined || Object.keys(val).length <= 50, {
      message: 'customAttributes cannot exceed 50 keys (IV-7)',
    }),
  tags: z.array(z.string().max(200)).max(50).optional(),
  createdAt: z.coerce.date().optional(),
  updatedAt: z.coerce.date().optional(),
  createdBy: z.string().optional(),
  updatedBy: z.string().optional(),
  schemaVersion: z.string().optional(),
  _id: z.string().optional(),
  __v: z.number().optional(),
});

export type StandardUserDtoType = z.infer<typeof StandardUserSchema>;
export class StandardUserDto extends createZodDto(StandardUserSchema) {}

// ========================================
// MINIMAL USER
// ========================================

export const MinimalUserSchema = z.object({
  sourceUserId: z.string(),
  email: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  status: userStatusEnum,
});

export class MinimalUserDto extends createZodDto(MinimalUserSchema) {}

// ========================================
// HELPER TYPES
// ========================================

export interface UserChangeDelta {
  field: string;
  oldValue: unknown;
  newValue: unknown;
  changedAt: Date;
  changedBy: string;
}
