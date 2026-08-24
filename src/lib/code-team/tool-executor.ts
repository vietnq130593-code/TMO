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
} from './dev-tools'

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
  file_edit: {
    type: 'function',
    function: {
      name: 'file_edit',
      description: 'Sửa file bằng exact string replace (an toàn hơn write). Lỗi nếu 0 match hoặc >1 match (dùng replace_all:true để thay tất cả). Có thể batch nhiều edits (atomic). ƯU TIÊN dùng tool này để sửa bug thay vì ghi đè cả file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Đường dẫn file relative từ workspace root' },
          old_str: { type: 'string', description: 'Chuỗi cần tìm (phải match chính xác, kể cả indentation)' },
          new_str: { type: 'string', description: 'Chuỗi thay thế' },
          replace_all: { type: 'boolean', description: 'true = thay mọi occurrence; mặc định lỗi nếu >1 match' },
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
  file_delete: {
    type: 'function',
    function: {
      name: 'file_delete',
      description: 'Xóa file hoặc thư mục. Bắt buộc có recursive:true để xóa thư mục. Hỗ trợ dry_run:true để xem sẽ xóa gì mà không thực sự xóa. Không bao giờ xóa workspace root.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Đường dẫn relative cần xóa' },
          recursive: { type: 'boolean', description: 'Bắt buộc nếu xóa thư mục' },
          dry_run: { type: 'boolean', description: 'true = chỉ trả về sẽ xóa gì, không touch filesystem' },
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
      description: 'Commit các file đã stage (hoặc paths cụ thể) với message. KHÔNG push. Dùng file tạm cho message để tránh shell escaping. Nếu all:true → git add -A trước.',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'Commit message (bắt buộc, không rỗng)' },
          paths: { type: 'array', items: { type: 'string' }, description: 'Paths cụ thể để commit (relative)' },
          all: { type: 'boolean', description: 'true = stage trước rồi commit (git add -A hoặc chỉ paths)' },
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
      case 'file_edit':
        result = await fileEdit(args as any)
        break
      case 'file_delete':
        result = await fileDelete(args as any)
        break
      case 'file_list':
        result = await fileList(args as any)
        break
      case 'grep':
        result = await grep(args as any)
        break
      case 'run_tests':
        result = await runTests(args as any)
        break
      case 'git_commit':
        result = await gitCommit(args as any)
        break
      // ===== P1: diagnostics + planning + synthesis + processes + packages =====
      case 'get_diagnostics':
        result = await getDiagnostics(args as any)
        break
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
      // ===== P2: gateway proxy (36 tools) =====
      case 'gateway_tool':
        result = await gatewayTool(args as any)
        break
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
    } catch {
      // opencode-server not available / timeout — fall through to local exec
    }
  }

  // Fallback: Use the project's own API for file operations
  switch (action) {
    case 'read':
      return await executeFileRead(path || '')
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
 */
async function executeFileRead(filePath: string): Promise<{ success: boolean; content?: string; error?: string }> {
  if (!filePath) return { success: false, error: 'Path is required' }

  try {
    const pathModule = await import('path')
    const projectRoot = process.cwd()
    const resolvedPath = pathModule.resolve(projectRoot, filePath)

    // Security: Prevent path traversal — resolved path must be within project root
    if (!resolvedPath.startsWith(projectRoot + pathModule.sep) && resolvedPath !== projectRoot) {
      return { success: false, error: `Access denied: path escapes project root` }
    }

    const fs = await import('fs/promises')
    const content = await fs.readFile(resolvedPath, 'utf-8')

    // Limit output to prevent overwhelming LLM context
    const maxChars = 50000
    const truncated = content.length > maxChars
    const output = truncated ? content.slice(0, maxChars) + '\n\n... [TRUNCATED — file too large]' : content

    return { success: true, content: output }
  } catch (err) {
    return {
      success: false,
      error: `Failed to read ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
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
      const results = await zai.functions.invoke('web_search', { query, num: 5 })
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
      const results = await zai.functions.invoke('web_search', { query, num: 5 })
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
      const result = await zai.functions.invoke('page_reader', { url })
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
    try {
      args = JSON.parse(tc.function.arguments)
    } catch {
      args = { _parseError: tc.function.arguments }
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
