/**
 * Skills Test API Endpoint
 *
 * GET /api/code-team/test-skills          — Test all 3 skills (Tavily, Serper, Jina)
 * GET /api/code-team/test-skills?skill=tavily — Test specific skill
 * GET /api/code-team/test-skills?skill=serper — Test specific skill
 * GET /api/code-team/test-skills?skill=jina   — Test specific skill
 *
 * This is a dev tool — no authentication required.
 * Tests each skill by making a real API call with a simple query.
 * Returns structured JSON with test results for each skill.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSkillStatus, executeTool } from '@/lib/code-team/tool-executor'
import { tavilyKeyPool, jinaKeyPool, serperKeyPool } from '@/lib/service-key-pool'

export const dynamic = 'force-dynamic'

interface SkillTestResult {
  skill: string
  status: 'success' | 'fail' | 'skip'
  duration_ms: number
  source: string | null    // Which provider answered (e.g. 'tavily', 'serper', 'jina')
  sample: unknown | null   // First result or snippet
  error: string | null
}

interface EnvironmentCheck {
  TAVILY_API_KEY_POOL: { total: number; available: number }
  SERPER_API_KEY_POOL: { total: number; available: number }
  JINA_API_KEY_POOL: { total: number; available: number }
  // (2026-10-15) zai_sdk field removed — z-ai-web-dev-sdk fallback đã gỡ bỏ
}

interface TestResponse {
  timestamp: string
  environment: EnvironmentCheck
  skills: SkillStatusCheck[]
  results: SkillTestResult[]
}

interface SkillStatusCheck {
  skill: string
  directKey: boolean
  available: boolean
  keyHint: string
}

async function testTavily(): Promise<SkillTestResult> {
  const start = Date.now()
  try {
    const result = await executeTool('tavily', { query: 'Next.js 16 features' })
    const duration = Date.now() - start

    if (result.success) {
      const data = result.result as Record<string, unknown>
      const source = (data.source as string) || 'tavily'
      const results = data.results as Array<Record<string, unknown>> | undefined
      const answer = data.answer as string | null | undefined
      const error = data.error as string | null | undefined

      if (error) {
        return { skill: 'tavily', status: 'fail', duration_ms: duration, source: null, sample: null, error: String(error) }
      }

      const sample = answer
        ? answer.slice(0, 200)
        : results?.[0]
          ? { title: results[0].title, url: results[0].url, content: (results[0].content as string)?.slice(0, 150) }
          : null

      return { skill: 'tavily', status: 'success', duration_ms: duration, source, sample, error: null }
    } else {
      return { skill: 'tavily', status: 'fail', duration_ms: duration, source: null, sample: null, error: String(result.result) }
    }
  } catch (err) {
    return { skill: 'tavily', status: 'fail', duration_ms: Date.now() - start, source: null, sample: null, error: err instanceof Error ? err.message : String(err) }
  }
}

async function testSerper(): Promise<SkillTestResult> {
  const start = Date.now()
  try {
    const result = await executeTool('serper', { query: 'TypeScript 5 new features' })
    const duration = Date.now() - start

    if (result.success) {
      const data = result.result as Record<string, unknown>
      const source = (data.source as string) || 'serper'
      const organic = data.organic as Array<Record<string, unknown>> | undefined
      const error = data.error as string | null | undefined

      if (error) {
        return { skill: 'serper', status: 'fail', duration_ms: duration, source: null, sample: null, error: String(error) }
      }

      const sample = organic?.[0]
        ? { title: organic[0].title, link: organic[0].link, snippet: (organic[0].snippet as string)?.slice(0, 150) }
        : null

      return { skill: 'serper', status: 'success', duration_ms: duration, source, sample, error: null }
    } else {
      return { skill: 'serper', status: 'fail', duration_ms: duration, source: null, sample: null, error: String(result.result) }
    }
  } catch (err) {
    return { skill: 'serper', status: 'fail', duration_ms: Date.now() - start, source: null, sample: null, error: err instanceof Error ? err.message : String(err) }
  }
}

async function testJina(): Promise<SkillTestResult> {
  const start = Date.now()
  try {
    const result = await executeTool('jina', { url: 'https://example.com' })
    const duration = Date.now() - start

    if (result.success) {
      const data = result.result as Record<string, unknown>
      const source = (data.source as string) || 'jina'
      const content = data.content as string | undefined
      const error = data.error as string | null | undefined

      if (error) {
        return { skill: 'jina', status: 'fail', duration_ms: duration, source: null, sample: null, error: String(error) }
      }

      const sample = content
        ? content.slice(0, 200)
        : null

      return { skill: 'jina', status: 'success', duration_ms: duration, source, sample, error: null }
    } else {
      return { skill: 'jina', status: 'fail', duration_ms: duration, source: null, sample: null, error: String(result.result) }
    }
  } catch (err) {
    return { skill: 'jina', status: 'fail', duration_ms: Date.now() - start, source: null, sample: null, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const skill = searchParams.get('skill')

  // Build environment check using key pools
  const environment: EnvironmentCheck = {
    TAVILY_API_KEY_POOL: { total: tavilyKeyPool.getTotalCount(), available: tavilyKeyPool.getAvailableCount() },
    SERPER_API_KEY_POOL: { total: serperKeyPool.getTotalCount(), available: serperKeyPool.getAvailableCount() },
    JINA_API_KEY_POOL: { total: jinaKeyPool.getTotalCount(), available: jinaKeyPool.getAvailableCount() },
  }

  // Get skill statuses
  const skillStatuses = getSkillStatus()

  // Determine which skills to test
  const validSkills = ['tavily', 'serper', 'jina']
  const skillsToTest = skill && validSkills.includes(skill) ? [skill] : validSkills

  // Run tests
  const results: SkillTestResult[] = []

  for (const s of skillsToTest) {
    // Check if skill has any available method
    const status = skillStatuses.find(st => st.skill === s)
    if (status && !status.available) {
      results.push({
        skill: s,
        status: 'skip',
        duration_ms: 0,
        source: null,
        sample: null,
        error: `No API key (${status.keyHint}). Set ${status.keyHint} in .env — z-ai-sdk fallback đã gỡ bỏ (direct API keys only).`,
      })
      continue
    }

    switch (s) {
      case 'tavily':
        results.push(await testTavily())
        break
      case 'serper':
        results.push(await testSerper())
        break
      case 'jina':
        results.push(await testJina())
        break
    }
  }

  const response: TestResponse = {
    timestamp: new Date().toISOString(),
    environment,
    skills: skillStatuses,
    results,
  }

  return NextResponse.json(response)
}
