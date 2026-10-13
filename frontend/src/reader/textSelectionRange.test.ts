import { afterEach, expect, it } from 'vitest'
import { textSelectionRange } from './geometry'

afterEach(() => { window.getSelection()?.removeAllRanges(); document.body.replaceChildren() })
function setup() {
  document.body.innerHTML = '<p id="before">页前内容</p><div class="textLayer"><span>第一行文字</span><span>第二行文字</span></div><p id="after">页后内容</p>'
  const layer = document.querySelector<HTMLElement>('.textLayer')!
  return { layer, first: layer.children[0].firstChild!, last: layer.children[1].firstChild!, before: document.querySelector('#before')!.firstChild!, after: document.querySelector('#after')!.firstChild!, selection: window.getSelection()! }
}
it('保留正向和反向跨行拖选的文字范围', () => {
  const { layer, first, last, selection } = setup()
  selection.setBaseAndExtent(first, 1, last, 3)
  expect(textSelectionRange(selection, layer)?.toString()).toBe('一行文字第二行')
  selection.setBaseAndExtent(last, 3, first, 1)
  expect(textSelectionRange(selection, layer)?.toString()).toBe('一行文字第二行')
})
it('拖过页尾及页首时截取本页，不丢弃已选文字或带入其他内容', () => {
  const { layer, first, last, before, after, selection } = setup()
  selection.setBaseAndExtent(first, 1, after, 2)
  expect(textSelectionRange(selection, layer)?.toString()).toBe('一行文字第二行文字')
  selection.setBaseAndExtent(last, 3, before, 1)
  expect(textSelectionRange(selection, layer)?.toString()).toBe('第一行文字第二行')
})
it('空选区及读者在笔记或其他元素中的选择不生成高亮', () => {
  const { layer, first, before, after, selection } = setup()
  expect(textSelectionRange(selection, layer)).toBeNull()
  selection.collapse(first, 2); expect(textSelectionRange(selection, layer)).toBeNull()
  selection.setBaseAndExtent(before, 0, after, 2); expect(textSelectionRange(selection, layer)).toBeNull()
})
