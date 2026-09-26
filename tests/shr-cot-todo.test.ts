// ============================================================================
// TEST SUITE — SHR + KHO MẨU CoT + TODO TREE + RunContext (Task 21 + rà soát)
// ============================================================================
// Chạy: cd /home/z/tmo-app && DATABASE_URL=file:/home/z/tmo-app/db/custom.db \
//        bun run tests/shr-cot-todo.test.ts
//
// Mục đích: test THỰC TẾ trên DB thật của app (SQLite tmo-app) + HTTP API thật
// (đường /api/tools/execute — đúng đường OpenCode CLI bridge dùng). Session test
// riêng (prefix test-shr-<ts>) → dọn sạch cuối test.
// Không phù hợp CI/Jest — đây là integration test sandbox theo yêu cầu user.
// ============================================================================

// Ép DB đúng của tmo-app — chống shell DATABASE_URL nhiễm path my-project
process.env.DATABASE_URL = 'file:/home/z/tmo-app/db/custom.db'

import {
  proposeHypothesis, recordJudgment, verifyPendingJudgments,
  compressCycleToSample, buildPriorReasoningBlock,
  parseDataScopeBlock, upsertRunContext, getRunContext,
  listHypotheses, posteriorOf, SHR_CONSTANTS, jaccard,
} from '../src/lib/structured-hypothesis'
import { todoWrite, autoCompleteRunTodosByEvidence } from '../src/lib/code-team/dev-tools'
import { db } from '../src/lib/db'

const TS = Date.now()
const SID = `test-shr-${TS}`
const RUN = `test-run-${TS}`

