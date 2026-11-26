---
Last updated: 2026-02-23
---

# Architecture Diagrams Index

Quick reference to all mermaid diagrams and flows in the EuroID architecture docs. Use this index to find diagrams when exploring the codebase or onboarding.

> **Note:** Domain-specific docs have been co-located into module `docs/` folders. Links below point to the new locations. See `docs/DOCUMENTATION_STRATEGY.md` for details.

---

## Core Flows

| Diagram | Location | Description |
|---------|----------|-------------|
| **System Flow (Life of a User)** | [core/DATAFLOWS.md](core/DATAFLOWS.md#-system-flow-life-of-a-user) | End-to-end: Discovery → Inbound → Policy → Safety → Provision → Reconciliation |
| **Connectors 3-Phase Flow** | [core/DATAFLOWS.md](core/DATAFLOWS.md#-connectors-flow) | Discovery → Provision → Reconciliation lifecycle |
| **Database Onion Model** | [identity/DATABASE_ARCHITECTURE.md](../../backend/src/modules/identity/docs/DATABASE_ARCHITECTURE.md) | Layers 1-5: profile, sources, controls, provisioning, metadata |
| **Hub & Spoke Inbound** | [identity/HUB_AND_SPOKE.md](../../backend/src/modules/identity/docs/HUB_AND_SPOKE.md) | Source → Validate → Mastery Check → Upsert |
| **Hub & Spoke Outbound** | [identity/HUB_AND_SPOKE.md](../../backend/src/modules/identity/docs/HUB_AND_SPOKE.md) | Hub → Mapper → Connector → Target |

---

## Governance

| Diagram | Location | Description |
|---------|----------|-------------|
| **Policy Engine Flow** | [policy/ARCHITECTURE.md](../../backend/src/modules/policy/docs/ARCHITECTURE.md) | User → conditionGroups → Role Bundles → operations / adminOperations |
| **Reconciliation Loop** | [reconciliation/ARCHITECTURE.md](../../backend/src/modules/reconciliation/docs/ARCHITECTURE.md) | Target vs Hub → Compare → Match / Drift → Fix / Absorb |
| **Orphan Detection Lifecycle** | [reconciliation/ORPHAN_DETECTION.md](../../backend/src/modules/reconciliation/docs/ORPHAN_DETECTION.md) | Reconciliation → Orphan Detection → Quarantine → Cleanup |
| **Simulation Flow** | [blueprints/ARCHITECTURE.md](../../backend/src/modules/blueprints/docs/ARCHITECTURE.md) | Policy draft → Sample users → Dry run → Diff → Impact report |
| **Access Request Status Lifecycle** | [access-requests/ARCHITECTURE.md](../../backend/src/modules/access-requests/docs/ARCHITECTURE.md) | PENDING_APPROVAL → APPROVED/REJECTED/CANCELLED → PROVISIONING → ACTIVE → EXPIRED |
| **Access Request Actor Flow** | [access-requests/ARCHITECTURE.md](../../backend/src/modules/access-requests/docs/ARCHITECTURE.md) | End-user → SoD → Workflow → Approval steps → Provision → Auto-expiry |
| **HR Leaver Flow** | [leavers/ARCHITECTURE.md](../../backend/src/modules/leavers/docs/ARCHITECTURE.md) | HR sync → leaver detection → offboarding workflow, or a paused mass-leaver batch → approve / reject |
| **HR Mover Flow** | [mover/ARCHITECTURE.md](../../backend/src/modules/mover/docs/ARCHITECTURE.md) | HR sync → leaver detection → mover detection against the access baseline → mover workflow, or a paused mass-mover batch → approve / reject |
| **HR Joiner Flow** | [joiners/ARCHITECTURE.md](../../backend/src/modules/joiners/docs/ARCHITECTURE.md) | HR sync → leaver and mover detection → joiners recorded → (pipeline deployed) onboarding workflow per joiner, or a paused mass-joiner batch → approve / reject |

---

## Infrastructure

| Diagram | Location | Description |
|---------|----------|-------------|
| **Temporal Orchestrator** | [infrastructure/TEMPORAL_WORKFLOWS.md](infrastructure/TEMPORAL_WORKFLOWS.md#-architecture-the-orchestrator) | Client → Temporal → Worker → Workflow → Activities → External APIs |
| **Onboarding Workflow** | [infrastructure/TEMPORAL_WORKFLOWS.md](infrastructure/TEMPORAL_WORKFLOWS.md#-onboarding-workflow-flow) | Discover → Health → Fetch → Policy → Admin WF → Provision per target → Writeback |
| **Offboarding Workflow** | [infrastructure/TEMPORAL_WORKFLOWS.md](infrastructure/TEMPORAL_WORKFLOWS.md#-offboarding-workflow-flow) | Linked admin accounts (child offboardings) → getOffboardingTargets → Deprovision per target → markDeleted or suspend |

---

## Integration

| Diagram | Location | Description |
|---------|----------|-------------|
| **Entra Provision Routing** | [entra/ENTRA_DEEP_DIVE.md](../../backend/src/modules/connectors/entra-connector/docs/ENTRA_DEEP_DIVE.md) | ProvisioningIntent → group/license/role ops → syncGroupMemberships / assignLicense / syncDirectoryRoles |
| **Entra Facade Architecture** | [entra/ENTRA_DEEP_DIVE.md](../../backend/src/modules/connectors/entra-connector/docs/ENTRA_DEEP_DIVE.md) | Facade → 3 sub-services (discovery, entitlements, provisioning) |

---

## User Flows (Step-by-Step)

| Flow | Location | Description |
|------|----------|-------------|
| **All User Flows** | [docs/USER_FLOWS.md](../../docs/USER_FLOWS.md) | 25 detailed end-to-end flows: auth, Design Studio, simulation, deploy, monitoring (1 to 9), then leavers, movers, joiners, access reviews, webhooks, GDPR, audit integrity, NHI and more (10 to 25) |
| **Test Scenario** | [docs/TEST_SCENARIO.md](../../docs/TEST_SCENARIO.md) | Concrete test data (numbers, names, expected outcomes) for the user flows above |

---

## Related Docs (ASCII or No Diagram)

| Doc | Content |
|-----|---------|
| [core/DATAFLOWS.md](core/DATAFLOWS.md) | Policy Engine, Reconciliation, Simulation, Temporal, Access Request, Risk Scoring (ASCII) |
| [privileged-access/ARCHITECTURE.md](../../backend/src/modules/privileged-access/docs/ARCHITECTURE.md) | Admin identity lifecycle (ASCII) |
| [risk-scoring/ARCHITECTURE.md](../../backend/src/modules/risk-scoring/docs/ARCHITECTURE.md) | Nightly risk score calculation (ASCII) |
