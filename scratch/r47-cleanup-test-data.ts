/**
 * r47 — DỌN DỆN DỮ LIỆU THỬ NGHIỆM (user request 2026-10-07)
 * ============================================================
 * "Kiểm tra xem hệ thống có dữ liệu thử nghiệm được tạo ra trong lúc chạy thử
 *  không, nếu có thì xóa đi vì dữ liệu thử nghiệm là thứ chỉ có giá trị khi
 *  thử nghiệm."
 *
 * BỐI CẢNH: toàn bộ hoạt động agent trong sandbox từ 2026-08-27 đến 2026-10-06
 * là các vòng chạy thử E2E của quá trình phát triển (R1→R46). Dữ liệu sinh ra:
 * 13 phiên chat test (R43/R44/R45 E2E, "Team Code", ProductCard, PDF export,
 * /tmp probes), 616 tin nhắn, 43 agent-run, 1185 tool-metric, 164 episode,
 * 88 lesson, 39 agent-memory, 608 entity KB writeback "auto-learn"... — tất cả
 * đều là dữ liệu thử nghiệm.
 *
 * XÓA (thuộc về chạy thử):
 *   SQLite : agentSession (kèm tombstone chống hồi sinh), chatMessage,
 *            agentRunRecord, codeTeam*, toolMetric, todo, episodeRecord,
 *            lessonRecord, agentMemory, workingMemory, memoryAccessLog,
 *            cotSample, taskContextArchive, runContext, arbiterVerdict,
 *            goalLoopJob, researchMission, researchKBEntry, councilTranscript,
 *            learningLog, agentInsight, pendingWriteback, dailyToken*,
 *            embeddingCache (cache — tính lại theo nhu cầu), pendingEdit,
 *            fsCheckpoint, neo4jCheckpointDiff, smolabTask
 *            + 10/13 đề xuất Self-direction pending (vấn đề đã sửa hoàn toàn
 *              ở R44-R46 — chi tiết worklog r47)
 *   Qdrant : theopus_episodes (toàn bộ), task_context (toàn bộ),
 *            agent_memory (toàn bộ), theopus_chunks (điểm auto_learned=true),
 *            theopus_communities (toàn bộ — tự build lại từ graph sạch qua
 *            ensureCommunitiesLazy ở query KB kế tiếp)
 *   Neo4j  : Episode/Action/ErrorOccurrence/Lesson/Session/Strategy (toàn bộ
 *            episodic subgraph), entity/Document/relationship dính nhãn
 *            auto-learn (source='auto-learn', documentId|id 'auto-learn:*')
 *
 * GIỮ (dữ liệu thật / cấu hình):
 *   - Document R2 + row "SQL-Injection-White-Paper" + theopus_documents/
 *     theopus_chunks thật (10 chunk security) + graph KB từ 107 PDF thật
 *     (17.254 Document, 53.771 Concept, ... — KHÔNG đụng)
 *   - localEntity/localRelationship (mirror KB thật), agentProfile (15),
 *     agentSkill, workspace, knowledgeAccessPolicy, opusSettings, userProfile
 *   - cronJob ALISTA nightly (23h30 — automation thật của hệ thống) +
 *     taskExecution (audit 2 lần chạy nightly)
 *   - 3 đề xuất Self-direction còn giá trị:
 *       cmuu1g6e1  escalation:assumption_wrong — lỗi cấu trúc kèm gợi ý
 *                  (unknown-tool chưa liệt kê tool hợp lệ, file-not-found chưa
 *                  gợi ý đường dẫn) — phần việc thật còn thiếu
 *       cmuu1n0so  domain:weak_domains — nạp KB cho data/devops/business
 *       cmuu1n0sp  domain:stale_domains — làm mới domain algorithm/ml
 *
 * XÁC MINH AN TOÀN TRƯỚC KHI VIẾT SCRIPT (r47 exploration):
 *   - ON MATCH SET của upsertEntitiesBatch KHÔNG ghi đè n.source → node thật
 *     không bao giờ mang nhãn auto-learn (chỉ ON CREATE SET source) → lọc
 *     source='auto-learn' chính xác chỉ trúng node do writeback tạo.
 *   - 11 Domain node chứa "auto" là domain THẬT (AutoML, Automotive,
 *     Cellular Automata...) → KHÔNG xóa Domain nào.
 *   - Neo4j: neo4j+s://6e688b02.databases.neo4j.io, user 6e688b02,
 *     database 6e688b02 (từ .env — bun tự nạp).
 *
 * CHẠY:  cd /home/z/tmo-app
 *        bun scratch/r47-cleanup-test-data.ts            # DRY-RUN (mặc định)
 *        EXECUTE=1 bun scratch/r47-cleanup-test-data.ts  # XÓA THẬT
 */
