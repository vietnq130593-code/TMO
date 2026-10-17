import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3'
const env = (k: string) => process.env[k] || ''
const s3 = new S3Client({ region: 'auto', endpoint: env('R2_ENDPOINT'), credentials: { accessKeyId: env('R2_ACCESS_KEY_ID'), secretAccessKey: env('R2_SECRET_ACCESS_KEY') } })
const list = await s3.send(new ListObjectsV2Command({ Bucket: env('R2_BUCKET_NAME') }))
const rows = (list.Contents || []).filter(o => /sqlite/i.test(o.Key!)).sort((a, b) => a.LastModified!.toISOString().localeCompare(b.LastModified!.toISOString()))
for (const o of rows) console.log(o.Key!, o.Size, o.LastModified!.toISOString())
