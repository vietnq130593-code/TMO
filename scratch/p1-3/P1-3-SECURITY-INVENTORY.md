# P1-3 — KIỂM KÊ BẢO MẬT CHỈ ĐỌC (redacted, machine-verifiable)

- **Scope:** `/home/z/tmo-app` (Next.js 16 + PM2 + Caddy)
- **Ngày chạy:** 2026-10-08T17:07Z
- **Bản chất:** READ-ONLY. Không sửa package.json/bun.lock/next.config/proxy/cookie/.env. Không cài dependency, không restart PM2, không ghi DB.
- **Redaction:** KHÔNG in giá trị secret. Chỉ tên biến + độ dài + sha256[:12] (mẫu riêng: `scratch/p1-3/secret-inventory.tsv`, đã verify LEAK_MATCHES=0).

## 0. MÁY ĐO (exit code / metadata)

| Phép đo | Lệnh | exit | Metadata |
|---|---|---|---|
| bun audit | `bun audit` | **1** | 1 vulnerability (1 high), braces@3.0.3, bytes=455, lines=11 |
| Secret scan .env | python redact scan | 0 | TOTAL_KEYS=140 EMPTY=4 PLACEHOLDER=42 SENSITIVE=27 |
| Secret scan .env.example | python redact scan | 0 | TOTAL_KEYS=136 EMPTY=12 PLACEHOLDER=64 SENSITIVE=31 |
| API route inventory | find route.ts | 0 | TOTAL_API_ROUTES=202, PROTECTED_BY_PROXY=40, UNPROTECTED=162 |
| Security headers static | rg headers | 0 | next.config.ts=0, Caddyfile=0, ecosystem.config.cjs=0, scripts/pm2-start.sh=0, src/=0 |
| Runtime headers HTTP | `curl -D - http://127.0.0.1:3000/` | 0 | HTTP/1.1 200 OK, KHÔNG có CSP/XFO/HSTS/nosniff/referrer-policy; có `X-Powered-By: Next.js` |
| Hardcoded secret literal | rg + redact | 0 | HITS_REAL=0 (chỉ 1 placeholder: `src/lib/tmo-token.ts:37`) |
| Git tracking .env | `git ls-files` | 0 | tracked hiện tại = `.env.example` (1 file); `.env` untracked |
| Git history .env | `git log -- .env` | 0 | **3 commit chứa .env**: 0802a25, 9ee1e7e, afe99b8 |
| Env diff .env vs .env.example | so sánh sha12 | 0 | KEYS_IN_BOTH=129, IDENTICAL_VALUES=95, IDENTICAL_SENSITIVE=3 |

## 1. FINDINGS

### F1 — HIGH — Không có bất kỳ security header nào (CSP / XFO / HSTS / nosniff / referrer-policy)
- **Bằng chứng:** `next.config.ts` (44 dòng, không có khối `headers()`); `Caddyfile:1-23` (chỉ `reverse_proxy`, không `header` directive); `grep` static = 0 match trên `next.config.ts|Caddyfile|ecosystem.config.cjs|scripts/pm2-start.sh|src/`.
- **Runtime receipt:** `curl -D -` trả `HTTP/1.1 200 OK` chỉ kèm `Cache-Control`, `X-Powered-By: Next.js`.
- **Tác động:** không có CSP → XSS không bị chặn; không có `X-Frame-Options`/`frame-ancestors` → app nhúng được cross-origin (clickjacking qua iframe trên domain khác); không có HSTS/nosniff.
- **Remediation (chưa áp dụng — ngoài phạm vi P1-3):** thêm `headers()` trong `next.config.ts` hoặc directive `header` trong `Caddyfile`.

### F2 — HIGH — 162/202 API route KHÔNG được proxy bảo vệ
- **Bằng chứng:** `src/proxy.ts:69-71` matcher chỉ `['/api/opencode/:path*','/api/workspace/:path*']`; `src/proxy.ts:21-22` `PROTECTED_PREFIXES` / `PUBLIC_PATHS = ['/api/health','/api/auth']`.
- **Đếm máy:** TOTAL_API_ROUTES=202, PROTECTED=40, UNPROTECTED=162.
- **Nhóm không được bảo vệ (top):** `openclaw` 39, `opencode` 39 (ngoài matcher? — 39 là tổng nhóm, chỉ phần khớp matcher mới được chặn), `research` 15, `tools` 11, `storage` 9, `code-team` 8, `opus` 7, `memory` 6, `self-direction` 5, `ingestion` 5.
- **Route nhạy cảm nằm ngoài bảo vệ:** `src/app/api/tools/execute/route.ts` (shell/exec), `src/app/api/storage/restore-neo4j/route.ts`, `src/app/api/agents/model-config/route.ts`.
- **Tác động:** endpoint shell/exec + restore DB + đọc/sửa config không cần token → nếu app lộ ra ngoài loopback là RCE không cần xác thực.

