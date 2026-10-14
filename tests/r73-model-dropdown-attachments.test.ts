/**
 * r73 — TEST 4 YÊU CẦU USER (2026-10-09, phiên sau r72):
 *   (1) Dropdown model free trên dòng model indicator (chat single mode)
 *   (2) Gỡ nút "Prompt Auto" + TOÀN BỘ code liên quan (chuỗi promptBudgetChars
 *       THEO TÁC VỤ) + nút "+" tải tệp đính kèm (ảnh/audio/video/pdf/docx/text)
 *   (3) Audit Bug_v2.md — last-resort failover chéo model (BUG2-018 kiến trúc)
 *   (4) Đánh giá + phân loại model free mới (matrix 14 ứng viên + battery 2 tầng)
 *
 * Mọi test bắt từ bằng chứng thật: matrix /tmp/oc-matrix-r73.txt, battery
 * /tmp/oc-battery-r73.md + /tmp/oc-battery2-r73.md, source scan khóa hợp đồng
 * gỡ nút (cùng pattern test đọc file của r72).
 *
 * Chạy: DATABASE_URL=file:/home/z/tmo-app/db/custom.db GOAL_LOOP_TEST_MODE=1 bun test tests/r73-model-dropdown-attachments.test.ts
 */
import { describe, expect, test, afterAll } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { PROVIDER_MODELS } from '../src/lib/agent-constants'
import { parseZenLastResortModels } from '../src/lib/llm'
import {
  classifySmolabAttachment,
  sanitizeSmolabAttachmentName,
  capSmolabAttachmentText,
} from '../src/lib/smolab-attachments'

const REPO = join(import.meta.dir, '..')

// ==================== (1) MODEL DROPDOWN — hợp đồng nguồn ====================

describe('r73-1 — dropdown model trên dòng model indicator (chat single)', () => {
  const smolabSrc = readFileSync(join(REPO, 'src/components/smolab/smolab-module.tsx'), 'utf8')

  test('dòng model indicator là nút bấm có data-dropdown-toggle + state showModelSelect', () => {
    expect(smolabSrc).toContain('showModelSelect')
    expect(smolabSrc).toMatch(/data-dropdown-toggle[\s\S]{0,2000}setShowModelSelect/)
  })

  test('dropdown render từ /api/agents/models (zenModelOptions fetch 1 lần) + icon caps ⚡🧠🤖', () => {
    expect(smolabSrc).toContain("fetch('/api/agents/models')")
    expect(smolabSrc).toMatch(/p\.key === 'zen'/)
    expect(smolabSrc).toContain("m.caps?.coding && <span title=\"coding\">⚡</span>")
    expect(smolabSrc).toContain("m.caps?.reasoning && <span title=\"reasoning\">🧠</span>")
    expect(smolabSrc).toContain("m.caps?.agentic && <span title=\"agentic\">🤖</span>")
  })

  test('chọn model → ghi đè chatBody.agentModel + model (single mode) — model hiệu dụng = selectedModel', () => {
    // r73: trước đây chatBody.model = agent.model (ghi đè selectedModel) →
    // sau fix: model + agentModel đều nhận selectedModel (dropdown chọn)
    expect(smolabSrc).toContain('chatBody.agentModel = selectedModel')
    expect(smolabSrc).toContain('chatBody.model = selectedModel')
  })

  test('chọn agent → reset selectedModel về model mặc định của agent', () => {
    expect(smolabSrc).toMatch(/setSelectedModel\(agent\.model\)/)
  })

  test('badge ⚡ ghi đè hiện khi selectedModel ≠ model agent', () => {
    expect(smolabSrc).toContain('⚡ ghi đè')
  })
})

// ==================== (2) GỠ NÚT PROMPT AUTO + NÚT "+" ====================

