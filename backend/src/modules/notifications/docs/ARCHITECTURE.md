# Email Notifications (`modules/notifications`)

> **Related:** [Access requests](../../access-requests/docs/ARCHITECTURE.md) · [Event bus](../../../../../docs/architecture/core/EVENT_BUS_ARCHITECTURE.md) · [Temporal workflows](../../../../../docs/architecture/infrastructure/TEMPORAL_WORKFLOWS.md) · [User flows, Flow 11](../../../../../docs/USER_FLOWS.md)

Sends email next to the in-app Socket.IO events (`infrastructure/realtime/`), which are unchanged. One SMTP server per deployment, configured from env (`backend/.env.example`, `infrastructure/config/mail.config.ts`). Without `SMTP_HOST` email is off: every entry point returns at once, nothing is stored, and each process (API, worker) logs one line at startup.

## Who gets what

| Mail (`kind`) | Trigger | Recipient | Sent once per |
|---|---|---|---|
| `approval-requested` | `accessRequestApprovalWorkflow` calls the `notifyApprover` activity for each approval step, and once for the new approver after a delegation | The step's `approverEmail`, else its `approverId`; for a `ROLE` step each active admin user of the tenant with that role; not the requester | request, step, recipient |
| `review-assigned` | `access_review.campaign_activated` (`AccessReviewCampaignService.activate`) | Each distinct `reviewerId` of the campaign's pending items, with their item count and the deadline | campaign, recipient |
| `review-escalated` | `access_review.item_escalated` (`AccessReviewActivities.checkAndEscalateOverdue`) | The item's new reviewer: the event carries no address, the handler reads the item's `reviewerId` by `itemId` | campaign, recipient (one mail however many items move) |
| `access-expiring` | `entitlement.expiring_soon` (7 days left) and `entitlement.expiring_tomorrow`, emitted by the hourly `entitlementExpiryWorkflow` for `provisioning[].expiresAt` | The identity that holds the access (its owner) | window, identity, target system, expiry time |
| `drift-threshold-exceeded` | A reconciliation run reached a drift threshold with `notifyOnDrift` and named `notifyEmail` (`POST /reconciliation/start-daily`): `dailyReconciliationWorkflow` calls the `notifyDriftThresholdExceeded` activity (`activities/reconciliation.activities.ts`) | The run's `notifyEmail`, resolved inside the tenant like any key (an active admin user or an identity) | run, recipient |
| Password reset (not stored, see below) | `POST /auth/password-reset/request` (`modules/auth/password-reset.service.ts`) | The address asked for, when it is an active console admin account that signs in with a password | each request (rate limited per address and IP) |

"Sent once" is the unique index `(tenantId, dedupeKey)` on `email_notifications`: an activity can run twice, an event can be replayed. The expiry workflow itself emits each warning once per provisioning entry and expiry date (`provisioning[].expiryWarnings`, see [Temporal workflows](../../../../../docs/architecture/infrastructure/TEMPORAL_WORKFLOWS.md)).

