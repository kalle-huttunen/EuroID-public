/**
 * GraphService: the fail-open reads and writes (health check, event sync) answer empty when Neo4j
 * is missing or a query fails; the strict ones (the access explorer and the graph resync) answer
 * 503 with what is wrong and what to do, so no caller reads "no access" from a graph that knows
 * nothing. A process that could not connect tries again on a later call, at most once per
 * NEO4J_RECONNECT_INTERVAL_MS, and no call waits for that attempt.
 *
 * Each connection creates the uniqueness constraints on (tenantId, id) of the node labels the
 * MERGEs write, if not there yet: before, nothing created an index or constraint, so every MERGE
 * scanned its label and two at once could write one node twice (FOLLOWUPS 2026-11-25). The
 * statements run against a real Neo4j in access-explorer.neo4j.integration.spec.ts.
 */
import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Driver } from 'neo4j-driver';
import { GRAPH_UNAVAILABLE, GraphService, type Neo4jDriverFactory } from './graph.service';
import { DUPLICATES_HINT } from './graph-constraints';

function serviceWith(env: Record<string, string>, factory?: Neo4jDriverFactory): GraphService {
  const config = { get: (key: string) => env[key] } as unknown as ConfigService;
  return new GraphService(config, factory);
}

/**
 * A driver factory for a Neo4j that answers while `neo4j.reachable` is true (checked when the
 * driver verifies its connection); `neo4j.gate` holds that check until it resolves. Each driver
 * it built is in `drivers`, answering every query with the record 'row'.
 */
function fakeNeo4j() {
  const neo4j = { reachable: false, gate: null as Promise<void> | null };
  const drivers: Array<{ verifyConnectivity: jest.Mock; close: jest.Mock; session: jest.Mock }> =
    [];
  const factory = jest.fn((_url: string, _user: string, _password: string) => {
    const driver = {
      ...fakeDriver(['row']).driver,
      verifyConnectivity: jest.fn(async () => {
        if (neo4j.gate) await neo4j.gate;
        if (!neo4j.reachable) throw new Error('ServiceUnavailable: connect ECONNREFUSED');
      }),
      close: jest.fn(async () => undefined),
    };
    drivers.push(driver);
    return driver as unknown as Driver;
  });
  return { neo4j, drivers, factory };
}

/** Lets a connection attempt that no call waits for finish. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

/** A connected driver whose sessions answer `run` with these records, or reject with `fail`. */
function fakeDriver(records: unknown[], fail?: Error) {
  const run = jest.fn(async () => {
    if (fail) throw fail;
    return { records };
  });
  const session = {
    run,
    executeWrite: jest.fn(async (work: (tx: { run: typeof run }) => unknown) => work({ run })),
    close: jest.fn(async () => undefined),
  };
  return { driver: { session: jest.fn(() => session) }, session, run };
}

const withDriver = (service: GraphService, driver: unknown) => {
  (service as unknown as { driver: unknown }).driver = driver;
};

async function rejection(promise: Promise<unknown>): Promise<ServiceUnavailableException> {
  try {
    await promise;
  } catch (error) {
    return error as ServiceUnavailableException;
  }
  throw new Error('expected the call to reject');
}

