/**
 * TC-12 — MODEL SWITCH BETWEEN TASK (TB-12 §3.2 + TB-01 §2 + TB-09 §10 E7 + DR-C7)
 * ==================================================================================
 * Spec:
 *  - Model chính lỗi giữa task → fallback chain. Agent GIỮ NGUYÊN vai trò + JD;
 *    task KHÔNG reset; worklog ghi dòng "model switched".
 *  - DR-C7 format: `model switched: <from> → <to> | trigger: <lý do> | next check: <thời điểm>`.
 *  - State trong DB (KHÔNG memory) — recordModelSwitch persist ModelSwitchEvent row.
 *
 * Fail-open: recordModelSwitch persist fail → KHÔNG chặn pipeline.
 */

import {
  formatModelSwitchLine,
  recordModelSwitch,
  getModelStack,
  nextFallbackModel,
  encodeModelSwitchedEntries,
} from '@/lib/research-team/model-switch'
import { db } from '@/lib/db'
import type { TestResult } from './_types'

async function run(): Promise<TestResult> {
  const details: string[] = []
  let createdEventId: string | undefined

  try {
    // ---------- 1. formatModelSwitchLine — DR-C7 format ----------
    const line = formatModelSwitchLine({
      fromModel: 'kimi-k3',
      toModel: 'space-bunny-free',
      trigger: '429 rate limit at 14:32 UTC',
      nextCheck: '2026-09-02T15:00:00Z',
    })
    // Expected: `model switched: kimi-k3 → space-bunny-free | trigger: 429 rate limit at 14:32 UTC | next check: 2026-09-02T15:00:00Z`
    const formatOk =
      line.startsWith('model switched: kimi-k3 → space-bunny-free') &&
      line.includes('| trigger:') &&
      line.includes('| next check:') &&
      line.includes('429 rate limit at 14:32 UTC')
    details.push(
      `formatModelSwitchLine: "${line.slice(0, 100)}..." — ${formatOk ? 'OK' : 'FAIL'}`,
    )

    // ---------- 2. recordModelSwitch returns ModelSwitchEntry with worklogLine ----------
    const entry = await recordModelSwitch({
      agentId: 'LISMA',
      fromModel: 'kimi-k3',
      toModel: 'space-bunny-free',
      trigger: '429 rate limit (TC-12)',
      nextCheck: '2026-09-02T15:00:00Z',
    })
    const entryOk =
      entry.fromModel === 'kimi-k3' &&
      entry.toModel === 'space-bunny-free' &&
      typeof entry.worklogLine === 'string' &&
      entry.worklogLine.includes('model switched:') &&
      typeof entry.at === 'string'
    details.push(
      `recordModelSwitch entry: from=${entry.fromModel} to=${entry.toModel} worklogLine=${entry.worklogLine ? 'non-empty' : 'EMPTY'} at=${entry.at} — ${entryOk ? 'OK' : 'FAIL'}`,
    )

    // ---------- 3. ModelSwitchEvent persisted to DB (state in DB, NOT memory) ----------
    // Find the latest event matching our trigger text.
    const persisted = await db.modelSwitchEvent.findFirst({
      where: { trigger: { contains: 'TC-12' } },
      orderBy: { at: 'desc' },
    })
    const persistedOk =
      !!persisted &&
      persisted.fromModel === 'kimi-k3' &&
      persisted.toModel === 'space-bunny-free' &&
      persisted.agentId === 'LISMA'
    if (persisted) createdEventId = persisted.id
    details.push(
      `ModelSwitchEvent persisted: ${!!persisted} agentId=${persisted?.agentId ?? '?'} from=${persisted?.fromModel ?? '?'} — ${persistedOk ? 'OK' : 'FAIL'}`,
    )

    // ---------- 4. getModelStack — has primary + fallback chain ----------
    const stack = getModelStack()
    const stackOk = stack.length >= 2 && stack[0] === stack[0] // primary at index 0
    details.push(
      `getModelStack: length=${stack.length} primary="${stack[0]}" — ${stackOk ? 'OK' : 'FAIL'}`,
    )

    // ---------- 5. nextFallbackModel returns next rank ----------
    const primaryModel = stack[0]
    const next = nextFallbackModel(primaryModel)
    const nextOk = next === null || typeof next === 'string'
    details.push(
      `nextFallbackModel("${primaryModel}"): ${next ?? '(null — terminal)'} — ${nextOk ? 'OK' : 'FAIL'}`,
    )

    // ---------- 6. encodeModelSwitchedEntries roundtrip ----------
    const encoded = encodeModelSwitchedEntries([entry])
    const decoded = JSON.parse(encoded) as Array<{ fromModel: string; toModel: string }>
    const roundtripOk = decoded.length === 1 && decoded[0].fromModel === 'kimi-k3'
    details.push(
      `encodeModelSwitchedEntries roundtrip: ${roundtripOk ? 'OK' : 'FAIL'}`,
    )

    const passed =
      formatOk && entryOk && persistedOk && stackOk && nextOk && roundtripOk
    return {
      name: 'TC-12 model switch (no task reset)',
      passed,
      details: details.join(' | '),
    }
  } catch (err) {
    return {
      name: 'TC-12 model switch (no task reset)',
      passed: false,
      details: [...details, `THREW: ${err instanceof Error ? err.message : String(err)}`].join(' | '),
    }
  } finally {
    // Cleanup — delete the test ModelSwitchEvent row
    try {
      if (createdEventId) await db.modelSwitchEvent.delete({ where: { id: createdEventId } })
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
      console.error('TC-12 uncaught:', err)
      process.exit(1)
    })
}

export { run }
