import { registerAs } from '@nestjs/config';

export interface RiskScoringConfig {
  weightEntitlement: number;
  weightHighRisk: number;
  weightSod: number;
  weightAnomaly: number;
  weightAdmin: number;
  weightDormant: number;
  weightPeerDeviation: number;
  dormancyDays: number;
  anomalyLookbackDays: number;
}

export const riskScoringConfig = registerAs(
  'riskScoring',
  (): RiskScoringConfig => ({
    weightEntitlement: parseInt(process.env.RISK_WEIGHT_ENTITLEMENT ?? '8', 10),
    weightHighRisk: parseInt(process.env.RISK_WEIGHT_HIGH_RISK ?? '22', 10),
    weightSod: parseInt(process.env.RISK_WEIGHT_SOD ?? '22', 10),
    weightAnomaly: parseInt(process.env.RISK_WEIGHT_ANOMALY ?? '13', 10),
    weightAdmin: parseInt(process.env.RISK_WEIGHT_ADMIN ?? '13', 10),
    weightDormant: parseInt(process.env.RISK_WEIGHT_DORMANT ?? '10', 10),
    weightPeerDeviation: parseInt(process.env.RISK_WEIGHT_PEER_DEVIATION ?? '12', 10),
    dormancyDays: parseInt(process.env.RISK_DORMANCY_DAYS ?? '90', 10),
    anomalyLookbackDays: parseInt(process.env.RISK_ANOMALY_LOOKBACK_DAYS ?? '90', 10),
  }),
);
