import { App, Tags } from 'aws-cdk-lib'
import { existsSync, readFileSync } from 'node:fs'
import * as path from 'node:path'
import { parseEnv } from 'node:util'
import { YaritoriStack } from '../lib/yaritori-stack'

// 読む画面のドメイン（YARITORI_WEB_ORIGIN）。環境変数か、リポジトリ直下の .env から読む（docs/ホスティング.md）。
// .env のほかの値（キーやトークン）はここでは読まない
const envFile = path.join(__dirname, '..', '..', '.env')
const webOrigin = process.env.YARITORI_WEB_ORIGIN
  ?? (existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')).YARITORI_WEB_ORIGIN : undefined)
  // 読む画面を出さないときと、CI の cdk synth はこのまま（Viewer は作られるが、誰も入れない）
  ?? 'https://yaritori.example.com'

const app = new App()
new YaritoriStack(app, 'Yaritori', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'ap-northeast-1' },
  webOrigin,
  description: 'yaritori: writers (human, Claude, Muse, routines) leave messages and files in rooms for each other',
})
Tags.of(app).add('project', 'yaritori')
