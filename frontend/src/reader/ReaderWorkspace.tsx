import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { ChevronLeft, ChevronRight, RotateCw, PanelLeft, Search, NotebookPen, Minus, Plus } from 'lucide-react'
import { api, readingApi, type Paper } from '../api'
import { Modal, Confirm } from '../components'
import PdfPage from './PdfPage'
import ReaderNavigation from './ReaderNavigation'
import ReaderSearch from './ReaderSearch'
import NotesPanel from './NotesPanel'
import SelectionToolbar from './SelectionToolbar'
import SaveStatus from './SaveStatus'
import { useAutosave } from './useAutosave'
import type { Annotation, AnnotationResult, Color, PageList, Position, PositionValue, ReaderHandle, ReaderOpen, RegisterSave, SaveControl, SelectionValue } from './types'
import type { SearchHit } from './textIndex'
import { clearPageCache } from './pageCache'
import './reader.css'

GlobalWorkerOptions.workerSrc = workerUrl
const defaultPosition: PositionValue = { page_number: 1, zoom_mode: 'fit_width', zoom: null, view_rotation: 0 }
const positionValue = (position: Position | null): PositionValue => position ? { page_number: position.page_number, zoom_mode: position.zoom_mode, zoom: position.zoom, view_rotation: position.view_rotation } : defaultPosition