let pass = 0, fail = 0
const fails: string[] = []
function ok(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; fails.push(name); console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`) }
}

async function cleanup() {
  await db.todo.deleteMany({ where: { sessionId: SID } }).catch(() => null)
  await db.structuredHypothesis.deleteMany({ where: { sessionId: SID } }).catch(() => null)
  await db.cotSample.deleteMany({ where: { sessionId: SID } }).catch(() => null)
  await db.runContext.deleteMany({ where: { sessionId: SID } }).catch(() => null)
}

// ==================== A. SHR — SINH / DUPLICATE / PARROT ====================
console.log('\n━━━ A. SHR — propose / duplicate / parrot ━━━')

const r1 = await proposeHypothesis({
  sessionId: SID, agentName: 'TEST', runId: RUN,
  contextSig: 'prisma sqlite schema migration',
  intervention: 'sửa schema rồi chạy db push',
  predictedDelta: 'bảng mới xuất hiện trong sqlite_master',
  mechanicsClaim: 'prisma db push tạo bảng mới trong sqlite',
  sourceCycle: 1,
})
ok('A1 propose → created (α=0 β=0, posterior 0.5)', r1.ok && r1.kind === 'created' && r1.posterior === 0.5, JSON.stringify(r1))
ok('A2 id trả về đầy đủ (cuid)', typeof r1.id === 'string' && r1.id.length >= 20)

const r2 = await proposeHypothesis({
  sessionId: SID, contextSig: 'prisma sqlite schema migration',
  intervention: 'chạy lại db push', predictedDelta: 'bảng xuất hiện lại',
  mechanicsClaim: 'prisma db push tạo bảng mới trong sqlite',
})
ok('A3 propose trùng cơ chế → duplicate (không tạo bản sao)', r2.ok && r2.kind === 'duplicate')

const beforeParrot = await db.structuredHypothesis.count({ where: { sessionId: SID } })
const r3 = await proposeHypothesis({
  sessionId: SID,
  contextSig: 'react component state hydration browser',  // ngữ cảnh LỆCH hẳn
  intervention: 'component mount lại', predictedDelta: 'state reset',
  mechanicsClaim: 'prisma db push tạo bảng mới trong sqlite',  // cơ chế TRÙNG
})
const afterParrot = await db.structuredHypothesis.findFirst({ where: { sessionId: SID, status: 'parrot_suspect' } })
ok('A4 parrot: cơ chế trùng + ngữ cảnh lệch → flag parrot_suspect', r3.ok && r3.kind === 'parrot' && !!afterParrot, JSON.stringify(r3))

// ==================== B. λ-GROUNDED JUDGMENT + VERIFY ====================
console.log('\n━━━ B. λ-grounded judgment + verify cuối chu kỳ ━━━')

const evOk = [
  { tool: 'shell', success: true, text: 'name: User\n---\n_table: User\nsqlite_master có bảng User sau khi push' },
  { tool: 'file_read', success: false, text: 'lỗi đọc file' },
]
const j1 = await recordJudgment({
  sessionId: SID, hypothesisId: r1.id!, verdict: 'confirmed',
  evidenceTool: 'shell', evidenceQuote: 'sqlite_master có bảng User',
})
ok('B1 judge → pending (chưa áp dụng α/β)', j1.ok)
const hAfterJudge = await db.structuredHypothesis.findUnique({ where: { id: r1.id! } })
ok('B2 pendingJudgment được ghi (JSON verdict+evidence)', !!hAfterJudge?.pendingJudgment && hAfterJudge.alpha === 0)

const v1 = await verifyPendingJudgments(SID, evOk)
ok('B3 verify KHỚP bằng chứng → applied (α=1)', v1.applied.length === 1 && v1.applied[0].alpha === 1, JSON.stringify(v1.applied))
ok('B4 posterior Laplace (α+1)/(α+β+2) = 0.667', Math.abs(v1.applied[0].posterior - 2 / 3) < 0.001)
ok('B5 pendingJudgment được xóa sau verify', hAfterJudge ? !(await db.structuredHypothesis.findUnique({ where: { id: r1.id! } }))?.pendingJudgment : false)

// BỊ TỪ CHỐI — bằng chứng không khớp (chống causal parrot)
await recordJudgment({
  sessionId: SID, hypothesisId: r1.id!, verdict: 'confirmed',
  evidenceTool: 'shell', evidenceQuote: 'kết quả không hề tồn tại trong evidence',
})
const v2 = await verifyPendingJudgments(SID, evOk)
ok('B6 verify KHÔNG khớp → TỪ CHỐI (α giữ nguyên)', v2.applied.length === 0 && v2.rejected.length === 1, JSON.stringify(v2))

// SUFFIX-MATCH (fix rà soát): judge bằng id rút gọn 6 ký tự cuối
const shortId = r1.id!.slice(-6)
const jShort = await recordJudgment({
  sessionId: SID, hypothesisId: shortId, verdict: 'confirmed',
  evidenceTool: 'shell', evidenceQuote: 'sqlite_master có bảng User sau khi push',
})
ok('B7 judge bằng id RÚT GỌN (6 ký tự) → suffix-match resolve (fix mới)', jShort.ok, JSON.stringify(jShort))

// CHUẨN HÓA TÊN TOOL (fix rà soát sau E2E-2): agent đường CLI trích
// evidenceTool="tmo_shell" nhưng evidence harness ghi tên resolve "shell" —
// phải vẫn khớp (trước đây bị TỪ CHỐI oan). Test cả alias bash.
{
  const rAlias = await proposeHypothesis({
    sessionId: SID, contextSig: 'file append write filesystem io',
    intervention: 'append dòng vào file rồi đọc lại', predictedDelta: 'file có thêm dòng cuối, nội dung cũ giữ nguyên',
    mechanicsClaim: 'file_write append mode thêm cuối file không ghi đè',
  })
  ok('B8a propose hypothesis cơ chế append → created', rAlias.ok && rAlias.kind === 'created', JSON.stringify(rAlias))
  // judge với tên tool DẠNG CLI (tmo_shell) + evidence dạng resolve (shell)
  await recordJudgment({
    sessionId: SID, hypothesisId: rAlias.id!, verdict: 'confirmed',
    evidenceTool: 'tmo_shell', evidenceQuote: 'dòng 4 xuất hiện ở cuối file',
  })
  const vAlias = await verifyPendingJudgments(SID, [
    { tool: 'shell', success: true, text: 'cat notes.md → 4 dòng: a, b, c, dòng 4 xuất hiện ở cuối file' },
  ])
  ok('B8b evidenceTool "tmo_shell" khớp evidence "shell" (chuẩn hóa tên — fix E2E-2)', vAlias.applied.length === 1 && vAlias.applied[0].alpha === 1, JSON.stringify(vAlias))
  // alias native bash cũng khớp shell
  await recordJudgment({
    sessionId: SID, hypothesisId: rAlias.id!, verdict: 'confirmed',
    evidenceTool: 'bash', evidenceQuote: 'dòng 4 xuất hiện ở cuối file',
  })
  const vBash = await verifyPendingJudgments(SID, [
    { tool: 'shell', success: true, text: 'wc -l 4 — dòng 4 xuất hiện ở cuối file' },
  ])
  ok('B8c evidenceTool "bash" khớp evidence "shell" (alias native)', vBash.applied.length === 1, JSON.stringify(vBash))
}

// ==================== C. PROMOTE / DEMOTE (vòng đời công thức) ====================
console.log('\n━━━ C. Vòng đời promote/demote ━━━')

// r1 hiện α=1 (từ B3). Judge thêm 3 lần confirmed có bằng chứng → α=4 → posterior 5/6=0.833 ≥0.80 ∧ obs≥4 → promoted
for (let i = 0; i < 3; i++) {
  await recordJudgment({ sessionId: SID, hypothesisId: r1.id!, verdict: 'confirmed', evidenceTool: 'shell', evidenceQuote: 'sqlite_master có bảng User' })
  await verifyPendingJudgments(SID, evOk)
}
const hPromoted = await db.structuredHypothesis.findUnique({ where: { id: r1.id! } })
ok('C1 promote: α=4 → posterior 0.833 ≥ 0.80 → status promoted',
  hPromoted?.status === 'promoted' && hPromoted.alpha === 4 && posteriorOf(hPromoted.alpha, hPromoted.beta) >= SHR_CONSTANTS.PROMOTE_POSTERIOR,
  `status=${hPromoted?.status} α=${hPromoted?.alpha}`)

// demote: hypothesis mới + 3 lần refuted có bằng chứng → β=3 → posterior 1/5=0.2 ≤0.35 → demoted
const rDemote = await proposeHypothesis({
  sessionId: SID, contextSig: 'git branch checkout workflow',
  intervention: 'checkout nhánh không tồn tại', predictedDelta: 'lỗi fatal',
  mechanicsClaim: 'git checkout nhánh không tồn tại báo lỗi fatal',
})
for (let i = 0; i < 3; i++) {
  await recordJudgment({ sessionId: SID, hypothesisId: rDemote.id!, verdict: 'refuted', evidenceTool: 'shell', evidenceQuote: 'sqlite_master có bảng User' })
  await verifyPendingJudgments(SID, evOk)
}
const hDemoted = await db.structuredHypothesis.findUnique({ where: { id: rDemote.id! } })
ok('C2 demote: β=3 → posterior 0.2 ≤ 0.35 → status demoted',
  hDemoted?.status === 'demoted' && hDemoted.beta === 3, `status=${hDemoted?.status} β=${hDemoted?.beta}`)

// judge sau demote → bị từ chối
const jDemoted = await recordJudgment({ sessionId: SID, hypothesisId: rDemote.id!, verdict: 'confirmed', evidenceTool: 'shell', evidenceQuote: 'x' })
ok('C3 hypothesis demoted không nhận phán quyết mới', !jDemoted.ok)

// ==================== D. KHO MẨU CoT — nén / truy hồi / chuỗi ====================
console.log('\n━━━ D. Kho mẫu CoT ━━━')

const report = `Đã hoàn thành điều tra package.json.
✅ ĐÃ CHẮC CHẮN: script "dev" là next dev -p 3000 — đọc trực tiếp từ package.json, chạy thành công.
❓ CÒN CHƯA CHẮC: liệu script build có dùng turbopack hay webpack.
📐 BIÊN ĐỘ DỮ LIỆU: cần đọc /home/z/tmo-app/package.json (scripts + deps) · ngoài phạm vi: yarn.lock, node_modules.`
const ctxSig = 'package.json script next dev port'
const c1 = await compressCycleToSample({
  sessionId: SID, agentName: 'TEST', report, contextSig: ctxSig,
  posterior: 0.85, parentSampleId: null,
  bestMechanics: 'prisma db push tạo bảng mới trong sqlite',
})
ok('D1 nén báo cáo → mẩu CoT (0 model call)', c1.created && !!c1.id, JSON.stringify(c1))
const s1 = c1.id ? await db.cotSample.findUnique({ where: { id: c1.id } }) : null
ok('D2 mẩu có conclusion (dòng ✅) + sampleText 200-420 ký tự',
  !!s1 && s1.conclusion.includes('next dev') && s1.sampleText.length >= 120 && s1.sampleText.length <= 420,
  `len=${s1?.sampleText.length ?? 0}`)
ok('D3 liên kết ngược: hypothesis khớp cơ chế nhận cotRef',
  (await db.structuredHypothesis.findUnique({ where: { id: r1.id! } }))?.cotRef === c1.id)

// truy hồi — ngữ cảnh khớp
const p1 = await buildPriorReasoningBlock(SID, 'package.json next script dev port 3000')
ok('D4 truy hồi Jaccard ≥0.5 → block prior + parentSampleId', p1.block.includes('Prior reasoning') && p1.parentSampleId === c1.id && p1.matchedCount === 1, JSON.stringify(p1))
ok('D5 nhãn "may be wrong, verify" có mặt (chống parrot)', p1.block.includes('may be wrong, verify'))
const s1After = c1.id ? await db.cotSample.findUnique({ where: { id: c1.id } }) : null
ok('D6 hitCount +1 khi được truy hồi', (s1After?.hitCount ?? 0) === 1)

// truy hồi — ngữ cảnh LỆCH (không khớp)
const p2 = await buildPriorReasoningBlock(SID, 'react hydration browser component state')
ok('D7 ngữ cảnh lệch → KHÔNG truy hồi', p2.block === '' && p2.parentSampleId === null)

// CHUỖI NGUỒN GỐC — cap 3 thế hệ (chuỗi phải CÙNG cơ chế với gốc — drift check
// so con vs gốc; ở D11 verify riêng việc phát hiện drift)
const g2 = await compressCycleToSample({
  sessionId: SID, report, contextSig: ctxSig, posterior: 0.8, parentSampleId: c1.id!,
  bestMechanics: 'prisma db push tạo bảng mới trong sqlite',
})
ok('D8 sinh thế hệ 2 từ cha gen1 → created (gen=2)', g2.created, JSON.stringify(g2))
const g3 = g2.id ? await compressCycleToSample({
  sessionId: SID, report, contextSig: ctxSig, posterior: 0.7, parentSampleId: g2.id,
  bestMechanics: 'prisma db push tạo bảng mới trong sqlite',
}) : { created: false }
ok('D9 sinh thế hệ 3 từ cha gen2 → created (gen=3, tail)', g3.created)
const g4 = g3.id ? await compressCycleToSample({
  sessionId: SID, report, contextSig: ctxSig, posterior: 0.6, parentSampleId: g3.id,
  bestMechanics: 'prisma db push tạo bảng mới trong sqlite',
}) : { created: false, reason: 'no g3' }
ok('D10 gen3 = tail → TỪ CHỐI sinh thế hệ 4 (union bound)', !g4.created, JSON.stringify(g4))

// DRIFT — con rời gốc chuỗi quá xa
const rootSample = await db.cotSample.create({
  data: { sessionId: SID, contextSig: 'docker kubernetes cluster deployment', mechanics: 'kubectl rollout restart pod', conclusion: 'pod restart', sampleText: '[gen1 | ctx: docker k8s | mech: kubectl restart]', generation: 1, posterior: 0.9 },
})
const driftChild = await compressCycleToSample({
  sessionId: SID, report, contextSig: 'package.json script next dev port',
  posterior: 0.7, parentSampleId: rootSample.id, bestMechanics: 'npm script chạy next dev',
})
ok('D11 drift: con vs gốc lệch → nhánh cấm tái dùng (created=false, drifted ghi audit)',
  !driftChild.created && /drift/i.test(driftChild.reason || ''), JSON.stringify(driftChild))
const driftedRows = await db.cotSample.count({ where: { sessionId: SID, drifted: true } })
ok('D12 mẩu drifted được ghi lại để audit (drifted=true)', driftedRows >= 1)

// ==================== E. RunContext — 📐 xuyên chu kỳ ====================
console.log('\n━━━ E. RunContext (📐 biên độ dữ liệu) ━━━')

const scope = parseDataScopeBlock(report)
ok('E1 parse khối 📐 từ báo cáo', !!scope && scope.includes('package.json'), scope || '(null)')
ok('E2 upsert + đọc lại RunContext (roundtrip)',
  (await (async () => {
    await upsertRunContext({ runId: RUN, sessionId: SID, dataScope: scope, goalDigest: 'test goal', contextKeywords: ctxSig })
    const rc = await getRunContext(RUN)
    return rc?.dataScope === scope && rc?.goalDigest === 'test goal'
  })()))
const rcMissing = await getRunContext('nonexistent-run')
ok('E3 run chưa có context → null (chu kỳ 1)', rcMissing === null)

// ==================== F. TODO TREE — todoWrite + autoComplete ====================
console.log('\n━━━ F. Todo tree (todoWrite parentId) ━━━')

const tw1 = await todoWrite({
  sessionId: SID, runId: RUN, todos: [
    { content: `Điều tra package.json ${TS}`, status: 'in_progress', priority: 'high' },
  ],
}) as { success: boolean; todos: Array<{ id: string; content: string; status: string; parentId?: string | null }> }
const parentId = tw1.todos?.[0]?.id
ok('F1 tạo todo cha → có id', tw1.success && !!parentId, JSON.stringify(tw1))
ok('F2 upserted trả parentId (fix mới — null cho todo gốc)', tw1.todos?.[0]?.parentId === null || tw1.todos?.[0]?.parentId === undefined)

const tw2 = await todoWrite({
  sessionId: SID, runId: RUN, todos: [
    { content: `Đọc section scripts ${TS}`, status: 'pending', parentId },
    { content: `Đọc section dependencies ${TS}`, status: 'pending', parentId },
  ],
}) as { success: boolean; todos: Array<{ id: string; content: string; status: string; parentId?: string | null }> }
ok('F3 tạo 2 todo CON (parentId) → thành công', tw2.success && tw2.todos?.length === 2)
ok('F4 upserted con có parentId trỏ đúng cha (fix mới)',
  tw2.todos?.every(t => t.parentId === parentId) ?? false, JSON.stringify(tw2.todos?.map(t => ({ id: t.id.slice(-6), parentId: t.parentId?.slice(-6) }))))

// cập nhật 1 con → completed qua id (kỷ luật: đóng trước khi mở)
const childId = tw2.todos?.[0]?.id
const tw3 = await todoWrite({
  sessionId: SID, runId: RUN, todos: [{ id: childId!, content: `Đọc section scripts ${TS}`, status: 'completed' }],
}) as { success: boolean; todos: Array<{ id: string; content: string; status: string; parentId?: string | null }> }
ok('F5 update theo id → completed, parentId KHÔNG bị rơi (fix mới)',
  tw3.success && tw3.todos?.[0]?.status === 'completed' && tw3.todos?.[0]?.parentId === parentId,
  JSON.stringify(tw3.todos?.[0]))

// cây trong DB
const treeRows = await db.todo.findMany({ where: { sessionId: SID, runId: RUN }, orderBy: { createdAt: 'asc' } })
const children = treeRows.filter(t => t.parentId === parentId)
ok('F6 DB: 2 todo con có parentId đúng cha', children.length === 2 && treeRows.length === 3)

// autoComplete trả parentId (fix mới) — todo phải ở trạng thái in_progress
// (thiết kế bảo thủ: chỉ hoàn thành việc ĐÃ bắt tay làm)
const depTodoId = tw2.todos && tw2.todos[1] ? tw2.todos[1].id : ''
if (depTodoId) {
  await todoWrite({
    sessionId: SID, runId: RUN, todos: [{ id: depTodoId, content: `Đọc section dependencies ${TS}`, status: 'in_progress' }],
  })
}
const ac = await autoCompleteRunTodosByEvidence({
  sessionId: SID, runId: RUN,
  evidence: [`Đọc section dependencies ${TS}`],
})
const acChild = ac.todos.find(t => t.content.includes('dependencies'))
ok('F7 autoComplete hoàn thành todo in_progress theo bằng chứng + TRẢ parentId (fix mới)',
  ac.completed === 1 && acChild?.status === 'completed' && acChild?.parentId === parentId,
  `completed=${ac.completed} parentId=${acChild?.parentId?.slice(-6) ?? 'MISSING'}`)

// ==================== G. HTTP API — đường OpenCode CLI bridge ====================
console.log('\n━━━ G. HTTP /api/tools/execute (đường CLI bridge thật) ━━━')

// Lấy token auth (proxy yêu cầu)
const setupRes = await fetch('http://localhost:3000/api/auth/setup', { credentials: 'same-origin' })
const setupData = await setupRes.json().catch(() => null) as { token?: string } | null
const token = setupData?.token
ok('G1 /api/auth/setup trả token', !!token)

const apiCall = async (tool: string, args: Record<string, unknown>) => {
  const res = await fetch('http://localhost:3000/api/tools/execute', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-tmo-api-token': token || '' },
    body: JSON.stringify({ tool, args, context: { agentName: 'opencode-bridge', sessionId: SID, runId: RUN } }),
  })
  return res.json().catch(() => null) as { success?: boolean; result?: unknown } | null
}

// hypothesis_write qua HTTP (đúng đường tmo_hypothesis bridge)
const g2res = await apiCall('hypothesis_write', {
  op: 'propose',
  mechanicsClaim: 'bun run script khai báo trong package.json',
  contextSig: 'bun package.json script runner',
  intervention: 'chạy bun run dev',
  predictedDelta: 'next dev khởi động port 3000',
})
const g2result = g2res?.result as { success?: boolean; kind?: string; id?: string } | undefined
ok('G2 hypothesis_write op=propose qua HTTP → created', g2res?.success === true && g2result?.kind === 'created', JSON.stringify(g2res?.result))

const g3res = await apiCall('hypothesis_write', { op: 'list' })
const g3result = g3res?.result as { total?: number; hypotheses?: Array<{ id: string; mechanicsClaim: string }> } | undefined
ok('G3 hypothesis_write op=list qua HTTP → thấy hypothesis vừa tạo',
  g3res?.success === true && (g3result?.total ?? 0) >= 1, `total=${g3result?.total}`)

// todo_write qua HTTP với parentId (đúng đường tmo_todo bridge)
const g4res = await apiCall('todo_write', {
  todos: [{ content: `Việc qua HTTP bridge ${TS}`, status: 'pending', parentId }],
})
const g4result = g4res?.result as { success?: boolean; todos?: Array<{ id: string; parentId?: string | null }> } | undefined
ok('G4 todo_write qua HTTP với parentId → lưu đúng cha (context stamping sessionId+runId)',
  g4res?.success === true && g4result?.todos?.[0]?.parentId === parentId, JSON.stringify(g4res?.result))

const viaHttp = await db.todo.findFirst({ where: { sessionId: SID, runId: RUN, content: `Việc qua HTTP bridge ${TS}` } })
ok('G5 todo qua HTTP gắn ĐÚNG sessionId + runId từ context (context-merge)',
  !!viaHttp && viaHttp.runId === RUN && viaHttp.parentId === parentId)

// ==================== TỔNG KẾT ====================
console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
console.log(`KẾT QUẢ: ${pass} PASS · ${fail} FAIL / ${pass + fail} test`)
if (fail > 0) {
  console.log('FAIL chi tiết:')
  for (const f of fails) console.log(`  ❌ ${f}`)
}
await cleanup()
console.log(`\n🧹 Đã dọn sạch dữ liệu test (session ${SID})`)
await db.$disconnect()
process.exit(fail > 0 ? 1 : 0)
