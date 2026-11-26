/**
 * EuroID — k6 Smoke Test
 *
 * Quick validation that core API endpoints respond under light load.
 * Run: k6 run tests/load/k6-smoke.js
 *
 * Env vars:
 *   BASE_URL  — API base (default: http://localhost:3001/api/v1)
 *   AUTH_TOKEN — JWT bearer token (optional if AUTH_DISABLED=true)
 */

import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Rate, Trend } from 'k6/metrics';

// ── Config ──────────────────────────────────────────────
const BASE = __ENV.BASE_URL || 'http://localhost:3001/api/v1';
const TOKEN = __ENV.AUTH_TOKEN || '';

const errorRate = new Rate('errors');
const identityListDuration = new Trend('identity_list_duration', true);
const healthDuration = new Trend('health_check_duration', true);

export const options = {
  // Smoke test: light load, validate correctness
  stages: [
    { duration: '30s', target: 5 },   // ramp to 5 VUs
    { duration: '1m', target: 5 },    // hold
    { duration: '10s', target: 0 },   // ramp down
  ],
  thresholds: {
    http_req_duration: ['p(95)<500', 'p(99)<1000'], // 95th < 500ms, 99th < 1s
    errors: ['rate<0.05'],                           // <5% error rate
    identity_list_duration: ['p(95)<800'],
    health_check_duration: ['p(99)<200'],
  },
};

function headers() {
  const h = { 'Content-Type': 'application/json' };
  if (TOKEN) h['Authorization'] = `Bearer ${TOKEN}`;
  return h;
}

// ── Scenarios ───────────────────────────────────────────

export default function () {
  group('Health Check', () => {
    const res = http.get(`${BASE}/health`, { headers: headers() });
    healthDuration.add(res.timings.duration);
    const ok = check(res, {
      'health returns 200': (r) => r.status === 200,
    });
    errorRate.add(!ok);
  });

  // Routes and parameters as in swagger-spec.json: the identity list pages with _start/_end
  // (without them it answers every identity) and answers a plain array.
  group('Identity List (paginated)', () => {
    const res = http.get(`${BASE}/identity?_start=0&_end=20`, { headers: headers() });
    identityListDuration.add(res.timings.duration);
    const ok = check(res, {
      'identity list returns 200': (r) => r.status === 200,
      'answers an array': (r) => {
        try { return Array.isArray(JSON.parse(r.body)); }
        catch { return false; }
      },
    });
    errorRate.add(!ok);
  });

  group('Policy List', () => {
    const res = http.get(`${BASE}/policy`, { headers: headers() });
    const ok = check(res, {
      'policy list returns 200': (r) => r.status === 200,
    });
    errorRate.add(!ok);
  });

  group('Connector Configs', () => {
    const res = http.get(`${BASE}/connectors`, { headers: headers() });
    const ok = check(res, {
      'connectors returns 200': (r) => r.status === 200,
    });
    errorRate.add(!ok);
  });

  group('Audit Events (recent)', () => {
    const res = http.get(`${BASE}/audit?page=1&limit=10`, { headers: headers() });
    const ok = check(res, {
      'audit returns 200': (r) => r.status === 200,
    });
    errorRate.add(!ok);
  });

  // Without a system the catalog answers an empty list and runs no query
  group('Entitlement Catalog', () => {
    const res = http.get(`${BASE}/entitlement-catalog?system=entra-id`, { headers: headers() });
    const ok = check(res, {
      'entitlements returns 200': (r) => r.status === 200,
    });
    errorRate.add(!ok);
  });

  sleep(1); // pacing between iterations
}