Not covered: access granted through an access request with a duration (`timeConstraint.expiresAt`) is revoked by `accessRequestApprovalWorkflow` sleeping until the expiry and gets no warning, because nothing signals it beforehand (adding one changes that workflow's commands and needs `patched()`). Credential rotation (`credential.expiring_soon`) is a scheduled password rotation, not access that ends, and sends no mail.

## Recipients stay inside the tenant

`EmailRecipientsService.resolve(tenantId, key)` maps the approver, reviewer or owner a record names to an address. A key resolves only to an active admin user of that tenant (`admin_users`, by email or id, tenant in the filter) or a not-deleted identity of that tenant (`IdentityService.findByEmail` / `findById` inside `withTenantContext(tenantId)`). Anything else gets no mail and an info log with the key masked: an address nobody in the tenant has, or an `ACCESS_REVIEW_DEFAULT_REVIEWER` placeholder such as `unassigned@review.pending`. A `ROLE` approval step (its `approverEmail` is the role name) is not resolved: the activity passes the role and `EmailRecipientsService.roleHolders(tenantId, role)` returns the active admin users of the tenant with that role; when nobody but the requester holds it, nobody is mailed and an info line names the role. The tenant always comes from the workflow input (`notifyApprover`) or the event's `metadata.tenantId`.

## Content

`email-templates.ts` renders HTML plus plain text. Every interpolated value passes through the `html` tag, which HTML-escapes it unless it is the tag's own output; subjects are one line (control characters removed, 150 characters). Mails carry no more personal data than the in-app notification: no requester, identity or reviewer names and no justifications, only entitlement and system names, the campaign name, counts and dates. Links point at the frontend origin (`FRONTEND_URL`, else the first `CORS_ORIGINS` entry): `/access-requests/:id`, `/intelligence/reviews`, `/access-requests`, `/reconciliation`.

## Password reset mail

`PasswordResetMailService` (`password-reset-mail.service.ts`, template `password-reset-email.ts`) sends the console admin password reset mail for `modules/auth`. It carries a live reset token, so it does not go through `EmailDeliveryService`: it is sent at once through `MailTransportService`, never stored in `email_notifications` and never retried from the dead-letter queue, which would keep the token in clear for as long as the mail waited. A failed send returns `failed` and is logged without the address or the token; the admin asks again, or a super-admin issues a code. The request's answer never waits for the mail (the auth module sends it after answering). The link is `<FRONTEND_URL>/reset-password#token=<token>`: the token sits in the URL fragment, which the browser never sends to a server. The mail names nobody and says what to do if the recipient did not ask.

## Delivery and retries

Sending never blocks or fails a workflow, a request or the event bus.

1. `EmailDeliveryService.dispatch` stores the mail (`email_notifications`, status `PENDING`), claims it (`SENDING`, atomic), sends it through nodemailer (`MailTransportService`), and marks it `SENT` with the bodies removed, or `FAILED` with `lastError` (addresses masked). It never throws.
2. A failed send is captured in the dead-letter queue as an `event_handler_failure` entry (source `email:<kind>`) whose stored event is `notification.email_retry` with `{ notificationId, kind }`: no address, no content.
3. The DLQ's auto-retry (`DLQ_MAX_RETRIES`, default 3; first after 1 minute, then 1 and 5 minutes) and its admin retry re-emit that event. `EmailNotificationHandler.handleRetry` (`suppressErrors: false`) calls `redeliver`, which throws when the send fails again so the DLQ counts the attempt and finally marks the entry `failed_permanently`. A notification already `SENT` is reported as done; one that no longer exists (TTL) or a retry with email turned off throws. The entry names no `handler`, so a retry re-emits the event to every listener (audit and the other wildcard listeners too) and closes the entry as `replayed` only when all of them succeeded; a retry after another listener failed finds the mail `SENT` and sends nothing twice. The poller (`DeadLetterService.processAutoRetries`) runs each retry in the entry's tenant and picks only entries that carry a domain event; `email-dlq-retry.integration.spec.ts` covers a failed send that the next automatic retry delivers.
4. A `SENDING` claim older than six SMTP timeouts is taken over (the process died mid-send).

Why the DLQ and not a Temporal retry policy for the approver mail: the approval workflow proxies its activities with Temporal's default retry policy (unlimited attempts), so a throwing `notifyApprover` would hold the approval step for as long as SMTP is down, and bounding it would change the workflow's activity options. The reviewer and expiry mails have no activity of their own. One mechanism serves all four, and the activity stays a quick call that never throws, with no workflow change.

`email_notifications` documents are deleted after 30 days (TTL index, like webhook delivery attempts).

The dead-letter capture itself runs in the notification's tenant context: the tenant plugin also validates the entry's nested `error` document, and a capture without a context fails.

Known gap: a process that dies after storing a mail and before its send outcome is recorded leaves it `PENDING` or `SENDING` without a dead-letter entry; nothing retries it.

## Files

| File | Role |
|---|---|
| `infrastructure/config/mail.config.ts` | `SMTP_*`, `FRONTEND_URL` parsing; off without `SMTP_HOST`, startup error on an invalid value once on |
| `mail-transport.service.ts` | nodemailer SMTP transport (lazy connect, timeouts, STARTTLS required by default); `MAIL_SENDER` token for a test transport |
| `email-delivery.service.ts` | Store, claim, send, mark; DLQ capture; `redeliver` |
| `email-recipients.service.ts` | Tenant-scoped recipient resolution |
| `email-notification.service.ts` | Per-kind recipient, template and dedupe key |
| `email-notification.handler.ts` | Event listeners (campaign activated, escalated, expiring, retry) |
| `email-templates.ts` | HTML plus text bodies, escaping |
| `drift-threshold-email.ts` | The reconciliation drift alert (`drift-threshold-exceeded`): counts and the thresholds, a link to `/reconciliation` |
| `password-reset-mail.service.ts`, `password-reset-email.ts` | Console admin password reset mail: sent at once, not stored or retried |
| `schemas/email-notification.schema.ts` | `email_notifications` collection |
| `activities/access-request.activities.ts` (`notifyApprover`) | Approver mail from the approval workflow |
| `activities/reconciliation.activities.ts` (`notifyDriftThresholdExceeded`) | Drift alert mail from the daily reconciliation |
