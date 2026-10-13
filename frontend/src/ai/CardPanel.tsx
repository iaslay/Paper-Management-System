import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { api, readingApi, ApiError, dateText, type Paper } from '../api'
import { Confirm, Modal } from '../components'
import type { Note, PageList, PageSource, ReaderHandle } from '../reader/types'
import { emptyCard, normalizeDirection, originNames, typeNames, stageNames, type CardData, type CardState, type CardVersion, type Claim, type Evidence, type ModelSettings, type CardTask } from './types'
import './ai.css'

const activeStatuses = new Set(['queued', 'running', 'waiting_retry'])
const fields = [['summary','一句话简介',150], ['research_question','研究问题',200], ['method','研究方法',400]] as const
const groups = [['contributions','作者贡献',200], ['findings','主要结果',250], ['limitations','局限与疑问',200]] as const
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value))

function EvidenceList({ claim, onGo }: { claim: Claim; onGo: (page: number) => void }) {
  if (!claim.evidence.length) return <span className="ai-source-missing">暂无来源引用</span>
  return <details className="ai-evidence"><summary>{claim.evidence.length} 条来源 · {claim.evidence.every(ref => ref.verification === 'user_checked') ? '已人工核对' : '待核对'}</summary>{claim.evidence.map((ref,index) => <div className="ai-evidence-item" key={index}>{ref.page_number ? <button className="text-button" onClick={() => onGo(ref.page_number!)}>原文第 {ref.page_number} 页 ↗</button> : <span>选中的个人记录</span>}<small>{ref.verification === 'user_checked' ? '已人工核对' : '模型识读／引用待核对'}</small>{ref.excerpt && <blockquote>{ref.excerpt}</blockquote>}{ref.description && <p>{ref.description}</p>}</div>)}</details>
}

function ClaimEditor({ label, limit, value, sources, onChange, onGo }: { label: string; limit: number; value: Claim; sources: PageSource[]; onChange: (value: Claim) => void; onGo: (page: number) => void }) {
  const [page, setPage] = useState(''), [error, setError] = useState('')
  function addSource() {
    const source = sources.find(source => source.page_number === Number(page))
    if (!source) { setError('请填写原文有效页码；若尚无来源，请先打开原文准备页面。'); return }
    if (value.evidence.length >= 3) return
    onChange({ ...value, evidence: [...value.evidence, { page_source_id: source.id, page_number: source.page_number, note_id: null, excerpt: '', description: '', verification: 'unverified' }] }); setError(''); setPage('')
  }
  function updateRef(index: number, change: Partial<Evidence>) { onChange({ ...value, evidence: value.evidence.map((ref,i) => i === index ? { ...ref, ...change } : ref) }) }
  return <section className="ai-claim-editor"><label>{label}<textarea aria-label={`卡片${label}`} rows={label === '研究方法' ? 4 : 3} maxLength={limit} value={value.text} onChange={event => onChange({ ...value, text: event.target.value, origin: 'user_record', evidence: value.evidence.map(ref => ({ ...ref, verification: 'unverified' })) })} /></label><small>{value.text.length}／{limit} 字符 · {originNames[value.origin]}</small><details><summary>来源引用与核对</summary>{value.evidence.map((ref,index) => <div className="ai-evidence-edit" key={index}><div className="ai-inline">{ref.page_number ? <button type="button" className="text-button" onClick={() => onGo(ref.page_number!)}>原文第 {ref.page_number} 页 ↗</button> : <span>个人记录来源</span>}<button className="text-button danger-text" onClick={() => onChange({ ...value, evidence: value.evidence.filter((_,i) => i !== index) })}>移除来源</button></div><textarea aria-label={`${label}来源摘录 ${index+1}`} rows={2} value={ref.excerpt} maxLength={500} placeholder="摘录或图表说明，需与原文核对" onChange={event => updateRef(index,{ excerpt:event.target.value,verification:'unverified' })} /><label className="ai-check"><input type="checkbox" checked={ref.verification === 'user_checked'} onChange={event => updateRef(index,{verification:event.target.checked ? 'user_checked' : 'unverified'})} />我已核对这条来源</label></div>)}{value.evidence.length < 3 && <div className="ai-add-source"><input aria-label={`${label}来源页码`} inputMode="numeric" value={page} onChange={event => setPage(event.target.value)} placeholder="原文页码" /><button type="button" className="button compact secondary" onClick={addSource}>添加{label}来源</button></div>}{error && <p className="error-message">{error}</p>}</details></section>
}

