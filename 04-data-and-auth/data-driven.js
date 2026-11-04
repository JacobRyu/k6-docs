import http from 'k6/http';
import { check } from 'k6';
import { SharedArray } from 'k6/data';
import exec from 'k6/execution';
import papaparse from 'https://jslib.k6.io/papaparse/5.1.1/index.js';

const BASE = __ENV.BASE_URL || 'http://localhost:8080';

// SharedArray: init で 1 回だけ読み込み、全 VU で共有する。
// コールバック内では open() が使える（init コンテキスト）。
const users = new SharedArray('users', () => {
  const rows = papaparse.parse(open('./data/users.csv'), { header: true }).data;
  return rows.filter((u) => u.email && u.email.trim() !== '');
});

export const options = {
  vus: 4,
  iterations: 40, // 40 行を 4 VU で分担
  thresholds: {
    checks: ['rate>0.99'],
    http_req_failed: ['rate<0.01'],
  },
};

export default function () {
  // 全 VU で重複しない通し番号。ランダムだと同じ行を引く可能性がある。
  const idx = exec.scenario.iterationInTest % users.length;
  const user = users[idx];

  // 実行ごとに一意な値（作成系 API で衝突を避ける）
  const uniqueKey = `lt-${exec.vu.idInTest}-${exec.scenario.iterationInTest}`;

  const res = http.post(
    `${BASE}/api/echo`,
    JSON.stringify({
      email: user.email,
      plan: user.plan,
      unique_key: uniqueKey,
    }),
    {
      headers: { 'Content-Type': 'application/json' },
      tags: { name: 'POST /api/echo', api: 'create' },
    },
  );

  check(res, {
    'status is 200': (r) => r.status === 200,
    'email echoed correctly': (r) => r.json('json.email') === user.email,
    'unique key is unique': (r) => r.json('json.unique_key') === uniqueKey,
  });
}
