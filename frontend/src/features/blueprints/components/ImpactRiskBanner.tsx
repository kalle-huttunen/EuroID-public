/**
 * ImpactRiskBanner — Risk level alert banner for ImpactAnalysisModal.
 */
import React from 'react';
import { Alert } from 'antd';
import type { IRiskSummary, IRiskAssessment } from '../../../interfaces/impact-analysis.interface';

export interface ImpactRiskBannerProps {
    risk: IRiskAssessment;
    summary: IRiskSummary;
}

export const ImpactRiskBanner: React.FC<ImpactRiskBannerProps> = ({ risk, summary }) => {
    const affectedCount = summary.creates + summary.updates + summary.deletes;

    const msg = risk.circuitBreakerTriggered
        ? `Circuit breaker triggered — ${risk.affectedPercentage}% exceeds threshold (${risk.threshold}%). Cannot proceed without override.`
        : risk.overallRisk === 'critical'
          ? `High impact — ${risk.affectedPercentage}% of users affected. Manual approval recommended.`
          : risk.overallRisk === 'high'
            ? `High impact — ${risk.affectedPercentage}% of users affected. Review before proceeding.`
            : risk.overallRisk === 'medium'
              ? `Medium impact — ${affectedCount} users affected. Review before proceeding.`
              : `Low impact — ${affectedCount} users affected.`;

    const alertType = risk.circuitBreakerTriggered || risk.overallRisk === 'critical'
        ? 'error'
        : risk.overallRisk === 'high' || risk.overallRisk === 'medium'
          ? 'warning'
          : 'success';

    return <Alert message={msg} type={alertType} showIcon style={{ marginBottom: 16 }} />;
};
