import { createRef } from 'react'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import CardPanel from './CardPanel'
import ModelSettingsModal from './ModelSettings'
import { changeProtocol } from './modelConnection'
import { api, readingApi, type Paper } from '../api'
import type { ReaderHandle } from '../reader/types'
import { emptyCard, type CardState, type CardVersion, type ModelSettings, type Usage, type CardTask } from './types'

vi.mock('../api', async()=>{const original=await vi.importActual('../api');return {...original,api:vi.fn(),readingApi:vi.fn()}})
const paper:Paper={id:'a'.repeat(32),title:'测试论文',authors:[],year:null,doi:null,original_filename:'test.pdf',file_size:300,page_count:2,reading_status:'read',file_hash:'f'.repeat(64),last_read_page:1,last_opened_at:1,is_favorite:false,revision:1,created_at:1,updated_at:1,deleted_at:null,research_directions:[],tags:[],topics:[],card_summary:null,card_status:null}
const config:ModelSettings={revision:1,provider:'responses',base_url:'https://example.com/v1',model:'test-vision',enabled:true,auto_on_read:false,input_mode:'auto',structured_output:true,batch_pages:12,max_request_bytes:20*1024**2,image_long_edge:1600,max_output_tokens:8000,max_calls:40,input_tokens_per_page:6000,max_task_tokens:500000,monthly_token_limit:2000000,timeout_seconds:120,has_key:true,tested_mode:'pdf',tested_at:1,test_error:null}
const usage:Usage={month:'2026-10',occupied_tokens:0,accounted_tokens:0,reserved_tokens:0,unknown_tasks:0,task_count:0,monthly_token_limit:2000000,connection_test_calls:0,calls:[]}
let state:CardState, jobs:CardTask[]
function version(id='b'.repeat(32)):CardVersion {const data=emptyCard();data.summary.text='已有简介';data.research_question.text='研究问题';data.method.text='方法';return{id,paper_id:paper.id,file_hash:paper.file_hash,sequence:1,data,source:'manual',confirmed_at:null,created_at:1,warnings:[],base_version_id:null}}
beforeEach(()=>{
  vi.clearAllMocks();jobs=[];const saved=version();state={paper_id:paper.id,card_revision:1,current_version_id:saved.id,versions:[saved],decisions:{}}
  vi.mocked(api).mockImplementation(async(path)=>{
    if(path.endsWith('/card'))return structuredClone(state)
    if(path.endsWith('/card-tasks'))return structuredClone(jobs)
    if(path==='/settings/model')return {...config}
    if(path==='/settings/model/usage')return {...usage}
    if(path.endsWith('/card-sources'))return[]
    if(path.includes('/notes?'))return{items:[],total:0,page:1,page_size:50}
    throw new Error('未模拟的请求：'+path)
  })
  vi.mocked(readingApi).mockImplementation((path,options)=>api(path,options))
})
afterEach(()=>{cleanup();vi.useRealTimers()})
function panel(ref=createRef<ReaderHandle>(),enabled=true,active=true){return <CardPanel ref={ref} paper={paper} enabled={enabled} active={active} onGo={vi.fn()} onSettings={vi.fn()} onChanged={vi.fn()} onPaperChanged={vi.fn()} />}

it('保存响应未知时复用原请求，后续输入保留并建立另一份版本',async()=>{
  const reference=createRef<ReaderHandle>(),view=render(panel(reference))
  await waitFor(()=>expect(view.getByRole('button',{name:'编辑卡片'})).toBeTruthy())
  fireEvent.click(view.getByRole('button',{name:'编辑卡片'}))
  fireEvent.change(view.getByLabelText('卡片一句话简介'),{target:{value:'第一次提交的简介'}})
  const sent:Record<string,any>[]=[]
  vi.mocked(readingApi).mockImplementation(async(_,options)=>{const payload=JSON.parse(options!.body as string);sent.push(payload);if(sent.length===1)throw new Error('连接中断');return{version:{...version('c'.repeat(32)),sequence:sent.length,data:payload.data},card_revision:1}})
  fireEvent.click(view.getByRole('button',{name:'保存为新版本'}))
  await waitFor(()=>expect(view.getByRole('alert').textContent).toContain('连接中断'))
  fireEvent.change(view.getByLabelText('卡片一句话简介'),{target:{value:'失败后补充的新简介'}})
  fireEvent.click(view.getByRole('button',{name:'安全重试保存'}))
  await waitFor(()=>expect(sent.length).toBe(2))
  expect(sent[1].request_id).toBe(sent[0].request_id)
  expect(sent[1].data.summary.text).toBe('第一次提交的简介')
  expect((view.getByLabelText('卡片一句话简介') as HTMLTextAreaElement).value).toBe('失败后补充的新简介')
  await waitFor(()=>expect(view.getByRole('button',{name:'保存为新版本'})).toBeTruthy())
  fireEvent.click(view.getByRole('button',{name:'保存为新版本'}))
  await waitFor(()=>expect(sent.length).toBe(3))
  expect(sent[2].request_id).not.toBe(sent[1].request_id)
  expect(sent[2].data.summary.text).toBe('失败后补充的新简介')
  await waitFor(()=>expect(reference.current!.dirty()).toBe(false))
})

