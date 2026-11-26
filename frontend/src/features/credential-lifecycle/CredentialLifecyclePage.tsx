/**
 * Credential lifecycle (`/credentials`, operator like the inventory routes): the password age of
 * each account EuroID provisioned in Entra ID and AD against the credential policy that applies,
 * as the nightly check recorded it. Tabs (`?tab=`): credentials due and overdue, the ones the check
 * could not judge with the reason, and for policy-admins the credential policies. Policy-admins
 * also see the compliance summary (GET /compliance). Nothing here resets a password: the backend
 * has no automatic reset (no secret storage), which the page says.
 */
import React from 'react';
import { Alert, Button, Card, Tabs } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { credentialKeys, useCredentialCompliance } from '@api/credential-lifecycle-api';
import { PageContainer, PageHeader } from '@shared/PageHeader';
import { KpiBand } from '@shared/KpiBand';
import { usePermission } from '../../auth/usePermission';
import { DueCredentialsTab, UnknownCredentialsTab } from './CredentialListTabs';
import { CredentialPoliciesTab } from './CredentialPoliciesTab';
import {
  NO_RESET_NOTE,
  NO_RESET_TITLE,
  STATUS_LABEL,
  WHERE_ENTRIES_COME_FROM,
} from './credential-labels';

type CredentialTab = 'due' | 'unknown' | 'policies';

export const CredentialLifecyclePage: React.FC = () => {
  const qc = useQueryClient();
  const isPolicyAdmin = usePermission('policy-admin');
  const [searchParams, setSearchParams] = useSearchParams();
  const compliance = useCredentialCompliance(isPolicyAdmin);

  const tabs: CredentialTab[] = isPolicyAdmin ? ['due', 'unknown', 'policies'] : ['due', 'unknown'];
  const requested = searchParams.get('tab') as CredentialTab | null;
  const activeTab: CredentialTab = requested && tabs.includes(requested) ? requested : 'due';
  const changeTab = (key: string) => {
    const next = new URLSearchParams(searchParams);
    if (key === 'due') next.delete('tab');
    else next.set('tab', key);
    setSearchParams(next, { replace: true });
  };

  const summary = compliance.data;
  const kpi = (
    key: string,
    label: string,
    value: number | undefined,
    tab?: CredentialTab,
    tone?: 'warning' | 'error',
  ) => ({
    key,
    label,
    value: compliance.isError ? null : (value ?? 0),
    tone: tone && (value ?? 0) > 0 ? tone : ('default' as const),
    ...(tab ? { onClick: () => changeTab(tab), actionLabel: `Show ${label.toLowerCase()}` } : {}),
  });

  return (
    <PageContainer>
      <PageHeader
        title="Credential lifecycle"
        subtitle={WHERE_ENTRIES_COME_FROM}
        actions={
          <Button
            icon={<ReloadOutlined />}
            onClick={() => qc.invalidateQueries({ queryKey: credentialKeys.all })}
          >
            Refresh
          </Button>
        }
      />
      <Alert
        type="info"
        showIcon
        message={NO_RESET_TITLE}
        description={NO_RESET_NOTE}
        style={{ marginBottom: 16 }}
      />
      {isPolicyAdmin && (
        <div style={{ marginBottom: 16 }}>
          <KpiBand
            loading={compliance.isLoading}
            items={[
              kpi('compliant', STATUS_LABEL.COMPLIANT, summary?.compliant),
              kpi('expiring', STATUS_LABEL.EXPIRING_SOON, summary?.expiringSoon, 'due', 'warning'),
              kpi('expired', STATUS_LABEL.EXPIRED, summary?.expired, 'due', 'error'),
              kpi('unknown', STATUS_LABEL.UNKNOWN, summary?.unknown, 'unknown', 'warning'),
              kpi('total', 'Accounts tracked', summary?.total),
            ]}
          />
        </div>
      )}
      <Card size="small" role="region" aria-label="Credentials">
        <Tabs
          activeKey={activeTab}
          onChange={changeTab}
          destroyOnHidden
          items={[
            { key: 'due', label: 'Due and overdue', children: <DueCredentialsTab /> },
            { key: 'unknown', label: 'Could not be checked', children: <UnknownCredentialsTab /> },
            ...(isPolicyAdmin
              ? [{ key: 'policies', label: 'Policies', children: <CredentialPoliciesTab /> }]
              : []),
          ]}
        />
      </Card>
    </PageContainer>
  );
};
