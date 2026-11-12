import type { Inbox, InboxRoom } from '@yaritori/schema'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { waitFor, watched, type WaitDeps } from '../src/wait'

const room = (id: string, unread = 0, over: Partial<InboxRoom> = {}): InboxRoom => ({
  id,
  title: `部屋 ${id}`,
  role: 'write',
  archived: false,
  readUpTo: null,
  unread,
  unreadCapped: false,
  heads: [],
  ...over,
})
const box = (...rooms: InboxRoom[]): Inbox => ({ rooms })
const httpError = (status: number) => Object.assign(new Error(`→ ${status}`), { status })

/** 受信箱を順に返し（尽きたら最後のもの）、待った時間を時計に足す */
function fake(answers: (Inbox | Error)[]) {
  let clock = 0
  let calls = 0
  const warns: string[] = []
  const deps: WaitDeps = {
    inbox: async () => {
      const a = answers[Math.min(calls++, answers.length - 1)]
      if (a instanceof Error) throw a
      return a
    },
    sleep: async (ms) => void (clock += ms),
    now: () => clock,
    warn: (m) => void warns.push(m),
  }
  return { deps, warns, calls: () => calls, clock: () => clock }
}

test('まだ pull していない発言があれば、待たずにすぐ終わる', async () => {
  const f = fake([box(room('sample', 2), room('other'))])
  const hit = await waitFor(['sample'], { every: 60, timeout: 10 }, f.deps)
  assert.deepEqual(hit?.map((r) => r.id), ['sample'])
  assert.equal(f.calls(), 1)
  assert.equal(f.clock(), 0)
})

test('来るまで every 秒ごとに見に行き、来た部屋だけを返す', async () => {
  const f = fake([box(room('sample'), room('other', 5)), box(room('sample'), room('other', 5)), box(room('sample', 1), room('other', 5))])
  const hit = await waitFor(['sample'], { every: 60, timeout: 10 }, f.deps)
  assert.deepEqual(hit?.map((r) => r.id), ['sample'])
  assert.equal(f.calls(), 3)
  assert.equal(f.clock(), 120e3)
})

test('timeout 分のうちに来なければ null（最後は残りの時間だけ待つ）', async () => {
  const f = fake([box(room('sample'))])
  assert.equal(await waitFor(['sample'], { every: 60, timeout: 2.5 }, f.deps), null)
  assert.equal(f.clock(), 150e3)
  assert.equal(f.calls(), 4)
})

test('部屋を言わなければ、閉じた部屋を除く入っている部屋のどれか', async () => {
  const f = fake([box(room('a'), room('closed', 3, { archived: true })), box(room('a'), room('b', 1), room('closed', 3, { archived: true }))])
  const hit = await waitFor([], { every: 60, timeout: 10 }, f.deps)
  assert.deepEqual(hit?.map((r) => r.id), ['b'])
})

test('入っていない部屋・閉じた部屋を言われたら、待たずに止める', () => {
  const b = box(room('sample'), room('closed', 0, { archived: true }))
  assert.throws(() => watched(b, ['nothing']), /部屋 nothing に入っていません/)
  assert.throws(() => watched(b, ['closed']), /閉じています/)
  assert.deepEqual(watched(b, ['sample']).map((r) => r.id), ['sample'])
})

test('通信の失敗・5xx・429 は待ち続け、キー違い（4xx）は止める。最初の1回の失敗はすぐ知らせる', async () => {
  const net = new TypeError('fetch failed')
  const f = fake([box(room('sample')), net, httpError(503), httpError(429), box(room('sample', 1))])
  const hit = await waitFor(['sample'], { every: 60, timeout: 10 }, f.deps)
  assert.deepEqual(hit?.map((r) => r.id), ['sample'])
  assert.equal(f.warns.length, 3)

  const bad = fake([box(room('sample')), httpError(401)])
  await assert.rejects(waitFor(['sample'], { every: 60, timeout: 10 }, bad.deps), /401/)
  const first = fake([httpError(503)])
  await assert.rejects(waitFor(['sample'], { every: 60, timeout: 10 }, first.deps), /503/)
})

test('待っている間に部屋が閉じられたら止める', async () => {
  const f = fake([box(room('sample')), box(room('sample', 0, { archived: true }))])
  await assert.rejects(waitFor(['sample'], { every: 60, timeout: 10 }, f.deps), /閉じています/)
})
