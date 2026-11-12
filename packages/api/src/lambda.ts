/** Lambda「Api」の入口。CDK（infra）の NodejsFunction がこれを束ねる */
// 書き手への説明。束ねるとき（infra の NodejsFunction の loader）に文字として入る
import guide from '../../../docs/書き手への説明.md'
import { createApp } from './app'
import { ssmKeyLoader } from './auth'
import { dynamoRoomDb } from './roomdb'
import { s3Store } from './store'
import { urlHandler } from './url-adapter'

const app = createApp({
  loadKeys: ssmKeyLoader(process.env.KEYS_PARAM!),
  store: s3Store(process.env.STORE_BUCKET!),
  rooms: dynamoRoomDb(process.env.ROOMS_TABLE!),
  guide,
})

export const handler = urlHandler(app)
