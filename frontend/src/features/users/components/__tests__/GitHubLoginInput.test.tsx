/**
 * The GitHub login on the Profile form: shows the identity's login; a save that does not edit it
 * sends no custom attributes; an edit sends the identity's whole customAttributes with the login
 * changed (PATCH replaces customAttributes, so hrStatus must survive); clearing removes only the
 * login; something that is not a GitHub login is refused before it is sent.
 */
import React, { useEffect } from 'react';
import { describe, it, expect } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { Form, type FormInstance } from 'antd';
import { GitHubLoginInput } from '../GitHubLoginInput';
import { validateGitHubLogin, withGitHubLogin } from '../github-login';

const CURRENT = { hrStatus: 'Active', githubLogin: 'ada-l' };

/** `current`: the identity's customAttributes as loaded (undefined: it has none). */
function renderField(current: Record<string, string> | undefined) {
  const holder: { form?: FormInstance } = {};
  const Host: React.FC = () => {
    const [f] = Form.useForm();
    useEffect(() => {
      holder.form = f;
    }, [f]);
    return (
      <Form form={f}>
        <Form.Item
          label="GitHub login"
          name="customAttributes"
          rules={[{ validator: validateGitHubLogin }]}
        >
          <GitHubLoginInput current={current} />
        </Form.Item>
      </Form>
    );
  };
  render(<Host />);
  return {
    form: () => holder.form!,
    input: () => screen.getByLabelText('GitHub login') as HTMLInputElement,
  };
}

describe('GitHubLoginInput', () => {
  it('shows the current login and sends nothing until it is edited', () => {
    const { form, input } = renderField(CURRENT);

    expect(input().value).toBe('ada-l');
    expect(form().getFieldsValue().customAttributes).toBeUndefined();
  });

  it('sends the whole customAttributes with the new login, keeping the others', async () => {
    const { form, input } = renderField(CURRENT);

    fireEvent.change(input(), { target: { value: ' octocat ' } });

    expect(input().value).toBe('octocat');
    await expect(form().validateFields()).resolves.toEqual({
      customAttributes: { hrStatus: 'Active', githubLogin: 'octocat' },
    });
  });

  it('clearing the login removes only that attribute', async () => {
    const { form, input } = renderField(CURRENT);

    fireEvent.change(input(), { target: { value: '' } });

    expect(input().value).toBe('');
    await expect(form().validateFields()).resolves.toEqual({
      customAttributes: { hrStatus: 'Active' },
    });
  });

  it('adds a login to an identity without custom attributes', () => {
    const { form, input } = renderField(undefined);

    expect(input().value).toBe('');
    fireEvent.change(input(), { target: { value: 'ada-l' } });

    expect(form().getFieldsValue().customAttributes).toEqual({ githubLogin: 'ada-l' });
  });

  it('refuses something that is not a GitHub login before it is sent', async () => {
    const { form, input } = renderField(CURRENT);

    fireEvent.change(input(), { target: { value: 'ada/../members' } });

    await act(async () => {
      await expect(form().validateFields()).rejects.toMatchObject({
        errorFields: [expect.objectContaining({ name: ['customAttributes'] })],
      });
    });
    expect(
      await screen.findByText(/letters, digits and hyphens, at most 39 characters/),
    ).toBeInTheDocument();
  });

  it('validates only an edited login, with GitHub’s characters and length', async () => {
    await expect(validateGitHubLogin(null, undefined)).resolves.toBeUndefined();
    await expect(validateGitHubLogin(null, { hrStatus: 'x' })).resolves.toBeUndefined();
    await expect(validateGitHubLogin(null, { githubLogin: 'Ada-L-1' })).resolves.toBeUndefined();
    await expect(validateGitHubLogin(null, { githubLogin: 'a'.repeat(40) })).rejects.toThrow();
    await expect(validateGitHubLogin(null, { githubLogin: 'ada.l' })).rejects.toThrow();
    expect(withGitHubLogin({ githubLogin: 'x', n: 1 }, '  ')).toEqual({ n: 1 });
  });
});
