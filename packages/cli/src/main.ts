/**
 * yaritori の CLI（`npm run yaritori -- <コマンド>`）。
 *
 * - `me`・`inbox`・`wait`・`post`・`pull`・`doc` は API をキー（YARITORI_KEY）で叩く。書き手として使う道
 * - `admin …` は**管理の操作で、API に出さず、AWS の認証で DynamoDB・SSM を直接書く**（設計 1節・5節・12節）。
 *   だから使えるのは、このアカウントの AWS の認証を持っている手元だけ
 */
import { parseArgs } from 'node:util'
import { docGet, docList, docPut } from './docs'
import { keyList, keyRevoke, keyRotate } from './key'
import { me, post, pull, showInbox } from './messages'
import { roomCreate, roomDoc, roomEdit, roomList, roomShow } from './rooms'
import { wait } from './wait'
import { webAllow, webDeny, webGoogle, webList, webSessionRotate } from './web'

const USAGE = `使い方（相対パスは、コマンドを打った場所から。--as <書き手> で YARITORI_KEY_<書き手> のキーを使う）:
  yaritori me                                                    このキーの書き手と、入っている部屋
  yaritori inbox                                                 部屋ごとの未読
  yaritori wait [<部屋> …] [--every <秒>] [--timeout <分>]       ほかの書き手の発言が来るまで待つ（未読があればすぐ終わる。
                                                                 既定は 60 秒ごと・最長 360 分。来なければ終了コード 3）
  yaritori post <部屋> <file.md> [--subject <見出し>] [--reply <発言の id>] [--attach <ファイル> …]
                                                                 発言を置く（直せない・消せない。添付は1つ 100MB・10 個まで）
  yaritori pull <部屋> --into <フォルダ> [--include-mine]         まだ落としていない発言を <日付>-<書き手>-<回>.md で落とし、既読にする
  yaritori doc list <部屋>                                       資料の一覧（版・直せるか）
  yaritori doc get <部屋> <資料> [--out <ファイル>] [--version <版>] [--force]
                                                                 資料の写しを書く（頭に版。手で直した写しは上書きしない）
  yaritori doc put <部屋> <資料> <ファイル> [--note <何を直したか>] [--base <版>]
                                                                 資料を直す（写しの版のあとに誰かが直していれば 412 で止まる）

  yaritori admin room create <部屋> --title <題> [--about <説明>] [--rules-file <md>] [--member <書き手>=read|write …]
  yaritori admin room edit <部屋> [--title …] [--about …] [--rules-file …] [--member …] [--remove-member <書き手> …] [--archive|--unarchive]
  yaritori admin room doc <部屋> <資料> [--title <名前>] [--editor <書き手> …] [--remove]
                                                                 資料を部屋に足す・直せる人を替える・外す
  yaritori admin room show <部屋>
  yaritori admin room list
  yaritori admin key rotate <書き手> [--write-env <ファイル> [--env-name <名前>] | --clipboard]
                                                                 キーを作る・作り直す（表示は1度きり。--write-env か --clipboard なら画面に出さない）
  yaritori admin key revoke <書き手>                             キーを失効させる
  yaritori admin key list                                        キーのある書き手の一覧
  yaritori admin web allow <メールアドレス>                       読む画面（Web）に入れる Google アカウントを足す
  yaritori admin web deny <メールアドレス>                        外す（5分以内にログイン済みの端末も入れなくなる）
  yaritori admin web list                                        入れるアカウントと、Google・セッションの鍵の有無
  yaritori admin web google <クライアント ID>                     Google の OAuth クライアント（シークレットは先にクリップボードへ）
  yaritori admin web session-rotate                              セッションの鍵を作る・作り直す（全端末がログインし直し）`

async function main(argv: string[]) {
  const { values: v, positionals: p } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'write-env': { type: 'string' },
      'env-name': { type: 'string' },
      clipboard: { type: 'boolean' },
      as: { type: 'string' },
      into: { type: 'string' },
      'include-mine': { type: 'boolean' },
      subject: { type: 'string' },
      reply: { type: 'string' },
      attach: { type: 'string', multiple: true },
      title: { type: 'string' },
      about: { type: 'string' },
      'rules-file': { type: 'string' },
      member: { type: 'string', multiple: true },
      'remove-member': { type: 'string', multiple: true },
      archive: { type: 'boolean' },
      unarchive: { type: 'boolean' },
      out: { type: 'string' },
      version: { type: 'string' },
      force: { type: 'boolean' },
      note: { type: 'string' },
      base: { type: 'string' },
      every: { type: 'string' },
      timeout: { type: 'string' },
      editor: { type: 'string', multiple: true },
      remove: { type: 'boolean' },
    },
  })
  const [cmd, a, b, c, d] = p
  if (v.as) process.env.YARITORI_ACTOR = v.as
  const int = (s: string | undefined, name: string) => {
    if (s === undefined) return undefined
    if (!/^\d+$/.test(s)) throw new Error(`--${name} は数で（${s}）`)
    return Number(s)
  }
  if (cmd === 'me') return me()
  if (cmd === 'inbox') return showInbox()
  if (cmd === 'wait') return wait(p.slice(1), { every: int(v.every, 'every'), timeout: int(v.timeout, 'timeout') })
  if (cmd === 'post' && a && b) return post(a, b, { subject: v.subject, replyTo: v.reply, attach: v.attach })
  if (cmd === 'pull' && a && v.into) return pull(a, v.into, { includeMine: v['include-mine'] })
  if (cmd === 'doc') {
    if (a === 'list' && b) return docList(b)
    if (a === 'get' && b && c) return docGet(b, c, { out: v.out, version: int(v.version, 'version'), force: v.force })
    if (a === 'put' && b && c && d) return docPut(b, c, d, { note: v.note, base: int(v.base, 'base') })
  }
  if (cmd === 'admin' && a === 'key') {
    if (b === 'rotate' && c) return keyRotate(c, { envFile: v['write-env'], envName: v['env-name'], clipboard: v.clipboard })
    if (b === 'revoke' && c) return keyRevoke(c)
    if (b === 'list') return keyList()
  }
  if (cmd === 'admin' && a === 'web') {
    if (b === 'allow' && c) return webAllow(c)
    if (b === 'deny' && c) return webDeny(c)
    if (b === 'list') return webList()
    if (b === 'google' && c) return webGoogle(c)
    if (b === 'session-rotate') return webSessionRotate()
  }
  if (cmd === 'admin' && a === 'room') {
    const edit = {
      title: v.title,
      about: v.about,
      rulesFile: v['rules-file'],
      members: v.member,
      removeMembers: v['remove-member'],
      archived: v.archive ? true : v.unarchive ? false : undefined,
    }
    if (b === 'create' && c && v.title) return roomCreate(c, v.title, edit)
    if (b === 'edit' && c) return roomEdit(c, edit)
    if (b === 'doc' && c && d) return roomDoc(c, d, { title: v.title, editors: v.editor, remove: v.remove })
    if (b === 'show' && c) return roomShow(c)
    if (b === 'list') return roomList()
  }
  console.error(USAGE)
  process.exitCode = 2
}

main(process.argv.slice(2)).catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e)
  process.exitCode = 1
})
