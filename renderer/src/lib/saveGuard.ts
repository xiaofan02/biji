// 保存抑制表 —— 修复"移动/删除/重命名正打开的文档后,原位复活出幽灵文件"的问题。
//
// 成因:编辑器(DocEditor/CodeEditor)在卸载时会把内容兜底写回它挂载时捕获的旧路径;
// 而移动/重命名会让标签 path 变化导致编辑器按 key 重建(旧实例卸载)、删除会关闭标签(卸载),
// 这些卸载 flush(以及卸载前残留的 600ms 防抖落盘)都指向那个已不存在的旧路径,
// fs.write 又会自动 mkdir + 建文件,于是在原位置重建出一个"新笔记"。
//
// 用法:做结构性变更的一方在动手前 suppressSave(旧路径),完成后(等卸载 flush + 残留防抖都跑完)
// 再 unsuppressSave。编辑器保存前调用 shouldSkipSave 命中则直接跳过。按前缀匹配,兼顾文件夹移动
// (其下已打开的子文档旧路径也会被一并抑制)。

const suppressed = new Set<string>()
const norm = (p: string) => p.replace(/\\/g, '/')

export function suppressSave(path: string): void {
  suppressed.add(norm(path))
}

export function unsuppressSave(path: string): void {
  suppressed.delete(norm(path))
}

export function shouldSkipSave(path: string): boolean {
  const np = norm(path)
  for (const p of suppressed) {
    if (np === p || np.startsWith(p + '/')) return true
  }
  return false
}
