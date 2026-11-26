/**
 * Graph Service — Neo4j Connection Manager
 *
 * Manages the Neo4j driver lifecycle and provides query execution methods.
 * runQuery, runWriteQuery and healthCheck are fail-open (empty results / false when Neo4j is
 * unavailable) for the event sync and the health check. readStrict, writeStrict and
 * assertAvailable are for callers that must not answer from a graph that knows nothing (the access
 * explorer, the graph resync): they throw 503 with GRAPH_UNAVAILABLE instead.
 *
 * A process that could not connect (Neo4j not up yet when it started) tries again on a later call
 * (a query, the health check, the readiness probe's connectionState), at most once per
 * NEO4J_RECONNECT_INTERVAL_MS (30 s by default) and one attempt at a time. No call waits for the
 * attempt: until it succeeds the strict calls answer 503 and the fail-open ones answer empty.
 *
 * A connected process that loses Neo4j: a query or health check that cannot reach it (the
 * driver's ServiceUnavailable or SessionExpired) marks the graph lost, and the readiness probe's
 * connectionState says not-connected until a query reaches Neo4j again or a connectivity check
 * succeeds. connectionState starts that check at most once per NEO4J_RECONNECT_INTERVAL_MS,
 * also while connected (so a loss without graph traffic shows too), and never awaits it, so the
 * probe never waits for Neo4j. Queries keep going to the driver, which reconnects on its own.
 *
 * Each connection creates the node uniqueness constraints the MERGEs rely on, if they are not
 * there yet (graph-constraints.ts); one it cannot create is logged and the graph stays in use.
 */
