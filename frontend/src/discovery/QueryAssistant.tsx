import { useEffect, useRef, useState } from 'react'
import { Sparkles, ArrowDownToLine, RefreshCw, Square } from 'lucide-react'
import { api, type ApiError } from '../api'
import { requestId, type Provider, providerNames } from './types'
import './query-assistant.css'

interface QueryResult {
  intent: string; keywords: { concept: string; terms: string[] }[];
  queries: { label: string; q: string; reason: string }[]; notes: string | null;
  year_filter: { year_from: number | null; year_to: number | null; evidence: string } | null;
}
interface AssistTask {
  id: string; request_id: string; provider: Provider; text: string; status: string; result: QueryResult | null;
  model: string; error: string; error_code: string; input_tokens: number | null; output_tokens: number | null;
  estimated_tokens: number; usage_unknown: boolean;
}
interface ModelStatus { enabled: boolean; model: string }
interface Submit { request_id: string; text: string; provider: Provider }
export interface AssistApplication { q: string; years?: QueryResult['year_filter'] }
const running = (task: AssistTask | null) => !!task && ['queued', 'running'].includes(task.status)

export default function QueryAssistant({ provider, active, onApply, onSettings }: {
  provider: Provider; active: boolean; onApply: (value: AssistApplication) => void; onSettings?: () => void;
}) {
  const [text, setText] = useState('')
  const [task, setTask] = useState<AssistTask | null>(null)
  const [resultTask, setResultTask] = useState<AssistTask | null>(null)
  const [status, setStatus] = useState<ModelStatus | null>(null)
  const [q, setQ] = useState('')
  const [choice, setChoice] = useState(0)
  const [withYears, setWithYears] = useState(false)
  const [sending, setSending] = useState(false)
  const [uncertain, setUncertain] = useState<Submit | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const submitting = useRef(false)
  const loaded = useRef(false)
  const draftTouched = useRef(false)
  const appliedResult = useRef('')
  const mounted = useRef(true)
  const postAbort = useRef<AbortController | null>(null)
  const generation = useRef(0)
  const resultRef = useRef<AssistTask | null>(null)

  function receive(item: AssistTask) {
    setTask(previous => previous?.id === item.id && !running(previous) && running(item) ? previous : item)
    if (item.status === 'succeeded' && item.result && appliedResult.current !== item.id) {
      appliedResult.current = item.id; resultRef.current = item; setResultTask(item); setChoice(0); setQ(item.result.queries[0].q); setWithYears(false)
    }
  }
  async function reload(signal?: AbortSignal) {
    const version = generation.current
    const [model, recent] = await Promise.all([api<ModelStatus>('/discovery/query-assists/status', { signal }), api<AssistTask[]>(`/discovery/query-assists?provider=${provider}`, { signal })])
    if (signal?.aborted || !mounted.current) return
    setStatus(model)
    if (version !== generation.current) return
    if (recent[0]) {
      receive(recent[0])
      if (!loaded.current && !draftTouched.current) setText(recent[0].text)
      const successful = recent.find(item => item.status === 'succeeded' && item.result)
      if (successful && !resultRef.current && recent[0].status !== 'succeeded') {
        appliedResult.current = successful.id; resultRef.current = successful; setResultTask(successful); setQ(successful.result!.queries[0].q)
      }
    }
    loaded.current = true
  }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; postAbort.current?.abort() } }, [])
  useEffect(() => {
    if (!active) return
    const abort = new AbortController()
    void reload(abort.signal).catch(cause => { if (!abort.signal.aborted) setError((cause as Error).message) })
    const changed = () => { void reload(abort.signal).catch(cause => { if (!abort.signal.aborted) setError((cause as Error).message) }) }
    window.addEventListener('paperboard-model-changed', changed)
    return () => { abort.abort(); window.removeEventListener('paperboard-model-changed', changed) }
  }, [active])
  useEffect(() => {
    if (!active || !task || !running(task)) return
    const abort = new AbortController()
    const timer = window.setInterval(() => {
      void api<AssistTask>(`/discovery/query-assists/${task.id}`, { signal: abort.signal }).then(item => {
        if (!abort.signal.aborted) receive(item)
      }).catch(cause => { if (!abort.signal.aborted) setError((cause as Error).message) })
    }, 1000)
    return () => { clearInterval(timer); abort.abort() }
  }, [active, task?.id, task?.status])

  async function submit(payload?: Submit) {
    if (submitting.current || running(task)) return
    const request = payload || { request_id: requestId(), text: text.trim(), provider }
    if (request.text.length < 2 || request.text.length > 2000) { setError('请用 2～2000 个字符描述想找的论文。'); return }
    submitting.current = true; setSending(true); setError(''); setNotice('')
    generation.current += 1
    const abort = new AbortController(); postAbort.current = abort
    const timeout = window.setTimeout(() => abort.abort(), 15000)
    try {
      const item = await api<AssistTask>('/discovery/query-assists', { method: 'POST', body: JSON.stringify(request), signal: abort.signal })
      if (!mounted.current) return
      setUncertain(null); receive(item)
    } catch (cause) {
      if (!mounted.current) return
      const problem = cause as ApiError
      if (!problem.status || problem.status >= 500) setUncertain(request)
      else setUncertain(null)
      setError(problem.name === 'AbortError' ? '提交响应超时，问题仍保留。可以安全重试同一提交。' : problem.message)
    } finally { clearTimeout(timeout); submitting.current = false; if (mounted.current) setSending(false) }
  }
  async function cancel() {
    if (!task || sending) return
    setSending(true); setError('')
    generation.current += 1
    try { receive(await api<AssistTask>(`/discovery/query-assists/${task.id}/cancel`, { method: 'POST' })) }
    catch (cause) { setError((cause as Error).message) }
    finally { setSending(false) }
  }
  const result = resultTask?.result
  const busy = sending || running(task)
  return <details className="query-assistant" open>
    <summary><Sparkles size={16} /><span>用自然语言描述，让 AI 帮你整理检索词</span><span className="query-assistant-model">{status?.model || '沿用论文模型'}</span></summary>
    <div className="query-assistant-body">
      <label className="query-question-label" htmlFor={`query-question-${provider}`}>你想找哪一类论文？</label>
      <textarea id={`query-question-${provider}`} aria-label={`${providerNames[provider]} 研究问题`} maxLength={2000} value={text}
        onChange={event => { draftTouched.current = true; setText(event.target.value) }}
        placeholder="例如：想找近三年关于多轮对话长期记忆更新的论文，重点关注如何处理过时信息。" />
      <div className="query-assistant-privacy"><span>仅发送这段问题，不附带论文或笔记。输入与生成结果保存在本机。</span><span>{text.length} / 2000</span></div>
      <div className="query-assistant-actions">
        <button className="button primary compact" disabled={busy || !!uncertain || !status?.enabled || text.trim().length < 2} onClick={() => void submit()}><Sparkles size={14} />{task?.status === 'queued' ? '等待生成…' : task?.status === 'running' ? '正在整理检索词…' : result ? '重新生成检索建议' : '生成检索建议'}</button>
        {running(task) && <button className="button secondary compact" disabled={sending} onClick={() => void cancel()}><Square size={12} />停止生成</button>}
        <button className="text-button" disabled={sending} onClick={() => { setError(''); void reload().catch(cause => setError((cause as Error).message)) }}><RefreshCw size={12} />重新加载</button>
        {onSettings && <button className="text-button" onClick={onSettings}>模型设置</button>}
      </div>
      {status && !status.enabled && <p className="query-hint">先在模型设置中启用已有 DeepSeek 或其他论文模型，手动检索仍可使用。</p>}
      {error && <p className="error-message" role="alert">{error}</p>}
      {uncertain && <div className="query-hint">尚未确认这次提交是否成功：{uncertain.text}<button className="text-button" disabled={busy} onClick={() => void submit(uncertain)}>安全重试提交</button></div>}
      {task?.status === 'failed' && <p className="error-message" role="alert">{task.error} {result && '下方保留上次成功结果。'}</p>}
      {task?.status === 'cancelled' && <p className="query-hint" role="status">生成已停止。问题保留，已发送请求的远端用量可能仍需确认。</p>}
      {result && <section className="query-result" aria-label="AI 检索建议">
        <div className="query-result-heading"><strong>{result.intent}</strong><span>AI 建议 · {resultTask.model}</span></div>
        <p className="query-result-question">依据的问题：{resultTask.text}</p>
        <div className="query-keywords">{result.keywords.map((group, index) => <div key={index}><span>{group.concept}</span><div>{group.terms.map(term => <span className="query-term" key={term}>{term}</span>)}</div></div>)}</div>
        <div className="query-choices" role="group" aria-label="备选检索表达">{result.queries.map((item, index) => <button key={index} className={choice === index ? 'selected' : ''} aria-pressed={choice === index} onClick={() => { setChoice(index); setQ(item.q); setNotice('') }}>{item.label}</button>)}</div>
        <p className="query-hint">{result.queries[choice]?.reason}</p>
        <label className="query-question-label" htmlFor={`query-edit-${provider}`}>可编辑的检索关键词</label>
        <input id={`query-edit-${provider}`} aria-label={`${providerNames[provider]} 建议关键词`} value={q} maxLength={500} onChange={event => { setQ(event.target.value); setNotice('') }} />
        {result.year_filter && <label className="query-apply-years"><input type="checkbox" checked={withYears} onChange={event => setWithYears(event.target.checked)} />同时应用年份建议：{result.year_filter.year_from || '不限'}～{result.year_filter.year_to || '不限'}<span>来自“{result.year_filter.evidence}”</span></label>}
        {result.notes && <p className="query-hint">{result.notes}</p>}
        <div className="query-assistant-actions"><button className="button secondary compact" disabled={!q.trim()} onClick={() => { onApply({ q: q.trim(), years: withYears ? result.year_filter : undefined }); setNotice('已填入检索框，请核对检索字段和筛选条件，再点击“检索论文”。') }}><ArrowDownToLine size={14} />填入检索框</button><span className="query-hint">{resultTask.input_tokens !== null && resultTask.output_tokens !== null ? `本次用量：输入 ${resultTask.input_tokens} / 输出 ${resultTask.output_tokens}` : '本次用量未确认，按估算计入预算'}{!withYears && ' · 保留现有筛选'}</span></div>
        {notice && <p className="success-message" role="status">{notice}</p>}
      </section>}
    </div>
  </details>
}
