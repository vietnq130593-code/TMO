// R24-c: lấy backup SQLite mới nhất từ R2 để tạo benchmark fixtures từ dữ liệu THẬT (Q1)
import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3'
import { writeFileSync } from 'fs'

const env = (k: string) => process.env[k] || ''
const s3 = new S3Client({
  region: 'auto',
  endpoint: env('R2_ENDPOINT'),
  credentials: { accessKeyId: env('R2_ACCESS_KEY_ID'), secretAccessKey: env('R2_SECRET_ACCESS_KEY') },
})
const bucket = env('R2_BUCKET_NAME')
const list = await s3.send(new ListObjectsV2Command({ Bucket: bucket }))
const keys = (list.Contents || []).map(o => ({ key: o.Key!, size: o.Size!, date: o.LastModified?.toISOString() || '' }))
console.log(JSON.stringify(keys.filter(k => /sqlite|backup|db/i.test(k.key)).sort((a, b) => a.date.localeCompare(b.date)), null, 1))
// Lấy bản MỚI NHẤT dạng .db/.sqlite
const cands = keys.filter(k => /\.(db|sqlite|sqlite3)$/i.test(k.key)).sort((a, b) => a.date.localeCompare(b.date))
if (cands.length === 0) { console.log('NO_SQLITE_BACKUP'); process.exit(0) }
const latest = cands[cands.length - 1]
console.log('LATEST:', latest.key, latest.size, latest.date)
const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: latest.key }))
const buf = Buffer.from(await obj.Body!.transformToByteArray())
writeFileSync('/home/z/tmo-app/scratch/r24c-backup.db', buf)
console.log('SAVED scratch/r24c-backup.db', buf.length, 'bytes')
