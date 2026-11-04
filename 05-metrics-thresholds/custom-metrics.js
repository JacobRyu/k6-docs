import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Gauge, Rate, Trend } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://localhost:8080';

// 4 種類のカスタムメトリクス
const businessErrors = new Counter('business_errors'); // 累積件数
const orderSuccess = new Rate('order_success'); // 成功率
const payloadSize = new Gauge('payload_size'); // 最新値/最小/最大
const detailLatency = new Trend('detail_latency', true); // 分布（ms）

export const options = {
  vus: 3,
  duration: '30s',
  thresholds: {
    // カスタムメトリクスも合否に使える
    order_success: ['rate>0.95'],
    detail_latency: ['p(95)<500'],
    'business_errors{reason:empty}': ['count<10'],
  },
};

export default function () {
  const list = http.get(`${BASE}/api/products?limit=10`, {
    tags: { api: 'list' },
  });

  check(list, { 'list: status is 200': (r) => r.status === 200 });

  const items = list.status === 200 ? list.json('items') : [];
  payloadSize.add(list.body ? list.body.length : 0);

  // ビジネス上の失敗を明示的に分類する
  if (items.length === 0) {
    businessErrors.add(1, { reason: 'empty' });
    orderSuccess.add(false);
    return;
  }

  const id = items[0].id;
  const detail = http.get(`${BASE}/api/products/${id}/`, {
    tags: { name: 'GET /api/products/:id', api: 'detail' },
  });

  // レスポンスタイムを独自 Trend にも記録（タグ付き）
  detailLatency.add(detail.timings.duration, { api: 'detail' });

  const ok = check(detail, {
    'detail: status is 200': (r) => r.status === 200,
    'detail: has name': (r) => typeof r.json('name') === 'string',
  });

  // 200 でも中身が不正ならビジネスエラー
  if (!ok) businessErrors.add(1, { reason: 'invalid_body' });
  orderSuccess.add(ok);

  sleep(1);
}
