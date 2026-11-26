/**
 * An identity's SoD violations through direct and nested access (GET
 * /access-explorer/identity/:id/sod-violations, viewer): the tenant's active SoD policies whose
 * every entitlement the identity reaches in the graph, each entitlement with the way there. Says
 * how many policies were checked, and when there is no policy to check.
 */
import React from 'react';
import { Card, List, Space, Tag, Typography } from 'antd';
import { Link } from 'react-router-dom';
import { useGraphSodViolations } from '@api/access-explorer-api';
import { EmptyState } from '@shared/EmptyState';
import type { IGraphSodViolation, SodAction, SodSeverity } from '../../interfaces';
import { ACTION_LABEL, ACTION_TAG, SEVERITY_LABEL, SEVERITY_TAG } from '../sod-policies/sod-labels';
import { entitlementDetail, grantText, pathSummary } from './access-explorer-labels';
import { NotInGraph } from './GraphStates';
import { queryState } from './graph-query-state';
import { IdentityPicker } from './ExplorerPickers';

const { Text } = Typography;

const ViolationCard: React.FC<{ violation: IGraphSodViolation }> = ({ violation }) => {
  const severity = violation.severity as SodSeverity | undefined;
  const action = violation.action as SodAction | undefined;
  const name = violation.policyName ?? 'Unnamed policy';
  return (
    <Card
      size="small"
      role="article"
      aria-label={`Violation of ${name}`}
      title={
        <Space wrap size={8}>
          <Text strong>{name}</Text>
          {severity && (
            <Tag color={SEVERITY_TAG[severity]}>{SEVERITY_LABEL[severity] ?? severity}</Tag>
          )}
          {action && <Tag color={ACTION_TAG[action]}>{ACTION_LABEL[action] ?? action}</Tag>}
        </Space>
      }
    >
      <List
        size="small"
        dataSource={violation.conflictingEntitlements}
        renderItem={({ entitlement, path }) => (
          <List.Item>
            <Space direction="vertical" size={0} style={{ minWidth: 0 }}>
              <Text strong>{entitlement.label || entitlement.id}</Text>
              <Text type="secondary" style={{ fontSize: 12, wordBreak: 'break-all' }}>
                {[entitlementDetail(entitlement), entitlement.id].filter(Boolean).join(' · ')}
              </Text>
              <Text style={{ fontSize: 12 }}>
                {pathSummary(path)}. {grantText(path.relationships[0])}
              </Text>
            </Space>
          </List.Item>
        )}
      />
    </Card>
  );
};

export const SodViolationsTab: React.FC<{
  identityId?: string;
  onIdentity: (id: string | undefined) => void;
  onLoadGraph?: () => void;
}> = ({ identityId, onIdentity, onLoadGraph }) => {
  const query = useGraphSodViolations(identityId);
  let body: React.ReactNode;
  if (!identityId) {
    body = (
      <EmptyState
        title="Choose an identity"
        description="The active SoD policies whose every entitlement it reaches, directly or through groups."
      />
    );
  } else {
    body = queryState(query, 'the SoD violations');
    const answer = query.data;
    if (!body && answer) {
      if (!answer.identityFound) {
        body = <NotInGraph what="identity" onLoadGraph={onLoadGraph} />;
      } else if (answer.policiesChecked === 0) {
        body = (
          <EmptyState
            title="No active SoD policy to check"
            description="The tenant has no active SoD policy that names entitlements. Policies are kept under Segregation of duties."
          />
        );
      } else if (answer.violations.length === 0) {
        body = (
          <EmptyState
            title="No SoD violation in the graph"
            description={`Checked ${answer.policiesChecked} active ${answer.policiesChecked === 1 ? 'policy' : 'policies'} against the access this identity reaches, directly or through groups.`}
          />
        );
      } else {
        body = (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Text>
              {answer.violations.length} of {answer.policiesChecked} active{' '}
              {answer.policiesChecked === 1 ? 'policy is' : 'policies are'} violated.{' '}
              <Link to="/sod-policies">Segregation of duties</Link>
            </Text>
            {answer.violations.map((v, i) => (
              <ViolationCard key={`${v.policyName ?? 'policy'}-${i}`} violation={v} />
            ))}
          </Space>
        );
      }
    }
  }
  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <IdentityPicker value={identityId} onChange={onIdentity} />
      <div aria-busy={query.isFetching}>{body}</div>
    </Space>
  );
};
