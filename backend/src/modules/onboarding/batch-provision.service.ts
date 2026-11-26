/**
 * Handles batch provisioning logic: seed test users, build bulk operations, trigger Temporal workflows, cleanup.
 * Uses shared Temporal client from TemporalClientProvider.
 */

import { Injectable, Logger, ForbiddenException, NotFoundException } from '@nestjs/common';
import { EntraService } from '../connectors/entra-connector/entra.service';
import { IdentityService } from '../identity/identity.service';
import { generateTestUsers } from '../../scripts/generate-test-users';
import { StandardUserDto, UserStatus } from '@shared/dtos/standard-user.dto';
import {
  BulkOperationRequest,
  BulkOperation,
  BulkOperationType,
  OperationPriority,
} from '@shared/dtos/bulk-operation.dto';
import {
  bulkProvisioningWorkflow,
  getProgressQuery,
  getCurrentPhaseQuery,
} from '../../workflows/bulk-provisioning.workflow';
import { DEFAULT_PROVISIONING_QUEUE } from '@infrastructure/temporal/task-queue.config';
import { getRequestContext } from '@infrastructure/middleware/get-request-context';
import { temporalWorkflowUrl } from '@infrastructure/config/temporal.config';
import { TemporalClientProvider } from '@infrastructure/temporal/temporal-client.provider';
import { getTenantWorkflow } from '@infrastructure/temporal/tenant-workflow';

/** Loose shape of an identity returned from the Identity service for batch operations. */
interface BatchIdentity {
  email?: string;
  userPrincipalName?: string;
  [key: string]: unknown;
}

@Injectable()
export class BatchProvisionService {
  private readonly logger = new Logger(BatchProvisionService.name);

  constructor(
    private readonly identityService: IdentityService,
    private readonly entraService: EntraService,
    private readonly temporalClientProvider: TemporalClientProvider,
  ) {}

  /**
   * Seed test users into MongoDB via IdentityService (Golden Record First). Each identity it mints
   * emits identity.created.
   */
  async seedTestUsers(count: number, domain?: string) {
    this.logger.log(`Generating ${count} test users...`);
    const users = generateTestUsers(count, domain);

    let inserted = 0;
    let updated = 0;

    for (const user of users) {
      const result = await this.identityService.saveOrUpdateReportingCreated(user);
      const createdAt = result?.createdAt as Date | undefined;
      const updatedAt = result?.updatedAt as Date | undefined;
      if (createdAt && updatedAt && Math.abs(createdAt.getTime() - updatedAt.getTime()) < 1000) {
        inserted++;
      } else {
        updated++;
      }
    }

    return {
      message: `Seeded ${count} test users into MongoDB`,
      summary: { total: count, inserted, updated },
      users: users.map((u) => ({
        sourceUserId: u.sourceUserId,
        displayName: u.displayName,
        email: u.email,
        department: u.departmentName,
        location: u.city,
        status: u.status,
      })),
    };
  }

  /**
   * Find pending test-batch users from MongoDB.
   */
  async findPendingTestBatchUsers(): Promise<BatchIdentity[]> {
    return this.identityService.findUsersByTagAndStatus('test-batch', UserStatus.PENDING);
  }

  /**
   * Find all test-batch users from MongoDB.
   */
  async findAllTestBatchUsers(): Promise<BatchIdentity[]> {
    return this.identityService.findUsersByTag('test-batch');
  }

  /**
   * Delete test-batch users from MongoDB.
   */
  async deleteTestBatchUsers(): Promise<{ deletedCount: number }> {
    return this.identityService.deleteUsersByTag('test-batch');
  }

