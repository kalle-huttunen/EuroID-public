/**
 * ICredentialManagement — optional interface for connectors that read credential state.
 *
 * Connectors are still "dumb pipes": they read a target account's credential state (last
 * password change, account status, MFA methods) for the nightly credential run's inventory
 * (activities/credential-inventory-refresh.ts). No connector resets a password: EuroID has no
 * secret storage to hand a generated password to, and a person's password is never reset
 * automatically.
 */

/** Credential state read from a target system (password age, account status). */
export interface CredentialState {
  passwordLastSet?: Date;
  passwordNeverExpires?: boolean;
  accountEnabled?: boolean;
}

/** MFA enrollment status from a target system. */
export interface MfaStatus {
  enrolled: boolean;
  methods: string[];
}

/**
 * Optional credential state reads. Connectors advertise this via the 'credentialManagement'
 * capability in their manifest.
 */
export interface ICredentialManagement {
  /** Read credential state from target system (password age, expiry, account status). */
  getCredentialState(externalId: string): Promise<CredentialState>;

  /** Read MFA enrollment status from target system (optional). */
  getMfaStatus?(externalId: string): Promise<MfaStatus>;
}
