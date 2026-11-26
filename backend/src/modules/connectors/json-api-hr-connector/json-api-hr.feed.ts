/**
 * How ingest reads the JSON API HR feed (JsonApiHrService.fetchUsers) and what the health check
 * (checkSource) says when the request fails. Pure, no I/O.
 */
import { BadRequestException } from '@nestjs/common';
import { CONNECTOR_TIMEOUT_HR_MS, JSON_HR_MAX_ITEMS } from '@infrastructure/config/defaults';
import { JsonApiHrFetchError } from './json-api-hr.client';

/** Names a responsePath must not walk through (they reach Object.prototype). */
const FORBIDDEN_PATH_KEYS = ['__proto__', 'constructor', 'prototype'];

export function assertSafeResponsePath(responsePath: string | undefined): void {
  if (responsePath && responsePath.split('.').some((k) => FORBIDDEN_PATH_KEYS.includes(k))) {
    throw new BadRequestException(
      `JsonApiHrConnector: responsePath contains forbidden key (F3). Use alphanumeric paths only.`,
    );
  }
}

/** The feed's records: the array at responsePath, or the body itself; at most JSON_HR_MAX_ITEMS. */
export function feedItems(data: unknown, responsePath: string | undefined): unknown[] {
  let items: unknown[];
  if (responsePath) {
    const extracted = responsePath
      .split('.')
      .reduce((o: unknown, k: string) => (o as Record<string, unknown>)?.[k], data);
    if (!Array.isArray(extracted)) {
      throw new BadRequestException(
        `JsonApiHrConnector: responsePath "${responsePath}" did not resolve to an array. Got: ${typeof extracted}`,
      );
    }
    items = extracted;
  } else if (Array.isArray(data)) {
    items = data;
  } else {
    throw new BadRequestException(
      `JsonApiHrConnector: Response is not an array. Use responsePath (e.g. "data", "users") to specify the array location.`,
    );
  }
  if (items.length > JSON_HR_MAX_ITEMS) {
    throw new BadRequestException(
      `JsonApiHrConnector: Item count ${items.length} exceeds limit ${JSON_HR_MAX_ITEMS} (JSON_HR_MAX_ITEMS). Possible OOM DoS (F2).`,
    );
  }
  return items;
}

export const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/**
 * Why the feed request failed, for the health check: the status or the network error code of an
 * HTTP failure (the ingest message can quote the body), the guard's reason for a refused URL,
 * the reason of a local file (dev/demo) or a header the client refused (these name no secret).
 */
export function feedFailure(error: unknown): string {
  if (error instanceof JsonApiHrFetchError) {
    const { status, code, notJson } = error.detail;
    if (status !== undefined) return `The endpoint answered HTTP ${status}`;
    if (notJson) return 'The file is not JSON';
    if (code === 'ECONNABORTED' || code === 'ETIMEDOUT') {
      return `The endpoint did not answer within ${CONNECTOR_TIMEOUT_HR_MS} ms`;
    }
    if (code === 'ERR_SSRF_BLOCKED') {
      return 'The URL is refused: its host resolves to a private, loopback, link-local, cloud metadata or reserved address';
    }
    return `The endpoint could not be reached (${code ?? 'no answer'})`;
  }
  if (error instanceof BadRequestException) return error.message;
  // validateUrlForFetch: https only, no blocked host or address (names the host, never the URL)
  return `The URL is refused: ${messageOf(error)}`;
}
