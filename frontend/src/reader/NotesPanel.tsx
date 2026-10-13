import { useCallback, useEffect, useRef, useState } from 'react'
import { api, readingApi, ApiError, type Paper } from '../api'
import { Modal, Confirm } from '../components'
import { useAutosave } from './useAutosave'
import SaveStatus from './SaveStatus'
import { colors, insightNames, type Annotation, type AnnotationResult, type Color, type InsightKind, type Note, type NoteSeed, type NoteValue, type PageList, type RegisterSave, type SelectionValue } from './types'

const noteValue = (note: Note | NoteSeed): NoteValue => ({ content: note.content, page_number: note.page_number, insight_kind: note.insight_kind })
export async function copyText(text: string) {
  try { await navigator.clipboard.writeText(text); return true } catch { return false }
}

function NoteEditor({ paper, localKey, seed, note, register, enabled, readOnly, visible, onSaved, onDeleted, onGo }: {
  paper: Paper; localKey: string; seed: NoteSeed; note?: Note; register: RegisterSave; enabled: boolean; readOnly: boolean; visible: boolean;
  onSaved: (note: Note, localKey: string) => void; onDeleted: (key: string, id?: string) => void; onGo: (page: number, annotationId?: string) => void;
}) {
  const [confirm, setConfirm] = useState(false), [deleting, setDeleting] = useState(false), [message, setMessage] = useState(''), [copyFallback, setCopyFallback] = useState(''), [compare, setCompare] = useState(false), [resolveAction, setResolveAction] = useState<'server' | 'mine' | null>(null)
  const removal = useRef<{ request_id: string; revision: number } | null>(null)
  const forkRequest = useRef<{ body: string; snapshot: string } | null>(null)
  const { queue, state } = useAutosave<NoteValue, Note>({ value: noteValue(note || seed), remote: note || null, enabled: enabled && !readOnly, register, key: `note-${localKey}`, label: seed.note_type === 'personal_insight' ? '个人心得' : `第 ${seed.page_number} 页记录`, text: value => value.content,
    validate: value => !value.content.trim() ? '内容为空，请输入内容或删除这条笔记。' : Array.from(value.content).length > 10000 ? '单条笔记最多 10,000 字符，请缩短后保存。' : null,
    writer: async (value, remote, requestId) => remote ? readingApi<Note>(`/notes/${remote.id}`, { method: 'PATCH', body: JSON.stringify({ ...value, revision: remote.revision, request_id: requestId }) }) : readingApi<Note>(`/papers/${paper.id}/notes`, { method: 'POST', body: JSON.stringify({ ...seed, ...value, file_hash: paper.file_hash, request_id: requestId }) }),
    onSaved: result => onSaved(result, localKey),
  })
  useEffect(() => { if (note && note.revision > (queue.snapshot().remote?.revision || 0) && !queue.dirty()) queue.adopt(note, noteValue(note)) }, [note, queue])
  const change = (values: Partial<NoteValue>) => queue.set({ ...state.draft, ...values })
  async function remove() {
    setDeleting(true); setMessage('')
    try {
      if (!await queue.settle()) { setMessage('请先确认待处理请求或比较版本，再删除。'); return }
      const current = queue.snapshot().remote
      if (!current) { onDeleted(localKey); return }
      removal.current ||= { request_id: crypto.randomUUID().replaceAll('-', ''), revision: current.revision }
      await readingApi(`/notes/${current.id}`, { method: 'DELETE', body: JSON.stringify(removal.current) })
      onDeleted(localKey, current.id)
    } catch (cause) { const error = cause as Error; if (error instanceof ApiError && error.status < 500) removal.current = null; if (error instanceof ApiError && error.code === 'revision_conflict' && error.current) queue.conflict(error.current as Note, error); setMessage(error.message) }
    finally { setDeleting(false); setConfirm(false) }
  }
  async function copy() { if (!await copyText(state.draft.content)) setCopyFallback(state.draft.content) }
  async function fork() {
    setDeleting(true)
    try {
      const newSeed: NoteSeed = { ...seed, ...state.draft, note_type: seed.note_type === 'annotation_comment' ? 'page_note' : seed.note_type, annotation_id: null }
      forkRequest.current ||= { body: JSON.stringify({ ...newSeed, file_hash: paper.file_hash, request_id: crypto.randomUUID().replaceAll('-', '') }), snapshot: JSON.stringify(state.draft) }
      const created = await readingApi<Note>(`/papers/${paper.id}/notes`, { method: 'POST', body: forkRequest.current.body })
      const unchanged = JSON.stringify(queue.snapshot().draft) === forkRequest.current.snapshot
      forkRequest.current = null
      if (unchanged && state.current) queue.adopt(state.current, noteValue(state.current))
      else if (unchanged) onDeleted(localKey)
      onSaved(created, `fork-${created.id}`); setCompare(false); setMessage('已另存为独立记录，服务器原记录已保留。')
    } catch (cause) { if (cause instanceof ApiError && cause.status < 500) forkRequest.current = null; setMessage((cause as Error).message) }
    finally { setDeleting(false) }
  }
  const typeName = seed.note_type === 'personal_insight' ? '个人心得' : seed.note_type === 'annotation_comment' ? '高亮评论' : '页码笔记'
  return <section className="reader-note-editor" style={{ display: visible ? undefined : 'none' }}>
    <div className="reader-note-heading"><strong>{typeName}</strong>{state.draft.page_number && <button className="text-button" onClick={() => onGo(state.draft.page_number!, seed.annotation_id || undefined)}>第 {state.draft.page_number} 页 ↗</button>}<button type="button" className="text-button" onClick={copy}>复制内容</button></div>
    {seed.note_type === 'personal_insight' ? <label>心得类别<select aria-label="心得类别" value={state.draft.insight_kind!} disabled={readOnly || deleting} onChange={event => change({ insight_kind: event.target.value as InsightKind })}>{Object.entries(insightNames).map(([kind, name]) => <option key={kind} value={kind}>{name}</option>)}</select></label> : seed.note_type === 'page_note' && <label className="reader-note-page">记录页码<input aria-label="笔记页码" type="number" min={1} max={paper.page_count} value={state.draft.page_number || ''} disabled={readOnly || deleting} onChange={event => change({ page_number: Number(event.target.value) || null })} /></label>}
    <label>{typeName}内容<textarea aria-label={`${typeName}内容`} rows={5} value={state.draft.content} disabled={readOnly || deleting} placeholder="记录一个疑问或发现，方便下次接着读。" onCompositionStart={() => queue.composition(true)} onCompositionEnd={() => queue.composition(false)} onChange={event => change({ content: event.target.value })} onBlur={() => { if (queue.dirty()) void queue.flush() }} /></label>
    <div className="reader-note-footer"><small>{Array.from(state.draft.content).length}／10,000 字符</small>{!readOnly && <button className="text-button danger-text" disabled={deleting} onClick={() => setConfirm(true)}>删除笔记</button>}</div>
    {!readOnly && <SaveStatus phase={state.phase} error={state.error} savedAt={state.savedAt} onRetry={queue.retry} />}
    {state.phase === 'conflict' && <button className="button compact secondary" onClick={() => setCompare(true)}>比较版本</button>}
    {state.phase === 'failed' && state.error instanceof ApiError && state.error.status === 404 && <button className="button compact secondary" onClick={fork}>另存为独立记录</button>}
    {message && <p className="reader-text-notice" role="status">{message}</p>}
    {copyFallback && <label>浏览器未允许复制，请选中文字后按 Ctrl+C<textarea readOnly value={copyFallback} onFocus={event => event.currentTarget.select()} /></label>}
    {confirm && <Confirm title="删除这条笔记？" description="删除后无法在应用内恢复。单独删除评论会保留原高亮。" action="删除笔记" danger busy={deleting} onConfirm={() => void remove()} onClose={() => setConfirm(false)} />}
    {compare && state.current && <Modal title="比较笔记版本" wide onClose={() => setCompare(false)}><div className="reader-conflict-grid"><label>我的未保存内容<textarea readOnly value={state.draft.content} rows={8} /></label><label>服务器最新内容<textarea readOnly value={state.current.content} rows={8} /></label></div><footer className="modal-footer"><button className="button secondary" onClick={() => setResolveAction('server')}>采用服务器内容</button><button className="button secondary" onClick={() => void fork()}>另存为独立记录</button><button className="button primary" onClick={() => setResolveAction('mine')}>保存我的内容</button></footer></Modal>}
    {resolveAction && state.current && <Confirm title={resolveAction === 'mine' ? '用我的内容更新服务器记录？' : '采用服务器最新内容？'} description={resolveAction === 'mine' ? '服务器当前版本将由你的编辑更新；再次发生冲突时会继续比较。' : '当前编辑区将替换为服务器内容，请先复制需要保留的草稿。'} action={resolveAction === 'mine' ? '保存我的内容' : '采用服务器内容'} busy={false} onClose={() => setResolveAction(null)} onConfirm={() => { if (resolveAction === 'mine') queue.overwrite(state.current!); else queue.adopt(state.current!, noteValue(state.current!)); setResolveAction(null); setCompare(false) }} />}
  </section>
}

