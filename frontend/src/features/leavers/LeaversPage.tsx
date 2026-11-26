/**
 * Joiners, movers and leavers: HR-driven onboarding, access moves and offboarding. HR syncs
 * onboard the people they add (once the pipeline is deployed), offboard terminated people, passed
 * end dates and people gone from the feed on their own, and move the access of people whose
 * department, job title, location or manager changed; a sync above the mass-joiner, mass-leaver
 * or mass-mover limit pauses here for approval. Tabs: pending leaver batches, offboardings that
 * left a target failed, decided leaver batches, HR joiners (pending, decided, limit), HR movers
 * (pending, decided, limit), the tenant leaver policy (`?tab=` deep link).
 */
import React from 'react';
import { Badge, Tabs } from 'antd';
import { useSearchParams } from 'react-router-dom';
import { useLeaverBatches, useOpenOffboardings } from '@api/leavers-api';
import { useMoverBatches } from '@api/hr-movers-api';
import { useJoinerBatches } from '@api/joiners-api';
import { PageContainer, PageHeader } from '@shared/PageHeader';
import { PendingLeaverBatches } from './PendingLeaverBatches';
import { LeaverBatchHistory } from './LeaverBatchHistory';
import { LeaverPolicyForm } from './LeaverPolicyForm';
import { OpenOffboardings } from './OpenOffboardings';
import { HrMovers } from './HrMovers';
import { HrJoiners } from './HrJoiners';

const TABS = ['pending', 'failed', 'history', 'joiners', 'movers', 'policy'] as const;
type TabKey = (typeof TABS)[number];

export const LeaversPage: React.FC = () => {
  const [params, setParams] = useSearchParams();
  const requested = params.get('tab') as TabKey | null;
  const activeKey: TabKey = requested && TABS.includes(requested) ? requested : 'pending';
  const { data: pending } = useLeaverBatches('pending');
  const pendingCount = pending?.length ?? 0;
  const { data: failed } = useOpenOffboardings();
  const failedCount = failed?.length ?? 0;
  const { data: pendingMovers } = useMoverBatches('pending');
  const moverCount = pendingMovers?.length ?? 0;
  const { data: pendingJoiners } = useJoinerBatches('pending');
  const joinerCount = pendingJoiners?.length ?? 0;

  return (
    <PageContainer>
      <PageHeader
        title="Joiners, movers and leavers"
        subtitle="HR syncs onboard joiners, move access and offboard leavers on their own. A sync above the mass-joiner, mass-mover or mass-leaver limit waits here for an admin."
      />
      <Tabs
        activeKey={activeKey}
        onChange={(key) => setParams(key === 'pending' ? {} : { tab: key }, { replace: true })}
        items={[
          {
            key: 'pending',
            label: (
              <span>
                Pending approval {pendingCount > 0 && <Badge count={pendingCount} size="small" />}
              </span>
            ),
            children: <PendingLeaverBatches />,
          },
          {
            key: 'failed',
            label: (
              <span>
                Failed offboardings {failedCount > 0 && <Badge count={failedCount} size="small" />}
              </span>
            ),
            children: <OpenOffboardings />,
          },
          { key: 'history', label: 'Decided', children: <LeaverBatchHistory /> },
          {
            key: 'joiners',
            label: (
              <span>
                HR joiners {joinerCount > 0 && <Badge count={joinerCount} size="small" />}
              </span>
            ),
            children: <HrJoiners />,
          },
          {
            key: 'movers',
            label: (
              <span>HR movers {moverCount > 0 && <Badge count={moverCount} size="small" />}</span>
            ),
            children: <HrMovers />,
          },
          { key: 'policy', label: 'Policy', children: <LeaverPolicyForm /> },
        ]}
      />
    </PageContainer>
  );
};
