import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://localhost:8080';

// カスタムメトリクス: ビジネス上の失敗（200 でも中身が不正など）を数える
const businessErrors = new Rate('business_errors');

export const options = {
  vus: 3,
  duration: '20s',
  thresholds: {
    // check の成功率も合否に使える
    checks: ['rate>0.99'],
    http_req_failed: ['rate<0.02'],
    // タグで絞ったしきい値
    'http_req_duration{api:list}': ['p(95)<800'],
    'http_req_duration{api:create}': ['p(95)<1500'],
    business_errors: ['rate<0.05'],
  },
};

export default function () {
  // --- 1. GET + 検証 ---
  const list = http.get(`${BASE}/api/products?limit=10`, {
    tags: { api: 'list' },
  });

  const listOk = check(list, {
    'list: status is 200': (r) => r.status === 200,
    'list: no network error': (r) => !r.error,
    'list: body has items': (r) => Array.isArray(r.json('items')),
  });
  businessErrors.add(!listOk);

  // --- 2. POST (JSON) ---
  const payload = JSON.stringify({
    name: `product-${__VU}-${__ITER}`,
    price: 19.99,
    category: 'loadtest',
  });
  const params = {
    headers: { 'Content-Type': 'application/json' },
    tags: { api: 'create' },
  };
  const created = http.post(`${BASE}/api/echo`, payload, params);

  check(created, {
    'create: status is 200': (r) => r.status === 200,
    'create: echoed name matches': (r) => r.json('json.name')?.startsWith('product-'),
  });

  // --- 3. batch: 独立したリクエストを並行実行 ---
  const responses = http.batch([
    ['GET', `${BASE}/api/products/1/`, null, { tags: { api: 'detail' } }],
    ['GET', `${BASE}/api/products/2/`, null, { tags: { api: 'detail' } }],
  ]);
  check(responses, {
    'batch: all 2xx': (rs) => rs.every((r) => r.status >= 200 && r.status < 300),
  });

  sleep(1);
}
