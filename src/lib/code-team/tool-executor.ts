/**
 * Code Team — Tool Execution Layer
 *
 * Central place to execute all tools that agents can call via LLM function calling.
 * Supports ReAct loop: LLM returns tool_call → execute → feed result back → repeat.
 *
 * Tools available (per-agent permissions from agents.ts):
 *   - opencode:         Code operations (read/write/bash) — via internal API
 *   - knowledge_search:  Semantic search in KB (Qdrant) — via knowledge-bridge
 *   - knowledge_graph:   Graph query (Neo4j Cypher) — via knowledge-bridge
 *   - knowledge_write:   Write entity/relationship to KB — via knowledge-bridge
 *   - tavily:           AI-optimized web search — via Tavily API + z-ai-sdk fallback
 *   - serper:           Google search — via Serper API + z-ai-sdk fallback
 *   - jina:             Web page reader — via Jina API + z-ai-sdk fallback
 *
 * Architecture:
 *   Workflow Engine → callLLMForAgent() with tool definitions
 *   → LLM returns tool_call → executeTool() → feed result back
 *   → Repeat until LLM outputs text (no more tool_calls)
 *
 * Phase 5 Enhancement:
 *   - Tavily/Serper/Jina use direct API keys (from .env)
 *   - z-ai-web-dev-sdk provides automatic fallback when API keys fail
 *   - Skills installed from Clawhub Market (web_search + page_reader)
 */

import { getAgentTools } from './agents'
import { tavilyKeyPool, jinaKeyPool, serperKeyPool } from '@/lib/service-key-pool'
import { ensureTmoApiToken } from '@/lib/tmo-token'
// Agent Activity Log — mọi tool call được echo vào ô Terminal (user request 2026-08-27)
import { recordAgentActivity } from '@/lib/agent-activity-log'
// Agent Run Tracker — Thought Process + Todos + Progress trong chat
// (user request 2026-08-31 — mọi agents hiển thị tư duy/tiến trình realtime)
import { recordAgentRunTool, recordAgentRunTodos } from '@/lib/agent-run-tracker'
import {
  fileEdit, fileWrite, fileDelete, fileList, grep,
  runTests, gitCommit, gitPush, gitPullWorkspace,
  getDiagnostics, decomposeTask, createTask, updateTask, getPlan,
  summarize, synthesize,
  runBg, readOutput, killProcess,
  managePackages,
  gatewayTool,
  // v2.1 Phase 1a — new primitives
  shell as executeShellFn,
  todoWrite as executeTodoWriteFn,
  todoRead as executeTodoReadFn,
  // v2.1 Phase 2.1 — Claude Code parity file_read
  fileRead as executeFileReadFn,
  // v2.1 Phase 3 — code intelligence + MCP (spec lines 223-242)
  browserScreenshot as executeBrowserScreenshotFn,
  lint as executeLintFn,
  typeCheck as executeTypeCheckFn,
  testCoverage as executeTestCoverageFn,
  dbQuery as executeDbQueryFn,
  // CI-6 / CI-4 (Task 10-b) — mở workspace bằng File Explorer / VS Code
  openWorkspaceInExplorer as openWorkspaceInExplorerFn,
  // CI-4 B3-B5 (Task 11-c) — structured git tools (khảo sát repo + branch/clone)
  gitStatus as executeGitStatusFn,
  gitDiff as executeGitDiffFn,
  gitLog as executeGitLogFn,
  gitBranch as executeGitBranchFn,
  gitClone as executeGitCloneFn,
  // CI-3 B2+B3 (Task 13-b) — Kho Context: truy hồi context đã nén
  contextRecall as executeContextRecallFn,
  // Dynamic skill + MCP enumeration (user request 2026-08-29)
  listSkills as executeListSkillsFn,
  readSkill as executeReadSkillFn,
  mcpListServers as executeMcpListServersFn,
} from './dev-tools'
// v2.1 Phase 3.6 — MCP bridge (separate module)
import { mcpCall as executeMcpCallFn } from '@/lib/mcp/mcp-bridge'
// CI-6.4 (Task 10-b) — pipeline kiểm định 5 lớp trước push (lint→typecheck→tests→
// smoke→secret scan→commit→push→pull verify; TỪ CHỐI push khi có bước fail)
import { runPrePushVerification } from './pre-push-verify'
import { isFlagEnabled, flagMode } from '@/lib/feature-flags'
// Phase 6 (rebuild) — start_preview/stop_preview operate on the USER's ACTIVE workspace
import { getActiveWorkspaceRoot } from '@/lib/workspace/workspace-manager'
// 21-d: resolve workspace root cho opencode action=write (thay process.cwd()) —
// pattern giống file_* tools (workspace-root.ts: active workspace → env → cwd)
import { resolveWorkspaceRoot } from './workspace-root'
// Task 19-b (App Runtime Awareness) — agents NHÌN THẤY runtime của app:
// preview nào đang chạy (port/pid/ai khởi động), HTTP probe + tail log.
import { listRunningPreviews, tailPreviewLog } from '@/lib/preview-registry'
import { listPreviewPorts } from '@/lib/preview-ports'
// v2.1 Phase 4.6 — Cron scheduler (separate module)
import {
  createCronJob as createCronJobFn,
  listCronJobs as listCronJobsFn,
  deleteCronJob as deleteCronJobFn,
  runCronJob as runCronJobFn,
  type CronSchedule,
} from '@/lib/cron/scheduler'
// v2.1 Phase 4.5 — exit_plan_mode persistence (uses db.codeTeamSession metadata)
import { db } from '@/lib/db'
// 21-c: Tool Access — hard-gate tool bị disable-override theo agent (ToolAssignment DB)
import { isToolDisabledForAgent, resolveAgentKey } from '@/lib/tool-access'

// ==================== Z-AI-SDK LAZY INITIALIZATION ====================
//
// ⚠️  IMPORTANT: z-ai-web-dev-sdk is an OPTIONAL dependency!
//
// This SDK ONLY works inside the z.ai sandbox environment where backend
// services (web_search, page_reader) are available. If you clone this
// project and run locally, the SDK will not initialize — this is expected
// and NOT an error. Direct API keys (TAVILY_API_KEY, SERPER_API_KEY,
// JINA_API_KEY) in .env will be used instead.
//
// Fallback chain: Direct API key → z-ai-sdk → error with helpful hint
//

let zaiInstance: any = null
let zaiInitPromise: Promise<any> | null = null
let zaiAvailable: boolean | null = null // null = not yet checked

async function getZAI(): Promise<any> {
  if (zaiInstance) return zaiInstance
  if (zaiInitPromise) return zaiInitPromise

  zaiInitPromise = (async () => {
    try {
      const ZAI = (await import('z-ai-web-dev-sdk')).default
      const instance = await ZAI.create()
      console.log('[ToolExecutor] ✅ z-ai-web-dev-sdk initialized — web_search + page_reader available as fallback')
      zaiInstance = instance
      zaiAvailable = true
      return instance
    } catch (err) {
      zaiAvailable = false
      console.warn(
        '[ToolExecutor] z-ai-web-dev-sdk not available (this is normal for local deployment — direct API keys will be used).',
        `Detail: ${err instanceof Error ? err.message : String(err)}`
      )
      return null
    }
  })()

  return zaiInitPromise
}

/** Phase 1a/1b fix — Race an async operation against a timeout.
 *
 * Wraps z-ai-sdk `functions.invoke()` calls (and similar) so a hung SDK
 * cannot stall the entire workflow. Without this, executeTavily/Serper/Jina/
 * WebSearch/WebFetch could hang forever if z-ai-sdk internal state goes bad.
 *
 * Spec: docs/FULLSTACK_CAPABILITY_PLAN_V2.md Part 4 Phase 1b.1
 */
