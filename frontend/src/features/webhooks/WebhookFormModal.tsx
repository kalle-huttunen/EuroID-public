/**
 * Create or edit a webhook subscription in a centered modal: name, https URL, event types from the
 * backend's list, custom headers, and the signing secret. The secret and the header values are
 * write-only: the backend never answers them, so editing leaves each unchanged unless a new one is
 * entered (the backend answers header names only). An edit sends only what changed (PATCH). The
 * body scrolls under a fixed title and footer, so Save stays in reach on a phone.
 */
import React, { useState } from 'react';
import { Alert, App, Button, Form, Input, Modal, Select, Typography } from 'antd';
import { DeleteOutlined, KeyOutlined, PlusOutlined } from '@ant-design/icons';
import { useCreateWebhook, useUpdateWebhook } from '@api/webhooks-api';
import type { IWebhookSubscription } from '../../interfaces';
import { apiErrorMessage } from '../dead-letter/dead-letter-labels';
import {
  HEADER_VALUE_MAX_LENGTH,
  MAX_EVENT_TYPES,
  SECRET_MAX_LENGTH,
  SECRET_MIN_LENGTH,
  eventTypeOptions,
  generateSigningSecret,
  headerNameProblem,
} from './webhook-labels';
import {
  changesOf,
  toHeaderMap,
  type HeaderRow,
  type WebhookFormValues as FormValues,
} from './webhook-changes';

const { Text } = Typography;

const MODAL_WIDTH = 640;
const EVENT_TYPE_OPTIONS = eventTypeOptions();

/**
 * Whether the text is one URL with a host. Whitespace is refused before parsing: Chromium escapes
 * a space in the host (`siem%20example`) where Node and Firefox fail, so the parser alone would
 * let "https://siem example com" through to the API in some browsers.
 */
function isParsableUrl(text: string): boolean {
  if (/\s/.test(text)) return false;
  try {
    return !!new URL(text).hostname;
  } catch {
    return false;
  }
}

