// R24-a: đếm số chunk đã có entities (phủ extraction) cho doc trial
import { db } from '../src/lib/db'
const DOC = process.argv[2] || 'c46fdb42-4bc5-4cea-8822-635c3c8efb3e'
async function main() {
  const ents = await db.localEntity.findMany({ where: { documentId: DOC }, select: { chunkId: true } })
  const covered = new Set(ents.map(e => e.chunkId).filter(Boolean))
  const rels = await db.localRelationship.count({ where: { documentId: DOC } })
  const entCount = await db.localEntity.count({ where: { documentId: DOC } })
  const doc = await db.document.findUnique({ where: { id: DOC }, select: { status: true, pageCount: true } })
  console.log(JSON.stringify({ doc: DOC, status: doc?.status, pageCount: doc?.pageCount, entities: entCount, relationships: rels, chunksWithEntities: covered.size, chunksMissing: 58 - covered.size }))
}
main().catch(e => { console.error(e); process.exit(1) })
