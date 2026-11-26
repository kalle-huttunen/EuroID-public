import type { StandardUserDto } from '@shared/dtos/standard-user.dto';
import { GITHUB_LOGIN_ATTRIBUTE } from '../github-connector/github.mapper';

/**
 * Custom attributes an HR connector maps through unchanged (field mapping only): a column or
 * JSON key mapped to `customAttributes.<key>` (columnMap / fieldMap value) fills that custom
 * attribute, e.g. `{ "GitHub Login": "customAttributes.githubLogin" }`. Empty values were
 * already left out by the connector's mapping.
 */
export const CUSTOM_ATTRIBUTE_PREFIX = 'customAttributes.';

/** A mapping target that fills a custom attribute. */
export type CustomAttributeTarget = `${typeof CUSTOM_ATTRIBUTE_PREFIX}${string}`;

/** Mapping target of the GitHub login (the GitHub connector's `githubLogin` attribute). */
export const GITHUB_LOGIN_TARGET =
  `${CUSTOM_ATTRIBUTE_PREFIX}${GITHUB_LOGIN_ATTRIBUTE}` as const satisfies CustomAttributeTarget;

/** Copy every `customAttributes.<key>` value of a mapped row onto the user's customAttributes. */
export function applyMappedCustomAttributes(
  user: Partial<StandardUserDto>,
  mapped: Record<string, string>,
): void {
  for (const [field, value] of Object.entries(mapped)) {
    if (!field.startsWith(CUSTOM_ATTRIBUTE_PREFIX)) continue;
    const key = field.slice(CUSTOM_ATTRIBUTE_PREFIX.length);
    if (!key) continue;
    user.customAttributes = { ...(user.customAttributes ?? {}), [key]: value };
  }
}