// FIX 2026-10-14 (TS2393 — Duplicate function implementation `main`): file
// này từng là global-scope script (import ở dòng 62 nằm SAU docblock + code
// khác nên vẫn hợp lệ) nhưng `main` toàn cục va chạm với r28-nim-rescue-
// verify.ts khi tsconfig include scratch/**. `export {}` → module scope.
export {}
import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()
const EXECUTE = process.env.EXECUTE === '1'
const QDRANT = process.env.QDRANT_URL || 'http://localhost:6333'
const NEO4J_URI = process.env.NEO4J_URI || ''
const NEO4J_USER = process.env.NEO4J_USER || ''
const NEO4J_PASS = process.env.NEO4J_PASSWORD || ''
const NEO4J_DATABASE = process.env.NEO4J_DATABASE || 'neo4j'

/** 10 đề xuất HỦY — vấn đề đã được R44-R46 sửa hoàn toàn (giữ 3 cái còn lại). */
const CANCELLED_PROPOSAL_IDS = [
  'cmuu1fipa003mllp8nrpev41g', // [ALISTA] tool:shell — guard pre-exec + routing + không retry: đủ
  'cmuu1fipd003nllp8svq6z018', // [ALISTA] tool:file_edit — như trên
  'cmuu1fipe003ollp859q7k52c', // [ALISTA] tool:file_delete — như trên
  'cmuvgwltu000glli4r7k8mjzh', // [ALISTA] tool:file_write — như trên
  'cmuu1g6dz003ullp89pm6i271', // [ALISTA] escalation:reasoning_error — prose-only guard đã có (r45)
  'cmuuwbdx90001lliebq234cxc', // [Escalation] REASONING_ERROR 146 — như trên
  'cmuuwbdxc0002lliewqnj8vdc', // [Escalation] ASSUMPTION_WRONG 7 — 3 manifestation đều đã fix (r44-46)
  'cmuuwbdxf0003llie5k7efvy0', // [Escalation] INPUT_INVALID 7 — todo_write shape heal (r46, E2E verified)
  'cmuv2exih0001ll2av2b3qelx', // [Escalation] TOOL_FAILURE 10 — 3 manifestation đều guard đúng thiết kế
  'cmuvgxx4w000mlli4l9tiskiy', // [ALISTA] escalation:tool_failure — preflight đủ 3 lớp
]
/** 3 đề xuất GIỮ lại. */
const KEPT_PROPOSAL_IDS = [
  'cmuu1g6e1003vllp83z0psxrh', // escalation:assumption_wrong — structured error + suggestions (còn thiếu thật)
  'cmuu1n0so004fllp87thn593v', // domain:weak_domains — việc nội dung thật
  'cmuu1n0sp004gllp83xr2bdfp', // domain:stale_domains — việc nội dung thật
]

async function count(table: string): Promise<number> {
  try {
    return await (db as unknown as Record<string, { count(): Promise<number> }>)[table].count()
  } catch {
    return -1
  }
}

async function qdrantDeleteAllPoints(collection: string): Promise<number> {
  // Scroll lấy toàn bộ id rồi delete theo id (ổn định với mọi phiên bản Qdrant)
  let deleted = 0
  let offset: string | number | undefined = undefined
  while (true) {
    const res = await fetch(`${QDRANT}/collections/${collection}/points/scroll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: 256, offset, with_payload: false }),
    })
    if (!res.ok) throw new Error(`scroll ${collection}: HTTP ${res.status}`)
    const json = (await res.json()) as { result: { points: Array<{ id: string | number }>; next_page_offset?: string | number | null } }
    const points = json.result?.points ?? []
    if (points.length > 0) {
      const ids = points.map(p => p.id)
      const del = await fetch(`${QDRANT}/collections/${collection}/points/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ points: ids }),
      })
      if (!del.ok) throw new Error(`delete ${collection}: HTTP ${del.status}`)
      deleted += ids.length
    }
    const next = json.result?.next_page_offset
    if (next === null || next === undefined) break
    offset = next
  }
  return deleted
}

