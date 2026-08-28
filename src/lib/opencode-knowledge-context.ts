/**
 * OpenCode Knowledge Context Enrichment — Magnum Opus
 * 
 * Enriches OpenCode coding sessions with Knowledge Base context:
 * - Related entities from Neo4j
 * - Related documents from Qdrant
 * - Past corrections and insights from SQLite
 * - Code structure analysis
 */

import { db } from '@/lib/db'
import { agentKnowledgeSearch, type KnowledgeSearchResult } from '@/lib/knowledge-bridge'

// ============================================
// TYPES
// ============================================

export interface KnowledgeEnrichmentResult {
  entities: { name: string; type: string; description: string }[]
  documents: { content: string; score: number; source: string }[]
  corrections: { wrongAnswer: string; correctAnswer: string; reason: string }[]
  insights: { content: string; type: string }[]
  graphPaths: { from: string; to: string; path: string[] }[]
  enrichmentScore: number  // 0-1, how much context was found
}

export interface CodeStructureResult {
  exports: { name: string; type: 'function' | 'class' | 'variable' | 'interface' | 'type' }[]
  imports: { module: string; items: string[] }[]
  dependencies: string[]
}

// ============================================
// MAIN ENRICHMENT FUNCTION
// ============================================

export async function enrichCodeContext(
  query: string,
  filePath?: string
): Promise<KnowledgeEnrichmentResult> {
  const result: KnowledgeEnrichmentResult = {
    entities: [],
    documents: [],
    corrections: [],
    insights: [],
    graphPaths: [],
    enrichmentScore: 0,
  }

  try {
    // 1. Search KB for relevant documents
    try {
      const kbResults = await agentKnowledgeSearch(query, { topK: 5 })
      if (kbResults && kbResults.results) {
        result.documents = kbResults.results.map((r: KnowledgeSearchResult) => ({
          content: r.content?.substring(0, 500) || '',
          score: r.score || 0,
          source: r.source || 'qdrant',
        }))
      }
    } catch {
      // Qdrant may be offline
    }

    // 2. Find related entities from Neo4j — use knowledge-graph API for explore action
    try {
      const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000'
      const graphRes = await fetch(`${baseUrl}/api/openclaw/tools/knowledge-graph`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'explore', entityName: query, limit: 10 }),
        signal: AbortSignal.timeout(8000),
      })
      if (graphRes.ok) {
        const graphData = await graphRes.json()
        // The explore action returns { entities: [{ name, type, description }] }
        const entities = graphData.entities || graphData.neighbors || []
        if (Array.isArray(entities)) {
          result.entities = entities.map((e: { name?: string; entity_name?: string; type?: string; entity_type?: string; description?: string; label?: string }) => ({
            name: e.name || e.entity_name || e.label || '',
            type: e.type || e.entity_type || 'Unknown',
            description: e.description || '',
          }))
        }
      }
    } catch {
      // Neo4j may be offline or explore action may fail
    }

    // 3. Find related corrections
    try {
      const corrections = await db.agentCorrection.findMany({
        where: { applied: true },
        take: 5,
        orderBy: { createdAt: 'desc' },
      })
      result.corrections = corrections.map(c => ({
        wrongAnswer: c.wrongAnswer || '',
        correctAnswer: c.correctAnswer || '',
        reason: c.reason || '',
      }))
    } catch {
      // DB may have issues
    }

    // 4. Find recent insights (especially from OpenCode)
    try {
      const insights = await db.agentInsight.findMany({
        where: {
          OR: [
            { source: 'auto_opencode' },
            { content: { contains: query.substring(0, 30) } },
          ],
        },
        take: 10,
        orderBy: { createdAt: 'desc' },
      })
      result.insights = insights.map(i => ({
        content: i.content || '',
        type: i.type || 'factual',
      }))
    } catch {
      // DB may have issues
    }

    // 5. Calculate enrichment score
    const hasDocs = result.documents.length > 0 ? 0.3 : 0
    const hasEntities = result.entities.length > 0 ? 0.25 : 0
    const hasCorrections = result.corrections.length > 0 ? 0.2 : 0
    const hasInsights = result.insights.length > 0 ? 0.25 : 0
    result.enrichmentScore = Math.min(1, hasDocs + hasEntities + hasCorrections + hasInsights)

  } catch (error) {
    console.error('[opencode-knowledge-context] Error enriching code context:', error)
  }

  return result
}

// ============================================
// CODE STRUCTURE PARSER
// ============================================

