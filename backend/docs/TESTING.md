# Backend Testing Guide

> Test types, run commands, patterns, and conventions for the EuroID backend.

---

## Quick Reference

```bash
npm test                # Run all .spec.ts tests
npm run typecheck       # Type-check src and tests with tsc (jest does not; the pre-push hook runs it)
npm run test:watch      # Watch mode (re-runs on file change)
npm run test:cov        # Coverage report (enforces thresholds)
npm run test:cov:safe   # Coverage with --runInBand (safer for CI, slower)
npm run test:debug      # Node inspector + Jest --runInBand
npm run test:e2e        # E2E tests (uses test/jest-e2e.json, at most 2 workers)
TEMPORAL_E2E=1 npm run test:e2e   # with the Temporal workflow e2e suite (about 40 s; the pre-push hook runs it)
TEMPORAL_E2E=1 npm run test:e2e -- test/workflows/jml-end-to-end.workflow.e2e-spec.ts  # the joiner, mover, leaver story
REDIS_TEST_URL=redis://127.0.0.1:6390 npm run test:e2e -- test/infrastructure  # cache and locks on a real Redis (throwaway instance; no gate runs it, see Redis backends)
NEO4J_TEST_URL=bolt://127.0.0.1:7697 NEO4J_TEST_PASSWORD=<password> npx jest src/modules/access-explorer/access-explorer.neo4j.integration.spec.ts  # access explorer on a real Neo4j (throwaway instance; no gate runs it, see Neo4j access explorer)
```

Jest compiles the tests without type-checking: both configs (`jest.config.ts`, `test/jest-e2e.json`) run ts-jest with `tsconfig.jest.json`, which is `tsconfig.json` plus `isolatedModules: true`, so ts-jest transpiles each file on its own and a type error does not fail a spec. `npm run typecheck` (`tsc --noEmit` with `tsconfig.json`, which covers `src` with its specs and `test`) catches it; the `pre-push` hook runs it before `npm test`. Transpiling a file on its own also hides imported types from decorator metadata: a Mongoose `@Prop` on a field typed by an imported enum or type alias needs an explicit `type` (for example `type: String`), or the spec fails with `Cannot determine a type for the "Class.field" field`.

---

## Test Types

| Type | File pattern | Database | What it tests |
|------|-------------|----------|---------------|
| **Unit** | `*.spec.ts` | No | Single service/guard/pipe with mocked dependencies |
| **Contract** | `*.contract.spec.ts` | No | Connector HTTP boundary — dumb-pipe field mapping, idempotency |
| **Activity** | `*.activities.spec.ts` | No | Temporal activities with mocked services |
| **Integration** | `*.integration.spec.ts` | Yes (in-memory) | Full module with real MongoDB via `mongodb-memory-server` |
| **E2E** | `*.e2e-spec.ts` | Yes | Full HTTP request/response (config: `test/jest-e2e.json`) |
| **Workflow E2E** | `test/workflows/*.workflow.e2e-spec.ts` | Yes (in-memory) | Temporal workflows on the time-skipping test server; opt-in with `TEMPORAL_E2E=1` (see Temporal Workflow E2E) |

---

## Test Classes and Time Budget

The numbers are from the audit's warm run of 2026-11-24 on `main` = `242f4e79` (idle machine, one runner at a time). File-seconds add up the run time of every file. Each runner works on 2 files at a time (see Configuration), so the wall time is shorter. A cold run clears the jest cache first.

| Runner | Files | Tests | File-seconds | Wall, warm | Wall, cold |
|--------|-------|-------|--------------|------------|------------|
| `npm test` | 395 | 4144 (4138 passed, 6 skipped) | 136.5 | 71 s | 65 s |
| `TEMPORAL_E2E=1 npm run test:e2e` | 29 | 204 (178 passed, 26 skipped) | 75.6 | 41 s | 43 s |

The audit's inventory sorts the files into classes by what the code contains:

| Class | Rule | Files | Tests | File-seconds |
|-------|------|-------|-------|--------------|
| Unit | no Nest testing module, no database helper | 196 | 1942 | 40.4 |
| Nest module | `createTestingModule` with mocked dependencies | 169 | 2045 | 85.5 |
| Integration with MongoDB | mentions `connectTestDb` or `MongoMemoryServer` | 30 | 157 | 10.6 |
| Temporal e2e | `test/workflows/*.workflow.e2e-spec.ts` | 28 | 197 | 75.6 |

