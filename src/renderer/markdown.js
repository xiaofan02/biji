// Markdown 实时预览 (使用主进程渲染)
import { el, bus, debounce, escapeHtml } from './utils.js';

export class MarkdownPreview {
  constructor() {
    this.visible = false;
    this.currentTab = null;
  }

  async init() {
    this.previewPane = el('#previewPane');
    this.body = el('#markdownBody');

    el('#btnPreview').addEventListener('click', () => this.toggle());
    el('#btnClosePreview').addEventListener('click', () => this.hide());
    window.biji.menu.on('menu:toggle-preview', () => this.toggle());

    const refresh = debounce(() => this.refresh(), 200);
    bus.on('editor:change', (tab) => {
      this.currentTab = tab;
      if (this.visible) refresh();
    });
    bus.on('editor:active', (tab) => {
      this.currentTab = tab;
      this.autoToggleByLang();
      if (this.visible) refresh();
    });
  }

  autoToggleByLang() {
    if (!this.currentTab) return;
    if (this.currentTab.language === 'markdown' && !this.visible) {
      this.show();
    } else if (this.currentTab.language !== 'markdown' && this.visible) {
      this.hide();
    }
  }

  toggle() {
    if (this.visible) this.hide();
    else this.show();
  }

  async show() {
    this.previewPane.classList.remove('hidden');
    this.visible = true;
    el('#btnPreview').classList.add('active');
    await this.refresh();
    bus.emit('resize');
  }

  hide() {
    this.previewPane.classList.add('hidden');
    this.visible = false;
    el('#btnPreview').classList.remove('active');
    bus.emit('resize');
  }

  async refresh() {
    if (!this.currentTab) {
      this.body.innerHTML = '<p style="color:var(--text-dim)">没有打开的笔记</p>';
      return;
    }
    if (this.currentTab.language !== 'markdown') {
      this.body.innerHTML = `<p style="color:var(--text-dim)">当前文件类型为 <code>${escapeHtml(this.currentTab.language)}</code>,Markdown 预览仅适用于 .md 文件</p>`;
      return;
    }
    try {
      const html = await window.biji.md.render(this.currentTab.content || '');
      this.body.innerHTML = html;
      this.body.querySelectorAll('a').forEach(a => {
        a.addEventListener('click', (e) => {
          e.preventDefault();
          if (a.href) window.biji.sys.openExternal(a.href);
        });
      });
    } catch (e) {
      this.body.innerHTML = '<p style="color:var(--error)">预览失败:' + escapeHtml(e.message) + '</p>';
    }
  }
}
