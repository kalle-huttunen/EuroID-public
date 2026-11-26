/**
 * Audit integrity: checks that the audit log was not changed. The hash chain over a time window,
 * one event's Merkle proof, the Merkle checkpoints (create one, check them against their events),
 * and a checkpoint's signed anchor in a centered modal. The checks only read. Route, nav entry and
 * every backend route need super-admin; anyone else gets no request.
 */
import React, { useState } from 'react';
import { Button, Result, Space } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { useQueryClient } from '@tanstack/react-query';
import { auditIntegrityKeys, useVerifyEvent } from '@api/audit-integrity-api';
import { PageContainer, PageHeader } from '@shared/PageHeader';
import { usePermission } from '../../auth/usePermission';
import type { IMerkleCheckpoint } from '../../interfaces';
import { AnchorProofModal } from './AnchorProofModal';
import { ChainCheckCard } from './ChainCheckCard';
import { CheckpointsCard } from './CheckpointsCard';
import { EventProofCard } from './EventProofCard';

const TITLE = 'Audit integrity';

export const AuditIntegrityPage: React.FC = () => {
  const qc = useQueryClient();
  const isSuperAdmin = usePermission('super-admin');
  const [eventId, setEventId] = useState('');
  const proof = useVerifyEvent();
  const [anchorFor, setAnchorFor] = useState<IMerkleCheckpoint | null>(null);

  if (!isSuperAdmin) {
    return (
      <PageContainer>
        <PageHeader title={TITLE} />
        <Result status="403" title="Audit integrity checks need the super-admin role." />
      </PageContainer>
    );
  }

  const checkProof = (id: string) => {
    const trimmed = id.trim();
    setEventId(trimmed);
    if (trimmed) proof.mutate(trimmed);
  };

  return (
    <PageContainer>
      <PageHeader
        title={TITLE}
        subtitle="Check that the audit log was not changed: its hash chain, Merkle checkpoints and their signed anchors. The checks only read; Create checkpoint adds a checkpoint."
        actions={
          <Button
            icon={<ReloadOutlined />}
            onClick={() => qc.invalidateQueries({ queryKey: auditIntegrityKeys.all })}
          >
            Refresh
          </Button>
        }
      />
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <ChainCheckCard onCheckProof={checkProof} />
        <EventProofCard
          eventId={eventId}
          onEventIdChange={setEventId}
          onCheck={() => checkProof(eventId)}
          proof={proof}
        />
        <CheckpointsCard onOpenAnchor={setAnchorFor} />
      </Space>
      <AnchorProofModal checkpoint={anchorFor} onClose={() => setAnchorFor(null)} />
    </PageContainer>
  );
};
