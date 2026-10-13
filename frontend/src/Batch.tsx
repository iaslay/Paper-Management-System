import { useState } from 'react'
import { api, type Tag } from './api'
import { LabelPicker, Modal } from './components'

export default function Batch({ ids, tags, onClose, onDone }: { ids: string[]; tags: Tag[]; onClose: () => void; onDone: (failed: string[]) => void }) {
  const [initialCount] = useState(ids.length)
  const [pendingIds, setPendingIds] = useState(ids)
  const [directions, setDirections] = useState<number[]>([])
  const [operation, setOperation] = useState('add')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [results, setResults] = useState<{ id: string; ok: boolean; detail?: string }[]>([])
  async function submit() {
    setBusy(true); setError('')
    try {
      const response = await api<{ results: typeof results }>('/papers/research-direction-batches', { method: 'POST', body: JSON.stringify({ paper_ids: pendingIds, direction_ids: directions, operation }) })
      const failed = response.results.filter(row => !row.ok).map(row => row.id)
      setResults(response.results); setPendingIds(failed); onDone(failed)
    } catch (cause) { setError((cause as Error).message) }
    finally { setBusy(false) }
  }
  return <Modal title="批量维护研究方向" subtitle={`本次选中了 ${initialCount} 篇论文${results.length ? `，待重试 ${pendingIds.length} 篇` : ''}。`} onClose={() => { if (!busy) onClose() }}><div className="modal-body"><div className="segmented"><button className={operation === 'add' ? 'active' : ''} disabled={busy} onClick={() => setOperation('add')}>添加方向</button><button className={operation === 'remove' ? 'active' : ''} disabled={busy} onClick={() => setOperation('remove')}>移除方向</button></div><LabelPicker tags={tags.filter(tag => tag.kind === 'research_direction')} selected={directions} onChange={setDirections} disabled={busy} /><p className="muted small">添加会保留现有方向；移除只解除指定方向，不影响论文和其他分类。</p>{error && <div className="error-message" role="alert">{error}</div>}{results.length > 0 && <div role="status"><div className="success-message">成功 {results.filter(row => row.ok).length} 篇，失败 {results.filter(row => !row.ok).length} 篇。</div>{results.filter(row => !row.ok).map(row => <p key={row.id} className="error-message">{row.detail}</p>)}</div>}</div><footer className="modal-footer"><button className="button secondary" disabled={busy} onClick={onClose}>关闭</button><button className="button primary" disabled={busy || !directions.length || !pendingIds.length} onClick={submit}>{busy ? '正在更新…' : results.length ? '重试未完成的论文' : operation === 'add' ? '添加到选中论文' : '从选中论文移除'}</button></footer></Modal>
}
