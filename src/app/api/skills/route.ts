/**
 * Skills API — Clawhub Market
 *
 * GET  /api/skills          — List all installed skills with status (includes key pool info)
 * GET  /api/skills?status   — Quick health check (just status, no test)
 * GET  /api/skills?pool     — Detailed key pool status for all services
 * POST /api/skills/test     — Test a specific skill (tavily | serper | jina | web_search | page_reader)
 * POST /api/skills/test-all — Test all skills and return results
 */

import { NextRequest, NextResponse } from 'next/server'
import { tavilyKeyPool, jinaKeyPool, serperKeyPool } from '@/lib/service-key-pool'

// ===== SKILL DEFINITIONS =====

interface SkillDef {
  id: string
  name: string
  description: string
  category: 'search' | 'reader' | 'knowledge' | 'code'
  icon: string
  provider: string
  apiKeyEnv: string
  hasApiKey: boolean
  totalKeys: number
  availableKeys: number
  hasFallback: boolean
  fallbackProvider: string
  usedByAgents: string[]
  // Optional: 3 skill key-pool (tavily/serper/jina) chưa khai báo tĩnh —
  // runtime undefined (quickStatus đếm chúng ra cả 3 nhóm, giữ nguyên hiện trạng)
  status?: 'active' | 'fallback' | 'unavailable'
  docsUrl?: string
}

function getSkills(): SkillDef[] {
  return [
    {
      id: 'tavily',
      name: 'Tavily',
      description: 'Deep web search AI-optimized cho AI Agents. Trả về kết quả có nội dung tóm tắt + answer. Bất kỳ Agent nào cũng có thể dùng khi cần tìm kiếm thông tin trên web.',
      category: 'search',
      icon: '🔍',
      provider: 'Tavily API',
      apiKeyEnv: 'TAVILY_API_KEY_1..4',
      hasApiKey: tavilyKeyPool.hasKeys(),
      totalKeys: tavilyKeyPool.getTotalCount(),
      availableKeys: tavilyKeyPool.getAvailableCount(),
      hasFallback: true,
      fallbackProvider: 'z-ai-web-dev-sdk (web_search)',
      usedByAgents: ['Mọi Agents (khi cần Web Search)'],
    },
    {
      id: 'serper',
      name: 'Serper',
      description: 'Google Search API. Trả về organic results với titles, snippets, links. Bất kỳ Agent nào cũng có thể dùng khi cần tìm docs, packages, solutions trên Google.',
      category: 'search',
      icon: '🔎',
      provider: 'Serper API',
      apiKeyEnv: 'SERPER_API_KEY_1..4',
      hasApiKey: serperKeyPool.hasKeys(),
      totalKeys: serperKeyPool.getTotalCount(),
      availableKeys: serperKeyPool.getAvailableCount(),
      hasFallback: true,
      fallbackProvider: 'z-ai-web-dev-sdk (web_search)',
      usedByAgents: ['Mọi Agents (khi cần Google Search)'],
      docsUrl: 'https://serper.dev',
    },
    {
      id: 'jina',
      name: 'Jina Reader',
      description: 'Web page reader — đọc nội dung trang web từ URL. Trả về text content. Bất kỳ Agent nào cũng có thể dùng khi cần đọc docs, articles, API references.',
      category: 'reader',
      icon: '📖',
      provider: 'Jina API',
      apiKeyEnv: 'JINA_API_KEY_1..2',
      hasApiKey: jinaKeyPool.hasKeys(),
      totalKeys: jinaKeyPool.getTotalCount(),
      availableKeys: jinaKeyPool.getAvailableCount(),
      hasFallback: true,
      fallbackProvider: 'z-ai-web-dev-sdk (page_reader)',
      usedByAgents: ['Mọi Agents (khi cần đọc trang web)'],
      docsUrl: 'https://jina.ai',
    },
    {
      id: 'web_search',
      name: 'Web Search (z-ai-sdk)',
      description: 'Web search via z-ai-web-dev-sdk. Fallback cho Tavily/Serper khi API keys không khả dụng. Không cần API key riêng.',
      category: 'search',
      icon: '🌐',
      provider: 'z-ai-web-dev-sdk',
      apiKeyEnv: '(none)',
      hasApiKey: true,
      totalKeys: 0,
      availableKeys: 0,
      hasFallback: false,
      fallbackProvider: '',
      usedByAgents: ['Mọi Agents (fallback Web Search)'],
      status: 'active',
      docsUrl: 'https://docs.z.ai',
    },
    {
      id: 'page_reader',
      name: 'Page Reader (z-ai-sdk)',
      description: 'Web page reader via z-ai-web-dev-sdk. Fallback cho Jina khi API key không khả dụng. Không cần API key riêng.',
      category: 'reader',
      icon: '📄',
      provider: 'z-ai-web-dev-sdk',
      apiKeyEnv: '(none)',
      hasApiKey: true,
      totalKeys: 0,
      availableKeys: 0,
      hasFallback: false,
      fallbackProvider: '',
      usedByAgents: ['Mọi Agents (fallback Page Reader)'],
      status: 'active',
      docsUrl: 'https://docs.z.ai',
    },
  ]
}

