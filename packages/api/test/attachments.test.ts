import { hashKey, newKey, type ErrorBody, type FileLink, type Inbox, type MessageOut, type ReadMark, type UploadOut } from '@yaritori/schema'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { createApp } from '../src/app'
import { toBuffers } from '../src/auth'
import { memoryRoomDb } from '../src/roomdb'
import { memoryStore } from '../src/store'

const keys = { opus: newKey('opus'), muse: newKey('muse'), reader: newKey('reader') }
const hashes = Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, hashKey(v)]))
const room = (id: string, members: Record<string, 'read' | 'write'>, extra: Record<string, unknown> = {}) =>
  ({ id, title: `部屋 ${id}`, members, createdAt: 'x', updatedAt: 'x', ...extra })
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
type Who = keyof typeof keys

function setup() {
  const store = memoryStore()
  const rooms = memoryRoomDb([
    room('a', { opus: 'write', muse: 'write', reader: 'read' }),
    room('b', { opus: 'write', muse: 'write' }),
    room('closed', { opus: 'write' }, { archived: true }),
  ])
  const app = createApp({ loadKeys: async () => toBuffers(hashes), store, rooms, guide: '' })
  const call = (who: Who, path: string, init: RequestInit = {}) =>
    app.request(path, { ...init, headers: { authorization: `Bearer ${keys[who]}`, 'content-type': 'application/json', ...init.headers } })
  const json = (who: Who, path: string, body: unknown, headers: Record<string, string> = {}) =>
    call(who, path, { method: 'POST', body: JSON.stringify(body), headers })
  /** 上げる場所をもらう */
  const slot = (who: Who, r: string, name: string, contentType: string, bytes: Uint8Array) =>
    json(who, `/v1/rooms/${r}/uploads`, { name, contentType, size: bytes.length, sha256: sha(bytes) })
  /** 場所をもらって S3 に上げるまで。uploadId を返す */
  const upload = async (who: Who, r: string, name: string, contentType: string, bytes: Uint8Array) => {
    const res = await slot(who, r, name, contentType, bytes)
    assert.equal(res.status, 201)
    const out = (await res.json()) as UploadOut
    assert.deepEqual(store.s3Put(out.url, bytes, out.headers), { ok: true })
    return out.uploadId
  }
  const post = (who: Who, r: string, body: unknown, headers: Record<string, string> = {}) => json(who, `/v1/rooms/${r}/messages`, body, headers)
  const read = (who: Who, r: string, upTo: string) => json(who, `/v1/rooms/${r}/read`, { upTo })
  const box = async (who: Who) => (await (await call(who, '/v1/inbox')).json()) as Inbox
  return { store, call, slot, upload, post, read, box }
}
const err = async (res: Response) => ((await res.json()) as ErrorBody).error

test('上げる場所をもらい、S3 に上げ、発言で指し、別の書き手が取り出せる（中身は関数を通らない）', async () => {
  const { upload, post, call, store } = setup()
  const md = new TextEncoder().encode('# 1枚目\n本文')
  const bin = new Uint8Array(256).map((_, i) => i)
  const ids = [await upload('muse', 'a', 'ストーリーズ案.md', 'text/markdown', md), await upload('muse', 'a', 'bytes.bin', 'application/octet-stream', bin)]
  const res = await post('muse', 'a', { text: '案を添付します', attachments: ids.map((uploadId) => ({ uploadId })) })
  assert.equal(res.status, 201)
  const m = (await res.json()) as MessageOut
  assert.deepEqual(m.attachments!.map((a) => [a.fileId, a.name, a.size, a.sha256]), [
    [`f_${m.id.slice(2)}-0`, 'ストーリーズ案.md', md.length, sha(md)],
    [`f_${m.id.slice(2)}-1`, 'bytes.bin', 256, sha(bin)],
  ])

  const link = (await (await call('reader', `/v1/rooms/a/files/${m.attachments![1].fileId}`)).json()) as FileLink
  assert.equal(link.name, 'bytes.bin')
  assert.equal(link.size, 256)
  assert.match(link.expiresAt, /\+09:00$/)
  assert.equal(sha(store.s3Get(link.url)!), m.attachments![1].sha256)
  const mdLink = (await (await call('opus', `/v1/rooms/a/files/${m.attachments![0].fileId}`)).json()) as FileLink
  assert.equal(mdLink.name, 'ストーリーズ案.md')
  assert.equal(new TextDecoder().decode(store.s3Get(mdLink.url)!), '# 1枚目\n本文')
})

