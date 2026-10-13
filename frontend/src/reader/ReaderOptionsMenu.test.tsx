import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import ReaderOptionsMenu from './ReaderOptionsMenu'
import { Modal } from '../components'
import type { Paper } from '../api'

const paper:Paper={id:'a'.repeat(32),title:'测试阅读论文',authors:[],year:2026,doi:null,original_filename:'paper.pdf',file_size:1000,page_count:18,reading_status:'read',file_hash:'f'.repeat(64),last_read_page:2,last_opened_at:1,is_favorite:false,revision:1,created_at:1,updated_at:1,deleted_at:null,research_directions:[],tags:[],topics:[],card_summary:null,card_status:null}
afterEach(()=>{cleanup();vi.restoreAllMocks()})

it('更多菜单保留论文信息、卡片、下载与重新加载入口，执行后收起菜单',()=>{
  const onInfo=vi.fn(),onCard=vi.fn(),onReload=vi.fn()
  const view=render(<ReaderOptionsMenu paper={paper} onInfo={onInfo} onCard={onCard} onReload={onReload} />)
  const summary=view.getByLabelText('更多阅读操作'),details=summary.closest('details')!
  expect(details.open).toBe(false)
  fireEvent.click(summary);fireEvent.click(view.getByRole('button',{name:'论文信息'}));expect(onInfo).toHaveBeenCalledOnce();expect(details.open).toBe(false)
  fireEvent.click(summary);fireEvent.click(view.getByRole('button',{name:'简介卡片'}));expect(onCard).toHaveBeenCalledOnce()
  fireEvent.click(summary);expect(view.getByRole('link',{name:'下载原文'}).getAttribute('href')).toBe(`/api/v1/papers/${paper.id}/file?download=true`)
  fireEvent.click(view.getByRole('button',{name:'重新加载原文'}));expect(onReload).toHaveBeenCalledOnce();expect(details.open).toBe(false)
})

it('退出键优先收起菜单，点击论文区域收起菜单并继续阅读',()=>{
  const close=vi.fn()
  const view=render(<Modal title="测试阅读" onClose={close}><ReaderOptionsMenu paper={paper} onInfo={vi.fn()} onCard={vi.fn()} onReload={vi.fn()} /><div data-testid="paper">论文区域</div></Modal>)
  vi.spyOn(view.getByRole('dialog'),'getClientRects').mockReturnValue([{}] as unknown as DOMRectList)
  const summary=view.getByLabelText('更多阅读操作'),details=summary.closest('details')!
  fireEvent.click(summary);fireEvent.keyDown(summary,{key:'Escape'})
  expect(details.open).toBe(false);expect(close).not.toHaveBeenCalled()
  fireEvent.click(summary);fireEvent.pointerDown(view.getByTestId('paper'));expect(details.open).toBe(false)
  fireEvent.keyDown(view.getByRole('dialog'),{key:'Escape'});expect(close).toHaveBeenCalledOnce()
})
