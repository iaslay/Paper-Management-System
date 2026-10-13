import { cleanup, fireEvent, render, waitFor, act } from '@testing-library/react'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import PaperDetail from './PaperDetail'
import { api, readingApi, type Paper, type Tag } from './api'
import type { MetadataResult } from './ai/MetadataAssist'
import type { ReaderHandle } from './reader/types'

const readerProbe=vi.hoisted(()=>({mounts:0,dirty:false,flush:vi.fn()}))

vi.mock('./api',async()=>{const original=await vi.importActual('./api');return{...original,api:vi.fn(),readingApi:vi.fn()}})
vi.mock('./reader/ReaderWorkspace',async()=>{
  const React=await import('react')
  return {default:React.forwardRef<ReaderHandle>(function ReaderProbe(_props,ref){
    const [note,setNote]=React.useState('')
    React.useEffect(()=>{readerProbe.mounts++},[])
    React.useImperativeHandle(ref,()=>({dirty:()=>readerProbe.dirty,flush:readerProbe.flush,text:()=>note,retry:()=>{}}),[note])
    return <div>测试阅读区域<span>当前第 4 页</span><textarea aria-label="测试未保存笔记" value={note} onChange={event=>{setNote(event.target.value);readerProbe.dirty=true}} /></div>
  })}
})
vi.mock('./ai/CardPanel',()=>({default:()=> <div>测试卡片区域</div>}))
const paper:Paper={id:'a'.repeat(32),title:'论文文件名',authors:[],year:2026,doi:'已有 DOI',original_filename:'paper.pdf',file_size:1000,page_count:18,reading_status:'read',file_hash:'f'.repeat(64),last_read_page:4,last_opened_at:1,is_favorite:false,revision:1,created_at:1,updated_at:1,deleted_at:null,research_directions:[],tags:[],topics:[],card_summary:null,card_status:null}
const tags:Tag[]=[{id:1,kind:'research_direction',name:'已有方向',aliases:[],revision:1,deleted_at:null,merged_into_id:null,paper_count:0}]
const source={page_source_id:'e'.repeat(32),page_number:1}
const result:MetadataResult={fields:{title:{value:'AI 识别的真实标题',sources:[source]},authors:{value:['Alice Example','Bob Example'],sources:[source]},year:{value:null,sources:[]},doi:{value:null,sources:[]}},classifications:[{kind:'research_direction',tag_id:1,name:'已有方向',reason:'对应论文问题',sources:[source]},{kind:'topic',tag_id:null,name:'新主题',reason:'研究主题',sources:[source]},{kind:'general',tag_id:null,name:'新标签',reason:'便于查找',sources:[source]}],warnings:[],analyzed_pages:[1,2,3,4,18]}
const task={id:'b'.repeat(32),status:'succeeded',stage:'succeeded',progress:100,metadata:result,error_message:null,reserved_tokens:200000,charged_tokens:1000,usage_unknown:false}
let saved:Record<string,any>[]
beforeEach(()=>{
  localStorage.clear();readerProbe.mounts=0;readerProbe.dirty=false;readerProbe.flush.mockResolvedValue(true)
  saved=[];vi.clearAllMocks()
  vi.mocked(api).mockImplementation(async(path)=>{if(path.endsWith('/metadata-tasks'))return[];if(path.startsWith('/card-tasks/'))return task;throw new Error('未模拟请求')})
  vi.mocked(readingApi).mockImplementation(async(path,options)=>{
    if(path.endsWith('/metadata-tasks'))return structuredClone(task)
    if(options?.method==='PATCH'){
      const body=JSON.parse(options.body as string);saved.push(body)
      return{...paper,title:body.title,authors:body.authors,year:body.year,doi:body.doi,revision:2,research_directions:body.research_direction_ids.map((id:number)=>({id,name:'已有方向'})),topics:body.new_labels.filter((label:any)=>label.kind==='topic').map((label:any)=>({id:4,name:label.name})),tags:body.new_labels.filter((label:any)=>label.kind==='general').map((label:any)=>({id:5,name:label.name})),resolved_labels:body.new_labels.map((label:any)=>({...label,id:label.kind==='topic'?4:5}))}
    }
    throw new Error('未模拟写入')
  })
})
afterEach(()=>{cleanup();vi.useRealTimers();vi.restoreAllMocks()})
function view(onClose=vi.fn(),onSaved=vi.fn(),currentPaper=paper) {return <PaperDetail paper={currentPaper} tags={tags} preview={false} enabled={true} onClose={onClose} onSaved={onSaved} onRead={vi.fn()} onOpened={vi.fn()} onModelSettings={vi.fn()} />}

function readingView(onClose=vi.fn(),currentPaper=paper) {return <PaperDetail paper={currentPaper} tags={tags} preview enabled onClose={onClose} onSaved={vi.fn()} onRead={vi.fn()} onOpened={vi.fn()} onModelSettings={vi.fn()} />}

