import { createRef } from 'react'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import DiscussionPanel from './DiscussionPanel'
import { api, readingApi, ApiError, type Paper } from '../api'
import type { ReaderHandle } from '../reader/types'

vi.mock('../api',async()=>({...await vi.importActual('../api'),api:vi.fn(),readingApi:vi.fn()}))
const paper={id:'paper',file_hash:'hash',page_count:18,deleted_at:null} as Paper
const session={id:'session',title:'论文讨论',paper_id:'paper',updated_at:1}
const message={id:'reply',role:'assistant',content:'这是已保存的论文解释。',status:'completed',task_id:'job',error_message:null,evidence:[{page_number:3,excerpt:'原文摘要',description:''}],context:{model:'deepseek-flash',text_pages:[1,2,3],image_pages:[3]}}
let data:any
beforeEach(()=>{
  vi.clearAllMocks();data={session,messages:[message],tasks:[],model:{name:'deepseek-flash',enabled:true},current_page:3}
  vi.mocked(api).mockImplementation(async path=>path.endsWith('/discussions')?[session]:structuredClone(data))
  vi.mocked(readingApi).mockResolvedValue({id:'new-job',status:'queued'})
})
afterEach(()=>{cleanup();vi.useRealTimers();vi.unstubAllGlobals()})
function view(extra:Record<string,any>={}){return <DiscussionPanel paper={paper} enabled={true} active={true} onGo={vi.fn()} onCard={vi.fn()} onChanged={vi.fn()} onSettings={vi.fn()} {...extra}/>}
async function opened(extra:Record<string,any>={}){const result=render(view(extra));await result.findByText(message.content);return result}

