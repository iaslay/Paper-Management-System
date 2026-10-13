import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { MessageSquare, Send, Plus, Sparkles, Copy, Square, BookOpen } from 'lucide-react'
import { api, readingApi, ApiError, type Paper } from '../api'
import { Confirm } from '../components'
import type { ReaderHandle } from '../reader/types'
import type { CardTask } from './types'
import './discussion.css'

interface Session { id: string; title: string; paper_id: string; updated_at: number }
interface Message { id: string; role: 'user' | 'assistant'; content: string; status: string; task_id: string | null; error_message: string | null; evidence: {page_number:number;excerpt:string;description:string}[]; context: {model?:string;text_pages?:number[];image_pages?:number[];clipped_pages?:number[];empty_pages?:number[];history_count?:number} }
interface Detail { session: Session; messages: Message[]; tasks: CardTask[]; model: {name:string;enabled:boolean}; current_page: number }
const stages: Record<string,string> = {queued:'排队中',preparing:'准备论文上下文',discussion:'正在思考并生成',repairing:'核对回答格式',validating:'保存回答与来源',waiting_retry:'等待重试'}
const activeStatuses = new Set(['queued','running','waiting_retry'])
const examples = ['这篇论文要解决什么问题，核心方法是什么？','请解释实验设计，结果有哪些适用条件？','方法有哪些局限，哪些改进值得进一步验证？']
export default forwardRef<ReaderHandle, {paper:Paper;enabled:boolean;active:boolean;openSession?:{id:string;nonce:number}|null;onGo:(page:number)=>void;onCard:(id:string)=>void;onChanged:()=>void;onSettings:()=>void}>(function DiscussionPanel({paper,enabled,active,openSession,onGo,onCard,onChanged,onSettings}, ref) {
  const [sessions,setSessions] = useState<Session[]>([]), [sessionId,setSessionId] = useState<string|null>(null), [detail,setDetail] = useState<Detail|null>(null)
  const [input,setInput] = useState(''), [pages,setPages] = useState(''), [error,setError] = useState(''), [notice,setNotice] = useState(''), [busy,setBusy] = useState(false), [switchTo,setSwitchTo] = useState<string|null>(null), [copyFallback,setCopyFallback] = useState('')
  const current = useRef({input,sessionId,enabled}); current.current={input,sessionId,enabled}
  const mounted = useRef(true), list = useRef<HTMLDivElement>(null), scrollRequested = useRef(false), followReplies = useRef(true), pagesInitialized = useRef<string|null>(null)
  const pending = useRef<{session:string;kind:'messages'|'card-tasks';body:Record<string,unknown>;text:string}|null>(null), newRequest = useRef<string|null>(null), requestLock = useRef(false)
  const dirty = !!input.trim() || !!pending.current
  const task = detail?.tasks.find(job=>activeStatuses.has(job.status)), latestCardTask=detail?.tasks.find(job=>job.purpose==='discussion_card'), cardTask=detail?.tasks.find(job=>job.purpose==='discussion_card' && job.status==='succeeded' && job.result_version_id)
  const readOnly = !enabled || !!paper.deleted_at
  const lastReply=detail?.tasks.find(job=>job.purpose==='discussion_reply')
  const shownNotice = !task && !busy && notice==='问题已保存，正在生成回答。'?(lastReply?.status==='succeeded'?'回答已保存，可以继续追问或生成卡片。':'问题已保存，回答未完成。'):!task && !busy && notice.startsWith('正在根据这段讨论')?(latestCardTask?.status==='succeeded'?'卡片草稿已保存，核对并确认后更新当前卡片。':'讨论记录已保留，卡片生成未完成。'):notice
  useImperativeHandle(ref,()=>({dirty:()=>!!current.current.input.trim() || !!pending.current,flush:async()=>!current.current.input.trim() && !pending.current,text:()=>[current.current.input,pending.current?.text || ''].filter(Boolean).join('\n'),retry:()=>{setNotice('未发送的问题仍保留，点击发送或安全重试后再关闭。')}}),[])
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false}},[])
  useEffect(()=>{if(!dirty)return;const before=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue=''};window.addEventListener('beforeunload',before);return()=>window.removeEventListener('beforeunload',before)},[dirty])
  async function loadSessions(signal?:AbortSignal) {
    const items = await api<Session[]>(`/papers/${paper.id}/discussions`,{signal})
    if (signal?.aborted || !mounted.current)return
    setSessions(items);setSessionId(previous=>previous && items.some(item=>item.id===previous)?previous:items[0]?.id || null)
  }
  async function loadDetail(id:string,signal?:AbortSignal) {
    const data=await api<Detail>(`/discussions/${id}`,{signal})
    if(signal?.aborted || !mounted.current || current.current.sessionId!==id)return
    setDetail(data);setSessions(previous=>previous.map(item=>item.id===id?data.session:item))
    if(pagesInitialized.current!==id){setPages(String(data.current_page));pagesInitialized.current=id}
  }
  useEffect(()=>{
    if(!active || !enabled)return
    const controller=new AbortController()
    void loadSessions(controller.signal).catch(cause=>{if(!controller.signal.aborted)setError(cause.message)})
    return()=>controller.abort()
  },[paper.id,active,enabled])
  useEffect(()=>{
    if(!active || !sessionId)return
    const controller=new AbortController();setDetail(null)
    void loadDetail(sessionId,controller.signal).catch(cause=>{if(!controller.signal.aborted)setError(cause.message)})
    const modelChanged=()=>void loadDetail(sessionId,controller.signal).catch(cause=>{if(!controller.signal.aborted)setError(cause.message)})
    window.addEventListener('paperboard-model-changed',modelChanged)
    return()=>{controller.abort();window.removeEventListener('paperboard-model-changed',modelChanged)}
  },[sessionId,active])
  useEffect(()=>{
    if(!active || !sessionId || !task)return
    const controller=new AbortController(), timer=window.setInterval(()=>void loadDetail(sessionId,controller.signal).catch(cause=>{if(!controller.signal.aborted)setError(cause.message)}),1500)
    return()=>{controller.abort();window.clearInterval(timer)}
  },[active,sessionId,!!task])
  useEffect(()=>{
    if(!active || !openSession)return
    if(current.current.input.trim() || pending.current){setNotice('当前未发送的问题已保留，请先发送或处理后再切换关联讨论。');return}
    setSessionId(openSession.id)
  },[openSession?.nonce,active])
  useEffect(()=>{if((scrollRequested.current || followReplies.current) && list.current){list.current.scrollTop=list.current.scrollHeight;scrollRequested.current=false}},[detail?.messages.map(item=>`${item.id}:${item.status}`).join('|')])
  async function createSession() {
    if(requestLock.current || readOnly)return
    requestLock.current=true;setBusy(true);setError('')
    newRequest.current ||= crypto.randomUUID().replaceAll('-','')
    try {
      const session=await readingApi<Session>(`/papers/${paper.id}/discussions`,{method:'POST',body:JSON.stringify({request_id:newRequest.current,file_hash:paper.file_hash})})
      if(!mounted.current)return
      newRequest.current=null;setSessions(previous=>[session,...previous.filter(item=>item.id!==session.id)]);setSessionId(session.id);setInput('');setNotice('');setDetail(null)
    }catch(cause){setError((cause as Error).message)}finally{requestLock.current=false;if(mounted.current)setBusy(false)}
  }
  function switchSession(id:string) {
    if(requestLock.current || pending.current){setError('上次提交结果尚未确认，请先安全重试原请求。');return}
    if(input.trim()){setSwitchTo(id);return}
    if(id==='new')void createSession();else{setSessionId(id);setNotice('');setError('')}
  }
  function selectedPages():number[] {
    if(!pages.trim())return[]
    const numbers=pages.split(/[,，、\s]+/).map(value=>Number(value))
    if(numbers.length>3 || numbers.some(value=>!Number.isInteger(value) || value<1 || value>paper.page_count))throw new Error(`请输入最多3个有效页码，范围1～${paper.page_count}，用逗号分隔。`)
    return [...new Set(numbers)]
  }
  async function submit(kind:'messages'|'card-tasks',override?:string) {
    if(requestLock.current || readOnly || !sessionId)return
    if(!pending.current && (task || !detail?.model.enabled))return
    if(pending.current && (pending.current.kind!==kind || pending.current.session!==sessionId)){setError('上次提交结果尚未确认，请先安全重试原请求。');return}
    requestLock.current=true;setBusy(true);setError('');setNotice('')
    try{
      if(!pending.current){const text=(override ?? input).trim();if(kind==='messages' && (!text || Array.from(text).length>2000))throw new Error('请输入1～2000字符的问题。');pending.current={session:sessionId,kind,text,body:{request_id:crypto.randomUUID().replaceAll('-',''),file_hash:paper.file_hash,selected_pages:selectedPages(),...(kind==='messages'?{content:text}:{})}}}
      const sent=pending.current
      await readingApi<CardTask>(`/discussions/${sent.session}/${sent.kind}`,{method:'POST',body:JSON.stringify(sent.body)})
      if(!mounted.current)return
      if(sent.kind==='messages' && override===undefined && current.current.input.trim()===sent.text)setInput('')
      pending.current=null;scrollRequested.current=true;await loadDetail(sent.session);onChanged()
      setNotice(sent.kind==='card-tasks'?'正在根据这段讨论生成独立卡片草稿，已有卡片保持原有内容。':'问题已保存，正在生成回答。')
    }catch(cause){setError((cause as Error).message);if(cause instanceof ApiError && cause.status<500 && cause.status!==401)pending.current=null}
    finally{requestLock.current=false;if(mounted.current)setBusy(false)}
  }
  async function cancel() {
    if(!task)return
    try{await api(`/card-tasks/${task.id}/cancel`,{method:'POST'});if(sessionId)await loadDetail(sessionId);setNotice('已停止后续生成，问题和已有回答已保留。')}catch(cause){setError((cause as Error).message)}
  }
  async function copy(value:string){try{await navigator.clipboard.writeText(value);setNotice('已复制回答。')}catch{setCopyFallback(value)}}
  return <section className="discussion-panel" aria-label="论文讨论">
    <header className="discussion-header"><div><MessageSquare size={19}/><strong>论文讨论</strong><span>{detail?.model.name || '沿用论文模型 · DeepSeek'}</span></div><div><select aria-label="选择本篇论文讨论" value={sessionId || ''} disabled={busy || !!pending.current} onChange={event=>switchSession(event.target.value)}><option value="" disabled>选择讨论</option>{sessions.map(session=><option key={session.id} value={session.id}>{session.title}</option>)}</select><button className="button compact secondary" disabled={readOnly || busy} onClick={()=>switchSession('new')}><Plus size={14}/>新讨论</button></div></header>
    {error && <p className="discussion-notice error" role="alert">{error}<button className="text-button" onClick={()=>void (sessionId?loadDetail(sessionId):loadSessions()).catch(cause=>setError(cause.message))}>重新加载</button></p>}
    {shownNotice && <p className="discussion-notice" role="status">{shownNotice}</p>}
    {latestCardTask?.status==='failed' && <p className="discussion-notice error" role="alert">卡片生成失败：{latestCardTask.error_message || '请稍后重新生成。'} 已有卡片保留，可点击“根据讨论生成卡片”重试。</p>}
    <div className="discussion-messages" ref={list} onScroll={event=>{const element=event.currentTarget;followReplies.current=element.scrollHeight-element.clientHeight-element.scrollTop<100}}>
      {!sessionId?<div className="discussion-empty"><MessageSquare size={32}/><h3>围绕这篇论文聊一聊</h3><p>讨论研究问题、方法、实验和局限，之后把有价值的结论整理进卡片。</p><button className="button primary" disabled={readOnly || busy} onClick={()=>void createSession()}>开始论文讨论</button></div>:!detail?<p className="discussion-empty">正在加载讨论…</p>:!detail.messages.length?<div className="discussion-empty"><h3>从一个具体问题开始</h3><p>默认使用现有论文模型。发送时包含论文文字、选定原文页和聊天上下文；个人笔记不会自动纳入。</p><div>{examples.map(example=><button className="discussion-example" key={example} onClick={()=>setInput(example)}>{example}</button>)}</div></div>:detail.messages.map(message=><article key={message.id} className={`discussion-message ${message.role}`} aria-label={message.role==='user'?'我的问题':'AI 回答'}><div className="discussion-message-author"><strong>{message.role==='user'?'我':message.context.model || 'AI 助手'}</strong>{message.content && message.role==='assistant' && <button className="text-button" onClick={()=>void copy(message.content)}><Copy size={12}/>复制回答</button>}</div>{message.content?<p>{message.content}</p>:<p className="discussion-pending">{activeStatuses.has(message.status)?stages[task?.stage || 'queued'] || '正在生成回答…':message.error_message || (message.status==='cancelled'?'已停止这次回答。':'这次回答未完成，可以重试。')}</p>}{message.evidence.length>0 && <div className="discussion-evidence">{message.evidence.map((source,index)=><button className="text-button" title={source.excerpt || source.description} key={index} onClick={()=>onGo(source.page_number)}><BookOpen size={12}/>原文第 {source.page_number} 页</button>)}</div>}{message.context.text_pages && <small className="discussion-context">本次文字覆盖 {message.context.text_pages.length} 页 · 补充原文页 {message.context.image_pages?.join('、') || '无'} · 使用 {message.context.history_count || 0} 条历史消息{message.context.clipped_pages?.length?' · 部分文字截断':''}{message.context.empty_pages?.length?' · 部分页面没有可提取文字':''}</small>}{message.role==='assistant' && !message.content && !activeStatuses.has(message.status) && <button className="text-button" disabled={readOnly || busy || !!task} onClick={()=>{const index=detail.messages.indexOf(message),question=detail.messages[index-1];if(question?.role==='user')void submit('messages',question.content)}}>重新回答这个问题</button>}</article>)}
    </div>
    {copyFallback && <label className="discussion-copy">请选择内容后按 Ctrl+C<textarea aria-label="手动复制回答" readOnly value={copyFallback} onFocus={event=>event.currentTarget.select()}/><button className="text-button" onClick={()=>setCopyFallback('')}>收起</button></label>}
    {task && <div className="discussion-task" role="status"><span>{stages[task.stage] || stages[task.status] || '处理中'} · {task.progress}%</span><button className="text-button" onClick={()=>void cancel()}><Square size={12}/>停止生成</button></div>}
    {sessionId && detail && <footer className="discussion-composer"><div className="discussion-card-actions"><button className="button compact secondary" disabled={readOnly || busy || !!task || !detail.messages.some(message=>message.role==='assistant' && message.status==='completed') || !!pending.current} onClick={()=>void submit('card-tasks')}><Sparkles size={14}/>根据讨论生成卡片</button>{cardTask?.result_version_id && <button className="text-button" onClick={()=>onCard(cardTask.result_version_id!)}>查看卡片草稿 ↗</button>}</div>{!detail.model.enabled && <p className="discussion-notice">论文模型尚未启用或通过测试。<button className="text-button" onClick={onSettings}>打开模型设置</button></p>}<textarea aria-label="论文讨论问题" value={input} rows={3} maxLength={2000} disabled={readOnly} onChange={event=>setInput(event.target.value)} placeholder="问一个具体问题，或说说你对这篇论文的理解…" onKeyDown={event=>{if(event.key==='Enter' && (event.ctrlKey || event.metaKey)){event.preventDefault();void submit('messages')}}}/><div className="discussion-composer-tools"><label>补充原文页<input aria-label="讨论补充原文页码" value={pages} disabled={busy || readOnly || !!pending.current} onChange={event=>setPages(event.target.value)} placeholder="最多3页，如 1,3"/></label><small>{Array.from(input).length}/2000 · Ctrl+Enter 发送</small>{pending.current?<button className="button primary" disabled={busy || readOnly} onClick={()=>void submit(pending.current!.kind)}>安全重试提交</button>:<button className="button primary" disabled={readOnly || busy || !!task || !detail.model.enabled || !input.trim()} onClick={()=>void submit('messages')}><Send size={14}/>发送</button>}</div></footer>}
    {switchTo && <Confirm title="切换到其他讨论？" description="当前未发送的问题会被放弃；已发送的讨论记录会保留。" action="放弃未发送问题并切换" busy={busy} onClose={()=>setSwitchTo(null)} onConfirm={()=>{const id=switchTo;setSwitchTo(null);setInput('');if(id==='new')void createSession();else setSessionId(id)}}/>}
  </section>
})
