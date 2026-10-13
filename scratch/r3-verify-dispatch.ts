import { db } from '/home/z/tmo-app/src/lib/db'
import { applyOpusVerdict } from '/home/z/tmo-app/src/lib/opus/pipeline'
import type { OpusVerdict } from '/home/z/tmo-app/src/lib/opus/types'

const TEST_SESSION = 'sess_r3_dispatch_test'

async function main() {
  // 1. Tạo test session gắn agent = OPUS (tái hiện đúng tình huống bug: session
  //    agent là Opus + delegation nhắc tên Opus — trước fix, job sẽ chạy với
  //    Opus làm executor. Sau fix: Opus bị loại khỏi delegatee match, không
  //    agent nào khác khớp (chỉ nhắc Opus) → R3-02 guard re-route Omega.
  const opus = await db.agentProfile.findUniqueOrThrow({ where: { name: 'Opus' }, select: { id: true, name: true } })
  const omega = await db.agentProfile.findUniqueOrThrow({ where: { name: 'Omega' }, select: { id: true, name: true } })
  await db.agentSession.upsert({
    where: { sessionId: TEST_SESSION },
    create: { sessionId: TEST_SESSION, title: 'R3-02 dispatch test', agentProfileId: opus.id, messageCount: 0 },
    update: { agentProfileId: opus.id },
  })
  console.log(`Session test gắn agent: Opus (trước fix — đây chính là nguồn bug R3-02)`)

  const verdict: OpusVerdict = {
    decision: 'FIX',
    summary: 'Test R3-02: delegation chỉ nhắc Opus (mô tả quy trình) — không được rơi vào Opus thi công.',
    axes: { specCompliance: { score: 5, note: 'test' }, processQuality: { score: 5, note: 'test' }, verification: { score: 5, note: 'test' }, riskDebt: { score: 5, note: 'test' }, reportHonesty: { score: 5, note: 'test' } },
    issues: [],
    directive: {
      goal: 'R3-02 test goal — sẽ cancel ngay',
      rationale: 'test',
      scope: 'test only',
      // Delegation nhắc Opus (mô tả quy trình review) — KHÔNG nhắc agent nào khác
      delegation: 'Sau khi agents hoàn thành, Opus review lại; phần triển khai do Omega lập plan',
      acceptanceCriteria: ['job được enqueue với agent != Opus'],
    },
    rationale: 'test R3-02',
    evidenceRefs: [],
    stopAssessment: { ledgerClean: false, verificationGreen: false, specSatisfied: false, noNewBlocking: true, allMet: false },
  }

  const msg = await applyOpusVerdict(
    { id: 'test_review_r3', sessionId: TEST_SESSION, triggerMode: 'auto' },
    verdict,
    { autoDispatch: true, triggerMode: 'auto' },
  )
  console.log('Directive message inserted:', msg?.id)

  // 2. Kiểm tra job được enqueue với agent nào?
  const job = await db.goalLoopJob.findFirst({ where: { sessionId: TEST_SESSION }, orderBy: { createdAt: 'desc' } })
  if (job) {
    const input = JSON.parse(job.input)
    console.log(`JOB: status=${job.status} | agentName trong input = ${JSON.stringify(input.agentName)}`)
    // 3. Cancel ngay để không đốt LLM
    await db.goalLoopJob.update({ where: { id: job.id }, data: { cancelRequestedAt: new Date(), status: 'cancelled', stopReason: 'R3-02 test — cancel ngay sau verify', completedAt: new Date() } })
    console.log('Job đã cancel (test)')
  } else {
    console.log('KHÔNG có job — dispatch bị bỏ (kiểm tra log có R3-02 guard không)')
  }

  // 4. Session agent sau dispatch: phải là Omega (re-route) hoặc vẫn Opus nhưng không dispatch
  const sess = await db.agentSession.findUniqueOrThrow({ where: { sessionId: TEST_SESSION }, select: { agentProfileId: true } })
  const agentNow = await db.agentProfile.findUniqueOrThrow({ where: { id: sess.agentProfileId ?? '' }, select: { name: true } })
  console.log(`Session agent sau dispatch: ${agentNow.name} (kỳ vọng: Omega)`)

  // 5. Dọn test data
  await db.chatMessage.deleteMany({ where: { sessionId: TEST_SESSION } })
  await db.goalLoopJob.deleteMany({ where: { sessionId: TEST_SESSION } })
  await db.agentSession.delete({ where: { sessionId: TEST_SESSION } })
  console.log('Đã dọn test data (session + messages + jobs)')
}
main().then(() => process.exit(0)).catch(e => { console.error('FAIL:', e); process.exit(1) })
