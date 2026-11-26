/**
 * The console admin password reset mail, HTML plus plain text (email-templates.ts escaping and
 * layout). It names no person: only the link, how long it works, and what to do if the
 * recipient did not ask for it.
 */
import { html, layout, textBody, type RenderedEmail } from './email-templates';

export interface PasswordResetView {
  /** The frontend reset page with the token in the fragment. */
  link: string;
  validMinutes: number;
}

const FOOTER =
  'Sent by EuroID because someone asked to reset the password of this admin account. If it was not you, ignore this email: your password stays as it is.';

export function renderPasswordReset(view: PasswordResetView): RenderedEmail {
  const action = { label: 'Set a new password', url: view.link };
  const validity = `The link works once, for ${view.validMinutes} minutes. Setting the password signs you out everywhere; your MFA stays as it is.`;
  return {
    subject: 'Reset your EuroID password',
    text: textBody(
      ['Someone asked to reset the password of your EuroID admin account.', validity],
      action,
      FOOTER,
    ),
    html: layout(
      'Reset your EuroID password',
      [html`Someone asked to reset the password of your EuroID admin account.`, html`${validity}`],
      action,
      FOOTER,
    ),
  };
}
