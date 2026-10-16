import { useEffect, useState } from 'react'
import { api } from '../api'
import { Modal } from '../components'
import { type IEEEConfiguration, timeText } from './types'

export default function DiscoverySettings({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [config, setConfig] = useState<IEEEConfiguration | null>(null)
  const [key, setKey] = useState('')
  const [limit, setLimit] = useState(200)
  const [mode, setMode] = useState('webvpn')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  useEffect(() => {
    const abort = new AbortController()
    Promise.all([api<IEEEConfiguration>('/settings/discovery-providers', { signal: abort.signal }), api<{ mode: string }>('/settings/institution-access', { signal: abort.signal })]).then(([saved, institution]) => { setConfig(saved); setLimit(saved.daily_limit); setMode(institution.mode) }).catch(cause => { if (!abort.signal.aborted) setError((cause as Error).message) })
    return () => abort.abort()
  }, [])
  async function save(clear = false) {
    if (!config) return
    setBusy(true); setError(''); setNotice('')
    try {
      const saved = await api<IEEEConfiguration>('/settings/discovery-providers/ieee', { method: 'PUT', body: JSON.stringify({ revision: config.revision, api_key: key || undefined, clear_key: clear, daily_limit: limit }) })
      setConfig(saved); setKey('')
      await api('/settings/institution-access', { method: 'PUT', body: JSON.stringify({ mode }) })
      setNotice(clear ? '检索密钥已移除。已有候选和论文继续可用。' : '检索设置已保存。可以测试 IEEE 接口，或直接进行检索。'); onSaved()
    } catch (cause) { setError((cause as Error).message) }
    finally { setBusy(false) }
  }
  async function test() {
    setBusy(true); setError(''); setNotice('')
    try { setConfig(await api('/settings/discovery-providers/ieee/test', { method: 'POST' })); setNotice('IEEE 元数据检索测试通过。全文仍需机构核对权限。'); onSaved() }
    catch (cause) { setError((cause as Error).message); const saved = await api<IEEEConfiguration>('/settings/discovery-providers').catch(() => null); if (saved) setConfig(saved) }
    finally { setBusy(false) }
  }
  function close() { if (!busy && (!key || window.confirm('密钥尚未保存，确定关闭？'))) onClose() }
  return <Modal title="检索来源设置" onClose={close}>
    <div className="modal-body discovery-settings">
      <p className="muted">arXiv 无需密钥。ACL 使用公开元数据索引；IEEE 使用独立检索密钥，与论文 AI 模型分开配置。</p>
      {error && <p className="error-message" role="alert">{error}</p>}{notice && <p className="success-message" role="status">{notice}</p>}
      <label>IEEE API 密钥<input type="password" aria-label="IEEE API 密钥" autoComplete="off" value={key} onChange={e => setKey(e.target.value)} placeholder={config?.configured ? '已加密保存，留空保留' : '稍后提供也可以，其他来源继续可用'} disabled={busy} /></label>
      <label>本机每日请求上限<input aria-label="IEEE 每日请求上限" type="number" min={1} max={200} value={limit} onChange={e => setLimit(Number(e.target.value))} disabled={busy} /></label>
      <p className="muted small">本机按 UTC 日期统计，今天已发 {config?.calls_today || 0} 次。缓存命中不调用来源；测试、分页及失败请求均计数。实际账号用量以 IEEE 为准。</p>
      <div className="discovery-setting-actions"><button className="button secondary compact" onClick={test} disabled={busy || !config?.configured || !!key}>{busy ? '处理中…' : '测试 IEEE 检索'}</button><span className="muted small">{config?.test_status === 'passed' ? '最近测试通过' : config?.test_status === 'failed' ? '最近测试未通过' : '尚未测试'} · {timeText(config?.tested_at)}</span></div>
      <label>电子科技大学访问方式<select aria-label="机构访问方式" value={mode} onChange={e => setMode(e.target.value)} disabled={busy}><option value="webvpn">校外：校园 VPN</option><option value="campus">校内：直接进入 IEEE</option></select></label>
      <p className="muted small">学校认证在学校或 IEEE 页面完成。这里不填写学校密码，也不保存浏览器会话。</p>
      {config?.configured && <button className="text-button" disabled={busy} onClick={() => { if (window.confirm('移除 IEEE 检索密钥？已有论文与候选将保留。')) void save(true) }}>移除已保存密钥</button>}
    </div>
    <footer className="modal-footer"><button className="button secondary" onClick={close} disabled={busy}>关闭</button><button className="button primary" onClick={() => void save()} disabled={busy || !config || !Number.isInteger(limit) || limit < 1 || limit > 200}>保存检索设置</button></footer>
  </Modal>
}
