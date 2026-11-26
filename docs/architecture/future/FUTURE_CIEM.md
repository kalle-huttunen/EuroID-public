# FUTURE: Cloud Infrastructure Entitlement Management (CIEM)

> **Status:** Not implemented. Architecture draft for future development.

## Overview

Cloud Infrastructure Entitlement Management (CIEM) extends EuroID's governance to **cloud-native permissions** — AWS IAM policies, Azure RBAC role assignments, and GCP IAM bindings. Cloud permissions are fundamentally different from SaaS entitlements: they are fine-grained (thousands of individual actions), deeply nested (policies → roles → groups → users), and over-provisioning is the #1 cloud security risk.

---

## Problem Statement

- EuroID governs SaaS entitlements (Entra groups, AD groups, SCIM roles) but not cloud IAM
- Cloud permissions are 10-100x more granular than SaaS entitlements (AWS has 15,000+ IAM actions)
- Over-permissioned cloud identities are the primary attack vector for cloud breaches
- No visibility into effective permissions (what can this identity actually do in AWS/Azure/GCP?)
- No detection of unused permissions (identity has S3 admin but never accessed S3)
- Compliance frameworks increasingly require cloud entitlement governance

---

## Proposed Architecture

### Component Overview

| Component | Path (Proposed) | Responsibility |
|-----------|-----------------|----------------|
| CiemModule | `modules/ciem/ciem.module.ts` | NestJS module registration |
| CloudPermissionDiscoveryService | `modules/ciem/cloud-permission-discovery.service.ts` | Discover IAM policies, roles, bindings from cloud providers |
| EffectivePermissionService | `modules/ciem/effective-permission.service.ts` | Resolve transitive permissions (policy → role → group → user) |
| PermissionUsageService | `modules/ciem/permission-usage.service.ts` | Analyze CloudTrail/Activity Log for actual usage |
| OverPermissionDetectionService | `modules/ciem/over-permission-detection.service.ts` | Compare effective vs used permissions |
| CiemController | `modules/ciem/ciem.controller.ts` | REST API for cloud entitlement views |

### Cloud Provider Connectors (Extensions)

| Provider | Discovery Source | Usage Source | Connector |
|----------|-----------------|--------------|-----------|
| **AWS** | IAM API (ListUsers, ListPolicies, GetPolicy) | CloudTrail (last 90 days) | `aws-iam-connector/` |
| **Azure** | Azure Resource Manager (role assignments, role definitions) | Azure Activity Log | Extend existing `entra-connector/` |
| **GCP** | Cloud Resource Manager (IAM bindings) | Cloud Audit Log | `gcp-iam-connector/` |

---

## Data Model

### Cloud Permission Schema

```typescript
// Collection: cloud_permissions
{
  tenantId: string,
  identityId: string,                 // Link to EuroID Identity Hub
  provider: 'AWS' | 'AZURE' | 'GCP',
  accountId: string,                  // AWS account, Azure subscription, GCP project

  // Effective permissions (resolved)
  effectivePermissions: [{
    service: string,                  // e.g., 's3', 'ec2', 'iam'
    actions: string[],                // e.g., ['s3:GetObject', 's3:PutObject']
    resources: string[],              // e.g., ['arn:aws:s3:::my-bucket/*']
    effect: 'ALLOW' | 'DENY',
    source: {                         // How they got this permission
      type: 'DIRECT' | 'GROUP' | 'ROLE' | 'POLICY',
      name: string,                   // e.g., 'AmazonS3FullAccess'
      path: string[],                 // e.g., ['user', 'group:developers', 'policy:S3Full']
    },
  }],

  // Usage analysis
  usedPermissions: [{
    service: string,
    action: string,
    lastUsed: Date,
    usageCount: number,               // In analysis window
  }],

  // Over-permission analysis
  overPermissionScore: number,         // 0-100 (higher = more over-permissioned)
  unusedPermissions: [{
    service: string,
    action: string,
    grantedVia: string,               // Policy/role name
    unusedDays: number,
  }],

  analyzedAt: Date,
}
```

### Cloud Entitlement in Catalog

```typescript
// Extension to existing EntitlementCatalog
{
  type: 'CloudPermission',            // New entitlement type alongside 'Group', 'License'
  cloudProvider: 'AWS' | 'AZURE' | 'GCP',
  cloudResource: {
    policyArn?: string,               // AWS
    roleDefinitionId?: string,        // Azure
    roleId?: string,                  // GCP
  },
  permissionCount: number,            // How many individual actions this grants
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL',  // Based on permission sensitivity
}
```

---

## Analysis Workflow

