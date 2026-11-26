import { Logger } from '@nestjs/common';
import type { MailConfig } from '@infrastructure/config/mail.config';
import { MailTransportService, type OutgoingMail } from './mail-transport.service';
import { PasswordResetMailService } from './password-reset-mail.service';
import { renderPasswordReset } from './password-reset-email';

const CONF: MailConfig = {
  enabled: true,
  host: 'smtp.example.com',
  port: 587,
  secure: false,
  requireTls: true,
  from: 'EuroID <no-reply@example.com>',
  timeoutMs: 1000,
  frontendUrl: 'https://euroid.example.com',
};
const TOKEN = '0123456789abcdef'.repeat(4);

function serviceWith(sendMail: (m: OutgoingMail & { from: string }) => Promise<unknown>) {
  return new PasswordResetMailService(new MailTransportService(CONF, { sendMail }));
}

describe('PasswordResetMailService', () => {
  it('sends the link to the reset page with the token in the fragment, at once', async () => {
    const sent: OutgoingMail[] = [];
    const service = serviceWith(async (m) => sent.push(m));

    await expect(service.send('alice@example.com', TOKEN, 30)).resolves.toBe('sent');

    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('alice@example.com');
    expect(sent[0].text).toContain(`https://euroid.example.com/reset-password#token=${TOKEN}`);
    expect(sent[0].text).toContain('for 30 minutes');
  });

  // The mail carries a live token: it is not stored for a retry, and a failure is logged without
  // the address or the token, even when the SMTP answer quotes them.
  it('reports a failed send without the address or the token in the log', async () => {
    const service = serviceWith(async () => {
      throw new Error(`550 rejected alice@example.com body ${TOKEN}`);
    });
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    await expect(service.send('alice@example.com', TOKEN, 30)).resolves.toBe('failed');

    const line = warn.mock.calls.map(([m]) => String(m)).join('\n');
    warn.mockRestore();
    expect(line).toMatch(/^Password reset email not sent:/);
    expect(line).not.toContain(TOKEN);
    expect(line).not.toContain('alice@example.com');
  });

  it('sends nothing while email is off', async () => {
    const service = new PasswordResetMailService(
      new MailTransportService({ ...CONF, enabled: false }),
    );

    expect(service.isEnabled()).toBe(false);
    await expect(service.send('alice@example.com', TOKEN, 30)).resolves.toBe('disabled');
  });
});

describe('renderPasswordReset', () => {
  const link = `https://euroid.example.com/reset-password#token=${TOKEN}`;
  const mail = renderPasswordReset({ link, validMinutes: 45 });

  it('links to the reset page and says how long and how often the link works', () => {
    expect(mail.subject).toBe('Reset your EuroID password');
    expect(mail.text).toContain(`Set a new password: ${link}`);
    expect(mail.html).toContain(`href="${link}"`);
    expect(mail.text).toContain('The link works once, for 45 minutes.');
  });

  it('tells a recipient who did not ask that nothing changes, and names nobody', () => {
    expect(mail.text).toContain(
      'If it was not you, ignore this email: your password stays as it is.',
    );
    expect(mail.html).toContain('If it was not you, ignore this email');
    expect(mail.text).not.toMatch(/Sign in to see the details/);
  });
});
