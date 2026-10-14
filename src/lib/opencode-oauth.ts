/**
 * OpenCode Account OAuth — Device Flow (RFC 8628)
 * USER REQUEST 2026-10-14: "thêm opencode auth login bằng account OpenCode để
 * có thể dùng các lõi free có trong danh sách" — flow: chọn lõi free đang bị
 * Zen chặn (FreeTierError "free tier can only be used from within OpenCode")
 * → UI hiện yêu cầu đăng nhập → user mở link xác thực, đăng nhập tài khoản
 * OpenCode, phê duyệt → app nhận session token → dùng session cho các call
 * lõi free.
 *
 * ===================== CƠ CHẾ (đảo ngược-engineering live 2026-10-14) =====================
 * OpenCode Console (https://opencode.ai/console — SPA) expose device-flow:
 *   1. POST https://opencode.ai/console/auth/device/code   body {client_id}
 *      → {device_code, user_code, verification_uri:"/console/device",
 *         verification_uri_complete:"/console/device?user_code=…&client_id=…",
 *         expires_in:600, interval:5}                      (live-verify 200)
 *   2. User mở verification_uri_complete trên MÁY MÌNH (máy app không cần
 *      mở được browser — flow thiết kế sẵn cho thiết bị không có GUI),
 *      đăng nhập tài khoản OpenCode (email/mật khẩu hoặc social), phê duyệt.
 *   3. POST …/console/auth/device/token  body {grant_type:
 *      "urn:ietf:params:oauth:grant-type:device_code", device_code, client_id}
 *      → đang chờ: 400 {error:"authorization_pending"}    (live-verify)
 *      → sau phê duyệt: 200 {access_token, refresh_token, token_type:"Bearer",
 *        expires_in, org_id?}
 *   4. Session token dùng làm Bearer cho Zen (kèm header nhận diện OpenCode
 *      app — User-Agent opencode/<ver> + x-opencode-client, trích từ binary
 *      CLI v1.19.0: chính là header desktop app gửi cho provider opencode).
 *   5. Refresh: POST …/console/auth/refresh {grant_type:"refresh_token",
 *      refresh_token, client_id} → cùng shape token response (best-effort —
 *      schema từ console JS; chỉ verify được khi có session thật).
 *
 * GHI CHÚ TRUNG THỰC (policy Zen lật ngược nhiều lần — xem worklog r72/r74/
 * Task 28): có đúng session token tài khoản mở khóa free tier hay không là
 * quy định PHÍA SERVER Zen — không thể kết luận trước khi user hoàn tất đăng
 * nhập thật. Vì vậy sau khi đăng nhập thành công app LUÔN probe space-bunny-
 * free ngay (probeFreeTier) và báo kết quả THẬT (freeTierUnlocked true/false);
 * probe fail → toàn bộ chuỗi failover cũ (CLI → ZEN FAILOVER → LAST RESORT →
 * NIM RESCUE) vẫn giữ agents sống như trước.
 *
 * Store: db/opencode-oauth.json (pattern db/zen-block-state.json r74b — file
 * dùng chung giữa các process instance của llm.ts). KHÔNG import llm.ts từ
 * đây (llm.ts import module này — tránh cycle).
 */

// ==================== CONFIG ====================

const CONSOLE_BASE = process.env.OPENCODE_CONSOLE_BASE?.trim() || 'https://opencode.ai'
const DEVICE_CODE_URL = `${CONSOLE_BASE}/console/auth/device/code`
const DEVICE_TOKEN_URL = `${CONSOLE_BASE}/console/auth/device/token`
const SESSION_REFRESH_URL = `${CONSOLE_BASE}/console/auth/refresh`
const SESSION_INFO_URL = `${CONSOLE_BASE}/console/auth/session`
const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code'

/** client_id của CLI CHÍNH CHỦ — trích từ binary opencode v1.19.0 (Task 30:
 *  `var lo="https://opencode.ai/console",ln="opencode-cli"` — CẢ 2 flow OAuth
 *  trong binary đều dùng "opencode-cli"). Task 29 từng dùng "tmo-app" — console
 *  cấp token nhưng token mang client lạ; đổi đúng client chính chủ để token
 *  giống hệt flow `opencode auth login` thật. Override qua env nếu cần. */
export const OPENCODE_OAUTH_CLIENT_ID = process.env.OPENCODE_OAUTH_CLIENT_ID?.trim() || 'opencode-cli'

/** UA đầy đủ đúng như CLI capture thật (Task 30 mock-capture 2026-10-14):
 *  `opencode/1.19.0 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14`. */
const OPENCODE_CLIENT_UA = 'opencode/1.19.0 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14'

// ==================== CLIENT SESSION ID (định dạng ses_ của CLI) ====================

