import { createTransport } from 'nodemailer';
import type { MailConfig } from '@infrastructure/config/mail.config';
import {
  createSmtpSender,
  MailTransportService,
  type OutgoingMail,
} from './mail-transport.service';

const ON: MailConfig = {
  enabled: true,
  host: 'smtp.example.com',
  port: 587,
  secure: false,
  requireTls: true,
  from: 'EuroID <no-reply@example.com>',
  timeoutMs: 1000,
  frontendUrl: 'https://euroid.example.com',
};
const OFF: MailConfig = { ...ON, enabled: false, host: '', from: '', frontendUrl: '' };

describe('MailTransportService', () => {
  it('builds no transport when email is off, and refuses to send', async () => {
    expect(createSmtpSender(OFF)).toBeNull();
    const service = new MailTransportService(OFF);
    expect(service.isEnabled()).toBe(false);
    await expect(
      service.send({ to: 'a@example.com', subject: 's', text: 't', html: '<p>h</p>' }),
    ).rejects.toThrow(/SMTP_HOST/);
  });

  it('builds an SMTP transport without connecting when email is on', () => {
    expect(createSmtpSender(ON)).not.toBeNull();
    expect(new MailTransportService(ON).isEnabled()).toBe(true);
  });

  it('sends from the configured sender, HTML plus plain text (JSON transport, no SMTP server)', async () => {
    const json = createTransport({ jsonTransport: true });
    const sent: Array<Record<string, unknown>> = [];
    const sender = {
      sendMail: async (message: OutgoingMail & { from: string }) => {
        const info = await json.sendMail(message);
        sent.push(JSON.parse(info.message) as Record<string, unknown>);
        return info;
      },
    };
    const service = new MailTransportService(ON, sender);

    await service.send({
      to: 'approver@example.com',
      subject: 'Subject',
      text: 'Plain',
      html: '<p>Html</p>',
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      from: { address: 'no-reply@example.com', name: 'EuroID' },
      to: [{ address: 'approver@example.com', name: '' }],
      subject: 'Subject',
      text: 'Plain',
      html: '<p>Html</p>',
    });
    expect(service.frontendUrl).toBe('https://euroid.example.com');
  });

  it('passes a refused send on to the caller', async () => {
    const sender = { sendMail: jest.fn().mockRejectedValue(new Error('421 try again later')) };
    const service = new MailTransportService(ON, sender);
    await expect(
      service.send({ to: 'a@example.com', subject: 's', text: 't', html: 'h' }),
    ).rejects.toThrow('421 try again later');
  });
});
