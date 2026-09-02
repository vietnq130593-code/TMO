/**
 * TC-09 — PIVOT TRIGGER (TB-12 §3.2 + TB-09 §6 + TB-06 §8.6/8.7)
 * ==================================================================================
 * Spec:
 *  - Giữa mission M2, KING đọc worklog thấy claim thiếu evidence (trigger 🔴) →
 *    PIVOT — dừng part hiện tại, quay lại part liên quan / giao group bổ sung.
 *  - KHÔNG tiếp tục với claim không evidence.
 *  - Decision log có lý do pivot + part được quay lại.
 *
 * Constraint:
 *  - recordPivot với reason EMPTY → throw 'PIVOT reason BẮT BUỘC (TC-09)'.
 *  - recordPivot với reason non-empty → append decision='PIVOT' vào Decision Log.
 */

import { recordPivot, getDecisionLog } from '@/lib/research-team/king/decision-log'
import { createMission } from '@/lib/research-team/mission-store'
import { db } from '@/lib/db'
import type { TestResult } from './_types'

async function run(): Promise<TestResult> {
  const details: string[] = []
  let missionId: string | undefined

  try {
    // ---------- 1. Empty reason → throw TC-09 error ----------
    let emptyThrew = false
    let emptyErrMsg = ''
    try {
      // Mission ID doesn't need to exist — reason check happens FIRST.
      await recordPivot('fake-mission-id', '', '🔴')
    } catch (err) {
      emptyThrew = true
      emptyErrMsg = err instanceof Error ? err.message : String(err)
    }
    const emptyOk =
      emptyThrew && emptyErrMsg.includes('PIVOT reason BẮT BUỘC')
    details.push(
      `empty reason throws: ${emptyThrew} msg="${emptyErrMsg.slice(0, 80)}" — ${emptyOk ? 'OK' : 'FAIL'}`,
    )

    // ---------- 2. Valid reason + real mission → append PIVOT decision ----------
    const mission = await createMission({
      request: 'TC-09 pivot test — chẩn đoán m2',
      title: 'TC-09 pivot',
      missionType: 'M2',
      tier: 'T2',
      confidence: {
        signals: ['logs mention issue', 'system', 'chat latency'],
        conflicts: [],
        level: 'HIGH',
      },
    })
    missionId = mission.id

    // Record PIVOT với trigger 🔴 (fundamental — TB-06 §8.6)
    await recordPivot(
      mission.id,
      'claim thiếu evidence — root cause chưa verify được file:line + log excerpt (TC-09 trigger 🔴)',
      '🔴',
    )

    const decisionLog = await getDecisionLog(mission.id)
    const pivotEntry = decisionLog.find((d) => d.decision === 'PIVOT')
    const pivotOk =
      !!pivotEntry &&
      typeof pivotEntry.reason === 'string' &&
      pivotEntry.reason.includes('fundamental') &&
      pivotEntry.reason.includes('claim thiếu evidence')
    details.push(
      `PIVOT decision appended: ${!!pivotEntry} reason="${pivotEntry?.reason.slice(0, 80) ?? ''}" — ${pivotOk ? 'OK' : 'FAIL'}`,
    )

    const passed = emptyOk && pivotOk
    return {
      name: 'TC-09 pivot trigger',
      passed,
      details: details.join(' | '),
    }
  } catch (err) {
    return {
      name: 'TC-09 pivot trigger',
      passed: false,
      details: [...details, `THREW: ${err instanceof Error ? err.message : String(err)}`].join(' | '),
    }
  } finally {
    try {
      if (missionId) await db.researchMission.delete({ where: { id: missionId } })
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
      console.error('TC-09 uncaught:', err)
      process.exit(1)
    })
}

export { run }
