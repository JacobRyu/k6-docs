import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE = __ENV.BASE_URL || 'http://localhost:8080';

// 閉じたモデル（VU 数で負荷を決める）のロードテスト。
// 現状ピークの 1.5〜2 倍を目標に設定するのが実務的な出発点。
export const options = {
  scenarios: {
    load: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '2m', target: 20 },   // ウォームアップ
        { duration: '10m', target: 20 },  // 定常（ここで判定）
        { duration: '3m', target: 50 },   // ピーク確認
        { duration: '1m', target: 0 },    // クールダウン
      ],
      gracefulRampDown: '30s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<800', 'p(99)<1500'],
    checks: ['rate>0.99'],
  },
  // ボディを検証しないなら有効化してメモリを節約
  discardResponseBodies: true,
};

export default function () {
  const res = http.get(`${BASE}/api/products?limit=10`, {
    tags: { api: 'list' },
  });

  check(res, {
    'status is 200': (r) => r.status === 200,
    'no network error': (r) => !r.error,
  });

  // 実ユーザーの思考時間。閉じたモデルでは必須。
  sleep(Math.random() * 2 + 1);
}