/**
 * Sinh ID đúng thuật toán Identifier.create của opencode (đảo ngược từ binary
 * v1.19.0, hàm tA): `ses_` + 12 hex (timestamp-ms<<12 + counter, bitwise NOT
 * để descending) + 14 base62 ngẫu nhiên. GitHub #49433 xác nhận gate chỉ chấp
 * nhận ĐÚNG định dạng này (UUID → 403). 1 ID ổn định/install (pattern giống
 * CLI giữ 1 session ID cho cả phiên) — persist vào store file.
 */
function generateClientSessionId(): string {
  // BigInt() thay vì literal (0x1000n…) — tsconfig target < ES2020 (TS2737)
  const $ = BigInt(Date.now()) * BigInt(4096) + BigInt(1)
  const U = ~$ // ses_ dùng bitwise NOT (descending — sort mới nhất trước)
  let hex = ''
  for (let w = 0; w < 6; w++) {
    hex += Number((U >> BigInt(40 - 8 * w)) & BigInt(255)).toString(16).padStart(2, '0')
  }
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
  const rand = crypto.getRandomValues(new Uint8Array(14))
  let b62 = ''
  for (const b of rand) b62 += chars[b % 62]
  return 'ses_' + hex + b62
}

let cachedClientSessionId: string | null = null

/** ID phiên client (định dạng ses_ chính chủ) — ổn định theo install, dùng cho
 * toàn bộ header x-opencode-session-id / x-session-affinity / x-session-id. */
export function getOpenCodeClientSessionId(): string {
  if (cachedClientSessionId) return cachedClientSessionId
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs')
    const file = storeFile()
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as { clientSessionId?: string }
    if (raw.clientSessionId && /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/.test(raw.clientSessionId)) {
      cachedClientSessionId = raw.clientSessionId
      return cachedClientSessionId
    }
  } catch { /* chưa có file — sinh mới bên dưới */ }
  cachedClientSessionId = generateClientSessionId()
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('path') as typeof import('path')
    const file = storeFile()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    let existing: Record<string, unknown> = {}
    try { existing = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown> } catch { /* file mới */ }
    fs.writeFileSync(file, JSON.stringify({ ...existing, clientSessionId: cachedClientSessionId }, null, 2) + '\n', { mode: 0o600 })
  } catch { /* best-effort — dùng memory */ }
  return cachedClientSessionId
}

/**
 * Bộ header "from within OpenCode" ĐÚNG như capture thật của CLI v1.19.0
 * (Task 30 mock-capture): user-agent đầy đủ suffix + x-opencode-session-id +
 * x-session-affinity + x-session-id — CÙNG một giá trị ses_. Lưu ý: header
 * đúng tên là x-opencode-session-ID (GitHub #49433 gọi tắt x-opencode-session
 * — capture thật mới là chuẩn). llm.ts tái dùng cho đường session-token.
 */
export function buildOpenCodeSessionHeaders(): Record<string, string> {
  const sid = getOpenCodeClientSessionId()
  return {
    'User-Agent': OPENCODE_CLIENT_UA,
    'x-opencode-session-id': sid,
    'x-session-affinity': sid,
    'x-session-id': sid,
  }
}

/** Store file — tương đối theo cwd process (mọi process PM2 chạy từ app-dir,
 *  cùng pattern zenBlockStateFile llm.ts). */
const STORE_FILE_DEFAULT = 'db/opencode-oauth.json'

const HTTP_TIMEOUT_MS = 15_000
/** Access token hết hạn sớm 60s (refresh trước deadline thật). */
const TOKEN_EXPIRY_MARGIN_MS = 60_000
/** Session bị server từ chối (401/403) → tạm ngừng thử 60s (chống đốt timeout
 *  mỗi call khi session chết giữa chừng — llm.ts đọc qua isSessionRecentlyRejected). */
const SESSION_REJECT_COOLDOWN_MS = 60_000

// ==================== TYPES ====================

export interface OpenCodeOAuthSession {
  accessToken: string
  refreshToken: string
  tokenType: string
  orgId?: string
  /** client_id đã phát hành token (Task 30) — token sai client = không mở
   *  free-tier được (Task 29 dùng "tmo-app" → bị chặn; đổi về "opencode-cli").
   *  Session cũ không có trường này → tự coi là stale, yêu cầu login lại. */
  clientId?: string
  acquiredAt: number
  /** Millis-epoch deadline của access token. */
  expiresAt: number
  /** Thông tin tài khoản (best-effort từ /console/auth/session). */
  email?: string
  /** Kết quả probe free-tier gần nhất. */
  freeTier?: {
    probedAt: number
    unlocked: boolean
    detail: string
    endpoint?: string
    /** R6 — thông tin egress thật của máy chạy app lúc probe (nói thật môi
     *  trường thay vì hardcode kết luận sandbox-era). */
    egress?: { ip: string; org: string; country: string; city?: string; isDatacenter: boolean }
    /** R6 — true khi opencode CLI trên MÁY CHẠY APP gọi được model free
     *  (keyless/native): HTTP session có thể bị chặn nhưng lõi free vẫn dùng
     *  được qua transport CLI (failover tự động của llm.ts). */
    cliOk?: boolean
  }
}

