import type { LambdaFunctionURLEvent } from 'aws-lambda'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import { urlHandler } from '../src/url-adapter'

const event = (over: Partial<LambdaFunctionURLEvent> & { method?: string } = {}): LambdaFunctionURLEvent => ({
  version: '2.0',
  routeKey: '$default',
  rawPath: '/echo',
  rawQueryString: '',
  headers: { host: 'example.lambda-url.ap-northeast-1.on.aws', 'content-type': 'application/json' },
  isBase64Encoded: false,
  requestContext: {
    accountId: 'anonymous', apiId: 'x', domainName: 'example.lambda-url.ap-northeast-1.on.aws', domainPrefix: 'example',
    http: { method: over.method ?? 'GET', path: over.rawPath ?? '/echo', protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 't' },
    requestId: 'r', routeKey: '$default', stage: '$default', time: '', timeEpoch: 0,
  },
  ...over,
})

const bin = new Uint8Array(256).map((_, i) => i)
const app = new Hono()
  .get('/echo', (c) => c.json({ q: c.req.query('q'), auth: c.req.header('authorization') ?? null }))
  .post('/echo', async (c) => c.json({ text: await c.req.text() }))
  .post('/bytes', async (c) => c.json({ len: (await c.req.arrayBuffer()).byteLength }))
  .get('/bin', (c) => c.body(new Uint8Array(bin), 200, { 'Content-Type': 'application/octet-stream' }))
  .get('/sjis', (c) => c.body(new Uint8Array([0x93, 0xfa, 0x96, 0x7b]), 200, { 'Content-Type': 'text/plain' }))
const handler = urlHandler(app)

test('JSON の応答は文字列のまま、パス・クエリ・ヘッダーが届く', async () => {
  const res = await handler(event({ rawQueryString: 'q=%E6%A4%9C%E7%B4%A2%E8%AA%9E', headers: { host: 'h', authorization: 'Bearer k' } }))
  assert.equal(res.statusCode, 200)
  assert.equal(res.isBase64Encoded, false)
  assert.deepEqual(JSON.parse(res.body!), { q: '検索語', auth: 'Bearer k' })
})

test('本文は文字のときも base64 のときも届く', async () => {
  const text = await handler(event({ method: 'POST', body: '{"a":"日本"}' }))
  assert.deepEqual(JSON.parse(text.body!), { text: '{"a":"日本"}' })
  const b64 = await handler(event({ method: 'POST', rawPath: '/bytes', body: Buffer.from(bin).toString('base64'), isBase64Encoded: true }))
  assert.deepEqual(JSON.parse(b64.body!), { len: 256 })
})

test('JSON 以外は base64 で返し、バイナリも Shift_JIS も1バイトも崩れない', async () => {
  const b = await handler(event({ rawPath: '/bin' }))
  assert.equal(b.isBase64Encoded, true)
  assert.deepEqual([...Buffer.from(b.body!, 'base64')], [...bin])
  const s = await handler(event({ rawPath: '/sjis' }))
  assert.equal(s.isBase64Encoded, true)
  assert.deepEqual([...Buffer.from(s.body!, 'base64')], [0x93, 0xfa, 0x96, 0x7b])
})

test('4MB の応答を作るのが速い（1秒より十分短い）', async () => {
  const big = new Uint8Array(4 * 1024 * 1024).fill(7)
  const h = urlHandler(new Hono().get('/big', (c) => c.body(new Uint8Array(big), 200, { 'Content-Type': 'application/octet-stream' })))
  const started = performance.now()
  const res = await h(event({ rawPath: '/big' }))
  const ms = performance.now() - started
  assert.equal(Buffer.from(res.body!, 'base64').length, big.length)
  assert.ok(ms < 1000, `${ms.toFixed(0)}ms`)
})

test('Set-Cookie は cookies に並べ、届いた cookies は Cookie ヘッダーにまとめる（読む画面のログイン）', async () => {
  const h = urlHandler(new Hono()
    .get('/set', (c) => {
      c.header('Set-Cookie', 'a=1; Path=/', { append: true })
      c.header('Set-Cookie', 'b=2; Path=/', { append: true })
      return c.redirect('/next', 302)
    })
    .get('/get', (c) => c.json({ cookie: c.req.header('cookie') ?? null })))
  const set = await h(event({ rawPath: '/set' }))
  assert.equal(set.statusCode, 302)
  assert.deepEqual(set.cookies, ['a=1; Path=/', 'b=2; Path=/'])
  assert.equal(set.headers?.['set-cookie'], undefined)
  assert.equal(set.headers?.location, '/next')
  const get = await h(event({ rawPath: '/get', cookies: ['a=1', 'b=2'] }))
  assert.deepEqual(JSON.parse(get.body!), { cookie: 'a=1; b=2' })
  assert.equal((await h(event({ rawPath: '/get' }))).cookies, undefined)
})
