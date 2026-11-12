/** Lambda「Viewer」の入口（読む画面の /api と /auth）。CDK（infra）の NodejsFunction がこれを束ねる */
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm'
import { Viewers } from '@yaritori/schema'
import { googleAuth, type AuthSecrets } from './google'
import { dynamoRoomDb } from './roomdb'
import { s3Store } from './store'
import { urlHandler } from './url-adapter'
import { createViewer } from './viewer'

/** SSM の秘密と許可リストを控えておく時間。作り直し・外したアカウントは、この時間のうちに全コンテナで効く */
const CACHE_MS = 5 * 60e3

const ssm = new SSMClient({})

async function parameter(name: string): Promise<string | null> {
  try {
    return (await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }))).Parameter?.Value ?? null
  } catch (e) {
    if (e instanceof Error && e.name === 'ParameterNotFound') return null
    throw e
  }
}

function cached<T>(load: () => Promise<T>): () => Promise<T> {
  let hit: { at: number; value: Promise<T> } | null = null
  return () => {
    if (!hit || Date.now() - hit.at > CACHE_MS) {
      const value = load()
      value.catch(() => (hit = null)) // 読めなかったら次の要求でやり直す
      hit = { at: Date.now(), value }
    }
    return hit.value
  }
}

const secrets = cached(async (): Promise<AuthSecrets> => {
  const [google, sessionKey] = await Promise.all([parameter(process.env.GOOGLE_PARAM!), parameter(process.env.SESSION_KEY_PARAM!)])
  if (!google || !sessionKey) throw new Error('Google のクライアントかセッションの鍵が SSM にありません（admin web google・admin web session-rotate）')
  const g = JSON.parse(google) as { client_id: string; client_secret: string }
  return { clientId: g.client_id, clientSecret: g.client_secret, sessionKey }
})

// まだ1人も足していなければ、誰も通さないだけ
const viewers = cached(async () => new Set(Viewers.parse(JSON.parse((await parameter(process.env.VIEWERS_PARAM!)) ?? '[]'))))

const app = createViewer({
  store: s3Store(process.env.STORE_BUCKET!),
  rooms: dynamoRoomDb(process.env.ROOMS_TABLE!),
  auth: googleAuth({ secrets, viewers, publicOrigin: process.env.PUBLIC_ORIGIN! }),
})

export const handler = urlHandler(app)
