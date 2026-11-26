import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Form } from 'antd';
import { PiiInput } from '../PiiField';
import { usePermission } from '../../../auth/usePermission';
import { axiosInstance } from '@api/data';

vi.mock('../../../auth/usePermission', () => ({
  usePermission: vi.fn(),
}));

vi.mock('@api/data', () => ({
  axiosInstance: { post: vi.fn() },
}));

// What the API returns for the field, and what the audited reveal returns.
const MASKED = '+358 •• ••• 4567';
const CLEAR = '+358 40 123 4567';

/** The profile form: Form.Item hands PiiInput the masked value from the API. */
function renderProfileForm(onValuesChange = vi.fn()) {
  const view = render(
    <Form initialValues={{ mobilePhone: MASKED }} onValuesChange={onValuesChange}>
      <Form.Item name="mobilePhone" label="Mobile Phone">
        <PiiInput label="Mobile Phone" identityId="id-42" field="mobilePhone" />
      </Form.Item>
    </Form>,
  );
  return { ...view, onValuesChange };
}

describe('PiiInput', () => {
  beforeEach(() => {
    vi.mocked(usePermission).mockReturnValue(true);
    vi.mocked(axiosInstance.post).mockReset();
    vi.mocked(axiosInstance.post).mockResolvedValue({
      data: { identityId: 'id-42', field: 'mobilePhone', value: CLEAR },
    });
  });

  it('shows only the masked value and no editable input before a reveal', () => {
    const { container } = renderProfileForm();
    expect(screen.getByLabelText('Sensitive field hidden')).toHaveTextContent(MASKED);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(container.innerHTML).not.toContain(CLEAR);
  });

  it('reveal goes through the audited endpoint and opens the clear value for editing', async () => {
    const { onValuesChange } = renderProfileForm();
    fireEvent.click(screen.getByRole('button', { name: /reveal mobile phone/i }));

    const input = await screen.findByRole('textbox', { name: 'Mobile Phone' });
    expect(input).toHaveValue(CLEAR);
    expect(axiosInstance.post).toHaveBeenCalledWith('/api/v1/identity/id-42/pii/reveal', {
      field: 'mobilePhone',
    });
    // Revealing is not editing: the form keeps the masked value, so a save leaves the field alone.
    expect(onValuesChange).not.toHaveBeenCalled();
  });

  it('an edit after the reveal goes to the form, and hiding keeps it out of the DOM', async () => {
    const { container, onValuesChange } = renderProfileForm();
    fireEvent.click(screen.getByRole('button', { name: /reveal mobile phone/i }));
    const input = await screen.findByRole('textbox', { name: 'Mobile Phone' });

    fireEvent.change(input, { target: { value: '+358 50 999 0000' } });
    expect(onValuesChange).toHaveBeenLastCalledWith(
      { mobilePhone: '+358 50 999 0000' },
      { mobilePhone: '+358 50 999 0000' },
    );

    fireEvent.click(screen.getByRole('button', { name: /hide mobile phone/i }));
    expect(screen.getByLabelText('Sensitive field hidden')).toHaveTextContent('(edited)');
    expect(container.innerHTML).not.toContain('+358 50 999 0000');
    expect(container.innerHTML).not.toContain(CLEAR);

    // Showing the user's own edit again needs no second reveal.
    fireEvent.click(screen.getByRole('button', { name: /reveal mobile phone/i }));
    expect(screen.getByRole('textbox', { name: 'Mobile Phone' })).toHaveValue('+358 50 999 0000');
    expect(axiosInstance.post).toHaveBeenCalledTimes(1);
  });

  it('fails closed: a failed reveal keeps the field masked and not editable', async () => {
    vi.mocked(axiosInstance.post).mockRejectedValueOnce(new Error('403'));
    const { container } = renderProfileForm();
    fireEvent.click(screen.getByRole('button', { name: /reveal mobile phone/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not be logged/i);
    expect(screen.getByLabelText('Sensitive field hidden')).toHaveTextContent(MASKED);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(container.innerHTML).not.toContain(CLEAR);

    fireEvent.click(screen.getByRole('button', { name: /retry revealing mobile phone/i }));
    expect(await screen.findByRole('textbox', { name: 'Mobile Phone' })).toHaveValue(CLEAR);
  });

  it('without operator permission: a disabled placeholder and no reveal', () => {
    vi.mocked(usePermission).mockReturnValue(false);
    renderProfileForm();
    expect(screen.getByDisplayValue('••••••••')).toBeDisabled();
    expect(screen.queryByRole('button', { name: /reveal/i })).not.toBeInTheDocument();
  });
});
