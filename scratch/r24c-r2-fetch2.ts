// Lấy bản 10-16 14:18 (pre-D0, pre-reset?) kiểm tra
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'
import { writeFileSync } from 'fs'
const env = (k: string) => process.env[k] || ''
const s3 = new S3Client({ region: 'auto', endpoint: env('R2_ENDPOINT'), credentials: { accessKeyId: env('R2_ACCESS_KEY_ID'), secretAccessKey: env('R2_SECRET_ACCESS_KEY') } })
for (const key of ['backups/sqlite/custom-2026-10-16T14-18-51-982Z.db', 'backups/sqlite/custom-2026-10-15T13-00-00-000Z.db']) {
  try {
    const obj = await s3.send(new GetObjectCommand({ Bucket: env('R2_BUCKET_NAME'), Key: key }))
    const buf = Buffer.from(await obj.Body!.transformToByteArray())
    const name = '/home/z/tmo-app/scratch/r24c-' + key.split('/').pop()!
    writeFileSync(name, buf)
    console.log('SAVED', name, buf.length)
  } catch (e) { console.log('MISS', key) }
}