async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timeout after ${timeoutMs}ms`))
    }, timeoutMs)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Shape kết quả z-ai-sdk functions.invoke('page_reader') — chỉ các field code dùng */
interface ZaiPageReaderResult {
  data?: {
    html?: string
    title?: string
  }
}

// ==================== TOOL DEFINITIONS (OpenAI function calling format) ====================
// Each agent receives tools according to its permissions from agents.ts

export interface ToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: {
      type: 'object'
      properties: Record<string, unknown>
      // JSON Schema cho phép omit `required` (không param nào bắt buộc)
      required?: string[]
    }
  }
}

// ==================== CI-4 B6 (Task 11-c): MCP MOCK DE-ADVERTISE ====================
//
// mcp-bridge.ts ship 4 built-in servers (filesystem/github/postgres/puppeteer)
// đều mock:true (Phase 3 stub) — agents gọi mcp_call nhận dữ liệu GIẢ (vd
// github create_pr → "PR #42" không tồn tại) rồi hành động/nói dối user theo
// dữ liệu đó. Fix: ẨN mock built-ins khỏi mọi bề mặt agents NHÌN THẤY —
//   (1) mô tả tool mcp_call / mcp_list_servers không còn liệt kê chúng,
//   (2) mcp_list_servers case lọc chúng khỏi listing,
//   (3) mcp_call case chặn thẳng gọi trúng (redirect sang tools builtin thật).
// mcp-bridge.ts GIỮ NGUYÊN (mock wiring còn cho Phase 5 thay bằng subprocess
// thật — bỏ flag mock thì các lọc dưới tự mở lại). Servers operator khai báo
// qua env MCP_SERVERS / ~/.config/mcp/servers.json KHÔNG bị ảnh hưởng.

/** 4 built-in MCP servers Phase 3 (mock:true trong mcp-bridge BUILTIN_SERVERS) */
const MCP_MOCK_BUILTIN_IDS = ['filesystem', 'github', 'postgres', 'puppeteer'] as const

/**
 * Set ID của built-in servers đang còn mock — tra động từ mcp-bridge để khi
 * Phase 5 hiện thực server nào (bỏ mock) thì server đó tự hiện lại cho agents.
 * Fail-open về danh sách tĩnh nếu bridge lỗi (vẫn ẩn — an toàn hơn).
 */
async function getHiddenMockMcpServerIds(): Promise<Set<string>> {
  try {
    const { listAvailableServers } = await import('@/lib/mcp/mcp-bridge')
    const all = await listAvailableServers()
    return new Set(
      all.filter(s => s.mock && (MCP_MOCK_BUILTIN_IDS as readonly string[]).includes(s.id)).map(s => s.id),
    )
  } catch {
    return new Set(MCP_MOCK_BUILTIN_IDS)
  }
}

/**
 * Lọc mock built-in servers khỏi receipt của mcp_list_servers (đổi tại chỗ —
 * shape giữ nguyên, chỉ mảng servers[] bị lọc + ghi chú _note cho agents).
 */
async function filterMockMcpServersFromListing(raw: unknown): Promise<unknown> {
  try {
    if (raw && typeof raw === 'object' && Array.isArray((raw as { servers?: unknown }).servers)) {
      const listing = raw as { servers?: Array<Record<string, unknown>>; [k: string]: unknown }
      const hidden = await getHiddenMockMcpServerIds()
      const before = listing.servers?.length ?? 0
      listing.servers = (listing.servers || []).filter(s => !hidden.has(String(s.id || '')))
      const hiddenCount = before - (listing.servers?.length ?? 0)
      if (hiddenCount > 0) {
        listing._note = `Đã ẩn ${hiddenCount} built-in mock server (Phase 3 stub — Phase 5 chưa hiện thực). Chỉ MCP servers operator cấu hình (env MCP_SERVERS / ~/.config/mcp/servers.json) được liệt kê.`
      }
      return listing
    }
    return raw
  } catch {
    return raw // fail-open shape gốc
  }
}

// Log 1 lần khi module load (globalThis guard chống HMR double-log)
;(() => {
  const g = globalThis as { __tmoMcpMockHiddenLogged?: boolean }
  if (g.__tmoMcpMockHiddenLogged) return
  g.__tmoMcpMockHiddenLogged = true
  console.log('[MCP] Built-in mock servers hidden from agents (filesystem/github/postgres/puppeteer — Phase 5 chưa hiện thực)')
})()

const ALL_TOOL_DEFINITIONS: Record<string, ToolDefinition> = {
  opencode: {
    type: 'function',
    function: {
      name: 'opencode',
      description: 'Thực hiện code operations: đọc file, viết file, chạy terminal command, tạo thư mục. Dùng để implement code theo architecture spec.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['read', 'write', 'bash', 'mkdir'],
            description: 'Hành động cần thực hiện',
          },
          path: {
            type: 'string',
            description: 'Đường dẫn file hoặc thư mục (cho read/write/mkdir). Phải là đường dẫn tương đối từ project root.',
          },
          content: {
            type: 'string',
            description: 'Nội dung file (cho write action). Code đầy đủ, có error handling và comments.',
          },
          command: {
            type: 'string',
            description: 'Terminal command (cho bash action). Ví dụ: "npm run build", "npm test".',
          },
        },
        required: ['action'],
      },
    },
  },
  knowledge_search: {
    type: 'function',
    function: {
      name: 'knowledge_search',
      description: 'Tìm kiếm semantic trong Knowledge Base (Qdrant + Neo4j). Trả về relevant chunks, entities, relationships. Dùng khi cần tra cứu kiến thức đã học, best practices, hoặc thông tin về project.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Câu hỏi hoặc từ khóa cần tìm kiếm',
          },
          topK: {
            type: 'number',
            description: 'Số kết quả trả về (default: 5, max: 20)',
            default: 5,
          },
        },
        required: ['query'],
      },
    },
  },
  knowledge_graph: {
    type: 'function',
    function: {
      name: 'knowledge_graph',
      description: 'Truy vấn đồ thị Neo4j bằng Cypher query. CHỈ CHO PHÉP MATCH (read-only). Dùng khi cần tìm relationships giữa entities, phân tích graph structure.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Cypher query (chỉ MATCH, không CREATE/DELETE/SET). Ví dụ: "MATCH (n:Entity)-[r:DEPENDS_ON]->(m) RETURN n,m,r LIMIT 10"',
          },
        },
        required: ['query'],
      },
    },
  },
  knowledge_write: {
    type: 'function',
    function: {
      name: 'knowledge_write',
      description: 'Ghi entity hoặc relationship mới vào Knowledge Base. Dùng bởi G3 (CATALYST) để ghi self-evolving lessons. Entity sẽ được sync lên Neo4j sau.',
      parameters: {
        type: 'object',
        properties: {
          entityName: {
            type: 'string',
            description: 'Tên entity (ví dụ: "N+1 Query Pattern", "Prisma Include Strategy")',
          },
          entityType: {
            type: 'string',
            description: 'Loại entity (ví dụ: "AntiPattern", "BestPractice", "Concept", "Component")',
          },
          description: {
            type: 'string',
            description: 'Mô tả chi tiết entity',
          },
          category: {
            type: 'string',
            description: 'Category: Database | API Design | Frontend | Security | Anti-Patterns | Performance',
          },
          relationshipType: {
            type: 'string',
            description: 'Loại relationship nếu cần tạo relationship (ví dụ: "IMPROVES", "PREVENTS", "DEPENDS_ON")',
          },
          targetEntityName: {
            type: 'string',
            description: 'Tên target entity cho relationship (nếu có)',
          },
        },
        required: ['entityName', 'entityType', 'description', 'category'],
      },
    },
  },
  tavily: {
    type: 'function',
    function: {
      name: 'tavily',
      description: 'Web search AI-optimized — tìm kiếm thông tin trên internet. Trả về kết quả có nội dung tóm tắt. Dùng khi cần research best practices, docs, hoặc thông tin mới.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Câu hỏi tìm kiếm',
          },
        },
        required: ['query'],
      },
    },
  },
  serper: {
    type: 'function',
    function: {
      name: 'serper',
      description: 'Google Search API — tìm kiếm trên Google. Trả về search results với titles, snippets, links. Dùng khi cần tìm docs, packages, solutions.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Câu hỏi tìm kiếm trên Google',
          },
        },
        required: ['query'],
      },
    },
  },
  jina: {
    type: 'function',
    function: {
      name: 'jina',
      description: 'Web page reader — đọc nội dung trang web từ URL. Trả về text content của trang. Dùng khi cần đọc docs, articles, hoặc API references.',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'URL trang web cần đọc',
          },
        },
        required: ['url'],
      },
    },
  },

  // ==================== P0: DEV TOOLS ====================
  // Phase 2.1 — file_read: Claude Code parity tool (line numbers + offset + limit + truncation cursor)
  file_read: {
    type: 'function',
    function: {
      name: 'file_read',
      description: 'Đọc file text với line numbers (cat -n style), offset + limit để đọc trang, và truncation cursor để tiếp tục file lớn. Auto-detect binary (NULL byte) và từ chối. ƯU TIÊN tool này cho mọi nhu cầu đọc file code/log/json.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Đường dẫn file relative từ workspace root (không absolute)' },
          offset: { type: 'number', description: 'Line number bắt đầu đọc (1-based, default 1). Bỏ qua để đọc từ đầu.' },
          limit: { type: 'number', description: 'Số dòng tối đa trả về (default 2000). Nếu file nhiều hơn, return nextOffset để tiếp tục.' },
          line_numbers: { type: 'boolean', description: 'true = prefix mỗi dòng với số dòng (default true). false = chỉ content.' },
        },
        required: ['path'],
      },
    },
  },
  file_edit: {
    type: 'function',
    function: {
      name: 'file_edit',
      description: 'Sửa file bằng exact string replace (an toàn hơn write). Lỗi nếu 0 match hoặc >1 match (dùng replace_all:true để thay tất cả). Hỗ trợ match_count guard (số lần match kỳ vọng) + dry_run (preview không write). Có thể batch nhiều edits (atomic).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Đường dẫn file relative từ workspace root' },
          old_str: { type: 'string', description: 'Chuỗi cần tìm (phải match chính xác, kể cả indentation)' },
          new_str: { type: 'string', description: 'Chuỗi thay thế' },
          replace_all: { type: 'boolean', description: 'true = thay mọi occurrence; mặc định lỗi nếu >1 match' },
          match_count: { type: 'number', description: 'Assert số lần match kỳ vọng (fail nếu khác). Giúp tránh edit sai file' },
          dry_run: { type: 'boolean', description: 'true = chỉ trả diff preview, không write filesystem' },
          edits: {
            type: 'array',
            items: { type: 'object', properties: { old_str: { type: 'string' }, new_str: { type: 'string' } } },
            description: 'Batch nhiều edits (atomic — all-or-nothing). Bỏ qua old_str/new_str nếu dùng edits.',
          },
        },
        required: ['path'],
      },
    },
  },
  // Phase 2.3 — file_multi_edit: explicit batch tool (Claude Code convention)
  // Internally routes to fileEdit({ path, edits }). Exposed as separate tool so LLM can
  // semantically distinguish "I want one edit" vs "I want N atomic edits".
  file_multi_edit: {
    type: 'function',
    function: {
      name: 'file_multi_edit',
      description: 'Sửa nhiều đoạn trong 1 file cùng lúc (atomic — hoặc tất cả apply hoặc không gì cả). Ưu tiên dùng tool này khi cần sửa >=2 đoạn trong cùng file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Đường dẫn file relative từ workspace root' },
          edits: {
            type: 'array',
            description: 'Danh sách edits (atomic — all-or-nothing). Mỗi edit phải match chính xác 1 lần.',
            items: {
              type: 'object',
              properties: {
                old_str: { type: 'string', description: 'Chuỗi cần tìm (exact match)' },
                new_str: { type: 'string', description: 'Chuỗi thay thế' },
              },
              required: ['old_str', 'new_str'],
            },
          },
          dry_run: { type: 'boolean', description: 'true = preview diff không write' },
        },
        required: ['path', 'edits'],
      },
    },
  },
  // 21-d: file_write — native write tool cho FILE LỚN (không truncate, hỗ trợ append)
  file_write: {
    type: 'function',
    function: {
      name: 'file_write',
      description: 'Tạo file mới / ghi đè / nối tiếp (append) — DÙNG CHO FILE LỚN: viết từng phần (mỗi lần ~200-400 dòng) với mode append sau lần đầu overwrite; KHÔNG giới hạn độ dài content. Path relative từ workspace root; tự tạo parent dirs.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Đường dẫn file relative từ workspace root' },
          content: { type: 'string', description: 'Nội dung cần ghi (nguyên văn, không truncate)' },
          mode: { type: 'string', enum: ['overwrite', 'append'], description: "overwrite = ghi đè (mặc định, từ chối content rỗng); append = nối tiếp vào cuối file (file chưa tồn tại thì tạo mới) — dùng cho phần 2, 3... của file lớn" },
          create_dirs: { type: 'boolean', description: 'true = tự tạo parent directories (mặc định true)' },
        },
        required: ['path', 'content'],
      },
    },
  },
  file_delete: {
    type: 'function',
    function: {
      name: 'file_delete',
      description: 'Xóa file hoặc thư mục. Bắt buộc có recursive:true để xóa thư mục. Hỗ trợ dry_run:true để xem sẽ xóa gì (kèm số file đếm được) mà không thực sự xóa. Symlink được phát hiện qua fs.lstat — chỉ xóa link chứ không xóa target (an toàn). force:true để xóa cả readonly files (default false). Không bao giờ xóa workspace root.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Đường dẫn relative cần xóa' },
          recursive: { type: 'boolean', description: 'Bắt buộc nếu xóa thư mục' },
          dry_run: { type: 'boolean', description: 'true = chỉ trả về sẽ xóa gì + fileCount, không touch filesystem' },
          force: { type: 'boolean', description: 'true = fs.rm với force (xóa cả readonly files). Default false — phải explicit để tránh footgun.' },
        },
        required: ['path'],
      },
    },
  },
  file_list: {
    type: 'function',
    function: {
      name: 'file_list',
      description: 'Liệt kê nội dung thư mục (shallow hoặc tree). Tự bỏ node_modules/.next/.git/dist/build. Trả về name/type/size/mtime.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Thư mục cần list (mặc định workspace root)' },
          depth: { type: 'number', description: 'Độ sâu tối đa (1-5, mặc định 1)' },
          ignore: { type: 'array', items: { type: 'string' }, description: 'Tên thư mục/file bỏ qua' },
        },
      },
    },
  },
  grep: {
    type: 'function',
    function: {
      name: 'grep',
      description: 'Tìm nội dung file bằng regex (JS regex, case-insensitive). mode: content/files/count. Tự bỏ node_modules/.next/.git. Dùng để tìm lỗi, tìm usage, recon trước khi sửa.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regex pattern (JS syntax)' },
          path: { type: 'string', description: 'Thư mục/file cần search (mặc định root)' },
          glob: { type: 'string', description: 'Filter filename glob (vd "*.test.ts")' },
          mode: { type: 'string', enum: ['content', 'files', 'count'], description: 'content = trả matches, files = chỉ filenames, count = đếm' },
          context: { type: 'number', description: 'Số dòng context trước/sau match (0-5)' },
          head_limit: { type: 'number', description: 'Giới hạn số matches (mặc định 100, max 500)' },
        },
        required: ['pattern'],
      },
    },
  },
  run_tests: {
    type: 'function',
    function: {
      name: 'run_tests',
      description: 'Chạy test suite (autodetect framework: bun test / vitest / jest / pytest). Timeout 5 phút. Parse pass/fail/skip + failure locations (file:line). Dùng CI=true để tắt watch mode.',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', description: 'File test hoặc test name pattern (optional)' },
          coverage: { type: 'boolean', description: 'true = chạy với coverage' },
        },
      },
    },
  },
  git_commit: {
    type: 'function',
    function: {
      name: 'git_commit',
      description: 'Commit các file đã stage (hoặc stage scoped paths rồi commit). KHÔNG push remote. all=true REQUIRES paths[] — KHÔNG dùng `git add -A` (spec violation). Pre-flight check `git status --porcelain` để tránh lỗi "nothing to commit". Structured receipt: {commitHash, branch, filesChanged[]}.',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'Commit message (bắt buộc, không rỗng)' },
          paths: { type: 'array', items: { type: 'string' }, description: 'Paths relative cần commit. BẮT BUỘC nếu all=true.' },
          all: { type: 'boolean', description: 'true = stage paths trước rồi commit. KHÔNG dùng `git add -A` — phải có paths.' },
          dry_run: { type: 'boolean', description: 'true = stage paths, show diff sẽ commit, KHÔNG commit. Preview trước khi thật.' },
          no_verify: { type: 'boolean', description: 'true = pass --no-verify (skip pre-commit hooks). Dùng ít — hooks có thể kiểm tra code quality.' },
        },
        required: ['message'],
      },
    },
  },
  // P0.5 — Remote git ops (user request 2026-08-29): agents push/pull code khi
  // user yêu cầu. Token tự lấy từ GitHub Token Store (token user nhập dialog
  // "Pull Code từ GitHub" được lưu tự động) — KHÔNG ghi token vào .git/config.
  git_push: {
    type: 'function',
    function: {
      name: 'git_push',
      description: 'Push commits local của ACTIVE WORKSPACE lên remote (origin). Token xác thực tự động lấy từ token đã lưu (user nhập trong dialog Pull Code) — KHÔNG cần hỏi user lại. ⚠️ KHUYẾN NGHỊ: với tác vụ code của hệ thống TMO, hãy dùng tool verify_and_push thay thế — nó chạy pipeline kiểm định đầy đủ (lint → typecheck → tests → smoke → quét secret) TRƯỚC KHI push và TỰ TỪ CHỐI nếu có bước fail. Chỉ dùng git_push trực tiếp khi user yêu cầu push gấp không cần kiểm định, hoặc push branch phụ. dry_run=true để xem trạng thái (ahead/behind/uncommitted) mà không push. Chỉ dùng force:true khi user yêu cầu ghi đè.',
      parameters: {
        type: 'object',
        properties: {
          branch: { type: 'string', description: 'Branch cần push (default: branch hiện tại)' },
          remote: { type: 'string', description: 'Tên remote (default: origin)' },
          force: { type: 'boolean', description: 'true = --force-with-lease. CHỈ khi user yêu cầu tường minh.' },
          set_upstream: { type: 'boolean', description: 'true = --set-upstream (push lần đầu branch mới)' },
          dry_run: { type: 'boolean', description: 'true = chỉ báo ahead/behind/uncommitted, KHÔNG push' },
        },
      },
    },
  },
  git_pull: {
    type: 'function',
    function: {
      name: 'git_pull',
      description: 'Pull code mới nhất từ remote (origin) về ACTIVE WORKSPACE. An toàn: merge fast-forward-only — KHÔNG discard thay đổi local chưa commit, KHÔNG tạo merge commit. dry_run=true để xem có bao nhiêu commit/file mới trên remote. force:true = hard-reset theo remote (DISCARD local — chỉ khi user yêu cầu). Token xác thực tự động từ token đã lưu.',
      parameters: {
        type: 'object',
        properties: {
          branch: { type: 'string', description: 'Branch cần pull (default: branch hiện tại)' },
          remote: { type: 'string', description: 'Tên remote (default: origin)' },
          force: { type: 'boolean', description: 'true = hard-reset về phiên bản remote, DISCARD mọi thay đổi local. NGUY HIỂM — chỉ khi user yêu cầu.' },
          dry_run: { type: 'boolean', description: 'true = fetch + báo cáo khác biệt, KHÔNG apply' },
        },
      },
    },
  },

  // CI-6 (Task 10-b) — open_workspace: mở thư mục workspace bằng File Explorer
  // / VS Code trên máy người dùng (bridge giữa agent và desktop user).
  open_workspace: {
    type: 'function',
    function: {
      name: 'open_workspace',
      description: 'Mở thư mục workspace bằng File Explorer (hoặc VS Code) trên máy người dùng',
      parameters: {
        type: 'object',
        properties: {
          rootPath: { type: 'string', description: 'Đường dẫn tuyệt đối thư mục cần mở (optional — default = workspace đang active)' },
          editor: { type: 'string', enum: ['explorer', 'vscode'], description: 'explorer = File Explorer (default), vscode = VS Code' },
        },
      },
    },
  },
  // CI-6.4 (Task 10-b) — verify_and_push: pipeline kiểm định 5 lớp trước push.
  verify_and_push: {
    type: 'function',
    function: {
      name: 'verify_and_push',
      description: 'Pipeline kiểm định trước push: lint → typecheck → tests → smoke → quét secret → commit → push → pull verify. Tự động TỪ CHỐI push nếu bất kỳ bước nào thất bại.',
      parameters: {
        type: 'object',
        properties: {
          commit_message: { type: 'string', description: 'Commit message (bắt buộc)' },
          paths: { type: 'array', items: { type: 'string' }, description: 'Scoped paths cần commit (optional — default = mọi file thay đổi theo git status)' },
          smoke_url: { type: 'string', description: 'URL smoke probe HEAD (optional — bỏ qua nếu omit)' },
          dry_run: { type: 'boolean', description: 'true = chạy đủ các bước kiểm định nhưng KHÔNG commit/push/pull' },
        },
        required: ['commit_message'],
      },
    },
  },

  // CI-4 B3-B5 (Task 11-c) — structured git tools: khảo sát repo TRƯỚC khi sửa.
  // git_status/git_diff/git_log read-only luôn bật; git_branch/git_clone gate
  // chung ENABLE_GIT_COMMIT như mọi git tool (policy "1 flag tắt hết").
  git_status: {
    type: 'function',
    function: {
      name: 'git_status',
      description: 'Trạng thái git có cấu trúc: branch hiện tại, ahead/behind so với upstream, clean/dirty, danh sách file thay đổi (path + status modified/added/deleted/untracked + staged?), remote URL (đã strip token), head commit. Gọi ĐẦU TIÊN khi khảo sát repo trước khi sửa code — rẻ, read-only, không side-effect.',
      parameters: {
        type: 'object',
        properties: {
          root: { type: 'string', description: 'Đường dẫn repo cần kiểm tra, absolute hoặc relative so với workspace (optional — default = ACTIVE workspace)' },
        },
      },
    },
  },
  git_diff: {
    type: 'function',
    function: {
      name: 'git_diff',
      description: 'Xem diff so với 1 ref cục bộ (default HEAD): summary (filesChanged + insertions + deletions) + nội dung diff capped max_lines (default 400). staged_only=true chỉ xem phần đã stage. Xem trước khi commit để chắc chắn sửa đúng chỗ; thu hẹp bằng paths[] cho diff nhỏ.',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', description: 'Git ref cục bộ cần so sánh (default HEAD — vd HEAD, main, abc1234, HEAD~3). KHÔNG nhận URL remote/option.' },
          staged_only: { type: 'boolean', description: 'true = chỉ diff phần đã stage (git diff --cached)' },
          paths: { type: 'array', items: { type: 'string' }, description: 'Chỉ diff các path này (relative từ workspace root)' },
          max_lines: { type: 'number', description: 'Cap số dòng diff trả về (default 400, max 2000)' },
        },
      },
    },
  },
  git_log: {
    type: 'function',
    function: {
      name: 'git_log',
      description: 'Lịch sử commit có cấu trúc: commits[] với hash, shortHash, author, date, message (+ files[] mỗi commit mặc định). oneline=true = compact không kèm files. Dùng khi cần hiểu commit nào đụng file gì, ai sửa gần đây, trước khi refactor/xóa code.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Số commit tối đa (default 20, max 100)' },
          path: { type: 'string', description: 'Chỉ xem lịch sử của 1 file/thư mục (relative từ workspace root)' },
          oneline: { type: 'boolean', description: 'true = compact (không kèm files[] mỗi commit) — xem nhanh dòng thời gian' },
        },
      },
    },
  },
  git_branch: {
    type: 'function',
    function: {
      name: 'git_branch',
      description: 'Quản lý branch: list (danh sách + branch hiện tại) | create (tạo mới, không switch) | switch (chuyển branch — thay đổi working tree) | delete (-d an toàn chỉ xóa branch đã merge; force=true (-D) xóa cả branch chưa merge; TỪ CHỐI xóa branch đang đứng).',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'create', 'switch', 'delete'], description: 'Hành động trên branch' },
          name: { type: 'string', description: 'Tên branch (bắt buộc với create/switch/delete — chỉ [a-zA-Z0-9._-/])' },
          force: { type: 'boolean', description: 'delete: true = -D xóa cả branch chưa merge (NGUY HIỂM — mất commit chưa merge)' },
        },
        required: ['action'],
      },
    },
  },
  git_clone: {
    type: 'function',
    function: {
      name: 'git_clone',
      description: 'Clone 1 repo GitHub (https://) VÀO thư mục con của ACTIVE workspace (target_dir hoặc tên repo). depth=1 clone shallow cho nhanh. Token embedded trong URL được dùng one-shot rồi dọn khỏi .git/config; repo private cũng dùng được token đã lưu. Sau clone trả targetPath + số file + branch.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL https:// của repo (vd https://github.com/user/repo.git) — CHỈ https://' },
          target_dir: { type: 'string', description: 'Thư mục đích trong workspace (optional — default = tên repo từ URL)' },
          depth: { type: 'number', description: 'Shallow clone depth (vd 1 = chỉ commit cuối — nhanh, tiết kiệm disk)' },
        },
        required: ['url'],
      },
    },
  },

  // CI-3 B2+B3 (Task 13-b) — Kho Context "đọc lại khi cần": truy hồi digest/
  // raw/task_summary đã bị nén khỏi context active (Qdrant semantic + SQL LIKE
  // fallback trên TaskContextArchive). Read-only — không flag gate.
  context_recall: {
    type: 'function',
    function: {
      name: 'context_recall',
      description: 'Truy hồi thông tin context đã nén/lưu trữ của các run trước (digest, đoạn raw bị cắt, task_summary) — dùng khi cần đọc lại chi tiết đã bị nén (tên file đã đọc, kết quả lệnh, quyết định kỹ thuật đã chốt của run cũ) thay vì đọc lại toàn bộ transcript.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Từ khóa tìm kiếm — tên file, tên hàm, lệnh đã chạy, quyết định kỹ thuật...' },
          runId: { type: 'string', description: 'Chỉ tìm trong run/session này (optional — bỏ qua để tìm xuyên run)' },
          limit: { type: 'number', description: 'Số kết quả tối đa (default 5, max 20)' },
        },
        required: ['query'],
      },
    },
  },

  // ==================== P1: DIAGNOSTICS + PLANNING + SYNTHESIS ====================
  get_diagnostics: {
    type: 'function',
    function: {
      name: 'get_diagnostics',
      description: 'Type-check + lint diagnostics (tsc --noEmit) cho file hoặc toàn workspace. Parse errors với file:line:col + code. Thử opencode-server /lsp/diagnostics trước.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File cụ thể (optional — nếu omit, check toàn workspace)' },
        },
      },
    },
  },
  // ==================== v2.1 Phase 3 — Code Intelligence + MCP (spec lines 223-242) ====================
  // 3.1 — alias of getDiagnostics but exposed under a separate tool name per
  // spec. Phase 3 wire-up: separate `lsp_diagnostics` tool definition + case.
  lsp_diagnostics: {
    type: 'function',
    function: {
      name: 'lsp_diagnostics',
      description: 'LSP diagnostics (tsc --noEmit + opencode-server /lsp/diagnostics). Phase 3 code intelligence — trả file:line:col + TSxxxx code. Giống get_diagnostics nhưng tên tool tách biệt theo spec line 228.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File cụ thể (optional — nếu omit, check toàn workspace)' },
        },
      },
    },
  },
  // 3.2 — Playwright headless chromium screenshot, returns base64 PNG.
  browser_screenshot: {
    type: 'function',
    function: {
      name: 'browser_screenshot',
      description: 'Chụp screenshot URL (Playwright headless chromium). Trả base64 PNG cho agent consumption. Tùy chọn: full_page, viewport, wait_until, wait_ms, selector (chỉ chụp element).',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL http(s) cần chụp (bắt buộc)' },
          full_page: { type: 'boolean', description: 'true = chụp toàn page (scroll), false = chỉ viewport (default)' },
          viewport_width: { type: 'number', description: 'Viewport width (default 1280, clamp 320-4096)' },
          viewport_height: { type: 'number', description: 'Viewport height (default 720, clamp 240-4096)' },
          wait_until: { type: 'string', enum: ['load', 'domcontentloaded', 'networkidle'], description: 'Playwright waitUntil event (default load)' },
          wait_ms: { type: 'number', description: 'Đợi thêm ms sau khi navigate (max 60s, default 0)' },
          selector: { type: 'string', description: 'CSS selector — nếu set, chỉ chụp element đó (15s wait visible)' },
        },
        required: ['url'],
      },
    },
  },
  // 3.3a — ESLint structured parser.
  lint: {
    type: 'function',
    function: {
      name: 'lint',
      description: 'Chạy ESLint với --format json, parse kết quả có cấu trúc. Trả {errorCount, warningCount, results:[{file,line,column,severity,ruleId,message}], fixableErrorCount}. Cap max_results (default 100) để tránh tràn context.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File/thư mục cần lint (optional, default ".")' },
          fix: { type: 'boolean', description: 'true = chạy với --fix (auto-fixable rules)' },
          max_results: { type: 'number', description: 'Số lượng kết quả tối đa trả về (default 100, max 1000)' },
        },
      },
    },
  },
  // 3.3b — tsc --noEmit parser (uses existing parseTscOutput).
  type_check: {
    type: 'function',
    function: {
      name: 'type_check',
      description: 'Chạy tsc --noEmit, parse errors với file:line:col + TSxxxx code. Tùy chọn path filter để chỉ xem errors của file cụ thể. Trả {errorCount, results, raw (5KB)}',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Filter result theo file path (optional — vẫn check toàn project)' },
        },
      },
    },
  },
  // 3.4 — bun test --coverage parser.
  test_coverage: {
    type: 'function',
    function: {
      name: 'test_coverage',
      description: 'Chạy bun test --coverage, parse bảng coverage text (hoặc JSON nếu reporter=json). Trả {totalCoverage:{functions,lines,branches}, files:[{path,functions,lines,branches,uncoveredLines:[[start,end],...]}], testFailures, durationMs}.',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', description: 'Test file/pattern target (optional, default toàn test suite)' },
          reporter: { type: 'string', enum: ['text', 'json'], description: 'Bun coverage reporter (default text)' },
        },
      },
    },
  },
  // 3.5 — Prisma $queryRawUnsafe + read-only guard.
  db_query: {
    type: 'function',
    function: {
      name: 'db_query',
      description: 'Read-only SQL query against SQLite buffer layer (Prisma $queryRawUnsafe). STRICT READ-ONLY GUARD: reject INSERT/UPDATE/DELETE/DROP/ALTER/TRUNCATE/CREATE/GRANT/REVOKE/ATTACH/DETACH + multi-statement + PRAGMA (except query_plan). Trả {rows, rowCount, truncated, sql}.',
      parameters: {
        type: 'object',
        properties: {
          sql: { type: 'string', description: 'SQL SELECT query (read-only — write keywords rejected)' },
          params: { type: 'array', items: {}, description: 'Positional bind params (optional)' },
          limit: { type: 'number', description: 'Max rows trả về (default 100, max 1000) — wrap query trong sub LIMIT' },
        },
        required: ['sql'],
      },
    },
  },
  // 3.6 — MCP bridge call. CI-4 B6 (Task 11-c) de-advertise: 4 built-in server
  // (filesystem/github/postgres/puppeteer) là MOCK Phase 3 (trả dữ liệu giả —
  // vd github create_pr → PR #42 không tồn tại) → KHÔNG còn quảng bá trong mô
  // tả; gọi trực tiếp cũng bị chặn ở case mcp_call bên dưới. Chỉ MCP servers
  // operator cấu hình (env MCP_SERVERS / ~/.config/mcp/servers.json) được dùng.
  mcp_call: {
    type: 'function',
    function: {
      name: 'mcp_call',
      description: 'Gọi tool trên MCP server do operator cấu hình (env MCP_SERVERS hoặc ~/.config/mcp/servers.json — xem danh sách qua mcp_list_servers). First-use permission prompt (D10): trả requiresPermission=true lần đầu, agent phải gọi /api/openclaw/permissions grant. Lưu ý: mọi thao tác code/git/DB/browser dùng tools builtin của app (file_read, git_commit, db_query, browser_screenshot...) — mcp_call chỉ cho MCP servers operator cấu hình riêng.',
      parameters: {
        type: 'object',
        properties: {
          server: { type: 'string', description: 'MCP server ID (lấy từ mcp_list_servers)' },
          tool: { type: 'string', description: 'Tool name trên server (vd invoke...)' },
          args: { type: 'object', description: 'Tool args (schema phụ thuộc server+tool)' },
        },
        required: ['server', 'tool'],
      },
    },
  },
  decompose_task: {
    type: 'function',
    function: {
      name: 'decompose_task',
      description: 'Phân tích goal thành 3-7 subtasks (DAG với dependencies). LLM-assisted, trả JSON array. Lưu vào task store (in-memory). Trả về tasks với IDs để assign cho agents.',
      parameters: {
        type: 'object',
        properties: {
          goal: { type: 'string', description: 'Mục tiêu cần phân tách' },
          context: { type: 'string', description: 'Context bổ sung (optional)' },
        },
        required: ['goal'],
      },
    },
  },
  create_task: {
    type: 'function',
    function: {
      name: 'create_task',
      description: 'Tạo 1 task trong task store với assignee/priority/deps. Status mặc định pending.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          spec: { type: 'string', description: 'Acceptance criteria (1-2 câu)' },
          assignee: { type: 'string', description: 'TL/G1/G2-A/G2-B/G3' },
          priority: { type: 'string', enum: ['low', 'medium', 'high'] },
          deps: { type: 'array', items: { type: 'string' }, description: 'Task IDs mà task này phụ thuộc' },
        },
        required: ['title', 'spec'],
      },
    },
  },
  update_task: {
    type: 'function',
    function: {
      name: 'update_task',
      description: 'Cập nhật status/notes của task. Enforce ≤1 in_progress per agent là gợi ý chứ không bắt buộc.',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'Task ID (vd T001)' },
          status: { type: 'string', enum: ['pending', 'in_progress', 'blocked', 'completed', 'failed'] },
          notes: { type: 'string' },
        },
        required: ['task_id'],
      },
    },
  },
  get_plan: {
    type: 'function',
    function: {
      name: 'get_plan',
      description: 'Đọc task board: tất cả tasks + status breakdown + dependencies. Dùng cho TL routing.',
      parameters: { type: 'object', properties: {} },
    },
  },
  summarize: {
    type: 'function',
    function: {
      name: 'summarize',
      description: 'Tóm tắt nội dung 1+ file hoặc text. LLM-assisted, trả purpose/key points/risks/TODOs. Dùng cho recon trước khi sửa hoặc cho handoff giữa agents.',
      parameters: {
        type: 'object',
        properties: {
          paths: { type: 'array', items: { type: 'string' }, description: 'File paths relative (vd ["src/lib/llm.ts"])' },
          content: { type: 'string', description: 'Hoặc inline content trực tiếp' },
          focus: { type: 'string', description: 'Tập trung vào điểm nào (vd "public API surface")' },
        },
      },
    },
  },
  synthesize: {
    type: 'function',
    function: {
      name: 'synthesize',
      description: 'Tổng hợp nhiều sources (file paths hoặc inline text) thành 1 báo cáo cho 1 goal cụ thể. Nhận diện conflicts + open questions. Dùng khi G1/G3 cần gộp findings từ nhiều nguồn.',
      parameters: {
        type: 'object',
        properties: {
          sources: { type: 'array', items: { type: 'string' }, description: 'Sources — mỗi item là file path hoặc inline text' },
          goal: { type: 'string', description: 'Câu hỏi/mục tiêu tổng hợp' },
        },
        required: ['sources', 'goal'],
      },
    },
  },
  run_bg: {
    type: 'function',
    function: {
      name: 'run_bg',
      description: 'Chạy command nền (long-running: dev server, watcher, build...). Trả processId để poll bằng read_output. KHÔNG block — trả về ngay. Tự kill khi cần bằng kill_process.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Command chạy nền (vd "bun run dev")' },
          cwd: { type: 'string', description: 'Working directory (optional)' },
        },
        required: ['command'],
      },
    },
  },
  read_output: {
    type: 'function',
    function: {
      name: 'read_output',
      description: 'Poll output của background process (started bằng run_bg). Trả new stdout+stderr + ended flag + bytesRead. Pass list:true để xem tất cả processes đang chạy.',
      parameters: {
        type: 'object',
        properties: {
          process_id: { type: 'string', description: 'Process ID (từ run_bg response)' },
          list: { type: 'boolean', description: 'true = list tất cả processes, không cần process_id' },
          since_offset: { type: 'number', description: 'Byte offset để đọc từ (từ bytesRead trước) — incremental' },
        },
      },
    },
  },
  kill_process: {
    type: 'function',
    function: {
      name: 'kill_process',
      description: 'Kill background process by process_id hoặc by port (SIGTERM). Dọn dẹp khi task xong.',
      parameters: {
        type: 'object',
        properties: {
          process_id: { type: 'string' },
          port: { type: 'number', description: 'Tìm+kill process đang giữ port' },
        },
      },
    },
  },
  manage_packages: {
    type: 'function',
    function: {
      name: 'manage_packages',
      description: 'Cài/gỡ/cập nhật packages (bun add/remove/install/update). Timeout 2 phút. Dùng khi task cần thêm dependency.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['add', 'remove', 'install', 'update'] },
          packages: { type: 'array', items: { type: 'string' }, description: 'Package names (required for add/remove)' },
          dev: { type: 'boolean', description: 'true = dev dependency (chỉ cho add)' },
        },
        required: ['action'],
      },
    },
  },
  // ===== Phase 6 (rebuild): AI preview tools — start/stop the dev server of
  // the user's active workspace. The UI listens for the tool_result and
  // auto-opens the Preview panel (see page.tsx 'tmo-ai-tool-event').
  // NOTE: start_preview result JSON puts `port` FIRST — the workflow engine
  // truncates tool detail to 500 chars and the UI needs the port.
  start_preview: {
    type: 'function',
    function: {
      name: 'start_preview',
      description: 'Start the dev server for the current workspace and display it in the Preview panel. Auto-detects framework and picks the first free port starting from 3005. Use after making code changes so the user sees the result.',
      parameters: {
        type: 'object',
        properties: {
          root: { type: 'string', description: 'Workspace root directory (default: active workspace)' },
          port: { type: 'number', description: 'Preferred port (server still auto-picks a free one in 3005-3099)' },
          command: { type: 'string', description: 'Custom dev command (default: <pkg-manager> run dev)' },
        },
        required: [],
      },
    },
  },
  stop_preview: {
    type: 'function',
    function: {
      name: 'stop_preview',
      description: 'Stop the running dev server for a workspace root.',
      parameters: {
        type: 'object',
        properties: {
          root: { type: 'string', description: 'Workspace root directory (default: active workspace)' },
        },
        required: [],
      },
    },
  },
  // ===== Task 19-b (App Runtime Awareness): agent NHÌN THẤY preview/dev-server
  // đang chạy (kể cả preview USER tự bấm Start trong UI) — dùng TRƯỚC khi kill
  // process hoặc khi cần biết app user đang xem có chạy ổn không. =====
  get_app_runtime_status: {
    type: 'function',
    function: {
      name: 'get_app_runtime_status',
      description: 'Kiểm tra trạng thái runtime của app: preview/dev-server nào đang chạy (port, pid, ai khởi động: user/agent), HTTP có respond không, và tail log gần nhất của từng preview. Dùng trước khi kill process hoặc khi cần biết app user đang xem có chạy ổn không.',
      parameters: {
        type: 'object',
        properties: {
          tail_lines: { type: 'number', description: 'Số dòng log gần nhất trả về cho từng preview (default: 20, max: 100)' },
        },
        required: [],
      },
    },
  },

  // ==================== P2: GATEWAY PROXY (36 tools) ====================
  gateway_tool: {
    type: 'function',
    function: {
      name: 'gateway_tool',
      description: 'Proxy tới 1 trong 36 gateway-bridge tools (port 18791). 17 HTTP tools: web_search, web_fetch, memory_search, memory_get, browser, canvas, sessions_list, sessions_history, session_status, sessions_yield, agents_list, message, tts, skill_workshop, create_goal, get_goal, update_goal. 19 bridge-only: x_search, exec, read, write, edit, apply_patch, code_execution, process, sessions_spawn, sessions_send, cron, heartbeat_respond, gateway, nodes, update_plan, image, image_generate, music_generate, video_generate.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Tên gateway tool (vd "web_search", "exec", "read")' },
          args: { type: 'object', description: 'Arguments cho tool đó (khác nhau theo tool)', additionalProperties: true },
        },
        required: ['name'],
      },
    },
  },

  // ==================== v2.1 Phase 1a: SHELL + TODO (Claude Code parity) ====================
  // NOTE: switch case + flag gate were added in Phase 1a but ALL_TOOL_DEFINITIONS
  // entries were missing — this regression is fixed in Phase 1b so the LLM can
  // actually see the schema and call these tools.
  shell: {
    type: 'function',
    function: {
      name: 'shell',
      description: 'Bash với timeout 5min (max 10min). Cho phép metacharacters (|, &&, ;, >). cwd mặc định = workspace root, có thể truyền cwd absolute ở bất kỳ đâu. Trả về D2 structured receipt {success, exit_code, stdout, stderr, duration_ms, truncated, cursor, cwd}. Thay thế 5 v1 tools (install_package, read_logs, lint, type_check, db_query).',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command. Ví dụ: "bun add bcrypt", "bun run lint", "tsc --noEmit", "git status"' },
          cwd: { type: 'string', description: 'Working directory (mặc định: workspace root). Relative → resolve theo workspace root; absolute → dùng nguyên (chạy ở bất kỳ đâu).' },
          timeout_ms: { type: 'number', description: 'Timeout ms (default 300000=5min, max 600000=10min). SIGTERM then SIGKILL after 5s grace.' },
          env: { type: 'object', description: 'Extra env vars (key-value)', additionalProperties: { type: 'string' } },
          stdin: { type: 'string', description: 'Stdin input cho command (vd password prompt)' },
        },
        required: ['command'],
      },
    },
  },
  todo_write: {
    type: 'function',
    function: {
      name: 'todo_write',
      description: 'Claude Code-style in-flight task list (batch upsert, DB-backed). Truyền mảng todos (có id=update, không id=create, có idempotencyKey=idempotent). Trả về danh sách đầy đủ sau khi write. Dùng cho agent tự track multi-step work. Persisted trong SQLite — sống sót qua server restart.',
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'Session scope — mỗi conversation có list riêng. Bỏ trống → "default".' },
          agentRole: { type: 'string', description: 'Agent position (TL|G1|G2-A|G2-B|G3) cho Code Team, hoặc null cho independent agent. Bỏ trống → null.' },
          todos: {
            type: 'array',
            description: 'Danh sách todo (full rewrite — Claude Code semantics)',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'ID nếu update existing; bỏ trống nếu create mới' },
                content: { type: 'string', description: 'Nội dung task (string)' },
                status: { type: 'string', enum: ['pending', 'in_progress', 'blocked', 'completed', 'failed'] },
                priority: { type: 'string', enum: ['low', 'medium', 'high'] },
                parentId: { type: 'string', description: 'Parent task ID (cho subtask / DAG)' },
                idempotencyKey: { type: 'string', description: 'Optional — khi set, repeat calls với cùng key trả về existing todo (no duplicate)' },
              },
              required: ['content'],
            },
          },
        },
        required: ['todos'],
      },
    },
  },
  todo_read: {
    type: 'function',
    function: {
      name: 'todo_read',
      description: 'Đọc task list hiện tại (DB-backed) với status breakdown (pending/in_progress/completed/...). Dùng để agent review progress trước khi quyết định next step.',
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'Session scope (bỏ trống → "default")' },
          agentRole: { type: 'string', description: 'Filter theo agent position (TL|G1|G2-A|G2-B|G3). Bỏ trống → trả về tất cả agent trong session.' },
        },
        required: [],
      },
    },
  },
  // ===== Dynamic skill + MCP enumeration (user request 2026-08-29) =====
  list_skills: {
    type: 'function',
    function: {
      name: 'list_skills',
      description: 'Liệt kê ĐỘNG skill registry runtime: DB skills (user tạo) + 60+ clawhub skills trên đĩa (skills/<slug>/SKILL.md) + 5 dịch vụ web (tavily/serper/jina/sdk). Trả tên + mô tả ngắn + slug. Sau đó gọi read_skill({"slug":"<slug>"}) để đọc hướng dẫn đầy đủ trước khi dùng skill.',
      parameters: {
        type: 'object',
        properties: {
          source: { type: 'string', enum: ['all', 'db', 'filesystem', 'services'], description: 'Nguồn cần scan (mặc định all)' },
        },
        required: [],
      },
    },
  },
  read_skill: {
    type: 'function',
    function: {
      name: 'read_skill',
      description: 'Đọc nội dung đầy đủ của 1 skill theo slug (tra cứu DB AgentSkill → filesystem skills/<slug>/SKILL.md). Trả về front-matter (name/description) + toàn bộ hướng dẫn.',
      parameters: {
        type: 'object',
        properties: {
          slug: { type: 'string', description: 'Slug của skill (lấy từ list_skills)' },
        },
        required: ['slug'],
      },
    },
  },
  mcp_list_servers: {
    type: 'function',
    function: {
      name: 'mcp_list_servers',
      description: 'Enumerate MCP servers runtime: MCP servers operator cấu hình (env MCP_SERVERS / ~/.config/mcp/servers.json) + tools mỗi server + MCP Bridge OpenClaw↔OpenCode (outbound/inbound) + trạng thái mcp_call. Built-in mock servers Phase 3 đã bị ẩn (dữ liệu giả — Phase 5 chưa hiện thực).',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },

  // ==================== v2.1 Phase 1b.1: UNIFIED WEB (consolidate tavily/serper/jina) ====================
  // Phase 1b.1 — single unified web interface (Claude Code / Z.ai Code parity).
  // Routes to best-available provider; falls back to z-ai-web-dev-sdk.
  // Old tavily/serper/jina tools remain accessible for backward compatibility.
  web_search: {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Unified web search — routes tới provider tốt nhất (Tavily khi có key, Serper fallback, z-ai-sdk cuối cùng). Trả về results[] thống nhất {title, url, snippet/score}. Dùng khi cần research docs, best practices, thông tin mới.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Câu hỏi tìm kiếm' },
          max_results: { type: 'number', description: 'Số kết quả tối đa (default 5, max 20)' },
          depth: { type: 'string', enum: ['basic', 'advanced'], description: 'basic=nhanh, advanced=sâu (Tavily search_depth). Default basic.' },
        },
        required: ['query'],
      },
    },
  },
  web_fetch: {
    type: 'function',
    function: {
      name: 'web_fetch',
      description: 'Unified web page reader — routes Jina (r.jina.ai) khi có key, fallback z-ai-sdk page_reader. Trả về {url, title, content, length, truncated, source}. Dùng để đọc bài blog, docs, RFC, hoặc page snippet.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL page cần đọc (phải có http:// hoặc https://)' },
          format: { type: 'string', enum: ['text', 'html', 'markdown'], description: 'Output format (default text — clean text)' },
        },
        required: ['url'],
      },
    },
  },

  // ==================== v2.1 Phase 1b.2: P0 GATEWAY TOOLS (first-class) ====================
  // Phase 1b.2 — expose 5 P0 gateway tools as first-class (not via gateway_tool
  // generic proxy). Each is a thin wrapper around gatewayTool({name, args}).
  // Gated by ENABLE_GATEWAY_TOOLS=phase-1b (off by default per D11).
  gateway_exec: {
    type: 'function',
    function: {
      name: 'gateway_exec',
      description: 'Execute shell command qua Gateway bridge (session-context, port 18791). Alternative to `shell` khi cần gateway-side session tracking. Trả về {success, output, exitCode}.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command' },
          cwd: { type: 'string', description: 'Working directory (optional)' },
        },
        required: ['command'],
      },
    },
  },
  gateway_read: {
    type: 'function',
    function: {
      name: 'gateway_read',
      description: 'Read file qua Gateway bridge (session-context). Trả về {success, content, length}. Alternative to opencode read khi cần gateway-side session tracking.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path (relative to workspace)' },
        },
        required: ['path'],
      },
    },
  },
  gateway_write: {
    type: 'function',
    function: {
      name: 'gateway_write',
      description: 'Write file qua Gateway bridge (session-context). Trả về {success, bytes}. Alternative to opencode write.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path (relative to workspace)' },
          content: { type: 'string', description: 'File content' },
        },
        required: ['path', 'content'],
      },
    },
  },
  gateway_edit: {
    type: 'function',
    function: {
      name: 'gateway_edit',
      description: 'Edit file bằng exact string replace qua Gateway bridge (session-context). Trả về {success, replacements}. Alternative to file_edit.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path' },
          old: { type: 'string', description: 'String cần replace (phải match duy nhất)' },
          new: { type: 'string', description: 'String thay thế' },
        },
        required: ['path', 'old', 'new'],
      },
    },
  },
  gateway_apply_patch: {
    type: 'function',
    function: {
      name: 'gateway_apply_patch',
      description: 'Apply unified diff patch qua Gateway bridge (session-context). Trả về {success, applied_lines}. Dùng khi cần apply multi-hunk patch.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path' },
          patch: { type: 'string', description: 'Unified diff patch content (--- /dev/null\n+++ file\n@@ ...)' },
        },
        required: ['path', 'patch'],
      },
    },
  },

  // ==================== v2.1 Phase 4.5 — exit_plan_mode (NEW — Claude Code parity) ====================
  // Spec: docs/FULLSTACK_CAPABILITY_PLAN_V2.md Phase 4.5 (lines 252-263)
  // Behavior: agent emits plan + target files + risk assessment → workflow pauses →
  // user approves/rejects/modifies via /api/openclaw/plan-mode → workflow resumes.
  // Used by TL (APEX) and G3 (CATALYST) — only positions that plan.
  exit_plan_mode: {
    type: 'function',
    function: {
      name: 'exit_plan_mode',
      description: 'Phase 4.5 — Claude Code parity. Agent emits plan + target files + risk assessment. Workflow pauses, surfaces to UI for user approval. User approves/rejects/modifies. Agent resumes with approved scope. Use this BEFORE making file edits if changes are uncertain or risky. Available to TL (APEX) and G3 (CATALYST) only — these are the positions that plan.',
      parameters: {
        type: 'object',
        properties: {
          plan: { type: 'string', description: 'Plan description (Vietnamese or English)' },
          filesToModify: {
            type: 'array',
            items: { type: 'string' },
            description: 'Relative paths of files to be modified',
          },
          riskLevel: {
            type: 'string',
            enum: ['low', 'medium', 'high'],
            description: 'Risk assessment',
          },
        },
        required: ['plan', 'filesToModify', 'riskLevel'],
      },
    },
  },

  // ==================== v2.1 Phase 4.6 — cron (NEW — Z.ai Code parity) ====================
  // Spec: docs/FULLSTACK_CAPABILITY_PLAN_V2.md Phase 4.6 (lines 263-281)
  // Behavior: schedule recurring or one-time agent tasks via the cron-scheduler
  // mini-service (port 3004). Actions: create | list | delete | run.
  // Schedule kinds: one_time (epoch-ms), cron (5-field cron expression), fixed_rate (interval).
  // Dedup: jobId hash (sha256 of schedule+task+sessionId) — refuse duplicates.
  // Retries: max 3 with exponential backoff (2^n seconds). Available to TL + G3 only.
  cron: {
    type: 'function',
    function: {
      name: 'cron',
      description: 'Phase 4.6 — Z.ai Code parity. Schedule recurring or one-time agent tasks. Action: create | list | delete | run. Schedule kinds: one_time (epoch-ms expr), cron (cron expression), fixed_rate (interval string). Timezone optional. Retries max 3 with exponential backoff. Dedup: jobId hash, refuse duplicate schedules. Available to TL (APEX) and G3 (CATALYST) only — the planner positions.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['create', 'list', 'delete', 'run'], description: 'create=list+register a new job; list=query all jobs; delete=soft-delete (status=paused); run=manual trigger (for testing)' },
          jobId: { type: 'string', description: 'For delete/run actions — required' },
          schedule: {
            type: 'object',
            description: 'Required for create action',
            properties: {
              kind: { type: 'string', enum: ['one_time', 'cron', 'fixed_rate'], description: 'one_time=run once at epoch-ms; cron=5-field cron expression; fixed_rate=interval string' },
              expr: { type: 'string', description: 'epoch-ms (one_time) | cron expression | interval (e.g. 30s/5m/1h/1d/1w)' },
              tz: { type: 'string', description: 'IANA timezone, e.g., Etc/GMT-7 (optional — server tz used if omitted)' },
            },
            required: ['kind', 'expr'],
          },
          task: { type: 'string', description: 'Agent task description (for create action)' },
          sessionId: { type: 'string', description: 'Resume existing session (optional, for create action)' },
        },
        required: ['action'],
      },
    },
  },

  // ==================== Custom Tools (user request 2026-08-30) ====================
  // Agents TỰ VIẾT tools khi cần và DÙNG NGAY (hot-register trong cùng ReAct loop).
  // Handler JS chạy trong sandbox (fetch HTTP OK, KHÔNG fs/process/eval).
  // Mỗi custom tool tự tạo AgentSkill companion (source 'agent-tool') → hiện
  // trong ô "SKILL.md Guides" của module Skills.
  create_custom_tool: {
    type: 'function',
    function: {
      name: 'create_custom_tool',
      description:
        'TẠO TOOL MỚI do chính bạn viết — dùng NGAY sau khi tạo (hot-register). ' +
        'Khi thiếu tool cho task (vd: tính toán đặc biệt, convert format, gọi API lạ), ĐỪNG lặp code mỗi lần — ' +
        'viết 1 tool reusable: định nghĩa name + description + parameters (JSON schema) + handlerCode. ' +
        'Handler là JavaScript thuần: function handler(args, sandbox) { ... return result } — ' +
        'sandbox có: fetch (HTTP/HTTPS), JSON, Math, Date, console. KHÔNG dùng process/require/import/eval/fs. ' +
        'Tool được lưu vĩnh viễn (DB) + tự tạo SKILL.md guide. Timeout 10s, output ~2000 ký tự.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Tên tool (snake_case, vd: word_frequency, base32_encode). KHÔNG trùng tool có sẵn.' },
          description: { type: 'string', description: 'Mô tả tool làm gì — dùng để các agent khác hiểu và gọi đúng' },
          parameters: {
            type: 'object',
            description: 'JSON schema các tham số. VD: {"type":"object","properties":{"text":{"type":"string","description":"Văn bản cần phân tích"}},"required":["text"]}',
            properties: {},
          },
          handlerCode: {
            type: 'string',
            description:
              'JavaScript handler. VD: function handler(args) { const words = args.text.split(/\\s+/); return { words: words.length }; } ' +
              'Có thể async. Return string/object đều được.',
          },
          skillMd: { type: 'string', description: '(Tùy chọn) Nội dung SKILL.md hướng dẫn dùng tool — bỏ trống sẽ tự sinh' },
        },
        required: ['name', 'description', 'parameters', 'handlerCode'],
      },
    },
  },
  delete_custom_tool: {
    type: 'function',
    function: {
      name: 'delete_custom_tool',
      description: 'Xóa một custom tool đã tạo (kèm SKILL.md guide của nó). Chỉ xóa được tool do agent/user tạo.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Tên custom tool cần xóa' },
        },
        required: ['name'],
      },
    },
  },
  list_custom_tools: {
    type: 'function',
    function: {
      name: 'list_custom_tools',
      description: 'Liệt kê các custom tools đã tạo (tên + mô tả + số lần gọi). Dùng trước khi create để tránh trùng tên.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  // ===== SUB-AGENT DELEGATION (user request 2026-09-08) =====
  // Agent (vd Omega) gọi Code Team chuyên trách xử lý task phù hợp —
  // parent chỉ nhận báo cáo NÉN, context của sub-agent không đổ vào
  // parent (context isolation → tiết kiệm budget token vòng lặp mục tiêu).
  delegate_task: {
    type: 'function',
    function: {
      name: 'delegate_task',
      description:
        'DELEGATE task cho agent chuyên trách của Code Team — sub-agent chạy tự chủ (đọc/sửa file, chạy lệnh, kiểm định) ' +
        'và trả về BÁO CÁO NÉN (đã làm · bằng chứng tool · còn thiếu). ' +
        'Dùng khi: (1) task code lớn cần implement/review/tối ưu chuyên sâu, (2) muốn giảm tải context của bạn — ' +
        'sub-agent đọc nhiều file mà context của bạn KHÔNG phình, (3) cần góc nhìn chuyên trách (security review, arch design). ' +
        'KHÔNG dùng cho task 1-2 bước đơn giản — tự làm nhanh hơn. Chọn đúng agent: APEX=phân tích/verify tổng thể, ' +
        'CORTEX=thiết kế kiến trúc/DB/API, BOLT=implement code, SENTINEL=review/bug/security, CATALYST=tối ưu/refactor.',
      parameters: {
        type: 'object',
        properties: {
          agent: {
            type: 'string',
            enum: ['APEX', 'CORTEX', 'BOLT', 'SENTINEL', 'CATALYST'],
            description: 'Agent chuyên trách sẽ nhận task',
          },
          task: {
            type: 'string',
            description: 'Nhiệm vụ CỤ THỂ cho sub-agent (mục tiêu, phạm vi file, điều kiện hoàn thành kiểm định được)',
          },
          context: {
            type: 'string',
            description: 'Context bổ sung từ bạn: file liên quan, ràng buộc, kết quả bước trước, quyết định đã chốt...',
          },
          acceptance_criteria: {
            type: 'string',
            description:
              'DELEGATION CONTRACT — danh sách điều kiện hoàn thành KIỂM ĐỊNH ĐƯỢC (mỗi điều kiện 1 dòng, dạng "xong khi..."). ' +
              'Sub-agent tự verify từng điều kiện bằng tool thật trước khi báo cáo và nêu ĐẠT/CHƯA ĐẠT từng điều kiện trong báo cáo. ' +
              'Vd: "xong khi file src/lib/x.ts sửa hàm Y và lint pass", "xong khi test X chạy 169/169 pass".',
          },
        },
        required: ['agent', 'task'],
      },
    },
  },
  // ===== OMEGA ORCHESTRATION (user request 2026-09-08) =====
  // 3 tool phối hợp multi-agent: mọi agent GẶP VẤN ĐỀ escalate về Omega;
  // Omega (và agents có quyền) TẠO AGENT MỚI + ĐIỀU ĐỘNG agent bất kỳ.
  escalate_problem: {
    type: 'function',
    function: {
      name: 'escalate_problem',
      description:
        'ESCALATE vấn đề cho OMEGA — orchestrator của hệ thống agents. Omega phân tích căn nguyên, ' +
        'cân nhắc các phương án (tự sửa / đổi cách tiếp cận / điều agent khác xử lý / tạo agent mới) và trả về ' +
        'TƯ VẤN TỐT NHẤT cho bạn. Dùng khi: (1) tool fail lặp lại cùng lỗi, (2) cùng hành động lặp lại không tiến triển, ' +
        '(3) task cần chuyên môn ngoài vòng của bạn (xem Agent Roster), (4) NHẬN DIỆN SỚM rủi ro trước khi kẹt hẳn. ' +
        'Escalate sớm rẻ hơn chữa sau — đừng xoay vòng mãi mới hỏi.',
      parameters: {
        type: 'object',
        properties: {
          problem: {
            type: 'string',
            description: 'Mô tả vấn đề CỤ THỂ: gì đang sai/bế tắc, thông báo lỗi, kết quả mong muốn vs thực tế',
          },
          context: {
            type: 'string',
            description: 'Context: mục tiêu task, file/lệnh liên quan, ràng buộc...',
          },
          attempted: {
            type: 'string',
            description: 'Các cách ĐÃ THỬ và kết quả từng cách (để Omega không đề xuất lại cách đã fail)',
          },
          severity: {
            type: 'string',
            enum: ['low', 'medium', 'high'],
            description: 'Mức độ: low=phiền nhưng đi tiếp được, medium=chặn 1 phần task, high=kẹt hẳn/task fail',
          },
        },
        required: ['problem'],
      },
    },
  },
  create_agent: {
    type: 'function',
    function: {
      name: 'create_agent',
      description:
        'TẠO AGENT MỚI trong module Agents (Agent Factory — quyền của Omega orchestrator). ' +
        'Dùng khi hệ thống THIẾU agent có kỹ năng phù hợp cho tác vụ (xem Agent Roster trước — nếu đã có agent ' +
        'phù hợp thì dispatch_agent/delegate_task thay vì tạo mới). Agent mới hiện ngay trong UI module Agents. ' +
        'Fields: Tên (unique), Mô tả vai trò, Hướng dẫn chi tiết (system prompt), Avatar (emoji), Model, ' +
        'Team + vị trí (hoặc standalone), Temperature, Lương token (maxTokens), Toolset.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Tên agent MỚI (unique, 2-50 ký tự, không trùng agent hiện có)' },
          description: { type: 'string', description: 'Mô tả vai trò ngắn (hiện trong UI module Agents)' },
          instruction: {
            type: 'string',
            description:
              'Hướng dẫn chi tiết — system prompt đầy đủ cho agent mới: vai trò, kỹ năng, cách làm việc, ' +
              'khi nào escalate về Omega. Viết kỹ — đây là "cặp não" của agent.',
          },
          capable: { type: 'string', description: 'Kỹ năng chính (comma-separated) — hiển thị trong Agent Roster cho agents khác thấy' },
          avatar: { type: 'string', description: 'Emoji avatar, vd: 🤖 🏗️ 🔬 🎨 📊 🧠 💡 ⚡ 🎯 🛡️ 📝 🔍 💻 🌐 🧪 📐' },
          model: {
            type: 'string',
            description:
              'Model ID (CHAT models — lõi extraction nemotron/gpt-oss BỊ CẤM cho agent chat). Khả dụng: moonshotai/kimi-k3 (lõi chính, mạnh) | ' +
              'deepseek-ai/deepseek-v4-pro-0813 | deepseek-ai/deepseek-v4-flash-0731 (nhanh) | minimaxai/minimax-m3',
          },
          team: { type: 'string', enum: ['code', 'research'], description: 'Team (null/omit = standalone agent)' },
          position: {
            type: 'string',
            description: 'Vị trí trong team — code: G4/G5 (mở rộng; TL/G1/G2-A/G2-B/G3 reserved cho hệ thống), research: TL/G1/G2/G3/G4/G5',
          },
          temperature: { type: 'number', description: 'Temperature 0.0-2.0 (0.3=kỹ thuật chặt chẽ, 0.7=cân bằng, 1.0+=sáng tạo)' },
          maxTokens: { type: 'number', description: 'LƯƠNG TOKEN (maxTokens) 256-32768 — trần output mỗi lượt của agent' },
          tools: {
            type: 'array',
            items: { type: 'string' },
            description: 'Toolset cho agent mới (tên tool). Bỏ trống = generalist mặc định (fs+shell+test+web+KB+todo+custom-tool+escalate_problem)',
          },
        },
        required: ['name', 'description', 'instruction'],
      },
    },
  },
  dispatch_agent: {
    type: 'function',
    function: {
      name: 'dispatch_agent',
      description:
        'ĐIỀU ĐỘNG agent BẤT KỲ trong Agent Roster tham gia xử lý tác vụ (quyền của Omega orchestrator). ' +
        '2 chế độ: (1) "task" (mặc định) — TẠM THỜI: agent chạy 1 task tự chủ, trả báo cáo nén (context của bạn không phình); ' +
        '(2) "long_term" — LÂU DÀI: điều agent vào team (cập nhật team/position trong module Agents, kèm task chạy luôn nếu có). ' +
        'Khác delegate_task (chỉ Code Team 5 vị trí): dispatch_agent gọi được MỌI agent kể cả custom/standalone.',
      parameters: {
        type: 'object',
        properties: {
          agent: { type: 'string', description: 'TÊN agent trong Agent Roster sẽ được điều động' },
          task: { type: 'string', description: 'Nhiệm vụ cụ thể giao cho agent (bắt buộc với duration=task; tùy chọn với long_term)' },
          context: { type: 'string', description: 'Context bổ sung: file liên quan, ràng buộc, kết quả bước trước...' },
          duration: {
            type: 'string',
            enum: ['task', 'long_term'],
            description: 'task = tham gia tạm thời cho 1 tác vụ (mặc định) | long_term = điều động lâu dài vào team',
          },
          team: { type: 'string', enum: ['code', 'research'], description: '(long_term) team đích — null/omit = standalone' },
          position: { type: 'string', description: '(long_term) vị trí trong team đích — code: G4/G5 (mở rộng), research: TL/G1/G2/G3/G4/G5' },
        },
        required: ['agent', 'task'],
      },
    },
  },

  // ===== 21-c: OMEGA TOOLS MANAGER — Omega tự quản lý tool-access của agents =====
  // (user request: "thiết lập để Omega cũng có thể sử dụng chức năng này") — CHỈ nằm
  // trong tool list của Omega (standalone-agents.ts) — Code Team 5 agent KHÔNG có
  // (tránh tranh quyền với quản trị viên). Executor: case 'manage_tools'.
  manage_tools: {
    type: 'function',
    function: {
      name: 'manage_tools',
      description: 'Quản lý tool-access của agents (chỉ Omega được dùng). Action: (1) list_tools — danh sách tool + agents + override status (compact); (2) set_tool_access {agentKey, toolName, enabled} — bật/tắt 1 tool cho 1 agent (enabled=null → reset về mặc định); (3) read_tool {toolName} — mô tả đầy đủ + parameters + ma trận agent của 1 tool; (4) read_skill {name} — đọc SKILL.md của skill filesystem; (5) write_skill {name, content} — ghi đè SKILL.md (tự backup .bak). agentKey hợp lệ: APEX|CORTEX|BOLT|SENTINEL|CATALYST|OMEGA|NEW_AGENT (NEW_AGENT = mọi agent động do Omega tạo).',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list_tools', 'set_tool_access', 'read_tool', 'read_skill', 'write_skill'], description: 'Hành động quản lý' },
          agentKey: { type: 'string', description: '(set_tool_access) Agent key: APEX|CORTEX|BOLT|SENTINEL|CATALYST|OMEGA|NEW_AGENT' },
          toolName: { type: 'string', description: '(set_tool_access/read_tool) Tên tool builtin' },
          enabled: { type: 'boolean', description: '(set_tool_access) true=bật, false=vô hiệu hóa, null/omit=reset về mặc định' },
          name: { type: 'string', description: '(read_skill/write_skill) Slug skill filesystem (vd "pdf", "web")' },
          content: { type: 'string', description: '(write_skill) Nội dung SKILL.md MỚI (toàn bộ, ghi đè — có backup .bak tự động)' },
        },
        required: ['action'],
      },
    },
  },

  // ===== AUTOMATION TOOLS (user request 2026-09-13) =====
  // 2 tool bổ sung cho module Smolab > Automation:
  //   • manage_automation — CHỈ Omega: trực tiếp tạo cron job / webhook /
  //     standing order / task flow (quyền mặc định của orchestrator).
  //   • propose_automation — MỌI agents: thấy cần automation → đề xuất, Omega
  //     quyết định forward vào Self-direction chờ Mr. Architect / agent được
  //     ủy quyền phê duyệt (được duyệt → tài nguyên tự tạo).
  manage_automation: {
    type: 'function',
    function: {
      name: 'manage_automation',
      description:
        'QUẢN LÝ TỰ ĐỘNG HÓA của module Smolab > Automation (CHỈ Omega có quyền mặc định). ' +
        'Actions: (1) create_cron {expression, taskPrompt} — cron job chạy theo lịch (expression vd "*/5 * * * *" hoặc "0 9 * * 1-5"); ' +
        '(2) list_cron; (3) toggle_cron {id, enabled}; (4) delete_cron {id}; ' +
        '(5) create_webhook {url, events[], secret?} — đăng ký endpoint nhận sự kiện (HTTPS công khai); (6) list_webhooks; (7) delete_webhook {id}; ' +
        '(8) add_standing_order {order, priority?} — chỉ thị thường trực inject vào mọi automation runs; (9) list_standing_orders; (10) delete_standing_order {id}; ' +
        '(11) list_flows — danh sách task flow; (12) create_flow {name, description?, steps[]} — quy trình nhiều bước Trigger→Action→Condition→Result ' +
        '(steps: [{type:"trigger",config:{kind:"cron",expression:"..."}}, {type:"action",config:{kind:"agent_task",taskPrompt:"..."}}, {type:"condition",config:{description:"điều kiện chạy tiếp"}}, {type:"result",config:{resultKind:"log"|"notify"}}]); ' +
        '(13) update_flow {id, name?, description?, steps?, enabled?}; (14) delete_flow {id}; (15) run_flow {id} — chạy flow ngay. ' +
        'Tác vụ chạy nền tự động — dùng khi user yêu cầu hoặc hệ thống cần automation.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: [
              'create_cron', 'list_cron', 'toggle_cron', 'delete_cron',
              'create_webhook', 'list_webhooks', 'delete_webhook',
              'add_standing_order', 'list_standing_orders', 'delete_standing_order',
              'list_flows', 'create_flow', 'update_flow', 'delete_flow', 'run_flow',
            ],
            description: 'Hành động automation',
          },
          // cron
          expression: { type: 'string', description: '(create_cron) Cron expression, vd "*/5 * * * *" (mỗi 5 phút), "0 9 * * 1-5" (9h sáng thứ 2-6)' },
          taskPrompt: { type: 'string', description: '(create_cron) Nhiệm vụ LLM chạy theo lịch (tiếng Việt, cụ thể)' },
          // webhook
          url: { type: 'string', description: '(create_webhook) URL đích HTTPS công khai' },
          events: { type: 'array', items: { type: 'string' }, description: '(create_webhook) Event đăng ký, vd ["document.uploaded","query.completed"] hoặc ["*"]' },
          secret: { type: 'string', description: '(create_webhook) HMAC secret (tùy chọn)' },
          // standing order
          order: { type: 'string', description: '(add_standing_order) Nội dung chỉ thị thường trực' },
          priority: { type: 'number', description: '(add_standing_order) Ưu tiên 0-100 (mặc định 0)' },
          // task flow
          name: { type: 'string', description: '(create_flow/update_flow) Tên flow' },
          description: { type: 'string', description: '(create_flow/update_flow) Mô tả flow' },
          steps: { type: 'array', items: { type: 'object' }, description: '(create_flow/update_flow) Chuỗi bước [{type, title, config}] — xem mô tả tool' },
          // chung
          id: { type: 'string', description: '(toggle_cron/delete_cron/delete_webhook/delete_standing_order/update_flow/delete_flow/run_flow) ID tài nguyên' },
          enabled: { type: 'boolean', description: '(toggle_cron/update_flow) Bật/tắt' },
        },
        required: ['action'],
      },
    },
  },

  propose_automation: {
    type: 'function',
    function: {
      name: 'propose_automation',
      description:
        'ĐỀ XUẤT tạo tài nguyên automation (cron job / webhook / standing order / task flow) khi bạn thấy CẦN nhưng KHÔNG có quyền tạo trực tiếp (chỉ Omega có manage_automation). ' +
        'Luồng: đề xuất của bạn → OMEGA quyết định (forward/từ chối) → nếu forward: vào module Self-direction chờ Mr. Architect hoặc agent được ủy quyền PHÊ DUYỆT → được duyệt thì tài nguyên tự tạo. ' +
        'Dùng khi: tác vụ lặp lại định kỳ đáng tự động hóa, cần đẩy sự kiện ra endpoint ngoài, cần chỉ thị thường trực, hoặc cần quy trình nhiều bước. ' +
        'KHÔNG dùng cho việc gấp cần làm ngay — tự làm bằng tools của mình.',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['cron', 'webhook', 'standing_order', 'task_flow'], description: 'Loại tài nguyên cần tạo' },
          payload: {
            type: 'object',
            description:
              'Nội dung theo kind: cron={expression:"0 9 * * 1-5", taskPrompt:"nhiệm vụ..."} | webhook={url:"https://...", events:["document.uploaded"]} | ' +
              'standing_order={order:"chỉ thị...", priority:50} | task_flow={name:"...", description:"...", steps:[{type:"trigger",config:{kind:"cron",expression:"..."}},{type:"action",config:{kind:"agent_task",taskPrompt:"..."}}]}',
          },
          reason: { type: 'string', description: 'Lý do cần automation này (cụ thể — Omega và người duyệt đọc lý do này)' },
          evidence: { type: 'string', description: 'Bằng chứng/dữ liệu hỗ trợ (vd tần suất lặp lại, số lần đã làm tay)' },
        },
        required: ['kind', 'payload', 'reason'],
      },
    },
  },
}

/**
 * Get tool definitions for a given position.
 * Each agent only sees tools it has permission to use.
 */
export function getToolDefinitionsForPosition(position: string): ToolDefinition[] {
  const tools = getAgentTools(position)
  return tools
    .map(t => ALL_TOOL_DEFINITIONS[t])
    .filter((def): def is ToolDefinition => def !== undefined)
}

/**
 * Get tool definitions for a given list of tool names.
 * Used when building context for LLM with specific tools.
 */
export function getToolDefinitions(tools: string[]): ToolDefinition[] {
  return tools
    .map(t => ALL_TOOL_DEFINITIONS[t])
    .filter((def): def is ToolDefinition => def !== undefined)
}

/**
 * Get ALL built-in tool summaries (name + description + category) — dùng bởi
 * GET /api/tools/registry để UI module Skills hiển thị đầy đủ tools hiện có
 * của app (user request 2026-08-30: "ô Skill.md guides chưa hiện hết skills/tools").
 */
export function getAllBuiltinToolSummaries(): Array<{
  name: string
  description: string
  category: string
  paramNames: string[]
}> {
  const summaries: Array<{ name: string; description: string; category: string; paramNames: string[] }> = []
  for (const [name, def] of Object.entries(ALL_TOOL_DEFINITIONS)) {
    summaries.push({
      name,
      description: def.function.description,
      category: name.startsWith('gateway_') ? 'gateway' : name.startsWith('knowledge_') ? 'knowledge' : name.startsWith('file_') || name === 'opencode' ? 'code' : 'other',
      paramNames: Object.keys((def.function.parameters as { properties?: Record<string, unknown> })?.properties || {}),
    })
  }
  return summaries
}

/**
 * 21-c: tool có phải builtin (có def trong ALL_TOOL_DEFINITIONS) không? —
 * dùng bởi POST /api/tools/assignments validate toolName trước khi set override.
 */
export function isBuiltinTool(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(ALL_TOOL_DEFINITIONS, name)
}

/**
 * 21-c: lấy FULL def 1 tool builtin (description + parameters JSON) — dùng bởi
 * GET /api/tools/builtin/[name] (dialog Tools Manager hiển thị parameters).
 */
export function getBuiltinToolDefinition(name: string): ToolDefinition | null {
  return ALL_TOOL_DEFINITIONS[name] ?? null
}

// ==================== TOOL EXECUTION ====================

export interface ToolExecutionResult {
  success: boolean
  result: unknown
  duration: number
}

/**
 * Execute a tool call from LLM.
 * Called in the ReAct loop when LLM returns a tool_call.
 *
 * @param toolName - Name of the tool to execute
 * @param args - Arguments from LLM's tool_call
 * @param context - Agent context (tên agent + sessionId) — dùng để ghi
 *                 Agent Activity Log hiển thị trong ô Terminal (user request
 *                 2026-08-27: Terminal phải thấy rõ agent đang chạy gì).
 * @returns Execution result with success status
 */
export async function executeTool(
  toolName: string,
  args: Record<string, unknown>,
  context?: {
    agentName?: string
    sessionId?: string | null
    /** RunId của run CHA (goal-loop / pipeline step) — delegate_task dùng làm parentRunId */
    runId?: string | null
    /**
     * DELEGATION CONTRACT (fix 2026-09-12): runId của run SUB-AGENT được
     * delegate — subagent-delegate truyền vào để tool events + todo snapshots
     * ghi vào run của sub-agent (chứ không trộn vào parent run).
     */
    delegationRunId?: string | null
  }
): Promise<ToolExecutionResult> {
  const startTime = Date.now()

  // Mỗi tool call đều được ghi vào Agent Activity Log (ring buffer in-memory)
  // → GET /api/agent-activity → Terminal UI poll 2.5s và echo `$ [AI] ...`.
  // Fail-open: record lỗi không được phép làm hỏng tool execution.
  //
  // 2026-08-31 — recordActivity giờ nhận cả `result` để:
  //   1. Terminal hiện KẾT QUẢ THẬT (resultPreview) chứ không chỉ lệnh
  //   2. Agent Run Tracker ghi tool event vào khối Thought Process trong chat
  //   3. todo_write → capture snapshot todo list cho panel Todos
  const recordActivity = (success: boolean, result?: unknown) => {
    try {
      const resultPreview = summarizeToolResult(toolName, result)
      recordAgentActivity({
        agentName: context?.agentName,
        tool: toolName,
        detail: summarizeToolCall(toolName, args),
        success,
        durationMs: Date.now() - startTime,
        sessionId: context?.sessionId ?? null,
        resultPreview,
      })
      // Thought Process panel trong chat — ghi vào run đang active của session.
      // DELEGATION CONTRACT (fix 2026-09-12): context.delegationRunId (sub-agent
      // được delegate) → ghi vào run CỦA SUB-AGENT thay vì run active của parent
      // (tránh trộn event + đè lastTodos của parent run — context isolation).
      recordAgentRunTool(context?.sessionId ?? null, {
        tool: toolName,
        argsSummary: summarizeToolCall(toolName, args),
        success,
        durationMs: Date.now() - startTime,
        resultPreview,
      }, context?.delegationRunId || undefined)
      // todo_write thành công → snapshot todo list (panel Todos trong chat)
      if (toolName === 'todo_write' && success) {
        const r = result as { todos?: Array<{ id?: string; content?: string; status?: string; priority?: string }> } | null
        if (r && Array.isArray(r.todos)) {
          recordAgentRunTodos(context?.sessionId ?? null, r.todos.map((t, i) => ({
            id: String(t.id ?? `todo_${i}`),
            content: String(t.content ?? ''),
            status: String(t.status ?? 'pending'),
            priority: t.priority ? String(t.priority) : undefined,
          })), context?.delegationRunId || undefined)
        }
      }
    } catch { /* ignore — display-only */ }
  }

  try {
    let result: unknown

    // ━━━ 21-c — EXECUTOR HARD-GATE (defense in depth) ━━━
    // ToolAssignment override enabled=false (Tools Manager UI / Omega manage_tools)
    // → chặn TẠI EXECUTOR dù LLM vẫn phát tool call — phủ mọi đường gọi
    // (goal-loop, workflow ReAct, sub-agent delegate, Pattern-1/2 parse).
    // KHÔNG chặn khi thiếu agent context (caller hệ thống). Fail-open tuyệt đối:
    // lỗi DB → cho chạy (prompt-side đã lượt tool khỏi list rồi).
    if (context?.agentName) {
      try {
        if (await isToolDisabledForAgent(context.agentName, toolName)) {
          const key = resolveAgentKey(context.agentName)
          const gateMsg = `Tool [${toolName}] đã bị vô hiệu hóa cho agent [${key}] bởi quản trị viên. Nếu cần dùng, hãy yêu cầu bật lại qua Tools Manager (hoặc Omega gọi manage_tools action=set_tool_access).`
          recordActivity(false, gateMsg)
          return {
            success: false,
            result: gateMsg,
            duration: Date.now() - startTime,
          }
        }
      } catch { /* fail-open — không bao giờ làm hỏng tool vì check quyền lỗi */ }
    }

    switch (toolName) {
      case 'opencode':
        result = await executeOpenCode(args)
        break
      case 'knowledge_search':
        result = await executeKnowledgeSearch(args)
        break
      case 'knowledge_graph':
        result = await executeKnowledgeGraph(args)
        break
      case 'knowledge_write':
        result = await executeKnowledgeWrite(args)
        break
      case 'tavily':
        result = await executeTavily(args)
        break
      case 'serper':
        result = await executeSerper(args)
        break
      case 'jina':
        result = await executeJina(args)
        break
      // ===== P0: dev tools =====
      // Phase 2 — each case checks both the master ENABLE_FILE_OPS flag AND its per-tool flag.
      // Per spec line 217: "each tool ENABLE_<TOOL> off by default, flip per acceptance test".
      // We default to true here for backward compat — operators can flip individual tools off.
      case 'file_read': {
        if (!isFlagEnabled('ENABLE_FILE_OPS') || !isFlagEnabled('ENABLE_FILE_READ')) {
          return {
            success: false,
            result: 'file_read tool is disabled (set ENABLE_FILE_OPS=true + ENABLE_FILE_READ=true in .env to enable).',
            duration: Date.now() - startTime,
          }
        }
        result = await executeFileReadFn(args as any)
        break
      }
      case 'file_edit': {
        if (!isFlagEnabled('ENABLE_FILE_OPS') || !isFlagEnabled('ENABLE_FILE_EDIT')) {
          return {
            success: false,
            result: 'file_edit tool is disabled (set ENABLE_FILE_OPS=true + ENABLE_FILE_EDIT=true in .env to enable).',
            duration: Date.now() - startTime,
          }
        }
        result = await fileEdit(args as any)
        break
      }
      case 'file_multi_edit': {
        if (!isFlagEnabled('ENABLE_FILE_OPS') || !isFlagEnabled('ENABLE_FILE_MULTI_EDIT')) {
          return {
            success: false,
            result: 'file_multi_edit tool is disabled (set ENABLE_FILE_OPS=true + ENABLE_FILE_MULTI_EDIT=true in .env to enable).',
            duration: Date.now() - startTime,
          }
        }
        // Routes to fileEdit with edits[] (atomic batch — all-or-nothing)
        result = await fileEdit(args as any)
        break
      }
      // 21-d: file_write — native write cho file lớn (overwrite/append, không truncate)
      case 'file_write': {
        if (!isFlagEnabled('ENABLE_FILE_OPS') || !isFlagEnabled('ENABLE_FILE_WRITE')) {
          return {
            success: false,
            result: 'file_write tool is disabled (set ENABLE_FILE_OPS=true + ENABLE_FILE_WRITE=true in .env to enable).',
            duration: Date.now() - startTime,
          }
        }
        result = await fileWrite(args as any)
        break
      }
      case 'file_delete': {
        if (!isFlagEnabled('ENABLE_FILE_OPS') || !isFlagEnabled('ENABLE_FILE_DELETE')) {
          return {
            success: false,
            result: 'file_delete tool is disabled (set ENABLE_FILE_OPS=true + ENABLE_FILE_DELETE=true in .env to enable).',
            duration: Date.now() - startTime,
          }
        }
        result = await fileDelete(args as any)
        break
      }
      case 'file_list': {
        if (!isFlagEnabled('ENABLE_FILE_OPS') || !isFlagEnabled('ENABLE_FILE_LIST')) {
          return {
            success: false,
            result: 'file_list tool is disabled (set ENABLE_FILE_OPS=true + ENABLE_FILE_LIST=true in .env to enable).',
            duration: Date.now() - startTime,
          }
        }
        result = await fileList(args as any)
        break
      }
      case 'grep': {
        if (!isFlagEnabled('ENABLE_FILE_OPS') || !isFlagEnabled('ENABLE_FILE_GREP')) {
          return {
            success: false,
            result: 'grep tool is disabled (set ENABLE_FILE_OPS=true + ENABLE_FILE_GREP=true in .env to enable).',
            duration: Date.now() - startTime,
          }
        }
        result = await grep(args as any)
        break
      }
      case 'run_tests': {
        if (!isFlagEnabled('ENABLE_RUN_TESTS')) {
          return {
            success: false,
            result: 'run_tests tool is disabled (set ENABLE_RUN_TESTS=true in .env to enable).',
            duration: Date.now() - startTime,
          }
        }
        result = await runTests(args as any)
        break
      }
      case 'git_commit': {
        if (!isFlagEnabled('ENABLE_GIT_COMMIT')) {
          return {
            success: false,
            result: 'git_commit tool is disabled (set ENABLE_GIT_COMMIT=true in .env to enable). Standing rule: KHÔNG push remote.',
            duration: Date.now() - startTime,
          }
        }
        result = await gitCommit(args as any)
        break
      }
      // P0.5 — remote git ops (user request 2026-08-29): push/pull active workspace.
      // Cùng feature flag ENABLE_GIT_COMMIT (mọi git tools tắt cùng nhau).
      case 'git_push': {
        if (!isFlagEnabled('ENABLE_GIT_COMMIT')) {
          return {
            success: false,
            result: 'git_push tool is disabled (set ENABLE_GIT_COMMIT=true in .env to enable).',
            duration: Date.now() - startTime,
          }
        }
        result = await gitPush(args as any)
        break
      }
      case 'git_pull': {
        if (!isFlagEnabled('ENABLE_GIT_COMMIT')) {
          return {
            success: false,
            result: 'git_pull tool is disabled (set ENABLE_GIT_COMMIT=true in .env to enable).',
            duration: Date.now() - startTime,
          }
        }
        result = await gitPullWorkspace(args as any)
        break
      }
      // CI-6 (Task 10-b) — mở thư mục workspace bằng File Explorer / VS Code
      case 'open_workspace': {
        let wsRoot = typeof args.rootPath === 'string' && args.rootPath.trim() ? args.rootPath.trim() : ''
        if (!wsRoot) {
          // Default = workspace đang active (workspace-root resolver: DB → env → cwd)
          wsRoot = await resolveWorkspaceRoot()
        }
        const editorArg = args.editor === 'vscode' ? 'vscode' : 'explorer'
        result = await openWorkspaceInExplorerFn(wsRoot, editorArg)
        break
      }
      // CI-6.4 (Task 10-b) — pipeline kiểm định 5 lớp trước push (fail → TỪ CHỐI push)
      case 'verify_and_push': {
        if (!isFlagEnabled('ENABLE_GIT_COMMIT')) {
          return {
            success: false,
            result: 'verify_and_push tool is disabled (set ENABLE_GIT_COMMIT=true in .env to enable).',
            duration: Date.now() - startTime,
          }
        }
        result = await runPrePushVerification({
          commitMessage: typeof args.commit_message === 'string' ? args.commit_message : '',
          paths: Array.isArray(args.paths)
            ? args.paths.filter((p): p is string => typeof p === 'string' && p.trim() !== '')
            : undefined,
          smokeUrl: typeof args.smoke_url === 'string' && args.smoke_url.trim() ? args.smoke_url.trim() : undefined,
          dryRun: args.dry_run === true,
        })
        break
      }
      // ===== CI-4 B3-B5 (Task 11-c) — structured git tools =====
      // Read-only 3 tool (status/diff/log): luôn bật — không flag, đã validate
      // injection guard ở tầng dev-tools (target ref cục bộ, paths scoped workspace).
      case 'git_status':
        result = await executeGitStatusFn(
          typeof args.root === 'string' && args.root.trim() ? args.root.trim() : undefined,
        )
        break
      case 'git_diff':
        result = await executeGitDiffFn({
          target: typeof args.target === 'string' && args.target.trim() ? args.target : undefined,
          staged_only: args.staged_only === true,
          paths: Array.isArray(args.paths)
            ? args.paths.filter((p): p is string => typeof p === 'string' && p.trim() !== '')
            : undefined,
          max_lines: typeof args.max_lines === 'number' && Number.isFinite(args.max_lines) ? args.max_lines : undefined,
        })
        break
      case 'git_log':
        result = await executeGitLogFn({
          limit: typeof args.limit === 'number' && Number.isFinite(args.limit) ? args.limit : undefined,
          path: typeof args.path === 'string' && args.path.trim() ? args.path : undefined,
          oneline: args.oneline === true,
        })
        break
      // Write-class 2 tool (branch/clone): gate chung ENABLE_GIT_COMMIT — đồng bộ
      // policy section P0.5 ("1 flag tắt hết mọi git tool"), KHÔNG thêm flag mới.
      case 'git_branch': {
        if (!isFlagEnabled('ENABLE_GIT_COMMIT')) {
          return {
            success: false,
            result: 'git_branch tool is disabled (set ENABLE_GIT_COMMIT=true in .env to enable).',
            duration: Date.now() - startTime,
          }
        }
        result = await executeGitBranchFn({
          action: (typeof args.action === 'string' ? args.action : '') as 'list' | 'create' | 'switch' | 'delete',
          name: typeof args.name === 'string' ? args.name : undefined,
          force: args.force === true,
        })
        break
      }
      case 'git_clone': {
        if (!isFlagEnabled('ENABLE_GIT_COMMIT')) {
          return {
            success: false,
            result: 'git_clone tool is disabled (set ENABLE_GIT_COMMIT=true in .env to enable).',
            duration: Date.now() - startTime,
          }
        }
        result = await executeGitCloneFn({
          url: typeof args.url === 'string' ? args.url : '',
          target_dir: typeof args.target_dir === 'string' && args.target_dir.trim() ? args.target_dir : undefined,
          depth: typeof args.depth === 'number' && Number.isFinite(args.depth) ? args.depth : undefined,
        })
        break
      }
      // ===== CI-3 B2+B3 (Task 13-b) — Kho Context: truy hồi context đã nén =====
      // Read-only (Qdrant semantic + SQL LIKE trên TaskContextArchive) — không
      // flag gate, fail-open trả hint 0 kết quả khi mọi layer hỏng (không 500).
      case 'context_recall':
        result = await executeContextRecallFn({
          query: typeof args.query === 'string' ? args.query : '',
          runId: typeof args.runId === 'string' && args.runId.trim() ? args.runId.trim() : undefined,
          limit: typeof args.limit === 'number' && Number.isFinite(args.limit) ? args.limit : undefined,
        })
        break
      // ===== P1: diagnostics + planning + synthesis + processes + packages =====
      case 'get_diagnostics':
        result = await getDiagnostics(args as any)
        break
      // ===== v2.1 Phase 3 — code intelligence + MCP (spec lines 223-242) =====
      // 3.1 lsp_diagnostics — alias of getDiagnostics (separate tool name per spec line 228)
      case 'lsp_diagnostics': {
        if (!isFlagEnabled('ENABLE_LSP_DIAGNOSTICS')) {
          return {
            success: false,
            result: 'lsp_diagnostics tool is disabled (set ENABLE_LSP_DIAGNOSTICS=true in .env to enable). See docs/FULLSTACK_CAPABILITY_PLAN_V2.md Phase 3.1.',
            duration: Date.now() - startTime,
          }
        }
        result = await getDiagnostics(args as any)
        break
      }
      // 3.2 browser_screenshot — Playwright headless chromium → base64 PNG
      case 'browser_screenshot': {
        if (!isFlagEnabled('ENABLE_BROWSER_SCREENSHOT')) {
          return {
            success: false,
            result: 'browser_screenshot tool is disabled (set ENABLE_BROWSER_SCREENSHOT=true in .env to enable). See docs/FULLSTACK_CAPABILITY_PLAN_V2.md Phase 3.2.',
            duration: Date.now() - startTime,
          }
        }
        result = await executeBrowserScreenshotFn(args as any)
        break
      }
      // 3.3a lint — ESLint --format json parser
      case 'lint': {
        if (!isFlagEnabled('ENABLE_LINT')) {
          return {
            success: false,
            result: 'lint tool is disabled (set ENABLE_LINT=true in .env to enable). See docs/FULLSTACK_CAPABILITY_PLAN_V2.md Phase 3.3.',
            duration: Date.now() - startTime,
          }
        }
        result = await executeLintFn(args as any)
        break
      }
      // 3.3b type_check — tsc --noEmit parser
      case 'type_check': {
        if (!isFlagEnabled('ENABLE_TYPE_CHECK')) {
          return {
            success: false,
            result: 'type_check tool is disabled (set ENABLE_TYPE_CHECK=true in .env to enable). See docs/FULLSTACK_CAPABILITY_PLAN_V2.md Phase 3.3.',
            duration: Date.now() - startTime,
          }
        }
        result = await executeTypeCheckFn(args as any)
        break
      }
      // 3.4 test_coverage — bun test --coverage parser
      case 'test_coverage': {
        if (!isFlagEnabled('ENABLE_TEST_COVERAGE')) {
          return {
            success: false,
            result: 'test_coverage tool is disabled (set ENABLE_TEST_COVERAGE=true in .env to enable). See docs/FULLSTACK_CAPABILITY_PLAN_V2.md Phase 3.4.',
            duration: Date.now() - startTime,
          }
        }
        result = await executeTestCoverageFn(args as any)
        break
      }
      // 3.5 db_query — Prisma $queryRawUnsafe + read-only guard
      case 'db_query': {
        if (!isFlagEnabled('ENABLE_DB_QUERY')) {
          return {
            success: false,
            result: 'db_query tool is disabled (set ENABLE_DB_QUERY=true in .env to enable). See docs/FULLSTACK_CAPABILITY_PLAN_V2.md Phase 3.5.',
            duration: Date.now() - startTime,
          }
        }
        result = await executeDbQueryFn(args as any)
        break
      }
      // 3.6 mcp_call — MCP bridge (servers operator cấu hình qua env/config)
      case 'mcp_call': {
        if (!isFlagEnabled('ENABLE_MCP_CALL')) {
          return {
            success: false,
            result: 'mcp_call tool is disabled (set ENABLE_MCP_CALL=true in .env to enable). See docs/FULLSTACK_CAPABILITY_PLAN_V2.md Phase 3.6.',
            duration: Date.now() - startTime,
          }
        }
        // CI-4 B6 (Task 11-c): chặn mock built-in servers tại executor — chúng
        // trả dữ liệu GIẢ (vd github create_pr → PR #42 không tồn tại) và agents
        // đã từng tin theo. mcp-bridge.ts giữ nguyên; khi Phase 5 thay mock bằng
        // subprocess thật (bỏ flag mock) thì lọc này tự mở lại.
        const mcpServerId = typeof args.server === 'string' ? args.server.trim().toLowerCase() : ''
        const hiddenMockIds = await getHiddenMockMcpServerIds()
        if (hiddenMockIds.has(mcpServerId)) {
          return {
            success: false,
            result: `MCP server "${mcpServerId}" là built-in MOCK (Phase 3 stub — dữ liệu giả, Phase 5 chưa hiện thực) và đã bị ẩn. KHÔNG dùng nó cho tác vụ thật. Dùng tools builtin tương ứng: file_read/file_write/file_list (filesystem), git_status/git_diff/git_log/git_commit/git_push (github), db_query (SQL), browser_screenshot (browser).`,
            duration: Date.now() - startTime,
          }
        }
        result = await executeMcpCallFn(args as any)
        break
      }
      case 'decompose_task':
        result = await decomposeTask(args as any)
        break
      case 'create_task':
        result = await createTask(args as any)
        break
      case 'update_task':
        result = await updateTask(args as any)
        break
      case 'get_plan':
        result = await getPlan()
        break
      case 'summarize':
        result = await summarize(args as any)
        break
      case 'synthesize':
        result = await synthesize(args as any)
        break
      case 'run_bg':
        result = await runBg(args as any)
        break
      case 'read_output':
        result = await readOutput(args as any)
        break
      case 'kill_process':
        result = await killProcess(args as any)
        break
      case 'manage_packages':
        result = await managePackages(args as any)
        break
      // ===== Phase 6 (rebuild): AI preview tools — proxy to the Phase 3
      // /api/opencode/preview/{start,stop} routes (port collision safe,
      // per-root log file, SSE stream) so the UI can auto-open the Preview. =====
      case 'start_preview': {
        const previewRoot = typeof args.root === 'string' && args.root
          ? args.root
          : (await getActiveWorkspaceRoot()) || process.cwd()
        try {
          const res = await fetch('http://127.0.0.1:3000/api/opencode/preview/start', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              // FIX 2026-08-28: ensureTmoApiToken() — tự provision khi .env thiếu
              'x-tmo-api-token': ensureTmoApiToken() ?? process.env.TMO_API_TOKEN ?? '',
            },
            body: JSON.stringify({
              root: previewRoot,
              // Task 19-b: đánh dấu preview do AGENT khởi động — agents khác
              // (qua get_app_runtime_status) biết process này KHÔNG phải của user.
              startedBy: 'agent',
              ...(typeof args.command === 'string' && args.command ? { command: args.command } : {}),
            }),
            signal: AbortSignal.timeout(30_000),
          })
          const data = await res.json().catch(() => null) as Record<string, unknown> | null
          if (!res.ok || !data || (data.status !== 'started' && data.status !== 'already_running')) {
            result = {
              success: false,
              error: `start_preview failed (HTTP ${res.status})`,
              detail: data ? JSON.stringify(data).slice(0, 400) : 'no response body',
            }
            break
          }
          const startedPort = typeof data.port === 'number' ? data.port : null
          const pid = typeof data.pid === 'number' ? data.pid : null
          // `port` FIRST — detail is truncated at 500 chars upstream and the
          // UI (tmo-ai-tool-event listener) regex-extracts the port to open
          // the Preview panel.
          result = {
            success: true,
            port: startedPort,
            summary: `Dev server started on port ${startedPort} for ${previewRoot} (pid ${pid})`,
            pid,
            command: typeof data.command === 'string' ? data.command : undefined,
            logFile: typeof data.logFile === 'string' ? data.logFile : undefined,
            startedAt: typeof data.startedAt === 'number' ? data.startedAt : undefined,
            root: previewRoot,
            status: data.status,
          }
        } catch (err) {
          result = {
            success: false,
            error: `start_preview request failed: ${err instanceof Error ? err.message : String(err)}`,
          }
        }
        break
      }
      case 'stop_preview': {
        const stopRoot = typeof args.root === 'string' && args.root
          ? args.root
          : (await getActiveWorkspaceRoot()) || process.cwd()
        try {
          const res = await fetch('http://127.0.0.1:3000/api/opencode/preview/stop', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              // FIX 2026-08-28: ensureTmoApiToken() — tự provision khi .env thiếu
              'x-tmo-api-token': ensureTmoApiToken() ?? process.env.TMO_API_TOKEN ?? '',
            },
            body: JSON.stringify({ root: stopRoot }),
            signal: AbortSignal.timeout(15_000),
          })
          const data = await res.json().catch(() => null) as Record<string, unknown> | null
          if (!res.ok || !data) {
            result = {
              success: false,
              error: `stop_preview failed (HTTP ${res.status})`,
            }
            break
          }
          // Idempotent: always success — note whether something was actually stopped
          result = {
            success: true,
            summary: data.stopped
              ? `Dev server stopped for ${stopRoot} (pid ${data.pid})`
              : `No running dev server for ${stopRoot} — nothing to stop`,
            stopped: Boolean(data.stopped),
            pid: typeof data.pid === 'number' ? data.pid : undefined,
            root: stopRoot,
          }
        } catch (err) {
          result = {
            success: false,
            error: `stop_preview request failed: ${err instanceof Error ? err.message : String(err)}`,
          }
        }
        break
      }
      // ===== Task 19-b (App Runtime Awareness): liệt kê preview/dev-server
      // đang chạy (registry shared — thấy được CẢ preview user tự bấm Start
      // trong UI), HTTP probe từng port + tail log gần nhất. Fail-open tuyệt
      // đối: registry rỗng/lỗi → vẫn trả JSON hợp lệ, không bao giờ throw. =====
      case 'get_app_runtime_status': {
        const rawTail = Number(args.tail_lines)
        const tailLines = Number.isFinite(rawTail) && rawTail > 0
          ? Math.min(100, Math.floor(rawTail))
          : 20
        try {
          const previews = listRunningPreviews()
          if (previews.length === 0) {
            result = {
              success: true,
              running: false,
              count: 0,
              hint: 'Không có preview nào đang chạy. Dùng start_preview để khởi động.',
            }
            break
          }

          // Chỉ HTTP-probe port nằm trong allowlist preview-proxy (start/detect
          // đăng ký) — tránh quét port tùy ý (SSRF-ish).
          const allowedPorts = new Set(listPreviewPorts())
          const detailed = await Promise.all(previews.map(async (p) => {
            let httpStatus: number | 'unreachable' = 'unreachable'
            if (typeof p.port === 'number' && allowedPorts.has(p.port)) {
              try {
                const probe = await fetch(`http://127.0.0.1:${p.port}/`, {
                  method: 'HEAD',
                  signal: AbortSignal.timeout(2500),
                })
                httpStatus = probe.status
              } catch {
                httpStatus = 'unreachable'
              }
            }
            return {
              root: p.root,
              port: p.port ?? null,
              pid: p.pid,
              startedAt: new Date(p.startedAt).toISOString(),
              startedBy: p.startedBy,
              alive: p.alive,
              httpStatus,
              logFile: p.logFile ?? null,
              recentLog: p.logFile ? tailPreviewLog(p.logFile, tailLines) : [],
            }
          }))

          // Hint lấy từ preview MỚI KHỞI ĐỘNG NHẤT (user thường đang xem cái đó)
          const newest = detailed
            .slice()
            .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
            .find(d => typeof d.port === 'number')
          const hint = newest
            ? `Preview của user đang chạy ở port ${newest.port} — KHÔNG kill nếu không được yêu cầu. Có thể curl http://127.0.0.1:${newest.port}/ qua tool shell để kiểm tra sâu hơn.`
            : 'Có preview đang chạy nhưng chưa xác định được port — chờ dev server sẵn sàng rồi gọi lại get_app_runtime_status, hoặc đọc recentLog.'

          result = {
            success: true,
            running: true,
            count: detailed.length,
            previews: detailed,
            hint,
          }
        } catch (err) {
          result = {
            success: true, // fail-open — không có preview nào biết được ≠ lỗi tool
            running: false,
            count: 0,
            hint: 'Không xác định được trạng thái preview (fail-open). Có thể dùng shell để kiểm tra thủ công (ps aux | grep dev).',
            error: err instanceof Error ? err.message : String(err),
          }
        }
        break
      }
      // ===== P2: gateway proxy (36 tools) =====
      case 'gateway_tool':
        result = await gatewayTool(args as any)
        break
      // ===== v2.1 Phase 1a — Claude Code/Z.ai Code parity primitives =====
      case 'shell':
        if (!isFlagEnabled('ENABLE_SHELL_TOOL')) {
          return {
            success: false,
            result: 'shell tool is disabled (set ENABLE_SHELL_TOOL=true in .env to enable). See docs/FULLSTACK_CAPABILITY_PLAN_V2.md Part 12.',
            duration: Date.now() - startTime,
          }
        }
        result = await executeShellFn(args as any)
        break
      case 'todo_write':
        if (!isFlagEnabled('ENABLE_TODO_TOOL')) {
          return {
            success: false,
            result: 'todo_write tool is disabled (set ENABLE_TODO_TOOL=true in .env to enable). See docs/FULLSTACK_CAPABILITY_PLAN_V2.md Part 12.',
            duration: Date.now() - startTime,
          }
        }
        result = await executeTodoWriteFn(args as any)
        break
      case 'todo_read':
        if (!isFlagEnabled('ENABLE_TODO_TOOL')) {
          return {
            success: false,
            result: 'todo_read tool is disabled (set ENABLE_TODO_TOOL=true in .env to enable). See docs/FULLSTACK_CAPABILITY_PLAN_V2.md Part 12.',
            duration: Date.now() - startTime,
          }
        }
        result = await executeTodoReadFn(args as any)
        break
      // ===== Dynamic skill + MCP enumeration (user request 2026-08-29) =====
      case 'list_skills':
        result = await executeListSkillsFn(args as any)
        break
      case 'read_skill':
        result = await executeReadSkillFn(args as { slug: string })
        break
      case 'mcp_list_servers': {
        // CI-4 B6 (Task 11-c) — de-advertise: lọc mock built-in servers (Phase 3
        // stub) khỏi danh sách agents nhìn thấy. mcp-bridge.ts giữ nguyên — chỉ
        // lọc ở tầng hiển thị cho agents.
        const rawListing = await executeMcpListServersFn()
        result = await filterMockMcpServersFromListing(rawListing)
        break
      }
      // ===== v2.1 Phase 1b.1: Unified web (consolidate tavily/serper/jina) =====
      case 'web_search':
        if (!isFlagEnabled('ENABLE_WEB_UNIFIED')) {
          return {
            success: false,
            result: 'web_search tool is disabled (set ENABLE_WEB_UNIFIED=true in .env to enable). Tip: tavily/serper tools remain available without the flag.',
            duration: Date.now() - startTime,
          }
        }
        result = await executeWebSearch(args)
        break
      case 'web_fetch':
        if (!isFlagEnabled('ENABLE_WEB_UNIFIED')) {
          return {
            success: false,
            result: 'web_fetch tool is disabled (set ENABLE_WEB_UNIFIED=true in .env to enable). Tip: jina tool remains available without the flag.',
            duration: Date.now() - startTime,
          }
        }
        result = await executeWebFetch(args)
        break
      // ===== v2.1 Phase 1b.2: P0 first-class gateway tools (proxy via gateway-bridge) =====
      case 'gateway_exec':
      case 'gateway_read':
      case 'gateway_write':
      case 'gateway_edit':
      case 'gateway_apply_patch':
        if (flagMode('ENABLE_GATEWAY_TOOLS', ['off', 'phase-1b', 'full']) === 'off') {
          return {
            success: false,
            result: `${toolName} is disabled (set ENABLE_GATEWAY_TOOLS=phase-1b in .env to enable). Tip: gateway_tool (generic proxy) remains available without the flag.`,
            duration: Date.now() - startTime,
          }
        }
        result = await executeP0GatewayTool(toolName, args)
        break
      // ===== v2.1 Phase 4.5 — exit_plan_mode (NEW — Claude Code parity) =====
      // Agent emits plan + target files + risk assessment → workflow pauses for
      // user approval. We persist the pending plan to CodeTeamSession.partsDefinition
      // (repurposed as a JSON blob carrier) so /api/openclaw/plan-mode can read it.
      // Returns { approved:false, _hint:'.../?action=approve' } immediately so
      // the ReAct loop knows the workflow is paused.
      case 'exit_plan_mode': {
        if (!isFlagEnabled('ENABLE_PLAN_MODE')) {
          return {
            success: false,
            result: 'exit_plan_mode tool is disabled (set ENABLE_PLAN_MODE=true in .env to enable). See docs/FULLSTACK_CAPABILITY_PLAN_V2.md Phase 4.5.',
            duration: Date.now() - startTime,
          }
        }
        const plan = String(args.plan || '')
        const filesToModify = Array.isArray(args.filesToModify) ? args.filesToModify.map(String) : []
        const riskLevel = (['low', 'medium', 'high'].includes(String(args.riskLevel)) ? String(args.riskLevel) : 'medium') as 'low' | 'medium' | 'high'
        const sessionId = String(args.sessionId || 'default')
        const planId = `plan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

        try {
          // Phase 4 audit fix (Task 11, P1-3): previously this block used
          // `if (existing)` to guard the update — but if the CodeTeamSession
          // row didn't exist (e.g. agent called exit_plan_mode outside a
          // workflow, or session row was never created), the plan was
          // silently dropped while the tool still returned planId+approved:false
          // as if persisted. The plan-mode API then 404s on approve/reject.
          //
          // Fix: upsert to guarantee the row exists with safe defaults, then
          // read-modify-write the partsDefinition JSON array. The create
          // branch carries the plan inline so it's persisted atomically; the
          // update branch does the read-push-write for existing sessions.
          const entry = {
            planId,
            type: 'pending_plan' as const,
            plan,
            filesToModify,
            riskLevel,
            status: 'pending' as const,
            createdAt: new Date().toISOString(),
          }

          const existing = await db.codeTeamSession.findUnique({
            where: { sessionId },
            select: { partsDefinition: true },
          })
          if (!existing) {
            // Create the session row with the plan as the first entry.
            // Safe defaults: routingMode 'C' (manual), tier 1, score 3 (minimal).
            // currentStep 'plan_pending' surfaces the pause state in the UI.
            await db.codeTeamSession.create({
              data: {
                sessionId,
                routingMode: 'C',
                tier: 1,
                score: 3,
                currentStep: 'plan_pending',
                partsDefinition: JSON.stringify([entry]),
              },
            })
          } else {
            let partsRaw: unknown[]
            try { partsRaw = JSON.parse(existing.partsDefinition || '[]') } catch { partsRaw = [] }
            if (!Array.isArray(partsRaw)) partsRaw = []
            partsRaw.push(entry)
            await db.codeTeamSession.update({
              where: { sessionId },
              data: { partsDefinition: JSON.stringify(partsRaw) },
            })
          }
        } catch (err) {
          console.warn(`[ToolExecutor] exit_plan_mode persist failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`)
        }

        result = {
          planId,
          approved: false,
          modifications: undefined,
          status: 'pending',
          _hint: 'Plan surfaced for review. Call POST /api/openclaw/plan-mode?action=approve (body: {planId, sessionId}) to approve, ?action=reject to reject, ?action=modify (body: {planId, modifications, sessionId}) to modify.',
        }
        break
      }
      // ===== v2.1 Phase 4.6 — cron (NEW — Z.ai Code parity) =====
      // Action: create | list | delete | run. Delegates to src/lib/cron/scheduler.ts.
      // The cron-scheduler mini-service (port 3004) tick loop queries for due jobs.
      case 'cron': {
        if (!isFlagEnabled('ENABLE_CRON_TOOL')) {
          return {
            success: false,
            result: 'cron tool is disabled (set ENABLE_CRON_TOOL=true in .env to enable). See docs/FULLSTACK_CAPABILITY_PLAN_V2.md Phase 4.6.',
            duration: Date.now() - startTime,
          }
        }
        const action = String(args.action || '')
        if (action === 'create') {
          const schedule = args.schedule as CronSchedule | undefined
          const task = String(args.task || '')
          if (!schedule || !schedule.kind || !schedule.expr) {
            return {
              success: false,
              result: 'cron create requires { schedule: { kind, expr }, task }',
              duration: Date.now() - startTime,
            }
          }
          if (!task) {
            return {
              success: false,
              result: 'cron create requires non-empty task description',
              duration: Date.now() - startTime,
            }
          }
          try {
            const created = await createCronJobFn({
              schedule,
              task,
              sessionId: args.sessionId ? String(args.sessionId) : undefined,
            })
            result = {
              success: true,
              jobId: created.jobId,
              nextRun: created.nextRun?.toISOString() ?? null,
              dryRun: created.dryRun,
              jobHash: created.jobHash,
              duplicate: created.duplicate,
              _hint: created.duplicate
                ? 'Duplicate schedule (jobHash already exists) — returned existing jobId without re-registering.'
                : 'Job registered. cron-scheduler mini-service (port 3004) will execute on nextRunAt.',
            }
          } catch (err) {
            return {
              success: false,
              result: `cron create failed: ${err instanceof Error ? err.message : String(err)}`,
              duration: Date.now() - startTime,
            }
          }
        } else if (action === 'list') {
          const list = await listCronJobsFn({
            status: typeof args.status === 'string' ? (args.status as 'active' | 'paused' | 'completed' | 'failed') : undefined,
            sessionId: args.sessionId ? String(args.sessionId) : undefined,
          })
          result = { success: true, jobs: list, count: list.length }
        } else if (action === 'delete') {
          if (!args.jobId) {
            return { success: false, result: 'cron delete requires jobId', duration: Date.now() - startTime }
          }
          const del = await deleteCronJobFn(String(args.jobId))
          result = { success: del.success, jobId: args.jobId, error: del.error }
        } else if (action === 'run') {
          if (!args.jobId) {
            return { success: false, result: 'cron run requires jobId', duration: Date.now() - startTime }
          }
          const runResult = await runCronJobFn(String(args.jobId))
          result = { success: runResult.success, jobId: args.jobId, result: runResult.result, error: runResult.error }
        } else {
          return {
            success: false,
            result: `cron action "${action}" not recognized — must be one of: create, list, delete, run`,
            duration: Date.now() - startTime,
          }
        }
        break
      }
      // ===== v2.1 Phase 5.2 — delegate tool (sub-agent dispatch) =====
      // Spec: docs/FULLSTACK_CAPABILITY_PLAN_V2.md Phase 5.2 (lines 315-320).
      // Real sub-agent delegation path goes through src/lib/orchestration/agent-delegator.ts.
      // Gated by ENABLE_REAL_DELEGATE: when false, the tool returns a "disabled" message
      // so legacy callers don't accidentally fire real LLM calls. When true, the
      // delegator runs the real LLM path (1 LLM call + optional 1 tool_call + 1 synthesis).
      case 'delegate': {
        if (!isFlagEnabled('ENABLE_REAL_DELEGATE')) {
          return {
            success: false,
            result: 'delegate tool is disabled (set ENABLE_REAL_DELEGATE=true in .env to enable). See docs/FULLSTACK_CAPABILITY_PLAN_V2.md Phase 5.2.',
            duration: Date.now() - startTime,
          }
        }
        // Build the DelegatedTask from args. Required: assignedAgent, description.
        // Optional: id, parentSessionId, taskType, input, expectedOutput, context, timeout, priority.
        // Dynamic import avoids a static circular dep: orchestration/agent-delegator
        // imports from code-team/agent-resolver + code-team/tool-executor (this file),
        // so a static import here would close the cycle.
        try {
          const { createAgentDelegator } = await import('@/lib/orchestration/agent-delegator')
          const sessionId = typeof args.sessionId === 'string' ? args.sessionId : `delegate-${Date.now()}`
          const assignedAgent = typeof args.assignedAgent === 'string' ? args.assignedAgent : 'G2-A'
          const taskId = typeof args.id === 'string' ? args.id : `delegate-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
          const delegator = createAgentDelegator(sessionId)
          const task = {
            id: taskId,
            parentSessionId: sessionId,
            assignedAgent: assignedAgent as 'TL' | 'G1' | 'G2-A' | 'G2-B' | 'G3',
            taskType: typeof args.taskType === 'string' ? args.taskType : 'delegated',
            description: typeof args.description === 'string' ? args.description : '(no description)',
            input: typeof args.input === 'string' ? args.input : '',
            expectedOutput: typeof args.expectedOutput === 'string' ? args.expectedOutput : '',
            context: typeof args.context === 'string' ? args.context : '',
            timeout: typeof args.timeout === 'number' ? args.timeout : 120_000,
            priority: typeof args.priority === 'number' ? args.priority : 0,
          }
          const delegateResult = await delegator.delegate(task)
          result = {
            success: delegateResult.success,
            taskId: delegateResult.taskId,
            agentPosition: delegateResult.agentPosition,
            output: delegateResult.output,
            duration: delegateResult.duration,
            tokensUsed: delegateResult.tokensUsed,
            filesCreated: delegateResult.filesCreated,
            filesModified: delegateResult.filesModified,
            errors: delegateResult.errors.map((e) => ({ message: e.message, severity: e.severity })),
          }
        } catch (err) {
          return {
            success: false,
            result: `delegate failed: ${err instanceof Error ? err.message : String(err)}`,
            duration: Date.now() - startTime,
          }
        }
        break
      }
      // ===== Custom Tools (user request 2026-08-30) — agents tự viết tools =====
      case 'create_custom_tool': {
        try {
          const { createCustomTool } = await import('@/lib/custom-tool-registry')
          const createResult = await createCustomTool({
            name: String(args.name || ''),
            description: String(args.description || ''),
            parameters: (args.parameters && typeof args.parameters === 'object'
              ? args.parameters as Record<string, unknown>
              : { type: 'object', properties: {} }),
            handlerCode: String(args.handlerCode || ''),
            skillMd: typeof args.skillMd === 'string' ? args.skillMd : undefined,
            source: 'agent',
          })
          result = createResult
          if (!createResult.success) {
            recordActivity(false)
            return {
              success: false,
              result: `Tạo custom tool thất bại: ${createResult.error}`,
              duration: Date.now() - startTime,
            }
          }
        } catch (err) {
          return {
            success: false,
            result: `create_custom_tool lỗi: ${err instanceof Error ? err.message : String(err)}`,
            duration: Date.now() - startTime,
          }
        }
        break
      }
      case 'delete_custom_tool': {
        try {
          const { deleteCustomTool } = await import('@/lib/custom-tool-registry')
          result = await deleteCustomTool(String(args.name || ''))
        } catch (err) {
          return {
            success: false,
            result: `delete_custom_tool lỗi: ${err instanceof Error ? err.message : String(err)}`,
            duration: Date.now() - startTime,
          }
        }
        break
      }
      case 'list_custom_tools': {
        try {
          const { ensureCustomToolsLoaded, getAllCustomTools } = await import('@/lib/custom-tool-registry')
          await ensureCustomToolsLoaded()
          const tools = getAllCustomTools()
          result = {
            success: true,
            count: tools.length,
            tools: tools.map(t => ({
              name: t.name,
              description: t.description,
              parameters: t.parameters,
              version: t.version,
              callCount: t.callCount,
              enabled: t.enabled,
            })),
            hint: tools.length === 0
              ? 'Chưa có custom tool nào. Dùng create_custom_tool để tự viết tool mới.'
              : 'Gọi trực tiếp: tool_call: <name>({...args}). Muốn xóa: delete_custom_tool({"name": "..."})',
          }
        } catch (err) {
          return {
            success: false,
            result: `list_custom_tools lỗi: ${err instanceof Error ? err.message : String(err)}`,
            duration: Date.now() - startTime,
          }
        }
        break
      }
      // ===== SUB-AGENT DELEGATION (user request 2026-09-08) =====
      // Omega/agent khác → gọi Code Team chuyên trách. Token sub-agent tiêu thụ
      // được báo về caller qua result.tokensUsed — goal loop cộng vào budget tổng.
      case 'delegate_task': {
        if (!isFlagEnabled('ENABLE_SUBAGENT_DELEGATE')) {
          return {
            success: false,
            result: 'delegate_task tool is disabled (set ENABLE_SUBAGENT_DELEGATE=true in .env to enable).',
            duration: Date.now() - startTime,
          }
        }
        try {
          const { runSubAgent, resolveDelegationTarget, DELEGATABLE_AGENTS } = await import('@/lib/subagent-delegate')
          const target = resolveDelegationTarget(args.agent ?? args.agentName)
          if (!target) {
            result = {
              success: false,
              error: `Agent "${String(args.agent ?? '')}" không hợp lệ. Chọn một trong: ${DELEGATABLE_AGENTS.map(a => a.name).join(', ')}.`,
            }
            break
          }
          const task = String(args.task ?? args.description ?? '').trim()
          if (!task) {
            result = { success: false, error: 'Thiếu "task" — mô tả nhiệm vụ cụ thể cho sub-agent.' }
            break
          }
          const outcome = await runSubAgent({
            position: target,
            task,
            context: args.context ? String(args.context) : undefined,
            // DELEGATION CONTRACT (fix 2026-09-12): điều kiện hoàn thành kiểm
            // định được — sub-agent tự verify từng điều kiện + báo cáo ĐẠT/CHƯA ĐẠT;
            // parentRunId để hiển thị nguồn giao việc trong Thought Process panel.
            acceptanceCriteria: args.acceptance_criteria ? String(args.acceptance_criteria) : undefined,
            parentRunId: context?.runId ?? null,
            parentAgentName: context?.agentName || 'parent-agent',
            sessionId: context?.sessionId ?? null,
          })
          result = {
            success: outcome.success,
            agent: outcome.agent,
            position: outcome.position,
            report: outcome.report,
            tokensUsed: outcome.tokensUsed,
            iterations: outcome.iterations,
            toolCalls: outcome.toolCalls,
            endedBy: outcome.endedBy,
            evidence: outcome.evidence.slice(-12),
            error: outcome.error,
            hint: outcome.success
              ? undefined
              : 'Delegate thất bại — bạn có thể tự làm trực tiếp bằng tools của mình, hoặc delegate lại agent khác.',
          }
        } catch (err) {
          result = { success: false, error: `delegate_task lỗi: ${err instanceof Error ? err.message : String(err)}` }
        }
        break
      }
      // ===== OMEGA ORCHESTRATION (user request 2026-09-08) =====
      // (1) Mọi agent gặp vấn đề → escalate_problem → Omega-on-demand tư vấn
      //     giải pháp tốt nhất (nhận diện sớm, không chờ kẹt hẳn).
      case 'escalate_problem': {
        const problem = String(args.problem ?? args.issue ?? '').trim()
        if (!problem) {
          result = { success: false, error: 'Thiếu "problem" — mô tả vấn đề cụ thể bạn đang gặp.' }
          break
        }
        try {
          const { consultOmega } = await import('@/lib/omega-orchestrator')
          const consult = await consultOmega({
            problem,
            context: args.context ? String(args.context) : undefined,
            attempted: args.attempted ? String(args.attempted) : undefined,
            callingAgent: context?.agentName || 'unknown-agent',
            severity: ['low', 'medium', 'high'].includes(String(args.severity)) ? String(args.severity) : 'medium',
          })
          result = consult.success
            ? {
                success: true,
                advisory: consult.text,
                dispatchAgent: consult.advisory?.dispatchAgent ?? null,
                createAgentSuggestion: consult.advisory?.createAgent ?? null,
                tokensUsed: consult.tokensUsed,
              }
            : { success: false, error: `Omega consult thất bại: ${consult.error || 'không rõ lỗi'}` }
        } catch (err) {
          result = { success: false, error: `escalate_problem lỗi: ${err instanceof Error ? err.message : String(err)}` }
        }
        break
      }
      // (2) Omega Agent Factory — tự tạo agent mới trong module Agents
      //     (avatar, tên, mô tả, instruction, model, team, vị trí, temp, lương token).
      case 'create_agent': {
        try {
          const { createAgentByOmega } = await import('@/lib/omega-orchestrator')
          const created = await createAgentByOmega({
            name: args.name !== undefined ? String(args.name) : '',
            description: args.description !== undefined ? String(args.description) : '',
            instruction: args.instruction !== undefined ? String(args.instruction) : '',
            avatar: args.avatar !== undefined ? String(args.avatar) : undefined,
            provider: args.provider ? String(args.provider) : undefined,
            model: args.model !== undefined ? String(args.model) : undefined,
            team: args.team === null || args.team === undefined ? null : (args.team ? String(args.team) : null),
            position: args.position === null || args.position === undefined ? null : (args.position ? String(args.position) : null),
            temperature: typeof args.temperature === 'number' ? args.temperature : undefined,
            maxTokens: typeof args.maxTokens === 'number' ? args.maxTokens : undefined,
            domain: args.domain ? String(args.domain) : undefined,
            capable: args.capable ? String(args.capable) : undefined,
            tools: Array.isArray(args.tools) ? args.tools.map((t: unknown) => String(t)) : undefined,
          })
          result = created.success
            ? {
                success: true,
                agent: created.agent,
                message: `Đã tạo agent "${created.agent?.name}" — hiện trong module Agents. Agents khác thấy agent này trong Agent Roster (điều động qua dispatch_agent).`,
              }
            : { success: false, error: created.error || 'Tạo agent thất bại' }
        } catch (err) {
          result = { success: false, error: `create_agent lỗi: ${err instanceof Error ? err.message : String(err)}` }
        }
        break
      }
      // (3) Omega Dispatcher — điều động agent BẤT KỲ: tạm thời (task) hoặc
      //     lâu dài (vào team). Token sub-agent báo về qua result.tokensUsed.
      case 'dispatch_agent': {
        if (!isFlagEnabled('ENABLE_SUBAGENT_DELEGATE')) {
          return {
            success: false,
            result: 'dispatch_agent tool is disabled (set ENABLE_SUBAGENT_DELEGATE=true in .env to enable).',
            duration: Date.now() - startTime,
          }
        }
        try {
          const { dispatchAgentByOmega } = await import('@/lib/omega-orchestrator')
          const duration = String(args.duration ?? 'task') === 'long_term' ? 'long_term' : 'task'
          const dispatched = await dispatchAgentByOmega({
            agent: (args.agent ?? args.agentName) as string,
            task: args.task ? String(args.task) : undefined,
            context: args.context ? String(args.context) : undefined,
            duration,
            team: args.team === undefined ? undefined : (args.team === null ? null : String(args.team)),
            position: args.position === undefined ? undefined : (args.position === null ? null : String(args.position)),
            parentAgentName: context?.agentName || 'Omega',
            sessionId: context?.sessionId ?? null,
          })
          result = {
            success: dispatched.success,
            mode: dispatched.mode,
            agent: dispatched.agent,
            report: dispatched.report,
            assignment: dispatched.assignment,
            tokensUsed: dispatched.tokensUsed,
            iterations: dispatched.iterations,
            toolCalls: dispatched.toolCalls,
            endedBy: dispatched.endedBy,
            error: dispatched.error,
            hint: dispatched.success
              ? undefined
              : 'Điều động thất bại — kiểm tra tên agent trong Agent Roster, hoặc tự làm trực tiếp bằng tools của mình.',
          }
        } catch (err) {
          result = { success: false, error: `dispatch_agent lỗi: ${err instanceof Error ? err.message : String(err)}` }
        }
        break
      }
      // ===== 21-c: Omega Tools Manager — Omega tự quản lý tool-access khi cần =====
      // (def chỉ nằm trong tool list của Omega — Code Team KHÔNG được cấp).
      // Mọi action fail-open: lỗi → JSON thân thiện, KHÔNG crash executor.
      case 'manage_tools': {
        try {
          result = await executeManageTools(args, context)
        } catch (err) {
          result = { success: false, error: `manage_tools lỗi: ${err instanceof Error ? err.message : String(err)}` }
        }
        break
      }
      // ===== AUTOMATION TOOLS (user request 2026-09-13) =====
      // Omega trực tiếp quản lý automation của module Smolab > Automation.
      // Fail-open mọi action: lỗi → JSON thân thiện với hint.
      case 'manage_automation': {
        try {
          result = await executeManageAutomation(args, context)
        } catch (err) {
          result = { success: false, error: `manage_automation lỗi: ${err instanceof Error ? err.message : String(err)}` }
        }
        break
      }
      // Agent (không có quyền trực tiếp) đề xuất automation → Omega quyết định
      // → Self-direction chờ phê duyệt (user request 2026-09-13).
      case 'propose_automation': {
        try {
          const { submitAutomationProposal, validateAutomationRequest } = await import('@/lib/automation-proposals')
          const validated = validateAutomationRequest(args.kind, args.payload)
          if (!validated.ok) {
            result = { success: false, error: validated.error }
            break
          }
          const submitted = await submitAutomationProposal({
            kind: validated.data.kind,
            // Payload đã validate đầy đủ theo kind — cast qua unknown (union
            // payload types không overlap đủ trực tiếp từ Record<string, unknown>)
            payload: validated.data.payload as unknown as Parameters<typeof submitAutomationProposal>[0]['payload'],
            proposedBy: context?.agentName || 'unknown-agent',
            reason: args.reason ? String(args.reason) : undefined,
            evidence: args.evidence ? String(args.evidence) : undefined,
          })
          result = submitted.success
            ? {
                success: true,
                forwarded: submitted.forwarded,
                proposalId: submitted.proposalId ?? null,
                message: submitted.forwarded
                  ? `Omega đã CHUYỂN TIẾP đề xuất ${validated.data.kind} vào module Self-direction (proposal ${submitted.proposalId}) — chờ Mr. Architect hoặc agent được ủy quyền phê duyệt; được duyệt thì tài nguyên tự tạo. Lý do Omega: ${submitted.omegaReason || '(không nêu)'}`
                  : `Omega TỪ CHỐI đề xuất này — không gửi vào Self-direction. Lý do: ${submitted.omegaReason || '(không nêu)'}. Có thể chỉnh sửa đề xuất rõ hơn rồi thử lại.`,
                omegaReason: submitted.omegaReason ?? null,
                tokensUsed: submitted.tokensUsed,
              }
            : { success: false, error: submitted.error || 'Đề xuất thất bại' }
        } catch (err) {
          result = { success: false, error: `propose_automation lỗi: ${err instanceof Error ? err.message : String(err)}` }
        }
        break
      }
      default: {
        // ===== Custom tool dispatch (user request 2026-08-30) =====
        // Tool không nằm trong built-in list → kiểm tra custom tool registry
        // (agents TỰ VIẾT qua create_custom_tool + lazy-load từ DB).
        try {
          const ctr = await import('@/lib/custom-tool-registry')
          await ctr.ensureCustomToolsLoaded()
          // Next.js dev có thể tách module instance theo route → tool tạo ở
          // instance khác có thể chưa vào registry instance này. Reload DB
          // một lần trước khi kết luận "unknown tool".
          if (!ctr.isCustomToolRegistered(toolName)) {
            await ctr.loadCustomToolsFromDB()
          }
          if (ctr.isCustomToolRegistered(toolName)) {
            const execResult = await ctr.executeCustomTool(toolName, args, 10000, 2000)
            recordActivity(execResult.success, execResult.success ? execResult.result : { error: execResult.error || 'Custom tool execution failed', timedOut: execResult.timedOut || false })
            return {
              success: execResult.success,
              result: execResult.success
                ? execResult.result
                : { error: execResult.error || 'Custom tool execution failed', timedOut: execResult.timedOut || false },
              duration: Date.now() - startTime,
            }
          }
        } catch (registryErr) {
          console.warn(`[ToolExecutor] Custom tool dispatch failed for "${toolName}":`, registryErr instanceof Error ? registryErr.message : String(registryErr))
        }

        recordActivity(false, `Unknown tool: ${toolName}`)
        return {
          success: false,
          result: `Unknown tool: ${toolName}`,
          duration: Date.now() - startTime,
        }
      }
    }

    // FIX (review 2026-09-08): result là OBJECT có field success (vd
    // delegate_task / escalate_problem / create_agent / dispatch_agent /
    // knowledge_search...) → propagate truthiness ĐÚNG ra ngoài. Trước đây
    // outer luôn success:true → goal-loop evidence ghi "✓" cho tool THẤT BẠI
    // bên trong (tín hiệu mâu thuẫn cho evaluator + AUTO-ESCALATE không thấy
    // được dispatch fail).
    const innerSuccess = result !== null && typeof result === 'object'
      && typeof (result as Record<string, unknown>).success === 'boolean'
      ? (result as Record<string, unknown>).success === true
      : true
    recordActivity(innerSuccess, result)
    return {
      success: innerSuccess,
      result,
      duration: Date.now() - startTime,
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    console.error(`[ToolExecutor] Error executing ${toolName}:`, errorMsg)
    recordActivity(false, `Tool error: ${errorMsg}`)
    return {
      success: false,
      result: `Tool error: ${errorMsg}`,
      duration: Date.now() - startTime,
    }
  }
}

