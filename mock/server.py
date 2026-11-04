#!/usr/bin/env python3
"""k6 実務ガイド用のモック API（Python 標準ライブラリのみ）。

本番 API の代わりに、一覧・詳細・作成・認証・Cookie セッション・
エラー注入・遅延注入を提供する。外部依存なしで動く。

    python3 mock/server.py          # http://localhost:8080
    PORT=9090 python3 mock/server.py

エンドポイント一覧は mock/README.md を参照。
"""

import json
import os
import random
import secrets
import threading
import time
from http.cookies import CookieError, SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "8080"))
QUIET = os.environ.get("QUIET", "0") == "1"

_lock = threading.Lock()
_tokens = {}  # token -> 有効期限（epoch 秒）
_counters = {"order": 1000, "product": 100, "request": 0}

PRODUCTS = [
    {
        "id": i,
        "name": f"Product {i}",
        "price": round(10 + i * 1.5, 2),
        "category": ["books", "games", "tools"][i % 3],
        "stock": 1000 - i,
    }
    for i in range(1, 101)
]


def next_id(kind: str) -> int:
    with _lock:
        _counters[kind] += 1
        return _counters[kind]


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    # --- helpers -------------------------------------------------
    def _json(self, status: int, payload, headers=None):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return None
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return None

    def _bearer_ok(self):
        auth = self.headers.get("Authorization", "")
        if not auth.startswith("Bearer "):
            return False
        token = auth[len("Bearer "):].strip()
        with _lock:
            expiry = _tokens.get(token)
            if expiry is None:
                return False
            if expiry <= time.time():
                _tokens.pop(token, None)
                return False
        return True

    def _cookie_ok(self):
        jar = SimpleCookie()
        try:
            jar.load(self.headers.get("Cookie", ""))
        except CookieError:
            return False
        morsel = jar.get("session")
        return bool(morsel and morsel.value == "demo-session")

    def log_message(self, fmt, *args):  # noqa: A003
        if not QUIET:
            with _lock:
                _counters["request"] += 1
            print(f"[mock] {self.command} {self.path} -> {args[1] if len(args) > 1 else ''}")

    # --- routing -------------------------------------------------
    def do_GET(self):  # noqa: N802
        url = urlparse(self.path)
        path = url.path.rstrip("/") or "/"
        query = parse_qs(url.query)

        if path == "/health":
            return self._json(200, {"status": "ok"})

        if path == "/api/products":
            try:
                limit = int(query.get("limit", ["20"])[0])
            except (TypeError, ValueError):
                return self._json(400, {"error": "limit must be an integer"})
            limit = max(1, min(limit, 100))
            items = PRODUCTS[:limit]
            return self._json(200, {"items": items, "total": len(PRODUCTS), "limit": limit})

        if path.startswith("/api/products/"):
            raw = path.split("/")[-1]
            if not raw.isdigit():
                return self._json(400, {"error": "invalid id"})
            pid = int(raw)
            for item in PRODUCTS:
                if item["id"] == pid:
                    return self._json(200, item)
            return self._json(404, {"error": "product not found", "id": pid})

        if path == "/api/me":
            if not self._bearer_ok():
                return self._json(401, {"error": "unauthorized"})
            return self._json(200, {"username": "demo", "plan": "pro"})

        if path == "/api/session/me":
            if not self._cookie_ok():
                return self._json(401, {"error": "unauthorized"})
            return self._json(200, {"username": "demo", "session": "cookie"})

        if path == "/api/slow":
            try:
                ms = int(query.get("ms", ["200"])[0])
            except (TypeError, ValueError):
                return self._json(400, {"error": "ms must be an integer"})
            ms = max(0, min(ms, 5000))
            time.sleep(ms / 1000)
            return self._json(200, {"slept_ms": ms})

        if path == "/api/error":
            try:
                status = int(query.get("status", ["500"])[0])
            except (TypeError, ValueError):
                return self._json(400, {"error": "status must be an integer"})
            if status < 400 or status > 599:
                status = 500
            return self._json(status, {"error": f"injected {status}"})

        if path == "/api/flaky":
            try:
                rate = float(query.get("fail_rate", ["0.1"])[0])
            except (TypeError, ValueError):
                return self._json(400, {"error": "fail_rate must be a number"})
            rate = max(0.0, min(rate, 1.0))
            if random.random() < rate:
                return self._json(503, {"error": "injected random failure"})
            return self._json(200, {"ok": True})

        return self._json(404, {"error": "not found", "path": path})

    def do_POST(self):  # noqa: N802
        path = (urlparse(self.path).path.rstrip("/") or "/")
        body = self._read_json()

        if path == "/api/auth/login":
            if not isinstance(body, dict):
                return self._json(400, {"error": "json body required"})
            if body.get("username") == "demo" and body.get("password") == "demo":
                token = f"lt-{secrets.token_hex(8)}"
                now = time.time()
                with _lock:
                    # 期限切れを掃除してから登録（長時間試験での増加を防ぐ）
                    for old, exp in list(_tokens.items()):
                        if exp <= now:
                            _tokens.pop(old, None)
                    _tokens[token] = now + 3600
                return self._json(
                    200,
                    {"access_token": token, "token_type": "Bearer", "expires_in": 3600},
                )
            return self._json(401, {"error": "invalid credentials"})

        if path == "/api/session/login":
            if isinstance(body, dict) and body.get("username") == "demo" and body.get("password") == "demo":
                return self._json(
                    200,
                    {"ok": True},
                    headers={"Set-Cookie": "session=demo-session; Path=/; HttpOnly"},
                )
            return self._json(401, {"error": "invalid credentials"})

        if path == "/api/echo":
            return self._json(
                200,
                {
                    "json": body,
                    "method": "POST",
                    "path": "/api/echo",
                },
            )

        if path == "/api/products":
            if not self._bearer_ok():
                return self._json(401, {"error": "unauthorized"})
            if not isinstance(body, dict) or not body.get("name"):
                return self._json(400, {"error": "name is required"})
            item = {
                "id": next_id("product"),
                "name": body["name"],
                "price": body.get("price", 0),
                "category": body.get("category", "misc"),
                "stock": body.get("stock", 0),
            }
            return self._json(201, item)

        if path == "/api/orders":
            if not isinstance(body, dict):
                return self._json(400, {"error": "json body required"})
            return self._json(
                201,
                {
                    "order_id": f"ord-{next_id('order')}",
                    "status": "accepted",
                    "item": body.get("item"),
                },
            )

        return self._json(404, {"error": "not found", "path": path})

    def do_DELETE(self):  # noqa: N802
        path = (urlparse(self.path).path.rstrip("/") or "/")
        if path == "/api/session":
            return self._json(
                200,
                {"ok": True},
                headers={"Set-Cookie": "session=; Path=/; Max-Age=0"},
            )
        return self._json(404, {"error": "not found", "path": path})


def main():
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"[mock] listening on http://{HOST}:{PORT}")
    print("[mock] login: demo / demo")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[mock] shutting down")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
