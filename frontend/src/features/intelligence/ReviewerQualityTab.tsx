/**
 * The Reviewer quality tab of Access reviews (super-admin, like GET
 * /intelligence/reviewer-quality): each reviewer's score in each completed campaign, lowest
 * first, with the signals behind it. A chosen campaign is read from
 * GET /intelligence/reviewer-quality/:campaignId. The nightly intelligence batch scores a campaign
 * once, the night after it completes; nothing here changes a campaign or a decision.
 */
import React, { useState } from 'react';
import { Button, Select, Skeleton, Space, Table, Tag, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { ReloadOutlined } from '@ant-design/icons';
import { useQueryClient } from '@tanstack/react-query';
import {
  REVIEWER_QUALITY_PAGE_SIZE,
  accessIntelligenceKeys,
  useReviewerQuality,
} from '@api/access-intelligence-api';
import type { ReviewCampaign } from '@api/intelligence-api';
import { EmptyState } from '@shared/EmptyState';
import { ErrorState } from '@shared/ErrorState';
import type { IReviewerQualityScore } from '../../interfaces';
import {
  NIGHTLY_BATCH,
  QUALITY_EXPLAINED,
  formatDateTime,
  formatDuration,
  formatPercent,
  qualityLevel,
  scorePenalties,
} from './access-intelligence-labels';

const { Text } = Typography;

/** Below this width (phones) the scores scroll inside their container, not the page. */
const TABLE_MIN_WIDTH = 1100;

function emptyText(campaign: ReviewCampaign | undefined, filtered: boolean) {
  if (!filtered) {
    return {
      title: 'No reviewer scores yet',
      description: `Each completed campaign is scored once, the night after it completes. ${NIGHTLY_BATCH} Active and cancelled campaigns are not scored.`,
    };
  }
  if (campaign && campaign.status !== 'COMPLETED') {
    return {
      title: 'No scores for this campaign',
      description: `Only completed campaigns are scored; this one is ${campaign.status.toLowerCase()}.`,
    };
  }
  return {
    title: 'No scores for this campaign',
    description: `It is scored the night after it completes, if anyone decided its items. ${NIGHTLY_BATCH}`,
  };
}

export interface ReviewerQualityTabProps {
  /** The page's campaigns: their names and the completed ones to filter by. */
  campaigns: ReviewCampaign[];
  campaignId?: string;
  onCampaignChange: (campaignId: string | undefined) => void;
}

export const ReviewerQualityTab: React.FC<ReviewerQualityTabProps> = ({
  campaigns,
  campaignId,
  onCampaignChange,
}) => {
  const qc = useQueryClient();
  // The page belongs to the campaign it was chosen for: another campaign (from the filter or a
  // campaign's modal) starts on its first page.
  const [paging, setPaging] = useState({ campaignId, page: 1 });
  const page = paging.campaignId === campaignId ? paging.page : 1;
  const setPage = (next: number) => setPaging({ campaignId, page: next });
  const scores = useReviewerQuality(campaignId, page);
  const nameOf = new Map(campaigns.map((c) => [c.campaignId, c.name]));
  const completed = campaigns.filter(
    (c) => c.status === 'COMPLETED' || c.campaignId === campaignId,
  );
  const rows = scores.data?.data ?? [];

  const chooseCampaign = (id: string | undefined) => {
    setPaging({ campaignId: id, page: 1 });
    onCampaignChange(id);
  };

  const columns: ColumnsType<IReviewerQualityScore> = [
    {
      title: 'Reviewer',
      dataIndex: 'reviewerId',
      key: 'reviewer',
      render: (reviewer: string) => <span style={{ wordBreak: 'break-word' }}>{reviewer}</span>,
    },
    {
      title: 'Campaign',
      dataIndex: 'campaignId',
      key: 'campaign',
      width: 200,
      render: (id: string) => (
        <span style={{ wordBreak: 'break-word' }}>{nameOf.get(id) ?? id}</span>
      ),
    },
    {
      title: 'Score',
      key: 'score',
      width: 230,
      render: (_: unknown, s) => {
        const level = qualityLevel(s.qualityScore);
        const penalties = scorePenalties(s);
        return (
          <Space direction="vertical" size={4}>
            <Tag color={level.color}>
              {Math.round(s.qualityScore)} · {level.label}
            </Tag>
            {penalties.length ? (
              <Space size={[4, 4]} wrap>
                {penalties.map((p) => (
                  <Tag key={p.label} style={{ whiteSpace: 'normal' }}>
                    {p.label} (−{p.points})
                  </Tag>
                ))}
              </Space>
            ) : (
              <Text type="secondary" style={{ fontSize: 12 }}>
                No warning signs
              </Text>
            )}
          </Space>
        );
      },
    },
    {
      title: 'Approved',
      key: 'approvalRate',
      width: 100,
      render: (_: unknown, s) => formatPercent(s.signals.approvalRate),
    },
    {
      title: 'Avg decision time',
      key: 'avgDecisionTime',
      width: 130,
      render: (_: unknown, s) => formatDuration(s.signals.avgDecisionTimeSeconds),
    },
    {
      title: 'Approvals unjustified',
      key: 'noJustificationRate',
      width: 130,
      render: (_: unknown, s) => formatPercent(s.signals.noJustificationRate),
    },
    {
      title: 'Flagged',
      key: 'flagged',
      width: 90,
      render: (_: unknown, s) => (
        <Tooltip title="Approved without a justification in under 15 seconds">
          <span tabIndex={0}>{s.flaggedDecisions.length}</span>
        </Tooltip>
      ),
    },
    {
      title: 'Scored',
      dataIndex: 'calculatedAt',
      key: 'calculatedAt',
      width: 140,
      render: (at: string) => formatDateTime(at),
    },
  ];

  let body: React.ReactNode;
  if (scores.isLoading) {
    body = <Skeleton active paragraph={{ rows: 5 }} />;
  } else if (scores.isError) {
    body = (
      <ErrorState
        title="Could not load the reviewer scores"
        error={scores.error}
        onRetry={() => scores.refetch()}
      />
    );
  } else if (!rows.length) {
    const campaign = campaigns.find((c) => c.campaignId === campaignId);
    const empty = emptyText(campaign, !!campaignId);
    body = (
      <EmptyState
        title={empty.title}
        description={empty.description}
        action={
          campaignId
            ? {
                label: 'Show all campaigns',
                type: 'default',
                onClick: () => chooseCampaign(undefined),
              }
            : undefined
        }
      />
    );
  } else {
    body = (
      <Table
        aria-label="Reviewer quality scores"
        columns={columns}
        dataSource={rows}
        rowKey="_id"
        size="small"
        scroll={{ x: TABLE_MIN_WIDTH }}
        pagination={{
          current: page,
          pageSize: REVIEWER_QUALITY_PAGE_SIZE,
          total: scores.data?.total ?? rows.length,
          showSizeChanger: false,
          onChange: setPage,
        }}
      />
    );
  }

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Space wrap style={{ width: '100%', justifyContent: 'space-between' }}>
        <Select<string>
          aria-label="Campaign"
          placeholder="All completed campaigns"
          allowClear
          showSearch
          optionFilterProp="label"
          value={campaignId}
          onChange={chooseCampaign}
          options={completed.map((c) => ({ value: c.campaignId, label: c.name }))}
          style={{ width: 320, maxWidth: '100%' }}
        />
        <Button
          icon={<ReloadOutlined />}
          onClick={() =>
            qc.invalidateQueries({ queryKey: accessIntelligenceKeys.reviewerQualityPrefix() })
          }
        >
          Refresh
        </Button>
      </Space>
      <Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
        {QUALITY_EXPLAINED}
      </Text>
      <div role="region" aria-label="Reviewer quality" aria-busy={scores.isFetching}>
        {body}
      </div>
    </Space>
  );
};