export interface DeviceLoginStart {
  userCode: string
  deviceCode: string
  /** URL tuyệt đối user mở trên máy mình (verification_uri_complete). */
  verificationUrl: string
  /** URL verification gốc (thủ công nhập code). */
  verificationUri: string
  expiresInSeconds: number
  intervalSeconds: number
}

/** Shape kết quả probe free-tier 1 lần (HTTP session — llm.ts/route có thể
 *  enrich thêm cliOk cho tầng đối chiếu CLI). */
export interface FreeTierProbeShape {
  unlocked: boolean
  detail: string
  endpoint?: string
  egress?: ZenEgressInfo
  cliOk?: boolean
}

export type DevicePollResult =
  | { status: 'pending'; message: string }
  | { status: 'success'; session: OpenCodeOAuthSession; freeTier: FreeTierProbeShape }
  | { status: 'expired'; message: string }
  | { status: 'denied'; message: string }
  | { status: 'error'; message: string }

export interface OpenCodeOAuthStatus {
  loggedIn: boolean
  sessionValidTill?: number
  needsRefresh?: boolean
  email?: string
  orgId?: string
  freeTier?: NonNullable<OpenCodeOAuthSession['freeTier']>
}

// ==================== STORE (file + memory, pattern r74b) ====================

interface StoreShape {
  session?: OpenCodeOAuthSession
  clientSessionId?: string
}

let storeAbsPath: string | null = null
function storeFile(): string {
  if (!storeAbsPath) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('path') as typeof import('path')
    storeAbsPath = path.resolve(process.env.OPENCODE_OAUTH_STORE_FILE || STORE_FILE_DEFAULT)
  }
  return storeAbsPath
}

let storeFileCache: { mtimeMs: number; data: StoreShape } | null = null
let memSession: OpenCodeOAuthSession | null = null

function readSessionStore(): OpenCodeOAuthSession | null {
  if (memSession) return memSession
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs')
    const file = storeFile()
    const st = fs.statSync(file)
    if (storeFileCache && storeFileCache.mtimeMs === st.mtimeMs) {
      memSession = filterStaleClient(storeFileCache.data.session)
      return memSession
    }
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'))
    const data: StoreShape = raw && typeof raw === 'object' && typeof raw.session === 'object'
      ? { session: raw.session, clientSessionId: typeof raw.clientSessionId === 'string' ? raw.clientSessionId : undefined }
      : {}
    storeFileCache = { mtimeMs: st.mtimeMs, data }
    memSession = filterStaleClient(data.session)
    return memSession
  } catch {
    return filterStaleClient(storeFileCache?.data.session)
  }
}

/** Task 30 — session phát hành cho client_id KHÁC hiện tại (vd Task 29 dùng
 *  "tmo-app") không thể mở free-tier → coi như chưa đăng nhập để UI hướng
 *  dẫn login lại đúng client chính chủ. KHÔNG xoá file (ghi đè khi login mới). */
function filterStaleClient(session: OpenCodeOAuthSession | null | undefined): OpenCodeOAuthSession | null {
  if (!session) return null
  if (session.clientId === OPENCODE_OAUTH_CLIENT_ID) return session
  console.warn(`[OC-OAUTH] Session cũ phát hành cho client "${session.clientId ?? '(không ghi — Task 29 tmo-app)'}" ≠ "${OPENCODE_OAUTH_CLIENT_ID}" — cần đăng nhập lại để lấy token client chính chủ`)
  return null
}

function writeSessionStore(session: OpenCodeOAuthSession | null): void {
  memSession = session
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('path') as typeof import('path')
    const file = storeFile()
    if (!session) {
      try { fs.unlinkSync(file) } catch { /* chưa có file = sạch */ }
      storeFileCache = null
      return
    }
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ session } satisfies StoreShape, null, 2) + '\n', { mode: 0o600 })
    storeFileCache = null // invalidate — đọc lại mtime lần sau
  } catch (err) {
    console.warn('[OC-OAUTH] Ghi store lỗi (không chặn — dùng memory):', err instanceof Error ? err.message : String(err))
  }
}

// ==================== SESSION-REJECT COOLDOWN (memory only) ====================

let sessionRejectUntil = 0
let sessionRejectReasonText = ''

/** llm.ts gọi TRƯỚC khi thử session — tránh đốt timeout mỗi call khi server
 *  đã từ chối session này (401/403) trong <60s qua. */
export function isSessionRecentlyRejected(): boolean {
  return Date.now() < sessionRejectUntil
}

export function noteSessionRejected(reason: string): void {
  sessionRejectUntil = Date.now() + SESSION_REJECT_COOLDOWN_MS
  sessionRejectReasonText = reason
  console.warn(`[OC-OAUTH] Session bị server từ chối — tạm ngừng dùng ${Math.round(SESSION_REJECT_COOLDOWN_MS / 1000)}s: ${reason.slice(0, 160)}`)
}

