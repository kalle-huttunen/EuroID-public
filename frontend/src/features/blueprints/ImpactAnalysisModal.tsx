/**
 * ImpactAnalysisModal - Full-screen impact analysis (Vercel Deployment Preview style)
 *
 * Replaces SimulationDrawer with a full-width modal: summary stats, User Deltas table,
 * Entra Metadata, Risk Report. Dry Run defaults ON; LIVE MODE shows a red warning.
 */

import React, { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
    Modal, Alert, Space, Button, Typography, Tabs, Switch, Row, Col, Statistic, Skeleton, theme,
} from 'antd';
import {
    PlayCircleOutlined, PlusCircleOutlined, EditOutlined, DeleteOutlined, WarningOutlined,
    SafetyCertificateOutlined, ExperimentOutlined, BarChartOutlined, CheckCircleOutlined,
} from '@ant-design/icons';
import { axiosInstance } from '@api/data';
import { API_BASE } from '@api/constants';
import { fetchConnectorHealth, reconciliationKeys } from '@api/reconciliation-api';
import { IStandardUser } from '../../interfaces';
import type { IUserDelta, IEntraUserMetadata, IRiskSummary, IRiskAssessment, ImpactAnalysisResponse } from '../../interfaces/impact-analysis.interface';
import type { IConnectorHealthStatus } from '../../interfaces/reconciliation.interface';
import { DeltaAnalysis } from './components/blueprint/DeltaAnalysis';
import { EntraIDMetadata } from './components/blueprint/EntraIDMetadata';
import { RiskReportTab } from './RiskReportTab';
import type { UserDelta } from './components/blueprint/DeltaAnalysis';
import { ImpactSummaryTab } from './components/ImpactSummaryTab';
import { ImpactRiskBanner } from './components/ImpactRiskBanner';

const { Text, Title } = Typography;

export interface ImpactAnalysisModalProps {
    open: boolean;
    onClose: () => void;
    testUsers: IStandardUser[];
    activeConnectors: string[];
}

const SUMMARY_DEFAULT: IRiskSummary = { totalUsers: 0, creates: 0, updates: 0, deletes: 0, warnings: 0 };

function toUserDelta(d: IUserDelta): UserDelta {
    return {
        userId: d.userId, displayName: d.displayName, upn: d.upn,
        action: d.action as UserDelta['action'], risk: d.risk,
        changes: d.changes?.map(c => ({ field: c.field, oldValue: c.oldValue ?? null, newValue: c.newValue ?? null, impact: c.impact })),
        warnings: d.warnings, targetSystem: d.targetSystem,
    };
}

