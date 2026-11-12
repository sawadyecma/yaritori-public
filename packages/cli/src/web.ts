/**
 * 読む画面（Web。Lambda「Viewer」）の出し入れ（2026-10-30）。AWS の認証で SSM を直接書く（API には出さない）。
 *
 * - 入れる Google アカウント（WEB_VIEWERS_PARAM）。外せば5分のうちに、ログイン済みの端末も入れなくなる
 * - Google の OAuth クライアント（WEB_GOOGLE_PARAM）。秘密はクリップボードから読み、画面にもコマンドの履歴にも出さない
 * - セッションの署名鍵（WEB_SESSION_KEY_PARAM）。作り直すと、全端末が5分のうちに締め出される
 *
 * **CDK ではパラメータを作らない**（キーと同じ。中身が CloudFormation のテンプレートに残る）。
 */
import { GetParameterCommand, PutParameterCommand, SSMClient } from '@aws-sdk/client-ssm'
import { Viewers, WEB_GOOGLE_PARAM, WEB_SESSION_KEY_PARAM, WEB_VIEWERS_PARAM } from '@yaritori/schema'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'

const ssm = new SSMClient({ region: process.env.AWS_REGION ?? 'ap-northeast-1' })

async function get(name: string): Promise<string | null> {
  try {
    return (await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }))).Parameter?.Value ?? null
  } catch (e) {
    if (e instanceof Error && e.name === 'ParameterNotFound') return null
    throw e
  }
}

async function put(name: string, value: string) {
  await ssm.send(new PutParameterCommand({ Name: name, Value: value, Type: 'SecureString', Tier: 'Standard', Overwrite: true }))
}

const readViewers = async () => Viewers.parse(JSON.parse((await get(WEB_VIEWERS_PARAM)) ?? '[]'))

export async function webAllow(email: string) {
  const [add] = Viewers.parse([email])
  const now = await readViewers()
  if (now.includes(add)) return console.error(`${add} はもう入れます。`)
  await put(WEB_VIEWERS_PARAM, JSON.stringify([...now, add].sort()))
  console.error(`${add} を入れるようにしました（5分以内に効きます）。Google の同意画面の「テストユーザー」にも入っている必要があります。`)
}

export async function webDeny(email: string) {
  const [gone] = Viewers.parse([email])
  const now = await readViewers()
  if (!now.includes(gone)) throw new Error(`${gone} は入れるアカウントにありません`)
  await put(WEB_VIEWERS_PARAM, JSON.stringify(now.filter((e) => e !== gone)))
  console.error(`${gone} を外しました（5分以内に、ログイン済みの端末も入れなくなります）。`)
}

export async function webList() {
  const now = await readViewers()
  console.log(now.length ? now.join('\n') : '（まだ誰も入れません）')
  const [google, session] = await Promise.all([get(WEB_GOOGLE_PARAM), get(WEB_SESSION_KEY_PARAM)])
  console.error(`Google のクライアント: ${google ? JSON.parse(google).client_id : '（まだ。admin web google）'}`)
  console.error(`セッションの鍵: ${session ? 'あり' : '（まだ。admin web session-rotate）'}`)
}

/** Google Cloud で作った OAuth クライアント（ウェブアプリケーション）。秘密は先にクリップボードへコピーしておく */
export async function webGoogle(clientId: string) {
  if (!/^[0-9]+-[0-9a-z]+\.apps\.googleusercontent\.com$/.test(clientId)) {
    throw new Error(`クライアント ID の形が違います（<数字>-<英数字>.apps.googleusercontent.com）: ${clientId}`)
  }
  const pasted = spawnSync('pbpaste', { encoding: 'utf8' })
  const secret = pasted.status === 0 ? pasted.stdout.trim() : ''
  if (!secret || /\s/.test(secret) || secret.length > 200) {
    throw new Error('クリップボードにクライアントシークレットがありません。Google Cloud の画面でシークレットをコピーしてから、もう一度打ってください')
  }
  if (!secret.startsWith('GOCSPX-')) {
    throw new Error('クリップボードの中身がクライアントシークレットに見えません（GOCSPX- で始まるもの）。コピーし直してください')
  }
  await put(WEB_GOOGLE_PARAM, JSON.stringify({ client_id: clientId, client_secret: secret }))
  // 貼り終えた秘密をクリップボードに残さない
  spawnSync('pbcopy', { input: '' })
  console.error('Google のクライアントを置きました（シークレットは画面に出さず、クリップボードは空にしました）。5分以内に効きます。')
}

export async function webSessionRotate() {
  const had = (await get(WEB_SESSION_KEY_PARAM)) !== null
  await put(WEB_SESSION_KEY_PARAM, randomBytes(48).toString('base64url'))
  console.error(had ? 'セッションの鍵を作り直しました。5分以内に、全端末がログインし直しになります。' : 'セッションの鍵を作りました。')
}