The inventory looks for `connectTestDb`, so a spec that gets its database from `testDbUri()` counts as Nest module or unit. By file name, the specs named `*.integration.spec.ts` are 76 files with 623 tests and 60.0 file-seconds (one file is the skipped Neo4j suite), `*.activities.spec.ts` 26 files with 418 tests and 8.0 s, and `*.contract.spec.ts` 2 files with 24 tests and 0.7 s. The Redis suite (`test/infrastructure/redis-backends.e2e-spec.ts`) is the 29th e2e file: 7 tests, all skipped without `REDIS_TEST_URL`.

What the time budget rests on:

- Per test: `testTimeout` is 30 s in `jest.config.ts`. Two specs raise it because they do one large piece of work: `app-routes.spec.ts` (a `beforeAll` of 120 s that imports every controller to build the route table; 2.0 s warm) and `seed-demo.integration.spec.ts` (120 s; seeds 200 identities, the slowest backend file at 10.4 s).
- Slowest backend files (warm): `seed-demo.integration.spec.ts` 10.4 s, `leaver-detection.integration.spec.ts` 8.1 s, `auth-local.service.spec.ts` 5.8 s, `hr-mover-detection.integration.spec.ts` 4.1 s, `password-reset.integration.spec.ts` 3.8 s. Every other file takes 2.3 s or less.
- Slowest e2e files (warm): `jml-end-to-end` 6.1 s, `offboarding-per-system` 5.0 s, `payload-codec` 4.7 s (43 tests), `hr-leaver` 4.4 s, `reconciliation-orphan-cleanup-start` 4.0 s.
- Gates built on these numbers: the pre-push hook (typecheck, `npm test`, e2e) takes about 3 minutes. The related tests of a change to `src/infrastructure/events/event-types.ts` (196 files, the widest case) took 42 s warm and 52 s cold in the pre-commit hook.

---

## What Runs Where

| Where | When | What | Cost |
|-------|------|------|------|
| Pre-commit (`.husky/pre-commit`, `lint-staged` in the root `package.json`) | every commit, on the staged files | staged `backend/src/**/*.ts`: `prettier --write`, `eslint --fix`, `jest --bail --findRelatedTests --passWithNoTests` (the specs that import a changed file), then `check-tenant-guard.sh`, `check-request-tenant-fields.sh`, `check-workflow-tenant-reads.sh`. Staged `frontend/src/**/*.{ts,tsx}`: `prettier --write`, `eslint --fix`, `check-hex-colors.sh` (no vitest). Staged `swagger-spec.json`: `check-api-types-drift.sh` | 42 to 52 s for a change to the event registry (`event-types.ts`, 196 related files); less for a change fewer specs import |
| Pre-push (`.husky/pre-push`) | every push; a failure refuses the push | `npm run typecheck`, `npm test` (the whole backend jest suite), `TEMPORAL_E2E=1 npm run test:e2e` | about 3 minutes |
| Maintainer's verify-and-push script (not in the repo) | before a push to `main` | backend: `npm run typecheck`, `npm run lint:ci`, every `scripts/check-*.sh`; frontend: `npm run typecheck`, `npm run lint`, `npx vitest run --maxWorkers=4`, `npm run build`; then the push, which runs the pre-push hook | 416 to 435 s from start to push in the audit's Task 9 pushes |

The verify script does not run the Temporal e2e suite itself: the pre-push hook does, and running it in both places cost about 40 s a push. Frontend vitest runs only in the verify script (or by hand with `npm test` in `frontend/`): neither hook runs it. There is no CI.

---

## Rules

These came out of the test suite audit of 2026-11-24. Each was checked by changing the code a test names and seeing the test fail.

