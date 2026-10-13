import type { SavePhase } from './saveQueue'

const names: Record<SavePhase, string> = { empty: '输入后自动保存', dirty: '尚未保存', saving: '正在保存…', saved: '已保存', failed: '保存未完成', conflict: '存在版本冲突', paused: '登录后继续保存', invalid: '请检查内容' }
export default function SaveStatus({ phase, error, savedAt, onRetry }: { phase: SavePhase; error?: Error | null; savedAt?: number | null; onRetry?: () => void }) {
  return <div className={`reader-save-status ${phase}`} role="status"><span>{names[phase]}{phase === 'saved' && savedAt ? `于 ${new Date(savedAt).toLocaleTimeString('zh-CN', { hour12: false })}` : ''}</span>{error && <span className="save-error">{error.message}</span>}{onRetry && phase === 'failed' && <button type="button" className="text-button" onClick={onRetry}>重试保存</button>}</div>
}
