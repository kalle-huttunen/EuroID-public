---
Last updated: 2026-02-23
---

# 🏗️ System Architecture - The 2026 Standard

## 🎯 High-Level Overview

We are building an **Event-Driven, Policy-Based Identity Governance & Administration (IGA) Platform**.

It is designed to be **Resilient** (Temporal), **Self-Healing** (Reconciliation), and **Safe** (Simulation).

---

## ⚠️ System Landmines (Critical Safety Protocol)

These are the five "Architectural Sins" that will kill the platform in the long run.

### 🧨 Landmine 1: The "God Object" User

* **The Trap:** You try to store *everything* about a user in a single flat JSON object (`user.managerName`, `user.lastLogin`, `user.laptopSerial`).
* **The Explosion:** The User object becomes 5MB large. Performance crawls. Syncs time out.
* **The 2026 Fix:** **The Onion Model.**
* **Core:** Only identity data (Name, Email, ID).
* **Layers:** Everything else is a linked document (`sources['workday']`, `devices['laptop']`). Fetch only what you need.



### 🧨 Landmine 2: Secret Sprawl

* **The Trap:** Storing API Keys in the MongoDB `Blueprint` collection in plain text.
* **The Explosion:** A database dump leaks the keys to your entire infrastructure.
* **The 2026 Fix:** **Envelope Encryption.**
* Secrets in the DB are encrypted with a key that lives in **HashiCorp Vault** (or AWS KMS). The DB admin cannot read them.



### 🧨 Landmine 3: The "Distributed Monolith"

* **The Trap:** The `EntraService` directly imports the `SlackService` to send a notification.
* **The Explosion:** You cannot test Entra without mocking Slack. If Slack is down, Entra provisioning fails.
* **The 2026 Fix:** **Event-Driven Decoupling.**
* Entra Service emits an event: `USER_PROVISIONED`.
* Notification Service listens for the event. They never talk directly.



### 🧨 Landmine 4: The ReDoS Trap (Regex Denial of Service)

* **The Trap:** Allowing admins to write custom Regex policies (e.g., for email validation) that run on the main thread.
* **The Explosion:** A malicious regex (e.g., `(a+)+$`) freezes the Node.js Event Loop, taking down the API for everyone.
* **The 2026 Fix:** **Sandboxed Execution.**
* Use `vm2` or a timeout-wrapped execution helper for all user-defined regex.
* Never use `new RegExp()` directly on untrusted input in the main thread.



### 🧨 Landmine 5: The Hardcoded Fallback

* **The Trap:** `JWT_SECRET || 'default-dev-secret'`.
* **The Explosion:** Production environment variables fail to load, the app starts with the default secret, and attackers forge admin tokens.
* **The 2026 Fix:** **Fail Fast.**
* The application **crashes at startup**: config validation throws when the config loads if `JWT_SECRET` is unset (unless `AUTH_DISABLED=true`, refused in production) or no encryption key is set (`ENCRYPTION_KEY`, `ENCRYPTION_KEY_PASSPHRASE` or `KMS_PROVIDER`).
* The checks: `backend/src/infrastructure/config/auth.config.ts` and `encryption.config.ts`.
* No default fallbacks allowed in code.



---

## 🏗️ Foundational Pillars

| Pillar | Component | Responsibility |
| --- | --- | --- |
| 1. **The Heart** | **Identity Hub** | The Single Source of Truth. Implements the **Onion Model** (Golden Record + Raw Sources). |
| 2. **The Brain** | **Policy Engine** | Decides who gets what. Translates **Business Roles** → **Technical Entitlements**. |
| 3. **The Hands** | **Connectors** | "Dumb pipes" that execute changes. Strictly **Idempotent** and **Rate-Limited**. |
| 4. **The Eyes** | **Reconciliation** | Detects drift. Compares **Desired State** vs. **Actual State**. |
| 5. **The Nerves** | **Temporal** | Orchestrates long-running processes (Sagas, Retries, Approvals). |
| 6. **The Safety** | **Simulation** | Predicts the **Blast Radius** of changes before they happen. |
| 7. **The Shield** | **Privileged Access** | Linked admin identities, tiered admin model (Tier 0/1/2). See [privileged-access/ARCHITECTURE.md](../../../backend/src/modules/privileged-access/docs/ARCHITECTURE.md). |
| 8. **The Shop** | **Access Requests** | Self-service portal, approval workflows, requestable entitlements. See [access-requests/ARCHITECTURE.md](../../../backend/src/modules/access-requests/docs/ARCHITECTURE.md). |
| 9. **The Gauge** | **Risk Scoring** | Composite risk score (0-100), nightly batch calculation, trend tracking. See [risk-scoring/ARCHITECTURE.md](../../../backend/src/modules/risk-scoring/docs/ARCHITECTURE.md). |

