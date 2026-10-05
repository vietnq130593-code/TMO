/// <reference types="bun-types" />
/**
 * ROUND-37 — Unit Tests: Adaptation Engine (V2a) + ε-greedy Exploration (V2d)
 *
 * V2a: applyAdaptationToSession — 8 chiến lược apply THẬT vào session-store;
 *      consumers (directive block / maxIterations / compressEarly / escalation
 *      / KB threshold delta TTL) + markSessionAdaptationOutcome đóng vòng.
 * V2d: applyEpsilonExploration — deterministic rng, guard ngưỡng, slice-5,
 *      exploration flag cho validateAppliedLessons.
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test'
import { PrismaClient } from '@prisma/client'

// ==================== MOCK PRISMA (mirror pattern layer9.test.ts) ====================
// Proxy mock: 3 model adaptation-engine cần + fall-through PrismaClient thật
// cho file test khác trong cùng process (không leak — bài học 2026-09-02).
const updateMock = mock(() => Promise.resolve({}))
const updateManyMock = mock(() => Promise.resolve({ count: 0 }))
const findFirstMock = mock(() => Promise.resolve(null))
mock.module('@/lib/db', () => {
  const mockedModels: Record<string, unknown> = {
    strategyAdaptationLog: {
      findFirst: findFirstMock,
      update: updateMock,
    },
    failurePattern: {
      updateMany: updateManyMock,
    },
  }
  let fallback: PrismaClient | null = null
  return {
    db: new Proxy(mockedModels, {
      get(target, prop, receiver) {
        if (prop === 'then') return undefined
        if (prop in target) return Reflect.get(target, prop, receiver)
        fallback ??= new PrismaClient()
        return Reflect.get(fallback, prop, receiver)
      },
    }),
  }
})

import type { AdaptationDecision } from '@/lib/learning/types'
import {
  applyAdaptationToSession,
  getAdaptationDirectiveBlock,
  getAdaptedMaxIterations,
  shouldCompressContextEarly,
  hasEscalation,
  getKbConfidenceThresholdDelta,
  markSessionAdaptationOutcome,
  __resetAdaptationStoreForTest,
  __peekSessionAdaptation,
} from '@/lib/learning/adaptation-engine'
import { applyEpsilonExploration } from '@/lib/episodic-memory/preact'

function decision(strategy: string): AdaptationDecision {
  return {
    shouldAdapt: true,
    currentStrategy: 'previous',
    recommendedStrategy: strategy as AdaptationDecision['recommendedStrategy'],
    reason: `test ${strategy}`,
    confidence: 0.8,
  }
}

// ==================== V2a: ADAPTATION ENGINE ====================

describe('AdaptationEngine (V2a)', () => {
  beforeEach(() => {
    __resetAdaptationStoreForTest()
    findFirstMock.mockImplementation(() => Promise.resolve(null))
    updateMock.mockClear()
    updateManyMock.mockClear()
  })

  describe('applyAdaptationToSession — 8 chiến lược', () => {
    it('read_lint_rules_first → directive ép đọc lint rules + config', () => {
      const state = applyAdaptationToSession('sess-a', decision('read_lint_rules_first'))
      expect(state).not.toBeNull()
      const block = getAdaptationDirectiveBlock('sess-a')
      expect(block).toContain('CHỈ THỊ THÍCH ỨNG')
      expect(block).toContain('lint rules')
    })

    it('read_api_docs → directive đọc API docs thật', () => {
      applyAdaptationToSession('sess-b', decision('read_api_docs'))
      expect(getAdaptationDirectiveBlock('sess-b')).toContain('API docs')
    })

    it('check_dev_log → directive kiểm tra dev.log', () => {
      applyAdaptationToSession('sess-c', decision('check_dev_log'))
      expect(getAdaptationDirectiveBlock('sess-c')).toContain('dev.log')
    })

    it('change_fix_approach → directive đổi cách fix', () => {
      applyAdaptationToSession('sess-d', decision('change_fix_approach'))
      expect(getAdaptationDirectiveBlock('sess-d')).toContain('ĐỔI CÁCH FIX')
    })

    it('compress_context → shouldCompressContextEarly=true', () => {
      expect(shouldCompressContextEarly('sess-e')).toBe(false)
      applyAdaptationToSession('sess-e', decision('compress_context'))
      expect(shouldCompressContextEarly('sess-e')).toBe(true)
    })

    it('reduce_scope → maxIterations chia đôi (floor 8)', () => {
      expect(getAdaptedMaxIterations('sess-f', 25)).toBe(25)
      applyAdaptationToSession('sess-f', decision('reduce_scope'))
      expect(getAdaptedMaxIterations('sess-f', 25)).toBe(12)
      // Không bao giờ hạ dưới 8 — không giết chết step
      expect(getAdaptedMaxIterations('sess-f', 10)).toBe(8)
    })

    it('escalate_to_user → hasEscalation=true (caller emit SSE)', () => {
      expect(hasEscalation('sess-g')).toBe(false)
      applyAdaptationToSession('sess-g', decision('escalate_to_user'))
      expect(hasEscalation('sess-g')).toBe(true)
      expect(getAdaptationDirectiveBlock('sess-g')).toContain('TẠM DỪNG')
    })

    it('tighten_refusal_threshold → KB delta +0.1 (TTL)', () => {
      expect(getKbConfidenceThresholdDelta()).toBe(0)
      applyAdaptationToSession('sess-h', decision('tighten_refusal_threshold'))
      expect(getKbConfidenceThresholdDelta()).toBeCloseTo(0.1, 5)
    })

    it('merge config các lần apply liên tiếp + không trùng directive', () => {
      applyAdaptationToSession('sess-i', decision('read_lint_rules_first'))
      applyAdaptationToSession('sess-i', decision('change_fix_approach'))
      const state = __peekSessionAdaptation('sess-i')
      expect(state?.applyCount).toBe(2)
      expect(state?.directives.length).toBe(2)
      // Apply lại strategy 1 → KHÔNG nhân bản directive
      applyAdaptationToSession('sess-i', decision('read_lint_rules_first'))
      expect(__peekSessionAdaptation('sess-i')?.directives.length).toBe(2)
    })

    it('shouldAdapt=false → null (không apply)', () => {
      const noAdapt: AdaptationDecision = { ...decision('escalate_to_user'), shouldAdapt: false }
      expect(applyAdaptationToSession('sess-j', noAdapt)).toBeNull()
    })
  })

  describe('markSessionAdaptationOutcome — đóng vòng học', () => {
    it('thành công → resolve FailurePattern + xoá directives', async () => {
      applyAdaptationToSession('sess-k', decision('change_fix_approach'), 'G2-A-code')
      await markSessionAdaptationOutcome('sess-k', true, 'G2-A-code')
      // Store bị xoá (pattern đã khỏi)
      expect(__peekSessionAdaptation('sess-k')).toBeNull()
      expect(getAdaptationDirectiveBlock('sess-k')).toBe('')
      expect(updateManyMock).toHaveBeenCalled() // failurePattern resolved
    })

    it('step KHÁC với sourceStepId → bỏ qua (chống resolve nhầm)', async () => {
      applyAdaptationToSession('sess-l', decision('change_fix_approach'), 'G2-A-code')
      await markSessionAdaptationOutcome('sess-l', true, 'G2-B-review')
      // Step khác pass — adaptation vẫn chờ
      expect(__peekSessionAdaptation('sess-l')).not.toBeNull()
      expect(updateManyMock).not.toHaveBeenCalled()
    })

    it('thất bại → GIỮ directives cho step sau', async () => {
      applyAdaptationToSession('sess-m', decision('change_fix_approach'), 'G2-A-code')
      await markSessionAdaptationOutcome('sess-m', false, 'G2-A-code')
      expect(__peekSessionAdaptation('sess-m')).not.toBeNull()
      expect(getAdaptationDirectiveBlock('sess-m')).not.toBe('')
    })
  })
})

// ==================== V2d: ε-GREEDY EXPLORATION ====================

describe('applyEpsilonExploration (V2d)', () => {
  const lessons = Array.from({ length: 10 }, (_, i) => ({
    id: `lesson-${i}`,
    confidence: 0.9 - i * 0.05, // 0.9 → 0.45
  }))

  it('rng >= epsilon → KHÔNG khám phá — top-5 nguyên vẹn', () => {
    const out = applyEpsilonExploration(lessons, { rng: () => 0.99, epsilon: 0.15 })
    expect(out.length).toBe(5)
    expect(out[4].id).toBe('lesson-4')
    expect(out.some(l => l.exploration)).toBe(false)
  })

  it('rng < epsilon → slot cuối đổi thành lesson rank 6+ ĐÁNH DẤU exploration', () => {
    const out = applyEpsilonExploration(lessons, { rng: () => 0.01, epsilon: 0.15 })
    expect(out.length).toBe(5)
    expect(out[4].id).toBe('lesson-5') // rank 6 (index 5)
    expect((out[4] as { exploration?: boolean }).exploration).toBe(true)
    // 4 slot đầu giữ nguyên
    expect(out.slice(0, 4).map(l => l.id)).toEqual(['lesson-0', 'lesson-1', 'lesson-2', 'lesson-3'])
  })

  it('danh sách ≤5 → giữ nguyên + slice 5 (parity hành vi cũ)', () => {
    const out = applyEpsilonExploration(lessons.slice(0, 3), { rng: () => 0.01, epsilon: 0.15 })
    expect(out.length).toBe(3)
  })

  it('ứng viên rank 6+ dưới ngưỡng review (0.4) → KHÔNG khám phá', () => {
    const lowConfidence = [
      ...lessons.slice(0, 5), // top-5 đủ
      { id: 'lesson-low', confidence: 0.3 }, // dưới 0.4
    ]
    const out = applyEpsilonExploration(lowConfidence, { rng: () => 0.01, epsilon: 0.15 })
    expect(out[4].id).toBe('lesson-4')
    expect(out.some(l => l.exploration)).toBe(false)
  })

  it('epsilon=0 → tắt hoàn toàn (env kill-switch)', () => {
    const out = applyEpsilonExploration(lessons, { rng: () => 0.001, epsilon: 0 })
    expect(out[4].id).toBe('lesson-4')
  })
})
