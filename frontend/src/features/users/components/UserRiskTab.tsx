/**
 * UserRiskTab — risk score, open anomalies, and upcoming offboarding.
 * Self-contained: owns its own data queries.
 */

import React from "react";
import { Space, Tag, Typography } from "antd";
import { useQuery } from "@tanstack/react-query";
import {
  fetchAnomalies,
  fetchRiskScores,
  fetchUpcomingOffboardingByIdentity,
  intelligenceKeys,
} from "@api/intelligence-api";
import type { IStandardUser } from "../../../interfaces";
import { resolveIdentityId } from "./user-detail.types";
import { ErrorState } from "@shared/ErrorState";

const { Title, Text } = Typography;

/** antd status presets: token-driven, so they follow light/dark mode. */
function getRiskScoreColor(score: number): string {
  if (score <= 25) return "success";
  if (score <= 75) return "warning";
  return "error";
}

interface UserRiskTabProps {
  user: IStandardUser;
}

export const UserRiskTab: React.FC<UserRiskTabProps> = ({ user }) => {
  const identityId = resolveIdentityId(user);

  const anomaliesQuery = useQuery({
    queryKey: intelligenceKeys.anomalies({ identityId }),
    queryFn: () => fetchAnomalies({ identityId }),
    enabled: !!identityId,
  });
  const riskScoresQuery = useQuery({
    queryKey: intelligenceKeys.riskScores(),
    queryFn: () => fetchRiskScores(200),
    enabled: !!identityId,
  });
  const { data: offboarding } = useQuery({
    queryKey: intelligenceKeys.offboardingByIdentity(identityId!),
    queryFn: () => fetchUpcomingOffboardingByIdentity(identityId!),
    enabled: !!identityId && !!user.endDate,
  });

  const riskEntry = riskScoresQuery.data?.find((r) => r.identityId === identityId);
  const openAnomalies = (anomaliesQuery.data?.data ?? []).filter((a) => a.status === "open");

  if (anomaliesQuery.isError || riskScoresQuery.isError) {
    return (
      <ErrorState
        compact
        title="Could not load risk data"
        error={anomaliesQuery.error ?? riskScoresQuery.error}
        onRetry={() => {
          void anomaliesQuery.refetch();
          void riskScoresQuery.refetch();
        }}
      />
    );
  }

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <div>
        <Title level={5}>Risk score</Title>
        {riskEntry ? (
          <Tag
            color={getRiskScoreColor(riskEntry.riskScore)}
            className="tabular-nums"
            style={{ fontSize: 16, lineHeight: '26px', paddingInline: 10 }}
          >
            {riskEntry.riskScore}
          </Tag>
        ) : (
          <Text type="secondary">No risk score computed yet.</Text>
        )}
      </div>
      <div>
        <Title level={5}>Open anomalies</Title>
        {openAnomalies.length > 0 ? (
          <Space direction="vertical" size={4}>
            {openAnomalies.map((a) => (
              <div key={a.anomalyId}>
                <Tag color={a.severity === "critical" ? "error" : "warning"}>
                  {a.type}
                </Tag>{" "}
                {a.title}
              </div>
            ))}
          </Space>
        ) : (
          <Text type="secondary">No open anomalies.</Text>
        )}
      </div>
      {user.endDate && (
        <div>
          <Title level={5}>Upcoming offboarding</Title>
          {offboarding ? (
            <Space direction="vertical" size={4}>
              <Text>End date: {new Date(offboarding.endDate).toLocaleDateString()}</Text>
              <Tag
                color={
                  offboarding.daysRemaining < 7
                    ? "error"
                    : offboarding.daysRemaining < 30
                      ? "warning"
                      : "success"
                }
              >
                {offboarding.daysRemaining} days remaining
              </Tag>
              {offboarding.blastRadius?.affectedSystems?.length > 0 && (
                <Text type="secondary">
                  Affected systems: {offboarding.blastRadius.affectedSystems.join(", ")}
                </Text>
              )}
            </Space>
          ) : (
            <Text type="secondary">No offboarding data.</Text>
          )}
        </div>
      )}
    </Space>
  );
};
