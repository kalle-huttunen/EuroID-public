import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Connection, Client } from '@temporalio/client';
import {
  TEMPORAL_ADDRESS,
  TEMPORAL_NAMESPACE,
  temporalReconnectDelays,
  temporalTlsConfig,
} from '../config/temporal.config';
import { EncryptionService } from '../secrets/encryption.service';
import { temporalDataConverter } from './temporal-payload-codec';

/**
 * Shared Temporal client provider. Single connection for all NestJS services.
 * Replaces 8 duplicate Connection.connect() + Client instances across the codebase.
 * Every payload it sends is encrypted, as the worker's are (temporal-payload-codec.ts).
 *
 * It connects at startup. When Temporal cannot be reached then, the API still starts, and the
 * first getClient() or isConnected() after the backoff delay starts a new connection attempt in
 * the background (one at a time); that call still answers "not connected", the calls after a
 * successful attempt get the client. The delay starts at TEMPORAL_RECONNECT_MIN_MS and doubles
 * after each failed attempt up to TEMPORAL_RECONNECT_MAX_MS. Once connected, the gRPC channel
 * reconnects on its own when Temporal restarts.
 */
@Injectable()
export class TemporalClientProvider implements OnModuleInit {
  private readonly logger = new Logger(TemporalClientProvider.name);
  private client: Client | null = null;
  private attempt: Promise<void> | null = null;
  private failedAttempts = 0;
  private nextAttemptAt = 0;

  constructor(private readonly encryption: EncryptionService) {}

  async onModuleInit(): Promise<void> {
    this.logger.log('Initializing shared Temporal Client connection...');
    await this.connect();
  }

  getClient(): Client {
    if (!this.client) {
      this.reconnectIfDue();
      throw new Error(
        `Temporal is not connected (${TEMPORAL_ADDRESS}). The API reconnects in the background; try again shortly.`,
      );
    }
    return this.client;
  }

  isConnected(): boolean {
    if (!this.client) this.reconnectIfDue();
    return this.client !== null;
  }

  /** Start one background connection attempt when none runs and the backoff delay is over. */
  private reconnectIfDue(): void {
    if (this.attempt || Date.now() < this.nextAttemptAt) return;
    void this.connect();
  }

  /** One connection attempt; a failure sets the next attempt's time and never rejects. */
  private connect(): Promise<void> {
    if (this.attempt) return this.attempt;
    this.attempt = this.tryConnect().finally(() => {
      this.attempt = null;
    });
    return this.attempt;
  }

  private async tryConnect(): Promise<void> {
    // The worker's mTLS settings (worker.ts): an mTLS-only Temporal refuses a plain connection.
    const tls = temporalTlsConfig();
    if (tls && this.failedAttempts === 0)
      this.logger.log('Temporal mTLS enabled (client certificates)');
    try {
      const connection = await Connection.connect({
        address: TEMPORAL_ADDRESS,
        connectTimeout: 5000,
        ...(tls && { tls }),
      });
      // The worker polls TEMPORAL_NAMESPACE: start workflows in the same one.
      this.client = new Client({
        connection,
        namespace: TEMPORAL_NAMESPACE,
        dataConverter: temporalDataConverter(this.encryption),
      });
      this.failedAttempts = 0;
      this.logger.log('Temporal Client connected successfully');
    } catch (error: unknown) {
      const { minMs, maxMs } = temporalReconnectDelays();
      const delayMs = Math.min(maxMs, minMs * 2 ** this.failedAttempts);
      this.failedAttempts++;
      this.nextAttemptAt = Date.now() + delayMs;
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Temporal server not available at ${TEMPORAL_ADDRESS} (${message}). ` +
          `Blueprint API and canvas will work; the next connection attempt is made on use after ${delayMs} ms.`,
      );
    }
  }
}
