import { useState, type FormEvent } from 'react'
import { BookOpen, ArrowUpRight, Leaf, Eye, EyeOff, ShieldCheck } from 'lucide-react'
import { api, type User } from './api'

export default function Auth({ initialized, onLogin, expired }: { initialized: boolean; onLogin: (user: User) => void; expired: boolean }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [space, setSpace] = useState('我的论文库')
  const [visible, setVisible] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!initialized && password !== confirmation) { setError('两次输入的密码不一致，请重新检查。'); return }
    setBusy(true); setError('')
    try {
      const result = await api<{ user: User }>(initialized ? '/session' : '/setup', { method: 'POST', body: JSON.stringify({ username, password, ...(!initialized ? { workspace_name: space } : {}) }) })
      onLogin(result.user)
    } catch (cause) { setError((cause as Error).message) }
    finally { setBusy(false) }
  }
  return <div className="auth-page">
    <section className="auth-story">
      <div className="brand"><span className="brand-mark"><BookOpen size={24} /></span><span>研读<span className="brand-sub">论文看板</span></span></div>
      <div className="story-center"><span className="eyebrow">把知识，留在手边</span><h1>让每一次阅读，<br />都有迹可循。</h1><p>收好论文，理清研究方向。<br />给认真读过的内容，一个可以回来的地方。</p>
        <div className="paper-art" aria-hidden="true"><div className="art-sheet back" /><div className="art-sheet front"><span className="art-number">01</span><div className="art-rule long" /><div className="art-rule" /><div className="art-graph"><span /><span /><span /><span /><span /></div><div className="art-rule long" /><div className="art-rule long" /><div className="art-rule short" /><div className="art-tag"><Leaf size={13} />研究的下一步</div></div><div className="art-orbit" /></div>
      </div><div className="story-footer">收集 <span>·</span> 分类 <span>·</span> 回顾</div>
    </section>
    <section className="auth-form-area"><div className="auth-form-wrap"><span className="step-label">{initialized ? '欢迎回来' : '从这里开始'}</span><h2>{initialized ? '继续你的研究' : '建立个人论文空间'}</h2><p className="muted">{initialized ? '登录后，接着整理你的阅读线索。' : '设置唯一账号，保护你的论文与研究记录。'}</p>
      {expired && <div className="notice">登录已过期。重新登录后可以继续刚才的操作。</div>}
      <form onSubmit={submit}>
        {!initialized && <label>论文库名称<input required maxLength={50} value={space} onChange={event => setSpace(event.target.value)} autoComplete="organization" /></label>}
        <label>用户名<input required minLength={3} maxLength={64} value={username} onChange={event => setUsername(event.target.value)} placeholder="输入至少 3 个字符" autoComplete="username" /></label>
        <label>密码<div className="password-field"><input required type={visible ? 'text' : 'password'} minLength={12} maxLength={128} value={password} onChange={event => setPassword(event.target.value)} placeholder="至少 12 个字符" autoComplete={initialized ? 'current-password' : 'new-password'} /><button type="button" aria-label={visible ? '隐藏密码' : '显示密码'} onClick={() => setVisible(!visible)}>{visible ? <EyeOff size={17} /> : <Eye size={17} />}</button></div></label>
        {!initialized && <label>再次输入密码<input required type="password" minLength={12} maxLength={128} value={confirmation} onChange={event => setConfirmation(event.target.value)} autoComplete="new-password" /></label>}
        {error && <div className="error-message" role="alert">{error}</div>}
        <button className="button primary auth-submit" disabled={busy}>{busy ? '正在处理…' : initialized ? '进入论文库' : '创建论文空间'}<ArrowUpRight size={17} /></button>
      </form><p className="auth-security"><ShieldCheck size={16} />私人空间，文件访问需要登录。</p>
    </div><span className="auth-bottom">研读 · 让知识沉淀，让思考生长</span></section>
  </div>
}
