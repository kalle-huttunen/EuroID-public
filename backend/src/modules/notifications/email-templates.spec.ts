import {
  escapeHtml,
  formatUtc,
  oneLine,
  renderAccessExpiring,
  renderApprovalRequested,
  renderReviewAssigned,
  renderReviewEscalated,
} from './email-templates';

const APP = 'https://euroid.example.com';
const INJECTION = '<img src=x onerror=alert(1)><a href="https://evil.example">click</a>';

describe('email templates', () => {
  it('escapes every HTML-significant character', () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;',
    );
  });

  it('keeps a subject on one line and caps its length', () => {
    expect(oneLine('a\r\nBcc: victim@example.com\tb')).toBe('a Bcc: victim@example.com b');
    expect(oneLine('x'.repeat(400))).toHaveLength(150);
  });

  it('formats dates in UTC and drops invalid ones', () => {
    expect(formatUtc(new Date('2026-11-29T14:05:00Z'))).toBe('2026-11-29 14:05 UTC');
    expect(formatUtc('2026-11-29T14:05:00.000Z')).toBe('2026-11-29 14:05 UTC');
    expect(formatUtc('not a date')).toBe('');
    expect(formatUtc(undefined)).toBe('');
  });

  describe('approval requested', () => {
    const mail = renderApprovalRequested(
      {
        requestId: 'req/1?x=<y>',
        stepNumber: 1,
        stepCount: 2,
        entitlements: [{ system: 'entra-id', name: INJECTION }],
      },
      APP,
    );

    it('escapes entitlement names in the HTML body', () => {
      expect(mail.html).not.toContain('<img');
      expect(mail.html).not.toContain('href="https://evil.example"');
      expect(mail.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    });

    it('links to the request in the web app, with the id URL-encoded', () => {
      const url = `${APP}/access-requests/${encodeURIComponent('req/1?x=<y>')}`;
      expect(mail.text).toContain(url);
      expect(mail.html).toContain(`href="${escapeHtml(url)}"`);
    });

    it('says which step it is and lists what was requested', () => {
      expect(mail.subject).toBe('Access request waiting for your approval');
      expect(mail.text).toContain('Approval step 1 of 2.');
      expect(mail.text).toContain('(entra-id)');
    });

    it('lists at most ten entitlements', () => {
      const many = renderApprovalRequested(
        {
          requestId: 'r',
          stepNumber: 1,
          stepCount: 1,
          entitlements: Array.from({ length: 12 }, (_, i) => ({ system: 's', name: `g${i}` })),
        },
        APP,
      );
      expect(many.text).toContain('g9 (s)');
      expect(many.text).not.toContain('g10 (s)');
      expect(many.text).toContain('and 2 more');
    });
  });

  describe('review assigned', () => {
    const mail = renderReviewAssigned(
      {
        campaignName: `Q4\r\nBcc: x@evil.example ${INJECTION}`,
        itemCount: 3,
        deadline: '2026-12-01T00:00:00Z',
      },
      APP,
    );

    it('escapes the campaign name and keeps the subject on one line', () => {
      expect(mail.html).not.toContain('<img');
      expect(mail.subject).not.toMatch(/[\r\n]/);
      expect(mail.subject).toContain('3 access items to review');
    });

    it('gives the deadline and links to the reviews page', () => {
      expect(mail.text).toContain('Decide by 2026-12-01 00:00 UTC.');
      expect(mail.text).toContain(`${APP}/intelligence/reviews`);
    });
  });

  it('review escalated: escapes the campaign name and says why', () => {
    const mail = renderReviewEscalated({ campaignName: INJECTION, daysOverdue: 7 }, APP);
    expect(mail.html).not.toContain('<img');
    expect(mail.text).toContain('not decided within 7 days');
    expect(mail.subject).toContain('overdue items reassigned to you');
  });

  describe('access expiring', () => {
    it('names the system and when the access ends, escaped', () => {
      const mail = renderAccessExpiring(
        {
          targetSystem: '<b>entra</b>',
          expiresAt: new Date('2026-11-23T09:00:00Z'),
          window: 'tomorrow',
        },
        APP,
      );
      expect(mail.subject).toBe('Your access to <b>entra</b> expires tomorrow');
      expect(mail.html).not.toContain('<b>entra</b>');
      expect(mail.html).toContain('&lt;b&gt;entra&lt;/b&gt;');
      expect(mail.text).toContain('at 2026-11-23 09:00 UTC');
      expect(mail.text).toContain(`${APP}/access-requests`);
    });

    it('says "in 7 days" for the early warning', () => {
      const mail = renderAccessExpiring(
        { targetSystem: 'scim', expiresAt: '2026-11-29T09:00:00Z', window: 'soon' },
        APP,
      );
      expect(mail.subject).toBe('Your access to scim expires in 7 days');
    });
  });
});
