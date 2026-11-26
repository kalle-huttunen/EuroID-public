/**
 * Bulk operations wizard: CSV upload → field mapping → preview → execute → results.
 * Orchestrates bulk-provisioning workflow via Temporal.
 */
import React, { useState, useCallback } from 'react';
import { Card, Steps, Button, Space, message, theme } from 'antd';
import { CsvUploader, type ParsedCsv } from './CsvUploader';
import { FieldMapper, type FieldMapping } from './FieldMapper';
import { BulkPreview } from './BulkPreview';
import { BulkProgress } from './BulkProgress';
import { BulkResults } from './BulkResults';
import type { IBulkOperation } from '../../interfaces/bulk-operation.interface';
import { axiosInstance } from '@api/data';
import { getTenantId } from '../../auth/token-store';
import { useAuthContext } from '../../auth/auth-context';
import { LiveBadge } from '@shared/LiveBadge';
import { BULK_PROVISIONING_API } from '@config/api-routes';
import { CONNECTOR_NAME_TO_ID } from '@config/connector-mapping';
import { PageContainer, PageHeader } from '@shared/PageHeader';
import { apiErrorMessage } from '../dead-letter/dead-letter-labels';

const STEPS = [
  { title: 'Upload CSV' },
  { title: 'Map Fields' },
  { title: 'Preview & Configure' },
  { title: 'Execute' },
  { title: 'Results' },
];

export const BulkOperations: React.FC = () => {
  const { token } = theme.useToken();
  const auth = useAuthContext();
  const [currentStep, setCurrentStep] = useState(0);
  const [parsedCsv, setParsedCsv] = useState<ParsedCsv | null>(null);
  const [mapping, setMapping] = useState<FieldMapping>({});
  const [operationType, setOperationType] = useState<IBulkOperation['type']>('CREATE');
  const [targetSystems, setTargetSystems] = useState<string[]>([]);
  const [dryRun, setDryRun] = useState(true);
  const [continueOnError, setContinueOnError] = useState(true);
  const [batchSize, setBatchSize] = useState(10);
  const [requireApprovalForDeletes, setRequireApprovalForDeletes] = useState(true);
  const [workflowId, setWorkflowId] = useState<string | null>(null);

  const toBackendTargetSystems = useCallback((names: string[]) => {
    return names.map((n) => CONNECTOR_NAME_TO_ID[n] ?? n.toLowerCase().replace(/\s+/g, '-'));
  }, []);

  const startWorkflow = useCallback(
    async (operations: IBulkOperation[]) => {
      const batchId = `batch-${Date.now()}`;
      const tenantId = getTenantId() ?? 'dev-tenant';
      const payload = {
        batchId,
        tenantId,
        operations: operations.map((op) => ({
          ...op,
          user: {
            ...op.user,
            tenantId: op.user.tenantId ?? tenantId,
            status: op.user.status ?? 'ACTIVE',
          },
          targetSystems: toBackendTargetSystems(op.targetSystems),
          priority: 'NORMAL' as const,
        })),
        dryRun,
        continueOnError,
        batchSize,
        requireApprovalForDeletes,
        initiatedBy: auth.user?.profile?.email ?? 'unknown',
        notes: 'Bulk import from CSV',
      };
      try {
        const { data: json } = await axiosInstance.post(`${BULK_PROVISIONING_API}/start`, payload);
        const wfId = json.workflowId ?? json.workflow_id;
        if (wfId) setWorkflowId(wfId);
        setCurrentStep(3);
      } catch (e) {
        console.error(e);
        message.error(apiErrorMessage(e, 'Failed to start bulk job'));
      }
    },
    [
      dryRun,
      continueOnError,
      batchSize,
      requireApprovalForDeletes,
      toBackendTargetSystems,
      auth.user?.profile?.email,
    ],
  );

  // The preview keeps Execute disabled until the start request settles
  const handleExecute = useCallback(
    (operations: IBulkOperation[]) => startWorkflow(operations),
    [startWorkflow],
  );

  const handleProgressComplete = useCallback(() => {
    setCurrentStep(4);
  }, []);

  const handleStartNew = useCallback(() => {
    setCurrentStep(0);
    setParsedCsv(null);
    setMapping({});
    setWorkflowId(null);
  }, []);

  const canNext = () => {
    if (currentStep === 0) return !!parsedCsv?.rows?.length;
    if (currentStep === 1) return true;
    if (currentStep === 2) return true;
    return false;
  };

  const renderStepContent = () => {
    switch (currentStep) {
      case 0:
        return <CsvUploader value={parsedCsv} onChange={setParsedCsv} />;
      case 1:
        return (
          <FieldMapper
            parsedCsv={parsedCsv}
            mapping={mapping}
            onMappingChange={setMapping}
            operationType={operationType}
            onOperationTypeChange={setOperationType}
            targetSystems={targetSystems}
            onTargetSystemsChange={setTargetSystems}
          />
        );
      case 2:
        return (
          <BulkPreview
            parsedCsv={parsedCsv}
            mapping={mapping}
            operationType={operationType}
            targetSystems={targetSystems}
            dryRun={dryRun}
            continueOnError={continueOnError}
            batchSize={batchSize}
            requireApprovalForDeletes={requireApprovalForDeletes}
            onDryRunChange={setDryRun}
            onContinueOnErrorChange={setContinueOnError}
            onBatchSizeChange={setBatchSize}
            onRequireApprovalChange={setRequireApprovalForDeletes}
            onExecute={handleExecute}
          />
        );
      case 3:
        return <BulkProgress workflowId={workflowId} onComplete={handleProgressComplete} />;
      case 4:
        return <BulkResults workflowId={workflowId} onStartNew={handleStartNew} />;
      default:
        return null;
    }
  };

  return (
    <PageContainer>
      <PageHeader
        title="Bulk operations"
        titleExtra={<LiveBadge />}
        subtitle="Import a CSV, preview the impact, then provision in one batch"
      />
      <Card>
        <Steps current={currentStep} items={STEPS} style={{ marginBottom: 24 }} />
        <div style={{ minHeight: 280 }}>{renderStepContent()}</div>
        <div style={{ marginTop: 24, display: 'flex', justifyContent: 'space-between' }}>
          <Button
            disabled={currentStep === 0}
            onClick={() => setCurrentStep((s) => Math.max(0, s - 1))}
          >
            Back
          </Button>
          {currentStep < 2 && (
            <Button
              type="primary"
              disabled={!canNext()}
              onClick={() => setCurrentStep((s) => s + 1)}
            >
              Next
            </Button>
          )}
          {currentStep === 2 && (
            <span style={{ color: token.colorTextTertiary }}>
              Use the Execute button above to run the batch.
            </span>
          )}
          {currentStep > 2 && currentStep < 4 && <span />}
          {currentStep === 4 && (
            <Button type="primary" onClick={handleStartNew}>
              Start new batch
            </Button>
          )}
        </div>
      </Card>
    </PageContainer>
  );
};