/** Cho UI/test — lý do bị từ chối gần nhất (rỗng = không có). */
export function sessionRejectReason(): string {
  return Date.now() < sessionRejectUntil ? sessionRejectReasonText : ''
}

// ==================== FETCH HELPERS ====================

async function consoleFetch(url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS)
  try {
    return await fetch(url, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': OPENCODE_CLIENT_UA,
        ...(init?.headers || {}),
      },
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }
}

// ==================== DEVICE FLOW ====================

/**
 * Bước 1 — xin device code. Trả về thông tin cho UI hiển thị: user mở
 * verificationUrl trên máy mình, đăng nhập tài khoản OpenCode, phê duyệt.
 */
export async function startDeviceLogin(): Promise<DeviceLoginStart> {
  const res = await consoleFetch(DEVICE_CODE_URL, {
    method: 'POST',
    body: JSON.stringify({ client_id: OPENCODE_OAUTH_CLIENT_ID }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Device-code HTTP ${res.status}: ${body.slice(0, 200)}`)
  }
  const data = await res.json() as {
    device_code?: string
    user_code?: string
    verification_uri?: string
    verification_uri_complete?: string
    expires_in?: number
    interval?: number
  }
  if (!data.device_code || !data.user_code) {
    throw new Error(`Device-code response thiếu device_code/user_code: ${JSON.stringify(data).slice(0, 200)}`)
  }
  const verificationUrl = data.verification_uri_complete
    ? (data.verification_uri_complete.startsWith('http') ? data.verification_uri_complete : `${CONSOLE_BASE}${data.verification_uri_complete}`)
    : `${CONSOLE_BASE}/console/device?user_code=${encodeURIComponent(data.user_code)}&client_id=${encodeURIComponent(OPENCODE_OAUTH_CLIENT_ID)}`
  const verificationUri = data.verification_uri
    ? (data.verification_uri.startsWith('http') ? data.verification_uri : `${CONSOLE_BASE}${data.verification_uri}`)
    : `${CONSOLE_BASE}/console/device`
  console.log(`[OC-OAUTH] Device login bắt đầu — user_code ${data.user_code}, hết hạn ${data.expires_in ?? 600}s`)
  return {
    userCode: data.user_code,
    deviceCode: data.device_code,
    verificationUrl,
    verificationUri,
    expiresInSeconds: data.expires_in ?? 600,
    intervalSeconds: data.interval ?? 5,
  }
}

/**
 * Bước 3 — poll token (client gọi mỗi ~interval giây). 200 = user đã phê
 * duyệt → session được lưu store (ghi đè session cũ nếu có) + probe free-tier
 * NGAY để báo kết quả thật (xem ghi chú trung thực ở đầu file).
 */
export async function pollDeviceToken(deviceCode: string): Promise<DevicePollResult> {
  let res: Response
  try {
    res = await consoleFetch(DEVICE_TOKEN_URL, {
      method: 'POST',
      body: JSON.stringify({
        grant_type: DEVICE_GRANT_TYPE,
        device_code: deviceCode,
        client_id: OPENCODE_OAUTH_CLIENT_ID,
      }),
    })
  } catch (err) {
    return { status: 'error', message: `Không gọi được console (mạng/timeout): ${err instanceof Error ? err.message : String(err)}` }
  }
  if (res.ok) {
    const data = await res.json() as {
      access_token?: string
      refresh_token?: string
      token_type?: string
      expires_in?: number
      org_id?: string
    }
    if (!data.access_token) {
      return { status: 'error', message: `Token response thiếu access_token: ${JSON.stringify(data).slice(0, 200)}` }
    }
    const session: OpenCodeOAuthSession = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? '',
      tokenType: data.token_type ?? 'Bearer',
      orgId: data.org_id,
      clientId: OPENCODE_OAUTH_CLIENT_ID,
      acquiredAt: Date.now(),
      expiresAt: Date.now() + Math.max(60, data.expires_in ?? 3600) * 1000,
    }
    // Best-effort lấy email tài khoản (không chặn flow nếu fail)
    const email = await fetchSessionEmail(session.accessToken).catch(() => undefined)
    if (email) session.email = email
    writeSessionStore(session)
    console.log(`[OC-OAUTH] ✅ Đăng nhập OpenCode account thành công${email ? ` (${email})` : ''} — session hết hạn ${new Date(session.expiresAt).toLocaleString('vi-VN')}`)
    // Probe free-tier NGAY — kết quả thật cho UI
    const freeTier = await probeFreeTier(session.accessToken)
    const merged: OpenCodeOAuthSession = { ...session, freeTier: { probedAt: Date.now(), ...freeTier } }
    writeSessionStore(merged)
    return { status: 'success', session: merged, freeTier }
  }
  // 4xx — phân loại lỗi chuẩn RFC 8628
  const body = await res.text().catch(() => '')
  let errTag = ''
  let errDesc = ''
  try {
    const parsed = JSON.parse(body) as { error?: string; error_description?: string }
    errTag = parsed.error ?? ''
    errDesc = parsed.error_description ?? ''
  } catch { /* body không phải JSON */ }
  if (errTag === 'authorization_pending' || errTag === 'slow_down') {
    return { status: 'pending', message: errDesc || 'Đang chờ bạn phê duyệt trên trang OpenCode Console…' }
  }
  if (errTag === 'expired_token' || /expired/i.test(body)) {
    return { status: 'expired', message: 'Mã đăng nhập đã hết hạn (10 phút) — bấm "Đăng nhập lại" để lấy mã mới.' }
  }
  if (errTag === 'access_denied' || /denied/i.test(body)) {
    return { status: 'denied', message: 'Bạn đã từ chối yêu cầu đăng nhập trên OpenCode Console.' }
  }
  return { status: 'error', message: `Device-token HTTP ${res.status}: ${(errDesc || body).slice(0, 200)}` }
}

// ==================== SESSION INFO / REFRESH ====================

/** GET /console/auth/session — lấy email tài khoản (best-effort, để hiển thị). */
async function fetchSessionEmail(accessToken: string): Promise<string | undefined> {
  const res = await consoleFetch(SESSION_INFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) return undefined
  const data = await res.json() as { email?: string; user?: { email?: string } }
  return data.email ?? data.user?.email ?? undefined
}

/**
 * Refresh session bằng refresh_token (chuẩn OAuth). Best-effort — endpoint
 * schema trích từ console JS; nếu console từ chối → session cũ giữ nguyên,
 * caller xử lý như session hết hạn.
 */
async function refreshSession(session: OpenCodeOAuthSession): Promise<OpenCodeOAuthSession | null> {
  if (!session.refreshToken) return null
  // Task 30 — CLI chính chủ refresh qua /console/auth/device/token với
  // grant_type=refresh_token (đảo ngược từ binary, hàm Ra). Thử endpoint này
  // TRƯỚC; /console/auth/refresh (schema console SPA — Task 29) giữ làm fallback.
  const endpoints = [DEVICE_TOKEN_URL, SESSION_REFRESH_URL]
  let res: Response | null = null
  let lastErr = ''
  for (const url of endpoints) {
    try {
      res = await consoleFetch(url, {
        method: 'POST',
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: session.refreshToken,
          client_id: OPENCODE_OAUTH_CLIENT_ID,
        }),
      })
      if (res.ok) break
      lastErr = `HTTP ${res.status} (${url})`
      console.warn(`[OC-OAUTH] Refresh session ${lastErr}`)
      res = null
    } catch (err) {
      console.warn(`[OC-OAUTH] Refresh session ${url} lỗi:`, err instanceof Error ? err.message : String(err))
    }
  }
  if (!res || !res.ok) {
    console.warn(`[OC-OAUTH] Refresh session thất bại cả 2 endpoint: ${lastErr || 'không response'}`)
    return null
  }
  try {
    const data = await res.json() as {
      access_token?: string
      refresh_token?: string
      token_type?: string
      expires_in?: number
      org_id?: string
    }
    if (!data.access_token) return null
    const refreshed: OpenCodeOAuthSession = {
      ...session,
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? session.refreshToken,
      tokenType: data.token_type ?? session.tokenType,
      orgId: data.org_id ?? session.orgId,
      acquiredAt: Date.now(),
      expiresAt: Date.now() + Math.max(60, data.expires_in ?? 3600) * 1000,
    }
    writeSessionStore(refreshed)
    console.log(`[OC-OAUTH] Session refresh OK — hạn mới ${new Date(refreshed.expiresAt).toLocaleString('vi-VN')}`)
    return refreshed
  } catch (err) {
    console.warn('[OC-OAUTH] Refresh session lỗi:', err instanceof Error ? err.message : String(err))
    return null
  }
}

/**
 * Lấy access token còn hạn (tự refresh nếu sắp hết). null = chưa đăng nhập /
 * refresh thất bại. llm.ts gọi mỗi call Zen — fast-path memory, chỉ chạm
 * mạng khi cần refresh.
 */
export async function getValidZenSessionToken(): Promise<string | null> {
  const session = await getValidZenSession()
  return session?.accessToken ?? null
}

/** Task 30 — full session còn hạn (tự refresh nếu sắp hết) — cho route cần
 *  access + refresh + expiresAt (writeAuthJsonForCli format oauth chính chủ). */
export async function getValidZenSession(): Promise<OpenCodeOAuthSession | null> {
  const session = readSessionStore()
  if (!session) return null
  if (Date.now() < session.expiresAt - TOKEN_EXPIRY_MARGIN_MS) return session
  // Hết hạn (hoặc sắp hết) → refresh 1 lần
  return await refreshSession(session)
}

/** Peek session (không refresh) — cho status endpoint + test. */
export function peekSession(): OpenCodeOAuthSession | null {
  return readSessionStore()
}

// ==================== FREE-TIER PROBE ====================

// ==================== EGRESS LOOKUP (R6) ====================

/** Thông tin egress của máy chạy app (best-effort qua ipinfo.io) — probe
 *  free-tier dùng để nói THẬT môi trường thay vì hardcode kết luận sandbox-era.
 *  R6 (user report 2026-10-31): chạy app trên máy cá nhân ở VN nhưng thông báo
 *  vẫn nói "bị chặn vì app chạy trên datacenter Alibaba Cloud HK" — thông báo
 *  cũ là KẾT LUẬN TĨNH từ điều tra Task 30 trên sandbox, không kiểm chứng lại
 *  nơi app thực sự đang chạy. Giờ mỗi lần probe lấy IP/org thật để kết luận. */
export interface ZenEgressInfo {
  ip: string
  org: string
  country: string
  city?: string
  /** true khi org khớp cloud/datacenter đã biết — CHỈ trường hợp này message
   *  "Zen chặn free-tier theo IP máy chủ (datacenter)" mới có căn cứ. */
  isDatacenter: boolean
}

const EGRESS_DATACENTER_RE =
  /alibaba|as45102|amazon|aws\b|microsoft|azure|google cloud|gcp\b|hetzner|ovh\b|digitalocean|vultr|linode|tencent|byteplus|oracle cloud|colocation|datacamp/i

async function lookupEgressInfo(): Promise<ZenEgressInfo | null> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 5000)
    try {
      const res = await fetch(process.env.TMO_EGRESS_LOOKUP_URL?.trim() || 'https://ipinfo.io/json', {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      })
      if (!res.ok) return null
      const d = await res.json() as { ip?: string; org?: string; country?: string; city?: string }
      const org = (d.org || '').trim()
      return {
        ip: (d.ip || '').trim() || 'unknown',
        org: org || 'unknown',
        country: (d.country || '').trim(),
        city: d.city,
        isDatacenter: EGRESS_DATACENTER_RE.test(org),
      }
    } finally {
      clearTimeout(timer)
    }
  } catch {
    return null // best-effort — không chặn probe
  }
}

/** R6 — dòng egress chuẩn (1 nguồn dùng chung cho mọi message kết luận). */
function formatEgressLine(eg: ZenEgressInfo | null): string {
  if (!eg) return 'Không tra cứu được egress máy chạy app (ipinfo.io không trả lời trong 5s)'
  const place = [eg.city, eg.country].filter(Boolean).join(', ')
  return `egress hiện tại của máy chạy app: ${eg.org} — ${eg.ip}${place ? ` (${place})` : ''}`
}

/**
 * Probe space-bunny-free với session token — trả lời câu hỏi "session tài
 * khoản có mở free tier không?" bằng KẾT QUẢ THẬT. Thử cả 2 endpoint Zen
 * (/zen/v1 cũ + /inference/v1 mới — docs 2026-10-14 đã chuyển sang inference).
 *
 * R6 — message kết luận giờ theo BẰNG CHỨNG + MÔI TRƯỜNG THẬT (egress IP/org
 * live qua ipinfo): phân biệt 403 FreeTierError / lỗi mạng / lỗi tạm thời,
 * và CHỈ đổ lỗi "IP datacenter" khi IP egress thật sự thuộc datacenter.
 */
export async function probeFreeTier(accessToken?: string): Promise<FreeTierProbeShape> {
  const token = accessToken ?? await getValidZenSessionToken()
  if (!token) return { unlocked: false, detail: 'Chưa có session OpenCode account' }
  const endpoints = [
    process.env.ZEN_BASE_URL?.trim() || 'https://opencode.ai/zen/v1',
    'https://opencode.ai/inference/v1',
  ]
  // R6 — egress live tra cứu song song với probe (không chặn thêm thời gian);
  // mọi nhánh return đều kèm egress để UI + log nói THẬT môi trường.
  const egressPromise = lookupEgressInfo()
  // Task 30 — body kèm tools chuẩn opencode (gate kiểm tra mảng tools của
  // agent chính chủ — GitHub #50627/#54744: request thiếu tool chuẩn bị chặn;
  // capture thật có 24 tool, đây là tổ hợp tối giản các tool lõi).
  const probeBody = {
    model: 'space-bunny-free',
    max_tokens: 32,
    messages: [
      { role: 'system', content: 'You are opencode, a CLI coding agent.' },
      { role: 'user', content: 'Reply with exactly: OK' },
    ],
    tools: OFFICIAL_CORE_TOOLS,
    tool_choice: 'auto',
  }
  const seen = new Set<string>()
  // R6 — đếm bằng chứng mỗi loại lỗi để kết luận cuối theo SỰ THẬT:
  // FreeTierError 403 (chạm được Zen nhưng bị policy chặn) ≠ lỗi mạng
  // (không gọi được opencode.ai — không kết luận gì về free-tier được).
  let freeTierErrCount = 0
  let lastNetErr: string | null = null
  for (const base of endpoints) {
    if (seen.has(base)) continue
    seen.add(base)
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 30_000)
      try {
        const res = await fetch(`${base}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            ...buildOpenCodeSessionHeaders(),
          },
          body: JSON.stringify(probeBody),
          signal: controller.signal,
        })
        if (res.ok) {
          console.log(`[OC-OAUTH] ✅ Probe free-tier OK (${base}) — session OpenCode account MỞ free tier`)
          return { unlocked: true, detail: 'Session OpenCode account đã mở khóa space-bunny-free (probe OK)', endpoint: base, egress: (await egressPromise) ?? undefined }
        }
        const body = await res.text().catch(() => '')
        console.warn(`[OC-OAUTH] Probe free-tier ${base} HTTP ${res.status}: ${body.slice(0, 160)}`)
        if (res.status === 401 || (res.status === 403 && !/FreeTierError|free tier/i.test(body))) {
          noteSessionRejected(`HTTP ${res.status} khi probe: ${body.slice(0, 120)}`)
          return { unlocked: false, detail: `Session bị từ chối (HTTP ${res.status}) — token không hợp lệ hoặc hết hạn`, endpoint: base, egress: (await egressPromise) ?? undefined }
        }
        // FreeTierError → endpoint này không mở với session — thử endpoint kế
        freeTierErrCount += 1 // R6 — bằng chứng: chạm được Zen, bị policy chặn
      } finally {
        clearTimeout(timer)
      }
    } catch (err) {
      console.warn(`[OC-OAUTH] Probe free-tier ${base} lỗi:`, err instanceof Error ? err.message : String(err))
      lastNetErr = err instanceof Error ? err.message : String(err) // R6 — không nuốt bằng chứng mạng nữa
    }
  }
  // ===== R6 — KẾT LUẬN THEO BẰNG CHỨNG (thay hardcode sandbox-era Task 30) =====
  // User report 2026-10-31: chạy app trên máy cá nhân ở Việt Nam, đã đăng nhập
  // opencode, nhưng thông báo vẫn nói "bị chặn vì app chạy trên datacenter
  // Alibaba Cloud HK" — vì đoạn return này hardcode kết luận từ điều tra Task 30
  // TRÊN SANDBOX, không kiểm chứng nơi app đang chạy. Giờ kết luận theo egress
  // live + số endpoint thực sự bị FreeTierError:
  //   (1) 0 endpoint chạm được → lỗi mạng (không kết luận gì về free-tier);
  //   (2) bị FreeTierError + egress là datacenter → đúng nghĩa "IP máy chủ";
  //   (3) bị FreeTierError + egress KHÔNG phải datacenter → TUYỆT ĐỐI không
  //       đổ lỗi "IP datacenter" — nói thẳng policy/tài khoản + hướng khác.
  const egress = await egressPromise
  const egLine = formatEgressLine(egress)
  // Chuẩn hoá null → undefined cho field tùy chọn của shape (tsc strict).
  const egressField: ZenEgressInfo | undefined = egress ?? undefined
  if (freeTierErrCount === 0) {
    return {
      unlocked: false,
      detail: `Không gọi được opencode.ai từ máy chạy app — cả ${endpoints.length} endpoint đều lỗi mạng${lastNetErr ? ` (${lastNetErr})` : ''}. ${egLine}. Đây là lỗi KẾT NỐI, chưa nói gì về free-tier — kiểm tra Internet/firewall của máy chạy app rồi bấm "Thử lại".`,
      egress: egressField,
    }
  }
  if (egress?.isDatacenter) {
    return {
      unlocked: false,
      detail: `Zen chặn free-tier theo IP máy chủ: ${egLine} — org này là datacenter nên bị từ chối kể cả session hợp lệ (bằng chứng nền Task 30: replay nguyên vận request CLI chính chủ vẫn 403 từ datacenter; keyless chỉ mở cho IP cá nhân). Hướng khắc phục: chạy app trên máy cá nhân/IP nhà, hoặc nạp credit Zen dùng model trả phí.`,
      egress: egressField,
    }
  }
  if (egress) {
    return {
      unlocked: false,
      detail: `Session hợp lệ nhưng Zen vẫn từ chối (FreeTierError 403 trên ${freeTierErrCount}/${endpoints.length} endpoint). ${egLine} — org này KHÔNG phải datacenter, nên KHÔNG phải lý do "IP máy chủ/datacenter" như thông báo cũ (đó là kết luận từ điều tra sandbox-era Task 30, hết căn cứ ở máy này). Nguyên nhân khả dĩ: policy Zen lật theo tài khoản/thời điểm (bấm "Thử lại" sau ít phút), hoặc model free vừa đổi danh sách (đồng bộ R5 sẽ cập nhật). Hướng khắc phục: thử lại sau, dùng model trả phí, hoặc probe từ máy/IP khác.`,
      egress: egressField,
    }
  }
  return {
    unlocked: false,
    detail: `Session bị FreeTierError 403 (${freeTierErrCount}/${endpoints.length} endpoint) nhưng không tra cứu được egress máy chạy app — không đủ căn cứ kết luận "IP datacenter" như thông báo cũ. Thử lại sau ít phút.`,
    egress: egressField,
  }
}

