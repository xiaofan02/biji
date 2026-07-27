// 主入口:初始化所有模块并互相连接
import { el, els, toast, bus, setupResizer, debounce } from './utils.js';
import { Notes } from './notes.js';
import { EditorManager } from './editor.js';
import { MarkdownPreview } from './markdown.js';
import { AIChat } from './ai.js';
import { TerminalManager } from './terminal.js';
import { Settings } from './settings.js';

async function main() {
  // 应用初始主题
  const theme = await window.biji.settings.get('theme') || 'dark';
  document.documentElement.setAttribute('data-theme', theme);

  const notes = new Notes();
  const editor = new EditorManager();
  const preview = new MarkdownPreview();
  const ai = new AIChat();
  const terminal = new TerminalManager();
  const settings = new Settings();

  await notes.init();
  await editor.init();
  await preview.init();
  await ai.init();
  await settings.init();

  // 终端模块按需加载,避免阻塞首屏
  let terminalReady = false;
  async function ensureTerminal() {
    if (!terminalReady) {
      await terminal.init();
      terminalReady = true;
    }
  }

  // AI 上下文(注入当前打开的笔记)
  bus.on('ai:request-context', (cb) => {
    cb(editor.getActiveTab());
  });

  // 编辑器活动 tab 变化 -> 更新文件树高亮
  bus.on('editor:active', (tab) => {
    notes.setActivePath(tab?.path || null);
  });

  // 主题与字号变更
  bus.on('theme:changed', (t) => editor.setTheme(t));
  bus.on('fontSize:changed', (s) => editor.setFontSize(s));

  // 工作区变更
  bus.on('workspace:changed', async (newWs) => {
    notes.workspace = newWs;
    await notes.refresh();
  });

  // ========== 右侧面板切换 ==========
  const rightPanel = el('#rightPanel');
  const rightResizer = el('#rightResizer');

  function showRightPanel(which) {
    rightPanel.classList.remove('hidden');
    rightResizer.classList.remove('hidden');
    els('.panel-tab', rightPanel).forEach(t => {
      t.classList.toggle('active', t.dataset.panel === which);
    });
    els('.panel-content', rightPanel).forEach(c => {
      c.classList.toggle('active', c.dataset.panel === which);
    });
    bus.emit('resize');
    if (which === 'terminal') {
      ensureTerminal().then(() => terminal.refit());
    }
  }

  function hideRightPanel() {
    rightPanel.classList.add('hidden');
    rightResizer.classList.add('hidden');
    bus.emit('resize');
  }

  els('.panel-tab', rightPanel).forEach(t => {
    t.addEventListener('click', () => showRightPanel(t.dataset.panel));
  });

  el('#closeRightPanel').addEventListener('click', hideRightPanel);

  el('#btnAI').addEventListener('click', () => {
    if (rightPanel.classList.contains('hidden')) showRightPanel('ai');
    else if (el('.panel-tab.active').dataset.panel !== 'ai') showRightPanel('ai');
    else hideRightPanel();
  });

  el('#btnTerminal').addEventListener('click', () => {
    if (rightPanel.classList.contains('hidden')) showRightPanel('terminal');
    else if (el('.panel-tab.active').dataset.panel !== 'terminal') showRightPanel('terminal');
    else hideRightPanel();
  });

  window.biji.menu.on('menu:toggle-ai', () => {
    showRightPanel('ai');
  });

  window.biji.menu.on('menu:toggle-terminal', () => {
    showRightPanel('terminal');
  });

  // ========== 分隔条 ==========
  setupResizer(el('.resizer[data-target="sidebar"]'), el('#sidebar'), 'x', 180, 500);
  setupResizer(el('#rightResizer'), rightPanel, 'x', 280, 800);
  setupResizer(el('.preview-resizer'), el('#previewPane'), 'x', 200, 1200);

  // ========== 全局搜索 ==========
  const searchInput = el('#globalSearch');
  const searchResults = el('#searchResults');

  const doSearch = debounce(async (q) => {
    if (!q.trim()) {
      searchResults.classList.remove('visible');
      searchResults.innerHTML = '';
      return;
    }
    const results = await window.biji.fs.search(q.trim());
    searchResults.innerHTML = '';
    if (results.length === 0) {
      searchResults.innerHTML = '<div class="search-result-item" style="color:var(--text-dim)">未找到匹配的笔记</div>';
    } else {
      for (const r of results.slice(0, 50)) {
        const item = document.createElement('div');
        item.className = 'search-result-item';
        const nameDiv = document.createElement('div');
        nameDiv.className = 'name';
        nameDiv.textContent = r.name + (r.match === 'filename' ? ' · 文件名' : '');
        const sn = document.createElement('div');
        sn.className = 'snippet';
        sn.textContent = r.snippet || r.path;
        item.appendChild(nameDiv);
        item.appendChild(sn);
        item.addEventListener('click', () => {
          bus.emit('note:open', r.path);
          searchResults.classList.remove('visible');
          searchInput.value = '';
        });
        searchResults.appendChild(item);
      }
    }
    searchResults.classList.add('visible');
  }, 250);

  searchInput.addEventListener('input', (e) => doSearch(e.target.value));
  searchInput.addEventListener('focus', () => {
    if (searchInput.value) doSearch(searchInput.value);
  });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      searchInput.value = '';
      searchResults.classList.remove('visible');
      searchInput.blur();
    }
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-box')) {
      searchResults.classList.remove('visible');
    }
  });

  // ========== 全局快捷键 ==========
  document.addEventListener('keydown', (e) => {
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.key.toLowerCase() === 'p' && !e.shiftKey) {
      e.preventDefault();
      searchInput.focus();
      searchInput.select();
    }
  });

  // 关闭无意义提示
  window.addEventListener('error', (e) => {
    console.error('Renderer error:', e.error);
  });

  console.log('✓ 笔记 Biji 启动完成');
}

main().catch(e => {
  console.error('启动失败:', e);
  alert('启动失败:' + e.message + '\n\n请检查依赖是否已安装 (npm install)');
});
