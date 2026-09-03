/**
 * Agent Profiles API — CRUD Management
 *
 * GET    /api/agents          — List all agents (optional ?team=code|research, ?enabled=true|false, ?id=xxx)
 * POST   /api/agents          — Create new agent
 * PUT    /api/agents          — Update agent
 * DELETE /api/agents?id=xxx   — Delete agent
 */

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import {
  PROVIDER_MODELS,
  VALID_PROVIDERS,
  VALID_DOMAINS,
  TEAM_POSITIONS,
  AGENT_NAME_MIN,
  AGENT_NAME_MAX,
  AGENT_DESCRIPTION_MAX,
  AGENT_INSTRUCTION_MAX,
  AGENT_TEMPERATURE_MIN,
  AGENT_TEMPERATURE_MAX,
  AGENT_MAX_TOKENS_MIN,
  AGENT_MAX_TOKENS_MAX,
} from '@/lib/agent-constants'
import { ensureCodeTeamAgents, ensureMCPBridgeConfig } from '@/lib/code-team/agents'
import { ensureStandaloneAgents } from '@/lib/standalone-agents'
// RESEARCH TEAM SEED (Task 3-fix WORK 2): ensure 5 research agents
// (NEMESIS/SIVIL/BELI/LISMA/HAN) exist — lazy-seed trên GET /api/agents để
// Agents module → Team Research section hiển thị đầy đủ roster (TB-01 §1).
import { ensureResearchTeamAgents } from '@/lib/research-team/agents'
// AGENT ROSTER (user request 2026-09-08): sau khi tạo/sửa/xóa agent → invalidate
// roster cache để danh bạ kỹ năng inject vào system prompt của agents cập nhật.
import { invalidateRosterCache } from '@/lib/agent-roster'
// DB SELF-HEAL (fix "local không load agents" 2026-09-09): DB local cũ hơn
// schema sau git pull → query lỗi P2021/P2022 → thay vì trả fallback rỗng câm
// lặng, tự chạy prisma db push rồi THỬ LẠI một lần.
import { ensureDbReady } from '@/lib/db-setup'

// ==================== DB RETRY HELPER ====================

/** Check if a DB error is transient (SQLite busy, lock, etc.) */
function isTransientDbError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.includes('SQLITE_BUSY') ||
    msg.includes('SQLITE_LOCKED') ||
    msg.includes('database is locked') ||
    msg.includes(' SQLITE_BUSY') ||
    msg.includes('Resource temporarily unavailable') ||
    msg.includes('Could not establish connection') ||
    msg.includes('timed out')
}

/** Retry a DB operation with exponential backoff for transient SQLite errors */
async function retryDbOp<T>(
  op: () => Promise<T>,
  maxRetries = 3,
  baseDelayMs = 500
): Promise<T> {
  let lastErr: unknown
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await op()
    } catch (err) {
      lastErr = err
      if (!isTransientDbError(err) || attempt === maxRetries) break
      const delay = baseDelayMs * Math.pow(2, attempt)
      console.log(`[Agents API] DB busy, retry ${attempt + 1}/${maxRetries} in ${delay}ms...`)
      await new Promise(resolve => setTimeout(resolve, delay))
    }
  }
  throw lastErr
}

export const dynamic = 'force-dynamic'

// ==================== VALIDATION HELPERS ====================

function validateProvider(provider: string): string | null {
  if (!VALID_PROVIDERS.includes(provider)) {
    return `Provider "${provider}" không hợp lệ. Chọn: ${VALID_PROVIDERS.join(', ')}`
  }
  return null
}

function validateModel(provider: string, model: string): string | null {
  const models = PROVIDER_MODELS[provider]
  if (!models) return `Provider "${provider}" không có models`
  if (!models.some(m => m.id === model)) {
    return `Model "${model}" không thuộc provider "${provider}". Các models khả dụng: ${models.map(m => m.id).join(', ')}`
  }
  return null
}

function validateTeamPosition(team: string | null | undefined, position: string | null | undefined): string | null {
  if (!team) {
    // No team — position must be null
    if (position) return 'Không thể có position khi chưa chọn Team'
    return null
  }
  if (team !== 'code' && team !== 'research') {
    return `Team "${team}" không hợp lệ. Chọn: code, research`
  }
  if (!position) {
    return 'Vui lòng chọn vị trí trong Team'
  }
  const validPositions = TEAM_POSITIONS[team]
  if (!validPositions.includes(position)) {
    return `Position "${position}" không hợp lệ cho Team "${team}". Chọn: ${validPositions.join(', ')}`
  }
  return null
}

