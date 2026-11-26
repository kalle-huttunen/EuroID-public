/**
 * AuditTrailTab -- Configuration change history.
 */
import React from 'react';
import { Space, Alert, Table, Tag } from 'antd';

const auditData = [
    { key: '1', timestamp: '2026-02-07 15:23:45', user: 'admin@euroid.com', action: 'Updated field mapping: email → userPrincipalName', category: 'Field Mapping' },
    { key: '2', timestamp: '2026-02-07 12:10:22', user: 'admin@euroid.com', action: 'Added policy rule: Finance department access', category: 'Policy Engine' },
    { key: '3', timestamp: '2026-02-06 09:45:12', user: 'admin@euroid.com', action: 'Enabled GDPR compliance mode', category: 'Compliance' },
];

const columns = [
    { title: 'Timestamp', dataIndex: 'timestamp', key: 'timestamp', width: 160 },
    { title: 'User', dataIndex: 'user', key: 'user', width: 200 },
    { title: 'Action', dataIndex: 'action', key: 'action' },
    { title: 'Category', dataIndex: 'category', key: 'category', width: 140, render: (cat: string) => <Tag>{cat}</Tag> },
];

export const AuditTrailTab: React.FC = () => (
    <Space direction="vertical" style={{ width: '100%' }} size="large">
        <Alert
            message="Configuration Change History"
            description="Track all changes made to field mappings and policy rules."
            type="info"
            showIcon
        />
        <Table dataSource={auditData} size="small" pagination={false} columns={columns} />
    </Space>
);
