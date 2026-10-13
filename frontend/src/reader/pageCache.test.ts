import { describe, expect, it, vi } from 'vitest'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { pageText, clearPageCache } from './pageCache'

describe('页面文字缓存', () => {
  it('相同页并发读取共享请求，容量限制为十页，关闭后清理', async () => {
    const getPage = vi.fn(async () => ({ getTextContent: async () => ({ items: [], styles: {} }) }))
    const pdf = { getPage } as unknown as PDFDocumentProxy
    const first = pageText(pdf, 1); expect(pageText(pdf, 1)).toBe(first); await first
    for (let page = 2; page <= 11; page++) await pageText(pdf, page)
    expect(getPage).toHaveBeenCalledTimes(11)
    await pageText(pdf, 1); expect(getPage).toHaveBeenCalledTimes(12)
    clearPageCache(pdf); await pageText(pdf, 1); expect(getPage).toHaveBeenCalledTimes(13)
  })
  it('失败的页不会永久缓存，可重新读取', async () => {
    const getPage = vi.fn().mockRejectedValueOnce(new Error('读取失败')).mockResolvedValue({ getTextContent: async () => ({ items: [], styles: {} }) })
    const pdf = { getPage } as unknown as PDFDocumentProxy
    await expect(pageText(pdf, 1)).rejects.toThrow('读取失败'); await pageText(pdf, 1)
    expect(getPage).toHaveBeenCalledTimes(2)
  })
})
