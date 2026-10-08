/**
 * DIRECTIVE GUARD — chống ping-pong mission (BUG-008, quan sát r68).
 *
 * Bằng chứng: mission #18 kết thúc verdict_stagnation (4.0M tokens) 09:25Z
 * → user re-dispatch qua UI chỉ 82 ký tự "Tiếp tục triển khai các đề xuất
 * khắc phục và các phần việc chưa hoàn thành cho tôi" — KHÔNG khối
 * "Nghiệm thu:", evaluator không có tiêu chí đối chiếu → quỹ đạo stagnation
 * lặp lại (mission #19 chết y hệt sau 4.6M tokens). Guard fail-fast trước
 * đây CHỈ nằm trong scripts/mission-dispatch.ts (đường script) — đường UI
 * (/api/openclaw/chat) KHÔNG được bảo vệ.
 *
 * Thiết kế r69 (doctrine "hardcode > prompt" + ràng buộc "không chặn user"):
 * guard nằm ở TẦNG API (đường UI lẫn script cùng chịu — mission-dispatch
 * giờ import cùng nguồn sự thật này). KHÔNG TỪ CHỐI user — thay vào đó
 * TỰ GẮN tiêu chí nghiệm thu kiểm định được vào directive trước khi dispatch:
 *   (a) directive là WORK ORDER (mang động từ triển khai/tiếp tục hoặc dài)
 *       mà KHÔNG có khối "Nghiệm thu:" hợp lệ →
 *   (b) session CÓ todo đang mở → scaffold từ BACKLOG THẬT (từng todo mở
 *       trở thành 1 tiêu chí — đúng phần việc chưa xong user muốn tiếp nối);
 *       session không có → scaffold BASELINE máy-đo được (bằng chứng tool/
 *       todo/kiểm định) — evaluator LUÔN có cái để bám, không còn phán uẩn.
 * Kết quả enrich là DATA (dòng "- [ ] …") nạp vào chuỗi kiểm định cơ khí
 * của evaluator + todo-coverage ("mỗi Nghiệm thu n ≥ 1 todo") — không phải
 * lời nhắc mong model tuân theo.
 */

import type { PrismaClient } from '@prisma/client'

// ==================== (1) EXTRACT — nguồn sự thật chung ====================
// Đồng bộ chủ đích với extractDirectiveSpec (agent-goal-loop.ts — runtime
// parser) nhưng guard chỉ cần DANH SÁCH tiêu chí; giữ cả 2 đường bắt như
// script cũ (block checklist + per-item) để không từ chối nhầm format thật.

/**
 * Trích tiêu chí nghiệm thu từ directive thô. 2 đường:
 * (a) khối "Nghiệm thu:" + các dòng "- [ ] …" (dạng chuẩn hoá worked-example
 *     scratch/r64-directive.txt);
 * (b) per-item "Nghiệm thu: <điều kiện>" — format mission #18 mỗi hạng mục
 *     1 dòng (parser harness chỉ bắt block đầu — guard bắt thêm đường này).
 */
export function extractAcceptanceCriteria(raw: string): string[] {
  const items = new Set<string>()
  const block = raw.match(
    /(?:Tiêu chí )?[Nn]ghiệm thu[^:\n]*:\s*([\s\S]*?)(?=\n\s*\n|\n\s*[•🏁🔍💡📊🚨⚖️]|$)/
  )
  if (block) {
    // r69 (test bắt lỗi): đường (a) CHỈ nhận dòng CHECKLIST ("- …" / "- [ ] …")
    // — trước đây mọi dòng kế tiếp đều thành item, nuốt cả "Hạng mục 2…" và
    // dòng "Nghiệm thu: …" kế tiếp trong format per-item mission #18 (test
    // thật: 4 item rác thay vì 2). Format per-item thuần do đường (b) nhận.
    for (const line of block[1].split('\n')) {
      if (!/^\s*-\s*(\[[ xX]\])?/.test(line)) continue
      const item = line
        .replace(/^\s*-\s*\[[ xX]\]\s*/, '')
        .replace(/^\s*-\s*/, '')
        .trim()
      if (item && item.length > 3) items.add(item)
    }
  }
  for (const m of raw.matchAll(/^[^\S\n]*[Nn]ghiệm thu[^:\n]*:[ \t]*(\S.*)$/gm)) {
    const item = m[1].trim()
    if (item.length > 3) items.add(item)
  }
  return [...items]
}

// ==================== (2) WORK-ORDER DETECTION ====================
// Guard KHÔNG áp cho chat thường (câu hỏi factual ngắn không phải mission).
// Work order = mang động từ triển khai tiếng Việt/Anh đặc trưng mission,
// hoặc directive dài (≥200 chars — kiểu worked-example đầy đặc tả).
const WORK_ORDER_VERB_RE =
  /(tiếp tục|triển khai|khắc phục|thực hiện|hoàn thành|xử lý|xử lý tiếp|làm tiếp|phần việc|công việc|nhiệm vụ|implement|deploy|refactor|hotfix|fix |p0-|p1-|p2-|nghiệm thu)/i
const WORK_ORDER_MIN_CHARS = 200

