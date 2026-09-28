# OpenClaw Integration — Kế Hoạch Triển Khai Chi Tiết

> Ngày tạo: 2026-03-05  
> Cập nhật: 2026-03-05  
> Dựa trên: `OPENCLAW_INTEGRATION_ANALYSIS.md` + Khảo sát codebase thực tế

---

## Mục Lục

1. [Tổng Quan Kiến Trúc Mục Tiêu](#1-tổng-quan-kiến-trúc-mục-tiêu)
2. [Phát Hiện Quan Trọng Mới](#2-phát-hiện-quan-trọng-mới)
3. [P0: Gateway-First Tool Calling](#3-p0-gateway-first-tool-calling)
4. [P1: Skills → Tools Connection](#4-p1-skills--tools-connection)
5. [P2: Full Archive Download & Execution](#5-p2-full-archive-download--execution)
6. [P3: Extensible Tool System](#6-p3-extensible-tool-system)
7. [Dependency Map](#7-dependency-map)
8. [Risk & Mitigation](#8-risk--mitigation)

---

## 1. Tổng Quan Kiến Trúc Mục Tiêu

### Kiến trúc hiện tại (BROKEN):

```
User Chat → /api/openclaw/chat
              ├── Code query? → OpenCode (port 18790) ← OK
              ├── Agent có provider+model? → ReAct loop:
              │     callLLMForAgent() → ❌ KHÔNG gửi tools
              │     parseToolCallsFromOutput() → ❌ Regex fragile  
              │     executeTool() → ❌ Chỉ 7 tools
              ├── Không có agent? → Gateway chatCompletion() → ❌ Không có NVIDIA key
              └── Fallback → /api/query → Local RAG
```

### Kiến trúc mục tiêu (SAU P0):

```
User Chat → /api/openclaw/chat
              ├── Code query? → OpenCode (port 18790) ← giữ nguyên
              │
              ├── Gateway ONLINE?
              │     └── YES → Route qua Gateway:
              │           POST /v1/chat/completions
              │           + Header: x-openclaw-model = agent.model
              │           + Body: tools = Gateway's 37 tools
              │           → Gateway tự handle ReAct loop
              │           → Trả về final response (đã xử lý tools)
              │           → ✅ 37 tools khả dụng
              │
              ├── Gateway OFFLINE?
              │     └── YES → Fallback local ReAct loop:
              │           callLLMForAgent() + tools parameter ← SỬA
              │           Parse structured tool_calls ← SỬA
              │           executeTool() (7 local tools + Gateway /tools/invoke) ← MỞ RỘNG
              │           → ✅ 7+ tools khả dụng
              │
              └── Cuối cùng → /api/query → Local RAG ← giữ nguyên
```

### Chiến lược: Gateway-First, Local-Fallback

- **Gateway online** → Route tất cả qua Gateway → 37 tools đầy đủ
- **Gateway offline** → Fallback local ReAct loop → 7+ tools (sửa đổi)
- **Không phá vỡ** flow hiện tại — chỉ thêm layer mới

---

## 2. Phát Hiện Quan Trọng Mới

### ⚠️ HTTP Deny List — Thay đổi chiến lược P0

Khi khảo sát Gateway API thực tế, phát hiện:

**12+ tools quan trọng bị DENY qua HTTP `/tools/invoke`:**
```
exec, spawn, shell, fs_write, fs_delete, fs_move,
apply_patch, sessions_spawn, sessions_send, cron, gateway, nodes
```

**Ý nghĩa:**
- Pattern B (Hybrid: gọi NVIDIA trực tiếp + execute tools qua `/tools/invoke`) **KHÔNG THỂ DÙNG** cho file/exec tools
- Chỉ có thể dùng `/tools/invoke` cho: `web_search`, `web_fetch`, `x_search`, `memory_search`, `memory_get`, `sessions_list`, `session_status`, `agents_list`, `message`
- **Pattern A (route qua Gateway `/v1/chat/completions`)** là con đường duy nhất để dùng tất cả 37 tools vì Gateway's internal agent loop không bị HTTP deny list

### ✅ Gateway hỗ trợ model override per request

- Header `x-openclaw-model` cho phép chỉ định model cho mỗi request
- Ví dụ: `x-openclaw-model: nvidia/qwen/qwen3.5-397b-a17b` → RAMPAGE agent
- Không cần cấu hình mỗi agent riêng trong Gateway

### ✅ Gateway đã có NVIDIA NIM built-in provider

- Chỉ cần set `NVIDIA_API_KEY` env var → Gateway tự gọi NVIDIA NIM
- Dynamic model discovery từ `assets.ngc.nvidia.com` (cache 24h, max 32 models)
- App có thể dùng bất kỳ NVIDIA model nào thông qua `x-openclaw-model` header

---

## 3. P0: Gateway-First Tool Calling

### Mục tiêu
Agents có thể gọi và thực thi tools thật. Khi Gateway online → 37 tools. Khi offline → 7+ local tools.

### Thời gian dự kiến: 2-3 ngày

### P0.1: Cấu hình NVIDIA NIM cho Gateway

**Triển khai:**
```bash
# 1. Set NVIDIA_API_KEY cho Gateway process
# Sửa mini-services/openclaw-gateway/index.ts
# Thêm NVIDIA_API_KEY vào env khi spawn process
```

**File cần sửa:** `mini-services/openclaw-gateway/index.ts`

**Chi tiết:**
- Đọc `NVIDIA_API_KEY_1` từ `.env` (app đã có 4 keys)
- Pass `NVIDIA_API_KEY` env var cho child process khi spawn `openclaw gateway run`
- Kiểm tra Gateway có nhận được key không: `curl http://127.0.0.1:18789/v1/models`

**Cách triển khai:**
```typescript
// mini-services/openclaw-gateway/index.ts
// Trong spawn args, thêm env:
const env = {
  ...process.env,
  NVIDIA_API_KEY: process.env.NVIDIA_API_KEY_1 || '',
};

const child = spawn('npx', ['openclaw', 'gateway', 'run', ...], {
  env,  // ← thêm dòng này
  stdio: ['ignore', 'pipe', 'pipe'],
});
```

**Verify:**
```bash
curl -X POST http://127.0.0.1:18789/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"openclaw","messages":[{"role":"user","content":"Say hello"}],"max_tokens":50}'
# → Phải trả về response thay vì "missing-provider-auth" error
```

---

### P0.2: Sửa Chat Route — Gateway-First với Model Override

**File cần sửa:** `src/app/api/openclaw/chat/route.ts`

**Hiện tại (line 542-648):**
```
if (hasAgentProviderModel) → runAgentReActLoop() (bypasses Gateway)
if (!hasAgentProviderModel) → try Gateway chatCompletion()
```

**Sửa thành:**
```
1. Luôn kiểm tra Gateway online trước
2. Nếu Gateway online → route QUA Gateway (dù có agent provider hay không)
3. Nếu Gateway offline → fallback local ReAct loop
```

**Chi tiết triển khai:**

```typescript
// === NEW: Gateway-First Chat Flow ===

// Bước 1: Kiểm tra Gateway status (cache 30s để tránh spam)
let gatewayOnline = false
let gatewayCacheTime = 0
const GATEWAY_CACHE_TTL = 30000

async function isGatewayOnlineCached(): Promise<boolean> {
  const now = Date.now()
  if (now - gatewayCacheTime < GATEWAY_CACHE_TTL) return gatewayOnline
  gatewayCacheTime = now
  const result = await isGatewayOnline()
  gatewayOnline = result.online
  return gatewayOnline
}

// Bước 2: Map agent model → x-openclaw-model header
function mapAgentModelToGatewayHeader(provider: string, model: string): string {
  // App dùng: nvidia/qwen/qwen3.5-397b-a17b
  // Gateway cần: nvidia/qwen/qwen3.5-397b-a17b (giữ nguyên)
  return `${provider}/${model}`
}

// Bước 3: Route chat qua Gateway
async function routeThroughGateway(params: {
  messages: ChatMessage[]
  agentProvider: string
  agentModel: string
  sessionId?: string
  temperature?: number
  maxTokens?: number
  agentProfileId?: string
  agentProfileName?: string
  teamMode?: string
  teamName?: string
}): Promise<NextResponse | null> {
  const { messages, agentProvider, agentModel, sessionId, temperature, maxTokens,
          agentProfileId, agentProfileName, teamMode, teamName } = params

  try {
    // Gọi Gateway với x-openclaw-model header để chỉ định model cho agent
    const gatewayModel = mapAgentModelToGatewayHeader(agentProvider, agentModel)
    
    const res = await gatewayFetch('/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-openclaw-model': gatewayModel,  // ← Override model per agent
      },
      body: JSON.stringify({
        model: 'openclaw/default',
        messages,
        stream: false,
        ...(temperature !== undefined ? { temperature } : {}),
        ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
        // KHÔNG cần gửi tools — Gateway tự có 37 tools built-in
        // Gateway's agent loop tự động handle tool calling
      }),
      timeout: 120000,  // 2 phút timeout cho ReAct loop
    })

    if (!res.ok) {
      console.warn(`[Gateway] Chat error ${res.status}`)
      return null
    }

    const data = await res.json()
    const content = data.choices?.[0]?.message?.content || 'No response'

    // Track token usage
    const usage = data.usage
    if (usage?.total_tokens) {
      addTokensUsed(usage.total_tokens, agentProvider, agentProfileId, agentModel)
    }

    // Track session
    if (sessionId) {
      await db.agentSession.upsert({
        where: { sessionId },
        create: {
          sessionId, model: agentModel, provider: agentProvider,
          title: messages[0]?.content?.slice(0, 50) || 'New Chat',
          messageCount: messages.length + 1,
          agentProfileId: agentProfileId || null,
          teamMode: teamMode || null, teamName: teamName || null,
        },
        update: { messageCount: { increment: 1 } },
      }).catch(() => {})
    }

    // Auto-learn, memory, etc. (giữ nguyên logic hiện tại)
    // ...

    return NextResponse.json({
      content,
      model: agentModel,
      provider: agentProvider,
      sessionId: sessionId || `session-${Date.now()}`,
      agentProfileId,
      sources: [],
      confidence: 0.7,
      kbResults: 'gateway-react',
      gatewayToolsAvailable: true,
    })
  } catch (err) {
    console.warn('[Gateway] Error:', err)
    return null
  }
}
```

**Thay đổi trong POST() handler:**

```typescript
// TRƯỚC (line 542-648):
if (hasAgentProviderModel) {
  // Luôn chạy local ReAct loop → bypasses Gateway
  const reactResult = await runAgentReActLoop(...)
  return NextResponse.json(...)
}
if (!hasAgentProviderModel) {
  // Chỉ thử Gateway khi KHÔNG có agent config
  const onlineResult = await isGatewayOnline()
  if (onlineResult.online) { ... }
}

// SAU:
// 1. Kiểm tra Gateway status
const gatewayAvailable = await isGatewayOnlineCached()

if (gatewayAvailable) {
  // 2a. Gateway online → route QUA Gateway (ALL agents, không phân biệt)
  const gatewayResponse = await routeThroughGateway({
    messages: fullMessages,
    agentProvider: agentProvider || 'nvidia',
    agentModel: agentModel || 'nvidia/nemotron-3-super-120b-a12b',
    sessionId, temperature: agentTemperature, maxTokens: agentMaxTokens,
    agentProfileId, agentProfileName, teamMode, teamName,
  })
  
  if (gatewayResponse) return gatewayResponse
  // Nếu Gateway trả về null (error) → fall through to local
}

// 2b. Gateway offline HOẶC Gateway error → fallback local ReAct loop
if (hasAgentProviderModel) {
  // Giữ nguyên runAgentReActLoop() hiện tại
  const reactResult = await runAgentReActLoop(...)
  return NextResponse.json(...)
}

// 2c. Cuối cùng → /api/query fallback (giữ nguyên)
```

**Kết quả P0.2:**
- Gateway online → 37 tools tự động khả dụng, không cần gửi tools trong request
- Gateway offline → Fallback local ReAct loop (7 tools)
- Mỗi Agent dùng model riêng qua `x-openclaw-model` header
- Không phá vỡ logic hiện tại

---

### P0.3: Sửa `callLLMForAgent()` — Thêm tools parameter (cho local fallback)

**File cần sửa:** `src/lib/llm.ts`

**Hiện tại (line 1730):**
```typescript
body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature })
// ❌ Không có tools parameter
```

**Sửa thành:**
```typescript
// Thêm tools parameter vào tryProviderWithSlotKey function signature
async function tryProviderWithSlotKey(
  slotIndex: number,
  pool: ProviderKeyPool,
  endpoint: string,
  models: string[],
  prompt: string,
  systemPrompt: string | undefined,
  timeoutMs: number = 120000,
  extraHeaders: Record<string, string> = {},
  rateLimitCooldownMs: number = 60000,
  temperature: number = 0.1,
  maxTokens: number = 4096,
  agentId?: string,
  agentName?: string,
  tools?: Array<{ type: string; function: { name: string; description: string; parameters: Record<string, unknown> } }>,
  // ← THÊM tools parameter
): Promise<LLMResult | null> {
  // ...existing code...

  // Sửa body JSON:
  body: JSON.stringify({
    model,
    messages,
    max_tokens: maxTokens ?? 4096,
    temperature: temperature ?? 0.1,
    ...(tools && tools.length > 0 ? { tools, tool_choice: 'auto' } : {}),
    // ← THÊM tools khi có
  }),
```

**Cũng sửa `callLLMForAgent()` (line 2296):**
```typescript
export async function callLLMForAgent(
  prompt: string,
  agentConfig: { provider: string; model: string },
  systemPrompt?: string,
  options?: LLMCallOptions & {
    tools?: Array<{ type: string; function: { name: string; description: string; parameters: Record<string, unknown> } }>
  },
): Promise<LLMResult> {
  const { provider, model } = agentConfig

  // Pass tools to provider call
  const agentResult = await callLLMWithSpecificProvider(
    prompt, provider, model, systemPrompt,
    { ...options, tools: options?.tools }  // ← THÊM
  )
  if (agentResult?.content) return agentResult

  return callLLM(prompt, systemPrompt, 'agent-fallback', options)
}
```

**Sửa `callLLMWithSpecificProvider()` (line 2238):**
```typescript
async function callLLMWithSpecificProvider(
  prompt: string,
  provider: string,
  model: string,
  systemPrompt?: string,
  options?: LLMCallOptions & {
    tools?: Array<{ type: string; function: { name: string; description: string; parameters: Record<string, unknown> } }>
  },
): Promise<LLMResult | null> {
  // ...existing code...
  
  const result = await tryProviderWithSlotKey(
    -1, config.pool, config.endpoint, [model],
    prompt, systemPrompt, config.timeout, config.extraHeaders,
    config.rateLimitCooldown,
    options?.temperature ?? 0.1,
    options?.maxTokens ?? 4096,
    options?.agentId, options?.agentName,
    options?.tools,  // ← THÊM
  )
  return result
}
```

**Sửa response parsing trong tryProviderWithSlotKey:**
```typescript
// Hiện tại (line 1760):
const data = await response.json() as {
  choices: Array<{ message: { content: string } }>
  usage?: { ... }
}

// Sửa thành:
const data = await response.json() as {
  choices: Array<{
    message: {
      content: string
      tool_calls?: Array<{
        id: string
        type: 'function'
        function: { name: string; arguments: string }
      }>
    }
    finish_reason?: string
  }>
  usage?: { ... }
}

// Thêm tool_calls vào LLMResult:
const toolCalls = data.choices?.[0]?.message?.tool_calls
return {
  content: data.choices?.[0]?.message?.content || '',
  // ...existing fields...
  toolCalls,  // ← THÊM structured tool_calls
  finishReason: data.choices?.[0]?.finish_reason,
}
```

**Cũng cần sửa LLMResult type:**
```typescript
// Thêm vào interface LLMResult:
export interface LLMResult {
  content: string
  error?: string
  // ...existing fields...
  toolCalls?: Array<{    // ← THÊM
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
  finishReason?: string  // ← THÊM
}
```

---

### P0.4: Sửa ReAct Loop — Dùng structured tool_calls

**File cần sửa:** `src/app/api/openclaw/chat/route.ts` (runAgentReActLoop, line 64-189)

**Hiện tại:**
```typescript
// Gọi LLM KHÔNG có tools
const result = await callLLMForAgent(formattedPrompt, { provider, model }, systemPrompt, options)

// Parse tool calls bằng regex
const toolCalls = parseToolCallsFromOutput(result.content)
```

**Sửa thành:**
```typescript
// 1. Lấy tool definitions cho agent
const toolDefs = agentTools.length > 0 
  ? getToolDefinitions(agentTools)  // existing function
  : []

// 2. Gọi LLM CÓ tools parameter
const result = await callLLMForAgent(
  formattedPrompt, 
  { provider: agentProvider, model: agentModel },
  systemPrompt,
  {
    agentId, agentName,
    temperature: agentTemperature,
    maxTokens: agentMaxTokens,
    tools: toolDefs,  // ← GỬI tools cho LLM
  }
)

// 3. Parse structured tool_calls (ưu tiên), fallback regex
let toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }> = []

if (result.toolCalls && result.toolCalls.length > 0) {
  // ✅ Structured tool_calls từ LLM (preferred)
  toolCalls = result.toolCalls.map(tc => ({
    id: tc.id,
    name: tc.function.name,
    args: JSON.parse(tc.function.arguments),
  }))
} else {
  // ❌ Fallback regex (cho models không hỗ trợ tool calling)
  toolCalls = parseToolCallsFromOutput(result.content)
}
```

**Thêm OpenAI-compliant tool result format:**
```typescript
// Khi thêm tool result vào messages:
for (const tc of toolCalls) {
  const toolResult = await executeTool(tc.name, tc.args)
  
  messages.push({
    role: 'tool',
    content: JSON.stringify({ tool: tc.name, success: toolResult.success, result: toolResult.result }),
    tool_call_id: tc.id,  // ← THÊM tool_call_id (cần cho OpenAI format)
  })
}
```

---

### P0.5: Mở Rộng executeTool() — Thêm Gateway Tools

**File cần sửa:** `src/lib/code-team/tool-executor.ts`

**Hiện tại:** switch/case chỉ handle 7 tools

**Sửa thành: Thêm Gateway proxy tools**

```typescript
// Thêm vào ALL_TOOL_DEFINITIONS:
const GATEWAY_TOOL_DEFINITIONS: Record<string, ToolDefinition> = {
  web_search: {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Tìm kiếm trên web. Trả về kết quả với nội dung tóm tắt.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Câu hỏi tìm kiếm' },
        },
        required: ['query'],
      },
    },
  },
  web_fetch: {
    type: 'function',
    function: {
      name: 'web_fetch',
      description: 'Fetch nội dung trang web từ URL. Trả về text content.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL trang web cần đọc' },
        },
        required: ['url'],
      },
    },
  },
  // ... thêm các tools khác từ Gateway catalog
}

// Thêm Gateway tool executor:
async function executeGatewayTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const res = await fetch('http://127.0.0.1:18789/tools/invoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, args }),
    signal: AbortSignal.timeout(30000),
  })
  
  if (!res.ok) {
    throw new Error(`Gateway tool error: ${res.status}`)
  }
  
  const data = await res.json()
  if (!data.ok) {
    throw new Error(`Tool error: ${data.error?.message || 'Unknown'}`)
  }
  
  return data.result
}

// Sửa executeTool():
export async function executeTool(
  toolName: string,
  args: Record<string, unknown>
): Promise<ToolExecutionResult> {
  const startTime = Date.now()

  try {
    let result: unknown

    // 1. Thử local tools trước (7 tools hiện có)
    if (['opencode', 'knowledge_search', 'knowledge_graph', 
         'knowledge_write', 'tavily', 'serper', 'jina'].includes(toolName)) {
      // ... existing switch/case ...
    }
    
    // 2. Thử Gateway tools (37 tools, chỉ HTTP-allowed ones)
    else {
      result = await executeGatewayTool(toolName, args)
    }

    return { success: true, result, duration: Date.now() - startTime }
  } catch (err) {
    // ...existing error handling...
  }
}
```

**Lưu ý:** Gateway `/tools/invoke` chỉ cho phép các tools KHÔNG trong deny list:
- ✅ Available: `web_search`, `web_fetch`, `x_search`, `memory_search`, `memory_get`, `sessions_list`, `session_status`, `agents_list`, `message`, `image`, `tts`
- ❌ Denied: `exec`, `read`, `write`, `edit`, `apply_patch`, `sessions_spawn`, `sessions_send`, `cron`, `gateway`, `nodes`

---

### P0.6: Frontend — Hiển thị Gateway Tool Status

**File cần sửa:** `src/app/page.tsx` (SmolabModule)

**Chi tiết:**
- Thêm indicator "Gateway: Online/Offline" trong Smolab header
- Hiển thị số tools khả dụng (37 khi online, 7 khi offline)
- Khi tool được gọi qua Gateway, hiển thị "🔧 Tool: web_search" trong chat message

```typescript
// Thêm state:
const [gatewayStatus, setGatewayStatus] = useState<{ online: boolean; tools: number }>({ online: false, tools: 7 })

// Check gateway status on mount:
useEffect(() => {
  fetch('/api/openclaw/status').then(r => r.json()).then(data => {
    setGatewayStatus({ online: data.gatewayOnline, tools: data.toolsAvailable })
  }).catch(() => {})
}, [])
```

**Thêm API endpoint:** `src/app/api/openclaw/status/route.ts`
```typescript
export async function GET() {
  const { online } = await isGatewayOnline()
  return NextResponse.json({
    gatewayOnline: online,
    toolsAvailable: online ? 37 : 7,
    gatewayUrl: process.env.OPENCLAW_GATEWAY_URL || 'http://127.0.0.1:18789',
  })
}
```

---

### P0 Checklist

| # | Task | File | Mô Tả |
|---|------|------|-------|
| P0.1 | Cấu hình NVIDIA key cho Gateway | `mini-services/openclaw-gateway/index.ts` | Pass NVIDIA_API_KEY env cho child process |
| P0.2 | Gateway-First chat routing | `src/app/api/openclaw/chat/route.ts` | Route qua Gateway trước, fallback local |
| P0.3 | Thêm tools param cho callLLMForAgent | `src/lib/llm.ts` | Sửa 3 functions + LLMResult type |
| P0.4 | Structured tool_calls trong ReAct loop | `src/app/api/openclaw/chat/route.ts` | Ưu tiên structured, fallback regex |
| P0.5 | Mở rộng executeTool với Gateway proxy | `src/lib/code-team/tool-executor.ts` | Thêm Gateway tool executor |
| P0.6 | Frontend Gateway status indicator | `src/app/page.tsx` + API mới | Hiển thị online/offline + tool count |

---

## 4. P1: Skills → Tools Connection

### Mục tiêu
ClawHub skills cài vào app tạo ra executable tools. Agent có thể gọi tools từ skills đã cài.

### Thời gian dự kiến: 3-4 ngày

### P1.1: Hiểu ClawHub Package Structure

**Nghiên cứu trước khi code:**
- ClawHub API: `https://clawhub.ai/api/v1/packages/{id}` — trả về gì?
- Archive format: `.tar.gz`? `.zip`? Cấu trúc bên trong?
- Phân biệt: Skill (SKILL.md), Plugin (executable code), Tool (function schema + handler)

**Khảo sát:**
```bash
# Test ClawHub API
curl https://clawhub.ai/api/v1/search?q=web
curl https://clawhub.ai/api/v1/packages/{package-id}
```

### P1.2: Implement Archive Download

**File cần sửa:** `src/app/api/openclaw/skills/route.ts`

**Hiện tại (Install flow):**
```typescript
// Chỉ fetch SKILL.md từ ClawHub → lưu vào AgentSkill table
const skillRes = await fetch(`${CLAWHUB_API}/packages/${packageId}`)
const skillData = await skillRes.json()
// Lưu skillData.readme (SKILL.md content) vào DB
```

**Sửa thành:**
```typescript
// 1. Fetch full package info
const packageRes = await fetch(`${CLAWHUB_API}/packages/${packageId}`)
const packageData = await packageRes.json()

// 2. Download archive (nếu có)
if (packageData.archiveUrl) {
  const archiveRes = await fetch(packageData.archiveUrl)
  const archiveBuffer = await archiveRes.arrayBuffer()
  
  // 3. Extract archive
  const extracted = await extractArchive(archiveBuffer)
  
  // 4. Tìm Plugin/Tool definitions
  const pluginFiles = extracted.filter(f => f.name.endsWith('.plugin.js') || f.name.endsWith('.plugin.ts'))
  const toolFiles = extracted.filter(f => f.name.endsWith('.tool.json'))
  const skillMd = extracted.find(f => f.name === 'SKILL.md')
  
  // 5. Lưu vào filesystem
  const skillDir = path.join(process.cwd(), 'skills', packageId)
  await fs.mkdir(skillDir, { recursive: true })
  for (const file of extracted) {
    await fs.writeFile(path.join(skillDir, file.name), file.content)
  }
  
  // 6. Register tools vào Gateway (nếu Gateway online)
  for (const toolFile of toolFiles) {
    const toolSchema = JSON.parse(toolFile.content)
    await registerToolWithGateway(toolSchema)
  }
}

// 7. Lưu metadata vào DB
await db.agentSkill.upsert({
  where: { id: packageId },
  create: {
    id: packageId,
    name: packageData.name,
    description: packageData.description,
    content: skillMd?.content || packageData.readme || '',
    enabled: true,
    source: 'clawhub',
    archiveUrl: packageData.archiveUrl,
    toolCount: toolFiles?.length || 0,
    hasPlugin: pluginFiles?.length > 0,
  },
  update: {
    archiveUrl: packageData.archiveUrl,
    toolCount: toolFiles?.length || 0,
    hasPlugin: pluginFiles?.length > 0,
  },
})
```

### P1.3: Tool Schema Validation

**File mới:** `src/lib/skill-tool-schema.ts`

```typescript
/**
 * Validate tool schema theo OpenAI function calling format
 */
export interface SkillToolSchema {
  name: string
  description: string
  parameters: {
    type: 'object'
    properties: Record<string, {
      type: string
      description?: string
      enum?: string[]
      default?: unknown
    }>
    required?: string[]
  }
}

export function validateToolSchema(schema: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = []
  
  if (!schema || typeof schema !== 'object') {
    return { valid: false, errors: ['Schema must be an object'] }
  }
  
  const s = schema as Record<string, unknown>
  
  if (!s.name || typeof s.name !== 'string') errors.push('Missing "name" field')
  if (!s.description || typeof s.description !== 'string') errors.push('Missing "description" field')
  if (!s.parameters || typeof s.parameters !== 'object') errors.push('Missing "parameters" field')
  
  return { valid: errors.length === 0, errors }
}
```

### P1.4: Register Tools với Gateway

**File mới:** `src/lib/gateway-tool-registry.ts`

```typescript
/**
 * Register custom tools with OpenClaw Gateway
 * Uses Gateway's plugin system to add tools dynamically
 */

const GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL || 'http://127.0.0.1:18789'

export async function registerToolWithGateway(tool: {
  name: string
  description: string
  parameters: Record<string, unknown>
  handler?: string  // URL của tool handler endpoint
}): Promise<boolean> {
  try {
    // OpenClaw Gateway hỗ trợ dynamic tool registration qua plugin API
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
        // Handler URL — Gateway sẽ gọi endpoint này khi tool được invoke
        ...(tool.handler ? { handler: { type: 'http', url: tool.handler } } : {}),
      }),
    })
    return res.ok
  } catch {
    return false
  }
}

export async function unregisterToolFromGateway(toolName: string): Promise<boolean> {
  try {
    const res = await fetch(`${GATEWAY_URL}/v1/tools/unregister`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: toolName }),
    })
    return res.ok
  } catch {
    return false
  }
}
```

### P1.5: Skill Install UI — Hiển thị Tool Count

**File cần sửa:** `src/app/page.tsx` (SkillsTabContent)

**Chi tiết:**
- Khi search ClawHub, hiển thị số tools trong mỗi package
- Nút "Install" → download archive + register tools
- Tab "Installed Skills" → hiển thị tools đã register
- Nút "Uninstall" → unregister tools + xóa files

### P1 Checklist

| # | Task | File | Mô Tả |
|---|------|------|-------|
| P1.1 | Nghiên cứu ClawHub API | N/A | Test archive download, package structure |
| P1.2 | Archive download + extract | `skills/route.ts` | Download, extract, save to filesystem |
| P1.3 | Tool schema validation | `skill-tool-schema.ts` (mới) | Validate tool definitions |
| P1.4 | Gateway tool registry | `gateway-tool-registry.ts` (mới) | Register/unregister tools |
| P1.5 | UI: Tool count + install | `page.tsx` | Hiển thị tools trong skills |

---

## 5. P2: Full Archive Download & Execution

### Mục tiêu
ClawHub packages có đầy đủ Skill + Plugin + Tool. Tools chạy trong sandbox an toàn.

### Thời gian dự kiến: 3-5 ngày

### P2.1: Plugin Execution Engine

**File mới:** `src/lib/plugin-runner.ts`

**Chi tiết:**
- Load plugin JS files từ `skills/{packageId}/` directory
- Execute trong sandboxed context (VM2 hoặc similar)
- Expose safe APIs cho plugin (fetch, db read, etc.)
- Catch errors, timeout, resource limits

```typescript
interface PluginExecutionContext {
  toolName: string
  args: Record<string, unknown>
  allowedApis: string[]  // ['fetch', 'db.read', 'memory.search']
  timeout: number        // ms
  maxMemory: number      // bytes
}

async function executePlugin(
  pluginPath: string,
  context: PluginExecutionContext
): Promise<unknown> {
  // 1. Load plugin module
  // 2. Call handler function with args
  // 3. Apply timeout
  // 4. Return result
}
```

### P2.2: Tool Permission System

**File cần sửa:** `prisma/schema.prisma`

```prisma
model ToolPermission {
  id          String   @id @default(cuid())
  agentProfileId String?  /// FK → AgentProfile (null = global)
  toolName    String   /// Tool name (e.g., "web_search", "exec")
  source      String   @default("builtin") /// "builtin" | "gateway" | "skill" | "custom"
  allowed     Boolean  @default(true)
  requiresApproval Boolean @default(false) /// Cần user approval trước khi chạy
  maxCallsPerHour  Int?     /// Rate limit
  createdAt   DateTime @default(now())

  agentProfile AgentProfile? @relation(fields: [agentProfileId], references: [id], onDelete: Cascade)

  @@unique([agentProfileId, toolName])
  @@index([toolName])
}
```

### P2.3: Security & Sandboxing

**Chi tiết:**
- File operations: Chỉ cho phép trong project directory
- Exec: Whitelist commands, block dangerous ones (`rm -rf /`, `sudo`, etc.)
- Network: Chỉ cho phép HTTP/HTTPS, block internal IPs
- Memory/CPU: Limits per tool execution
- Timeout: Default 30s, configurable per tool

### P2.4: Tool Marketplace UI Improvements

**File cần sửa:** `src/app/page.tsx`

**Chi tiết:**
- Rating/reviews cho skills
- "Popular" và "Featured" tabs
- Auto-update check cho installed skills
- Dependency management (skill A requires skill B)

### P2 Checklist

| # | Task | File | Mô Tả |
|---|------|------|-------|
| P2.1 | Plugin execution engine | `plugin-runner.ts` (mới) | Sandbox, timeout, resource limits |
| P2.2 | Tool permission system | `schema.prisma` + API | Per-agent tool permissions |
| P2.3 | Security & sandboxing | Multiple | File/exec/network limits |
| P2.4 | Marketplace UI | `page.tsx` | Rating, auto-update, dependencies |

---

## 6. P3: Extensible Tool System

### Mục tiêu
Hệ thống tools mở rộng, dễ thêm/bớt, per-agent permissions, analytics.

### Thời gian dự kiến: 5-7 ngày

### P3.1: Dynamic Tool Registration/Deregistration

**Chi tiết:**
- API endpoint: `POST /api/tools/register` — Đăng ký tool mới
- API endpoint: `DELETE /api/tools/{name}` — Gỡ tool
- Tool hot-reload — Không cần restart server
- Tool versioning — Nhiều version cùng tồn tại

### P3.2: Tool Permissions per Agent

**Chi tiết:**
- UI: Mỗi Agent có trang "Tools" riêng
- Toggle on/off cho từng tool
- Quota system: max calls per hour/day
- Approval queue: Tools cần approval chạy qua UI trước

### P3.3: Tool Usage Analytics

**Chi tiết:**
- Log mọi tool call: timestamp, agent, tool, args, result, duration
- Dashboard: Top tools, success rate, avg duration
- Alert: Tool failure rate > threshold → notification
- Export: CSV/JSON data cho analysis

### P3.4: Custom Tool Creation UI

**Chi tiết:**
- Visual tool builder: Name, description, parameters (type, required, enum)
- Code editor cho tool handler (JavaScript)
- Test panel: Chạy thử tool với args
- Publish: Đăng lên ClawHub hoặc giữ private

### P3 Checklist

| # | Task | File | Mô Tả |
|---|------|------|-------|
| P3.1 | Dynamic registration | `api/tools/` (mới) | Hot-reload, versioning |
| P3.2 | Per-agent permissions | UI + API | Toggle, quota, approval |
| P3.3 | Usage analytics | Dashboard | Logs, metrics, alerts |
| P3.4 | Custom tool builder | UI (mới) | Visual builder, test, publish |

---

## 7. Dependency Map

```
P0.1 (NVIDIA key cho Gateway)
  └──→ P0.2 (Gateway-First routing) ← DEPENDS ON P0.1
  
P0.3 (tools param cho callLLMForAgent) ← INDEPENDENT
P0.4 (Structured tool_calls) ← DEPENDS ON P0.3
P0.5 (Gateway tool proxy) ← DEPENDS ON P0.2
P0.6 (Frontend status) ← DEPENDS ON P0.2

P1.1 (ClawHub research) ← INDEPENDENT (có thể song song P0)
P1.2 (Archive download) ← DEPENDS ON P1.1
P1.3 (Schema validation) ← INDEPENDENT
P1.4 (Gateway registry) ← DEPENDS ON P1.2 + P1.3
P1.5 (UI) ← DEPENDS ON P1.4

P2.1 (Plugin runner) ← DEPENDS ON P1.4
P2.2 (Permissions) ← DEPENDS ON P0.5
P2.3 (Security) ← DEPENDS ON P2.1
P2.4 (Marketplace UI) ← DEPENDS ON P1.5

P3.1 (Dynamic registration) ← DEPENDS ON P2.1
P3.2 (Per-agent permissions) ← DEPENDS ON P2.2
P3.3 (Analytics) ← DEPENDS ON P2.1
P3.4 (Custom tool builder) ← DEPENDS ON P3.1
```

### Song song khả thi:
- **P0.1 + P0.3** có thể làm song song
- **P1.1** (research) có thể làm song song với P0
- **P1.3** (schema validation) có thể làm song song với P1.2

---

## 8. Risk & Mitigation

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| Gateway NVIDIA key không work | P0 blocked | Medium | Test trước bằng curl; fallback local ReAct |
| Gateway crash khi load cao | Tools mất | Medium | Local fallback đã implement trong P0.2 |
| x-openclaw-model header không route đúng model | Agent dùng sai model | Low | Test từng model trước; log model trong response |
| ClawHub archive format không như expected | P1 blocked | Medium | Research kỹ (P1.1) trước khi code; fallback SKILL.md-only |
| Plugin sandbox escape | Security breach | Low | Dùng VM2; whitelist APIs; limit resources |
| Tool calling chậm (nhiều iterations) | UX kém | Medium | Timeout per iteration; streaming UI; max 5 iterations |
| NVIDIA rate limit (4 keys) | Agent không gọi được | Medium | Round-robin keys; exponential backoff; queue system |

---

## Phụ Lục: Files Impact Summary

### P0 — Files cần sửa/tạo:

| File | Action | Mô Tả |
|------|--------|-------|
| `mini-services/openclaw-gateway/index.ts` | SỬA | Thêm NVIDIA_API_KEY env cho child process |
| `src/app/api/openclaw/chat/route.ts` | SỬA | Gateway-First routing + structured tool_calls |
| `src/lib/llm.ts` | SỬA | Thêm tools param (3 functions + LLMResult type) |
| `src/lib/code-team/tool-executor.ts` | SỬA | Thêm Gateway proxy tools |
| `src/app/page.tsx` | SỬA | Gateway status indicator |
| `src/app/api/openclaw/status/route.ts` | TẠO MỚI | Gateway status API |

### P1 — Files cần sửa/tạo:

| File | Action | Mô Tả |
|------|--------|-------|
| `src/app/api/openclaw/skills/route.ts` | SỬA | Archive download + extract |
| `src/lib/skill-tool-schema.ts` | TẠO MỚI | Tool schema validation |
| `src/lib/gateway-tool-registry.ts` | TẠO MỚI | Gateway tool registration |
| `src/app/page.tsx` | SỬA | Skills UI improvements |

### P2 — Files cần sửa/tạo:

| File | Action | Mô Tả |
|------|--------|-------|
| `src/lib/plugin-runner.ts` | TẠO MỚI | Plugin sandbox execution |
| `prisma/schema.prisma` | SỬA | ToolPermission model |
| Multiple files | SỬA | Security middleware |

### P3 — Files cần sửa/tạo:

| File | Action | Mô Tả |
|------|--------|-------|
| `src/app/api/tools/` | TẠO MỚI | Tool CRUD API |
| `src/app/page.tsx` | SỬA | Tool management UI |
| Analytics files | TẠO MỚI | Usage tracking + dashboard |
