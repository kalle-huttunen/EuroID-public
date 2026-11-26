/**
 * Email bodies, HTML plus plain text. Pure functions, no I/O.
 *
 * Every interpolated value is HTML-escaped by the `html` tag unless it is itself the output of
 * that tag, so a campaign or entitlement name cannot inject markup. Mails carry no more personal
 * data than the in-app notification: no requester, identity or reviewer names, no justifications.
 * The recipient follows the link and signs in to see the details.
 */

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ESCAPES[ch]);
}

/** Markup that has been through the `html` tag: safe to embed as is. */
class SafeHtml {
  constructor(readonly value: string) {}
}

function fragment(value: unknown): string {
  if (value instanceof SafeHtml) return value.value;
  if (Array.isArray(value)) return value.map(fragment).join('');
  return escapeHtml(value);
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): SafeHtml {
  let out = strings[0];
  values.forEach((value, i) => {
    out += fragment(value) + strings[i + 1];
  });
  return new SafeHtml(out);
}

const SUBJECT_MAX = 150;
const LIST_MAX = 10;

/** One line of plain text: control characters (CR/LF included) become spaces, length capped. */
export function oneLine(value: unknown, max = SUBJECT_MAX): string {
  const flat = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** 2026-11-29 14:00 UTC, or "" for a missing or invalid date. */
export function formatUtc(value: Date | string | undefined): string {
  if (value === undefined || value === null) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function frontendLink(frontendUrl: string, path: string): string {
  return `${frontendUrl}${path}`;
}

/** The line under every mail unless a mail gives its own. */
const DEFAULT_FOOTER = 'Sent by EuroID. Sign in to see the details.';

export function layout(
  title: string,
  paragraphs: SafeHtml[],
  action: { label: string; url: string },
  footer: string = DEFAULT_FOOTER,
): string {
  return html`<!doctype html>
    <html lang="en">
      <body
        style="margin:0;padding:24px;background:#f5f6f8;font-family:Arial,Helvetica,sans-serif;color:#1f2933;"
      >
        <table
          role="presentation"
          width="100%"
          cellpadding="0"
          cellspacing="0"
          style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:6px;"
        >
          <tr>
            <td style="padding:24px;">
              <h1 style="font-size:18px;margin:0 0 16px 0;">${title}</h1>
              ${paragraphs.map(
                (p) => html`<p style="font-size:14px;line-height:1.5;margin:0 0 12px 0;">${p}</p>`,
              )}
              <p style="margin:20px 0 0 0;">
                <a
                  href="${action.url}"
                  style="display:inline-block;padding:10px 16px;background:#1f4e8c;color:#ffffff;text-decoration:none;border-radius:4px;font-size:14px;"
                  >${action.label}</a
                >
              </p>
              <p style="font-size:12px;color:#616e7c;margin:20px 0 0 0;">${footer}</p>
            </td>
          </tr>
        </table>
      </body>
    </html>`.value;
}

export function textBody(
  lines: string[],
  action: { label: string; url: string },
  footer: string = DEFAULT_FOOTER,
): string {
  return [...lines, '', `${action.label}: ${action.url}`, '', footer].join('\n');
}

/** Entitlement list: the first LIST_MAX as "name (system)", then "and N more". */
function entitlementLines(entitlements: Array<{ system: string; name: string }>): string[] {
  const shown = entitlements
    .slice(0, LIST_MAX)
    .map((e) => `${oneLine(e.name, 200)} (${oneLine(e.system, 100)})`);
  if (entitlements.length > LIST_MAX) shown.push(`and ${entitlements.length - LIST_MAX} more`);
  return shown;
}

// ── Access request approval ───────────────────────────────────────

export interface ApprovalRequestedView {
  requestId: string;
  /** 1-based approval step and how many steps the request has. */
  stepNumber: number;
  stepCount: number;
  entitlements: Array<{ system: string; name: string }>;
}

export function renderApprovalRequested(
  view: ApprovalRequestedView,
  frontendUrl: string,
): RenderedEmail {
  const action = {
    label: 'Open the request',
    url: frontendLink(frontendUrl, `/access-requests/${encodeURIComponent(view.requestId)}`),
  };
  const items = entitlementLines(view.entitlements);
  const step = `Approval step ${view.stepNumber} of ${view.stepCount}.`;
  return {
    subject: 'Access request waiting for your approval',
    text: textBody(
      [
        'An access request is waiting for your approval.',
        step,
        '',
        'Requested access:',
        ...items.map((i) => `- ${i}`),
      ],
      action,
    ),
    html: layout(
      'Access request waiting for your approval',
      [
        html`An access request is waiting for your approval. ${step}`,
        html`Requested access:<br />${items.map((i, n) =>
            n === 0 ? html`${i}` : html`<br />${i}`,
          )}`,
      ],
      action,
    ),
  };
}

// ── Access review ──────────────────────────────────────────────────

export interface ReviewAssignedView {
  campaignName: string;
  itemCount: number;
  deadline?: Date | string;
}

export function renderReviewAssigned(view: ReviewAssignedView, frontendUrl: string): RenderedEmail {
  const action = {
    label: 'Open My Reviews',
    url: frontendLink(frontendUrl, '/intelligence/reviews'),
  };
  const name = oneLine(view.campaignName);
  const items = view.itemCount === 1 ? '1 access item' : `${view.itemCount} access items`;
  const deadline = formatUtc(view.deadline);
  const due = deadline ? `Decide by ${deadline}.` : 'Decide before the campaign deadline.';
  return {
    subject: oneLine(`Access review "${name}": ${items} to review`),
    text: textBody(
      [`The access review campaign "${name}" has started.`, `You have ${items} to review. ${due}`],
      action,
    ),
    html: layout(
      'Access review started',
      [
        html`The access review campaign <strong>${name}</strong> has started.`,
        html`You have ${items} to review. ${due}`,
      ],
      action,
    ),
  };
}

export interface ReviewEscalatedView {
  campaignName: string;
  daysOverdue?: number;
}

export function renderReviewEscalated(
  view: ReviewEscalatedView,
  frontendUrl: string,
): RenderedEmail {
  const action = {
    label: 'Open My Reviews',
    url: frontendLink(frontendUrl, '/intelligence/reviews'),
  };
  const name = oneLine(view.campaignName);
  const overdue =
    view.daysOverdue && view.daysOverdue > 0
      ? `They were not decided within ${view.daysOverdue} days.`
      : 'They were overdue.';
  return {
    subject: oneLine(`Access review "${name}": overdue items reassigned to you`),
    text: textBody(
      [`Review items in the access review campaign "${name}" were reassigned to you.`, overdue],
      action,
    ),
    html: layout(
      'Overdue review items reassigned to you',
      [
        html`Review items in the access review campaign <strong>${name}</strong> were reassigned to
          you.`,
        html`${overdue}`,
      ],
      action,
    ),
  };
}

// ── Expiring access ────────────────────────────────────────────────

export interface AccessExpiringView {
  targetSystem: string;
  expiresAt: Date | string;
  /** 'soon': about seven days left; 'tomorrow': the last day. */
  window: 'soon' | 'tomorrow';
}

export function renderAccessExpiring(view: AccessExpiringView, frontendUrl: string): RenderedEmail {
  const action = {
    label: 'Request access again',
    url: frontendLink(frontendUrl, '/access-requests'),
  };
  const system = oneLine(view.targetSystem, 100);
  const when = view.window === 'tomorrow' ? 'tomorrow' : 'in 7 days';
  const at = formatUtc(view.expiresAt);
  const removal = at
    ? `Your time-limited access to ${system} ends ${when}, at ${at}, and is then removed.`
    : `Your time-limited access to ${system} ends ${when} and is then removed.`;
  return {
    subject: oneLine(`Your access to ${system} expires ${when}`),
    text: textBody([removal, 'If you still need it, request it again before it ends.'], action),
    html: layout(
      `Your access to ${system} expires ${when}`,
      [html`${removal}`, html`If you still need it, request it again before it ends.`],
      action,
    ),
  };
}
