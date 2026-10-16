import { useEffect, useRef, useState } from 'react'
import { api, type ApiError } from '../api'
import { Modal, Confirm } from '../components'
import { modelOptions, type ModelOptions, type ModelSettings, type Usage } from './types'
import './ai.css'
import { changeProtocol, connectionInfo } from './modelConnection'

export default function ModelSettingsModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [saved, setSaved] = useState<ModelSettings | null>(null), [draft, setDraft] = useState<ModelOptions | null>(null), [usage, setUsage] = useState<Usage | null>(null)
  const [key, setKey] = useState(''), [busy, setBusy] = useState(false), [testing, setTesting] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [discard, setDiscard] = useState(false)
  const active = useRef(true)
  useEffect(() => { active.current = true; void load(); return () => { active.current = false } }, [])
  async function load() {
    try { const [config, used] = await Promise.all([api<ModelSettings>('/settings/model'), api<Usage>('/settings/model/usage')]); if (active.current) { setSaved(config); setDraft(modelOptions(config)); setUsage(used) } }
    catch (cause) { if (active.current) setError((cause as Error).message) }
  }
  const dirty = !!saved && !!draft && (JSON.stringify(modelOptions(saved)) !== JSON.stringify(draft) || !!key)
  const connection = draft ? connectionInfo(draft) : null
  useEffect(() => { if (!dirty) return; const before = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }; window.addEventListener('beforeunload', before); return () => window.removeEventListener('beforeunload', before) }, [dirty])
  const change = <K extends keyof ModelOptions>(name: K, value: ModelOptions[K]) => { setDraft(previous => previous ? { ...previous, [name]: value } : previous); setNotice('') }
  async function save(test = false) {
    if (!draft || !saved || busy) return
    setBusy(true); setError(''); setNotice('')
    let testAttempted = false
    try {
      let config = saved
      if (dirty || saved.revision === 0) {
        config = await api<ModelSettings>('/settings/model', { method: 'PUT', body: JSON.stringify({ ...draft, revision: saved.revision, ...(key ? { api_key: key } : {}) }) })
        if (!active.current) return
        setSaved(config); setDraft(modelOptions(config)); setKey(''); onSaved()
      }
      if (test) {
        setTesting(true)
        testAttempted = true
        config = await api<ModelSettings>('/settings/model/test', { method: 'POST', body: JSON.stringify({ revision: config.revision }) })
        if (!active.current) return
        setSaved(config); setDraft(modelOptions(config)); onSaved(); setNotice(`视觉输入测试通过，将使用${config.tested_mode === 'pdf' ? '原生 PDF' : '页面图片'}生成卡片。`)
      } else setNotice('模型配置已保存。')
      const used = await api<Usage>('/settings/model/usage'); if (active.current) setUsage(used)
    } catch (cause) {
      if (active.current) {
        setError((cause as Error).message)
        if ((cause as ApiError).code === 'config_conflict') setNotice('本页输入已保留；可以复制服务地址和模型名后重新加载设置。')
        else if (testAttempted) {
          try { const [current,used] = await Promise.all([api<ModelSettings>('/settings/model'),api<Usage>('/settings/model/usage')]); if(active.current){setSaved(current);setDraft(modelOptions(current));setUsage(used);onSaved()} } catch {}
        }
      }
    }
    finally { if (active.current) { setBusy(false); setTesting(false) } }
  }
  function close() { if (busy) return; if (dirty) setDiscard(true); else onClose() }
  return <><Modal title="模型设置与用量" wide onClose={close}><div className="ai-settings">
    <p className="ai-notice">生成时会向你配置的服务发送论文 PDF 或页面图片。个人笔记默认不发送，选择后才纳入。连接测试使用合成文档，也可能产生少量用量。</p>
    {error && <p className="error-message" role="alert">{error}</p>}{notice && <p className="ai-notice" role="status">{notice}</p>}
    {!draft ? <button className="button secondary" onClick={() => void load()}>重新加载设置</button> : <fieldset disabled={busy} className="ai-settings-fields">
      <div className="ai-switches"><label><input type="checkbox" checked={draft.enabled} onChange={event => change('enabled', event.target.checked)} />启用云端模型</label><label><input type="checkbox" checked={draft.auto_on_read} onChange={event => change('auto_on_read', event.target.checked)} />首次标记已读后自动生成草稿</label></div>
      <p><button type="button" className="button compact secondary" onClick={() => { setDraft(previous => previous ? { ...previous, provider: 'responses', base_url: 'https://api.deepseek.com', model: 'deepseek-flash', input_mode: 'images' } : previous); setError(''); setNotice('已填入 DeepSeek 配置，请保存并测试；已有同服务密钥可继续使用。') }}>填入 DeepSeek 推荐配置</button></p>
      <div className="ai-two-columns"><label>接口类型<select value={draft.provider} onChange={event => { const provider = event.target.value as ModelOptions['provider']; setDraft(previous => previous ? changeProtocol(previous, provider) : previous); setNotice('') }}><option value="responses">OpenAI Responses</option><option value="claude">Claude Messages</option><option value="chat">兼容视觉接口</option></select></label><label>输入模式<select value={draft.input_mode} onChange={event => change('input_mode', event.target.value as ModelOptions['input_mode'])}><option value="auto">自动：PDF 优先</option><option value="pdf">原生 PDF</option><option value="images">按页图片</option></select></label></div>
      <label>服务地址<input aria-label="模型服务地址" value={draft.base_url} maxLength={2048} onChange={event => change('base_url', event.target.value)} placeholder="https://服务地址/v1" /></label>
      <p className="muted small">填写服务基础地址；完整接口地址会自动去除重复路径。{connection?.endpoint && <span className="ai-endpoint-preview">实际请求地址：{connection.endpoint}</span>}{connection?.hint && <span>{connection.hint}</span>}</p>
      {connection?.deepseek && <p className="ai-notice">DeepSeek Flash 的 API 模型标识为 deepseek-flash；Responses 使用页面图片，自动模式也会转图。请选择“按页图片”，无需独立 OCR。</p>}
      <div className="ai-two-columns"><label>模型名称<input value={draft.model} maxLength={200} onChange={event => change('model', event.target.value)} placeholder="填写你有权限使用的视觉模型" /></label><label>API 密钥<input type="password" autoComplete="off" aria-label="模型 API 密钥" value={key} maxLength={4096} onChange={event => setKey(event.target.value)} placeholder={saved?.has_key ? '已有加密密钥，留空保留' : '输入服务密钥'} /></label></div>
      <p className="muted small">{saved?.has_key ? '密钥已加密保存，不会回传。更换服务或接口类型需重新填写密钥；同一接口的地址格式修正保留密钥。' : '尚未保存密钥。'} {saved?.tested_mode && !dirty ? `已验证：${saved.tested_mode === 'pdf' ? '原生 PDF' : '图片输入'}` : '新配置需测试视觉输入能力。'}</p>
      <details><summary>用量上限与输入设置</summary><div className="ai-two-columns">{([
        ['monthly_token_limit','月度 token 上限',10000,100000000], ['max_task_tokens','单任务 token 上限',10000,50000000], ['batch_pages','每批页数',1,30], ['max_output_tokens','每次输出 token 上限',1024,16000], ['max_calls','单任务调用次数上限',3,60], ['input_tokens_per_page','每页输入 token 预估',1000,100000], ['image_long_edge','图片最长边（像素）',800,3000], ['timeout_seconds','单次超时（秒）',10,120]
      ] as const).map(([name,label,min,max]) => <label key={name}>{label}<input type="number" min={min} max={max} value={draft[name]} onChange={event => change(name, Number(event.target.value))} /></label>)}<label>请求大小上限（MiB）<input type="number" min={1} max={40} value={draft.max_request_bytes / 1024 ** 2} onChange={event => change('max_request_bytes', Math.round(Number(event.target.value) * 1024 ** 2))} /></label></div><label className="ai-check"><input type="checkbox" checked={draft.structured_output} onChange={event => change('structured_output',event.target.checked)} />接口支持时使用结构化输出</label><p className="muted small">预占包括全部原文、输出、长文汇总、重试和格式修复。token 数是用量估计，不代表服务商的货币账单。</p></details>
    </fieldset>}
    {usage && <section className="ai-usage"><h3>{usage.month} 用量</h3><div className="ai-usage-grid"><span>已占用<strong>{usage.occupied_tokens.toLocaleString()}／{usage.monthly_token_limit.toLocaleString()}</strong></span><span>任务剩余预占<strong>{usage.reserved_tokens.toLocaleString()}</strong></span><span>已记录用量／估算<strong>{usage.accounted_tokens.toLocaleString()}</strong></span></div><p className="muted small">{usage.task_count} 个 AI 任务 · {usage.connection_test_calls} 次连接／能力测试 · {usage.search_query_calls || 0} 次检索词生成 · {usage.unknown_tasks} 个任务、{usage.unknown_calls || 0} 次独立调用的用量未确认</p>{usage.calls.length > 0 && <details><summary>最近调用记录</summary><div className="ai-call-list">{usage.calls.map(call => <p key={call.id}><span>{call.stage === 'connection' ? '连接测试' : call.stage === 'capability' ? '视觉测试' : call.stage === 'metadata' ? '信息识别' : call.stage === 'search_query' ? '检索词生成' : 'AI 处理'}</span><span>{call.input_tokens !== null && call.output_tokens !== null ? `输入 ${call.input_tokens.toLocaleString()}／输出 ${call.output_tokens.toLocaleString()}` : call.status === 'failed' ? '未产生已确认用量' : `用量未确认，估算占用 ${call.estimated_tokens.toLocaleString()}`}</span></p>)}</div></details>}</section>}
    </div><footer className="modal-footer"><button className="button secondary" disabled={busy} onClick={close}>关闭</button><button className="button secondary" disabled={busy || !draft} onClick={() => void save()}>{busy && !testing ? '正在保存…' : '保存配置'}</button><button className="button primary" disabled={busy || !draft?.enabled} onClick={() => void save(true)}>{testing ? '正在测试视觉输入…' : '保存并测试视觉能力'}</button></footer></Modal>{discard && <Confirm title="放弃未保存的模型设置？" description="已保存的配置会保留，本页未保存的输入将丢失。" action="放弃并关闭" busy={false} onClose={() => setDiscard(false)} onConfirm={onClose} />}</>
}
