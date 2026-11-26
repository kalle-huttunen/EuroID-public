/**
 * OnboardingWizard
 *
 * Guided step-by-step overlay for creating and onboarding a new hire.
 * Steps: Choose Template → User Details → Review → Confirm & Start.
 */

import React, { useState } from 'react';
import {
  Modal,
  Steps,
  Form,
  Input,
  Select,
  Button,
  Space,
  Typography,
  Card,
  Tag,
  Descriptions,
  Alert,
  Empty,
  App,
} from 'antd';
import {
  UserAddOutlined,
  SolutionOutlined,
  FileTextOutlined,
  CheckCircleOutlined,
  DollarOutlined,
  ToolOutlined,
  ClockCircleOutlined,
  CrownOutlined,
  UserOutlined,
  LinkOutlined,
} from '@ant-design/icons';
import { useList } from '@api/resource-hooks';
import { Link } from 'react-router-dom';
import type { RoleBundle } from '../../components/policy-engine/types';
import { EmploymentType, UserStatus, getEmploymentTypeLabel } from '../../interfaces';
import { axiosInstance } from '@api/data';
import { API_BASE } from '@api/constants';
import { getTenantId } from '../../auth/token-store';

const { Text } = Typography;

export interface OnboardingWizardProps {
  open: boolean;
  onClose: () => void;
  onComplete: (workflowId: string) => void;
}

const BUNDLE_ICONS: Record<string, React.ReactNode> = {
  UserOutlined: <UserOutlined />,
  DollarOutlined: <DollarOutlined />,
  ToolOutlined: <ToolOutlined />,
  ClockCircleOutlined: <ClockCircleOutlined />,
  CrownOutlined: <CrownOutlined />,
};

