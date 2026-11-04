import http from 'k6/http';
import { check, sleep } from 'k6';
import exec from 'k6/execution';

// init コンテキスト: VU ごとに 1 回だけ実行される
const BASE = __ENV.BASE_URL || 'http://localhost:8080';
const startedAt = new Date().toISOString();

export const options = {
  // shared-iterations: 合計 4 イテレーションを 2 VU で分担する
  vus: 2,
  iterations: 4,
};

// setup: テスト全体で 1 回。戻り値は default / teardown に渡る
export function setup() {
  const res = http.get(`${BASE}/api/products?limit=10`);
  const count = res.status === 200 ? res.json('items').length : -1;
  console.log(`[setup] fetched ${count} products at ${startedAt}`);
  return { count, startedAt };
}

// default: VU ごとに繰り返し実行される（負荷の本体）
export default function (data) {
  const id = exec.vu.idInTest;              // テスト全体で一意な VU ID
  const iter = exec.vu.iterationInScenario; // シナリオ内の反復番号

  const res = http.get(`${BASE}/api/products?limit=10`);
  check(res, {
    'status is 200': (r) => r.status === 200,
    'setup data is available': () => data.count > 0,
  });

  console.log(`[default] vu=${id} iter=${iter} count=${data.count}`);

  // 実ユーザーの思考時間
  sleep(0.5);
}

// teardown: テスト全体で 1 回。後始末や集計に使う
export function teardown(data) {
  console.log(`[teardown] test started at ${data.startedAt}`);
}
