/**
 * Custom Tool Registry — In-memory hot-reload registry for custom tools
 *
 * Provides:
 *   - In-memory registry for fast access to custom tool definitions and handlers
 *   - Integration with Gateway Tool Registry for dynamic registration
 *   - Sandbox execution of custom tool handlers (similar to plugin-runner.ts)
 *   - Auto-load from DB on startup
 *
 * Custom tools are user-defined tools stored in the CustomTool DB table.
 * They extend the built-in tool system (local + gateway) with arbitrary JS handlers.
 */

import { db } from '@/lib/db'
import { registerToolWithGateway, unregisterToolFromGateway } from '@/lib/gateway-tool-registry'
import { ALL_KNOWN_TOOLS } from '@/lib/skill-tool-schema'

// ==================== TYPES ====================

export interface CustomToolEntry {
  id: string
  name: string
  description: string
  parameters: Record<string, unknown>  // Parsed JSON schema
  handlerCode: string
  version: string
  source: string
  category: string
  enabled: boolean
  isPublic: boolean
  skillSlug: string | null
  callCount: number
  createdAt: Date
  updatedAt: Date
}

export interface CustomToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

interface RegistryEntry {
  tool: CustomToolEntry
  registeredAt: Date
  gatewayRegistered: boolean
}

export interface ExecutionResult {
  success: boolean
  result: unknown
  duration: number
  error?: string
  timedOut?: boolean
}

// ==================== IN-MEMORY REGISTRY ====================

const registry = new Map<string, RegistryEntry>()

// ==================== REGISTRY OPERATIONS ====================

/**
 * Register a custom tool in the in-memory registry
 * Optionally also registers with the Gateway
 */
export async function registerCustomTool(
  tool: CustomToolEntry,
  registerGateway: boolean = true
): Promise<{ registered: boolean; gatewayResult?: { success: boolean; method: string; error?: string } }> {
  // Add to in-memory registry
  const entry: RegistryEntry = {
    tool,
    registeredAt: new Date(),
    gatewayRegistered: false,
  }

  let gatewayResult: { success: boolean; method: string; error?: string } | undefined

  // Optionally register with Gateway
  if (registerGateway) {
    gatewayResult = await registerToolWithGateway({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      skillSlug: tool.skillSlug || undefined,
    })
    entry.gatewayRegistered = gatewayResult.success
  }

  registry.set(tool.name, entry)
  return { registered: true, gatewayResult }
}

/**
 * Unregister a custom tool from the in-memory registry + Gateway
 */
export async function unregisterCustomTool(name: string): Promise<{ unregistered: boolean }> {
  const entry = registry.get(name)
  if (!entry) {
    return { unregistered: false }
  }

  // Unregister from Gateway if it was registered
  if (entry.gatewayRegistered) {
    await unregisterToolFromGateway(name)
  }

  registry.delete(name)
  return { unregistered: true }
}

/**
 * Get all custom tool definitions in OpenAI function calling format
 * Only returns enabled tools
 */
export function getCustomToolDefs(): CustomToolDefinition[] {
  const defs: CustomToolDefinition[] = []

  for (const entry of registry.values()) {
    if (!entry.tool.enabled) continue

    defs.push({
      type: 'function',
      function: {
        name: entry.tool.name,
        description: entry.tool.description,
        parameters: entry.tool.parameters,
      },
    })
  }

  return defs
}

/**
 * Get handler code for a specific custom tool
 */
export function getCustomToolHandler(name: string): string | null {
  const entry = registry.get(name)
  if (!entry) return null
  return entry.tool.handlerCode
}

/**
 * Get a custom tool entry by name
 */
export function getCustomTool(name: string): CustomToolEntry | null {
  const entry = registry.get(name)
  if (!entry) return null
  return entry.tool
}

/**
 * Get all registered custom tool entries
 */