export function isWorkOrderDirective(directive: string): boolean {
  const d = directive.trim()
  return d.length >= WORK_ORDER_MIN_CHARS || WORK_ORDER_VERB_RE.test(d)
}

// ==================== (3) SCAFFOLD — backlog / baseline ====================

/** Scaffold BASELINE — máy-đo được, áp mọi work order thiếu nghiệm thu. */
export const BASELINE_ACCEPTANCE_SCAFFOLD = `Nghiệm thu (hệ thống TỰ GẮN — directive gốc chưa khai tiêu chí, chống ping-pong verdict_stagnation):
- [ ] Báo cáo cuối liệt kê TỪNG việc đã làm kèm bằng chứng tool trích dẫn được (tên tool + kết quả cụ thể)
- [ ] Mọi kết luận "đã xong/vừa xong" đều có tool call tương ứng THẬT trong run này (trọng tài đối chiếu mục lục tool call)
- [ ] Phần chưa hoàn thành được ghi thành todo (todo_write) + nêu rõ trong mục "Còn thiếu" của báo cáo cuối
- [ ] Nếu task chạm mã nguồn: ít nhất 1 lần kiểm định (lint / type_check / run_tests / run_gate) chạy THẬT với kết quả được trích dẫn`

/**
 * Scaffold từ BACKLOG THẬT của session: todo đang mở (pending/in_progress/
 * blocked, chưa archived) — từng todo 1 tiêu chí. Đây là "phần việc chưa
 * hoàn thành" user muốn tiếp nối, truy hồi bằng SQL (không phải đoán).
 * Trả null khi không có todo mở nào / DB lỗi (fail-open → baseline).
 */
export async function buildBacklogAcceptanceScaffold(
  db: PrismaClient,
  sessionId: string,
  maxItems = 8,
): Promise<string | null> {
  try {
    const openTodos = await db.todo.findMany({
      where: {
        sessionId,
        status: { in: ['pending', 'in_progress', 'blocked'] },
        archivedAt: null,
      },
      orderBy: [{ priority: 'desc' }, { updatedAt: 'desc' }],
      take: maxItems,
      select: { content: true },
    })
    if (openTodos.length === 0) return null
    const lines = openTodos.map(t => `- [ ] ${t.content.replace(/\s+/g, ' ').trim().slice(0, 180)}`)
    return `Nghiệm thu (hệ thống TỰ TRUY HỒI từ backlog todo đang mở của session — đúng phần việc chưa hoàn thành cần tiếp nối, không phải directive mơ hồ):
${lines.join('\n')}`
  } catch {
    return null // fail-open — DB lỗi → caller dùng baseline
  }
}

// ==================== (4) ENRICH — điểm vào duy nhất của tầng API ====================

export interface DirectiveGuardResult {
  /** Directive sau guard (= gốc khi không áp) — dùng cho jobInput.userMessage */
  directive: string
  /** true = đã tự gắn scaffold (directive gốc thiếu nghiệm thu) */
  guardApplied: boolean
  /** 'backlog' | 'baseline' | '' — loại scaffold đã gắn (audit log) */
  scaffoldKind: '' | 'backlog' | 'baseline'
  /** Số tiêu chí sau enrich (audit log) */
  acceptanceCount: number
}

/**
 * ÁP GUARD cho directive trước khi dispatch goal-loop. KHÔNG BAO GIỜ chặn
 * hay throw — mọi lỗi nội bộ trả về directive gốc (fail-open tuyệt đối).
 *
 * @param db      PrismaClient (truy hồi backlog todo)
 * @param sessionId session của directive (null → baseline path)
 * @param directive  nội dung user message gốc
 */
export async function enrichDirectiveForGoalLoop(
  db: PrismaClient,
  sessionId: string | null | undefined,
  directive: string,
): Promise<DirectiveGuardResult> {
  const base: DirectiveGuardResult = { directive, guardApplied: false, scaffoldKind: '', acceptanceCount: extractAcceptanceCriteria(directive).length }
  try {
    if (!directive || !directive.trim()) return base
    // Directive ĐÃ có tiêu chí riêng → tôn trọng (operator dùng worked-example)
    if (base.acceptanceCount > 0) return base
    // Chat thường (câu hỏi ngắn không phải work order) → không can thiệp
    if (!isWorkOrderDirective(directive)) return base

    // Work order thiếu nghiệm thu → gắn scaffold: backlog thật nếu có,
    // ngược lại baseline máy-đo.
    let scaffold: string | null = null
    let kind: 'backlog' | 'baseline' = 'baseline'
    if (sessionId) {
      scaffold = await buildBacklogAcceptanceScaffold(db, sessionId)
      if (scaffold) kind = 'backlog'
    }
    if (!scaffold) scaffold = BASELINE_ACCEPTANCE_SCAFFOLD

    const enriched = `${directive.trim()}\n\n${scaffold}`
    return {
      directive: enriched,
      guardApplied: true,
      scaffoldKind: kind,
      acceptanceCount: extractAcceptanceCriteria(enriched).length,
    }
  } catch {
    return base // fail-open — guard không được phép chặn user
  }
}
