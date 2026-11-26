/**
 * [MODULE] ActivitiesModule
 * -------------------------
 * Thin aggregator for all Temporal Activities. Feature-specific modules sit closer to their domains.
 * The Temporal Worker imports this module to resolve all activities.
 */
import { Module } from '@nestjs/common';
import { ConnectorActivitiesModule } from './connector-activities.module';
import { IdentityActivitiesModule } from './identity-activities.module';
import { BulkActivitiesModule } from './bulk-activities.module';
import { BlueprintActivitiesModule } from './blueprint-activities.module';
import { ReconciliationActivitiesModule } from './reconciliation-activities.module';
import { WritebackActivitiesModule } from './writeback-activities.module';
import { ArchivalActivitiesModule } from './archival-activities.module';
import { EntitlementExpiryActivitiesModule } from './entitlement-expiry-activities.module';
import { PrivilegedAccessActivitiesModule } from './privileged-access-activities.module';
import { AccessRequestActivitiesModule } from './access-request-activities.module';
import { RiskScoreActivitiesModule } from './risk-score-activities.module';
import { RecertificationActivitiesModule } from './recertification-activities.module';
import { OrphanActivitiesModule } from './orphan-activities.module';
import { IntelligenceActivitiesModule } from './intelligence-activities.module';
import { CredentialActivitiesModule } from './credential-activities.module';
import { AuditArchiveActivitiesModule } from './audit-archive-activities.module';
import { MoverActivitiesModule } from './mover-activities.module';
import { CredentialRotationActivitiesModule } from './credential-rotation-activities.module';

@Module({
  imports: [
    ConnectorActivitiesModule,
    AccessRequestActivitiesModule,
    ArchivalActivitiesModule,
    IdentityActivitiesModule,
    BulkActivitiesModule,
    BlueprintActivitiesModule,
    ReconciliationActivitiesModule,
    WritebackActivitiesModule,
    EntitlementExpiryActivitiesModule,
    PrivilegedAccessActivitiesModule,
    RiskScoreActivitiesModule,
    RecertificationActivitiesModule,
    OrphanActivitiesModule,
    IntelligenceActivitiesModule,
    CredentialActivitiesModule,
    AuditArchiveActivitiesModule,
    MoverActivitiesModule,
    CredentialRotationActivitiesModule,
  ],
  exports: [
    ArchivalActivitiesModule,
    ConnectorActivitiesModule,
    AccessRequestActivitiesModule,
    IdentityActivitiesModule,
    BulkActivitiesModule,
    BlueprintActivitiesModule,
    ReconciliationActivitiesModule,
    WritebackActivitiesModule,
    EntitlementExpiryActivitiesModule,
    PrivilegedAccessActivitiesModule,
    RiskScoreActivitiesModule,
    RecertificationActivitiesModule,
    OrphanActivitiesModule,
    IntelligenceActivitiesModule,
    CredentialActivitiesModule,
    AuditArchiveActivitiesModule,
    MoverActivitiesModule,
    CredentialRotationActivitiesModule,
  ],
})
export class ActivitiesModule {}

// --- Task 108 recap: ArchivalActivitiesModule imported for cold storage archival activities.
