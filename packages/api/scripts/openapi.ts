/**
 * docs/openapi.yaml を書き出す（書き手に渡す仕様の正本。手で直さない）。
 * servers は入れない（宛先をリポジトリに残さない）。書き手は GET /v1/openapi.json で、叩いた宛先が servers に入ったものを受け取る。
 * CI は書き出し直して差分が無いことを見る。
 */
import { writeFileSync } from 'node:fs'
import { stringify } from 'yaml'
import { OPENAPI_INFO, createApp } from '../src/app'
import { memoryRoomDb } from '../src/roomdb'
import { memoryStore } from '../src/store'

const root = new URL('../../../', import.meta.url)

const doc = createApp({ loadKeys: async () => new Map(), store: memoryStore(), rooms: memoryRoomDb(), guide: '' }).getOpenAPI31Document({
  openapi: '3.1.0',
  info: OPENAPI_INFO,
  servers: [],
})

const header = '# 生成物。手で直さない（npm run openapi で書き出す。元は packages/api/src/app.ts と packages/schema）\n'
writeFileSync(new URL('docs/openapi.yaml', root), header + stringify(doc))
console.log('docs/openapi.yaml を書き出しました')
