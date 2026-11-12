import { WEB_PAGE, WEB_PEEK_TEXT_BYTES, peekKind, type DocHistory, type ErrorBody, type FileLink, type MessageList, type WebDoc, type WebPeek, type WebRoom, type WebRoomList } from '@yaritori/schema'
import { SignJWT } from 'jose'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { googleAuth } from '../src/google'
import { memoryRoomDb } from '../src/roomdb'
import { ulid } from '../src/rooms'
import { memoryStore } from '../src/store'
import { createViewer } from '../src/viewer'

const room = (id: string, members: Record<string, 'read' | 'write'>, extra: Record<string, unknown> = {}) => ({
  id, title: `部屋 ${id}`, about: 'ためし', rules: '- 数字は出どころつきで', members,
  createdAt: '2026-10-29T15:00:00+09:00', updatedAt: '2026-10-29T15:00:00+09:00', ...extra,
})
const message = (r: string, n: number, from = 'muse') => {
  const id = `m_${ulid(Date.UTC(2026, 9, 29) + n * 1000)}`
  return { [`rooms/${r}/messages/${id}.json`]: { id, room: r, from, text: `# ${n}通目\n本文`, createdAt: '2026-10-29T15:00:00+09:00' } }
}
const version = (r: string, doc: string, v: number, text: string) => ({
  [`rooms/${r}/docs/${doc}/v${String(v).padStart(6, '0')}.json`]: { docId: doc, room: r, version: v, text, updatedBy: 'human', updatedAt: 'x' },
})

function setup() {
  const rooms = memoryRoomDb([
    room('sample-room', { human: 'write', opus: 'write', muse: 'write' }, {
      docs: { '01-memo': { title: '01-本人のメモ.md', editors: ['human'] } },
    }),
    room('selftest', { opus: 'write' }),
    room('closed', { opus: 'write' }, { archived: true }),
  ])
  const store = memoryStore({
    ...Object.assign({}, ...Array.from({ length: WEB_PAGE + 3 }, (_, i) => message('sample-room', i + 1))),
    ...version('sample-room', '01-memo', 1, '最初'),
    ...version('sample-room', '01-memo', 2, '二つ目を足した'),
  })
  return { store, rooms, app: createViewer({ store, rooms }) }
}
const err = async (res: Response) => ((await res.json()) as ErrorBody).error

test('部屋の members とは関係なく、全部の部屋が見える（閉じた部屋も）', async () => {
  const { app } = setup()
  const res = await app.request('/api/rooms')
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('cache-control'), 'no-store')
  assert.equal(res.headers.get('x-robots-tag'), 'noindex, nofollow')
  const { rooms } = (await res.json()) as WebRoomList
  assert.deepEqual(rooms.map((r) => [r.id, r.archived]), [['closed', true], ['sample-room', false], ['selftest', false]])
  assert.deepEqual(rooms[1].members, { human: 'write', opus: 'write', muse: 'write' })
})

test('部屋は決まりと資料の一覧つき。「直せるか」は持たない', async () => {
  const { app } = setup()
  const r = (await (await app.request('/api/rooms/sample-room')).json()) as WebRoom
  assert.equal(r.rules, '- 数字は出どころつきで')
  assert.deepEqual(r.docs.map((d) => [d.docId, d.version, d.editors]), [['01-memo', 2, ['human']]])
  assert.equal('canEdit' in r.docs[0], false)
})

test('発言は置いた順に 50 通ずつ、続きは after=<next>', async () => {
  const { app } = setup()
  const first = (await (await app.request('/api/rooms/sample-room/messages')).json()) as MessageList
  assert.equal(first.messages.length, WEB_PAGE)
  assert.equal(first.messages[0].head, '# 1通目')
  assert.equal(first.messages[0].text, '# 1通目\n本文')
  assert.ok(first.next)
  const rest = (await (await app.request(`/api/rooms/sample-room/messages?after=${first.next}`)).json()) as MessageList
  assert.deepEqual(rest.messages.map((m) => m.head), ['# 51通目', '# 52通目', '# 53通目'])
  assert.equal(rest.next, null)
  const one = await app.request(`/api/rooms/sample-room/messages/${rest.messages[0].id}`)
  assert.equal(one.status, 200)
})

