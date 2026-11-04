import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE = __ENV.BASE_URL || 'http://localhost:8080';

// 「何をもって合格か」をここに全部書く。人がグラフを見る運用にしない。
export const options = {
  vus: 5,
  duration: '45s',
  thresholds: {
    // 全体
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<800', 'p(99)<1500'],

    // タグ別（エンドポイントごとの SLO）
    'http_req_duration{api:list}': ['p(95)<600'],
    'http_req_duration{api:detail}': ['p(95)<400'],

    // check の成功率
    checks: ['rate>0.99'],

    // 危険域に入ったら即中止（本番試験の安全装置）
    'http_req_failed{api:list}': [
      {
        threshold: 'rate<0.05',
        abortOnFail: true,
        delayAbortEval: '15s', // ウォームアップ中の一過性エラーを無視
      },
    ],
  },
};

export default function () {
  const list = http.get(`${BASE}/api/products?limit=10`, {
    tags: { api: 'list' },
  });

  const ok = check(list, {
    'list: status is 200': (r) => r.status === 200,
    'list: no network error': (r) => !r.error,
    'list: body has items': (r) => Array.isArray(r.json('items')),
  });

  const items = ok ? list.json('items') : [];
  if (items.length > 0) {
    const id = items[0].id;
    const detail = http.get(`${BASE}/api/products/${id}/`, {
      tags: { name: 'GET /api/products/:id', api: 'detail' },
    });

    check(detail, {
      'detail: status is 200': (r) => r.status === 200,
      'detail: id matches': (r) => r.json('id') === id,
    });
  }

  sleep(1);
}
