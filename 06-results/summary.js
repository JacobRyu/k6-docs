import http from 'k6/http';
import { check, sleep } from 'k6';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.2/index.js';

const BASE = __ENV.BASE_URL || 'http://localhost:8080';
const RUN_ID = __ENV.RUN_ID || 'local';

export const options = {
  vus: 3,
  duration: '20s',
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<800'],
    checks: ['rate>0.99'],
  },
};

export default function () {
  const res = http.get(`${BASE}/api/products?limit=10`, {
    tags: { api: 'list', testid: RUN_ID },
  });
  check(res, { 'status is 200': (r) => r.status === 200 });
  sleep(1);
}

// テスト終了時に 1 回だけ呼ばれる
export function handleSummary(data) {
  return {
    // これを返さないと画面に何も出なくなる
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
    // 集計値（比較・保管用）
    'reports/summary.json': JSON.stringify(data, null, 2),
    // CI のテストレポート用
    'reports/junit.xml': toJUnit(data),
  };
}

/**
 * k6 の集計結果を JUnit XML に変換する。
 * しきい値ごとに 1 testcase とし、違反を failure にする。
 */
function toJUnit(data) {
  const cases = [];

  for (const [metricName, metric] of Object.entries(data.metrics)) {
    const thresholds = metric.thresholds || {};
    for (const [expression, result] of Object.entries(thresholds)) {
      const name = `${metricName} ${expression}`;
      const failure = result.ok
        ? ''
        : `<failure message="${escapeXml(expression)} failed">${escapeXml(
            JSON.stringify(metric.values),
          )}</failure>`;
      cases.push(
        `    <testcase classname="k6.thresholds" name="${escapeXml(name)}">${failure}</testcase>`,
      );
    }
  }

  const failures = cases.filter((c) => c.includes('<failure')).length;
  const durationSec = (data.state.testRunDurationMs / 1000).toFixed(3);

  return `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="k6" tests="${cases.length}" failures="${failures}" time="${durationSec}">
  <testsuite name="k6.thresholds" tests="${cases.length}" failures="${failures}" time="${durationSec}">
${cases.join('\n')}
  </testsuite>
</testsuites>
`;
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