function AnnotationEditor({ annotation, enabled, readOnly, register, onChanged, onDeleted, onComment, onGo, visible }: {
  annotation: Annotation; enabled: boolean; readOnly: boolean; register: RegisterSave; onChanged: () => void; onDeleted: (id: string) => void;
  onComment: (annotation: Annotation) => void; onGo: (page: number, id: string) => void; visible: boolean;
}) {
  const [confirm, setConfirm] = useState(false), [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [conflict, setConflict] = useState(false)
  const deletion = useRef<{ request_id: string; revision: number } | null>(null)
  const { queue, state } = useAutosave<{ color: Color }, Annotation>({ value: { color: annotation.color }, remote: annotation, key: `annotation-${annotation.id}`, label: `第 ${annotation.page_number} 页高亮`, text: () => annotation.quote, register, enabled: enabled && !readOnly, validate: () => null,
    writer: (value, remote, requestId) => readingApi<Annotation>(`/annotations/${annotation.id}`, { method: 'PATCH', body: JSON.stringify({ ...value, revision: remote!.revision, request_id: requestId }) }), onSaved: onChanged })
  useEffect(() => { if (annotation.revision > (queue.snapshot().remote?.revision || 0) && !queue.dirty()) queue.adopt(annotation, { color: annotation.color }) }, [annotation, queue])
  async function remove() {
    setBusy(true)
    try {
      if (!await queue.settle()) { setMessage('请先确认待处理请求或比较高亮颜色。'); return }
      deletion.current ||= { request_id: crypto.randomUUID().replaceAll('-', ''), revision: queue.snapshot().remote!.revision }
      await readingApi(`/annotations/${annotation.id}`, { method: 'DELETE', body: JSON.stringify(deletion.current) }); onDeleted(annotation.id)
    } catch (cause) { if (cause instanceof ApiError && cause.status < 500) deletion.current = null; if (cause instanceof ApiError && cause.code === 'revision_conflict' && cause.current) queue.conflict(cause.current as Annotation, cause); setMessage((cause as Error).message) }
    finally { setBusy(false); setConfirm(false) }
  }
  return <section className="reader-annotation-card" style={{ display: visible ? undefined : 'none' }}><button className="reader-annotation-quote" onClick={() => onGo(annotation.page_number, annotation.id)}><small>第 {annotation.page_number} 页 · 原文摘录 ↗</small><span>{annotation.quote}</span></button><div className="reader-inline-tools"><select aria-label="修改高亮颜色" value={state.draft.color} disabled={readOnly || busy} onChange={event => queue.set({ color: event.target.value as Color })}>{Object.entries(colors).map(([color, name]) => <option key={color} value={color}>{name}</option>)}</select>{!readOnly && <><button className="text-button" onClick={() => onComment(annotation)}>编辑评论</button><button className="text-button danger-text" disabled={busy} onClick={() => setConfirm(true)}>删除高亮</button></>}</div>{!readOnly && <SaveStatus phase={state.phase} error={state.error} onRetry={queue.retry} />}{state.phase === 'conflict' && <button className="text-button" onClick={() => setConflict(true)}>比较颜色</button>}{message && <p className="reader-text-notice">{message}</p>}{confirm && <Confirm title="删除这处高亮及其评论？" description="高亮及关联评论将一起删除，无法在应用内恢复。" action="删除高亮与评论" danger busy={busy} onConfirm={() => void remove()} onClose={() => setConfirm(false)} />}{conflict && state.current && <Modal title="高亮颜色存在冲突" onClose={() => setConflict(false)}><div className="modal-body"><p>当前颜色：{colors[state.draft.color]}；服务器颜色：{colors[state.current.color]}。</p></div><footer className="modal-footer"><button className="button secondary" onClick={() => { queue.adopt(state.current!, { color: state.current!.color }); setConflict(false); onChanged() }}>采用服务器颜色</button><button className="button primary" onClick={() => { queue.overwrite(state.current!); setConflict(false) }}>保存当前颜色</button></footer></Modal>}</section>
}

export function HighlightDraft({ paper, draftKey, selection, color, comment, enabled, register, onSaved }: { paper: Paper; draftKey: string; selection: SelectionValue; color: Color; comment?: string; enabled: boolean; register: RegisterSave; onSaved: (result: AnnotationResult, key: string) => void }) {
  const { queue, state } = useAutosave({ value: { ...selection, color, ...(comment ? { comment } : {}) }, remote: null as AnnotationResult | null, key: `highlight-new-${draftKey}`, label: `第 ${selection.page_number} 页待保存高亮`, text: value => `${value.quote}${value.comment ? '\n' + value.comment : ''}`, enabled, register, autoCreate: true, validate: () => null,
    writer: (value, _, requestId) => readingApi<AnnotationResult>(`/papers/${paper.id}/annotations`, { method: 'POST', body: JSON.stringify({ ...value, file_hash: paper.file_hash, request_id: requestId }) }), onSaved: result => onSaved(result, draftKey) })
  return <section className="reader-highlight-draft"><blockquote>{selection.quote}</blockquote><SaveStatus phase={state.phase} error={state.error} onRetry={queue.retry} /></section>
}

export default function NotesPanel({ paper, currentPage, annotations, register, enabled, readOnly, onChanged, onGo, reload, drafts, onHighlightSaved }: {
  paper: Paper; currentPage: number; annotations: Annotation[]; register: RegisterSave; enabled: boolean; readOnly: boolean; onChanged: () => void; onGo: (page: number, id?: string) => void; reload: number;
  drafts: { key: string; selection: SelectionValue; color: Color; comment?: string }[]; onHighlightSaved: (result: AnnotationResult, key: string) => void;
}) {
  const [tab, setTab] = useState<'notes' | 'insights' | 'highlights'>('notes'), [list, setList] = useState<PageList<Note> | null>(null), [page, setPage] = useState(1), [error, setError] = useState(''), [tick, setTick] = useState(0)
  const [editors, setEditors] = useState<{ key: string; seed: NoteSeed; note?: Note; selected: boolean }[]>([])
  const [cachedAnnotations, setCachedAnnotations] = useState<Annotation[]>([])
  useEffect(() => { setCachedAnnotations(previous => { const map = new Map(previous.map(item => [item.id, item])); annotations.forEach(item => map.set(item.id, item)); return [...map.values()] }) }, [annotations])
  const fetchNotes = useCallback(() => {
    let active = true
    const type = tab === 'insights' ? '&note_type=personal_insight' : ''
    api<PageList<Note>>(`/papers/${paper.id}/notes?page=${page}&page_size=50${type}`).then(result => {
      if (!active) return
      setList(result); setError('')
      setEditors(previous => previous.map(editor => { const updated = result.items.find(note => note.id === editor.note?.id); return updated ? { ...editor, note: updated } : editor }))
    }).catch(cause => { if (active) setError((cause as Error).message) })
    return () => { active = false }
  }, [paper.id, page, tab])
  useEffect(fetchNotes, [fetchNotes, reload, tick])
  const seedFrom = (note: Note): NoteSeed => ({ ...noteValue(note), note_type: note.note_type, annotation_id: note.annotation_id })
  function open(note: Note) { setEditors(previous => { const existing = previous.find(editor => editor.note?.id === note.id); return previous.map(editor => ({ ...editor, selected: editor.key === existing?.key })).concat(existing ? [] : [{ key: note.id, seed: seedFrom(note), note, selected: true }]) }); setTab(note.note_type === 'personal_insight' ? 'insights' : 'notes') }
  function add(insight?: InsightKind) { const seed: NoteSeed = { content: '', note_type: insight ? 'personal_insight' : 'page_note', page_number: insight ? null : currentPage, insight_kind: insight || null, annotation_id: null }; setEditors(previous => [...previous.map(editor => ({ ...editor, selected: false })), { key: crypto.randomUUID(), seed, selected: true }]); setTab(insight ? 'insights' : 'notes') }
  function saved(note: Note, localKey: string) { setEditors(previous => previous.map(editor => editor.key === localKey ? { ...editor, note } : editor)); setTick(value => value + 1) }
  function removed(key: string, id?: string) { setEditors(previous => previous.filter(editor => editor.key !== key && editor.note?.id !== id)); setTick(value => value + 1) }
  async function comment(annotation: Annotation) {
    try { const result = await api<AnnotationResult>(`/annotations/${annotation.id}`); if (result.note) open(result.note); else { const seed: NoteSeed = { content: '', note_type: 'annotation_comment', page_number: annotation.page_number, annotation_id: annotation.id, insight_kind: null }; setEditors(previous => [...previous.map(editor => ({ ...editor, selected: false })), { key: `comment-${annotation.id}-${crypto.randomUUID()}`, seed, selected: true }]); setTab('notes') } }
    catch (cause) { setError((cause as Error).message) }
  }
  const visibleAnnotations = new Set(annotations.map(item => item.id))
  return <aside className="reader-notes-panel" aria-label="个人记录面板"><div className="reader-panel-tabs"><button className={tab === 'notes' ? 'active' : ''} onClick={() => { setTab('notes'); setPage(1) }}>笔记</button><button className={tab === 'insights' ? 'active' : ''} onClick={() => { setTab('insights'); setPage(1) }}>个人心得</button><button className={tab === 'highlights' ? 'active' : ''} onClick={() => setTab('highlights')}>高亮</button></div>
    {readOnly && <p className="reader-text-notice">这篇论文在回收站中，恢复后可以继续编辑记录。</p>}
    {!readOnly && tab === 'notes' && <button className="button compact primary reader-add-note" onClick={() => add()}>添加本页笔记</button>}
    {!readOnly && tab === 'insights' && <div className="reader-insight-add">{Object.entries(insightNames).map(([kind, name]) => <button key={kind} className="button compact secondary" onClick={() => add(kind as InsightKind)}>添加{name}</button>)}</div>}
    {error && <p className="reader-text-notice" role="alert">{error}<button className="text-button" onClick={() => setTick(t => t + 1)}>重新加载记录</button></p>}
    {drafts.map(draft => <HighlightDraft key={draft.key} paper={paper} draftKey={draft.key} selection={draft.selection} color={draft.color} comment={draft.comment} enabled={enabled && !readOnly} register={register} onSaved={onHighlightSaved} />)}
    {editors.map(editor => <NoteEditor key={editor.key} paper={paper} localKey={editor.key} seed={editor.seed} note={editor.note} register={register} enabled={enabled} readOnly={readOnly} visible={editor.selected && (tab === 'insights' ? editor.seed.note_type === 'personal_insight' : tab === 'notes' && editor.seed.note_type !== 'personal_insight')} onSaved={saved} onDeleted={removed} onGo={onGo} />)}
    {cachedAnnotations.map(annotation => <AnnotationEditor key={annotation.id} annotation={annotation} enabled={enabled} readOnly={readOnly} register={register} visible={tab === 'highlights' && visibleAnnotations.has(annotation.id)} onChanged={onChanged} onDeleted={id => { setCachedAnnotations(previous => previous.filter(item => item.id !== id)); setEditors(previous => previous.filter(editor => editor.seed.annotation_id !== id)); onChanged(); setTick(t => t + 1) }} onComment={annotation => void comment(annotation)} onGo={onGo} />)}
    {tab === 'highlights' ? !annotations.length && <p className="reader-empty">当前页还没有高亮。选中文字后可添加；没有文字层的页面可添加页码笔记。</p> : <><div className="reader-note-list">{list?.items.filter(note => tab !== 'notes' || note.note_type !== 'personal_insight').map(note => <button className="reader-note-summary" key={note.id} onClick={() => open(note)}><small>{note.note_type === 'personal_insight' ? insightNames[note.insight_kind!] : `第 ${note.page_number} 页 · ${note.note_type === 'annotation_comment' ? '高亮评论' : '页码笔记'}`}</small><span>{note.content}</span></button>)}</div>{!list?.items.length && !editors.some(e => e.selected) && <p className="reader-empty">记录一个疑问或发现，方便下次接着读。</p>}{list && list.total > 50 && <div className="reader-inline-tools"><button disabled={page <= 1} onClick={() => setPage(page - 1)}>上一组</button><span>{page}／{Math.ceil(list.total / 50)}</span><button disabled={page >= Math.ceil(list.total / 50)} onClick={() => setPage(page + 1)}>下一组</button></div>}</>}
  </aside>
}
