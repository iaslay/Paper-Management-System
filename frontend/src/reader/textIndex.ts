import type { TextContent } from 'pdfjs-dist/types/src/display/api'

export interface TextIndex { text: string; normalized: string; offsets: number[]; ends: number[]; items: { text: string; start: number; end: number }[] }
export interface SearchHit { page: number; start: number; end: number; snippet: string }

export function normalizeWithOffsets(text: string) {
  let normalized = '', original = 0
  const offsets: number[] = [], ends: number[] = []
  // 连字、代理对和组合字符逐簇映射回原始 UTF-16 偏移。
  const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)
  for (const segment of segments) {
    original = segment.index
    const value = segment.segment.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ')
    for (const character of value) {
      if (character === ' ' && normalized.endsWith(' ')) { ends[ends.length - 1] = original + segment.segment.length; continue }
      normalized += character
      for (let i = 0; i < character.length; i++) { offsets.push(original); ends.push(original + segment.segment.length) }
    }
  }
  return { normalized, offsets, ends }
}
export function buildIndex(content: TextContent): TextIndex {
  let text = ''
  const items: TextIndex['items'] = []
  for (const item of content.items) {
    if (!('str' in item)) continue
    const start = text.length
    text += item.str
    items.push({ text: item.str, start, end: text.length })
    if (item.hasEOL) text += '\n'
  }
  return { text, items, ...normalizeWithOffsets(text) }
}
export function matches(index: TextIndex, query: string, page: number): SearchHit[] {
  const needle = normalizeWithOffsets(query).normalized.trim()
  if (!needle) return []
  const hits: SearchHit[] = []
  let from = 0
  while (hits.length < 500) {
    const found = index.normalized.indexOf(needle, from)
    if (found < 0) break
    const start = index.offsets[found], end = index.ends[found + needle.length - 1]
    hits.push({ page, start, end, snippet: index.text.slice(Math.max(0, start - 35), Math.min(index.text.length, end + 55)).replace(/\s+/g, ' ') })
    from = found + needle.length
  }
  return hits
}
