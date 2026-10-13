import { useEffect, useRef, useState } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { buildIndex, matches, type TextIndex, type SearchHit } from './textIndex'
import { pageText } from './pageCache'

export default function ReaderSearch({ pdf, current, onHit }: { pdf: PDFDocumentProxy; current: number; onHit: (hit: SearchHit) => void }) {
  const [query, setQuery] = useState(''), [needle, setNeedle] = useState(''), [progress, setProgress] = useState(0), [textPages, setTextPages] = useState(0), [version, setVersion] = useState(0), [cancelled, setCancelled] = useState(false), [error, setError] = useState('')
  const indexes = useRef(new Map<number, TextIndex>()), cancel = useRef(false), generation = useRef(0)
  const [hits, setHits] = useState<SearchHit[]>([])
  useEffect(() => { const timer = setTimeout(() => setNeedle(query), 300); return () => clearTimeout(timer) }, [query])
  useEffect(() => {
    let active = true
    const run = ++generation.current
    cancel.current = false; setCancelled(false); setProgress(0); setTextPages(0); indexes.current.clear()
    async function scan() {
      const order = [current, ...Array.from({ length: pdf.numPages }, (_, i) => i + 1).filter(page => page !== current)]
      let next = 0, done = 0, searchable = 0
      async function worker() {
        while (next < order.length && active && !cancel.current && generation.current === run) {
          const number = order[next++]
          try {
            const content = await pageText(pdf, number)
            if (!active || generation.current !== run || cancel.current) return
            const index = buildIndex(content); indexes.current.set(number, index); if (index.text.trim()) searchable++
          } catch { if (active) setError('部分页面的文字无法读取，结果只包含可检索页面。') }
          if (!active || generation.current !== run) return
          setProgress(++done); setTextPages(searchable); setVersion(v => v + 1)
          await new Promise(resolve => setTimeout(resolve, 0))
        }
      }
      await Promise.all([worker(), worker()])
    }
    void scan()
    return () => { active = false; cancel.current = true; generation.current++; indexes.current.clear() }
  }, [pdf])
  useEffect(() => { setHits(Array.from(needle).length > 100 ? [] : [...indexes.current.entries()].sort(([a], [b]) => a - b).flatMap(([page, index]) => matches(index, needle, page)).slice(0, 500)) }, [needle, version])
  return <aside className="reader-search-panel" aria-label="文内搜索"><h3>搜索原文文字</h3><label><input aria-label="文内搜索关键词" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索中文或英文关键词" /></label>{Array.from(query).length > 100 && <p className="error-message">关键词最多 100 字符，请缩短后重试。</p>}<div className="reader-index-status" role="status">已扫描 {progress}／{pdf.numPages} 页 · {textPages} 页可检索{progress < pdf.numPages && !cancelled && <button className="text-button" onClick={() => { cancel.current = true; setCancelled(true) }}>停止扫描</button>}</div>{error && <p className="reader-text-notice">{error}</p>}{cancelled && <p className="reader-text-notice">扫描已停止，结果仅覆盖已扫描页面。重新打开搜索可以继续扫描。</p>}{progress === pdf.numPages && !textPages ? <p className="reader-empty">原文没有可检索文字，可以按页阅读并添加笔记。</p> : !needle.trim() ? <p className="reader-empty">输入关键词，点击结果定位到原文。扫描页无法进行文字搜索。</p> : !hits.length ? <p className="reader-empty">{progress < pdf.numPages ? '已扫描范围内暂未找到结果。' : '可检索文字中没有找到结果。'}</p> : <><p className="reader-result-count">{hits.length === 500 ? '仅展示前 500 项' : `${hits.length} 项匹配`}</p>{hits.map((hit, i) => <button key={`${hit.page}-${hit.start}-${i}`} className="reader-search-result" onClick={() => onHit(hit)}><strong>第 {hit.page} 页</strong><span>{hit.snippet}</span></button>)}</>}</aside>
}