test('資料はいまの版と前の版、版の一覧', async () => {
  const { app } = setup()
  const now = (await (await app.request('/api/rooms/sample-room/docs/01-memo')).json()) as WebDoc
  assert.deepEqual([now.version, now.latest, now.text], [2, 2, '二つ目を足した'])
  assert.equal('canEdit' in now, false)
  const old = (await (await app.request('/api/rooms/sample-room/docs/01-memo?version=1')).json()) as WebDoc
  assert.deepEqual([old.version, old.latest, old.text], [1, 2, '最初'])
  const h = (await (await app.request('/api/rooms/sample-room/docs/01-memo/versions')).json()) as DocHistory
  assert.deepEqual(h.versions.map((v) => v.version), [2, 1])
  assert.equal((await app.request('/api/rooms/sample-room/docs/01-memo?version=0')).status, 400)
  assert.equal((await app.request('/api/rooms/sample-room/docs/01-memo?version=9')).status, 404)
})

test('添付は取り出す URL を返す', async () => {
  const { app, store } = setup()
  const fileId = `f_${ulid()}-0`
  store.objects.set(`rooms/sample-room/files/${fileId}`, { bytes: new Uint8Array([1]), contentType: 'image/png', name: '案.png' })
  const link = (await (await app.request(`/api/rooms/sample-room/files/${fileId}`)).json()) as FileLink
  assert.equal(link.name, '案.png')
  assert.equal(link.url, `memory://get/rooms/sample-room/files/${fileId}`)
})