test('申告と違う中身・大きさ・Content-Type・チェックサムは、S3 が断る', async () => {
  const { slot, store } = setup()
  const bytes = new TextEncoder().encode('本物')
  const out = (await (await slot('opus', 'a', 'a.txt', 'text/plain', bytes)).json()) as UploadOut
  assert.deepEqual(Object.keys(out.headers).sort(), ['content-type', 'x-amz-checksum-sha256'])
  const fake = new TextEncoder().encode('偽物')
  assert.deepEqual(store.s3Put(out.url, fake, out.headers), { ok: false, code: 'BadDigest' })
  assert.deepEqual(store.s3Put(out.url, bytes.subarray(1), out.headers), { ok: false, code: 'SignatureDoesNotMatch' })
  assert.deepEqual(store.s3Put(out.url, bytes, { ...out.headers, 'content-type': 'text/html' }), { ok: false, code: 'SignatureDoesNotMatch' })
  assert.deepEqual(store.s3Put(out.url, bytes, { 'content-type': 'text/plain' }), { ok: false, code: 'SignatureDoesNotMatch' })
})

test('上げる場所の申告が違えば 400、read の部屋・閉じた部屋は 403、入っていない部屋は 404', async () => {
  const { call } = setup()
  const up = (who: Who, r: string, body: unknown) => call(who, `/v1/rooms/${r}/uploads`, { method: 'POST', body: JSON.stringify(body) })
  const ok = { name: 'a.txt', contentType: 'text/plain', size: 3, sha256: 'a'.repeat(64) }
  for (const body of [
    { ...ok, size: 100 * 1024 * 1024 + 1 },
    { ...ok, size: 0 },
    { ...ok, sha256: 'A'.repeat(64) },
    { ...ok, name: '../etc/passwd' },
    { ...ok, name: '.env' },
    { ...ok, contentType: 'text/plain; charset=utf-8' },
    { ...ok, extra: 1 },
  ]) {
    const res = await up('opus', 'a', body)
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 80))
  }
  assert.equal((await up('opus', 'a', { ...ok, size: 100 * 1024 * 1024 })).status, 201)
  assert.equal((await err(await up('reader', 'a', ok))).code, 'read_only')
  assert.equal((await err(await up('opus', 'closed', ok))).code, 'archived')
  assert.equal((await up('reader', 'b', ok)).status, 404)
})

test('発言で指せるのは、自分が・この部屋に・上げ終えたものだけ', async () => {
  const { slot, upload, post } = setup()
  const bytes = new TextEncoder().encode('x')
  const notYet = ((await (await slot('opus', 'a', 'a.txt', 'text/plain', bytes)).json()) as UploadOut).uploadId
  const missing = await post('opus', 'a', { text: 'x', attachments: [{ uploadId: notYet }] })
  assert.equal(missing.status, 400)
  assert.equal((await err(missing)).code, 'upload_missing')

  const museOwn = await upload('muse', 'a', 'a.txt', 'text/plain', bytes)
  const others = await post('opus', 'a', { text: 'x', attachments: [{ uploadId: museOwn }] })
  assert.equal((await err(others)).code, 'bad_upload')

  const forB = await upload('opus', 'b', 'a.txt', 'text/plain', bytes)
  const wrongRoom = await post('opus', 'a', { text: 'x', attachments: [{ uploadId: forB }] })
  assert.equal((await err(wrongRoom)).code, 'bad_upload')

  const mine = await upload('opus', 'a', 'a.txt', 'text/plain', bytes)
  const twice = await post('opus', 'a', { text: 'x', attachments: [{ uploadId: mine }, { uploadId: mine }] })
  assert.equal((await err(twice)).code, 'bad_request')
  const legacy = await post('opus', 'a', { text: 'x', attachments: [{ name: 'a', contentType: 'text/plain', contentBase64: 'YQ==' }] })
  assert.equal(legacy.status, 400)
  assert.equal((await post('opus', 'a', { text: 'x', attachments: [{ uploadId: mine }] })).status, 201)
})

