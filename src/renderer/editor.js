// 编辑器与标签页管理
// Markdown(.md) 使用 Vditor 即时渲染(IR, 所见即所得), 其它文件使用 Monaco
import { el, basename, langForFile, toast, bus } from './utils.js';

let monaco = null;

function loadMonaco() {
  return new Promise((resolve, reject) => {
    if (window.monaco) {
      monaco = window.monaco;
      return resolve(monaco);
    }
    window.require(['vs/editor/editor.main'], () => {
      monaco = window.monaco;
      resolve(monaco);
    }, reject);
  });
}

const VDITOR_CDN = '../node_modules/vditor';

export class EditorManager {
  constructor() {
    this.editor = null;          // Monaco 实例(代码文件)
    this.vditor = null;          // Vditor 实例(markdown)
    this.vditorReady = null;     // 懒加载 Promise 守卫
    this.vditorMode = 'wysiwyg'; // 'wysiwyg' 所见即所得(隐藏 markdown 标记, 飞书风格) | 'sv' 源码分屏
    this.loadingContent = false; // 程序化写入内容时忽略 input, 避免误标"未保存"
    this._loadGuardTimer = null;
    this._imgObserver = null;
    this._fontSize = 14;
    this.tabs = [];
    this.activeIndex = -1;
    this.modifiedSet = new Set();
  }

  async init() {
    await loadMonaco();

    monaco.editor.defineTheme('biji-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [],
      colors: {
        'editor.background': '#1e1e1e',
        'editor.foreground': '#d4d4d4',
        'editor.lineHighlightBackground': '#2a2a2a',
        'editorLineNumber.foreground': '#5a5a5a',
        'editorCursor.foreground': '#aeafad'
      }
    });

    monaco.editor.defineTheme('biji-light', {
      base: 'vs',
      inherit: true,
      rules: [],
      colors: {}
    });

    this._fontSize = await window.biji.settings.get('fontSize') || 14;
    const theme = await window.biji.settings.get('theme') || 'dark';

    this.editor = monaco.editor.create(el('#monacoContainer'), {
      value: '',
      language: 'markdown',
      theme: theme === 'dark' ? 'biji-dark' : 'biji-light',
      fontSize: this._fontSize,
      fontFamily: 'Cascadia Code, Fira Code, Consolas, Menlo, monospace',
      automaticLayout: true,
      wordWrap: 'on',
      minimap: { enabled: true },
      scrollBeyondLastLine: false,
      renderWhitespace: 'boundary',
      tabSize: 2,
      lineNumbers: 'on',
      mouseWheelZoom: true
    });

    this.editor.onDidChangeModelContent(() => {
      const tab = this.tabs[this.activeIndex];
      if (!tab || tab.editorType !== 'monaco') return;
      tab.content = this.editor.getValue();
      this.markModified(tab.path);
      bus.emit('editor:change', tab);
    });

    this.editor.onDidChangeCursorPosition((e) => {
      const tab = this.tabs[this.activeIndex];
      if (tab && tab.editorType !== 'monaco') return;
      el('#statusLine').textContent = `行 ${e.position.lineNumber}, 列 ${e.position.column}`;
    });

