/**
 * OpenClaw Gateway Client Library
 *
 * Centralized client for communicating with the OpenClaw Gateway.
 * Uses OPENCLAW_GATEWAY_URL env variable (default: http://127.0.0.1:18789)
 *
 * ON-DEMAND (2026-09-07): các hàm "real-use" (chatCompletion, list*, createSession)
 * gọi ensureGatewayRunning() TRƯỚC — gateway offline thì tự spawn on-demand
 * (xem openclaw-ondemand.ts). isGatewayOnline() giữ THỤ ĐỘNG cho status polling
 * (không bao giờ tự spawn từ health check).
 */

import { ensureGatewayRunning } from './openclaw-ondemand'

const GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL || 'http://127.0.0.1:18789'
const DEFAULT_TIMEOUT = 5000

// ==================== GATEWAY HEALTH ====================

export async function isGatewayOnline(): Promise<{ online: boolean; responseTime?: number }> {
  const start = Date.now()
  try {
    const res = await gatewayFetch('/health')
    const data = await res.json()
    return { online: data.ok === true, responseTime: Date.now() - start }
  } catch {
    return { online: false }
  }
}

// ==================== CORE FETCH ====================

export async function gatewayFetch(path: string, options?: RequestInit & { timeout?: number }) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options?.timeout || DEFAULT_TIMEOUT)
  try {
    const res = await fetch(`${GATEWAY_URL}${path}`, {
      ...options,
      signal: controller.signal,
    })
    return res
  } finally {
    clearTimeout(timeout)
  }
}

// ==================== CHAT COMPLETIONS ====================

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_call_id?: string
  name?: string
}

export interface ChatCompletionParams {
  messages: ChatMessage[]
  model?: string
  sessionId?: string
  stream?: boolean
  temperature?: number
  max_tokens?: number
  tools?: Array<{ type: string; function: { name: string; description: string; parameters: Record<string, unknown> } }>
}

export async function chatCompletion(params: ChatCompletionParams) {
  // On-demand: đảm bảo gateway chạy trước khi gọi (spawn nếu cần)
  const gw = await ensureGatewayRunning()
  if (!gw.online) {
    throw new Error(`Gateway offline (on-demand start failed: ${gw.error || 'unknown'})`)
  }
  const res = await gatewayFetch('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: params.model || 'openclaw/default',
      messages: params.messages,
      session_id: params.sessionId,
      stream: params.stream || false,
      ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
      ...(params.max_tokens !== undefined ? { max_tokens: params.max_tokens } : {}),
      ...(params.tools ? { tools: params.tools } : {}),
    }),
    timeout: 60000,
  })

  if (!res.ok) {
    const errorText = await res.text().catch(() => 'Unknown error')
    throw new Error(`Gateway chat error ${res.status}: ${errorText}`)
  }

  return res
}

// ==================== MODELS ====================

export async function listModels() {
  if (!(await ensureGatewayRunning()).online) return []
  try {
    const res = await gatewayFetch('/v1/models')
    if (res.ok) {
      const data = await res.json()
      return data.data || []
    }
  } catch {}
  return []
}

// ==================== SESSIONS ====================

export async function listSessions() {
  if (!(await ensureGatewayRunning()).online) return []
  try {
    const res = await gatewayFetch('/v1/sessions')
    if (res.ok) {
      const data = await res.json()
      return data.sessions || data.data || []
    }
  } catch {}
  return []
}

export async function createSession(title?: string) {
  if (!(await ensureGatewayRunning()).online) throw new Error('Gateway offline (on-demand start failed)')
  const res = await gatewayFetch('/v1/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: title || 'New Session' }),
  })
  if (res.ok) return await res.json()
  throw new Error('Failed to create session')
}

// ==================== SKILLS ====================

export async function listSkills() {
  if (!(await ensureGatewayRunning()).online) return []
  try {
    const res = await gatewayFetch('/v1/skills')
    if (res.ok) {
      const data = await res.json()
      return data.skills || data.data || []
    }
  } catch {}
  return []
}

export async function searchSkills(query: string) {
  if (!(await ensureGatewayRunning()).online) return []
  try {
    const res = await gatewayFetch(`/v1/skills/search?q=${encodeURIComponent(query)}`)
    if (res.ok) {
      const data = await res.json()
      return data.skills || data.data || []
    }
  } catch {}
  return []
}

// ==================== TOOLS ====================

export async function listTools() {
  if (!(await ensureGatewayRunning()).online) return []
  try {
    const res = await gatewayFetch('/v1/tools')
    if (res.ok) {
      const data = await res.json()
      return data.tools || data.data || []
    }
  } catch {}
  return []
}

// ==================== AUTOMATION ====================

export async function listCronJobs() {
  if (!(await ensureGatewayRunning()).online) return { jobs: [] }
  try {
    const res = await gatewayFetch('/v1/automation/cron')
    if (res.ok) return await res.json()
  } catch {}
  return { jobs: [] }
}

export async function listWebhooks() {
  if (!(await ensureGatewayRunning()).online) return { webhooks: [] }
  try {
    const res = await gatewayFetch('/v1/automation/webhooks')
    if (res.ok) return await res.json()
  } catch {}
  return { webhooks: [] }
}

// ==================== CHANNELS ====================

export async function listChannels() {
  if (!(await ensureGatewayRunning()).online) return []
  try {
    const res = await gatewayFetch('/v1/channels')
    if (res.ok) {
      const data = await res.json()
      return data.channels || data.data || []
    }
  } catch {}
  return []
}
