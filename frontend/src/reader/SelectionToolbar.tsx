import { useEffect, useRef, useState } from 'react'
import type { Color, SelectionValue } from './types'
import { colors } from './types'
import { Languages } from 'lucide-react'

export default function SelectionToolbar({ selection, canHighlight, onCreate, onClose, onTranslate }: { selection: SelectionValue; canHighlight: boolean; onCreate: (color: Color, comment?: string) => void; onClose: () => void; onTranslate: () => void }) {
  const [color, setColor] = useState<Color>('yellow'), [withComment, setWithComment] = useState(false), [comment, setComment] = useState('')
  const close = useRef(onClose); close.current = onClose
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); close.current() } }
    document.addEventListener('keydown', escape, true)
    return () => document.removeEventListener('keydown', escape, true)
  }, [])
  return <section className="reader-selection" aria-label="文字选区操作"><p>第 {selection.page_number} 页 · {Array.from(selection.quote).length} 字符</p><blockquote>{selection.quote}</blockquote><div className="reader-inline-tools"><button type="button" className="button compact secondary" onMouseDown={event => event.preventDefault()} onClick={onTranslate}><Languages size={14} />翻译</button><select aria-label="高亮颜色" disabled={!canHighlight} value={color} onChange={event => setColor(event.target.value as Color)}>{Object.entries(colors).map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select><button type="button" className="button compact primary" disabled={!canHighlight} onMouseDown={event => event.preventDefault()} onClick={() => onCreate(color)}>保存高亮</button><button type="button" className="button compact secondary" disabled={!canHighlight} onMouseDown={event => event.preventDefault()} onClick={() => setWithComment(true)}>高亮并记笔记</button><button type="button" className="text-button" onClick={onClose}>取消选区</button></div>{withComment && <div className="reader-comment-compose"><label>高亮评论<textarea aria-label="新高亮评论" value={comment} rows={3} onChange={event => setComment(event.target.value)} placeholder="写下理解或疑问" /></label><button className="button compact primary" disabled={!comment.trim() || Array.from(comment).length > 10000} onClick={() => onCreate(color, comment)}>保存高亮与评论</button></div>}</section>
}
