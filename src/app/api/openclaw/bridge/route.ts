/**
 * Gateway Bridge API — Full 36-Tool Access via WebSocket Bridge
 *
 * GET  /api/openclaw/bridge — Bridge status + tool accessibility
 * POST /api/openclaw/bridge — Invoke a tool through the Bridge
 *
 * The Bridge (port 18791) connects to the Gateway via WebSocket
 * and provides access to ALL 36 Gateway tools including session-context ones
 * (exec, read, write, image_generate, etc.) that are NOT available via HTTP.
 */

import { NextRequest, NextResponse } from 'next/server'
import { validateArgs } from '@/lib/security/command-validator'
// ROUND-6 (infra-guard lớp 2): bridge tools ghi/lệnh phải qua guard như lớp 1
import { guardBridgeToolInvocation } from '@/lib/protected-paths'

export const dynamic = 'force-dynamic'

const BRIDGE_URL = process.env.OPENCLAW_BRIDGE_URL || 'http://127.0.0.1:18791'

// ==================== RATE LIMITING ====================
interface RateLimitEntry {
  count: number
  resetTime: number
}

const RATE_LIMIT_WINDOW = 60 * 1000 // 1 minute
const RATE_LIMIT_MAX = 30 // 30 requests per minute

const rateLimitMap = new Map<string, RateLimitEntry>()

function getRateLimitKey(request: NextRequest): string {
  const forwarded = request.headers.get('x-forwarded-for')
  const ip = forwarded?.split(',')[0]?.trim() || request.headers.get('x-real-ip') || 'unknown'
  const apiKey = request.headers.get('x-api-key')
  return apiKey || ip || 'unknown'
}

function checkRateLimit(key: string): { allowed: boolean; retryAfter?: number } {
  const now = Date.now()
  const entry = rateLimitMap.get(key)

  if (!entry || now > entry.resetTime) {
    // New window
    rateLimitMap.set(key, { count: 1, resetTime: now + RATE_LIMIT_WINDOW })
    return { allowed: true }
  }

  if (entry.count >= RATE_LIMIT_MAX) {
    const retryAfter = Math.ceil((entry.resetTime - now) / 1000)
    return { allowed: false, retryAfter }
  }

  entry.count++
  return { allowed: true }
}

// Cleanup to prevent memory leaks.
// FIX (timer leak on hot reload): the interval was created at module scope on
// every re-evaluation, never cleared and not unref'd — intervals (and their
// rateLimitMap closures) piled up during dev. globalThis guard + unref keeps
// exactly one cleanup interval alive.
const globalForBridgeRoute = globalThis as unknown as {
  __bridgeRateLimitCleanup?: ReturnType<typeof setInterval>
}
if (!globalForBridgeRoute.__bridgeRateLimitCleanup) {
  const cleanupTimer = setInterval(() => {
    const now = Date.now()
    for (const [key, entry] of rateLimitMap) {
      if (now > entry.resetTime) {
        rateLimitMap.delete(key)
      }
    }
  }, RATE_LIMIT_WINDOW * 2)
  if (typeof cleanupTimer === 'object' && 'unref' in cleanupTimer) cleanupTimer.unref()
  globalForBridgeRoute.__bridgeRateLimitCleanup = cleanupTimer
}

// ==================== AUTH ====================
function isAuthenticated(request: NextRequest): boolean {
  const apiKey = request.headers.get('x-api-key')
  const validApiKey = process.env.OPENCLAW_API_KEY

  if (validApiKey && apiKey === validApiKey) {
    return true
  }

  // Bearer token auth — FIX (security): previously ANY non-empty Bearer token was
  // accepted ("return token.length > 0" placeholder), letting arbitrary callers
  // through to exec/bash/write_file tools. Now the token must match OPENCLAW_API_KEY.
  const authHeader = request.headers.get('authorization')
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7)
    return !!validApiKey && token === validApiKey
  }

  // In development, allow requests without API key
  if (process.env.NODE_ENV === 'development') {
    return true
  }

  return false
}

// ==================== TOOL NAME VALIDATION ====================
/**
 * Whitelist of allowed tool names.
 * Prevents invocation of dangerous tools.
 */
const ALLOWED_TOOLS = [
  // Read-only tools
  'read', 'read_dir', 'search', 'grep_search', 'glob_search',
  'read_file', 'read_directory', 'file_search',
  // Safe write tools
  'write', 'write_file', 'edit',
  // Safe exec tools (with validation)
  'exec', 'bash', 'shell',
  // Network tools
  'fetch', 'curl', 'http_request',
  // Code analysis
  'code_analysis', 'ast_analysis', 'static_analysis',
  // Knowledge tools
  'knowledge_search', 'knowledge_write', 'knowledge_graph',
  // Other safe tools
  'image_generate', 'image_search', 'web_search',
  'git_status', 'git_diff', 'git_log',
] as const

