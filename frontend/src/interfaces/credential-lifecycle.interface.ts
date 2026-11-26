/**
 * Credential lifecycle (backend `modules/credential-lifecycle`, `/credential-lifecycle` routes).
 * Inventory rows are written by the nightly credential rotation run, which reads each account
 * EuroID provisioned in Entra ID or AD; policies are documents of `credential_policies`. The
 * swagger spec types these responses as unknown, so they are written out here from the schemas.
 */

export type CredentialStatus = 'COMPLIANT' | 'EXPIRING_SOON' | 'EXPIRED' | 'UNKNOWN';

/** One identity's account in one system (`credential_inventory`, unique per identity and system). */
export interface ICredentialRecord {
  _id: string;
  tenantId: string;
  /** The identity's `_id`. */
  identityId: string;
  /** `entra-id` or `ad` from the nightly run. */
  targetSystem: string;
  /** The account id in the system (Entra object id, AD distinguished name); '' when none is known. */
  externalId: string;
  password?: {
    /** The target's last password change. */
    lastRotated?: string;
    /** When the password is due under the policy that applies. */
    nextRotation?: string;
    status: CredentialStatus;
    rotationCount?: number;
    /** Why the status is UNKNOWN; absent otherwise. */
    statusReason?: string;
  };
  /** Entra ID only: MFA methods registered. */
  mfa?: { enrolled: boolean; methods: string[]; lastVerified?: string };
  /** When the nightly run last read the account. */
  observedAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

/** GET /credential-lifecycle/compliance: rows per password status. */
export interface ICredentialCompliance {
  compliant: number;
  expiringSoon: number;
  expired: number;
  unknown: number;
  total: number;
}

export interface ICredentialPolicy {
  /** ObjectId string; PATCH and DELETE /policies/:id take it. */
  _id: string;
  tenantId: string;
  name: string;
  description?: string;
  /** Empty or absent lists match every system and every employment type. */
  targetScope?: {
    connectorTypes?: string[];
    employmentTypes?: string[];
    entitlementTiers?: number[];
  };
  passwordPolicy?: {
    maxAgeDays: number;
    minLength: number;
    requireComplexity: boolean;
    preventReuse: number;
  };
  rotationPolicy?: {
    enabled: boolean;
    intervalDays: number;
    notifyDaysBefore: number;
    vaultStorage: boolean;
  };
  mfaRequirement?: { required: boolean; methods: string[]; gracePeriodDays: number };
  isActive: boolean;
  createdAt?: string;
  updatedAt?: string;
}

/** POST /policies (name required) and PATCH /policies/:id (any subset). */
export interface ICredentialPolicyBody {
  name?: string;
  description?: string;
  targetScope?: ICredentialPolicy['targetScope'];
  /** A sent object replaces the stored one; the API fills the settings left out with defaults. */
  passwordPolicy?: Partial<NonNullable<ICredentialPolicy['passwordPolicy']>>;
  rotationPolicy?: Partial<NonNullable<ICredentialPolicy['rotationPolicy']>>;
  isActive?: boolean;
}
