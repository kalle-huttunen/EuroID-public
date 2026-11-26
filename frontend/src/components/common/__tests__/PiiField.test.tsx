import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PiiField } from '../PiiField';
import { usePermission } from '../../../auth/usePermission';
import { axiosInstance } from '@api/data';

vi.mock('../../../auth/usePermission', () => ({
  usePermission: vi.fn(),
}));

// The reveal is an API call; mock the HTTP client so no real request leaves jsdom.
vi.mock('@api/data', () => ({
  axiosInstance: { post: vi.fn() },
}));

// What the API returns for the field, and what the audited reveal returns.
const MASKED = 's•••@email.com';
const CLEAR = 'secret@email.com';

const revealResponse = { data: { identityId: 'id-42', field: 'personalEmail', value: CLEAR } };

function renderEmail(props: Partial<React.ComponentProps<typeof PiiField>> = {}) {
  return render(
    <PiiField
      value={MASKED}
      label="Email"
      sensitive
      identityId="id-42"
      field="personalEmail"
      {...props}
    />,
  );
}

describe('PiiField', () => {
  beforeEach(() => {
    vi.mocked(usePermission).mockReturnValue(true);
    vi.mocked(axiosInstance.post).mockReset();
    vi.mocked(axiosInstance.post).mockResolvedValue(revealResponse);
  });

  it('non-sensitive field: renders value directly', () => {
    render(<PiiField value="Engineering" label="Department" sensitive={false} />);
    expect(screen.getByText('Engineering')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('sensitive field: renders only the masked value, the clear value is nowhere in the DOM', () => {
    const { container } = renderEmail();
    expect(screen.getByLabelText('Sensitive field hidden')).toHaveTextContent(MASKED);
    expect(container.innerHTML).not.toContain(CLEAR);
    expect(axiosInstance.post).not.toHaveBeenCalled();
  });

  it('reveal calls the audited reveal endpoint and shows the value it returns', async () => {
    const { container } = renderEmail();
    fireEvent.click(screen.getByRole('button', { name: /reveal email/i }));

    expect(await screen.findByText(CLEAR)).toBeInTheDocument();
    expect(axiosInstance.post).toHaveBeenCalledTimes(1);
    expect(axiosInstance.post).toHaveBeenCalledWith('/api/v1/identity/id-42/pii/reveal', {
      field: 'personalEmail',
    });
    expect(screen.getByRole('button', { name: /hide email/i })).toBeInTheDocument();
    expect(container.innerHTML).not.toContain(MASKED);
  });

  it('keeps the value masked while the reveal is still pending', () => {
    vi.mocked(axiosInstance.post).mockReturnValue(new Promise(() => {}));
    const { container } = renderEmail();
    fireEvent.click(screen.getByRole('button', { name: /reveal email/i }));
    expect(screen.getByLabelText('Sensitive field hidden')).toHaveTextContent(MASKED);
    expect(screen.queryByRole('button', { name: /hide email/i })).not.toBeInTheDocument();
    expect(container.innerHTML).not.toContain(CLEAR);
  });

  it('fails closed: a failed reveal keeps the value masked and offers a retry', async () => {
    vi.mocked(axiosInstance.post).mockRejectedValueOnce(new Error('network down'));
    const { container } = renderEmail();
    fireEvent.click(screen.getByRole('button', { name: /reveal email/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not be logged/i);
    expect(screen.getByLabelText('Sensitive field hidden')).toHaveTextContent(MASKED);
    expect(screen.queryByRole('button', { name: /hide email/i })).not.toBeInTheDocument();
    expect(container.innerHTML).not.toContain(CLEAR);

    // Retry: the reveal now succeeds, so the value is shown.
    fireEvent.click(screen.getByRole('button', { name: /retry revealing email/i }));
    expect(await screen.findByText(CLEAR)).toBeInTheDocument();
    expect(axiosInstance.post).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('click hide button: drops the clear value from the DOM', async () => {
    const { container } = renderEmail();
    fireEvent.click(screen.getByRole('button', { name: /reveal email/i }));
    fireEvent.click(await screen.findByRole('button', { name: /hide email/i }));
    expect(screen.getByLabelText('Sensitive field hidden')).toHaveTextContent(MASKED);
    expect(container.innerHTML).not.toContain(CLEAR);
  });

  it('offers no reveal when it does not know which identity field to reveal', () => {
    render(<PiiField value={MASKED} label="Email" sensitive />);
    expect(screen.getByLabelText('Sensitive field hidden')).toHaveTextContent(MASKED);
    expect(screen.queryByRole('button', { name: /reveal/i })).not.toBeInTheDocument();
  });

  it('without operator permission: shows dots without reveal option', () => {
    vi.mocked(usePermission).mockReturnValue(false);
    renderEmail();
    expect(screen.getByText('••••••••')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /reveal/i })).not.toBeInTheDocument();
  });
});
