/**
 * TC-01 — CLASSIFY AMBIGUOUS REQUEST (TB-12 §3.2 + TB-02 §6 edge #1 + DR-C2)
 * ==================================================================================
 * Spec:
 *  - Request mơ hồ (LOW confidence) → KING KHÔNG đoán mò; hỏi ĐÚNG 1 CÂU.
 *  - classifyMission returns clarifyingQuestion non-empty + confidence.level==='LOW'
 *    + tier falsy.
 *  - API: POST /missions ambiguous → 201 { status:'needs_clarification',
 *    mission.tier==='' }.
 *
 * Môi trường: NIM keys placeholder → LLM fail-open → LOW confidence + fallback
 * clarifyingQuestion. TC verify CODE STRUCTURE + fail-open path (KHÔNG require
 * real LLM).
 */

import { classifyMission } from '@/lib/research-team/classify'
import type { TestResult } from './_types'

async function run(): Promise<TestResult> {
  const details: string[] = []

  // ---------- 1. Pure function: classifyMission ambiguous request ----------
  // Request mơ hồ — không rõ Kaggle (M1) hay System Research (M2).
  const ambiguousRequest = 'cải thiện mọi thứ'
  const classify = await classifyMission(ambiguousRequest, 'Yêu cầu mơ hồ')

  // Assert: confidence.level === 'LOW' (DR-C2 — KHÔNG guess khi ambiguous)
  const isLow = classify.confidence.level === 'LOW'
  details.push(
    `classify.confidence.level=${classify.confidence.level} (expected LOW) — ${isLow ? 'OK' : 'FAIL'}`,
  )

  // Assert: clarifyingQuestion non-empty (TB-02 §6 edge #1 — hỏi đúng 1 câu)
  const hasQuestion =
    typeof classify.clarifyingQuestion === 'string' &&
    classify.clarifyingQuestion.trim().length > 0
  details.push(
    `clarifyingQuestion=${hasQuestion ? `"${classify.clarifyingQuestion!.slice(0, 80)}..."` : '(empty)'} — ${hasQuestion ? 'OK' : 'FAIL'}`,
  )

  // Assert: tier falsy (KHÔNG set tier khi LOW — chờ user clarify)
  const tierFalsy = !classify.tier
  details.push(`tier=${classify.tier ?? '(undefined)'} (expected falsy) — ${tierFalsy ? 'OK' : 'FAIL'}`)

  const pureOk = isLow && hasQuestion && tierFalsy

  // ---------- 2. API: POST /missions ambiguous → needs_clarification ----------
  let apiOk = false
  let missionTierInDb = '?'
  let apiStatus = '?'
  try {
    const resp = await fetch('http://localhost:3000/api/research/missions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        request: 'cải thiện mọi thứ', // ambiguous — fail-open LOW
        title: 'TC-01 ambiguous mission',
      }),
    })
    apiStatus = String(resp.status)
    if (resp.status === 201) {
      const body = (await resp.json()) as {
        status: string
        mission?: { tier?: string; status?: string }
        clarifyingQuestion?: string
      }
      const needsClarification = body.status === 'needs_clarification'
      missionTierInDb = body.mission?.tier ?? '(undefined)'
      const tierEmptyInDb = missionTierInDb === ''
      const apiHasQuestion =
        typeof body.clarifyingQuestion === 'string' &&
        body.clarifyingQuestion.trim().length > 0
      apiOk = needsClarification && tierEmptyInDb && apiHasQuestion
      details.push(
        `API POST /missions → ${apiStatus} status=${body.status} mission.tier="${missionTierInDb}" (expected '') clarifyingQuestion=${apiHasQuestion ? 'non-empty' : 'EMPTY'} — ${apiOk ? 'OK' : 'FAIL'}`,
      )
    } else {
      details.push(`API POST /missions → ${apiStatus} (expected 201) — FAIL`)
    }
  } catch (err) {
    details.push(
      `API POST /missions threw: ${err instanceof Error ? err.message : String(err)} — FAIL`,
    )
  }

  const passed = pureOk && apiOk
  return {
    name: 'TC-01 classify ambiguous',
    passed,
    details: details.join(' | '),
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
      console.error('TC-01 uncaught:', err)
      process.exit(1)
    })
}

export { run }
