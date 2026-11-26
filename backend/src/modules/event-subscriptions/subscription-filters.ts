/**
 * A webhook subscription's filters, outside the service so the delivery and its retry poller use
 * the same rules:
 * - `filters.eventTypes`: glob patterns per dot segment (matchesEventType), also as a MongoDB
 *   condition on a delivery attempt's eventType (eventTypeCondition), which the retry poller
 *   claims with, so a delivery the subscription no longer names is not read.
 * - `filters.severityMin`: an event whose payload carries a lower severity is not delivered.
 */
import { escapeRegex } from '@shared/utils/escape-regex';

/** The severity levels filters.severityMin takes, lowest first. */
export const SEVERITY_LEVELS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;

/**
 * Glob-style matching for event type patterns.
 * 'identity.*' matches 'identity.created' but not 'identity.status.changed'
 * '*' and '**' match everything
 * Exact match: 'identity.created' matches 'identity.created'
 */
export function matchesEventType(pattern: string, eventType: string): boolean {
  if (pattern === '*' || pattern === '**') return true;
  if (pattern === eventType) return true;

  const patternParts = pattern.split('.');
  const typeParts = eventType.split('.');

  if (patternParts.length !== typeParts.length) return false;

  return patternParts.every((part, i) => part === '*' || part === typeParts[i]);
}

/** The pattern as an anchored regex body: `*` is one segment, everything else literal. */
function patternRegex(pattern: string): string {
  return pattern
    .split('.')
    .map((part) => (part === '*' ? '[^.]+' : escapeRegex(part)))
    .join('\\.');
}

/**
 * MongoDB condition selecting the event types the patterns match (as matchesEventType does):
 * `{}` when a pattern matches every type, else `{ eventType: { $regex } }`.
 */
export function eventTypeCondition(patterns: string[]): Record<string, unknown> {
  if (patterns.some((p) => p === '*' || p === '**')) return {};
  if (patterns.length === 0) return { eventType: { $in: [] } };
  return { eventType: { $regex: `^(?:${patterns.map(patternRegex).join('|')})$` } };
}

/**
 * Whether an event passes filters.severityMin: always without a minimum, and always when the
 * payload has no `severity` on the LOW..CRITICAL scale (case ignored; drift.detected carries
 * LOW..CRITICAL, anomaly.detected low..critical): an event type without a severity is never held
 * back. Otherwise the event's severity must be at least the minimum.
 */
export function meetsSeverityMin(severityMin: string | undefined, payload: unknown): boolean {
  if (!severityMin) return true;
  const severity = (payload as { severity?: unknown } | undefined)?.severity;
  if (typeof severity !== 'string') return true;
  const level = SEVERITY_LEVELS.indexOf(severity.toUpperCase() as (typeof SEVERITY_LEVELS)[number]);
  if (level < 0) return true;
  return level >= SEVERITY_LEVELS.indexOf(severityMin as (typeof SEVERITY_LEVELS)[number]);
}
