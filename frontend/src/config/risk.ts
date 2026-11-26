/**
 * The lowest risk score that counts as high risk: the top band of the backend's risk score
 * distribution (76-100, risk-scoring.service.ts getDistribution). The identity hub's status
 * column and the risk dashboard's count use the same line.
 */
export const HIGH_RISK_MIN_SCORE = 76;

export const isHighRiskScore = (score: number): boolean => score >= HIGH_RISK_MIN_SCORE;
