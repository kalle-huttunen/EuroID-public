/**
 * The request bodies of the webhook form (WebhookFormModal): the headers of a create, and the
 * PATCH body of an edit, which carries only what changed.
 */
import type { IWebhookSubscription, IWebhookUpdate } from '../../interfaces';

export interface HeaderRow {
  name?: string;
  value?: string;
}

/** The values of the create and edit form. */
export interface WebhookFormValues {
  name: string;
  url: string;
  eventTypes: string[];
  secret?: string;
  headers?: HeaderRow[];
}

const namedRows = (rows: HeaderRow[] = []) =>
  rows
    .filter((row) => row.name?.trim())
    .map((row): [string, string | undefined] => [(row.name as string).trim(), row.value]);

export const toHeaderMap = (rows?: HeaderRow[]): Record<string, string> =>
  Object.fromEntries(namedRows(rows).map(([name, value]) => [name, value ?? '']));

/**
 * The headers of an edit, every one the subscription keeps: a header left without a value keeps
 * its stored one (null). Only a stored header may stay empty (the value field requires the rest).
 */
const editedHeaders = (rows?: HeaderRow[]): Record<string, string | null> =>
  Object.fromEntries(namedRows(rows).map(([name, value]) => [name, value ? value : null]));

const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && a.every((value) => b.includes(value));

/** The PATCH body of an edit: only the fields that changed. */
export function changesOf(sub: IWebhookSubscription, values: WebhookFormValues): IWebhookUpdate {
  const body: IWebhookUpdate = {};
  const name = values.name.trim();
  if (name !== sub.name) body.name = name;
  if (!sameSet(values.eventTypes, sub.filters.eventTypes)) {
    // PATCH replaces the whole filters object: keep a stored severityMin.
    body.filters = {
      eventTypes: values.eventTypes,
      ...(sub.filters.severityMin ? { severityMin: sub.filters.severityMin } : {}),
    };
  }
  const webhook: NonNullable<IWebhookUpdate['webhook']> = {};
  const url = values.url.trim();
  if (url !== sub.webhook.url) webhook.url = url;
  const headers = editedHeaders(values.headers);
  const stored = sub.webhook.headerNames;
  const headersKept =
    Object.keys(headers).length === stored.length &&
    stored.every((header) => headers[header] === null);
  if (!headersKept) webhook.headers = headers;
  if (values.secret) webhook.signingSecret = values.secret;
  if (Object.keys(webhook).length) body.webhook = webhook;
  return body;
}
