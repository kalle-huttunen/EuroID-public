/**
 * Shared fixtures of the dead-letter tests (DeadLetterPage.test.tsx and
 * DeadLetterDetailModal.test.tsx). They follow GET /dead-letter, GET /dead-letter/stats and
 * GET /dead-letter/:id. Each test file mocks `@api/data` with the request mocks below and
 * `usePermission` itself (vi.mock is hoisted per file).
 */
import { screen } from '@testing-library/react';
import { vi } from 'vitest';
import type { IDeadLetterEntry } from '../../../interfaces';

export const mockGet = vi.fn();
export const mockPost = vi.fn();

/** A failed event handler: carries the domain event, so retry and replay can re-emit it. */
export const eventEntry: IDeadLetterEntry = {
  _id: '64b7f0c2a1b2c3d4e5f60720',
  type: 'event_handler_failure',
  source: 'identity.created',
  originalPayload: {
    type: 'identity.created',
    aggregateId: 'id-1',
    payload: { email: 'm•••@corp.example', mobilePhone: '+358 •• ••• 4567' },
    metadata: { tenantId: 'tenant-a', depth: 0 },
  },
  error: { message: 'Handler failed for m•••@corp.example' },
  retryCount: 0,
  maxRetries: 3,
  status: 'pending',
  createdAt: '2026-11-22T10:00:00.000Z',
};

export const HANDLER = 'UserTimelineHandler.handleIdentityCreated';

/** A handler failure captured per handler: retry and replay run only that handler. */
export const handlerEntry: IDeadLetterEntry = {
  ...eventEntry,
  _id: '64b7f0c2a1b2c3d4e5f60722',
  handler: HANDLER,
};

/** A failed workflow step: nothing EuroID can re-emit. */
export const workflowEntry: IDeadLetterEntry = {
  _id: '64b7f0c2a1b2c3d4e5f60721',
  type: 'workflow_terminal',
  source: 'distributed-transaction',
  originalPayload: { transactionId: 'tx-1', system: 'entra-id', email: 'm•••@corp.example' },
  error: { message: 'Restore failed in entra-id' },
  retryCount: 0,
  maxRetries: 3,
  status: 'pending',
  createdAt: '2026-11-22T09:00:00.000Z',
};

export const LIST = /\/dead-letter$/;

/** Serves the list, the stats and each entry; `after` replaces an entry once an action ran. */
export function serve(entries: IDeadLetterEntry[], after: Record<string, IDeadLetterEntry> = {}) {
  let acted = false;
  mockPost.mockImplementation(() => {
    acted = true;
    return Promise.resolve({ data: { success: true } });
  });
  mockGet.mockImplementation((url: string) => {
    if (LIST.test(url)) return Promise.resolve({ data: entries });
    if (url.endsWith('/dead-letter/stats')) {
      return Promise.resolve({ data: { pending: entries.length, failed_permanently: 2 } });
    }
    const id = url.split('/').pop() as string;
    const entry = (acted && after[id]) || entries.find((e) => e._id === id);
    return entry ? Promise.resolve({ data: entry }) : Promise.reject(new Error('not found'));
  });
}

/**
 * The confirmation modal, found by its title. Under test rc-util's useId gives the detail modal
 * and the confirmation the same id ("test-id"), so a dialog's accessible name resolves to the
 * detail modal's title.
 */
export async function confirmDialog(title: string): Promise<HTMLElement> {
  const heading = await screen.findByText(title);
  return heading.closest('[role="dialog"]') as HTMLElement;
}