function validateToolName(name: unknown): { valid: boolean; error?: string } {
  if (!name || typeof name !== 'string') {
    return { valid: false, error: 'Tool name is required and must be a string' }
  }

  const trimmed = name.trim()
  if (trimmed.length === 0) {
    return { valid: false, error: 'Tool name cannot be empty' }
  }

  if (trimmed.length > 100) {
    return { valid: false, error: 'Tool name exceeds maximum length' }
  }

  // Check for injection attempts in tool name
  const injectionPattern = /[;|&`$><!]/
  if (injectionPattern.test(trimmed)) {
    return { valid: false, error: 'Tool name contains forbidden characters' }
  }

  // Check against whitelist
  const lowerName = trimmed.toLowerCase()
  const isAllowed = ALLOWED_TOOLS.some(t => lowerName.includes(t))
  
  if (!isAllowed) {
    return { valid: false, error: `Tool "${trimmed}" is not in the allowed list` }
  }

  return { valid: true }
}

// ==================== ROUTES ====================
export async function GET() {
  try {
    const res = await fetch(`${BRIDGE_URL}/health`, { signal: AbortSignal.timeout(5000) })
    if (res.ok) {
      const data = await res.json()
      return NextResponse.json(data)
    }
    return NextResponse.json({ ok: false, error: `Bridge returned ${res.status}` }, { status: 502 })
  } catch (err) {
    return NextResponse.json({
      ok: false,
      error: `Bridge unavailable: ${err instanceof Error ? err.message : String(err)}`,
      bridge: { status: 'disconnected', connected: false, authenticated: false },
      tools: { total: 36, httpAccessible: 17, sessionContext: 19, bridgeAccessible: 17 },
    }, { status: 503 })
  }
}

export async function POST(request: NextRequest) {
  try {
    // Step 1: Authentication
    if (!isAuthenticated(request)) {
      return NextResponse.json({
        ok: false,
        error: 'Unauthorized: valid API key required',
      }, { status: 401 })
    }

    // Step 2: Rate limiting
    const rateLimitKey = getRateLimitKey(request)
    const rateLimitCheck = checkRateLimit(rateLimitKey)
    if (!rateLimitCheck.allowed) {
      return NextResponse.json({
        ok: false,
        error: 'Rate limit exceeded',
        retryAfter: rateLimitCheck.retryAfter,
      }, {
        status: 429,
        headers: { 'Retry-After': String(rateLimitCheck.retryAfter) },
      })
    }

    // Step 3: Parse and validate body
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({
        ok: false,
        error: 'Invalid JSON body',
      }, { status: 400 })
    }

    if (!body || typeof body !== 'object') {
      return NextResponse.json({
        ok: false,
        error: 'Request body must be a valid object',
      }, { status: 400 })
    }

    const { name, args } = body as { name: unknown; args: unknown }

    // Validate tool name
    const toolValidation = validateToolName(name)
    if (!toolValidation.valid) {
      return NextResponse.json({
        ok: false,
        error: toolValidation.error,
      }, { status: 400 })
    }

    // Validate args for security
    const argsValidation = validateArgs(args)
    if (!argsValidation.valid) {
      return NextResponse.json({
        ok: false,
        error: argsValidation.error || 'Invalid args',
      }, { status: 400 })
    }

    // ROUND-6 (infra-guard lớp 2, 2026-10-28): route này trước đây chỉ chặn
    // prototype-pollution — agent có thể POST {name:'write', args:{path:'.env'}}
    // ghi đè file bảo vệ qua bridge, bypass lớp 1. Giờ mọi tool ghi/lệnh
    // (exec/write/edit/apply_patch/code_execution/process) phải qua guard
    // như lớp 1 (user directive: "chặn như lớp 1").
    try {
      const guard = guardBridgeToolInvocation({
        name: name as string,
        args: (args as Record<string, unknown>) || {},
        root: process.cwd(), // app luôn chạy từ tmo-app root
      })
      if (guard.blocked) {
        console.warn(`[INFRA-GUARD] bridge route blocked: ${guard.reason}`)
        return NextResponse.json({
          ok: false,
          error: guard.message || 'TỪ CHỐI (infra-guard lớp 2)',
        }, { status: 403 })
      }
    } catch {
      // guard lỗi hệ thống → fail-closed cho mutating tools (an toàn hơn)
      return NextResponse.json({ ok: false, error: 'infra-guard unavailable' }, { status: 503 })
    }

    // Step 4: Invoke the bridge
    const res = await fetch(`${BRIDGE_URL}/tools/invoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, args: args || {} }),
      signal: AbortSignal.timeout(60000),
    })

    const data = await res.json()
    return NextResponse.json(data, { status: res.ok ? 200 : 502 })
  } catch (err) {
    return NextResponse.json({
      ok: false,
      error: `Bridge invocation failed: ${err instanceof Error ? err.message : String(err)}`,
    }, { status: 500 })
  }
}