describe('r73-2 — gỡ nút "Prompt Auto" + toàn bộ code liên quan', () => {
  const smolabSrc = readFileSync(join(REPO, 'src/components/smolab/smolab-module.tsx'), 'utf8')
  const chatRouteSrc = readFileSync(join(REPO, 'src/app/api/openclaw/chat/route.ts'), 'utf8')
  const budgetSrc = readFileSync(join(REPO, 'src/lib/prompt-budget.ts'), 'utf8')
  const goalLoopSrc = readFileSync(join(REPO, 'src/lib/agent-goal-loop.ts'), 'utf8')
  const workerSrc = readFileSync(join(REPO, 'src/lib/goal-loop-worker.ts'), 'utf8')
  const durableSrc = readFileSync(join(REPO, 'src/lib/goal-loop-durable-types.ts'), 'utf8')
  const wfSrc = readFileSync(join(REPO, 'src/lib/code-team/workflow-engine.ts'), 'utf8')
  const teSrc = readFileSync(join(REPO, 'src/lib/code-team/tool-executor.ts'), 'utf8')

  test('UI: hết nút PROMPT AUTO / PROMPT ∞ / state promptBudgetMode', () => {
    expect(smolabSrc).not.toContain('PROMPT AUTO')
    expect(smolabSrc).not.toContain('PROMPT ∞')
    expect(smolabSrc).not.toContain('promptBudgetMode')
    expect(smolabSrc).not.toContain('promptBudgetChars')
  })

  test('chuỗi backend: hết promptBudgetChars xuyên suốt 5 file (route + goal-loop + worker + durable + code-team)', () => {
    // Cho phép từ khóa xuất hiện trong COMMENT giải thích việc đã gỡ (route +
    // prompt-budget có comment r73) — nhưng KHÔNG còn ở logic: các file
    // thực thi phải sạch hoàn toàn
    expect(workerSrc).not.toContain('promptBudgetChars')
    expect(durableSrc).not.toContain('promptBudgetChars')
    expect(wfSrc).not.toContain('promptBudgetChars')
    expect(teSrc).not.toContain('promptBudgetChars')
    expect(goalLoopSrc).not.toMatch(/promptBudgetChars[,:]/) // chỉ còn trong comment "đã bị XOÁ"
    expect(chatRouteSrc).not.toMatch(/promptBudgetChars[,:}\]]/)
  })

  test('prompt-budget.ts: budgetPromptWith ĐÃ XOÁ — chỉ còn budgetPrompt (trần env hệ thống duy nhất)', () => {
    expect(budgetSrc).not.toMatch(/export function budgetPromptWith/)
    expect(budgetSrc).toMatch(/export function budgetPrompt/)
  })

  test('API /api/agents/models vẫn phục vụ danh sách (không đổi hợp đồng cũ)', async () => {
    const mod: Record<string, unknown> = await import('../src/app/api/agents/models/route')
    expect(typeof mod.GET).toBe('function')
  })
})