// ==================== 21-c: MANAGE_TOOLS — Omega Tools Manager ====================
//
// Omega tự quản lý tool-access + đọc/sửa skill khi user yêu cầu ("hãy bật tool X
// cho agent Y"). 5 action — mọi action try/catch fail-open (lỗi → JSON thân thiện).

/** Ma trận agent mặc định cho manage_tools: [key, tên hiển thị, tools mặc định] */
async function getManageToolsAgentMatrix(): Promise<Array<{ key: string; label: string; tools: string[] }>> {
  const matrix: Array<{ key: string; label: string; tools: string[] }> = []
  try {
    const { getStandaloneAgentTools } = await import('@/lib/standalone-agents')
    for (const name of ['Omega']) {
      matrix.push({ key: 'OMEGA', label: name, tools: getStandaloneAgentTools(name) })
    }
  } catch { /* fail-open — bỏ qua */ }
  const { getAgentName } = await import('./agents')
  for (const [pos, key] of [['TL', 'APEX'], ['G1', 'CORTEX'], ['G2-A', 'BOLT'], ['G2-B', 'SENTINEL'], ['G3', 'CATALYST']] as const) {
    try {
      matrix.push({ key, label: getAgentName(pos), tools: getAgentTools(pos) })
    } catch { /* fail-open */ }
  }
  try {
    const { DEFAULT_NEW_AGENT_TOOLS } = await import('@/lib/omega-orchestrator')
    matrix.push({ key: 'NEW_AGENT', label: 'Agent động (do Omega tạo)', tools: [...DEFAULT_NEW_AGENT_TOOLS] })
  } catch { /* fail-open */ }
  return matrix
}

