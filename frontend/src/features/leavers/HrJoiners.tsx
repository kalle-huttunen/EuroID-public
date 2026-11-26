/**
 * HR joiners tab: an HR sync onboards the people it adds on its own (the onboarding workflow),
 * once the pipeline is deployed and their start date has come; a sync above the mass-joiner
 * limit waits here. Pending batches, decided batches, and the tenant's limit.
 */
import React from 'react';
import { Space, Typography } from 'antd';
import { PendingJoinerBatches } from './PendingJoinerBatches';
import { JoinerBatchHistory } from './JoinerBatchHistory';
import { JoinerPolicyForm } from './JoinerPolicyForm';

const { Title } = Typography;

export const HrJoiners: React.FC = () => (
  <Space direction="vertical" size={24} style={{ width: '100%' }}>
    <PendingJoinerBatches />
    <div>
      <Title level={5}>Decided joiner batches</Title>
      <JoinerBatchHistory />
    </div>
    <JoinerPolicyForm />
  </Space>
);