- MongoDB through `test-db.ts`. A spec that needs MongoDB takes its database from `testDbUri()` or `connectTestDb()`. It never starts a server: `scripts/check-test-db-helper.sh` refuses `MongoMemoryServer.create` and `new MongoMemoryServer` in a spec outside `src/testing/`.
- No sleeps. A test does not wait for real time to pass. Flush the pending work (the handler specs await a few `setImmediate` ticks) or probe the state (poll the request or the record the test cares about). A fixed sleep either wastes time or hides a race. The audit kept a sleep only where the wait is a timestamp that must be later (`admin-users.integration.spec.ts`, 20 ms). `scripts/check-test-waits.sh` fails on a new one (below).
- No wait over 5 s. A test does not wait longer than 5 s for anything. Workflow e2e specs run on the time-skipping server, so a timer completes at once, and a signal that must reach a workflow that may not have started yet goes through `signalWithStart` in place of a poll. `scripts/check-test-waits.sh` fails on a new `waitFor` or `findBy*` timeout over 5000 ms (below).
- A test fails when its logic changes. Before a test is kept or rewritten, change the line it names (flip a condition, drop a tenant, remove a guard call) and run it: it must go red. The audit did this by hand for its rewrites and for most of the gap tests it added. A test that asserts nothing a change could break, such as "renders without crashing", is deleted or merged into a test that can fail.
- Real `jose` for token checks. The default mock of `jose` skips `exp`, `nbf` and `alg`. A spec that tests what a token check refuses loads the real library through `src/testing/real-jose.ts` (see Known Issues).
- Workflow code is covered by e2e, which jest cannot measure. Workflow code runs in the Temporal worker bundle, so the coverage report does not count the lines the e2e specs run. Unit specs of workflow branches stay where deleting them would lower the covered lines (`access-request-approval.workflow.ts`, `onboarding-health-check.ts`), even when an e2e test also catches the change.
- Replay fixtures stay byte-identical. The files `test/fixtures/*.history.json` are recorded histories of earlier workflow versions. The replay specs and `payload-codec.workflow.e2e-spec.ts` replay them against the current workflow code. Do not edit, reformat or re-record one. Before unbinding an activity from `worker-default-activities.ts`, grep the workflows and the fixtures for its name.
- Frontend test levels. Page tests for user flows, unit tests for logic, modal tests for modal content (see `frontend/docs/ARCHITECTURE.md`, Testing).

### The sleep and wait guard (`scripts/check-test-waits.sh`)

It reads every test file of both sides (`backend/src/**/*.spec.ts`, `backend/src/testing/`, `backend/test/`, `frontend/src/**/*.{test,spec}.{ts,tsx}`, `__tests__/` and `frontend/src/test/`, `frontend/e2e/`) and counts two kinds of places:

- sleep: a line with a `setTimeout` wrapped in a promise (`new Promise(... setTimeout(...` on one line, or `setTimeout(resolve, ...)`), a call or definition of a `sleep(` or `delay(` helper, or Playwright's `waitForTimeout(`. A delay of 0 passes no time and is not counted, nor is a method such as the Temporal test environment's `env.sleep()`, which skips time.
- wait: a `timeout:` above 5000 ms in the arguments of `waitFor`, `waitUntil`, `waitForElementToBeRemoved` or a `findBy*`/`findAllBy*` query, or in an options constant (`const LOADED = { timeout: 10_000 }`). A test's own timeout (`it(name, { timeout: 20_000 }, fn)`) is not a wait.

The places that were there when the guard came (2026-11-25) are in `scripts/check-test-waits.allowlist`, one line per file and kind with the count: 25 files with 30 sleeps and 3 files with 3 waits, 28 entries. The guard fails when a file has more than its entry allows (a file without an entry allows none), and prints a note when a file needs fewer: lower or remove the entry then, never raise one. `bash scripts/check-test-waits.sh --list` prints today's counts in the allow-list's format. It is a text check: a sleep spread over several lines without `setTimeout(resolve`, or a timeout passed through a variable, is not seen. The verify script runs it with every other `scripts/check-*.sh`; neither hook does.

---

## Test Helpers (`src/testing/`)

All helpers are re-exported from `@testing` (path alias → `src/testing/index.ts`).

### Module Setup (`test-helpers.ts`)

```typescript
import { createTestingModule, createMockLogger, createMockEventEmitter, withTestTenant, TEST_TENANT_ID } from '@testing';
```

| Export | Purpose |
|--------|---------|
| `TEST_TENANT_ID` | `'test-tenant'` constant for all test tenant context |
| `withTestTenant(fn)` | Wraps async function in tenant `AsyncLocalStorage` context. **Required for all DB operations** — the tenant plugin scopes all queries by `tenantId`. |
| `createTestingModule(metadata)` | Wrapper around `Test.createTestingModule` |
| `createMockLogger()` | Jest mocks for `log`, `error`, `warn`, `debug`, `verbose` |
| `createMockLoggerFactory()` | Mocked `LoggerFactoryService` |
| `createMockEventEmitter()` | Mocked `DomainEventEmitterService` |

