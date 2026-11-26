/**
 * BrainConfig -- Top-level tab container for the EuroID Brain configuration.
 * Delegates each tab to its own focused component.
 */
import React from 'react';
import { Tabs, Space } from 'antd';
import {
  TableOutlined,
  ThunderboltOutlined,
  SafetyCertificateOutlined,
  HistoryOutlined,
  LinkOutlined,
} from '@ant-design/icons';
import { PolicyEngineStudio } from '../../../components/policy-engine';
import { FieldMappingTab } from './FieldMappingTab';
import { ComplianceTab } from './ComplianceTab';
import { AuditTrailTab } from './AuditTrailTab';
import { IdentityCorrelationTab } from './IdentityCorrelationTab';
import type { CorrelationConfigFormValues } from './IdentityCorrelationTab';
import type { ActiveConnectorInfo } from '../canvas';
import { useDefaultMastery } from '@api/reconciliation-config-api';
import { usePermission } from '../../../auth/usePermission';

interface Props {
  /** Names of target connectors currently on the canvas */
  activeConnectors: string[];
  /** Full connector info for mastery dropdowns (sources + targets) */
  activeConnectorsForMastery: ActiveConnectorInfo[];
  /** Correlation config from blueprint connectorConfigs['euroid-core'] */
  brainConfig: CorrelationConfigFormValues | null;
  /** Save correlation config to blueprint */
  onCorrelationSave: (values: CorrelationConfigFormValues) => Promise<void>;
}

export const BrainConfig: React.FC<Props> = ({
  activeConnectors,
  activeConnectorsForMastery,
  brainConfig,
  onCorrelationSave,
}) => {
  // The Field Mastery defaults: the tenant's Recon Config, which needs policy-admin to read.
  // The correlation settings are saved on the canvas (POST /blueprints/save): policy-admin too.
  const canEdit = usePermission('policy-admin');
  const defaultMastery = useDefaultMastery(canEdit);
  const brainTabs = [
    {
      key: 'field-mapping',
      label: (
        <Space>
          <TableOutlined />
          Field Mapping
        </Space>
      ),
      children: <FieldMappingTab activeConnectors={activeConnectors} />,
    },
    {
      key: 'policy-engine',
      label: (
        <Space>
          <ThunderboltOutlined />
          Policy Engine
        </Space>
      ),
      children: <PolicyEngineStudio />,
    },
    {
      key: 'compliance',
      label: (
        <Space>
          <SafetyCertificateOutlined />
          Compliance
        </Space>
      ),
      children: <ComplianceTab />,
    },
    {
      key: 'audit',
      label: (
        <Space>
          <HistoryOutlined />
          Audit Trail
        </Space>
      ),
      children: <AuditTrailTab />,
    },
    {
      key: 'identity-correlation',
      label: (
        <Space>
          <LinkOutlined />
          Identity Correlation
        </Space>
      ),
      children: (
        <IdentityCorrelationTab
          brainConfig={brainConfig}
          activeConnectors={activeConnectorsForMastery}
          onSave={onCorrelationSave}
          defaultMastery={defaultMastery}
          readOnly={!canEdit}
        />
      ),
    },
  ];

  return <Tabs items={brainTabs} defaultActiveKey="field-mapping" />;
};
