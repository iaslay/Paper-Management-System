import { useEffect, useRef, useState } from 'react'
import { Search, Settings2, ArrowUpRight, BookOpen, Download, Bookmark, RefreshCw, X, Copy, FileUp, Compass, ChevronRight } from 'lucide-react'
import { api, sizeText, type Paper, type Tag } from '../api'
import { LabelPicker, Modal } from '../components'
import MathText from '../reader/MathText'
import DiscoverySettings from './DiscoverySettings'
import { type Provider, type LiteratureRecord, type Candidate, type ImportTask, type Providers, type SearchResults, providerNames, taskNames, phaseNames, requestId, timeText } from './types'
import './discovery.css'

type Form = { q: string; field: string; sort: string; year_from: string; year_to: string; venue: string; category: string; date_from: string; date_to: string }
const emptyForm = (): Form => ({ q: '', field: 'all', sort: 'relevance', year_from: '', year_to: '', venue: '', category: '', date_from: '', date_to: '' })
const activeStatus = (status: string) => ['queued', 'running', 'retrying'].includes(status)

export default function DiscoveryPage({ active, tags, onOpenPaper, onChanged }: { active: boolean; tags: Tag[]; onOpenPaper: (id: string) => void; onChanged: () => void }) {
  const [provider, setProvider] = useState<Provider>('arxiv')
  const [forms, setForms] = useState<Record<Provider, Form>>({ arxiv: emptyForm(), acl: emptyForm(), ieee: emptyForm() })
  const [results, setResults] = useState<Partial<Record<Provider, SearchResults>>>({})
  const [submitted, setSubmitted] = useState<Partial<Record<Provider, string>>>({})
  const [submittedForms, setSubmittedForms] = useState<Partial<Record<Provider, Form>>>({})
  const [providers, setProviders] = useState<Providers | null>(null)
  const [candidates, setCandidates] = useState<Candidate[]>([])
  const [tasks, setTasks] = useState<ImportTask[]>([])
  const [tab, setTab] = useState<'search' | 'candidates' | 'tasks'>('search')
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [detail, setDetail] = useState<LiteratureRecord | null>(null)
  const [directionIds, setDirectionIds] = useState<number[]>([])
  const [hideImported, setHideImported] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [institution, setInstitution] = useState<{ name: string; portal_url: string } | null>(null)
  const [handoff, setHandoff] = useState<Candidate | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [previews, setPreviews] = useState<LiteratureRecord[]>([])
  const searchAbort = useRef<AbortController | null>(null)
  const finished = useRef(new Set<string>())
  const citationInput = useRef<HTMLInputElement>(null)
  const pdfInput = useRef<HTMLInputElement>(null)
  const [uncertainImport, setUncertainImport] = useState<{ candidate: Candidate; request: string } | null>(null)
  const form = forms[provider], result = results[provider]
  const work = tasks.some(t => activeStatus(t.status)) || !!providers?.acl.task && activeStatus(providers.acl.task.status)

  async function refresh(signal?: AbortSignal) {
    const [source, saved, jobs, access] = await Promise.all([api<Providers>('/discovery/providers', { signal }), api<Candidate[]>('/discovery/candidates', { signal }), api<ImportTask[]>('/paper-imports', { signal }), api<{ name: string; portal_url: string }>('/settings/institution-access', { signal })])
    if (signal?.aborted) return
    setProviders(source); setCandidates(saved); setTasks(jobs); setInstitution(access)
    for (const task of jobs) if (task.status === 'succeeded' && !finished.current.has(task.id)) { finished.current.add(task.id); onChanged() }
  }
  useEffect(() => {
    if (!active) { searchAbort.current?.abort(); setLoading(false); return }
    const abort = new AbortController()
    void refresh(abort.signal).catch(cause => { if (!abort.signal.aborted) setError((cause as Error).message) })
    return () => abort.abort()
  }, [active])
  useEffect(() => {
    if (!active || !work) return
    const abort = new AbortController()
    const timer = window.setInterval(() => { void refresh(abort.signal).catch(cause => { if (!abort.signal.aborted) setError((cause as Error).message) }) }, 2500)
    return () => { clearInterval(timer); abort.abort() }
  }, [active, !!work])
  useEffect(() => () => searchAbort.current?.abort(), [])

  function update(key: keyof Form, value: string) { setForms(previous => ({ ...previous, [provider]: { ...previous[provider], [key]: value } })) }
  function switchProvider(next: Provider) { searchAbort.current?.abort(); setLoading(false); setProvider(next); setDetail(null); setError(''); setTab('search') }
  async function search(more = false) {
    const queryForm = more ? submittedForms[provider] || form : form
    const q = queryForm.q.trim()
    if (!q || loading) return
    const abort = new AbortController()
    searchAbort.current?.abort(); searchAbort.current = abort
    setLoading(true); setError(''); setDetail(null)
    const params = new URLSearchParams({ provider, q, field: queryForm.field, sort: queryForm.sort })
    for (const key of ['year_from', 'year_to', 'venue', 'category', 'date_from', 'date_to'] as const) if (queryForm[key]) params.set(key, queryForm[key])
    if (more && result?.next_cursor) params.set('cursor', result.next_cursor)
    try {
      const found = await api<SearchResults>('/discovery/search?' + params, { signal: abort.signal })
      if (abort.signal.aborted) return
      setResults(previous => ({ ...previous, [provider]: { ...found, items: more ? [...(previous[provider]?.items || []), ...found.items] : found.items } }))
      setSubmitted(previous => ({ ...previous, [provider]: q }))
      setSubmittedForms(previous => ({ ...previous, [provider]: { ...queryForm } }))
    } catch (cause) { if (!abort.signal.aborted) setError((cause as Error).message) }
    finally { if (!abort.signal.aborted) setLoading(false) }
  }
  async function action(key: string, callback: () => Promise<void>) {
    if (busy) return
    setBusy(key); setError(''); setNotice('')
    try { await callback() } catch (cause) { setError((cause as Error).message) }
    finally { setBusy('') }
  }
  async function save(record: LiteratureRecord) {
    const candidate = await api<Candidate>('/discovery/candidates', { method: 'POST', body: JSON.stringify({ provider: record.provider, source_id: record.source_id, direction_ids: directionIds, record: record.provider === 'citation' ? record : undefined }) })
    await refresh()
    return candidate
  }
  async function importCandidate(candidate: Candidate, request = requestId()) {
    setUncertainImport({ candidate, request })
    await api('/paper-imports', { method: 'POST', body: JSON.stringify({ candidate_id: candidate.id, request_id: request }) })
    setUncertainImport(null); setNotice('论文已加入下载队列，可继续检索。'); await refresh()
  }
  async function getPaper(record: LiteratureRecord) {
    const candidate = await save(record)
    if (candidate.paper_id) { onOpenPaper(candidate.paper_id); return }
    if (record.provider === 'ieee' || record.provider === 'citation' || !record.pdf_url) { setHandoff(candidate); setConfirmed(false); return }
    await importCandidate(candidate)
  }
  async function sync() { await api('/discovery/providers/acl/sync', { method: 'POST', body: JSON.stringify({ request_id: requestId() }) }); await refresh(); setNotice('ACL 元数据同步已排队，完成前可继续阅读或使用其他来源。') }
  async function copy(value: string) { await navigator.clipboard.writeText(value); setNotice('已复制论文定位信息。') }
  async function uploadCandidate(file: File) {
    if (!handoff || !confirmed) return
    const body = new FormData()
    body.append('file', file); body.append('direction_ids', JSON.stringify(handoff.direction_ids)); body.append('candidate_id', handoff.id); body.append('candidate_confirmed', 'true')
    const result = await api<{ paper: Paper; duplicate: boolean }>('/papers', { method: 'POST', body })
    setHandoff(null); setNotice(result.duplicate ? '这份 PDF 已在论文库中，来源已关联。' : '论文已加入论文库，可以开始阅读。'); onChanged(); await refresh()
  }
  async function previewCitation(file: File) { const body = new FormData(); body.append('file', file); setPreviews(await api('/discovery/citation-previews', { method: 'POST', body })) }
  const visible = (result?.items || []).filter(record => !hideImported || !(record.paper_id || candidates.find(c => c.record.provider === record.provider && c.record.source_id === record.source_id)?.paper_id))
  const blocked = provider === 'ieee' && !providers?.ieee.configured || provider === 'acl' && !providers?.acl.ready
  function controls(record: LiteratureRecord) {
    const saved = candidates.find(c => c.record.provider === record.provider && c.record.source_id === record.source_id)
    const paper = record.paper_id || saved?.paper_id
    const trash = record.in_trash || saved?.in_trash
    return <div className="discovery-record-actions">{paper ? <button className="button secondary compact" onClick={() => onOpenPaper(paper)}><BookOpen size={14} />{trash ? '前往回收站恢复' : '打开已有论文'}</button> : <button className="button primary compact" disabled={!!busy} onClick={() => void action(record.source_id, () => getPaper(record))}>{record.provider === 'ieee' ? <ArrowUpRight size={14} /> : <Download size={14} />}{record.provider === 'ieee' ? '通过机构获取全文' : record.provider === 'citation' || !record.pdf_url ? '补传 PDF' : '加入论文库'}</button>}
      <button className="button secondary compact" disabled={!!busy} onClick={() => void action('save-' + record.source_id, async () => { await save(record); setNotice('已保存到待导入清单。') })}><Bookmark size={14} />{saved || record.saved ? '更新方向并保存' : '保存待导入'}</button>
      <button className="text-button" onClick={() => setDetail(record)}>查看摘要 <ChevronRight size={13} /></button></div>
  }
  return <section className="discovery-page" aria-label="发现论文">
    <header className="discovery-heading"><div><span className="eyebrow">从一个问题，找到下一篇论文</span><h1>发现论文 <Compass size={25} /></h1><p>检索公开文献，选好方向，再带入你的阅读空间。</p></div><button className="button secondary" onClick={() => setShowSettings(true)}><Settings2 size={16} />检索来源设置</button></header>
    <div className="discovery-source-tabs" role="group" aria-label="论文来源">{(['arxiv', 'acl', 'ieee'] as Provider[]).map(source => <button key={source} aria-pressed={provider === source} className={provider === source ? 'selected' : ''} onClick={() => switchProvider(source)}>{providerNames[source]}<span>{source === 'arxiv' ? '公开预印本' : source === 'acl' ? '自然语言处理文献' : 'API 检索 · 机构全文'}</span></button>)}</div>
    {error && <div className="error-message" role="alert">{error}</div>}{notice && <div className="success-message" role="status">{notice}</div>}
    <nav className="discovery-view-tabs" aria-label="发现论文视图">{([['search', '检索结果'], ['candidates', `待导入 · ${candidates.length}`], ['tasks', '导入任务']] as const).map(([value, label]) => <button className={tab === value ? 'selected' : ''} key={value} onClick={() => { setTab(value); setDetail(null) }}>{label}</button>)}</nav>
    {tab === 'search' && <>
      <form className="discovery-search-form" onSubmit={event => { event.preventDefault(); void search() }}>
        <div className="discovery-search-line"><Search size={20} /><input aria-label="论文检索词" maxLength={500} value={form.q} onChange={e => update('q', e.target.value)} placeholder="关键词、标题、作者、论文 ID 或官方链接" /><button className="button primary" disabled={loading || !form.q.trim() || !!blocked}>{loading ? '正在检索…' : '检索论文'}</button>{loading && <button type="button" className="button secondary" onClick={() => { searchAbort.current?.abort(); setLoading(false) }}>取消</button>}</div>
        <div className="discovery-filters"><label>检索字段<select aria-label="检索字段" value={form.field} onChange={e => update('field', e.target.value)}><option value="all">全部字段</option><option value="title">标题</option><option value="author">作者</option>{provider !== 'ieee' && <option value="abstract">摘要</option>}</select></label><label>排序<select aria-label="检索排序" value={form.sort} onChange={e => update('sort', e.target.value)}><option value="relevance">相关性</option><option value="year_desc">{provider === 'acl' ? '年份由新到旧' : '最新发表'}</option></select></label>
          <label>起始年份<input aria-label="起始年份" type="number" min={1800} max={2100} value={form.year_from} onChange={e => update('year_from', e.target.value)} placeholder="不限" /></label><label>结束年份<input aria-label="结束年份" type="number" min={1800} max={2100} value={form.year_to} onChange={e => update('year_to', e.target.value)} placeholder="不限" /></label>
          {provider === 'arxiv' && <label>学科分类<input aria-label="arXiv 学科分类" value={form.category} onChange={e => update('category', e.target.value)} placeholder="例如 cs.CL" maxLength={40} /></label>}
          {provider === 'acl' && <label className="discovery-venue">会议<select aria-label="ACL 会议" value={form.venue} onChange={e => update('venue', e.target.value)}><option value="">全部会议</option>{providers?.acl.venues.map(venue => <option key={venue}>{venue}</option>)}</select></label>}
        </div>
        {provider === 'arxiv' && <details className="discovery-date-filters"><summary>精确发布日期</summary><label>起始日期<input aria-label="起始日期" type="date" value={form.date_from} onChange={e => update('date_from', e.target.value)} /></label><label>结束日期<input aria-label="结束日期" type="date" value={form.date_to} onChange={e => update('date_to', e.target.value)} /></label></details>}
      </form>
      {provider === 'ieee' && !providers?.ieee.configured && <div className="discovery-source-notice"><Settings2 size={21} /><div><strong>配置 IEEE 检索密钥，即可在看板搜索</strong><p>检索论文信息无需学校登录。选定论文后，再通过电子科大机构权限获取全文。</p></div><button className="button secondary" onClick={() => setShowSettings(true)}>配置 IEEE 检索</button></div>}
      {provider === 'acl' && <div className="discovery-source-notice"><RefreshCw size={21} /><div><strong>{providers?.acl.ready ? `已索引 ${providers.acl.records?.toLocaleString()} 篇论文` : '先初始化 ACL 论文索引'}</strong><p>{providers?.acl.ready ? `元数据更新于 ${timeText(providers.acl.updated_at)}，索引可离线检索。` : '首次同步只获取公开元数据；PDF 在你选择论文后再下载。'}{providers?.acl.task && activeStatus(providers.acl.task.status) && ` ${phaseNames[providers.acl.task.phase] || '同步中'}，已处理 ${providers.acl.task.processed.toLocaleString()} 条。`}</p>{providers?.acl.task?.error && <p className="error-text">{providers.acl.task.error} {providers.acl.ready ? '仍使用上次成功的索引。' : ''}</p>}</div><button className="button secondary" disabled={!!busy || !!providers?.acl.task && activeStatus(providers.acl.task.status)} onClick={() => void action('sync', sync)}>{providers?.acl.ready ? '更新索引' : '初始化论文索引'}</button></div>}
      <div className="discovery-results-meta"><span>{result ? `“${submitted[provider]}” · 来源匹配 ${result.total.toLocaleString()} 条，已加载 ${result.items.length} 条` : '选择一个来源，开始发现与你相关的论文'}{result?.cached && ' · 缓存结果'}</span><label><input type="checkbox" checked={hideImported} onChange={e => setHideImported(e.target.checked)} />隐藏已入库</label></div>
      {result && <p className="muted small discovery-data-time">获取时间：{timeText(result.data_time)} · 每次最多展示 200 条，更多结果请缩小范围。</p>}
      {!result && !loading && !blocked && <div className="discovery-empty"><Compass size={36} /><h3>从研究问题出发</h3><p>可以试试 memory、personalized dialogue，或直接粘贴论文的官方链接。</p>{['long term memory', 'conversational agents', 'retrieval augmented generation'].map(example => <button className="label-option" key={example} onClick={() => update('q', example)}>{example}</button>)}</div>}
      {result && !visible.length && <div className="discovery-empty"><Search size={32} /><h3>{result.total ? '当前已加载记录均已隐藏' : '当前来源没有匹配结果'}</h3><p>{result.total ? '可以关闭“隐藏已入库”，或继续加载。' : '试着更换英文关键词，或放宽年份和会议条件。'}</p></div>}
      <div className="discovery-body"><div className="discovery-results">{visible.map(record => <article key={record.source_id} className="discovery-record"><div className="discovery-record-kicker"><span>{providerNames[record.provider]}</span><span>{record.year || '年份未提供'}{record.version && ` · ${record.version}`}</span><span>{record.provider === 'ieee' ? '全文需机构核对' : record.pdf_url ? '有原文链接' : '原文未提供'}</span></div><h2><button onClick={() => setDetail(record)}>{record.title}</button></h2><p className="discovery-authors">{record.authors.join('，') || '来源未提供作者'}{record.venue && ` · ${record.venue}`}</p><p className="discovery-abstract-snippet">{record.abstract || '来源未提供摘要，可查看原始条目。'}</p>{controls(record)}</article>)}
        {result?.next_cursor && <button className="button secondary discovery-load-more" disabled={loading} onClick={() => void search(true)}>{loading ? '加载中…' : '加载更多论文'}</button>}
      </div>{detail && <aside className="discovery-detail"><div className="discovery-detail-top"><span>论文摘要</span><button className="icon-button" aria-label="关闭论文摘要" onClick={() => setDetail(null)}><X size={18} /></button></div><h2>{detail.title}</h2><p className="muted small">{detail.authors.join('，')}</p><p className="muted small">{detail.source_id}{detail.doi && ` · DOI ${detail.doi}`}</p><MathText text={detail.abstract || '来源未提供摘要。'} /><label className="discovery-direction-label">加入时的研究方向</label><LabelPicker tags={tags} selected={directionIds} onChange={setDirectionIds} />{controls(detail)}{detail.url && <a className="text-button" href={detail.url} target="_blank" rel="noreferrer">查看官方来源 <ArrowUpRight size={13} /></a>}</aside>}</div>
    </>}
    {tab === 'candidates' && <div className="discovery-candidates">{!candidates.length && <div className="discovery-empty"><Bookmark size={33} /><h3>把有兴趣的论文先留下</h3><p>保存候选不会下载全文，也不会计入论文库篇数。</p></div>}{candidates.map(candidate => <article className="discovery-record" key={candidate.id}><div className="discovery-record-kicker"><span>{providerNames[candidate.record.provider]}</span><span>{candidate.paper_id ? '已关联论文' : '待导入'}</span></div><h2>{candidate.record.title}</h2><p className="muted small">{candidate.record.authors.join('，')} · {candidate.record.doi || candidate.record.source_id}</p><p className="muted small">研究方向：{candidate.direction_ids.map(id => tags.find(t => t.id === id)?.name || '分类已变更').join('、') || '未分类'}</p><div className="discovery-record-actions">{candidate.paper_id ? <button className="button secondary compact" onClick={() => onOpenPaper(candidate.paper_id!)}><BookOpen size={14} />{candidate.in_trash ? '前往回收站恢复' : '打开论文'}</button> : <button className="button primary compact" disabled={!!busy} onClick={() => void action(candidate.id, async () => { if (candidate.record.provider === 'ieee' || candidate.record.provider === 'citation' || !candidate.record.pdf_url) { setHandoff(candidate); setConfirmed(false) } else await importCandidate(candidate) })}>{candidate.record.provider === 'ieee' ? '通过机构获取全文' : candidate.record.pdf_url ? '下载并加入论文库' : '补传 PDF'}</button>}<button className="button secondary compact" disabled={!!busy} onClick={() => { setHandoff(candidate); setConfirmed(false) }}><FileUp size={14} />补传 PDF</button><button className="text-button" disabled={!!busy} onClick={() => void action('remove-' + candidate.id, async () => { await api(`/discovery/candidates/${candidate.id}`, { method: 'DELETE' }); await refresh() })}>移出待导入</button></div></article>)}</div>}
    {tab === 'tasks' && <div className="discovery-task-list">{!tasks.length && <div className="discovery-empty"><Download size={33} /><h3>还没有下载任务</h3><p>选择论文并加入论文库后，可在这里查看处理进度。</p></div>}{tasks.map(task => <article className="discovery-task" key={task.id}><div><h3>{task.title}</h3><p>{taskNames[task.status]} · {phaseNames[task.phase] || task.phase}{task.downloaded_bytes > 0 && ` · ${sizeText(task.downloaded_bytes)}`}</p>{task.error && <p className="error-text">{task.error}</p>}</div><div>{activeStatus(task.status) && <button className="button secondary compact" disabled={!!busy} onClick={() => void action(task.id, async () => { await api(`/paper-imports/${task.id}/cancel`, { method: 'POST' }); await refresh() })}>取消导入</button>}{['failed', 'cancelled'].includes(task.status) && <button className="button secondary compact" disabled={!!busy} onClick={() => void action(task.id, async () => { await api(`/paper-imports/${task.id}/retry`, { method: 'POST', body: JSON.stringify({ request_id: requestId() }) }); await refresh() })}>重试导入</button>}{task.status === 'succeeded' && task.paper_id && <button className="button primary compact" onClick={() => onOpenPaper(task.paper_id!)}>打开阅读</button>}</div></article>)}</div>}
    {uncertainImport && <div className="notice">如果刚才的导入请求响应中断，可以使用同一请求安全重试。<button className="text-button" disabled={!!busy} onClick={() => void action('retry-submit', () => importCandidate(uncertainImport.candidate, uncertainImport.request))}>安全重试提交</button></div>}
    <details className="discovery-manual"><summary>手动补充：机构网页检索与引文导入</summary><p>没有 IEEE 密钥时，也可以从电子科大资源入口手动检索。机构登录不等于后端获得下载权限。</p><div className="discovery-record-actions"><a className="button secondary compact" href={institution?.portal_url || 'https://vpn.uestc.edu.cn/'} target="_blank" rel="noreferrer">打开机构入口 <ArrowUpRight size={13} /></a><button className="button secondary compact" onClick={() => citationInput.current?.click()}>预览 RIS / BibTeX 引文</button></div><input ref={citationInput} type="file" accept=".ris,.bib,.bibtex" hidden onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void action('citation', () => previewCitation(file)) }} />{previews.map(record => <div className="discovery-citation" key={record.source_id}><strong>{record.title}</strong><button className="button secondary compact" disabled={!!busy} onClick={() => void action(record.source_id, async () => { await save(record); setNotice('引文已加入待导入，取得 PDF 后可补传。') })}>保存这条引文</button></div>)}</details>
    {handoff && <Modal title="获取并补传论文原文" onClose={() => { if (!busy) setHandoff(null) }}><div className="modal-body discovery-handoff-card"><h3>{handoff.record.title}</h3><p className="muted small">{handoff.record.doi ? `DOI：${handoff.record.doi}` : `来源标识：${handoff.record.source_id}`}</p>{handoff.record.provider === 'ieee' && <><ol><li>打开电子科大机构入口，按需完成登录，从资源列表进入 IEL / IEEE。</li><li>使用 DOI、文章号或题名定位同一论文，核对机构权限后下载 PDF。</li><li>回到这里选择下载文件，系统会关联候选并检查入库。</li></ol><div className="discovery-record-actions"><a href={institution?.portal_url || 'https://vpn.uestc.edu.cn/'} target="_blank" rel="noreferrer" className="button secondary">打开机构入口 <ArrowUpRight size={14} /></a><button className="button secondary" onClick={() => void action('copy', () => copy(handoff.record.doi || handoff.record.source_id))}><Copy size={14} />复制 DOI / 文章号</button><button className="text-button" onClick={() => void action('copy-title', () => copy(handoff.record.title))}>复制题名</button></div></>}{handoff.record.provider !== 'ieee' && handoff.record.url && <a href={handoff.record.url} target="_blank" rel="noreferrer" className="text-button">查看论文来源 <ArrowUpRight size={14} /></a>}<label className="discovery-confirm-pdf"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />我已核对所传 PDF 与这篇论文对应</label><button className="button primary" disabled={!confirmed || !!busy} onClick={() => pdfInput.current?.click()}><FileUp size={16} />{busy === 'upload' ? '正在检查并入库…' : '上传此篇 PDF'}</button><input ref={pdfInput} type="file" accept=".pdf" hidden onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void action('upload', () => uploadCandidate(file)) }} />{error && <p className="error-message" role="alert">{error}</p>}</div></Modal>}
    {showSettings && <DiscoverySettings onClose={() => setShowSettings(false)} onSaved={() => { void refresh().catch(cause => setError((cause as Error).message)) }} />}
  </section>
}