### Mock Factories (`mock-factories.ts`)

```typescript
import { createMockUser, createMockIdentityDocument, createMockPolicy } from '@testing';
```

| Factory | Returns |
|---------|---------|
| `createMockUser(overrides?)` | `StandardUserDto` with realistic defaults |
| `createMockIdentityDocument(overrides?)` | Full onion-model identity (profile + sources + provisioning) |
| `createMockPolicy(overrides?)` | Policy schema mock |
| `createMockAdminUser(overrides?)` | Admin document with pre-computed bcrypt hash |
| `createMockMfaSetup(overrides?)` | TOTP secret + backup codes |
| `createMockSamlProfile(overrides?)` | SAML profile mock |
| `createMockConnectorConfig()` | Connector configuration |
| `createMockDriftResult()` | Reconciliation drift result |
| `createMockAccessRequest()` | Access request document |
| `createMockRoleBundle()` | Role bundle with entitlements |

### In-Memory Database (`test-db.ts`)

One in-memory MongoDB serves the whole jest run, and each suite works in databases of its own on it. The global setup of both jest configs (`test/mongo-global-setup.ts`) starts the server with a 60 s launch timeout and sets `TEST_MONGO_URI`; the global teardown (`test/mongo-global-teardown.ts`) stops it and removes its directory. A run that crashed leaves its `/tmp/mongo-mem-*` directory behind (about 200 MB on a tmpfs with a per-user quota): the next run's setup removes those of the same user whose `mongod` is gone, and logs how many and how many MB. A running `mongod` keeps its PID in `mongod.lock` in its directory and empties the lock when it stops cleanly, so a directory goes when its lock names a PID no process has (`process.kill(pid, 0)` answers ESRCH), when its lock has been empty for a minute, or, without a lock, when it is an hour old (mongodb-memory-server makes the directory before it starts `mongod`). A directory whose lock names a live process is never removed, so another worktree's run keeps its server. Tests: `test/mongo-global-setup.spec.ts`.

```typescript
import { connectTestDb, clearTestDb, closeTestDb, testDbUri } from '@testing';
```

| Function | Lifecycle hook | Purpose |
|----------|---------------|---------|
| `testDbUri()` | `beforeAll` | URI of a new database unique to the suite (`t_<JEST_WORKER_ID>_<8 hex>`), for `MongooseModule.forRoot`, `createConnection` or `MongoClient.connect` |
| `testDbUri(label)`, `testDbName(label)` | in the test | A spec with several named databases (a migration spec): the same label gives the same database within the suite |
| `connectTestDb()` | `beforeAll` | Connect the default mongoose connection to a new database of the suite, return its URI |
| `clearTestDb()` | `afterEach` | Drop all collections (isolate tests) |
| `closeTestDb()` | `afterAll` | Close every mongoose connection, drop the suite's databases (the server stays up) |

Unique indexes live per database, so a duplicate key still fails with E11000 once the model's indexes are built (`await Model.init()`). A spec never starts a server of its own: the guard `scripts/check-test-db-helper.sh` fails when a `*.spec.ts` or `*.e2e-spec.ts` outside `src/testing/` contains `MongoMemoryServer.create` or `new MongoMemoryServer`.

---

## Test Patterns

### 1. Unit Test

Mock all dependencies. No database. Test one service in isolation.

```typescript
describe('MyService', () => {
  let service: MyService;
  let mockDep: jest.Mocked<Partial<SomeDependency>>;

  beforeEach(async () => {
    mockDep = { someMethod: jest.fn() };

    const module = await Test.createTestingModule({
      providers: [
        MyService,
        { provide: SomeDependency, useValue: mockDep },
        { provide: LoggerFactoryService, useValue: createMockLoggerFactory() },
      ],
    }).compile();

    service = module.get(MyService);
  });

  it('should do the thing', async () => {
    mockDep.someMethod.mockResolvedValue('result');
    expect(await service.doThing()).toBe('result');
  });
});
```

### 2. Connector Contract Test

Tests the HTTP boundary. Mock the client (HTTP layer), use real services + mapper. Validates dumb-pipe semantics: field mapping only, no business logic.