  /**
   * Build bulk operations from test-batch users and start a Temporal workflow.
   */
  async triggerEntraProvisioning(options: {
    dryRun: boolean;
    batchSize?: number;
    continueOnError?: boolean;
  }) {
    const { dryRun, batchSize = 5, continueOnError = true } = options;

    // Check Entra connectivity if not dry-run
    if (!dryRun) {
      const connected = await this.entraService.checkConnection();
      if (!connected) {
        return {
          error: 'Entra ID not connected. Run GET /api/v1/batch-provision/health to diagnose.',
          dryRun,
        };
      }
    }

    // Load test-batch users
    const testUsers = await this.findPendingTestBatchUsers();

    if (testUsers.length === 0) {
      return {
        error: 'No pending test-batch users found. Run POST /api/v1/batch-provision/seed first.',
        dryRun,
      };
    }

    this.logger.log(`Found ${testUsers.length} pending test-batch users`);

    // Build bulk operations
    const operations: BulkOperation[] = testUsers.map((user: BatchIdentity, index: number) => ({
      id: `batch-entra-${Date.now()}-${index}`,
      type: BulkOperationType.CREATE,
      user: user as unknown as StandardUserDto,
      targetSystems: ['entra-id'],
      priority: OperationPriority.NORMAL,
    }));

    const ctx = getRequestContext();
    const tid = ctx?.tenantId;
    if (!tid) {
      throw new ForbiddenException('Tenant context is required for batch provisioning');
    }

    const batchId = `entra-batch-${Date.now()}`;
    const request: BulkOperationRequest = {
      batchId,
      tenantId: tid,
      operations,
      dryRun,
      continueOnError,
      batchSize,
      requireApprovalForDeletes: false,
      initiatedBy: 'batch-provision-service',
      notes: dryRun
        ? 'Dry-run validation of test-batch users against Entra ID'
        : 'LIVE provisioning of test-batch users to Entra ID',
    };

    // Start Temporal workflow
    const client = this.temporalClientProvider.getClient();
    const workflowId = `t-${tid}-batch-provision-${batchId}`;

    await client.workflow.start(bulkProvisioningWorkflow, {
      taskQueue: DEFAULT_PROVISIONING_QUEUE,
      workflowId,
      args: [request],
      searchAttributes: {
        TenantId: [tid],
      },
    });

    this.logger.log(`Started batch provisioning workflow: ${workflowId} (dryRun=${dryRun})`);

    return {
      message: dryRun
        ? `DRY-RUN started for ${testUsers.length} users. No changes will be made to Entra ID.`
        : `LIVE provisioning started for ${testUsers.length} users to Entra ID!`,
      workflowId,
      batchId,
      dryRun,
      userCount: testUsers.length,
      trackingUrl: temporalWorkflowUrl(workflowId),
      statusEndpoint: `/api/v1/batch-provision/status/${workflowId}`,
    };
  }

