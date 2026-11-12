/**
 * 置き場（S3）。テストでは memoryStore に差し替える。
 *
 * 発言は putIfAbsent（S3 の条件付き書き込み `If-None-Match: *`）だけで書く。1通1オブジェクトの追記なので、
 * 上書きの道を持たなければロックが要らない（設計 3節）。上書きの道は持たない。
 * 部屋（room.json）と既読の印は DynamoDB に移した（roomdb.ts。設計 12節）。S3 に残る古いものは読まない。
 *
 * **添付の中身は関数を通さない。** 書き手は署名付き URL で S3 に直接上げ（presignPut）、関数は S3 の中でコピーし（copy）、
 * 取るときも署名付き URL を渡す（presignGet）。中身を関数に通すと、base64 の重さとメモリと 6MB の壁にぶつかる（2026-10-29 に実測）。
 */
import {
  CopyObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { createHash } from 'node:crypto'

export type ListResult = { keys: string[]; prefixes: string[]; truncated: boolean }
/** 添付のオブジェクトの様子。sha256 は S3 が照合したチェックサム（16進）。無いこともある */
export type ObjectInfo = { size: number; contentType: string; name?: string; sha256?: string }
export type PutSlot = { url: string; headers: Record<string, string> }

export interface Store {
  /** 無ければ null */
  get(key: string): Promise<unknown | null>
  /** 無いときだけ書く。もうあれば false */
  putIfAbsent(key: string, value: unknown): Promise<boolean>
  /** キーの順（＝ULID なら時刻の順）。startAfter より後だけ */
  list(prefix: string, opts?: { startAfter?: string; delimiter?: string; max?: number }): Promise<ListResult>
  /** 上げる URL。大きさ・sha256・Content-Type を署名に含めるので、申告と違う中身は S3 が断る */
  presignPut(key: string, o: { contentType: string; size: number; sha256: string }, seconds: number): Promise<PutSlot>
  head(key: string): Promise<ObjectInfo | null>
  /** S3 の中でコピーする（中身は関数を通らない）。名前と Content-Type を付け直す */
  copy(from: string, to: string, o: { contentType: string; name: string }): Promise<void>
  /** inline は、読む画面が画像・動画を埋め込むとき（それ以外はダウンロードさせる attachment） */
  presignGet(key: string, o: { name: string; inline?: boolean }, seconds: number): Promise<string>
  /** 添付の中身そのもの（読む画面が md・テキストを見せるときだけ。大きさは呼ぶ側が head で確かめてから）。無ければ null */
  getBytes(key: string): Promise<Uint8Array | null>
}

const hexToB64 = (hex: string) => Buffer.from(hex, 'hex').toString('base64')
const b64ToHex = (b64: string) => Buffer.from(b64, 'base64').toString('hex')
const disposition = (name: string, inline = false) => `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`

export function s3Store(
  bucket: string,
  // SDK が勝手に CRC32 を足すと、署名付き URL の約束（ヘッダー）が変わるので、求められたときだけにする
  s3 = new S3Client({ requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' }),
): Store {
  return {
    async get(key) {
      try {
        const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
        return JSON.parse(await res.Body!.transformToString('utf-8'))
      } catch (e) {
        // 無いキーで NoSuchKey が返るのは ListBucket を持っているから（無ければ AccessDenied になる）
        if (e instanceof Error && e.name === 'NoSuchKey') return null
        throw e
      }
    },
    async putIfAbsent(key, value) {
      try {
        await s3.send(new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: JSON.stringify(value),
          ContentType: 'application/json; charset=utf-8',
          IfNoneMatch: '*',
        }))
        return true
      } catch (e) {
        if (e instanceof Error && e.name === 'PreconditionFailed') return false
        throw e
      }
    },
    async list(prefix, opts = {}) {
      const res = await s3.send(new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        StartAfter: opts.startAfter,
        Delimiter: opts.delimiter,
        MaxKeys: opts.max ?? 1000,
      }))
      return {
        keys: (res.Contents ?? []).map((o) => o.Key!),
        prefixes: (res.CommonPrefixes ?? []).map((p) => p.Prefix!),
        truncated: !!res.IsTruncated,
      }
    },
    async presignPut(key, o, seconds) {
      const checksum = hexToB64(o.sha256)
      const url = await getSignedUrl(
        s3,
        new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: o.contentType, ContentLength: o.size, ChecksumSHA256: checksum }),
        {
          expiresIn: seconds,
          // 3つとも署名に入れ、チェックサムはクエリに移さずヘッダーのまま送らせる（S3 が中身と突き合わせる）
          signableHeaders: new Set(['content-type', 'content-length', 'x-amz-checksum-sha256']),
          unhoistableHeaders: new Set(['x-amz-checksum-sha256']),
        },
      )
      return { url, headers: { 'content-type': o.contentType, 'x-amz-checksum-sha256': checksum } }
    },
    async head(key) {
      try {
        const res = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key, ChecksumMode: 'ENABLED' }))
        return {
          size: res.ContentLength ?? 0,
          contentType: res.ContentType ?? 'application/octet-stream',
          ...(res.Metadata?.name && { name: decodeURIComponent(res.Metadata.name) }),
          ...(res.ChecksumSHA256 && !res.ChecksumSHA256.includes('-') && { sha256: b64ToHex(res.ChecksumSHA256) }),
        }
      } catch (e) {
        if (e instanceof Error && (e.name === 'NotFound' || e.name === 'NoSuchKey')) return null
        throw e
      }
    },
    async copy(from, to, o) {
      await s3.send(new CopyObjectCommand({
        Bucket: bucket,
        Key: to,
        CopySource: `${bucket}/${from.split('/').map(encodeURIComponent).join('/')}`,
        MetadataDirective: 'REPLACE',
        ContentType: o.contentType,
        // S3 のメタデータは ASCII なので、名前は URL の形で持つ
        Metadata: { name: encodeURIComponent(o.name) },
        ChecksumAlgorithm: 'SHA256',
      }))
    },
    async presignGet(key, o, seconds) {
      return getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key, ResponseContentDisposition: disposition(o.name, o.inline) }), { expiresIn: seconds })
    },
    async getBytes(key) {
      try {
        const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
        return await res.Body!.transformToByteArray()
      } catch (e) {
        if (e instanceof Error && e.name === 'NoSuchKey') return null
        throw e
      }
    },
  }
}

