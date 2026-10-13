import { useEffect, useRef } from 'react'
import { MoreHorizontal, FileText, Sparkles, Download, RefreshCw, MessageSquare } from 'lucide-react'
import type { Paper } from '../api'

export default function ReaderOptionsMenu({ paper, onInfo, onCard, onReload, onDiscussion }: { paper: Paper; onInfo: () => void; onCard: () => void; onReload: () => void; onDiscussion?: () => void }) {
  const menu = useRef<HTMLDetailsElement>(null)
  function choose(action: () => void) { if (menu.current) menu.current.open = false; action() }
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (menu.current?.open && !menu.current.contains(event.target as Node)) menu.current.open = false }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !menu.current?.open) return
      event.preventDefault(); event.stopPropagation(); menu.current.open = false; menu.current.querySelector('summary')?.focus()
    }
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape, true)
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape, true) }
  }, [])
  return <details className="reader-options-menu" ref={menu}>
    <summary className="icon-button" aria-label="更多阅读操作" title="更多阅读操作"><MoreHorizontal size={17} /></summary>
    <div className="reader-options-popover"><p title={paper.title}>{paper.title}<small>PDF · {paper.page_count} 页</small></p>
      <button type="button" onClick={() => choose(onInfo)}><FileText size={14} />论文信息</button>
      <button type="button" onClick={() => choose(onCard)}><Sparkles size={14} />简介卡片</button>
      {onDiscussion && <button type="button" onClick={() => choose(onDiscussion)}><MessageSquare size={14} />论文讨论</button>}
      <a href={`/api/v1/papers/${paper.id}/file?download=true`} onClick={() => { if (menu.current) menu.current.open = false }}><Download size={14} />下载原文</a>
      <button type="button" onClick={() => choose(onReload)}><RefreshCw size={14} />重新加载原文</button>
    </div>
  </details>
}