async function executeManageTools(
  args: Record<string, unknown>,
  _context?: { agentName?: string; sessionId?: string | null },
): Promise<unknown> {
  const action = String(args.action ?? '')
  const {
    getAllAssignments, setAssignment, normalizeAgentKeyStrict,
  } = await import('@/lib/tool-access')

  // ── (1) list_tools — compact: mỗi tool 1 dòng "tên | agents | override" ──
  if (action === 'list_tools') {
    const summaries = getAllBuiltinToolSummaries()
    const matrix = await getManageToolsAgentMatrix()
    const assignments = await getAllAssignments()

    const lines: string[] = []
    lines.push(`TOOLS (${summaries.length} builtin) — cột A = agents mặc định có tool; OV = override:`)
    for (const t of summaries) {
      const agents = matrix
        .filter(m => m.tools.includes(t.name))
        .map(m => m.key)
      const overrides = assignments
        .filter(a => a.toolName === t.name)
        .map(a => `${a.agentKey}:${a.enabled ? 'ON' : 'OFF'}`)
      const descLine = t.description.split('\n')[0].slice(0, 60)
      lines.push(
        `- ${t.name} [${t.category}] A=[${agents.join(',') || '—'}]${overrides.length ? ` OV=[${overrides.join(', ')}]` : ''} — ${descLine}`,
      )
    }
    lines.push('')
    lines.push('AGENTS: ' + matrix.map(m => `${m.key}=${m.label} (${m.tools.length} tools)`).join(' · '))
    lines.push('Lệnh: set_tool_access {agentKey, toolName, enabled} | read_tool {toolName} | read_skill/write_skill {name}')
    // Cap ~70 dòng compact để đỡ tốn token
    return { success: true, toolCount: summaries.length, listing: lines.slice(0, 72).join('\n'), truncated: lines.length > 72 }
  }

  // ── (2) set_tool_access — bật/tắt/reset tool cho agent (updatedBy: omega) ──
  if (action === 'set_tool_access') {
    const agentKey = String(args.agentKey ?? '')
    const toolName = String(args.toolName ?? '')
    const enabled = args.enabled === null || args.enabled === undefined ? null : Boolean(args.enabled)
    if (!agentKey || !toolName) {
      return { success: false, error: 'Cần đủ agentKey + toolName (enabled: true/false/null-reset)' }
    }
    const key = normalizeAgentKeyStrict(agentKey)
    if (!key) {
      return { success: false, error: 'agentKey không hợp lệ — dùng: APEX|CORTEX|BOLT|SENTINEL|CATALYST|OMEGA|NEW_AGENT' }
    }
    if (!isBuiltinTool(toolName)) {
      return { success: false, error: `Tool "${toolName}" không phải builtin. Dùng list_tools để xem danh sách.` }
    }
    const row = await setAssignment(key, toolName, enabled, 'omega')
    return {
      success: true,
      agentKey: key,
      toolName,
      enabled,
      effect: enabled === null ? 'reset về mặc định (đã xóa override)' : enabled ? 'ĐÃ BẬT (thêm vào whitelist hiệu dụng)' : 'ĐÃ VÔ HIỆU HÓA (chặn cả prompt lẫn executor)',
      row,
      note: 'Enforce 2 lớp: prompt-side (LLM không thấy tool) + executor hard-gate (gọi cũng bị chặn).',
    }
  }

  // ── (3) read_tool — mô tả đầy đủ + parameters + ma trận agent 1 tool ──
  if (action === 'read_tool') {
    const toolName = String(args.toolName ?? '')
    const summary = getAllBuiltinToolSummaries().find(t => t.name === toolName)
    if (!summary) {
      return { success: false, error: `Tool "${toolName}" không phải builtin. Dùng list_tools để xem danh sách.` }
    }
    const matrix = await getManageToolsAgentMatrix()
    const assignments = await getAllAssignments()
    return {
      success: true,
      tool: toolName,
      description: summary.description,
      parameters: summary.paramNames,
      agents: matrix.map(m => ({
        agentKey: m.key,
        label: m.label,
        defaultHas: m.tools.includes(toolName),
        override: assignments.find(a => a.agentKey === m.key && a.toolName === toolName)?.enabled ?? null,
      })),
    }
  }

  // ── (4) read_skill — đọc SKILL.md filesystem (cap 30K chars như read_skill) ──
  if (action === 'read_skill') {
    const name = String(args.name ?? '')
    const { readFsSkill } = await import('@/lib/fs-skills')
    const skill = await readFsSkill(name)
    if (!skill) {
      return { success: false, error: `Skill "${name}" không có SKILL.md trên đĩa (hoặc tên không hợp lệ). Omega có thể dùng list_skills để liệt kê.` }
    }
    const CAP = 30_000
    return {
      success: true,
      slug: skill.slug,
      size: skill.size,
      hasBackup: skill.hasBackup,
      truncated: skill.content.length > CAP,
      content: skill.content.slice(0, CAP),
    }
  }

  // ── (5) write_skill — ghi đè SKILL.md (backup .bak tự động lần đầu) ──
  if (action === 'write_skill') {
    const name = String(args.name ?? '')
    const content = typeof args.content === 'string' ? args.content : ''
    const { writeFsSkill } = await import('@/lib/fs-skills')
    const written = await writeFsSkill(name, content)
    if (!written.ok) {
      return { success: false, error: written.error }
    }
    return {
      success: true,
      slug: written.slug,
      size: written.size,
      backupCreated: written.backupCreated,
      note: 'Đã ghi đè skills/' + written.slug + '/SKILL.md. Bản gốc giữ tại SKILL.md.bak (lần sửa đầu).',
    }
  }

  return { success: false, error: `Action không hợp lệ: "${action}" — dùng list_tools | set_tool_access | read_tool | read_skill | write_skill` }
}