export const OnboardingWizard: React.FC<OnboardingWizardProps> = ({
  open,
  onClose,
  onComplete,
}) => {
  const { message } = App.useApp();
  const { data: bundlesData } = useList<RoleBundle>({ resource: 'role-bundles' });
  const roleBundles: RoleBundle[] = bundlesData?.data ?? [];

  const [currentStep, setCurrentStep] = useState(0);
  const [selectedBundle, setSelectedBundle] = useState<RoleBundle | null>(null);
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resetWizard = () => {
    setCurrentStep(0);
    setSelectedBundle(null);
    form.resetFields();
    setError(null);
  };

  const handleClose = () => {
    resetWizard();
    onClose();
  };

  const step1Valid = async () => {
    try {
      await form.validateFields(['firstName', 'lastName', 'email']);
      return true;
    } catch {
      return false;
    }
  };

  const goNext = async () => {
    setError(null);
    if (currentStep === 1) {
      const valid = await step1Valid();
      if (!valid) return;
    }
    setCurrentStep((s) => Math.min(s + 1, 3));
  };

  const goPrev = () => setCurrentStep((s) => Math.max(s - 1, 0));

  const handleStartOnboarding = async () => {
    setError(null);
    try {
      await form.validateFields();
      const values = form.getFieldsValue();
      setSubmitting(true);

      const payload = {
        firstName: values.firstName,
        lastName: values.lastName,
        email: values.email,
        departmentName: values.department,
        jobTitle: values.jobTitle,
        employmentType: values.employmentType,
        managerEmail: values.managerEmail,
        sourceSystem: 'OnboardingWizard',
        sourceUserId: `onboard-${crypto.randomUUID()}`,
        tenantId: getTenantId() ?? 'default',
        status: UserStatus.PENDING,
      };

      const { data } = await axiosInstance.post(
        `${API_BASE}/identity?triggerWorkflow=true`,
        payload,
      );

      if (data?.workflow?.triggered && data?.workflow?.workflowId) {
        message.success('User created and onboarding workflow started.');
        onComplete(data.workflow.workflowId);
        handleClose();
      } else if (data?.workflow?.triggered === false && data?.workflow?.error) {
        setError(data.workflow.error);
      } else {
        message.success('User created.');
        handleClose();
      }
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { message?: string } }; message?: string };
      const msg =
        axiosErr?.response?.data?.message ||
        axiosErr?.message ||
        'Failed to create user and start onboarding';
      setError(msg);
      message.error(msg);
    } finally {
      setSubmitting(false);
    }
  };

  const steps = [
    { title: 'Template (optional)', icon: <FileTextOutlined /> },
    { title: 'User Details', icon: <UserAddOutlined /> },
    { title: 'Review Checklist', icon: <SolutionOutlined /> },
    { title: 'Confirm & Start', icon: <CheckCircleOutlined /> },
  ];

  const renderStep0 = () => (
    <div style={{ marginTop: 16 }}>
      <Text type="secondary" style={{ display: 'block', marginBottom: 16 }}>
        Optionally pick a role bundle for reference. The hire&apos;s access is granted by the active
        role-based rules the person matches; a bundle applies only through the rules that use it.
      </Text>
      {roleBundles.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={
            <Space direction="vertical" align="center" size={8}>
              <span>No role bundles yet.</span>
              <Text type="secondary" style={{ fontSize: 12, textAlign: 'center', maxWidth: 320 }}>
                Create them in <strong>Design Studio</strong>: open the canvas, click the{' '}
                <strong>Brain</strong> node to open its config, then open the{' '}
                <strong>Policy Engine</strong> tab and switch to <strong>Role Bundles</strong>.
              </Text>
              <Link to="/blueprints">
                <Button type="primary" size="small" icon={<LinkOutlined />}>
                  Open Design Studio
                </Button>
              </Link>
            </Space>
          }
        />
      ) : (
        <Space size="middle" wrap style={{ width: '100%' }}>
          {roleBundles.map((bundle) => (
            <Card
              key={bundle.id}
              size="small"
              hoverable
              onClick={() => setSelectedBundle(bundle)}
              style={{
                width: 200,
                borderColor: selectedBundle?.id === bundle.id ? bundle.color : undefined,
                borderWidth: selectedBundle?.id === bundle.id ? 2 : 1,
              }}
            >
              <Space direction="vertical" size="small" style={{ width: '100%' }}>
                <Space>
                  <span style={{ color: bundle.color, fontSize: 20 }}>
                    {BUNDLE_ICONS[bundle.icon] ?? <UserOutlined />}
                  </span>
                  <Text strong>{bundle.name}</Text>
                </Space>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {bundle.description}
                </Text>
                <Space size={[0, 4]} wrap>
                  {bundle.actions.slice(0, 2).map((a) => (
                    <Tag key={a.id} style={{ fontSize: 10 }}>
                      {a.type}
                    </Tag>
                  ))}
                  {bundle.actions.length > 2 && (
                    <Tag style={{ fontSize: 10 }}>+{bundle.actions.length - 2}</Tag>
                  )}
                </Space>
              </Space>
            </Card>
          ))}
        </Space>
      )}
    </div>
  );

  const renderStep1Fields = () => (
    <>
      <Form.Item
        label="First Name"
        name="firstName"
        rules={[{ required: true, message: 'First name is required' }]}
      >
        <Input placeholder="Jane" />
      </Form.Item>
      <Form.Item
        label="Last Name"
        name="lastName"
        rules={[{ required: true, message: 'Last name is required' }]}
      >
        <Input placeholder="Doe" />
      </Form.Item>
      <Form.Item
        label="Email"
        name="email"
        rules={[
          { required: true, message: 'Email is required' },
          { type: 'email', message: 'Invalid email format' },
        ]}
      >
        <Input placeholder="jane.doe@company.com" />
      </Form.Item>
      <Form.Item label="Department" name="department">
        <Input placeholder="Engineering" />
      </Form.Item>
      <Form.Item label="Job Title" name="jobTitle">
        <Input placeholder="Software Engineer" />
      </Form.Item>
      <Form.Item label="Employment Type" name="employmentType">
        <Select
          options={[
            {
              value: EmploymentType.FULL_TIME,
              label: getEmploymentTypeLabel(EmploymentType.FULL_TIME),
            },
            {
              value: EmploymentType.PART_TIME,
              label: getEmploymentTypeLabel(EmploymentType.PART_TIME),
            },
            {
              value: EmploymentType.CONTRACTOR,
              label: getEmploymentTypeLabel(EmploymentType.CONTRACTOR),
            },
            { value: EmploymentType.INTERN, label: getEmploymentTypeLabel(EmploymentType.INTERN) },
            {
              value: EmploymentType.CONSULTANT,
              label: getEmploymentTypeLabel(EmploymentType.CONSULTANT),
            },
          ]}
        />
      </Form.Item>
      <Form.Item label="Manager Email" name="managerEmail">
        <Input type="email" placeholder="manager@company.com" />
      </Form.Item>
    </>
  );

  const renderStep2 = () => {
    const values = form.getFieldsValue();
    return (
      <div style={{ marginTop: 16 }}>
        <Descriptions column={1} size="small" bordered>
          <Descriptions.Item label="Template">
            {selectedBundle ? (
              <Tag color={selectedBundle.color}>{selectedBundle.name}</Tag>
            ) : (
              'None'
            )}
          </Descriptions.Item>
          <Descriptions.Item label="Name">
            {values.firstName} {values.lastName}
          </Descriptions.Item>
          <Descriptions.Item label="Email">{values.email}</Descriptions.Item>
          <Descriptions.Item label="Department">{values.department || '—'}</Descriptions.Item>
          <Descriptions.Item label="Job Title">{values.jobTitle || '—'}</Descriptions.Item>
          <Descriptions.Item label="Employment Type">
            {values.employmentType ? getEmploymentTypeLabel(values.employmentType) : '—'}
          </Descriptions.Item>
          <Descriptions.Item label="Manager">{values.managerEmail || '—'}</Descriptions.Item>
          {/* The request carries no bundle: onboarding runs the policy engine on the person */}
          <Descriptions.Item label="Access">
            Granted by the active role-based rules the person matches (department, job title,
            employment type)
          </Descriptions.Item>
        </Descriptions>
      </div>
    );
  };

  const renderStep3 = () => (
    <div style={{ marginTop: 16 }}>
      <Text type="secondary" style={{ display: 'block', marginBottom: 12 }}>
        Click "Start Onboarding" to create the user and trigger the provisioning workflow.
      </Text>
      {error && <Alert message={error} type="error" showIcon style={{ marginBottom: 16 }} />}
    </div>
  );

  const renderContent = () => (
    <Form
      form={form}
      layout="vertical"
      style={{ maxWidth: 520, marginTop: 16 }}
      initialValues={{ employmentType: EmploymentType.FULL_TIME }}
    >
      {currentStep === 0 && renderStep0()}
      {currentStep === 1 && renderStep1Fields()}
      {currentStep === 2 && renderStep2()}
      {currentStep === 3 && renderStep3()}
    </Form>
  );

  return (
    <Modal
      title="New Hire Onboarding"
      open={open}
      onCancel={handleClose}
      width={640}
      footer={null}
      destroyOnHidden
    >
      <Steps current={currentStep} items={steps} style={{ marginBottom: 24 }} />

      {renderContent()}

      <div style={{ marginTop: 24, display: 'flex', justifyContent: 'space-between' }}>
        <Button onClick={currentStep === 0 ? handleClose : goPrev}>
          {currentStep === 0 ? 'Cancel' : 'Back'}
        </Button>
        <Space>
          {currentStep < 3 ? (
            <Button type="primary" onClick={goNext}>
              Next
            </Button>
          ) : (
            <Button
              type="primary"
              icon={<CheckCircleOutlined />}
              loading={submitting}
              onClick={handleStartOnboarding}
            >
              Start Onboarding
            </Button>
          )}
        </Space>
      </div>
    </Modal>
  );
};