// ===== GET: List skills + status =====

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const quickStatus = url.searchParams.has('status')
  const poolStatus = url.searchParams.has('pool')

  // Detailed key pool status
  if (poolStatus) {
    return NextResponse.json({
      ok: true,
      pools: {
        tavily: {
          total: tavilyKeyPool.getTotalCount(),
          available: tavilyKeyPool.getAvailableCount(),
          keys: tavilyKeyPool.getKeyStatuses(),
          summary: tavilyKeyPool.getSummary(),
        },
        serper: {
          total: serperKeyPool.getTotalCount(),
          available: serperKeyPool.getAvailableCount(),
          keys: serperKeyPool.getKeyStatuses(),
          summary: serperKeyPool.getSummary(),
        },
        jina: {
          total: jinaKeyPool.getTotalCount(),
          available: jinaKeyPool.getAvailableCount(),
          keys: jinaKeyPool.getKeyStatuses(),
          summary: jinaKeyPool.getSummary(),
        },
      },
    })
  }

  const skills = getSkills()

  if (quickStatus) {
    // Quick health check — just counts
    const active = skills.filter(s => s.status === 'active').length
    const fallback = skills.filter(s => s.status === 'fallback').length
    const unavailable = skills.filter(s => s.status === 'unavailable').length
    return NextResponse.json({
      ok: true,
      summary: { total: skills.length, active, fallback, unavailable },
      keyPools: {
        tavily: `${tavilyKeyPool.getAvailableCount()}/${tavilyKeyPool.getTotalCount()}`,
        serper: `${serperKeyPool.getAvailableCount()}/${serperKeyPool.getTotalCount()}`,
        jina: `${jinaKeyPool.getAvailableCount()}/${jinaKeyPool.getTotalCount()}`,
      },
    })
  }

  return NextResponse.json({ ok: true, skills, total: skills.length })
}

// ===== POST: Test skills =====

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { action, skillId } = body

    if (action === 'test-all') {
      return NextResponse.json(await testAllSkills())
    }

    if (action === 'test' && skillId) {
      const result = await testSkill(skillId)
      return NextResponse.json(result)
    }

    return NextResponse.json(
      { ok: false, error: 'Invalid action. Use action="test" with skillId or action="test-all"' },
      { status: 400 }
    )
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    )
  }
}

// ===== TEST IMPLEMENTATIONS =====

async function testSkill(skillId: string): Promise<{
  ok: boolean
  skillId: string
  success: boolean
  source: string
  duration: number
  resultPreview: string
  error?: string
}> {
  const startTime = Date.now()

  switch (skillId) {
    case 'tavily':
      return await testTavily(startTime)
    case 'serper':
      return await testSerper(startTime)
    case 'jina':
      return await testJina(startTime)
    case 'web_search':
      return await testWebSearchSDK(startTime)
    case 'page_reader':
      return await testPageReaderSDK(startTime)
    default:
      return {
        ok: false,
        skillId,
        success: false,
        source: 'unknown',
        duration: Date.now() - startTime,
        resultPreview: '',
        error: `Unknown skill: ${skillId}`,
      }
  }
}

