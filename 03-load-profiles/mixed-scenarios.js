import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE = __ENV.BASE_URL || 'http://localhost:8080';

// 3 つのユーザー行動を別々の負荷モデルで同時に動かす。
export const options = {
  scenarios: {
    // 閲覧: 同時接続ユーザー（閉じたモデル）
    browse: {
      executor: 'constant-vus',
      vus: 20,
      duration: '8m',
      exec: 'browse',
    },
    // 検索: 外部からのリクエスト到着（開いたモデル）
    search: {
      executor: 'ramping-arrival-rate',
      startRate: 5,
      timeUnit: '1s',
      stages: [
        { duration: '2m', target: 30 },
        { duration: '6m', target: 30 },
      ],
      preAllocatedVUs: 30,
      maxVUs: 120,
      exec: 'search',
    },
    // 購入: ウォームアップ後に開始
    checkout: {
      executor: 'constant-arrival-rate',
      rate: 2,
      timeUnit: '1s',
      duration: '6m',
      startTime: '2m',
      preAllocatedVUs: 10,
      maxVUs: 50,
      exec: 'checkout',
      tags: { flow: 'checkout' },
    },
  },
  thresholds: {
    'http_req_duration{scenario:browse}': ['p(95)<800'],
    'http_req_duration{scenario:search}': ['p(95)<400'],
    'http_req_duration{scenario:checkout}': ['p(95)<1200'],
    'http_req_failed{scenario:checkout}': ['rate<0.001'],
  },
};

export function browse() {
  const res = http.get(`${BASE}/api/products?limit=10`, {
    tags: { api: 'list' },
  });
  check(res, { 'browse ok': (r) => r.status === 200 });
  sleep(Math.random() * 3 + 2);
}

export function search() {
  const res = http.get(`${BASE}/api/products/1/`, {
    tags: { name: 'GET /api/products/:id', api: 'detail' },
  });
  check(res, { 'search ok': (r) => r.status === 200 });
  // arrival-rate なので sleep しない
}

export function checkout() {
  const res = http.post(
    `${BASE}/api/orders`,
    JSON.stringify({ item: `sku-${__ITER}`, quantity: 1 }),
    {
      headers: { 'Content-Type': 'application/json' },
      tags: { name: 'POST /api/orders', api: 'checkout' },
    },
  );
  check(res, {
    'checkout accepted': (r) => r.status === 201,
    'order id returned': (r) => typeof r.json('order_id') === 'string',
  });
}
