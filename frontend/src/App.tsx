import { useEffect, useRef, useState, type ReactNode } from 'react'
import { BookOpen, LibraryBig, PanelsTopLeft, Star, Trash2, Tags, Settings2, Plus, Search, SlidersHorizontal, LayoutGrid, List, Columns3, FileText, ArrowUpRight, ChevronLeft, ChevronRight, Check, X, LogOut, Leaf, MoreHorizontal, UploadCloud, RotateCcw, ArrowRight, CheckCircle2, AlertCircle } from 'lucide-react'
import { api, dateText, sizeText, statusNames, type User, type Paper, type Tag, type ReadingStatus, type Kind, type Library } from './api'
import Auth from './Auth'
import Upload from './Upload'
import TagManager from './TagManager'
import PaperDetail, { type DetailHandle } from './PaperDetail'
import Batch from './Batch'
import { Confirm } from './components'
import ModelSettingsModal from './ai/ModelSettings'

type Section = 'library' | 'favorite' | 'trash'
import PaperCard from './PaperLibraryCard'

type Mode = 'grid' | 'list' | 'board'
type Toast = { message: string; error: boolean }

export default function App() {
  const [auth, setAuth] = useState<{ initialized: boolean; user: User | null } | null>(null)
  const [rememberedUser, setRememberedUser] = useState<User | null>(null)
  const [expired, setExpired] = useState(false)
  const [bootError, setBootError] = useState('')
  const [section, setSection] = useState<Section>('library')
  const [mode, setMode] = useState<Mode>('grid')
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('')
  const [directions, setDirections] = useState<number[]>([])
  const [match, setMatch] = useState('any')
  const [unclassified, setUnclassified] = useState(false)
  const [topic, setTopic] = useState('')
  const [tagFilter, setTagFilter] = useState('')
  const [year, setYear] = useState('')
  const [sort, setSort] = useState('updated')
  const [page, setPage] = useState(1)
  const [tags, setTags] = useState<Tag[]>([])
  const [library, setLibrary] = useState<Library | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [tick, setTick] = useState(0)
  const [showUpload, setShowUpload] = useState(false)
  const [showModelSettings,setShowModelSettings] = useState(false)
  const [manager, setManager] = useState<Kind | null>(null)
  const [detail, setDetail] = useState<Paper | null>(null)
  const [preview, setPreview] = useState(false)
  const [detailTab, setDetailTab] = useState<'info' | 'preview' | 'card'>('info')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [batch, setBatch] = useState(false)
  const [pending, setPending] = useState<Set<string>>(new Set())
  const [confirmation, setConfirmation] = useState<{ paper: Paper; action: 'trash' | 'permanent' } | null>(null)
  const [confirmBusy, setConfirmBusy] = useState(false)
  const [toast, setToast] = useState<Toast | null>(null)
  const [moreFilters, setMoreFilters] = useState(false)
  const searchInput = useRef<HTMLInputElement>(null)
  const detailControl = useRef<DetailHandle>(null)
  const refresh = () => setTick(value => value + 1)
  const notify = (message: string, error = false) => setToast({ message, error })
  async function classificationChanged() {
    try {
      const catalog = await api<Tag[]>('/tags')
      const activeIds = new Set(catalog.map(tag => tag.id))
      setTags(catalog)
      setDirections(previous => previous.filter(id => activeIds.has(id)))
      if (topic && !activeIds.has(Number(topic))) setTopic('')
      if (tagFilter && !activeIds.has(Number(tagFilter))) setTagFilter('')
      setPage(1); refresh()
    } catch (cause) { notify((cause as Error).message, true) }
  }
  async function boot() {
    setBootError('')
    try { const state = await api<{ initialized: boolean; user: User | null }>('/status'); setAuth(state); if (state.user) setRememberedUser(state.user) } catch (cause) { setBootError((cause as Error).message || '暂时无法连接服务，请确认服务已经启动。') }
  }
  useEffect(() => { boot() }, [])
  useEffect(() => {
    const handle = () => { setExpired(true); setAuth(previous => previous ? { ...previous, user: null } : previous) }
    window.addEventListener('paperboard-auth-expired', handle)
    return () => window.removeEventListener('paperboard-auth-expired', handle)
  }, [])
  useEffect(() => { const timer = window.setTimeout(() => setSearch(query), 300); return () => clearTimeout(timer) }, [query])
  useEffect(() => {
    if (auth && !auth.user) document.body.style.overflow = ''
    else if (auth?.user && (detail || showUpload || manager || batch)) document.body.style.overflow = 'hidden'
  }, [auth?.user])
  useEffect(() => { if (!toast) return; const timer = window.setTimeout(() => setToast(null), toast.error ? 7000 : 4000); return () => clearTimeout(timer) }, [toast])
  useEffect(() => {
    const handle = (event: KeyboardEvent) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k' && searchInput.current?.getClientRects().length && !document.querySelector('.modal-backdrop')) { event.preventDefault(); searchInput.current.focus() } }
    window.addEventListener('keydown', handle); return () => window.removeEventListener('keydown', handle)
  }, [])
  const pageSize = mode === 'board' ? 60 : mode === 'list' ? 20 : 12
  useEffect(() => {
    if (!auth?.user) return
    const abort = new AbortController()
    setLoading(true); setError('')
    const params = new URLSearchParams({ q: search, direction_match: match, unclassified_only: String(unclassified), favorite: String(section === 'favorite'), trash: String(section === 'trash'), sort, page: String(page), page_size: String(pageSize) })
    if (status) params.set('status', status)
    if (topic) params.set('topic_id', topic)
    if (tagFilter) params.set('tag_id', tagFilter)
    if (year) params.set('year', year)
    directions.forEach(id => params.append('research_direction_ids', String(id)))
    Promise.all([api<Library>('/papers?' + params, { signal: abort.signal }), api<Tag[]>('/tags', { signal: abort.signal })]).then(([result, catalog]) => {
      setLibrary(result); setTags(catalog)
      const lastPage = Math.max(1, Math.ceil(result.total / pageSize))
      if (page > lastPage) setPage(lastPage)
    }).catch(cause => { if (!abort.signal.aborted) setError((cause as Error).message) }).finally(() => { if (!abort.signal.aborted) setLoading(false) })
    return () => abort.abort()
  }, [auth?.user, search, status, directions, match, unclassified, section, sort, topic, tagFilter, year, page, pageSize, tick])
  function filter(action: () => void) { action(); setPage(1); setSelected(new Set()) }
  function toggleDirection(id: number) { filter(() => { setUnclassified(false); setDirections(previous => previous.includes(id) ? previous.filter(item => item !== id) : [...previous, id]) }) }
  function addDirection(id: number) { filter(() => { setUnclassified(false); setDirections(previous => previous.includes(id) ? previous : [...previous, id]); setSection('library') }) }
  function clearFilters() { filter(() => { setQuery(''); setSearch(''); setDirections([]); setUnclassified(false); setStatus(''); setTopic(''); setTagFilter(''); setYear(''); setMatch('any') }) }
  function navigate(next: Section, nextMode?: Mode) { filter(() => { setSection(next); clearFilters(); if (nextMode) setMode(nextMode) }) }
  function toggleSelected(id: string) { setSelected(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else if (next.size < 100) next.add(id); return next }) }
  async function patchPaper(paper: Paper, changes: Record<string, unknown>, message?: string) {
    setPending(previous => new Set(previous).add(paper.id))
    try {
      const saved = await api<Paper>(`/papers/${paper.id}`, { method: 'PATCH', body: JSON.stringify({ revision: paper.revision, ...changes }) })
      if (detail?.id === saved.id) setDetail(saved)
      refresh(); if (saved.card_generation_notice) notify(saved.card_generation_notice.message); else if (message) notify(message); return saved
    } catch (cause) { notify((cause as Error).message, true); refresh(); return null }
    finally { setPending(previous => { const next = new Set(previous); next.delete(paper.id); return next }) }
  }
  async function openPaper(paper: Paper, read: boolean, card = false) {
    setPreview(read); setDetailTab(card ? 'card' : read ? 'preview' : 'info')
    if (read && paper.reading_status === 'unread' && !paper.deleted_at) {
      const updated = await patchPaper(paper, { reading_status: 'reading' })
      setDetail(updated || paper)
    } else setDetail(paper)
  }
  async function restore(paper: Paper) {
    try { await api(`/papers/${paper.id}/restore?revision=${paper.revision}`, { method: 'POST' }); notify('论文已恢复，原文和分类均已保留。'); refresh() }
    catch (cause) { notify((cause as Error).message, true) }
  }
  async function remove() {
    if (!confirmation) return
    setConfirmBusy(true)
    try {
      await api(`/papers/${confirmation.paper.id}${confirmation.action === 'permanent' ? '/permanent' : ''}?revision=${confirmation.paper.revision}`, { method: 'DELETE' })
      setSelected(previous => { const next = new Set(previous); next.delete(confirmation.paper.id); return next })
      notify(confirmation.action === 'permanent' ? '论文与原文已彻底删除。' : '论文已移入回收站，30 天内可恢复。')
      setConfirmation(null); refresh()
    } catch (cause) { notify((cause as Error).message, true); setConfirmation(null); refresh() }
    finally { setConfirmBusy(false) }
  }
  async function performLogout() {
    try { await api('/session', { method: 'DELETE' }); setAuth(previous => previous ? { ...previous, user: null } : previous); setRememberedUser(null); setExpired(false); setDetail(null); setSelected(new Set()); setShowUpload(false); setManager(null); setBatch(false); setLibrary(null) }
    catch (cause) { notify((cause as Error).message, true) }
  }
  function logout() { if (detailControl.current) detailControl.current.requestClose(() => { void performLogout() }); else void performLogout() }
  if (!auth) return <div className="boot-screen"><BookOpen size={32} /><strong>研读 · 论文看板</strong>{bootError ? <><p className="error-text">{bootError}</p><button className="button secondary" onClick={boot}>重新连接</button></> : <p className="muted">正在打开你的研究空间…</p>}</div>
  if (!auth.user && !rememberedUser) return <Auth initialized={auth.initialized} expired={expired} onLogin={user => { setAuth({ initialized: true, user }); setRememberedUser(user); setExpired(false); refresh() }} />
  const profile = auth.user || rememberedUser!

  const stats = library?.stats || { total: 0, unread: 0, reading: 0, read: 0, favorite: 0, trash: 0, used_bytes: 0 }
  const directionTags = tags.filter(tag => tag.kind === 'research_direction')
  const items = library?.items || []
  const totalPages = Math.max(1, Math.ceil((library?.total || 0) / pageSize))
  const hasFilter = !!(query || directions.length || status || unclassified || topic || tagFilter || year)
  const allChecked = !!items.length && items.every(paper => selected.has(paper.id))
  const title = section === 'trash' ? '回收站' : section === 'favorite' ? '收藏论文' : mode === 'board' ? '阅读看板' : '我的论文库'
  function renderCard(paper: Paper, compact = false) {
    return <PaperCard key={paper.id} paper={paper} enabled={!!auth?.user} onRefresh={refresh} onSettings={() => setShowModelSettings(true)} onCard={() => openPaper(paper, false, true)} checked={selected.has(paper.id)} pending={pending.has(paper.id)} onSelect={() => toggleSelected(paper.id)} onOpen={() => openPaper(paper, true)} onInfo={() => openPaper(paper, false)} onFavorite={() => patchPaper(paper, { is_favorite: !paper.is_favorite }, paper.is_favorite ? '已取消收藏。' : '已加入收藏。')} onStatus={value => patchPaper(paper, { reading_status: value }, `已标记为${statusNames[value]}。`)} onDirection={addDirection} onDelete={() => setConfirmation({ paper, action: section === 'trash' ? 'permanent' : 'trash' })} onRestore={() => restore(paper)} trash={section === 'trash'} compact={compact} />
  }
  function navButton(icon: ReactNode, label: string, active: boolean, onClick: () => void, count?: number) { return <button className={`nav-item ${active ? 'active' : ''}`} onClick={onClick} title={label}>{icon}<span>{label}</span>{count !== undefined && <em>{count}</em>}</button> }
  return <><div className="app-shell" style={!auth.user ? { display: 'none' } : undefined} aria-hidden={!auth.user}>
    <aside className="sidebar"><div className="brand"><span className="brand-mark"><BookOpen size={22} /></span><span>研读<span className="brand-sub">论文看板</span></span></div><div className="workspace-label"><span className="workspace-dot" />{profile.workspace_name}</div>
      <div className="nav-group"><span className="nav-heading">研究资料</span>{navButton(<LibraryBig size={18} />, '全部论文', section === 'library' && mode !== 'board', () => navigate('library', 'grid'), stats.total)}{navButton(<PanelsTopLeft size={18} />, '阅读看板', section === 'library' && mode === 'board', () => navigate('library', 'board'))}{navButton(<Star size={18} />, '收藏夹', section === 'favorite', () => navigate('favorite'), stats.favorite)}{navButton(<Trash2 size={18} />, '回收站', section === 'trash', () => navigate('trash'), stats.trash)}</div>
      <div className="nav-group research-nav"><div className="nav-heading-line"><span className="nav-heading">研究方向</span><button className="icon-button" aria-label="管理研究方向" onClick={() => setManager('research_direction')}><Plus size={15} /></button></div>{directionTags.slice(0, 8).map(tag => <button key={tag.id} className={`direction-nav ${directions.includes(tag.id) && !unclassified ? 'selected' : ''}`} onClick={() => { if (section === 'trash') navigate('library'); toggleDirection(tag.id) }} title={tag.name}><span className="direction-dot" /><span>{tag.name}</span><em>{library?.direction_counts[tag.id] || 0}</em></button>)}{!directionTags.length && <button className="add-direction" onClick={() => setManager('research_direction')}><Plus size={14} />添加第一个研究方向</button>}{directionTags.length > 8 && <button className="text-button more-directions" onClick={() => setManager('research_direction')}>管理全部 {directionTags.length} 个方向 <ArrowRight size={12} /></button>}<button className={`direction-nav unclassified-nav ${unclassified ? 'selected' : ''}`} onClick={() => filter(() => { setDirections([]); setUnclassified(!unclassified) })}><span className="direction-dot empty" /><span>未分类</span></button></div>
      <div className="sidebar-bottom">{navButton(<Settings2 size={18} />, '分类管理', false, () => setManager('research_direction'))}{navButton(<BookOpen size={18} />, '模型设置', false, () => setShowModelSettings(true))}<div className="storage-note"><span>已使用 {sizeText(stats.used_bytes)}</span><span>{sizeText(profile.quota_bytes)}</span><div><i style={{ width: `${Math.min(100, stats.used_bytes / profile.quota_bytes * 100)}%` }} /></div></div><div className="user-row"><span className="user-avatar">{profile.username.slice(0, 1).toUpperCase()}</span><div><strong>{profile.username}</strong><span>个人研究空间</span></div><button className="icon-button" aria-label="退出登录" onClick={logout}><LogOut size={17} /></button></div></div>
    </aside>
    <div className="workspace"><header className="topbar"><div className="breadcrumb"><BookOpen size={15} /><span>个人研究空间</span><span>/</span><strong>{title}</strong></div><span className="privacy-label"><span />仅你可见</span></header>
      <main className="main-content"><section className="page-heading"><div><span className="eyebrow">积累，始于每一次认真阅读</span><h1>{title}<span className="heading-leaf"><Leaf size={25} /></span></h1><p>{section === 'trash' ? '暂时放下的资料，30 天内可以重新找回。' : section === 'favorite' ? '值得再次回来的论文，都在这里。' : '收好论文，理清方向，把研究线索留在手边。'}</p></div><button className="button primary upload-main" onClick={() => setShowUpload(true)}><Plus size={17} />上传论文</button></section>
      <section className="stats-grid"><div className="stat-card"><span className="stat-icon green"><LibraryBig size={21} /></span><div><span>全部论文</span><strong>{stats.total}<small>篇</small></strong></div><span className="stat-caption">你的知识积累</span></div><div className="stat-card"><span className="stat-icon blue"><BookOpen size={21} /></span><div><span>正在阅读</span><strong>{stats.reading}<small>篇</small></strong></div><span className="stat-caption">保持探索</span></div><div className="stat-card"><span className="stat-icon clay"><CheckCircle2 size={21} /></span><div><span>已经读完</span><strong>{stats.read}<small>篇</small></strong></div><span className="stat-caption">每一篇都有收获</span></div><div className="stat-card"><span className="stat-icon mauve"><Tags size={21} /></span><div><span>研究方向</span><strong>{directionTags.length}<small>个</small></strong></div><button className="stat-link" onClick={() => setManager('research_direction')}>管理方向 <ArrowUpRight size={13} /></button></div></section>
      <section className="library-section"><div className="library-topline"><div className="section-title"><h2>{mode === 'board' ? '阅读进程' : '论文列表'}</h2><span>{library?.total || 0} 篇{hasFilter ? '匹配' : ''}</span>{loading && <span className="loading-label">更新中…</span>}</div><div className="view-switch" role="group" aria-label="论文展示方式">{([{ value: 'grid', label: '卡片视图', icon: <LayoutGrid size={16} /> }, { value: 'list', label: '列表视图', icon: <List size={17} /> }, { value: 'board', label: '阅读看板', icon: <Columns3 size={17} /> }] as const).map(item => <button key={item.value} className={mode === item.value ? 'active' : ''} onClick={() => { setMode(item.value); setPage(1) }} aria-label={item.label} title={item.label} aria-pressed={mode === item.value}>{item.icon}</button>)}</div></div>
      <div className="library-toolbar"><div className="search-field"><Search size={17} /><input ref={searchInput} maxLength={200} value={query} onChange={event => filter(() => setQuery(event.target.value))} placeholder="搜索标题、作者、方向或别名" aria-label="搜索论文" /><kbd>Ctrl K</kbd>{query && <button className="icon-button" aria-label="清除搜索" onClick={() => filter(() => setQuery(''))}><X size={14} /></button>}</div><select value={status} onChange={event => filter(() => setStatus(event.target.value))} aria-label="筛选阅读状态"><option value="">全部阅读状态</option>{Object.entries(statusNames).map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select><button className={`button secondary filter-button ${moreFilters ? 'is-open' : ''}`} onClick={() => setMoreFilters(!moreFilters)}><SlidersHorizontal size={15} />筛选</button><select value={sort} onChange={event => filter(() => setSort(event.target.value))} aria-label="论文排序"><option value="updated">最近更新</option><option value="recent_read">最近阅读</option><option value="created">最近上传</option><option value="year">发表年份</option><option value="title">论文标题</option></select></div>
      {moreFilters && <div className="expanded-filters"><div><label>研究方向</label><div className="filter-directions">{directionTags.map(tag => <button key={tag.id} className={`label-option ${directions.includes(tag.id) ? 'selected' : ''}`} onClick={() => toggleDirection(tag.id)} aria-pressed={directions.includes(tag.id)}>{directions.includes(tag.id) && <Check size={12} />}{tag.name}</button>)}{!directionTags.length && <button className="text-button" onClick={() => setManager('research_direction')}>先添加研究方向</button>}</div></div><div className="filter-extra"><label>方向匹配<select value={match} onChange={event => filter(() => setMatch(event.target.value))} disabled={!directions.length}><option value="any">匹配任一方向</option><option value="all">同时包含全部方向</option></select></label><label>主题<select value={topic} onChange={event => filter(() => setTopic(event.target.value))}><option value="">全部主题</option>{tags.filter(tag => tag.kind === 'topic').map(tag => <option key={tag.id} value={tag.id}>{tag.name}</option>)}</select></label><label>普通标签<select value={tagFilter} onChange={event => filter(() => setTagFilter(event.target.value))}><option value="">全部标签</option>{tags.filter(tag => tag.kind === 'general').map(tag => <option key={tag.id} value={tag.id}>{tag.name}</option>)}</select></label><label>发表年份<input type="number" value={year} placeholder="不限年份" min={1500} max={new Date().getFullYear() + 1} onChange={event => filter(() => setYear(event.target.value))} /></label><button className="text-button" onClick={() => setManager('topic')}>管理主题与标签 <ArrowUpRight size={13} /></button></div></div>}
      {hasFilter && <div className="active-filters"><span>当前筛选</span>{directions.map(id => <button key={id} onClick={() => toggleDirection(id)}>{tags.find(tag => tag.id === id)?.name || '研究方向'}<X size={11} /></button>)}{unclassified && <button onClick={() => filter(() => setUnclassified(false))}>未分类<X size={11} /></button>}{status && <button onClick={() => filter(() => setStatus(''))}>{statusNames[status as ReadingStatus]}<X size={11} /></button>}<button className="clear-filter" onClick={clearFilters}>清除筛选</button></div>}
      {!!selected.size && section !== 'trash' && <div className="selection-bar"><CheckCircle2 size={17} /><strong>已选择 {selected.size} 篇</strong><span>可跨页选择，最多 100 篇</span><button className="button compact primary" onClick={() => setBatch(true)}>批量设置研究方向</button><button className="text-button" onClick={() => setSelected(new Set())}>取消选择</button></div>}
      {error && <div className="library-error" role="alert"><AlertCircle size={18} /><span>{error}</span><button className="text-button" onClick={refresh}>重新加载</button></div>}
      {loading && !library ? <div className="paper-grid">{[1, 2, 3].map(item => <div className="skeleton-card" key={item}><span /><span /><span /></div>)}</div> : !items.length && !error ? <div className="empty-library"><div className="empty-illustration"><FileText size={39} /><span><Leaf size={20} /></span></div><h3>{hasFilter ? '换个线索，再找找看' : section === 'trash' ? '回收站是空的' : section === 'favorite' ? '把值得复读的论文留在这里' : '你的研究积累，从第一篇开始'}</h3><p>{hasFilter ? '暂时没有符合这些条件的论文，可以调整关键词或清除筛选。' : section === 'trash' ? '移入回收站的论文会保留 30 天。' : section === 'favorite' ? '点击论文上的星标，即可加入收藏。' : '上传 PDF，添加研究方向，让每篇论文都有自己的位置。'}</p>{hasFilter ? <button className="button secondary" onClick={clearFilters}>清除筛选</button> : section === 'library' ? <button className="button primary" onClick={() => setShowUpload(true)}><UploadCloud size={17} />上传第一篇论文</button> : <button className="button secondary" onClick={() => navigate('library', 'grid')}>返回论文库</button>}</div> : mode === 'board' && section !== 'trash' ? <div className="reading-board">{(['unread', 'reading', 'read'] as ReadingStatus[]).map(column => <section key={column} className={`board-column ${column}`} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); const paper = items.find(item => item.id === event.dataTransfer.getData('paper-id')); if (paper && paper.reading_status !== column) patchPaper(paper, { reading_status: column }, `已移入${statusNames[column]}。`) }}><header><span className={`status-dot ${column}`} /><strong>{statusNames[column]}</strong><span>{items.filter(paper => paper.reading_status === column).length}</span><MoreHorizontal size={16} /></header><div className="board-papers">{items.filter(paper => paper.reading_status === column).map(paper => renderCard(paper, true))}{!items.some(paper => paper.reading_status === column) && <div className="board-empty">将论文拖到这里，<br />或在卡片上设置阅读状态。</div>}</div></section>)}</div> : mode === 'list' ? <div className="paper-table-wrap"><table className="paper-table"><thead><tr><th><input type="checkbox" aria-label="选择本页全部论文" disabled={section === 'trash'} checked={allChecked} onChange={() => setSelected(previous => { const next = new Set(previous); items.forEach(item => { if (allChecked) next.delete(item.id); else if (next.size < 100) next.add(item.id) }); return next })} /></th><th>论文</th><th>研究方向</th><th>阅读状态</th><th>操作</th></tr></thead><tbody>{items.map(paper => <tr key={paper.id}><td><input type="checkbox" aria-label={`选择 ${paper.title}`} checked={selected.has(paper.id)} disabled={section === 'trash'} onChange={() => toggleSelected(paper.id)} /></td><td><button className="table-title" onClick={() => openPaper(paper, false)}>{paper.title}</button><p>{paper.authors.join('、') || '作者待补充'} · {paper.year || '年份待补充'} · {paper.page_count} 页</p></td><td><div className="table-tags">{paper.research_directions.map(tag => <button className="direction-chip" key={tag.id} onClick={() => addDirection(tag.id)}>{tag.name}</button>)}{!paper.research_directions.length && <span className="muted small">未分类</span>}</div></td><td><select className={`status-select ${paper.reading_status}`} value={paper.reading_status} disabled={!!paper.deleted_at || pending.has(paper.id)} onChange={event => patchPaper(paper, { reading_status: event.target.value })} aria-label={`设置 ${paper.title} 的阅读状态`}>{Object.entries(statusNames).map(([value, name]) => <option value={value} key={value}>{name}</option>)}</select></td><td><div className="row-tools"><button className="icon-button" title={section === 'trash' ? '恢复论文' : '打开论文'} aria-label={`${section === 'trash' ? '恢复' : '打开'} ${paper.title}`} onClick={() => section === 'trash' ? restore(paper) : openPaper(paper, true)}>{section === 'trash' ? <RotateCcw size={16} /> : <ArrowUpRight size={17} />}</button><button className={`icon-button ${paper.is_favorite ? 'favorited' : ''}`} disabled={!!paper.deleted_at || pending.has(paper.id)} aria-label={`收藏 ${paper.title}`} onClick={() => patchPaper(paper, { is_favorite: !paper.is_favorite })}><Star size={16} fill={paper.is_favorite ? 'currentColor' : 'none'} /></button><button className="icon-button" aria-label={`删除 ${paper.title}`} disabled={pending.has(paper.id)} onClick={() => setConfirmation({ paper, action: section === 'trash' ? 'permanent' : 'trash' })}><Trash2 size={15} /></button></div></td></tr>)}</tbody></table></div> : <div className="paper-grid">{items.map(paper => renderCard(paper))}</div>}
      {!!items.length && <footer className="pagination"><span>{mode === 'board' ? '本页阅读进程 · ' : ''}共 {library?.total || 0} 篇论文</span><div><button className="icon-button" disabled={page <= 1 || loading} aria-label="上一页" onClick={() => setPage(page - 1)}><ChevronLeft size={17} /></button><span>{page} / {totalPages}</span><button className="icon-button" disabled={page >= totalPages || loading} aria-label="下一页" onClick={() => setPage(page + 1)}><ChevronRight size={17} /></button></div></footer>}
      </section><footer className="workspace-footer"><span><Leaf size={12} />一点点积累，也是一条研究的路。</span><span>研读 · 个人论文空间</span></footer>
      </main>
    </div>
    {showUpload && <Upload tags={directionTags} onClose={() => setShowUpload(false)} onSaved={refresh} />}
    {manager && <TagManager tags={tags} kind={manager} onClose={() => setManager(null)} onChange={classificationChanged} />}
    {detail && <PaperDetail ref={detailControl} key={detail.id} paper={detail} tags={tags} preview={preview} initialTab={detailTab} enabled={!!auth.user} onClose={() => { setDetail(null); refresh() }} onOpened={refresh} onSaved={paper => { setDetail(paper); void classificationChanged(); refresh() }} onModelSettings={()=>setShowModelSettings(true)} onRead={() => { if (detail.reading_status === 'unread') patchPaper(detail, { reading_status: 'reading' }) }} />}
    {showModelSettings && <ModelSettingsModal onClose={()=>setShowModelSettings(false)} onSaved={()=>{window.dispatchEvent(new Event('paperboard-model-changed'));refresh()}} />}
    {batch && <Batch ids={[...selected]} tags={tags} onClose={() => setBatch(false)} onDone={failed => { setSelected(new Set(failed)); refresh() }} />}
    {confirmation && <Confirm title={confirmation.action === 'permanent' ? '彻底删除这篇论文？' : '将论文移入回收站？'} description={confirmation.action === 'permanent' ? `“${confirmation.paper.title}”及原文将被永久删除，无法在应用内恢复。` : `“${confirmation.paper.title}”及分类关联将一起进入回收站，30 天内可以恢复。`} action={confirmation.action === 'permanent' ? '彻底删除' : '移入回收站'} danger busy={confirmBusy} onConfirm={remove} onClose={() => setConfirmation(null)} />}
    {toast && <div className={`toast ${toast.error ? 'error' : ''}`} role={toast.error ? 'alert' : 'status'}>{toast.error ? <AlertCircle size={18} /> : <CheckCircle2 size={18} />}<span>{toast.message}</span><button className="icon-button" aria-label="关闭提示" onClick={() => setToast(null)}><X size={15} /></button></div>}
  </div>{!auth.user && <Auth initialized={auth.initialized} expired={expired} onLogin={user => { setAuth({ initialized: true, user }); setRememberedUser(user); setExpired(false); refresh() }} />}</>
}
