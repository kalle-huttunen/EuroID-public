/**
 * CreateUserModal.tsx
 *
 * Modal form for manually creating users in the Identity Hub.
 * Supports two modes:
 * 1. "Create User" - Save to database only
 * 2. "Create & Run Pipeline" - Save and immediately trigger onboarding workflow
 *
 * Progressive disclosure pattern: Advanced fields are collapsed by default.
 */

import React, { useState } from 'react';
import {
  Modal,
  Form,
  Input,
  Select,
  Button,
  Space,
  Collapse,
  App,
  DatePicker,
  Checkbox,
  Row,
  Col,
  theme,
} from 'antd';
import {
  UserAddOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  DeleteOutlined,
} from '@ant-design/icons';
import { axiosInstance } from '@api/data';
import { API_BASE } from '@api/constants';
import { UserStatus, EmploymentType, ContractStatus } from '../../interfaces';
import { getTenantId } from '../../auth/token-store';

const { Option } = Select;

interface CreateUserModalProps {
  open: boolean;
  onClose: () => void;
  onSuccess: (workflowId?: string) => void;
}

export const CreateUserModal: React.FC<CreateUserModalProps> = ({ open, onClose, onSuccess }) => {
  const { message } = App.useApp();
  const { token } = theme.useToken();
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [triggerWorkflow, setTriggerWorkflow] = useState(false);

  const handleSubmit = async (shouldTriggerWorkflow: boolean) => {
    try {
      setTriggerWorkflow(shouldTriggerWorkflow);
      const values = await form.validateFields();
      setLoading(true);

      if (values.startDate) {
        values.startDate = values.startDate.toISOString();
      }
      if (values.endDate) {
        values.endDate = values.endDate.toISOString();
      }

      const rawContracts = values.contracts;
      if (Array.isArray(rawContracts) && rawContracts.length > 0) {
        interface RawContract {
          id?: string;
          title?: string;
          department?: string;
          isPrimary?: boolean;
          status?: string;
        }
        const contracts = rawContracts
          .filter((c: RawContract) => c?.title?.trim() || c?.department?.trim())
          .map((c: RawContract, index: number) => ({
            id: c.id?.trim() || `contract-${index + 1}`,
            title: (c.title ?? '').trim() || 'Untitled',
            department: (c.department ?? '').trim() || 'General',
            isPrimary: !!c.isPrimary,
            status: (c.status === ContractStatus.TERMINATED
              ? ContractStatus.TERMINATED
              : ContractStatus.ACTIVE) as ContractStatus,
          }));
        if (contracts.length > 0) {
          const hasPrimary = contracts.some((c) => c.isPrimary);
          if (!hasPrimary) contracts[0].isPrimary = true;
          values.contracts = contracts;
        } else {
          delete values.contracts;
        }
      }

      const { data } = await axiosInstance.post(
        `${API_BASE}/identity?triggerWorkflow=${shouldTriggerWorkflow}`,
        values,
      );

      if (shouldTriggerWorkflow && data.workflow?.triggered) {
        message.success({
          content: `User created and workflow started!`,
          duration: 3,
        });
        onSuccess(data.workflow.workflowId);
      } else {
        message.success({
          content: 'User created successfully',
          duration: 2,
        });
        onSuccess();
      }

      form.resetFields();
      onClose();
    } catch (error: unknown) {
      console.error('[CreateUserModal] Failed to create user:', error);

      const axiosErr = error as {
        response?: { data?: { message?: string | string[] } };
        errorFields?: unknown;
        message?: string;
      };
      const errMsg = axiosErr.response?.data?.message;
      if (errMsg) {
        const text = Array.isArray(errMsg) ? errMsg.join(', ') : errMsg;
        message.error(text);
      } else if (axiosErr.errorFields) {
        message.error('Please fix validation errors');
      } else {
        message.error(axiosErr.message || 'Failed to create user');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      title={
        <Space>
          <UserAddOutlined />
          <span>Create Test User</span>
        </Space>
      }
      open={open}
      onCancel={onClose}
      width={700}
      footer={
        <Space>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            type="default"
            icon={<UserAddOutlined />}
            onClick={() => handleSubmit(false)}
            loading={loading && !triggerWorkflow}
          >
            Create User
          </Button>
          <Button
            type="primary"
            icon={<PlayCircleOutlined />}
            onClick={() => handleSubmit(true)}
            loading={loading && triggerWorkflow}
            style={{ backgroundColor: token.colorSuccess, borderColor: token.colorSuccess }}
          >
            Create & Run Pipeline
          </Button>
        </Space>
      }
    >
      <Form
        form={form}
        layout="vertical"
        initialValues={{
          sourceSystem: 'Manual-Test',
          sourceUserId: `test-${crypto.randomUUID()}`,
          tenantId: getTenantId() ?? 'default',
          status: UserStatus.PENDING,
        }}
      >
        {/* Required Fields */}
        <div style={{ marginBottom: token.marginLG }}>
          <Row gutter={16}>
            <Col xs={24} sm={12}>
              <Form.Item
                label="First Name"
                name="firstName"
                rules={[{ required: true, message: 'First name is required' }]}
              >
                <Input placeholder="Alice" />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12}>
              <Form.Item
                label="Last Name"
                name="lastName"
                rules={[{ required: true, message: 'Last name is required' }]}
              >
                <Input placeholder="Test" />
              </Form.Item>
            </Col>
          </Row>

          <Form.Item
            label="Email"
            name="email"
            rules={[
              { required: true, message: 'Email is required' },
              { type: 'email', message: 'Invalid email format' },
            ]}
          >
            <Input placeholder="alice.test@company.com" />
          </Form.Item>

          <Row gutter={16}>
            <Col xs={24} sm={12}>
              <Form.Item
                label="Source System"
                name="sourceSystem"
                rules={[{ required: true }]}
                tooltip="Where this record comes from. An HR source of the tenant is refused: its records come from the HR sync only."
              >
                <Input placeholder="Manual-Test" />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12}>
              <Form.Item
                label="Source User ID"
                name="sourceUserId"
                rules={[{ required: true }]}
                tooltip="Unique ID from source system (auto-generated for tests)"
              >
                <Input placeholder="test-123456" />
              </Form.Item>
            </Col>
          </Row>

          <Row gutter={16}>
            <Col xs={24} sm={12}>
              <Form.Item
                label="Tenant ID"
                name="tenantId"
                rules={[{ required: true }]}
                tooltip="Tenant identifier for multi-tenancy"
              >
                <Input placeholder="default" />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12}>
              <Form.Item label="Status" name="status" rules={[{ required: true }]}>
                <Select>
                  <Option value={UserStatus.PENDING}>Pending</Option>
                  <Option value={UserStatus.ACTIVE}>Active</Option>
                  <Option value={UserStatus.INACTIVE}>Inactive</Option>
                </Select>
              </Form.Item>
            </Col>
          </Row>
        </div>

        {/* Advanced Fields (Collapsed) */}
        <Collapse
          ghost
          style={{ marginTop: token.marginMD }}
          items={[
            {
              key: '1',
              label: 'Advanced Fields (Optional)',
              children: (
                <>
                  <Row gutter={16}>
                    <Col xs={24} sm={12}>
                      <Form.Item label="Preferred Name" name="preferredName">
                        <Input placeholder="Ali" />
                      </Form.Item>
                    </Col>
                    <Col xs={24} sm={12}>
                      <Form.Item label="Job Title" name="jobTitle">
                        <Input placeholder="Software Engineer" />
                      </Form.Item>
                    </Col>
                  </Row>

                  <Row gutter={16}>
                    <Col xs={24} sm={8}>
                      <Form.Item label="Department Code" name="departmentCode">
                        <Input placeholder="ENG-001" />
                      </Form.Item>
                    </Col>
                    <Col xs={24} sm={8}>
                      <Form.Item label="Department Name" name="departmentName">
                        <Input placeholder="Engineering" />
                      </Form.Item>
                    </Col>
                    <Col xs={24} sm={8}>
                      <Form.Item label="Division" name="division">
                        <Input placeholder="Product" />
                      </Form.Item>
                    </Col>
                  </Row>

                  <Row gutter={16}>
                    <Col xs={24} sm={8}>
                      <Form.Item label="Location" name="location">
                        <Input placeholder="US-NYC" />
                      </Form.Item>
                    </Col>
                    <Col xs={24} sm={8}>
                      <Form.Item label="City" name="city">
                        <Input placeholder="New York" />
                      </Form.Item>
                    </Col>
                    <Col xs={24} sm={8}>
                      <Form.Item label="Country Code" name="countryCode">
                        <Input placeholder="US" />
                      </Form.Item>
                    </Col>
                  </Row>

                  <Row gutter={16}>
                    <Col xs={24} sm={12}>
                      <Form.Item label="Mobile Phone" name="mobilePhone">
                        <Input placeholder="+1 (555) 123-4567" />
                      </Form.Item>
                    </Col>
                    <Col xs={24} sm={12}>
                      <Form.Item label="Work Phone" name="workPhone">
                        <Input placeholder="+1 (555) 987-6543" />
                      </Form.Item>
                    </Col>
                  </Row>

                  <Form.Item label="Employment Type" name="employmentType">
                    <Select placeholder="Select employment type">
                      <Option value={EmploymentType.FULL_TIME}>Full-Time</Option>
                      <Option value={EmploymentType.PART_TIME}>Part-Time</Option>
                      <Option value={EmploymentType.CONTRACTOR}>Contractor</Option>
                      <Option value={EmploymentType.INTERN}>Intern</Option>
                      <Option value={EmploymentType.CONSULTANT}>Consultant</Option>
                    </Select>
                  </Form.Item>

                  <Row gutter={16}>
                    <Col xs={24} sm={12}>
                      <Form.Item label="Start Date" name="startDate">
                        <DatePicker style={{ width: '100%' }} />
                      </Form.Item>
                    </Col>
                    <Col xs={24} sm={12}>
                      <Form.Item label="End Date" name="endDate">
                        <DatePicker style={{ width: '100%' }} />
                      </Form.Item>
                    </Col>
                  </Row>

                  <Form.Item label="Manager Email" name="managerEmail">
                    <Input placeholder="manager@company.com" type="email" />
                  </Form.Item>

                  <Form.Item
                    label="Tags (comma-separated)"
                    name="tags"
                    getValueFromEvent={(e) =>
                      e.target.value ? e.target.value.split(',').map((t: string) => t.trim()) : []
                    }
                    getValueProps={(value) => ({
                      value: Array.isArray(value) ? value.join(', ') : value,
                    })}
                  >
                    <Input placeholder="new-hire, engineering, remote" />
                  </Form.Item>
                </>
              ),
            },
            {
              key: '2',
              label: 'Employments (multi-contract)',
              children: (
                <>
                  <p style={{ marginBottom: 12, color: token.colorTextSecondary, fontSize: 12 }}>
                    Add multiple roles (e.g. Surgeon + Professor). The first contract is primary by
                    default; root Job Title and Department are derived from the primary contract.
                  </p>
                  <Form.List name="contracts">
                    {(fields, { add, remove }) => (
                      <>
                        {fields.map(({ key, name, ...restField }) => (
                          <Row
                            key={key}
                            gutter={[8, 0]}
                            align="middle"
                            style={{
                              marginBottom: 12,
                              padding: 12,
                              background: token.colorBgElevated,
                              borderRadius: 8,
                            }}
                          >
                            <Col xs={12} sm={4}>
                              <Form.Item
                                {...restField}
                                name={[name, 'id']}
                                label="Id"
                                style={{ marginBottom: 0 }}
                              >
                                <Input placeholder="c1" />
                              </Form.Item>
                            </Col>
                            <Col xs={12} sm={6}>
                              <Form.Item
                                {...restField}
                                name={[name, 'title']}
                                label="Title"
                                style={{ marginBottom: 0 }}
                              >
                                <Input placeholder="Surgeon" />
                              </Form.Item>
                            </Col>
                            <Col xs={12} sm={5}>
                              <Form.Item
                                {...restField}
                                name={[name, 'department']}
                                label="Department"
                                style={{ marginBottom: 0 }}
                              >
                                <Input placeholder="Surgery" />
                              </Form.Item>
                            </Col>
                            <Col xs={6} sm={3}>
                              <Form.Item
                                {...restField}
                                name={[name, 'isPrimary']}
                                label="Primary"
                                valuePropName="checked"
                                style={{ marginBottom: 0 }}
                              >
                                <Checkbox />
                              </Form.Item>
                            </Col>
                            <Col xs={12} sm={4}>
                              <Form.Item
                                {...restField}
                                name={[name, 'status']}
                                label="Status"
                                style={{ marginBottom: 0 }}
                              >
                                <Select
                                  options={[
                                    { value: ContractStatus.ACTIVE, label: 'Active' },
                                    { value: ContractStatus.TERMINATED, label: 'Terminated' },
                                  ]}
                                />
                              </Form.Item>
                            </Col>
                            <Col xs={6} sm={2}>
                              <Button
                                type="text"
                                danger
                                aria-label="Remove entry"
                                icon={<DeleteOutlined />}
                                onClick={() => remove(name)}
                                style={{ marginTop: 30 }}
                              />
                            </Col>
                          </Row>
                        ))}
                        <Form.Item>
                          <Button
                            type="dashed"
                            onClick={() => add({ status: ContractStatus.ACTIVE })}
                            block
                            icon={<PlusOutlined />}
                          >
                            Add employment contract
                          </Button>
                        </Form.Item>
                      </>
                    )}
                  </Form.List>
                </>
              ),
            },
          ]}
        />
      </Form>
    </Modal>
  );
};
