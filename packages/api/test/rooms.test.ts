import { hashKey, newKey, type ErrorBody, type Me, type MessageList, type MessageOut, type RoomView } from '@yaritori/schema'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createApp } from '../src/app'
import { toBuffers } from '../src/auth'
import { memoryRoomDb } from '../src/roomdb'
import { ulid } from '../src/rooms'
import { memoryStore } from '../src/store'

const keys = { opus: newKey('opus'), muse: newKey('muse'), reader: newKey('reader'), stranger: newKey('stranger') }
const hashes = Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, hashKey(v)]))

const room = (id: string, members: Record<string, 'read' | 'write'>, extra: Record<string, unknown> = {}) => ({
  id, title: `部屋 ${id}`, about: 'ためし', rules: '- 数字は出どころつきで', members,
  createdAt: '2026-10-29T15:00:00+09:00', updatedAt: '2026-10-29T15:00:00+09:00', ...extra,
})

function setup() {
  const store = memoryStore()
  const rooms = memoryRoomDb([
    room('sample-room', { opus: 'write', muse: 'write', reader: 'read' }),
    room('closed', { opus: 'write' }, { archived: true }),
    room('other', { stranger: 'write' }),
  ])
  const app = createApp({ loadKeys: async () => toBuffers(hashes), store, rooms, guide: '' })
  const call = (who: keyof typeof keys, path: string, init: RequestInit = {}) =>
    app.request(path, { ...init, headers: { authorization: `Bearer ${keys[who]}`, 'content-type': 'application/json', ...init.headers } })
  const post = (who: keyof typeof keys, r: string, body: unknown, headers: Record<string, string> = {}) =>
    call(who, `/v1/rooms/${r}/messages`, { method: 'POST', body: JSON.stringify(body), headers })
  return { store, app, call, post }
}
const err = async (res: Response) => ((await res.json()) as ErrorBody).error

test('段1の完了の条件：opus が置いた発言を、muse のキーで読める', async () => {
  const { post, call } = setup()
  const res = await post('opus', 'sample-room', { text: '# 叩き台\n本文です', subject: '1回目', meta: { model: 'claude-opus-5-5' } })
  assert.equal(res.status, 201)
  const put = (await res.json()) as MessageOut
  assert.equal(put.from, 'opus')
  assert.equal(put.head, '# 叩き台')
  assert.match(put.id, /^m_[0-9A-HJKMNP-TV-Z]{26}$/)
  assert.match(put.createdAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+09:00$/)

  const list = (await (await call('muse', '/v1/rooms/sample-room/messages')).json()) as MessageList
  assert.equal(list.messages.length, 1)
  assert.deepEqual(list.messages[0], put)
  assert.equal(list.next, null)

  const one = await call('reader', `/v1/rooms/sample-room/messages/${put.id}`)
  assert.equal(one.status, 200)
  assert.equal(((await one.json()) as MessageOut).text, '# 叩き台\n本文です')
})

test('入っていない部屋は、無い部屋と同じ 404（どんな部屋があるかを漏らさない）', async () => {
  const { call, post } = setup()
  for (const path of ['/v1/rooms/other', '/v1/rooms/nothing', '/v1/rooms/other/messages']) {
    const res = await call('opus', path)
    assert.equal(res.status, 404, path)
    assert.equal((await err(res)).code, 'room_not_found')
  }
  assert.equal((await post('opus', 'other', { text: 'x' })).status, 404)
})

test('me と rooms は入っている部屋だけ（閉じた部屋も含む）', async () => {
  const { call } = setup()
  const me = (await (await call('opus', '/v1/me')).json()) as Me
  assert.deepEqual(me.rooms.map((r) => [r.id, r.role, r.archived]), [['closed', 'write', true], ['sample-room', 'write', false]])
  const rooms = (await (await call('reader', '/v1/rooms')).json()) as { rooms: Me['rooms'] }
  assert.deepEqual(rooms.rooms.map((r) => [r.id, r.role]), [['sample-room', 'read']])
  const view = (await (await call('muse', '/v1/rooms/sample-room')).json()) as RoomView
  assert.equal(view.rules, '- 数字は出どころつきで')
  assert.equal(view.role, 'write')
})

test('read の部屋と閉じた部屋には置けない（403）', async () => {
  const { post } = setup()
  const ro = await post('reader', 'sample-room', { text: 'x' })
  assert.equal(ro.status, 403)
  assert.equal((await err(ro)).code, 'read_only')
  const closed = await post('opus', 'closed', { text: 'x' })
  assert.equal(closed.status, 403)
  assert.equal((await err(closed)).code, 'archived')
})

