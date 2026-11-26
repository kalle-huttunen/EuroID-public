# Policy-as-Code (OPA Integration)

> **Status:** Partially implemented (Phases 1 and 2, not wired). `backend/src/infrastructure/opa/` (`opa.module.ts`,
> `opa-client.service.ts`; off unless `OPA_ENABLED=true`) and `backend/src/modules/policy/opa/` (`rego-compiler.service.ts`,
> `opa-evaluator.service.ts`) exist, but nothing calls the evaluator: `PolicyEngineService` evaluates every policy in
> TypeScript, and no policy save compiles or pushes Rego. Docker Compose has no OPA container.
> **Roadmap:** [ROADMAP.md](../roadmap/ROADMAP.md) | [Data Flows](../core/DATAFLOWS.md)

### Current State (updated 2026-02-17)
- Policies stored as JSON in MongoDB (`policy.schema.ts`)
- TypeScript `PolicyEngineService.evaluateCondition()` handles matching (`policy-engine.service.ts:377`)
- Condition operators (12 total): equals, not_equals, contains, starts_with, ends_with, in, not_in, regex, greater_than, less_than, is_empty, is_not_empty
- No external policy engine; all logic is in-process (489 lines in `policy-engine.service.ts`)
- SoD is now fully implemented: `SodService` (78 lines) validates toxic pairs, returns BLOCK/WARN violations, integrated at `policy-engine.service.ts:91`; BLOCK violations throw `SoDViolationException`, WARN violations attached to intent
- Policy staging & peer review implemented: policies created as draft, activation requires different user than creator
- Contract-aware evaluation: multi-contract split provisioning with per-contract "virtual user" evaluation
- Machine identity safety guard: `shouldEvaluatePolicyForUser()` skips SERVICE_ACCOUNT/ADMIN_ACCOUNT types
- 38+ domain event types defined in `event-types.ts`, including `POLICY_EVALUATED`, `RISK_SCORES_CALCULATED`, `ORPHAN_DETECTED`, `RECERTIFICATION_CAMPAIGN_CREATED`, `COMPLIANCE_REPORT_GENERATED`

### Architecture

```
┌──────────────┐     ┌──────────────────┐     ┌────────────────┐
│ Policy Studio│     │ NestJS API       │     │ OPA Sidecar    │
│ (React Flow) │────►│                  │────►│                │
│ Visual Editor│     │ PolicyEngine     │     │ Rego Policies  │
│              │     │ Service          │     │ (Git-synced)   │
└──────────────┘     │ (Orchestrator)   │     │                │
                     │                  │◄────│ JSON Decision  │
                     └──────────────────┘     └────────────────┘
```

### Implementation Plan

**Phase 1: OPA Sidecar Setup**
- Add OPA as a sidecar container (Docker Compose / K8s)
- Create `backend/src/infrastructure/opa/`:
  - `opa.module.ts` — NestJS module, configures OPA client
  - `opa-client.service.ts`: HTTP client to `OPA_URL` (default `http://localhost:8181`), with the `OpaQueryInput` and `OpaQueryResult` types (built)
- OPA runs on `localhost:8181` in dev, sidecar in prod

**Phase 2: Rego Policy Compiler**
- Create `backend/src/modules/policy/opa/`:
  - `policy-to-rego.compiler.ts` — translates JSON policy (conditionGroups + actions) → Rego
  - `rego-templates/` — Rego templates for each operator (equals, contains, regex, etc.)
- When a policy is saved in the UI, compile to Rego and push to OPA via Data API
- Keep JSON policies as source of truth in MongoDB (UI-friendly); Rego is the compiled output

**Phase 3: Hybrid Evaluation**
- Modify `PolicyEngineService.evaluate()`:
  - **Fast path (OPA):** Send `{ user, context }` to OPA → get `{ operations[], matched_policies[] }`
  - **Fallback (TypeScript):** If OPA is unreachable, fall back to existing in-process evaluation
  - Switches that exist: `OPA_ENABLED` (default `false`) and `OPA_FALLBACK_ON_ERROR` (default `true`), `infrastructure/config/opa.config.ts`; there is no `POLICY_ENGINE_MODE`
