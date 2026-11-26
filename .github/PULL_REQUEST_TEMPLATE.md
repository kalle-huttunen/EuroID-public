## Summary
<!-- 1-3 sentences: what changed and why -->

## Type of Change
- [ ] Feature (new functionality)
- [ ] Fix (bug fix)
- [ ] Refactor (no behavior change)
- [ ] Docs (documentation only)
- [ ] Infra (CI/CD, Docker, config)

## Modules Affected
<!-- Check all that apply -->
- [ ] Identity (Hub & Spoke / Golden Record)
- [ ] Policy Engine (ABAC)
- [ ] Connectors (Entra, AD, SCIM, etc.)
- [ ] Reconciliation
- [ ] Workflows (Temporal)
- [ ] Blueprints (Simulation)
- [ ] Frontend
- [ ] Infrastructure (auth, events, secrets, cache)

## Safety Checklist
- [ ] No business logic in connectors (dumb pipes)
- [ ] All data routes through Identity Hub (no direct HR→Target)
- [ ] Multi-step flows use Temporal (not Promise chains)
- [ ] Inputs validated with Zod at API boundary
- [ ] No hardcoded URLs, ports, or secrets
- [ ] Destructive actions have `dryRun` support

## Test Plan
<!-- How was this tested? -->
- [ ] Unit tests pass (`npm run test`)
- [ ] Type check passes (`npm run typecheck`)
- [ ] Lint passes (`npm run lint`)
- [ ] Manual verification (describe below)

## Screenshots
<!-- If UI change, add before/after screenshots -->