const ReaderSession = forwardRef<ReaderHandle, { paper: Paper; reader: ReaderOpen; pdf: PDFDocumentProxy | null; fileError: string; loading: boolean; enabled: boolean; onReload: () => void; onOpened: () => void; openAt?: {page:number;nonce:number} | null }>(function ReaderSession({ paper, reader, pdf, fileError, loading, enabled, onReload, onOpened, openAt }, ref) {
  const registry = useRef(new Map<string, SaveControl>())
  const [saveTick, setSaveTick] = useState(0), [readyPage, setReadyPage] = useState(0), [renderScale, setRenderScale] = useState(1)
  const register = useCallback<RegisterSave>((key, control) => { registry.current.set(key, control); setSaveTick(t => t + 1); const unsubscribe = control.subscribe(() => setSaveTick(t => t + 1)); return () => { unsubscribe(); registry.current.delete(key); setSaveTick(t => t + 1) } }, [])
  const { queue, state } = useAutosave<PositionValue, Position>({ value: positionValue(reader.position), remote: reader.position, enabled: enabled && !reader.read_only && readyPage > 0, register, key: 'reading-position', label: '阅读位置', text: value => `第 ${value.page_number} 页 · ${value.zoom_mode === 'fit_width' ? '适应宽度' : `${Math.round(value.zoom! * 100)}%`} · 额外旋转 ${value.view_rotation}°`,
    validate: value => value.page_number < 1 || value.page_number > paper.page_count ? '页码不在原文范围内。' : null,
    writer: (value, remote, requestId) => readingApi<Position>(`/papers/${paper.id}/position`, { method: 'PUT', body: JSON.stringify({ ...value, file_hash: reader.file_hash, revision: remote?.revision || 1, request_id: requestId }) }),
  })
  const [pageInput, setPageInput] = useState(String(state.draft.page_number)), [message, setMessage] = useState(''), [panel, setPanel] = useState<'navigation' | 'search' | null>(null), [notesVisible, setNotesVisible] = useState(() => window.innerWidth > 740)
  const [selection, setSelection] = useState<SelectionValue | null>(null), [searchHit, setSearchHit] = useState<SearchHit | null>(null), [focusAnnotation, setFocusAnnotation] = useState<string | null>(null)
  const [annotations, setAnnotations] = useState<Annotation[]>([]), [recordTick, setRecordTick] = useState(0), [recordError, setRecordError] = useState('')
  const [highlightDrafts, setHighlightDrafts] = useState<{ key: string; selection: SelectionValue; color: Color; comment?: string }[]>([])
  const [comparePosition, setComparePosition] = useState(false), [confirmPosition, setConfirmPosition] = useState(false), [otherPageNotice, setOtherPageNotice] = useState(false)
  const channel = useRef<BroadcastChannel | null>(null)
  const notifyChange = useCallback(() => setRecordTick(t => t + 1), [])
  useImperativeHandle(ref, () => ({ dirty: () => [...registry.current.values()].some(control => control.dirty()), flush: async () => (await Promise.all([...registry.current.values()].map(control => control.flush()))).every(Boolean), text: () => [...registry.current.values()].filter(control => control.dirty()).map(control => control.text()).join('\n\n'), retry: () => { registry.current.forEach(control => { void control.flush() }); notifyChange() } }), [notifyChange])
  const dirty = [...registry.current.values()].some(control => control.dirty())
  const notesDirty = [...registry.current.entries()].some(([key, control]) => key !== 'reading-position' && control.dirty())
  useEffect(() => {
    if (!dirty) return
    const before = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    const hidden = () => { if (document.visibilityState === 'hidden' && enabled) registry.current.forEach(control => { void control.flush() }) }
    window.addEventListener('beforeunload', before); document.addEventListener('visibilitychange', hidden)
    return () => { window.removeEventListener('beforeunload', before); document.removeEventListener('visibilitychange', hidden) }
  }, [dirty, enabled, saveTick])
  useEffect(() => { setPageInput(String(state.draft.page_number)) }, [state.draft.page_number])
  useEffect(() => { if (reader.position && !queue.dirty() && reader.position.revision > (queue.snapshot().remote?.revision || 0)) queue.adopt(reader.position, positionValue(reader.position)) }, [reader.position, queue])
  useEffect(() => {
    let active = true
    async function load() {
      const items: Annotation[] = []
      for (let page = 1; active; page++) {
        const list = await api<PageList<Annotation>>(`/papers/${paper.id}/annotations?page_number=${state.draft.page_number}&page=${page}&page_size=200`)
        if (!active) return
        items.push(...list.items)
        if (items.length >= list.total) break
      }
      if (active) { setAnnotations(items); setRecordError('') }
    }
    setAnnotations([]); void load().catch(cause => { if (active) setRecordError((cause as Error).message) })
    return () => { active = false }
  }, [paper.id, state.draft.page_number, recordTick, enabled])
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return
    const connection = new BroadcastChannel('paperboard-reading-records'); channel.current = connection
    connection.onmessage = event => { if (event.data?.paper_id === paper.id) setOtherPageNotice(true) }
    return () => { connection.close(); channel.current = null }
  }, [paper.id])
  function announce() { channel.current?.postMessage({ paper_id: paper.id, changed: true }); onOpened() }
  function change(value: PositionValue) { setReadyPage(0); queue.set(value); setSelection(null) }
  function go(page: number, annotationId?: string, hit?: SearchHit) {
    if (!Number.isInteger(page) || page < 1 || page > paper.page_count) { setMessage(`请输入 1～${paper.page_count} 范围内的页码。`); setPageInput(String(state.draft.page_number)); return }
    setMessage(''); setFocusAnnotation(annotationId || null); setSearchHit(hit || null)
    if (page !== state.draft.page_number) change({ ...state.draft, page_number: page })
  }
  function createHighlight(color: Color, comment?: string) {
    if (!selection) return
    setHighlightDrafts(previous => [...previous, { key: crypto.randomUUID(), selection, color, comment }]); setSelection(null); setNotesVisible(true); window.getSelection()?.removeAllRanges()
  }
  function highlightSaved(result: AnnotationResult, key: string) { setHighlightDrafts(previous => previous.filter(draft => draft.key !== key)); notifyChange(); announce() }
  useEffect(() => { if (openAt) go(openAt.page) }, [openAt?.nonce])
  const source = reader.page_sources.find(item => item.page_number === state.draft.page_number)
  const readOnly = reader.read_only
  return <section className="reader-workspace">
    <div className="reader-toolbar"><button className="icon-button" aria-label="PDF 上一页" disabled={!pdf || state.draft.page_number <= 1} onClick={() => go(state.draft.page_number - 1)}><ChevronLeft size={17} /></button><label className="reader-page-control"><input aria-label="PDF 页码" inputMode="numeric" value={pageInput} disabled={!pdf} onChange={event => setPageInput(event.target.value)} onBlur={() => go(Number(pageInput))} onKeyDown={event => { if (event.key === 'Enter') go(Number(pageInput)) }} /><span>／{paper.page_count} 页</span></label><button className="icon-button" aria-label="PDF 下一页" disabled={!pdf || state.draft.page_number >= paper.page_count} onClick={() => go(state.draft.page_number + 1)}><ChevronRight size={17} /></button><button className={`button compact secondary ${state.draft.zoom_mode === 'fit_width' ? 'active' : ''}`} disabled={!pdf} onClick={() => change({ ...state.draft, zoom_mode: 'fit_width', zoom: null })}>适应宽度</button><button className="icon-button" aria-label="缩小 PDF" disabled={!pdf || (state.draft.zoom_mode === 'custom' && state.draft.zoom! <= .5)} onClick={() => change({ ...state.draft, zoom_mode: 'custom', zoom: Math.max(.5, Math.round(((state.draft.zoom || renderScale) - .25) * 4) / 4) })}><Minus size={15} /></button><select aria-label="PDF 缩放比例" value={state.draft.zoom_mode === 'fit_width' ? 'fit' : String(state.draft.zoom)} disabled={!pdf} onChange={event => event.target.value === 'fit' ? change({ ...state.draft, zoom_mode: 'fit_width', zoom: null }) : change({ ...state.draft, zoom_mode: 'custom', zoom: Number(event.target.value) })}><option value="fit">适应宽度</option>{[.5, .75, 1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 2.75, 3].map(value => <option key={value} value={value}>{Math.round(value * 100)}%</option>)}</select><button className="icon-button" aria-label="放大 PDF" disabled={!pdf || (state.draft.zoom_mode === 'custom' && state.draft.zoom! >= 3)} onClick={() => change({ ...state.draft, zoom_mode: 'custom', zoom: Math.min(3, Math.max(.5, Math.round(((state.draft.zoom || renderScale) + .25) * 4) / 4)) })}><Plus size={15} /></button><button className="icon-button" aria-label="顺时针旋转 PDF" disabled={!pdf} onClick={() => change({ ...state.draft, view_rotation: (state.draft.view_rotation + 90) % 360 })}><RotateCw size={17} /></button><span className="reader-toolbar-spacer" /><button className={`button compact secondary ${panel === 'navigation' ? 'active' : ''}`} disabled={!pdf} onClick={() => setPanel(panel === 'navigation' ? null : 'navigation')}><PanelLeft size={14} />导航</button><button className={`button compact secondary ${panel === 'search' ? 'active' : ''}`} disabled={!pdf} onClick={() => setPanel(panel === 'search' ? null : 'search')}><Search size={14} />搜索</button><button className={`button compact secondary ${notesVisible ? 'active' : ''}`} onClick={() => setNotesVisible(!notesVisible)}><NotebookPen size={14} />记录</button></div>
    {(message || recordError) && <p className="reader-text-notice" role="alert">{message || recordError}</p>}
    {otherPageNotice && <p className="reader-text-notice">其他页面更新了这篇论文的记录，保存时会检查版本。<button className="text-button" onClick={() => { notifyChange(); setOtherPageNotice(false) }}>刷新记录</button></p>}
    <div className={`reader-body ${panel ? 'with-navigation' : ''} ${notesVisible ? 'with-notes' : ''}`}>
      {pdf && panel === 'navigation' && <ReaderNavigation pdf={pdf} current={state.draft.page_number} go={go} />}
      {pdf && panel === 'search' && <ReaderSearch pdf={pdf} current={state.draft.page_number} onHit={hit => go(hit.page, undefined, hit)} />}
      {pdf ? <PdfPage pdf={pdf} value={state.draft} source={source} annotations={annotations} readOnly={readOnly || !enabled} onReady={(page, scale) => { setReadyPage(page); setRenderScale(scale) }} onSelection={next => setSelection(previous => next && previous && JSON.stringify(next) === JSON.stringify(previous) ? previous : next)} searchHit={searchHit} focusAnnotation={focusAnnotation} selectionActions={selection && <SelectionToolbar key={`${selection.page_number}-${selection.quote}`} selection={selection} onCreate={createHighlight} onClose={() => { setSelection(null); window.getSelection()?.removeAllRanges() }} />} /> : <div className="reader-document-empty">{loading ? <p>正在加载原文…</p> : <><p role="alert">{fileError || '原文文件缺失，已有笔记仍可查看。请检查数据目录或恢复备份。'}</p><button className="button secondary" onClick={onReload}>重新加载原文</button><a className="button secondary" href={`/api/v1/papers/${paper.id}/file?download=true`}>下载原文检查</a></>}</div>}
      <div className="reader-notes-holder" style={{ display: notesVisible ? undefined : 'none' }}><NotesPanel paper={paper} currentPage={state.draft.page_number} annotations={annotations} register={register} enabled={enabled} readOnly={readOnly} onChanged={() => { notifyChange(); announce() }} onGo={go} reload={recordTick} drafts={highlightDrafts} onHighlightSaved={highlightSaved} /></div>
    </div>
    <footer className="reader-statusbar"><span>上次读到第 {state.remote?.page_number || reader.position?.page_number || 1} 页</span>{readOnly ? <span>回收站只读</span> : <><SaveStatus phase={state.phase} error={state.error} savedAt={state.savedAt} onRetry={queue.retry} /><span className={notesDirty ? 'reader-unsaved' : ''}>{notesDirty ? '个人记录尚未全部保存' : '个人记录已保存'}</span></>}{state.phase === 'conflict' && <button className="text-button" onClick={() => setComparePosition(true)}>选择继续位置</button>}<button className="text-button" onClick={onReload}>重新加载原文／页面准备</button></footer>
    <p className="reader-file-note">记录独立保存在本机。下载的原 PDF 不包含本应用高亮；尚未保存的草稿仅保留在当前页面。</p>
    {comparePosition && state.current && <Modal title="选择继续阅读位置" onClose={() => setComparePosition(false)}><div className="modal-body"><p>当前页面：第 {state.draft.page_number} 页；服务器已保存：第 {state.current.page_number} 页。</p><p>位置选择不会覆盖个人笔记。</p></div><footer className="modal-footer"><button className="button secondary" onClick={() => { queue.adopt(state.current!, positionValue(state.current!)); setComparePosition(false) }}>采用已保存位置</button><button className="button primary" onClick={() => setConfirmPosition(true)}>继续当前页</button></footer></Modal>}
    {confirmPosition && state.current && <Confirm title="保存当前阅读位置？" description="服务器上的继续阅读位置将更新为当前页，个人笔记保持原有内容。" action="继续当前页" busy={false} onClose={() => setConfirmPosition(false)} onConfirm={() => { queue.overwrite(state.current!); setConfirmPosition(false); setComparePosition(false) }} />}
  </section>
})