### F3 — HIGH — Token API chấp nhận qua query string `?token=` (rò vào access log / Referer)
- **Bằng chứng:** `src/proxy.ts:36-41` — comment tự thừa nhận "token xuất hiện trong access log"; `req.nextUrl.searchParams.get('token')` là nguồn token cuối cùng.
- **Tác động:** token nằm trong log proxy/PM2/dev.log, browser history, `Referer` khi điều hướng ra ngoài.
- **Ghi chú:** `/api/auth/setup` có mitigation rate-limit 60/phút/IP (`src/app/api/auth/setup/route.ts:33,73,76-77`) + audit-log (`:97-99`).

### F4 — HIGH — Cookie `Secure` bị tắt trong môi trường chạy thật
- **Bằng chứng:** `src/app/api/auth/setup/route.ts:109-115` → `secure: process.env.NODE_ENV === 'production'`; `ecosystem.config.cjs:49` → `NODE_ENV: 'development'`.
- **Hệ quả:** dù đang chạy qua Caddy reverse proxy, cookie `tmo_api_token` được set **không có cờ Secure** → rủi ro gửi plaintext qua HTTP nếu endpoint HTTP còn mở (Caddy `:81` không có `tls` → cleartext).
- **Cookie flags đo được:** `httpOnly: true` (đạt), `sameSite: 'lax'`, `path: '/'`, `maxAge: 30d`.

### F5 — MEDIUM — Caddy reverse proxy không có security header + `XTransformPort` là open-proxy nội bộ
- **Bằng chứng:** `Caddyfile:2-13` — matcher `query XTransformPort=*` → `reverse_proxy localhost:{query.XTransformPort}` do người gọi kiểm soát.
- **Tác động:** bất kỳ client nào cũng có thể yêu cầu proxy tới **port bất kỳ trên localhost** (vd 18791 gateway-bridge, 6333 Qdrant REST, 5432/7687 nếu có). Không có allowlist port.
- **Ghi chú:** `Caddyfile:8-11` set `X-Forwarded-For/Proto/Real-IP` từ `{remote_host}` — đúng, nhưng app đọc `x-forwarded-for` **không có danh sách trusted proxy** (`src/app/api/auth/setup/route.ts:42-45`, `src/app/api/openclaw/bridge/route.ts:33-34`) → IP lấy từ header **client gửi được tùy ý**, làm yếu rate-limit theo IP.

### F6 — MEDIUM — `next.config.ts` có `ignoreBuildErrors: true` + `allowedDevOrigins` mở rộng
- **Bằng chứng:** `next.config.ts:4-6` (`typescript.ignoreBuildErrors: true` → lỗi TS không chặn build/production), `next.config.ts:22` (`allowedDevOrigins: ["127.0.0.1","*.space-z.ai"]`), `next.config.ts:38-40` (`proxyClientMaxBodySize: '100mb'` → tăng bề mặt DoS).
- **Tác động:** `ignoreBuildErrors` che lỗi type ở prod; `*.space-z.ai` là wildcard domain cho dev-origin.

### F7 — MEDIUM — 15 route chẩn đoán/debug, một số công khai
- **Bằng chứng:** 15 route (`TOTAL_DIAGNOSTIC_ROUTES=15`), gồm `src/app/api/health/route.ts`, `src/app/api/health-check/route.ts`, `src/app/api/metrics/overview/route.ts`, `src/app/api/openclaw/status/route.ts`, `src/app/api/opencode/status/route.ts`, `src/app/api/opus/status/route.ts`, `src/app/api/code-team/status/route.ts`, `src/app/api/openclaw/channels/config/route.ts`, `src/app/api/research/health/route.ts`, `src/app/api/storage/collections-health/route.ts`, `src/app/api/agents/model-config/route.ts`, `src/app/api/opencode/git/status/route.ts`, `src/app/api/opencode/lsp/diagnostics/route.ts`, `src/app/api/opencode/mcp/status/route.ts`, `src/app/api/openclaw/learning/layer9-metrics/route.ts`.
- **Tác động:** `/api/health` nằm trong `PUBLIC_PATHS` (`src/proxy.ts:22`) → không cần token; trả metadata hệ thống (số key đang có/available/rate-limited — `src/app/api/health/route.ts:55` chỉ trả **số lượng**, không trả giá trị key → không rò bí mật).
- **Ghi nhận tích cực:** `.env` KHÔNG có biến `*DEBUG*` bật (`DEBUG_VARS=0`).

