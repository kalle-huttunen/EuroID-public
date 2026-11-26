/**
 * ComplianceTab -- Data governance & regulatory compliance settings.
 */
import React from 'react';
import { Space, Alert, Card, Switch, Form, Select, Typography } from 'antd';

const { Text } = Typography;

export const ComplianceTab: React.FC = () => (
    <Space direction="vertical" style={{ width: '100%' }} size="large">
        <Alert
            message="Data Governance & Regulatory Compliance"
            description="Configure data retention, PII handling, and compliance requirements."
            type="info"
            showIcon
        />

        <Card title="Active Compliance Frameworks" size="small">
            <Space direction="vertical" style={{ width: '100%' }}>
                <Space>
                    <Switch defaultChecked />
                    <Text>GDPR (EU General Data Protection Regulation)</Text>
                </Space>
                <Space>
                    <Switch defaultChecked />
                    <Text>SOC 2 Type II</Text>
                </Space>
                <Space>
                    <Switch />
                    <Text>HIPAA (Healthcare)</Text>
                </Space>
                <Space>
                    <Switch />
                    <Text>PCI DSS (Payment Card Industry)</Text>
                </Space>
            </Space>
        </Card>

        <Form layout="vertical">
            <Form.Item label="Data Retention Period" tooltip="How long to keep user data after termination">
                <Select defaultValue="7years" style={{ width: 200 }}>
                    <Select.Option value="1year">1 Year</Select.Option>
                    <Select.Option value="3years">3 Years</Select.Option>
                    <Select.Option value="7years">7 Years (Default)</Select.Option>
                    <Select.Option value="forever">Indefinite</Select.Option>
                </Select>
            </Form.Item>

            <Form.Item label="PII Data Classification">
                <Select defaultValue="confidential" style={{ width: 200 }}>
                    <Select.Option value="public">Public</Select.Option>
                    <Select.Option value="internal">Internal</Select.Option>
                    <Select.Option value="confidential">Confidential</Select.Option>
                    <Select.Option value="restricted">Restricted</Select.Option>
                </Select>
            </Form.Item>
        </Form>
    </Space>
);