it('沿用论文模型，打开讨论不调用模型，引用可回跳原文页',async()=>{
  const go=vi.fn(),result=await opened({onGo:go})
  expect(result.getAllByText('deepseek-flash').length).toBeGreaterThan(0)
  expect(readingApi).not.toHaveBeenCalled()
  expect((result.getByLabelText('讨论补充原文页码') as HTMLInputElement).value).toBe('3')
  fireEvent.click(result.getByRole('button',{name:'原文第 3 页'}));expect(go).toHaveBeenCalledWith(3)
})
it('显式发送问题时携带当前讨论、原文版本和所选页，成功后清空已提交输入',async()=>{
  const result=await opened()
  fireEvent.change(result.getByLabelText('论文讨论问题'),{target:{value:'为什么使用这种实验设计？'}})
  fireEvent.click(result.getByRole('button',{name:'发送'}))
  await waitFor(()=>expect(readingApi).toHaveBeenCalledOnce())
  expect(vi.mocked(readingApi).mock.calls[0][0]).toBe('/discussions/session/messages')
  expect(JSON.parse(vi.mocked(readingApi).mock.calls[0][1]?.body as string)).toMatchObject({file_hash:'hash',content:'为什么使用这种实验设计？',selected_pages:[3]})
  await waitFor(()=>expect((result.getByLabelText('论文讨论问题') as HTMLTextAreaElement).value).toBe(''))
})
it('保存响应不确定时安全重试原请求，等待时的新问题仍保留',async()=>{
  const result=await opened()
  vi.mocked(readingApi).mockRejectedValueOnce(new Error('连接中断'))
  fireEvent.change(result.getByLabelText('论文讨论问题'),{target:{value:'第一条问题'}})
  fireEvent.click(result.getByRole('button',{name:'发送'}));await result.findByRole('alert')
  const first=vi.mocked(readingApi).mock.calls[0][1]?.body
  fireEvent.change(result.getByLabelText('论文讨论问题'),{target:{value:'提交后的新问题'}})
  fireEvent.click(result.getByRole('button',{name:'安全重试提交'}))
  await waitFor(()=>expect(readingApi).toHaveBeenCalledTimes(2))
  expect(vi.mocked(readingApi).mock.calls[1][1]?.body).toBe(first)
  expect((result.getByLabelText('论文讨论问题') as HTMLTextAreaElement).value).toBe('提交后的新问题')
})
it('未发送问题加入窗口离开保护，不通过关闭触发模型',async()=>{
  const handle=createRef<ReaderHandle>(),result=await opened({ref:handle})
  fireEvent.change(result.getByLabelText('论文讨论问题'),{target:{value:'尚未发送的理解'}})
  expect(handle.current?.dirty()).toBe(true)
  expect(await handle.current?.flush()).toBe(false)
  expect(handle.current?.text()).toContain('尚未发送的理解')
  expect(readingApi).not.toHaveBeenCalled()
})
it('整理讨论卡片及查看指定草稿，不自动执行确认',async()=>{
  data.tasks=[{id:'card-job',purpose:'discussion_card',status:'succeeded',result_version_id:'version-new'}]
  const card=vi.fn(),result=await opened({onCard:card})
  fireEvent.click(result.getByRole('button',{name:'根据讨论生成卡片'}))
  await waitFor(()=>expect(readingApi).toHaveBeenCalledOnce())
  expect(vi.mocked(readingApi).mock.calls[0][0]).toBe('/discussions/session/card-tasks')
  expect(JSON.parse(vi.mocked(readingApi).mock.calls[0][1]?.body as string).content).toBeUndefined()
  fireEvent.click(result.getByRole('button',{name:'查看卡片草稿 ↗'}));expect(card).toHaveBeenCalledWith('version-new')
})
it('无效补充页码不提交，停止等待中的任务保留已有回答',async()=>{
  const result=await opened()
  fireEvent.change(result.getByLabelText('讨论补充原文页码'),{target:{value:'19'}})
  fireEvent.change(result.getByLabelText('论文讨论问题'),{target:{value:'请解释这页'}})
  fireEvent.click(result.getByRole('button',{name:'发送'}));await result.findByRole('alert')
  expect(readingApi).not.toHaveBeenCalled()
  data.tasks=[{id:'queued',status:'running',stage:'discussion',progress:30}]
  fireEvent.click(result.getByRole('button',{name:'重新加载'}));await result.findByRole('button',{name:'停止生成'})
  fireEvent.click(result.getByRole('button',{name:'停止生成'}))
  await waitFor(()=>expect(vi.mocked(api).mock.calls.some(([path])=>path==='/card-tasks/queued/cancel')).toBe(true))
  expect(result.getByText(message.content)).toBeTruthy()
})
it('不可写的论文不能发起讨论或整理卡片',async()=>{
  const result=await opened({paper:{...paper,deleted_at:1}})
  expect((result.getByRole('button',{name:'根据讨论生成卡片'}) as HTMLButtonElement).disabled).toBe(true)
  expect((result.getByLabelText('论文讨论问题') as HTMLTextAreaElement).disabled).toBe(true)
})
it('卡片任务失败显示可重试原因，已有回答仍可查看',async()=>{
  data.tasks=[{id:'failed-card',purpose:'discussion_card',status:'failed',error_message:'接口暂时不可用'}]
  const result=await opened()
  expect(result.getByRole('alert').textContent).toContain('接口暂时不可用')
  expect(result.getByRole('alert').textContent).toContain('已有卡片保留')
  expect((result.getByRole('button',{name:'根据讨论生成卡片'}) as HTMLButtonElement).disabled).toBe(false)
})
it('正在生成时快捷键不能提交第二个问题',async()=>{
  data.tasks=[{id:'running',purpose:'discussion_reply',status:'running',stage:'discussion',progress:20}]
  const result=await opened()
  fireEvent.change(result.getByLabelText('论文讨论问题'),{target:{value:'另一条问题'}})
  fireEvent.keyDown(result.getByLabelText('论文讨论问题'),{key:'Enter',ctrlKey:true})
  expect(readingApi).not.toHaveBeenCalled()
})
