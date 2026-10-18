/**
 * R38 — coverage NEW-id cho 1 doc (BẢN 2 — không import qdrant lib để tránh treo
 * module side-effect): scroll Qdrant bằng fetch thuần, SQL qua prisma.
 * In ra: <covered>/<total> — covered = chunk hiện tại có entities trong LocalEntity.
 * Usage: bun scratch/r38-coverage-new.ts <docId>
 */
import { db } from '../src/lib/db'

const docId = process.argv[2]
if (!docId) { console.log('0/0'); process.exit(0) }

async function scrollIds(): Promise<string[]> {
  const ids: string[] = []
  let offset: string | number | undefined = undefined
  for (let page = 0; page < 30; page++) {
    const body: Record<string, unknown> = {
      filter: { must: [{ key: 'document_id', match: { value: docId } }] },
      limit: 300, with_payload: false, with_vector: false,
    }
    if (offset !== undefined) body.offset = offset
    const res = await fetch('http://localhost:6333/collections/theopus_chunks/points/scroll', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) throw new Error(`scroll ${res.status}`)
    const j: any = await res.json()
    for (const p of j.result.points) ids.push(String(p.id))
    if (!j.result.next_page_offset) break
    offset = j.result.next_page_offset
  }
  return ids
}

async function main() {
  const ids = await scrollIds()
  const rows = await db.localEntity.findMany({ where: { documentId: docId }, select: { chunkId: true } }) as Array<{ chunkId: string | null }>
  const coveredSet = new Set(rows.map(r => r.chunkId).filter(Boolean) as string[])
  const covered = ids.filter(id => coveredSet.has(id)).length
  console.log(`${covered}/${ids.length}`)
  process.exit(0)
}
main().catch(e => { console.log(`ERR/${String(e.message).slice(0, 60)}`); process.exit(0) })
