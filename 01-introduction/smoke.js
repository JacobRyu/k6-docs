import http from 'k6/http';
import { check, sleep } from 'k6';

// 同梱モック API（python3 mock/server.py）を既定の宛先にする。
const BASE = __ENV.BASE_URL || 'http://localhost:8080';

// options はテスト全体の設定。ここでは「1 VU で 10 秒」のスモークテスト。
export const options = {
  vus: 1,
  duration: '10s',
  thresholds: {
    // 失敗率 1% 未満
    http_req_failed: ['rate<0.01'],
    // 95% のリクエストが 500ms 未満
    http_req_duration: ['p(95)<500'],
  },
};

export default function () {
  const res = http.get(`${BASE}/api/products?limit=5`);

  // check は「その場の検証」。失敗してもテストは止まらない。
  check(res, {
    'status is 200': (r) => r.status === 200,
    'body has items': (r) => Array.isArray(r.json('items')),
    'items are not empty': (r) => r.json('items').length > 0,
  });

  // 実ユーザーの思考時間。これがないと 1 VU が最速で連打してしまう。
  sleep(1);
}
