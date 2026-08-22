import { BlockNoteSchema, defaultBlockSpecs } from '@blocknote/core'
import { createHighlighterCore } from 'shiki/core'
import { createOnigurumaEngine } from 'shiki/engine/oniguruma'
// createCodeBlockSpec 在运行时由 @blocknote/core 导出,但未写入公开类型,故 ts 忽略
// @ts-ignore
import { createCodeBlockSpec } from '@blocknote/core'
import { spreadsheetBlock } from './spreadsheetBlock'
import { ganttBlock } from './ganttBlock'

// 代码块支持的语言(显示名 + 别名),用于语言下拉与 Shiki 高亮
export const supportedLanguages: Record<string, { name: string; aliases?: string[] }> = {
  text: { name: 'Plain Text' },
  bash: { name: 'Shell', aliases: ['sh', 'shell', 'zsh'] },
  c: { name: 'C' },
  cpp: { name: 'C++', aliases: ['c++'] },
  css: { name: 'CSS' },
  go: { name: 'Go' },
  html: { name: 'HTML' },
  java: { name: 'Java' },
  javascript: { name: 'JavaScript', aliases: ['js'] },
  json: { name: 'JSON' },
  markdown: { name: 'Markdown', aliases: ['md'] },
  python: { name: 'Python', aliases: ['py'] },
  rust: { name: 'Rust', aliases: ['rs'] },
  sql: { name: 'SQL' },
  typescript: { name: 'TypeScript', aliases: ['ts'] },
  xml: { name: 'XML' },
  yaml: { name: 'YAML', aliases: ['yml'] }
}

const createBijiHighlighter = () =>
  createHighlighterCore({
    themes: [import('@shikijs/themes/github-dark-default'), import('@shikijs/themes/github-light-default')],
    langs: [
      import('@shikijs/langs/bash'),
      import('@shikijs/langs/c'),
      import('@shikijs/langs/cpp'),
      import('@shikijs/langs/css'),
      import('@shikijs/langs/go'),
      import('@shikijs/langs/html'),
      import('@shikijs/langs/java'),
      import('@shikijs/langs/javascript'),
      import('@shikijs/langs/json'),
      import('@shikijs/langs/markdown'),
      import('@shikijs/langs/python'),
      import('@shikijs/langs/rust'),
      import('@shikijs/langs/sql'),
      import('@shikijs/langs/typescript'),
      import('@shikijs/langs/xml'),
      import('@shikijs/langs/yaml')
    ],
    engine: createOnigurumaEngine(import('shiki/wasm'))
  })

// 官方代码块默认使用 plain content，会主动丢弃文字颜色、背景色等行内标记。
// 保留它的渲染器、键盘行为和 Shiki 扩展，只把内容模式改为 inline：这样选中的代码片段
// 可以使用 BlockNote 自带的颜色工具，标记也会进入文档 JSON，能够保存、同步和导出。
const baseCodeBlock = createCodeBlockSpec({
  defaultLanguage: 'text',
  indentLineWithTab: true,
  supportedLanguages,
  createHighlighter: createBijiHighlighter as any
})
const annotatableCodeBlock = {
  ...baseCodeBlock,
  config: { ...baseCodeBlock.config, content: 'inline' }
} as any

// 带 Shiki 语法高亮、并支持片段颜色标注的飞书式 schema。
export const bijiSchema = BlockNoteSchema.create({
  blockSpecs: {
    ...defaultBlockSpecs,
    codeBlock: annotatableCodeBlock,
    spreadsheet: spreadsheetBlock(),
    gantt: ganttBlock()
  }
})
