# Smolab Implementation Plan — Session Isolation & Background Task System

## Tổng quan

Mục tiêu: Xây dựng hệ thống Smolab chat với:
1. **Bắt buộc chọn Agent/Team** trước khi chat
2. **Isolation nghiêm ngặt** — Mỗi Agent/Team có phiên chat riêng, không xem được của nhau
3. **Background Task** — Khi chuyển phiên, phiên cũ tiếp tục chạy nền, quay lại vẫn thấy kết quả

---

## Phase 1: Database Schema — Nền tảng dữ liệu

### Mục tiêu
Thêm model `SmolabTask` vào Prisma schema, cập nhật `AgentSession` để bắt buộc `agentProfileId`.

### Chi tiết triển khai

#### 1.1 Thêm model `SmolabTask` vào file `prisma/schema.prisma`

**Vị trí chèn**: Sau model `ChatMessage` (khoảng dòng 578), trước section `Agent Memory & Learning System`.

**Code cần thêm**:
```prisma
// ============================================
// SMOLAB BACKGROUND TASK SYSTEM
// Chat sessions isolation + background task continuation
// ============================================

/// Smolab background tasks — tracks long-running agent/team work that continues
/// even when user switches to another session. Each task is tied to one session
/// and one agent (or team lead agent).
model SmolabTask {
  id              String   @id @default(cuid())
  type            String   /// "agent_chat" | "team_workflow" | "agent_react" | "memory_extraction"
  status          String   @default("pending") /// "pending" | "running" | "completed" | "failed" | "cancelled"
  progress        Int      @default(0) /// 0-100 percentage

  // Liên kết Session + Agent
  sessionId       String   /// AgentSession.sessionId — phiên chat gốc
  agentProfileId  String?  /// AgentProfile.id — agent đang xử lý (null nếu team mode)
  teamName        String?  /// "code" | "research" — team đang xử lý (nếu team mode)

  // Task input/output
  inputSummary    String?  @db.Text /// Tóm tắt yêu cầu (first 200 chars của user message)
  result          String?  @db.Text /// Kết quả khi hoàn thành (JSON)
  error           String?  @db.Text /// Lỗi nếu thất bại

  // Thời gian
  createdAt       DateTime @default(now())
  startedAt       DateTime?
  completedAt     DateTime?
  updatedAt       DateTime @updatedAt

  // Relations
  session         AgentSession  @relation(fields: [sessionId], references: [sessionId])

  @@index([sessionId])
  @@index([agentProfileId, status])
  @@index([teamName, status])
  @@index([status])
  @@index([createdAt])
}
```

#### 1.2 Cập nhật model `AgentSession`

**File**: `prisma/schema.prisma`
**Thay đổi**: Thêm relation `tasks` và giữ `agentProfileId` nullable (để tương thích với session cũ, nhưng validate ở API layer).

**Sửa trong model AgentSession** (khoảng dòng 218-238):
```prisma
model AgentSession {
  id              String   @id @default(cuid())
  agentId         String   @default("default")
  sessionId       String   @unique
  model           String?
  provider        String?
  title           String?
  messageCount    Int      @default(0)
  agentProfileId  String?  /// FK → AgentProfile.id — BẮT BUỘC khi tạo session mới (validate ở API)
  teamMode        String?  /// "single" | "multi" — null = legacy session
  teamName        String?  /// "code" | "research" — null = single mode or legacy
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  agentProfile    AgentProfile? @relation(fields: [agentProfileId], references: [id], onDelete: SetNull)
  tasks           SmolabTask[]  /// ← THÊM DÒNG NÀY

  @@index([agentId])
  @@index([agentProfileId])
  @@index([teamName])
  @@index([createdAt])
}
```

#### 1.3 Chạy migration

```bash
cd /home/z/my-project
bun run db:push
```

### Kết quả Phase 1
- Database có model `SmolabTask` mới
- `AgentSession` có relation `tasks` tới `SmolabTask`
- Schema đã push vào SQLite

---

## Phase 2: Backend — Session Manager + Validation

### Mục tiêu
Tạo module `session-manager.ts` quản lý isolation, validate agent/team bắt buộc, cập nhật API sessions/chat.

### Chi tiết triển khai

#### 2.1 Tạo file `src/lib/smolab/session-manager.ts`

**Nội dung**:

```typescript
/**
 * Smolab Session Manager — Isolation & Validation
 * 
 * Rules:
 *   1. Chat PHẢI có agentProfileId (single mode) hoặc teamName (multi mode)
 *   2. Sessions chỉ hiển thị cho agent/team đang chọn
 *   3. Không thể chat mà chưa chọn agent/team
 *   4. Mỗi session thuộc đúng 1 agent hoặc 1 team
 */

import { db } from '@/lib/db'

// ==================== VALIDATION ====================

export interface ChatContext {
  mode: 'single' | 'multi'
  agentProfileId?: string | null
  teamName?: string | null
  sessionId?: string | null
}

/** Validate chat context — throw nếu thiếu agent/team */
export function validateChatContext(ctx: ChatContext): {
  valid: boolean
  error?: string
} {
  if (ctx.mode === 'single') {
    if (!ctx.agentProfileId) {
      return { valid: false, error: 'Vui lòng chọn Agent trước khi chat' }
    }
  } else if (ctx.mode === 'multi') {
    if (!ctx.teamName) {
      return { valid: false, error: 'Vui lòng chọn Team trước khi chat' }
    }
  } else {
    return { valid: false, error: 'Chế độ chat không hợp lệ' }
  }
  return { valid: true }
}

// ==================== SESSION ISOLATION ====================

/** Lấy sessions cho 1 agent cụ thể (single mode) */
export async function getSessionsForAgent(agentProfileId: string) {
  return db.agentSession.findMany({
    where: {
      agentProfileId,
      teamMode: 'single',
    },
    orderBy: { updatedAt: 'desc' },
    include: {
      tasks: {
        where: { status: { in: ['pending', 'running'] } },
        select: { id: true, type: true, status: true, progress: true, inputSummary: true },
      },
    },
  })
}

/** Lấy sessions cho 1 team cụ thể (multi mode) */
export async function getSessionsForTeam(teamName: string) {
  return db.agentSession.findMany({
    where: {
      teamName,
      teamMode: 'multi',
    },
    orderBy: { updatedAt: 'desc' },
    include: {
      tasks: {
        where: { status: { in: ['pending', 'running'] } },
        select: { id: true, type: true, status: true, progress: true, inputSummary: true },
      },
    },
  })
}

/** Tạo session mới với isolation — BẮT BUỘC có agentProfileId hoặc teamName */
export async function createIsolatedSession(params: {
  mode: 'single' | 'multi'
  agentProfileId?: string
  teamName?: string
  title?: string
  model?: string
  provider?: string
}) {
  const { mode, agentProfileId, teamName, title, model, provider } = params

  // Validate
  const validation = validateChatContext({ mode, agentProfileId, teamName })
  if (!validation.valid) {
    throw new Error(validation.error)
  }

  // Tạo sessionId unique
  const sessionId = `${mode === 'single' ? 'agent' : 'team'}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

  // Nếu multi mode, tìm TL agent để gán agentProfileId
  let resolvedAgentProfileId = agentProfileId
  if (mode === 'multi' && teamName) {
    const tl = await db.agentProfile.findFirst({
      where: { team: teamName, position: 'TL', enabled: true },
    })
    if (tl) resolvedAgentProfileId = tl.id
  }

  return db.agentSession.create({
    data: {
      sessionId,
      agentId: resolvedAgentProfileId || 'default',
      agentProfileId: resolvedAgentProfileId,
      teamMode: mode,
      teamName: mode === 'multi' ? teamName : null,
      title: title || `${mode === 'single' ? 'Agent' : 'Team'} Chat`,
      model: model || null,
      provider: provider || null,
    },
  })
}

/** Xóa session — chỉ cho phép xóa session của agent/team đang chọn */
export async function deleteIsolatedSession(params: {
  sessionId: string
  mode: 'single' | 'multi'
  agentProfileId?: string
  teamName?: string
}) {
  const { sessionId, mode, agentProfileId, teamName } = params

  // Verify ownership
  const session = await db.agentSession.findUnique({
    where: { sessionId },
  })

  if (!session) {
    throw new Error('Session không tồn tại')
  }

  // Kiểm tra session thuộc agent/team đang chọn
  if (mode === 'single' && session.agentProfileId !== agentProfileId) {
    throw new Error('Không có quyền xóa session này')
  }
  if (mode === 'multi' && session.teamName !== teamName) {
    throw new Error('Không có quyền xóa session này')
  }

  // Cancel running tasks first
  await db.smolabTask.updateMany({
    where: { sessionId, status: { in: ['pending', 'running'] } },
    data: { status: 'cancelled' },
  })

  // Delete messages, then session
  await db.chatMessage.deleteMany({ where: { sessionId } })
  await db.smolabTask.deleteMany({ where: { sessionId } })
  return db.agentSession.delete({ where: { sessionId } })
}
```

#### 2.2 Tạo API route `src/app/api/smolab/sessions/route.ts`

**Nội dung**:

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { getSessionsForAgent, getSessionsForTeam, createIsolatedSession, deleteIsolatedSession } from '@/lib/smolab/session-manager'

/** GET /api/smolab/sessions — Lấy sessions theo agent/team */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const mode = searchParams.get('mode') as 'single' | 'multi' | null
  const agentProfileId = searchParams.get('agentProfileId')
  const teamName = searchParams.get('teamName')

  try {
    if (mode === 'single' && agentProfileId) {
      const sessions = await getSessionsForAgent(agentProfileId)
      return NextResponse.json({ sessions })
    }
    if (mode === 'multi' && teamName) {
      const sessions = await getSessionsForTeam(teamName)
      return NextResponse.json({ sessions })
    }
    return NextResponse.json({ error: 'Thiếu mode + agentProfileId hoặc teamName' }, { status: 400 })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Lỗi' }, { status: 500 })
  }
}

/** POST /api/smolab/sessions — Tạo session mới */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const session = await createIsolatedSession(body)
    return NextResponse.json({ session })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Lỗi' }, { status: 400 })
  }
}

/** DELETE /api/smolab/sessions — Xóa session */
export async function DELETE(req: NextRequest) {
  try {
    const body = await req.json()
    await deleteIsolatedSession(body)
    return NextResponse.json({ success: true })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Lỗi' }, { status: 400 })
  }
}
```

### Kết quả Phase 2
- Module `session-manager.ts` với validation + isolation
- API `/api/smolab/sessions` cho CRUD sessions với isolation
- Sessions chỉ trả về cho đúng agent/team

---

## Phase 3: Backend — Background Task Worker

### Mục tiêu
Tạo Background Task Worker — singleton pattern, max 3 concurrent tasks, AbortController cho cancel, continue khi switch session.

