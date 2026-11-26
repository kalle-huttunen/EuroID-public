import { StandardUserDto } from '@shared/dtos/standard-user.dto';
import { ProvisioningResult } from '@shared/dtos/provisioning-result.dto';

// Re-export connector-agnostic types from shared for backwards compatibility.
// New code should import directly from '@shared/interfaces/provisioning.interface'.
export type {
  TargetAccount,
  ProvisioningIntent,
  Entitlement,
  EntitlementOrigin,
  EntitlementGovernanceLevel,
} from '@shared/interfaces/provisioning.interface';
import type {
  TargetAccount,
  ProvisioningIntent,
  Entitlement,
} from '@shared/interfaces/provisioning.interface';

/**
 * UPN generation patterns. Order determines priority when resolving available UPN.
 */
export type UpnPattern =
  | 'firstname.lastname'
  | 'firstname.middleinitial.lastname'
  | 'firstname.lastname{n}'
  | 'firstnamelastname'
  | 'firstname_lastname'
  | 'flastname';

/** Default pattern order for UPN resolution */
export const DEFAULT_UPN_PATTERNS: UpnPattern[] = [
  'firstname.lastname',
  'firstname.middleinitial.lastname',
  'firstname.lastname{n}',
];

/**
 * Runtime configuration for Entra ID connector
 * This allows overriding .env values with Blueprint-saved credentials
 */
export interface EntraConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  /** M365-verified domain (e.g., example.com). Required for UPN generation. */
  defaultDomain?: string;
  defaultLicense?: string;
  usageLocation?: string;
  /** UPN generation pattern order. First available candidate is used. */
  upnPatterns?: UpnPattern[];
}

export interface IEntraConnector {
  // --- HEALTH & DISCOVERY ---

  /**
   * Check connection to Entra ID
   * @param config - Optional runtime config to override .env values
   */
  checkConnection(config?: EntraConfig): Promise<boolean>;

  /** * Scans the tenant for Groups and Licenses (The "Menu" for the Policy Engine)
   * @param config - Optional runtime config to override .env values
   */
  discoverEntitlements(config?: EntraConfig): Promise<Entitlement[]>;

  // --- PROVISIONING ---
  checkUserExists(upn: string): Promise<string | null>;

  /**
   * Resolve an available UPN for a new user. Generates candidates, checks each against Entra,
   * returns the first available. Throws UpnExhaustedError if all are taken.
   */
  resolveAvailableUpn(
    user: StandardUserDto,
    config?: EntraConfig,
  ): Promise<{ chosenUpn: string; candidatesChecked: string[] }>;

  /**
   * The Main 2026 Entry Point:
   * Creates the user AND executes all policy intents (groups/licenses) in one go.
   * Returns ProvisioningResult with generatedAttributes (mail, UPN) when creating a new user.
   * Entra ID can generate work email — Jira, Slack, etc. cannot.
   *
   * @param user - The standardized user object
   * @param intent - Optional provisioning intent (groups/licenses)
   * @param config - Optional runtime config to override .env values
   */
  provision(
    user: StandardUserDto,
    intent?: ProvisioningIntent,
    config?: EntraConfig,
  ): Promise<ProvisioningResult>;

  /**
   * List users from Entra ID (for orphan detection / reconciliation).
   * Supports pagination: pass nextLink from previous response for next page.
   */
  listUsers(
    options?: { top?: number; nextLink?: string },
    config?: EntraConfig,
  ): Promise<{
    users: TargetAccount[];
    nextLink?: string;
  }>;
}
export interface EntraUserDto {
  userPrincipalName: string;
  displayName: string;
  givenName: string;
  surname: string;
  mailNickname: string;
  accountEnabled: boolean;

  // Employment fields
  jobTitle?: string;
  department?: string;
  employeeId?: string;
  companyName?: string;

  // Contact fields
  mobilePhone?: string;
  businessPhones?: string[];

  // Location fields
  officeLocation?: string;
  city?: string;
  state?: string;
  country?: string;
  postalCode?: string;
  usageLocation?: string;

  // Password (required for new users)
  passwordProfile?: {
    forceChangePasswordNextSignIn: boolean;
    password: string;
  };
}
