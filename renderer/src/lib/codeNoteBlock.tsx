import { createReactBlockSpec } from '@blocknote/react'

// 可标色代码框:React 自定义块。content:'inline' 使其内容支持行内样式(textColor/backgroundColor)→ 选中可标色。
// ★必须用 @blocknote/react 的 createReactBlockSpec(React 渲染);用 @blocknote/core 的 vanilla
//   createBlockSpec 塞进 React BlockNote 会让 schema 构建崩溃(白屏:Cannot read properties of undefined 'node')。
// render 用 contentRef 标记承载 inline 内容的元素。
export const codeNoteBlock = createReactBlockSpec(
  { type: 'codeNote', propSchema: {}, content: 'inline' } as any,
  {
    render: (props: any) => <div className="biji-codenote" ref={props.contentRef} />
  } as any
)
