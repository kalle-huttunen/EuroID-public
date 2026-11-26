/**
 * PiiField / PiiInput – identity PII shown masked until an audited reveal.
 *
 * The API returns PII fields masked ("m•••@example.com"), so the page holds no clear
 * value until the user reveals one. Reveal calls POST /identity/:id/pii/reveal, which
 * writes the PII_REVEALED audit entry and returns the value in the same request.
 * Requires the operator role. Fails closed: if the reveal fails, the field stays masked
 * with an inline error and a retry. Hiding drops the clear value from component state.
 */

import { useState } from 'react';
import { Typography, Button, Tooltip, Input, theme } from 'antd';
import { EyeOutlined, EyeInvisibleOutlined } from '@ant-design/icons';
import { usePermission } from '../../auth/usePermission';
import { revealPiiField } from '@api/identity-api';
import type { PiiFieldName } from '../../utils/pii-fields';

interface RevealState {
  /** identityId:field this state belongs to; another identity or field starts hidden. */
  scope: string;
  /** Clear value while revealed (PiiInput: the draft), null while hidden. */
  value: string | null;
  /** PiiInput only: the user typed a new value, which the form now holds. */
  edited: boolean;
  loading: boolean;
  failed: boolean;
}

const hiddenState = (scope: string, edited = false): RevealState => ({
  scope,
  value: null,
  edited,
  loading: false,
  failed: false,
});

function usePiiReveal(identityId: string | undefined, field: PiiFieldName | undefined) {
  const scope = `${identityId ?? ''}:${field ?? ''}`;
  const [state, setState] = useState<RevealState>(() => hiddenState(scope));
  const current = state.scope === scope ? state : hiddenState(scope);

  const reveal = async () => {
    if (!identityId || !field) return;
    setState({ ...current, loading: true, failed: false });
    try {
      const value = await revealPiiField(identityId, field);
      setState({ ...hiddenState(scope), value: value ?? '' });
    } catch {
      // No audit record, no value. The inline error tells the user and offers a retry.
      setState({ ...hiddenState(scope), failed: true });
    }
  };

  return {
    ...current,
    canReveal: Boolean(identityId && field),
    reveal,
    hide: () => setState(hiddenState(scope, current.edited)),
    edit: (value: string) => setState({ ...hiddenState(scope, true), value }),
  };
}

function RevealFailed({
  label,
  loading,
  onRetry,
}: {
  label: string;
  loading: boolean;
  onRetry: () => void;
}) {
  return (
    <span role="alert" style={{ display: 'block' }}>
      <Typography.Text type="danger" style={{ fontSize: 12 }}>
        Access could not be logged, so the value stays hidden.
      </Typography.Text>
      <Button
        type="link"
        size="small"
        loading={loading}
        onClick={onRetry}
        aria-label={`Retry revealing ${label}`}
        style={{ fontSize: 12, height: 'auto', paddingBlock: 0 }}
      >
        Retry
      </Button>
    </span>
  );
}

function RevealButton({
  label,
  title,
  loading,
  onReveal,
}: {
  label: string;
  title: string;
  loading: boolean;
  onReveal: () => void;
}) {
  return (
    <Tooltip title={title}>
      <Button
        type="link"
        size="small"
        icon={<EyeOutlined />}
        loading={loading}
        aria-label={`Reveal ${label}`}
        onClick={onReveal}
      />
    </Tooltip>
  );
}

function HideButton({ label, onHide }: { label: string; onHide: () => void }) {
  return (
    <Button
      type="link"
      size="small"
      icon={<EyeInvisibleOutlined />}
      aria-label={`Hide ${label}`}
      onClick={onHide}
    />
  );
}

export interface PiiFieldProps {
  /** Value as returned by the API: masked for PII fields. */
  value: string;
  label: string;
  /** If true, this field is PII: shown masked, with an audited reveal */
  sensitive?: boolean;
  /** Identity the field belongs to (needed to reveal) */
  identityId?: string;
  /** API name of the PII field (needed to reveal) */
  field?: PiiFieldName;
}

export function PiiField({ value, label, sensitive = false, identityId, field }: PiiFieldProps) {
  const canViewPii = usePermission('operator');
  const pii = usePiiReveal(identityId, field);

  if (!sensitive || !value) {
    return <Typography.Text>{value || '—'}</Typography.Text>;
  }

  if (!canViewPii) {
    return (
      <Tooltip title="You do not have permission to view this field. Personal data — handled per GDPR.">
        <Typography.Text type="secondary" aria-label="Sensitive field hidden">
          ••••••••
        </Typography.Text>
      </Tooltip>
    );
  }

  if (pii.value === null) {
    return (
      <span>
        <Typography.Text aria-label="Sensitive field hidden">{value}</Typography.Text>
        {pii.failed ? (
          <RevealFailed label={label} loading={pii.loading} onRetry={pii.reveal} />
        ) : (
          pii.canReveal && (
            <RevealButton
              label={label}
              title={`Reveal ${label} (action will be logged). Personal data — handled per GDPR.`}
              loading={pii.loading}
              onReveal={pii.reveal}
            />
          )
        )}
      </span>
    );
  }

  return (
    <span aria-live="polite" aria-label="Field revealed">
      <Typography.Text>{pii.value || '—'}</Typography.Text>
      <HideButton label={label} onHide={pii.hide} />
    </span>
  );
}

/** Form-friendly PII input: masked until an audited reveal, then an Input for editing. */
export interface PiiInputProps {
  /** Form value: the masked value from the API until the user edits after a reveal. */
  value?: string;
  /** Form.Item onChange; receives the new clear value. */
  onChange?: (value: string) => void;
  label: string;
  /** Identity the field belongs to (needed to reveal) */
  identityId?: string;
  /** API name of the PII field (needed to reveal) */
  field?: PiiFieldName;
  disabled?: boolean;
  placeholder?: string;
  [key: string]: unknown;
}

export function PiiInput({
  value,
  onChange,
  label,
  identityId,
  field,
  disabled,
  placeholder,
  ...inputProps
}: PiiInputProps) {
  const { token } = theme.useToken();
  const canViewPii = usePermission('operator');
  const pii = usePiiReveal(identityId, field);

  if (!canViewPii) {
    return (
      <Input
        {...inputProps}
        value="••••••••"
        disabled
        readOnly
        style={{ color: token.colorTextTertiary }}
      />
    );
  }

  if (pii.value === null) {
    // An edited value is the user's own input, held by the form; it is shown again without a reveal.
    const show = () => (pii.edited ? pii.edit(value ?? '') : pii.reveal());
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
        <Typography.Text aria-label="Sensitive field hidden" type={value ? undefined : 'secondary'}>
          {pii.edited ? '•••••••• (edited)' : value || '—'}
        </Typography.Text>
        {pii.failed ? (
          <RevealFailed label={label} loading={pii.loading} onRetry={pii.reveal} />
        ) : (
          pii.canReveal && (
            <RevealButton
              label={label}
              title={`Reveal ${label} to edit (action will be logged)`}
              loading={pii.loading}
              onReveal={show}
            />
          )
        )}
      </span>
    );
  }

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }} aria-live="polite">
      <Input
        {...inputProps}
        value={pii.value}
        onChange={(e) => {
          pii.edit(e.target.value);
          onChange?.(e.target.value);
        }}
        disabled={disabled}
        placeholder={placeholder}
        style={{ flex: 1, maxWidth: 300 }}
        aria-label={label}
      />
      <HideButton label={label} onHide={pii.hide} />
    </span>
  );
}
