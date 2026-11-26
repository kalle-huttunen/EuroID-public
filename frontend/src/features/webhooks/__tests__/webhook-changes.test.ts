/**
 * The PATCH body of a webhook edit (changesOf): only what changed, because the timeline and the
 * audit log name every field the body carries, and PATCH replaces a whole `filters` object.
 */
import { describe, it, expect } from 'vitest';
import { changesOf, type WebhookFormValues } from '../webhook-changes';
import { sub } from './WebhooksPage.fixtures';

/** The edit form as it opens for `sub`: its values, header values empty, no new secret. */
const unchanged: WebhookFormValues = {
  name: sub.name,
  url: sub.webhook.url,
  eventTypes: [...sub.filters.eventTypes],
  headers: sub.webhook.headerNames.map((name) => ({ name })),
};

describe('changesOf', () => {
  it.each<[string, Partial<WebhookFormValues>, object]>([
    ['an unchanged form', {}, {}],
    [
      'the same event types in another order',
      { eventTypes: [...sub.filters.eventTypes].reverse() },
      {},
    ],
    ['a rename, trimmed', { name: '  SIEM feed v2 ' }, { name: 'SIEM feed v2' }],
    [
      'a new URL, trimmed',
      { url: ' https://siem.example.com/v2 ' },
      { webhook: { url: 'https://siem.example.com/v2' } },
    ],
    [
      'other event types',
      { eventTypes: ['identity.created'] },
      { filters: { eventTypes: ['identity.created'] } },
    ],
    [
      'a new secret',
      { secret: 'n3w-s3cret-0123456789' },
      { webhook: { signingSecret: 'n3w-s3cret-0123456789' } },
    ],
    ['a dropped header', { headers: [] }, { webhook: { headers: {} } }],
  ])('sends only the change for %s', (_case, change, body) => {
    expect(changesOf(sub, { ...unchanged, ...change })).toEqual(body);
  });

  it('keeps a stored severityMin when the event types change, since PATCH replaces the filters', () => {
    const filtered = { ...sub, filters: { ...sub.filters, severityMin: 'high' } };

    expect(changesOf(filtered, { ...unchanged, eventTypes: ['anomaly.detected'] })).toEqual({
      filters: { eventTypes: ['anomaly.detected'], severityMin: 'high' },
    });
    // Renaming alone leaves the filters, and so the stored severityMin, out of the body.
    expect(changesOf(filtered, { ...unchanged, name: 'SIEM' })).toEqual({ name: 'SIEM' });
  });
});