### Chi tiết triển khai

#### 3.1 Tạo file `src/lib/smolab/background-task-worker.ts`

**Nội dung**:

```typescript
/**
 * Smolab Background Task Worker — Singleton
 * 
 * Architecture:
 *   - Max 3 concurrent tasks chạy song song
 *   - Mỗi task có AbortController riêng → cancel được
 *   - Khi user switch session → task VẪN CHẠY (không abort)
 *   - Task hoàn thành → update DB → emit event cho frontend poll
 *   - Pending tasks xếp hàng, tự chạy khi có slot trống
 */

import { db } from '@/lib/db'

// ==================== TYPES ====================

export interface TaskInput {
  type: 'agent_chat' | 'team_workflow' | 'agent_react' | 'memory_extraction'
  sessionId: string
  agentProfileId?: string
  teamName?: string
  inputSummary: string
  execute: (signal: AbortSignal) => Promise<string> // Hàm thực thi, return result JSON
}

interface RunningTask {
  id: string
  input: TaskInput
  controller: AbortController
  startedAt: Date
}

// ==================== SINGLETON WORKER ====================

const MAX_CONCURRENT = 3

class SmolabTaskWorker {
  private running: Map<string, RunningTask> = new Map()
  private queue: TaskInput[] = []
  private processing = false

  /** Enqueue a new task */
  async enqueue(input: TaskInput): Promise<string> {
    // 1. Tạo DB record
    const task = await db.smolabTask.create({
      data: {
        type: input.type,
        status: 'pending',
        sessionId: input.sessionId,
        agentProfileId: input.agentProfileId || null,
        teamName: input.teamName || null,
        inputSummary: input.inputSummary,
      },
    })

    // 2. Thêm vào queue
    this.queue.push({ ...input })

    // 3. Thử bắt đầu processing
    this.processQueue()

    return task.id
  }

  /** Cancel a running/pending task */
  async cancel(taskId: string): Promise<boolean> {
    // Cancel nếu đang chạy
    const running = this.running.get(taskId)
    if (running) {
      running.controller.abort()
      this.running.delete(taskId)
    }

    // Remove khỏi queue
    this.queue = this.queue.filter(t => {
      // Không thể filter bằng ID vì queue chỉ có TaskInput
      // Sẽ cần tìm qua sessionId + type
      return true // Keep all, cancel via DB
    })

    // Update DB
    await db.smolabTask.update({
      where: { id: taskId },
      data: { status: 'cancelled', completedAt: new Date() },
    }).catch(() => {})

    return true
  }

  /** Cancel tất cả tasks của 1 session */
  async cancelSessionTasks(sessionId: string): Promise<number> {
    let count = 0
    for (const [id, running] of this.running) {
      if (running.input.sessionId === sessionId) {
        running.controller.abort()
        this.running.delete(id)
        count++
      }
    }

    const result = await db.smolabTask.updateMany({
      where: { sessionId, status: { in: ['pending', 'running'] } },
      data: { status: 'cancelled', completedAt: new Date() },
    })
    return count + result.count
  }

  /** Process queue — start pending tasks up to MAX_CONCURRENT */
  private async processQueue() {
    if (this.processing) return
    this.processing = true

    try {
      while (this.running.size < MAX_CONCURRENT && this.queue.length > 0) {
        const input = this.queue.shift()!
        await this.startTask(input)
      }
    } finally {
      this.processing = false
    }
  }

  /** Start a single task */
  private async startTask(input: TaskInput) {
    // Tìm pending task trong DB cho session+type này
    const task = await db.smolabTask.findFirst({
      where: {
        sessionId: input.sessionId,
        type: input.type,
        status: 'pending',
      },
      orderBy: { createdAt: 'asc' },
    })

    if (!task) return

    const controller = new AbortController()
    const runningTask: RunningTask = {
      id: task.id,
      input,
      controller,
      startedAt: new Date(),
    }

    this.running.set(task.id, runningTask)

    // Update DB → running
    await db.smolabTask.update({
      where: { id: task.id },
      data: { status: 'running', startedAt: new Date() },
    })

    // Execute task (KHÔNG await — chạy nền)
    this.executeTask(task.id, input, controller.signal)
  }

  /** Execute a task — runs in background, updates DB on completion */
  private async executeTask(taskId: string, input: TaskInput, signal: AbortSignal) {
    try {
      const result = await input.execute(signal)

      if (signal.aborted) {
        await db.smolabTask.update({
          where: { id: taskId },
          data: { status: 'cancelled', completedAt: new Date() },
        })
      } else {
        await db.smolabTask.update({
          where: { id: taskId },
          data: {
            status: 'completed',
            progress: 100,
            result,
            completedAt: new Date(),
          },
        })
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      await db.smolabTask.update({
        where: { id: taskId },
        data: { status: 'failed', error: errorMsg, completedAt: new Date() },
      })
    } finally {
      this.running.delete(taskId)
      // Process next in queue
      this.processQueue()
    }
  }

  /** Get running task count */
  getRunningCount(): number {
    return this.running.size
  }

  /** Get pending task count */
  getPendingCount(): number {
    return this.queue.length
  }

  /** Get all running tasks info (for debug/status) */
  getRunningTasks(): Array<{ id: string; sessionId: string; type: string; startedAt: Date }> {
    return Array.from(this.running.values()).map(t => ({
      id: t.id,
      sessionId: t.input.sessionId,
      type: t.input.type,
      startedAt: t.startedAt,
    }))
  }

  /** Shutdown — cancel all running tasks */
  async shutdown() {
    for (const [id, running] of this.running) {
      running.controller.abort()
      await db.smolabTask.update({
        where: { id },
        data: { status: 'cancelled', completedAt: new Date() },
      }).catch(() => {})
    }
    this.running.clear()
    this.queue = []
  }
}

// Singleton instance
const globalForWorker = globalThis as unknown as {
  smolabWorker: SmolabTaskWorker | undefined
}

export const smolabWorker = globalForWorker.smolabWorker ?? new SmolabTaskWorker()
if (process.env.NODE_ENV !== 'production') globalForWorker.smolabWorker = smolabWorker
```

