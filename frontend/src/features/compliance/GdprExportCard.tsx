/**
 * Data subject access export (GET /identity/:id/dsar-export, operator): saved as a JSON file
 * through the browser. The page shows what the file holds by count only; the package itself, the
 * person's data unmasked, is never put on screen or kept.
 */
import React from 'react';
import { Alert, Button, Card, Descriptions, Typography } from 'antd';
import { DownloadOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import type { IdentityOption } from '@api/identity-api';
import { useDsarExport } from '@api/gdpr-api';
import { usePermission } from '../../auth/usePermission';
import { apiErrorMessage } from '../dead-letter/dead-letter-labels';
import type { IDsarExportSummary } from '../../interfaces';
import { EXPORT_COUNT_LABEL } from './gdpr-labels';

const { Paragraph, Text } = Typography;

const ExportSummary: React.FC<{ summary: IDsarExportSummary }> = ({ summary }) => (
  <Alert
    type="success"
    showIcon
    style={{ marginTop: 16 }}
    message={
      <>
        Export saved as <Text code>{summary.fileName}</Text>
      </>
    }
    description={
      <Descriptions size="small" column={1} style={{ marginTop: 8 }}>
        <Descriptions.Item label="Identity record">1</Descriptions.Item>
        {(Object.keys(EXPORT_COUNT_LABEL) as Array<keyof IDsarExportSummary['counts']>).map(
          (key) => (
            <Descriptions.Item key={key} label={EXPORT_COUNT_LABEL[key]}>
              {summary.counts[key]}
            </Descriptions.Item>
          ),
        )}
        <Descriptions.Item label="Exported">
          {dayjs(summary.exportedAt).format('YYYY-MM-DD HH:mm')} by {summary.exportedBy}
        </Descriptions.Item>
      </Descriptions>
    }
  />
);

export const GdprExportCard: React.FC<{ identity: IdentityOption }> = ({ identity }) => {
  const canExport = usePermission('operator');
  const exportData = useDsarExport();

  return (
    <Card size="small" title="Access export (Articles 15 and 20)" style={{ height: '100%' }}>
      <Paragraph>
        One JSON file with what EuroID holds about the person: the identity record, their timeline,
        the audit entries filed under them, their access review items and exclusions, the access
        they hold, their consent records, their records in every other collection an erasure
        reaches, and their linked admin identities. Other people&apos;s data in those records (who
        approved or decided) is left out.
      </Paragraph>
      <Paragraph type="secondary" style={{ fontSize: 12 }}>
        The file holds the data unmasked, as the person is entitled to it: hand it over through a
        secure channel. Each export is recorded in the audit log with these counts.
      </Paragraph>
      {canExport ? (
        <Button
          type="primary"
          icon={<DownloadOutlined />}
          loading={exportData.isPending}
          onClick={() => exportData.mutate(identity.id)}
        >
          Download export
        </Button>
      ) : (
        <Text type="secondary">The export needs the operator role.</Text>
      )}
      {exportData.isError && (
        <Alert
          type="error"
          showIcon
          style={{ marginTop: 16 }}
          message={`Export failed: ${apiErrorMessage(exportData.error, 'the request failed')}`}
        />
      )}
      {exportData.isSuccess && <ExportSummary summary={exportData.data} />}
    </Card>
  );
};
