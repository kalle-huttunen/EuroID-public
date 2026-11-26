# EuroID Documentation Strategy

## Why Co-located Documentation

EuroID uses a **Domain-Driven Documentation** pattern — architecture docs live next to the code they describe, not in a distant monolithic folder.

### The Problem with Monolithic Docs

When all architecture docs live in a single `docs/architecture/` folder:

- **AI context overload** — An agent asked to "add a new connector" must scan 20+ global docs to find the relevant rules. Most of those docs are irrelevant and consume context window.
- **Forgotten updates** — When a developer changes code in `modules/policy/`, they rarely remember to update a doc 5 folders away in `docs/architecture/governance/`.
- **Cross-contamination** — An AI agent reading `SYSTEM_ARCHITECTURE.md` might accidentally apply an Identity Hub rule to a Connector task, simply because it read about it.

### The Solution: Two-Tier Documentation

Domain-specific docs live **in the module folder** alongside the code. Cross-cutting docs stay **in `docs/architecture/`** because they genuinely affect all modules.

```
EuroID/
├── docs/
│   ├── architecture/           ← Cross-cutting (system-wide) docs
│   │   ├── core/               ← DATAFLOWS, EVENT_BUS, SYSTEM_ARCHITECTURE
│   │   ├── infrastructure/     ← MULTI_TENANCY, OBSERVABILITY, TEMPORAL_WORKFLOWS
│   │   ├── security/           ← PLATFORM_AUTH, DATA_RETENTION
│   │   ├── api/                ← API_REFERENCE, API_STABILITY_CONTRACT
│   │   ├── future/             ← FUTURE_* docs (unimplemented features)
│   │   ├── roadmap/            ← Consolidated roadmap (gaps + evolution plan)
│   │   ├── API_CHANGELOG.md    ← Breaking changes log
│   │   └── DIAGRAMS_INDEX.md   ← Visual index of all mermaid diagrams
│   ├── adr/                    ← Architecture Decision Records
│   └── DOCUMENTATION_STRATEGY.md  ← This file
│
├── backend/src/
│   ├── modules/
│   │   ├── identity/docs/      ← DATABASE_ARCHITECTURE, HUB_AND_SPOKE, MULTI_HR_INGESTION
│   │   ├── connectors/docs/    ← Connector ARCHITECTURE (general)
│   │   │   └── entra-connector/docs/  ← ENTRA_DEEP_DIVE (Entra-specific)
│   │   ├── policy/docs/        ← Policy engine ARCHITECTURE
│   │   ├── reconciliation/docs/← Reconciliation ARCHITECTURE, ORPHAN_DETECTION
│   │   ├── blueprints/docs/    ← Simulation ARCHITECTURE
│   │   ├── access-requests/docs/← Access request ARCHITECTURE
│   │   ├── risk-scoring/docs/  ← Risk scoring ARCHITECTURE
│   │   ├── privileged-access/docs/← PAM ARCHITECTURE
│   │   └── compliance-reporting/docs/← GDPR_COMPLIANCE
│   └── infrastructure/
│       ├── secrets/docs/       ← Secrets ARCHITECTURE
│       └── temporal/docs/      ← TASK_QUEUES
│
└── frontend/docs/              ← Frontend ARCHITECTURE
```

---

## Decision Matrix: Where Does My Doc Go?

| Question | Answer | Location |
|----------|--------|----------|
| Does it affect ALL modules? (auth, tenancy, observability, event bus) | Yes | `docs/architecture/` |
| Does it affect ONE module? (policy rules, connector patterns, reconciliation loop) | Yes | `module/docs/` |
| Is it a future/unimplemented feature? | Yes | `docs/architecture/future/` |
| Is it a cross-reference index, changelog, or API contract? | Yes | `docs/architecture/` |
| Is it about a specific connector's deep internals? | Yes | `connector/docs/` (e.g., `entra-connector/docs/`) |

**Rule of thumb:** If you can name the single module that owns the concept, the doc goes in that module's `docs/` folder. If it touches 3+ modules, it stays global.

---

## Module-Local Doc Conventions

### Naming

- **`ARCHITECTURE.md`** — The main architecture doc for a module (one per module)
- **Topic-specific names** — Additional docs for sub-features (e.g., `ORPHAN_DETECTION.md`, `ENTRA_DEEP_DIVE.md`, `GDPR_COMPLIANCE.md`)
- **Always uppercase** with underscores, matching the existing convention

### Cross-Reference Header

Every module-local doc starts with a cross-reference header linking to related cross-cutting docs:

```markdown
> **Module:** Identity (Pillar 1 — Heart)
> **Cross-cutting:** [Data Flows](../../../../../docs/architecture/core/DATAFLOWS.md) | [Event Bus](../../../../../docs/architecture/core/EVENT_BUS_ARCHITECTURE.md)
```

### Directory Structure

Architecture docs live in a `docs/` subdirectory within each module, not at the module root:

```
modules/identity/
├── docs/
│   ├── DATABASE_ARCHITECTURE.md
│   ├── HUB_AND_SPOKE.md
│   └── MULTI_HR_INGESTION.md
├── schemas/
├── services/
└── identity.module.ts
```

---

## Lifecycle Rules

### When a FUTURE_ doc becomes implemented

1. Move the doc from `docs/architecture/future/` to the new module's `docs/` folder
2. Rename from `FUTURE_*.md` to `ARCHITECTURE.md` (or a topic-specific name)
3. Leave a redirect stub at the old location
4. Update `CLAUDE.md` § Documentation Index

### When a new module is created

1. Create a `docs/` subdirectory in the module
2. Create `ARCHITECTURE.md` with the cross-reference header
3. Update `CLAUDE.md` § Documentation Index
4. Run the "Agent Definition of Done" checklist (see `rules/agent-workflows.md`)

### When modifying code in a module

If you change a pattern or behavior documented in the module's `docs/` folder, update the doc in the same PR. The doc is right there — no excuses.

> **Enforcement:** The full checklist for inventory updates, cross-reference hygiene, and diagram index maintenance is in `rules/agent-workflows.md` § "Agent Definition of Done". The lifecycle rules above describe the *what* and *why*; the checklist describes the *when* and *how*.

---

## Redirect Stubs

When docs are moved from `docs/architecture/` to module-local `docs/` folders, a **redirect stub** is left at the old location to prevent broken links in external references, bookmarks, or old task files.

### Stub Format

```markdown
# [Document Title]

> **This document has moved.** See [new location](relative/path).
>
> This stub exists to prevent broken links. Do not add content here.
```

### Stub Lifecycle

1. When a doc moves, leave a stub at the old location
2. Update all known cross-references in active docs to point to the new location
3. Once all references are updated, the stub can be deleted
4. **Do not add new content to stubs** — always work in the module-local doc

### Current Stub Cleanup Status

Active docs (DATAFLOWS.md, DIAGRAMS_INDEX.md, SYSTEM_ARCHITECTURE.md, all FUTURE_* docs, ROADMAP.md) have been updated to point directly to module-local paths as of 2026-02-22. `GAP_ANALYSIS_MATRIX.md` and `ARCHITECTURE_EVOLUTION_PLAN.md` stubs have been deleted — all references now point to `roadmap/ROADMAP.md` or specific `future/` docs. No remaining redirect stubs exist.

---

## Current Inventory

Full documentation inventory: see `CLAUDE.md` § Documentation Index (canonical list of all module-local, cross-cutting, and future design docs). The tree diagram above shows the organizational structure.
