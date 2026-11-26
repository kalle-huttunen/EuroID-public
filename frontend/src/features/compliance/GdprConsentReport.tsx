/**
 * The tenant's consent records per purpose (GET /identity/compliance/consent-report, operator).
 * It counts records, and its people count is those with at least one record.
 */
import React from 'react';
import { Card, Skeleton, Table, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useConsentReport } from '@api/gdpr-api';
import { EmptyState } from '@shared/EmptyState';
import { ErrorState } from '@shared/ErrorState';
import { usePermission } from '../../auth/usePermission';
import type { IConsentReport } from '../../interfaces';

const { Text } = Typography;

type Row = IConsentReport['byPurpose'][number];

const columns: ColumnsType<Row> = [
  { title: 'Purpose', dataIndex: 'purpose', key: 'purpose', ellipsis: true },
  { title: 'Granted', dataIndex: 'granted', key: 'granted', width: 110, align: 'right' },
  { title: 'Revoked', dataIndex: 'revoked', key: 'revoked', width: 110, align: 'right' },
  { title: 'Expired', dataIndex: 'expired', key: 'expired', width: 110, align: 'right' },
];

export const GdprConsentReport: React.FC = () => {
  const canRead = usePermission('operator');
  const report = useConsentReport(canRead);
  if (!canRead) return null;

  let body: React.ReactNode;
  if (report.isLoading) {
    body = <Skeleton active paragraph={{ rows: 3 }} />;
  } else if (report.isError) {
    body = (
      <ErrorState
        compact
        title="Could not load the consent report"
        error={report.error}
        onRetry={() => report.refetch()}
      />
    );
  } else if (!report.data?.byPurpose.length) {
    body = <EmptyState title="No consent recorded in this tenant yet" />;
  } else {
    body = (
      <>
        <Text style={{ display: 'block', marginBottom: 12 }}>
          {report.data.totalIdentities}{' '}
          {report.data.totalIdentities === 1 ? 'person has' : 'people have'} at least one consent
          record.
        </Text>
        <Table<Row>
          size="small"
          rowKey="purpose"
          columns={columns}
          dataSource={report.data.byPurpose}
          pagination={false}
          tableLayout="fixed"
          scroll={{ x: 520 }}
        />
      </>
    );
  }

  return (
    <Card size="small" title="Consent across the tenant">
      {body}
      <Text type="secondary" style={{ display: 'block', fontSize: 12, marginTop: 12 }}>
        Counts consent records per purpose. Nothing marks a consent expired after its expiry date,
        so such a consent counts as granted.
      </Text>
    </Card>
  );
};
