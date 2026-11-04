import http from 'k6/http';
import { check, group, sleep } from 'k6';

const BASE = __ENV.BASE_URL || 'http://localhost:8080';

export const options = {
  vus: 2,
  duration: '15s',
  thresholds: {
    // タグ別に SLO を分ける
    'http_req_duration{flow:list}': ['p(95)<800'],
    'http_req_duration{flow:detail}': ['p(95)<600'],
    'http_req_failed{flow:detail}': ['rate<0.01'],
  },
};

export default function () {
  // group は「処理のまとまり」に名前を付ける。深いネストは避ける。
  group('一覧 → 詳細', () => {
    const list = http.get(`${BASE}/api/products?limit=10`, {
      tags: { flow: 'list' },
    });
    check(list, { 'list ok': (r) => r.status === 200 });

    if (list.status !== 200) return;

    // 動的 ID はそのままだと URL ごとにメトリクスが増える。
    // name タグでテンプレート化して集約する。
    for (const item of list.json('items').slice(0, 3)) {
      const res = http.get(`${BASE}/api/products/${item.id}/`, {
        tags: {
          name: 'GET /api/products/:id',
          flow: 'detail',
        },
      });

      check(res, {
        'detail: status is 200': (r) => r.status === 200,
        'detail: id matches': (r) => r.json('id') === item.id,
      });
    }
  });

  sleep(Math.random() * 2 + 1); // 1〜3 秒
}
