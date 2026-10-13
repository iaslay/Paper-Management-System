import { useRef, useState, type ChangeEvent } from 'react'
import { UploadCloud, FileText, CheckCircle2, AlertCircle, X, RotateCcw } from 'lucide-react'
import { Modal, LabelPicker } from './components'
import { uploadPdf, sizeText, type Tag } from './api'

type Item = { id: string; file: File; status: 'waiting' | 'uploading' | 'success' | 'error'; progress: number; message: string }

export default function Upload({ tags, onClose, onSaved }: { tags: Tag[]; onClose: () => void; onSaved: () => void }) {
  const [items, setItems] = useState<Item[]>([])
  const [directions, setDirections] = useState<number[]>([])
  const [apply, setApply] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [dragging, setDragging] = useState(false)
  const chooser = useRef<HTMLInputElement>(null)
  const controller = useRef<AbortController | null>(null)
  function addFiles(files: File[]) {
    setError('')
    if (files.length + items.length > 20) { setError('一次最多选择 20 个文件。请分批上传。'); return }
    const next = files.map(file => {
      const message = !file.name.toLowerCase().endsWith('.pdf') ? '请选择 PDF 文件。' : file.size === 0 ? '文件为空，请重新选择。' : file.size > 50 * 1024 ** 2 ? '文件超过 50 MiB，请压缩后上传。' : ''
      return { id: crypto.randomUUID(), file, status: message ? 'error' as const : 'waiting' as const, progress: 0, message }
    })
    setItems(previous => [...previous, ...next])
  }
  function patch(id: string, value: Partial<Item>) { setItems(previous => previous.map(item => item.id === id ? { ...item, ...value } : item)) }
  async function run(onlyId?: string) {
    const pending = items.filter(item => onlyId ? item.id === onlyId : item.status === 'waiting')
    if (!pending.length || busy) return
    setBusy(true); setError('')
    controller.current = new AbortController()
    for (const item of pending) {
      if (controller.current.signal.aborted) break
      patch(item.id, { status: 'uploading', message: '正在上传…', progress: 0 })
      try {
        const result = await uploadPdf(item.file, items.length === 1 || apply ? directions : [], value => patch(item.id, { progress: value, message: value === 100 ? '检查文件与页数…' : '正在上传…' }), controller.current.signal)
        patch(item.id, { status: 'success', progress: 100, message: result.duplicate ? '论文已存在，已保留原记录。' : '已加入论文库' })
        onSaved()
      } catch (cause) { patch(item.id, { status: 'error', message: (cause as Error).message }) }
    }
    setBusy(false)
  }
  const waiting = items.filter(item => item.status === 'waiting').length
  const success = items.filter(item => item.status === 'success').length
  return <Modal title="上传论文" subtitle="把新的研究线索，加入你的论文库。" onClose={() => { if (!busy) onClose() }}>
    <div className="modal-body upload-body">
      <input className="visually-hidden" ref={chooser} type="file" accept=".pdf,application/pdf" multiple onChange={(event: ChangeEvent<HTMLInputElement>) => { addFiles(Array.from(event.target.files || [])); event.target.value = '' }} />
      <button className={`upload-drop ${dragging ? 'dragging' : ''}`} disabled={busy} onClick={() => chooser.current?.click()} onDragOver={event => { event.preventDefault(); if (!busy) setDragging(true) }} onDragLeave={() => setDragging(false)} onDrop={event => { event.preventDefault(); setDragging(false); if (!busy) addFiles(Array.from(event.dataTransfer.files)) }}><span className="upload-icon"><UploadCloud size={29} /></span><strong>点击选择，或将 PDF 拖到这里</strong><span>单篇不超过 50 MiB、300 页 · 每批最多 20 篇</span></button>
      <div><label className="field-label">研究方向 <span>可选</span></label><LabelPicker tags={tags} selected={directions} onChange={setDirections} disabled={busy} />{items.length > 1 && <label className="check-row"><input type="checkbox" checked={apply} disabled={busy} onChange={event => setApply(event.target.checked)} />将所选研究方向应用到本批文件</label>}</div>
      {!!items.length && <div className="upload-items">{items.map(item => <div className="upload-item" key={item.id}><span className="file-mini"><FileText size={20} /></span><div className="upload-item-content"><strong>{item.file.name}</strong><span className={item.status === 'error' ? 'error-text' : 'muted'}>{item.message || sizeText(item.file.size)}</span>{item.status === 'uploading' && <div className="progress-track"><span style={{ width: `${item.progress}%` }} /></div>}</div>{item.status === 'success' ? <CheckCircle2 className="green" size={19} /> : item.status === 'error' ? <><AlertCircle className="error-text" size={18} /><button className="icon-button" aria-label={`重试 ${item.file.name}`} disabled={busy || item.file.size > 50 * 1024 ** 2 || !item.file.size || !item.file.name.toLowerCase().endsWith('.pdf')} onClick={() => run(item.id)}><RotateCcw size={15} /></button></> : null}{item.status !== 'uploading' && item.status !== 'success' && <button className="icon-button" aria-label={`移除 ${item.file.name}`} disabled={busy} onClick={() => setItems(items.filter(other => other.id !== item.id))}><X size={16} /></button>}</div>)}</div>}
      {error && <div className="error-message" role="alert">{error}</div>}
    </div><footer className="modal-footer"><span className="muted small">{success ? `已加入 ${success} 篇` : '上传只保存论文，不触发 AI 调用。'}</span>{busy ? <button className="button secondary" onClick={() => controller.current?.abort()}>取消本批上传</button> : <button className="button secondary" onClick={onClose}>关闭</button>}<button className="button primary" disabled={busy || !waiting} onClick={() => run()}>{busy ? '正在上传…' : `开始上传${waiting ? `（${waiting}）` : ''}`}</button></footer>
  </Modal>
}
