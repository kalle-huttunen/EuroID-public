/**
 * Where SoD policies act, as the backend does it (SodService.validate and its callers):
 * - access requests (access-request-sod.service.ts): requested entitlements plus the person's
 *   access from role-based rules (directory roles and the linked admin account's included) and
 *   from their other requests still in force; BLOCK refuses, WARN is stored; checked again when
 *   the last approval comes in (claimForProvisioning), BLOCK then rejects;
 * - onboarding (policy.activities.ts evaluateUser, not retried; onboarding-sod-block.ts), mover
 *   runs (mover.activities.ts), bulk creates (bulk-provisioning-validation.ts): BLOCK;
 * - risk scores (risk-scoring.service.ts): every match, BLOCK or WARN;
 * - not: the access preview (SoD-free evaluation). Severity changes nothing; no per-policy
 *   violation count.
 */
import React from 'react';
import { Col, Collapse, Row, Typography } from 'antd';
import { Link } from 'react-router-dom';

const { Text, Paragraph } = Typography;

const TITLE = 'Where these policies act';

const Section: React.FC<{ title: string; items: React.ReactNode[] }> = ({ title, items }) => (
  <div>
    <Text strong>{title}</Text>
    <ul style={{ margin: '4px 0 0', paddingInlineStart: 20 }}>
      {items.map((item, i) => (
        <li key={i} style={{ marginBottom: 4 }}>
          {item}
        </li>
      ))}
    </ul>
  </div>
);

const RULES = <Link to="/role-rules">role-based rules</Link>;

const Body: React.FC = () => (
  <section aria-label={TITLE}>
    <Paragraph style={{ marginBottom: 12 }}>
      Each check looks at one person: their access from {RULES}, also what EuroID gives their linked
      admin account, and, for an access request, what is requested and what their earlier requests
      still give them. A policy matches when that holds every entitlement it lists (same system,
      kind and entitlement id).
    </Paragraph>
    <Row gutter={[24, 12]}>
      <Col xs={24} md={12}>
        <Section
          title="Block"
          items={[
            <>
              <Link to="/access-requests">Access requests</Link> are refused before an approver sees
              them; the request form shows the conflict before submitting. They are checked against
              the requested entitlements plus the person’s groups, licenses and directory roles from{' '}
              {RULES} and access from their earlier requests that is still in force. When the last
              approval comes in, a request is checked again against what the person holds at that
              moment and rejected on a conflict; the request page says why. Access held only in the
              target system is not included.
            </>,
            'Onboarding: the person is not provisioned and their timeline says why; the rest of the run goes on, and the run ends as failed.',
            'Mover runs fail; the identity’s timeline gives the reason.',
            <>
              <Link to="/bulk-operations">Bulk operations</Link>: a create whose access from
              role-based rules matches fails validation.
            </>,
          ]}
        />
      </Col>
      <Col xs={24} md={12}>
        <Section
          title="Warn"
          items={[
            'Access requests: the request goes ahead; the request form shows the warning, and the request page shows it to the approvers.',
            'Onboarding, mover runs and bulk creates are not stopped.',
          ]}
        />
        <div style={{ marginTop: 12 }}>
          <Section
            title="Block and Warn"
            items={[
              <>
                <Link to="/intelligence/risk">Risk scores</Link>: each matching policy adds a third
                of the identity’s SoD factor (22 of 100 risk points by default), from its access
                from role-based rules, the linked admin account’s included.
              </>,
              'Identity map: the policy trace counts one identity’s blockers and warnings.',
            ]}
          />
        </div>
      </Col>
      <Col xs={24}>
        <Section
          title="Not checked"
          items={[
            'The preview before re-evaluating an identity’s access (the mover run itself checks).',
            'Severity is a label shown with each violation; it does not change what is blocked.',
            'There is no count of current violations per policy: EuroID checks at the moments above and does not store violations per policy.',
          ]}
        />
      </Col>
    </Row>
  </section>
);

export const SodEnforcementPanel: React.FC = () => (
  <Collapse
    size="small"
    items={[
      {
        key: 'enforcement',
        label: (
          <div>
            <Text strong>{TITLE}</Text>
            <Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
              Block refuses access requests and stops onboarding, mover runs and bulk creates. Warn
              only warns on access requests. Both raise risk scores.
            </Text>
          </div>
        ),
        children: <Body />,
      },
    ]}
  />
);
