/**
 * Compliance Reports – generate SOX and ISO 27001 reports.
 * Backend: POST /api/v1/compliance-reports/generate,
 *         GET /api/v1/compliance-reports,
 *         GET /api/v1/compliance-reports/:id/download
 */

import React, { useState } from 'react';
import {
  Card,
  Row,
  Col,
  Form,
  Select,
  DatePicker,
  Button,
  Table,
  Space,
  Typography,
  message,
  Tag,
  Skeleton,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { DownloadOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import {
  useComplianceReports,
  useGenerateComplianceReport,
  downloadComplianceReport,
  type ReportMetadata,
  type ReportType,
  type ReportFormat,
} from '@api/compliance-api';
import { PageContainer, PageHeader } from '@shared/PageHeader';
import { apiErrorMessage } from '../dead-letter/dead-letter-labels';

const { Text } = Typography;
const { RangePicker } = DatePicker;

const REPORT_TYPES: { value: ReportType; label: string }[] = [
  { value: 'SOX', label: 'SOX' },
  { value: 'ISO27001', label: 'ISO 27001' },
];

const FORMATS: { value: ReportFormat; label: string }[] = [
  { value: 'PDF', label: 'PDF' },
  { value: 'CSV', label: 'CSV' },
];

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const ComplianceReports: React.FC = () => {
  const [form] = Form.useForm();
  const [typeFilter, setTypeFilter] = useState<ReportType | undefined>();

  const { data: reports, isLoading } = useComplianceReports({ type: typeFilter });
  const generateMutation = useGenerateComplianceReport();

  const handleGenerate = async () => {
    const values = await form.validateFields();
    const [from, to] = values.dateRange;
    if (!from || !to) {
      message.error('Please select a date range');
      return;
    }
    try {
      const result = await generateMutation.mutateAsync({
        type: values.type,
        // Whole days: the picker's moments carry a time of day
        dateRange: {
          from: from.startOf('day').toISOString(),
          to: to.endOf('day').toISOString(),
        },
        format: values.format,
      });
      message.success(
        `Report generated. Compliance score: ${result.summary.complianceScore}. Critical findings: ${result.summary.criticalFindings}`,
      );
    } catch (err: unknown) {
      const msg = apiErrorMessage(err, 'Failed to generate report');
      message.error(msg);
    }
  };

  const handleDownload = async (reportId: string) => {
    try {
      await downloadComplianceReport(reportId);
      message.success('Download started');
    } catch (err: unknown) {
      const msg = apiErrorMessage(err, 'Download failed');
      message.error(msg);
    }
  };

  const columns: ColumnsType<ReportMetadata> = [
    {
      title: 'Type',
      dataIndex: 'type',
      key: 'type',
      render: (type: ReportType) => <Tag color={type === 'SOX' ? 'blue' : 'green'}>{type}</Tag>,
    },
    {
      title: 'Format',
      dataIndex: 'format',
      key: 'format',
      width: 80,
    },
    {
      title: 'Date Range',
      key: 'dateRange',
      render: (_, r) =>
        `${dayjs(r.dateRange.from).format('YYYY-MM-DD')} – ${dayjs(r.dateRange.to).format('YYYY-MM-DD')}`,
    },
    {
      title: 'Generated',
      dataIndex: 'generatedAt',
      key: 'generatedAt',
      render: (d: string) => dayjs(d).format('YYYY-MM-DD HH:mm'),
    },
    {
      title: 'Size',
      dataIndex: 'fileSize',
      key: 'fileSize',
      render: (s: number) => formatBytes(s),
    },
    {
      title: 'Summary',
      key: 'summary',
      render: (_, r) => (
        <Space size="small">
          <Text type="secondary">Score: {r.summary?.complianceScore ?? '—'}</Text>
          <Text type="secondary">Findings: {r.summary?.criticalFindings ?? '—'}</Text>
        </Space>
      ),
    },
    {
      title: '',
      key: 'actions',
      width: 100,
      render: (_, r) => (
        <Button
          type="link"
          size="small"
          icon={<DownloadOutlined />}
          onClick={() => handleDownload(r.reportId)}
        >
          Download
        </Button>
      ),
    },
  ];

  return (
    <PageContainer>
      <PageHeader
        title="Compliance reports"
        subtitle="Generate SOX and ISO 27001 reports for auditors. Export as PDF or CSV."
      />

      <Card title="Generate report" style={{ marginBottom: 16 }}>
        <Form
          form={form}
          layout="inline"
          onFinish={handleGenerate}
          initialValues={{
            type: 'SOX',
            format: 'PDF',
            dateRange: [dayjs().subtract(30, 'day'), dayjs()],
          }}
        >
          <Form.Item name="type" label="Report type" rules={[{ required: true }]}>
            <Select options={REPORT_TYPES} style={{ width: 140 }} />
          </Form.Item>
          <Form.Item name="dateRange" label="Date range" rules={[{ required: true }]}>
            <RangePicker />
          </Form.Item>
          <Form.Item name="format" label="Format" rules={[{ required: true }]}>
            <Select options={FORMATS} style={{ width: 100 }} />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" loading={generateMutation.isPending}>
              Generate
            </Button>
          </Form.Item>
        </Form>
      </Card>

      <Card
        title="Generated reports"
        extra={
          <Select
            placeholder="Filter by type"
            allowClear
            style={{ width: 140 }}
            value={typeFilter}
            onChange={setTypeFilter}
            options={REPORT_TYPES}
          />
        }
      >
        {isLoading ? (
          <Skeleton active paragraph={{ rows: 4 }} />
        ) : (
          <Table
            columns={columns}
            dataSource={reports ?? []}
            rowKey="reportId"
            pagination={{ pageSize: 10 }}
            locale={{ emptyText: 'No reports generated yet' }}
          />
        )}
      </Card>
    </PageContainer>
  );
};

export default ComplianceReports;
