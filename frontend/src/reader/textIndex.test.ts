import { describe, expect, it } from 'vitest'
import type { TextContent } from 'pdfjs-dist/types/src/display/api'
import { buildIndex, matches, normalizeWithOffsets } from './textIndex'

describe('可回跳的文字索引', () => {
  it('全半角、连字与代理对归一后仍指向原始字符', () => {
    const text = 'ＡＩ ﬁ 😀 中文', index = { text, items: [], ...normalizeWithOffsets(text) }
    expect(matches(index, 'ai', 1).map(hit => text.slice(hit.start, hit.end))).toEqual(['ＡＩ'])
    expect(matches(index, 'FI', 1).map(hit => text.slice(hit.start, hit.end))).toEqual(['ﬁ'])
    expect(matches(index, '😀', 1).map(hit => text.slice(hit.start, hit.end))).toEqual(['😀'])
  })
  it('折叠空白与组合字符时保留原偏移', () => {
    const text = 'e\u0301\n  test', index = { text, items: [], ...normalizeWithOffsets(text) }
    const hit = matches(index, 'É test', 2)[0]
    expect(text.slice(hit.start, hit.end)).toBe(text)
  })
  it('跨文本项关键词能匹配，显式换行保留', () => {
    const index = buildIndex({ items: [{ str: '检索', hasEOL: false }, { str: '增强', hasEOL: true }, { str: '生成', hasEOL: false }], styles: {} } as unknown as TextContent)
    expect(matches(index, '检索增强', 8)[0].page).toBe(8)
    expect(index.text).toBe('检索增强\n生成'); expect(index.items[2].start).toBe(5)
  })
  it('普通关键词不会被当成正则执行，结果总量受限', () => {
    const text = 'a.b aXb ' + '字'.repeat(1000), index = { text, items: [], ...normalizeWithOffsets(text) }
    expect(matches(index, 'a.b', 1)).toHaveLength(1); expect(matches(index, '字', 1)).toHaveLength(500)
  })
})
