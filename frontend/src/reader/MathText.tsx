import { useMemo } from 'react'
import { renderToString } from 'katex'
import 'katex/dist/katex.min.css'

type Part = { raw: string; formula?: string; display?: boolean }
const delimiters = [
  { open: '$$', close: '$$', display: true },
  { open: '\\[', close: '\\]', display: true },
  { open: '\\(', close: '\\)', display: false },
  { open: '$', close: '$', display: false },
]

function escaped(text: string, index: number) {
  let backslashes = 0
  while (index > 0 && text[--index] === '\\') backslashes++
  return backslashes % 2 === 1
}

function closingIndex(text: string, start: number, close: string) {
  let braces = 0
  for (let index = start; index < text.length; index++) {
    if (escaped(text, index)) continue
    if (text[index] === '{') braces++
    else if (text[index] === '}') braces = Math.max(0, braces - 1)
    if (braces === 0 && text.startsWith(close, index)) return index
    // 单美元公式限制在一行，避免未闭合符号吞掉后面的段落。
    if (close === '$' && /[\r\n]/.test(text[index])) return -1
  }
  return -1
}

function splitMath(text: string): Part[] {
  const parts: Part[] = []
  let cursor = 0, plainStart = 0
  while (cursor < text.length) {
    const delimiter = !escaped(text, cursor) && delimiters.find(item => text.startsWith(item.open, cursor))
    if (!delimiter) { cursor++; continue }
    const start = cursor + delimiter.open.length
    const end = closingIndex(text, start, delimiter.close)
    const formula = end < 0 ? '' : text.slice(start, end)
    // 常见金额中的美元符号和空分隔符保留原文，不猜测缺失的公式边界。
    const currency = delimiter.open === '$' && (/^\s|\s$/.test(formula) || /\d/.test(text[end + 1] || '') || text[end + 1] === '$')
    if (!formula.trim() || currency) { cursor += delimiter.open.length; continue }
    if (plainStart < cursor) parts.push({ raw: text.slice(plainStart, cursor) })
    const opening = cursor
    cursor = end + delimiter.close.length
    parts.push({ raw: text.slice(opening, cursor), formula, display: delimiter.display })
    plainStart = cursor
  }
  if (plainStart < text.length) parts.push({ raw: text.slice(plainStart) })
  return parts
}

export default function MathText({ text }: { text: string }) {
  const content = useMemo(() => splitMath(text).map((part, index) => {
    if (part.formula === undefined) return part.raw
    try {
      // 仅插入 KaTeX 生成的标记；禁用外部资源与自定义 HTML，宏不在公式之间共享。
      const html = renderToString(part.formula, {
        displayMode: part.display, output: 'htmlAndMathml', throwOnError: true,
        trust: false, strict: 'error', maxExpand: 200, maxSize: 10,
      })
      const className = part.display ? 'reader-math-display' : 'reader-math-inline'
      return part.display
        ? <div className={className} key={index} dangerouslySetInnerHTML={{ __html: html }} />
        : <span className={className} key={index} dangerouslySetInnerHTML={{ __html: html }} />
    } catch {
      return <span className="reader-math-fallback" key={index} title="公式暂时无法显示，已保留原文">{part.raw}</span>
    }
  }), [text])
  return <div className="reader-translation-text">{content}</div>
}
