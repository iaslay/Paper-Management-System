import { useEffect, useRef, useState } from 'react'
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist'

type OutlineItem = Awaited<ReturnType<PDFDocumentProxy['getOutline']>> extends (infer T)[] | null ? T : never

function Thumbnail({ pdf, number, current, go, cache }: { pdf: PDFDocumentProxy; number: number; current: number; go: (page: number) => void; cache: Map<number, string> }) {
  const element = useRef<HTMLButtonElement>(null)
  const [image, setImage] = useState(() => cache.get(number) || ''), [error, setError] = useState(false)
  useEffect(() => {
    let active = true, task: RenderTask | null = null, started = false, visible = false
    const observer = new IntersectionObserver(async ([entry]) => {
      if (!entry.isIntersecting) { visible = false; started = false; task?.cancel(); setImage(''); return }
      visible = true
      if (started) return
      started = true
      if (cache.has(number)) { setImage(cache.get(number)!); return }
      const canvas = document.createElement('canvas')
      try {
        const page = await pdf.getPage(number)
        if (!active || !visible) return
        const base = page.getViewport({ scale: 1 }), viewport = page.getViewport({ scale: 96 / base.width })
        canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height)
        task = page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport }); await task.promise
        if (!active || !visible) return
        const data = canvas.toDataURL('image/jpeg', .65)
        cache.set(number, data); while (cache.size > 30) cache.delete(cache.keys().next().value!)
        setImage(data)
      } catch (cause) { if (active && (cause as Error).name !== 'RenderingCancelledException') setError(true) }
      finally { canvas.width = 0; canvas.height = 0 }
    }, { root: element.current?.closest('.reader-navigation'), rootMargin: '100px' })
    if (element.current) observer.observe(element.current)
    return () => { active = false; observer.disconnect(); task?.cancel() }
  }, [pdf, number, cache])
  return <button ref={element} className={`reader-thumbnail ${current === number ? 'current' : ''}`} onClick={() => go(number)} aria-label={`缩略图：第 ${number} 页`}>{image ? <img src={image} alt={`第 ${number} 页缩略图`} loading="lazy" /> : <span>{error ? '预览暂不可用' : number}</span>}<small>第 {number} 页</small></button>
}

export default function ReaderNavigation({ pdf, current, go }: { pdf: PDFDocumentProxy; current: number; go: (page: number) => void }) {
  const [tab, setTab] = useState<'outline' | 'thumbs'>('outline'), [outline, setOutline] = useState<OutlineItem[]>([]), [loading, setLoading] = useState(true), [error, setError] = useState('')
  const cache = useRef(new Map<number, string>())
  useEffect(() => { let active = true; pdf.getOutline().then(items => { if (active) setOutline(items || []) }).catch(() => { if (active) setError('目录暂时无法读取，可以使用缩略图。') }).finally(() => { if (active) setLoading(false) }); return () => { active = false; cache.current.clear() } }, [pdf])
  async function destination(item: OutlineItem) {
    try {
      if (item.url) { const url = new URL(item.url); if (['http:', 'https:'].includes(url.protocol)) window.open(url.href, '_blank', 'noopener,noreferrer'); else setError('这个目录链接暂不支持打开。'); return }
      const dest = typeof item.dest === 'string' ? await pdf.getDestination(item.dest) : item.dest
      if (!dest) { setError('这个目录条目没有有效页码。'); return }
      const index = typeof dest[0] === 'number' ? dest[0] : await pdf.getPageIndex(dest[0])
      go(index + 1)
    } catch { setError('这个目录条目暂时无法定位，请使用页码跳转。') }
  }
  function tree(items: OutlineItem[], depth = 0): React.ReactNode { return items.map((item, index) => <div key={`${depth}-${index}`} className="reader-outline-item">{item.items?.length ? <details><summary><button type="button" onClick={() => void destination(item)}>{item.title || '未命名章节'}</button></summary><div className="reader-outline-nested">{tree(item.items as OutlineItem[], depth + 1)}</div></details> : <button type="button" onClick={() => void destination(item)}>{item.title || '未命名章节'}</button>}</div>) }
  return <aside className="reader-navigation" aria-label="原文导航"><div className="reader-panel-tabs"><button className={tab === 'outline' ? 'active' : ''} onClick={() => setTab('outline')}>目录</button><button className={tab === 'thumbs' ? 'active' : ''} onClick={() => setTab('thumbs')}>缩略图</button></div>{error && <p role="status" className="reader-text-notice">{error}</p>}{tab === 'outline' ? loading ? <p className="reader-empty">正在读取目录…</p> : outline.length ? tree(outline) : <p className="reader-empty">这份 PDF 没有内置目录，可以使用缩略图或页码跳转。</p> : <div className="reader-thumbnail-list">{Array.from({ length: pdf.numPages }, (_, i) => <Thumbnail key={i + 1} pdf={pdf} number={i + 1} current={current} go={go} cache={cache.current} />)}</div>}</aside>
}
