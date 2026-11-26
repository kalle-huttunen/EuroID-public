/**
 * GitHubLoginInput — the identity's optional GitHub login (custom attribute `githubLogin`, also
 * mappable from HR) on the Profile form. With it, onboarding invites that GitHub account and
 * offboarding removes it from the organization; without it, GitHub is invited by email and an
 * accepted invitation has to be removed by hand.
 *
 * Bound to the form field `customAttributes`, whose value stays undefined until the login is
 * edited, so a save that does not touch it sends no custom attributes. Once edited, the value is
 * the identity's whole customAttributes with the login set (or removed when cleared): PATCH
 * /identity/:id replaces customAttributes, so the others (hrStatus, ...) are sent unchanged.
 * Validate with `validateGitHubLogin` (./github-login.ts).
 */
import React from 'react';
import { Input } from 'antd';
import { GITHUB_LOGIN_ATTRIBUTE, withGitHubLogin, type CustomAttributes } from './github-login';

interface GitHubLoginInputProps {
  /** The identity's custom attributes as loaded. */
  current?: CustomAttributes;
  /** Form-controlled: undefined until edited. */
  value?: CustomAttributes;
  onChange?: (value: CustomAttributes) => void;
  id?: string;
}

export const GitHubLoginInput: React.FC<GitHubLoginInputProps> = ({
  current,
  value,
  onChange,
  id,
}) => {
  const shown = (value ?? current)?.[GITHUB_LOGIN_ATTRIBUTE];
  return (
    <Input
      id={id}
      value={shown === undefined ? '' : String(shown)}
      onChange={(e) => onChange?.(withGitHubLogin(current, e.target.value))}
      placeholder="e.g. octocat"
      autoComplete="off"
      allowClear
    />
  );
};
