// 画面を出す（npm run deploy:web → ビルドのあとここ）。認証は .env の CLOUDFLARE_API_TOKEN・CLOUDFLARE_ACCOUNT_ID。
// ドメイン（WebUrl）・中継先（ViewerFunctionUrl）・バケット（StoreBucket）は infra/cdk-outputs.json から取る（正本はそこ1か所。wrangler.jsonc に写さない）
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const outputs = JSON.parse(readFileSync(new URL('../../infra/cdk-outputs.json', import.meta.url), 'utf8')).Yaritori ?? {}
const origin = outputs.ViewerFunctionUrl
if (!/^https:\/\/[a-z0-9]+\.lambda-url\.ap-northeast-1\.on\.aws\/?$/.test(origin ?? '')) {
  console.error('infra/cdk-outputs.json に ViewerFunctionUrl がありません。先に npm run deploy（cdk）で Lambda「Viewer」を作ってください')
  process.exit(1)
}
const host = /^https:\/\/([a-z0-9.-]+)$/.exec(outputs.WebUrl ?? '')?.[1]
if (!host || host.endsWith('example.com')) {
  console.error(`読む画面のドメインが決まっていません（WebUrl: ${outputs.WebUrl}）。.env に YARITORI_WEB_ORIGIN=https://<ドメイン> を書いて、npm run deploy をやり直してください`)
  process.exit(1)
}
const bucket = outputs.StoreBucket
if (!/^[a-z0-9.-]+$/.test(bucket ?? '')) {
  console.error('infra/cdk-outputs.json に StoreBucket がありません。先に npm run deploy をしてください')
  process.exit(1)
}
// CSP の画像・動画の読み込み先を、このバケットだけにする（public/_headers の __STORE_BUCKET__ を埋める）
const headers = new URL('./dist/_headers', import.meta.url)
writeFileSync(headers, readFileSync(headers, 'utf8').replaceAll('__STORE_BUCKET__', bucket))

const wrangler = new URL('../../node_modules/wrangler/bin/wrangler.js', import.meta.url).pathname
const r = spawnSync(process.execPath, ['--env-file=../../.env', wrangler, 'deploy', '--domain', host, '--var', `LAMBDA_ORIGIN:${origin}`], { stdio: 'inherit' })
process.exit(r.status ?? 1)