function validateTemperature(temp: number): string | null {
  if (temp < AGENT_TEMPERATURE_MIN || temp > AGENT_TEMPERATURE_MAX) return `Temperature phải từ ${AGENT_TEMPERATURE_MIN} đến ${AGENT_TEMPERATURE_MAX}`
  return null
}

function validateMaxTokens(tokens: number): string | null {
  if (tokens < AGENT_MAX_TOKENS_MIN || tokens > AGENT_MAX_TOKENS_MAX) return `Max Tokens phải từ ${AGENT_MAX_TOKENS_MIN} đến ${AGENT_MAX_TOKENS_MAX}`
  return null
}

function validateDomain(domain: string): string | null {
  if (!VALID_DOMAINS.includes(domain)) {
    return `Domain "${domain}" không hợp lệ. Chọn: ${VALID_DOMAINS.join(', ')}`
  }
  return null
}

// ==================== GET — LIST AGENTS ====================

export async function GET(request: NextRequest) {
  return getAgentsHandler(request, 0)
}

/**
 * Handler nội bộ với attempt-count: gặp DB error (schema drift) → tự heal qua
 * ensureDbReady({force:true}) → retry 1 lần. Đây là đường tự chữa KHÔNG cần
 * restart — user pull code mới là dùng được ngay, không cần nhớ `db:push`.
 */
async function getAgentsHandler(request: NextRequest, attempt: number): Promise<Response> {
  try {
    // Auto-seed Code Team + Standalone + Research Team + OPUS meta-agent on first
    // agents fetch (idempotent, cached). Research Team added in Task 3-fix WORK 2
    // — ensures NEMESIS/SIVIL/BELI/LISMA/HAN always present in DB.
    const { ensureOpusAgent } = await import('@/lib/opus/opus-agent')
    await Promise.all([
      ensureCodeTeamAgents(),
      ensureStandaloneAgents(),
      ensureMCPBridgeConfig(),
      ensureOpusAgent(),
      ensureResearchTeamAgents(),
    ])

    const { searchParams } = new URL(request.url)
    const id = searchParams.get('id')
    const team = searchParams.get('team')
    const enabled = searchParams.get('enabled')

    if (id) {
      // Get single agent by ID
      const agent = await retryDbOp(() => db.agentProfile.findUnique({
        where: { id },
        include: { sessions: { take: 10, orderBy: { updatedAt: 'desc' } } },
      }))
      if (!agent) {
        return NextResponse.json({ error: 'Agent không tồn tại' }, { status: 404 })
      }
      return NextResponse.json({ agent })
    }

    // List agents with optional team filter
    const where: Record<string, unknown> = {}
    if (team) where.team = team
    if (enabled !== null) where.enabled = enabled === 'true'

    const [agents, total] = await retryDbOp(() => Promise.all([
      db.agentProfile.findMany({
        where,
        include: { sessions: { take: 5, orderBy: { updatedAt: 'desc' } } },
        orderBy: { createdAt: 'desc' },
      }),
      db.agentProfile.count({ where }),
    ]))

    return NextResponse.json({ agents, total })
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    console.error('[Agents API] GET error:', errMsg)
    // Return safe fallback instead of 500 — allows UI to render even if DB is not ready
    const isDbError = errMsg.includes('no such table') || errMsg.includes('does not exist') ||
      errMsg.includes('SQLITE_ERROR') || errMsg.includes('Prisma Client') ||
      errMsg.includes('Unable to open') || errMsg.includes('SQLITE_BUSY') ||
      errMsg.includes('database is locked') || errMsg.includes('SQLITE_LOCKED')

    // SELF-HEAL (2026-09-09): DB error thường là schema drift (DB local cũ sau
    // git pull). Tự migrate rồi thử lại NGAY trong cùng request — không restart.
    if (isDbError && attempt === 0) {
      const healed = await ensureDbReady({ force: true })
      if (healed.ok) {
        console.log('[Agents API] DB đã tự đồng bộ schema — retry GET agents')
        return getAgentsHandler(request, 1)
      }
      console.error('[Agents API] Self-heal thất bại:', healed.reason)
    }

    if (isDbError) {
      return NextResponse.json({
        agents: [],
        total: 0,
        source: 'fallback',
        warning: `Database chưa khớp schema và không tự sửa được (${(healReasonOf(errMsg))}). Chạy thủ công: bun run db:push`,
      })
    }
    return NextResponse.json(
      { error: 'Failed to list agents', details: errMsg },
      { status: 500 }
    )
  }
}

