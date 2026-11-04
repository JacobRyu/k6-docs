import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE = __ENV.BASE_URL || 'http://localhost:8080';

// 同梱モックの既定アカウント。実環境では必ず -e で上書きする。
const USERNAME = __ENV.USERNAME || 'demo';
const PASSWORD = __ENV.PASSWORD || 'demo';

export const options = {
  vus: 5,
  duration: '30s',
  thresholds: {
    checks: ['rate>0.99'],
    'http_req_duration{api:login}': ['p(95)<1500'],
    'http_req_duration{api:me}': ['p(95)<800'],
  },
};

// モジュールスコープ = VU ごとに独立。VU ごとにトークンをキャッシュする。
let token = null;

function login() {
  const res = http.post(
    `${BASE}/api/auth/login`,
    JSON.stringify({ username: USERNAME, password: PASSWORD }),
    {
      headers: { 'Content-Type': 'application/json' },
      tags: { name: 'POST /api/auth/login', api: 'login' },
    },
  );

  const ok = check(res, {
    'login: status is 200': (r) => r.status === 200,
    'login: access token exists': (r) => !!r.json('access_token'),
  });

  return ok ? res.json('access_token') : null;
}

export default function () {
  // 初回のみログイン。以降はこの VU のトークンを使い回す。
  if (!token) {
    token = login();
    if (!token) {
      sleep(1);
      return;
    }
  }

  let res = http.get(`${BASE}/api/me`, {
    headers: { Authorization: `Bearer ${token}` },
    tags: { name: 'GET /api/me', api: 'me' },
  });

  // トークン失効時は再ログインして 1 度だけやり直す
  if (res.status === 401) {
    token = login();
    if (token) {
      res = http.get(`${BASE}/api/me`, {
        headers: { Authorization: `Bearer ${token}` },
        tags: { name: 'GET /api/me', api: 'me' },
      });
    }
  }

  check(res, {
    'me: status is 200': (r) => r.status === 200,
    'me: username is returned': (r) => typeof r.json('username') === 'string',
    'me: no network error': (r) => !r.error,
  });

  sleep(1);
}
