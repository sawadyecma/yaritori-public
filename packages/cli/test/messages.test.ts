import type { MessageOut } from '@yaritori/schema'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { DATA_NOTE, attachmentNames, contentTypeOf, fileName, pulledIds, readFrontMatter, toMarkdown } from '../src/messages'

const msg = (over: Partial<MessageOut> = {}): MessageOut => ({
  id: 'm_01JBX0000000000000000000AA',
  room: 'sample-room',
  from: 'muse',
  text: '# 3回目の返事\n本文',
  head: '# 3回目の返事',
  createdAt: '2026-10-29T14:32:00+09:00',
  ...over,
})

test('落とした md は頭に id と room を持ち、データだという一文がつく', () => {
  const md = toMarkdown(msg({ subject: '見出し: #1 "引用"', meta: { model: 'muse-spark-1.3' }, replyTo: 'm_01JBW0000000000000000000AA' }))
  assert.deepEqual(readFrontMatter(md), { id: 'm_01JBX0000000000000000000AA', room: 'sample-room' })
  assert.ok(md.includes(DATA_NOTE))
  assert.ok(md.endsWith('# 3回目の返事\n本文\n'))
  assert.ok(md.includes('subject: "見出し: #1 \\"引用\\""'))
})

test('手で書いた md は落とし済みとみなさない', () => {
  assert.equal(readFrontMatter('# 叩き台\n本文'), null)
  assert.equal(readFrontMatter('---\ntitle: x\n---\n本文'), null)
})

test('回の番号は、同じ日・同じ書き手の最大＋1（手で置いたファイルも数え、抜けは埋めない）', () => {
  const existing = ['2026-10-29-muse-1.md', '2026-10-29-muse-3.md', '2026-10-29-opus-2.md', 'README.md']
  assert.equal(fileName(msg(), existing), '2026-10-29-muse-4.md')
  assert.equal(fileName(msg({ from: 'opus' }), existing), '2026-10-29-opus-3.md')
  assert.equal(fileName(msg({ createdAt: '2026-10-30T09:00:00+09:00' }), existing), '2026-10-30-muse-1.md')
})

test('フォルダの中から、この部屋の落とし済みの id を拾う', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yaritori-'))
  writeFileSync(join(dir, 'a.md'), toMarkdown(msg()))
  writeFileSync(join(dir, 'b.md'), toMarkdown(msg({ id: 'm_01JBY0000000000000000000AA', room: 'other' })))
  writeFileSync(join(dir, 'c.md'), '# 手で書いたもの')
  assert.deepEqual([...pulledIds(dir, 'sample-room')], ['m_01JBX0000000000000000000AA'])
  assert.deepEqual([...pulledIds(join(dir, 'nothing'), 'sample-room')], [])
})

test('添付は front matter に、md から見た置き場所と sha256 つきで並ぶ', () => {
  const m = msg({ attachments: [{ fileId: 'f_01JBX0000000000000000000AA-0', name: '案.md', contentType: 'text/markdown', size: 3, sha256: 'ab' }] })
  const md = toMarkdown(m, [{ name: '案.md', path: '2026-10-29-muse-4/案.md' }])
  const line = md.split('\n').find((l) => l.startsWith('attachments: '))!
  assert.deepEqual(JSON.parse(line.slice('attachments: '.length)), [
    { name: '案.md', path: '2026-10-29-muse-4/案.md', contentType: 'text/markdown', size: 3, sha256: 'ab' },
  ])
  assert.equal(toMarkdown(msg()).includes('attachments'), false)
})

test('1通の中で添付の名前が重なったら 2- 3- をつける', () => {
  assert.deepEqual(attachmentNames([{ name: 'a.png' }, { name: 'b.png' }, { name: 'a.png' }, { name: 'a.png' }]), ['a.png', 'b.png', '2-a.png', '3-a.png'])
})

test('Content-Type は拡張子から（大文字も）。知らないものは octet-stream', () => {
  assert.equal(contentTypeOf('案.md'), 'text/markdown')
  assert.equal(contentTypeOf('IMG.JPG'), 'image/jpeg')
  assert.equal(contentTypeOf('data.unknown'), 'application/octet-stream')
  assert.equal(contentTypeOf('Makefile'), 'application/octet-stream')
})