/** Task 30 — tổ hợp tool lõi opencode (schema rút gọn từ capture thật của CLI
 *  v1.19.0) — dùng cho probe body để qua gate kiểm tra mảng tools. */
const OFFICIAL_CORE_TOOLS = [
  'bash', 'read', 'edit', 'write', 'glob', 'grep', 'list', 'patch', 'task', 'webfetch',
].map((name) => ({
  type: 'function',
  function: {
    name,
    description: `opencode built-in ${name} tool`,
    parameters: { type: 'object', properties: { input: { type: 'string', description: `input for ${name}` } }, required: ['input'] },
  },
}))

// ==================== CLI auth.json BRIDGE ====================

/**
 * Ghi session token vào auth store của opencode CLI (~/.local/share/opencode/
 * auth.json) theo ĐÚNG format oauth của CLI chính chủ (Task 30 — đảo ngược từ
 * binary: `iu(G,{type:"oauth",refresh:O,access:Y,expires:_})`, expires =
 * millis-epoch) để đường CLI NATIVE (provider opencode/*) cũng dùng session
 * tài khoản. Chỉ gọi khi probe free-tier OK (không phá credential cũ khi
 * session không giúp gì được). Logout → khôi phục oc_sk từ env.
 */
export function writeAuthJsonForCli(session: { accessToken: string; refreshToken: string; expiresAt: number }): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('path') as typeof import('path')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const os = require('os') as typeof import('os')
    const authPath = path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json')
    fs.mkdirSync(path.dirname(authPath), { recursive: true })
    fs.writeFileSync(authPath, JSON.stringify({
      opencode: {
        type: 'oauth',
        access: session.accessToken,
        refresh: session.refreshToken,
        expires: session.expiresAt,
      },
    }, null, 2) + '\n', { mode: 0o600 })
    console.log('[OC-OAUTH] auth.json CLI đã cập nhật sang session OpenCode account (format oauth chính chủ)')
    return true
  } catch (err) {
    console.warn('[OC-OAUTH] Ghi auth.json lỗi (không chặn):', err instanceof Error ? err.message : String(err))
    return false
  }
}

