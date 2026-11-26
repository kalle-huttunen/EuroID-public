/**
 * PolicyEngineStudio - Main Container Component
 *
 * Orchestrates all Policy Engine views:
 * 1. Policy List (dashboard) - Default view
 * 2. Policy Editor (visual builder) - When editing/creating
 * 3. Policy Preview (impact analysis) - Before activation
 * 4. Role Bundle Manager - Accessible from editor
 *
 * This replaces the simple policy table in ConfigDrawer's Policy Engine tab.
 * Now wired to real backend API at /api/v1/policy.
 */

import React, { useState } from 'react';
import { Space, Segmented, notification } from 'antd';
import { UnorderedListOutlined, AppstoreOutlined, TeamOutlined } from '@ant-design/icons';
import { Policy, RoleBundle } from './types';
import { PolicyList } from './PolicyList';
import { PolicyEditor } from './PolicyEditor';
import { PolicyPreview } from './PolicyPreview';
import { RoleBundleManager } from './RoleBundleManager';
import { GroupListView } from './GroupListView';
import { useSimulatePolicy, useCreatePolicy, useUpdatePolicy } from '@api/policy-api';

type View = 'list' | 'editor' | 'preview' | 'bundles' | 'groups';

export interface SimulationResult {
  totalUsers: number;
  matchedCount: number;
  matchPercentage: number;
  matchedUsers: Array<{
    id: string;
    firstName: string;
    lastName: string;
    email: string;
    department: string;
    jobTitle: string;
    employmentType: string;
    location: string;
    status: string;
  }>;
  actionsBySystem: Record<string, number>;
  totalOperations: number;
}

export const PolicyEngineStudio: React.FC = () => {
  const [currentView, setCurrentView] = useState<View>('list');
  const [selectedPolicy, setSelectedPolicy] = useState<Policy | null>(null);
  const [previewPolicy, setPreviewPolicy] = useState<Partial<Policy> | null>(null);
  const [simulationResult, setSimulationResult] = useState<SimulationResult | null>(null);
  const [activeSegment, setActiveSegment] = useState<string>('policies');
  const [refreshKey, setRefreshKey] = useState(0);
  const [pendingSavePolicy, setPendingSavePolicy] = useState<Partial<Policy> | null>(null);
  const [api, contextHolder] = notification.useNotification();

  const simulateMutation = useSimulatePolicy();
  const createMutation = useCreatePolicy();
  const updateMutation = useUpdatePolicy();

  const handleEditPolicy = (policy: Policy) => {
    setSelectedPolicy(policy);
    setCurrentView('editor');
  };

  const handleCreatePolicy = () => {
    setSelectedPolicy(null);
    setCurrentView('editor');
  };

  const handlePreviewPolicy = async (policy: Policy | Partial<Policy>) => {
    setPreviewPolicy(policy);
    setCurrentView('preview');

    const policyWithId = policy as Policy & { _id?: string };
    const payload =
      policyWithId._id || policyWithId.id
        ? { policyId: policyWithId._id || policyWithId.id }
        : { policy };

    simulateMutation.mutate(payload, {
      onSuccess: (data) => setSimulationResult(data),
      onError: () => {
        api.error({
          message: 'Simulation failed',
          description: 'Could not reach the backend.',
          placement: 'top',
        });
        setSimulationResult(null);
      },
    });
  };

  /**
   * Save now triggers a simulation first, showing the preview for confirmation.
   * The actual persist happens in handleConfirmSave.
   */
  const handleSavePolicy = async (policy: Partial<Policy>) => {
    setPendingSavePolicy(policy);
    setPreviewPolicy(policy);
    setCurrentView('preview');

    simulateMutation.mutate(
      { policy },
      {
        onSuccess: (data) => setSimulationResult(data),
        onError: () => {
          api.warning({
            message: 'Simulation unavailable',
            description: 'Could not run simulation. You can still confirm the save.',
            placement: 'top',
          });
          setSimulationResult(null);
        },
      },
    );
  };

  /** Called from PolicyPreview when the user clicks "Confirm and Save". */
  const handleConfirmSave = async () => {
    if (!pendingSavePolicy) return;
    const policy = pendingSavePolicy;

    const selectedWithId = selectedPolicy as (Policy & { _id?: string }) | null;
    const existingId = selectedWithId?.id || selectedWithId?._id;

    const onSuccess = () => {
      api.success({
        message: 'Policy Saved',
        description: `"${policy.name}" has been saved successfully.`,
        placement: 'top',
      });
      setCurrentView('list');
      setSelectedPolicy(null);
      setPendingSavePolicy(null);
      setRefreshKey((k) => k + 1);
    };

    const onError = () => {
      api.error({
        message: 'Save failed',
        description: 'Could not save the policy.',
        placement: 'top',
      });
    };

    if (existingId) {
      updateMutation.mutate({ id: existingId, policy }, { onSuccess, onError });
    } else {
      createMutation.mutate(policy, { onSuccess, onError });
    }
  };

  const handleCancelEdit = () => {
    setCurrentView('list');
    setSelectedPolicy(null);
  };

  const handleBackFromPreview = () => {
    setPendingSavePolicy(null);
    if (selectedPolicy || previewPolicy) {
      setCurrentView('editor');
    } else {
      setCurrentView('list');
    }
  };

  const handleApplyBundle = (bundle: RoleBundle) => {
    api.info({
      message: 'Bundle Applied',
      description: `"${bundle.name}" actions added. Create a policy to use this bundle.`,
      placement: 'top',
    });
  };

  const handleSegmentChange = (value: string | number) => {
    const val = String(value);
    setActiveSegment(val);
    if (val === 'policies') {
      setCurrentView('list');
    } else if (val === 'bundles') {
      setCurrentView('bundles');
    } else if (val === 'groups') {
      setCurrentView('groups');
    }
  };

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      {contextHolder}

      {/* Navigation - only show when not in editor/preview */}
      {(currentView === 'list' || currentView === 'bundles' || currentView === 'groups') && (
        <Segmented
          value={activeSegment}
          onChange={handleSegmentChange}
          options={[
            {
              value: 'policies',
              label: (
                <Space>
                  <UnorderedListOutlined /> Policies
                </Space>
              ),
            },
            {
              value: 'groups',
              label: (
                <Space>
                  <TeamOutlined /> Group List
                </Space>
              ),
            },
            {
              value: 'bundles',
              label: (
                <Space>
                  <AppstoreOutlined /> Role Bundles
                </Space>
              ),
            },
          ]}
          block
          style={{ marginBottom: 4 }}
        />
      )}

      {/* Views */}
      {currentView === 'list' && (
        <PolicyList
          key={refreshKey}
          onEditPolicy={handleEditPolicy}
          onPreviewPolicy={handlePreviewPolicy}
          onCreatePolicy={handleCreatePolicy}
        />
      )}

      {currentView === 'editor' && (
        <PolicyEditor
          policy={selectedPolicy}
          onSave={handleSavePolicy}
          onCancel={handleCancelEdit}
          onPreview={handlePreviewPolicy}
        />
      )}

      {currentView === 'preview' && previewPolicy && (
        <PolicyPreview
          policy={previewPolicy}
          simulationResult={simulationResult}
          simulationLoading={simulateMutation.isPending}
          onBack={handleBackFromPreview}
          onConfirmSave={pendingSavePolicy ? handleConfirmSave : undefined}
        />
      )}

      {currentView === 'groups' && <GroupListView />}

      {currentView === 'bundles' && <RoleBundleManager onApplyBundle={handleApplyBundle} />}
    </Space>
  );
};
