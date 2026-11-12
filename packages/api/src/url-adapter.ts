/**
 * Lambda の Function URL（イベントの形 2.0）と Hono のアプリをつなぐ。
 *
 * hono の aws-lambda アダプタを使わない理由：応答の base64 を1バイトずつ文字列をつないで作るので、
 * 4MB の添付を返すのに 9 秒かかり、メモリも 256MB の上限すれすれまで上がった（2026-10-29 に実測）。
 * いまは添付の中身を関数に通さない（署名付き URL）ので応答は JSON だけだが、ここでは Node の Buffer で戻し・作りをする。
 *
 * JSON の応答は文字列のまま返し、それ以外はすべて base64 で返す。
 * text/plain などを文字列で返すと、UTF-8 でない中身（Shift_JIS のテキストなど）が途中で壊れるため。
 */
import type { APIGatewayProxyStructuredResultV2, LambdaFunctionURLEvent } from 'aws-lambda'

/** Function URL に返す形（@types/aws-lambda の LambdaFunctionURLResult は文字列も許す和の型なので、形の決まったほうを使う） */
export type UrlResult = APIGatewayProxyStructuredResultV2

type Fetch = (req: Request) => Response | Promise<Response>

export const isJson = (contentType: string) => /^application\/json\s*(;|$)/i.test(contentType)

export function toRequest(event: LambdaFunctionURLEvent): Request {
  const host = event.headers?.host ?? event.requestContext.domainName
  const query = event.rawQueryString ? `?${event.rawQueryString}` : ''
  const headers = new Headers()
  for (const [k, v] of Object.entries(event.headers ?? {})) if (v !== undefined) headers.set(k, v)
  if (event.cookies?.length) headers.set('cookie', event.cookies.join('; '))
  const method = event.requestContext.http.method
  const hasBody = event.body !== undefined && method !== 'GET' && method !== 'HEAD'
  return new Request(`https://${host}${event.rawPath}${query}`, {
    method,
    headers,
    body: hasBody ? (event.isBase64Encoded ? Buffer.from(event.body!, 'base64') : event.body) : undefined,
  })
}

export async function toResult(res: Response): Promise<UrlResult> {
  const headers: Record<string, string> = {}
  res.headers.forEach((v, k) => {
    if (k !== 'set-cookie') headers[k] = v
  })
  const bytes = Buffer.from(await res.arrayBuffer())
  const json = isJson(res.headers.get('content-type') ?? '')
  // Set-Cookie は headers では1つしか返せないので、cookies に並べる（読む画面のログイン。書き手の API は置かない）
  const cookies = res.headers.getSetCookie()
  return {
    statusCode: res.status,
    headers,
    ...(cookies.length && { cookies }),
    body: json ? bytes.toString('utf8') : bytes.toString('base64'),
    isBase64Encoded: !json,
  }
}

export function urlHandler(app: { fetch: Fetch }) {
  return async (event: LambdaFunctionURLEvent): Promise<UrlResult> => toResult(await app.fetch(toRequest(event)))
}
