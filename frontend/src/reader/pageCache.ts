import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { TextContent } from 'pdfjs-dist/types/src/display/api'

const caches = new WeakMap<PDFDocumentProxy, Map<number, Promise<TextContent>>>()
export function pageText(pdf: PDFDocumentProxy, page: number) {
  let cache = caches.get(pdf)
  if (!cache) { cache = new Map(); caches.set(pdf, cache) }
  const existing = cache.get(page)
  if (existing) { cache.delete(page); cache.set(page, existing); return existing }
  const store = cache
  const promise = pdf.getPage(page).then(item => item.getTextContent()).catch(cause => { if (store.get(page) === promise) store.delete(page); throw cause })
  cache.set(page, promise)
  while (cache.size > 10) cache.delete(cache.keys().next().value!)
  return promise
}
export function clearPageCache(pdf: PDFDocumentProxy) { caches.delete(pdf) }
