/**
 * EuroID — k6 Stress Test
 *
 * Progressively increase load to find breaking point.
 * Identifies: connection pool exhaustion, MongoDB query timeouts,
 * Temporal worker saturation, and API throttle behavior.
 *
 * Run: k6 run tests/load/k6-stress.js
 *
 * Env vars:
 *   BASE_URL  — API base (default: http://localhost:3001/api/v1)
 *   AUTH_TOKEN — JWT bearer token
 */

import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://localhost:3001/api/v1';
const TOKEN = __ENV.AUTH_TOKEN || '';

const errorRate = new Rate('errors');
const throttledRate = new Rate('throttled');

export const options = {
  stages: [
    { duration: '1m', target: 10 },    // warm up
    { duration: '2m', target: 50 },    // moderate load
    { duration: '2m', target: 100 },   // high load
    { duration: '2m', target: 200 },   // stress
    { duration: '2m', target: 300 },   // breaking point?
    { duration: '1m', target: 0 },     // recovery
  ],
  thresholds: {
    http_req_duration: ['p(95)<2000'],  // relaxed: find where it breaks
    errors: ['rate<0.30'],              // expect some errors at peak
  },
};

function headers() {
  const h = { 'Content-Type': 'application/json' };
  if (TOKEN) h['Authorization'] = `Bearer ${TOKEN}`;
  return h;
}

export default function () {
  // Mix of read and write-like operations
  const rand = Math.random();

  if (rand < 0.60) {
    // 60%: Read operations (dashboard simulation)
    // Routes and parameters as in swagger-spec.json: the identity list pages with _start/_end
    // (without them it answers every identity), the catalog needs a system
    const readEndpoints = [
      '/identity?_start=0&_end=20',
      '/policy',
      '/connectors',
      '/audit?page=1&limit=10',
      '/entitlement-catalog?system=entra-id',
    ];
    const endpoint = readEndpoints[Math.floor(Math.random() * readEndpoints.length)];
    const res = http.get(`${BASE}${endpoint}`, { headers: headers() });

    const ok = check(res, {
      'read status ok': (r) => r.status >= 200 && r.status < 300,
    });
    errorRate.add(!ok);
    throttledRate.add(res.status === 429);

  } else if (rand < 0.85) {
    // 25%: Search / filter operations
    // The identity search parameter is q
    const res = http.get(`${BASE}/identity?_start=0&_end=50&q=test`, { headers: headers() });
    const ok = check(res, {
      'search status ok': (r) => r.status >= 200 && r.status < 300,
    });
    errorRate.add(!ok);
    throttledRate.add(res.status === 429);

  } else {
    // 15%: Health checks (lightweight, tests connection pool)
    const res = http.get(`${BASE}/health`, { headers: headers() });
    const ok = check(res, {
      'health ok': (r) => r.status === 200,
    });
    errorRate.add(!ok);
  }

  sleep(0.2 + Math.random() * 0.3); // fast pacing to stress
}
