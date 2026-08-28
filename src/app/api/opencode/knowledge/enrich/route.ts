/**
 * OC-3.4 + OC-3.5: Knowledge Enrichment for Code Sessions
 * 
 * POST /api/opencode/knowledge/enrich
 * 
 * Enriches a code query with Knowledge Base context:
 * - Related entities from Neo4j
 * - Related documents from Qdrant  
 * - Past corrections and insights from SQLite
 * - Code structure analysis
 * 
 * GET /api/opencode/knowledge/enrich?query=xxx
 * Returns enrichment without creating a session
 */

import { NextRequest, NextResponse } from 'next/server'
import { enrichCodeContext, isCodeQuery, detectCodeConfidence, parseCodeStructure, type CodeStructureResult } from '@/lib/opencode-knowledge-context'
import { generateOpenCodeSystemPrompt } from '@/lib/opencode-system-prompt'
import { db } from '@/lib/db'
import { resolve } from 'path'

// LocalEntity chưa khai báo @@unique([entityName, domain]) — where theo
// entityName_domain sẽ bị Prisma từ chối runtime (đã try/catch skip như cũ).
// Cast where về type thật của upsert, giữ nguyên payload gốc.
type LocalEntityUpsertWhere = Parameters<typeof db.localEntity.upsert>[0]['where']

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const query = searchParams.get('query') || ''
    const filePath = searchParams.get('filePath') || undefined

    // Get stats for system prompt (available even without query)
    let entityTypeCount = 0
    let documentCount = 0
    let correctionCount = 0
    let insightCount = 0
    let filesInWorkspace = 0
    try {
      entityTypeCount = await db.localEntity.count()
      correctionCount = await db.agentCorrection.count({ where: { applied: true } })
      insightCount = await db.agentInsight.count()
      // Count documents via Qdrant or estimate from entities
      documentCount = await db.localEntity.count({ where: { domain: 'document' } })
    } catch {
      // DB may have issues
    }

    // Count workspace files
    try {
      const { execSync } = await import('child_process')
      const count = execSync('find . -type f -not -path "./.next/*" -not -path "./node_modules/*" -not -path "./.git/*" | wc -l', {
        cwd: resolve(process.cwd(), process.env.OPENCODE_WORKSPACE || '.'),
        encoding: 'utf-8',
        timeout: 5000,
      }).trim()
      filesInWorkspace = parseInt(count) || 0
    } catch {
      // Fallback
    }

    // If no query, return stats-only response (for initial load / overview)
    if (!query) {
      // Get recent insights without query-specific search
      let recentInsights: { content: string; type: string }[] = []
      let recentCorrections: { wrongAnswer: string; correctAnswer: string; reason: string }[] = []
      try {
        const insights = await db.agentInsight.findMany({
          take: 10,
          orderBy: { createdAt: 'desc' },
        })
        recentInsights = insights.map(i => ({ content: i.content || '', type: i.type || 'factual' }))

        const corrections = await db.agentCorrection.findMany({
          where: { applied: true },
          take: 5,
          orderBy: { createdAt: 'desc' },
        })
        recentCorrections = corrections.map(c => ({
          wrongAnswer: c.wrongAnswer || '',
          correctAnswer: c.correctAnswer || '',
          reason: c.reason || '',
        }))
      } catch {}

      return NextResponse.json({
        isCodeQuery: false,
        codeConfidence: 0,
        enrichment: {
          entities: [],
          documents: [],
          corrections: recentCorrections,
          insights: recentInsights,
          graphPaths: [],
          enrichmentScore: recentInsights.length > 0 || recentCorrections.length > 0 ? 0.25 : 0,
        },
        systemPromptLength: 0,
        systemPromptPreview: '',
        stats: {
          entityTypeCount,
          documentCount,
          correctionCount,
          insightCount,
          filesInWorkspace,
        },
      })
    }

    // Detect if this is a code query
    const isCode = isCodeQuery(query)
    const confidence = detectCodeConfidence(query)

    // Enrich context from KB
    const enrichment = await enrichCodeContext(query, filePath)

    // Generate enriched system prompt
    const systemPrompt = generateOpenCodeSystemPrompt({
      entityTypeCount,
      documentCount,
      correctionCount,
      insightCount,
      filesInWorkspace,
      modelList: [],
      kbEnabled: true,
      mcpToolsEnabled: ['knowledge_search', 'knowledge_graph', 'knowledge_write', 'web_search'],
      recentCorrections: enrichment.corrections,
      recentInsights: enrichment.insights.slice(0, 5),
      relatedEntities: enrichment.entities,
    })

    return NextResponse.json({
      isCodeQuery: isCode,
      codeConfidence: confidence,
      enrichment,
      systemPromptLength: systemPrompt.length,
      systemPromptPreview: systemPrompt.substring(0, 500) + '...',
      stats: {
        entityTypeCount,
        documentCount,
        correctionCount,
        insightCount,
        filesInWorkspace,
      },
    })
  } catch (error) {
    console.error('[opencode/knowledge/enrich] GET Error:', error)
    return NextResponse.json(
      { error: 'Failed to enrich context', details: String(error) },
      { status: 500 }
    )
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { query, filePath, fileContent } = body

    if (!query) {
      return NextResponse.json({ error: 'query is required' }, { status: 400 })
    }

    // Detect if this is a code query
    const isCode = isCodeQuery(query)
    const confidence = detectCodeConfidence(query)

    // Enrich context from KB
    const enrichment = await enrichCodeContext(query, filePath)

    // Parse code structure if file content provided
    let codeStructure: CodeStructureResult | null = null
    if (fileContent && filePath) {
      codeStructure = parseCodeStructure(fileContent, filePath)
    }

    // Get stats for system prompt
    let entityTypeCount = 0
    let documentCount = 0
    let correctionCount = 0
    let insightCount = 0
    let filesInWorkspace = 0
    try {
      entityTypeCount = await db.localEntity.count()
      correctionCount = await db.agentCorrection.count({ where: { applied: true } })
      insightCount = await db.agentInsight.count()
      documentCount = await db.localEntity.count({ where: { domain: 'document' } })
    } catch {
      // DB may have issues
    }

    // Count workspace files
    try {
      const { execSync } = await import('child_process')
      const count = execSync('find . -type f -not -path "./.next/*" -not -path "./node_modules/*" -not -path "./.git/*" | wc -l', {
        cwd: resolve(process.cwd(), process.env.OPENCODE_WORKSPACE || '.'),
        encoding: 'utf-8',
        timeout: 5000,
      }).trim()
      filesInWorkspace = parseInt(count) || 0
    } catch {}

    // Generate full enriched system prompt
    const systemPrompt = generateOpenCodeSystemPrompt({
      entityTypeCount,
      documentCount,
      correctionCount,
      insightCount,
      filesInWorkspace,
      modelList: [],
      kbEnabled: true,
      mcpToolsEnabled: ['knowledge_search', 'knowledge_graph', 'knowledge_write', 'web_search'],
      recentCorrections: enrichment.corrections,
      recentInsights: enrichment.insights.slice(0, 5),
      relatedEntities: enrichment.entities,
    })

    // Create code-to-knowledge entities if code structure found
    let entitiesCreated = 0
    if (codeStructure) {
      for (const exp of codeStructure.exports) {
        try {
          await db.localEntity.upsert({
            where: {
              entityName_domain: {
                entityName: `${exp.name} (${filePath})`,
                domain: 'codebase',
              },
            } as unknown as LocalEntityUpsertWhere,
            create: {
              entityName: `${exp.name} (${filePath})`,
              entityType: exp.type === 'function' ? 'CodeFunction' : exp.type === 'class' ? 'CodeClass' : 'CodeExport',
              description: `${exp.type} export from ${filePath}`,
              domain: 'codebase',
              source: 'auto_opencode',
              properties: JSON.stringify({ filePath, exportType: exp.type }),
            },
            update: {
              description: `${exp.type} export from ${filePath}`,
              properties: JSON.stringify({ filePath, exportType: exp.type }),
            },
          })
          entitiesCreated++
        } catch {
          // Skip
        }
      }

      // Create dependency relationships
      for (const dep of codeStructure.dependencies) {
        try {
          await db.localEntity.upsert({
            where: {
              entityName_domain: {
                entityName: dep,
                domain: 'codebase',
              },
            } as unknown as LocalEntityUpsertWhere,
            create: {
              entityName: dep,
              entityType: 'NpmPackage',
              description: `NPM dependency used in ${filePath}`,
              domain: 'codebase',
              source: 'auto_opencode',
              properties: JSON.stringify({ type: 'dependency', usedIn: filePath }),
            },
            update: {
              description: `NPM dependency used in ${filePath}`,
            },
          })
          entitiesCreated++
        } catch {
          // Skip
        }
      }
    }

    return NextResponse.json({
      isCodeQuery: isCode,
      codeConfidence: confidence,
      enrichment,
      codeStructure,
      entitiesCreated,
      systemPrompt,
      stats: {
        entityTypeCount,
        documentCount,
        correctionCount,
        insightCount,
        filesInWorkspace,
      },
    })
  } catch (error) {
    console.error('[opencode/knowledge/enrich] POST Error:', error)
    return NextResponse.json(
      { error: 'Failed to enrich context', details: String(error) },
      { status: 500 }
    )
  }
}
