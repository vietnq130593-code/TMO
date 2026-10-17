// Verify cấu hình phòng sau restore: Neo4j Aura + R2 + NIM (một script, fail độc lập)
async function verifyNeo4j() {
  const neo4j = (await import('neo4j-driver')).default
  const driver = neo4j.driver(
    process.env.NEO4J_URI!,
    neo4j.auth.basic(process.env.NEO4J_USER!, process.env.NEO4J_PASSWORD!),
    { connectionTimeout: 15000 },
  )
  try {
    const s = driver.session({ database: process.env.NEO4J_DATABASE || undefined })
    const ping = await s.run('RETURN 1 AS ok')
    const cnt = await s.run('MATCH (n) RETURN count(n) AS cnt')
    const labels = await s.run('CALL db.labels() YIELD label RETURN collect(label) AS labels')
    console.log('[NEO4J] PING_OK =', ping.records[0].get('ok'),
      '| NODE_COUNT =', cnt.records[0].get('cnt').toString(),
      '| LABELS =', JSON.stringify(labels.records[0].get('labels')))
    await s.close()
  } finally {
    await driver.close()
  }
}

async function verifyR2() {
  const { S3Client, ListObjectsV2Command } = await import('@aws-sdk/client-s3')
  const client = new S3Client({
    region: 'auto',
    endpoint: process.env.R2_ENDPOINT,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    },
  })
  const r = await client.send(
    new ListObjectsV2Command({ Bucket: process.env.R2_BUCKET_NAME, MaxKeys: 15 }),
  )
  const keys = (r.Contents || []).map((o) => `${o.Key} (${o.Size}B, ${o.LastModified?.toISOString().slice(0, 10)})`)
  console.log('[R2] LIST_OK — bucket =', process.env.R2_BUCKET_NAME, '| KeyCount =', r.KeyCount)
  keys.forEach((k) => console.log('  -', k))
}

async function verifyNim() {
  const keys = [1, 2, 3, 4].map((i) => process.env[`NVIDIA_API_KEY_${i}`]!).filter(Boolean)
  const results = await Promise.all(
    keys.map(async (k, i) => {
      const res = await fetch('https://integrate.api.nvidia.com/v1/models', {
        headers: { Authorization: `Bearer ${k}` },
        signal: AbortSignal.timeout(20000),
      })
      return `key_${i + 1}: HTTP ${res.status}${res.status === 200 ? ' OK' : ''}`
    }),
  )
  console.log('[NIM]', results.join(' | '))
}

const [n4j, r2, nim] = ['neo4j', 'r2', 'nim'].map((name) =>
  ({ neo4j: verifyNeo4j, r2: verifyR2, nim: verifyNim })[name]!().then(
    () => `${name}: PASS`,
    (e) => `${name}: FAIL — ${e.message}`,
  ),
)
const all = await Promise.all([n4j, r2, nim])
console.log('\n=== SUMMARY ===')
all.forEach((s) => console.log(s))