export const WebhookFormModal: React.FC<{
  open: boolean;
  /** The subscription to edit; null creates one. */
  subscription: IWebhookSubscription | null;
  /** Names already in use: the API answers 409 to both a create and a rename onto one. */
  namesInUse: string[];
  onClose: () => void;
}> = ({ open, subscription, namesInUse, onClose }) => {
  const { message } = App.useApp();
  const [form] = Form.useForm<FormValues>();
  const create = useCreateWebhook();
  const update = useUpdateWebhook();
  const [error, setError] = useState<string | null>(null);
  const [secretVisible, setSecretVisible] = useState(false);
  const editing = !!subscription;
  const storedHeaderNames = subscription?.webhook.headerNames ?? [];
  const pending = create.isPending || update.isPending;

  const close = () => {
    setError(null);
    setSecretVisible(false);
    onClose();
  };

  const submit = async (values: FormValues) => {
    setError(null);
    try {
      if (!subscription) {
        await create.mutateAsync({
          name: values.name.trim(),
          filters: { eventTypes: values.eventTypes },
          webhook: {
            url: values.url.trim(),
            headers: toHeaderMap(values.headers),
            signingSecret: values.secret as string,
          },
        });
        message.success(`Subscription "${values.name.trim()}" created.`);
      } else {
        const body = changesOf(subscription, values);
        if (!Object.keys(body).length) {
          message.info('Nothing changed.');
        } else {
          await update.mutateAsync({ id: subscription._id, body });
          message.success(`Subscription "${values.name.trim()}" saved.`);
        }
      }
      close();
    } catch (err) {
      setError(apiErrorMessage(err, 'the request failed'));
    }
  };

  const initialValues: Partial<FormValues> = subscription
    ? {
        name: subscription.name,
        url: subscription.webhook.url,
        eventTypes: subscription.filters.eventTypes,
        // Values are never answered: an empty value keeps the stored one.
        headers: subscription.webhook.headerNames.map((name) => ({ name, value: '' })),
      }
    : { eventTypes: [], headers: [] };

  return (
    <Modal
      open={open}
      title={subscription ? `Edit ${subscription.name}` : 'New webhook subscription'}
      width={MODAL_WIDTH}
      okText={editing ? 'Save changes' : 'Create subscription'}
      confirmLoading={pending}
      onOk={() => form.submit()}
      onCancel={close}
      destroyOnHidden
      styles={{ body: { maxHeight: 'calc(100vh - 240px)', overflowY: 'auto' } }}
    >
      {error && (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 16 }}
          message={`${editing ? 'Not saved' : 'Not created'}: ${error}`}
        />
      )}
      <Form<FormValues>
        form={form}
        layout="vertical"
        initialValues={initialValues}
        onFinish={submit}
        requiredMark="optional"
      >
        <Form.Item
          name="name"
          label="Name"
          rules={[
            { required: true, whitespace: true, message: 'Name the subscription.' },
            { max: 100 },
            {
              validator: (_, value?: string) =>
                value && value.trim() !== subscription?.name && namesInUse.includes(value.trim())
                  ? Promise.reject(new Error('Another subscription has this name.'))
                  : Promise.resolve(),
            },
          ]}
        >
          <Input placeholder="SIEM feed" autoComplete="off" />
        </Form.Item>
        <Form.Item
          name="url"
          label="Endpoint URL"
          extra="https only. EuroID refuses a host that is or resolves to a private, loopback, link-local or cloud metadata address."
          rules={[
            {
              required: true,
              whitespace: true,
              message: 'Enter the URL that receives the events.',
            },
            { max: 2048 },
            {
              // Parsed as the browser and the API parse it. antd's `type: 'url'` pattern refuses
              // an IPv6 host such as https://[2001:db8::1]/: which addresses a webhook may reach
              // is the API's decision, and its refusal is shown in the form.
              validator: (_, value?: string) => {
                const url = value?.trim();
                if (!url) return Promise.resolve();
                if (!/^https:\/\//i.test(url)) {
                  return Promise.reject(new Error('The URL must start with https://.'));
                }
                return isParsableUrl(url)
                  ? Promise.resolve()
                  : Promise.reject(
                      new Error(
                        'Enter a full URL, for example https://siem.example.com/hooks/euroid.',
                      ),
                    );
              },
            },
          ]}
        >
          <Input placeholder="https://siem.example.com/hooks/euroid" autoComplete="off" />
        </Form.Item>
        <Form.Item
          name="eventTypes"
          label="Event types"
          extra="Each delivery carries ids only, never names or email addresses."
          rules={[
            { required: true, type: 'array', min: 1, message: 'Choose at least one event type.' },
            {
              type: 'array',
              max: MAX_EVENT_TYPES,
              message: `At most ${MAX_EVENT_TYPES} event types.`,
            },
          ]}
        >
          <Select
            mode="multiple"
            allowClear
            showSearch
            optionFilterProp="label"
            placeholder="identity.created, identity.*, ..."
            options={EVENT_TYPE_OPTIONS}
            maxTagCount="responsive"
          />
        </Form.Item>
        <Form.Item
          name="secret"
          label={editing ? 'New signing secret' : 'Signing secret'}
          extra={
            <>
              <div>
                {editing
                  ? 'Leave empty to keep the current secret. A new one signs every delivery from now on, retries of earlier events included.'
                  : 'Write-only: EuroID keeps it encrypted and never shows it again. Copy it into the receiving system before you save.'}{' '}
                Receivers check <Text code>X-EuroID-Signature</Text>: sha256= and the HMAC-SHA256 of
                the raw body with this secret.
              </div>
              <Button
                size="small"
                icon={<KeyOutlined />}
                style={{ marginTop: 8 }}
                onClick={() => {
                  form.setFieldValue('secret', generateSigningSecret());
                  void form.validateFields(['secret']);
                  setSecretVisible(true);
                }}
              >
                Generate a secret
              </Button>
            </>
          }
          rules={[
            ...(editing
              ? []
              : [{ required: true, message: 'Enter or generate a signing secret.' }]),
            {
              min: SECRET_MIN_LENGTH,
              max: SECRET_MAX_LENGTH,
              message: `${SECRET_MIN_LENGTH} to ${SECRET_MAX_LENGTH} characters.`,
            },
          ]}
        >
          <Input.Password
            autoComplete="new-password"
            placeholder={editing ? 'Unchanged' : `At least ${SECRET_MIN_LENGTH} characters`}
            visibilityToggle={{ visible: secretVisible, onVisibleChange: setSecretVisible }}
          />
        </Form.Item>
        <Form.Item
          label="Custom headers"
          extra={`Sent with every delivery. Values are write-only: never shown again, though stored unencrypted (the signing secret is the protected credential).${editing ? ' Leave a value empty to keep the stored one.' : ''}`}
        >
          <Form.List name="headers">
            {(fields, { add, remove }) => (
              <>
                {fields.map((field) => (
                  <div
                    key={field.key}
                    style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}
                  >
                    <Form.Item
                      name={[field.name, 'name']}
                      style={{ flex: '1 1 140px', margin: 0 }}
                      rules={[
                        { required: true, message: 'Header name' },
                        {
                          validator: (_, value?: string) => {
                            const problem = value ? headerNameProblem(value.trim()) : undefined;
                            return problem ? Promise.reject(new Error(problem)) : Promise.resolve();
                          },
                        },
                        {
                          validator: (_, value?: string) => {
                            const rows: HeaderRow[] = form.getFieldValue('headers') ?? [];
                            const lower = value?.trim().toLowerCase();
                            const twice =
                              !!lower &&
                              rows.filter((row) => row?.name?.trim().toLowerCase() === lower)
                                .length > 1;
                            return twice
                              ? Promise.reject(new Error('Header named twice.'))
                              : Promise.resolve();
                          },
                        },
                      ]}
                    >
                      <Input
                        placeholder="X-Team"
                        aria-label={`Header ${field.name + 1} name`}
                        autoComplete="off"
                      />
                    </Form.Item>
                    <Form.Item noStyle dependencies={[['headers', field.name, 'name']]}>
                      {() => {
                        const rowName = (
                          form.getFieldValue(['headers', field.name, 'name']) as string | undefined
                        )?.trim();
                        // A stored header keeps its value when the field is left empty.
                        const keeps = !!rowName && storedHeaderNames.includes(rowName);
                        return (
                          <Form.Item
                            name={[field.name, 'value']}
                            style={{ flex: '2 1 180px', margin: 0 }}
                            rules={[
                              { required: !keeps, message: 'Header value' },
                              { max: HEADER_VALUE_MAX_LENGTH },
                            ]}
                          >
                            <Input
                              placeholder={keeps ? 'Unchanged' : 'Value'}
                              aria-label={`Header ${field.name + 1} value`}
                              autoComplete="off"
                            />
                          </Form.Item>
                        );
                      }}
                    </Form.Item>
                    <Button
                      icon={<DeleteOutlined />}
                      aria-label={`Remove header ${field.name + 1}`}
                      onClick={() => remove(field.name)}
                    />
                  </div>
                ))}
                <Button
                  size="small"
                  icon={<PlusOutlined />}
                  onClick={() => add({ name: '', value: '' })}
                >
                  Add header
                </Button>
              </>
            )}
          </Form.List>
        </Form.Item>
      </Form>
    </Modal>
  );
};
