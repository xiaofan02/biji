// Monaco 编辑器与标签页管理
import { el, basename, langForFile, toast, bus, debounce } from './utils.js';

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

export class EditorManager {
  constructor() {
    this.editor = null;
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

    const fontSize = await window.biji.settings.get('fontSize') || 14;
    const theme = await window.biji.settings.get('theme') || 'dark';

    this.editor = monaco.editor.create(el('#monacoContainer'), {
      value: '',
      language: 'markdown',
      theme: theme === 'dark' ? 'biji-dark' : 'biji-light',
      fontSize,
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
      if (!tab) return;
      tab.content = this.editor.getValue();
      this.markModified(tab.path);
      bus.emit('editor:change', tab);
    });

    this.editor.onDidChangeCursorPosition((e) => {
      el('#statusLine').textContent = `行 ${e.position.lineNumber}, 列 ${e.position.column}`;
    });

    // Ctrl+S 保存
    this.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      this.saveActive();
    });

    bus.on('note:open', (p) => this.openFile(p));
    bus.on('note:deleted', (p) => this.closeTab(p));
    bus.on('note:renamed', (oldP, newP) => this.renameTab(oldP, newP));

    window.biji.menu.on('menu:save', () => this.saveActive());
    el('#btnSave').addEventListener('click', () => this.saveActive());

    window.addEventListener('resize', () => this.editor?.layout());
    bus.on('resize', () => this.editor?.layout());

    this.renderTabs();
  }

  async openFile(filePath) {
    const existing = this.tabs.findIndex(t => t.path === filePath);
    if (existing >= 0) {
      this.activateTab(existing);
      return;
    }
    try {
      const content = await window.biji.fs.read(filePath);
      const lang = langForFile(filePath);
      const model = monaco.editor.createModel(content, lang, monaco.Uri.file(filePath));
      this.tabs.push({
        path: filePath,
        name: basename(filePath),
        content,
        originalContent: content,
        model,
        language: lang
      });
      this.activateTab(this.tabs.length - 1);
    } catch (e) {
      toast('打开失败:' + e.message, 'error');
    }
  }

  activateTab(index) {
    if (index < 0 || index >= this.tabs.length) return;
    this.activeIndex = index;
    const tab = this.tabs[index];
    this.editor.setModel(tab.model);
    el('#emptyState').classList.add('hidden');
    el('#monacoContainer').classList.remove('hidden');
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
    tab.model?.dispose();
    this.modifiedSet.delete(tab.path);
    this.tabs.splice(idx, 1);

    if (this.tabs.length === 0) {
      this.activeIndex = -1;
      this.editor.setModel(monaco.editor.createModel('', 'plaintext'));
      el('#emptyState').classList.remove('hidden');
      el('#monacoContainer').classList.add('hidden');
      el('#statusFile').textContent = '就绪';
      el('#statusLang').textContent = '';
      el('#statusModified').textContent = '';
      bus.emit('editor:active', null);
    } else {
      this.activateTab(Math.min(idx, this.tabs.length - 1));
    }
    this.renderTabs();
  }

  renameTab(oldPath, newPath) {
    const t = this.tabs.find(t => t.path === oldPath);
    if (t) {
      t.path = newPath;
      t.name = basename(newPath);
      const lang = langForFile(newPath);
      t.language = lang;
      if (t.model) monaco.editor.setModelLanguage(t.model, lang);
      this.renderTabs();
    }
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
    try {
      await window.biji.fs.write(tab.path, tab.content);
      tab.originalContent = tab.content;
      this.markSaved(tab.path);
      toast(`✓ 已保存 ${tab.name}`, 'success', 1500);
    } catch (e) {
      toast('保存失败:' + e.message, 'error');
    }
  }

  getActiveTab() {
    return this.tabs[this.activeIndex] || null;
  }

  setTheme(theme) {
    monaco.editor.setTheme(theme === 'dark' ? 'biji-dark' : 'biji-light');
  }

  setFontSize(size) {
    this.editor?.updateOptions({ fontSize: size });
  }
}
