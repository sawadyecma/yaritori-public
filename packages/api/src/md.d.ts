/** docs/*.md を文字として読む（束ねるのは esbuild の text loader。infra の NodejsFunction で指定） */
declare module '*.md' {
  const text: string
  export default text
}
