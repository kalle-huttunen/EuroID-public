import { describe, it, expect } from 'vitest';
import { isHighRiskScore } from '../risk';

// Hunt 2026-11-25 08 F9: the identity hub flagged 75 as high risk, the risk dashboard counted 76
describe('isHighRiskScore', () => {
  it('starts high risk at the backend top band, 76', () => {
    expect(isHighRiskScore(75)).toBe(false);
    expect(isHighRiskScore(76)).toBe(true);
    expect(isHighRiskScore(100)).toBe(true);
  });
});
