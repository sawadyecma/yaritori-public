import { hashKey, newKey, type Inbox, type MessageOut } from '@yaritori/schema'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createApp } from '../src/app'
import { toBuffers } from '../src/auth'
import { memoryRoomDb } from '../src/roomdb'
import { memoryStore } from '../src/store'

const keys = { opus: newKey('opus'), muse: newKey('muse'), human: newKey('human') }
const hashes = Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, hashKey(v)]))
type Who = keyof typeof keys
const room = (id: string, members: Record<string, 'read' | 'write'>) => ({ id, title: `部屋 ${id}`, members, createdAt: 'x', updatedAt: 'x' })

/** 受信箱が S3 の一覧（LIST）を何回引いたかを数える */
function setup() {
  const store = memoryStore()
  const list = store.list
  let lists = 0
  store.list = (prefix, opts) => {
    if (prefix.endsWith('/messages/')) lists++
    return list(prefix, opts)
  }
  const rooms = memoryRoomDb([
    room('a', { opus: 'write', muse: 'write', human: 'write' }),
    room('b', { opus: 'write', muse: 'write' }),
  ])
  const app = createApp({ loadKeys: async () => toBuffers(hashes), store, rooms, guide: '' })
  const call = (who: Who, path: string, init: RequestInit = {}) =>
    app.request(path, { ...init, headers: { authorization: `Bearer ${keys[who]}`, 'content-type': 'application/json', ...init.headers } })
  const post = async (who: Who, r: string, text: string, headers: Record<string, string> = {}) =>
    call(who, `/v1/rooms/${r}/messages`, { method: 'POST', body: JSON.stringify({ text }), headers })
  const read = (who: Who, r: string, upTo: string) => call(who, `/v1/rooms/${r}/read`, { method: 'POST', body: JSON.stringify({ upTo }) })
  /** 受信箱と、そのとき S3 を LIST した回数 */
  const box = async (who: Who) => {
    const before = lists
    const res = await call(who, '/v1/inbox')
    assert.equal(res.status, 200)
    return { inbox: (await res.json()) as Inbox, lists: lists - before }
  }
  return { store, rooms, call, post, read, box }
}
const unread = (b: Inbox) => Object.fromEntries(b.rooms.map((r) => [r.id, r.unread]))

test('新しい発言が無いあいだ、受信箱は S3 を読まない（Muse が1分おきに見に来ても LIST しない）', async () => {
  const { box } = setup()
  const first = await box('muse')
  assert.deepEqual(unread(first.inbox), { a: 0, b: 0 })
  assert.equal(first.lists, 0)
  assert.deepEqual(first.inbox.rooms.map((r) => [r.id, r.title, r.role, r.archived, r.readUpTo]), [['a', '部屋 a', 'write', false, null], ['b', '部屋 b', 'write', false, null]])
})

test('自分の発言だけでは LIST しない。ほかの書き手が置いた部屋だけ LIST して数え、読んだら LIST しなくなる', async () => {
  const { post, read, box } = setup()
  await post('muse', 'a', '自分の発言')
  assert.deepEqual(await box('muse').then((b) => [unread(b.inbox), b.lists]), [{ a: 0, b: 0 }, 0])

  const m = (await (await post('opus', 'b', '【依頼】下調べ\n本文')).json()) as MessageOut
  const got = await box('muse')
  assert.deepEqual(unread(got.inbox), { a: 0, b: 1 })
  assert.equal(got.lists, 1) // b だけ
  assert.equal(got.inbox.rooms[1].heads[0].head, '【依頼】下調べ')

  assert.equal((await read('muse', 'b', m.id)).status, 200)
  assert.deepEqual(await box('muse').then((b) => [unread(b.inbox), b.lists]), [{ a: 0, b: 0 }, 0])
  // opus からは、自分の発言なので未読ではない
  assert.deepEqual(await box('opus').then((b) => [unread(b.inbox), b.lists]), [{ a: 1, b: 0 }, 1])
})

test('last は後ろに戻らない', async () => {
  const { rooms } = setup()
  await rooms.bumpLast('a', 'opus', 'm_02000000000000000000000000')
  await rooms.bumpLast('a', 'opus', 'm_01000000000000000000000000')
  assert.equal(rooms.rows.heads.get('a')!.last.opus, 'm_02000000000000000000000000')
})

test('last を進めたあとに発言を書けなくても、受信箱は見落とさない（送り直せば同じ id で出る）', async () => {
  const { store, post, box } = setup()
  const putIfAbsent = store.putIfAbsent
  let fail = true
  store.putIfAbsent = async (key, value) => {
    if (fail && key.includes('/messages/')) throw new Error('S3 が落ちた')
    return putIfAbsent(key, value)
  }
  const h = { 'idempotency-key': 'k-1' }
  assert.equal((await post('opus', 'a', '落ちた回', h)).status, 500)
  // last は進んでいるので、受信箱は a を読みに行く（まだ発言は無いので 0）
  assert.deepEqual(await box('muse').then((b) => [unread(b.inbox), b.lists]), [{ a: 0, b: 0 }, 1])

  fail = false
  assert.equal((await post('opus', 'a', '落ちた回', h)).status, 201)
  assert.deepEqual(unread((await box('muse')).inbox), { a: 1, b: 0 })
})

test('last を進められなければ、発言を置かずに止める（置いてから見落とすより先に失敗する）', async () => {
  const { store, rooms, post, box } = setup()
  rooms.bumpLast = async () => {
    throw new Error('DynamoDB が落ちた')
  }
  assert.equal((await post('opus', 'a', '置けない')).status, 500)
  assert.equal([...store.data.keys()].filter((k) => k.includes('/messages/')).length, 0)
  assert.deepEqual(unread((await box('muse')).inbox), { a: 0, b: 0 })
})

test('見出しが無い部屋（あるはずだが）は、部屋の行から作って S3 で数える', async () => {
  const { rooms, post, box } = setup()
  await post('opus', 'a', '1通目')
  rooms.rows.heads.delete('a')
  const got = await box('muse')
  assert.deepEqual(unread(got.inbox), { a: 1, b: 0 })
  assert.equal(got.inbox.rooms[0].title, '部屋 a')
  assert.equal(got.lists, 1)
})

test('部屋から外した書き手の既読は、席を作り直さない', async () => {
  const { rooms, post } = setup()
  const m = (await (await post('opus', 'b', 'x')).json()) as MessageOut
  const cur = (await rooms.get('b'))!
  const { muse: _, ...rest } = cur.room.members
  assert.ok(await rooms.replace({ ...cur.room, members: rest }, cur))
  assert.equal(await rooms.markRead('b', 'muse', m.id, 'x'), null)
  assert.deepEqual((await rooms.seats('muse')).map((s) => s.room), ['a'])
})

test('既読は後ろに戻らない', async () => {
  const { rooms } = setup()
  assert.deepEqual(await rooms.markRead('a', 'muse', 'm_02000000000000000000000000', 't2'), { upTo: 'm_02000000000000000000000000', updatedAt: 't2' })
  assert.deepEqual(await rooms.markRead('a', 'muse', 'm_01000000000000000000000000', 't3'), { upTo: 'm_02000000000000000000000000', updatedAt: 't2' })
})