---

## 🔄 The v2.0 Hybrid Topology (Remote Agents & Cells)

To support hybrid-cloud and high-security environments, the architecture is split into a Control Plane and Execution Plane.

> **Status (2026-11-26):** design only beyond logical tenant isolation and the agent registry: cells and the remote agent are not built, and every connector runs in `backend/src/worker.ts`. EuroID is supported as one installation per customer ([DEPLOYMENT.md](../../DEPLOYMENT.md) § Supported Deployment Model; [FUTURE_SHARED_HOSTING.md](../future/FUTURE_SHARED_HOSTING.md)).

| Plane | Component | Tech Stack | Responsibility |
|-------|-----------|------------|----------------|
| **Control** | **Core API (Cells)** | NestJS + Temporal | Orchestration, Policy Decision (OPA), Identity Hub. Tenant-isolated via "Cells". |
| **Control** | **Read Layer** | ElasticSearch | Denormalized views for instant dashboarding (CQRS). |
| **Execution** | **Remote Agents** | Go/Rust Binary | Runs inside customer firewall. Polls Temporal via gRPC. Executes Connector logic. |
| **Execution** | **Sandbox** | WebAssembly (Wasm) | Isolates untrusted connector code to prevent crashes/leaks. |

---

## 📂 Directory Structure

* **[Backend folder & file structure](../../../backend/README.md)**: NestJS modules, Temporal workflows, activities, and the 5-File Connector pattern.

---

## ⚙️ Key Technology Decisions

### 1. Backend Stack

* **NestJS:** Modular architecture, strong typing.
* **Temporal:** **Durable Execution.** If the server crashes during user onboarding, it resumes exactly where it left off.
* **MongoDB:** **Document-Oriented.** Perfect for storing the messy, variable JSON coming from 50 different APIs.
* **Zod:** **Runtime Validation.** Trust nothing that comes from the frontend or an API.

### 2. Frontend Stack

* **React + Vite:** Speed and ecosystem.
* **React Flow:** The visual engine for the **Policy Builder**.
* **TanStack Query:** Handles caching and server state synchronization.

---

## 🧩 Extended Modules (IGA Capabilities)

| Module | Path | Responsibility |
|--------|------|----------------|
| **Privileged Access** | `modules/privileged-access/` | Linked admin identities, tiered enforcement, activate/deactivate lifecycle |
| **Access Requests** | `modules/access-requests/` | Self-service portal, multi-step approval workflows, SoD pre-check |
| **Risk Scoring** | `modules/risk-scoring/` | Nightly composite risk score (0-100), trend tracking, distribution |
| **Compliance Reporting** | `modules/compliance-reporting/` | SOX & ISO 27001 report templates, PDF/CSV export |
| **Role Bundles** | `modules/role-bundles/` | Reusable action bundles with inheritance, resolved during policy evaluation |
| **NHI** | `modules/nhi/` | Service accounts, workload identities, AI agents: owner, expiry, kill-switch. See [nhi/ARCHITECTURE.md](../../../backend/src/modules/nhi/docs/ARCHITECTURE.md) |
| **Intelligence** | `modules/intelligence/` | Rubber-stamp detection, peer group outliers, recommendations. See [intelligence/ARCHITECTURE.md](../../../backend/src/modules/intelligence/docs/ARCHITECTURE.md) |
| **Credential Lifecycle** | `modules/credential-lifecycle/` | Credential inventory and rotation policies. See [credential-lifecycle/ARCHITECTURE.md](../../../backend/src/modules/credential-lifecycle/docs/ARCHITECTURE.md) |
| **Access Explorer** | `modules/access-explorer/` | Access graph queries over the optional Neo4j graph, synced from domain events |
| **Joiners, Leavers, Mover** | `modules/joiners/`, `leavers/`, `mover/` | HR-driven onboarding, offboarding and access change. Docs: `<module>/docs/ARCHITECTURE.md` in each |
| **Event Subscriptions** | `modules/event-subscriptions/` | HMAC-signed outbound webhooks for domain events |

---

## 🛡️ Security & Compliance

* **Composite Keys:** Identity is immutable (`sourceSystem` + `sourceUserId`), never tied to mutable emails.
* **Audit Trail:** Every action (policy change, provision, drift fix) is logged to an append-only collection.
* **Simulation First:** No policy is applied without a "Dry Run" impact analysis.
* **Least Privilege:** Connectors only request the scopes they explicitly need.
* **Privileged Access Separation:** Admin entitlements are provisioned to separate linked admin identities, not daily-driver accounts.
* **SoD Enforcement:** Segregation of Duties validation on policy evaluation and access request submission.
* **Risk-Based Governance:** Per-user risk scores enable risk-weighted access reviews and compliance decisions.
