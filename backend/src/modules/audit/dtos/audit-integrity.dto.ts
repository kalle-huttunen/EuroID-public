/**
 * Zod schemas for the audit routes' inputs (Zod at the gate). A route parses its input with them;
 * the global ZodErrorFilter answers a ZodError with 400 and one `field: message` line per issue.
 */
import { z } from 'zod';

/** ISO 8601 date or date and time, as the UI sends them (`2026-11-24T10:00:00.000Z`). */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

export const isoDateTime = z
  .string()
  .max(50)
  .refine((s) => ISO_DATE.test(s) && !Number.isNaN(Date.parse(s)), {
    message: 'must be an ISO 8601 date and time, for example 2026-11-24T10:00:00.000Z',
  });

const notReversed = (start: string | undefined, end: string | undefined) =>
  !start || !end || Date.parse(start) <= Date.parse(end);

/** A time window: GET /audit/verify-integrity (query) and POST /audit/verify (body). */
export const TimeWindowSchema = z
  .object({ from: isoDateTime.optional(), to: isoDateTime.optional() })
  .refine((w) => notReversed(w.from, w.to), {
    message: 'must not be after to',
    path: ['from'],
  });

/** GET /audit/merkle-roots */
export const MerkleRootsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/** POST /audit/verify-event/:eventId: the audit event's `_id`. */
export const EventIdParamSchema = z.object({
  eventId: z
    .string()
    .regex(/^[0-9a-f]{24}$/i, 'must be an audit event id (24 hexadecimal characters)'),
});

/** GET /audit/merkle-roots/:checkpointId/anchor: the checkpoint's UUID. */
export const CheckpointIdParamSchema = z.object({
  checkpointId: z.string().uuid('must be a checkpoint id (a UUID)'),
});

/** Date range of GET /audit (dateFrom, dateTo). */
export const auditDateRangeIsValid = (q: { dateFrom?: string; dateTo?: string }) =>
  notReversed(q.dateFrom, q.dateTo);
