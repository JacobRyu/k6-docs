import http from 'k6/http';
import { check, sleep } from 'k6';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.2/index.js';

// Webhook（Slack / Teams / 自前エンドポイント）へ結果を通知する例。
//   WEBHOOK_URL=https://hooks.slack.com/services/XXX k6 run 10-integrations/webhook-summary.js
const BASE = __ENV.BASE_URL || 'http://localhost:8080';
const WEBHOOK_URL = __ENV.WEBHOOK_URL || '';

export const options = {
  vus: 1,
  duration: '5s',
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<500'],
  },
};

export default function () {
  const res = http.get(`${BASE}/api/products?limit=5`);

  check(res, {
    'status is 200': (r) => r.status === 200,
    'has items': (r) => Array.isArray(r.json('items')),
  });

  sleep(1);
}

export function handleSummary(data) {
  const text = textSummary(data, { indent: '  ', enableColors: false });

  if (!WEBHOOK_URL) {
    return { stdout: text };
  }

  const failedMetric = data.metrics.http_req_failed;
  const durationMetric = data.metrics.http_req_duration;
  const failed = (failedMetric ? failedMetric.values.rate : 0) * 100;
  // リクエストが 0 件だと p(95) は存在しない
  const p95 = durationMetric && durationMetric.values['p(95)']
    ? durationMetric.values['p(95)']
    : 0;
  const seconds = Math.round(data.state.testRunDurationMs / 1000);

  const payload = JSON.stringify({
    text: [
      `k6 finished (${seconds}s)`,
      `error rate: ${failed.toFixed(2)}%`,
      `p95: ${p95.toFixed(1)} ms`,
    ].join(' / '),
  });

  const res = http.post(WEBHOOK_URL, payload, {
    headers: { 'Content-Type': 'application/json' },
    timeout: '5s',
  });

  console.log(`webhook status=${res.status}`);
  return { stdout: text };
}
