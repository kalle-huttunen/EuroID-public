/**
 * Port for policy evaluation and SoD validation.
 * Implemented by PolicyEngineService, injected via POLICY_DECISION_PORT token.
 * Decouples consumers (AccessRequestsService, ImpactAnalysisService, RiskScoringService) from the full PolicyModule.
 */
import type { StandardUserDto } from '@shared/dtos/standard-user.dto';
// Type-only import: acceptable for port — no runtime dependency on the concrete module.
import type {
  PolicyProvisioningIntent,
  ProvisioningOperation,
} from '../../modules/policy/policy-engine.service';

export const POLICY_DECISION_PORT = Symbol('POLICY_DECISION_PORT');

export interface IPolicyDecisionPort {
  /** Full evaluation: runs policies + SoD + returns intent with violation summary. */
  evaluate(user: StandardUserDto, tenantId?: string): Promise<PolicyProvisioningIntent>;
  /**
   * Evaluate without running SoD (caller merges ops and runs a single SoD pass);
   * `includeAdminOperations` adds the operations that go to the linked admin account;
   * `reviewExclusionsLiftedSince` (the access baseline's time, for the "before" side of a delta)
   * also leaves out what access review exclusions lifted after it suppressed.
   */
  evaluateOperationsWithoutSod(
    user: StandardUserDto,
    tenantId?: string,
    options?: { includeAdminOperations?: boolean; reviewExclusionsLiftedSince?: Date },
  ): Promise<ProvisioningOperation[]>;
}
