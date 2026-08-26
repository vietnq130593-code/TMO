/**
 * Knowledge Bridge Library
 *
 * Connects OpenClaw Agents to the local Knowledge Base (Qdrant + Neo4j + SQLite).
 * Provides search, graph query, and write capabilities for agents.
 *
 * Uses NVIDIA nemotron-3-embed-1b (2048-dim) for embedding queries.
 */

import { db } from '@/lib/db'

// ==================== KNOWLEDGE SEARCH ====================

export interface KnowledgeSearchResult {
  type: 'chunk' | 'entity' | 'relationship'
  content: string
  source?: string
  entityName?: string
  entityType?: string
  score?: number
  relationshipType?: string
  sourceEntity?: string
  targetEntity?: string
}

export async function agentKnowledgeSearch(query: string, options?: {
  topK?: number
  expandGraph?: boolean
  domain?: string
}): Promise<{ results: KnowledgeSearchResult[]; answer?: string }> {
  try {
    // Use the existing /api/query infrastructure internally
    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000'
    const res = await fetch(`${baseUrl}/api/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        chatHistory: [],
      }),
      signal: AbortSignal.timeout(30000),
    })

    if (res.ok) {
      const data = await res.json()
      const results: KnowledgeSearchResult[] = []

      // Convert sources to structured results
      if (data.sources) {
        for (const src of data.sources) {
          results.push({
            type: src.type || 'chunk',
            content: src.content,
            source: src.documentTitle,
            entityName: src.entityName,
            score: src.similarity,
          })
        }
      }

      return { results, answer: data.answer }
    }
  } catch (err) {
    console.error('[Knowledge Bridge] Search error:', err)
  }

  return { results: [] }
}

// ==================== GRAPH QUERY ====================

export async function agentGraphQuery(cypher: string, params?: Record<string, unknown>) {
  // Safety: only allow read queries
  const normalized = cypher.trim().toUpperCase()
  if (normalized.startsWith('CREATE') || normalized.startsWith('DELETE') || normalized.startsWith('DROP') || normalized.startsWith('REMOVE') || normalized.startsWith('SET')) {
    throw new Error('Only MATCH queries are allowed for agent graph queries')
  }

  try {
    const { safeSession, toNative } = await import('@/lib/neo4j')
    let session: import('neo4j-driver').Session | null = null
    try {
      session = await safeSession()
    } catch {
      return { records: [], count: 0, error: 'Neo4j driver not available' }
    }
    try {
      const result = await session.run(cypher, params || {})
      const records = result.records.slice(0, 100).map(record => {
        const obj: Record<string, unknown> = {}
        for (const key of record.keys as string[]) {
          obj[key] = toNative(record.get(key))
        }
        return obj
      })
      return { records, count: records.length }
    } finally {
      await session?.close().catch(() => {})
    }
  } catch (err) {
    console.error('[Knowledge Bridge] Graph query error:', err)
    return { records: [], count: 0, error: err instanceof Error ? err.message : String(err) }
  }
}

// ==================== KNOWLEDGE WRITE ====================

export async function agentWriteEntity(data: {
  entityName: string
  entityType: string
  description: string
  domain: string
  properties?: Record<string, unknown>
}) {
  // Write to SQLite buffer (LocalEntity) — will be synced to Neo4j later
  const entity = await db.localEntity.create({
    data: {
      entityName: data.entityName,
      entityType: data.entityType,
      description: data.description,
      domain: data.domain,
      properties: data.properties ? JSON.stringify(data.properties) : null,
      source: 'agent',
      synced: false,
    },
  })
  return { id: entity.id, entityName: entity.entityName }
}

export async function agentWriteRelationship(data: {
  sourceEntityName: string
  targetEntityName: string
  relationshipType: string
  description: string
}) {
  // Find source and target entities
  const source = await db.localEntity.findFirst({ where: { entityName: data.sourceEntityName } })
  const target = await db.localEntity.findFirst({ where: { entityName: data.targetEntityName } })

  const relationship = await db.localRelationship.create({
    data: {
      sourceEntityId: source?.id || null,
      targetEntityId: target?.id || null,
      sourceEntityName: data.sourceEntityName,
      targetEntityName: data.targetEntityName,
      relationshipType: data.relationshipType,
      description: data.description,
      source: 'agent',
      synced: false,
    },
  })
  return { id: relationship.id, type: relationship.relationshipType }
}

// ==================== SYSTEM PROMPT GENERATION ====================

export async function generateSystemPromptContext(): Promise<string> {
  const parts: string[] = []

  // Prisma schema summary
  const modelNames = ['JobQueue', 'DailyTokenUsage', 'DailyTokenByProvider', 'DailyTokenByProviderSlot', 'DailyTokenByProviderModel', 'LocalEntity', 'LocalRelationship', 'LocalResolvedEntity', 'AgentProfile', 'AgentSession', 'LearningLog', 'AgentInsight', 'AgentCorrection', 'AgentPreference', 'AgentSkill', 'ToolPermission', 'KnowledgeAccessPolicy', 'CronJob', 'Webhook', 'StandingOrder', 'TaskExecution', 'ChannelConfig', 'OpenCodeSession', 'MCPBridgeConfig']
  parts.push(`SQLite Models: ${modelNames.join(', ')}`)

  // Neo4j info
  try {
    const { safeSession } = await import('@/lib/neo4j')
    let session: import('neo4j-driver').Session | null = null
    try {
      session = await safeSession()
    } catch {
      parts.push('Neo4j: Not connected')
      parts.push(`Qdrant Collections: theopus_documents, theopus_chunks (2048-dim vectors)`)
      parts.push(`Embedding Model: nvidia/nemotron-3-embed-1b (2048-dim)`)
      return parts.join('\n')
    }
    try {
      const labelsResult = await session.run('CALL db.labels()')
      const labels = labelsResult.records.map(r => r.get(0))
      parts.push(`Neo4j Node Labels: ${labels.join(', ')}`)

      const relResult = await session.run('CALL db.relationshipTypes()')
      const relTypes = relResult.records.map(r => r.get(0))
      parts.push(`Neo4j Relationship Types: ${relTypes.join(', ')}`)

      const countResult = await session.run('MATCH (n) RETURN count(n) as count')
      const nodeCount = countResult.records[0]?.get('count')?.toNumber() || 0
      parts.push(`Neo4j Total Nodes: ${nodeCount}`)
    } finally {
      await session?.close().catch(() => {})
    }
  } catch {
    parts.push('Neo4j: Not connected')
  }

  // Qdrant info
  parts.push(`Qdrant Collections: theopus_documents, theopus_chunks (2048-dim vectors)`)
  parts.push(`Embedding Model: nvidia/nemotron-3-embed-1b (2048-dim)`)

  return parts.join('\n')
}

// ==================== SCHEMA INFO ====================

export async function getSchemaInfo() {
  const schema: {
    prisma: { models: string[] }
    neo4j: { labels: string[]; relationshipTypes: string[]; nodeCount: number; relationshipCount: number }
    qdrant: { collections: Array<{ name: string; vectorSize: number }>; embeddingModel: string }
  } = {
    prisma: { models: ['JobQueue', 'DailyTokenUsage', 'DailyTokenByProvider', 'DailyTokenByProviderSlot', 'DailyTokenByProviderModel', 'LocalEntity', 'LocalRelationship', 'LocalResolvedEntity', 'AgentProfile', 'AgentSession', 'LearningLog', 'AgentInsight', 'AgentCorrection', 'AgentPreference', 'AgentSkill', 'ToolPermission', 'KnowledgeAccessPolicy', 'CronJob', 'Webhook', 'StandingOrder', 'TaskExecution', 'ChannelConfig', 'OpenCodeSession', 'MCPBridgeConfig'] },
    neo4j: { labels: [], relationshipTypes: [], nodeCount: 0, relationshipCount: 0 },
    qdrant: { collections: [{ name: 'theopus_documents', vectorSize: 2048 }, { name: 'theopus_chunks', vectorSize: 2048 }], embeddingModel: 'nvidia/nemotron-3-embed-1b' },
  }

  try {
    const { safeSession } = await import('@/lib/neo4j')
    let session: import('neo4j-driver').Session | null = null
    try {
      session = await safeSession()
    } catch {
      return schema
    }
    try {
      const labelsResult = await session.run('CALL db.labels()')
      schema.neo4j.labels = labelsResult.records.map(r => r.get(0) as string)

      const relResult = await session.run('CALL db.relationshipTypes()')
      schema.neo4j.relationshipTypes = relResult.records.map(r => r.get(0) as string)

      const countResult = await session.run('MATCH (n) RETURN count(n) as nodes, 0 as rels')
      schema.neo4j.nodeCount = countResult.records[0]?.get('nodes')?.toNumber() || 0

      const relCountResult = await session.run('MATCH ()-[r]->() RETURN count(r) as rels')
      schema.neo4j.relationshipCount = relCountResult.records[0]?.get('rels')?.toNumber() || 0
    } finally {
      await session?.close().catch(() => {})
    }
  } catch {}

  return schema
}
