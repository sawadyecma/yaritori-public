import { MAX_CREATED_ROOMS, hashKey, newKey, type DocView, type ErrorBody, type MessageOut, type RoomSummary, type RoomView } from '@yaritori/schema'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createApp } from '../src/app'
import { toBuffers } from '../src/auth'
import { memoryRoomDb } from '../src/roomdb'
import { memoryStore } from '../src/store'

const keys = { human: newKey('human'), opus: newKey('opus'), muse: newKey('muse'), reader: newKey('reader') }
const hashes = Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, hashKey(v)]))
type Who = keyof typeof keys

const room = (id: string, extra: Record<string, unknown> = {}) => ({
  id, title: `部屋 ${id}`, members: { human: 'write', opus: 'write', muse: 'write' },
  createdAt: '2026-10-29T15:00:00+09:00', updatedAt: '2026-10-29T15:00:00+09:00', ...extra,
})

function setup(init: unknown[] = []) {
  const store = memoryStore()
  const rooms = memoryRoomDb([
    // 手元の CLI で作った部屋（createdBy が無い）。muse も入っている
    room('sample-room', { docs: { '01-memo': { title: '01-本人のメモ.md', editors: ['human'] } } }),
    room('secret', { members: { human: 'write' } }),
    ...init,
  ])
  const app = createApp({ loadKeys: async () => toBuffers(hashes), store, rooms, guide: '' })
  const call = (who: Who, path: string, init: RequestInit = {}) =>
    app.request(path, { ...init, headers: { authorization: `Bearer ${keys[who]}`, 'content-type': 'application/json', ...init.headers } })
  const create = (who: Who, body: unknown) => call(who, '/v1/rooms', { method: 'POST', body: JSON.stringify(body) })
  const patch = (who: Who, id: string, body: unknown) => call(who, `/v1/rooms/${id}`, { method: 'PATCH', body: JSON.stringify(body) })
  return { rooms, call, create, patch }
}
const err = async (res: Response) => ((await res.json()) as ErrorBody).error

test('muse が作った部屋には muse・opus・human が write で入り、opus がすぐ置ける', async () => {
  const { create, call } = setup()
  const res = await create('muse', { id: 'muse-shiryou', title: '資料づくり', about: 'Muse が呼びかけた部屋', rules: '- 数字は出どころつきで' })
  assert.equal(res.status, 201)
  const made = (await res.json()) as RoomView
  assert.deepEqual(made.members, { muse: 'write', opus: 'write', human: 'write' })
  assert.equal(made.createdBy, 'muse')
  assert.equal(made.role, 'write')
  assert.equal(made.archived, false)
  assert.deepEqual(made.docs, {})

  const view = (await (await call('opus', '/v1/rooms/muse-shiryou')).json()) as RoomView
  assert.equal(view.rules, '- 数字は出どころつきで')
  const post = await call('opus', '/v1/rooms/muse-shiryou/messages', { method: 'POST', body: JSON.stringify({ text: '入りました' }) })
  assert.equal(post.status, 201)
  assert.equal(((await post.json()) as MessageOut).from, 'opus')
  // 入っていない書き手からは、ほかの部屋と同じく見えない
  assert.equal((await call('reader', '/v1/rooms/muse-shiryou')).status, 404)
  // 3者の席もできていて、入っている部屋の一覧にすぐ出る
  for (const who of ['muse', 'opus', 'human'] as const) {
    const list = (await (await call(who, '/v1/rooms')).json()) as { rooms: RoomSummary[] }
    assert.ok(list.rooms.some((r) => r.id === 'muse-shiryou' && r.title === '資料づくり'), who)
  }
})

test('muse 以外は作れない（403）。参加者・作った人は送れない（400）', async () => {
  const { create, rooms } = setup()
  for (const who of ['opus', 'human', 'reader'] as const) {
    const res = await create(who, { id: 'x-room', title: 'x' })
    assert.equal(res.status, 403, who)
    assert.equal((await err(res)).code, 'cannot_create_room')
  }
  for (const extra of [{ members: { muse: 'write', reader: 'read' } }, { createdBy: 'human' }, { archived: true }]) {
    const res = await create('muse', { id: 'x-room', title: 'x', ...extra })
    assert.equal(res.status, 400, JSON.stringify(extra))
  }
  assert.equal(await rooms.get('x-room'), null)
})

test('もうある id には作れない（入っていない部屋も上書きしない）。形違いの id は 400', async () => {
  const { create, rooms } = setup()
  const before = await rooms.get('secret')
  for (const id of ['secret', 'sample-room']) {
    const res = await create('muse', { id, title: '乗っ取り' })
    assert.equal(res.status, 409, id)
    assert.equal((await err(res)).code, 'room_exists')
  }
  assert.deepEqual(await rooms.get('secret'), before)
  for (const id of ['Muse', '-x', 'a/b', 'a'.repeat(65)]) assert.equal((await create('muse', { id, title: 'x' })).status, 400, id)
})

test('作るときに資料も足せる。editors は部屋の3者だけ', async () => {
  const { create, call } = setup()
  const bad = await create('muse', { id: 'muse-docs', title: 'x', docs: { plan: { title: '案.md', editors: ['reader'] } } })
  assert.equal(bad.status, 400)
  assert.equal((await err(bad)).code, 'bad_editor')
  assert.equal((await call('muse', '/v1/rooms/muse-docs')).status, 404)

  const res = await create('muse', { id: 'muse-docs', title: 'x', docs: { plan: { title: '案.md', editors: ['muse', 'opus'] } } })
  assert.equal(res.status, 201)
  const put = await call('opus', '/v1/rooms/muse-docs/docs/plan', { method: 'PUT', body: JSON.stringify({ text: '# 案' }), headers: { 'if-match': '"0"' } })
  assert.equal(put.status, 200)
  assert.equal(((await put.json()) as DocView).version, 1)
  const human = await call('human', '/v1/rooms/muse-docs/docs/plan', { method: 'PUT', body: JSON.stringify({ text: 'x' }), headers: { 'if-match': '"1"' } })
  assert.equal((await err(human)).code, 'not_editor')
})

