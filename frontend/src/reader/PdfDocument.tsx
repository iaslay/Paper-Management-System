import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import PdfPage from './PdfPage'
import { layoutPages, nearbyPages, pageAt, sourceSize, type PageLayout, type PageSize } from './continuousLayout'
import type { Annotation, PageSource, PositionValue, Rect, SelectionValue } from './types'
import type { SearchHit } from './textIndex'

export interface PageJump { page: number; nonce: number }
export default function PdfDocument({ pdf, value, sources, annotations, readOnly, onReady, onSelection, onPageChange, onVisiblePages, jump, searchHit, focusAnnotation, selectionActions }: {
  pdf: PDFDocumentProxy; value: PositionValue; sources: PageSource[]; annotations: Annotation[]; readOnly: boolean;
  onReady: (page: number, scale: number) => void; onSelection: (selection: SelectionValue | null) => void;
  onPageChange: (page: number) => void; onVisiblePages: (pages: number[]) => void; jump: PageJump | null;
  searchHit: SearchHit | null; focusAnnotation: string | null; selectionActions?: ReactNode;
}) {
  const scroll = useRef<HTMLDivElement>(null), initialized = useRef(false), previousLayout = useRef<PageLayout[]>([]), lastJump = useRef<PageJump | null>(null)
  const callbacks = useRef({ onReady, onSelection, onPageChange, onVisiblePages, current: value.page_number })
  callbacks.current = { onReady, onSelection, onPageChange, onVisiblePages, current: value.page_number }
  const padding = 16
  const [viewport, setViewport] = useState({ width: 0, height: 0, top: 0 })
  const [retainedPage, setRetainedPage] = useState<number | null>(null)
  const [sizes, setSizes] = useState<PageSize[] | null>(null)
  const [error, setError] = useState('')
  const readyPages = useRef(new Map<number, number>())
  useEffect(() => {
    let active = true
    initialized.current = false; previousLayout.current = []; lastJump.current = null; readyPages.current.clear(); setSizes(null); setError('')
    async function measure() {
      const known = new Map(sources.map(source => [source.page_number, sourceSize(source)])), result: PageSize[] = []
      for (let number = 1; number <= pdf.numPages; number++) {
        if (!active) return
        const size = known.get(number)
        if (size) result.push(size)
        else {
          const page = await pdf.getPage(number)
          const base = page.getViewport({ scale: 1, rotation: 0 })
          result.push({ width: base.width, height: base.height, rotation: page.rotate })
        }
      }
      if (active) setSizes(result)
    }
    void measure().catch(() => { if (active) setError('页面尺寸读取失败，请重新加载原文。') })
    return () => { active = false }
  }, [pdf, sources])
  useEffect(() => {
    const element = scroll.current
    if (!element) return
    const observer = new ResizeObserver(() => {
      // 切换到论文信息时阅读器暂时隐藏，保留原布局和滚动锚点。
      if (element.clientWidth > 0 && element.clientHeight > 0) setViewport(previous => ({ ...previous, width: element.clientWidth, height: element.clientHeight }))
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const layout = useMemo(() => sizes && viewport.width > 0 ? layoutPages(sizes, viewport.width - padding * 2, value) : [], [sizes, viewport.width, value.zoom_mode, value.zoom, value.view_rotation])
  const refresh = useCallback(() => {
    const element = scroll.current
    if (!element || !layout.length || !initialized.current) return
    const top = Math.max(0, element.scrollTop - padding), height = element.clientHeight
    setViewport(previous => previous.top === top && previous.height === height ? previous : { ...previous, top, height })
    // 以视野上部的阅读线判定当前页，跨页时同步工具栏及保存队列。
    // 最后一页短于视野时无法滚到页首，滚至文档底部仍应记为末页。
    const atEnd = element.scrollHeight > height && element.scrollTop >= element.scrollHeight - height - 2
    const current = atEnd ? layout[layout.length - 1] : pageAt(layout, top + Math.min(120, height * .25))
    if (callbacks.current.current !== current.page) { callbacks.current.current = current.page; callbacks.current.onPageChange(current.page) }
    if (readyPages.current.has(current.page)) callbacks.current.onReady(current.page, readyPages.current.get(current.page)!)
  }, [layout])
  useLayoutEffect(() => {
    const element = scroll.current
    if (!element || !layout.length) return
    const old = previousLayout.current
    if (!initialized.current) {
      const target = layout[(jump?.page || value.page_number) - 1] || layout[0]
      element.scrollTop = target.top + padding; initialized.current = true; lastJump.current = jump
    } else if (jump && jump !== lastJump.current) {
      element.scrollTop = layout[jump.page - 1].top + padding; lastJump.current = jump
    } else if (old !== layout && old.length) {
      // 缩放、旋转和侧栏改变宽度时保留当前阅读位置在页内的比例。
      // 使用上次滚动记录；新文档变短时浏览器会先截断 DOM 的 scrollTop。
      const oldTop = viewport.top, anchor = pageAt(old, oldTop), next = layout[anchor.page - 1]
      const fraction = Math.max(0, Math.min(1, (oldTop - anchor.top) / anchor.height))
      element.scrollTop = next.top + fraction * next.height + padding
    }
    previousLayout.current = layout; refresh()
  }, [layout, jump, refresh])
  const visible = useMemo(() => layout.length ? nearbyPages(layout, viewport.top, viewport.height) : [], [layout, viewport.top, viewport.height])
  const visibleKey = visible.join(',')
  useEffect(() => { if (visible.length) callbacks.current.onVisiblePages(visible) }, [visibleKey])
  const mounted = new Set(visible)
  if (retainedPage) mounted.add(retainedPage)
  const sourceMap = useMemo(() => new Map(sources.map(source => [source.page_number, source])), [sources])
  const locate = useCallback((page: number, rect: Rect) => {
    const element = scroll.current, item = layout[page - 1]
    if (!element || !item) return
    const left = (Math.max(element.clientWidth - padding * 2, ...layout.map(item => item.width)) - item.width) / 2
    element.scrollTo({ top: padding + item.top + Math.max(0, rect[1] - 80), left: Math.max(0, padding + left + rect[0] - 30), behavior: 'instant' })
    refresh()
  }, [layout, refresh])
  return <div className="reader-page-column">
    <div className="reader-page-scroll reader-continuous-scroll" ref={scroll} aria-label="论文连续阅读区域" onScroll={refresh} onPointerDownCapture={event => {
      const page = (event.target as HTMLElement).closest<HTMLElement>('[data-page-number]')
      // 保留拖选所在页，滚动跨越渲染窗口时原生选区不会被卸载。
      setRetainedPage(page ? Number(page.dataset.pageNumber) : null)
    }}>
      {error ? <p className="reader-load-error" role="alert">{error}</p> : !layout.length ? <div className="reader-loading" role="status">正在准备连续阅读…</div> : <div className="reader-page-list" style={{ width: Math.max(viewport.width - padding * 2, ...layout.map(item => item.width)) }}>
        {layout.map(item => <div className="reader-page-slot" data-page-number={item.page} key={item.page} style={{ height: item.height }}>
          {mounted.has(item.page) ? <PdfPage pdf={pdf} value={{ ...value, page_number: item.page }} scale={item.scale} source={sourceMap.get(item.page)} annotations={annotations} readOnly={readOnly} onReady={(page, scale) => {
            readyPages.current.set(page, scale)
            if (callbacks.current.current === page) callbacks.current.onReady(page, scale)
          }} onSelection={next => callbacks.current.onSelection(next)} searchHit={searchHit?.page === item.page ? searchHit : null} focusAnnotation={focusAnnotation} onLocate={locate} /> : <div className="reader-page-placeholder" style={{ width: item.width, height: item.height }} aria-label={`原文第 ${item.page} 页，滚动到此处加载`} />}
        </div>)}
      </div>}
    </div>
    {selectionActions}
  </div>
}
