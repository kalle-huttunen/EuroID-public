/**
 * Access explorer (`/access-explorer`, every role, like the viewer routes of
 * `/api/v1/access-explorer`): who has access to what, read from the Neo4j access graph. Views
 * (`?tab=`): an identity's access graph (default), the holders of an entitlement, the access path
 * between them, an identity's SoD violations through nested groups. The identity (`?identity=`,
 * its `_id`) and the entitlement (`?entitlement=`, its graph key `<system>::<id>`) are shared by
 * the views, so the identity page can link here and a row can open another view. A super-admin also loads the graph
 * from MongoDB (POST /access-explorer/resync). Without a graph store every view shows the API's
 * 503 message and how the graph is filled, never an empty answer.
 */
import React, { useState } from 'react';
import { Button, Card, Space, Tabs } from 'antd';
import { CloudSyncOutlined, ReloadOutlined } from '@ant-design/icons';
import { useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { accessExplorerKeys } from '@api/access-explorer-api';
import { PageContainer, PageHeader } from '@shared/PageHeader';
import { usePermission } from '../../auth/usePermission';
import { PAGE_SUBTITLE } from './access-explorer-labels';
import { IdentityAccessTab } from './IdentityAccessTab';
import { HoldersTab } from './HoldersTab';
import { AccessPathTab } from './AccessPathTab';
import { SodViolationsTab } from './SodViolationsTab';
import { ResyncModal } from './ResyncModal';

const TABS = ['identity', 'holders', 'path', 'sod'] as const;
type ExplorerTab = (typeof TABS)[number];

export const AccessExplorerPage: React.FC = () => {
  const qc = useQueryClient();
  const isSuperAdmin = usePermission('super-admin');
  const [searchParams, setSearchParams] = useSearchParams();
  const [resyncOpen, setResyncOpen] = useState(false);

  const requested = searchParams.get('tab') as ExplorerTab | null;
  const tab: ExplorerTab = requested && TABS.includes(requested) ? requested : 'identity';
  const identityId = searchParams.get('identity') ?? undefined;
  const entitlementId = searchParams.get('entitlement') ?? undefined;

  const update = (changes: Record<string, string | undefined>) => {
    const next = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(changes)) {
      if (value && !(key === 'tab' && value === 'identity')) next.set(key, value);
      else next.delete(key);
    }
    setSearchParams(next, { replace: true });
  };
  const setIdentity = (id: string | undefined) => update({ identity: id });
  const setEntitlement = (id: string | undefined) => update({ entitlement: id });
  const loadGraph = isSuperAdmin ? () => setResyncOpen(true) : undefined;

  return (
    <PageContainer>
      <PageHeader
        title="Access explorer"
        subtitle={PAGE_SUBTITLE}
        actions={
          <Space wrap>
            <Button
              icon={<ReloadOutlined />}
              onClick={() => qc.invalidateQueries({ queryKey: accessExplorerKeys.all })}
            >
              Refresh
            </Button>
            {isSuperAdmin && (
              <Button icon={<CloudSyncOutlined />} onClick={() => setResyncOpen(true)}>
                Load graph from MongoDB
              </Button>
            )}
          </Space>
        }
      />
      <Card size="small" role="region" aria-label="Access explorer">
        <Tabs
          activeKey={tab}
          onChange={(key) => update({ tab: key })}
          destroyOnHidden
          items={[
            {
              key: 'identity',
              label: 'Identity access',
              children: (
                <IdentityAccessTab
                  identityId={identityId}
                  onIdentity={setIdentity}
                  onShowHolders={(id) => update({ tab: 'holders', entitlement: id })}
                  onLoadGraph={loadGraph}
                />
              ),
            },
            {
              key: 'holders',
              label: 'Entitlement holders',
              children: (
                <HoldersTab
                  entitlementId={entitlementId}
                  onEntitlement={setEntitlement}
                  onShowIdentity={(id) => update({ tab: 'identity', identity: id })}
                  onLoadGraph={loadGraph}
                />
              ),
            },
            {
              key: 'path',
              label: 'Access path',
              children: (
                <AccessPathTab
                  identityId={identityId}
                  entitlementId={entitlementId}
                  onIdentity={setIdentity}
                  onEntitlement={setEntitlement}
                />
              ),
            },
            {
              key: 'sod',
              label: 'SoD violations',
              children: (
                <SodViolationsTab
                  identityId={identityId}
                  onIdentity={setIdentity}
                  onLoadGraph={loadGraph}
                />
              ),
            },
          ]}
        />
      </Card>
      {resyncOpen && <ResyncModal onClose={() => setResyncOpen(false)} />}
    </PageContainer>
  );
};
