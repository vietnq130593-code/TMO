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

/** client_id đăng ký với console device-flow — live-verify 2026-10-14 với
 *  "tmo-app". Override qua env nếu console yêu cầu client đăng ký chặt hơn. */
export const OPENCODE_OAUTH_CLIENT_ID = process.env.OPENCODE_OAUTH_CLIENT_ID?.trim() || 'tmo-app'

/** Header nhận diện "from within OpenCode" — trích từ binary opencode CLI
 *  v1.19.0 (zen SDK: UA `opencode/<ver>` + x-opencode-client app/cli/desktop).
 *  Live-probe 2026-10-14: các header này với oc_sk key KHÔNG mở free tier
 *  (403 vẫn trả về) — gửi kèm session token để mô phỏng desktop app sát nhất. */
const OPENCODE_CLIENT_UA = 'opencode/1.19.0'
/** Export cho llm.ts tái dùng trên đường session-token (1 nguồn header —
 *  cùng bộ header probeFreeTier dùng, tránh lệch nhau giữa probe + call thật). */
export const OPENCODE_SESSION_HEADERS: Record<string, string> = {
  'User-Agent': OPENCODE_CLIENT_UA,
  'x-opencode-client': 'app',
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

export type DevicePollResult =
  | { status: 'pending'; message: string }
  | { status: 'success'; session: OpenCodeOAuthSession; freeTier: { unlocked: boolean; detail: string; endpoint?: string } }
  | { status: 'expired'; message: string }
  | { status: 'denied'; message: string }
  | { status: 'error'; message: string }

export interface OpenCodeOAuthStatus {
  loggedIn: boolean
  sessionValidTill?: number
  needsRefresh?: boolean
  email?: string
  orgId?: string
  freeTier?: { probedAt: number; unlocked: boolean; detail: string; endpoint?: string }
}

// ==================== STORE (file + memory, pattern r74b) ====================

interface StoreShape {
  session?: OpenCodeOAuthSession
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
      memSession = storeFileCache.data.session ?? null
      return memSession
    }
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'))
    const data: StoreShape = raw && typeof raw === 'object' && typeof raw.session === 'object'
      ? { session: raw.session }
      : {}
    storeFileCache = { mtimeMs: st.mtimeMs, data }
    memSession = data.session ?? null
    return memSession
  } catch {
    return storeFileCache?.data.session ?? null
  }
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
  try {
    const res = await consoleFetch(SESSION_REFRESH_URL, {
      method: 'POST',
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: session.refreshToken,
        client_id: OPENCODE_OAUTH_CLIENT_ID,
      }),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      console.warn(`[OC-OAUTH] Refresh session HTTP ${res.status}: ${body.slice(0, 160)}`)
      return null
    }
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
  const session = readSessionStore()
  if (!session) return null
  if (Date.now() < session.expiresAt - TOKEN_EXPIRY_MARGIN_MS) return session.accessToken
  // Hết hạn (hoặc sắp hết) → refresh 1 lần
  const refreshed = await refreshSession(session)
  return refreshed?.accessToken ?? null
}

/** Peek session (không refresh) — cho status endpoint + test. */
export function peekSession(): OpenCodeOAuthSession | null {
  return readSessionStore()
}

// ==================== FREE-TIER PROBE ====================

/**
 * Probe space-bunny-free với session token — trả lời câu hỏi "session tài
 * khoản có mở free tier không?" bằng KẾT QUẢ THẬT. Thử cả 2 endpoint Zen
 * (/zen/v1 cũ + /inference/v1 mới — docs 2026-10-14 đã chuyển sang inference).
 */
export async function probeFreeTier(accessToken?: string): Promise<{ unlocked: boolean; detail: string; endpoint?: string }> {
  const token = accessToken ?? await getValidZenSessionToken()
  if (!token) return { unlocked: false, detail: 'Chưa có session OpenCode account' }
  const endpoints = [
    process.env.ZEN_BASE_URL?.trim() || 'https://opencode.ai/zen/v1',
    'https://opencode.ai/inference/v1',
  ]
  const seen = new Set<string>()
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
            ...OPENCODE_SESSION_HEADERS,
          },
          body: JSON.stringify({
            model: 'space-bunny-free',
            messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
            max_tokens: 16,
          }),
          signal: controller.signal,
        })
        if (res.ok) {
          console.log(`[OC-OAUTH] ✅ Probe free-tier OK (${base}) — session OpenCode account MỞ free tier`)
          return { unlocked: true, detail: 'Session OpenCode account đã mở khóa space-bunny-free (probe OK)', endpoint: base }
        }
        const body = await res.text().catch(() => '')
        console.warn(`[OC-OAUTH] Probe free-tier ${base} HTTP ${res.status}: ${body.slice(0, 160)}`)
        if (res.status === 401 || (res.status === 403 && !/FreeTierError|free tier/i.test(body))) {
          noteSessionRejected(`HTTP ${res.status} khi probe: ${body.slice(0, 120)}`)
          return { unlocked: false, detail: `Session bị từ chối (HTTP ${res.status}) — token không hợp lệ hoặc hết hạn`, endpoint: base }
        }
        // FreeTierError → endpoint này không mở với session — thử endpoint kế
      } finally {
        clearTimeout(timer)
      }
    } catch (err) {
      console.warn(`[OC-OAUTH] Probe free-tier ${base} lỗi:`, err instanceof Error ? err.message : String(err))
    }
  }
  return { unlocked: false, detail: 'Session đã đăng nhập nhưng Zen vẫn chặn free-tier (FreeTierError trên cả 2 endpoint) — có thể policy Zen yêu cầu điều kiện khác (app chính chủ/nạp credit)' }
}

// ==================== CLI auth.json BRIDGE ====================

/**
 * Ghi session token vào auth store của opencode CLI (~/.local/share/opencode/
 * auth.json) để đường CLI NATIVE (provider opencode/*) cũng dùng session tài
 * khoản — "from within OpenCode" cần credential đúng, oc_sk key đã bị chặn
 * 403 toàn cục (Task 28). Chỉ gọi khi probe free-tier OK (không phá credential
 * cũ khi session không giúp gì được). Logout → khôi phục oc_sk từ env.
 */
export function writeAuthJsonForCli(accessToken: string): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('path') as typeof import('path')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const os = require('os') as typeof import('os')
    const authPath = path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json')
    fs.mkdirSync(path.dirname(authPath), { recursive: true })
    fs.writeFileSync(authPath, JSON.stringify({ opencode: { type: 'api', key: accessToken } }, null, 2) + '\n', { mode: 0o600 })
    console.log('[OC-OAUTH] auth.json CLI đã cập nhật sang session token OpenCode account (CLI native dùng session)')
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
