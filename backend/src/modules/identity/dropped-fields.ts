/** A source's fields that its latest record no longer carries (input to ReconciliationService). */
export interface DroppedFields {
  sourceName: string;
  /** Profile keys, and `customAttributes.<key>` for a dropped custom attribute. */
  fields: string[];
}

/** No value: missing, `null` or `''`. */
export function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date)
  );
}

/**
 * The keys `previous` (a source's last raw record) had a value for and `next` (its new record)
 * has not: what the source dropped. Custom attributes are compared one by one.
 */
export function droppedFields(
  previous: Record<string, unknown> | undefined,
  next: Record<string, unknown>,
): string[] {
  if (!previous) return [];
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(previous)) {
    if (key === '_id' || isEmpty(value)) continue;
    if (key === 'customAttributes' && isPlainObject(value)) {
      const nextCustom = isPlainObject(next.customAttributes) ? next.customAttributes : {};
      for (const [customKey, customValue] of Object.entries(value)) {
        if (!isEmpty(customValue) && isEmpty(nextCustom[customKey])) {
          dropped.push(`customAttributes.${customKey}`);
        }
      }
      continue;
    }
    if (isEmpty(next[key])) dropped.push(key);
  }
  return dropped;
}