/** Rút gọn lý do heal thất bại cho warning trả về UI */
function healReasonOf(errMsg: string): string {
  return errMsg.slice(0, 160)
}

// ==================== POST — CREATE AGENT ====================

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const {
      name, description, instruction, domain, capable,
      provider, model, temperature, maxTokens,
      team, position, avatar, tools,
    } = body

    // Validate required fields
    if (!name || typeof name !== 'string' || name.trim().length < AGENT_NAME_MIN || name.trim().length > AGENT_NAME_MAX) {
      return NextResponse.json({ error: `Tên Agent phải từ ${AGENT_NAME_MIN}-${AGENT_NAME_MAX} ký tự` }, { status: 400 })
    }
    if (!description || typeof description !== 'string' || description.trim().length === 0) {
      return NextResponse.json({ error: 'Mô tả vai trò không được để trống' }, { status: 400 })
    }
    if (description.trim().length > AGENT_DESCRIPTION_MAX) {
      return NextResponse.json({ error: `Mô tả vai trò không được quá ${AGENT_DESCRIPTION_MAX} ký tự` }, { status: 400 })
    }
    if (!instruction || typeof instruction !== 'string' || instruction.trim().length === 0) {
      return NextResponse.json({ error: 'Hướng dẫn chi tiết không được để trống' }, { status: 400 })
    }
    if (instruction.trim().length > AGENT_INSTRUCTION_MAX) {
      return NextResponse.json({ error: `Hướng dẫn chi tiết không được quá ${AGENT_INSTRUCTION_MAX} ký tự` }, { status: 400 })
    }
    // Domain and capable are optional — defaults applied if not provided
    const domainValue = domain || 'mixed'
    const domainError = validateDomain(domainValue)
    if (domainError) return NextResponse.json({ error: domainError }, { status: 400 })

    // Validate provider
    if (!provider) return NextResponse.json({ error: 'Vui lòng chọn Provider' }, { status: 400 })
    const providerError = validateProvider(provider)
    if (providerError) return NextResponse.json({ error: providerError }, { status: 400 })

    // Validate model
    if (!model) return NextResponse.json({ error: 'Vui lòng chọn Model' }, { status: 400 })
    const modelError = validateModel(provider, model)
    if (modelError) return NextResponse.json({ error: modelError }, { status: 400 })

    // Validate temperature
    const tempValue = temperature ?? 0.7
    const tempError = validateTemperature(tempValue)
    if (tempError) return NextResponse.json({ error: tempError }, { status: 400 })

    // Validate maxTokens
    const tokensValue = maxTokens ?? 4096
    const tokensError = validateMaxTokens(tokensValue)
    if (tokensError) return NextResponse.json({ error: tokensError }, { status: 400 })

    // Validate team + position
    const teamError = validateTeamPosition(team || null, position || null)
    if (teamError) return NextResponse.json({ error: teamError }, { status: 400 })

    // Check Code Team position reservation — non-system agents cannot take Code Team positions
    if (team === 'code' && position) {
      const reservedPositions = ['TL', 'G1', 'G2-A', 'G2-B', 'G3']
      if (reservedPositions.includes(position)) {
        const existingHolder = await db.agentProfile.findFirst({
          where: { team: 'code', position, isSystem: true },
        })
        if (existingHolder) {
          return NextResponse.json({
            error: `Position "${position}" đã được giữ bởi Agent hệ thống "${existingHolder.name}". Vui lòng chọn position khác hoặc để trống.`,
          }, { status: 409 })
        }
      }
    }

    // Check unique name
    const existing = await db.agentProfile.findUnique({ where: { name: name.trim() } })
    if (existing) {
      return NextResponse.json({ error: `Tên Agent "${name.trim()}" đã tồn tại` }, { status: 409 })
    }

    // Create agent
    const agent = await db.agentProfile.create({
      data: {
        name: name.trim(),
        description: description.trim(),
        instruction: instruction.trim(),
        domain: domainValue,
        capable: capable ? capable.trim() : '',
        provider,
        model,
        temperature: tempValue,
        maxTokens: tokensValue,
        team: team || null,
        position: position || null,
        avatar: avatar || '🤖',
        // TOOLSET (user request 2026-09-08 — Agent Factory): whitelist tools riêng
        // cho agent (JSON string). UI/Omega create_agent có thể chỉ định; null =
        // mọi tool đều được phép (hành vi cũ).
        tools: Array.isArray(tools) && tools.length > 0 ? JSON.stringify(tools.map((t: unknown) => String(t))) : null,
      },
    })

    invalidateRosterCache()

    return NextResponse.json({ agent }, { status: 201 })
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to create agent', details: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    )
  }
}