export default forwardRef<ReaderHandle, { paper: Paper; enabled: boolean; onOpened: () => void; openAt?: {page:number;nonce:number} | null }>(function ReaderWorkspace({ paper, enabled, onOpened, openAt }, ref) {
  const [reader, setReader] = useState<ReaderOpen | null>(null), [pdf, setPdf] = useState<PDFDocumentProxy | null>(null), [error, setError] = useState(''), [fileError, setFileError] = useState(''), [loading, setLoading] = useState(true), [reload, setReload] = useState(0)
  const session = useRef<ReaderHandle>(null), openedCallback = useRef(onOpened); openedCallback.current = onOpened
  useImperativeHandle(ref, () => ({ dirty: () => session.current?.dirty() || false, flush: async () => session.current?.flush() ?? true, text: () => session.current?.text() || '', retry: () => session.current?.retry() }), [])
  useEffect(() => {
    let active = true
    let loaded: PDFDocumentProxy | null = null
    setLoading(true); setFileError(''); setError(''); setPdf(null)
    const task = getDocument({ url: `/api/v1/papers/${paper.id}/file`, withCredentials: true, cMapUrl: '/pdfjs/cmaps/', cMapPacked: true, standardFontDataUrl: '/pdfjs/standard_fonts/', wasmUrl: '/pdfjs/wasm/' })
    task.promise.then(document => { loaded = document; if (active) { if (document.numPages !== paper.page_count) setFileError('原文页数与论文记录不一致，请检查文件版本。已有笔记仍可查看。'); else setPdf(document) } }).catch(cause => { if (!active) return; if (cause?.status === 401) window.dispatchEvent(new Event('paperboard-auth-expired')); setFileError('原文加载失败，已有笔记仍可查看。可以重试加载或下载原文检查。') }).finally(() => { if (active) setLoading(false) })
    api<ReaderOpen>(`/papers/${paper.id}/reader-open`, { method: 'POST' }).then(result => { if (active) { setReader(result); openedCallback.current() } }).catch(cause => { if (active) setError((cause as Error).message) })
    return () => { active = false; if (loaded) clearPageCache(loaded); task.destroy().catch(() => {}) }
  }, [paper.id, reload])
  if (!reader) return <div className="reader-document-empty">{error ? <><p role="alert">{error}</p><button className="button secondary" onClick={() => setReload(value => value + 1)}>重试打开阅读</button></> : <p>正在恢复阅读位置与页面信息…</p>}</div>
  return <><p className="reader-open-notice" role="status">已继续上次阅读：第 {reader.position?.page_number || 1} 页。</p>{error && <p className="reader-text-notice">{error}</p>}<ReaderSession ref={session} paper={paper} reader={reader} pdf={pdf} fileError={fileError} loading={loading} enabled={enabled} onReload={() => setReload(value => value + 1)} onOpened={() => openedCallback.current()} openAt={openAt} /></>
})
