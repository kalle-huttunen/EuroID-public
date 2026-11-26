/**
 * The identity's optional GitHub login: custom attribute `githubLogin` (backend:
 * `modules/connectors/github-connector/github.mapper.ts`, which checks the same format).
 */
import type { IStandardUser } from '../../../interfaces';

export const GITHUB_LOGIN_ATTRIBUTE = 'githubLogin';

/** Letters, digits and hyphens, at most 39 characters. */
const GITHUB_LOGIN = /^[A-Za-z0-9-]{1,39}$/;

export type CustomAttributes = NonNullable<IStandardUser['customAttributes']>;

/** `current` with the GitHub login set to `login` (trimmed), or without it when empty. */
export function withGitHubLogin(
  current: CustomAttributes | undefined,
  login: string,
): CustomAttributes {
  const next: CustomAttributes = { ...(current ?? {}) };
  const trimmed = login.trim();
  if (trimmed) next[GITHUB_LOGIN_ATTRIBUTE] = trimmed;
  else delete next[GITHUB_LOGIN_ATTRIBUTE];
  return next;
}

/** Form rule: an edited login must look like a GitHub login (an unedited one is not checked). */
export async function validateGitHubLogin(
  _rule: unknown,
  value: CustomAttributes | undefined,
): Promise<void> {
  const login = value?.[GITHUB_LOGIN_ATTRIBUTE];
  if (login === undefined || GITHUB_LOGIN.test(String(login))) return;
  throw new Error('A GitHub login has letters, digits and hyphens, at most 39 characters');
}