    // Ctrl+S 保存(Monaco 内)
    this.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      this.saveActive();
    });

    // Ctrl+Shift+I 插入图片(Monaco 内)
    this.editor.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyI,
      () => this.insertImageFromDialog()
    );

    // Monaco 内的粘贴/拖拽图片
    this.attachImageHandlers();

    // Vditor 容器内 Ctrl+S 兜底(菜单加速键通常已覆盖, 双保险)
    el('#vditorContainer').addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        this.saveActive();
      }
    });

    bus.on('note:open', (p) => this.openFile(p));
    bus.on('note:deleted', (p) => this.closeTab(p));
    bus.on('note:renamed', (oldP, newP) => this.renameTab(oldP, newP));
    // 👁️ / Ctrl+Shift+P 对 markdown 切换 所见即所得 <-> 源码分屏
    bus.on('editor:toggle-md-mode', () => this.toggleVditorMode());

    window.biji.menu.on('menu:save', () => this.saveActive());
    el('#btnSave').addEventListener('click', () => this.saveActive());
    el('#btnInsertImage').addEventListener('click', () => this.insertImageFromDialog());

    window.addEventListener('resize', () => this.editor?.layout());
    bus.on('resize', () => this.editor?.layout());

    this.renderTabs();
  }

  // ============ Vditor 懒加载 / 生命周期 ============
  ensureVditor() {
    if (this.vditor) return Promise.resolve(this.vditor);
    if (this.vditorReady) return this.vditorReady;
    this.vditorReady = this._createVditor(this.vditorMode);
    return this.vditorReady;
  }

  async _createVditor(mode) {
    const Vditor = window.Vditor;
    if (!Vditor) {
      toast('Vditor 未加载, 请确认已 npm install vditor', 'error');
      return null;
    }
    const theme = await window.biji.settings.get('theme') || 'dark';
    const dark = theme === 'dark';

    return new Promise((resolve) => {
      const v = new Vditor(el('#vditorContainer'), {
        cdn: VDITOR_CDN,
        mode,
        theme: dark ? 'dark' : 'classic',
        cache: { enable: false },
        placeholder: '开始写作…',
        toolbarConfig: { pin: true },
        toolbar: [
          'headings', 'bold', 'italic', 'strike', '|',
          'list', 'ordered-list', 'check', 'outdent', 'indent', '|',
          'quote', 'line', 'code', 'inline-code', '|',
          'table', 'link', 'upload', '|',
          'undo', 'redo', '|',
          'outline', 'fullscreen'
        ],
        preview: {
          theme: { current: dark ? 'dark' : 'light' },
          hljs: { style: dark ? 'vs2015' : 'github', lineNumber: true },
          math: { engine: 'KaTeX' }
        },
        input: (value) => this.onVditorInput(value),
        upload: {
          handler: (files) => this.handleVditorUpload(files),
          // 阻止 Vditor 默认的多文件链接拼接, 完全交给 handler
          multiple: true
        },
        after: () => {
          this.vditor = v;
          this._applyVditorFontSize();
          this._observeVditorImages();
          resolve(v);
        }
      });
    });
  }

  onVditorInput(value) {
    const tab = this.tabs[this.activeIndex];
    if (!tab || tab.editorType !== 'vditor') return;
    // 始终保持 tab.content 最新(存盘安全), 并把图片绝对路径还原为相对路径
    tab.content = this._sanitizeImagePaths(value, tab.path);
    if (this.loadingContent) return; // 程序化载入不标记"未保存"
    this.markModified(tab.path);
    bus.emit('editor:change', tab);
  }

  async handleVditorUpload(files) {
    const tab = this.tabs[this.activeIndex];
    if (!tab) return '请先打开一篇笔记';
    for (const file of files) {
      if (!file.type || !file.type.startsWith('image/')) continue;
      try {
        const buf = new Uint8Array(await file.arrayBuffer());
        const ext = (file.type.split('/')[1] || 'png').toLowerCase();
        const saved = await window.biji.fs.saveImage(tab.path, buf, ext);
        this.vditor?.insertValue(`![](${saved.relPath})\n`);
      } catch (e) {
        toast('插入图片失败:' + e.message, 'error');
      }
    }
    return null; // 不走 Vditor 默认上传
  }

  // 把存盘内容里指向当前笔记目录的 file:// 图片地址还原为相对路径, 保证 .md 可移植
  _sanitizeImagePaths(markdown, notePath) {
    if (!markdown || !notePath) return markdown;
    // ](file:///任意/assets/xxx.png)  ->  ](assets/xxx.png)
    return markdown.replace(/\]\(file:\/\/[^)]*?\/(assets\/[^)]+)\)/gi, ']($1)');
  }

  // 监听 Vditor 内容区, 把相对路径图片的显示地址改写为 file://(仅改 DOM 显示, 不动源码)
  _observeVditorImages() {
    const container = el('#vditorContainer');
    if (!container || this._imgObserver) return;
    this._imgObserver = new MutationObserver(() => this._rewriteVditorImages());
    this._imgObserver.observe(container, { childList: true, subtree: true });
  }

  _rewriteVditorImages() {
    const tab = this.tabs[this.activeIndex];
    if (!tab || tab.editorType !== 'vditor' || !tab.path) return;
    const noteDir = tab.path.replace(/\\/g, '/').replace(/\/[^/]*$/, '');
    el('#vditorContainer').querySelectorAll('img').forEach(img => {
      const src = img.getAttribute('src') || '';
      if (!src) return;
      if (/^(https?:|data:|blob:|file:|\/\/)/i.test(src)) return;
      const normalized = src.replace(/\\/g, '/').replace(/^\.\//, '');
      const isAbs = normalized.startsWith('/') || /^[a-zA-Z]:\//.test(normalized);
      const full = isAbs ? normalized : `${noteDir}/${normalized}`;
      img.src = 'file://' + (full.startsWith('/') ? full : '/' + full);
    });
  }

  // 切换 markdown 的 所见即所得(wysiwyg) <-> 源码分屏(sv); Vditor 模式无法热切换, 销毁后以新模式重建
  async toggleVditorMode() {
    const tab = this.getActiveTab();
    if (!tab || tab.editorType !== 'vditor') return;
    this.vditorMode = this.vditorMode === 'wysiwyg' ? 'sv' : 'wysiwyg';
    const content = tab.content || '';
    if (this._imgObserver) { this._imgObserver.disconnect(); this._imgObserver = null; }
    if (this.vditor) {
      try { this.vditor.destroy(); } catch {}
      this.vditor = null;
    }
    this.vditorReady = null;
    await this.ensureVditor();
    this._loadValue(content);
    toast(this.vditorMode === 'wysiwyg' ? '✓ 所见即所得模式' : '✓ 源码分屏模式', 'info', 1200);
  }

  _loadValue(content) {
    if (!this.vditor) return;
    this.loadingContent = true;
    this.vditor.setValue(content || '', true);
    clearTimeout(this._loadGuardTimer);
    this._loadGuardTimer = setTimeout(() => { this.loadingContent = false; }, 80);
    this._rewriteVditorImages();
  }

  // ============ 标签页 ============
  async openFile(filePath) {
    const existing = this.tabs.findIndex(t => t.path === filePath);
    if (existing >= 0) {
      await this.activateTab(existing);
      return;
    }
    try {
      const content = await window.biji.fs.read(filePath);
      const lang = langForFile(filePath);
      const editorType = lang === 'markdown' ? 'vditor' : 'monaco';
      const tab = {
        path: filePath,
        name: basename(filePath),
        content,
        originalContent: content,
        language: lang,
        editorType,
        model: null
      };
      if (editorType === 'monaco') {
        tab.model = monaco.editor.createModel(content, lang, monaco.Uri.file(filePath));
      }
      this.tabs.push(tab);
      await this.activateTab(this.tabs.length - 1);
    } catch (e) {
      toast('打开失败:' + e.message, 'error');
    }
  }

  async activateTab(index) {
    if (index < 0 || index >= this.tabs.length) return;
    this.activeIndex = index;
    const tab = this.tabs[index];
    el('#emptyState').classList.add('hidden');

    if (tab.editorType === 'vditor') {
      el('#monacoContainer').classList.add('hidden');
      el('#vditorContainer').classList.remove('hidden');
      await this.ensureVditor();
      // ensureVditor 可能因异步切换导致此 tab 已非当前激活, 再次确认
      if (this.tabs[this.activeIndex] === tab) {
        this._loadValue(tab.content);
      }
    } else {
      el('#vditorContainer').classList.add('hidden');
      el('#monacoContainer').classList.remove('hidden');
      this.editor.setModel(tab.model);
      this.editor.layout();
    }

    el('#statusFile').textContent = tab.path;
    el('#statusLang').textContent = tab.language;
    this.renderTabs();
    bus.emit('editor:active', tab);
  }

  closeTab(targetPath) {
    const idx = typeof targetPath === 'number'
      ? targetPath
      : this.tabs.findIndex(t => t.path === targetPath);
    if (idx < 0) return;

    const tab = this.tabs[idx];
    if (this.modifiedSet.has(tab.path)) {
      if (!confirm(`"${tab.name}" 有未保存的修改,确定关闭吗?`)) return;
    }
    if (tab.model) tab.model.dispose();
    this.modifiedSet.delete(tab.path);
    this.tabs.splice(idx, 1);

    if (this.tabs.length === 0) {
      this.activeIndex = -1;
      this.editor.setModel(monaco.editor.createModel('', 'plaintext'));
      el('#emptyState').classList.remove('hidden');
      el('#monacoContainer').classList.add('hidden');
      el('#vditorContainer').classList.add('hidden');
      if (this.vditor) this._loadValue('');
      el('#statusFile').textContent = '就绪';
      el('#statusLang').textContent = '';
      el('#statusModified').textContent = '';
      el('#statusLine').textContent = '';
      bus.emit('editor:active', null);
    } else {
      this.activateTab(Math.min(idx, this.tabs.length - 1));
    }
    this.renderTabs();
  }

  renameTab(oldPath, newPath) {
    const t = this.tabs.find(t => t.path === oldPath);
    if (!t) return;
    t.path = newPath;
    t.name = basename(newPath);
    const lang = langForFile(newPath);
    const newType = lang === 'markdown' ? 'vditor' : 'monaco';
    t.language = lang;

    if (newType !== t.editorType) {
      // 扩展名变更导致编辑器类型切换: 重建该 tab 的承载
      if (t.model) { t.model.dispose(); t.model = null; }
      t.editorType = newType;
      if (newType === 'monaco') {
        t.model = monaco.editor.createModel(t.content, lang, monaco.Uri.file(newPath));
      }
      if (this.tabs[this.activeIndex] === t) this.activateTab(this.activeIndex);
    } else if (t.model) {
      monaco.editor.setModelLanguage(t.model, lang);
    }
    this.renderTabs();
  }

  markModified(path) {
    this.modifiedSet.add(path);
    el('#statusModified').textContent = '● 未保存';
    this.renderTabs();
  }

  markSaved(path) {
    this.modifiedSet.delete(path);
    el('#statusModified').textContent = '';
    this.renderTabs();
  }

  renderTabs() {
    const container = el('#tabs');
    container.innerHTML = '';
    this.tabs.forEach((tab, i) => {
      const t = document.createElement('div');
      t.className = 'tab' + (i === this.activeIndex ? ' active' : '') +
                    (this.modifiedSet.has(tab.path) ? ' modified' : '');
      const name = document.createElement('span');
      name.className = 'tab-name';
      name.textContent = tab.name;
      const close = document.createElement('span');
      close.className = 'tab-close';
      close.textContent = '×';
      close.addEventListener('click', (e) => {
        e.stopPropagation();
        this.closeTab(i);
      });
      t.appendChild(name);
      t.appendChild(close);
      t.addEventListener('click', () => this.activateTab(i));
      t.addEventListener('mousedown', (e) => {
        if (e.button === 1) { e.preventDefault(); this.closeTab(i); }
      });
      container.appendChild(t);
    });
  }

  async saveActive() {
    const tab = this.tabs[this.activeIndex];
    if (!tab) return;
    // Vditor 下确保取到最新内容(input 可能有节流)
    if (tab.editorType === 'vditor' && this.vditor) {
      tab.content = this._sanitizeImagePaths(this.vditor.getValue(), tab.path);
    }
    try {
      await window.biji.fs.write(tab.path, tab.content);
      tab.originalContent = tab.content;
      this.markSaved(tab.path);
      toast(`✓ 已保存 ${tab.name}`, 'success', 1500);
    } catch (e) {
      toast('保存失败:' + e.message, 'error');
    }
  }

  attachImageHandlers() {
    const domNode = this.editor.getDomNode();
    if (!domNode) return;

    domNode.addEventListener('paste', async (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const it of items) {
        if (it.kind === 'file' && it.type.startsWith('image/')) {
          e.preventDefault();
          e.stopPropagation();
          const file = it.getAsFile();
          if (file) await this.saveAndInsertImage(file);
          return;
        }
      }
    }, true);

    domNode.addEventListener('dragover', (e) => {
      if (e.dataTransfer?.types?.includes('Files')) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }
    });

    domNode.addEventListener('drop', async (e) => {
      const files = e.dataTransfer?.files;
      if (!files || files.length === 0) return;
      const imgs = Array.from(files).filter(f => f.type.startsWith('image/'));
      if (imgs.length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      for (const f of imgs) await this.saveAndInsertImage(f);
    }, true);
  }

  async insertImageFromDialog() {
    const tab = this.tabs[this.activeIndex];
    if (!tab) {
      toast('请先打开一篇笔记', 'warning');
      return;
    }
    try {
      const res = await window.biji.sys.chooseImage();
      if (!res) return;
      const saved = await window.biji.fs.saveImage(tab.path, res.data, res.ext);
      this.insertTextAtCursor(`![](${saved.relPath})`);
      toast('✓ 已插入图片', 'success', 1500);
    } catch (e) {
      toast('插入图片失败:' + e.message, 'error');
    }
  }

  async saveAndInsertImage(file) {
    const tab = this.tabs[this.activeIndex];
    if (!tab) {
      toast('请先打开一篇笔记', 'warning');
      return;
    }
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      const ext = (file.type.split('/')[1] || 'png').toLowerCase();
      const saved = await window.biji.fs.saveImage(tab.path, buf, ext);
      this.insertTextAtCursor(`![](${saved.relPath})`);
      toast('✓ 已插入图片', 'success', 1500);
    } catch (e) {
      toast('插入图片失败:' + e.message, 'error');
    }
  }

  insertTextAtCursor(text) {
    const tab = this.getActiveTab();
    if (tab && tab.editorType === 'vditor' && this.vditor) {
      this.vditor.insertValue(text);
      this.vditor.focus();
      return;
    }
    if (!this.editor) return;
    const sel = this.editor.getSelection();
    const op = { range: sel, text, forceMoveMarkers: true };
    this.editor.executeEdits('insert-image', [op]);
    this.editor.focus();
  }

  getActiveTab() {
    return this.tabs[this.activeIndex] || null;
  }

  setTheme(theme) {
    monaco.editor.setTheme(theme === 'dark' ? 'biji-dark' : 'biji-light');
    if (this.vditor) {
      const dark = theme === 'dark';
      this.vditor.setTheme(
        dark ? 'dark' : 'classic',
        dark ? 'dark' : 'light',
        dark ? 'vs2015' : 'github'
      );
    }
  }

  setFontSize(size) {
    this._fontSize = size;
    this.editor?.updateOptions({ fontSize: size });
    this._applyVditorFontSize();
  }

  _applyVditorFontSize() {
    const c = el('#vditorContainer');
    if (c && this._fontSize) c.style.setProperty('--biji-md-font-size', this._fontSize + 'px');
  }
}
