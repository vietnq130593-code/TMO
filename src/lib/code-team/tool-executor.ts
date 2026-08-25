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
import {
  fileEdit, fileDelete, fileList, grep,
  runTests, gitCommit,
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
} from './dev-tools'
// v2.1 Phase 3.6 — MCP bridge (separate module)
import { mcpCall as executeMcpCallFn } from '@/lib/mcp/mcp-bridge'
import { isFlagEnabled, flagMode } from '@/lib/feature-flags'
// Phase 6 (rebuild) — start_preview/stop_preview operate on the USER's ACTIVE workspace
import { getActiveWorkspaceRoot } from '@/lib/workspace/workspace-manager'
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
      required: string[]
    }
  }
}

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
  // 3.6 — MCP bridge call (stub: 4 built-in servers with mock impl).
  mcp_call: {
    type: 'function',
    function: {
      name: 'mcp_call',
      description: 'Gọi tool trên MCP server (filesystem/github/postgres/puppeteer + discovered từ env MCP_SERVERS hoặc ~/.config/mcp/servers.json). First-use permission prompt (D10): trả requiresPermission=true lần đầu, agent phải gọi /api/openclaw/permissions grant. Phase 3 stub — mock impl, real subprocess deferred Phase 5.',
      parameters: {
        type: 'object',
        properties: {
          server: { type: 'string', description: 'MCP server ID (filesystem/github/postgres/puppeteer/...)' },
          tool: { type: 'string', description: 'Tool name trên server (vd create_pr, read_file, query...)' },
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
      description: 'Sandboxed bash với timeout 5min (max 10min) + working-dir lock. Cho phép metacharacters (|, &&, ;, >). Refuse sudo/rm -rf //fork bomb/dd of=/dev//mkfs. Trả về D2 structured receipt {success, exit_code, stdout, stderr, duration_ms, truncated, cursor, cwd}. Thay thế 5 v1 tools (install_package, read_logs, lint, type_check, db_query).',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command. Ví dụ: "bun add bcrypt", "bun run lint", "tsc --noEmit", "git status"' },
          cwd: { type: 'string', description: 'Working directory relative to OPENCODE_WORKSPACE (default: workspace root)' },
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
 * @returns Execution result with success status
 */
export async function executeTool(
  toolName: string,
  args: Record<string, unknown>
): Promise<ToolExecutionResult> {
  const startTime = Date.now()

  try {
    let result: unknown

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
      // 3.6 mcp_call — MCP bridge (filesystem/github/postgres/puppeteer + discovered)
      case 'mcp_call': {
        if (!isFlagEnabled('ENABLE_MCP_CALL')) {
          return {
            success: false,
            result: 'mcp_call tool is disabled (set ENABLE_MCP_CALL=true in .env to enable). See docs/FULLSTACK_CAPABILITY_PLAN_V2.md Phase 3.6.',
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
              'x-tmo-api-token': process.env.TMO_API_TOKEN || '',
            },
            body: JSON.stringify({
              root: previewRoot,
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
              'x-tmo-api-token': process.env.TMO_API_TOKEN || '',
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
      default:
        return {
          success: false,
          result: `Unknown tool: ${toolName}`,
          duration: Date.now() - startTime,
        }
    }

    return {
      success: true,
      result,
      duration: Date.now() - startTime,
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    console.error(`[ToolExecutor] Error executing ${toolName}:`, errorMsg)
    return {
      success: false,
      result: `Tool error: ${errorMsg}`,
      duration: Date.now() - startTime,
    }
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
 */
async function executeFileWrite(filePath: string, content: string): Promise<{ success: boolean; message: string; error?: string }> {
  if (!filePath) return { success: false, message: '', error: 'Path is required' }
  if (!content) return { success: false, message: '', error: 'Content is required' }

  try {
    const pathModule = await import('path')
    const projectRoot = process.cwd()
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

    return { success: true, message: `File written: ${filePath} (${content.length} chars)` }
  } catch (err) {
    return {
      success: false,
      message: '',
      error: `Failed to write ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

/**
 * Execute a bash command safely.
 * Security: Only allows pre-approved commands.
 */
async function executeBash(command: string): Promise<{ success: boolean; output?: string; error?: string }> {
  if (!command) return { success: false, error: 'Command is required' }

  // Security: Whitelist of allowed commands
  // NOTE: 'node' is excluded because `node -e "..."` can execute arbitrary code.
  //       'cat'/'head'/'tail'/'grep' are excluded — use opencode read instead.
  //       'npx'/'bunx' are excluded — can download+execute arbitrary npm packages.
  const allowedPrefixes = [
    'npm run',
    'npm test',
    'npm lint',
    'bun run',
    'bun test',
    'bun lint',
    'tsc',
    'eslint',
    'prettier',
    'echo',
    'ls',
    'wc',
    'rg',       // ripgrep — search only
    'which',
    'pwd',
    'prisma',
    'git status',
    'git diff',
    'git log',
  ]

  // Block dangerous flags that could allow code execution or file access
  const dangerousFlags = ['-e ', '--eval ', '-r ', '--require ', '-p ', '--print ']
  const normalizedCmd = command.trim()
  const isAllowed = allowedPrefixes.some(prefix => normalizedCmd.startsWith(prefix))
  const usesDangerousFlag = dangerousFlags.some(flag => normalizedCmd.includes(flag))

  // Security: Block shell metacharacters that enable command chaining/injection
  // These allow bypassing the whitelist by chaining additional commands:
  //   "npm run build; rm -rf /"   →  ;  chains commands
  //   "git status && cat /etc/p"  →  && chains on success
  //   "echo hi | bash"            →  |  pipes output
  //   "tsc || rm -rf /"           →  || chains on failure
  //   "echo $(cat /etc/passwd)"   →  $() command substitution
  //   "echo `cat /etc/passwd`"    →  backtick command substitution
  //   "echo hi > /etc/passwd"     →  >  redirect write
  //   "echo hi >> /etc/passwd"    →  >> redirect append
  const shellMetacharacters = /(;|&&|\|\||\||`|\$\(|\$\{|>|>>)/
  const usesShellMetacharacters = shellMetacharacters.test(normalizedCmd)

  if (!isAllowed || usesDangerousFlag || usesShellMetacharacters) {
    return {
      success: false,
      error: `Command not allowed: "${normalizedCmd.slice(0, 100)}". ${!isAllowed ? 'Prefix not in whitelist.' : ''} ${usesDangerousFlag ? 'Dangerous flag detected.' : ''} ${usesShellMetacharacters ? 'Shell metacharacter (;, &&, ||, |, `, $(), >, >>) detected — command chaining is forbidden.' : ''}`,
    }
  }

  try {
    const { exec } = await import('child_process')
    const { promisify } = await import('util')
    const execAsync = promisify(exec)

    const { stdout, stderr } = await execAsync(normalizedCmd, {
      cwd: process.cwd(),
      timeout: 30000,
      maxBuffer: 1024 * 1024, // 1MB
    })

    const output = [
      stdout ? `STDOUT:\n${stdout}` : '',
      stderr ? `STDERR:\n${stderr}` : '',
    ].filter(Boolean).join('\n')

    return { success: true, output: output || '(no output)' }
  } catch (err) {
    const error = err as { stdout?: string; stderr?: string; message?: string }
    const output = [
      error.stdout ? `STDOUT:\n${error.stdout}` : '',
      error.stderr ? `STDERR:\n${error.stderr}` : '',
    ].filter(Boolean).join('\n')

    return {
      success: false,
      output: output || undefined,
      error: `Command failed: ${error.message}`,
    }
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

    return {
      results: result.results.slice(0, topK),
      answer: result.answer,
      totalFound: result.results.length,
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
      const result = await withTimeout(
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
      const result = await withTimeout(
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