it('切换全页面与小窗时保留当前页和未保存笔记，阅读器不重建',async()=>{
  const rendered=render(readingView())
  await rendered.findByText('测试阅读区域')
  fireEvent.change(rendered.getByLabelText('测试未保存笔记'),{target:{value:'正在编辑的阅读理解'}})
  const mounts=readerProbe.mounts
  fireEvent.click(rendered.getByRole('button',{name:'全页面阅读'}))
  expect(rendered.getByRole('dialog',{name:paper.title}).classList.contains('reader-full-page')).toBe(true)
  expect((rendered.getByLabelText('测试未保存笔记') as HTMLTextAreaElement).value).toBe('正在编辑的阅读理解')
  expect(rendered.getByText('当前第 4 页')).toBeTruthy()
  fireEvent.click(rendered.getByRole('button',{name:'返回小窗'}))
  expect(rendered.getByRole('dialog',{name:paper.title}).classList.contains('reader-full-page')).toBe(false)
  expect(readerProbe.mounts).toBe(mounts);expect(readerProbe.flush).not.toHaveBeenCalled();expect(readingApi).not.toHaveBeenCalled()
})

it('记住阅读布局，重开其他论文沿用选择，切到信息页仍可操作',async()=>{
  const first=render(readingView())
  fireEvent.click(first.getByRole('button',{name:'全页面阅读'}))
  expect(localStorage.getItem('paperboard-reader-layout')).toBe('full-page')
  first.unmount()
  const second=render(readingView(vi.fn(),{...paper,id:'b'.repeat(32),title:'另一篇论文'}))
  expect(second.getByRole('button',{name:'返回小窗'})).toBeTruthy()
  fireEvent.click(second.getByRole('button',{name:'论文信息'}))
  expect(second.queryByRole('button',{name:'返回小窗'})).toBeNull()
  expect(second.getByRole('dialog',{name:'论文详情'}).classList.contains('reader-full-page')).toBe(false)
  fireEvent.click(second.getByRole('button',{name:'阅读与记录'}))
  expect(second.getByRole('button',{name:'返回小窗'})).toBeTruthy()
  fireEvent.click(second.getByRole('button',{name:'返回小窗'}))
  expect(localStorage.getItem('paperboard-reader-layout')).toBe('window')
})

it('浏览器存储不可用时仍可在当前页面切换布局',()=>{
  vi.spyOn(Storage.prototype,'getItem').mockImplementation(()=>{throw new Error('存储不可用')})
  vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw new Error('存储不可用')})
  const rendered=render(readingView())
  fireEvent.click(rendered.getByRole('button',{name:'全页面阅读'}))
  expect(rendered.getByRole('button',{name:'返回小窗'})).toBeTruthy()
})

it('全页面关闭仍等待保存，保存失败时保留阅读界面并提示处理草稿',async()=>{
  const close=vi.fn(),rendered=render(readingView(close))
  await rendered.findByText('测试阅读区域')
  fireEvent.change(rendered.getByLabelText('测试未保存笔记'),{target:{value:'需要保存的笔记'}})
  readerProbe.flush.mockResolvedValue(false)
  fireEvent.click(rendered.getByRole('button',{name:'全页面阅读'}))
  fireEvent.click(rendered.getByRole('button',{name:'关闭窗口'}))
  await rendered.findByRole('heading',{name:'处理未保存的内容'})
  expect(readerProbe.flush).toHaveBeenCalledOnce();expect(close).not.toHaveBeenCalled()
  expect((rendered.getByLabelText('测试未保存笔记') as HTMLTextAreaElement).value).toBe('需要保存的笔记')
})

it('从库卡片直达阅读卡片，不打开阅读器或改动阅读状态', async () => {
  const onRead=vi.fn()
  const rendered=render(<PaperDetail paper={paper} tags={tags} preview={false} initialTab="card" enabled={true} onClose={vi.fn()} onSaved={vi.fn()} onRead={onRead} onOpened={vi.fn()} onModelSettings={vi.fn()} />)
  await rendered.findByText('测试卡片区域')
  expect(rendered.queryByText('测试阅读区域')).toBeNull()
  expect(onRead).not.toHaveBeenCalled(); expect(readingApi).not.toHaveBeenCalled()
})

it('AI 填写字段与分类，缺失信息和阅读状态保留，显式保存才提交',async()=>{
  const rendered=render(view())
  fireEvent.click(rendered.getByRole('button',{name:'AI 识别并填写'}))
  await waitFor(()=>expect((rendered.getByLabelText('论文标题') as HTMLTextAreaElement).value).toBe('AI 识别的真实标题'))
  expect((rendered.getByLabelText('作者') as HTMLInputElement).value).toBe('Alice Example；Bob Example')
  expect((rendered.getByLabelText('发表年份') as HTMLInputElement).value).toBe('2026')
  expect((rendered.getByLabelText('DOI') as HTMLInputElement).value).toBe('已有 DOI')
  expect((rendered.getByLabelText('阅读状态') as HTMLSelectElement).value).toBe('read')
  expect(saved).toEqual([])
  fireEvent.change(rendered.getByLabelText('待新建主题名称 1'),{target:{value:'修改后的主题'}})
  fireEvent.click(rendered.getByRole('button',{name:'保存信息'}))
  await waitFor(()=>expect(saved.length).toBe(1))
  expect(saved[0].new_labels).toEqual([{name:'修改后的主题',kind:'topic'},{name:'新标签',kind:'general'}])
  expect(saved[0].reading_status).toBe('read');expect(saved[0].file_hash).toBe(paper.file_hash)
  expect(saved[0].research_direction_ids).toEqual([1])
})

