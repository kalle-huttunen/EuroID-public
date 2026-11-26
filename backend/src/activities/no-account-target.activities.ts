import { Injectable } from '@nestjs/common';
import { ApplicationFailure } from '@temporalio/common';
import { DiscordWebhookService } from '../modules/connectors/discord-webhook-connector/discord-webhook.service';
import { GoogleSheetsService } from '../modules/connectors/google-sheets-connector/google-sheets.service';
import { FileOutboundService } from '../modules/connectors/file-outbound-connector/file-outbound.service';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { validateActivityContext } from '@shared/utils/activity-context';
import type { StandardUserDto } from '@shared/dtos/standard-user.dto';
import {
  asProvisionFailure,
  provisioningSubject,
  type TargetProvisionResult,
} from './target-provision';

/**
 * Onboarding's activities for the targets that keep no account: Discord webhook (posts a welcome
 * message), Google Sheets (appends a row), File outbound (appends a JSONL line). Default task
 * queue: none has a queue of its own. Each connector loads its saved config itself, so no
 * secret (webhook URL, service account key) passes through workflow history.
 *
 * Provisioning returns no account id, so onboarding writes nothing back and the identity gets a
 * SYNCED provisioning entry for the delivered record only; offboarding reports these targets
 * "not applicable" (offboarding-targets.ts). A retry after a lost result posts or appends again.
 *
 * Each delivery emits provisioning.completed (no account, no operation, the detail) and each
 * failed one provisioning.failed (the masked reason), under the identity's id
 * (provisioningSubject): the identity timeline shows what reached the target.
 */
@Injectable()
export class NoAccountTargetActivities {
  constructor(
    private readonly discordWebhook: DiscordWebhookService,
    private readonly googleSheets: GoogleSheetsService,
    private readonly fileOutbound: FileOutboundService,
    private readonly eventEmitter: DomainEventEmitterService,
  ) {}

  /** The saved webhook exists (read with GET, so nothing is posted to the channel). */
  async checkDiscordWebhookHealth(_config?: undefined, tenantId?: string, correlationId?: string) {
    return this.inTenant(tenantId, correlationId, () => this.discordWebhook.healthCheck());
  }

  async provisionUserToDiscordWebhook(
    user: StandardUserDto,
    intent?: unknown,
    _config?: undefined,
    tenantId?: string,
    correlationId?: string,
  ): Promise<TargetProvisionResult> {
    return this.provision('discord-webhook', user, tenantId, correlationId, async () => {
      await this.discordWebhook.create(user, intent);
      return 'no account: welcome message posted';
    });
  }

  /** The saved sheet loads with the saved service account. */
  async checkGoogleSheetsHealth(_config?: undefined, tenantId?: string, correlationId?: string) {
    return this.inTenant(tenantId, correlationId, () => this.googleSheets.healthCheck());
  }

  async provisionUserToGoogleSheets(
    user: StandardUserDto,
    _intent?: unknown,
    _config?: undefined,
    tenantId?: string,
    correlationId?: string,
  ): Promise<TargetProvisionResult> {
    return this.provision('google-sheets', user, tenantId, correlationId, async () => {
      await this.googleSheets.create(user);
      return 'no account: row appended to the sheet';
    });
  }

  /** The saved output file's directory is writable (created when missing). */
  async checkFileOutboundHealth(_config?: undefined, tenantId?: string, correlationId?: string) {
    return this.inTenant(tenantId, correlationId, () => this.fileOutbound.healthCheck());
  }

  async provisionUserToFileOutbound(
    user: StandardUserDto,
    intent?: unknown,
    _config?: undefined,
    tenantId?: string,
    correlationId?: string,
  ): Promise<TargetProvisionResult> {
    return this.provision('file-outbound', user, tenantId, correlationId, async () => {
      await this.fileOutbound.create(user, intent);
      return 'no account: line appended to the outbound file';
    });
  }

  private async inTenant<T>(
    tenantId: string | undefined,
    correlationId: string | undefined,
    fn: () => Promise<T>,
  ): Promise<T> {
    validateActivityContext({ tenantId: tenantId ?? '', correlationId });
    return withTenantContext(tenantId ?? '', fn, { correlationId });
  }

  private async provision(
    system: string,
    user: StandardUserDto,
    tenantId: string | undefined,
    correlationId: string | undefined,
    deliver: () => Promise<string>,
  ): Promise<TargetProvisionResult> {
    return this.inTenant(tenantId, correlationId, async () => {
      const { aggregateId, identityId } = provisioningSubject(user, system);
      const startTime = Date.now();
      let detail: string;
      try {
        detail = await deliver();
      } catch (error: unknown) {
        const failure = asProvisionFailure(system, error);
        this.eventEmitter.emit(DomainEventType.PROVISIONING_FAILED, aggregateId, {
          ...(identityId ? { identityId } : {}),
          connector: system,
          error: failure instanceof Error ? failure.message : String(failure),
          retryable: !(failure instanceof ApplicationFailure && failure.nonRetryable),
        });
        throw failure;
      }
      this.eventEmitter.emit(DomainEventType.PROVISIONING_COMPLETED, aggregateId, {
        ...(identityId ? { identityId } : {}),
        connector: system,
        operations: [],
        detail,
        durationMs: Date.now() - startTime,
      });
      return { success: true as const, detail };
    });
  }
}