```typescript
describe('Entra Connector Contract', () => {
  let service: EntraService;
  let mockClient: ReturnType<typeof createMockEntraClient>;

  beforeEach(async () => {
    mockClient = createMockEntraClient(); // Stateful in-memory user map

    const module = await Test.createTestingModule({
      providers: [
        EntraService,
        EntraMapper,
        EntraDiscoveryService,
        { provide: EntraClient, useValue: mockClient },  // Mock at HTTP boundary
        { provide: ConfigService, useValue: configService },
      ],
    }).compile();

    service = module.get(EntraService);
  });

  // Key contract assertions:
  it('is idempotent — 409 Conflict returns success', async () => { ... });
  it('returns empty on 404 NotFound for already-removed resources', async () => { ... });
  it('maps fields only — no PAM classification in output', async () => { ... });
});
```

**Reference:** `backend/src/modules/connectors/entra-connector/entra.contract.spec.ts`

### 3. Activity Test

Mock NestJS services, no database, no workflow runtime. Activities are plain async functions.

```typescript
describe('IdentityActivities', () => {
  let activities: IdentityActivities;
  let identityService: jest.Mocked<Partial<IdentityService>>;

  beforeEach(async () => {
    identityService = { saveOrUpdate: jest.fn(), findByEmail: jest.fn() };

    const module = await Test.createTestingModule({
      providers: [
        IdentityActivities,
        { provide: IdentityService, useValue: identityService },
      ],
    }).compile();

    activities = module.get(IdentityActivities);
  });

  it('rejects empty tenantId', async () => {
    await expect(activities.saveToHub(createMockUser(), ''))
      .rejects.toThrow('[SECURITY] tenantId is required');
  });
});
```

### 4. Integration Test

Real MongoDB (in-memory), full module setup. All DB operations must be wrapped in `withTestTenant()`.

```typescript
describe('IdentityService (Integration)', () => {
  let service: IdentityService;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(testDbUri()),
        MongooseModule.forFeature([{ name: Identity.name, schema: IdentitySchema }]),
      ],
      providers: [
        IdentityService,
        // ... real services + mocked external dependencies
      ],
    }).compile();

    service = module.get(IdentityService);
  });

  afterEach(async () => {
    // Clear all collections between tests
    const collections = mongoose.connection.collections;
    for (const key in collections) {
      await collections[key].deleteMany({});
    }
  });

  afterAll(async () => {
    await module.close();
    await closeTestDb();
  });

  it('saves user with real MongoDB upsert', async () => {
    const result = await withTestTenant(() => service.saveOrUpdate(dto));
    expect(result._id).toBeDefined();
  });
});
```

### 5. Temporal Workflow E2E (`test/workflows/`)

Workflows run on Temporal's time-skipping test server (timers complete at once) with in-memory MongoDB, through `test/helpers/workflow-test-env.ts`: `createWorkflowTestHarness` starts the server, a worker on the queue you name and, optionally, activity-only workers on connector queues. The specs are skipped unless `TEMPORAL_E2E=1`; some tests inside them run only when a recording variable or a fixture workflow path is set (26 skipped tests in the 2026-11-24 run, 7 of them the Redis suite). Most of them pass stub activities; the joiner, mover, leaver test below runs the real ones.

The environment's client and every worker run the payload codec of the API and the worker (`test/helpers/test-payload-codec.ts`, a random key per test process), so a fetched history holds encrypted payloads. `historyText()` reads them decrypted, `historyJSON()` records fixtures decrypted (they replay with or without the codec), and a test that reads a payload itself decrypts it with `testPayloadCodec.decryptPayload()`.

```bash
TEMPORAL_E2E=1 npm run test:e2e   # the whole suite, about 40 s
TEMPORAL_E2E=1 npm run test:e2e -- test/workflows/jml-end-to-end.workflow.e2e-spec.ts
```

The `pre-push` hook runs the whole suite after `npm run typecheck` and `npm test` (`.husky/pre-push`; there is no CI). A failing spec refuses the push.

**Test server binary.** The first run downloads it (about 86 MB; the lookup and the archive come from `https://temporal.download`) into `backend/node_modules/.cache/temporal-test-server` (`createTestWorkflowEnvironment`). Later runs reuse it, offline too, for 365 days or until the Temporal SDK version changes (the file name carries the SDK version). Without the cached binary and without network every spec fails in `beforeAll` with `Failed to start ephemeral server: error sending request for url (https://temporal.download/...)`. The SDK's own default, the OS temp directory with a one-day TTL, made the first run after a reboot (a tmpfs `/tmp`) or after a day download it again.

