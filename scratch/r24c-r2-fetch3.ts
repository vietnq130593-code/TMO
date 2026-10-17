import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'
import { writeFileSync } from 'fs'
const env = (k: string) => process.env[k] || ''
const s3 = new S3Client({ region: 'auto', endpoint: env('R2_ENDPOINT'), credentials: { accessKeyId: env('R2_ACCESS_KEY_ID'), secretAccessKey: env('R2_SECRET_ACCESS_KEY') } })
// 4 bản giàu dữ liệu nhất trước reset: 10-08 (41MB), 10-11 (20MB), 10-15 (24MB), 10-07 (23MB)
for (const key of ['backups/sqlite/custom-2026-10-08T23-17-01-012Z.db', 'backups/sqlite/custom-2026-10-11T23-48-24-048Z.db', 'backups/sqlite/custom-2026-10-15T05-59-22-820Z.db']) {
  const obj = await s3.send(new GetObjectCommand({ Bucket: env('R2_BUCKET_NAME'), Key: key }))
  const buf = Buffer.from(await obj.Body!.transformToByteArray())
  const name = '/home/z/tmo-app/scratch/r24c-' + key.split('/').pop()!
  writeFileSync(name, buf)
  console.log('SAVED', name, buf.length)
}
