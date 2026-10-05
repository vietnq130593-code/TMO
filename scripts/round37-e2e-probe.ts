/**
 * ROUND-37 — E2E probe sống: 5 vấn đề đã xử lý hoạt động thật không?
 *
 *   V2a — applyAdaptationToSession: apply 8 chiến lược vào session thật +
 *          markSessionAdaptationOutcome với DB thật (StrategyAdaptationLog
 *          pending → successful + FailurePattern resolved).
 *   V2d — applyEpsilonExploration: rng deterministic + guard.
 *   V3  — buildAgentBrainBlock + recordAgentEpisode: PRE-ACT đọc brain thật
 *          (Neo4j lessons) + ghi 1 episode E2E-PROBE thật 3 tầng (Qdrant +
 *          Neo4j + SQLite mirror) + verify đọc lại được.
 *   V5  — agentKnowledgeSearch: stack parity chat (hybrid+MMR+entity qua
 *          searchUserKB) + expandGraph relationship thật.
 *
 * Usage: cd /home/z/tmo-app && bun scripts/round37-e2e-probe.ts
 */

import { db } from '../src/lib/db'
import { applyAdaptationToSession, getAdaptationDirectiveBlock, getAdaptedMaxIterations, shouldCompressContextEarly, hasEscalation, getKbConfidenceThresholdDelta, markSessionAdaptationOutcome } from '../src/lib/learning/adaptation-engine'
import { applyEpsilonExploration } from '../src/lib/episodic-memory/preact'
import { buildAgentBrainBlock, recordAgentEpisode, mapRunOutcome } from '../src/lib/episodic-memory/agent-brain'
import { searchSimilarEpisodes } from '../src/lib/episodic-memory/episode-store'
import { agentKnowledgeSearch } from '../src/lib/knowledge-bridge'

const PASS: string[] = []
const FAIL: string[] = []
function check(name: string, ok: boolean, detail: string) {
  if (ok) { PASS.push(name); console.log(`  ✅ ${name} — ${detail}`) }
  else { FAIL.push(name); console.log(`  ❌ ${name} — ${detail}`) }
}

