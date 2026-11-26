/**
 * The reconciliation drift alert mail, HTML plus plain text (email-templates.ts escaping and
 * layout): a run reached a drift threshold of its settings. Counts only, no identity or account;
 * the link opens the Reconciliation page, where the drifts are.
 */
import { html, layout, oneLine, textBody, type RenderedEmail } from './email-templates';

export interface DriftThresholdView {
  totalDrifts: number;
  criticalDrifts: number;
  alerts: Array<{
    threshold: 'maxDriftsBeforeAlert' | 'criticalDriftAlertThreshold';
    limit: number;
    found: number;
  }>;
}

const INTRO = 'A reconciliation run reached a drift alert threshold of its settings.';

export function renderDriftThresholdExceeded(
  view: DriftThresholdView,
  frontendUrl: string,
): RenderedEmail {
  const action = { label: 'Open Reconciliation', url: `${frontendUrl}/reconciliation` };
  const lines = view.alerts.map((alert) =>
    alert.threshold === 'criticalDriftAlertThreshold'
      ? `It found ${alert.found} critical drifts; the alert threshold is ${alert.limit}.`
      : `It found ${alert.found} drifts; the alert threshold is ${alert.limit}.`,
  );
  return {
    subject: oneLine(
      `Reconciliation found ${view.totalDrifts} drifts (${view.criticalDrifts} critical)`,
    ),
    text: textBody([INTRO, ...lines], action),
    html: layout(
      'Reconciliation drift alert',
      [html`${INTRO}`, ...lines.map((line) => html`${line}`)],
      action,
    ),
  };
}
