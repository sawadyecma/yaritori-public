import assert from 'node:assert/strict'
import { test } from 'node:test'
import { KeyHashes, hashKey, newKey, parseKey } from '../src/index'

test('作ったキーから書き手を引ける', () => {
  for (const name of ['muse', 'opus', 'human', 'routine-daily', 'a']) {
    assert.deepEqual(parseKey(newKey(name)), { principal: name })
  }
})

test('秘密の部分に _ や - が入っても書き手を取り違えない', () => {
  const secret = 'ab_cd-ef' + 'x'.repeat(35)
  assert.deepEqual(parseKey(`yt_muse_${secret}`), { principal: 'muse' })
})

test('形が違うキーは null', () => {
  for (const bad of ['', 'muse', 'yt_muse_short', `yt_Muse_${'x'.repeat(43)}`, `yt__${'x'.repeat(43)}`, `xx_muse_${'x'.repeat(43)}`, `yt_muse_${'x'.repeat(44)}`]) {
    assert.equal(parseKey(bad), null, bad)
  }
})

test('書き手の名前に _ や大文字を使うとキーを作らない', () => {
  assert.throws(() => newKey('my_bot'))
  assert.throws(() => newKey('Muse'))
  assert.throws(() => newKey('x'.repeat(33)))
})

test('ハッシュは sha256 の16進で、SSM の形に通る', () => {
  const key = newKey('opus')
  const doc = { opus: hashKey(key) }
  assert.equal(doc.opus.length, 64)
  assert.deepEqual(KeyHashes.parse(doc), doc)
  assert.notEqual(hashKey(newKey('opus')), doc.opus)
})
