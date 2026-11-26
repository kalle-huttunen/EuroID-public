# FUTURE: Identity Verification & Proofing

> **Status:** Not implemented. Architecture draft for future development.

## Overview

EuroID currently trusts HR data implicitly — if Workday says "John Doe is a new employee," the system onboards them. Identity verification adds an **out-of-band proofing layer** for high-assurance scenarios: regulated industries, privileged account creation, external contractor onboarding, and break-glass access. This integrates with external identity verification providers (Onfido, Jumio, Persona, Microsoft Entra Verified ID) to validate that a person is who they claim to be.

---

## Problem Statement

- No verification that the person behind an HR record is who they claim to be
- PAM accounts (Tier 0/1) are created based solely on HR data + policy engine output
- External contractors may be onboarded without any identity proofing
- Break-glass access has no step-up verification
- Compliance (NIST SP 800-63-3) requires Identity Assurance Level (IAL) 2+ for privileged systems
- No verifiable credential support (W3C VC, mDL) for emerging digital identity standards

---

## Use Cases

| Trigger | Verification Required | Assurance Level |
|---------|----------------------|-----------------|
| New employee onboarding (standard) | None (HR-trusted) | IAL1 |
| External contractor onboarding | Document + liveness | IAL2 |
| Tier 0 admin account creation | Document + liveness + manager attestation | IAL2+ |
| Break-glass access | Step-up re-verification (biometric) | IAL2 |
| Access to regulated systems (HIPAA, PCI) | Periodic re-verification (annual) | IAL2 |
| Verifiable credential presentation | Verify VC signature + issuer trust | IAL2-3 |

---

## Proposed Architecture

### Component Overview

| Component | Path (Proposed) | Responsibility |
|-----------|-----------------|----------------|
| IdentityVerificationService | `modules/identity-verification/identity-verification.service.ts` | Orchestrate verification workflows |
| VerificationProviderAdapter | `modules/identity-verification/adapters/` | Provider-specific implementations |
| VerificationPolicyService | `modules/identity-verification/verification-policy.service.ts` | Determine when verification is required |
| identityVerificationWorkflow | `workflows/identity-verification.workflow.ts` | Temporal workflow: initiate → wait for result → record |
| IdentityVerification schema | `modules/identity-verification/schemas/identity-verification.schema.ts` | Verification state persistence |

### Verification Flow

```
Policy Engine evaluates identity
        │
        ▼
VerificationPolicyService: Is verification required?
  (Based on: employment type, entitlement tier, compliance zone)
        │
        ├── NO → Continue normal provisioning
        │
        └── YES → Start identityVerificationWorkflow
                    │
                    ▼
              Create verification request
              Send link to identity (email/SMS)
                    │
                    ▼
              User opens verification portal
                ├── Upload document (passport, ID card)
                ├── Liveness check (selfie vs document)
                └── Optional: manager attestation
                    │
                    ▼
              Provider callback (webhook)
                ├── VERIFIED → Record IAL, continue provisioning
                ├── FAILED → Flag for manual review
                └── INCONCLUSIVE → Retry or escalate
```

---

## Verification Schema

```typescript
// Collection: identity_verifications
{
  tenantId: string,
  identityId: string,
  trigger: 'ONBOARDING' | 'PRIVILEGED_ACCESS' | 'BREAK_GLASS' | 'PERIODIC' | 'MANUAL',

  status: 'PENDING' | 'IN_PROGRESS' | 'VERIFIED' | 'FAILED' | 'EXPIRED',
  assuranceLevel: 'IAL1' | 'IAL2' | 'IAL3',

  provider: 'ONFIDO' | 'JUMIO' | 'PERSONA' | 'ENTRA_VERIFIED_ID' | 'MANUAL',
  providerSessionId: string,          // External session reference

  checks: [{
    type: 'DOCUMENT' | 'LIVENESS' | 'MANAGER_ATTESTATION' | 'VERIFIABLE_CREDENTIAL',
    status: 'PASSED' | 'FAILED' | 'PENDING',
    completedAt?: Date,
    details?: Record<string, unknown>, // Provider-specific result (no PII stored)
  }],

  verifiedAt?: Date,
  expiresAt?: Date,                    // Verification validity period
  workflowId: string,                 // Temporal workflow ID

  createdAt: Date,
}
```

---

## Provider Adapter Interface

```typescript
interface IVerificationProvider {
  readonly providerId: string;

  // Initiate verification session
  createSession(identity: {
    firstName: string;
    lastName: string;
    email: string;
    dateOfBirth?: string;
  }): Promise<{ sessionId: string; verificationUrl: string }>;

  // Check session status (polling or webhook-driven)
  getSessionStatus(sessionId: string): Promise<{
    status: 'PENDING' | 'COMPLETE' | 'FAILED';
    checks: CheckResult[];
    assuranceLevel?: 'IAL1' | 'IAL2' | 'IAL3';
  }>;

  // Webhook handler for async results
  handleWebhook(payload: unknown, signature: string): Promise<VerificationEvent>;
}
```

---

## Integration with Existing Systems

| System | Integration |
|--------|-------------|
| **Onboarding workflow** | Insert verification step before provisioning for configured employment types |
| **PAM** | Tier 0 admin account creation blocked until IAL2 verification passes |
| **Access requests** | Configurable per-entitlement: `requiresVerification: true` |
| **Break-glass** | After emergency token use, require re-verification within 24h |
| **Risk scoring** | Verification status as risk factor (unverified = higher risk) |
| **Identity schema** | Add `verificationStatus` and `assuranceLevel` to Identity metadata |

---

## GDPR & Privacy

- **Document images:** NOT stored in EuroID — remain with verification provider
- **Biometric data:** NOT stored — liveness check results are boolean only
- **Consent:** Verification requires explicit consent (integrate with existing consent management)
- **Data minimization:** Only store verification outcome (PASSED/FAILED + IAL level), not raw evidence
- **Provider DPA:** Verification providers must have GDPR-compliant Data Processing Agreements

---

## Implementation Checklist

- [ ] Create `identity_verifications` schema and `IdentityVerificationService` (orchestrate verification workflows)
- [ ] Create `VerificationPolicyService` (determine when verification is required based on employment type, entitlement tier, compliance zone)
- [ ] Implement `IVerificationProvider` adapter interface (createSession, getSessionStatus, handleWebhook)
- [ ] Implement at least one provider adapter (e.g., Onfido or Entra Verified ID)
- [ ] Create `identityVerificationWorkflow` Temporal workflow (initiate, wait for result, record outcome)
- [ ] Add `verificationStatus` and `assuranceLevel` fields to Identity metadata schema
- [ ] Integrate verification step into onboarding workflow and PAM Tier 0 account creation
- [ ] Implement GDPR data minimization: store only verification outcome (PASSED/FAILED + IAL), no raw evidence or biometric data
- [ ] Add unit and integration tests for verification service, policy evaluation, provider adapters, and workflow
- [ ] Update API_CHANGELOG.md and backend README inventory

---

## Related Docs

| Doc | Relevance |
|-----|-----------|
| `../../../backend/src/modules/privileged-access/docs/ARCHITECTURE.md` | PAM accounts require verification |
| `../../../backend/src/modules/access-requests/docs/ARCHITECTURE.md` | Verification as approval step |
| `../../../backend/src/modules/compliance-reporting/docs/GDPR_COMPLIANCE.md` | Consent and data minimization for biometric data |
| `../infrastructure/TEMPORAL_WORKFLOWS.md` | Verification workflow pattern |