// ==================== PUT — UPDATE AGENT ====================

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json()
    const { id, name, description, instruction, domain, capable,
      provider, model, temperature, maxTokens,
      team, position, avatar, enabled, tools } = body

    if (!id) {
      return NextResponse.json({ error: 'Agent ID là bắt buộc' }, { status: 400 })
    }

    // Check agent exists
    const existing = await db.agentProfile.findUnique({ where: { id } })
    if (!existing) {
      return NextResponse.json({ error: 'Agent không tồn tại' }, { status: 404 })
    }

    // Build update data
    const updateData: Record<string, unknown> = {}

    if (name !== undefined) {
      if (typeof name !== 'string' || name.trim().length < AGENT_NAME_MIN || name.trim().length > AGENT_NAME_MAX) {
        return NextResponse.json({ error: `Tên Agent phải từ ${AGENT_NAME_MIN}-${AGENT_NAME_MAX} ký tự` }, { status: 400 })
      }
      // Check unique name (excluding self)
      const nameConflict = await db.agentProfile.findFirst({
        where: { name: name.trim(), NOT: { id } },
      })
      if (nameConflict) {
        return NextResponse.json({ error: `Tên Agent "${name.trim()}" đã tồn tại` }, { status: 409 })
      }
      updateData.name = name.trim()
    }

    if (description !== undefined) {
      if (typeof description !== 'string' || description.trim().length === 0) {
        return NextResponse.json({ error: 'Mô tả vai trò không được để trống' }, { status: 400 })
      }
      if (description.trim().length > AGENT_DESCRIPTION_MAX) {
        return NextResponse.json({ error: `Mô tả vai trò không được quá ${AGENT_DESCRIPTION_MAX} ký tự` }, { status: 400 })
      }
      updateData.description = description.trim()
    }

    if (instruction !== undefined) {
      if (typeof instruction !== 'string' || instruction.trim().length === 0) {
        return NextResponse.json({ error: 'Hướng dẫn chi tiết không được để trống' }, { status: 400 })
      }
      if (instruction.trim().length > AGENT_INSTRUCTION_MAX) {
        return NextResponse.json({ error: `Hướng dẫn chi tiết không được quá ${AGENT_INSTRUCTION_MAX} ký tự` }, { status: 400 })
      }
      updateData.instruction = instruction.trim()
    }

    if (capable !== undefined) {
      updateData.capable = typeof capable === 'string' ? capable.trim() : ''
    }

    if (domain !== undefined) {
      const domainError = validateDomain(domain)
      if (domainError) return NextResponse.json({ error: domainError }, { status: 400 })
      updateData.domain = domain
    }

    // Provider + Model: if changing provider, must also provide model
    const effectiveProvider = provider ?? existing.provider

    if (provider !== undefined) {
      const providerError = validateProvider(provider)
      if (providerError) return NextResponse.json({ error: providerError }, { status: 400 })
      updateData.provider = provider
    }

    if (model !== undefined) {
      const modelError = validateModel(effectiveProvider, model)
      if (modelError) return NextResponse.json({ error: modelError }, { status: 400 })
      updateData.model = model
    }

    // Cross-validate: if provider changed but model wasn't provided, check if old model is still valid
    if (provider !== undefined && model === undefined) {
      const modelError = validateModel(provider, existing.model)
      if (modelError) {
        return NextResponse.json({
          error: `Model "${existing.model}" không thuộc provider "${provider}". Vui lòng chọn model mới khi đổi provider.`,
        }, { status: 400 })
      }
    }

    if (temperature !== undefined) {
      const tempError = validateTemperature(temperature)
      if (tempError) return NextResponse.json({ error: tempError }, { status: 400 })
      updateData.temperature = temperature
    }

    if (maxTokens !== undefined) {
      const tokensError = validateMaxTokens(maxTokens)
      if (tokensError) return NextResponse.json({ error: tokensError }, { status: 400 })
      updateData.maxTokens = maxTokens
    }

    // Team + Position handling
    if (team !== undefined) {
      if (team === null) {
        // Remove from team — also clear position
        updateData.team = null
        updateData.position = null
      } else {
        const effectiveTeam = team
        const effectivePosition = position ?? existing.position
        const teamError = validateTeamPosition(effectiveTeam, effectivePosition)
        if (teamError) return NextResponse.json({ error: teamError }, { status: 400 })
        updateData.team = effectiveTeam
        if (position !== undefined) updateData.position = position
      }
    } else if (position !== undefined) {
      // Position changed without team change — validate against existing team
      const effectiveTeam = existing.team
      const teamError = validateTeamPosition(effectiveTeam, position)
      if (teamError) return NextResponse.json({ error: teamError }, { status: 400 })
      updateData.position = position
    }

    // Check Code Team position reservation for non-system agents
    const effectiveTeam2 = (updateData.team as string | null | undefined) ?? existing.team
    const effectivePosition2 = (updateData.position as string | null | undefined) ?? existing.position
    if (effectiveTeam2 === 'code' && effectivePosition2 && !existing.isSystem) {
      const reservedPositions = ['TL', 'G1', 'G2-A', 'G2-B', 'G3']
      if (reservedPositions.includes(effectivePosition2)) {
        const existingHolder = await db.agentProfile.findFirst({
          where: { team: 'code', position: effectivePosition2, isSystem: true, NOT: { id } },
        })
        if (existingHolder) {
          return NextResponse.json({
            error: `Position "${effectivePosition2}" đã được giữ bởi Agent hệ thống "${existingHolder.name}". Vui lòng chọn position khác.`,
          }, { status: 409 })
        }
      }
    }

    if (avatar !== undefined) updateData.avatar = avatar
    if (enabled !== undefined) updateData.enabled = enabled

    // TOOLSET (user request 2026-09-08 — Agent Factory): cập nhật whitelist tools
    if (tools !== undefined) {
      updateData.tools = Array.isArray(tools) && tools.length > 0
        ? JSON.stringify(tools.map((t: unknown) => String(t)))
        : null
    }

    // Apply update
    const updated = await db.agentProfile.update({
      where: { id },
      data: updateData,
    })

    invalidateRosterCache()

    return NextResponse.json({ agent: updated })
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to update agent', details: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    )
  }
}

// ==================== DELETE — DELETE AGENT ====================

export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const id = searchParams.get('id')

    if (!id) {
      return NextResponse.json({ error: 'Agent ID là bắt buộc (?id=xxx)' }, { status: 400 })
    }

    // Check agent exists
    const existing = await db.agentProfile.findUnique({ where: { id } })
    if (!existing) {
      return NextResponse.json({ error: 'Agent không tồn tại' }, { status: 404 })
    }

    // Protect system agents from deletion
    if (existing.isSystem) {
      return NextResponse.json({ error: `Agent hệ thống "${existing.name}" không thể xóa. Bạn có thể tắt (disable) hoặc tùy chỉnh thay vì xóa.` }, { status: 403 })
    }

    // Unlink all related sessions (set agentProfileId = null, keep chat history)
    await db.agentSession.updateMany({
      where: { agentProfileId: id },
      data: { agentProfileId: null },
    })

    // Delete the agent
    await db.agentProfile.delete({ where: { id } })

    invalidateRosterCache()

    return NextResponse.json({
      success: true,
      deletedAgent: { id, name: existing.name },
      message: `Đã xóa Agent "${existing.name}". Các phiên chat liên quan được giữ lại.`,
    })
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to delete agent', details: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    )
  }
}