#### 3.2 Tạo API route `src/app/api/smolab/tasks/route.ts`

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { smolabWorker } from '@/lib/smolab/background-task-worker'

/** GET /api/smolab/tasks — Lấy task status */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const sessionId = searchParams.get('sessionId')
  const taskType = searchParams.get('type')

  try {
    const where: any = {}
    if (sessionId) where.sessionId = sessionId
    if (taskType) where.type = taskType

    const tasks = await db.smolabTask.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 50,
    })

    return NextResponse.json({
      tasks,
      workerStatus: {
        running: smolabWorker.getRunningCount(),
        pending: smolabWorker.getPendingCount(),
        runningTasks: smolabWorker.getRunningTasks(),
      },
    })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Lỗi' }, { status: 500 })
  }
}
```

#### 3.3 Tạo API route `src/app/api/smolab/tasks/[id]/route.ts`

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { smolabWorker } from '@/lib/smolab/background-task-worker'

/** GET /api/smolab/tasks/[id] — Chi tiết 1 task */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  try {
    const task = await db.smolabTask.findUnique({ where: { id } })
    if (!task) return NextResponse.json({ error: 'Task không tồn tại' }, { status: 404 })
    return NextResponse.json({ task })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Lỗi' }, { status: 500 })
  }
}

/** PATCH /api/smolab/tasks/[id] — Cancel task */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  try {
    await smolabWorker.cancel(id)
    return NextResponse.json({ success: true })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Lỗi' }, { status: 500 })
  }
}
```

### Kết quả Phase 3
- Singleton `SmolabTaskWorker` với queue, max 3 concurrent, AbortController
- API `/api/smolab/tasks` cho CRUD + status
- API `/api/smolab/tasks/[id]` cho chi tiết + cancel
- Tasks chạy nền, tiếp tục khi user switch session

---

## Phase 4: Backend — Chat API tích hợp Background Task

### Mục tiêu
Cập nhật chat API (`/api/openclaw/chat`) để:
1. Validate agent/team bắt buộc
2. Tạo SmolabTask cho mỗi chat request
3. Chat chạy trong background task worker
4. Trả về response ngay (non-blocking) cho single agent chat dài

### Chi tiết triển khai

#### 4.1 Tạo file `src/app/api/smolab/chat/route.ts`

**Chat API mới chuyên cho Smolab** — tách riêng khỏi `/api/openclaw/chat` cũ để không ảnh hưởng hệ thống hiện tại.

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { validateChatContext, createIsolatedSession } from '@/lib/smolab/session-manager'
import { smolabWorker } from '@/lib/smolab/background-task-worker'
import { db } from '@/lib/db'

