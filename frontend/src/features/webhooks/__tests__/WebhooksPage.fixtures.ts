/**
 * Shared fixtures of the WebhooksPage tests, split by subject into WebhooksPage*.test.tsx. Each test
 * file mocks `@api/data` with the request mocks below and `usePermission` itself (vi.mock is
 * hoisted per file).
 */
import { expect, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import type userEvent from '@testing-library/user-event';
import dayjs from 'dayjs';
import type { IWebhookDelivery, IWebhookSubscription } from '../../../interfaces';

export const mockGet = vi.fn();
export const mockPost = vi.fn();
export const mockPatch = vi.fn();
export const mockDelete = vi.fn();

export const SUB_ID = '64b7f0c2a1b2c3d4e5f60730';

/**
 * As GET /event-subscriptions answers it: the custom headers' names only, and whether a signing
 * secret is stored. Neither the secret nor a header value is ever answered.
 */
export const sub: IWebhookSubscription = {
  _id: SUB_ID,
  tenantId: 'tenant-a',
  name: 'SIEM feed',
  type: 'WEBHOOK',
  status: 'ACTIVE',
  filters: {
    eventTypes: ['identity.created', 'identity.*', 'drift.detected', 'anomaly.detected'],
  },
  webhook: {
    url: 'https://siem.example.com/hooks/euroid',
    headerNames: ['X-Team'],
    hasSigningSecret: true,
  },
  createdBy: 'admin@corp.example',
  createdAt: '2026-11-20T09:00:00.000Z',
  updatedAt: '2026-11-20T09:00:00.000Z',
};

export const paused: IWebhookSubscription = {
  ...sub,
  _id: '64b7f0c2a1b2c3d4e5f60731',
  name: 'Ticketing',
  status: 'PAUSED',
  filters: { eventTypes: ['provisioning.failed'] },
  webhook: { url: 'https://tickets.example.com/in', headerNames: [], hasSigningSecret: true },
};

/** As GET /event-subscriptions/:id/deliveries answers them. */
export const delivery = (overrides: Partial<IWebhookDelivery>): IWebhookDelivery => ({
  _id: '64b7f0c2a1b2c3d4e5f60801',
  tenantId: 'tenant-a',
  subscriptionId: SUB_ID,
  eventType: 'identity.created',
  eventId: '0b6f5a52-5d3a-4c8e-9b1e-6f2d7c1a9e01',
  body: {
    eventId: '0b6f5a52-5d3a-4c8e-9b1e-6f2d7c1a9e01',
    eventType: 'identity.created',
    timestamp: '2026-11-22T10:00:00.000Z',
    aggregateId: '64b7f0c2a1b2c3d4e5f60999',
    payload: { identityId: '64b7f0c2a1b2c3d4e5f60999' },
  },
  status: 'DELIVERED',
  httpStatus: 200,
  attempts: 1,
  createdAt: '2026-11-22T10:00:00.000Z',
  updatedAt: '2026-11-22T10:00:01.000Z',
  ...overrides,
});

export const delivered = delivery({});
/** Failed, a retry ahead: not in the dead-letter queue yet. */
export const retrying = delivery({
  _id: '64b7f0c2a1b2c3d4e5f60802',
  eventType: 'drift.detected',
  status: 'FAILED',
  httpStatus: 503,
  attempts: 2,
  nextRetryAt: dayjs().add(1, 'hour').toISOString(),
  lastError: 'Request failed with status code 503',
});
/** Ran out of attempts: the retry time is the last one scheduled, in the past. */
export const exhausted = delivery({
  _id: '64b7f0c2a1b2c3d4e5f60803',
  status: 'FAILED',
  httpStatus: 500,
  attempts: 5,
  nextRetryAt: '2026-11-22T08:02:05.000Z',
  lastError: 'Request failed with status code 500',
});
/** A retry fell due while the subscription was paused. */
export const waiting = delivery({
  _id: '64b7f0c2a1b2c3d4e5f60804',
  eventType: 'anomaly.detected',
  status: 'FAILED',
  httpStatus: undefined,
  attempts: 1,
  nextRetryAt: '2026-11-22T09:00:01.000Z',
  lastError: 'Subscription no longer active',
});

export const LIST = /\/event-subscriptions$/;
export const DELIVERIES = /\/event-subscriptions\/[^/]+\/deliveries$/;

export function serve(subs: IWebhookSubscription[] = [sub], deliveries: IWebhookDelivery[] = []) {
  mockGet.mockImplementation((url: string) => {
    if (LIST.test(url)) return Promise.resolve({ data: subs });
    if (DELIVERIES.test(url)) return Promise.resolve({ data: deliveries });
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
  mockPost.mockResolvedValue({ data: sub });
  mockPatch.mockResolvedValue({ data: sub });
  mockDelete.mockResolvedValue({ data: { success: true, id: SUB_ID } });
}

export const listLoads = () =>
  mockGet.mock.calls.filter(([url]) => LIST.test(url as string)).length;

/** Waits for the list to be requested again after an action. */
export async function expectListReloaded(before: number) {
  await waitFor(() => expect(listLoads()).toBeGreaterThan(before));
}

/** A confirmation (App.useApp modal.confirm), found by its visible title. */
export async function confirmDialog(title: string): Promise<HTMLElement> {
  const heading = await screen.findByText(title, { selector: '.ant-modal-confirm-title' });
  return heading.closest('.ant-modal') as HTMLElement;
}

/** The form modal, found by its title. */
export async function formModal(title: string): Promise<HTMLElement> {
  const heading = await screen.findByText(title, { selector: '.ant-modal-title' });
  return heading.closest('.ant-modal') as HTMLElement;
}

type User = ReturnType<typeof userEvent.setup>;

/** Pastes into a field: typing re-renders the form on every key and makes the tests slow. */
export async function fill(user: User, label: string | RegExp, text: string) {
  const field = screen.getByLabelText(label);
  await user.click(field);
  await user.paste(text);
}

export async function pickEventType(user: User, type: string) {
  const select = screen.getByLabelText('Event types');
  await user.click(select);
  await user.paste(type);
  const option = await waitFor(() => {
    const el = document.querySelector(`.ant-select-item-option[title="${type}"]`);
    if (!el) throw new Error(`option ${type} not rendered`);
    return el as HTMLElement;
  });
  await user.click(option);
}