it('等待识别时的人工标题和分类编辑不会被结果覆盖',async()=>{
  let resolve!:(value:unknown)=>void
  vi.mocked(readingApi).mockImplementation(()=>new Promise(done=>{resolve=done}))
  const rendered=render(view())
  fireEvent.click(rendered.getByRole('button',{name:'AI 识别并填写'}))
  fireEvent.change(rendered.getByLabelText('论文标题'),{target:{value:'等待时手工修改的标题'}})
  fireEvent.click(rendered.getByRole('button',{name:'已有方向'}))
  await act(async()=>{resolve(task)})
  expect((rendered.getByLabelText('论文标题') as HTMLTextAreaElement).value).toBe('等待时手工修改的标题')
  expect(rendered.getByRole('button',{name:'已有方向'}).getAttribute('aria-pressed')).toBe('true')
  expect((rendered.getByLabelText('作者') as HTMLInputElement).value).toContain('Alice Example')
  expect(rendered.getByRole('status').textContent).toContain('等待期间的修改')
})

it('普通标签超过十个后仍可填入建议，按二十个合计上限控制',async()=>{
  const rendered=render(view(vi.fn(),vi.fn(),{...paper,tags:Array.from({length:11},(_,index)=>({id:index+10,name:`已有标签${index}`}))}))
  fireEvent.click(rendered.getByRole('button',{name:'AI 识别并填写'}))
  await waitFor(()=>expect(rendered.getByLabelText('待新建普通标签名称 2')).toBeTruthy())
  const checkbox=rendered.getByRole('checkbox',{name:/新建普通标签：新标签/}) as HTMLInputElement
  expect(checkbox.checked).toBe(true);expect(checkbox.disabled).toBe(false)
})

it('AI 填写后关闭窗口需要处理未保存表单',async()=>{
  const close=vi.fn(),rendered=render(view(close))
  fireEvent.click(rendered.getByRole('button',{name:'AI 识别并填写'}))
  await waitFor(()=>expect((rendered.getByLabelText('论文标题') as HTMLTextAreaElement).value).toBe(result.fields.title.value))
  fireEvent.click(rendered.getByRole('button',{name:'关闭'}))
  await waitFor(()=>expect(rendered.getByRole('heading',{name:'处理未保存的内容'})).toBeTruthy())
  expect(close).not.toHaveBeenCalled()
})

it('保存响应不确定时重试原请求，之后的编辑仍保留',async()=>{
  const original=vi.mocked(readingApi).getMockImplementation()!,sent:Record<string,any>[]=[]
  vi.mocked(readingApi).mockImplementation(async(path,options)=>{
    if(options?.method==='PATCH'){
      sent.push(JSON.parse(options.body as string));if(sent.length===1)throw new Error('连接中断')
    }
    return original(path,options)
  })
  const rendered=render(view())
  fireEvent.click(rendered.getByRole('button',{name:'AI 识别并填写'}))
  await waitFor(()=>expect((rendered.getByLabelText('论文标题') as HTMLTextAreaElement).value).toBe(result.fields.title.value))
  fireEvent.click(rendered.getByRole('button',{name:'保存信息'}))
  await waitFor(()=>expect(rendered.getByRole('alert').textContent).toContain('连接中断'))
  fireEvent.change(rendered.getByLabelText('论文标题'),{target:{value:'失败后新编辑的标题'}})
  fireEvent.click(rendered.getByRole('button',{name:'保存信息'}))
  await waitFor(()=>expect(sent.length).toBe(2))
  expect(sent[1]).toEqual(sent[0])
  expect((rendered.getByLabelText('论文标题') as HTMLTextAreaElement).value).toBe('失败后新编辑的标题')
  await waitFor(()=>expect(rendered.getByRole('status').textContent).toContain('之后的修改仍保留'))
})

it('离开论文信息页后停止识别轮询',async()=>{
  vi.useFakeTimers()
  vi.mocked(readingApi).mockResolvedValue({...task,status:'queued',stage:'queued',progress:0,metadata:null})
  vi.mocked(api).mockImplementation(async(path)=>path.endsWith('/metadata-tasks')?[]:{...task,status:'running',stage:'metadata',metadata:null})
  const rendered=render(view())
  await act(async()=>{fireEvent.click(rendered.getByRole('button',{name:'AI 识别并填写'}))})
  await act(async()=>{await vi.advanceTimersByTimeAsync(1500)})
  const count=vi.mocked(api).mock.calls.filter(([path])=>path.startsWith('/card-tasks/')).length
  expect(count).toBe(1)
  await act(async()=>{fireEvent.click(rendered.getByRole('button',{name:'简介卡片'}))})
  await act(async()=>{await vi.advanceTimersByTimeAsync(5000)})
  expect(vi.mocked(api).mock.calls.filter(([path])=>path.startsWith('/card-tasks/')).length).toBe(count)
})
