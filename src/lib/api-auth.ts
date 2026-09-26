// ============================================
// src/lib/api-auth.ts — frontend auth helper
// authedFetch() tự inject x-tmo-api-token vào mọi request + TỰ HEAL khi 401.
//
// FIX 2026-09-25 (preview iframe 401 — user report "[FileSelect] read failed ...
// { error: 'Unauthorized' }"): preview panel chạy app trong cross-site iframe —
// browser chặn cookie SameSite=Lax (third-party context) → mọi request
// /api/opencode/* + /api/workspace/* bị proxy.ts trả 401 mãi (cookie không bao
// giờ được set/gửi). authedFetch giờ:
//   1. Lấy token từ localStorage (page.tsx lưu sau khi gọi /api/auth/setup —
//      setup giờ trả token trong body). Header KHÔNG bị luật SameSite ràng
//      buộc → hoạt động trong mọi context (iframe, tab, PWA...).
//   2. Khi nhận 401 (token thiếu/sai — vd app restart sinh token mới): tự gọi
//      /api/auth/setup lấy token mới, lưu localStorage, retry ĐÚNG 1 lần.
//      Caller không cần tự xử lý 401.
// ============================================

export function getApiToken(): string | null {
  if (typeof window === 'undefined') return null
  return localStorage.getItem('tmo_api_token') || null
}

export function setApiToken(token: string): void {
  if (typeof window === 'undefined') return
  localStorage.setItem('tmo_api_token', token)
}

/** Gọi /api/auth/setup — set cookie (first-party) + trả token để lưu localStorage. */
async function fetchSetupToken(): Promise<string | null> {
  if (typeof window === 'undefined') return null
  try {
    const res = await fetch('/api/auth/setup', { credentials: 'same-origin' })
    if (!res.ok) return null
    const data = (await res.json().catch(() => null)) as { token?: string } | null
    const token = data?.token
    if (typeof token === 'string' && token.trim().length >= 16) {
      setApiToken(token.trim())
      return token.trim()
    }
    return null
  } catch {
    return null
  }
}

/** Dedupe các lần fetch setup chạy đồng thời (nhiều request 401 cùng lúc). */
let inflightSetup: Promise<string | null> | null = null

function ensureToken(): Promise<string | null> {
  const cached = getApiToken()
  if (cached) return Promise.resolve(cached)
  if (!inflightSetup) {
    inflightSetup = fetchSetupToken().finally(() => {
      inflightSetup = null
    })
  }
  return inflightSetup
}

function doFetch(url: string, init: RequestInit, token: string | null): Promise<Response> {
  const headers = new Headers(init.headers)
  if (token && !headers.has('x-tmo-api-token')) {
    headers.set('x-tmo-api-token', token)
  }
  return fetch(url, { ...init, headers })
}

export async function authedFetch(url: string, init: RequestInit = {}): Promise<Response> {
  // Cache-bust GET khi retry để không bao giờ ăn response 401 cũ từ HTTP cache
  // (trước đây browser cache 401 làm click file lỗi vĩnh viễn dù token đã tốt).
  let token = await ensureToken()
  let res = await doFetch(url, init, token)
  if (res.status === 401) {
    // Cookie (nếu có) + token hiện tại đều bị từ chối — setup lại rồi retry 1 lần
    token = await fetchSetupToken()
    if (token) {
      const retryUrl =
        !init.method || init.method.toUpperCase() === 'GET'
          ? `${url}${url.includes('?') ? '&' : '?'}_tmo_retry=${Date.now()}`
          : url
      res = await doFetch(retryUrl, init, token)
    }
  }
  return res
}
