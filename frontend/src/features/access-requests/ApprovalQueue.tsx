/**
 * ApprovalQueue — pending approvals for managers/owners
 */
import React, { useState } from 'react';
import { EmptyState } from '../../components/common/EmptyState';
import { App, Table, Button, Space, Tag, Modal, Input, Form } from 'antd';
import { CheckOutlined, CloseOutlined, UserAddOutlined } from '@ant-design/icons';
import {
  usePendingApprovals,
  useApproveRequest,
  useRejectRequest,
  useDelegateRequest,
  type AccessRequest,
} from '@api/access-requests-api';
import { apiErrorMessage } from '../dead-letter/dead-letter-labels';

export const ApprovalQueue: React.FC = () => {
  const { message } = App.useApp();
  const { data: requests, isLoading } = usePendingApprovals();
  const approveMutation = useApproveRequest();
  const rejectMutation = useRejectRequest();
  const delegateMutation = useDelegateRequest();
  const [decisionModal, setDecisionModal] = useState<{
    request: AccessRequest;
    action: 'approve' | 'reject';
    stepIndex: number;
  } | null>(null);
  const [delegateModal, setDelegateModal] = useState<{
    request: AccessRequest;
    stepIndex: number;
  } | null>(null);
  const [justification, setJustification] = useState('');
  const [delegateForm] = Form.useForm();

  const pendingList = requests ?? [];

  const handleApprove = (request: AccessRequest) => {
    const pendingStep = request.approvalSteps?.findIndex((s) => s.status === 'PENDING');
    if (pendingStep === undefined || pendingStep < 0) return;
    setDecisionModal({ request, action: 'approve', stepIndex: pendingStep });
  };

  const handleReject = (request: AccessRequest) => {
    const pendingStep = request.approvalSteps?.findIndex((s) => s.status === 'PENDING');
    if (pendingStep === undefined || pendingStep < 0) return;
    setDecisionModal({ request, action: 'reject', stepIndex: pendingStep });
  };

  const handleDelegate = (request: AccessRequest) => {
    const pendingStep = request.approvalSteps?.findIndex((s) => s.status === 'PENDING');
    if (pendingStep === undefined || pendingStep < 0) return;
    setDelegateModal({ request, stepIndex: pendingStep });
    delegateForm.resetFields();
  };

  const submitDecision = async () => {
    if (!decisionModal) return;
    const { request, action, stepIndex } = decisionModal;
    try {
      if (action === 'approve') {
        await approveMutation.mutateAsync({
          requestId: request.requestId,
          body: { stepIndex, justification },
        });
        message.success('Request approved');
      } else {
        await rejectMutation.mutateAsync({
          requestId: request.requestId,
          body: { stepIndex, justification },
        });
        message.success('Request rejected');
      }
      setDecisionModal(null);
      setJustification('');
    } catch (err) {
      // The API says why: the request was closed (409), or try again (503)
      message.error(apiErrorMessage(err, 'Operation failed'));
    }
  };

  const submitDelegate = async () => {
    if (!delegateModal) return;
    try {
      const values = await delegateForm.validateFields();
      await delegateMutation.mutateAsync({
        requestId: delegateModal.request.requestId,
        body: { stepIndex: delegateModal.stepIndex, delegateTo: values.delegateTo },
      });
      message.success('Approval delegated');
      setDelegateModal(null);
    } catch (err) {
      message.error(apiErrorMessage(err, 'Delegation failed'));
    }
  };

  const columns = [
    {
      title: 'Requester',
      dataIndex: 'requesterEmail',
      key: 'requesterEmail',
    },
    {
      title: 'Entitlements',
      key: 'entitlements',
      render: (_: unknown, r: AccessRequest) =>
        r.entitlements?.map((e) => e.entitlementName).join(', ') ?? '—',
    },
    {
      title: 'Step',
      key: 'step',
      render: (_: unknown, r: AccessRequest) => {
        const pending = r.approvalSteps?.find((s) => s.status === 'PENDING');
        return pending ? (
          <Tag color="processing">{pending.approverType} approval pending</Tag>
        ) : (
          '—'
        );
      },
    },
    {
      title: 'Actions',
      key: 'actions',
      render: (_: unknown, record: AccessRequest) => (
        <Space>
          <Button
            type="primary"
            size="small"
            icon={<CheckOutlined />}
            onClick={() => handleApprove(record)}
          >
            Approve
          </Button>
          <Button danger size="small" icon={<CloseOutlined />} onClick={() => handleReject(record)}>
            Reject
          </Button>
          <Button size="small" icon={<UserAddOutlined />} onClick={() => handleDelegate(record)}>
            Delegate
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <>
      <Table
        dataSource={pendingList}
        columns={columns}
        rowKey="requestId"
        loading={isLoading}
        locale={{
          emptyText: (
            <EmptyState title="No pending approvals" description="You're all caught up!" />
          ),
        }}
      />

      <Modal
        title={decisionModal?.action === 'approve' ? 'Approve Request' : 'Reject Request'}
        open={!!decisionModal}
        onOk={submitDecision}
        onCancel={() => {
          setDecisionModal(null);
          setJustification('');
        }}
        confirmLoading={approveMutation.isPending || rejectMutation.isPending}
      >
        {decisionModal && (
          <Space direction="vertical" style={{ width: '100%' }}>
            <p>
              {decisionModal.action === 'approve'
                ? 'Add optional justification for approval:'
                : 'Provide reason for rejection (recommended):'}
            </p>
            <Input.TextArea
              rows={3}
              value={justification}
              onChange={(e) => setJustification(e.target.value)}
              placeholder="Justification..."
            />
          </Space>
        )}
      </Modal>

      <Modal
        title="Delegate Approval"
        open={!!delegateModal}
        onOk={submitDelegate}
        onCancel={() => setDelegateModal(null)}
        confirmLoading={delegateMutation.isPending}
      >
        {delegateModal && (
          <Form form={delegateForm} layout="vertical">
            <Form.Item
              name="delegateTo"
              label="Delegate to (email or identity ID)"
              rules={[
                { required: true, message: 'Enter email or identity ID of the new approver' },
              ]}
            >
              <Input placeholder="user@example.com" />
            </Form.Item>
          </Form>
        )}
      </Modal>
    </>
  );
};