/**
 * POST /api/smolab/chat
 * 
 * Body:
 *   mode: 'single' | 'multi'
 *   agentProfileId?: string (bắt buộc nếu single)
 *   teamName?: string (bắt buộc nếu multi)
 *   sessionId?: string (nếu có session rồi)
 *   message: string
 *   model?: string
 *   provider?: string
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { mode, agentProfileId, teamName, sessionId, message, model, provider } = body

    // 1. Validate — BẮT BUỘC chọn agent/team
    const validation = validateChatContext({ mode, agentProfileId, teamName })
    if (!validation.valid) {
      return NextResponse.json({ error: validation.error }, { status: 400 })
    }

    // 2. Tạo hoặc dùng session hiện có
    let currentSessionId = sessionId
    if (!currentSessionId) {
      const session = await createIsolatedSession({
        mode,
        agentProfileId,
        teamName,
        title: message.slice(0, 50),
        model,
        provider,
      })
      currentSessionId = session.sessionId
    }

    // 3. Lưu user message vào DB
    await db.chatMessage.create({
      data: {
        sessionId: currentSessionId,
        role: 'user',
        content: message,
      },
    })

    // 4. Lấy agent profile để build system prompt
    let agentProfile = null
    if (mode === 'single' && agentProfileId) {
      agentProfile = await db.agentProfile.findUnique({ where: { id: agentProfileId } })
    } else if (mode === 'multi' && teamName) {
      agentProfile = await db.agentProfile.findFirst({
        where: { team: teamName, position: 'TL', enabled: true },
      })
    }

    if (!agentProfile) {
      return NextResponse.json({ error: 'Agent không tồn tại hoặc chưa được bật' }, { status: 404 })
    }

    // 5. Tạo background task
    const taskId = await smolabWorker.enqueue({
      type: mode === 'single' ? 'agent_chat' : 'team_workflow',
      sessionId: currentSessionId,
      agentProfileId: agentProfile.id,
      teamName: mode === 'multi' ? teamName : undefined,
      inputSummary: message.slice(0, 200),
      execute: async (signal) => {
        // ===== THỰC THI CHAT TRONG BACKGROUND =====
        // Import LLM caller
        const { callLLMForAgent } = await import('@/lib/llm')

        // Lấy lịch sử chat
        const history = await db.chatMessage.findMany({
          where: { sessionId: currentSessionId },
          orderBy: { createdAt: 'asc' },
          take: 40, // Last 40 messages context
        })

        const messages = history.map(m => ({
          role: m.role as 'user' | 'assistant' | 'system',
          content: m.content,
        }))

        // Call LLM
        const result = await callLLMForAgent(
          agentProfile!.id,
          messages,
          {
            systemPrompt: agentProfile!.instruction,
            signal,
          }
        )

        // Lưu assistant message
        await db.chatMessage.create({
          data: {
            sessionId: currentSessionId,
            role: 'assistant',
            content: result.content,
            model: result.model,
            provider: result.provider,
            metadata: JSON.stringify({
              tokensUsed: result.tokensUsed,
              duration: result.duration,
            }),
          },
        })

        // Update session message count
        await db.agentSession.update({
          where: { sessionId: currentSessionId },
          data: { messageCount: { increment: 1 }, updatedAt: new Date() },
        })

        return JSON.stringify({
          content: result.content,
          model: result.model,
          provider: result.provider,
          tokensUsed: result.tokensUsed,
          duration: result.duration,
        })
      },
    })

    // 6. Return ngay — không đợi task xong
    return NextResponse.json({
      sessionId: currentSessionId,
      taskId,
      status: 'processing',
    })

  } catch (err) {
    console.error('[Smolab Chat] Error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Lỗi nội bộ' },
      { status: 500 }
    )
  }
}
```

#### 4.2 Polling endpoint cho task status + message

**Thay vì SSE phức tạp, dùng polling đơn giản** — Frontend poll mỗi 2 giây khi có task đang chạy.

API đã có ở Phase 3: `GET /api/smolab/tasks?sessionId=xxx`

### Kết quả Phase 4
- API `/api/smolab/chat` — Chat mới với validation + background task
- Chat request → tạo task → return ngay → task chạy nền
- Polling endpoint đã sẵn từ Phase 3

---

## Phase 5: Frontend — UI Enforcement (Bắt buộc chọn Agent/Team)

### Mục tiêu
Cập nhật UI Smolab trong `page.tsx`:
1. Disable chat input khi chưa chọn agent/team
2. Hiển thị placeholder "Chọn Agent hoặc Team để bắt đầu chat"
3. Chuyển đổi session list theo agent/team đang chọn

### Chi tiết triển khai

#### 5.1 State changes trong SmolabModule

**File**: `src/app/page.tsx`
**Vị trí**: Function `SmolabModule` (dòng ~5725)

**Thêm state mới**:
```typescript
// Thêm sau dòng 5764
const [activeTaskIds, setActiveTaskIds] = useState<Map<string, string>>(new Map()) // sessionId → taskId
const [taskPolling, setTaskPolling] = useState(false)
```

#### 5.2 Conditional chat input — Disable khi chưa chọn

**Vị trí**: Tìm phần render chat input (khoảng dòng 7369 trở đi)

**Thay đổi logic**:
```typescript
// Thay vì luôn hiện chat input, thêm điều kiện:
const canChat = (chatMode === 'single' && selectedAgentId) || (chatMode === 'multi' && selectedTeam)

// Khi render chat input:
{canChat ? (
  // Hiện chat input bình thường
  <div className="...">
    <Textarea ... />
    <Button onClick={handleSend} ... />
  </div>
) : (
  // Hiện placeholder khi chưa chọn
  <div className="flex items-center justify-center h-20 text-stone-400 text-sm">
    <div className="text-center">
      <Bot className="h-8 w-8 mx-auto mb-2 opacity-30" />
      <p>Chọn Agent hoặc Team để bắt đầu chat</p>
    </div>
  </div>
)}
```

#### 5.3 Hiển thị Agent/Team selection nổi bật khi chưa chọn

**Vị trí**: Phần render Agent/Team dropdown (dòng ~7058 và ~7202)

**Thay đổi**: Khi chưa chọn agent/team, thêm hiệu ứng highlight:
```typescript
// Cho Agent dropdown (single mode):
{chatMode === 'single' && !selectedAgentId && (
  <div className="p-3 rounded-xl bg-cyan-950/30 border border-cyan-500/55 text-center">
    <Bot className="h-6 w-6 mx-auto mb-1 text-cyan-400" />
    <p className="text-xs text-cyan-400">Chọn Agent để bắt đầu</p>
  </div>
)}

// Cho Team dropdown (multi mode):
{chatMode === 'multi' && !selectedTeam && (
  <div className="p-3 rounded-xl bg-amber-950/30 border border-amber-500/55 text-center">
    <Users className="h-6 w-6 mx-auto mb-1 text-amber-400" />
    <p className="text-xs text-amber-400">Chọn Team để bắt đầu</p>
  </div>
)}
```

#### 5.4 Cập nhật handleSend để gọi `/api/smolab/chat`

**Vị trí**: Function `handleSend` (dòng ~6618)

**Thay đổi chính**:
```typescript
const handleSend = useCallback(async () => {
  // ... existing input validation ...

  // THAY ĐỔI: Gọi API mới /api/smolab/chat thay vì /api/openclaw/chat
  const res = await fetch('/api/smolab/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mode: chatMode,
      agentProfileId: selectedAgentId,
      teamName: selectedTeam,
      sessionId: currentSessionId || undefined,
      message: input,
    }),
  })

  const data = await res.json()

  if (!res.ok) {
    // Hiện lỗi validation (VD: "Vui lòng chọn Agent trước khi chat")
    sonnerToast.error('Lỗi', { description: data.error })
    return
  }

  // Update session ID nếu mới tạo
  if (data.sessionId && data.sessionId !== currentSessionId) {
    setCurrentSessionId(data.sessionId)
  }

  // Track task ID để polling
  if (data.taskId) {
    setActiveTaskIds(prev => new Map(prev).set(data.sessionId, data.taskId))
    setTaskPolling(true)
  }

  // Thêm user message vào UI ngay
  const userMsg: SmolabMessage = {
    id: `user_${Date.now()}`,
    role: 'user',
    content: input,
    timestamp: new Date(),
  }
  setMessages(prev => [...prev, userMsg])
  setInput('')
}, [input, chatMode, selectedAgentId, selectedTeam, currentSessionId])
```

### Kết quả Phase 5
- Chat input disabled khi chưa chọn agent/team
- Placeholder "Chọn Agent/Team" hiển thị rõ ràng
- handleSend gọi API mới `/api/smolab/chat`
- Task ID được track để polling

---

## Phase 6: Frontend — Task Polling & Indicators

### Mục tiêu
1. Polling task status mỗi 2 giây khi có task đang chạy
2. Hiển thị badge ⚡ trên session đang chạy task
3. Load assistant message khi task hoàn thành
4. Toast notification khi task nền hoàn thành

### Chi tiết triển khai

#### 6.1 Task Polling Hook

**Vị trí**: Trong `SmolabModule`, thêm useEffect:

```typescript
// Task polling — check mỗi 2 giây khi có task đang chạy
useEffect(() => {
  if (!taskPolling || activeTaskIds.size === 0) return

  const pollInterval = setInterval(async () => {
    let anyRunning = false

    for (const [sessionId, taskId] of activeTaskIds) {
      try {
        const res = await fetch(`/api/smolab/tasks/${taskId}`)
        if (!res.ok) continue
        const data = await res.json()
        const task = data.task

        if (task.status === 'completed') {
          // Task xong → load messages mới
          const msgRes = await fetch(`/api/chat-messages?sessionId=${encodeURIComponent(sessionId)}`)
          if (msgRes.ok) {
            const msgData = await msgRes.json()
            const loaded: SmolabMessage[] = msgData.messages.map((m: any) => ({
              id: m.id,
              role: m.role === 'user' ? 'user' : 'assistant',
              content: m.content,
              timestamp: new Date(m.createdAt),
              model: m.model,
              provider: m.provider,
            }))
            setMessages(loaded)
          }

          // Remove khỏi tracking
          setActiveTaskIds(prev => {
            const next = new Map(prev)
            next.delete(sessionId)
            return next
          })

          // Toast nếu KHÔNG phải session hiện tại (nghĩa là task nền)
          if (sessionId !== currentSessionId) {
            sonnerToast.success('Task hoàn thành', {
              description: `Phiên "${sessionId.slice(0, 8)}..." đã xong`,
            })
          }

        } else if (task.status === 'failed') {
          // Task lỗi
          if (sessionId === currentSessionId) {
            const errMsg: SmolabMessage = {
              id: `error_${Date.now()}`,
              role: 'error',
              content: `Lỗi: ${task.error || 'Unknown error'}`,
              timestamp: new Date(),
            }
            setMessages(prev => [...prev, errMsg])
          }

          setActiveTaskIds(prev => {
            const next = new Map(prev)
            next.delete(sessionId)
            return next
          })

        } else if (task.status === 'running' || task.status === 'pending') {
          anyRunning = true
        }
      } catch (err) {
        console.warn('[Smolab] Task poll error:', err)
      }
    }

    // Dừng polling nếu không còn task nào đang chạy
    if (!anyRunning) {
      setTaskPolling(false)
    }
  }, 2000) // Poll mỗi 2 giây

  return () => clearInterval(pollInterval)
}, [taskPolling, activeTaskIds, currentSessionId])
```

#### 6.2 Session Badge — ⚡ cho session đang chạy task

**Vị trí**: Trong render session list (dòng ~7145 và ~7281)

**Thay đổi**: Thêm badge sau tên session:
```typescript
// Trong map qua sessions, thêm badge:
{s.tasks && s.tasks.length > 0 && (
  <span className="flex items-center gap-0.5 text-amber-400">
    <Zap className="h-3 w-3" />
    <span className="text-[9px]">{s.tasks.length}</span>
  </span>
)}
```

#### 6.3 Loading indicator trong chat

**Vị trí**: Trong render messages area

**Thay đổi**: Khi task đang chạy cho session hiện tại, hiện typing indicator:
```typescript
{activeTaskIds.has(currentSessionId) && (
  <div className="flex items-center gap-2 px-4 py-2 text-xs text-stone-400">
    <Loader2 className="h-3 w-3 animate-spin" />
    <span>{smolabAgents.find(a => a.id === selectedAgentId)?.name || 'Agent'} đang xử lý...</span>
  </div>
)}
```

### Kết quả Phase 6
- Polling tự động mỗi 2 giây
- Badge ⚡ trên session đang chạy task
- Messages tự load khi task xong
- Toast notification cho task nền hoàn thành
- Typing indicator trong chat

---

## Phase 7: Frontend — Session Isolation UI & Polish

### Mục tiêu
1. Chuyển session fetch sang `/api/smolab/sessions`
2. Khi đổi agent/team → reset session list + messages
3. Session chỉ hiện cho đúng agent/team
4. Clean up khi chuyển mode (single ↔ multi)

### Chi tiết triển khai

#### 7.1 Cập nhật fetchSessionsForAgent / fetchSessionsForTeam

**Vị trí**: Function fetchSessionsForAgent (dòng ~6041) và fetchSessionsForTeam

**Thay đổi**: Gọi `/api/smolab/sessions` thay vì `/api/openclaw/sessions`:

```typescript
const fetchSessionsForAgent = useCallback(async (agentProfileId: string) => {
  try {
    const res = await fetch(`/api/smolab/sessions?mode=single&agentProfileId=${agentProfileId}`)
    if (res.ok) {
      const data = await res.json()
      setSessions(data.sessions || [])
    }
  } catch (err) {
    console.warn('[Smolab] Failed to load agent sessions:', err)
  }
}, [])

const fetchSessionsForTeam = useCallback(async (teamName: string) => {
  try {
    const res = await fetch(`/api/smolab/sessions?mode=multi&teamName=${teamName}`)
    if (res.ok) {
      const data = await res.json()
      setSessions(data.sessions || [])
    }
  } catch (err) {
    console.warn('[Smolab] Failed to load team sessions:', err)
  }
}, [])
```

#### 7.2 Reset khi chuyển agent/team

**Vị trí**: useEffect khi selectedAgentId/selectedTeam thay đổi

**Thay đổi**: Reset messages + currentSessionId khi chuyển:
```typescript
useEffect(() => {
  // Reset chat khi đổi agent/team
  setMessages([])
  setCurrentSessionId('')
  setActiveTaskIds(new Map())
  setTaskPolling(false)

  // Load sessions cho agent/team mới
  if (chatMode === 'single' && selectedAgentId) {
    fetchSessionsForAgent(selectedAgentId)
  } else if (chatMode === 'multi' && selectedTeam) {
    fetchSessionsForTeam(selectedTeam)
  }
}, [selectedAgentId, selectedTeam, chatMode])
```

#### 7.3 Reset khi chuyển mode (single ↔ multi)

**Vị trí**: Nút chuyển mode (dòng ~7017)

**Thay đổi**: Khi click chuyển mode:
```typescript
const newMode = chatMode === 'single' ? 'multi' : 'single'
setChatMode(newMode)
setSelectedAgentId(null)
setSelectedTeam(null)
setMessages([])
setCurrentSessionId('')
setSessions([])
setActiveTaskIds(new Map())
setTaskPolling(false)
```

### Kết quả Phase 7
- Sessions chỉ load cho đúng agent/team
- Chat reset khi chuyển agent/team/mode
- Isolation nghiêm ngặt — không session "lọt" qua

---

## Tổng kết

| Phase | Nội dung | Files tạo/sửa | Phụ thuộc |
|-------|----------|---------------|-----------|
| **1** | Database Schema | `prisma/schema.prisma` | Không |
| **2** | Session Manager + API | `src/lib/smolab/session-manager.ts`, `src/app/api/smolab/sessions/route.ts` | Phase 1 |
| **3** | Background Task Worker + API | `src/lib/smolab/background-task-worker.ts`, `src/app/api/smolab/tasks/route.ts`, `src/app/api/smolab/tasks/[id]/route.ts` | Phase 1 |
| **4** | Chat API tích hợp Task | `src/app/api/smolab/chat/route.ts` | Phase 2, 3 |
| **5** | Frontend — UI Enforcement | `src/app/page.tsx` (sửa) | Phase 4 |
| **6** | Frontend — Task Polling | `src/app/page.tsx` (sửa) | Phase 5 |
| **7** | Frontend — Session Isolation | `src/app/page.tsx` (sửa) | Phase 5, 6 |

**Thứ tự triển khai**: 1 → 2 → 3 → 4 → 5 → 6 → 7 (tuần tự, mỗi phase phụ thuộc phase trước)

**Không bỏ qua phase nào** — mỗi phase là nền tảng cho phase sau.

---

## ⚠️ LƯU Ý QUAN TRỌNG CHO CÁC PHASE SAU

### 🔴 Phase 3 — Background Task Worker: Sửa lỗi cancel queue

**Vấn đề**: Hàm `cancel()` trong `SmolabTaskWorker` có bug — filter queue luôn `return true` nên không xóa được task khỏi queue. Queue items không lưu `taskId` nên không thể filter chính xác.

**Cách sửa**:
1. Thêm `taskId` vào interface `TaskInput` hoặc tạo wrapper `QueuedTask { taskId: string; input: TaskInput }`
2. Sửa filter logic: `this.queue = this.queue.filter(t => t.taskId !== taskId)`
3. Khi `enqueue()`, sau khi tạo DB record → gán `task.id` vào queue item

**Code sửa**:
```typescript
interface QueuedTask {
  taskId: string
  input: TaskInput
}

// Trong class SmolabTaskWorker:
private queue: QueuedTask[] = []  // Thay vì TaskInput[]

async enqueue(input: TaskInput): Promise<string> {
  const task = await db.smolabTask.create({ ... })
  this.queue.push({ taskId: task.id, input })  // ← Gán taskId
  this.processQueue()
  return task.id
}

async cancel(taskId: string): Promise<boolean> {
  const running = this.running.get(taskId)
  if (running) {
    running.controller.abort()
    this.running.delete(taskId)
  }
  // SỬA: Filter đúng theo taskId
  this.queue = this.queue.filter(t => t.taskId !== taskId)
  // ...
}
```

### 🔴 Phase 3 — startTask: Tránh trùng lặp DB lookup

**Vấn đề**: `startTask()` dùng `findFirst({ where: { sessionId, type, status: 'pending' } })` để tìm task. Nếu có 2 tasks cùng type cho cùng session, `findFirst` luôn trả về task cũ nhất, không phải task vừa enqueue.

**Cách sửa**: Thay vì tìm lại task trong DB, truyền `taskId` trực tiếp từ queue vào `startTask()`:
```typescript
private async startTask(queued: QueuedTask) {
  const { taskId, input } = queued
  // Verify task vẫn còn pending
  const task = await db.smolabTask.findUnique({ where: { id: taskId } })
  if (!task || task.status !== 'pending') return
  // ... tiếp tục như cũ, dùng taskId thay vì task.id
}
```

### 🔴 Phase 4 — callLLMForAgent signature KHÁC plan

**Vấn đề**: Plan viết `callLLMForAgent(agentProfileId, messages, { systemPrompt, signal })` nhưng signature thực tế là:
```typescript
callLLMForAgent(
  prompt: string,           // ← Chuỗi text, KHÔNG phải messages array
  agentConfig: { provider: string; model: string },  // ← Cần provider+model
  systemPrompt?: string,
  options?: LLMCallOptions  // ← KHÔNG có signal
): Promise<LLMResult>
```

**Cách sửa**:
1. Build `prompt` từ lịch sử chat: nối các messages thành 1 chuỗi text
2. Lấy `provider` + `model` từ `AgentProfile` record
3. **KHÔNG truyền AbortSignal** — `callLLMForAgent` không hỗ trợ. Nếu cần cancel, phải dùng wrapper try/catch + AbortSignal kiểm tra sau khi LLM trả về.
4. `LLMResult` trả về `{ content, provider, model, tokensUsed? }` — KHÔNG có `duration`

**Code sửa cho Phase 4 execute function**:
```typescript
execute: async (signal) => {
  const { callLLMForAgent } = await import('@/lib/llm')
  
  const history = await db.chatMessage.findMany({
    where: { sessionId: currentSessionId },
    orderBy: { createdAt: 'asc' },
    take: 40,
  })
  
  // Build prompt từ lịch sử
  const prompt = history
    .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n\n')
  
  const result = await callLLMForAgent(
    prompt,
    { provider: agentProfile!.provider, model: agentProfile!.model },
    agentProfile!.instruction,
    { agentId: agentProfile!.id, agentName: agentProfile!.name }
  )
  
  // ... save message, update session ...
  return JSON.stringify({
    content: result.content,
    model: result.model,
    provider: result.provider,
    tokensUsed: result.tokensUsed,
  })
}
```

### 🟡 Phase 4 — LLMResult không có `duration`

**Vấn đề**: Plan ghi `result.duration` nhưng `LLMResult` chỉ có `{ content, provider, model, error?, tokensUsed? }`. Không có field `duration`.

**Cách sửa**: Tự đo thời gian bằng `Date.now()` trước/sau khi gọi LLM:
```typescript
const startTime = Date.now()
const result = await callLLMForAgent(...)
const duration = Date.now() - startTime
// Lưu duration vào metadata
```

### 🟡 Phase 5-7 — Line numbers trong page.tsx có thể đã thay đổi

**Vấn đề**: Plan ghi line numbers cụ thể (VD: "dòng ~5725", "dòng ~6618") nhưng page.tsx có thể đã thay đổi sau Phase 1+2.

**Cách xử lý**: 
- KHÔNG dựa vào line numbers cụ thể
- Dùng `Grep` để tìm vị trí chính xác bằng function name / variable name
- Tìm: `handleSend`, `fetchSessionsForAgent`, `fetchSessionsForTeam`, `SmolabModule`, `chatMode`, `selectedAgentId`, `currentSessionId`

### 🟡 Phase 6 — Polling theo sessionId hiệu quả hơn

**Vấn đề**: Plan poll từng taskId riêng lẻ trong vòng lặp `for...of activeTaskIds`. Nếu có nhiều tasks, tạo nhiều HTTP requests.

**Cách sửa**: Dùng `GET /api/smolab/tasks?sessionId=xxx` để poll tất cả tasks của 1 session cùng lúc, thay vì poll từng task ID:
```typescript
const res = await fetch(`/api/smolab/tasks?sessionId=${encodeURIComponent(sessionId)}`)
const data = await res.json()
// data.tasks là array tất cả tasks của session
const active = data.tasks.filter(t => t.status === 'running' || t.status === 'pending')
```

### 🟢 Phase 3 — Singleton pattern trong Next.js

**Lưu ý**: Next.js dev mode với Turbopack có thể tạo nhiều instance của module. Singleton pattern dùng `globalThis` (như plan đã viết) là đúng — nhưng cần đảm bảo reset state khi hot-reload.

Plan đã handle đúng với:
```typescript
const globalForWorker = globalThis as unknown as { smolabWorker: SmolabTaskWorker | undefined }
export const smolabWorker = globalForWorker.smolabWorker ?? new SmolabTaskWorker()
if (process.env.NODE_ENV !== 'production') globalForWorker.smolabWorker = smolabWorker
```

### 🟢 Phase 7 — Cần update cả session list type

**Lưu ý**: Khi chuyển sang `/api/smolab/sessions`, response format sẽ khác — sessions include `tasks` relation. Frontend cần update type definition cho session object để hiển thị badge ⚡ đúng.
