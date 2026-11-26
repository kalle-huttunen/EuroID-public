# FUTURE: Credential Lifecycle Management

> **Status:** Partially implemented. Built: `backend/src/modules/credential-lifecycle/` (credential policies and inventory,
> `/api/v1/credential-lifecycle/*`) and the nightly `credentialRotationWorkflow` (`backend/src/workflows/credential-rotation.workflow.ts`),
> which reads password state from Entra ID and AD (MFA methods from Entra ID) and reports due credentials. It resets no password, and no vault
> is built. See `backend/src/modules/credential-lifecycle/docs/ARCHITECTURE.md`. The rest of this file is the original draft.

## Overview

EuroID governs **who has access to what** (entitlements) but not **how they authenticate** (credentials). A credential lifecycle management layer would govern password policies, credential rotation, passkey inventory, certificate management, and credential vaulting for managed accounts — closing the gap between identity governance and credential security.

---

## Problem Statement

- Connectors provision user accounts but do not manage the credentials for those accounts
- No password rotation enforcement for managed accounts (admin accounts, service accounts)
- No visibility into credential state (password age, MFA registration, passkey count)
- PAM module creates linked admin accounts but cannot rotate their credentials
- Service account credentials (API keys, SCIM tokens) have no automatic rotation
- Certificate-based mTLS connections are manually managed

---

## Proposed Architecture

### Component Overview

| Component | Path (Proposed) | Responsibility |
|-----------|-----------------|----------------|
| CredentialPolicyService | `modules/credential-lifecycle/credential-policy.service.ts` | CRUD for credential policies (rotation interval, complexity, MFA requirements) |
| CredentialRotationService | `modules/credential-lifecycle/credential-rotation.service.ts` | Orchestrate password/key rotation via connectors |
| CredentialInventoryService | `modules/credential-lifecycle/credential-inventory.service.ts` | Track credential state per identity (password age, MFA methods, passkeys) |
| CredentialVaultAdapter | `modules/credential-lifecycle/vault-adapter.service.ts` | Interface to HashiCorp Vault / AWS Secrets Manager |
| credentialRotationWorkflow | `workflows/credential-rotation.workflow.ts` | Temporal workflow for scheduled rotation with rollback |

### Credential Types

| Type | Source | Rotation Strategy |
|------|--------|-------------------|
| **Password** | Target systems (Entra, AD) | Connector `resetPassword()` → store in vault → notify user |
| **API Key** | Service accounts (SCIM tokens) | Regenerate → update consumers → revoke old |
| **Certificate** | mTLS connections, SAML signing | CSR → sign → deploy → revoke old |
| **Passkey (FIDO2)** | End-user devices | Inventory only (user-managed); track count and last-use |
| **SSH Key** | Linux/Unix targets (future) | Generate → deploy → revoke old |

---

## Credential Policy Schema

```typescript
// Collection: credential_policies
{
  tenantId: string,
  name: string,
  targetScope: {
    connectorTypes?: string[],        // e.g., ['entra', 'ad']
    employmentTypes?: string[],       // e.g., ['ADMIN_ACCOUNT', 'SERVICE_ACCOUNT']
    entitlementTiers?: number[],      // e.g., [0, 1] for PAM accounts
  },

  passwordPolicy?: {
    maxAgeDays: number,               // Force rotation after N days
    minLength: number,
    requireComplexity: boolean,
    preventReuse: number,             // Remember last N passwords
  },

  rotationPolicy?: {
    enabled: boolean,
    intervalDays: number,             // Auto-rotate every N days
    notifyDaysBefore: number,         // Warn before forced rotation
    vaultStorage: boolean,            // Store rotated credentials in vault
  },

  mfaRequirement?: {
    required: boolean,
    methods: ('TOTP' | 'FIDO2' | 'SMS' | 'EMAIL')[],
    graceperiodDays: number,          // Days to enroll before access blocked
  },

  createdAt: Date,
  updatedAt: Date,
}
```

---

## Credential Inventory Schema