import {
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import neo4j, { Driver, Session, Record as Neo4jRecord } from 'neo4j-driver';
import { ensureNodeConstraints } from './graph-constraints';

export interface CypherResult {
  records: Neo4jRecord[];
}

/** Builds the driver for a connection attempt; tests provide a fake one. */
export type Neo4jDriverFactory = (url: string, user: string, password: string) => Driver;
export const NEO4J_DRIVER_FACTORY = 'NEO4J_DRIVER_FACTORY';

const createNeo4jDriver: Neo4jDriverFactory = (url, user, password) =>
  neo4j.driver(url, neo4j.auth.basic(user, password), {
    maxConnectionPoolSize: 50,
    connectionAcquisitionTimeout: 5000,
    connectionTimeout: 5000,
  });

/** NEO4J_RECONNECT_INTERVAL_MS when unset: the least time between two connection attempts. */
export const DEFAULT_RECONNECT_INTERVAL_MS = 30_000;

/** The graph for the readiness probe: ok (connected), not-connected (configured) or not-configured. */
export type GraphConnectionState = 'ok' | 'not-connected' | 'not-configured';

/** Driver error codes that mean Neo4j cannot be reached, not that the query is wrong. */
const CONNECTION_ERROR_CODES: ReadonlySet<string> = new Set([
  neo4j.error.SERVICE_UNAVAILABLE,
  neo4j.error.SESSION_EXPIRED,
]);

const isConnectionError = (error: unknown): boolean =>
  CONNECTION_ERROR_CODES.has(String((error as { code?: unknown } | null)?.code ?? ''));

const RESYNC_HINT =
  'then loads the graph from MongoDB with POST /api/v1/access-explorer/resync (super-admin).';

/** The 503 messages of the strict calls: what is wrong and what to do. */
export const GRAPH_UNAVAILABLE = {
  notConfigured:
    'The access graph is not available: Neo4j is not configured on the API (NEO4J_PASSWORD is ' +
    'empty). An administrator sets NEO4J_URL, NEO4J_USER and NEO4J_PASSWORD, restarts the API ' +
    `and ${RESYNC_HINT}`,
  notConnected:
    'The access graph is not available: the API is not connected to Neo4j. It connects on its ' +
    'own once Neo4j answers, trying again at most every NEO4J_RECONNECT_INTERVAL_MS (30 s by ' +
    'default). An administrator checks that Neo4j is running and reachable from the API (the ' +
    'API log has the cause) and tries again in a moment; after an outage a super-admin loads the ' +
    'graph from MongoDB with POST /api/v1/access-explorer/resync.',
  queryFailed:
    'The access graph is not available: the Neo4j query failed. Check that Neo4j is running and ' +
    'reachable from the API (the API log has the cause), then try again.',
} as const;

@Injectable()
export class GraphService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GraphService.name);
  private driver: Driver | null = null;
  /** The connection attempt running, if any: one at a time. */
  private connecting: Promise<void> | null = null;
  /** When the last connection attempt started (Date.now()), null before the first. */
  private lastAttemptAt: number | null = null;
  private destroyed = false;
  /** A call could not reach Neo4j through the driver; cleared by a call or check that does. */
  private connectionLost = false;
  /** The connectivity check connectionState started, if any: one at a time. */
  private checking: Promise<void> | null = null;
  /** When the connection was made, marked lost or last checked (Date.now()). */
  private lastCheckAt = 0;

  private readonly url: string;
  private readonly user: string;
  private readonly password: string;
  private readonly reconnectIntervalMs: number;
  private readonly createDriver: Neo4jDriverFactory;

  constructor(
    private readonly configService: ConfigService,
    @Optional() @Inject(NEO4J_DRIVER_FACTORY) driverFactory?: Neo4jDriverFactory,
  ) {
    this.url = this.configService.get<string>('NEO4J_URL') ?? 'bolt://localhost:7687';
    this.user = this.configService.get<string>('NEO4J_USER') ?? 'neo4j';
    this.password = this.configService.get<string>('NEO4J_PASSWORD') ?? '';
    this.reconnectIntervalMs = this.configuredInterval();
    this.createDriver = driverFactory ?? createNeo4jDriver;
  }

  async onModuleInit(): Promise<void> {
    if (!this.password) {
      this.logger.warn(
        'NEO4J_PASSWORD not set. Graph service will operate in fail-open mode ' +
          '(all queries return empty results).',
      );
      return;
    }
    await this.connect();
  }

  async onModuleDestroy(): Promise<void> {
    this.destroyed = true;
    if (this.connecting) await this.connecting;
    if (this.driver) {
      await this.driver.close();
      this.driver = null;
      this.logger.log('Neo4j driver closed');
    }
  }

  /** The graph's state now, without waiting for Neo4j; starts a connection attempt when one is due. */
  connectionState(): GraphConnectionState {
    if (!this.password) return 'not-configured';
    const driver = this.currentDriver();
    if (!driver) return 'not-connected';
    this.checkConnectionIfDue(driver);
    return this.connectionLost ? 'not-connected' : 'ok';
  }

  /**
   * Check if Neo4j is available. Fail-open: returns false if unavailable.
   */
  async healthCheck(): Promise<boolean> {
    const driver = this.currentDriver();
    if (!driver) return false;

    try {
      await driver.verifyConnectivity();
      this.markReached();
      return true;
    } catch (error: unknown) {
      this.markLostIf(error);
      return false;
    }
  }

  /**
   * Execute a read-only Cypher query with automatic session management.
   * Returns empty result set if Neo4j is unavailable.
   */
  async runQuery(cypher: string, params: Record<string, unknown> = {}): Promise<CypherResult> {
    const driver = this.currentDriver();
    if (!driver) {
      this.logger.debug('Neo4j unavailable — returning empty result for read query');
      return { records: [] };
    }

    let session: Session | null = null;
    try {
      session = driver.session({ defaultAccessMode: neo4j.session.READ });
      const result = await session.run(cypher, params);
      this.markReached();
      return { records: result.records };
    } catch (error: unknown) {
      this.markLostIf(error);
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Neo4j read query failed: ${message}`);
      return { records: [] };
    } finally {
      if (session) {
        await session.close();
      }
    }
  }

  /**
   * Creates the node uniqueness constraints that are not there yet (graph-constraints.ts); one
   * that fails is logged with what to do. Nothing without a connection: the next one creates them.
   */
  async ensureNodeConstraints(): Promise<void> {
    if (this.driver) await ensureNodeConstraints(this.driver, this.logger);
  }

  /** Throws the 503 of GRAPH_UNAVAILABLE when there is no driver (not configured or not connected). */
  assertAvailable(): void {
    this.requireDriver();
  }

  /**
   * A read for callers that must not read "nothing" from a missing graph: 503 when Neo4j is not
   * configured, not connected or the query fails (the cause goes to the log, not to the caller).
   */
  async readStrict(cypher: string, params: Record<string, unknown> = {}): Promise<CypherResult> {
    return this.runStrict('READ', cypher, params);
  }

  /** A write in a write transaction that fails like readStrict instead of being skipped. */
  async writeStrict(cypher: string, params: Record<string, unknown> = {}): Promise<CypherResult> {
    return this.runStrict('WRITE', cypher, params);
  }

  private requireDriver(): Driver {
    const driver = this.currentDriver();
    if (driver) return driver;
    throw new ServiceUnavailableException(
      this.password ? GRAPH_UNAVAILABLE.notConnected : GRAPH_UNAVAILABLE.notConfigured,
    );
  }

  private async runStrict(
    mode: 'READ' | 'WRITE',
    cypher: string,
    params: Record<string, unknown>,
  ): Promise<CypherResult> {
    const driver = this.requireDriver();
    let session: Session | null = null;
    try {
      session = driver.session({
        defaultAccessMode: mode === 'READ' ? neo4j.session.READ : neo4j.session.WRITE,
      });
      const result =
        mode === 'READ'
          ? await session.run(cypher, params)
          : await session.executeWrite((tx) => tx.run(cypher, params));
      this.markReached();
      return { records: result.records };
    } catch (error: unknown) {
      this.markLostIf(error);
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Neo4j ${mode.toLowerCase()} query failed: ${message}`);
      throw new ServiceUnavailableException(GRAPH_UNAVAILABLE.queryFailed);
    } finally {
      if (session) {
        await session.close();
      }
    }
  }

  /**
   * Execute a write Cypher query within a write transaction.
   * Returns empty result set if Neo4j is unavailable.
   */
  async runWriteQuery(cypher: string, params: Record<string, unknown> = {}): Promise<CypherResult> {
    const driver = this.currentDriver();
    if (!driver) {
      this.logger.debug('Neo4j unavailable — skipping write query');
      return { records: [] };
    }

    let session: Session | null = null;
    try {
      session = driver.session({ defaultAccessMode: neo4j.session.WRITE });
      const result = await session.executeWrite(async (tx) => {
        return tx.run(cypher, params);
      });
      this.markReached();
      return { records: result.records };
    } catch (error: unknown) {
      this.markLostIf(error);
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Neo4j write query failed: ${message}`);
      return { records: [] };
    } finally {
      if (session) {
        await session.close();
      }
    }
  }

  /** A call that could not reach Neo4j marks the connection lost (the readiness probe reports it). */
  private markLostIf(error: unknown): void {
    if (!isConnectionError(error) || this.connectionLost) return;
    this.connectionLost = true;
    this.lastCheckAt = Date.now();
    this.logger.warn(
      `Lost the connection to Neo4j at ${this.url}: the readiness probe reports the graph ` +
        'not-connected until a query reaches it again or a check succeeds (at most every ' +
        `${this.reconnectIntervalMs / 1000} s).`,
    );
  }

  /** A call that reached Neo4j clears a lost connection. */
  private markReached(): void {
    if (!this.connectionLost) return;
    this.connectionLost = false;
    this.logger.log(`Neo4j at ${this.url} answers again`);
  }

  /** Checks the connection when a check is due: one at a time, not awaited, never rejects. */
  private checkConnectionIfDue(driver: Driver): void {
    if (this.checking || this.destroyed) return;
    if (Date.now() - this.lastCheckAt < this.reconnectIntervalMs) return;
    this.lastCheckAt = Date.now();
    this.checking = driver
      .verifyConnectivity()
      .then(
        () => this.markReached(),
        (error: unknown) => this.markLostIf(error),
      )
      .finally(() => {
        this.checking = null;
      });
  }

  /** The driver; while there is none, starts a connection attempt when one is due (not awaited). */
  private currentDriver(): Driver | null {
    if (!this.driver) this.reconnectIfDue();
    return this.driver;
  }

  private reconnectIfDue(): void {
    if (!this.password || this.destroyed || this.connecting) return;
    const sinceLast = this.lastAttemptAt === null ? Infinity : Date.now() - this.lastAttemptAt;
    if (sinceLast < this.reconnectIntervalMs) return;
    void this.connect();
  }

  /** One connection attempt. It never rejects: a failure is logged and its driver closed. */
  private connect(): Promise<void> {
    this.lastAttemptAt = Date.now();
    this.connecting = this.attemptConnection().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async attemptConnection(): Promise<void> {
    let driver: Driver | undefined;
    try {
      driver = this.createDriver(this.url, this.user, this.password);
      await driver.verifyConnectivity();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Failed to connect to Neo4j at ${this.url}: ${message}. The access explorer answers 503 ` +
          'and the event sync skips its writes until a connection succeeds; the next attempt ' +
          `starts with a graph call at least ${this.reconnectIntervalMs / 1000} s from now.`,
      );
      await driver?.close().catch(() => undefined);
      return;
    }
    if (this.destroyed) {
      await driver.close();
      return;
    }
    this.driver = driver;
    this.lastCheckAt = Date.now();
    this.logger.log(`Connected to Neo4j at ${this.url}`);
    await this.ensureNodeConstraints();
  }

  /** NEO4J_RECONNECT_INTERVAL_MS in milliseconds; the default when unset or not a number >= 0. */
  private configuredInterval(): number {
    const value = this.configService.get<string | number>('NEO4J_RECONNECT_INTERVAL_MS');
    if (value === undefined || value === null || value === '') return DEFAULT_RECONNECT_INTERVAL_MS;
    const ms = Number(value);
    if (Number.isFinite(ms) && ms >= 0) return ms;
    this.logger.warn(
      `NEO4J_RECONNECT_INTERVAL_MS "${value}" is not a number of milliseconds; ` +
        `using ${DEFAULT_RECONNECT_INTERVAL_MS}.`,
    );
    return DEFAULT_RECONNECT_INTERVAL_MS;
  }
}
