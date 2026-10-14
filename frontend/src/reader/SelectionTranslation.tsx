import { useEffect, useRef, useState } from 'react'
import { Languages, Copy, X } from 'lucide-react'
import { api, type Paper } from '../api'
import type { SelectionValue } from './types'

interface TranslationConfig { enabled: boolean; model: string; base_url: string; max_characters: number; timeout_seconds: number }
interface TranslationResult { translation: string; model: string; cached: boolean }
export default function SelectionTranslation({ paper, selection, request = 0 }: { paper: Pick<Paper, 'id' | 'file_hash'>; selection: SelectionValue | null; request?: number }) {
  const [config, setConfig] = useState<TranslationConfig | null>(null), [configError, setConfigError] = useState(''), [configTick, setConfigTick] = useState(0)
  const [status, setStatus] = useState<'idle' | 'loading' | 'done' | 'failed' | 'cancelled'>('idle'), [result, setResult] = useState<TranslationResult | null>(null), [error, setError] = useState('')
  const [copied, setCopied] = useState(false), [copyFallback, setCopyFallback] = useState(false)
  const current = useRef<{ controller: AbortController; timeout: ReturnType<typeof setTimeout> } | null>(null)
  const lastRequest = useRef(0)
  useEffect(() => {
    const controller = new AbortController()
    setConfigError('')
    api<TranslationConfig>('/settings/translation', { signal: controller.signal }).then(setConfig).catch(cause => { if (!controller.signal.aborted) setConfigError((cause as Error).message) })
    return () => controller.abort()
  }, [configTick])
  function stop() {
    if (current.current) { clearTimeout(current.current.timeout); current.current.controller.abort(); current.current = null }
  }
  useEffect(() => {
    setResult(null); setStatus('idle'); setError(''); setCopied(false); setCopyFallback(false)
    return stop
  }, [paper.id, paper.file_hash, selection?.quote, selection?.page_number])
  async function translate() {
    if (!selection || !config?.enabled || current.current) return
    stop(); setResult(null); setCopied(false); setCopyFallback(false); setError(''); setStatus('loading')
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), (config.timeout_seconds + 3) * 1000)
    current.current = { controller, timeout }
    try {
      const next = await api<TranslationResult>(`/papers/${paper.id}/translation`, { method: 'POST', signal: controller.signal, body: JSON.stringify({ quote: selection.quote, page_number: selection.page_number, file_hash: paper.file_hash }) })
      if (current.current?.controller !== controller) return
      setResult(next); setStatus('done')
    } catch (cause) {
      if (current.current?.controller !== controller) return
      setError((cause as Error).name === 'AbortError' ? '翻译等待超时，请重试或缩短选区。' : (cause as Error).message); setStatus('failed')
    } finally {
      clearTimeout(timeout)
      if (current.current?.controller === controller) current.current = null
    }
  }
  useEffect(() => {
    if (!request || request === lastRequest.current || !selection || !config?.enabled) return
    lastRequest.current = request; void translate()
  }, [request, config?.enabled, selection?.quote, selection?.page_number])
  async function copy() {
    if (!result) return
    try { await navigator.clipboard.writeText(result.translation); setCopied(true); setCopyFallback(false) }
    catch { setCopyFallback(true) }
  }
  return <div className="reader-translation">
    {selection ? <details className="reader-translation-source" open><summary>原文 · 第 {selection.page_number} 页 · {Array.from(selection.quote).length} 字符</summary><blockquote>{selection.quote}</blockquote></details> : <div className="reader-translation-empty"><Languages size={28} /><h3>划词翻译</h3><p>在论文中选中文字，点击选区操作中的“翻译”。译文会显示在这里，可拖动侧栏左边缘调整宽度。</p></div>}
    <div className="reader-translation-heading">{selection && <button type="button" className="button compact secondary" disabled={!config?.enabled || status === 'loading' || status === 'done'} onMouseDown={event => event.preventDefault()} onClick={() => void translate()}><Languages size={14} />{status === 'failed' || status === 'cancelled' ? '重试翻译' : '翻译'}</button>}<small title={config?.base_url}>{config ? `${config.model} · 仅发送选中文字` : '正在准备翻译…'}</small></div>
    {configError && <p role="alert">{configError}<button className="text-button" onClick={() => setConfigTick(value => value + 1)}>重试读取翻译配置</button></p>}
    {config && !config.enabled && <p role="status">划词翻译已停用。</p>}
    {status === 'loading' && <div className="reader-translation-wait"><span role="status">正在翻译…</span><button type="button" className="text-button" onClick={() => { stop(); setStatus('cancelled') }}><X size={13} />取消翻译</button></div>}
    {status === 'failed' && <p className="reader-translation-error" role="alert">{error}</p>}
    {status === 'cancelled' && <p role="status">已取消翻译</p>}
    {result && <div className="reader-translation-result" aria-label="选中文字的中文译文"><div><strong>中文译文</strong><button type="button" className="text-button" onClick={() => void copy()}><Copy size={13} />{copied ? '已复制' : '复制译文'}</button></div><p>{result.translation}</p><small>{result.cached ? '已复用本次服务会话内的译文' : 'AI 译文'} · {result.model}</small>{copyFallback && <label>请选择译文后按 Ctrl+C<textarea aria-label="手动复制译文" value={result.translation} readOnly onFocus={event => event.currentTarget.select()} /></label>}</div>}
  </div>
}
