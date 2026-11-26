import { maskEmail } from '../identity/identity-pii';

/** Anything shaped like an email address, e.g. the recipient an SMTP 550 answer quotes. */
const EMAIL_IN_TEXT = /[^\s<>()[\]"',;:@]+@[^\s<>()[\]"',;:@]+\.[A-Za-z]{2,}/g;
const MAX_ERROR_LENGTH = 500;

/** Text with every email address masked (m•••@example.com), for logs and dead letters. */
export function maskEmailsIn(text: string): string {
  return text.replace(EMAIL_IN_TEXT, (address) => maskEmail(address));
}

/** An error's message with email addresses masked, cut to a storable length. */
export function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return maskEmailsIn(message).slice(0, MAX_ERROR_LENGTH);
}