export function getAllCustomTools(): CustomToolEntry[] {
  return Array.from(registry.values()).map(e => e.tool)
}

/**
 * Check if a tool name is already taken (custom, local, or gateway)
 */
export function isToolNameTaken(name: string): boolean {
  // Check custom registry
  if (registry.has(name)) return true

  // Check known built-in/gateway tools
  if (ALL_KNOWN_TOOLS.has(name)) return true

  return false
}

// ==================== SECURITY SUTURES ====================

/**
 * Dangerous patterns that could be used for injection or
 * escaping the sandbox.
 */
const DANGEROUS_PATTERNS = [
  /\bprocess\b/,
  /\brequire\s*\(/,
  /\bimport\s*\(/,
  /\beval\s*\(/,
  /\bFunction\s*\(/,
  /\bdocument\b/,
  /\bwindow\b/,
  /\blocalStorage\b/,
  /\bsessionStorage\b/,
  /\bfetch\s*\(.*['"]file:\/\//,
  /\bXMLHttpRequest\b/,
  /\bWebSocket\b/,
  /\bWorker\b/,
  /\bSharedArrayBuffer\b/,
  /\batomics\b/i,
]

/**
 * Check if handler code contains dangerous patterns.
 * Returns true if the code is safe to execute.
 */
function validateHandlerCode(code: string, toolName: string): { safe: boolean; error?: string } {
  if (!code || typeof code !== 'string') {
    return { safe: false, error: 'Handler code is required and must be a string' }
  }

  if (code.length > 50000) {
    return { safe: false, error: 'Handler code exceeds maximum size of 50KB' }
  }

  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(code)) {
      return { safe: false, error: `Handler code contains forbidden pattern: ${pattern.source}` }
    }
  }

  return { safe: true }
}

// ==================== SANDBOX EXECUTION ====================

/**
 * Create a sandboxed environment with limited API access.
 * BLOCKS: filesystem access, child_process, eval, etc.
 * (Follows the same pattern as plugin-runner.ts)
 */
function createSandbox(toolName: string): Record<string, unknown> {
  return {
    console: {
      log: (...args: unknown[]) => console.log(`[CustomTool:${toolName}]`, ...args),
      error: (...args: unknown[]) => console.error(`[CustomTool:${toolName}]`, ...args),
      warn: (...args: unknown[]) => console.warn(`[CustomTool:${toolName}]`, ...args),
    },
    JSON,
    Math,
    Date,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    encodeURIComponent,
    decodeURIComponent,
    encodeURI,
    decodeURI,
    // SECURE: Only allow fetch for HTTP-based tools
    // Block file:// protocol via validation above
    fetch: (url: string, init?: RequestInit) => {
      if (typeof url === 'string' && url.startsWith('file:')) {
        console.warn('[CustomTool] Blocked file:// fetch by', url, 'by tool', toolName)
        return Promise.reject(new TypeError('file:// protocol is disabled in sandbox'));
      }
      if (typeof url === 'string' && url.startsWith('ftp:')) {
        return Promise.reject(new TypeError('ftp:// protocol is disabled in sandbox'));
      }
      return fetch(url, init);
    },
  }
}

/**
 * Execute custom tool handler code in a sandbox
 * Timeout: 10s max (safe for testing)
 * Result truncation: 2000 chars for safety
 */
export async function executeCustomTool(
  name: string,
  args: Record<string, unknown>,
  timeoutMs: number = 10000,
  maxOutputLength: number = 2000
): Promise<ExecutionResult> {
  const startTime = Date.now()

  const entry = registry.get(name)
  if (!entry) {
    return {
      success: false,
      result: null,
      duration: 0,
      error: `Custom tool "${name}" not found in registry`,
    }
  }

  const handlerCode = entry.tool.handlerCode

  // SECURITY: Validate handler code before execution
  const codeValidation = validateHandlerCode(handlerCode, name)
  if (!codeValidation.safe) {
    return {
      success: false,
      result: null,
      duration: 0,
      error: `Security validation failed: ${codeValidation.error}`,
    }
  }

  // Increment call count
  // (fire-and-forget, don't block execution)
  db.customTool.update({
    where: { id: entry.tool.id },
    data: { callCount: { increment: 1 } },
  }).catch(() => { /* ignore */ })

  try {
    const sandbox = createSandbox(name)

    // Execute with timeout
    const result = await Promise.race([
      executeInSandbox(handlerCode, args, sandbox),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Custom tool execution timed out')), timeoutMs)
      ),
    ])

    // Truncate output if too long
    let finalResult = result
    if (typeof result === 'string' && result.length > maxOutputLength) {
      finalResult = result.substring(0, maxOutputLength) + '... [truncated]'
    } else if (typeof result === 'object' && result !== null) {
      const serialized = JSON.stringify(result)
      if (serialized.length > maxOutputLength) {
        finalResult = serialized.substring(0, maxOutputLength) + '... [truncated]'
      }
    }

    return {
      success: true,
      result: finalResult,
      duration: Date.now() - startTime,
    }
  } catch (err) {
    const isTimeout = err instanceof Error && err.message.includes('timed out')
    return {
      success: false,
      result: null,
      error: err instanceof Error ? err.message : 'Unknown execution error',
      duration: Date.now() - startTime,
      timedOut: isTimeout,
    }
  }
}

/**
 * Execute arbitrary handler code in a sandbox (for testing unregistered tools)
 */
export async function executeHandlerCode(
  handlerCode: string,
  toolName: string,
  args: Record<string, unknown>,
  timeoutMs: number = 10000,
  maxOutputLength: number = 2000
): Promise<ExecutionResult> {
  const startTime = Date.now()

  // SECURITY: Validate handler code before execution
  const codeValidation = validateHandlerCode(handlerCode, toolName)
  if (!codeValidation.safe) {
    return {
      success: false,
      result: null,
      duration: 0,
      error: `Security validation failed: ${codeValidation.error}`,
    }
  }

  try {
    const sandbox = createSandbox(toolName)

    // Execute with timeout
    const result = await Promise.race([
      executeInSandbox(handlerCode, args, sandbox),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Custom tool execution timed out')), timeoutMs)
      ),
    ])

    // Truncate output
    let finalResult = result
    if (typeof result === 'string' && result.length > maxOutputLength) {
      finalResult = result.substring(0, maxOutputLength) + '... [truncated]'
    } else if (typeof result === 'object' && result !== null) {
      const serialized = JSON.stringify(result)
      if (serialized.length > maxOutputLength) {
        finalResult = serialized.substring(0, maxOutputLength) + '... [truncated]'
      }
    }

    return {
      success: true,
      result: finalResult,
      duration: Date.now() - startTime,
    }
  } catch (err) {
    const isTimeout = err instanceof Error && err.message.includes('timed out')
    return {
      success: false,
      result: null,
      error: err instanceof Error ? err.message : 'Unknown execution error',
      duration: Date.now() - startTime,
      timedOut: isTimeout,
    }
  }
}

/**
 * Execute handler code in a sandboxed context
 * Uses Function constructor for basic sandboxing (same pattern as plugin-runner.ts)
 *
 * The handler code should export a function called `handler` that receives (args) and returns a result.
 * Alternatively, the code can be a self-executing function.
 */
async function executeInSandbox(
  code: string,
  args: Record<string, unknown>,
  sandbox: Record<string, unknown>
): Promise<unknown> {
  // Wrap code: if it defines a `handler` function, call it with args
  // Otherwise, wrap as an IIFE
  const wrappedCode = `
    ${code}
    if (typeof handler === 'function') {
      return handler(args, sandbox);
    } else {
      throw new Error('No "handler" function found in custom tool code. Define: function handler(args, sandbox) { ... }');
    }
  `

  const sandboxKeys = Object.keys(sandbox)
  const sandboxValues = Object.values(sandbox)

  try {
    // Execute in strict mode with limited context
    const fn = new Function('args', 'sandbox', ...sandboxKeys, `"use strict";\n` + wrappedCode)
    const result = fn(args, sandbox, ...sandboxValues)

    // Handle async results
    if (result instanceof Promise) {
      return await result
    }
    return result
  } catch (err) {
    throw new Error(`Custom tool execution error: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// ==================== DB LOAD ====================

/**
 * Load all enabled custom tools from DB into the in-memory registry.
 * Call this on startup or when needed for hot reload.
 */
export async function loadCustomToolsFromDB(): Promise<{
  loaded: number
  failed: number
  results: Array<{ name: string; loaded: boolean; error?: string }>
}> {
  const results: Array<{ name: string; loaded: boolean; error?: string }> = []
  let loaded = 0
  let failed = 0

  try {
    const tools = await db.customTool.findMany({
      where: { enabled: true },
    })

    for (const tool of tools) {
      try {
        // Parse parameters JSON
        let parameters: Record<string, unknown>
        try {
          parameters = JSON.parse(tool.parameters)
        } catch {
          results.push({ name: tool.name, loaded: false, error: 'Invalid parameters JSON' })
          failed++
          continue
        }

        const entry: CustomToolEntry = {
          id: tool.id,
          name: tool.name,
          description: tool.description,
          parameters,
          handlerCode: tool.handlerCode,
          version: tool.version,
          source: tool.source,
          category: tool.category,
          enabled: tool.enabled,
          isPublic: tool.isPublic,
          skillSlug: tool.skillSlug,
          callCount: tool.callCount,
          createdAt: tool.createdAt,
          updatedAt: tool.updatedAt,
        }

        // Register in memory + gateway (best effort)
        await registerCustomTool(entry, true)
        results.push({ name: tool.name, loaded: true })
        loaded++
      } catch (err) {
        results.push({
          name: tool.name,
          loaded: false,
          error: err instanceof Error ? err.message : 'Unknown error',
        })
        failed++
      }
    }
  } catch (err) {
    console.error('[CustomToolRegistry] Failed to load from DB:', err)
  }

  console.log(`[CustomToolRegistry] Loaded ${loaded} custom tools from DB (${failed} failed)`)
  return { loaded, failed, results }
}

/**
 * Clear the entire in-memory registry (useful for testing or reset)
 */
export function clearRegistry(): void {
  registry.clear()
}

// ==================== AGENT-FACING API (user request 2026-08-30) ====================
// Agents TỰ VIẾT tools khi cần (create_custom_tool) và DÙNG NGAY sau đó.
// Mỗi custom tool được lưu DB (persist qua restart) + tạo AgentSkill companion
// (source 'agent-tool') để hiện trong ô "SKILL.md Guides" của module Skills.

/** Lazy-load flag — registry tự nạp từ DB ở lần truy cập đầu tiên */
let dbLoaded = false

/**
 * Đảm bảo registry đã nạp custom tools từ DB (idempotent, fail-open).
 * Gọi ở executeTool dispatch + chat route whitelist check.
 */
export async function ensureCustomToolsLoaded(): Promise<void> {
  if (dbLoaded) return
  dbLoaded = true
  try {
    await loadCustomToolsFromDB()
  } catch (err) {
    console.warn('[CustomToolRegistry] Lazy load failed:', err instanceof Error ? err.message : String(err))
  }
}

/** Sync check — tool này có phải custom tool đã register không? */
export function isCustomToolRegistered(name: string): boolean {
  const entry = registry.get(name)
  return !!entry && entry.tool.enabled
}

/** Danh sách tên custom tools đang enabled (sync) */
export function getCustomToolNames(): string[] {
  const names: string[] = []
  for (const entry of registry.values()) {
    if (entry.tool.enabled) names.push(entry.tool.name)
  }
  return names
}

export interface CreateCustomToolResult {
  success: boolean
  toolName?: string
  skillSlug?: string
  error?: string
  usage?: string
}

/**
 * Agent/user tạo custom tool MỚI — validate + save DB + register in-memory
 * (dùng được NGAY trong cùng ReAct loop) + tạo AgentSkill companion để hiện
 * trong ô SKILL.md Guides.
 */
export async function createCustomTool(input: {
  name: string
  description: string
  parameters: Record<string, unknown>
  handlerCode: string
  skillMd?: string
  source?: string
  category?: string
}): Promise<CreateCustomToolResult> {
  const { name, description, parameters, handlerCode } = input

  // ===== Validate name =====
  if (!name || typeof name !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    return { success: false, error: 'Invalid tool name — phải bắt đầu bằng chữ/c underscore, chỉ chứa [a-zA-Z0-9_]' }
  }
  if (isToolNameTaken(name)) {
    return { success: false, error: `Tool name "${name}" bị trùng với built-in/gateway tool hoặc custom tool đã có` }
  }
  const existing = await db.customTool.findUnique({ where: { name } })
  if (existing) {
    return { success: false, error: `Custom tool "${name}" đã tồn tại trong DB` }
  }

  // ===== Validate description =====
  if (!description || typeof description !== 'string') {
    return { success: false, error: 'Thiếu description' }
  }

  // ===== Validate parameters (JSON schema object) =====
  let paramsSchema: Record<string, unknown>
  if (typeof parameters === 'string') {
    try {
      paramsSchema = JSON.parse(parameters)
    } catch {
      return { success: false, error: 'parameters là JSON string không hợp lệ' }
    }
  } else if (parameters && typeof parameters === 'object') {
    paramsSchema = parameters
  } else {
    paramsSchema = { type: 'object', properties: {} }
  }
  if (paramsSchema.type !== 'object') {
    // ép type='object' (duplicate key tsc TS1117 — chỉ cần 1 lần, giá trị cuối vẫn 'object')
    paramsSchema = { ...paramsSchema, type: 'object' } as Record<string, unknown>
  }

  // ===== Validate handler code (sandbox security) =====
  const codeCheck = validateHandlerCode(handlerCode, name)
  if (!codeCheck.safe) {
    return { success: false, error: `Handler code không đạt security check: ${codeCheck.error}` }
  }
  // Phải định nghĩa function handler(args, sandbox)
  if (!/\bfunction\s+handler\s*\(|\bhandler\s*=\s*(async\s*)?\(|const\s+handler\s*=/.test(handlerCode)) {
    return { success: false, error: 'Handler code phải định nghĩa: function handler(args, sandbox) { ... return result }' }
  }

  // ===== Save DB =====
  const source = input.source === 'user' ? 'user' : 'agent'
  const category = input.category || 'custom'
  const saved = await db.customTool.create({
    data: {
      name,
      description,
      parameters: JSON.stringify(paramsSchema),
      handlerCode,
      source,
      category,
      enabled: true,
    },
  })

  // ===== Register in-memory (hot — dùng ngay) =====
  const entry: CustomToolEntry = {
    id: saved.id,
    name: saved.name,
    description: saved.description,
    parameters: paramsSchema,
    handlerCode: saved.handlerCode,
    version: saved.version,
    source: saved.source,
    category: saved.category,
    enabled: saved.enabled,
    isPublic: saved.isPublic,
    skillSlug: null,
    callCount: 0,
    createdAt: saved.createdAt,
    updatedAt: saved.updatedAt,
  }
  await registerCustomTool(entry, true)

  // ===== AgentSkill companion → hiện trong ô SKILL.md Guides =====
  const skillSlug = `tool-${name}`
  const skillMdContent =
    input.skillMd && input.skillMd.trim()
      ? input.skillMd
      : `# Tool: ${name}

## Description
${description}

## When to Use
- Gọi tool \`${name}\` khi cần: ${description.slice(0, 150)}

## How to Use
tool_call: ${name}(${JSON.stringify(
          Object.entries((paramsSchema.properties as Record<string, { description?: string; type?: string }>) || {})
            .slice(0, 3)
            .map(([k, v]) => `"${k}": <${v.type || 'string'}${v.description ? ` — ${v.description}` : ''}>`)
        )})

## Handler
Tool này do agent TỰ VIẾT (create_custom_tool) — handler JS chạy trong sandbox
(fetch HTTP được phép, KHÔNG truy cập filesystem/process). Source code lưu trong
CustomTool DB table, gọi trực tiếp qua tool_call: ${name}({...}).

## Rules
- Kết quả trả về bị giới hạn ~2000 ký tự (truncated)
- Timeout 10s
- Tool bị lỗi → báo lỗi rõ ràng, KHÔNG bịa kết quả`

  try {
    await db.agentSkill.upsert({
      where: { agentId_slug: { agentId: 'default', slug: skillSlug } },
      create: {
        agentId: 'default',
        slug: skillSlug,
        name: `🔧 ${name}`,
        content: skillMdContent,
        source: 'agent-tool',
        enabled: true,
        version: saved.version,
      },
      update: { content: skillMdContent, enabled: true },
    })
    await db.customTool.update({ where: { id: saved.id }, data: { skillSlug } })
    entry.skillSlug = skillSlug

    // Filesystem sync cho z.ai platform layer
    try {
      const { writeFileSync, mkdirSync } = await import('fs')
      const { join } = await import('path')
      const skillsDir = join(process.cwd(), 'skills', skillSlug)
      mkdirSync(skillsDir, { recursive: true })
      writeFileSync(join(skillsDir, 'SKILL.md'), skillMdContent, 'utf-8')
    } catch { /* non-fatal */ }
  } catch (skillErr) {
    console.warn('[CustomToolRegistry] AgentSkill companion failed (non-blocking):', skillErr instanceof Error ? skillErr.message : String(skillErr))
  }

  const paramNames = Object.keys((paramsSchema.properties as Record<string, unknown>) || {})
  const usage = paramNames.length > 0
    ? `tool_call: ${name}({${paramNames.map(p => `"${p}": ...`).join(', ')}})`
    : `tool_call: ${name}({})`

  console.log(`[CustomToolRegistry] Agent created custom tool "${name}" + skill "${skillSlug}"`)
  return { success: true, toolName: name, skillSlug, usage }
}

/**
 * Xóa custom tool (kèm AgentSkill companion). Chỉ tool source 'agent'/'user'
 * (built-in không đụng được).
 */
export async function deleteCustomTool(name: string): Promise<{ success: boolean; error?: string }> {
  const existing = await db.customTool.findUnique({ where: { name } })
  if (!existing) return { success: false, error: `Custom tool "${name}" không tồn tại` }

  await db.customTool.delete({ where: { name } })
  await unregisterCustomTool(name)

  // Gỡ AgentSkill companion + filesystem
  if (existing.skillSlug) {
    try {
      await db.agentSkill.deleteMany({ where: { slug: existing.skillSlug } })
      const { unlinkSync, existsSync, rmdirSync, readdirSync } = await import('fs')
      const { join } = await import('path')
      const skillDir = join(process.cwd(), 'skills', existing.skillSlug)
      const skillFile = join(skillDir, 'SKILL.md')
      if (existsSync(skillFile)) unlinkSync(skillFile)
      if (existsSync(skillDir)) {
        try { if (readdirSync(skillDir).length === 0) rmdirSync(skillDir) } catch { /* ignore */ }
      }
    } catch { /* non-fatal */ }
  }

  console.log(`[CustomToolRegistry] Deleted custom tool "${name}"`)
  return { success: true }
}