export function parseCodeStructure(content: string, filePath: string): CodeStructureResult {
  const result: CodeStructureResult = {
    exports: [],
    imports: [],
    dependencies: [],
  }

  // Parse imports
  const importRegex = /import\s+(?:{([^}]+)}|(\w+))\s+from\s+['"]([^'"]+)['"]/g
  let match
  while ((match = importRegex.exec(content)) !== null) {
    const items = match[1] 
      ? match[1].split(',').map(s => s.trim()).filter(Boolean)
      : match[2] ? [match[2]] : []
    const mod = match[3]
    result.imports.push({ module: mod, items })
    if (!mod.startsWith('.') && !mod.startsWith('/')) {
      result.dependencies.push(mod)
    }
  }

  // Parse exports - functions
  const funcExportRegex = /export\s+(?:async\s+)?function\s+(\w+)/g
  while ((match = funcExportRegex.exec(content)) !== null) {
    result.exports.push({ name: match[1], type: 'function' })
  }

  // Parse exports - classes
  const classExportRegex = /export\s+class\s+(\w+)/g
  while ((match = classExportRegex.exec(content)) !== null) {
    result.exports.push({ name: match[1], type: 'class' })
  }

  // Parse exports - interfaces
  const interfaceExportRegex = /export\s+interface\s+(\w+)/g
  while ((match = interfaceExportRegex.exec(content)) !== null) {
    result.exports.push({ name: match[1], type: 'interface' })
  }

  // Parse exports - types
  const typeExportRegex = /export\s+type\s+(\w+)/g
  while ((match = typeExportRegex.exec(content)) !== null) {
    result.exports.push({ name: match[1], type: 'type' })
  }

  // Parse exports - const/let/var
  const varExportRegex = /export\s+(?:const|let|var)\s+(\w+)/g
  while ((match = varExportRegex.exec(content)) !== null) {
    result.exports.push({ name: match[1], type: 'variable' })
  }

  return result
}

// ============================================
// CODE QUERY DETECTION
// ============================================

const CODE_QUERY_PATTERNS = [
  /\b(fix|sửa|fix bug)\b/i,
  /\b(refactor|tái cấu trúc)\b/i,
  /\b(implement|triển khai|xây dựng)\b/i,
  /\b(write code|viết code)\b/i,
  /\b(debug|gỡ lỗi)\b/i,
  /\b(optimize|tối ưu)\b/i,
  /\b(add feature|thêm tính năng)\b/i,
  /\b(update|cập nhật)\b.*\b(code|file|function)\b/i,
  /\b(create|tạo)\b.*\b(component|module|api|function)\b/i,
  /\b(review code|kiểm tra code)\b/i,
  /\b(write test|viết test)\b/i,
  /\b(document|tài liệu hóa)\b.*\b(code)\b/i,
  /\.(ts|tsx|js|jsx|py|go|rs|java|c|cpp|h)\b/i,
  /\b(auth|api|route|component|module|service|handler)\b/i,
  /\b(function|class|method|variable|interface)\b/i,
  /\b(compile|build|run)\b/i,
  /\b(error|bug|issue|problem)\b.*\b(code|file)\b/i,
]

export function isCodeQuery(query: string): boolean {
  // If the query matches any code-related pattern, it's a code query
  return CODE_QUERY_PATTERNS.some(pattern => pattern.test(query))
}

export function detectCodeConfidence(query: string): number {
  let score = 0
  for (const pattern of CODE_QUERY_PATTERNS) {
    if (pattern.test(query)) {
      score += 0.15
    }
  }
  return Math.min(1, score)
}

// ============================================
// INSIGHT EXTRACTION (for auto-knowledge capture)
// ============================================

export interface ExtractedInsight {
  content: string
  type: 'factual' | 'procedural' | 'pattern'
  confidence: number
  entityName?: string
  entityType?: string
}

export function extractInsightsFromSessionData(
  summary: string,
  filesChanged: string[],
  toolsUsed: string[]
): ExtractedInsight[] {
  const insights: ExtractedInsight[] = []

  // Pattern: file was modified → create code module insight
  for (const file of filesChanged) {
    insights.push({
      content: `File ${file} đã được sửa đổi trong coding session`,
      type: 'factual',
      confidence: 0.7,
      entityName: file,
      entityType: 'CodeFile',
    })
  }

  // Pattern: knowledge_search was used → session leveraged KB
  if (toolsUsed.includes('knowledge_search')) {
    insights.push({
      content: 'Coding session đã sử dụng Knowledge Base để tìm kiếm context',
      type: 'pattern',
      confidence: 0.8,
    })
  }

  // Pattern: LSP was used → session verified code quality
  if (toolsUsed.includes('lsp_diagnostics') || toolsUsed.includes('file_edit')) {
    insights.push({
      content: 'Code changes đã được verify qua LSP diagnostics',
      type: 'procedural',
      confidence: 0.85,
    })
  }

  // Pattern: summary contains key insights
  const summaryLines = summary.split('\n').filter(l => l.trim())
  for (const line of summaryLines) {
    const trimmed = line.trim()
    // Detect factual statements
    if (/^(sửa|fix|thêm|add|cập nhật|update|xóa|remove|tạo|create)/i.test(trimmed)) {
      insights.push({
        content: trimmed,
        type: 'procedural',
        confidence: 0.75,
      })
    }
    // Detect patterns
    if (/luôn|always|never|không bao giờ|should|nên|must|phải/i.test(trimmed)) {
      insights.push({
        content: trimmed,
        type: 'pattern',
        confidence: 0.8,
      })
    }
  }

  return insights
}
