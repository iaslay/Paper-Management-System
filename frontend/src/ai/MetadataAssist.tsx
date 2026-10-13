import { useEffect, useRef, useState } from 'react'
import { Sparkles } from 'lucide-react'
import { api, readingApi, ApiError, type Kind } from '../api'
import './ai.css'

export interface MetadataSource { page_source_id: string; page_number: number }
export interface MetadataResult {
  fields: { title: { value: string | null; sources: MetadataSource[] }; authors: { value: string[]; sources: MetadataSource[] }; year: { value: number | null; sources: MetadataSource[] }; doi: { value: string | null; sources: MetadataSource[] } }
  classifications: { kind: Kind; tag_id: number | null; name: string; reason: string; sources: MetadataSource[] }[]
  warnings: string[]; analyzed_pages: number[]
}
interface MetadataTask { id: string; status: string; stage: string; progress: number; metadata: MetadataResult | null; error_message: string | null; reserved_tokens: number; charged_tokens: number; usage_unknown: boolean }
const activeStatuses = new Set(['queued', 'running', 'waiting_retry'])
const stages: Record<string,string> = { queued: '等待识别', preparing: '准备原文页面', metadata: '识别论文信息', repairing: '修正识别格式', waiting_retry: '等待重试', validating: '核对字段与来源', succeeded: '识别完成', failed: '识别未完成', cancelled: '已取消识别' }

export default function MetadataAssist({ paperId, active, enabled, readOnly, onStart, onFill, onSettings, onGo }: { paperId: string; active: boolean; enabled: boolean; readOnly: boolean; onStart: () => void; onFill: (result: MetadataResult) => void; onSettings: () => void; onGo: (page: number) => void }) {
  const [task, setTask] = useState<MetadataTask | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const mounted = useRef(true), requested = useRef<string | null>(null), pending = useRef<{ request_id: string; regenerate: boolean } | null>(null)
  const callbacks = useRef({ onStart, onFill }); callbacks.current = { onStart, onFill }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    if (!active || !enabled) return
    const abort = new AbortController()
    void api<MetadataTask[]>(`/papers/${paperId}/metadata-tasks`, { signal: abort.signal }).then(jobs => {
      if (abort.signal.aborted) return
      const latest = jobs.find(job=>job.id===requested.current) || jobs[0]
      if (requested.current && !latest) return
      if (latest?.status==='succeeded' && latest.metadata && latest.id===requested.current) { requested.current=null;callbacks.current.onFill(latest.metadata) }
      setTask(latest || null)
    }).catch(cause => { if (!abort.signal.aborted) setError(cause.message) })
    return () => abort.abort()
  }, [paperId, active, enabled])
  const running = !!task && activeStatuses.has(task.status)
  useEffect(() => {
    if (!running || !task || !active || !enabled) return
    const abort = new AbortController()
    const timer = window.setInterval(() => {
      void api<MetadataTask>(`/card-tasks/${task.id}`, { signal: abort.signal }).then(result => {
        if (abort.signal.aborted) return
        if (result.status === 'succeeded' && result.metadata && requested.current === result.id) { requested.current = null; callbacks.current.onFill(result.metadata) }
        setTask(result)
      }).catch(cause => { if (!abort.signal.aborted) setError(cause.message) })
    }, 1500)
    return () => { clearInterval(timer); abort.abort() }
  }, [task?.id, running, active, enabled])
  async function identify() {
    if (busy || readOnly || !enabled || running) return
    if (!pending.current) { callbacks.current.onStart(); pending.current = { request_id: crypto.randomUUID().replaceAll('-', ''), regenerate: !!task } }
    setBusy(true); setError('')
    try {
      const result = await readingApi<MetadataTask>(`/papers/${paperId}/metadata-tasks`, { method: 'POST', body: JSON.stringify(pending.current) })
      if (!mounted.current) return
      pending.current = null; requested.current = result.id
      if (result.status === 'succeeded' && result.metadata) { requested.current = null; callbacks.current.onFill(result.metadata) }
      setTask(result)
    } catch (cause) { if (mounted.current) setError((cause as Error).message); if (cause instanceof ApiError && cause.status < 500 && cause.status !== 401) pending.current = null }
    finally { if (mounted.current) setBusy(false) }
  }
  return <section className="metadata-assist" aria-label="AI 填写论文信息">
    <div className="ai-inline"><div><strong>让 AI 补全论文信息</strong><p className="muted small">识别前四页与末页中的标题、作者、年份、DOI 和分类。填入后可编辑，保存信息后生效。</p></div><button type="button" className="button compact secondary" disabled={busy || running || readOnly || !enabled} onClick={() => void identify()}><Sparkles size={14} />{busy ? '正在提交…' : running ? '正在识别…' : pending.current ? '重试识别请求' : task ? '重新识别并填写' : 'AI 识别并填写'}</button><button type="button" className="text-button" onClick={onSettings}>模型设置</button></div>
    {error && <p className="error-message" role="alert">{error}</p>}
    {task && <div className="metadata-progress"><div className="ai-inline"><span>{stages[task.stage] || '处理中'} · {task.progress}%</span>{running && <button type="button" className="text-button" disabled={busy || readOnly} onClick={() => void readingApi<MetadataTask>(`/card-tasks/${task.id}/cancel`, { method: 'POST' }).then(setTask).catch(cause => setError(cause.message))}>取消识别</button>}{task.status === 'succeeded' && task.metadata && <button type="button" className="text-button" disabled={busy || readOnly || !enabled} onClick={() => { callbacks.current.onStart(); callbacks.current.onFill(task.metadata!) }}>填入上次识别结果</button>}</div>{running && <progress value={task.progress} max={100} />}{task.error_message && <p className="error-message">{task.error_message}</p>}<small className="muted">预占 {task.reserved_tokens.toLocaleString()} token · 已记录／估算 {task.charged_tokens.toLocaleString()}{task.usage_unknown ? ' · 用量未确认' : ''}</small></div>}
    {task?.metadata && <details><summary>识别来源与提示</summary><p className="muted small">识别页序：{task.metadata.analyzed_pages.join('、')}；来源需要人工核对。未识别字段保持原值。</p>{Object.entries(task.metadata.fields).map(([name, field]) => <p className="small" key={name}>{({title:'标题',authors:'作者',year:'年份',doi:'DOI'} as Record<string,string>)[name]}：{field.value && (!Array.isArray(field.value) || field.value.length) ? field.sources.map(source => <button type="button" className="text-button" key={source.page_number} onClick={() => onGo(source.page_number)}>原文第 {source.page_number} 页 ↗</button>) : '未识别'}</p>)}{task.metadata.warnings.map((warning,index) => <p className="ai-notice" key={index}>{warning}</p>)}</details>}
  </section>
}
