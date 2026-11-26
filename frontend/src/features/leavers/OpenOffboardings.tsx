/**
 * Offboardings that left a target or a linked admin account failed, whatever started them: an HR
 * leaver (batch member or not) or deleting the user. The account may still have access there. An
 * admin removes it in the target system by hand and closes the target as removed manually; once
 * none is left failed and no linked admin account failed, the offboarding completes.
 */
import React, { useMemo, useState } from 'react';
import { Skeleton, Space, Table, Tag, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import { useOpenOffboardings } from '@api/leavers-api';
import type { IFailedOffboarding } from '../../interfaces';
import { usePermission } from '../../auth/usePermission';
import { EmptyState } from '../../components/common/EmptyState';
import { PAGE_SIZES } from '@config/pagination';
import { IdentityCell, OffboardingResult } from './LeaverItemsTable';
import { RemovedManuallyModal, type RemovedManuallyTarget } from './RemovedManuallyModal';
import { REASON_LABEL, REASON_TAG } from './leaver-labels';

const { Text } = Typography;

/** Below this width the table scrolls sideways; above it the Offboarding column takes the rest. */
const TABLE_MIN_WIDTH = 820;

/** What started the offboarding: an HR leaver (reason and source) or deleting the user. */
const StartedBy: React.FC<{ item: IFailedOffboarding }> = ({ item }) =>
  item.leaver ? (
    <span>
      <Tag color={REASON_TAG[item.leaver.reason]}>{REASON_LABEL[item.leaver.reason]}</Tag>
      <Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
        HR leaver, {item.leaver.sourceName}
      </Text>
    </span>
  ) : (
    <Tooltip title="Started by deleting the user on the Users page, not by an HR sync">
      <Tag>User deleted</Tag>
    </Tooltip>
  );

export const OpenOffboardings: React.FC = () => {
  const { data, isLoading } = useOpenOffboardings();
  const canClose = usePermission('policy-admin');
  const [target, setTarget] = useState<RemovedManuallyTarget | null>(null);

  const columns = useMemo<ColumnsType<IFailedOffboarding>>(
    () => [
      {
        title: 'Identity',
        key: 'identity',
        width: 220,
        render: (_: unknown, item) => (
          <IdentityCell displayName={item.displayName} email={item.email} />
        ),
      },
      {
        title: 'Started by',
        key: 'startedBy',
        width: 190,
        render: (_: unknown, item) => <StartedBy item={item} />,
      },
      {
        title: 'Finished',
        key: 'finishedAt',
        width: 150,
        render: (_: unknown, item) => dayjs(item.offboarding.finishedAt).format('YYYY-MM-DD HH:mm'),
      },
      {
        title: 'Offboarding',
        key: 'offboarding',
        render: (_: unknown, item) => (
          <OffboardingResult
            result={item.offboarding}
            onCloseTarget={
              canClose
                ? (s, last) =>
                    setTarget({
                      workflowId: item.workflowId,
                      displayName: item.displayName,
                      system: s.system,
                      failure: s.reason,
                      last,
                    })
                : undefined
            }
          />
        ),
      },
    ],
    [canClose],
  );

  if (isLoading) return <Skeleton active paragraph={{ rows: 4 }} />;
  if (!data?.length) {
    return (
      <EmptyState
        title="No failed offboardings"
        description="Offboardings that could not remove access in a target system appear here, whether an HR sync or deleting the user started them."
      />
    );
  }
  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Text type="secondary">
        EuroID could not remove these accounts. Remove each one in its system, then mark it removed
        manually; the Golden Record stays suspended until no target is left failed. A failed admin
        account is closed on its own row; then offboard the person again.
      </Text>
      <Table<IFailedOffboarding>
        size="small"
        rowKey="workflowId"
        columns={columns}
        dataSource={data}
        pagination={data.length > PAGE_SIZES.MEDIUM ? { pageSize: PAGE_SIZES.MEDIUM } : false}
        tableLayout="fixed"
        scroll={{ x: TABLE_MIN_WIDTH }}
      />
      <RemovedManuallyModal target={target} onClose={() => setTarget(null)} />
    </Space>
  );
};
