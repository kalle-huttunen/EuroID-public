import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { createTransport } from 'nodemailer';
import { type MailConfig, mailConfig } from '@infrastructure/config/mail.config';

/** One rendered mail to one recipient. */
export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/** The part of a nodemailer transporter this module uses. Tests inject a JSON or stream transport. */
export interface MailSender {
  sendMail(message: OutgoingMail & { from: string }): Promise<unknown>;
}

/** Optional provider token: a MailSender that replaces the SMTP transport (tests only). */
export const MAIL_SENDER = Symbol('MAIL_SENDER');

/** SMTP transport for an enabled config, null when email is off. Connects lazily, on first send. */
export function createSmtpSender(conf: MailConfig): MailSender | null {
  if (!conf.enabled) return null;
  return createTransport({
    host: conf.host,
    port: conf.port,
    secure: conf.secure,
    requireTLS: conf.requireTls,
    ...(conf.auth ? { auth: { user: conf.auth.user, pass: conf.auth.pass } } : {}),
    connectionTimeout: conf.timeoutMs,
    greetingTimeout: conf.timeoutMs,
    socketTimeout: conf.timeoutMs,
    dnsTimeout: conf.timeoutMs,
  });
}

/**
 * Sends mail through the deployment's SMTP server (mail.config.ts). With SMTP_HOST unset email is
 * off: isEnabled() is false, the callers skip their work, and startup logs that once.
 */
@Injectable()
export class MailTransportService implements OnModuleInit {
  private readonly logger = new Logger(MailTransportService.name);
  private readonly sender: MailSender | null;

  constructor(
    @Inject(mailConfig.KEY) private readonly conf: MailConfig,
    @Optional() @Inject(MAIL_SENDER) sender?: MailSender,
  ) {
    this.sender = sender ?? createSmtpSender(conf);
  }

  onModuleInit(): void {
    if (this.sender) {
      this.logger.log(
        `Email notifications on: SMTP ${this.conf.host}:${this.conf.port}, links to ${this.conf.frontendUrl}`,
      );
    } else {
      this.logger.log('Email notifications off: SMTP_HOST is not set (in-app notifications only)');
    }
  }

  isEnabled(): boolean {
    return this.sender !== null;
  }

  /** Origin of the web app that email links point to. */
  get frontendUrl(): string {
    return this.conf.frontendUrl;
  }

  /** Throws when the server refuses or cannot be reached; the caller decides about retries. */
  async send(mail: OutgoingMail): Promise<void> {
    if (!this.sender) throw new Error('Email is off: SMTP_HOST is not set');
    await this.sender.sendMail({
      from: this.conf.from,
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
    });
  }
}