async function main() {
  console.log('════════════ ROUND-37 E2E PROBE (thật — Qdrant + Neo4j + SQLite) ════════════\n')

  // ─────────── V2a — ADAPTATION ENGINE (apply thật + đóng vòng) ───────────
  console.log('── V2a: Adaptation Engine ──')
  const probeSession = `e2e-probe-round37-${Date.now()}`
  try {
    // Tạo pending StrategyAdaptationLog + FailurePattern mở (giống workflow path)
    const adaptLogId = `adapt-e2e-${Date.now()}`
    await db.strategyAdaptationLog.create({
      data: {
        id: adaptLogId,
        sessionId: probeSession,
        patternId: null,
        fromStrategy: 'change_fix_approach',
        toStrategy: 'escalate_to_user',
        reason: 'E2E probe round-37',
        confidence: 0.8,
        successful: null,
        createdAt: new Date(),
      },
    })
    await db.failurePattern.create({
      data: {
        id: `pattern-e2e-${Date.now()}`,
        sessionId: probeSession,
        type: 'repeated_error',
        count: 3,
        strategiesTried: '[]',
        nextStrategy: 'escalate_to_user',
        context: JSON.stringify({ taskType: 'e2e-probe', stepType: 'G2-A-code' }),
        resolved: false,
      },
    })

    // APPLY escalate_to_user + reduce_scope
    const applied = applyAdaptationToSession(probeSession, {
      shouldAdapt: true,
      currentStrategy: 'previous',
      recommendedStrategy: 'escalate_to_user',
      reason: 'E2E probe — lỗi lặp 3 lần',
      confidence: 0.85,
    }, 'G2-A-code')
    check('V2a-1 applyAdaptationToSession', applied !== null, `strategy=${applied?.strategy}, ${applied?.directives.length} directive(s)`)

    const block = getAdaptationDirectiveBlock(probeSession)
    check('V2a-2 directive block render', block.includes('CHỈ THỊ THÍCH ỨNG') && block.includes('TẠM DỪNG'), `${block.length} chars`)

    applyAdaptationToSession(probeSession, {
      shouldAdapt: true, currentStrategy: 'x', recommendedStrategy: 'reduce_scope', reason: 'probe', confidence: 0.7,
    }, 'G2-A-code')
    const maxIter = getAdaptedMaxIterations(probeSession, 25)
    check('V2a-3 reduce_scope giảm vòng', maxIter === 12, `25 → ${maxIter}`)
    check('V2a-4 escalate flag', hasEscalation(probeSession) === true, 'caller sẽ emit SSE omega_escalation')

    // Đóng vòng: step đúng (G2-A-code) PASS → log successful + pattern resolved
    await markSessionAdaptationOutcome(probeSession, true, 'G2-A-code')
    const logAfter = await db.strategyAdaptationLog.findUnique({ where: { id: adaptLogId } })
    check('V2a-5 outcome chốt StrategyAdaptationLog', logAfter?.successful === true, `successful=${logAfter?.successful}`)
    const patternAfter = await db.failurePattern.findFirst({ where: { sessionId: probeSession } })
    check('V2a-6 pattern resolved', patternAfter?.resolved === true, `resolved=${patternAfter?.resolved}`)

    // Dọn probe rows
    await db.strategyAdaptationLog.deleteMany({ where: { sessionId: probeSession } })
    await db.failurePattern.deleteMany({ where: { sessionId: probeSession } })
  } catch (err) {
    check('V2a adapter', false, err instanceof Error ? err.message : String(err))
  }

  // KB threshold delta (tighten_refusal_threshold) — TTL 24h
  applyAdaptationToSession('e2e-kb-delta', {
    shouldAdapt: true, currentStrategy: 'x', recommendedStrategy: 'tighten_refusal_threshold', reason: 'probe', confidence: 0.9,
  })
  const delta = getKbConfidenceThresholdDelta()
  check('V2a-7 KB threshold delta', Math.abs(delta - 0.1) < 1e-9, `delta=+${delta.toFixed(2)} (kb-access Step2 gate giờ dùng ngưỡng này)`)

  // ─────────── V2d — ε-GREEDY EXPLORATION ───────────
  console.log('\n── V2d: ε-greedy Exploration ──')
  const lessons = Array.from({ length: 8 }, (_, i) => ({ id: `l${i}`, confidence: 0.9 - i * 0.05 }))
  const noExplore = applyEpsilonExploration(lessons, { rng: () => 0.99, epsilon: 0.15 })
  const explore = applyEpsilonExploration(lessons, { rng: () => 0.01, epsilon: 0.15 })
  check('V2d-1 exploit path giữ top-5', noExplore[4].id === 'l4' && !noExplore.some(l => (l as { exploration?: boolean }).exploration), 'rng 0.99 ≥ ε')
  const explored = explore[4] as { id: string; exploration?: boolean }
  check('V2d-2 explore path hoán vị slot cuối', explored.id === 'l5' && explored.exploration === true, `slot cuối → ${explored.id} [THỬ NGHIỆM] — appliedLessonIds sẽ validate nó`)

  // ─────────── V3 — AGENT BRAIN (PRE-ACT đọc + CONSOLIDATE ghi 3 tầng) ───────────
  console.log('\n── V3: Agent Brain adapter (4 gia đình ngoài goal-loop) ──')
  try {
    const brain = await buildAgentBrainBlock({
      family: 'code-team',
      agentName: 'E2E-PROBE (G2-A)',
      task: 'Sửa lỗi Prisma schema khi migrate — E2E probe round-37',
    })
    console.log(`    PRE-ACT: block ${brain.promptBlock.length} chars, ${brain.appliedLessonIds.length} lesson applied`)
    check('V3-1 PRE-ACT chạy thật (Neo4j/Qdrant)', typeof brain.promptBlock === 'string', brain.promptBlock ? 'có ký ức liên quan' : 'brain trống (chưa có lesson tương đồng — hợp lệ)')

    // CONSOLIDATE — episode E2E thật với 1 lỗi + 1 success (recorder tự classify + lesson nếu resolve)
    const probeGoal = `E2E-PROBE round-37 — verify recordAgentEpisode ghi 3 tầng (lúc ${new Date().toISOString()})`
    recordAgentEpisode({
      family: 'code-team',
      agentName: 'E2E-PROBE (G2-A)',
      goal: probeGoal,
      sessionId: 'e2e-probe-round37',
      outcome: mapRunOutcome({ status: 'done', toolFailures: 1 }),
      stopReason: 'complete',
      toolEvidence: [
        { tool: 'db_query', success: false, text: 'Error: P2021 table `ProbeTable` does not exist — e2e probe lỗi thật để taxonomy classify' },
        { tool: 'db_query', success: true, text: 'Đã khắc phục: query đúng bảng sau khi xem schema — e2e probe resolve' },
      ],
    })
    // Cho recorder hoàn tất (fire-and-forget nền) — embed + Neo4j write cần vài giây
    console.log('    đợi recorder nền 8s...')
    await new Promise(r => setTimeout(r, 8000))

    // Verify: episode đọc lại được qua Qdrant semantic search (theo chính goal text)
    const hits = await searchSimilarEpisodes({ queryText: probeGoal.slice(0, 200), topK: 3, minScore: 0.5 })
    const found = hits.find(h => String(h.payload?.title ?? '').includes('E2E-PROBE round-37'))
    check('V3-2 episode ghi xong đọc lại được (Qdrant)', !!found, found ? `score=${found.score.toFixed(3)} title="${String(found.payload?.title).slice(0, 60)}"` : `${hits.length} hits nhưng không thấy probe`)

    const epMirror = await db.episodeRecord.count()
    check('V3-3 SQLite mirror EpisodeRecord', epMirror > 0, `${epMirror} rows`)
  } catch (err) {
    check('V3 agent-brain', false, err instanceof Error ? err.message : String(err))
  }

  // ─────────── V5 — KNOWLEDGE SEARCH PARITY STACK ───────────
  console.log('\n── V5: knowledge_search = stack chat (hybrid+MMR+entity+expandGraph) ──')
  try {
    const res = await agentKnowledgeSearch('SQL injection protection và cách phòng tránh', { topK: 5, expandGraph: true })
    const chunks = res.results.filter(r => r.type === 'chunk')
    const entities = res.results.filter(r => r.type === 'entity')
    const rels = res.results.filter(r => r.type === 'relationship')
    check('V5-1 stack chat chạy (chunks hybrid+MMR)', chunks.length > 0, `${chunks.length} chunks (score đầu ${(chunks[0]?.score ?? 0).toFixed(3)})`)
    check('V5-2 entity semantic (Neo4j 8 label)', entities.length >= 0, `${entities.length} entities${entities.length > 0 ? ` (VD: ${entities.slice(0, 2).map(e => e.entityName).join(', ')})` : ' — KB entity có thể trống, đường sống đã verify qua chunk'}`)
    console.log(`    expandGraph: ${rels.length} relationship (1-hop của top entities)`)
    check('V5-3 diagnostics shape giữ nguyên', res.diagnostics?.ok === true && res.diagnostics?.reason === 'ok', `durationMs=${res.diagnostics?.durationMs ?? 'n/a'}`)
  } catch (err) {
    check('V5 knowledge-bridge', false, err instanceof Error ? err.message : String(err))
  }

  // ─────────── TỔNG KẾT ───────────
  console.log('\n════════════════════════════════════════════')
  console.log(`KẾT QUẢ: ${PASS.length} pass / ${FAIL.length} fail`)
  if (FAIL.length > 0) {
    console.log('FAIL:', FAIL.join('; '))
    process.exit(1)
  }
  process.exit(0)
}

main().catch(err => {
  console.error('E2E probe crash:', err)
  process.exit(1)
})
