/**
 * The Identity Correlation Conflict card at phone width. At 400 px its action buttons reached
 * x=510, so the page scrolled sideways, and the Existing / Incoming records, half a card each,
 * broke their words letter by letter. The records now stack below md and the buttons wrap.
 */
import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { Form } from 'antd';
import { renderWithProviders } from '../../../../test/test-utils';
import { UserProfileTab } from '../UserProfileTab';
import type { IStandardUserWithMeta } from '../user-detail.types';

vi.mock('@api/data', () => ({
  axiosInstance: {
    get: vi.fn().mockResolvedValue({ data: {} }),
    post: vi.fn().mockResolvedValue({ data: {} }),
  },
}));

vi.mock('@api/reconciliation-api', () => ({
  fetchDrifts: vi.fn().mockResolvedValue([]),
  correctDrift: vi.fn(),
  reconciliationKeys: {
    drifts: (p?: object) => ['reconciliation', 'drifts', p],
    driftsPrefix: () => ['reconciliation', 'drifts'],
  },
}));

const ID = '64b7f0c2a1b2c3d4e5f60811';
const user = {
  _id: ID,
  email: 'riikka.tuominen@corp.example',
  firstName: 'Riikka',
  lastName: 'Tuominen',
  status: 'ACTIVE',
  metadata: {
    requiresReview: true,
    conflictDetails: {
      matchedBy: 'email',
      matchedValue: 'riikka.tuominen@corp.example',
      confidence: 0.92,
      existingSnapshot: {
        sourceName: 'Workday',
        firstName: 'Riikka',
        lastName: 'Tuominen',
        email: 'riikka.tuominen@corp.example',
        departmentName: 'Platform Engineering',
        jobTitle: 'Senior Site Reliability Engineer',
      },
      incomingSnapshot: {
        sourceName: 'CSV HR',
        firstName: 'Riikka',
        lastName: 'Tuominen',
        email: 'riikka.tuominen@corp.example',
        departmentName: 'Infrastructure',
        jobTitle: 'Site Reliability Engineer',
      },
    },
  },
} as unknown as IStandardUserWithMeta;

function ProfileTab() {
  const [form] = Form.useForm();
  return (
    <UserProfileTab
      user={user}
      form={form}
      identityId={ID}
      identityData={null}
      showSyncWarning={false}
      changedFields={[]}
      onFieldsChange={() => {}}
    />
  );
}

describe('UserProfileTab conflict card on phones', { timeout: 20_000 }, () => {
  it('stacks the existing and incoming records below md, side by side from md up', async () => {
    renderWithProviders(<ProfileTab />);

    for (const title of ['Existing Record', 'Incoming Record']) {
      const column = (await screen.findByText(title)).closest('.ant-col') as HTMLElement;
      expect(column).toHaveClass('ant-col-xs-24', 'ant-col-md-12');
      // A plain span-12 column stays half a card wide at every width.
      expect(column).not.toHaveClass('ant-col-12');
    }
  });

  it('wraps the merge, split and dismiss buttons instead of pushing them off the screen', async () => {
    renderWithProviders(<ProfileTab />);

    const merge = await screen.findByRole('button', { name: /Merge — Same Person$/ });
    const actions = merge.closest('.ant-space') as HTMLElement;
    expect(actions.style.flexWrap).toBe('wrap');
    expect(actions).toContainElement(screen.getByRole('button', { name: /Split/ }));
    expect(actions).toContainElement(screen.getByRole('button', { name: /^Dismiss$/ }));
  });
});