describe('r73-2b — nút "+" tải tệp đính kèm cho agents', () => {
  const smolabSrc = readFileSync(join(REPO, 'src/components/smolab/smolab-module.tsx'), 'utf8')
  const attachRouteSrc = readFileSync(join(REPO, 'src/app/api/smolab/attachments/route.ts'), 'utf8')

  test('UI: nút + (fileInputRef) + accept ảnh/audio/video/pdf/docx/text + chips trạng thái', () => {
    expect(smolabSrc).toContain('fileInputRef')
    expect(smolabSrc).toMatch(/accept="image\/\*,audio\/\*,video\/\*/)
    expect(smolabSrc).toContain('pendingAttachments')
    expect(smolabSrc).toContain('handleAttachmentSelect')
    expect(smolabSrc).toContain('removeAttachment')
  })

  test('manifest đính kèm ghép vào message content (agent thấy nội dung tệp trong ngữ cảnh)', () => {
    expect(smolabSrc).toContain('buildAttachmentManifest')
    expect(smolabSrc).toMatch(/const text = manifest \? `\$\{rawText\}/)
    expect(smolabSrc).toContain('attachmentIds')
  })

  test('route upload: POST/GET/DELETE + VLM (createVision) + ASR (asr.create) + pdf-parse + mammoth', () => {
    expect(attachRouteSrc).toMatch(/export async function POST/)
    expect(attachRouteSrc).toMatch(/export async function GET/)
    expect(attachRouteSrc).toMatch(/export async function DELETE/)
    expect(attachRouteSrc).toContain('createVision')
    expect(attachRouteSrc).toContain('asr.create')
    expect(attachRouteSrc).toContain("import('pdf-parse')")
    expect(attachRouteSrc).toContain("import('mammoth')")
    expect(attachRouteSrc).toContain('video_url')
  })

  test('phân loại tệp — hardcode đuôi thắng MIME client bịa', () => {
    // .pdf + MIME bịa "text/html" → vẫn là pdf (đuôi hardcode thắng)
    expect(classifySmolabAttachment('report.pdf', 'text/html').kind).toBe('pdf')
    expect(classifySmolabAttachment('anh.png', '').kind).toBe('image')
    expect(classifySmolabAttachment('giong-noi.mp3', 'audio/mpeg').kind).toBe('audio')
    expect(classifySmolabAttachment('clip.mp4', 'video/mp4').kind).toBe('video')
    expect(classifySmolabAttachment('ghi-chu.md', '').kind).toBe('text')
    expect(classifySmolabAttachment('tai-lieu.docx', '').kind).toBe('docx')
    expect(classifySmolabAttachment('ky-lac.xyz', '').kind).toBe('other')
    // MIME thật khi có (client không bịa) vẫn được tôn trọng
    expect(classifySmolabAttachment('cgi-bin', 'image/png').kind).toBe('image')
  })

  test('phân loại — MIME generic octet-stream (curl/API client) coi như KHÔNG có MIME → dùng fallback đuôi', () => {
    // Bằng chứng live r73: curl -F upload .wav gửi application/octet-stream
    // → trước fix rơi kind=other (mất đường ASR); sau fix → audio/wav + ASR.
    expect(classifySmolabAttachment('r73-tone.wav', 'application/octet-stream').kind).toBe('audio')
    expect(classifySmolabAttachment('r73-tone.wav', 'application/octet-stream').mime).toBe('audio/wav')
    expect(classifySmolabAttachment('clip.mp4', 'application/octet-stream').kind).toBe('video')
    expect(classifySmolabAttachment('anh.jpg', 'application/octet-stream').kind).toBe('image')
    expect(classifySmolabAttachment('tai-lieu.pdf', 'application/octet-stream').kind).toBe('pdf')
    // MIME THẬT khác octet-stream vẫn thắng đuôi (đã test ở case trên)
    expect(classifySmolabAttachment('data.bin', 'audio/mpeg').kind).toBe('audio')
  })

  test('sanitize tên tệp — chặn path traversal + ký tự điều khiển + cap 120', () => {
    expect(sanitizeSmolabAttachmentName('../../etc/passwd')).toBe('passwd')
    expect(sanitizeSmolabAttachmentName('/tmp/x/../../.env')).toBe('.env')
    expect(sanitizeSmolabAttachmentName('a<b>c:d|e?f*.txt')).toBe('a_b_c_d_e_f_.txt')
    expect(sanitizeSmolabAttachmentName('')).toBe('file')
    expect(sanitizeSmolabAttachmentName('x'.repeat(500)).length).toBe(120)
  })

  test('cap văn bản chưng cất — cắt kèm marker trỏ về tệp gốc', () => {
    expect(capSmolabAttachmentText(null, 10)).toBeNull()
    expect(capSmolabAttachmentText('ngắn', 10)).toBe('ngắn')
    const capped = capSmolabAttachmentText('x'.repeat(100), 10)
    expect(capped).toContain('đã cắt tại 10 ký tự')
    expect(capped!.startsWith('x'.repeat(10))).toBe(true)
    expect(capped!.length).toBeLessThan(100) // 10 ký tự giữ + marker < 60
  })

  test('DB: bảng ChatAttachment sống (roundtrip create → read → delete)', async () => {
    const { db } = await import('../src/lib/db')
    const row = await db.chatAttachment.create({
      data: {
        fileName: 'r73-test.txt',
        mimeType: 'text/plain',
        kind: 'text',
        sizeBytes: 5,
        filePath: '/tmp/r73-test.txt',
        derivedText: 'hello',
        status: 'ready',
      },
    })
    expect(row.id).toBeTruthy()
    const readBack = await db.chatAttachment.findUnique({ where: { id: row.id } })
    expect(readBack?.fileName).toBe('r73-test.txt')
    await db.chatAttachment.delete({ where: { id: row.id } })
    const gone = await db.chatAttachment.findUnique({ where: { id: row.id } })
    expect(gone).toBeNull()
  })
})

// ==================== (3) BUG2-018 — LAST-RESORT FAILOVER CHÉO MODEL ====================

describe('r73-3 — last-resort failover chéo model trong free tier (BUG2-018 kiến trúc)', () => {
  test('pool mặc định = 3 model ĐÃ VERIFY battery r73 (ling + mimo + big-pickle)', () => {
    expect(parseZenLastResortModels(undefined, 'space-bunny-free', 'space-bunny-free'))
      .toEqual(['ling-3.1-flash-free', 'mimo-v2.6-flash-free', 'big-pickle'])
  })

  test('loại model chính + model failover (đã thử rung trên — không lặp lại call chết)', () => {
    // Model chính ling → pool rơi xuống mimo + big-pickle (2 model kế)
    expect(parseZenLastResortModels(undefined, 'ling-3.1-flash-free', 'space-bunny-free'))
      .toEqual(['mimo-v2.6-flash-free', 'big-pickle'])
  })

  test('env ZEN_LAST_RESORT_MODELS override pool', () => {
    expect(parseZenLastResortModels('step-5-preview-free,nemotron-3-ultra-free', 'space-bunny-free', 'space-bunny-free'))
      .toEqual(['step-5-preview-free', 'nemotron-3-ultra-free'])
  })

  test('cap 3 model/lần (chống đốt >15 phút CLI timeout khi cả pool chết)', () => {
    expect(parseZenLastResortModels('a,b,c,d,e', 'x', 'y')).toHaveLength(3)
  })

  test('mục rỗng/khoảng trắng bị lọc sạch', () => {
    expect(parseZenLastResortModels(' a , ,b ,  ', 'x', 'y')).toEqual(['a', 'b'])
  })

  test('llm.ts gọi parseZenLastResortModels trong chuỗi failover (source scan)', () => {
    const llmSrc = readFileSync(join(REPO, 'src/lib/llm.ts'), 'utf8')
    expect(llmSrc).toContain('parseZenLastResortModels(process.env.ZEN_LAST_RESORT_MODELS, zenModel, zenFailoverModel)')
    expect(llmSrc).toContain('agent-last-resort:')
  })
})

// ==================== (4) PHÂN LOẠI MODEL FREE — battery 2 tầng ====================

describe('r73-4 — phân loại model free theo coding/agentic/reasoning (battery thật)', () => {
  test('8 model battery r73 + 4 model R5 đồng bộ = 12 model free (đúng models.dev 2026-10-14)', () => {
    // PIN UPDATE R5 (2026-10-14 — user request "xác định lại list các model miễn
    // phí hiện tại của opencode... 1 số model free đang không có tên"): đối
    // chiếu `opencode models --verbose --refresh` + models.dev cho 12 model
    // free (cost 0/0, status != deprecated) — catalog cũ 8/12. 3 model từng
    // bị loại ở matrix r73 (2026-10-09) được đưa TRỞ LẠI vì metadata đã đổi
    // (nói thật — live blockedTransports từ /api/agents/models hiển thị thực
    // tế từng model); cat-jam-free là model MỚI phát hành 2026-10-12 (sau r73).
    expect(PROVIDER_MODELS.zen).toHaveLength(12)
    const ids = PROVIDER_MODELS.zen.map(m => m.id)
    expect(ids).toEqual([
      'space-bunny-free',
      'big-pickle',
      'mimo-v2.6-flash-free',
      'ling-3.1-flash-free',
      'longcat-2.5-preview-free',
      'nemotron-3-ultra-free',
      'nemotron-3.5-lightning-free',
      'step-5-preview-free',
      'cat-jam-free',
      'exo-free',
      'ling-3.0-flash-fin-free',
      'muse-spark-1.3-contributor-free',
    ])
  })

  test('battery 2 tầng: 8 model r73 PASS coding-hard + 4 model R5 caps từ metadata (romanToInt 6/6 case chạy bun thật)', () => {
    for (const m of PROVIDER_MODELS.zen) {
      expect(m.caps?.coding).toBe(true)
    }
  })

  test('battery 2 tầng: reasoning PASS (bài vòi hồ bơi = 140 phút — space-bunny đúng số nhưng nhiều chữ, năng lực vẫn đạt)', () => {
    for (const m of PROVIDER_MODELS.zen) {
      expect(m.caps?.reasoning).toBe(true)
    }
  })

  test('battery KHÓ phân hóa agentic: space-bunny + longcat lỗi JSON schema lồng nhau → caps.agentic=false', () => {
    // Bằng chứng /tmp/oc-battery2-r73.md: 2 model này json-parse-fail ở bài
    // agentic-hard (JSON lồng analysis/actions/depends_on); 6 model kia giữ
    // schema ĐÚNG. Hợp quan sát r70: SBF là model phát tool-call đứt nhiều
    // nhất — parser salvage r70 F1-F7 bù cho đặc tính này.
    const byId = new Map(PROVIDER_MODELS.zen.map(m => [m.id, m]))
    expect(byId.get('space-bunny-free')?.caps?.agentic).toBe(false)
    expect(byId.get('longcat-2.5-preview-free')?.caps?.agentic).toBe(false)
    expect(byId.get('big-pickle')?.caps?.agentic).toBe(true)
    expect(byId.get('mimo-v2.6-flash-free')?.caps?.agentic).toBe(true)
    expect(byId.get('nemotron-3-ultra-free')?.caps?.agentic).toBe(true)
    expect(byId.get('step-5-preview-free')?.caps?.agentic).toBe(true)
  })

  test('label phân loại kèm đặc tính vận hành (tốc độ/xu hướng sử dụng)', () => {
    const byId = new Map(PROVIDER_MODELS.zen.map(m => [m.id, m.label || '']))
    expect(byId.get('big-pickle')).toContain('nhanh nhất coding')
    expect(byId.get('mimo-v2.6-flash-free')).toContain('NHANH NHẤT tổng thể')
    expect(byId.get('nemotron-3-ultra-free')).toContain('reasoning SÂU')
  })
})

// Dọn dẹp (nếu test DB bị giết giữa chừng — an toàn)
afterAll(async () => {
  try {
    const { db } = await import('../src/lib/db')
    await db.chatAttachment.deleteMany({ where: { fileName: 'r73-test.txt' } })
  } catch { /* ignore */ }
})