/**
 * Tóm tắt ngắn gọn tool call cho Agent Activity Log / Terminal echo.
 * shell → lệnh; file_* → path; opencode → action + path/command; ...
 */
function summarizeToolCall(toolName: string, args: Record<string, unknown>): string {
  const s = (v: unknown) => (typeof v === 'string' ? v : '')
  switch (toolName) {
    case 'shell':
    case 'run_bg':
      return s(args.command)
    case 'file_read':
    case 'file_edit':
    case 'file_write':
    case 'file_delete':
      return s(args.path)
    case 'file_multi_edit':
      return s(args.path) || `${Array.isArray(args.edits) ? args.edits.length : '?'} edits`
    case 'file_list':
      return s(args.path) || s(args.pattern) || '.'
    case 'grep':
      return s(args.pattern)
    case 'opencode': {
      const action = s(args.action)
      const target = s(args.path) || s(args.command) || ''
      return action ? `${action} ${target}`.trim() : target
    }
    case 'run_tests':
      return s(args.path) || 'auto-detect'
    case 'git_commit':
      return s(args.message).slice(0, 120)
    case 'git_push':
      return `${s(args.branch) || 'HEAD'} → remote${args.force ? ' (force)' : ''}`
    case 'git_pull':
      return `${s(args.branch) || 'HEAD'} ← remote${args.force ? ' (force)' : ''}`
    case 'todo_write':
      return `${Array.isArray(args.todos) ? args.todos.length : '?'} bước`
    case 'knowledge_search':
    case 'tavily':
    case 'serper':
    case 'web_search':
      return s(args.query)
    case 'jina':
    case 'web_fetch':
      return s(args.url)
    case 'create_custom_tool':
      return `tạo tool "${s(args.name)}"`
    case 'delete_custom_tool':
      return `xóa tool "${s(args.name)}"`
    case 'list_custom_tools':
      return 'liệt kê custom tools'
    default: {
      try { return JSON.stringify(args).slice(0, 150) } catch { return '' }
    }
  }
}

