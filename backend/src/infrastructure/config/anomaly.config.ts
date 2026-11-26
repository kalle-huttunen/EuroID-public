import { registerAs } from '@nestjs/config';

export interface AnomalyConfig {
  businessHoursTz: string;
  businessHoursStart: number;
  businessHoursEnd: number;
  velocityThresholdN: number;
  velocityWindowM: number;
  privilegeEscalationWindowH: number;
  peerDeviationThreshold: number;
}

export const anomalyConfig = registerAs(
  'anomaly',
  (): AnomalyConfig => ({
    businessHoursTz: process.env.BUSINESS_HOURS_TZ || 'UTC',
    businessHoursStart: parseInt(process.env.BUSINESS_HOURS_START || '7', 10),
    businessHoursEnd: parseInt(process.env.BUSINESS_HOURS_END || '19', 10),
    velocityThresholdN: parseInt(process.env.ANOMALY_VELOCITY_N || '10', 10),
    velocityWindowM: parseInt(process.env.ANOMALY_VELOCITY_M || '5', 10),
    privilegeEscalationWindowH: parseInt(process.env.ANOMALY_PRIVILEGE_WINDOW_H || '24', 10),
    peerDeviationThreshold: parseFloat(process.env.ANOMALY_PEER_THRESHOLD || '0.1'),
  }),
);
