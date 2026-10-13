import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { TextLayer, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist'
import type { PageViewport } from 'pdfjs-dist/types/src/display/page_viewport'
import type { Annotation, PageSource, PositionValue, Rect, SelectionValue } from './types'
import { selectionRects, textSelectionRange, toViewRect } from './geometry'
import { buildIndex, type SearchHit, type TextIndex } from './textIndex'
import { pageText } from './pageCache'
import { useTextSelection } from './useTextSelection'

export default function PdfPage({ pdf, value, source, annotations, readOnly, onReady, onSelection, searchHit, focusAnnotation, selectionActions }: {
  pdf: PDFDocumentProxy; value: PositionValue; source?: PageSource; annotations: Annotation[]; readOnly: boolean;
  onReady: (page: number, scale: number) => void; onSelection: (value: SelectionValue | null) => void; searchHit: SearchHit | null; focusAnnotation: string | null;
  selectionActions?: ReactNode;
}) {
  const scroll = useRef<HTMLDivElement>(null), sheet = useRef<HTMLDivElement>(null), canvas = useRef<HTMLCanvasElement>(null), text = useRef<HTMLDivElement>(null)
  const task = useRef<RenderTask | null>(null), textTask = useRef<TextLayer | null>(null)
  const callbacks = useRef({ onReady, onSelection }); callbacks.current = { onReady, onSelection }
  const [width, setWidth] = useState(600), [loading, setLoading] = useState(true), [error, setError] = useState(''), [textNotice, setTextNotice] = useState('')
  const [rendered, setRendered] = useState<{ viewport: PageViewport; page: number; index: TextIndex; layer: TextLayer; sourceValid: boolean } | null>(null)
  const [dimensions, setDimensions] = useState({ width: 1, height: 1, scale: 1 })
  const [searchRects, setSearchRects] = useState<Rect[]>([])
  useEffect(() => {
    if (!scroll.current) return
    const observer = new ResizeObserver(([entry]) => { if (entry.contentRect.width > 0) setWidth(entry.contentRect.width) })
    observer.observe(scroll.current); return () => observer.disconnect()
  }, [])
  useEffect(() => {
    let active = true
    const previous = task.current
    previous?.cancel(); textTask.current?.cancel()
    setLoading(true); setError(''); setTextNotice(''); setRendered(null); setSearchRects([]); callbacks.current.onSelection(null)
    async function draw() {
      try {
        await previous?.promise.catch(() => {})
        const page = await pdf.getPage(value.page_number)
        if (!active || !canvas.current || !text.current || !sheet.current) return
        const rotation = (page.rotate + value.view_rotation) % 360
        const base = page.getViewport({ scale: 1, rotation })
        const scale = value.zoom_mode === 'custom' ? value.zoom! : Math.max(.1, (width - 32) / base.width)
        const viewport = page.getViewport({ scale, rotation }), ratio = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(16000000 / (viewport.width * viewport.height)), 16384 / Math.max(viewport.width, viewport.height))
        setDimensions({ width: viewport.width, height: viewport.height, scale: scale * page.userUnit })
        sheet.current.style.width = `${viewport.width}px`; sheet.current.style.height = `${viewport.height}px`
        sheet.current.style.setProperty('--total-scale-factor', String(scale * page.userUnit))
        canvas.current.width = Math.floor(viewport.width * ratio); canvas.current.height = Math.floor(viewport.height * ratio)
        canvas.current.style.width = `${viewport.width}px`; canvas.current.style.height = `${viewport.height}px`
        const drawing = page.render({ canvas: canvas.current, canvasContext: canvas.current.getContext('2d')!, viewport, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] })
        task.current = drawing
        await drawing.promise
        if (!active) return
        callbacks.current.onReady(value.page_number, scale)
        let index: TextIndex, layer: TextLayer
        try {
          const content = await pageText(pdf, value.page_number)
          if (!active || !text.current) return
          index = buildIndex(content)
          text.current.replaceChildren()
          layer = new TextLayer({ textContentSource: content, container: text.current, viewport }); textTask.current = layer
          await layer.render()
          if (!active) return
          // 补齐 PDF.js 阅读器的页尾选区承接层，拖到文字行间空白时仍留在文字层内。
          const end = document.createElement('div'); end.className = 'endOfContent'; text.current.append(end)
        } catch {
          if (active) { setTextNotice('这一页的文字暂时无法提取，可以添加本页笔记。'); setLoading(false) }
          return
        }
        const sourceValid = !!source && source.page_number === value.page_number && source.view_box.every((v, i) => Math.abs(v - page.view[i]) <= .5) && source.intrinsic_rotation === page.rotate && Math.abs(source.user_unit - page.userUnit) < .0001
        if (!index.text.trim()) setTextNotice('这一页没有可选文字，可以添加本页笔记。')
        else if (!sourceValid && !readOnly) setTextNotice('页面坐标尚未准备好，暂时无法保存文字高亮。可以重试准备或添加页码笔记。')
        setRendered({ viewport, page: value.page_number, index, layer, sourceValid }); setLoading(false)
      } catch (cause) {
        if (active && (cause as Error).name !== 'RenderingCancelledException') { setError('这一页暂时无法显示，请重新加载或下载原文。'); setLoading(false) }
      }
    }
    void draw()
    return () => { active = false; task.current?.cancel(); textTask.current?.cancel() }
  }, [pdf, value.page_number, value.zoom_mode, value.zoom, value.view_rotation, width, source, readOnly])
  useEffect(() => { for (const page of [value.page_number - 1, value.page_number + 1]) { if (page >= 1 && page <= pdf.numPages) void pageText(pdf, page).catch(() => {}) } }, [pdf, value.page_number])

  useEffect(() => {
    setSearchRects([])
    if (!rendered || !sheet.current || !searchHit || searchHit.page !== rendered.page) return
    try {
      const ranges: Range[] = []
      rendered.index.items.forEach((item, i) => {
        if (item.end <= searchHit.start || item.start >= searchHit.end) return
        const node = rendered.layer.textDivs[i]?.firstChild
        if (!node) return
        const range = document.createRange()
        range.setStart(node, Math.max(0, searchHit.start - item.start)); range.setEnd(node, Math.min(item.text.length, searchHit.end - item.start)); ranges.push(range)
      })
      const origin = sheet.current.getBoundingClientRect()
      const rects = ranges.flatMap(range => Array.from(range.getClientRects()).filter(r => r.width > 0).map(r => [r.left - origin.left, r.top - origin.top, r.right - origin.left, r.bottom - origin.top] as Rect))
      setSearchRects(rects)
      if (rects[0]) scroll.current?.scrollTo({ top: Math.max(0, rects[0][1] - 80), left: Math.max(0, rects[0][0] - 20), behavior: 'smooth' })
    } catch { setTextNotice('搜索已定位到对应页，文字位置请手动核对。') }
  }, [rendered, searchHit])
  useEffect(() => {
    if (!focusAnnotation || !rendered) return
    const annotation = annotations.find(item => item.id === focusAnnotation)
    if (annotation?.rects[0]) { const rect = toViewRect(rendered.viewport, annotation.rects[0]); scroll.current?.scrollTo({ top: Math.max(0, rect[1] - 70), left: Math.max(0, rect[0] - 30), behavior: 'smooth' }) }
  }, [focusAnnotation, rendered, annotations])

  function select() {
    const selection = window.getSelection()
    if (!selection?.rangeCount || !rendered?.sourceValid || !source || readOnly || !sheet.current || !text.current || loading) return
    const range = textSelectionRange(selection, text.current)
    if (!range) { if (text.current.contains(selection.anchorNode) || text.current.contains(selection.focusNode)) callbacks.current.onSelection(null); return }
    const quote = (text.current.contains(selection.anchorNode) && text.current.contains(selection.focusNode) ? selection.toString() : range.toString()).trim()
    if (!quote) return
    if (Array.from(quote).length > 2000) { setTextNotice('选中的文字过长，请缩短选区后再高亮。'); return }
    try { callbacks.current.onSelection({ quote, rects: selectionRects(range, sheet.current, rendered.viewport, source.view_box), page_number: value.page_number, page_source_id: source.id }) }
    catch (cause) { setTextNotice((cause as Error).message) }
  }
  useTextSelection(text, select, () => callbacks.current.onSelection(null))
  function overlay(rect: Rect, key: string, className: string) { return <span key={key} className={className} style={{ left: rect[0], top: rect[1], width: rect[2] - rect[0], height: rect[3] - rect[1] }} /> }
  return <div className="reader-page-column">
    {textNotice && <p className="reader-text-notice" role="status">{textNotice}</p>}
    <div className="reader-page-scroll" ref={scroll}>
      {loading && <div className="reader-loading" role="status">正在显示第 {value.page_number} 页…</div>}
      {error && <p className="reader-load-error" role="alert">{error}</p>}
      <div className="reader-sheet" ref={sheet} style={{ width: dimensions.width, height: dimensions.height, visibility: error || loading ? 'hidden' : 'visible', '--total-scale-factor': dimensions.scale } as CSSProperties}>
        <canvas ref={canvas} aria-label={`原文第 ${value.page_number} 页`} />
        <div className="reader-overlays">{rendered && annotations.filter(item => item.page_number === rendered.page && item.file_hash === source?.file_hash && rendered.sourceValid).flatMap(item => item.rects.map((rect, i) => overlay(toViewRect(rendered.viewport, rect), `${item.id}-${i}`, `reader-highlight ${item.color} ${focusAnnotation === item.id ? 'emphasis' : ''}`)))}{searchRects.map((rect, i) => overlay(rect, `search-${i}`, 'reader-search-mark'))}</div>
        <div className="textLayer" ref={text} />
      </div>
    </div>
    {selectionActions}
  </div>
}