#### The joiner, mover, leaver story (`jml-end-to-end.workflow.e2e-spec.ts`)

Plan item 2.6: the lifecycle an evaluator looks at, in one tenant. It runs on the app's own Nest modules (identity, policy, connectors, onboarding, offboarding, leavers, mover, access review, audit, events and their global infrastructure) as a Nest application without a port, with the real activities registered on the default queue as `worker.ts` registers them (`buildDefaultActivities`). The story touches no connector queue. The env file is ignored; Redis, Neo4j, OPA, SMTP and Entra ID are not configured, and Elasticsearch stays in its fail-open mode without a connection attempt. The CSV HR connector reads exports the test writes, the File outbound connector appends to a file in a directory the test owns; nothing else is mocked. It takes about 12 s alone (9 s inside the suite).

| Stage | Trigger | Asserted |
|---|---|---|
| 1. Joiner | Scheduled HR sync of the first export (`scheduledSyncWorkflow`) before Deploy: HR joiner detection records the three identities it minted as joiners, waiting. Impact analysis and Deploy (Deploy starts nothing). The next full sync puts the three in a mass-joiner batch (3 is above the allowance of 2); an admin approves it, which starts one onboarding run per joiner (`OnboardingService.triggerOnboarding`, memo `joiner:hr-sync:csv-hr`) | Ingest result; three Golden Records from `csv-hr` (`primary-hr`); no workflow before the approval; the pending batch (3 identities, allowance 2); one File outbound line per joiner with the record and the policy's intent; provisioning entry `SYNCED` with the write-back complete and nothing written back; access baseline recorded; no `identity.updated` and no workflow besides the three onboarding runs; audit of the two syncs, the batch pause and approval and each onboarding start; the same export again starts nothing |
| 2. Mover | Next scheduled sync with one department changed (HR mover detection, trigger `hr-sync`) | One mover run; its outcome for File outbound: not updated by the mover, with the policy delta (new department's group added, old one removed) and the reason; timeline; baseline advanced; nothing new in the file; what the active policies give the new department; access preview with nothing pending; audit |
| 3. Review | A campaign over the File outbound identities, created and activated; the default reviewer keeps two accounts and revokes the third | One review item per File outbound account (a campaign cannot read memberships there, so the item is the account); nothing removed before the close; at close the revoked person's provisioning entry is `DEPROVISIONED` (outcome `already-gone`: the target keeps no account), the kept ones stay `SYNCED`, the file is unchanged; timeline and audit (`access_review.account_revoked`); an access review exclusion of the account against the Sales policy, which then grants that person nothing (`access_review.exclusion_created`) |
| 4. Leaver | Next scheduled sync with `Status: Terminated` | Leaver detection under the default policy (one leaver, within the floor of 2 per sync): one offboarding run, memo `leaver:terminated`, File outbound `not-applicable`, Golden Record soft-deleted, leaver event and offboarding record, timeline, audit; the same export again starts nothing |
| 5. Joiner under the limit | The pipeline paused, a sync with one new hire; then resumed and the next sync | Paused: the new hire is recorded and waits, nothing starts. Resumed: the sync starts his onboarding itself (1 is within the allowance of 2), actor `system:hr-sync`, no batch; his File outbound line, `SYNCED` entry, joiner timeline and audit; the same export again starts nothing |
| 6. Rehire | The stage 4 leaver active again in HR with a start date after the deletion | The sync revives the same identity (not deleted, same id) and onboards her as a joiner at once; delivered to File outbound again; a second joiner event with `rehiredAt` next to the first hire's; timeline "Rehired in the csv-hr sync."; the same export again starts nothing |

Every stage also checks that the dead-letter queue stayed empty: no event handler failed and no event payload was refused.

Plan 2.8a: stage 1 also asserts each joiner's timeline ("Created via csv-hr", "Onboarding started by HR sync", "Policy evaluated", "Provisioned to file-outbound") and that `identity.created`, `policy.evaluated` and `provisioning.completed` are audited under the identity id with no email in the entry; stages 2, 3 and 4 expect those entries first, and stage 5 asserts the same four for its new hire.

Not asserted, reported for a decision: the mover cannot change File outbound access.

### 6. Redis backends (`test/infrastructure/redis-backends.e2e-spec.ts`)

`RedisModule` on a real Redis, checked with a second client of the test's own: the Nest cache, the owned locks and the security state are written to Redis, a one-time value goes to exactly one of many simultaneous takes, concurrent increments count in one window that Redis expires, the security state store rejects reads and writes while Redis cannot be reached (it fails closed), and the startup check refuses a cache that is not in Redis (7 tests).

No gate runs this suite. It is skipped unless `REDIS_TEST_URL` is set, and the `pre-push` hook sets only `TEMPORAL_E2E=1`. Run it by hand after a change to `src/infrastructure/cache/`, against a throwaway Redis (the test touches only keys under a random prefix of its own):

```bash
docker run -d --rm --name euroid-test-redis -p 127.0.0.1:6390:6379 redis:7-alpine
REDIS_TEST_URL=redis://127.0.0.1:6390 npm run test:e2e -- test/infrastructure/redis-backends.e2e-spec.ts
docker stop euroid-test-redis
```

Last run on 2026-11-24 with `redis:7-alpine`: 7 of 7 passed.

### 7. Neo4j access explorer (`src/modules/access-explorer/access-explorer.neo4j.integration.spec.ts`)

The access explorer on a real Neo4j with the tenant's state in the in-memory MongoDB (14 tests). `GraphResyncService` fills the graph from MongoDB and removes what MongoDB no longer has for the tenant while other tenants stay untouched; the four explorer queries answer from what it wrote (`LIMIT` as an integer, `OPTIONAL MATCH` answers for missing nodes, `shortestPath` with a missing end). `GraphSyncService` names an entitlement and its application from `discovery.completed` and removes a deleted identity's node and edges in its tenant only; a `GraphService` whose first connection attempt fails (a closed port) connects on a later call. A group most identities get from a role-based rule that names it by display name is one node, the catalog's (native id): its holders by rule and by request, the path to it and an SoD policy naming it by display name answer on that node, the resync removes the node the old key made, and provisioning that names it by display name links and unlinks there. Policy evaluation is stubbed.

No gate runs this suite. It is part of `npm test` but skipped unless `NEO4J_TEST_URL` is set. `NEO4J_TEST_PASSWORD` is the password and `NEO4J_TEST_USER` the user (default `neo4j`). Run it by hand after a change to the graph code (`src/infrastructure/graph/`, `src/modules/access-explorer/`) against a throwaway Neo4j 5; the test touches only nodes of its own random tenants and removes them at the end.

```bash
NEO4J_TEST_URL=bolt://127.0.0.1:7697 NEO4J_TEST_PASSWORD=<password> \
  npx jest src/modules/access-explorer/access-explorer.neo4j.integration.spec.ts
```

Last run on 2026-11-25 with `neo4j:5`: 14 of 14 passed.

---

## Configuration

### Jest Config (`jest.config.ts`)

Key settings:

| Setting | Value | Why |
|---------|-------|-----|
| `globalSetup`, `globalTeardown` | `test/mongo-global-setup.ts`, `test/mongo-global-teardown.ts` | One in-memory MongoDB per run (In-Memory Database above); `test/jest-e2e.json` uses them too |
| `testTimeout` | `30000` (30s) | Room for slow integration suites |
| `maxWorkers` | `2` | Prevent OOM |
| `workerIdleMemoryLimit` | `512MB` | Kill workers that leak memory |
| `testRegex` | `.*\\.spec\\.ts$` | Matches all `.spec.ts` files |

### E2E Config (`test/jest-e2e.json`)

`maxWorkers` is `2` here as well. A Temporal workflow e2e worker (`TEMPORAL_E2E=1`) is much heavier than a unit test worker: on the full suite two workers together peaked at about 3.7 GB RSS (measured 2026-11-23). Without the cap Jest starts one worker per CPU core minus one, which can run a development machine out of memory. A `--maxWorkers` flag on the command line still overrides the config value.

### Coverage Thresholds

Enforced in `jest.config.ts` (`npm run test:cov`): each floor is the measured coverage rounded down to a whole percent, minus 2 points, so coverage can dip a little but not fall far unnoticed:

```
branches:   63%
functions:  75%
lines:      79%
statements: 78%
```

Measured 2026-11-25 on `main` = `919db006` with `npx jest --coverage` (402 suites passed and 1 skipped, 4216 tests passed and 9 skipped): statements 80.67%, branches 65.76%, functions 77.85%, lines 81.16%. Raise a floor the same way when coverage grows; never lower one to get a run through.

The frontend's floors are in `frontend/vitest.config.ts` (`npm run test:coverage` in `frontend/`), set the same way from `npx vitest run --coverage` on the same tree (136 files, 824 tests passed): statements 79.21%, branches 66.26%, functions 75.87%, lines 81.31%, so floors of 77, 64, 73 and 79. Vitest's v8 coverage counts only the files a test loads (336 of the 381 source files that day).

Coverage excludes: `*.module.ts`, `main.ts`, `worker.ts`.

### Path Aliases

Tests use the same aliases as source code:

| Alias | Maps to |
|-------|---------|
| `@infrastructure/*` | `src/infrastructure/*` |
| `@shared/*` | `src/shared/*` |
| `@modules/*` | `src/modules/*` |
| `@testing` / `@testing/*` | `src/testing/index.ts` / `src/testing/*` |

---

## Known Issues

### `jose` ESM Compatibility

The `jose` library is ESM-only. Jest (CommonJS) cannot parse it directly.

**Solution:** A mock at `backend/__mocks__/jose.ts` provides CJS-compatible stubs for `jwtVerify`, `SignJWT`, and `createRemoteJWKSet`. Mapped in jest config:

```typescript
moduleNameMapper: {
  '^jose$': '<rootDir>/__mocks__/jose.ts',
}
```

The mock produces structurally valid JWTs (3-segment base64url) so tests can inspect token structure.

It checks the signature, issuer and audience but not `exp`, `nbf` or `alg`. A spec that tests what a token check refuses (an expired token, `alg: none`) loads the real library instead: `jest.mock('jose', () => jest.requireActual('@testing/real-jose').loadRealJose())` (`src/testing/real-jose.ts`; Node's own `require` of the ESM build, outside Jest's module registry). Examples: `src/infrastructure/auth/auth-guards.http.spec.ts`, `src/modules/auth/mfa.service.spec.ts`.

### Tenant Scoping

All database operations in tests **must** be wrapped in `withTestTenant()`. Without it, the Mongoose tenant plugin injects `undefined` as `tenantId`, and queries return no results.

```typescript
// Wrong — will silently return empty results
const result = await service.findAll();

// Correct
const result = await withTestTenant(() => service.findAll());
```

### Memory Pressure

`mongodb-memory-server` downloads and runs a real MongoDB binary, one instance per jest run (its peak RSS was about 370 MB over a full backend run, measured 2026-11-24). Both Jest configs (`jest.config.ts`, `test/jest-e2e.json`) cap workers at 2, so no `--maxWorkers` flag is needed. If tests OOM:

1. Use `npm run test:cov:safe` (runs with `--runInBand` — single worker)
2. Ensure `workerIdleMemoryLimit: '512MB'` is set in jest config

---

## File Inventory

| File | Purpose |
|------|---------|
| `jest.config.ts` | Main Jest configuration |
| `__mocks__/jose.ts` | ESM compatibility mock for JWT library |
| `src/testing/index.ts` | Re-exports all test helpers |
| `src/testing/test-helpers.ts` | NestJS module setup, tenant context, logger mocks |
| `src/testing/mock-factories.ts` | Realistic DTO/schema factories |
| `src/testing/test-db.ts` | A database per suite on the run's in-memory MongoDB |
| `src/testing/real-jose.ts` | The real `jose` for specs that test token checks (see Known Issues) |
| `test/jest-e2e.json` | E2E test runner config |
| `test/mongo-global-setup.ts`, `test/mongo-global-teardown.ts` | Start and stop the run's in-memory MongoDB; remove what crashed runs left in `/tmp` |
| `test/helpers/workflow-test-env.ts` | Temporal workflow e2e harness: test server (cached binary), workers, `describeTemporalE2E` |
| `test/helpers/test-payload-codec.ts` | The harness's payload codec (the production codec under a test key), `decryptedHistory()` |
| `test/workflows/jml-end-to-end.workflow.e2e-spec.ts` | The joiner, mover, leaver story on the real modules and activities |
| `test/fixtures/simulation-fixture.ts` | Policy simulation test data |
