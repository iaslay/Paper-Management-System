import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import MathText from './MathText'

afterEach(cleanup)

it('用户示例中的四个行内公式渲染上下标与希腊字母，中文叙述保留', () => {
  const text = String.raw`为确保纵向连贯性，TheraMind 整合了一个动态记忆系统。给定当前话语 $U_t$ 以及所有先前会话的完整历史 $H^{1:k-1}$，记忆召回函数 $\Phi_{\text{memory}}$ 生成相关的记忆摘要 $M_t$：`
  const { container } = render(<MathText text={text} />)
  expect(container.querySelectorAll('.reader-math-inline .katex')).toHaveLength(4)
  expect(Array.from(container.querySelectorAll('annotation')).map(node => node.textContent)).toEqual(['U_t', 'H^{1:k-1}', String.raw`\Phi_{\text{memory}}`, 'M_t'])
  expect(container.querySelectorAll('msub')).toHaveLength(3)
  expect(container.querySelectorAll('msup')).toHaveLength(1)
  expect(container.textContent).toContain('Φ')
  expect(container.textContent).toContain('生成相关的记忆摘要')
  expect(container.querySelector('.reader-math-fallback')).toBeNull()
})

it('支持美元与反斜杠两种行内和独立分隔符，保留换行与分数', () => {
  const { container } = render(<MathText text={String.raw`行内 $x_i$ 与 \(y^2\)。
$$M_t = \Phi_{\text{memory}}(U_t,H^{1:k-1})$$
\[\frac{a+b}{\sqrt{c}}\]`} />)
  expect(container.querySelectorAll('.reader-math-inline')).toHaveLength(2)
  expect(container.querySelectorAll('.reader-math-display .katex-display')).toHaveLength(2)
  expect(container.querySelector('mfrac')).toBeTruthy()
  expect(container.querySelector('msqrt')).toBeTruthy()
  expect(container.textContent).toContain('\n')
})

it('普通金额、转义美元和未闭合符号保持原文，后续有效公式仍可渲染', () => {
  const plain = String.raw`费用 $5 至 $10，字面符号 \$，未闭合 $U_t
空分隔符 $$ 与 \(\)`
  const { container } = render(<MathText text={plain + '\n有效 $x$。'} />)
  expect(container.textContent).toContain(plain)
  expect(container.querySelectorAll('.katex')).toHaveLength(1)
  expect(container.querySelector('annotation')?.textContent).toBe('x')
})

it('不支持或损坏的公式显示原始文本，不影响相邻正常公式', () => {
  const bad = String.raw`$\unknowncommand{x}$`
  const { container } = render(<MathText text={`前文 ${bad}，后文 $M_t$，未闭合 $H^{1:k-1$`} />)
  expect(container.querySelector('.reader-math-fallback')?.textContent).toBe(bad)
  expect(container.querySelectorAll('.katex')).toHaveLength(1)
  expect(container.textContent).toContain('$H^{1:k-1$')
})

it('模型返回的 HTML 按文字显示，公式不能添加链接、图片或自定义 HTML', () => {
  const rawHtml = '<img src="https://example.com/a" onerror="alert(1)">'
  const { container } = render(<MathText text={rawHtml + String.raw` $\href{javascript:alert(1)}{x}$ $\includegraphics{https://example.com/a}$ $\htmlClass{evil}{x}$`} />)
  expect(container.textContent).toContain(rawHtml)
  expect(container.querySelector('img, a, script, .evil, [onerror]')).toBeNull()
})

it('递归宏受到展开限制，失败后保留公式并继续显示正常内容', () => {
  const recursive = String.raw`$\def\loop{\loop}\loop$`
  const { container } = render(<MathText text={`${recursive}，正常 $x$`} />)
  expect(container.querySelector('.reader-math-fallback')?.textContent).toBe(recursive)
  expect(container.querySelectorAll('.katex')).toHaveLength(1)
})

it('切换译文时更新公式，上一段定义的宏不会影响下一段', () => {
  const rendered = render(<MathText text={String.raw`$\gdef\custom{a}\custom$ $\custom$`} />)
  expect(rendered.container.querySelector('.reader-math-fallback')?.textContent).toBe(String.raw`$\custom$`)
  rendered.rerender(<MathText text="新译文 $H^k$" />)
  expect(rendered.container.querySelectorAll('.katex')).toHaveLength(1)
  expect(rendered.container.querySelector('annotation')?.textContent).toBe('H^k')
  expect(rendered.container.querySelector('.reader-math-fallback')).toBeNull()
})
