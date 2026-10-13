import { useEffect, useRef, useState, type ReactNode } from 'react'
import { X, Check, Search } from 'lucide-react'
import type { Tag } from './api'

export function Modal({ title, subtitle, children, onClose, wide = false, fullPage = false, headerActions, className = '' }: { title: string; subtitle?: string; children: ReactNode; onClose: () => void; wide?: boolean; fullPage?: boolean; headerActions?: ReactNode; className?: string }) {
  const container = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    container.current?.focus()
    const handle = (event: KeyboardEvent) => {
      const dialogs = document.querySelectorAll('.modal')
      if (dialogs[dialogs.length - 1] !== container.current || !container.current?.getClientRects().length) return
      if (event.key === 'Escape') close.current()
      if (event.key !== 'Tab') return
      const nodes = container.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex="0"]')
      if (!nodes?.length) { event.preventDefault(); return }
      const first = nodes[0], last = nodes[nodes.length - 1]
      if (event.shiftKey && (document.activeElement === first || document.activeElement === container.current)) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    const original = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    document.addEventListener('keydown', handle)
    return () => { document.removeEventListener('keydown', handle); document.body.style.overflow = original; previous?.focus() }
  }, [])
  return <div className={`modal-backdrop ${fullPage ? 'full-page-backdrop' : ''}`} onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <div className={`modal ${wide ? 'wide' : ''} ${className}`} role="dialog" aria-modal="true" aria-label={title} ref={container} tabIndex={-1}>
      <header className="modal-header"><div className="modal-title-block"><h2 title={title}>{title}</h2>{subtitle && <p>{subtitle}</p>}</div><span className="modal-header-actions">{headerActions}<button className="icon-button" onClick={onClose} aria-label="关闭窗口"><X size={20} /></button></span></header>
      {children}
    </div>
  </div>
}

export function LabelPicker({ tags, selected, onChange, max = 10, disabled = false, empty = '还没有可选分类，请先在分类管理中创建。' }: { tags: Tag[]; selected: number[]; onChange: (ids: number[]) => void; max?: number; disabled?: boolean; empty?: string }) {
  const [query, setQuery] = useState('')
  const filtered = tags.filter(tag => [tag.name, ...tag.aliases].some(name => name.toLocaleLowerCase().includes(query.toLocaleLowerCase())))
  return <div className="label-picker">
    {tags.length > 6 && <div className="small-search"><Search size={14} /><input aria-label="搜索可选分类" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索名称或别名" /></div>}
    <div className="label-options">
      {filtered.map(tag => <button type="button" key={tag.id} className={`label-option ${selected.includes(tag.id) ? 'selected' : ''}`} aria-pressed={selected.includes(tag.id)} disabled={disabled || (!selected.includes(tag.id) && selected.length >= max)} onClick={() => onChange(selected.includes(tag.id) ? selected.filter(id => id !== tag.id) : [...selected, tag.id])}>{selected.includes(tag.id) && <Check size={13} />}{tag.name}</button>)}
      {!tags.length && <p className="muted small">{empty}</p>}
      {tags.length > 0 && !filtered.length && <p className="muted small">没有匹配的分类。</p>}
    </div>
    {selected.length >= max && <p className="muted small">最多选择 {max} 个，请先移除再添加。</p>}
  </div>
}

export function Confirm({ title, description, action, danger = false, busy, onConfirm, onClose }: { title: string; description: string; action: string; danger?: boolean; busy: boolean; onConfirm: () => void; onClose: () => void }) {
  return <Modal title={title} onClose={() => { if (!busy) onClose() }}><div className="modal-body"><p className="confirm-description">{description}</p></div><footer className="modal-footer"><button className="button secondary" onClick={onClose} disabled={busy}>取消</button><button className={`button ${danger ? 'danger' : 'primary'}`} onClick={onConfirm} disabled={busy}>{busy ? '正在处理…' : action}</button></footer></Modal>
}
