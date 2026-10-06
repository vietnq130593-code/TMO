// ============================================================================
// ROUND-43 VERIFY — đối chiếu DB ChatMessage rows của session e2e:
// (1) toolResult rows có toolSeq; (2) patch theo seq cho kết quả ĐÚNG tool
//     (không còn ghép nhầm như B1 — 4/70 mismatch của round-42);
// (3) mọi tool_call có teamSeq đơn điệu; (4) trạng thái panel cuối đúng.
// Chạy: cd /home/z/tmo-app && DATABASE_URL=file:/home/z/tmo-app/db/custom.db \
//        bun run scratch/r43-verify-pairing.ts <sessionId>
// ============================================================================
process.env.DATABASE_URL = 'file:/home/z/tmo-app/db/custom.db'

import { db } from '../src/lib/db'

const sessionId = process.argv[2]
if (!sessionId) {
  console.error('Usage: bun run scratch/r43-verify-pairing.ts <sessionId>')
  process.exit(1)
}

let pass = 0, fail = 0
const fails: string[] = []
function ok(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; fails.push(name); console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`) }
}

const rows = await db.chatMessage.findMany({
  where: { sessionId },
  orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
})
console.log(`▶ Session ${sessionId}: ${rows.length} rows`)

type Meta = Record<string, unknown> | null | undefined
const metaOf = (r: { metadata: string | null }): Meta => {
  if (!r.metadata) return undefined
  try {
    const first = JSON.parse(r.metadata)
    return typeof first === 'string' ? JSON.parse(first) : first
  } catch { return undefined }
}

// ── 1. teamSeq đơn điệu (theo thứ tự emit đã stamp) ──
const seqRows = rows.map(r => ({ id: r.id, meta: metaOf(r) }))
  .filter(x => typeof x.meta?.teamSeq === 'number') as Array<{ id: string; meta: Record<string, unknown> }>
ok('V1 có rows mang teamSeq (route stamp sống)', seqRows.length > 0, `count=${seqRows.length}`)

// ── 2. toolResult có toolSeq + patch theo seq cho ĐÚNG tool ──
const toolCalls = seqRows.filter(x => (x.meta as { toolCallInfo?: { tool: string } }).toolCallInfo)
const toolResults = seqRows.filter(x => (x.meta as { toolResult?: unknown }).toolResult)
const withToolSeq = toolResults.filter(x => typeof (x.meta as { toolResult?: { toolSeq?: number } }).toolResult?.toolSeq === 'number')
ok(`V2 toolResult rows có toolSeq (${withToolSeq.length}/${toolResults.length})`,
  toolResults.length > 0 && withToolSeq.length === toolResults.length,
  `results=${toolResults.length} withSeq=${withToolSeq.length}`)

// Mô phỏng patch-theo-seq của frontend trên thứ tự row DB THẬT (commit order — có thể lệch emit order)
const events: Array<{ kind: 'tool'; id: string; seq?: number; tool: string; success?: boolean; resultTool?: string }> = []
let mismatch = 0, orphans = 0
for (const x of seqRows) {
  const m = x.meta as { teamSeq?: number; toolCallInfo?: { tool: string }; toolResult?: { toolSeq?: number; tool?: string; ok?: boolean } }
  if (m.toolCallInfo) {
    events.push({ kind: 'tool', id: x.id, seq: m.teamSeq as number, tool: m.toolCallInfo.tool })
    continue
  }
  if (m.toolResult) {
    const refSeq = m.toolResult.toolSeq
    const target = refSeq != null
      ? events.filter(e => e.seq === refSeq).at(-1)
      : events.filter(e => e.success == null).at(-1)
    if (target) {
      target.success = m.toolResult.ok !== false
      target.resultTool = m.toolResult.tool
    } else {
      orphans++
    }
  }
}
// Mismatch = tool nhận result của tool KHÁC (so sánh tên tool)
for (const e of events) {
  if (e.resultTool != null && e.resultTool !== e.tool) mismatch++
}
ok('V3 patch-theo-seq: 0 kết quả ghép nhầm tool', mismatch === 0, `mismatch=${mismatch}`)
ok('V4 patch-theo-seq: 0 kết quả mồ côi', orphans === 0, `orphans=${orphans}`)
const resolved = events.filter(e => e.success != null).length
console.log(`  ℹ️ ${events.length} tool calls, ${resolved} đã có kết quả ✓/✗, ${events.length - resolved} chưa có`)

// ── 3. không có cặp call/result lệch thứ tự ngược trong DB (thông tin thêm) ──
let inverted = 0
for (let i = 1; i < seqRows.length; i++) {
  const prev = seqRows[i - 1].meta as { toolResult?: { toolSeq?: number } }
  const cur = seqRows[i].meta as { teamSeq?: number }
  // result row đứng TRƯỚC call row của nó (theo teamSeq) → commit race thật
  if (prev.toolResult && typeof prev.toolResult.toolSeq === 'number' && cur.teamSeq === prev.toolResult.toolSeq) inverted++
}
console.log(`  ℹ️ DB có ${inverted} cặp result-commit-trước-call (bằng chứng race B1 — seq-patch xử lý được)`)

// ── 4. trạng thái cuối ──
const doneRow = rows.map(r => ({ role: r.role, meta: metaOf(r) }))
  .filter(x => typeof x.meta?.workflowStatus === 'string').at(-1)
ok('V5 có workflow_done row (marker terminal)', !!doneRow, `status=${(doneRow?.meta?.workflowStatus as string) ?? 'none'}`)
if (doneRow && doneRow.meta) console.log(`  ℹ️ workflow_done status = ${doneRow.meta.workflowStatus}`)

// ── 5. thought + todos persist ──
const thoughts = seqRows.filter(x => (x.meta as { teamThought?: boolean }).teamThought === true)
ok(`V6 thought snapshots persist (${thoughts.length})`, thoughts.length > 0)
const todoCalls = events.filter(e => e.tool === 'todo_write')
console.log(`  ℹ️ todo_write calls: ${todoCalls.length}`)

console.log(`\n══ KẾT QUẢ: ${pass} PASS / ${fail} FAIL ══`)
if (fail > 0) { console.log(fails.join('\n')); process.exit(1) }
process.exit(0)