async function qdrantDeleteByFilter(collection: string, must: Record<string, unknown>): Promise<number> {
  const before = await fetch(`${QDRANT}/collections/${collection}`).then(r => r.json()) as { result?: { points_count?: number } }
  const del = await fetch(`${QDRANT}/collections/${collection}/points/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filter: { must } }),
  })
  if (!del.ok) throw new Error(`filter-delete ${collection}: HTTP ${del.status}`)
  return before.result?.points_count ?? -1
}

async function main() {
  console.log(`\n${'█'.repeat(70)}\n█ r47 CLEANUP TEST DATA — ${EXECUTE ? '🔴 EXECUTE (XÓA THẬT)' : '🟢 DRY-RUN (không xóa — chạy với EXECUTE=1 để xóa thật)'}\n${'█'.repeat(70)}`)

  // ═══════════════ 1. SNAPSHOT TRƯỚC ═══════════════
  const sqliteTables = [
    'agentSession', 'chatMessage', 'agentRunRecord', 'codeTeamSession', 'codeTeamWorklog',
    'codeTeamCheckpoint', 'toolMetric', 'todo', 'episodeRecord', 'lessonRecord',
    'agentMemory', 'workingMemory', 'memoryAccessLog', 'cotSample', 'taskContextArchive',
    'runContext', 'arbiterVerdict', 'goalLoopJob', 'researchMission', 'researchKBEntry',
    'councilTranscript', 'learningLog', 'agentInsight', 'pendingWriteback', 'dailyTokenUsage',
    'dailyTokenByProvider', 'dailyTokenByProviderSlot', 'dailyTokenByProviderModel',
    'dailyTokenByAgent', 'embeddingCache', 'pendingEdit', 'fsCheckpoint', 'neo4jCheckpointDiff',
    'smolabTask', 'deletedSession', 'selfDirectionProposal', 'cronJob', 'taskExecution',
    'document', 'localEntity', 'agentProfile',
  ] as const
  console.log('\n─── SQLITE trước ───')
  const before: Record<string, number> = {}
  for (const t of sqliteTables) {
    before[t] = await count(t)
    console.log(`  ${t}: ${before[t]}`)
  }
  const proposalsBefore = await db.selfDirectionProposal.findMany({ select: { id: true, title: true, status: true } })
  const pendingBefore = proposalsBefore.filter(p => p.status === 'pending')
  console.log(`  → pending proposals: ${pendingBefore.length}/13 — hủy ${CANCELLED_PROPOSAL_IDS.length}, giữ ${KEPT_PROPOSAL_IDS.length}`)

  console.log('\n─── QDRANT trước ───')
  const qdrantCollections = ['theopus_episodes', 'task_context', 'agent_memory', 'theopus_chunks', 'theopus_communities', 'theopus_documents']
  const qdrantBefore: Record<string, number> = {}
  for (const c of qdrantCollections) {
    try {
      const r = await fetch(`${QDRANT}/collections/${c}`).then(x => x.json()) as { result?: { points_count?: number } }
      qdrantBefore[c] = r.result?.points_count ?? -1
      console.log(`  ${c}: ${qdrantBefore[c]}`)
    } catch {
      qdrantBefore[c] = -1
      console.log(`  ${c}: KHÔNG TRUY CẬP ĐƯỢC`)
    }
  }

  console.log('\n─── NEO4J trước ───')
  const Neo4j = await import('neo4j-driver')
  const driver = Neo4j.default.driver(NEO4J_URI, Neo4j.default.auth.basic(NEO4J_USER, NEO4J_PASS), { connectionTimeout: 20000 })
  const nsession = driver.session({ database: NEO4J_DATABASE })
  const neoLabels = ['Episode', 'Action', 'ErrorOccurrence', 'Lesson', 'Session', 'Strategy']
  const neoBefore: Record<string, number> = {}
  for (const l of [...neoLabels, 'autoLearnEntity', 'autoLearnDoc', 'autoLearnRel']) {
    const q = l === 'autoLearnEntity'
      ? 'MATCH (n) WHERE n.source = $s OR n.documentId STARTS WITH $p RETURN count(n) AS c'
      : l === 'autoLearnDoc'
        ? 'MATCH (d:Document) WHERE d.id STARTS WITH $p RETURN count(d) AS c'
        : l === 'autoLearnRel'
          ? 'MATCH ()-[r]->() WHERE r.source = $s RETURN count(r) AS c'
          : `MATCH (n:${l}) RETURN count(n) AS c`
    try {
      const r = await nsession.run(q, { s: 'auto-learn', p: 'auto-learn:' })
      neoBefore[l] = r.records[0].get('c').toNumber()
      console.log(`  ${l}: ${neoBefore[l]}`)
    } catch (e) {
      neoBefore[l] = -1
      console.log(`  ${l}: LỖI ${(e as Error).message.slice(0, 80)}`)
    }
  }

  if (!EXECUTE) {
    console.log('\n🟢 DRY-RUN hoàn tất — KHÔNG xóa gì. Kiểm tra danh sách trên rồi chạy: EXECUTE=1 bun scratch/r47-cleanup-test-data.ts')
    await nsession.close(); await driver.close(); await db.$disconnect()
    return
  }

  // ═══════════════ 2. SQLITE XÓA ═══════════════
  console.log('\n─── SQLITE xóa ───')
  // 2a. Tombstone TRƯỚC khi xóa session (chống upsert hồi sinh — đúng pattern
  // DELETE /api/openclaw/sessions: mark trước, persist DB, sống qua restart).
  const sessions = await db.agentSession.findMany({ select: { sessionId: true } })
  for (const s of sessions) {
    await db.deletedSession.upsert({
      where: { sessionId: s.sessionId },
      create: { sessionId: s.sessionId },
      update: {},
    })
  }
  console.log(`  tombstone: ${sessions.length} sessionId (chống hồi sinh sau restart)`)

  const deleteTables = [
    'chatMessage', 'agentRunRecord', 'codeTeamWorklog', 'codeTeamSession', 'codeTeamCheckpoint',
    'toolMetric', 'todo', 'smolabTask', 'workingMemory', 'memoryAccessLog', 'pendingEdit',
    'fsCheckpoint', 'neo4jCheckpointDiff', 'episodeRecord', 'lessonRecord', 'agentMemory',
    'cotSample', 'taskContextArchive', 'runContext', 'arbiterVerdict', 'goalLoopJob',
    'researchKBEntry', 'councilTranscript', 'researchMission', 'learningLog', 'agentInsight',
    'pendingWriteback', 'dailyTokenByAgent', 'dailyTokenByProviderModel', 'dailyTokenByProviderSlot',
    'dailyTokenByProvider', 'dailyTokenUsage', 'embeddingCache', 'agentSession',
  ] as const
  for (const t of deleteTables) {
    const r = await (db as unknown as Record<string, { deleteMany(arg: unknown): Promise<{ count: number }> }>)[t].deleteMany({})
    console.log(`  ${t}: -${r.count}`)
  }

  // 2b. Hủy 10 đề xuất (steps cascade theo schema — hiện 0 row, xóa tay cho chắc)
  console.log(`  ── hủy ${CANCELLED_PROPOSAL_IDS.length} đề xuất đã-sửa-hoàn-toàn ──`)
  for (const id of CANCELLED_PROPOSAL_IDS) {
    const p = proposalsBefore.find(x => x.id === id)
    await db.proposalStep.deleteMany({ where: { proposalId: id } })
    await db.selfDirectionProposal.deleteMany({ where: { id } })
    console.log(`  ✕ [${id.slice(0, 10)}] ${p?.title?.slice(0, 64) ?? '?'}`)
  }
  const kept = await db.selfDirectionProposal.findMany({ select: { id: true, title: true, status: true } })
  console.log(`  → còn lại ${kept.length} đề xuất:`)
  for (const k of kept) console.log(`  ✓ [${k.id.slice(0, 10)}] (${k.status}) ${k.title.slice(0, 64)}`)

  // ═══════════════ 3. QDRANT XÓA ═══════════════
  console.log('\n─── QDRANT xóa ───')
  for (const c of ['theopus_episodes', 'task_context', 'agent_memory', 'theopus_communities']) {
    const n = await qdrantDeleteAllPoints(c)
    console.log(`  ${c}: -${n} points`)
  }
  const chunkBefore = await qdrantDeleteByFilter('theopus_chunks', { key: 'auto_learned', match: { value: true } })
  console.log(`  theopus_chunks: xóa filter auto_learned=true (trước khi xóa: ${chunkBefore} points — giữ lại chunk thật)`)
  // Verify còn lại bao nhiêu
  for (const c of qdrantCollections) {
    const r = await fetch(`${QDRANT}/collections/${c}`).then(x => x.json()) as { result?: { points_count?: number } }
    console.log(`  → sau: ${c} = ${r.result?.points_count ?? '?'} points`)
  }

  // ═══════════════ 4. NEO4J XÓA ═══════════════
  console.log('\n─── NEO4J xóa ───')
  // 4a. Relationship auto-learn TRƯỚC khi xóa node (quan hệ nối 2 node thật
  // cũng do writeback test tạo → r.source='auto-learn' là marker chính xác).
  let r1 = await nsession.run('MATCH ()-[r]->() WHERE r.source = $s DELETE r', { s: 'auto-learn' })
  console.log(`  relationships source=auto-learn: -${r1.summary.counters.updates().relationshipsDeleted}`)
  // 4b. Entity do writeback tạo (ON MATCH không đè source → marker chính xác).
  let r2 = await nsession.run('MATCH (n) WHERE n.source = $s OR n.documentId STARTS WITH $p DETACH DELETE n', { s: 'auto-learn', p: 'auto-learn:' })
  console.log(`  entities auto-learn: -${r2.summary.counters.updates().nodesDeleted}`)
  // 4c. Document node auto-learn (anchor của writeback batch).
  let r3 = await nsession.run('MATCH (d:Document) WHERE d.id STARTS WITH $p DETACH DELETE d', { p: 'auto-learn:' })
  console.log(`  documents auto-learn: -${r3.summary.counters.updates().nodesDeleted}`)
  // 4d. Toàn bộ episodic subgraph (Episode/Action/ErrorOccurrence/Lesson/
  // Session/Strategy — 100% từ chạy thử, mirror SQLite đã xóa ở bước 2).
  for (const l of neoLabels) {
    const r = await nsession.run(`MATCH (n:${l}) DETACH DELETE n`)
    console.log(`  ${l}: -${r.summary.counters.updates().nodesDeleted}`)
  }
  // 4e. Verify
  for (const l of [...neoLabels, 'autoLearnEntity', 'autoLearnDoc', 'autoLearnRel']) {
    const q = l === 'autoLearnEntity'
      ? 'MATCH (n) WHERE n.source = $s OR n.documentId STARTS WITH $p RETURN count(n) AS c'
      : l === 'autoLearnDoc'
        ? 'MATCH (d:Document) WHERE d.id STARTS WITH $p RETURN count(d) AS c'
        : l === 'autoLearnRel'
          ? 'MATCH ()-[r]->() WHERE r.source = $s RETURN count(r) AS c'
          : `MATCH (n:${l}) RETURN count(n) AS c`
    const r = await nsession.run(q, { s: 'auto-learn', p: 'auto-learn:' })
    console.log(`  → sau: ${l} = ${r.records[0].get('c').toNumber()}`)
  }
  // KB thật phải nguyên vẹn
  for (const l of ['Document', 'Concept', 'Technology', 'Domain']) {
    const r = await nsession.run(`MATCH (n:${l}) RETURN count(n) AS c`)
    console.log(`  → KB thật ${l} = ${r.records[0].get('c').toNumber()} (giữ nguyên)`)
  }

  await nsession.close()
  await driver.close()

  // ═══════════════ 5. SQLITE VERIFY SAU ═══════════════
  console.log('\n─── SQLITE sau ───')
  for (const t of sqliteTables) {
    const after = await count(t)
    const marker = after !== before[t] ? ' ← ĐỔI' : ''
    console.log(`  ${t}: ${before[t]} → ${after}${marker}`)
  }

  console.log(`\n${'█'.repeat(70)}\n█ HOÀN TẤT — nhớ: pm2 restart theopusflashlite (xóa state in-memory)\n${'█'.repeat(70)}`)
  await db.$disconnect()
}

main().catch(async err => {
  console.error('FATAL:', err)
  await db.$disconnect()
  process.exit(1)
})