export default forwardRef<ReaderHandle, { paper: Paper; enabled: boolean; active: boolean; onGo: (page: number) => void; onSettings: () => void; onChanged: () => void; onPaperChanged: (paper: Paper) => void }>(function CardPanel({ paper, enabled, active, onGo, onSettings, onChanged, onPaperChanged }, ref) {
  const [state, setState] = useState<CardState | null>(null), [config, setConfig] = useState<ModelSettings | null>(null), [tasks, setTasks] = useState<CardTask[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null), [editing, setEditing] = useState(false), [draft, setDraft] = useState<CardData>(emptyCard), [baseline, setBaseline] = useState(''), [baseId, setBaseId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false), [generating, setGenerating] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [discard, setDiscard] = useState(false), [conflict, setConflict] = useState<CardState | null>(null)
  const [sources,setSources] = useState<PageSource[]>([]), [notes,setNotes] = useState<Note[]>([]), [notesTotal,setNotesTotal] = useState(0), [notePage,setNotePage] = useState(0), [noteIds,setNoteIds] = useState<string[]>([])
  const [newDirection,setNewDirection] = useState<{index:number;version:CardVersion} | null>(null)
  const pendingSave = useRef<{body:unknown;snapshot:string} | null>(null), saving = useRef<Promise<boolean> | null>(null), pendingGenerate = useRef<{request_id:string;regenerate:boolean;note_ids:string[]} | null>(null), pendingDecision = useRef<{path:string;body:unknown} | null>(null)
  const current = useRef({draft,baseline,editing,baseId,state,enabled}); current.current = {draft,baseline,editing,baseId,state,enabled}
  const selected = state?.versions.find(version => version.id === selectedId) || state?.versions.find(version => version.id === state.current_version_id) || state?.versions[0]
  const dirty = editing && JSON.stringify(draft) !== baseline
  const readOnly = !!paper.deleted_at || !enabled
  const task = tasks.find(task => activeStatuses.has(task.status)) || tasks[0]
  const mounted = useRef(true), requestedTask = useRef<string | null>(null)

  async function load(signal?: AbortSignal) {
    try {
      const [card,jobs,settings] = await Promise.all([api<CardState>(`/papers/${paper.id}/card`,{signal}), api<CardTask[]>(`/papers/${paper.id}/card-tasks`,{signal}), api<ModelSettings>('/settings/model',{signal})])
      if (!mounted.current || signal?.aborted) return
      setState(card); setTasks(jobs); setConfig(settings)
      if (!current.current.editing) setSelectedId(previous => previous && card.versions.some(version => version.id === previous) ? previous : card.current_version_id || card.versions[0]?.id || null)
    } catch (cause) { if (mounted.current && !signal?.aborted) setError((cause as Error).message) }
  }
  useEffect(() => {
    mounted.current = true
    if (!enabled || !active) return
    const abort = new AbortController(); void load(abort.signal)
    const settingsChanged = () => { void load(abort.signal) }
    window.addEventListener('paperboard-model-changed',settingsChanged)
    return () => { abort.abort(); window.removeEventListener('paperboard-model-changed',settingsChanged) }
  }, [paper.id,enabled,active])
  useEffect(() => () => { mounted.current = false }, [])
  useEffect(() => {
    if (!enabled || !active || !tasks.some(task => activeStatuses.has(task.status))) return
    const abort = new AbortController()
    const timer = window.setInterval(() => { void api<CardTask[]>(`/papers/${paper.id}/card-tasks`,{signal:abort.signal}).then(async jobs => {
      if (abort.signal.aborted) return
      const done = jobs.find(job => job.id === requestedTask.current && job.status === 'succeeded')
      if (done) {
        const card = await api<CardState>(`/papers/${paper.id}/card`,{signal:abort.signal})
        if (!abort.signal.aborted) { requestedTask.current = null; setState(card); setTasks(jobs); if (!current.current.editing) setSelectedId(done.result_version_id); setNotice('新草稿已生成，请查看来源并核对后确认。'); onChanged() }
      } else if (!jobs.some(job => activeStatuses.has(job.status))) { await load(abort.signal) }
      else setTasks(jobs)
    }).catch(cause => { if (!abort.signal.aborted) setError((cause as Error).message) }) },2000)
    return () => { window.clearInterval(timer); abort.abort() }
  }, [tasks.some(task=>activeStatuses.has(task.status)),enabled,active,paper.id])
  useEffect(() => { if (!dirty) return; const before = (event:BeforeUnloadEvent) => {event.preventDefault();event.returnValue=''}; window.addEventListener('beforeunload',before); return()=>window.removeEventListener('beforeunload',before) }, [dirty])

  async function save(override?:CardState):Promise<boolean> {
    if (saving.current) return saving.current
    const value = current.current
    if (!value.editing || JSON.stringify(value.draft) === value.baseline) return true
    if (!value.enabled || paper.deleted_at || !value.state) return false
    if (!pendingSave.current) pendingSave.current = {body:{request_id:crypto.randomUUID().replaceAll('-',''),file_hash:paper.file_hash,card_revision:(override || value.state).card_revision,base_version_id:override?.current_version_id || value.baseId,data:clone(value.draft)},snapshot:JSON.stringify(value.draft)}
    const pending = pendingSave.current
    setBusy(true);setError('')
    saving.current = (async()=>{
      try {
        const result = await readingApi<{version:CardVersion;card_revision:number}>(`/papers/${paper.id}/card-versions`,{method:'POST',body:JSON.stringify(pending.body)})
        if (!mounted.current) return true
        setState(previous=>previous ? {...previous,card_revision:result.card_revision,current_version_id:previous.current_version_id || result.version.id,versions:[result.version,...previous.versions.filter(version=>version.id!==result.version.id)]} : previous)
        setBaseId(result.version.id);setSelectedId(result.version.id)
        if (JSON.stringify(current.current.draft) === pending.snapshot) { setDraft(clone(result.version.data));setBaseline(JSON.stringify(result.version.data)) }
        else setBaseline(JSON.stringify(result.version.data))
        pendingSave.current=null;setNotice('新版本已保存，核对后可确认当前卡片。');onChanged()
        return JSON.stringify(current.current.draft) === pending.snapshot
      } catch(cause) {
        if (mounted.current) {setError((cause as Error).message);if(cause instanceof ApiError && cause.code==='card_conflict' && cause.current) setConflict(cause.current as CardState)}
        if(cause instanceof ApiError && cause.status>=400 && cause.status<500 && cause.status!==401) pendingSave.current=null
        return false
      } finally {if(mounted.current)setBusy(false);saving.current=null}
    })()
    return saving.current
  }
  const actions = useRef({save,load});actions.current={save,load}
  useImperativeHandle(ref,()=>({dirty:()=>current.current.editing && JSON.stringify(current.current.draft)!==current.current.baseline,flush:()=>actions.current.save(),text:()=>JSON.stringify(current.current.draft,null,2),retry:()=>{void actions.current.save()}}),[])
  async function edit(version?:CardVersion) {
    if(readOnly)return
    const data=clone(version?.data || emptyCard());setDraft(data);setBaseline(JSON.stringify(data));setBaseId(version?.id || null);setEditing(true);setError('');setNotice('');pendingSave.current=null
    try {setSources(await api<PageSource[]>(`/papers/${paper.id}/card-sources`))} catch(cause){setError((cause as Error).message)}
  }
  async function generate(regenerate=false) {
    if(generating || readOnly)return
    if(!pendingGenerate.current)pendingGenerate.current={request_id:crypto.randomUUID().replaceAll('-',''),regenerate,note_ids:[...noteIds]}
    setGenerating(true);setError('');setNotice('')
    try {const job=await readingApi<CardTask>(`/papers/${paper.id}/card-tasks`,{method:'POST',body:JSON.stringify(pendingGenerate.current)});setTasks(previous=>[job,...previous.filter(item=>item.id!==job.id)]);requestedTask.current=job.id;pendingGenerate.current=null;setNotice(job.status==='succeeded'?'相同输入已有生成结果，可以查看历史版本。':'生成任务已提交，可以继续阅读。');if(job.status==='succeeded'){await load();setSelectedId(job.result_version_id)}}
    catch(cause){setError((cause as Error).message);if(cause instanceof ApiError && cause.status<500)pendingGenerate.current=null}
    finally{setGenerating(false)}
  }
  async function moreNotes() {
    try {const page=notePage+1,list=await api<PageList<Note>>(`/papers/${paper.id}/notes?page=${page}&page_size=50`);setNotes(previous=>[...previous,...list.items.filter(note=>!previous.some(old=>old.id===note.id))]);setNotesTotal(list.total);setNotePage(page)}catch(cause){setError((cause as Error).message)}
  }
  async function confirmVersion(version:CardVersion) {
    if(!state || busy || readOnly)return
    setBusy(true);setError('')
    try {
      const path=`/card-versions/${version.id}/confirm`
      if(!pendingDecision.current)pendingDecision.current={path,body:{request_id:crypto.randomUUID().replaceAll('-',''),card_revision:state.card_revision}}
      if(pendingDecision.current.path!==path)throw new Error('上次操作结果尚未确认，请先重试原操作。')
      await readingApi(path,{method:'POST',body:JSON.stringify(pendingDecision.current.body)});pendingDecision.current=null;setEditing(false);await load();setSelectedId(version.id);setNotice('这份版本已确认为当前卡片。确认表示你已审阅，引用仍以各条核对状态为准。');onChanged()
    }catch(cause){setError((cause as Error).message);if(cause instanceof ApiError && cause.status<500){pendingDecision.current=null;if(cause.code==='card_conflict' && cause.current)setConflict(cause.current as CardState)}}finally{setBusy(false)}
  }
  async function direction(version:CardVersion,index:number,ignore=false,createNew=false) {
    if(busy || readOnly)return
    setBusy(true);setError('')
    try {
      const path=`/card-versions/${version.id}/direction-suggestions/${index}/${ignore?'ignore':'accept'}`
      if(!pendingDecision.current)pendingDecision.current={path,body:{request_id:crypto.randomUUID().replaceAll('-',''),paper_revision:paper.revision,create_new:createNew}}
      if(pendingDecision.current.path!==path)throw new Error('上次操作结果尚未确认，请先重试原操作。')
      const result=await readingApi<{paper:Paper;decision:{status:string;tag_id:number|null}}>(path,{method:'POST',body:JSON.stringify(pendingDecision.current.body)})
      pendingDecision.current=null;onPaperChanged(result.paper);await load();setNotice(result.decision.status==='ignored'?'已忽略该方向候选。':'研究方向已加入分类。');setNewDirection(null)
    }catch(cause){setError((cause as Error).message);if(cause instanceof ApiError && cause.status<500)pendingDecision.current=null}finally{setBusy(false)}
  }
  function updateClaim(key:typeof fields[number][0],value:Claim){setDraft(previous=>({...previous,[key]:value}))}
  function cancelEdit(){if(dirty)setDiscard(true);else setEditing(false)}
  const count = draft.summary.text.length+draft.research_question.text.length+draft.method.text.length+[...draft.contributions,...draft.findings,...draft.limitations].reduce((total,claim)=>total+claim.text.length,0)

  return <section className="ai-card-panel" aria-label="论文简介卡片"><header className="ai-card-header"><div><h3>留下一张能找回思路的卡片</h3><p>读懂它解决什么问题，再决定怎样用于自己的研究。</p></div><button className="button compact secondary" onClick={onSettings}>模型设置</button></header>
    {error && <p className="error-message" role="alert">{error}</p>}{notice && <p className="ai-notice" role="status">{notice}</p>}
    {!state && <button className="button secondary" onClick={()=>void load()}>加载卡片与任务</button>}
    {state && <><div className="ai-card-actions"><button className="button primary" disabled={readOnly || generating || !!task && activeStatuses.has(task.status) || !config?.enabled || !config.tested_mode} onClick={()=>void generate(!!selected || task?.status==='failed' || task?.status==='cancelled')}>{generating ? '正在提交…' : pendingGenerate.current ? '重试提交生成请求' : selected ? '重新生成草稿' : task?.status==='failed' || task?.status==='cancelled' ? '重试生成' : '生成简介卡片'}</button><button className="button secondary" disabled={readOnly || editing} onClick={()=>void edit()}>手工填写卡片</button>{!config?.enabled || !config.tested_mode ? <span className="muted small">配置并测试模型后可使用 AI；手工填写仍可用。</span>:<span className="muted small">使用 {config.model} · {config.tested_mode==='pdf'?'原生 PDF':'页面图片'}</span>}</div>
      {!readOnly && <details className="ai-note-options" onToggle={event=>{if(event.currentTarget.open && !notePage)void moreNotes()}}><summary>选择本次发送的个人记录（默认不发送）{noteIds.length>0?` · 已选 ${noteIds.length} 条`:''}</summary><p className="muted small">只发送明确勾选的记录，最多 50 条。个人记录会标为用户内容，不能作为论文事实的证明。</p>{notes.map(note=><label className="ai-note-choice" key={note.id}><input type="checkbox" disabled={generating || !!pendingGenerate.current || noteIds.length>=50 && !noteIds.includes(note.id)} checked={noteIds.includes(note.id)} onChange={event=>setNoteIds(previous=>event.target.checked?[...previous,note.id]:previous.filter(id=>id!==note.id))} /><span>{note.page_number?`第 ${note.page_number} 页`:'个人心得'} · {note.content.slice(0,120)}</span></label>)}{notePage>0 && !notes.length && <p className="muted small">暂无个人记录。</p>}{notes.length<notesTotal && <button className="text-button" onClick={()=>void moreNotes()}>加载更多记录</button>}</details>}
      {task && <section className={`ai-task ${task.status}`} aria-label="卡片生成任务"><div className="ai-inline"><strong>{task.status==='waiting_retry'?'等待重试':stageNames[task.stage] || '处理中'}</strong><span>{task.progress}%</span>{activeStatuses.has(task.status) && <button className="text-button" disabled={readOnly} onClick={()=>void api<CardTask>(`/card-tasks/${task.id}/cancel`,{method:'POST'}).then(result=>{setTasks(previous=>previous.map(item=>item.id===result.id?result:item));setNotice('已取消后续处理；发出的请求可能仍在服务商执行并计费。')}).catch(cause=>setError(cause.message))}>取消生成</button>}</div><progress max={100} value={task.progress} />{task.error_message && <p>{task.error_message}</p>}<small>预算预占 {task.reserved_tokens.toLocaleString()} token · 已记录／估算 {task.charged_tokens.toLocaleString()} token{task.usage_unknown?' · 用量未确认':''}</small></section>}
      {state.versions.length>0 && <div className="ai-version-picker"><label>卡片版本<select aria-label="卡片历史版本" disabled={editing} value={selected?.id || ''} onChange={event=>setSelectedId(event.target.value)}>{state.versions.map(version=><option key={version.id} value={version.id}>第 {version.sequence} 版 · {version.id===state.current_version_id?'当前 · ':''}{version.confirmed_at?'已确认':'草稿'} · {version.source==='ai'?'AI 生成':'用户填写／编辑'}</option>)}</select></label></div>}
      {editing ? <div className="ai-card-editor"><div className="ai-inline"><strong>{baseId?'编辑为新版本':'手工卡片草稿'}</strong><span>{count}／2000 字符</span><button className="text-button" disabled={busy} onClick={cancelEdit}>取消编辑</button></div><p className="muted small">修改正文后标为用户修改，对应引用重新待核对；保存会创建新版本。个人笔记保持独立。</p><label>论文类型<select value={draft.paper_type} onChange={event=>setDraft(previous=>({...previous,paper_type:event.target.value}))}>{Object.entries(typeNames).map(([value,name])=><option key={value} value={value}>{name}</option>)}</select></label>{fields.map(([key,label,limit])=><ClaimEditor key={key} label={label} limit={limit} value={draft[key]} sources={sources} onChange={value=>updateClaim(key,value)} onGo={onGo} />)}{groups.map(([key,label,limit])=><section className="ai-editor-group" key={key}><h4>{label}</h4>{draft[key].map((claim,index)=><div key={index}><ClaimEditor label={`${label} ${index+1}`} limit={limit} value={claim} sources={sources} onGo={onGo} onChange={value=>setDraft(previous=>({...previous,[key]:previous[key].map((item,i)=>i===index?value:item)}))} /><button className="text-button danger-text" onClick={()=>setDraft(previous=>({...previous,[key]:previous[key].filter((_,i)=>i!==index)}))}>移除这项{label}</button></div>)}{draft[key].length<3 && <button className="button compact secondary" onClick={()=>setDraft(previous=>({...previous,[key]:[...previous[key],{text:'',origin:'user_record',evidence:[]}]}))}>添加{label}</button>}</section>)}<label>个人用途<textarea aria-label="卡片个人用途" rows={2} maxLength={80} value={draft.personal_value} onChange={event=>setDraft(previous=>({...previous,personal_value:event.target.value}))} placeholder="这篇论文对我的研究有什么用？" /></label><div className="ai-inline"><button className="button primary" disabled={busy || count>2000 || readOnly || !dirty} onClick={()=>void save()}>{busy?'正在保存…':pendingSave.current?'安全重试保存':'保存为新版本'}</button><span className="muted small">{dirty?'本页编辑尚未保存':'编辑已保存'}</span>{!dirty && selected && <button className="button secondary" disabled={busy || readOnly} onClick={()=>void confirmVersion(selected)}>确认此版本</button>}</div></div> : selected ? <article className="ai-card-document"><div className="ai-inline"><span className="ai-card-badge">第 {selected.sequence} 版 · {selected.confirmed_at?'已审阅确认':'待核对草稿'}</span><span className="muted small">{typeNames[selected.data.paper_type]} · {dateText(selected.created_at)}</span>{!readOnly && <><button className="button compact secondary" disabled={busy} onClick={()=>void edit(selected)}>编辑卡片</button><button className="button compact primary" disabled={busy || selected.id===state.current_version_id && !!selected.confirmed_at} onClick={()=>void confirmVersion(selected)}>确认此版本</button></>}</div>{selected.model_info && <p className="muted small">{selected.source==='ai'?'生成模型':'原生成模型'}：{selected.model_info.model} · {selected.model_info.input_mode==='pdf'?'原生 PDF':'页面图片'} · 配置版本 {selected.model_info.config_revision}</p>}{selected.warnings.map((warning,index)=><p className="ai-notice" key={index}>{warning}</p>)}{fields.map(([key,label])=><section className={`ai-card-section ${key}`} key={key}><h4>{label}<small>{originNames[selected.data[key].origin]}</small></h4><p>{selected.data[key].text || '尚未填写'}</p><EvidenceList claim={selected.data[key]} onGo={onGo} /></section>)}{groups.map(([key,label])=><section className="ai-card-section" key={key}><h4>{label}</h4>{selected.data[key].length?selected.data[key].map((claim,index)=><div className="ai-card-claim" key={index}><span className="ai-origin">{originNames[claim.origin]}</span><p>{claim.text}</p><EvidenceList claim={claim} onGo={onGo} /></div>):<p className="muted small">原文未说明或当前识读无法确认。</p>}</section>)}{selected.data.personal_value && <section className="ai-card-section personal"><h4>个人用途</h4><p>{selected.data.personal_value}</p></section>}<section className="ai-card-section"><h4>AI 推荐研究方向</h4><p className="muted small">只有采纳后才会加入论文分类。</p>{selected.data.research_direction_suggestions.length?selected.data.research_direction_suggestions.map((suggestion,index)=>{const decision=state.version_decisions?.[selected.id]?.[String(index)] || state.decisions[normalizeDirection(suggestion.name)];return <div className="ai-direction-suggestion" key={index}><strong>{suggestion.name}</strong><p>{suggestion.reason}</p><div className="ai-inline">{suggestion.evidence.map((evidence,i)=><button className="text-button" key={i} onClick={()=>onGo(evidence.page_number!)}>原文第 {evidence.page_number} 页 ↗</button>)}{decision?<span>{decision.status==='accepted'?'已采纳':'已忽略'}</span>:!readOnly && <><button className="button compact secondary" disabled={busy} onClick={()=>suggestion.tag_id?void direction(selected,index):setNewDirection({index,version:selected})}>{suggestion.tag_id?'添加方向':'新建或匹配并添加'}</button><button className="text-button" disabled={busy} onClick={()=>void direction(selected,index,true)}>忽略推荐</button></>}</div></div>}):<p className="muted small">暂无可核对的方向推荐，可以在论文信息中手动设置。</p>}</section><p className="ai-footer-note">来源页校验只保证引用属于本篇论文，不证明结论正确。个人心得请在“阅读与记录”中查看。</p></article>:<div className="ai-empty"><h4>为这篇论文留下简介</h4><p>生成草稿或手工填写，方便下次快速回顾研究问题、方法与局限。</p></div>}
    </>}
    {discard && <Confirm title="放弃本页卡片编辑？" description="已经保存的卡片版本会保留，本页尚未保存的输入将丢失。" action="放弃编辑" busy={false} onClose={()=>setDiscard(false)} onConfirm={()=>{setEditing(false);setDiscard(false);pendingSave.current=null}} />}
    {newDirection && <Confirm title="添加这个研究方向？" description={`“${newDirection.version.data.research_direction_suggestions[newDirection.index].name}”将加入论文分类。已有同名或别名时复用；不存在时新建。`} action="新建或匹配并添加" busy={busy} onClose={()=>setNewDirection(null)} onConfirm={()=>void direction(newDirection.version,newDirection.index,false,true)} />}
    {conflict && <Modal title="当前卡片已在其他页面更新" onClose={()=>setConflict(null)}><div className="modal-body"><p>本页输入已保留。生成和编辑都保留历史版本，请选择要继续的内容。</p><label>本页简介<textarea readOnly rows={3} value={draft.summary.text} /></label><label>当前卡片简介<textarea readOnly rows={3} value={conflict.versions.find(version=>version.id===conflict.current_version_id)?.data.summary.text || ''} /></label></div><footer className="modal-footer"><button className="button secondary" onClick={()=>setConflict(null)}>继续编辑</button><button className="button secondary" onClick={()=>{setState(conflict);setSelectedId(conflict.current_version_id);setEditing(false);setConflict(null);pendingSave.current=null}}>放弃本页编辑并载入当前卡片</button>{editing && <button className="button primary" onClick={()=>{const latest=conflict;setState(latest);setConflict(null);pendingSave.current=null;void save(latest)}}>基于当前卡片保存我的新版本</button>}</footer></Modal>}
  </section>
})
