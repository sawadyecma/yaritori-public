/**
 * 読む画面を手元で開く（2026-10-30）。`npm run web` → http://127.0.0.1:8770
 *
 * Lambda「Viewer」（viewer-lambda.ts）と同じ app で、違いは2つ:
 *
 * - **ログインが無い。** guard を外すフラグは作らず、guard を渡さない別の入口にしてある（Lambda の側で外れる道を持たない）
 * - 画面（packages/web/dist）もここが配る（外では Cloudflare の Worker が配る）。CSP などのヘッダーは
 *   Cloudflare と同じ packages/web/public/_headers のものを付ける（足りないと本番で黙って映らなくなるので、手元で先に気づけるように）
 *
 * **127.0.0.1 にだけ開く。** ログインを通さないので、同じ Wi-Fi の端末からも見えないようにする。
 * S3 と DynamoDB は手元の AWS の認証で読む（infra/cdk-outputs.json の StoreBucket と RoomsTable）。
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { S3Client } from '@aws-sdk/client-s3'
import { serve } from '@hono/node-server'
import { readFileSync } from 'node:fs'
import { readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { dynamoRoomDb } from './roomdb'
import { s3Store } from './store'
import { createViewer } from './viewer'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const UI = path.join(ROOT, 'packages/web/dist')
const PORT = Number(process.env.PORT ?? 8770)
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
}

const outputs = JSON.parse(readFileSync(path.join(ROOT, 'infra/cdk-outputs.json'), 'utf8')).Yaritori as { StoreBucket: string; RoomsTable: string }
const bucket = outputs.StoreBucket

/** _headers の「/*」の下に並んだヘッダー（Cloudflare の静的ファイルと同じもの。CSP のバケットは deploy.mjs と同じく埋める） */
const HEADERS = readFileSync(path.join(ROOT, 'packages/web/public/_headers'), 'utf8')
  .replaceAll('__STORE_BUCKET__', bucket)
  .split('\n')
  .flatMap((l) => {
    const m = /^\s+([A-Za-z-]+):\s*(.+)$/.exec(l)
    return m ? [[m[1], m[2].trim()] as const] : []
  })
const region = process.env.AWS_REGION ?? 'ap-northeast-1'
const s3 = new S3Client({
  region,
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
})
const app = createViewer({ store: s3Store(bucket, s3), rooms: dynamoRoomDb(outputs.RoomsTable, new DynamoDBClient({ region })) })

// 画面。/ は index.html、それ以外は dist の中のファイル（外へ出るパスは 404）
app.get('*', async (c) => {
  const rel = c.req.path === '/' ? 'index.html' : decodeURIComponent(c.req.path.slice(1))
  try {
    const file = await realpath(path.join(UI, rel))
    if (!file.startsWith(UI + path.sep)) return c.notFound()
    c.header('Content-Type', TYPES[path.extname(file)] ?? 'application/octet-stream')
    for (const [k, v] of HEADERS) c.header(k, v)
    return c.body(await readFile(file))
  } catch {
    if (rel === 'index.html') return c.text('画面がまだビルドされていません（npm run build --workspace @yaritori/web）', 503)
    return c.notFound()
  }
})

serve({ fetch: app.fetch, hostname: '127.0.0.1', port: PORT }, () => {
  console.error(`http://127.0.0.1:${PORT} （手元だけ。ログインなし。バケット ${bucket}）`)
})