export const ImpactAnalysisModal: React.FC<ImpactAnalysisModalProps> = ({ open, onClose, testUsers, activeConnectors }) => {
    const { token } = theme.useToken();
    const [simulating, setSimulating] = useState(false);
    const [dryRunMode, setDryRunMode] = useState(true);
    const [deltas, setDeltas] = useState<IUserDelta[]>([]);
    const [entraMetadata, setEntraMetadata] = useState<IEntraUserMetadata[]>([]);
    const [summary, setSummary] = useState<IRiskSummary>(SUMMARY_DEFAULT);
    const [risk, setRisk] = useState<IRiskAssessment | null>(null);
    const [activeTab, setActiveTab] = useState('summary');
    const [hasRunOnce, setHasRunOnce] = useState(false);
    const [errorMessage, setErrorMessage] = useState<string | null>(null);

    const { data: rawHealth = [], isLoading: healthLoading } = useQuery({
        queryKey: reconciliationKeys.connectorHealth(),
        queryFn: fetchConnectorHealth,
        enabled: open,
    });

    const connectorHealth: IConnectorHealthStatus[] = useMemo(() => {
        if (!Array.isArray(rawHealth) || rawHealth.length === 0) {
            return activeConnectors.map((connectorName) => ({
                connectorName, connectorId: connectorName.toLowerCase().replace(/\s+/g, '-'),
                status: 'unknown' as const, uptime: 0, lastChecked: '',
            }));
        }
        const onBoard = rawHealth.filter((c) => activeConnectors.includes(c.connectorName));
        const missing = activeConnectors.filter((n) => !rawHealth.some((c) => c.connectorName === n));
        return [
            ...onBoard,
            ...missing.map((connectorName) => ({
                connectorName, connectorId: connectorName.toLowerCase().replace(/\s+/g, '-'),
                status: 'unknown' as const, uptime: 0, lastChecked: '',
            })),
        ];
    }, [rawHealth, activeConnectors]);

    const runImpactAnalysis = async () => {
        setSimulating(true); setHasRunOnce(true); setErrorMessage(null);
        try {
            const { data } = await axiosInstance.post<ImpactAnalysisResponse>(`${API_BASE}/blueprints/impact-analysis`, { users: testUsers, connectors: activeConnectors, dryRun: dryRunMode });
            if (data.success) {
                setDeltas(data.deltas ?? []); setEntraMetadata(data.entraMetadata ?? []);
                setSummary(data.summary ?? SUMMARY_DEFAULT); setRisk(data.risk ?? null); setActiveTab('deltas');
            } else { setErrorMessage(data.message ?? 'Impact analysis failed.'); }
        } catch (err: unknown) {
            const e = err as { response?: { data?: { message?: string } }; message?: string };
            setErrorMessage(e?.response?.data?.message ?? e?.message ?? 'Impact analysis request failed.');
        } finally { setSimulating(false); }
    };

    const deltasForDeltaAnalysis = useMemo(() => deltas.map(toUserDelta), [deltas]);
    const vipUserIds = useMemo(() => new Set(testUsers.filter(u => u.priority === 'VIP').map(u => u._id ?? u.sourceUserId)), [testUsers]);
    const hasEntraConnector = useMemo(() => activeConnectors.some(c => c.toLowerCase().includes('entra') || c.toLowerCase().includes('azure')), [activeConnectors]);

    const tabItems = [
        { key: 'summary', label: <Space><BarChartOutlined />Summary</Space>, children: <ImpactSummaryTab hasRunOnce={hasRunOnce} summary={summary} dryRunMode={dryRunMode} healthLoading={healthLoading} connectorHealth={connectorHealth} /> },
        { key: 'deltas', label: <Space><EditOutlined />User Deltas</Space>, children: deltasForDeltaAnalysis.length > 0 ? <DeltaAnalysis deltas={deltasForDeltaAnalysis} loading={simulating} variant="unified" vipUserIds={vipUserIds} /> : simulating ? <Skeleton active paragraph={{ rows: 8 }} /> : hasRunOnce && summary.totalUsers === 0 ? <Alert message="No users to analyze" description="Import users first via HR ingest or manual creation." type="info" showIcon /> : <Alert message="No Analysis Available" description="Run the impact analysis to see what will change across your target systems." type="info" showIcon /> },
        ...(hasEntraConnector ? [{ key: 'entra', label: <Space><SafetyCertificateOutlined />Entra Metadata</Space>, children: entraMetadata.length > 0 ? <EntraIDMetadata users={entraMetadata} loading={simulating} /> : simulating ? <Skeleton active paragraph={{ rows: 6 }} /> : <Alert message="No Entra ID Data" description="Run the analysis to see license assignments, group memberships, and UPN validation." type="info" showIcon /> }] : []),
        { key: 'risk', label: <Space><WarningOutlined />Risk Report</Space>, children: <RiskReportTab deltas={deltas} summary={summary} testUsers={testUsers} loading={simulating} /> },
    ];

    return (
        <Modal
            title={<Space><ExperimentOutlined /><Title level={4} style={{ margin: 0 }}>Impact Analysis</Title></Space>}
            open={open} onCancel={onClose} width="45vw" centered
            styles={{ body: { maxHeight: '75vh', overflow: 'auto' } }} footer={null} destroyOnHidden
        >
            <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
                <Space>
                    <Text type="secondary" style={{ fontSize: 12 }}>Dry Run</Text>
                    <Switch checked={dryRunMode} onChange={setDryRunMode} checkedChildren="On" unCheckedChildren="Live" />
                    <Button type="primary" icon={<PlayCircleOutlined />} onClick={runImpactAnalysis} loading={simulating} disabled={activeConnectors.length === 0}>Run Analysis</Button>
                </Space>
            </div>

            {!dryRunMode && <Alert message="LIVE MODE ACTIVE" description="You are running in LIVE mode. Changes may be written to target systems if you proceed with provisioning." type="error" showIcon style={{ marginBottom: 16 }} closable />}
            {errorMessage && <Alert message="Analysis failed" description={errorMessage} type="error" showIcon style={{ marginBottom: 16 }} closable onClose={() => setErrorMessage(null)} />}
            {hasRunOnce && risk && <ImpactRiskBanner risk={risk} summary={summary} />}

            {hasRunOnce && (
                <Row gutter={16} style={{ marginBottom: 24 }}>
                    <Col xs={12} sm={6}><Statistic title="Creates" value={summary.creates} valueStyle={{ color: token.colorSuccess }} prefix={<PlusCircleOutlined />} /></Col>
                    <Col xs={12} sm={6}><Statistic title="Updates" value={summary.updates} valueStyle={{ color: token.colorPrimary }} prefix={<EditOutlined />} /></Col>
                    <Col xs={12} sm={6}><Statistic title="Deletes" value={summary.deletes} valueStyle={{ color: token.colorError }} prefix={<DeleteOutlined />} /></Col>
                    <Col xs={12} sm={6}><Statistic title={summary.noChange != null ? 'No change' : 'Warnings'} value={summary.noChange ?? summary.warnings ?? 0} valueStyle={{ color: summary.noChange != null ? token.colorTextTertiary : token.colorWarning }} prefix={summary.noChange != null ? <CheckCircleOutlined /> : <WarningOutlined />} /></Col>
                </Row>
            )}

            <Tabs activeKey={activeTab} onChange={setActiveTab} items={tabItems} />
        </Modal>
    );
};
