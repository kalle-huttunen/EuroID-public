/**
 * HR movers tab: an HR sync that changes a person's department, job title, location or manager
 * moves their access on its own (the mover workflow); a sync above the mass-mover limit waits
 * here. Pending batches, decided batches, and the tenant's limit.
 */
import React from 'react';
import { Space, Typography } from 'antd';
import { PendingMoverBatches } from './PendingMoverBatches';
import { MoverBatchHistory } from './MoverBatchHistory';
import { MoverPolicyForm } from './MoverPolicyForm';

const { Title } = Typography;

export const HrMovers: React.FC = () => (
  <Space direction="vertical" size={24} style={{ width: '100%' }}>
    <PendingMoverBatches />
    <div>
      <Title level={5}>Decided mover batches</Title>
      <MoverBatchHistory />
    </div>
    <MoverPolicyForm />
  </Space>
);
