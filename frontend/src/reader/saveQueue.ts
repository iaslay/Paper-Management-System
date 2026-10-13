import { ApiError } from '../api'

export type SavePhase = 'empty' | 'dirty' | 'saving' | 'saved' | 'failed' | 'conflict' | 'paused' | 'invalid'
export interface SaveSnapshot<T, R> { draft: T; remote: R | null; phase: SavePhase; error: Error | null; savedAt: number | null; current: R | null }
type Writer<T, R> = (value: T, remote: R | null, requestId: string) => Promise<R>

export class SaveQueue<T, R> {
  private listeners = new Set<() => void>()
  private timer?: ReturnType<typeof setTimeout>
  private running: Promise<boolean> | null = null
  private pending: { value: T; remote: R | null; requestId: string; sequence: number } | null = null
  private sequence = 0
  private confirmed = 0
  private retries = 0
  private enabled = false
  private composing = false
  private state: SaveSnapshot<T, R>
  onSaved?: (remote: R) => void

  constructor(value: T, remote: R | null, private writer: Writer<T, R>, private validate: (value: T) => string | null) {
    this.state = { draft: value, remote, phase: remote ? 'saved' : 'empty', error: null, savedAt: null, current: null }
  }
  snapshot = () => this.state
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private publish(change: Partial<SaveSnapshot<T, R>>) { this.state = { ...this.state, ...change }; this.listeners.forEach(listener => listener()) }
  private cancelTimer() { clearTimeout(this.timer); this.timer = undefined }
  private schedule(delay = 1000) { this.cancelTimer(); if (this.enabled && !this.composing) this.timer = setTimeout(() => { void this.flush() }, delay) }
  dirty = () => this.sequence > this.confirmed || this.pending !== null
  pause = () => { this.enabled = false; this.cancelTimer() }
  setEnabled(enabled: boolean) {
    const changed = this.enabled !== enabled
    this.enabled = enabled
    if (!enabled) { this.cancelTimer(); return }
    if (changed && this.dirty() && this.state.phase !== 'conflict' && this.state.phase !== 'invalid') {
      if (this.state.phase === 'paused') this.publish({ phase: 'dirty', error: null })
      this.schedule()
    }
  }
  composition(value: boolean) { this.composing = value; this.cancelTimer(); if (!value && this.dirty()) this.schedule() }
  set(value: T) {
    if (JSON.stringify(value) === JSON.stringify(this.state.draft)) return
    this.sequence++
    const error = this.validate(value)
    // 已明确拒绝的请求可以换成新载荷；响应不确定的请求必须先确认。
    if (this.pending && this.state.error instanceof ApiError && this.state.error.status >= 400 && this.state.error.status < 500 && this.state.error.status !== 401) this.pending = null
    this.retries = 0
    this.publish({ draft: value, phase: this.state.phase === 'conflict' ? 'conflict' : error ? 'invalid' : 'dirty', error: error ? new Error(error) : null })
    this.cancelTimer()
    if (!error && this.state.phase !== 'conflict') this.schedule()
  }
  start() { if (!this.state.remote && !this.validate(this.state.draft) && !this.dirty()) { this.sequence++; this.publish({ phase: 'dirty' }); this.schedule() } }
  adopt(remote: R, value: T) {
    this.cancelTimer(); this.pending = null; this.sequence++; this.confirmed = this.sequence; this.retries = 0
    this.publish({ remote, draft: value, current: null, error: null, phase: 'saved', savedAt: Date.now() })
  }
  overwrite(remote: R) {
    this.pending = null; this.sequence++; this.retries = 0
    this.publish({ remote, current: null, error: null, phase: 'dirty' }); void this.flush()
  }
  conflict(current: R, error: Error) { this.cancelTimer(); this.pending = null; this.publish({ phase: 'conflict', current, error }) }
  settle = async (): Promise<boolean> => {
    // 删除前确认已经提交的请求，空白草稿无需先创建再删除。
    this.cancelTimer()
    if (this.running) await this.running
    if (this.pending && this.enabled) await this.flush()
    this.cancelTimer()
    return !this.pending && !this.running && this.state.phase !== 'conflict'
  }
  retry = () => { this.retries = 0; if (this.state.phase !== 'conflict') { this.publish({ phase: 'dirty', error: null }); void this.flush() } }
  flush = async (): Promise<boolean> => {
    this.cancelTimer()
    if (this.running) { await this.running; return this.dirty() && this.state.phase === 'dirty' ? this.flush() : !this.dirty() }
    if (!this.dirty()) return true
    if (!this.enabled || this.composing || this.state.phase === 'conflict') return false
    if (!this.pending) {
      const validation = this.validate(this.state.draft)
      if (validation) { this.publish({ phase: 'invalid', error: new Error(validation) }); return false }
      this.pending = { value: structuredClone(this.state.draft), remote: this.state.remote, requestId: crypto.randomUUID().replaceAll('-', ''), sequence: this.sequence }
    }
    const pending = this.pending
    this.publish({ phase: 'saving', error: null })
    this.running = this.writer(pending.value, pending.remote, pending.requestId).then(remote => {
      this.confirmed = pending.sequence; this.pending = null; this.retries = 0
      this.publish({ remote, phase: this.dirty() ? 'dirty' : 'saved', savedAt: Date.now(), error: null })
      this.onSaved?.(remote)
      if (this.dirty()) this.schedule()
      return !this.dirty()
    }).catch((cause: unknown) => {
      const error = cause instanceof Error ? cause : new Error('保存未完成，请重试。')
      if (error instanceof ApiError && error.status === 409 && error.code === 'revision_conflict') {
        this.pending = null; this.publish({ phase: 'conflict', current: error.current as R, error })
      } else if (error instanceof ApiError && error.status === 401) {
        this.enabled = false; this.publish({ phase: 'paused', error })
      } else {
        const retryable = !(error instanceof ApiError) || error.status >= 500
        if (!retryable) this.pending = null
        this.publish({ phase: 'failed', error })
        if (retryable && this.retries < 2) { this.schedule(this.retries++ === 0 ? 2000 : 5000) }
      }
      return false
    }).finally(() => { this.running = null })
    const ok = await this.running
    return ok || (this.state.phase === 'dirty' ? this.flush() : false)
  }
}