/**
 * Tóm tắt KẾT QUẢ THẬT của tool cho Terminal + Thought Process panel
 * (user request 2026-08-31: hiện cả lệnh LẪN kết quả chạy thật).
 *
 * shell/run_bg → stdout+stderr; file_read → content preview + số dòng;
 * file_edit → số edits áp dụng; todo_write → số bước ghi; search → count kết quả;
 * default → JSON stringify truncated. Fail-open: lỗi → chuỗi rỗng.
 */
function summarizeToolResult(toolName: string, result: unknown): string {
  try {
    if (result == null) return ''
    const trunc = (s: string, max = 700) => (s.length > max ? `${s.slice(0, max)}…` : s)
    if (typeof result === 'string') {
      return trunc(result)
    }
    if (typeof result !== 'object') {
      return trunc(String(result), 300)
    }
    const r = result as Record<string, unknown>
    switch (toolName) {
      case 'shell':
      case 'run_bg': {
        const out = [String(r.stdout || ''), String(r.stderr || '')].filter(Boolean).join('\n').trim()
        if (out) return trunc(out)
        // run_bg không có output ngay (background) — hiện process info
        if (r.pid) return trunc(`[background] pid=${r.pid}${r.message ? ` · ${r.message}` : ''}`, 200)
        return trunc(JSON.stringify(result), 300)
      }
      case 'file_read': {
        const content = typeof r.content === 'string' ? r.content : ''
        const totalLines = typeof r.totalLines === 'number' ? r.totalLines : 0
        if (content) {
          const preview = content.split('\n').slice(0, 12).join('\n')
          return trunc(`${preview}\n… (${totalLines} dòng)`, 600)
        }
        return trunc(JSON.stringify(result), 300)
      }
      case 'file_edit':
      case 'file_multi_edit': {
        const applied = typeof r.editsApplied === 'number' ? r.editsApplied : 0
        const dry = r.dryRun ? ' (dry-run)' : ''
        return trunc(`Đã áp dụng ${applied} edit${dry}${r.newFileSize ? ` · size=${r.newFileSize}` : ''} · ${r.path || ''}`, 300)
      }
      case 'file_write': {
        const bytes = typeof r.bytesWritten === 'number' ? r.bytesWritten : 0
        const mode = r.mode === 'append' ? 'append' : 'overwrite'
        return trunc(`Đã ghi ${mode} ${bytes} bytes · size=${r.fileSize ?? '?'} · ${r.path || ''}`, 300)
      }
      case 'todo_write': {
        const n = typeof r.upserted === 'number' ? r.upserted : (Array.isArray(r.todos) ? r.todos.length : 0)
        return `Đã ghi ${n} todo`
      }
      case 'todo_read': {
        const total = typeof r.total === 'number' ? r.total : 0
        return `Đọc ${total} todo`
      }
      case 'knowledge_search':
      case 'tavily':
      case 'serper':
      case 'web_search': {
        const n = Array.isArray(r.results) ? r.results.length
          : Array.isArray(r.sources) ? r.sources.length
          : typeof r.resultCount === 'number' ? r.resultCount : 0
        return trunc(`${n} kết quả`, 200)
      }
      case 'git_commit': {
        const commit = typeof r.commit === 'string' ? r.commit.slice(0, 12) : ''
        const files = Array.isArray(r.files) ? r.files.length : 0
        return trunc(`${commit ? `commit ${commit}` : 'OK'}${files ? ` · ${files} file` : ''}`, 200)
      }
      default: {
        return trunc(JSON.stringify(result), 500)
      }
    }
  } catch {
    return ''
  }
}

// ==================== MANAGE_AUTOMATION — Omega trực tiếp quản lý automation (2026-09-13) ====================
//
// 15 action trên 4 loại tài nguyên của module Smolab > Automation:
// cron jobs / webhooks / standing orders / task flows. Fail-open mọi action
// (lỗi → JSON thân thiện + hint, KHÔNG throw ra executor).