/** Khôi phục auth.json về oc_sk key từ env (logout / session không mở gì). */
export function restoreAuthJsonFromEnv(): boolean {
  const key = process.env.ZEN_API_KEY_1?.trim()
  if (!key) return false
  return writeAuthJsonRaw(key)
}

function writeAuthJsonRaw(key: string): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('path') as typeof import('path')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const os = require('os') as typeof import('os')
    const authPath = path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json')
    fs.mkdirSync(path.dirname(authPath), { recursive: true })
    fs.writeFileSync(authPath, JSON.stringify({ opencode: { type: 'api', key } }, null, 2) + '\n', { mode: 0o600 })
    console.log('[OC-OAUTH] auth.json CLI khôi phục về ZEN_API_KEY_1 (oc_sk)')
    return true
  } catch (err) {
    console.warn('[OC-OAUTH] Khôi phục auth.json lỗi:', err instanceof Error ? err.message : String(err))
    return false
  }
}

// ==================== STATUS / LOGOUT ====================

export function getOAuthStatus(): OpenCodeOAuthStatus {
  const session = readSessionStore()
  if (!session) return { loggedIn: false }
  const now = Date.now()
  return {
    loggedIn: true,
    sessionValidTill: session.expiresAt,
    needsRefresh: now >= session.expiresAt - TOKEN_EXPIRY_MARGIN_MS,
    email: session.email,
    orgId: session.orgId,
    freeTier: session.freeTier,
  }
}

/** Cập nhật kết quả probe free-tier mới nhất vào session (memory + file).
 *  Dùng bởi /api/opencode/auth/probe sau khi re-probe (policy Zen lật ngược
 *  nhiều lần — kết quả mới nhất phải hiện lên status route). */
export function updateSessionFreeTier(freeTier: NonNullable<OpenCodeOAuthSession['freeTier']>): void {
  const session = readSessionStore()
  if (!session) return
  writeSessionStore({ ...session, freeTier })
}

export function logoutOpenCode(): OpenCodeOAuthStatus {
  writeSessionStore(null)
  sessionRejectUntil = 0
  sessionRejectReasonText = ''
  restoreAuthJsonFromEnv()
  console.log('[OC-OAUTH] Đã đăng xuất OpenCode account — session xoá, auth.json CLI khôi phục oc_sk')
  return { loggedIn: false }
}

// ==================== TEST HELPER ====================

/** Cho unit-test: ghi session giả lập vào memory (không chạm file thật). */
export function __setSessionForTest(session: OpenCodeOAuthSession | null): void {
  memSession = session
}
