/**
 * 書き手のキーの出し入れ（設計 5節）。SSM の KEYS_PARAM（SecureString）に sha256 だけを置く。
 *
 * **CDK ではパラメータを作らない。** 中身を CDK に書くと CloudFormation のテンプレートに値が残るため。
 * Lambda は最大5分、前のキーを覚えているので、作り直しが全部に効くまで少し待つ。
 */
import { GetParameterCommand, PutParameterCommand, SSMClient } from '@aws-sdk/client-ssm'
import { KEYS_PARAM, KeyHashes, hashKey, newKey } from '@yaritori/schema'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'

const ssm = new SSMClient({ region: process.env.AWS_REGION ?? 'ap-northeast-1' })

/** SSM の標準パラメータの上限。超えると高度なパラメータ（有料）になるので、その手前で止める */
const STANDARD_LIMIT = 4096

async function read(): Promise<KeyHashes> {
  try {
    const res = await ssm.send(new GetParameterCommand({ Name: KEYS_PARAM, WithDecryption: true }))
    return KeyHashes.parse(JSON.parse(res.Parameter?.Value ?? '{}'))
  } catch (e) {
    if (e instanceof Error && e.name === 'ParameterNotFound') return {}
    throw e
  }
}

async function write(doc: KeyHashes) {
  const value = JSON.stringify(doc)
  if (Buffer.byteLength(value) > STANDARD_LIMIT) {
    throw new Error(`キーの一覧が ${STANDARD_LIMIT} バイトを超えます。使っていない書き手を revoke してください`)
  }
  await ssm.send(new PutParameterCommand({
    Name: KEYS_PARAM,
    Value: value,
    Type: 'SecureString',
    Tier: 'Standard',
    Overwrite: true,
  }))
}

/** .env の <name>= の行を差し替える（ほかの行は残す）。持ち主だけが読める 600 にする */
function writeEnv(path: string, name: string, key: string) {
  const kept = existsSync(path)
    ? readFileSync(path, 'utf8').split('\n').filter((l) => l !== '' && !l.startsWith(`${name}=`))
    : []
  writeFileSync(path, [...kept, `${name}=${key}`].join('\n') + '\n', { mode: 0o600 })
  chmodSync(path, 0o600)
}

export type KeyOut = { envFile?: string; envName?: string; clipboard?: boolean }

export async function keyRotate(principal: string, out: KeyOut = {}) {
  const key = newKey(principal)
  const doc = await read()
  const had = principal in doc
  await write({ ...doc, [principal]: hashKey(key) })
  console.error(`${principal} のキーを${had ? '作り直しました（前のキーは5分以内に効かなくなります）' : '作りました'}。`)
  if (out.envFile) {
    const name = out.envName ?? 'YARITORI_KEY'
    writeEnv(out.envFile, name, key)
    console.error(`キーは ${out.envFile} の ${name} に書きました（画面には出していません）。`)
  } else if (out.clipboard) {
    // 画面にも会話にも出さずに渡す（Muse の Cloud の秘密の置き場に貼ってもらう）
    const r = spawnSync('pbcopy', { input: key })
    if (r.status !== 0) throw new Error('クリップボードに入れられませんでした（pbcopy）。キーはもう作ってあるので、作り直してください')
    console.error('キーはクリップボードに入れました（画面には出していません）。渡す先の秘密の置き場に貼ったら、クリップボードは別のもので上書きしてください。')
  } else {
    console.error('キーは下の1行だけで、もう表示できません。渡す先の秘密の置き場に入れてください（会話や md には書かない）。')
    console.log(key)
  }
}

export async function keyRevoke(principal: string) {
  const doc = await read()
  if (!(principal in doc)) throw new Error(`${principal} のキーはありません`)
  const { [principal]: _gone, ...rest } = doc
  await write(rest)
  console.error(`${principal} のキーを失効させました（5分以内に効かなくなります）。`)
}

export async function keyList() {
  const names = Object.keys(await read()).sort()
  console.log(names.length ? names.join('\n') : '（まだ1本もありません）')
}