async function executeManageAutomation(
  args: Record<string, unknown>,
  context?: { agentName?: string; sessionId?: string | null },
): Promise<unknown> {
  const action = String(args.action ?? '')
  const dbMod = await import('@/lib/db')
  const db = dbMod.db
  const { approximateNextRun, validateWebhookUrl } = await import('@/lib/automation-engine')
  const AGENT_ID = 'default'
  const actor = context?.agentName || 'Omega'

  // ── Cron Jobs ──────────────────────────────────────────────────────────
  if (action === 'create_cron') {
    const expression = String(args.expression ?? '').trim()
    const taskPrompt = String(args.taskPrompt ?? '').trim()
    if (!expression || !taskPrompt) {
      return { success: false, error: 'create_cron cần {expression, taskPrompt} — vd expression "0 9 * * 1-5"' }
    }
    const job = await db.cronJob.create({
      data: {
        agentId: AGENT_ID,
        expression: expression.slice(0, 100),
        taskPrompt: taskPrompt.slice(0, 3000),
        enabled: true,
        nextRunAt: approximateNextRun(expression),
      },
    })
    return {
      success: true,
      jobId: job.id,
      expression: job.expression,
      nextRunAt: job.nextRunAt?.toISOString() ?? null,
      message: `Đã tạo cron job "${taskPrompt.slice(0, 80)}" (lịch ${expression}) — hiển thị trong Smolab > Automation, scheduler tự chạy theo lịch.`,
    }
  }
  if (action === 'list_cron') {
    const jobs = await db.cronJob.findMany({
      where: { agentId: AGENT_ID },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { id: true, expression: true, taskPrompt: true, enabled: true, lastRunAt: true, nextRunAt: true, status: true },
    })
    return {
      success: true,
      count: jobs.length,
      jobs: jobs.map(j => ({
        id: j.id, expression: j.expression, task: j.taskPrompt.slice(0, 120),
        enabled: j.enabled, status: j.status,
        lastRunAt: j.lastRunAt?.toISOString() ?? null, nextRunAt: j.nextRunAt?.toISOString() ?? null,
      })),
    }
  }
  if (action === 'toggle_cron') {
    const id = String(args.id ?? '')
    const enabled = args.enabled === true
    if (!id) return { success: false, error: 'toggle_cron cần {id, enabled}' }
    const existing = await db.cronJob.findUnique({ where: { id } })
    if (!existing) return { success: false, error: `Cron job ${id} không tồn tại` }
    const updated = await db.cronJob.update({
      where: { id },
      data: { enabled, ...(enabled ? { nextRunAt: approximateNextRun(existing.expression) } : {}) },
    })
    return { success: true, jobId: id, enabled: updated.enabled, message: `Cron job "${updated.taskPrompt.slice(0, 60)}" ${enabled ? 'ĐÃ BẬT' : 'ĐÃ TẮT'}.` }
  }
  if (action === 'delete_cron') {
    const id = String(args.id ?? '')
    if (!id) return { success: false, error: 'delete_cron cần {id}' }
    const existing = await db.cronJob.findUnique({ where: { id } })
    if (!existing) return { success: false, error: `Cron job ${id} không tồn tại` }
    await db.cronJob.delete({ where: { id } })
    return { success: true, jobId: id, message: `Đã xóa cron job "${existing.taskPrompt.slice(0, 60)}".` }
  }

  // ── Webhooks ───────────────────────────────────────────────────────────
  if (action === 'create_webhook') {
    const url = String(args.url ?? '').trim()
    const events = Array.isArray(args.events) ? args.events.map(e => String(e).trim()).filter(Boolean) : []
    if (!url || events.length === 0) {
      return { success: false, error: 'create_webhook cần {url, events[]} — vd events ["document.uploaded","query.completed"] hoặc ["*"]' }
    }
    const check = validateWebhookUrl(url)
    if (!check.valid) {
      return { success: false, error: `URL không hợp lệ: ${check.reason} — chỉ nhận HTTP/HTTPS công khai (chống SSRF).` }
    }
    const wh = await db.webhook.create({
      data: {
        agentId: AGENT_ID,
        url: url.slice(0, 1000),
        events: JSON.stringify(events.slice(0, 10)),
        secret: args.secret ? String(args.secret).slice(0, 200) : null,
        enabled: true,
      },
    })
    return {
      success: true,
      webhookId: wh.id,
      url: wh.url,
      events,
      message: `Đã đăng ký webhook ${url} (events: ${events.join(', ')}) — sự kiện khớp sẽ POST kèm HMAC-SHA256 (nếu có secret).`,
    }
  }
  if (action === 'list_webhooks') {
    const webhooks = await db.webhook.findMany({
      where: { agentId: AGENT_ID },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { id: true, url: true, events: true, enabled: true, secret: true },
    })
    return {
      success: true,
      count: webhooks.length,
      webhooks: webhooks.map(w => ({ id: w.id, url: w.url, events: JSON.parse(w.events || '[]'), enabled: w.enabled, hasSecret: Boolean(w.secret) })),
    }
  }
  if (action === 'delete_webhook') {
    const id = String(args.id ?? '')
    if (!id) return { success: false, error: 'delete_webhook cần {id}' }
    const existing = await db.webhook.findUnique({ where: { id } })
    if (!existing) return { success: false, error: `Webhook ${id} không tồn tại` }
    await db.webhook.delete({ where: { id } })
    return { success: true, webhookId: id, message: `Đã xóa webhook ${existing.url}.` }
  }

  // ── Standing Orders ────────────────────────────────────────────────────
  if (action === 'add_standing_order') {
    const order = String(args.order ?? '').trim()
    if (!order) return { success: false, error: 'add_standing_order cần {order} — nội dung chỉ thị thường trực' }
    const priorityRaw = typeof args.priority === 'number' ? args.priority : parseInt(String(args.priority ?? '0'), 10)
    const priority = Number.isFinite(priorityRaw) ? Math.min(100, Math.max(0, Math.round(priorityRaw))) : 0
    const so = await db.standingOrder.create({
      data: { agentId: AGENT_ID, order: order.slice(0, 2000), priority, enabled: true },
    })
    return {
      success: true,
      orderId: so.id,
      priority,
      message: `Đã thêm standing order (P${priority}): "${order.slice(0, 100)}" — inject vào system prompt của mọi automation runs (cron/heartbeat/task flow).`,
    }
  }
  if (action === 'list_standing_orders') {
    const orders = await db.standingOrder.findMany({
      where: { agentId: AGENT_ID },
      orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
      take: 50,
      select: { id: true, order: true, priority: true, enabled: true },
    })
    return { success: true, count: orders.length, orders }
  }
  if (action === 'delete_standing_order') {
    const id = String(args.id ?? '')
    if (!id) return { success: false, error: 'delete_standing_order cần {id}' }
    const existing = await db.standingOrder.findUnique({ where: { id } })
    if (!existing) return { success: false, error: `Standing order ${id} không tồn tại` }
    await db.standingOrder.delete({ where: { id } })
    return { success: true, orderId: id, message: `Đã xóa standing order "${existing.order.slice(0, 80)}".` }
  }

  // ── Task Flows ─────────────────────────────────────────────────────────
  if (action === 'list_flows') {
    const { listTaskFlows } = await import('@/lib/task-flows')
    const flows = await listTaskFlows()
    return {
      success: true,
      count: flows.length,
      flows: flows.map(f => ({
        id: f.id, name: f.name, description: f.description.slice(0, 150), enabled: f.enabled,
        createdBy: f.createdBy, steps: f.steps.length,
        stepTypes: f.steps.map(s => `${s.type}:${s.title.slice(0, 40)}`),
        nextRunAt: f.nextRunAt?.toISOString() ?? null, lastRunAt: f.lastRunAt?.toISOString() ?? null,
      })),
    }
  }
  if (action === 'create_flow') {
    const { validateTaskFlowInput, createTaskFlow } = await import('@/lib/task-flows')
    const validated = validateTaskFlowInput({
      name: args.name,
      description: args.description,
      steps: args.steps,
      enabled: true,
      createdBy: `omega (${actor})`,
    })
    if (!validated.ok) {
      return { success: false, error: `Flow không hợp lệ: ${validated.error}`, hint: 'Flow cần ≥1 action; trigger (nếu có) phải là bước đầu tiên và duy nhất.' }
    }
    const flow = await createTaskFlow(validated.data)
    return {
      success: true,
      flowId: flow.id,
      name: flow.name,
      steps: flow.steps.length,
      nextRunAt: flow.nextRunAt?.toISOString() ?? null,
      message: `Đã tạo task flow "${flow.name}" (${flow.steps.length} bước) — thiết kế được/tinh chỉnh được trong Smolab > Automation.${flow.nextRunAt ? ` Trigger cron tự chạy từ ${flow.nextRunAt.toISOString()}.` : ''}`,
    }
  }
  if (action === 'update_flow') {
    const id = String(args.id ?? '')
    if (!id) return { success: false, error: 'update_flow cần {id}' }
    const { updateTaskFlow, validateTaskFlowInput } = await import('@/lib/task-flows')
    const patch: Record<string, unknown> = {}
    if (args.name !== undefined) patch.name = String(args.name)
    if (args.description !== undefined) patch.description = String(args.description)
    if (args.enabled !== undefined) patch.enabled = args.enabled === true
    if (args.steps !== undefined) {
      const validated = validateTaskFlowInput({ name: args.name ?? '(check)', description: args.description, steps: args.steps, enabled: args.enabled ?? true })
      if (!validated.ok) return { success: false, error: `Steps không hợp lệ: ${validated.error}` }
      patch.steps = validated.data.steps
    }
    const flow = await updateTaskFlow(id, patch as Parameters<typeof updateTaskFlow>[1])
    if (!flow) return { success: false, error: `Task flow ${id} không tồn tại` }
    return {
      success: true,
      flowId: id,
      name: flow.name,
      enabled: flow.enabled,
      nextRunAt: flow.nextRunAt?.toISOString() ?? null,
      message: `Đã cập nhật task flow "${flow.name}" (${Object.keys(patch).join(', ')}) — thay đổi có hiệu lực ngay.`,
    }
  }
  if (action === 'delete_flow') {
    const id = String(args.id ?? '')
    if (!id) return { success: false, error: 'delete_flow cần {id}' }
    const { deleteTaskFlow } = await import('@/lib/task-flows')
    const ok = await deleteTaskFlow(id)
    if (!ok) return { success: false, error: `Task flow ${id} không tồn tại` }
    return { success: true, flowId: id, message: 'Đã xóa task flow.' }
  }
  if (action === 'run_flow') {
    const id = String(args.id ?? '')
    if (!id) return { success: false, error: 'run_flow cần {id}' }
    const { runTaskFlow } = await import('@/lib/task-flows')
    const run = await runTaskFlow(id, { trigger: 'manual (Omega)' })
    return {
      success: run.success,
      flowId: id,
      flowName: run.flowName,
      stoppedAtCondition: run.stopReason ? { reason: run.stopReason } : null,
      steps: run.steps.map(s => ({ title: s.title, type: s.type, outcome: s.outcome, summary: s.summary.slice(0, 200) })),
      durationMs: run.durationMs,
      error: run.error ?? null,
      message: run.success
        ? `Flow "${run.flowName}" HOÀN TẤT (${run.steps.filter(s => s.outcome === 'executed').length}/${run.steps.length} bước chạy).`
        : run.stopReason
          ? `Flow dừng ở condition: ${run.stopReason}`
          : `Flow thất bại: ${run.error}`,
    }
  }

  return {
    success: false,
    error: `Action "${action}" không hợp lệ. Actions: create_cron | list_cron | toggle_cron | delete_cron | create_webhook | list_webhooks | delete_webhook | add_standing_order | list_standing_orders | delete_standing_order | list_flows | create_flow | update_flow | delete_flow | run_flow`,
  }
}

// ==================== INDIVIDUAL TOOL IMPLEMENTATIONS ====================

/**
 * OpenCode — Code operations (read, write, bash, mkdir)
 *
 * Uses the OpenCode API server (configured via OPENCODE_SERVER_URL env var) if available,
 * otherwise falls back to direct file system operations via the project API.
 */
