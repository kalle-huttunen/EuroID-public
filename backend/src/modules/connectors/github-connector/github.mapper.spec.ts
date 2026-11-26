/**
 * The identity's GitHub login (custom attribute) and the GitHub account id onboarding writes
 * back: what counts as a login, what is refused before it reaches a GitHub URL, and which
 * written-back ids name a GitHub user.
 */
import { HttpStatus } from '@nestjs/common';
import { ConnectorException } from '@shared/exceptions/domain-exceptions';
import { githubLoginOf, githubUserIdOf, githubUserObjectId } from './github.mapper';

describe('githubLoginOf', () => {
  it('reads the trimmed login; no attribute, null or blank is no login', () => {
    expect(githubLoginOf({ githubLogin: '  Ada-L ' })).toBe('Ada-L');
    expect(githubLoginOf({ githubLogin: 12345 })).toBe('12345');
    expect(githubLoginOf({ hrStatus: 'Active' })).toBeUndefined();
    expect(githubLoginOf({ githubLogin: null })).toBeUndefined();
    expect(githubLoginOf({ githubLogin: '   ' })).toBeUndefined();
    expect(githubLoginOf(undefined)).toBeUndefined();
  });

  it('accepts older logins with hyphens anywhere, up to 39 characters', () => {
    expect(githubLoginOf({ githubLogin: 'legacy--name-' })).toBe('legacy--name-');
    expect(githubLoginOf({ githubLogin: 'a'.repeat(39) })).toBe('a'.repeat(39));
  });

  it.each([
    ['a path', 'ada/../../orgs'],
    ['a dot', 'ada.l'],
    ['a space', 'ada l'],
    ['an email', 'ada@acme.test'],
    ['40 characters', 'a'.repeat(40)],
    ['a boolean', true],
  ])('refuses %s (422), naming the attribute and not the value', (_what, value) => {
    let error: unknown;
    try {
      githubLoginOf({ githubLogin: value });
    } catch (e: unknown) {
      error = e;
    }
    expect(error).toBeInstanceOf(ConnectorException);
    expect((error as ConnectorException).getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    expect((error as Error).message).toMatch(
      /^customAttributes\.githubLogin is not a GitHub login/,
    );
    if (typeof value === 'string') expect((error as Error).message).not.toContain(value);
  });
});

describe('GitHub account ids', () => {
  it('round-trips the GitHub user id onboarding writes back', () => {
    expect(githubUserObjectId(583231)).toBe('github-user-583231');
    expect(githubUserIdOf('github-user-583231')).toBe(583231);
  });

  it('finds no user id in an invitation id, another target id or nothing', () => {
    expect(githubUserIdOf('github-invitation-4242')).toBeUndefined();
    expect(githubUserIdOf('github-user-')).toBeUndefined();
    expect(githubUserIdOf('github-user-12a')).toBeUndefined();
    expect(githubUserIdOf('00u1')).toBeUndefined();
    expect(githubUserIdOf(undefined)).toBeUndefined();
  });
});