describe('GraphService', () => {
  describe('without NEO4J_PASSWORD (not configured, the default)', () => {
    const service = serviceWith({});

    beforeAll(async () => {
      await service.onModuleInit();
    });

    it('answers a strict read with 503 that says Neo4j is not configured and how to fill it', async () => {
      const error = await rejection(service.readStrict('MATCH (n) RETURN n'));

      expect(error).toBeInstanceOf(ServiceUnavailableException);
      expect(error.getStatus()).toBe(503);
      expect(error.message).toBe(GRAPH_UNAVAILABLE.notConfigured);
      expect(error.message).toContain('NEO4J_PASSWORD');
      expect(error.message).toContain('POST /api/v1/access-explorer/resync');
    });

    it('answers a strict write and the availability check with the same 503', async () => {
      expect((await rejection(service.writeStrict('CREATE (n)'))).message).toBe(
        GRAPH_UNAVAILABLE.notConfigured,
      );
      expect(() => service.assertAvailable()).toThrow(GRAPH_UNAVAILABLE.notConfigured);
    });

    it('keeps the fail-open reads, writes and health check of the other callers', async () => {
      await expect(service.runQuery('MATCH (n) RETURN n')).resolves.toEqual({ records: [] });
      await expect(service.runWriteQuery('CREATE (n)')).resolves.toEqual({ records: [] });
      await expect(service.healthCheck()).resolves.toBe(false);
    });

    it('never builds a driver, and its state says not configured', async () => {
      const { factory } = fakeNeo4j();
      const unconfigured = serviceWith({}, factory);
      await unconfigured.onModuleInit();

      await rejection(unconfigured.readStrict('MATCH (n) RETURN n'));
      expect(unconfigured.connectionState()).toBe('not-configured');
      expect(factory).not.toHaveBeenCalled();
    });
  });

  describe('configured, but Neo4j not reachable when the process started', () => {
    let now: number;

    beforeEach(() => {
      now = 1_000_000;
      jest.spyOn(Date, 'now').mockImplementation(() => now);
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('answers 503 that says the API is not connected yet and connects on its own', async () => {
      const { factory } = fakeNeo4j();
      const service = serviceWith({ NEO4J_PASSWORD: 'set' }, factory);
      await service.onModuleInit();

      const error = await rejection(service.readStrict('MATCH (n) RETURN n'));

      expect(error.getStatus()).toBe(503);
      expect(error.message).toBe(GRAPH_UNAVAILABLE.notConnected);
      expect(error.message).toContain('NEO4J_RECONNECT_INTERVAL_MS');
      expect(error.message).not.toContain('restart');
    });

    it('tries again on a call once the interval has passed, and that call does not wait for it', async () => {
      const { neo4j, drivers, factory } = fakeNeo4j();
      const service = serviceWith(
        { NEO4J_PASSWORD: 'set', NEO4J_RECONNECT_INTERVAL_MS: '30000' },
        factory,
      );
      await service.onModuleInit();
      expect(factory).toHaveBeenCalledTimes(1);
      // The driver that could not connect is closed, not kept or leaked
      expect(drivers[0].close).toHaveBeenCalled();
      expect(service.connectionState()).toBe('not-connected');

      now += 29_999;
      neo4j.reachable = true;
      await rejection(service.readStrict('MATCH (n) RETURN n'));
      await expect(service.runWriteQuery('CREATE (n)')).resolves.toEqual({ records: [] });
      expect(factory).toHaveBeenCalledTimes(1);

      now += 1;
      const error = await rejection(service.readStrict('MATCH (n) RETURN n'));
      expect(error.message).toBe(GRAPH_UNAVAILABLE.notConnected);
      expect(factory).toHaveBeenCalledTimes(2);

      await settle();
      await expect(service.readStrict('MATCH (n) RETURN n')).resolves.toEqual({
        records: ['row'],
      });
      await expect(service.runWriteQuery('CREATE (n)')).resolves.toEqual({ records: ['row'] });
      expect(service.connectionState()).toBe('ok');
      expect(drivers[1].close).not.toHaveBeenCalled();
      expect(factory).toHaveBeenCalledTimes(2);
    });

    it('runs one attempt at a time, and calls during it answer at once', async () => {
      const { neo4j, factory } = fakeNeo4j();
      const service = serviceWith(
        { NEO4J_PASSWORD: 'set', NEO4J_RECONNECT_INTERVAL_MS: '0' },
        factory,
      );
      await service.onModuleInit();
      let open!: () => void;
      neo4j.gate = new Promise<void>((resolve) => (open = resolve));
      neo4j.reachable = true;

      // The health check and the readiness state start an attempt like a query does
      await expect(service.healthCheck()).resolves.toBe(false);
      expect((await rejection(service.readStrict('MATCH (n) RETURN n'))).message).toBe(
        GRAPH_UNAVAILABLE.notConnected,
      );
      await expect(service.runQuery('MATCH (n) RETURN n')).resolves.toEqual({ records: [] });
      expect(service.connectionState()).toBe('not-connected');
      expect(factory).toHaveBeenCalledTimes(2);

      open();
      await settle();
      expect(service.connectionState()).toBe('ok');
      await expect(service.healthCheck()).resolves.toBe(true);
    });

    it('waits 30 s between attempts when NEO4J_RECONNECT_INTERVAL_MS is unset or not a number', async () => {
      const envs: Array<Record<string, string>> = [{}, { NEO4J_RECONNECT_INTERVAL_MS: 'soon' }];
      for (const env of envs) {
        const { factory } = fakeNeo4j();
        const service = serviceWith({ NEO4J_PASSWORD: 'set', ...env }, factory);
        await service.onModuleInit();

        now += 29_999;
        service.connectionState();
        expect(factory).toHaveBeenCalledTimes(1);
        now += 1;
        service.connectionState();
        expect(factory).toHaveBeenCalledTimes(2);
        await settle();
      }
    });

    it('stops trying once the module is destroyed', async () => {
      const { factory } = fakeNeo4j();
      const service = serviceWith(
        { NEO4J_PASSWORD: 'set', NEO4J_RECONNECT_INTERVAL_MS: '0' },
        factory,
      );
      await service.onModuleInit();
      await service.onModuleDestroy();

      await rejection(service.readStrict('MATCH (n) RETURN n'));
      expect(factory).toHaveBeenCalledTimes(1);
    });
  });

  describe('node uniqueness constraints', () => {
    const CONSTRAINTS = ['Identity', 'Entitlement', 'Application'].map(
      (label) =>
        `CREATE CONSTRAINT ${label.toLowerCase()}_tenant_id_unique IF NOT EXISTS ` +
        `FOR (n:${label}) REQUIRE (n.tenantId, n.id) IS UNIQUE`,
    );

    /** A reachable Neo4j whose constraint statement for `failing` rejects with `error`. */
    function neo4jWith(failing?: string, error?: Error) {
      const run = jest.fn(async (cypher: string) => {
        if (failing && cypher.includes(`(n:${failing})`)) throw error;
        return { records: [] };
      });
      const sessions: Array<{ close: jest.Mock }> = [];
      const driver = {
        verifyConnectivity: jest.fn(async () => undefined),
        close: jest.fn(async () => undefined),
        session: jest.fn(() => {
          const session = { run, close: jest.fn(async () => undefined) };
          sessions.push(session);
          return session;
        }),
      };
      return { driver, run, sessions, factory: () => driver as unknown as Driver };
    }

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('creates one per node label on (tenantId, id) when it connects, if not there yet', async () => {
      const { driver, run, sessions, factory } = neo4jWith();
      const service = serviceWith({ NEO4J_PASSWORD: 'set' }, factory);

      await service.onModuleInit();

      expect(run.mock.calls.map(([cypher]) => cypher)).toEqual(CONSTRAINTS);
      expect(driver.session).toHaveBeenCalledWith({ defaultAccessMode: 'WRITE' });
      expect(sessions.every((session) => session.close.mock.calls.length === 1)).toBe(true);
      expect(service.connectionState()).toBe('ok');
    });

    it('logs one it cannot create with what to do, creates the others and stays connected', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const duplicates = new Error(
        'Unable to create Constraint( name=identity_tenant_id_unique ): Both Node(4) and ' +
          "Node(9) have the label `Identity` and properties `tenantId` = 't1', `id` = 'x'",
      );
      const { run, factory } = neo4jWith('Identity', duplicates);
      const service = serviceWith({ NEO4J_PASSWORD: 'set' }, factory);

      await service.onModuleInit();

      expect(run).toHaveBeenCalledTimes(3);
      expect(warn).toHaveBeenCalledTimes(1);
      const [logged] = warn.mock.calls[0] as [string];
      expect(logged).toContain('(:Identity)');
      expect(logged).toContain(duplicates.message);
      expect(logged).toContain(DUPLICATES_HINT);
      expect(DUPLICATES_HINT).toContain('POST /api/v1/access-explorer/resync');
      expect(service.connectionState()).toBe('ok');
      await expect(service.readStrict('MATCH (n) RETURN n')).resolves.toEqual({ records: [] });
    });

    it('runs again on request (after a resync), and does nothing without a connection', async () => {
      const { run, factory } = neo4jWith();
      const service = serviceWith({ NEO4J_PASSWORD: 'set' }, factory);
      await service.onModuleInit();

      await service.ensureNodeConstraints();
      expect(run).toHaveBeenCalledTimes(6);

      const unconfigured = serviceWith({});
      await expect(unconfigured.ensureNodeConstraints()).resolves.toBeUndefined();
    });
  });

  // connectionState() said ok whenever a driver existed, so /health/ready reported the graph ok
  // for 40 s and more after Neo4j stopped while every graph view answered 503 (browser check
  // 2026-11-25). A query that fails because Neo4j cannot be reached now marks the graph
  // not connected until a check (at most once per NEO4J_RECONNECT_INTERVAL_MS) or a query
  // succeeds; the readiness probe itself never waits for Neo4j.
  describe('connection lost after connecting', () => {
    let now: number;

    beforeEach(() => {
      now = 1_000_000;
      jest.spyOn(Date, 'now').mockImplementation(() => now);
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    /** A Neo4j that answers while `neo4j.up`; down, every call fails as the driver reports it. */
    function liveNeo4j() {
      const neo4j = { up: true };
      const unreachable = () =>
        Object.assign(new Error('Failed to connect to server bolt://10.0.0.7:7687'), {
          code: 'ServiceUnavailable',
        });
      const run = jest.fn(async () => {
        if (!neo4j.up) throw unreachable();
        return { records: ['row'] };
      });
      const session = {
        run,
        executeWrite: jest.fn(async (work: (tx: { run: typeof run }) => unknown) => work({ run })),
        close: jest.fn(async () => undefined),
      };
      const driver = {
        session: jest.fn(() => session),
        verifyConnectivity: jest.fn(async () => {
          if (!neo4j.up) throw unreachable();
        }),
        close: jest.fn(async () => undefined),
      };
      return { neo4j, driver, run, factory: jest.fn(() => driver as unknown as Driver) };
    }

    async function connected(interval = '30000') {
      const live = liveNeo4j();
      const service = serviceWith(
        { NEO4J_PASSWORD: 'set', NEO4J_RECONNECT_INTERVAL_MS: interval },
        live.factory,
      );
      await service.onModuleInit();
      expect(service.connectionState()).toBe('ok');
      live.driver.verifyConnectivity.mockClear();
      return { service, ...live };
    }

    it('reports not-connected once a query cannot reach Neo4j, without asking Neo4j per call', async () => {
      const { service, neo4j, driver } = await connected();

      neo4j.up = false;
      const error = await rejection(service.readStrict('MATCH (n) RETURN n'));
      expect(error.message).toBe(GRAPH_UNAVAILABLE.queryFailed);

      expect(service.connectionState()).toBe('not-connected');
      now += 29_999;
      expect(service.connectionState()).toBe('not-connected');
      expect(service.connectionState()).toBe('not-connected');
      expect(driver.verifyConnectivity).not.toHaveBeenCalled();
    });

    it('notices a loss without graph traffic: the probe checks a connected graph once per interval', async () => {
      const { service, neo4j, driver } = await connected();
      neo4j.up = false;

      now += 29_999;
      expect(service.connectionState()).toBe('ok');
      await settle();
      expect(driver.verifyConnectivity).not.toHaveBeenCalled();

      now += 1;
      expect(service.connectionState()).toBe('ok'); // the check starts, not awaited
      await settle();
      expect(driver.verifyConnectivity).toHaveBeenCalledTimes(1);
      expect(service.connectionState()).toBe('not-connected');
    });

    it('the fail-open read, write and health check mark it too', async () => {
      for (const call of [
        (s: GraphService) => s.runQuery('MATCH (n) RETURN n'),
        (s: GraphService) => s.runWriteQuery('CREATE (n)'),
        (s: GraphService) => s.healthCheck(),
      ]) {
        const { service, neo4j } = await connected();
        neo4j.up = false;
        await call(service);
        expect(service.connectionState()).toBe('not-connected');
      }
    });

    it('is ok again once a check succeeds, at most one check per interval and not awaited', async () => {
      const { service, neo4j, driver } = await connected();
      neo4j.up = false;
      await service.runQuery('MATCH (n) RETURN n');

      now += 30_000;
      expect(service.connectionState()).toBe('not-connected'); // check 1 starts, Neo4j still down
      await settle();
      expect(driver.verifyConnectivity).toHaveBeenCalledTimes(1);
      expect(service.connectionState()).toBe('not-connected');

      neo4j.up = true;
      now += 29_999;
      service.connectionState();
      await settle();
      expect(driver.verifyConnectivity).toHaveBeenCalledTimes(1);
      expect(service.connectionState()).toBe('not-connected');

      now += 1;
      service.connectionState(); // check 2
      await settle();
      expect(driver.verifyConnectivity).toHaveBeenCalledTimes(2);
      expect(service.connectionState()).toBe('ok');
    });

    it('is ok again at once when a query reaches Neo4j', async () => {
      const { service, neo4j } = await connected();
      neo4j.up = false;
      await service.runQuery('MATCH (n) RETURN n');
      expect(service.connectionState()).toBe('not-connected');

      neo4j.up = true;
      await expect(service.readStrict('MATCH (n) RETURN n')).resolves.toEqual({
        records: ['row'],
      });
      expect(service.connectionState()).toBe('ok');
    });

    it('stays ok when a query fails for another reason than reaching Neo4j', async () => {
      const { service, run } = await connected();
      run.mockRejectedValueOnce(
        Object.assign(new Error('Invalid input'), {
          code: 'Neo.ClientError.Statement.SyntaxError',
        }),
      );

      await rejection(service.readStrict('MATCH (n RETURN n'));

      expect(service.connectionState()).toBe('ok');
    });
  });

  describe('connected', () => {
    it('returns the records of a strict read and runs it in a read session', async () => {
      const service = serviceWith({ NEO4J_PASSWORD: 'set' });
      const { driver, session, run } = fakeDriver(['row']);
      withDriver(service, driver);

      await expect(service.readStrict('MATCH (n) RETURN n', { a: 1 })).resolves.toEqual({
        records: ['row'],
      });
      expect(driver.session).toHaveBeenCalledWith({ defaultAccessMode: 'READ' });
      expect(run).toHaveBeenCalledWith('MATCH (n) RETURN n', { a: 1 });
      expect(session.close).toHaveBeenCalled();
    });

    it('runs a strict write in a write transaction', async () => {
      const service = serviceWith({ NEO4J_PASSWORD: 'set' });
      const { driver, session } = fakeDriver(['row']);
      withDriver(service, driver);

      await expect(service.writeStrict('CREATE (n)')).resolves.toEqual({ records: ['row'] });
      expect(driver.session).toHaveBeenCalledWith({ defaultAccessMode: 'WRITE' });
      expect(session.executeWrite).toHaveBeenCalled();
    });

    it('answers a failed strict query with 503, without the driver error, and closes the session', async () => {
      const service = serviceWith({ NEO4J_PASSWORD: 'set' });
      const { driver, session } = fakeDriver([], new Error('ServiceUnavailable: bolt://10.0.0.7'));
      withDriver(service, driver);

      const error = await rejection(service.readStrict('MATCH (n) RETURN n'));

      expect(error.getStatus()).toBe(503);
      expect(error.message).toBe(GRAPH_UNAVAILABLE.queryFailed);
      expect(error.message).not.toContain('10.0.0.7');
      expect(session.close).toHaveBeenCalled();
    });

    it('still answers the fail-open read empty when the query fails', async () => {
      const service = serviceWith({ NEO4J_PASSWORD: 'set' });
      withDriver(service, fakeDriver([], new Error('boom')).driver);

      await expect(service.runQuery('MATCH (n) RETURN n')).resolves.toEqual({ records: [] });
    });
  });
});
