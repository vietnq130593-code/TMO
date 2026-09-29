/**
 * Gateway Tool Registry — Register/unregister custom tools with OpenClaw Gateway
 * 
 * When a ClawHub skill is installed that references tools, this module:
 * 1. Validates the tool definitions
 * 2. Registers them with the Gateway (if Gateway supports dynamic registration)
 * 3. Tracks which skills have registered which tools
 * 4. Unregisters tools when skills are uninstalled
 */

import { validateToolSchema, type SkillToolSchema } from './skill-tool-schema'

const GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL || 'http://127.0.0.1:18789'

// In-memory registry tracking which skills registered which tools
interface ToolRegistration {
  toolName: string
  skillSlug: string
  registeredAt: Date
  source: 'skill-archive' | 'custom' | 'clawhub'
}

const registrationLog: ToolRegistration[] = []

/**
 * Register a tool with the Gateway
 * Note: OpenClaw Gateway may not support dynamic tool registration via HTTP API.
 * This function attempts registration and falls back gracefully.
 */
export async function registerToolWithGateway(tool: {
  name: string
  description: string
  parameters: Record<string, unknown>
  handler?: string  // URL of tool handler endpoint
  skillSlug?: string
}): Promise<{ success: boolean; method: string; error?: string }> {
  // Validate tool schema
  const validation = validateToolSchema({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  })
  
  if (!validation.valid) {
    return { success: false, method: 'validation', error: validation.errors.join(', ') }
  }
  
  // Track in local registry regardless of Gateway support
  registrationLog.push({
    toolName: tool.name,
    skillSlug: tool.skillSlug || 'unknown',
    registeredAt: new Date(),
    source: tool.skillSlug ? 'clawhub' : 'custom',
  })

  // R7-M2 (S6, audit R7-M1): cap 100 — registrationLog push mỗi CALL (không
  // phải unique tool) nên mọc vô hạn theo tải; giữ 100 mới nhất bằng splice
  // in-place (giữ reference cho reader đang giữ array).
  if (registrationLog.length > 100) {
    registrationLog.splice(0, registrationLog.length - 100)
  }
  
  // Try Gateway registration (may not be supported)
  try {
    const res = await fetch(`${GATEWAY_URL}/v1/tools/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
        ...(tool.handler ? { handler: { type: 'http', url: tool.handler } } : {}),
      }),
      signal: AbortSignal.timeout(5000),
    })
    
    if (res.ok) {
      return { success: true, method: 'gateway-api' }
    }
    
    // Gateway doesn't support dynamic registration — that's OK
    return { success: true, method: 'local-registry-only', error: `Gateway returned ${res.status}` }
  } catch (err) {
    // Gateway unreachable — tool is still tracked locally
    return { success: true, method: 'local-registry-only', error: err instanceof Error ? err.message : 'Gateway unreachable' }
  }
}

/**
 * Unregister a tool from the Gateway
 */
export async function unregisterToolFromGateway(toolName: string): Promise<{ success: boolean; method: string }> {
  // Remove from local registry
  const idx = registrationLog.findIndex(r => r.toolName === toolName)
  if (idx !== -1) {
    registrationLog.splice(idx, 1)
  }
  
  // Try Gateway unregistration
  try {
    const res = await fetch(`${GATEWAY_URL}/v1/tools/unregister`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: toolName }),
      signal: AbortSignal.timeout(5000),
    })
    
    if (res.ok) return { success: true, method: 'gateway-api' }
    return { success: true, method: 'local-registry-only' }
  } catch {
    return { success: true, method: 'local-registry-only' }
  }
}

/**
 * Register all tools referenced by a skill
 */
export async function registerSkillTools(
  skillSlug: string,
  toolNames: string[],
  toolDefs: SkillToolSchema[]
): Promise<{ registered: number; failed: number; results: Array<{ tool: string; success: boolean; method: string }> }> {
  const results: Array<{ tool: string; success: boolean; method: string }> = []
  let registered = 0
  let failed = 0
  
  for (const toolName of toolNames) {
    const def = toolDefs.find(d => d.name === toolName)
    
    const result = await registerToolWithGateway({
      name: toolName,
      description: def?.description || `Tool from skill: ${skillSlug}`,
      parameters: def?.parameters || { type: 'object', properties: {} },
      skillSlug,
    })
    
    results.push({ tool: toolName, success: result.success, method: result.method })
    if (result.success) registered++
    else failed++
  }
  
  return { registered, failed, results }
}

/**
 * Get all registered tools
 */
export function getRegisteredTools(): ToolRegistration[] {
  return [...registrationLog]
}

/**
 * Get tools registered by a specific skill
 */
export function getSkillRegisteredTools(skillSlug: string): ToolRegistration[] {
  return registrationLog.filter(r => r.skillSlug === skillSlug)
}

/**
 * Clear all registrations for a skill (used during uninstall)
 */
export async function clearSkillRegistrations(skillSlug: string): Promise<number> {
  const skillTools = registrationLog.filter(r => r.skillSlug === skillSlug)
  let cleared = 0
  
  for (const reg of skillTools) {
    await unregisterToolFromGateway(reg.toolName)
    cleared++
  }
  
  return cleared
}