it('退出登录后保留卡片输入，离开检查拒绝未保存内容被跳过',async()=>{
  const reference=createRef<ReaderHandle>(),view=render(panel(reference))
  await waitFor(()=>expect(view.getByRole('button',{name:'编辑卡片'})).toBeTruthy())
  fireEvent.click(view.getByRole('button',{name:'编辑卡片'}))
  fireEvent.change(view.getByLabelText('卡片一句话简介'),{target:{value:'会话过期时保留'}})
  view.rerender(panel(reference,false,false))
  expect(reference.current!.dirty()).toBe(true)
  let saved=true;await act(async()=>{saved=await reference.current!.flush()})
  expect(saved).toBe(false);expect(readingApi).not.toHaveBeenCalled()
  expect((view.getByLabelText('卡片一句话简介') as HTMLTextAreaElement).value).toBe('会话过期时保留')
})

it('生成请求默认不包含个人笔记，重复提交不因网络异常更换请求标识',async()=>{
  const view=render(panel())
  await waitFor(()=>expect(view.getByRole('button',{name:'重新生成草稿'})).toBeTruthy())
  const original=vi.mocked(api).getMockImplementation()!,sent:Record<string,any>[]=[]
  vi.mocked(api).mockImplementation(async(path,options)=>{
    if(path.endsWith('/card-tasks') && options?.method==='POST'){
      const body=JSON.parse(options.body as string);sent.push(body)
      if(sent.length===1)throw new Error('连接中断')
      return{id:'d'.repeat(32),paper_id:paper.id,status:'queued',stage:'queued',progress:0,error_message:null,error_code:null,result_version_id:null,charged_tokens:0,reserved_tokens:10000,usage_unknown:false,created_at:1}
    }
    return original(path,options)
  })
  fireEvent.click(view.getByRole('button',{name:'重新生成草稿'}))
  await waitFor(()=>expect(view.getByRole('alert').textContent).toContain('连接中断'))
  fireEvent.click(view.getByRole('button',{name:'重试提交生成请求'}))
  await waitFor(()=>expect(sent.length).toBe(2))
  expect(sent[0].note_ids).toEqual([]);expect(sent[1]).toEqual(sent[0])
})

it('隐藏卡片页后停止任务轮询',async()=>{
  vi.useFakeTimers()
  jobs=[{id:'d'.repeat(32),paper_id:paper.id,status:'queued',stage:'queued',progress:0,error_message:null,error_code:null,result_version_id:null,charged_tokens:0,reserved_tokens:10000,usage_unknown:false,created_at:1}]
  const reference=createRef<ReaderHandle>();let view:ReturnType<typeof render>
  await act(async()=>{view=render(panel(reference))})
  await act(async()=>{await vi.advanceTimersByTimeAsync(2000)})
  const calls=vi.mocked(api).mock.calls.filter(([path])=>path.endsWith('/card-tasks')).length
  expect(calls).toBeGreaterThan(1)
  view!.rerender(panel(reference,true,false))
  await act(async()=>{await vi.advanceTimersByTimeAsync(6000)})
  expect(vi.mocked(api).mock.calls.filter(([path])=>path.endsWith('/card-tasks')).length).toBe(calls)
})

