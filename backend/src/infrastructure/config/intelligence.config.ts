/**
 * Intelligence Module Configuration
 *
 * Env-var driven config for rubber-stamp detection, peer group modeling,
 * and smart access recommendations.
 */

import { registerAs } from '@nestjs/config';

export interface IntelligenceConfig {
  /** Decision time threshold (ms) below which an approval is considered too fast. Default 30000 (30s). */
  rubberStampThresholdMs: number;
  /** Number of approvals within 5-minute window to count as bulk approve. Default 10. */
  bulkApproveWindowCount: number;
  /** Minimum group size for peer group formation. Default 3. */
  peerGroupMinSize: number;
  /** Hold rate below which an entitlement is considered unique/unusual (fraction). Default 0.2. */
  outlierHoldRate: number;
  /** Hold rate threshold for missing baseline detection (fraction). Default 0.8. */
  missingBaselineRate: number;
  /** Hold rate for recommendation threshold (fraction). Default 0.7. */
  recommendationHoldRate: number;
  /** Unusual request warning threshold (fraction). Default 0.05. */
  unusualRequestThreshold: number;
  /** Maximum number of recommendations to return. Default 10. */
  recommendationMax: number;
}

export const intelligenceConfig = registerAs(
  'intelligence',
  (): IntelligenceConfig => ({
    rubberStampThresholdMs: parseInt(
      process.env.INTELLIGENCE_RUBBER_STAMP_THRESHOLD_MS ?? '30000',
      10,
    ),
    bulkApproveWindowCount: parseInt(
      process.env.INTELLIGENCE_BULK_APPROVE_WINDOW_COUNT ?? '10',
      10,
    ),
    peerGroupMinSize: parseInt(process.env.INTELLIGENCE_PEER_GROUP_MIN_SIZE ?? '3', 10),
    outlierHoldRate: parseFloat(process.env.INTELLIGENCE_OUTLIER_HOLD_RATE ?? '0.2'),
    missingBaselineRate: parseFloat(process.env.INTELLIGENCE_MISSING_BASELINE_RATE ?? '0.8'),
    recommendationHoldRate: parseFloat(process.env.INTELLIGENCE_RECOMMENDATION_HOLD_RATE ?? '0.7'),
    unusualRequestThreshold: parseFloat(
      process.env.INTELLIGENCE_UNUSUAL_REQUEST_THRESHOLD ?? '0.05',
    ),
    recommendationMax: parseInt(process.env.INTELLIGENCE_RECOMMENDATION_MAX ?? '10', 10),
  }),
);
