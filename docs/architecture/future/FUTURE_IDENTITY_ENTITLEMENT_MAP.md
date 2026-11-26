# FUTURE: Identity Entitlement Map (Visual)

> **Status:** Phase 1 and the drift actions of Phase 2 are implemented. Route `/identity/:id/map`,
> opened with **Entitlement map** on the identity page `/identities/:id`. Code:
> `frontend/src/features/identity-map/` (page `IdentityMapCanvas.tsx`, nodes in `canvas/`,
> `components/PolicyTraceModal.tsx`, `components/DriftActionPanel.tsx`, data in `hooks/`) and
> `frontend/src/api/identity-map-api.ts`. Built differently from this draft: the policy trace opens a
> modal on click (no hover tooltip), entitlements are always shown under their system (no expand),
> and an entitlement shows no risk level or approval chain. Not implemented: admin account
> activate/deactivate, entitlement revocation, countdown badges for time-bound entitlements, compare
> mode, export and the historical view. The rest of this file is the original draft; the data
> sources, the entry point and the checklist below say what is built.

## Overview

A per-identity visual map that shows everything a user has — accounts, entitlements, admin accounts, and their relationships — rendered as an interactive graph. Think of it as the Design Studio canvas, but for a single person instead of the system topology.

Today, understanding a user's full access picture requires cross-referencing Identity Hub profile, provisioning state, policy evaluation output, reconciliation drift records, and linked admin accounts. The Identity Entitlement Map consolidates this into a single visual.

---

## Problem Statement

- Admins must click through multiple screens to understand what a user has access to
- No single view shows the relationship between a primary identity, their standard accounts, and linked admin accounts
- Access review campaigns require reviewers to mentally reconstruct the "access picture" from tabular data
- Drift (actual vs desired) is only visible in the Reconciliation module, not in context of the user
- Compliance auditors ask "show me everything this person has" — currently requires manual aggregation

---

## Proposed Architecture

### Visual Layout

```
                         ┌──────────────────────────┐
                         │     Kalle Virtanen        │
                         │     IT Helpdesk           │
                         │     kalle@contoso.com     │
                         │     Status: ACTIVE        │
                         │     Risk Score: 72/100    │
                         └────────────┬──────────────┘
                                      │
                    ┌─────────────────┼──────────────────┐
                    │                 │                   │
           ┌────────▼──────┐  ┌──────▼────────┐  ┌──────▼──────────────┐
           │  Entra ID     │  │  Active Dir   │  │  Admin Account      │
           │  (Standard)   │  │  (Standard)   │  │  adm-kalle@...      │
           │  ● SYNCED     │  │  ● SYNCED     │  │  TIER_1 ● ACTIVE    │
           ├───────────────┤  ├───────────────┤  ├─────────────────────┤
           │ Groups:       │  │ Groups:       │  │ Directory Roles:    │
           │  SG-AllEmploy │  │  CN=AllEmploy │  │  User Administrator │
           │  SG-IT-Staff  │  │  CN=IT-Users  │  │  Helpdesk Admin     │
           │               │  │               │  │                     │
           │ Licenses:     │  │               │  │ Groups:             │
           │  M365 E3      │  │               │  │  SG-IT-Admins       │
           │  Power BI Pro │  │               │  │                     │
           │               │  │               │  │ Session:            │
           │ Drift: 0      │  │ Drift: 1 ⚠    │  │  Expires: 14:30    │
           └───────────────┘  └───────────────┘  └─────────────────────┘

Legend:  ● SYNCED  ○ SYNCING  ✕ ERROR  ◐ DRIFT
        Solid line = provisioned    Dashed = policy-intended but not yet provisioned
```

### Data Sources (as built)

What the map reads (`hooks/useIdentityEntitlements.ts`, fetchers in `api/identity-map-api.ts`).
Every call is a `GET` that the `viewer` role may make; the paths start with `/api/v1`.