test('添付つきの送り直し・途中で落ちた回でも、添付は二重にできない。上げたものが消えたあとの送り直しも前の発言を返す', async () => {
  const { upload, post, store } = setup()
  const uploadId = await upload('opus', 'a', 'a.txt', 'text/plain', new TextEncoder().encode('a'))
  const body = { text: 'x', attachments: [{ uploadId }] }
  const h = { 'idempotency-key': 'k' }
  const first = (await (await post('opus', 'a', body, h)).json()) as MessageOut
  assert.equal((await post('opus', 'a', body, h)).status, 200)

  store.data.delete(`rooms/a/messages/${first.id}.json`) // 添付をコピーしたあと、発言を書く前に落ちたことにする
  const again = (await (await post('opus', 'a', body, h)).json()) as MessageOut
  assert.deepEqual(again.attachments, first.attachments)
  assert.equal([...store.objects.keys()].filter((k) => k.startsWith('rooms/')).length, 1)

  store.objects.delete(`uploads/opus/${uploadId}`) // 2日たって一時置き場が消えた
  store.data.delete(`uploads/opus/${uploadId}.json`)
  const late = await post('opus', 'a', body, h)
  assert.equal(late.status, 200)
  assert.equal(((await late.json()) as MessageOut).id, first.id)
})

test('ほかの部屋の添付・無い添付は 404', async () => {
  const { upload, post, call } = setup()
  const uploadId = await upload('opus', 'b', 'a.txt', 'text/plain', new TextEncoder().encode('a'))
  const m = (await (await post('opus', 'b', { text: 'x', attachments: [{ uploadId }] })).json()) as MessageOut
  const fid = m.attachments![0].fileId
  assert.equal((await call('reader', `/v1/rooms/b/files/${fid}`)).status, 404) // reader は b に入っていない
  const other = await call('opus', `/v1/rooms/a/files/${fid}`)
  assert.equal(other.status, 404)
  assert.equal((await err(other)).code, 'file_not_found')
})

test('受信箱：自分の発言は数えず、read で印を置くと未読が減り、後ろには戻らない', async () => {
  const { post, read, box } = setup()
  const ids: string[] = []
  for (const [who, text] of [['opus', '1'], ['muse', '2'], ['muse', '3'], ['opus', '4']] as const) {
    ids.push(((await (await post(who, 'a', { text, subject: `件名${text}` })).json()) as MessageOut).id)
    await new Promise((r) => setTimeout(r, 2))
  }
  const before = await box('opus')
  assert.deepEqual(before.rooms.map((r) => [r.id, r.unread]), [['a', 2], ['b', 0], ['closed', 0]])
  assert.deepEqual(before.rooms[0].heads.map((h) => [h.from, h.head, h.subject]), [['muse', '2', '件名2'], ['muse', '3', '件名3']])
  assert.equal(before.rooms[0].readUpTo, null)
  assert.equal((await box('reader')).rooms[0].unread, 4)

  const mark = (await (await read('opus', 'a', ids[1])).json()) as ReadMark
  assert.equal(mark.upTo, ids[1])
  assert.deepEqual((await box('opus')).rooms[0].heads.map((h) => h.head), ['3'])

  const back = (await (await read('opus', 'a', ids[0])).json()) as ReadMark // 前の id を送っても動かない
  assert.equal(back.upTo, ids[1])
  await read('opus', 'a', ids[3])
  const after = await box('opus')
  assert.equal(after.rooms[0].unread, 0)
  assert.equal(after.rooms[0].readUpTo, ids[3])
  assert.equal((await box('muse')).rooms[0].unread, 2) // ほかの書き手の印は別
})

test('read：無い発言の id は 400、入っていない部屋は 404、read の書き手でも置ける', async () => {
  const { post, read } = setup()
  const m = (await (await post('opus', 'a', { text: 'x' })).json()) as MessageOut
  assert.equal((await read('reader', 'a', m.id)).status, 200)
  const bad = await read('opus', 'a', 'm_01ZZZZZZZZZZZZZZZZZZZZZZZZ')
  assert.equal(bad.status, 400)
  assert.equal((await err(bad)).code, 'bad_up_to')
  assert.equal((await read('reader', 'b', m.id)).status, 404)
})