- OPA input schema: `{ user: StandardUserDto, tenant: string, contracts: [], customAttributes: {} }`
- OPA output schema: `{ allow: bool, operations: [{ type, action, target, targetId }], matched: string[] }`

**Phase 4: Git-Sync for Audit**
- Policies exported to Git repo on save (Rego files versioned)
- Create `backend/src/modules/policy/opa/git-sync.service.ts`
- On policy update: write `.rego` file → commit → push to policy repo
- Compliance team can review policy changes via PR workflow
- **Note:** Policy staging & peer review is already implemented in NestJS — git-sync adds version history on top of the existing approval workflow

**Phase 5: Testing & Validation**
- OPA `opa test` for Rego unit tests
- Create `backend/src/modules/policy/opa/policy-test.service.ts` — runs OPA test suite before deploying policy
- UI: "Test Policy" button runs OPA evaluation with sample users before activation

### Files Changed
| Action | File |
|--------|------|
| New | `backend/src/infrastructure/opa/` (module, client, interfaces) |
| New | `backend/src/modules/policy/opa/` (compiler, templates, git-sync, test) |
| Modify | `backend/src/modules/policy/policy-engine.service.ts` — add OPA evaluation path |
| Modify | `backend/src/modules/policy/policy.module.ts` — register OPA module |
| Modify | `backend/src/modules/policy/policy.service.ts` — compile to Rego on save |
| New | `policies/` (root-level directory for Rego files, Git-synced) |

### Dependencies
- OPA binary/container (new infrastructure)
- Git repository for policy versioning (optional, for audit)

### Scope Adjustment (2026-02-17, updated 2026-02-19)
- Phase 4 (Enhanced SoD) is partially complete: `SodService.validate()` already handles toxic pair detection with BLOCK/WARN modes. OPA integration would add nested group awareness and graph-based SoD (see Improvement 5).
- Policy staging/peer review already exists; OPA git-sync adds immutable version history on top.
- **Risk Scoring now consumes policy engine**: `RiskScoringService` calls `PolicyEngineService.evaluateForRiskScoring()` to count SoD violations per identity. OPA migration must preserve this interface or Risk Scoring must be updated to query OPA directly.

### Implementation Checklist

**Phase 1 — OPA Sidecar Setup**
- [x] Create `backend/src/infrastructure/opa/` module (`opa.module.ts`, `opa-client.service.ts` with its input and result types)
- [ ] Add OPA container to Docker Compose and K8s manifests

**Phase 2 — Rego Policy Compiler**
- [x] Create a Rego compiler (`modules/policy/opa/rego-compiler.service.ts`: JSON conditionGroups + actions to Rego)
- [x] Rego for each operator (`OPERATOR_MAP` in `rego-compiler.service.ts`, all 12 operators; no `rego-templates/` directory)
- [ ] Compile to Rego and push to OPA via Data API on policy save (`OpaEvaluatorService.syncPolicies()` compiles and pushes through the Policy API, but nothing calls it)

**Phase 3 — Hybrid Evaluation**
- [ ] Modify `PolicyEngineService.evaluate()` to support OPA fast path with TypeScript fallback
- [ ] Add a mode switch (opa | typescript | hybrid) that `PolicyEngineService` reads (no `POLICY_ENGINE_MODE` exists)
- [ ] Ensure `RiskScoringService.evaluateForRiskScoring()` interface is preserved

**Phase 4 — Git-Sync for Audit**
- [ ] Create `git-sync.service.ts` (write .rego files, commit, push to policy repo on policy update)

**Phase 5 — Testing & Validation**
- [ ] Create `policy-test.service.ts` (run OPA test suite before deploying policy)
- [ ] Add "Test Policy" button in UI (OPA evaluation with sample users before activation)
- [ ] Add unit and integration tests for Rego compiler, OPA evaluation, fallback, and git-sync
- [ ] Update API_CHANGELOG.md and policy module docs

### Risks
- Rego learning curve for operations teams (mitigated by keeping visual editor)
- OPA sidecar availability (mitigated by TypeScript fallback)
- Complex policies (nested contracts, custom attributes) may be hard to express in Rego
- Contract-aware evaluation (`evaluateWithPolicies` multi-contract split) must be replicated in Rego
