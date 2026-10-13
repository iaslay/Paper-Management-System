import { useEffect, useRef, useState } from 'react'
import { Check, FileText, Star, Trash2, ArrowUpRight, RotateCcw, ArrowRight, Sparkles, CheckCircle2, RefreshCw } from 'lucide-react'
import { api, readingApi, ApiError, dateText, statusNames, type Paper, type ReadingStatus } from './api'
import type { CardTask } from './ai/types'
import './PaperLibraryCard.css'

const activeStatuses = new Set(['queued', 'running', 'waiting_retry'])
interface Props {
  paper: Paper; checked: boolean; pending: boolean; enabled: boolean;
  onSelect: () => void; onOpen: () => void; onInfo: () => void; onCard: () => void;
  onFavorite: () => void; onStatus: (status: ReadingStatus) => void; onDirection: (id: number) => void;
  onDelete: () => void; onRestore: () => void; onRefresh: () => void; onSettings: () => void;
  trash: boolean; compact?: boolean;
}

export default function PaperLibraryCard({ paper, checked, pending, enabled, onSelect, onOpen, onInfo, onCard, onFavorite, onStatus, onDirection, onDelete, onRestore, onRefresh, onSettings, trash, compact = false }: Props) {
  const [task, setTask] = useState<CardTask | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const mounted = useRef(true), request = useRef<{request_id: string; regenerate: boolean} | null>(null)
  const requestedTask = useRef<string | null>(null)
  const refresh = useRef(onRefresh); refresh.current = onRefresh
  const running = !!task && activeStatuses.has(task.status)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    if (!enabled || trash || !paper.card_summary) return
    const abort = new AbortController()
    void api<CardTask[]>(`/papers/${paper.id}/preview-tasks`, {signal: abort.signal}).then(jobs => {
      if (abort.signal.aborted) return
      const latest = requestedTask.current ? jobs.find(job => job.id === requestedTask.current) : jobs[0]
      if (requestedTask.current && !latest) return
      setTask(latest || null)
    }).catch(() => {})
    return () => abort.abort()
  }, [paper.id, enabled, trash, paper.card_summary, paper.card_preview])
  useEffect(() => {
    if (!running || !task || !enabled || trash) return
    const abort = new AbortController()
    const timer = window.setInterval(() => {
      void api<CardTask>(`/card-tasks/${task.id}`, {signal: abort.signal}).then(result => {
        if (abort.signal.aborted) return
        setTask(result)
        if (result.status === 'succeeded') refresh.current()
      }).catch(cause => { if (!abort.signal.aborted) setError(cause.message) })
    }, 1500)
    return () => { clearInterval(timer); abort.abort() }
  }, [task?.id, running, enabled, trash])
  async function generate() {
    if (busy || running || !enabled || trash || pending) return
    request.current ||= {request_id: crypto.randomUUID().replaceAll('-', ''), regenerate: !!task || !!paper.card_preview}
    setBusy(true); setError('')
    try {
      const result = await readingApi<CardTask>(`/papers/${paper.id}/preview-tasks`, {method: 'POST', body: JSON.stringify(request.current)})
      if (!mounted.current) return
      request.current = null; requestedTask.current = result.id; setTask(result)
      if (result.status === 'succeeded') refresh.current()
    } catch (cause) {
      if (mounted.current) setError((cause as Error).message)
      if (cause instanceof ApiError && cause.status < 500 && cause.status !== 401) request.current = null
    } finally { if (mounted.current) setBusy(false) }
  }
  const preview = paper.card_preview
  const brief = preview || paper.card_brief
  const authors = paper.authors.slice(0, 2).join('、') + (paper.authors.length > 2 ? ` 等 ${paper.authors.length} 人` : '')
  return <article className={`paper-card library-paper-card ${checked ? 'checked' : ''} ${compact ? 'compact-card' : ''}`} draggable={!trash && !pending} onDragStart={event => event.dataTransfer.setData('paper-id', paper.id)}>
    <div className="card-top"><label className="paper-check"><input type="checkbox" checked={checked} onChange={onSelect} aria-label={`选择 ${paper.title}`} disabled={trash || pending} /><span><Check size={12} /></span></label><span className="paper-format"><FileText size={13} /> PDF<span>·</span>{paper.page_count} 页</span><button className={`icon-button favorite-button ${paper.is_favorite ? 'favorited' : ''}`} aria-label={`${paper.is_favorite ? '取消收藏' : '收藏'} ${paper.title}`} onClick={onFavorite} disabled={pending || trash}><Star size={17} fill={paper.is_favorite ? 'currentColor' : 'none'} /></button></div>
    <div className="card-copy">
      <button className={`paper-title ${preview ? 'has-preview' : ''}`} onClick={onInfo} title={paper.title}><h3>{preview?.headline || paper.title}</h3></button>
      {preview && <p className="paper-original-title" title={paper.title}>{paper.title}</p>}
      <p className="paper-authors" title={paper.authors.join('、')}><span className="paper-author-names">{authors || '作者待补充'}</span><span className="paper-year">{paper.year || '年份待补充'}</span></p>
      <div className="card-directions">{paper.research_directions.slice(0, 3).map(tag => <button key={tag.id} className="direction-chip" onClick={() => onDirection(tag.id)} disabled={trash}>{tag.name}</button>)}{paper.research_directions.length > 3 && <button className="direction-chip more" onClick={onInfo}>＋{paper.research_directions.length - 3}</button>}{!paper.research_directions.length && <button className="unclassified-chip" onClick={onInfo}>＋ 添加研究方向</button>}</div>
    </div>
    {paper.card_summary ? <section className="paper-insight" aria-label="论文速览">
      <div className="paper-insight-heading"><span>论文速览</span><span className={`paper-card-badge ${paper.card_status === 'confirmed' ? 'confirmed' : ''}`} title="此状态表示原阅读卡片的确认状态；AI 速览是简明重述。">{paper.card_status === 'confirmed' && <CheckCircle2 size={11} />}{paper.card_status === 'confirmed' ? '已确认卡片' : '待核对草稿'}</span></div>
      {brief ? <dl className="paper-insight-rows">{([['problem', '研究问题'], ['approach', '核心做法'], ['benefit', '主要价值']] as const).map(([key, label]) => <div key={key}><dt>{label}</dt><dd title={brief[key]}>{brief[key]}</dd></div>)}</dl> : <p className="paper-insight-summary" title={paper.card_summary}>{paper.card_summary}</p>}
      <div className="paper-insight-actions"><button className="paper-insight-link" onClick={onCard}>查看阅读卡片<ArrowRight size={13} /></button>{preview && <button className="paper-insight-note preview-refresh" aria-label="重新整理简明速览" title="AI 根据阅读卡片整理。点击重新整理会调用云端模型；事实与来源请查看完整卡片。" disabled={busy || running || pending || !enabled || trash} onClick={() => void generate()}><RefreshCw size={10} />{busy || running ? '正在整理…' : 'AI 整理'}</button>}</div>
      {!preview && !trash && <div className="preview-assist"><button className="preview-generate" title="使用云端 AI 简化已有卡片；不发送个人记录，也不改写原卡片。" disabled={busy || running || pending || !enabled} onClick={() => void generate()}><Sparkles size={12} />{busy ? '正在提交…' : running ? '正在整理速览…' : request.current ? '重试速览请求' : task?.status === 'failed' || task?.status === 'cancelled' ? '重新整理速览' : '生成简明速览'}</button>{running && <button className="text-button" disabled={busy || pending} onClick={() => void readingApi<CardTask>(`/card-tasks/${task!.id}/cancel`, {method: 'POST'}).then(setTask).catch(cause => setError(cause.message))}>取消</button>}</div>}
      {preview && running && !trash && <div className="preview-assist"><button className="text-button" disabled={busy || pending || !enabled} onClick={() => void readingApi<CardTask>(`/card-tasks/${task!.id}/cancel`, {method: 'POST'}).then(setTask).catch(cause => setError(cause.message))}>取消整理</button></div>}
      {(error || task?.error_message) && <div className="preview-error" role="alert">{error || task?.error_message}<button className="text-button" onClick={onSettings}>模型设置</button></div>}
    </section> : <section className="paper-insight paper-insight-empty"><span>留下这篇论文的阅读线索</span><p>整理研究问题、方法和结果，下次快速找回思路。</p><button className="paper-insight-link" onClick={onCard}>生成或填写阅读卡片<ArrowRight size={13} /></button></section>}
    {!compact && !!(paper.topics.length || paper.tags.length) && <div className="paper-secondary-labels" title={[...paper.topics, ...paper.tags].map(tag => tag.name).join(' · ')}>{[...paper.topics.slice(0, 1), ...paper.tags.slice(0, 2)].map(tag => <span key={tag.id}>{tag.name}</span>)}</div>}
    <div className="card-bottom">{trash ? <span className="muted small">{dateText(paper.deleted_at!)} 移入回收站</span> : <select className={`status-select ${paper.reading_status}`} aria-label={`设置 ${paper.title} 的阅读状态`} value={paper.reading_status} disabled={pending} onChange={event => onStatus(event.target.value as ReadingStatus)}>{Object.entries(statusNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>}<span className="card-date">{dateText(paper.created_at)} 加入</span><button className="icon-button delete-button" aria-label={`${trash ? '彻底删除' : '移入回收站'} ${paper.title}`} disabled={pending} onClick={onDelete}><Trash2 size={14} /></button></div>
    <button className="card-open" disabled={pending} onClick={trash ? onRestore : onOpen}>{trash ? <><RotateCcw size={14} />恢复论文</> : <><span>{paper.last_read_page ? `继续阅读 · 第 ${paper.last_read_page} 页` : '打开论文'}</span><ArrowUpRight size={15} /></>}</button>
  </article>
}
