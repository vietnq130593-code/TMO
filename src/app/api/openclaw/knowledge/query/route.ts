/**
 * Knowledge Query API — Execute read-only queries against Neo4j (Cypher) or SQLite
 *
 * POST /api/openclaw/knowledge/query
 * Body: { type: "cypher" | "sql", query: string }
 *
 * Safety:
 * - Only MATCH (Cypher) and SELECT (SQL) queries allowed
 * - Blocks CREATE, DELETE, DROP, REMOVE, SET, INSERT, UPDATE, ALTER, TRUNCATE
 * - Auto-adds LIMIT if not present (max 100)
 * - 5 second timeout
 */

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { enforceSqlLimit, isReadOnlySql, redactSqlForLog } from '@/lib/sql-policy'

export const dynamic = 'force-dynamic'

/** Hard cap cho SQL knowledge API — không cho agent kéo nguyên bảng về. */
const SQL_MAX_LIMIT = 100

const BLOCKED_KEYWORDS = [
  'CREATE', 'DELETE', 'DROP', 'REMOVE', 'SET',
  'INSERT', 'UPDATE', 'ALTER', 'TRUNCATE', 'MERGE',
]

function isReadOnlyQuery(type: 'cypher' | 'sql', query: string): { safe: boolean; reason?: string } {
  const normalized = query.trim().toUpperCase()

  if (type === 'cypher') {
    if (!normalized.startsWith('MATCH') && !normalized.startsWith('RETURN')) {
      return { safe: false, reason: 'Cypher queries must start with MATCH or RETURN' }
    }
    const upperWords = normalized.split(/[\s(;,]+/)
    for (const word of upperWords) {
      if (BLOCKED_KEYWORDS.includes(word)) {
        return { safe: false, reason: `Keyword "${word}" is not allowed. Only read queries are permitted.` }
      }
    }
  }

  if (type === 'sql') {
    // P0-3: dùng chính sách dùng chung (src/lib/sql-policy.ts) thay vì so khớp
    // từ trên chuỗi THÔ. Bản cũ quét `normalized` (chưa mask string literal) nên
    // attacker giấu payload sau một literal — ví dụ
    //   SELECT 'x; DROP TABLE T' FROM sqlite_master
    // — vẫn lọt vì `;` và `DROP` nằm trong từ thứ 2 (BLOCKED_KEYWORDS chỉ so
    // key chính xác). sql-policy mask literal/comment TRƯỚC rồi mới quét, và
    // chặn multi-statement `; <non-space>` ở mọi vị trí.
    const verdict = isReadOnlySql(query)
    if (!verdict.safe) return { safe: false, reason: verdict.reason }
  }

  return { safe: true }
}

function addLimitIfNeeded(type: 'cypher' | 'sql', query: string, maxLimit = 100): string {
  if (type === 'sql') {
    // Bọc subquery thay vì nối " LIMIT 100" vào CUỐI câu: bản cũ dò chữ
    // `normalized.includes('LIMIT')` trên chuỗi thô → query
    // `SELECT ... AS "LIMIT"` (có chữ LIMIT trong literal) bị bỏ sót không LIMIT,
    // và `LIMIT 999999` do người dùng đưa vào vẫn qua. Bọc luôn → cap cứng.
    return enforceSqlLimit(query, maxLimit, SQL_MAX_LIMIT)
  }
  const normalized = query.trim().toUpperCase()
  if (!normalized.includes('LIMIT')) {
    return `${query.trim()} LIMIT ${maxLimit}`
  }
  return query.trim()
}

async function executeCypherQuery(query: string) {
  const { safeSession } = await import('@/lib/neo4j')
  let session: import('neo4j-driver').Session | null = null
  try {
    session = await safeSession()
  } catch (err: any) {
    return { records: [], count: 0, columns: [], error: 'Neo4j driver not available: ' + (err instanceof Error ? err.message : String(err)) }
  }
  try {
    const result = await session.run(query, {}, { timeout: 5000 })
    const columns = result.records.length > 0 ? result.records[0].keys : []
    const records = result.records.slice(0, 100).map(record => {
      const obj: Record<string, unknown> = {}
      // Neo4j Record.keys typed là (string|number|symbol)[] (keyof RecordShape)
      // — key thật luôn là string; cast một lần để dùng làm index
      for (const key of record.keys as string[]) {
        const val = record.get(key)
        // Convert Neo4j Integer to number
        if (val !== null && typeof val === 'object' && typeof val.toNumber === 'function') {
          obj[key] = val.toNumber()
        } else if (val !== null && typeof val === 'object' && typeof val.properties === 'object' && Array.isArray(val.labels)) {
          // Neo4j Node
          const nodeProps: Record<string, unknown> = {}
          for (const [k, v] of Object.entries(val.properties as Record<string, unknown>)) {
            if (v !== null && typeof v === 'object' && typeof (v as { toNumber?: unknown }).toNumber === 'function') {
              nodeProps[k] = (v as { toNumber: () => number }).toNumber()
            } else {
              nodeProps[k] = v
            }
          }
          obj[key] = { ...nodeProps, _labels: val.labels }
        } else if (val !== null && typeof val === 'object' && typeof val.properties === 'object' && typeof val.type === 'string') {
          // Neo4j Relationship
          const relProps: Record<string, unknown> = {}
          for (const [k, v] of Object.entries(val.properties as Record<string, unknown>)) {
            if (v !== null && typeof v === 'object' && typeof (v as { toNumber?: unknown }).toNumber === 'function') {
              relProps[k] = (v as { toNumber: () => number }).toNumber()
            } else {
              relProps[k] = v
            }
          }
          obj[key] = { ...relProps, _type: val.type }
        } else {
          obj[key] = val
        }
      }
      return obj
    })

    return { records, count: records.length, columns }
  } finally {
    await session?.close().catch(() => {})
  }
}

async function executeSqlQuery(query: string) {
  // Defense-in-depth: executeSqlQuery là hàm duy nhất chạm $queryRawUnsafe của
  // route này — kiểm tra lại ở ĐÂY (không chỉ ở POST) để một call site tương lai
  // gọi thẳng hàm này với SQL chưa qua guard cũng bị chặn.
  const verdict = isReadOnlySql(query)
  if (!verdict.safe) throw new Error(`read-only guard: ${verdict.reason}`)
  const results = await db.$queryRawUnsafe<Record<string, unknown>[]>(query)
  const columns = results.length > 0 ? Object.keys(results[0]) : []
  return { records: results, count: results.length, columns }
}

export async function POST(request: NextRequest) {
  let reqType = '?'
  try {
    const body = await request.json()
    const { type, query } = body
    reqType = typeof type === 'string' ? type : '?'

    if (!type || !query) {
      return NextResponse.json(
        { error: 'type and query are required' },
        { status: 400 }
      )
    }

    if (type !== 'cypher' && type !== 'sql') {
      return NextResponse.json(
        { error: 'type must be "cypher" or "sql"' },
        { status: 400 }
      )
    }

    // Validate query is read-only
    const safetyCheck = isReadOnlyQuery(type, query)
    if (!safetyCheck.safe) {
      // Log ĐÃ redact (literal → `?`) — không rò nội dung truy vấn/dữ liệu vào log.
      console.warn(
        `[KnowledgeQuery] rejected type=${type} reason=${safetyCheck.reason} sql=${redactSqlForLog(query)}`
      )
      return NextResponse.json(
        { error: safetyCheck.reason },
        { status: 403 }
      )
    }

    // Auto-add LIMIT if not present
    const safeQuery = addLimitIfNeeded(type, query, SQL_MAX_LIMIT)

    // Execute with timeout
    let result
    if (type === 'cypher') {
      result = await executeCypherQuery(safeQuery)
    } else {
      result = await executeSqlQuery(safeQuery)
    }

    if (result.error) {
      return NextResponse.json(
        { error: result.error },
        { status: 503 }
      )
    }

    return NextResponse.json({
      records: result.records,
      count: result.count,
      columns: result.columns,
      query: safeQuery,
      type,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // Log redact: lỗi SQLite có thể chứa cả câu query (kèm literal) trong message.
    console.error(`[KnowledgeQuery] execution failed type=${reqType} err=${message}`)
    return NextResponse.json(
      { error: 'Query execution failed', details: message },
      { status: 500 }
    )
  }
}
