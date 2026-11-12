import { hashKey, newKey, type DocHistory, type DocSummary, type DocView, type ErrorBody, type RoomView } from '@yaritori/schema'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createApp } from '../src/app'
import { toBuffers } from '../src/auth'
import { memoryRoomDb } from '../src/roomdb'
import { memoryStore } from '../src/store'

const keys = { human: newKey('human'), opus: newKey('opus'), muse: newKey('muse'), reader: newKey('reader') }
const hashes = Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, hashKey(v)]))
type Who = keyof typeof keys

function setup(extra: Record<string, unknown> = {}) {
  const store = memoryStore()
  const rooms = memoryRoomDb([{
    id: 'sample', title: 'サンプルの部屋', createdAt: 'x', updatedAt: 'x',
    members: { human: 'write', opus: 'write', muse: 'write', reader: 'read' },
    docs: {
      '01-memo': { title: '01-本人のメモ.md', editors: ['human'] },
      '02-plan': { title: '02-案.md', editors: ['opus', 'human'] },
    },
    ...extra,
  }])
  const app = createApp({ loadKeys: async () => toBuffers(hashes), store, rooms, guide: '' })
  const call = (who: Who, path: string, init: RequestInit = {}) =>
    app.request(path, { ...init, headers: { authorization: `Bearer ${keys[who]}`, 'content-type': 'application/json', ...init.headers } })
  const get = (who: Who, doc: string, q = '') => call(who, `/v1/rooms/sample/docs/${doc}${q}`)
  const put = (who: Who, doc: string, ifMatch: string | undefined, body: unknown) =>
    call(who, `/v1/rooms/sample/docs/${doc}`, { method: 'PUT', body: JSON.stringify(body), headers: ifMatch === undefined ? {} : { 'if-match': ifMatch } })
  return { store, call, get, put }
}
const err = async (res: Response) => ((await res.json()) as ErrorBody).error

test('段3の完了の条件：01 は本人のキーでだけ直せる。古い版で直そうとすると 412', async () => {
  const { get, put } = setup()
  const first = await get('muse', '01-memo')
  assert.equal(first.headers.get('etag'), '"0"')
  assert.deepEqual(((await first.json()) as DocView).text, '')

  const v1 = await put('human', '01-memo', '"0"', { text: '# 本人のメモ\n一', note: '最初の版' })
  assert.equal(v1.status, 200)
  assert.equal(v1.headers.get('etag'), '"1"')
  assert.equal(((await v1.json()) as DocView).updatedBy, 'human')

  for (const who of ['opus', 'muse', 'reader'] as const) {
    const res = await put(who, '01-memo', '"1"', { text: '盛った話' })
    assert.equal(res.status, 403, who)
    assert.equal((await err(res)).code, 'not_editor')
  }

  assert.equal((await put('human', '01-memo', '"1"', { text: '# 本人のメモ\n一 → 二' })).status, 200)
  const stale = await put('human', '01-memo', '"1"', { text: '古い版の上から' })
  assert.equal(stale.status, 412)
  const e = await err(stale)
  assert.equal(e.code, 'version_conflict')
  assert.match(e.message, /いまは版 2/)

  const now = (await (await get('reader', '01-memo')).json()) as DocView
  assert.deepEqual([now.version, now.text, now.canEdit], [2, '# 本人のメモ\n一 → 二', false])
})

test('2人が同じ版から直すと、先に書いたほうだけが通る（次の番号を取り合う）', async () => {
  const { put } = setup()
  const [a, b] = await Promise.all([
    put('opus', '02-plan', '"0"', { text: 'opus の案' }),
    put('human', '02-plan', '"0"', { text: '本人の案' }),
  ])
  assert.deepEqual([a.status, b.status].sort(), [200, 412])
})

test('前の版は消えず、version= で読め、版の一覧は新しい順', async () => {
  const { get, put, call } = setup()
  for (const [i, text] of ['一', '二', '三'].entries()) await put('opus', '02-plan', `"${i}"`, { text, note: `${i + 1}回目` })
  const old = await get('muse', '02-plan', '?version=1')
  assert.equal(old.headers.get('etag'), '"1"')
  const v = (await old.json()) as DocView
  assert.deepEqual([v.version, v.latest, v.text, v.note], [1, 3, '一', '1回目'])
  assert.equal((await get('muse', '02-plan', '?version=9')).status, 404)

  const hist = (await (await call('muse', '/v1/rooms/sample/docs/02-plan/versions')).json()) as DocHistory
  assert.deepEqual(hist.versions.map((x) => [x.version, x.updatedBy, x.note, x.bytes]), [[3, 'opus', '3回目', 3], [2, 'opus', '2回目', 3], [1, 'opus', '1回目', 3]])
})

test('If-Match が無ければ 428、読めなければ 400。W/ と引用符なしは受ける', async () => {
  const { put } = setup()
  const none = await put('opus', '02-plan', undefined, { text: 'x' })
  assert.equal(none.status, 428)
  assert.equal((await err(none)).code, 'if_match_required')
  assert.equal((await err(await put('opus', '02-plan', '"abc"', { text: 'x' }))).code, 'bad_if_match')
  assert.equal((await put('opus', '02-plan', 'W/"0"', { text: 'x' })).status, 200)
  assert.equal((await put('opus', '02-plan', '1', { text: 'y' })).status, 200)
  // いまより先の版を言っても、飛ばして書けない
  assert.equal((await put('opus', '02-plan', '"5"', { text: 'z' })).status, 412)
})

test('一覧と部屋：資料ごとの版・直せるか。無い資料は 404、閉じた部屋は読めるが直せない', async () => {
  const { call, put, get } = setup()
  await put('human', '01-memo', '"0"', { text: 'a' })
  const list = (await (await call('opus', '/v1/rooms/sample/docs')).json()) as { docs: DocSummary[] }
  assert.deepEqual(list.docs.map((d) => [d.docId, d.title, d.version, d.canEdit]), [['01-memo', '01-本人のメモ.md', 1, false], ['02-plan', '02-案.md', 0, true]])
  const room = (await (await call('muse', '/v1/rooms/sample')).json()) as RoomView
  assert.deepEqual(room.docs['01-memo'].editors, ['human'])
  const missing = await get('opus', '99-nothing')
  assert.equal(missing.status, 404)
  assert.equal((await err(missing)).code, 'doc_not_found')

  const closed = setup({ archived: true })
  assert.equal((await closed.get('muse', '02-plan')).status, 200)
  assert.equal((await err(await closed.put('opus', '02-plan', '"0"', { text: 'x' }))).code, 'archived')
})

test('資料の形：200KB を超える本文・知らない項目は 400', async () => {
  const { put } = setup()
  assert.equal((await put('opus', '02-plan', '"0"', { text: 'あ'.repeat(70000) })).status, 400)
  assert.equal((await put('opus', '02-plan', '"0"', { text: 'x', updatedBy: 'human' })).status, 400)
})