| Data | Source | API |
|------|--------|-----|
| Identity profile and provisioning status per target | Identity Hub (Onion document) | `/identity/v2/:id`: `{ found, identity }`, the map uses `identity.profile` and `identity.provisioning[]` (PII masked). `GET /identity/:id` returns the profile only, without `provisioning[]` |
| Entitlements the identity has (granted by an active policy or access request, with status) | Identity Hub | `/identity/:id/entitlements`: `{ identityId, entitlements[] }` (the identity page's Access tab reads the same). A request grant of a time-bound request carries `expiresAt`, the time constraint the policy trace shows for access a request granted, on any identity's map |
| Policy-intended operations (policy trace, time constraints, SoD warnings) | Policy Engine | `/policy/evaluate/:identityId`, evaluated live on every load |
| Entitlement metadata (type, governance level) | Entitlement Catalog | `/entitlement-catalog?system=:sys`, once per system of the identity's entitlements |
| Open drifts per target system | Reconciliation | `/reconciliation/drifts?userId=:id&status=open`, every page |
| Risk score | Risk Scoring | `/risk-scores/:identityId` (a 404, no score yet, shows no score) |
| Linked admin accounts | Privileged Access | `/privileged-access/:parentId/admin-accounts` (a viewer gets 403 for another identity: the map then shows no admin accounts) |

No backend endpoint is specific to the map: it aggregates these in the frontend. Access assigned
directly in a target system is not shown (the page says so).

### Interactive Features

| Feature | Behavior |
|---------|----------|
| **Click target system node** | Expands to show all entitlements (groups, licenses, roles) |
| **Click entitlement** | Shows: source policy, governance level (STRICT/OPEN), origin (POLICY/EXTERNAL), risk level, approval chain |
| **Drift indicator** | Amber badge on target node when drift exists. Click → shows drift details with [Correct] / [Absorb] actions |
| **Admin account node** | Shows tier badge, session status, expiry timer. Click → activate/deactivate. Dashed line to parent identity. |
| **Time-bound entitlements** | Countdown badge showing remaining duration |
| **Policy trace** | Hover entitlement → tooltip shows "Assigned by policy: All Full-Time Employees (P1)" |
| **Compare mode** | Toggle to show desired state (policy intent) vs actual state (reconciliation) side-by-side |
| **Export** | PDF/CSV export for compliance auditors |

### Component Architecture

```
IdentityEntitlementMap/
├── IdentityMapCanvas.tsx          — ReactFlow canvas (reuse from Design Studio)
├── IdentityNode.tsx               — Center node: user profile + risk score
├── TargetSystemNode.tsx           — Per-system: Entra, AD, SCIM apps
├── EntitlementChip.tsx            — Group/License/Role pill with governance badge
├── AdminAccountNode.tsx           — Linked admin with tier + session status
├── DriftBadge.tsx                 — Amber indicator with correction actions
├── PolicyTraceTooltip.tsx         — Shows which policy assigned each entitlement
└── hooks/
    ├── useIdentityEntitlements.ts — TanStack Query: aggregates all data sources
    └── useEntitlementGraph.ts     — Transforms flat data into ReactFlow nodes/edges
```

### Route & Navigation

- **URL:** `/identity/:id/map`
- **Entry point:** **Entitlement map** in the header of the identity page `/identities/:id`
  (`frontend/src/features/users/IdentityDetailPage.tsx`); the map's Back returns there.
- **Not linked yet from:** Access Review item detail, Reconciliation drift detail.

---

## Phases

### Phase 1: Read-Only Map (MVP)
- Render identity → target system → entitlements graph
- Show provisioning status, drift count, admin account linkage
- Policy trace tooltips
- No interactive actions (view only)

### Phase 2: Interactive Actions
- Correct drift from map view
- Activate/deactivate admin accounts
- Revoke individual entitlements (triggers access request revocation workflow)

### Phase 3: Compare Mode + Export
- Side-by-side: desired (policy) vs actual (reconciliation)
- PDF export for compliance
- Historical view: "what did this user have on date X?" (from audit events)

---

## Dependencies

- Identity Hub with provisioning state (exists)
- Entitlement Catalog with adminTier/riskLevel (exists after TASK_182)
- Policy Engine evaluation (exists)
- Reconciliation drift detection (exists)
- Risk Scoring Service (exists)
- ReactFlow library (already used in Design Studio)

---

## Relationship to Existing Features

| Feature | Relationship |
|---------|-------------|
| **Design Studio** | System-level topology (connectors + brain). Entitlement Map is user-level topology. Shares ReactFlow renderer. |
| **Identity Hub** | Tabular view of all identities. Entitlement Map is the deep-dive for a single identity. |
| **Reconciliation Dashboard** | Shows drifts across all users. Entitlement Map shows drifts for one user in context. |
| **Access Reviews** | Reviewers decide approve/revoke. Entitlement Map gives them the visual context to decide. |
| **PAM / Privileged Access** | Admin accounts panel. Entitlement Map shows admin accounts in context of the parent identity. |

---

## Implementation Checklist

**Phase 1 — Read-Only Map (MVP)**
- [x] Create `useIdentityEntitlements.ts` hook (TanStack Query: aggregate data from Identity Hub, Policy Engine, Reconciliation, Entitlement Catalog, Risk Scoring)
- [x] Create `useEntitlementGraph.ts` hook (transform flat data into ReactFlow nodes/edges)
- [x] Create `IdentityMapCanvas.tsx`, `IdentityNode.tsx`, `TargetSystemNode.tsx`, `EntitlementChip.tsx`, `AdminAccountNode.tsx`
- [x] Implement `DriftBadge.tsx` and `PolicyTraceTooltip.tsx` components (the policy trace is `components/PolicyTraceModal.tsx`, opened on click)
- [x] Add route `/identity/:id/map` and "View Entitlement Map" button in Identity Hub detail drawer (the button is **Entitlement map** on the identity page)

**Phase 2 — Interactive Actions**
- [x] Implement drift correction actions from map view (Correct / Absorb): `components/DriftActionPanel.tsx`
- [ ] Implement admin account activate/deactivate from `AdminAccountNode`
- [ ] Implement individual entitlement revocation (triggers access request revocation workflow)

**Phase 3 — Compare Mode & Export**
- [ ] Implement desired vs actual side-by-side compare mode
- [ ] Implement PDF/CSV export for compliance auditors
- [ ] Add unit tests for hooks, components, and interactive actions (they exist for the data hooks and the two modals: `hooks/__tests__/useEntitlementGraph.test.tsx`, `components/__tests__/IdentityMapModals.test.tsx`)
