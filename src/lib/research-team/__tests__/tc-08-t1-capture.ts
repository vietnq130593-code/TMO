/**
 * TC-08 — T1 CAPTURE AT MONITOR/FINALIZE (TB-12 §3.2 + TB-08 §7 quy tắc vàng #2)
 * ==================================================================================
 * Spec:
 *  - Task tier T1 (M1/M2) — không qua G3 → Tri thức vẫn vào KB: KING ghi tại
 *    MONITOR + FINALIZE (quy tắc vàng #2 — TB-08 §7); không để tri thức thất lạc.
 *  - captureAtMonitor pure-ish (DB side-effect) — capture lesson + baseline entries
 *    từ worklog + persist ResearchKBEntry rows.
 *  - extractLessonsFromWorklog pure function — verify entries non-empty.
 *
 * DB test — verify KB count tăng sau captureAtMonitor. KHÔNG require LLM.
 */

import { captureAtMonitor, extractLessonsFromWorklog } from '@/lib/research-team/g3/capture'
import { db } from '@/lib/db'
import { createMission } from '@/lib/research-team/mission-store'
import type { WorklogEntry } from '@/lib/research-team/types'
import type { TestResult } from './_types'

async function run(): Promise<TestResult> {
  const details: string[] = []
  let missionId: string | undefined

  try {
    // ---------- 1. Pure: extractLessonsFromWorklog ----------
    const worklog: WorklogEntry = {
      mission: 'M2',
      status: 'IN_PROGRESS',
      currentPhase: 'G3',
      overallProgress: 80,
      tlReadBack: 'VERIFIED',
      done: [
        'Insight: fail-fast retry 4xx giảm latency 121s → 6.2s',
        'Verified key health check tại src/lib/llm/key-pool.ts:42',
      ],
      issuesFaced: ['Anti-pattern: retry mù 4xx gây 121s latency'],
      suggestionsNextGroup: ['Triển khai full benchmark A/B'],
      filesChanged: ['workspace/research/key-pool.ts'],
      findings: [
        {
          no: 1,
          finding: 'Retry mù 4xx là root cause 121s latency',
          evidence: 'src/lib/llm/retry.ts:42',
          severity: 'HIGH',
          proposal: 'Fail-fast trên 4xx + key health check',
        },
      ],
    }
    const lessons = extractLessonsFromWorklog(worklog)
    const lessonsOk = lessons.length >= 1
    details.push(
      `extractLessonsFromWorklog: ${lessons.length} candidates (≥1 expected) — ${lessonsOk ? 'OK' : 'FAIL'}`,
    )
    if (lessons.length > 0) {
      details.push(
        `categories: ${lessons.map((l) => l.category).join(',')}`,
      )
    }

    // ---------- 2. DB: create M2/T1 mission + captureAtMonitor ----------
    const mission = await createMission({
      request: 'TC-08 T1 capture test — verify NEO4J_DATABASE',
      title: 'TC-08 T1 capture',
      missionType: 'M2',
      tier: 'T1',
      confidence: {
        signals: ['verify config', 'NEO4J_DATABASE', 'T1 simple'],
        conflicts: [],
        level: 'HIGH',
      },
    })
    missionId = mission.id

    const kbBefore = await db.researchKBEntry.count()
    const capture = await captureAtMonitor(
      mission.id,
      'task-tc08-fake',
      worklog,
      'M2',
      'T1',
    )
    const kbAfter = await db.researchKBEntry.count()
    const capturedOk = capture.captured.length >= 1
    const dbCountOk = kbAfter > kbBefore
    details.push(
      `captureAtMonitor: captured=${capture.captured.length} KB count ${kbBefore}→${kbAfter} — ${capturedOk && dbCountOk ? 'OK' : 'FAIL'}`,
    )

    const passed = lessonsOk && capturedOk && dbCountOk
    return {
      name: 'TC-08 T1 capture at MONITOR/FINALIZE',
      passed,
      details: details.join(' | '),
    }
  } catch (err) {
    return {
      name: 'TC-08 T1 capture at MONITOR/FINALIZE',
      passed: false,
      details: [...details, `THREW: ${err instanceof Error ? err.message : String(err)}`].join(' | '),
    }
  } finally {
    // Cleanup best-effort — delete KB entries created with sourceMission=missionId
    try {
      if (missionId) {
        await db.researchKBEntry.deleteMany({ where: { sourceMission: missionId } })
        await db.researchMission.delete({ where: { id: missionId } })
      }
    } catch {
      // ignore
    }
  }
}

if (import.meta.main) {
  run()
    .then((r) => {
      console.log(r.name, r.passed ? 'PASS' : 'FAIL')
      console.log(r.details)
      process.exit(r.passed ? 0 : 1)
    })
    .catch((err) => {
      console.error('TC-08 uncaught:', err)
      process.exit(1)
    })
}

export { run }