async function executeOpenCode(args: Record<string, unknown>): Promise<unknown> {
  const action = args.action as string
  const path = args.path as string | undefined
  const content = args.content as string | undefined
  const command = args.command as string | undefined

  // Try OpenCode server first (for bash commands only — the server's /execute
  // endpoint accepts {command} and runs it in the workspace).
  // FIX (P2 bug): the original code posted to /api/execute but the Hono server
  // exposes /execute (no /api prefix). The 404 made this branch ALWAYS fail
  // silently and fall through to the local implementation. The fix below only
  // attempts the server for the bash action (which the server actually supports)
  // and uses the correct path.
  if (action === 'bash' && command) {
    try {
      const opencodeUrl = process.env.OPENCODE_SERVER_URL || 'http://localhost:18790'
      const res = await fetch(`${opencodeUrl}/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command }),
        signal: AbortSignal.timeout(30000),
      })
      if (res.ok) {
        const data = await res.json()
        return data
      }
    } catch (err) {
      // opencode-server not available / timeout — fall through to local exec
      console.warn(`[ToolExecutor] opencode-server ${action} failed (${err instanceof Error ? err.message : String(err)}) — falling back to local exec`)
    }
  }

  // Fallback: Use the project's own API for file operations
  switch (action) {
    case 'read': {
      // Route through Phase 2.1 `fileRead` to ensure consistent behavior
      // (line numbers, offset/limit, binary detection, repo-root guard).
      // Legacy `executeFileRead` is deprecated; this adapter reshapes the
      // new `fileRead` return value into the legacy {success,content?} shape
      // expected by historical callers of `opencode action='read'`.
      // See: docs/tool-smoke-tests.md file_read section for new tool shape.
      const result = await executeFileReadFn({
        path: path || '',
        offset: 1,
        limit: 2000,
        line_numbers: true,
      })
      if (typeof result === 'object' && result !== null && 'error' in result) {
        return { success: false, error: String((result as { error: unknown }).error) }
      }
      const r = result as { lines?: unknown[]; content?: string; truncated?: boolean; nextOffset?: number }
      // Prefer pre-rendered content if present; otherwise join lines.
      const out =
        typeof r.content === 'string'
          ? r.content
          : Array.isArray(r.lines)
            ? (r.lines as Array<{ content?: string }>).map((l) => l.content ?? '').join('\n')
            : ''
      const note = r.truncated ? `\n\n... [TRUNCATED — nextOffset=${r.nextOffset ?? 'n/a'}, call file_read with offset=${r.nextOffset ?? 'next'} to continue]` : ''
      return { success: true, content: out + note }
    }
    case 'write':
      return await executeFileWrite(path || '', content || '')
    case 'bash':
      return await executeBash(command || '')
    case 'mkdir':
      return { success: true, message: `mkdir not needed — write will create parent dirs` }
    default:
      return { success: false, error: `Unknown opencode action: ${action}` }
  }
}

/**
 * Read a file from the project directory.
 * Security: Only allows reading files within the project root.
 * Uses path.resolve + startsWith check to prevent path traversal.
 *
 * @deprecated Phase 2.1 — superseded by `fileRead()` in dev-tools.ts which
 * adds line numbers, offset/limit pagination, binary detection, and a
 * `nextOffset` cursor. The `opencode action='read'` switch above now routes
 * through `fileRead()` so all callers get the new behavior automatically.
 * This stub remains only as an explicit deprecation marker.
 */
async function executeFileRead(filePath: string): Promise<{ success: boolean; content?: string; error?: string }> {
  // Pass-through to the new tool — see opencode case 'read' above.
  const result = await executeFileReadFn({ path: filePath, offset: 1, limit: 2000, line_numbers: true })
  if (typeof result === 'object' && result !== null && 'error' in result) {
    return { success: false, error: String((result as { error: unknown }).error) }
  }
  const r = result as { content?: string; lines?: Array<{ content?: string }>; truncated?: boolean; nextOffset?: number }
  const out = typeof r.content === 'string' ? r.content : Array.isArray(r.lines) ? r.lines.map((l) => l.content ?? '').join('\n') : ''
  const note = r.truncated ? `\n\n... [TRUNCATED — use file_read with offset=${r.nextOffset ?? 'next'} to continue]` : ''
  return { success: true, content: out + note }
}

/**
 * Write a file to the project directory.
 * Security: Only allows writing within the project root. Uses path.resolve to prevent traversal.
 * Auto-creates parent directories.
 *
 * 21-d FIX cwd footgun: path resolve theo ACTIVE workspace root (pattern
 * workspace-root.ts — giống file_edit/file_write) thay vì process.cwd().
 * process.cwd() của Next.js dev = /home/z/tmo-app (thư mục app) → LLM dùng
 * path tương đối ("src/foo.ts") sẽ ghi nhầm vào source của app. Nếu workspace
 * root không xác định được → fallback cwd + ghi chú trong kết quả (giữ behavior
 * cũ).
 */
async function executeFileWrite(filePath: string, content: string): Promise<{ success: boolean; message: string; error?: string }> {
  if (!filePath) return { success: false, message: '', error: 'Path is required' }
  if (!content) return { success: false, message: '', error: 'Content is required' }

  try {
    const pathModule = await import('path')
    // 21-d: ưu tiên ACTIVE workspace root; fallback process.cwd() (behavior cũ)
    let projectRoot = process.cwd()
    let rootNote = ''
    try {
      projectRoot = await resolveWorkspaceRoot()
      if (!projectRoot || typeof projectRoot !== 'string') {
        projectRoot = process.cwd()
        rootNote = ' [note: workspace root không xác định được — fallback process.cwd()]'
      }
    } catch {
      projectRoot = process.cwd()
      rootNote = ' [note: workspace root không xác định được — fallback process.cwd()]'
    }
    const resolvedPath = pathModule.resolve(projectRoot, filePath)

    // Security: Prevent path traversal — resolved path must be within project root
    if (!resolvedPath.startsWith(projectRoot + pathModule.sep) && resolvedPath !== projectRoot) {
      return { success: false, message: '', error: 'Access denied: path escapes project root' }
    }

    const fs = await import('fs/promises')

    // Auto-create parent directories
    const dir = pathModule.dirname(resolvedPath)
    await fs.mkdir(dir, { recursive: true })

    // Write file
    await fs.writeFile(resolvedPath, content, 'utf-8')

    return { success: true, message: `File written: ${filePath} (${content.length} chars)${rootNote}` }
  } catch (err) {
    return {
      success: false,
      message: '',
      error: `Failed to write ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

/**
 * Execute a bash command (legacy v1 path — opencode action='bash').
 *
 * 2026-08-29 (user request): delegate toàn bộ sang v2 shell() trong dev-tools.ts
 * — KHÔNG còn command whitelist, KHÔNG chặn sudo/rm -rf /, KHÔNG chặn shell
 * metacharacters. cwd = workspace root (active), timeout 5min. Kết quả map về
 * shape legacy {success, output?, error?}.
 */
async function executeBash(command: string): Promise<{ success: boolean; output?: string; error?: string }> {
  if (!command) return { success: false, error: 'Command is required' }

  const receipt = await executeShellFn({ command }) as {
    success?: boolean
    exit_code?: number
    stdout?: string
    stderr?: string
    duration_ms?: number
  }
  const output = [receipt.stdout, receipt.stderr].filter(Boolean).join('\n').trim()
  return {
    success: receipt.success === true,
    output: output || undefined,
    error: receipt.success === true ? undefined : (receipt.stderr?.trim() || `exit_code=${receipt.exit_code ?? 'unknown'}`),
  }
}

/**
 * Knowledge Search — Semantic search in KB (Qdrant + Neo4j)
 * Uses knowledge-bridge which already handles embedding + search.
 */
async function executeKnowledgeSearch(args: Record<string, unknown>): Promise<unknown> {
  const query = args.query as string
  const topK = Math.min((args.topK as number) || 5, 20)

  if (!query) return { error: 'Query is required' }

  try {
    const { agentKnowledgeSearch } = await import('@/lib/knowledge-bridge')
    const result = await agentKnowledgeSearch(query, { topK })

    // BUG FIX 2026-09-06: truyền diagnostics (lý do 0 kết quả — Qdrant chết /
    // embedding lỗi / KB rỗng / không khớp) vào kết quả tool để AGENT báo đúng
    // nguyên nhân cho user thay vì chỉ "0 kết quả".
    return {
      results: result.results.slice(0, topK),
      answer: result.answer,
      totalFound: result.results.length,
      diagnostics: result.diagnostics,
    }
  } catch (err) {
    return { error: `Knowledge search failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}

/**
 * Knowledge Graph — Neo4j Cypher query (read-only)
 * Enforces read-only at client level BEFORE sending to knowledge-bridge.
 * Only MATCH, RETURN, WHERE, WITH, ORDER BY, LIMIT, SKIP, DISTINCT are allowed.
 */
async function executeKnowledgeGraph(args: Record<string, unknown>): Promise<unknown> {
  const query = args.query as string

  if (!query) return { error: 'Cypher query is required' }

  // Security: Enforce read-only at client level
  // Block any write/mutation Cypher keywords (case-insensitive)
  const writeKeywords = /\b(CREATE|DELETE|SET|MERGE|DROP|REMOVE|DETACH|CALL\s*\{.*\}\s*IN\s+TRANSACTION)\b/i
  if (writeKeywords.test(query)) {
    return { error: 'Only read-only Cypher queries (MATCH) are allowed. Write operations (CREATE, DELETE, SET, MERGE, DROP, REMOVE) are forbidden.' }
  }

  try {
    const { agentGraphQuery } = await import('@/lib/knowledge-bridge')
    const result = await agentGraphQuery(query)

    return {
      records: result.records,
      count: result.count,
      error: result.error,
    }
  } catch (err) {
    return { error: `Graph query failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}

/**
 * Knowledge Write — Write entity/relationship to KB
 * Uses knowledge-bridge which writes to SQLite buffer (syncs to Neo4j later).
 * Only G3 (CATALYST) has this permission.
 */
async function executeKnowledgeWrite(args: Record<string, unknown>): Promise<unknown> {
  const entityName = args.entityName as string
  const entityType = args.entityType as string
  const description = args.description as string
  const category = args.category as string
  const relationshipType = args.relationshipType as string | undefined
  const targetEntityName = args.targetEntityName as string | undefined

  if (!entityName || !entityType || !description || !category) {
    return { error: 'entityName, entityType, description, and category are required' }
  }

  try {
    const { agentWriteEntity, agentWriteRelationship } = await import('@/lib/knowledge-bridge')

    // Write entity
    const entity = await agentWriteEntity({
      entityName,
      entityType,
      description,
      domain: category,
    })

    // Write relationship if specified
    let relationship: { id: string; type: string } | null = null
    if (relationshipType && targetEntityName) {
      const rel = await agentWriteRelationship({
        sourceEntityName: entityName,
        targetEntityName,
        relationshipType,
        description: `${entityName} ${relationshipType} ${targetEntityName}`,
      })
      relationship = { id: rel.id, type: rel.type }
    }

    return {
      entity: { id: entity.id, name: entity.entityName },
      relationship,
      message: `Đã ghi entity "${entityName}" vào KB${relationship ? ` + relationship "${relationshipType}" → ${targetEntityName}` : ''}`,
    }
  } catch (err) {
    return { error: `Knowledge write failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}

// ==================== KEY RETRY HELPER ====================

/**
 * Retry a service call with the next available key from the pool.
 * Called when the first key fails — tries remaining keys before falling back to SDK.
 *
 * @param service - 'tavily' | 'serper' | 'jina'
 * @param param - The query (for search) or URL (for reader)
 * @returns Result if a key succeeds, null if all keys fail
 */
async function retryWithNextKey(
  service: 'tavily' | 'serper' | 'jina',
  param: string
): Promise<unknown | null> {
  const pool = service === 'tavily' ? tavilyKeyPool : service === 'serper' ? serperKeyPool : jinaKeyPool
  const maxRetries = pool.getTotalCount() - 1 // Already tried 1 key

  for (let i = 0; i < maxRetries; i++) {
    const nextKey = pool.getNextKey()
    if (!nextKey || nextKey.isLastResort) break // No more healthy keys

    console.log(`[ToolExecutor] ${service} retrying with key ${nextKey.index + 1}...`)

    try {
      let res: Response

      if (service === 'tavily') {
        res = await fetch('https://api.tavily.com/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            api_key: nextKey.key,
            query: param,
            search_depth: 'advanced',
            include_answer: true,
            max_results: 5,
          }),
          signal: AbortSignal.timeout(30000),
        })
      } else if (service === 'serper') {
        res = await fetch('https://google.serper.dev/search', {
          method: 'POST',
          headers: {
            'X-API-KEY': nextKey.key,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ q: param, num: 5 }),
          signal: AbortSignal.timeout(15000),
        })
      } else {
        // Jina
        const headers: Record<string, string> = { 'Accept': 'text/plain' }
        if (nextKey.key) headers['Authorization'] = `Bearer ${nextKey.key}`
        res = await fetch(`https://r.jina.ai/${param}`, {
          method: 'GET',
          headers,
          signal: AbortSignal.timeout(30000),
        })
      }

      if (res.ok) {
        pool.reportResult(nextKey.index, true, res.status)
        console.log(`[ToolExecutor] ${service} key ${nextKey.index + 1} succeeded on retry`)

        if (service === 'tavily') {
          const data = await res.json()
          return {
            answer: data.answer,
            results: (data.results || []).map((r: Record<string, unknown>) => ({
              title: r.title, url: r.url, content: r.content, score: r.score,
            })),
            source: `tavily-key${nextKey.index + 1}`,
          }
        } else if (service === 'serper') {
          const data = await res.json()
          return {
            organic: (data.organic || []).map((r: Record<string, unknown>) => ({
              title: r.title, link: r.link, snippet: r.snippet,
            })),
            knowledgeGraph: data.knowledgeGraph || null,
            source: `serper-key${nextKey.index + 1}`,
          }
        } else {
          // Jina
          const text = await res.text()
          const maxChars = 30000
          const truncated = text.length > maxChars
          const content = truncated ? text.slice(0, maxChars) + '\n\n... [TRUNCATED — page too long]' : text
          return {
            url: param, content, length: text.length, truncated,
            source: `jina-key${nextKey.index + 1}`,
          }
        }
      }

      // This key also failed — report and try next
      const errorBody = await res.text().catch(() => '')
      pool.reportResult(nextKey.index, false, res.status, `HTTP ${res.status}: ${errorBody.slice(0, 200)}`)
      console.warn(`[ToolExecutor] ${service} key ${nextKey.index + 1} also failed: ${res.status}`)
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      pool.reportResult(nextKey.index, false, undefined, errMsg)
      console.warn(`[ToolExecutor] ${service} key ${nextKey.index + 1} exception: ${errMsg}`)
    }
  }

  return null // All keys failed
}

/**
 * Tavily — AI-optimized web search
 * Uses ServiceKeyPool for multi-key rotation with automatic fallback.
 * Primary: Direct Tavily API with rotating keys from pool
 * Fallback: z-ai-web-dev-sdk web_search function (Clawhub Market skill)
 */
async function executeTavily(args: Record<string, unknown>): Promise<unknown> {
  const query = args.query as string
  if (!query) return { error: 'Query is required' }

  // Primary: Direct Tavily API with key pool rotation
  if (tavilyKeyPool.hasKeys()) {
    const keySelection = tavilyKeyPool.getNextKey()
    if (keySelection) {
      try {
        const res = await fetch('https://api.tavily.com/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            api_key: keySelection.key,
            query,
            search_depth: 'advanced',
            include_answer: true,
            max_results: 5,
          }),
          signal: AbortSignal.timeout(30000),
        })

        if (res.ok) {
          tavilyKeyPool.reportResult(keySelection.index, true, res.status)
          const data = await res.json()
          return {
            answer: data.answer,
            results: (data.results || []).map((r: Record<string, unknown>) => ({
              title: r.title,
              url: r.url,
              content: r.content,
              score: r.score,
            })),
            source: `tavily-key${keySelection.index + 1}`,
          }
        }

        // API returned error status — report to pool and try next key
        const errorBody = await res.text().catch(() => '')
        tavilyKeyPool.reportResult(keySelection.index, false, res.status, `HTTP ${res.status}: ${errorBody.slice(0, 200)}`)
        console.warn(`[ToolExecutor] Tavily key ${keySelection.index + 1} error: ${res.status}`)

        // Try remaining keys before falling back to SDK
        const retryResult = await retryWithNextKey('tavily', query)
        if (retryResult) return retryResult
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        tavilyKeyPool.reportResult(keySelection.index, false, undefined, errMsg)
        console.warn(`[ToolExecutor] Tavily key ${keySelection.index + 1} failed: ${errMsg}`)

        // Try remaining keys before falling back to SDK
        const retryResult = await retryWithNextKey('tavily', query)
        if (retryResult) return retryResult
      }
    }
  }

  // Fallback: z-ai-web-dev-sdk web_search
  try {
    const zai = await getZAI()
    if (zai) {
      const results = await withTimeout(
        zai.functions.invoke('web_search', { query, num: 5 }),
        30_000,
        'z-ai-sdk web_search (tavily fallback)',
      )
      if (Array.isArray(results) && results.length > 0) {
        return {
          answer: null,
          results: results.map((r: any) => ({
            title: r.name || r.title,
            url: r.url,
            content: r.snippet || r.content,
            score: r.rank || null,
          })),
          source: 'z-ai-sdk-web_search',
        }
      }
    }
  } catch (err) {
    console.warn(`[ToolExecutor] z-ai-sdk web_search fallback failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  return {
    error: 'Tavily search failed and no fallback available.',
    hint: !tavilyKeyPool.hasKeys() ? 'Add TAVILY_API_KEY_1..4 to .env' : `All ${tavilyKeyPool.getTotalCount()} keys failed (${tavilyKeyPool.getAvailableCount()} available)`,
    poolStatus: tavilyKeyPool.getSummary(),
  }
}

/**
 * Serper — Google Search API
 * Uses ServiceKeyPool for multi-key rotation with automatic fallback.
 * Primary: Direct Serper API with rotating keys from pool
 * Fallback: z-ai-web-dev-sdk web_search function (Clawhub Market skill)
 */
async function executeSerper(args: Record<string, unknown>): Promise<unknown> {
  const query = args.query as string
  if (!query) return { error: 'Query is required' }

  // Primary: Direct Serper API with key pool rotation
  if (serperKeyPool.hasKeys()) {
    const keySelection = serperKeyPool.getNextKey()
    if (keySelection) {
      try {
        const res = await fetch('https://google.serper.dev/search', {
          method: 'POST',
          headers: {
            'X-API-KEY': keySelection.key,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            q: query,
            num: 5,
          }),
          signal: AbortSignal.timeout(15000),
        })

        if (res.ok) {
          serperKeyPool.reportResult(keySelection.index, true, res.status)
          const data = await res.json()
          return {
            organic: (data.organic || []).map((r: Record<string, unknown>) => ({
              title: r.title,
              link: r.link,
              snippet: r.snippet,
            })),
            knowledgeGraph: data.knowledgeGraph || null,
            source: `serper-key${keySelection.index + 1}`,
          }
        }

        // API returned error status — report to pool and try next key
        const errorBody = await res.text().catch(() => '')
        serperKeyPool.reportResult(keySelection.index, false, res.status, `HTTP ${res.status}: ${errorBody.slice(0, 200)}`)
        console.warn(`[ToolExecutor] Serper key ${keySelection.index + 1} error: ${res.status}`)

        // Try remaining keys before falling back to SDK
        const retryResult = await retryWithNextKey('serper', query)
        if (retryResult) return retryResult
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        serperKeyPool.reportResult(keySelection.index, false, undefined, errMsg)
        console.warn(`[ToolExecutor] Serper key ${keySelection.index + 1} failed: ${errMsg}`)

        // Try remaining keys before falling back to SDK
        const retryResult = await retryWithNextKey('serper', query)
        if (retryResult) return retryResult
      }
    }
  }

  // Fallback: z-ai-web-dev-sdk web_search
  try {
    const zai = await getZAI()
    if (zai) {
      const results = await withTimeout(
        zai.functions.invoke('web_search', { query, num: 5 }),
        30_000,
        'z-ai-sdk web_search (serper fallback)',
      )
      if (Array.isArray(results) && results.length > 0) {
        return {
          organic: results.map((r: any) => ({
            title: r.name || r.title,
            link: r.url,
            snippet: r.snippet || '',
          })),
          knowledgeGraph: null,
          source: 'z-ai-sdk-web_search',
        }
      }
    }
  } catch (err) {
    console.warn(`[ToolExecutor] z-ai-sdk web_search fallback failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  return {
    error: 'Serper search failed and no fallback available.',
    hint: !serperKeyPool.hasKeys() ? 'Add SERPER_API_KEY_1..4 to .env' : `All ${serperKeyPool.getTotalCount()} keys failed (${serperKeyPool.getAvailableCount()} available)`,
    poolStatus: serperKeyPool.getSummary(),
  }
}

/**
 * Jina — Web page reader
 * Uses ServiceKeyPool for multi-key rotation with automatic fallback.
 * Primary: Direct Jina API with rotating keys from pool
 * Fallback: z-ai-web-dev-sdk page_reader function (Clawhub Market skill)
 */
async function executeJina(args: Record<string, unknown>): Promise<unknown> {
  const url = args.url as string
  if (!url) return { error: 'URL is required' }

  // Validate URL
  try {
    new URL(url)
  } catch {
    return { error: `Invalid URL: ${url}` }
  }

  // Primary: Direct Jina API with key pool rotation
  if (jinaKeyPool.hasKeys()) {
    const keySelection = jinaKeyPool.getNextKey()
    if (keySelection) {
      try {
        const headers: Record<string, string> = {
          'Accept': 'text/plain',
        }
        if (keySelection.key) {
          headers['Authorization'] = `Bearer ${keySelection.key}`
        }

        const res = await fetch(`https://r.jina.ai/${url}`, {
          method: 'GET',
          headers,
          signal: AbortSignal.timeout(30000),
        })

        if (res.ok) {
          jinaKeyPool.reportResult(keySelection.index, true, res.status)
          const text = await res.text()

          // Limit output to prevent overwhelming LLM context
          const maxChars = 30000
          const truncated = text.length > maxChars
          const content = truncated ? text.slice(0, maxChars) + '\n\n... [TRUNCATED — page too long]' : text

          return {
            url,
            content,
            length: text.length,
            truncated,
            source: `jina-key${keySelection.index + 1}`,
          }
        }

        // API returned error status — report to pool and try next key
        const errorBody = await res.text().catch(() => '')
        jinaKeyPool.reportResult(keySelection.index, false, res.status, `HTTP ${res.status}: ${errorBody.slice(0, 200)}`)
        console.warn(`[ToolExecutor] Jina key ${keySelection.index + 1} error: ${res.status}`)

        // Try remaining keys before falling back to SDK
        const retryResult = await retryWithNextKey('jina', url)
        if (retryResult) return retryResult
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        jinaKeyPool.reportResult(keySelection.index, false, undefined, errMsg)
        console.warn(`[ToolExecutor] Jina key ${keySelection.index + 1} failed: ${errMsg}`)

        // Try remaining keys before falling back to SDK
        const retryResult = await retryWithNextKey('jina', url)
        if (retryResult) return retryResult
      }
    }
  }

  // Fallback: z-ai-web-dev-sdk page_reader
  try {
    const zai = await getZAI()
    if (zai) {
      const result = await withTimeout<ZaiPageReaderResult>(
        zai.functions.invoke('page_reader', { url }),
        30_000,
        'z-ai-sdk page_reader (jina fallback)',
      )
      if (result?.data?.html) {
        // Convert HTML to clean text
        const text = result.data.html
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]*>/g, ' ')
          .replace(/&nbsp;/g, ' ')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/\s+/g, ' ')
          .trim()

        const maxChars = 30000
        const truncated = text.length > maxChars
        const content = truncated ? text.slice(0, maxChars) + '\n\n... [TRUNCATED — page too long]' : text

        return {
          url,
          title: result.data.title || null,
          content,
          length: text.length,
          truncated,
          source: 'z-ai-sdk-page_reader',
        }
      }
    }
  } catch (err) {
    console.warn(`[ToolExecutor] z-ai-sdk page_reader fallback failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  return {
    error: 'Jina reader failed and no fallback available.',
    hint: !jinaKeyPool.hasKeys() ? 'Add JINA_API_KEY_1..2 to .env' : `All ${jinaKeyPool.getTotalCount()} keys failed (${jinaKeyPool.getAvailableCount()} available)`,
    poolStatus: jinaKeyPool.getSummary(),
  }
}

// ==================== v2.1 Phase 1b.1: UNIFIED WEB (consolidate tavily/serper/jina) ====================

/**
 * web_search — Unified web search interface (Claude Code / Z.ai Code parity).
 *
 * Routing strategy (best-available provider):
 *   1. Tavily (when TAVILY_API_KEY_* configured) — AI-optimized, returns answer + content
 *   2. Serper (when SERPER_API_KEY_* configured) — Google SERP, returns organic + KG
 *   3. z-ai-web-dev-sdk web_search fallback (sandbox only)
 *
 * Output is normalized to a stable schema:
 *   { query, results: [{title, url, snippet, score?}], source, total }
 *
 * Feature flag: ENABLE_WEB_UNIFIED (off by default per D11).
 * Old `tavily`/`serper` tools remain callable without the flag for backward compat.
 */
async function executeWebSearch(args: Record<string, unknown>): Promise<unknown> {
  const query = args.query as string
  if (!query) return { error: 'query is required' }

  const maxResults = Math.min(Math.max(Number(args.max_results) || 5, 1), 20)
  const depth = args.depth === 'advanced' ? 'advanced' : 'basic'

  // Strategy 1: Tavily (preferred — has answer + content snippets)
  if (tavilyKeyPool.hasKeys()) {
    const tavilyResult = await executeTavily({ query, search_depth: depth })
    if (tavilyResult && typeof tavilyResult === 'object' && 'results' in tavilyResult) {
      const tr = tavilyResult as { results?: Array<Record<string, unknown>>; answer?: string | null; source?: string }
      return {
        query,
        source: tr.source || 'tavily',
        answer: tr.answer || null,
        total: tr.results?.length || 0,
        results: (tr.results || []).slice(0, maxResults).map(r => ({
          title: r.title,
          url: r.url,
          snippet: r.content || r.snippet || '',
          score: r.score ?? null,
        })),
      }
    }
  }

  // Strategy 2: Serper (Google SERP)
  if (serperKeyPool.hasKeys()) {
    const serperResult = await executeSerper({ query, num: maxResults })
    if (serperResult && typeof serperResult === 'object' && 'organic' in serperResult) {
      const sr = serperResult as { organic?: Array<Record<string, unknown>>; knowledgeGraph?: unknown; source?: string }
      return {
        query,
        source: sr.source || 'serper',
        knowledgeGraph: sr.knowledgeGraph || null,
        total: sr.organic?.length || 0,
        results: (sr.organic || []).slice(0, maxResults).map(r => ({
          title: r.title,
          url: r.link,
          snippet: r.snippet || '',
          score: null,
        })),
      }
    }
  }

  // Strategy 3: z-ai-sdk web_search (sandbox fallback) — invoke directly to skip
  // the tavilyKeyPool.hasKeys() gate that executeTavily already failed above.
  try {
    const zai = await getZAI()
    if (zai) {
      const results = await withTimeout(
        zai.functions.invoke('web_search', { query, num: maxResults }),
        30_000,
        'z-ai-sdk web_search (unified)',
      )
      if (Array.isArray(results) && results.length > 0) {
        return {
          query,
          source: 'z-ai-sdk-web_search',
          total: results.length,
          results: results.map((r: any) => ({
            title: r.name || r.title,
            url: r.url,
            snippet: r.snippet || r.content || '',
            score: r.rank ?? null,
          })),
        }
      }
    }
  } catch (err) {
    console.warn(`[ToolExecutor] web_search z-ai-sdk fallback failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  return {
    query,
    error: 'All web search providers failed (no tavily/serper keys configured + z-ai-sdk unavailable).',
    hint: 'Set TAVILY_API_KEY_1..4 or SERPER_API_KEY_1..4 in .env, or run inside z.ai sandbox for SDK fallback.',
    tavilyKeys: tavilyKeyPool.getAvailableCount(),
    serperKeys: serperKeyPool.getAvailableCount(),
  }
}

/**
 * web_fetch — Unified web page reader (Claude Code / Z.ai Code parity).
 *
 * Routing strategy:
 *   1. Jina (r.jina.ai) when JINA_API_KEY_* configured — clean text/markdown
 *   2. z-ai-sdk page_reader fallback (sandbox only)
 *
 * Output normalized to:
 *   { url, title, content, length, truncated, source }
 *
 * Feature flag: ENABLE_WEB_UNIFIED (off by default per D11).
 * Old `jina` tool remains callable without the flag for backward compat.
 */
async function executeWebFetch(args: Record<string, unknown>): Promise<unknown> {
  const url = args.url as string
  if (!url) return { error: 'url is required' }

  // Validate URL
  try {
    new URL(url)
  } catch {
    return { error: `Invalid URL: ${url}` }
  }

  const format = args.format === 'html' ? 'html' : args.format === 'markdown' ? 'markdown' : 'text'

  // Strategy 1: Jina (preferred — returns clean text by default)
  if (jinaKeyPool.hasKeys()) {
    const jinaResult = await executeJina({ url })
    if (jinaResult && typeof jinaResult === 'object' && 'content' in jinaResult) {
      const jr = jinaResult as { content?: string; length?: number; truncated?: boolean; source?: string }
      // Jina always returns text; for html/markdown format, return as-is (consumer can convert)
      return {
        url,
        title: null, // Jina text mode doesn't return title
        content: jr.content || '',
        length: jr.length || 0,
        truncated: jr.truncated || false,
        format,
        source: jr.source || 'jina',
      }
    }
  }

  // Strategy 2: z-ai-sdk page_reader (returns title + html; we convert to text)
  try {
    const zai = await getZAI()
    if (zai) {
      const result = await withTimeout<ZaiPageReaderResult>(
        zai.functions.invoke('page_reader', { url }),
        30_000,
        'z-ai-sdk page_reader (unified web_fetch)',
      )
      if (result?.data?.html) {
        let text = result.data.html
        if (format === 'text' || format === 'markdown') {
          // Strip tags for text/markdown output
          text = text
            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]*>/g, ' ')
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/\s+/g, ' ')
            .trim()
        }
        const maxChars = 30000
        const truncated = text.length > maxChars
        const content = truncated ? text.slice(0, maxChars) + '\n\n... [TRUNCATED — page too long]' : text
        return {
          url,
          title: result.data.title || null,
          content,
          length: text.length,
          truncated,
          format,
          source: 'z-ai-sdk-page_reader',
        }
      }
    }
  } catch (err) {
    console.warn(`[ToolExecutor] web_fetch z-ai-sdk fallback failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  return {
    url,
    error: 'All web fetch providers failed (no jina keys + z-ai-sdk unavailable).',
    hint: 'Set JINA_API_KEY_1..2 in .env, or run inside z.ai sandbox for SDK fallback.',
    jinaKeys: jinaKeyPool.getAvailableCount(),
  }
}

// ==================== v2.1 Phase 1b.2: P0 GATEWAY TOOLS (first-class wrappers) ====================

/**
 * P0 Gateway tools — thin first-class wrappers around gatewayTool() proxy.
 *
 * Each maps a clean tool name → gateway-bridge tool name:
 *   gateway_exec       → 'exec'
 *   gateway_read       → 'read'
 *   gateway_write      → 'write'
 *   gateway_edit       → 'edit'
 *   gateway_apply_patch → 'apply_patch'
 *
 * Rationale: giving these 5 P0 tools first-class schemas (vs. generic gateway_tool)
 * lets the LLM emit structured calls directly with proper parameters, instead of
 * wrapping args inside another {name, args} object. Cleaner reasoning + fewer
 * JSON parse failures.
 *
 * Feature flag: ENABLE_GATEWAY_TOOLS=phase-1b (off by default per D11).
 * The generic gateway_tool proxy remains available without the flag.
 */
const P0_GATEWAY_TOOL_MAP: Record<string, string> = {
  gateway_exec: 'exec',
  gateway_read: 'read',
  gateway_write: 'write',
  gateway_edit: 'edit',
  gateway_apply_patch: 'apply_patch',
}

async function executeP0GatewayTool(
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const gwName = P0_GATEWAY_TOOL_MAP[toolName]
  if (!gwName) {
    return { success: false, error: `Not a P0 gateway tool: ${toolName}` }
  }

  // Map first-class args → gateway-bridge args (which vary per tool)
  const gwArgs: Record<string, unknown> = {}
  if (toolName === 'gateway_exec') {
    if (args.command) gwArgs.command = args.command
    if (args.cwd) gwArgs.cwd = args.cwd
  } else if (toolName === 'gateway_read') {
    if (args.path) gwArgs.path = args.path
  } else if (toolName === 'gateway_write') {
    if (args.path) gwArgs.path = args.path
    if (args.content) gwArgs.content = args.content
  } else if (toolName === 'gateway_edit') {
    if (args.path) gwArgs.path = args.path
    if (args.old) gwArgs.old = args.old
    if (args.new) gwArgs.new = args.new
  } else if (toolName === 'gateway_apply_patch') {
    if (args.path) gwArgs.path = args.path
    if (args.patch) gwArgs.patch = args.patch
  }

  // Delegate to the existing gatewayTool proxy (which hits gateway-bridge:18791)
  return gatewayTool({ name: gwName, args: gwArgs })
}

// ==================== SKILL STATUS CHECK ====================

/**
 * Check which skills are available based on environment configuration.
 * Used by the test endpoint and diagnostics.
 *
 * Skills are available if:
 *   - Direct API key is set in .env (primary method)
 *   - z-ai-web-dev-sdk is initialized (fallback method)
 */
export interface SkillStatus {
  skill: string
  directKey: boolean      // At least one API key available in pool
  totalKeys: number       // Total keys in pool
  availableKeys: number   // Keys not in cooldown/disabled
  zaiFallback: boolean | null  // null = not yet checked, true/false = checked
  available: boolean      // true if either direct key or z-ai fallback works
  keyHint: string         // Hint about which env var to set
  poolSummary?: string    // Key pool status summary
}

export function getSkillStatus(): SkillStatus[] {
  return [
    {
      skill: 'tavily',
      directKey: tavilyKeyPool.hasKeys(),
      totalKeys: tavilyKeyPool.getTotalCount(),
      availableKeys: tavilyKeyPool.getAvailableCount(),
      zaiFallback: zaiAvailable,
      available: tavilyKeyPool.getAvailableCount() > 0 || zaiAvailable === true,
      keyHint: 'TAVILY_API_KEY_1..4',
      poolSummary: tavilyKeyPool.getSummary(),
    },
    {
      skill: 'serper',
      directKey: serperKeyPool.hasKeys(),
      totalKeys: serperKeyPool.getTotalCount(),
      availableKeys: serperKeyPool.getAvailableCount(),
      zaiFallback: zaiAvailable,
      available: serperKeyPool.getAvailableCount() > 0 || zaiAvailable === true,
      keyHint: 'SERPER_API_KEY_1..4',
      poolSummary: serperKeyPool.getSummary(),
    },
    {
      skill: 'jina',
      directKey: jinaKeyPool.hasKeys(),
      totalKeys: jinaKeyPool.getTotalCount(),
      availableKeys: jinaKeyPool.getAvailableCount(),
      zaiFallback: zaiAvailable,
      available: jinaKeyPool.getAvailableCount() > 0 || zaiAvailable === true,
      keyHint: 'JINA_API_KEY_1..2',
      poolSummary: jinaKeyPool.getSummary(),
    },
  ]
}

/**
 * Check if z-ai-web-dev-sdk has been initialized and is available.
 * Returns null if not yet checked, true/false otherwise.
 */
export function getZaiAvailable(): boolean | null {
  return zaiAvailable
}

// ==================== REACT LOOP HELPER ====================

/**
 * Process a single LLM response — check for tool_calls and execute them.
 * Returns array of tool execution results for feeding back to LLM.
 *
 * This is the core of the ReAct loop:
 * 1. LLM returns response with tool_calls
 * 2. We execute each tool_call
 * 3. Results are fed back as tool messages
 * 4. LLM generates next response (may have more tool_calls or final text)
 */
export async function processToolCalls(
  toolCalls: Array<{ id: string; function: { name: string; arguments: string } }>,
): Promise<Array<{ toolCallId: string; toolName: string; result: ToolExecutionResult }>> {
  const results: Array<{ toolCallId: string; toolName: string; result: ToolExecutionResult }> = []

  for (const tc of toolCalls) {
    let args: Record<string, unknown> = {}
    let parseError: string | null = null
    try {
      args = JSON.parse(tc.function.arguments)
    } catch (err) {
      parseError = err instanceof Error ? err.message : String(err)
      console.warn(`[ToolExecutor] tool_call ${tc.function.name} args JSON.parse failed — ${parseError}. Raw (first 200 chars): ${tc.function.arguments.slice(0, 200)}`)
    }

    // If parse failed, return a direct error result for THIS tool_call
    // instead of passing `_parseError` to executeTool (which would just say "Unknown tool").
    // The LLM sees the parse failure as a tool result and can recover on the next turn.
    // NOTE: ToolExecutionResult interface uses `result: unknown` (string for errors),
    // matching the existing executeTool pattern — there is no separate `error` field.
    if (parseError) {
      results.push({
        toolCallId: tc.id,
        toolName: tc.function.name,
        result: {
          success: false,
          result: `arguments JSON.parse failed: ${parseError}. Raw arguments (first 500 chars): ${tc.function.arguments.slice(0, 500)}`,
          duration: 0,
        },
      })
      continue
    }

    console.log(`[ToolExecutor] Executing: ${tc.function.name}(${JSON.stringify(args).slice(0, 200)})`)

    const result = await executeTool(tc.function.name, args)

    results.push({
      toolCallId: tc.id,
      toolName: tc.function.name,
      result,
    })

    console.log(`[ToolExecutor] Result: ${tc.function.name} → ${result.success ? 'OK' : 'FAIL'} (${result.duration}ms)`)
  }

  return results
}

/**
 * Format tool results into messages for the LLM.
 * Each tool result becomes a "tool" role message.
 * Note: Duration is excluded from LLM messages to save tokens — LLM doesn't need timing info.
 */
export function formatToolResultsAsMessages(
  results: Array<{ toolCallId: string; toolName: string; result: ToolExecutionResult }>,
): Array<{ role: 'tool'; tool_call_id: string; content: string }> {
  return results.map(r => ({
    role: 'tool' as const,
    tool_call_id: r.toolCallId,
    content: JSON.stringify({
      tool: r.toolName,
      success: r.result.success,
      result: r.result.result,
    }),
  }))
}
