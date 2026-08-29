/**
 * ERROR TAXONOMY (A6 · phần B) — 6 ROOT CAUSE × manifestations 2 tầng
 *
 * Tầng 1 = ROOT CAUSE (tại sao sai) — 6 loại R1-R6.
 * Tầng 2 = MANIFESTATION (biểu hiện ra sao) — M1.1…M6.3.
 *
 * Bảng hành động B.2 (playbook): mỗi root cause có MỘT phản ứng chuẩn —
 * agent không cần "sáng tạo" khi gặp lỗi: tra taxonomy → làm đúng phản ứng.
 * Đây chính là thứ biến "retry mò" thành "học có hệ thống".
 *
 * Quy tắc vàng: category (manifestation-level, ErrorType 17 loại hiện có
 * của TMO) trả lời "lỗi trông thế nào"; rootCause trả lời "ai sai/vì sao
 * sai" — 2 tầng độc lập, ghép nhau trong ErrorOccurrence node.
 */

import type {
  Manifestation,
  RootCauseCode,
  RootCausePlaybook,
} from './types'

// ==================== B.1 — CÂY PHÂN LOẠI 2 TẦNG ====================

/** Manifestations theo root cause — markers regex match trên raw message lowercase */
export const MANIFESTATIONS: Record<RootCauseCode, Manifestation[]> = {
  INPUT_INVALID: [
    {
      code: 'M1.1',
      description: 'tham số tool sai format (path sai, JSON malformed)',
      markers: [
        /invalid (input|parameter|argument|json)/,
        /json.{0,20}(malformed|parse|unexpected)/,
        /(expected|invalid) (path|file path)/,
        /must be (a |an )?(string|number|boolean|array|object)/,
        /missing (required )?(parameter|argument|field|property)/,
        /enoent.{0,40}(no such file|cannot find)/,
        /argument.{0,20}invalid/i,
        /validation (failed|error)/,
        /\b400 bad request\b/,
      ],
    },
    {
      code: 'M1.2',
      description: 'hiểu sai yêu cầu user (wrong goal parsing)',
      markers: [
        /goal.{0,30}(unclear|ambiguous|misinterpret)/i,
        /user (intent|request).{0,20}(unclear|mismatch)/i,
        /wrong (goal|target|objective)/i,
      ],
    },
    {
      code: 'M1.3',
      description: 'thiếu thông tin cần thiết (undeclared dependency)',
      markers: [
        /missing (information|context|requirement|dependency)/i,
        /undeclared/i,
        /not provided/i,
        /required field.{0,20}(missing|absent)/i,
      ],
    },
  ],

  ASSUMPTION_WRONG: [
    {
      code: 'M2.1',
      description: 'đoán sai nội dung file/schema (chưa đọc đã sửa)',
      markers: [
        /type ['"`].+['"`].{0,30}is not assignable/i,
        /ts2322/i,
        /property ['"`].+['"`].{0,30}(does not exist|not exist)/i,
        /ts2339/i,
        /no overload (matches|exists)/i,
        /cannot find (module|name)/i,
        /schema (mismatch|does not match)/i,
      ],
    },
    {
      code: 'M2.2',
      description: 'đoán sai hành vi API/tool (hallucinated capability)',
      markers: [
        /is not a function/i,
        /\.open is not a function/i,
        /undefined is not an object/i,
        /cannot read propert(y|ies) of (undefined|null)/i,
        /hallucinated/i,
        /no such (command|option|method|tool|subcommand)/i,
        /unknown (command|option|method|tool)/i,
        /unsupported (operation|command|method)/i,
      ],
    },
    {
      code: 'M2.3',
      description: 'đoán sai trạng thái hệ thống (file đã xóa, DB đổi schema)',
      markers: [
        /no such table/i,
        /table.{0,20}already exists/i,
        /column.{0,20}(does not exist|not found)/i,
        /file (already exists|not found)/i,
        /already been (deleted|removed)/i,
        /duplicate (key|entry)/i,
        /record (not found|does not exist)/i,
      ],
    },
  ],

  KNOWLEDGE_GAP: [
    {
      code: 'M3.1',
      description: 'không biết API/library cần dùng',
      markers: [
        /cannot find module ['"`]/i,
        /module not found/i,
        /peer dep(i)?endency/i,
        /is not exported/i,
        /has no exported member/i,
        /api (unknown|not documented)/i,
      ],
    },
    {
      code: 'M3.2',
      description: 'không biết quy ước của project (CONVENTIONS.md chưa đọc)',
      markers: [
        /convention/i,
        /(violates|breaks).{0,20}(style|convention|naming)/i,
        /naming (convention|mismatch)/i,
      ],
    },
    {
      code: 'M3.3',
      description: 'KB thiếu dữ liệu về chủ đề',
      markers: [
        /no (knowledge|kb|results|matches) (found|available)/i,
        /knowledge base.{0,20}(empty|missing|no match)/i,
        /not in (kb|knowledge)/i,
      ],
    },
  ],

  TOOL_FAILURE: [
    {
      code: 'M4.1',
      description: 'tool timeout / crash',
      markers: [
        /timeout|timed out/i,
        /etimedout/i,
        /econnreset|econnrefused/i,
        /socket hang up/i,
        /fetch failed/i,
        /process (crashed|killed)|sigkill|sigsegv/i,
        /\b50[234]\b/,
        /service unavailable/i,
        /bad gateway/i,
        /\b429\b|rate ?limit/i,
      ],
    },
    {
      code: 'M4.2',
      description: 'tool trả kết quả sai (mock server, stale data)',
      markers: [
        /stale (data|cache|result)/i,
        /mock server/i,
        /unexpected (result|output|response)/i,
        /nonsense|garbled|corrupted (output|result)/i,
      ],
    },
    {
      code: 'M4.3',
      description: 'quyền truy cập bị từ chối',
      markers: [
        /permission denied|eacces|eperm/i,
        /\b40[13]\b|(unauthorized|forbidden)/i,
        /access (denied|not allowed|restricted)/i,
        /not authorized/i,
        /quota (exceeded|exhausted)/i,
        /insufficient (credits|quota|funds)/i,
      ],
    },
  ],

  REASONING_ERROR: [
    {
      code: 'M5.1',
      description: 'logic sai (off-by-one, sai điều kiện)',
      markers: [
        /off[- ]by[- ]one/i,
        /logic (error|flaw|mistake)/i,
        /condition.{0,20}(wrong|incorrect|inverted)/i,
        /infinite loop/i,
        /assertion (failed|error)/i,
        /expected.{0,30}but (got|received)/i,
        /test[s]? (failed|failing)/i,
      ],
    },
    {
      code: 'M5.2',
      description: 'kế hoạch sai thứ tự (sửa B trước khi biết A)',
      markers: [
        /(used|referenced) before (definition|declaration|initialization)/i,
        /out of order/i,
        /premature (call|access|optimization)/i,
        /before it (exists|is (ready|defined|created))/i,
      ],
    },
    {
      code: 'M5.3',
      description: 'mất ngữ cảnh (quên quyết định trước đó trong session)',
      markers: [
        /context (lost|exceeded|window)/i,
        /forgot (previous|earlier|prior)/i,
        /contradicts (previous|earlier)/i,
        /inconsistent with (previous|earlier)/i,
      ],
    },
  ],

  ENV_DRIFT: [
    {
      code: 'M6.1',
      description: 'dependency update phá API',
      markers: [
        /version (mismatch|conflict|incompatible)/i,
        /incompatible with (current )?version/i,
        /requires (node|bun|typescript|python).{0,20}version/i,
        /breaking change/i,
        /deprecated (api|function|module)/i,
        /engine (conflict|mismatch)/i,
      ],
    },
    {
      code: 'M6.2',
      description: 'config/credential hết hạn',
      markers: [
        /(api[_ ]?key|token|credential).{0,30}(invalid|expired|missing|exhausted)/i,
        /unauthenticated|authentication (failed|required)/i,
        /env(ironment)? variable.{0,20}(missing|not set|undefined)/i,
        /credential/i,
        /\b401\b/,
      ],
    },
    {
      code: 'M6.3',
      description: 'workspace không đồng bộ với production',
      markers: [
        /drift(ed)?|out of sync|desync/i,
        /migration (pending|not applied|missing)/i,
        /schema.{0,20}out (of|to) date/i,
        /port.{0,20}(already )?in use/i,
        /eaddrinuse/i,
        /workspace.{0,20}(dirty|mismatch)/i,
      ],
    },
  ],
}

// ==================== B.2 — BẢNG HÀNH ĐỘNG (PLAYBOOK) ====================

export const ROOT_CAUSE_PLAYBOOKS: Record<RootCauseCode, RootCausePlaybook> = {
  INPUT_INVALID: {
    code: 'INPUT_INVALID',
    label: 'R1 · INPUT_INVALID — đầu vào sai',
    correctResponse: 'Đọc lại spec/tool schema, hỏi user nếu mơ hồ — sửa input cho đúng format rồi mới thử lại',
    antiPattern: 'Retry nguyên vẹn cùng input cũ',
  },
  ASSUMPTION_WRONG: {
    code: 'ASSUMPTION_WRONG',
    label: 'R2 · ASSUMPTION_WRONG — giả định sai về thế giới',
    correctResponse: 'file_read/grep TRƯỚC — verify bằng tool rồi mới hành động, không đoán lại lần nữa',
    antiPattern: 'Đoán lại lần nữa (guess harder)',
  },
  KNOWLEDGE_GAP: {
    code: 'KNOWLEDGE_GAP',
    label: 'R3 · KNOWLEDGE_GAP — thiếu tri thức',
    correctResponse: 'knowledge_search → web_search → hỏi user/escalate — không bịa dựa trên prior',
    antiPattern: 'Bịa dựa trên prior (hallucinate để lấp khoảng trống)',
  },
  TOOL_FAILURE: {
    code: 'TOOL_FAILURE',
    label: 'R4 · TOOL_FAILURE — công cụ lỗi (không phải lỗi agent)',
    correctResponse: 'Đổi tool tương đương, escalate nếu lặp lại nhiều lần',
    antiPattern: 'Retry vô hạn cùng tool',
  },
  REASONING_ERROR: {
    code: 'REASONING_ERROR',
    label: 'R5 · REASONING_ERROR — lỗi suy luận',
    correctResponse: 'Dừng, re-plan từ đầu, nhờ SENTINEL/evaluator review — sửa đúng căn nguyên logic',
    antiPattern: 'Vá cục bộ chỗ lỗi (patch symptom)',
  },
  ENV_DRIFT: {
    code: 'ENV_DRIFT',
    label: 'R6 · ENV_DRIFT — môi trường thay đổi',
    correctResponse: 'Snapshot check, diff config, rollback nếu cần — không sửa code theo môi trường mù mờ',
    antiPattern: 'Sửa code theo môi trường mới mù mờ',
  },
}

/** Tra playbook — MỘT phản ứng chuẩn cho mỗi root cause */
export function getPlaybook(rootCause: RootCauseCode): RootCausePlaybook {
  return ROOT_CAUSE_PLAYBOOKS[rootCause]
}

// ==================== B.3 — QUY TRÌNH PHÂN LOẠI ====================

export interface ClassifyInput {
  /** Raw error message (raw_message của ErrorOccurrence) */
  rawMessage: string
  /** Tool sinh ra lỗi — dùng cho heuristics đặc thù */
  tool?: string
  /** ErrorType hiện có của TMO (manifestation-level) nếu caller có */
  errorType?: string
}

export interface ClassificationResult {
  rootCause: RootCauseCode
  /** Mã manifestation M*.n khớp mạnh nhất (nếu có) */
  manifestation: string | null
  /** Điểm match của manifestation (số marker khớp) */
  score: number
  /** Bước B1-B7 đã dừng lại — giải thích quyết định */
  decisionPath: string
  playbook: RootCausePlaybook
}

/**
 * Phân loại lỗi theo quy trình B.3 (B1→B7) — heuristic deterministic,
 * KHÔNG dùng LLM (nhẹ, chạy được fail-open, kết quả ổn định).
 *
 *  B1: Đọc raw error message
 *  B2: "Input tôi đưa vào có đúng spec không?" → R1
 *  B3: "Tôi có vừa đoán điều gì không verify không?" → R2
 *  B4: "Tôi có biết chắc cách dùng đúng không?" → R3
 *  B5: "Tool có chạy mà trả kết quả vô lý/crash không?" → R4
 *  B6: Còn lại → R5 (lỗi của chính mình) hoặc R6 (môi trường)
 *  B7: Ghi ErrorOccurrence với category + root_cause
 *
 * Thứ tự đánh giá theo đúng B.2-B.6 (input → assumption → knowledge →
 * tool → env/reasoning). Mỗi bước tính điểm match manifestation; bước có
 * điểm cao nhất thắng. Điểm 0 toàn bộ → default R5 REASONING_ERROR
 * (lỗi của chính agent — nguyên tắc trung thực, không đổ lỗi môi trường).
 */
export function classifyRootCause(input: ClassifyInput): ClassificationResult {
  const raw = (input.rawMessage || '').toLowerCase()
  const decisionPath: string[] = ['B1: đọc raw message']

  // Điểm mỗi root cause = tổng marker khớp qua mọi manifestation
  const scores = new Map<RootCauseCode, { total: number; best: Manifestation | null; bestScore: number }>()
  for (const rc of Object.keys(MANIFESTATIONS) as RootCauseCode[]) {
    let total = 0
    let best: Manifestation | null = null
    let bestScore = 0
    for (const m of MANIFESTATIONS[rc]) {
      const hits = m.markers.filter(rx => rx.test(raw)).length
      if (hits > 0) {
        total += hits
        if (hits > bestScore) { bestScore = hits; best = m }
      }
    }
    scores.set(rc, { total, best, bestScore })
  }

  // B2→B6 theo đúng thứ tự quy trình — bước nào có marker khớp thì dừng ở đó
  const order: Array<{ step: string; rc: RootCauseCode }> = [
    { step: 'B2', rc: 'INPUT_INVALID' },
    { step: 'B3', rc: 'ASSUMPTION_WRONG' },
    { step: 'B4', rc: 'KNOWLEDGE_GAP' },
    { step: 'B5', rc: 'TOOL_FAILURE' },
    { step: 'B6', rc: 'ENV_DRIFT' },
  ]

  let chosen: RootCauseCode = 'REASONING_ERROR'
  let chosenStep = 'B6'
  let chosenManifestation: Manifestation | null = null
  let chosenScore = 0

  for (const { step, rc } of order) {
    const s = scores.get(rc)!
    if (s.total > 0) {
      decisionPath.push(`${step}: marker khớp ${rc} (${s.total} hits) → dừng`)
      chosen = rc
      chosenStep = step
      chosenManifestation = s.best
      chosenScore = s.total
      break
    }
    decisionPath.push(`${step}: không có marker ${rc} → qua bước sau`)
  }
  if (chosen === 'REASONING_ERROR') {
    const s = scores.get('REASONING_ERROR')!
    if (s.total > 0) {
      chosenManifestation = s.best
      chosenScore = s.total
      decisionPath.push('B6: marker REASONING_ERROR khớp')
    } else {
      decisionPath.push('B6: không marker nào khớp → default R5 REASONING_ERROR (lỗi của chính agent)')
    }
  }

  // Heuristic đặc thù theo tool (B5 override): shell/terminal lỗi thường là R4
  // hoặc R6; tool đặc thù bỏ qua nếu đã có match mạnh (score ≥ 2)
  if (chosenScore < 2 && input.tool) {
    const t = input.tool.toLowerCase()
    if (/econnrefused|connection refused|service unavailable|503|429/.test(raw)) {
      decisionPath.push(`B5+: tool "${input.tool}" — marker kết nối/rate-limit mạnh → TOOL_FAILURE`)
      chosen = 'TOOL_FAILURE'
      chosenStep = 'B5'
    } else if (t === 'shell' || t === 'run_tests' || t === 'terminal') {
      // Shell lỗi exit ≠ 0 mà không khớp marker nào rõ → thường env/exec problem
      if (/command not found|not found|enoent/.test(raw)) {
        decisionPath.push(`B5+: shell ENOENT/command-not-found → KNOWLEDGE_GAP (không biết môi trường có gì)`)
        chosen = 'KNOWLEDGE_GAP'
        chosenStep = 'B4'
      }
    }
  }

  return {
    rootCause: chosen,
    manifestation: chosenManifestation?.code ?? null,
    score: chosenScore,
    decisionPath: decisionPath.join(' → '),
    playbook: getPlaybook(chosen),
  }
}

/** Template câu Lesson theo root cause (C.1 nhịp 4 — "Khi [trigger], nên [fix] vì [root_cause]") */
export function buildLessonStatement(params: {
  rootCause: RootCauseCode
  triggerCondition: string
  fixSummary: string
}): string {
  const { rootCause, triggerCondition, fixSummary } = params
  const label = ROOT_CAUSE_PLAYBOOKS[rootCause].label.split('—')[0].trim()
  return `Khi ${triggerCondition}, nên ${fixSummary} vì lỗi thuộc ${label}`
}

/** Nhân bản manifestation list cho UI/API */
export function listTaxonomy(): Array<RootCausePlaybook & { manifestations: Manifestation[] }> {
  return (Object.keys(ROOT_CAUSE_PLAYBOOKS) as RootCauseCode[]).map(rc => ({
    ...ROOT_CAUSE_PLAYBOOKS[rc],
    manifestations: MANIFESTATIONS[rc],
  }))
}