it('保存模型密钥后清空输入，测试只针对已保存配置版本',async()=>{
  const calls:{path:string;body:Record<string,any>}[]=[]
  vi.mocked(api).mockImplementation(async(path,options)=>{
    if(options?.body)calls.push({path,body:JSON.parse(options.body as string)})
    if(path==='/settings/model/usage')return usage
    if(path==='/settings/model/test')return{...config,revision:2}
    if(path==='/settings/model')return options?.method==='PUT'?{...config,revision:2}:config
    throw new Error('请求未模拟')
  })
  const view=render(<ModelSettingsModal onClose={vi.fn()} onSaved={vi.fn()} />)
  await waitFor(()=>expect(view.getByLabelText('模型 API 密钥')).toBeTruthy())
  fireEvent.change(view.getByLabelText('模型 API 密钥'),{target:{value:'private-key-never-returned'}})
  fireEvent.click(view.getByRole('button',{name:'保存并测试视觉能力'}))
  await waitFor(()=>expect(view.getByRole('status').textContent).toContain('测试通过'))
  expect((view.getByLabelText('模型 API 密钥') as HTMLInputElement).value).toBe('')
  expect(calls[0].body.api_key).toBe('private-key-never-returned')
  expect(calls[1]).toEqual({path:'/settings/model/test',body:{revision:2}})
})

it('DeepSeek 预设使用官方模型标识和图片模式，保留已有密钥',async()=>{
  const sent:Record<string,any>[]=[]
  vi.mocked(api).mockImplementation(async(path,options)=>{
    if(path==='/settings/model/usage')return usage
    if(path==='/settings/model/test')return{...config,revision:2,base_url:'https://api.deepseek.com',model:'deepseek-flash',input_mode:'images',tested_mode:'images'}
    if(path==='/settings/model'){
      if(options?.method==='PUT'){const body=JSON.parse(options.body as string);sent.push(body);return{...body,has_key:true}}
      return{...config,base_url:'https://api.deepseek.com/responses',model:'DeepSeek-V4.1-Flash'}
    }
    throw new Error('未模拟请求')
  })
  const view=render(<ModelSettingsModal onClose={vi.fn()} onSaved={vi.fn()} />)
  await waitFor(()=>expect(view.getByRole('button',{name:'填入 DeepSeek 推荐配置'})).toBeTruthy())
  expect(view.getByText('实际请求地址：https://api.deepseek.com/responses')).toBeTruthy()
  fireEvent.click(view.getByRole('button',{name:'填入 DeepSeek 推荐配置'}))
  expect((view.getByLabelText('模型名称') as HTMLInputElement).value).toBe('deepseek-flash')
  expect((view.getByLabelText('输入模式') as HTMLSelectElement).value).toBe('images')
  fireEvent.click(view.getByRole('button',{name:'保存并测试视觉能力'}))
  await waitFor(()=>expect(view.getByRole('status').textContent).toContain('页面图片'))
  expect(sent[0].base_url).toBe('https://api.deepseek.com');expect(sent[0].api_key).toBeUndefined()
})

it('切换接口协议保留自定义服务，避免把请求转到其他服务商',()=>{
  const changed=changeProtocol({...config,base_url:'https://my-service.example/v1/responses'},'chat')
  expect(changed.base_url).toBe('https://my-service.example/v1')
  expect(changed.provider).toBe('chat')
})

it('任务完成后先载入新草稿，再停止轮询，不中止结果请求',async()=>{
  vi.useFakeTimers()
  state={paper_id:paper.id,card_revision:0,current_version_id:null,versions:[],decisions:{}}
  const queued:CardTask={id:'e'.repeat(32),paper_id:paper.id,status:'queued',stage:'queued',progress:0,error_message:null,error_code:null,result_version_id:null,charged_tokens:0,reserved_tokens:10000,usage_unknown:false,created_at:1}
  const original=vi.mocked(api).getMockImplementation()!
  vi.mocked(api).mockImplementation(async(path,options)=>{
    if(path.endsWith('/card-tasks') && options?.method==='POST'){jobs=[queued];return queued}
    if(path.endsWith('/card') && state.versions.length){await Promise.resolve();if(options?.signal?.aborted)throw new Error('结果被中止');return structuredClone(state)}
    return original(path,options)
  })
  let view:ReturnType<typeof render>;await act(async()=>{view=render(panel())})
  await act(async()=>{fireEvent.click(view!.getByRole('button',{name:'生成简介卡片'}))})
  const generated=version('f'.repeat(32));generated.data.summary.text='新完成的卡片草稿'
  state={paper_id:paper.id,card_revision:1,current_version_id:generated.id,versions:[generated],decisions:{}}
  jobs=[{...queued,status:'succeeded',stage:'succeeded',progress:100,result_version_id:generated.id}]
  await act(async()=>{await vi.advanceTimersByTimeAsync(2000)})
  expect(view!.getByText('新完成的卡片草稿')).toBeTruthy()
  expect(view!.getByRole('button',{name:'编辑卡片'})).toBeTruthy()
})