type MemObject = { bytes: Uint8Array; contentType: string; name?: string; sha256?: string }

/**
 * テスト用。S3 と同じく、キーの辞書順で並べる。
 * 署名付き URL は memory:// の URL にし、s3Put・s3Get で S3 の振る舞い（申告と違えば断る）をまねる
 */
export function memoryStore(init: Record<string, unknown> = {}) {
  const data = new Map(Object.entries(init).map(([k, v]) => [k, JSON.stringify(v)]))
  const objects = new Map<string, MemObject>()
  const slots = new Map<string, { key: string; contentType: string; size: number; sha256: string }>()
  let n = 0
  const store: Store & {
    data: typeof data
    objects: typeof objects
    s3Put(url: string, bytes: Uint8Array, headers: Record<string, string>): { ok: true } | { ok: false; code: string }
    s3Get(url: string): Uint8Array | null
  } = {
    data,
    objects,
    async get(key) {
      const v = data.get(key)
      return v === undefined ? null : JSON.parse(v)
    },
    async putIfAbsent(key, value) {
      if (data.has(key) || objects.has(key)) return false
      data.set(key, JSON.stringify(value))
      return true
    },
    async list(prefix, opts = {}) {
      const max = opts.max ?? 1000
      const keys: string[] = []
      const prefixes = new Set<string>()
      const all = [...data.keys(), ...objects.keys()].filter((k) => k.startsWith(prefix) && (!opts.startAfter || k > opts.startAfter)).sort()
      let truncated = false
      for (const k of all) {
        if (keys.length + prefixes.size >= max) {
          truncated = true
          break
        }
        const rest = k.slice(prefix.length)
        const cut = opts.delimiter ? rest.indexOf(opts.delimiter) : -1
        if (cut >= 0) prefixes.add(prefix + rest.slice(0, cut + 1))
        else keys.push(k)
      }
      return { keys, prefixes: [...prefixes], truncated }
    },
    async presignPut(key, o) {
      const url = `memory://put/${++n}`
      slots.set(url, { key, ...o })
      return { url, headers: { 'content-type': o.contentType, 'x-amz-checksum-sha256': hexToB64(o.sha256) } }
    },
    async head(key) {
      const o = objects.get(key)
      return o ? { size: o.bytes.length, contentType: o.contentType, ...(o.name && { name: o.name }), ...(o.sha256 && { sha256: o.sha256 }) } : null
    },
    async copy(from, to, o) {
      const src = objects.get(from)
      if (!src) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' })
      objects.set(to, { ...src, contentType: o.contentType, name: o.name })
    },
    async presignGet(key, o) {
      return `memory://get/${key}${o.inline ? '#inline' : ''}`
    },
    async getBytes(key) {
      return objects.get(key)?.bytes ?? null
    },
    s3Put(url, bytes, headers) {
      const slot = slots.get(url)
      if (!slot) return { ok: false, code: 'NoSuchUrl' }
      // 署名に入れた3つのどれかが違えば、S3 は署名が合わない（403）かチェックサムが合わない（400）で断る
      if (headers['content-type'] !== slot.contentType || bytes.length !== slot.size) return { ok: false, code: 'SignatureDoesNotMatch' }
      if (headers['x-amz-checksum-sha256'] !== hexToB64(slot.sha256)) return { ok: false, code: 'SignatureDoesNotMatch' }
      const actual = createHash('sha256').update(bytes).digest('hex')
      if (actual !== slot.sha256) return { ok: false, code: 'BadDigest' }
      objects.set(slot.key, { bytes: new Uint8Array(bytes), contentType: slot.contentType, sha256: actual })
      return { ok: true }
    },
    s3Get(url) {
      return objects.get(url.replace('memory://get/', ''))?.bytes ?? null
    },
  }
  return store
}