async function testAllSkills() {
  const skillIds = ['tavily', 'serper', 'jina', 'web_search', 'page_reader']
  const results = await Promise.allSettled(skillIds.map(id => testSkill(id)))

  return {
    ok: true,
    results: results.map((r, i) => {
      if (r.status === 'fulfilled') return r.value
      return {
        ok: false,
        skillId: skillIds[i],
        success: false,
        source: 'error',
        duration: 0,
        resultPreview: '',
        error: r.reason?.message || String(r.reason),
      }
    }),
    testedAt: new Date().toISOString(),
  }
}

async function testTavily(startTime: number) {
  // Use key pool rotation
  if (tavilyKeyPool.hasKeys()) {
    const keySelection = tavilyKeyPool.getNextKey()
    if (keySelection) {
      try {
        const res = await fetch('https://api.tavily.com/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            api_key: keySelection.key,
            query: 'Next.js 15 new features',
            max_results: 2,
          }),
          signal: AbortSignal.timeout(15000),
        })

        if (res.ok) {
          tavilyKeyPool.reportResult(keySelection.index, true, res.status)
          const data = await res.json()
          const resultsCount = data.results?.length || 0
          return {
            ok: true,
            skillId: 'tavily',
            success: true,
            source: `tavily-api-key${keySelection.index + 1}`,
            duration: Date.now() - startTime,
            resultPreview: `Found ${resultsCount} results using key ${keySelection.index + 1}. Answer: ${(data.answer || '').slice(0, 100)}`,
          }
        }

        const errorBody = await res.text().catch(() => '')
        tavilyKeyPool.reportResult(keySelection.index, false, res.status, errorBody.slice(0, 200))
      } catch (err) {
        tavilyKeyPool.reportResult(keySelection.index, false, undefined, err instanceof Error ? err.message : String(err))
      }
    }
  }

  // Fallback: z-ai-web-dev-sdk
  try {
    const ZAI = (await import('z-ai-web-dev-sdk')).default
    const zai = await ZAI.create()
    const results = await zai.functions.invoke('web_search', { query: 'Next.js 15 new features', num: 2 })
    return {
      ok: true,
      skillId: 'tavily',
      success: true,
      source: 'z-ai-sdk-web_search',
      duration: Date.now() - startTime,
      resultPreview: `Found ${results?.length || 0} results via SDK fallback`,
    }
  } catch (err) {
    return {
      ok: false,
      skillId: 'tavily',
      success: false,
      source: tavilyKeyPool.hasKeys() ? 'tavily-api' : 'none',
      duration: Date.now() - startTime,
      resultPreview: '',
      error: `Tavily API failed (${tavilyKeyPool.getAvailableCount()}/${tavilyKeyPool.getTotalCount()} keys available) + SDK fallback failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

async function testSerper(startTime: number) {
  if (serperKeyPool.hasKeys()) {
    const keySelection = serperKeyPool.getNextKey()
    if (keySelection) {
      try {
        const res = await fetch('https://google.serper.dev/search', {
          method: 'POST',
          headers: { 'X-API-KEY': keySelection.key, 'Content-Type': 'application/json' },
          body: JSON.stringify({ q: 'TypeScript 5.5 new features', num: 2 }),
          signal: AbortSignal.timeout(15000),
        })

        if (res.ok) {
          serperKeyPool.reportResult(keySelection.index, true, res.status)
          const data = await res.json()
          const organicCount = data.organic?.length || 0
          return {
            ok: true,
            skillId: 'serper',
            success: true,
            source: `serper-api-key${keySelection.index + 1}`,
            duration: Date.now() - startTime,
            resultPreview: `Found ${organicCount} organic results using key ${keySelection.index + 1}`,
          }
        }

        const errorBody = await res.text().catch(() => '')
        serperKeyPool.reportResult(keySelection.index, false, res.status, errorBody.slice(0, 200))
      } catch (err) {
        serperKeyPool.reportResult(keySelection.index, false, undefined, err instanceof Error ? err.message : String(err))
      }
    }
  }

  try {
    const ZAI = (await import('z-ai-web-dev-sdk')).default
    const zai = await ZAI.create()
    const results = await zai.functions.invoke('web_search', { query: 'TypeScript 5.5 new features', num: 2 })
    return {
      ok: true,
      skillId: 'serper',
      success: true,
      source: 'z-ai-sdk-web_search',
      duration: Date.now() - startTime,
      resultPreview: `Found ${results?.length || 0} results via SDK fallback`,
    }
  } catch (err) {
    return {
      ok: false,
      skillId: 'serper',
      success: false,
      source: serperKeyPool.hasKeys() ? 'serper-api' : 'none',
      duration: Date.now() - startTime,
      resultPreview: '',
      error: `Serper API failed (${serperKeyPool.getAvailableCount()}/${serperKeyPool.getTotalCount()} keys available) + SDK fallback failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

async function testJina(startTime: number) {
  if (jinaKeyPool.hasKeys()) {
    const keySelection = jinaKeyPool.getNextKey()
    if (keySelection) {
      try {
        const headers: Record<string, string> = { 'Accept': 'text/plain' }
        if (keySelection.key) headers['Authorization'] = `Bearer ${keySelection.key}`

        const res = await fetch('https://r.jina.ai/https://example.com', {
          method: 'GET',
          headers,
          signal: AbortSignal.timeout(15000),
        })

        if (res.ok) {
          jinaKeyPool.reportResult(keySelection.index, true, res.status)
          const text = await res.text()
          return {
            ok: true,
            skillId: 'jina',
            success: true,
            source: `jina-api-key${keySelection.index + 1}`,
            duration: Date.now() - startTime,
            resultPreview: `Read ${text.length} chars using key ${keySelection.index + 1}. Preview: ${text.slice(0, 100).replace(/\n/g, ' ')}`,
          }
        }

        const errorBody = await res.text().catch(() => '')
        jinaKeyPool.reportResult(keySelection.index, false, res.status, errorBody.slice(0, 200))
      } catch (err) {
        jinaKeyPool.reportResult(keySelection.index, false, undefined, err instanceof Error ? err.message : String(err))
      }
    }
  }

  try {
    const ZAI = (await import('z-ai-web-dev-sdk')).default
    const zai = await ZAI.create()
    const result = await zai.functions.invoke('page_reader', { url: 'https://example.com' })
    if (result?.data?.html) {
      return {
        ok: true,
        skillId: 'jina',
        success: true,
        source: 'z-ai-sdk-page_reader',
        duration: Date.now() - startTime,
        resultPreview: `Read page via SDK. Title: ${result.data.title || 'N/A'}`,
      }
    }
  } catch (err) {
    // Fall through
  }

  return {
    ok: false,
    skillId: 'jina',
    success: false,
    source: 'none',
    duration: Date.now() - startTime,
    resultPreview: '',
    error: `Jina API failed (${jinaKeyPool.getAvailableCount()}/${jinaKeyPool.getTotalCount()} keys available) + SDK fallback failed`,
  }
}

async function testWebSearchSDK(startTime: number) {
  try {
    const ZAI = (await import('z-ai-web-dev-sdk')).default
    const zai = await ZAI.create()
    const results = await zai.functions.invoke('web_search', { query: 'test query', num: 1 })
    return {
      ok: true,
      skillId: 'web_search',
      success: true,
      source: 'z-ai-sdk',
      duration: Date.now() - startTime,
      resultPreview: `SDK web_search works. Found ${results?.length || 0} results`,
    }
  } catch (err) {
    return {
      ok: false,
      skillId: 'web_search',
      success: false,
      source: 'z-ai-sdk',
      duration: Date.now() - startTime,
      resultPreview: '',
      error: `SDK web_search failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

async function testPageReaderSDK(startTime: number) {
  try {
    const ZAI = (await import('z-ai-web-dev-sdk')).default
    const zai = await ZAI.create()
    const result = await zai.functions.invoke('page_reader', { url: 'https://example.com' })
    return {
      ok: true,
      skillId: 'page_reader',
      success: true,
      source: 'z-ai-sdk',
      duration: Date.now() - startTime,
      resultPreview: `SDK page_reader works. Title: ${result?.data?.title || 'N/A'}`,
    }
  } catch (err) {
    return {
      ok: false,
      skillId: 'page_reader',
      success: false,
      source: 'z-ai-sdk',
      duration: Date.now() - startTime,
      resultPreview: '',
      error: `SDK page_reader failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}
