import { useEffect, useState, type FormEvent } from 'react'
import { Plus, Tag as TagIcon, Pencil, Trash2, GitMerge, RotateCcw, ArrowRight, Check } from 'lucide-react'
import { api, kindNames, type Tag, type Kind } from './api'
import { Confirm, Modal } from './components'

export default function TagManager({ tags, kind: initialKind, onClose, onChange }: { tags: Tag[]; kind: Kind; onClose: () => void; onChange: () => void }) {
  const [kind, setKind] = useState<Kind>(initialKind)
  const [archived, setArchived] = useState(false)
  const [archiveList, setArchiveList] = useState<Tag[]>([])
  const [editing, setEditing] = useState<Tag | null>(null)
  const [name, setName] = useState('')
  const [aliases, setAliases] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [deleting, setDeleting] = useState<Tag | null>(null)
  const [merging, setMerging] = useState<Tag | null>(null)
  const [targetId, setTargetId] = useState('')
  const [preview, setPreview] = useState<{ source: Tag; target: Tag; affected_count: number; alias_count: number } | null>(null)
  const active = tags.filter(tag => tag.kind === kind)
  const rows = archived ? archiveList.filter(tag => tag.kind === kind) : active
  async function loadArchive() {
    try { setArchiveList(await api<Tag[]>('/tags?archived=true')) } catch (cause) { setError((cause as Error).message) }
  }
  useEffect(() => { if (archived) loadArchive() }, [archived])
  function reset() { setEditing(null); setName(''); setAliases(''); setError('') }
  function edit(tag: Tag) { setEditing(tag); setName(tag.name); setAliases(tag.aliases.join('\n')); setError(''); setSuccess('') }
  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setSuccess('')
    try {
      await api(editing ? `/tags/${editing.id}` : '/tags', { method: editing ? 'PATCH' : 'POST', body: JSON.stringify({ name, aliases: aliases.split(/[,，;；\n]+/).map(value => value.trim()).filter(Boolean), kind, ...(editing ? { revision: editing.revision } : {}) }) })
      reset(); onChange(); setSuccess(editing ? '分类已更新，相关论文会显示新名称。' : '已创建分类，现在可以添加到论文。')
    } catch (cause) { setError((cause as Error).message) }
    finally { setBusy(false) }
  }
  async function remove() {
    if (!deleting) return
    setBusy(true); setError('')
    try { await api(`/tags/${deleting.id}?revision=${deleting.revision}`, { method: 'DELETE' }); setDeleting(null); reset(); onChange(); setSuccess('已归档分类，论文与原文均已保留。') }
    catch (cause) { setError((cause as Error).message); setDeleting(null) }
    finally { setBusy(false) }
  }
  async function restore(tag: Tag) {
    setBusy(true); setError('')
    try { await api(`/tags/${tag.id}/restore?revision=${tag.revision}`, { method: 'POST' }); await loadArchive(); onChange(); setSuccess('已恢复分类，可重新关联到论文。') }
    catch (cause) { setError((cause as Error).message) }
    finally { setBusy(false) }
  }
  function mergePayload() {
    const target = active.find(tag => tag.id === Number(targetId))
    return { target_id: target?.id, revision: merging?.revision, target_revision: target?.revision }
  }
  async function prepareMerge() {
    setBusy(true); setError('')
    try { setPreview(await api(`/tags/${merging!.id}/merge-preview`, { method: 'POST', body: JSON.stringify(mergePayload()) })) }
    catch (cause) { setError((cause as Error).message) }
    finally { setBusy(false) }
  }
  async function performMerge() {
    setBusy(true); setError('')
    try { await api(`/tags/${merging!.id}/merge`, { method: 'POST', body: JSON.stringify({ target_id: preview!.target.id, revision: preview!.source.revision, target_revision: preview!.target.revision }) }); setPreview(null); setMerging(null); reset(); onChange(); setSuccess('分类已合并，论文关联已迁移并去重。') }
    catch (cause) { setError((cause as Error).message); setPreview(null) }
    finally { setBusy(false) }
  }
  return <>
    <Modal title="分类管理" subtitle="用一致的研究方向，让论文更容易找回。" wide onClose={() => { if (!busy) onClose() }}>
      <div className="manager-tabs">{(['research_direction', 'topic', 'general'] as Kind[]).map(item => <button className={kind === item ? 'active' : ''} onClick={() => { setKind(item); reset(); setMerging(null); setSuccess('') }} key={item} disabled={busy}>{kindNames[item]}</button>)}</div>
      <div className="manager-layout"><section className="manager-list"><div className="section-heading"><strong>{kindNames[kind]} <span className="muted">{rows.length}</span></strong><label className="check-row"><input type="checkbox" checked={archived} onChange={event => { setArchived(event.target.checked); reset(); setMerging(null) }} disabled={busy} />查看已归档</label></div>
        {!rows.length && <div className="manager-empty"><TagIcon size={28} /><p>{archived ? '还没有归档分类' : `添加你的第一个${kindNames[kind]}`}</p><span>分类名称可以按你的学科和研究习惯定义。</span></div>}
        {rows.map(tag => <div className={`manager-row ${editing?.id === tag.id ? 'editing' : ''}`} key={tag.id}><span className={`direction-dot ${kind}`} /><div><strong>{tag.name}</strong><p>{tag.aliases.length ? `别名：${tag.aliases.join('、')}` : `${tag.paper_count} 篇论文`}</p></div>{!archived ? <div className="row-tools"><button className="icon-button" disabled={busy} aria-label={`编辑 ${tag.name}`} onClick={() => edit(tag)}><Pencil size={15} /></button>{kind === 'research_direction' && <button className="icon-button" disabled={busy || active.length < 2} aria-label={`合并 ${tag.name}`} onClick={() => { reset(); setMerging(tag); setTargetId(''); setSuccess('') }}><GitMerge size={15} /></button>}<button className="icon-button" disabled={busy} aria-label={`归档 ${tag.name}`} onClick={() => setDeleting(tag)}><Trash2 size={15} /></button></div> : tag.merged_into_id ? <span className="muted small">已合并</span> : <button className="button compact secondary" disabled={busy} onClick={() => restore(tag)}><RotateCcw size={13} />恢复</button>}</div>)}
      </section><section className="manager-editor">
        {merging ? <><span className="form-eyebrow">整理相近方向</span><h3>合并“{merging.name}”</h3><p className="muted small">原名称会作为目标方向的别名保留，相关论文一起迁移。</p><label>合并到<select value={targetId} onChange={event => setTargetId(event.target.value)} disabled={busy}><option value="">请选择目标方向</option>{active.filter(tag => tag.id !== merging.id).map(tag => <option key={tag.id} value={tag.id}>{tag.name}</option>)}</select></label><div className="form-actions"><button className="button secondary" disabled={busy} onClick={() => setMerging(null)}>取消</button><button className="button primary" disabled={busy || !targetId} onClick={prepareMerge}>{busy ? '正在检查…' : '查看合并影响'}<ArrowRight size={15} /></button></div></> : <form onSubmit={save}><span className="form-eyebrow">{editing ? '调整分类' : '整理你的研究地图'}</span><h3>{editing ? `编辑${kindNames[kind]}` : `新建${kindNames[kind]}`}</h3><label>名称<input required maxLength={kind === 'topic' ? 50 : 30} value={name} disabled={busy} onChange={event => setName(event.target.value)} placeholder={kind === 'research_direction' ? '例如：检索增强生成' : kind === 'topic' ? '例如：毕业课题' : '例如：适合组会'} /></label><label>别名 <span className="muted small">可选</span><textarea rows={3} value={aliases} maxLength={500} disabled={busy} onChange={event => setAliases(event.target.value)} placeholder={kind === 'research_direction' ? '例如：RAG\n每行一个，或用逗号分隔' : '每行一个，或用逗号分隔'} /></label><p className="muted small">最多 10 个别名。规范名称与别名都可以用于检索。</p><div className="form-actions">{editing && <button className="button secondary" disabled={busy} type="button" onClick={reset}>取消编辑</button>}<button className="button primary" disabled={busy}>{editing ? <Check size={15} /> : <Plus size={15} />}{busy ? '正在保存…' : editing ? '保存分类' : '创建分类'}</button></div></form>}
        {error && <div className="error-message" role="alert">{error}</div>}{success && <div className="success-message" role="status">{success}</div>}
      </section></div>
    </Modal>
    {deleting && <Confirm title={`归档“${deleting.name}”？`} description={`将解除它与 ${deleting.paper_count} 篇有效论文的关联，保留论文、原文和其他分类。可以从已归档列表恢复分类。`} action="归档分类" danger busy={busy} onConfirm={remove} onClose={() => setDeleting(null)} />}
    {preview && <Confirm title="确认合并研究方向" description={`将“${preview.source.name}”合并到“${preview.target.name}”，迁移 ${preview.affected_count} 篇论文的关联。合并后原名称作为别名，重复关联只保留一份。`} action="合并方向" busy={busy} onConfirm={performMerge} onClose={() => setPreview(null)} />}
  </>
}