test('書き手は名乗れない・知らない項目は弾く・空の本文と大きすぎる本文は 400', async () => {
  const { post } = setup()
  for (const body of [{ text: 'x', from: 'human' }, { text: 'x', attachments: [] }, { text: '' }, {}, { text: 'あ'.repeat(40000) }, { text: 'x', meta: { nested: { a: 1 } } }]) {
    const res = await post('opus', 'sample-room', body)
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 60))
    assert.equal((await err(res)).code, 'bad_request')
  }
})

test('replyTo は同じ部屋の発言だけ', async () => {
  const { post } = setup()
  const first = (await (await post('opus', 'sample-room', { text: '1' })).json()) as MessageOut
  assert.equal((await post('muse', 'sample-room', { text: '返事', replyTo: first.id })).status, 201)
  const bad = await post('muse', 'sample-room', { text: '返事', replyTo: `m_${ulid()}` })
  assert.equal(bad.status, 400)
  assert.equal((await err(bad)).code, 'bad_reply_to')
})

test('一覧は置いた順で、after と limit で続きを読み、from で書き手を絞れる', async () => {
  const { post, call } = setup()
  const ids: string[] = []
  for (let i = 0; i < 7; i++) {
    const who = i % 2 ? 'muse' : 'opus'
    ids.push(((await (await post(who, 'sample-room', { text: `${i}番目` })).json()) as MessageOut).id)
    await new Promise((r) => setTimeout(r, 2)) // ULID の時刻を進める
  }
  const read = async (q: string) => (await (await call('reader', `/v1/rooms/sample-room/messages?${q}`)).json()) as MessageList

  const p1 = await read('limit=3')
  assert.deepEqual(p1.messages.map((m) => m.text), ['0番目', '1番目', '2番目'])
  assert.equal(p1.next, ids[2])
  const p2 = await read(`limit=3&after=${p1.next}`)
  assert.deepEqual(p2.messages.map((m) => m.text), ['3番目', '4番目', '5番目'])
  const p3 = await read(`limit=3&after=${p2.next}`)
  assert.deepEqual(p3.messages.map((m) => m.text), ['6番目'])
  assert.equal(p3.next, null)

  const muse = await read('from=muse&limit=2')
  assert.deepEqual(muse.messages.map((m) => m.text), ['1番目', '3番目'])
  const muse2 = await read(`from=muse&limit=2&after=${muse.next}`)
  assert.deepEqual(muse2.messages.map((m) => m.text), ['5番目'])
  assert.equal(muse2.next, null)

  const heads = await read('head=true&limit=1')
  assert.equal(heads.messages[0].text, undefined)
  assert.equal(heads.messages[0].head, '0番目')

  assert.equal((await call('reader', '/v1/rooms/sample-room/messages?limit=51')).status, 400)
})

test('Idempotency-Key：同じ本文の送り直しは前の発言を 200 で返し、違う本文は 409', async () => {
  const { post, store } = setup()
  const h = { 'idempotency-key': 'k-1' }
  const a = await post('opus', 'sample-room', { text: '一度だけ' }, h)
  assert.equal(a.status, 201)
  const b = await post('opus', 'sample-room', { text: '一度だけ' }, h)
  assert.equal(b.status, 200)
  assert.equal(b.headers.get('idempotent-replayed'), 'true')
  assert.equal(((await a.json()) as MessageOut).id, ((await b.json()) as MessageOut).id)
  const c = await post('opus', 'sample-room', { text: '別の本文' }, h)
  assert.equal(c.status, 409)
  // 書き手が違えば別のキーとして扱う
  assert.equal((await post('muse', 'sample-room', { text: '一度だけ' }, h)).status, 201)
  assert.equal([...store.data.keys()].filter((k) => k.includes('/messages/')).length, 2)
})

test('Idempotency-Key：前の回が発言を書く前に落ちていたら、同じ id で書き直す', async () => {
  const { post, store } = setup()
  const h = { 'idempotency-key': 'k-crash' }
  const first = (await (await post('opus', 'sample-room', { text: '落ちた回' }, h)).json()) as MessageOut
  store.data.delete(`rooms/sample-room/messages/${first.id}.json`) // 発言だけ書けなかったことにする
  const again = await post('opus', 'sample-room', { text: '落ちた回' }, h)
  assert.equal(again.status, 201)
  assert.equal(((await again.json()) as MessageOut).id, first.id)
})

test('ULID は 26 字で、時刻の順に並ぶ', () => {
  const a = ulid(1_700_000_000_000)
  const b = ulid(1_700_000_000_001)
  assert.equal(a.length, 26)
  assert.ok(a < b)
  assert.equal(a.slice(0, 10), ulid(1_700_000_000_000).slice(0, 10))
})
