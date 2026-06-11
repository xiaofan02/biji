import { BlockNoteSchema, defaultBlockSpecs } from '@blocknote/core'
// createCodeBlockSpec 在运行时由 @blocknote/core 导出,但未写入公开类型,故 ts 忽略
// @ts-ignore
import { createCodeBlockSpec } from '@blocknote/core'

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

const HIGHLIGHT_LANGS = Object.keys(supportedLanguages).filter((l) => l !== 'text')

// 带 Shiki 语法高亮的飞书式 schema;shiki 懒加载,首次出现代码块时才下载高亮器
export const bijiSchema = BlockNoteSchema.create({
  blockSpecs: {
    ...defaultBlockSpecs,
    // @ts-ignore createCodeBlockSpec 运行时存在
    codeBlock: createCodeBlockSpec({
      defaultLanguage: 'text',
      indentLineWithTab: true,
      supportedLanguages,
      createHighlighter: () =>
        import('shiki').then(({ createHighlighter }) =>
          createHighlighter({
            themes: ['github-dark-default', 'github-light-default'],
            langs: HIGHLIGHT_LANGS
          })
        )
    })
  }
})
