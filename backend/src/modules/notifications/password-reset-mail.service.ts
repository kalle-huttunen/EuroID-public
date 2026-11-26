import { Injectable, Logger } from '@nestjs/common';
import { MailTransportService } from './mail-transport.service';
import { describeError } from './email-log';
import { renderPasswordReset } from './password-reset-email';

export type PasswordResetMailResult = 'sent' | 'failed' | 'disabled';

/**
 * The console admin password reset mail (`modules/auth/password-reset.service.ts`). It carries a
 * live reset token, so it is sent at once through the transport and never stored: unlike the
 * other notifications it is not kept in `email_notifications` for a dead-letter retry, which
 * would keep the token in clear for as long as the mail waits. A failed send is logged without
 * the address or the token, and the admin asks again or gets a code from a super-admin.
 */
@Injectable()
export class PasswordResetMailService {
  private readonly logger = new Logger(PasswordResetMailService.name);

  constructor(private readonly transport: MailTransportService) {}

  isEnabled(): boolean {
    return this.transport.isEnabled();
  }

  /** Never throws. The link opens the reset page with the token in the URL fragment. */
  async send(to: string, token: string, validMinutes: number): Promise<PasswordResetMailResult> {
    if (!this.transport.isEnabled()) return 'disabled';
    const link = `${this.transport.frontendUrl}/reset-password#token=${encodeURIComponent(token)}`;
    try {
      await this.transport.send({ to, ...renderPasswordReset({ link, validMinutes }) });
      return 'sent';
    } catch (error: unknown) {
      const reason = describeError(error).split(token).join('[token]');
      this.logger.warn(`Password reset email not sent: ${reason}`);
      return 'failed';
    }
  }
}
