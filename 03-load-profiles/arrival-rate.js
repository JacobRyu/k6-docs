import http from 'k6/http';
import { check } from 'k6';

const BASE = __ENV.BASE_URL || 'http://localhost:8080';

// 開いたモデル（到着率で負荷を決める）。
// 「毎秒何リクエストを処理できるか」を測るのに適する。
// sleep は入れない（VU を無駄に占有するため）。
export const options = {
  scenarios: {
    ramp_rate: {
      executor: 'ramping-arrival-rate',
      startRate: 10,
      timeUnit: '1s',
      stages: [
        { duration: '2m', target: 50 },   // 50 RPS まで増加
        { duration: '3m', target: 50 },   // 50 RPS 維持
        { duration: '2m', target: 100 },  // 100 RPS まで増加
        { duration: '3m', target: 100 },  // 100 RPS 維持
        { duration: '2m', target: 20 },   // 戻す
      ],
      // 到着率を支える VU 数。リトルの法則 + 余裕で見積もる。
      // 100 RPS × 0.5s = 50 並行 → 余裕をみて 100
      preAllocatedVUs: 100,
      maxVUs: 400,
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<1000', 'p(99)<2000'],
    // 到着率を維持できなかった量。0 に近いほど意図どおり。
    dropped_iterations: ['count<100'],
  },
};

export default function () {
  const res = http.get(`${BASE}/api/products?limit=10`, {
    tags: { api: 'list' },
  });

  check(res, {
    'status is 200': (r) => r.status === 200,
    'no network error': (r) => !r.error,
  });
}