  /**
   * Get the status of a batch provisioning workflow.
   */
  async getProvisioningStatus(workflowIdParam: string) {
    const ctx = getRequestContext();
    const tid = ctx?.tenantId;
    let workflowId: string;
    if (workflowIdParam.startsWith('t-') || workflowIdParam.startsWith('batch-provision-')) {
      workflowId = workflowIdParam;
    } else {
      if (!tid) {
        throw new ForbiddenException(
          'Tenant context is required to resolve workflow status by batch ID',
        );
      }
      workflowId = `t-${tid}-batch-provision-${workflowIdParam}`;
    }

    try {
      // Another tenant's workflow id is a 404, like a missing one.
      const { handle, description } = await getTenantWorkflow(
        this.temporalClientProvider.getClient(),
        workflowId,
      );
      const status = description.status.name;

      if (status === 'COMPLETED') {
        const result = await handle.result();
        return { workflowId, status: 'COMPLETED', result };
      }

      if (status === 'RUNNING') {
        let phase = 'UNKNOWN';
        let progress: unknown = null;
        try {
          phase = await handle.query(getCurrentPhaseQuery);
          progress = await handle.query(getProgressQuery);
        } catch {
          // Queries may fail if workflow hasn't registered handlers yet
        }
        return {
          workflowId,
          status: 'RUNNING',
          phase,
          progress,
          trackingUrl: temporalWorkflowUrl(workflowId),
        };
      }

      return { workflowId, status, startTime: description.startTime };
    } catch (error: unknown) {
      if (error instanceof NotFoundException) throw error;
      const internalMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to get workflow status for ${workflowId}: ${internalMsg}`);
      return { workflowId, error: 'Workflow status unavailable' };
    }
  }

  /**
   * Clean up test-batch users from MongoDB (optionally from Entra).
   */
  async cleanupTestUsers(removeFromEntra: boolean) {
    this.logger.log(`Cleaning up test-batch users (removeFromEntra=${removeFromEntra})`);

    const testUsers = await this.findAllTestBatchUsers();

    if (testUsers.length === 0) {
      return { message: 'No test-batch users found to clean up.' };
    }

    const entraResults: Array<{ email: string; deleted: boolean; error?: string }> = [];

    if (removeFromEntra && (await this.entraService.isConfiguredForTenant())) {
      for (const user of testUsers) {
        try {
          const upn = user.userPrincipalName || user.email;
          const deleted = await this.entraService.deleteUser(upn as string);
          entraResults.push({ email: user.email ?? '', deleted });
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          entraResults.push({ email: user.email ?? '', deleted: false, error: message });
        }
      }
    }

    const deleteResult = await this.deleteTestBatchUsers();

    return {
      message: `Cleaned up ${deleteResult.deletedCount} test-batch users from MongoDB`,
      mongodb: { deleted: deleteResult.deletedCount },
      entra: removeFromEntra
        ? {
            attempted: entraResults.length,
            succeeded: entraResults.filter((r) => r.deleted).length,
            failed: entraResults.filter((r) => !r.deleted).length,
            details: entraResults,
          }
        : 'Skipped (pass ?fromEntra=true to also delete from Entra ID)',
    };
  }

  /**
   * Simple public health check — no filesystem paths or sensitive data.
   */
  async getHealthCheck(): Promise<{
    status: string;
    envLoaded: boolean;
    temporalConnected: boolean;
  }> {
    let temporalConnected = false;
    try {
      this.temporalClientProvider.getClient();
      temporalConnected = true;
    } catch {
      // Temporal unreachable
    }
    return {
      status: 'ok',
      envLoaded: !!process.env.ENTRA_CLIENT_ID,
      temporalConnected,
    };
  }

  /**
   * Full diagnostics (super-admin only) — env paths, keys, Entra connectivity. `keysCheck` reads
   * the ENTRA_* variables; the connection, license and domain checks run on the config the
   * tenant's Entra ID calls run on, which `entra.configSource` names: its installed connector
   * config, else ENTRA_*, else none (then nothing is checked).
   */
  async getHealthDiagnostics(envLoadInfo: {
    processCwd: string;
    dirname: string;
    attemptedPaths: Array<{ path: string; exists: boolean }>;
    firstExisting: string | null;
  }) {
    const keysCheck = this.entraService.getConfigKeysCheck();
    const configSource = await this.entraService.tenantConfigSource();
    const configured = configSource !== 'none';
    const tenantConfig = configSource === 'tenant-connector';
    let connected = false;

    if (configured) {
      connected = await this.entraService.checkConnection();
    }

    let licenses: Record<string, number> = {};
    let domainCheck: { ok: boolean; domain: string; verifiedDomains: string[] } | null = null;
    if (connected) {
      const licMap = await this.entraService.getAvailableLicenses();
      licenses = Object.fromEntries(licMap);
      domainCheck = await this.entraService.isDefaultDomainVerified();
    }

    const allKeysOk = Object.values(keysCheck).every((k) => k.status === 'ok');
    const requiredKeysOk =
      keysCheck.ENTRA_TENANT_ID.status === 'ok' &&
      keysCheck.ENTRA_CLIENT_ID.status === 'ok' &&
      keysCheck.ENTRA_CLIENT_SECRET.status === 'ok';

    const CONNECTOR_CONFIG = "the tenant's Entra ID connector config";
    let status: string;
    let message: string;
    if (!configured || (!tenantConfig && !requiredKeysOk)) {
      status = 'NOT_CONFIGURED';
      message =
        'No Entra ID config: install the Entra ID connector for this tenant, or fix the keys ' +
        'marked missing or placeholder in keysCheck (see hints).';
    } else if (!connected && tenantConfig) {
      status = 'AUTH_FAILED';
      message =
        `The connection on ${CONNECTOR_CONFIG} failed: check its tenant ID, client ID and ` +
        'client secret (all three set) and the app permissions.';
    } else if (!connected) {
      status = 'AUTH_FAILED';
      message =
        'Credentials present but connection failed — check tenant ID, client ID, secret, and app permissions.';
    } else if (domainCheck && !domainCheck.ok) {
      status = 'DOMAIN_NOT_VERIFIED';
      const domainOf = tenantConfig
        ? `The default domain "${domainCheck.domain}" of ${CONNECTOR_CONFIG}`
        : `ENTRA_DEFAULT_DOMAIN "${domainCheck.domain}"`;
      message = `${domainOf} is not in your tenant's verified domains. Use one of: ${domainCheck.verifiedDomains.join(', ') || 'none'}.`;
    } else if (tenantConfig) {
      status = 'READY';
      message = `Entra ID connected and ready on ${CONNECTOR_CONFIG}.`;
    } else if (!allKeysOk) {
      status = 'READY';
      message =
        'Connected. Optional keys (e.g. ENTRA_USAGE_LOCATION, ENTRA_DEFAULT_LICENSE) can be set as needed.';
    } else {
      status = 'READY';
      message = 'Entra ID connected and ready.';
    }

    return {
      envLoad: {
        processCwd: envLoadInfo.processCwd,
        dirname: envLoadInfo.dirname,
        attemptedPaths: envLoadInfo.attemptedPaths,
        firstExisting: envLoadInfo.firstExisting,
        hint: envLoadInfo.firstExisting
          ? `ConfigModule loads .env from the first existing path above. Save the file as UTF-8 (no BOM) so keys are read correctly.`
          : `No .env file found at any attempted path. Add backend/.env with your Entra keys (UTF-8, no BOM).`,
      },
      keysCheck,
      entra: {
        configSource,
        configured,
        connected,
        licenses,
        domainCheck: domainCheck ?? undefined,
      },
      status,
      message,
    };
  }
}