test('ピーク：md とテキストは中身、画像と動画は埋め込む URL、ほかはダウンロードだけ', async () => {
  const { app, store } = setup()
  const put = (n: number, name: string, contentType: string, bytes: Uint8Array) => {
    const fileId = `f_${ulid(Date.UTC(2026, 9, 30) + n)}-0`
    store.objects.set(`rooms/sample-room/files/${fileId}`, { bytes, contentType, name })
    return async () => (await (await app.request(`/api/rooms/sample-room/files/${fileId}/peek`)).json()) as WebPeek
  }
  const utf8 = (t: string) => new TextEncoder().encode(t)

  const md = await put(1, '案.md', 'text/markdown', utf8('# 案\n本文'))()
  assert.deepEqual([md.kind, md.text, md.inlineUrl], ['markdown', '# 案\n本文', undefined])
  assert.match(md.url, /^memory:\/\/get\/rooms\/sample-room\/files\/f_/)

  const csv = await put(2, '表.csv', 'text/csv', utf8('a,b\n1,2'))()
  assert.deepEqual([csv.kind, csv.text], ['text', 'a,b\n1,2'])

  const png = await put(3, 'カバー.png', 'image/png', new Uint8Array([0x89, 0x50]))()
  assert.equal(png.kind, 'image')
  assert.equal(png.text, undefined)
  assert.match(png.inlineUrl!, /#inline$/)
  assert.doesNotMatch(png.url, /#inline$/) // ダウンロードのほうは attachment のまま

  const mp4 = await put(4, 'リール.mp4', 'video/mp4', new Uint8Array([0]))()
  assert.equal(mp4.kind, 'video')
  assert.match(mp4.inlineUrl!, /#inline$/)

  // Shift_JIS の「日本」
  const sjis = await put(5, 'メモ.txt', 'text/plain', new Uint8Array([0x93, 0xfa, 0x96, 0x7b]))()
  assert.equal(sjis.kind, 'other')
  assert.match(sjis.note!, /UTF-8/)

  const big = await put(6, '大きい.md', 'text/markdown', new Uint8Array(WEB_PEEK_TEXT_BYTES + 1))()
  assert.equal(big.kind, 'other')
  assert.match(big.note!, /1MB/)
  assert.equal(big.text, undefined)

  const pdf = await put(7, '資料.pdf', 'application/pdf', new Uint8Array([0]))()
  assert.deepEqual([pdf.kind, pdf.inlineUrl, pdf.text], ['other', undefined, undefined])
  assert.ok(pdf.url)
})

test('ピークの種類は Content-Type でも拡張子でも引く（HTML や SVG は埋め込まない）', () => {
  assert.equal(peekKind('a.md', 'application/octet-stream'), 'markdown')
  assert.equal(peekKind('a.bin', 'text/markdown'), 'markdown')
  assert.equal(peekKind('写真.JPG', 'application/octet-stream'), 'image')
  assert.equal(peekKind('a.mov', 'video/quicktime'), 'video')
  assert.equal(peekKind('a.json', 'application/json'), 'text')
  assert.equal(peekKind('a.svg', 'image/svg+xml'), 'other')
  assert.equal(peekKind('a.html', 'text/html'), 'text') // 中身は文字として見せる（描かない）
  assert.equal(peekKind('a.zip', 'application/zip'), 'other')
})

test('無い部屋・形違いの id は 404（パスの外へは出ない）', async () => {
  const { app } = setup()
  for (const path of [
    '/api/rooms/nowhere',
    '/api/rooms/..%2F..%2Fidem',
    '/api/rooms/sample-room/messages/m_nope',
    '/api/rooms/sample-room/messages?after=..',
    '/api/rooms/sample-room/docs/..',
    '/api/rooms/sample-room/docs/nodoc',
    '/api/rooms/sample-room/files/f_x',
  ]) {
    const res = await app.request(path)
    assert.equal(res.status, 404, path)
    assert.match((await err(res)).message, /ありません/)
  }
})

test('書く口は無い（POST・PUT は 404）', async () => {
  const { app, store } = setup()
  const before = store.data.size
  for (const [method, path] of [['POST', '/api/rooms/sample-room/messages'], ['PUT', '/api/rooms/sample-room/docs/01-memo'], ['POST', '/api/rooms/sample-room/read']]) {
    const res = await app.request(path, { method, body: '{"text":"x","upTo":"x"}', headers: { 'content-type': 'application/json' } })
    assert.equal(res.status, 404, `${method} ${path}`)
  }
  assert.equal(store.data.size, before)
})

// ── ログイン（google.ts の guard。Google とのやり取り自体は本番で確かめる） ──

const SESSION_KEY = 'k'.repeat(48)
const ME = 'me@example.com'

function withAuth(viewers = [ME]) {
  const allow = new Set(viewers)
  const auth = googleAuth({
    secrets: async () => ({ clientId: 'id', clientSecret: 'secret', sessionKey: SESSION_KEY }),
    viewers: async () => allow,
    publicOrigin: 'https://yaritori.example.com',
  })
  const { store, rooms } = setup()
  return { app: createViewer({ store, rooms, auth }), allow }
}

async function session(o: { email?: string; key?: string; audience?: string; exp?: string } = {}) {
  const jwt = await new SignJWT({ sub: '123', email: o.email ?? ME })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(o.exp ?? '1h')
    .setAudience(o.audience ?? 'session')
    .sign(new TextEncoder().encode(o.key ?? SESSION_KEY))
  return { cookie: `__Host-yt_session=${jwt}` }
}

test('ログインしていなければ、API は 401・画面はログインへ', async () => {
  const { app } = withAuth()
  const api = await app.request('/api/rooms')
  assert.equal(api.status, 401)
  assert.equal((await err(api)).code, 'login')
  const page = await app.request('/')
  assert.equal(page.status, 302)
  assert.equal(page.headers.get('location'), '/auth/login')
  // 無いパスでも、先にログインを求める（何があるかを漏らさない）
  assert.equal((await app.request('/api/nowhere')).status, 401)
})

test('許可したアカウントのセッションなら読める', async () => {
  const { app } = withAuth()
  const res = await app.request('/api/me', { headers: await session() })
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { email: ME })
  assert.equal((await app.request('/api/rooms', { headers: await session() })).status, 200)
})

test('鍵違い・期限切れ・ログイン途中の印・許可していないアカウントは通さない', async () => {
  const { app } = withAuth()
  for (const [why, h] of [
    ['鍵違い', await session({ key: 'x'.repeat(48) })],
    ['期限切れ', await session({ exp: '-1s' })],
    ['ログイン途中の印', await session({ audience: 'login' })],
    ['許可していない', await session({ email: 'other@example.com' })],
  ] as const) {
    assert.equal((await app.request('/api/rooms', { headers: h })).status, 401, why)
  }
})

test('許可リストから外せば、署名が有効なセッションでも入れない', async () => {
  const { app, allow } = withAuth()
  const h = await session()
  assert.equal((await app.request('/api/rooms', { headers: h })).status, 200)
  allow.delete(ME)
  assert.equal((await app.request('/api/rooms', { headers: h })).status, 401)
})

test('ログインの途中の印が無い戻りは 400（Google には問い合わせない）', async () => {
  const { app } = withAuth()
  const res = await app.request('/auth/callback?code=c&state=s')
  assert.equal(res.status, 400)
  assert.match(await res.text(), /やり直して/)
})

test('ログアウトはセッションの Cookie を消す', async () => {
  const { app } = withAuth()
  const res = await app.request('/auth/logout', { headers: await session() })
  assert.equal(res.status, 200)
  assert.match(res.headers.get('set-cookie') ?? '', /^__Host-yt_session=;.*Max-Age=0/)
})
