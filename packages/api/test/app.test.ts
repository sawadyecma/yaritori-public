import { MAX_REQUEST_BYTES, hashKey, newKey, type ErrorBody } from '@yaritori/schema'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createApp } from '../src/app'
import { toBuffers } from '../src/auth'
import { memoryRoomDb } from '../src/roomdb'
import { memoryStore } from '../src/store'

const opusKey = newKey('opus')
const museKey = newKey('muse')
const app = createApp({ loadKeys: async () => toBuffers({ opus: hashKey(opusKey), muse: hashKey(museKey) }), store: memoryStore(), rooms: memoryRoomDb(), guide: '# 説明' })

/** 誤りの中身（{ error: { code, message } }） */
const err = async (res: Response) => ((await res.json()) as ErrorBody).error

const me = (auth?: string) => app.request('/v1/me', { headers: auth ? { authorization: auth } : {} })

test('キーから書き手が決まる', async () => {
  for (const [key, name] of [[opusKey, 'opus'], [museKey, 'muse']]) {
    const res = await me(`Bearer ${key}`)
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { principal: name, rooms: [] })
  }
})

test('キーが無ければ 401 no_key', async () => {
  for (const auth of [undefined, 'Basic abc', `Bearer`]) {
    const res = await me(auth)
    assert.equal(res.status, 401)
    assert.equal((await err(res)).code, 'no_key')
  }
})

test('キーが違えば 401 bad_key（形違い・知らない書き手・秘密違い・書き手のすり替え）', async () => {
  const swapped = opusKey.replace('yt_opus_', 'yt_muse_')
  for (const key of ['nonsense', newKey('stranger'), newKey('opus'), swapped]) {
    const res = await me(`Bearer ${key}`)
    assert.equal(res.status, 401, key)
    assert.equal((await err(res)).code, 'bad_key')
  }
})

test('誤りは { error: { code, message } } で、どの応答にも no-store と noindex', async () => {
  for (const res of [await me(), await me(`Bearer ${opusKey}`), await app.request('/nowhere')]) {
    assert.equal(res.headers.get('cache-control'), 'no-store')
    assert.equal(res.headers.get('x-robots-tag'), 'noindex, nofollow')
  }
  const res = await app.request('/v1/nowhere/at/all', { headers: { authorization: `Bearer ${opusKey}` } })
  assert.equal(res.status, 404)
  const e = await err(res)
  assert.equal(e.code, 'not_found')
  assert.match(e.message, /openapi\.yaml/)
})

test('リクエストの上限（5.75MB）を超える本文は 413', async () => {
  const res = await app.request('/v1/me', {
    method: 'POST',
    headers: { authorization: `Bearer ${opusKey}`, 'content-type': 'application/json' },
    body: 'x'.repeat(MAX_REQUEST_BYTES + 1),
  })
  assert.equal(res.status, 413)
  assert.equal((await err(res)).code, 'too_large')
})

test('キーを読めないときは 500 で、中身を漏らさない', async () => {
  const broken = createApp({ loadKeys: async () => { throw new Error('AccessDenied: arn:aws:ssm:secret') }, store: memoryStore(), rooms: memoryRoomDb(), guide: '' })
  const res = await broken.request('/v1/me', { headers: { authorization: `Bearer ${opusKey}` } })
  assert.equal(res.status, 500)
  assert.doesNotMatch(await res.text(), /arn:aws/)
})

test('説明（markdown）と仕様（OpenAPI）はキーで読める。仕様の宛先は叩かれている宛先', async () => {
  assert.equal((await app.request('/v1/guide')).status, 401)
  const g = await app.request('/v1/guide', { headers: { authorization: `Bearer ${opusKey}` } })
  assert.equal(g.status, 200)
  assert.equal(g.headers.get('content-type'), 'text/markdown; charset=utf-8')
  assert.equal(await g.text(), '# 説明')
  const spec = await app.request('https://example.lambda-url.ap-northeast-1.on.aws/v1/openapi.json', { headers: { authorization: `Bearer ${opusKey}` } })
  assert.equal(spec.status, 200)
  const doc = (await spec.json()) as { servers: { url: string }[]; paths: Record<string, unknown> }
  assert.deepEqual(doc.servers, [{ url: 'https://example.lambda-url.ap-northeast-1.on.aws' }])
  for (const p of ['/v1/guide', '/v1/inbox', '/v1/rooms/{room}/messages', '/v1/rooms/{room}/uploads', '/v1/rooms/{room}/docs/{docId}']) assert.ok(p in doc.paths, p)
})