```
Temporal CronWorkflow (weekly or on-demand)
        │
        ▼
  Phase 1: Discovery
    ├── AWS: ListUsers → ListAttachedUserPolicies → GetPolicy (for each)
    ├── Azure: ListRoleAssignments → GetRoleDefinition (for each)
    └── GCP: GetIamPolicy → GetRole (for each)
        │
        ▼
  Phase 2: Permission Resolution
    ├── Resolve transitive group memberships
    ├── Evaluate policy conditions (date/time, IP, MFA)
    ├── Merge ALLOW/DENY into effective permission set
    └── Map cloud identities to EuroID identities (by email or externalId)
        │
        ▼
  Phase 3: Usage Analysis
    ├── AWS: Query CloudTrail (last 90 days) for each identity
    ├── Azure: Query Activity Log
    └── GCP: Query Cloud Audit Log
        │
        ▼
  Phase 4: Over-Permission Detection
    ├── Compare effective permissions vs used permissions
    ├── Flag unused high-risk permissions (IAM admin, KMS, etc.)
    ├── Calculate over-permission score (0-100)
    └── Generate right-sizing recommendations
        │
        ▼
  Phase 5: Integration
    ├── Update cloud_permissions collection
    ├── Feed over-permission score into RiskScoringService
    ├── Create policy suggestions for least-privilege policies
    └── Emit CIEM_ANALYSIS_COMPLETED event
```

---

## Risk Integration

Over-permission score feeds into existing risk scoring as a new factor:

| Factor | Weight | Input | Normalization |
|--------|--------|-------|---------------|
| Cloud over-permission | 15% | `overPermissionScore` from CIEM analysis | Direct (already 0-100) |

This would be the 7th (or 8th with peer deviation) risk factor.

---

## API Endpoints (Proposed)

| Method | Path | Role | Description |
|--------|------|------|-------------|
| `GET` | `/api/v1/ciem/overview` | policy-admin | Dashboard: total identities, avg over-permission score |
| `GET` | `/api/v1/ciem/identities` | policy-admin | List identities with cloud permissions (paginated, sortable by score) |
| `GET` | `/api/v1/ciem/identities/:id` | policy-admin | Detailed cloud permissions for one identity |
| `GET` | `/api/v1/ciem/identities/:id/unused` | policy-admin | Unused permissions with right-sizing suggestions |
| `POST` | `/api/v1/ciem/analyze` | super-admin | Trigger CIEM analysis |
| `GET` | `/api/v1/ciem/recommendations` | policy-admin | Right-sizing recommendations across all identities |

---

## Phased Rollout

| Phase | Scope | Complexity |
|-------|-------|------------|
| **Phase 1** | AWS IAM connector + permission discovery | Medium |
| **Phase 2** | CloudTrail usage analysis + over-permission detection | High |
| **Phase 3** | Azure RBAC integration (extend Entra connector) | Medium |
| **Phase 4** | Right-sizing recommendations + policy suggestions | Medium |
| **Phase 5** | GCP IAM + cross-cloud unified view | Medium |
| **Phase 6** | Automated remediation (remove unused permissions via workflow) | High |

---

## Prerequisites

- AWS IAM connector (new — `modules/connectors/aws-iam-connector/`)
- AWS CloudTrail access (read-only IAM role in customer account)
- Identity correlation: map AWS IAM users/roles to EuroID identities

---

## Implementation Checklist

**Phase 1 — AWS IAM Discovery**
- [ ] Create `aws-iam-connector/` module (discovery service for ListUsers, ListPolicies, GetPolicy)
- [ ] Create `cloud_permissions` schema and `CloudPermissionDiscoveryService`

**Phase 2 — Permission Resolution & Usage Analysis**
- [ ] Implement `EffectivePermissionService` (resolve transitive group/role/policy permissions)
- [ ] Implement `PermissionUsageService` (query CloudTrail for actual usage per identity)
- [ ] Map cloud identities to EuroID identities (by email or externalId)

**Phase 3 — Over-Permission Detection**
- [ ] Implement `OverPermissionDetectionService` (compare effective vs used permissions, compute score 0-100)
- [ ] Integrate over-permission score into `RiskScoringService` as new risk factor

**Phase 4 — API & Workflow**
- [ ] Create `CiemController` with proposed API endpoints (overview, identities, unused, recommendations)
- [ ] Create weekly Temporal CronWorkflow (discovery, resolution, usage analysis, detection, integration)
- [ ] Extend Entitlement Catalog with `CloudPermission` type

**Phase 5 — Multi-Cloud & Remediation**
- [ ] Extend Entra connector for Azure RBAC integration
- [ ] Create `gcp-iam-connector/` for GCP IAM bindings
- [ ] Add unit and integration tests for all CIEM services
- [ ] Update API_CHANGELOG.md and connector docs

---

## Related Docs

| Doc | Relevance |
|-----|-----------|
| `../../../backend/src/modules/risk-scoring/docs/ARCHITECTURE.md` | Over-permission score as risk factor |
| `../../../backend/src/modules/connectors/docs/ARCHITECTURE.md` | New connector type for cloud IAM |
| `../../../backend/src/modules/policy/docs/ARCHITECTURE.md` | Right-sizing recommendations feed policy suggestions |
| `FUTURE_AI_ACCESS_INTELLIGENCE.md` | ML-based over-permission pattern detection |
