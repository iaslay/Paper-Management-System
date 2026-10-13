import { forwardRef, lazy, Suspense, useEffect, useImperativeHandle, useRef, useState, type FormEvent } from 'react'
import { Download, ExternalLink, FileText, Save, CalendarDays, BookOpen, Sparkles } from 'lucide-react'
import { readingApi, ApiError, dateText, sizeText, statusNames, kindNames, type Kind, type Paper, type Tag, type ReadingStatus } from './api'
import { Modal, LabelPicker, Confirm } from './components'
import type { ReaderHandle } from './reader/types'
import MetadataAssist, { type MetadataResult } from './ai/MetadataAssist'
const ReaderWorkspace = lazy(() => import('./reader/ReaderWorkspace'))
const CardPanel = lazy(() => import('./ai/CardPanel'))
export interface DetailHandle { requestClose: (after?: () => void) => void }
interface PendingLabel { name: string; kind: Kind; reason: string; selected: boolean }

export default forwardRef<DetailHandle, { paper: Paper; tags: Tag[]; preview: boolean; initialTab?: 'info' | 'preview' | 'card'; enabled: boolean; onClose: () => void; onSaved: (paper: Paper) => void; onRead: () => void; onOpened: () => void; onModelSettings: () => void }>(function PaperDetail({ paper, tags, preview, initialTab, enabled, onClose, onSaved, onRead, onOpened, onModelSettings }, ref) {
  const [tab, setTab] = useState(initialTab || (preview ? 'preview' : 'info'))
  const [title, setTitle] = useState(paper.title)
  const [authors, setAuthors] = useState(paper.authors.join('；'))
  const [year, setYear] = useState(paper.year?.toString() || '')
  const [doi, setDoi] = useState(paper.doi || '')
  const [status, setStatus] = useState<ReadingStatus>(paper.reading_status)
  const [directions, setDirections] = useState(paper.research_directions.map(tag => tag.id))
  const [general, setGeneral] = useState(paper.tags.map(tag => tag.id))
  const [topics, setTopics] = useState(paper.topics.map(tag => tag.id))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(false)
  const [pendingLabels, setPendingLabels] = useState<PendingLabel[]>([]), [metadataNotice, setMetadataNotice] = useState('')
  const info = { title, authors, year, doi, status, directions, general, topics, newLabels: pendingLabels.filter(label => label.selected).map(({name,kind}) => ({name:name.trim(),kind})) }
  const currentInfo = useRef(info); currentInfo.current = info
  const metadataStart = useRef(info), pendingSave = useRef<{body:unknown;snapshot:string} | null>(null)
  const [readerStarted, setReaderStarted] = useState(preview), [leave, setLeave] = useState(false), [discard, setDiscard] = useState(false), [copyContent, setCopyContent] = useState('')
  const reader = useRef<ReaderHandle>(null), afterLeave = useRef<() => void>(onClose)
  const card = useRef<ReaderHandle>(null), [cardStarted,setCardStarted] = useState(initialTab === 'card'), [openAt,setOpenAt] = useState<{page:number;nonce:number} | null>(null)
  const baseline = useRef(JSON.stringify({ title: paper.title, authors: paper.authors.join('；'), year: paper.year?.toString() || '', doi: paper.doi || '', status: paper.reading_status, directions: paper.research_directions.map(t => t.id), general: paper.tags.map(t => t.id), topics: paper.topics.map(t => t.id) }))
  const lastStatus = useRef(paper.reading_status)
  const lastPaper = useRef(paper)
  useEffect(() => {
    if (lastStatus.current !== paper.reading_status) {
      const old = JSON.parse(baseline.current)
      old.status = paper.reading_status; baseline.current = JSON.stringify(old)
      const previousStatus = lastStatus.current
      setStatus(current => current === previousStatus ? paper.reading_status : current)
      lastStatus.current = paper.reading_status
    }
  }, [paper.reading_status])
  useEffect(() => {
    const previous=lastPaper.current
    if (previous.revision===paper.revision)return
    setTitle(current => current === previous.title ? paper.title : current)
    setAuthors(current => current === previous.authors.join('；') ? paper.authors.join('；') : current)
    setYear(current => current === (previous.year?.toString() || '') ? paper.year?.toString() || '' : current)
    setDoi(current => current === (previous.doi || '') ? paper.doi || '' : current)
    const oldDirections=previous.research_directions.map(tag=>tag.id),nextDirections=paper.research_directions.map(tag=>tag.id)
    const oldGeneral=previous.tags.map(tag=>tag.id),nextGeneral=paper.tags.map(tag=>tag.id),oldTopics=previous.topics.map(tag=>tag.id),nextTopics=paper.topics.map(tag=>tag.id)
    setDirections(current=>JSON.stringify(current)===JSON.stringify(oldDirections)?nextDirections:current)
    setGeneral(current=>JSON.stringify(current)===JSON.stringify(oldGeneral)?nextGeneral:current)
    setTopics(current=>JSON.stringify(current)===JSON.stringify(oldTopics)?nextTopics:current)
    const saved=JSON.parse(baseline.current);saved.title=paper.title;saved.authors=paper.authors.join('；');saved.year=paper.year?.toString() || '';saved.doi=paper.doi || '';saved.directions=nextDirections;saved.general=nextGeneral;saved.topics=nextTopics;baseline.current=JSON.stringify(saved)
    lastPaper.current=paper
  }, [paper.revision])
  const infoDirty = !paper.deleted_at && (baseline.current !== JSON.stringify({ title, authors, year, doi, status, directions, general, topics }) || info.newLabels.length > 0)
  function fillMetadata(result: MetadataResult) {
    const before = metadataStart.current, current = currentInfo.current
    let filled = 0, skipped = 0
    for (const field of ['title','authors','year','doi'] as const) {
      const value = result.fields[field].value
      if (value === null || (Array.isArray(value) && !value.length)) continue
      if (JSON.stringify(current[field]) !== JSON.stringify(before[field])) { skipped++; continue }
      if (field === 'title') setTitle(value as string)
      else if (field === 'authors') setAuthors((value as string[]).join('；'))
      else if (field === 'year') setYear(String(value))
      else setDoi(value as string)
      filled++
    }
    const nextIds = { research_direction:[...current.directions], general:[...current.general], topic:[...current.topics] }, newLabels: PendingLabel[] = [], preserved = new Set<Kind>()
    const groupKeys = { research_direction:'directions', general:'general', topic:'topics' } as const
    for (const kind of ['research_direction','topic','general'] as const) {
      const key = groupKeys[kind]
      if (JSON.stringify(current[key]) !== JSON.stringify(before[key]) || JSON.stringify(current.newLabels.filter(label=>label.kind===kind)) !== JSON.stringify(before.newLabels.filter(label=>label.kind===kind))) { skipped++; preserved.add(kind); continue }
      for (const candidate of result.classifications.filter(label => label.kind === kind)) {
        const existing = candidate.tag_id && tags.some(tag=>tag.id===candidate.tag_id && tag.kind===kind && !tag.deleted_at)
        const count = nextIds[kind].length + newLabels.filter(label=>label.kind===kind && label.selected).length
        const total = nextIds.research_direction.length + nextIds.general.length + newLabels.filter(label=>label.kind!=='topic' && label.selected).length
        const available = count < (kind==='general'?20:10) && (kind==='topic' || total < 20)
        if (existing) { if (!nextIds[kind].includes(candidate.tag_id!) && available) nextIds[kind].push(candidate.tag_id!) }
        else newLabels.push({name:candidate.name,kind,reason:candidate.reason,selected:available})
      }
    }
    setDirections(nextIds.research_direction);setGeneral(nextIds.general);setTopics(nextIds.topic)
    setPendingLabels(previous => [...previous.filter(label=>preserved.has(label.kind)), ...newLabels])
    setMetadataNotice(`AI 已填入 ${filled} 个信息字段；未识别字段保持原值。${skipped ? `保留了 ${skipped} 处等待期间的修改。` : ''}请核对后保存。`);setSuccess(false)
  }
  useEffect(() => { if (!infoDirty) return; const warning = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }; window.addEventListener('beforeunload', warning); return () => window.removeEventListener('beforeunload', warning) }, [infoDirty])
  async function requestClose(after = onClose) {
    if (busy) return
    afterLeave.current = after
    const controls=[reader.current,card.current].filter((control):control is ReaderHandle=>!!control && control.dirty())
    const saved = !controls.length || await Promise.race([Promise.all(controls.map(control=>control.flush())).then(results=>results.every(Boolean)), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 5000))])
    if (infoDirty || !saved) { setLeave(true); return }
    after()
  }
  useImperativeHandle(ref, () => ({ requestClose: after => { void requestClose(after) } }))
  async function saveInfo() {
    if (busy || !enabled || paper.deleted_at) return false
    setBusy(true); setError(''); setSuccess(false)
    if (!pendingSave.current) pendingSave.current = { snapshot:JSON.stringify(currentInfo.current), body:{request_id:crypto.randomUUID().replaceAll('-',''),file_hash:paper.file_hash,revision:paper.revision,title,authors:authors.split(/[;；\n]+/).map(name=>name.trim()).filter(Boolean),year:year?Number(year):null,doi:doi||null,reading_status:status,research_direction_ids:directions,tag_ids:general,topic_ids:topics,new_labels:info.newLabels} }
    const pending = pendingSave.current
    try {
      const result = await readingApi<Paper & {resolved_labels:{name:string;kind:Kind;id:number}[]}>(`/papers/${paper.id}`, { method: 'PATCH', body: JSON.stringify(pending.body) })
      const unchanged = JSON.stringify(currentInfo.current) === pending.snapshot
      if (unchanged) { setTitle(result.title);setAuthors(result.authors.join('；'));setDoi(result.doi || '');setYear(result.year?.toString() || '');setStatus(result.reading_status);setDirections(result.research_directions.map(t=>t.id));setGeneral(result.tags.map(t=>t.id));setTopics(result.topics.map(t=>t.id));setPendingLabels([]);setSuccess(true);setMetadataNotice('') }
      else {
        for (const kind of ['research_direction','general','topic'] as const) {
          const ids = (result.resolved_labels || []).filter(label=>label.kind===kind && currentInfo.current.newLabels.some(candidate=>candidate.kind===kind && candidate.name===label.name)).map(label=>label.id)
          const setter = kind==='research_direction'?setDirections:kind==='general'?setGeneral:setTopics
          setter(previous=>[...new Set([...previous,...ids])])
        }
        setPendingLabels(previous=>previous.filter(label=>!(result.resolved_labels || []).some(saved=>saved.kind===label.kind && saved.name===label.name.trim())))
        setMetadataNotice('上次提交的信息已保存，之后的修改仍保留，请继续保存。')
      }
      pendingSave.current = null
      baseline.current = JSON.stringify({ title: result.title, authors: result.authors.join('；'), year: result.year?.toString() || '', doi: result.doi || '', status: result.reading_status, directions: result.research_directions.map(t => t.id), general: result.tags.map(t => t.id), topics: result.topics.map(t => t.id) }); onSaved(result); return unchanged
    } catch (cause) { setError((cause as Error).message); if(cause instanceof ApiError && cause.status<500 && cause.status!==401)pendingSave.current=null; return false }
    finally { setBusy(false) }
  }
  async function save(event: FormEvent) { event.preventDefault(); await saveInfo() }
  async function retryLeave() { if (infoDirty && !await saveInfo()) return; for(const control of [reader.current,card.current])if(control?.dirty() && !await control.flush())return; setLeave(false); afterLeave.current() }
  function renderPendingLabels(kind: Kind) {
    const pendingCount = pendingLabels.filter(label=>label.kind===kind && label.selected).length
    const existingCount = kind==='research_direction'?directions.length:kind==='topic'?topics.length:general.length
    const total = directions.length+general.length+pendingLabels.filter(label=>label.kind!=='topic' && label.selected).length
    return <div className="metadata-new-labels">{pendingLabels.map((label,index)=>label.kind===kind && <div key={`${kind}-${index}`}><label><input type="checkbox" checked={label.selected} disabled={!label.selected && (existingCount+pendingCount>=(kind==='general'?20:10) || (kind!=='topic' && total>=20))} onChange={event=>setPendingLabels(previous=>previous.map((value,i)=>i===index?{...value,selected:event.target.checked}:value))} /><span>新建{kindNames[kind]}：{label.name}<small>{label.reason} · 保存信息时创建</small></span></label><input aria-label={`待新建${kindNames[kind]}名称 ${index+1}`} value={label.name} maxLength={kind==='topic'?50:30} onChange={event=>setPendingLabels(previous=>previous.map((value,i)=>i===index?{...value,name:event.target.value}:value))} /></div>)}</div>
  }
  return <><Modal title={paper.deleted_at ? '回收站中的论文' : tab === 'preview' ? paper.title : '论文详情'} subtitle={`${paper.page_count} 页 · ${sizeText(paper.file_size)} · ${dateText(paper.created_at)} 加入`} wide className={tab === 'preview' ? 'reader-modal' : ''} onClose={() => void requestClose()}>
    <div className="detail-tabs"><button className={tab === 'info' ? 'active' : ''} onClick={() => setTab('info')}><FileText size={16} />论文信息</button><button className={tab === 'preview' ? 'active' : ''} onClick={() => { setTab('preview'); setReaderStarted(true); if (!paper.deleted_at) onRead() }}><BookOpen size={16} />阅读与记录</button><button className={tab==='card'?'active':''} onClick={()=>{setTab('card');setCardStarted(true)}}><Sparkles size={16} />简介卡片</button><a className="button compact secondary" href={`/api/v1/papers/${paper.id}/file?download=true`}><Download size={14} />下载原文</a></div>
    {readerStarted && <div style={{ display: tab === 'preview' ? undefined : 'none' }}><Suspense fallback={<div className="pdf-loading">正在准备阅读器…</div>}><ReaderWorkspace ref={reader} paper={paper} enabled={enabled} onOpened={onOpened} openAt={openAt} /></Suspense></div>}
    {cardStarted && <div style={{display:tab==='card'?undefined:'none'}}><Suspense fallback={<div className="pdf-loading">正在加载简介卡片…</div>}><CardPanel ref={card} paper={paper} enabled={enabled} active={tab==='card'} onChanged={onOpened} onPaperChanged={onSaved} onSettings={onModelSettings} onGo={page=>{setOpenAt({page,nonce:Date.now()});setTab('preview');setReaderStarted(true);if(!paper.deleted_at)onRead()}} /></Suspense></div>}
    <form onSubmit={save} style={{ display: tab === 'info' ? undefined : 'none' }}>
      <MetadataAssist paperId={paper.id} active={tab==='info'} enabled={enabled} readOnly={!!paper.deleted_at || busy} onStart={()=>{metadataStart.current=structuredClone(currentInfo.current)}} onFill={fillMetadata} onSettings={onModelSettings} onGo={page=>{setOpenAt({page,nonce:Date.now()});setTab('preview');setReaderStarted(true);if(!paper.deleted_at)onRead()}} />
      {metadataNotice && <div className="detail-notice"><p className="ai-notice" role="status">{metadataNotice}</p></div>}
      <fieldset disabled={busy || !!paper.deleted_at} className="detail-form"><div className="detail-main"><label>论文标题<textarea required rows={3} maxLength={500} value={title} onChange={event => { setTitle(event.target.value); setSuccess(false) }} /></label><label>作者<input value={authors} maxLength={10100} placeholder="多位作者用分号分隔" onChange={event => setAuthors(event.target.value)} /></label><div className="two-fields"><label>发表年份<input type="number" min={1500} max={new Date().getFullYear() + 1} value={year} placeholder="未填写" onChange={event => setYear(event.target.value)} /></label><label>阅读状态<select value={status} onChange={event => setStatus(event.target.value as ReadingStatus)}>{Object.entries(statusNames).map(([value, name]) => <option value={value} key={value}>{name}</option>)}</select></label></div><label>DOI<input maxLength={200} value={doi} onChange={event => setDoi(event.target.value)} placeholder="未填写" /></label><div className="file-facts"><CalendarDays size={15} />文件：{paper.original_filename}</div></div>
      <div className="detail-labels"><section><h3>研究方向</h3><p className="muted small">这篇论文属于哪些研究领域？</p><LabelPicker max={10-pendingLabels.filter(label=>label.kind==='research_direction' && label.selected).length} tags={tags.filter(tag => tag.kind === 'research_direction')} selected={directions} onChange={setDirections} />{renderPendingLabels('research_direction')}</section><section><h3>主题</h3><LabelPicker max={10-pendingLabels.filter(label=>label.kind==='topic' && label.selected).length} tags={tags.filter(tag => tag.kind === 'topic')} selected={topics} onChange={setTopics} />{renderPendingLabels('topic')}</section><section><h3>普通标签</h3><LabelPicker max={20-directions.length-pendingLabels.filter(label=>label.kind!=='topic' && label.selected).length} tags={tags.filter(tag => tag.kind === 'general')} selected={general} onChange={setGeneral} />{renderPendingLabels('general')}</section></div></fieldset>
      {(error || success) && <div className="detail-notice">{error ? <div className="error-message" role="alert">{error}</div> : <div className="success-message" role="status">论文信息与分类已保存。</div>}</div>}
      <footer className="modal-footer"><span className="muted small">{paper.deleted_at ? '恢复论文后可以编辑信息。' : '从 PDF 文件信息提取的标题与作者，可以在这里修正。'}</span><button className="button secondary" type="button" disabled={busy} onClick={() => void requestClose()}>关闭</button>{!paper.deleted_at && <button className="button primary" disabled={busy || !enabled}><Save size={15} />{busy ? '正在保存…' : '保存信息'}</button>}</footer>
    </form>
  </Modal>{leave && <Modal title="处理未保存的内容" onClose={() => setLeave(false)}><div className="modal-body"><p>阅读位置、个人记录、简介卡片或论文信息尚未全部保存。请重试保存，或复制内容后再离开。</p>{error && <p className="error-message">{error}</p>}{copyContent && <textarea aria-label="未保存内容副本" readOnly value={copyContent} rows={7} onFocus={event => event.currentTarget.select()} />}</div><footer className="modal-footer"><button className="button secondary" onClick={() => setLeave(false)}>继续编辑</button><button className="button secondary" onClick={() => setCopyContent(`${infoDirty ? `论文信息\n标题：${title}\n作者：${authors}\n年份：${year}\nDOI：${doi}\n` : ''}${reader.current?.text() || ''}${card.current?.dirty()?`\n\n简介卡片\n${card.current.text()}`:''}`)}>复制未保存内容</button><button className="button primary" disabled={busy || !enabled} onClick={() => void retryLeave()}>重试保存并离开</button><button className="text-button danger-text" onClick={() => setDiscard(true)}>放弃未保存内容并离开</button></footer></Modal>}{discard && <Confirm title="放弃未保存内容？" description="服务端已经保存的内容会保留，尚未提交的编辑将无法在关闭后恢复。" action="放弃并离开" danger busy={false} onClose={() => setDiscard(false)} onConfirm={() => { setLeave(false); setDiscard(false); afterLeave.current() }} />}</>
})