### F8 — MEDIUM — `.env` tồn tại trong git history (3 commit)
- **Bằng chứng:** `git log -- .env` → `0802a25`, `9ee1e7e`, `afe99b8`. Hiện tại `.env` untracked + `.gitignore:198` chặn đúng.
- **Tác động:** nếu 27 sensitive key từng commit có giá trị thật → lộ qua history/push/fork. Chưa đo được giá trị trong commit (không đọc blob — ngoài phạm vi redaction).

### F9 — LOW — Quyền file `.env` là 664 (group/other đọc được)
- **Bằng chứng:** `.env mode=664 owner=z:z size=42583`; ngược lại `.tmo-api-token mode=600` (đúng).
- **Khuyến nghị:** `chmod 600 .env`.

### F10 — LOW — `bun audit`: 1 HIGH nhưng chỉ nằm trong chuỗi dev/lint
- **Bằng chứng:** `bun audit` exit=1; `braces@3.0.3` qua `eslint-config-next > @next/eslint-plugin-next > fast-glob > micromatch > braces`; advisory GHSA-vfj7-8cjw-p6xm (stack-exhaustion DoS qua nested pattern).
- **Đánh giá:** chuỗi phụ thuộc lint, không nằm trong runtime Next server. **Không đề xuất nâng dependency** (ngoài phạm vi P1-3 theo lệnh parent).

### F11 — INFO — Điểm tốt đã kiểm chứng (KHÔNG cần sửa)
- Không có secret literal thật hardcode trong mã: `HITS_REAL=0`. Chỉ 1 placeholder tại `src/lib/tmo-token.ts:37` (`change-me-to-a-random-token`).
- Token auto-provision dùng CSPRNG: `src/lib/tmo-token.ts:107` `randomBytes(24).toString('hex')`, ghi file exclusive, cache module-level.
- Cookie có `httpOnly: true` và `SameSite=Lax`.
- `.env.example` không chứa giá trị SET khác `.env`: 95 giá trị trùng đều là config không nhạy cảm; 3 key "nhạy cảm" trùng thực chất là số nguyên không bí mật (`GOAL_LOOP_TOKEN_BUDGET`, `SUBAGENT_TOKEN_BUDGET`, `LLM_TIMEOUT_MS_PER_TOKEN`).
- `.env` + `.tmo-api-token` đã bị `.gitignore` chặn (`:198`, `:218`).
- Không có biến `NEXT_PUBLIC_*` mang bí mật: chỉ 1 tên duy nhất `NEXT_PUBLIC_BASE_URL` (4 occurrence) — URL công khai, không phải secret.
- Không có biến môi trường nhạy cảm khai báo trong `next.config.ts` / `Caddyfile` / `ecosystem.config.cjs` (0 match); `ecosystem.config.cjs:55` chỉ khai `DATABASE_URL` dạng đường dẫn file SQLite (không chứa mật khẩu).

## 2. PHÂN LOẠI THEO SEVERITY

| Severity | Số | ID |
|---|---|---|
| HIGH | 4 | F1, F2, F3, F4 |
| MEDIUM | 4 | F5, F6, F7, F8 |
| LOW | 2 | F9, F10 |
| INFO (đạt/không cần sửa) | 7 điểm | F11 |

## 3. GIỚI HẠN PHẠM VI ĐÃ TUÂN THỦ

- Không sửa bất kỳ file cấu hình nào. `git status` không có thay đổi do run này (artifact mới nằm trong `scratch/`).
- Không in giá trị secret: mọi phát hiện `.env` chỉ có `tên + độ dài + sha256[:12]`.
- Không đọc blob `.env` trong git history (F8 ghi nhận sự tồn tại của commit, không đọc nội dung).
- Không `bun audit fix`, không `manage_packages`, không restart PM2, không ghi DB.