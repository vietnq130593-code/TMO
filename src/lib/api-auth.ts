// ============================================
// src/lib/api-auth.ts — Phase 1: frontend auth helper
// authedFetch() tự inject x-tmo-api-token header vào mọi request.
// (Hoạt động song song với HttpOnly cookie từ /api/auth/setup — Phase 2 fix)
// ============================================

export function getApiToken(): string | null {
  if (typeof window === 'undefined') return null
  return localStorage.getItem('tmo_api_token') || null
}

export function setApiToken(token: string): void {
  if (typeof window === 'undefined') return
  localStorage.setItem('tmo_api_token', token)
}

export function authedFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const token = getApiToken()
  const headers = new Headers(init.headers)
  if (token && !headers.has('x-tmo-api-token')) {
    headers.set('x-tmo-api-token', token)
  }
  return fetch(url, { ...init, headers })
}
