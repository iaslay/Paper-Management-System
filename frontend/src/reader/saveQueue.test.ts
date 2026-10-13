import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SaveQueue } from './saveQueue'
import { ApiError } from '../api'

interface Remote { id: string; revision: number; content: string }
const remote: Remote = { id: 'note', revision: 1, content: '原记录' }
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
function make(writer: (value: string, remote: Remote | null, request: string) => Promise<Remote>) { const queue = new SaveQueue<string, Remote>('原记录', remote, writer, value => value.trim() ? null : '内容不能为空'); queue.setEnabled(true); return queue }
beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('串行保存与草稿保护', () => {
  it('停止输入一秒后才保存', async () => {
    const writer = vi.fn(async (value: string) => ({ ...remote, content: value, revision: 2 }))
    const queue = make(writer); queue.set('新内容')
    await vi.advanceTimersByTimeAsync(999); expect(writer).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1); expect(writer).toHaveBeenCalledTimes(1)
    expect(queue.snapshot().remote?.content).toBe('新内容'); expect(queue.dirty()).toBe(false)
  })
  it('请求期间继续输入，旧响应不覆盖草稿且下一次用新版本', async () => {
    const first = deferred<Remote>(), second = deferred<Remote>()
    const writer = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const queue = make(writer); queue.set('第一批输入'); const saving = queue.flush()
    queue.set('最新编辑'); expect(writer).toHaveBeenCalledTimes(1)
    first.resolve({ ...remote, content: '第一批输入', revision: 2 }); await Promise.resolve(); await Promise.resolve()
    expect(queue.snapshot().draft).toBe('最新编辑')
    await vi.advanceTimersByTimeAsync(0)
    expect(writer).toHaveBeenCalledTimes(2); expect(writer.mock.calls[1][1].revision).toBe(2)
    second.resolve({ ...remote, content: '最新编辑', revision: 3 }); await saving
    expect(queue.dirty()).toBe(false)
  })
  it('响应丢失先用同一请求确认旧载荷，再提交新编辑', async () => {
    const calls: { value: string; request: string; revision: number }[] = []
    let first = true
    const queue = make(async (value, previous, request) => {
      calls.push({ value, request, revision: previous!.revision })
      if (first) { first = false; throw new Error('响应丢失') }
      return { ...remote, content: value, revision: previous!.revision + 1 }
    })
    queue.set('已经提交的内容'); expect(await queue.flush()).toBe(false)
    queue.set('后续输入'); await queue.flush()
    expect(calls).toHaveLength(3); expect(calls[0].request).toBe(calls[1].request); expect(calls[1].value).toBe('已经提交的内容')
    expect(calls[2].request).not.toBe(calls[1].request); expect(calls[2].value).toBe('后续输入'); expect(calls[2].revision).toBe(2)
  })
  it('冲突暂停保存并保留双方内容，明确选择后使用当前版本', async () => {
    const current = { ...remote, revision: 7, content: '服务器内容' }
    const writer = vi.fn().mockRejectedValueOnce(new ApiError('版本冲突', 409, 'revision_conflict', current)).mockImplementation(async (value, previous) => ({ ...current, content: value, revision: previous.revision + 1 }))
    const queue = make(writer); queue.set('我的草稿'); await queue.flush(); await vi.advanceTimersByTimeAsync(20000)
    expect(writer).toHaveBeenCalledTimes(1); expect(queue.snapshot().draft).toBe('我的草稿'); expect(queue.snapshot().current).toEqual(current)
    queue.overwrite(current); await vi.advanceTimersByTimeAsync(0)
    expect(writer.mock.calls[1][1].revision).toBe(7); expect(queue.snapshot().remote?.content).toBe('我的草稿')
  })
  it('输入法组合期间与登录暂停期间不提交', async () => {
    const writer = vi.fn(async (value: string) => ({ ...remote, content: value, revision: 2 }))
    const queue = make(writer); queue.composition(true); queue.set('中文组合中')
    await vi.advanceTimersByTimeAsync(2000); expect(writer).not.toHaveBeenCalled()
    queue.composition(false); queue.setEnabled(false); await vi.advanceTimersByTimeAsync(2000); expect(writer).not.toHaveBeenCalled()
    queue.setEnabled(true); await vi.advanceTimersByTimeAsync(1000); expect(writer).toHaveBeenCalledTimes(1)
  })
  it('新建草稿在创建结果返回前不发送第二次创建', async () => {
    const create = deferred<Remote>(), patch = deferred<Remote>(), writer = vi.fn().mockReturnValueOnce(create.promise).mockReturnValueOnce(patch.promise)
    const queue = new SaveQueue<string, Remote>('', null, writer, (value: string) => value ? null : '空白')
    queue.setEnabled(true); queue.set('开始记录'); const saving = queue.flush(); queue.set('完成记录')
    expect(writer.mock.calls[0][1]).toBeNull(); create.resolve({ id: 'created', content: '开始记录', revision: 1 }); await vi.advanceTimersByTimeAsync(0)
    expect(writer.mock.calls[1][1].id).toBe('created'); patch.resolve({ id: 'created', content: '完成记录', revision: 2 }); await saving
  })
  it('失败只自动重试两次，仍保留草稿', async () => {
    const writer = vi.fn(async () => { throw new Error('网络不可用') })
    const queue = make(writer); queue.set('离线编辑'); await queue.flush(); await vi.advanceTimersByTimeAsync(20000)
    expect(writer).toHaveBeenCalledTimes(3); expect(queue.snapshot().draft).toBe('离线编辑'); expect(queue.dirty()).toBe(true)
  })
  it('清空已保存内容不会自动删除或写空字符串', async () => {
    const writer = vi.fn(async () => remote), queue = make(writer)
    queue.set('  '); expect(await queue.flush()).toBe(false); expect(writer).not.toHaveBeenCalled(); expect(queue.snapshot().phase).toBe('invalid')
  })
  it('删除前等待创建请求确认，清空草稿也不会留下不可识别的记录', async () => {
    const creating = deferred<Remote>(), writer = vi.fn().mockReturnValue(creating.promise)
    const queue = new SaveQueue<string, Remote>('', null, writer, value => value.trim() ? null : '空白')
    queue.setEnabled(true); queue.set('先提交的内容'); const saving = queue.flush(); queue.set('')
    const settled = queue.settle(); creating.resolve({ id: 'confirmed', revision: 1, content: '先提交的内容' })
    expect(await settled).toBe(true); await saving
    expect(queue.snapshot().remote?.id).toBe('confirmed'); expect(writer).toHaveBeenCalledTimes(1)
  })
  it('未提交的新草稿删除时不额外创建记录', async () => {
    const writer = vi.fn(async () => remote), queue = new SaveQueue<string, Remote>('', null, writer, value => value ? null : '空白')
    queue.setEnabled(true); queue.set('尚未提交'); expect(await queue.settle()).toBe(true)
    expect(writer).not.toHaveBeenCalled(); expect(queue.snapshot().remote).toBeNull()
  })
})
