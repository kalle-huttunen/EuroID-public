/**
 * Bulk Activities Module
 *
 * Provides Temporal activities for bulk provisioning, rate limiting, and distributed transactions.
 */
import { Module, forwardRef } from '@nestjs/common';
import { BulkProvisioningActivities } from './bulk-provisioning.activities';
import { RateLimiterActivities } from './rate-limiter.activities';
import { DistributedTransactionActivities } from './distributed-transaction.activities';
import { ConnectorActivitiesModule } from './connector-activities.module';
import { IdentityActivitiesModule } from './identity-activities.module';
import { PolicyModule } from '../modules/policy/policy.module';
import { DeadLetterModule } from '../modules/dead-letter/dead-letter.module';
import { EntraConnectorModule } from '../modules/connectors/entra-connector/entra.module';
import { FileOutboundConnectorModule } from '../modules/connectors/file-outbound-connector/file-outbound.module';
import { DiscordWebhookConnectorModule } from '../modules/connectors/discord-webhook-connector/discord-webhook.module';
import { GitHubConnectorModule } from '../modules/connectors/github-connector/github.module';
import { GoogleSheetsConnectorModule } from '../modules/connectors/google-sheets-connector/google-sheets.module';
import { RollbackSnapshotModule } from '../modules/bulk-provisioning/rollback-snapshot.module';
import { IdentityModule } from '../modules/identity/identity.module';

@Module({
  imports: [
    ConnectorActivitiesModule,
    IdentityActivitiesModule,
    PolicyModule,
    DeadLetterModule,
    EntraConnectorModule, // EntraService for DistributedTransactionActivities and bulk rollback
    RollbackSnapshotModule, // encrypted pre-change state for bulk rollback
    IdentityModule, // IdentityService: Golden Record write and its rollback in bulk provisioning
    forwardRef(() => FileOutboundConnectorModule),
    forwardRef(() => DiscordWebhookConnectorModule),
    forwardRef(() => GitHubConnectorModule),
    forwardRef(() => GoogleSheetsConnectorModule),
  ],
  providers: [BulkProvisioningActivities, RateLimiterActivities, DistributedTransactionActivities],
  exports: [BulkProvisioningActivities, RateLimiterActivities, DistributedTransactionActivities],
})
export class BulkActivitiesModule {}
