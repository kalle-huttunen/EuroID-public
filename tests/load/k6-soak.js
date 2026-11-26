/**
 * EuroID — k6 Soak Test
 *
 * Extended duration test to detect memory leaks, connection pool exhaustion,
 * and MongoDB cursor leaks under sustained moderate load.
 *
 * Run: k6 run tests/load/k6-soak.js
 * Duration: ~35 minutes
 *
 * Env vars:
 *   BASE_URL  — API base (default: http://localhost:3001/api/v1)
 *   AUTH_TOKEN — JWT bearer token
 */

import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://localhost:3001/api/v1';
const TOKEN = __ENV.AUTH_TOKEN || '';

const errorRate = new Rate('errors');
const reqCounter = new Counter('total_requests');

export const options = {
  stages: [
    { duration: '2m', target: 20 },   // ramp up
    { duration: '30m', target: 20 },   // sustained load
    { duration: '2m', target: 0 },     // ramp down
  ],
  thresholds: {
    http_req_duration: ['p(95)<1000', 'p(99)<2000'],
    errors: ['rate<0.02'],             // <2% errors over 30min
  },
};

function headers() {
  const h = { 'Content-Type': 'application/json' };
  if (TOKEN) h['Authorization'] = `Bearer ${TOKEN}`;
  return h;
}

export default function () {
  // Rotate through read-heavy endpoints (typical IGA dashboard pattern). Routes and query
  // parameters as in swagger-spec.json: the identity list pages with _start/_end (without them
  // it answers every identity), the entitlement catalog answers an empty list without a system,
  // and the risk scores take top.
  const endpoints = [
    '/health',
    '/identity?_start=0&_end=20',
    '/identity?_start=20&_end=40',
    '/policy',
    '/audit?page=1&limit=10',
    '/connectors',
    '/entitlement-catalog?system=entra-id',
    '/analytics/seasonal-patterns',
    '/risk-scores?top=10',
    '/access-reviews/campaigns?page=1&limit=10',
  ];

  const endpoint = endpoints[Math.floor(Math.random() * endpoints.length)];
  const res = http.get(`${BASE}${endpoint}`, { headers: headers() });

  reqCounter.add(1);
  const ok = check(res, {
    'status is 2xx': (r) => r.status >= 200 && r.status < 300,
    'response time < 2s': (r) => r.timings.duration < 2000,
  });
  errorRate.add(!ok);

  sleep(0.5 + Math.random()); // 0.5-1.5s pacing
}
