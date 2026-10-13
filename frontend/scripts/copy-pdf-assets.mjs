import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// 字体、字形映射和解码器随应用提供，阅读时不访问外部资源站。
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = resolve(project, 'node_modules/pdfjs-dist')
const target = resolve(project, 'public/pdfjs')
await mkdir(target, { recursive: true })
for (const folder of ['cmaps', 'standard_fonts', 'wasm']) {
  await cp(resolve(source, folder), resolve(target, folder), { recursive: true })
}
// 启动脚本以构建版本判断是否需要自动更新界面。
const metadata = JSON.parse(await readFile(resolve(project, 'package.json'), 'utf8'))
await writeFile(resolve(project, 'public/version.json'), JSON.stringify({ version: metadata.version }) + '\n')