test('自分が作った部屋は直せる。送った項目だけ変わり、閉じる・開け直すもできる', async () => {
  const { create, patch, call } = setup()
  await create('muse', { id: 'muse-room', title: '最初の名前', about: 'はじめ', rules: '- 決まり1' })
  const res = await patch('muse', 'muse-room', { title: '新しい名前', rules: '- 決まり1\n- 決まり2' })
  assert.equal(res.status, 200)
  const room = (await res.json()) as RoomView
  assert.equal(room.title, '新しい名前')
  assert.equal(room.about, 'はじめ')
  assert.equal(room.rules, '- 決まり1\n- 決まり2')
  assert.equal(room.createdBy, 'muse')

  assert.equal((await patch('muse', 'muse-room', { archived: true })).status, 200)
  const closed = await call('opus', '/v1/rooms/muse-room/messages', { method: 'POST', body: JSON.stringify({ text: 'x' }) })
  assert.equal((await err(closed)).code, 'archived')
  assert.equal((await patch('muse', 'muse-room', { archived: false })).status, 200)
  assert.equal((await call('opus', '/v1/rooms/muse-room/messages', { method: 'POST', body: JSON.stringify({ text: 'x' }) })).status, 201)
})

test('直せるのは自分が作った部屋だけ。参加者は変えられない', async () => {
  const { create, patch, rooms } = setup()
  // CLI で作った部屋は、muse が入っていても直せない
  const cli = await patch('muse', 'sample-room', { title: '乗っ取り' })
  assert.equal(cli.status, 403)
  assert.equal((await err(cli)).code, 'not_room_owner')
  // 入っていない部屋は、無い部屋と同じ 404
  assert.equal((await err(await patch('muse', 'secret', { title: 'x' }))).code, 'room_not_found')
  assert.equal((await err(await patch('muse', 'nothing', { title: 'x' }))).code, 'room_not_found')

  await create('muse', { id: 'muse-room', title: 'x' })
  // muse の部屋に入っていても、opus・human は API で直せない
  for (const who of ['opus', 'human'] as const) assert.equal((await err(await patch(who, 'muse-room', { title: 'y' }))).code, 'not_room_owner')
  for (const body of [{ members: { reader: 'read' } }, { createdBy: 'opus' }, { id: 'other' }]) {
    assert.equal((await patch('muse', 'muse-room', body)).status, 400, JSON.stringify(body))
  }
  assert.equal((await rooms.get('muse-room'))!.room.title, 'x')
})

test('資料は足すだけ。もうある資料の名前・直せる人は変えられない', async () => {
  const { create, patch } = setup()
  await create('muse', { id: 'muse-room', title: 'x', docs: { '01-honnin': { title: '01-本人.md', editors: ['human'] } } })
  const res = await patch('muse', 'muse-room', { docs: { plan: { title: '案.md', editors: ['muse'] } } })
  assert.equal(res.status, 200)
  assert.deepEqual((await res.json() as RoomView).docs, {
    '01-honnin': { title: '01-本人.md', editors: ['human'] },
    plan: { title: '案.md', editors: ['muse'] },
  })

  const take = await patch('muse', 'muse-room', { docs: { '01-honnin': { title: '01-本人.md', editors: ['muse'] } } })
  assert.equal(take.status, 409)
  assert.equal((await err(take)).code, 'doc_exists')
  const outside = await patch('muse', 'muse-room', { docs: { memo: { title: 'memo.md', editors: ['reader'] } } })
  assert.equal((await err(outside)).code, 'bad_editor')
})

test(`API で作れる部屋は ${MAX_CREATED_ROOMS} まで（閉じた部屋も数える。CLI で作った部屋は数えない）`, async () => {
  const many = Array.from({ length: MAX_CREATED_ROOMS - 1 }, (_, i) => room(`muse-${i}`, { createdBy: 'muse', archived: i === 0 }))
  const { create } = setup(many)
  assert.equal((await create('muse', { id: 'muse-last', title: 'x' })).status, 201)
  const res = await create('muse', { id: 'muse-over', title: 'x' })
  assert.equal(res.status, 403)
  assert.equal((await err(res)).code, 'too_many_rooms')
})

test('直している間に CLI が部屋を書いたら、読み直して当て直す（CLI の直しを消さない）', async () => {
  const { create, patch, rooms } = setup()
  await create('muse', { id: 'muse-room', title: 'x' })
  const replace = rooms.replace
  let raced = 0
  rooms.replace = async (next, prev) => {
    if (raced++ === 0) {
      // muse が読んだあと、書く前に、本人が CLI で reader を入れた
      const cur = (await rooms.get(next.id))!
      assert.ok(await replace({ ...cur.room, members: { ...cur.room.members, reader: 'read' } }, cur))
    }
    return replace(next, prev)
  }
  const res = await patch('muse', 'muse-room', { about: '直した' })
  assert.equal(res.status, 200)
  const room = (await rooms.get('muse-room'))!.room
  assert.equal(room.about, '直した')
  assert.equal(room.members.reader, 'read')
  assert.deepEqual((await rooms.seats('reader')).map((s) => s.room), ['muse-room'])

  rooms.replace = async () => false
  const stuck = await patch('muse', 'muse-room', { about: 'もう一度' })
  assert.equal(stuck.status, 409)
  assert.equal((await err(stuck)).code, 'room_conflict')
})