```typescript
// Collection: credential_inventory
{
  tenantId: string,
  identityId: string,
  targetSystem: string,               // e.g., 'entra', 'ad'
  externalId: string,                 // Account ID in target system

  password?: {
    lastRotated: Date,
    nextRotation: Date,
    status: 'COMPLIANT' | 'EXPIRING_SOON' | 'EXPIRED' | 'UNKNOWN',
  },

  mfa?: {
    enrolled: boolean,
    methods: string[],                // e.g., ['TOTP', 'FIDO2']
    lastVerified: Date,
  },

  passkeys?: {
    count: number,
    devices: string[],                // Device names
    lastUsed: Date,
  },

  certificates?: [{
    thumbprint: string,
    notBefore: Date,
    notAfter: Date,
    status: 'ACTIVE' | 'EXPIRING_SOON' | 'EXPIRED' | 'REVOKED',
  }],

  updatedAt: Date,
}
```

---

## Rotation Workflow

```
Temporal CronWorkflow (daily)
        │
        ▼
For each credential policy with rotation enabled:
  ┌──────────────────────────────────────────────┐
  │  1. Query credential_inventory               │
  │     WHERE nextRotation <= today               │
  │                                               │
  │  2. For each expired credential:              │
  │     a. Generate new credential                │
  │     b. Connector.resetPassword(externalId)    │
  │     c. Store new credential in vault          │
  │     d. Update credential_inventory            │
  │     e. Emit CREDENTIAL_ROTATED event          │
  │                                               │
  │  3. For credentials expiring in N days:       │
  │     a. Emit CREDENTIAL_EXPIRING_SOON          │
  │     b. Notify identity owner                  │
  └──────────────────────────────────────────────┘
```

---

## Connector Interface Extension

```typescript
// Added to ConnectorCapability
type ConnectorCapability = ... | 'credentialManagement';

// New methods on connector client (optional)
interface ICredentialManagement {
  resetPassword(externalId: string, newPassword: string): Promise<void>;
  getCredentialState(externalId: string): Promise<CredentialState>;
  getMfaStatus(externalId: string): Promise<MfaStatus>;
  listPasskeys?(externalId: string): Promise<PasskeyInfo[]>;
}
```

---

## Vault Integration

```
EuroID ──▶ VaultAdapter (interface)
                │
                ├── HashiCorpVaultAdapter  (Vault KV v2)
                ├── AwsSecretsAdapter      (AWS Secrets Manager)
                └── AzureKeyVaultAdapter   (Azure Key Vault)

Credentials stored as:
  path: euroid/{tenantId}/credentials/{identityId}/{targetSystem}
  data: { username, password, rotatedAt, previousPasswords[] }
```

---

## Security Considerations

- **Credential transit:** Passwords generated server-side, transmitted to target via TLS, never logged
- **Vault secrets:** Vault credentials stored in EuroID env vars (not MongoDB)
- **Audit:** Every rotation attempt logged as audit event with success/failure (no credential values in audit)
- **Rollback:** If target system rejects new password, workflow retries then alerts; old credential preserved
- **Zero-knowledge:** EuroID can optionally NOT store the credential (generate → push to target → discard)

---

## Implementation Checklist

- [x] Create `credential_policies` schema and `CredentialPolicyService` (CRUD for rotation/password/MFA policies)
- [x] Create `credential_inventory` schema and `CredentialInventoryService` (track credential state per identity)
- [ ] Implement `CredentialRotationService` (orchestrate password/key rotation via connectors)
- [ ] Create `VaultAdapter` interface and implement HashiCorp Vault / AWS Secrets Manager / Azure Key Vault adapters
- [ ] Extend connector interface with `ICredentialManagement` methods (resetPassword, getCredentialState, getMfaStatus)
- [ ] Create `credentialRotationWorkflow` Temporal CronWorkflow (daily: query expiring credentials, rotate, store, notify)
- [ ] Implement credential transit security (TLS-only, no logging of credential values, audit every rotation attempt)
- [ ] Add GDPR consideration: ensure vault path structure supports per-tenant isolation and erasure
- [ ] Add unit and integration tests for rotation workflow, vault adapters, and connector extensions
- [ ] Update API_CHANGELOG.md, connector docs, and backend README inventory

---

## Related Docs

| Doc | Relevance |
|-----|-----------|
| `../../../backend/src/infrastructure/secrets/docs/ARCHITECTURE.md` | Encryption at rest for stored credentials |
| `../../../backend/src/modules/privileged-access/docs/ARCHITECTURE.md` | PAM accounts are primary rotation targets |
| `../../../backend/src/modules/connectors/docs/ARCHITECTURE.md` | Connector interface extended with credential methods |
| `../infrastructure/TEMPORAL_WORKFLOWS.md` | Rotation workflow pattern |
