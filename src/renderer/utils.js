// 工具函数与基础设施

export const el = (sel, root = document) => root.querySelector(sel);
export const els = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function debounce(fn, ms = 300) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export function toast(msg, type = 'info', duration = 3000) {
  const container = el('#toastContainer');
  const node = document.createElement('div');
  node.className = `toast ${type}`;
  node.textContent = msg;
  container.appendChild(node);
  setTimeout(() => {
    node.style.opacity = '0';
    node.style.transition = 'opacity 0.3s';
    setTimeout(() => node.remove(), 300);
  }, duration);
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

export async function prompt(message, defaultValue = '') {
  return new Promise(resolve => {
    const value = window.prompt(message, defaultValue);
    resolve(value);
  });
}

export async function confirmDialog(message) {
  return window.confirm(message);
}

// 简单的事件总线
export class Bus {
  constructor() { this.listeners = {}; }
  on(event, cb) {
    (this.listeners[event] ??= []).push(cb);
    return () => this.off(event, cb);
  }
  off(event, cb) {
    if (!this.listeners[event]) return;
    this.listeners[event] = this.listeners[event].filter(f => f !== cb);
  }
  emit(event, ...args) {
    (this.listeners[event] || []).forEach(cb => {
      try { cb(...args); } catch (e) { console.error(e); }
    });
  }
}

export const bus = new Bus();

// 根据扩展名推断语言
const EXT_LANG = {
  md: 'markdown', markdown: 'markdown',
  py: 'python', pyw: 'python',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'typescript',
  jsx: 'javascript',
  json: 'json', jsonc: 'json',
  yaml: 'yaml', yml: 'yaml',
  toml: 'ini', ini: 'ini', cfg: 'ini', conf: 'ini',
  xml: 'xml', html: 'html', htm: 'html', vue: 'html',
  css: 'css', scss: 'scss', less: 'less',
  sh: 'shell', bash: 'shell', zsh: 'shell',
  ps1: 'powershell',
  bat: 'bat', cmd: 'bat',
  sql: 'sql',
  go: 'go',
  rs: 'rust',
  c: 'c', h: 'c',
  cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp',
  java: 'java',
  rb: 'ruby',
  php: 'php',
  lua: 'lua',
  r: 'r',
  swift: 'swift',
  kt: 'kotlin',
  dart: 'dart',
  txt: 'plaintext',
  log: 'plaintext',
  csv: 'plaintext',
  env: 'shell',
  dockerfile: 'dockerfile',
  makefile: 'makefile'
};

export function langForFile(filename) {
  const lower = filename.toLowerCase();
  if (lower === 'dockerfile') return 'dockerfile';
  if (lower === 'makefile') return 'makefile';
  if (lower.endsWith('.env') || lower === '.env') return 'shell';
  const ext = filename.split('.').pop().toLowerCase();
  return EXT_LANG[ext] || 'plaintext';
}

export function basename(p) {
  return p.split(/[/\\]/).pop();
}

export function dirname(p) {
  const parts = p.split(/[/\\]/);
  parts.pop();
  return parts.join('/');
}

// 拖拽分隔条
export function setupResizer(resizer, target, axis = 'x', minSize = 100, maxSize = 800) {
  let dragging = false;
  resizer.addEventListener('mousedown', (e) => {
    dragging = true;
    document.body.style.cursor = axis === 'x' ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const rect = target.getBoundingClientRect();
    if (axis === 'x') {
      const isRightPanel = target.classList.contains('right-panel') ||
                           target.classList.contains('preview-pane');
      const newSize = isRightPanel
        ? window.innerWidth - e.clientX
        : e.clientX - rect.left;
      target.style.width = Math.max(minSize, Math.min(maxSize, newSize)) + 'px';
    }
  });
  document.addEventListener('mouseup', () => {
    if (dragging) {
      dragging = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      bus.emit('resize');
    }
  });
}

// 上下文菜单
export function showContextMenu(x, y, items) {
  const menu = el('#contextMenu');
  menu.innerHTML = '';
  for (const item of items) {
    if (item.divider) {
      const d = document.createElement('div');
      d.className = 'context-menu-divider';
      menu.appendChild(d);
    } else {
      const n = document.createElement('div');
      n.className = 'context-menu-item';
      n.textContent = item.label;
      n.addEventListener('click', () => {
        hideContextMenu();
        item.action();
      });
      menu.appendChild(n);
    }
  }
  menu.classList.remove('hidden');
  const rect = menu.getBoundingClientRect();
  const px = Math.min(x, window.innerWidth - rect.width - 4);
  const py = Math.min(y, window.innerHeight - rect.height - 4);
  menu.style.left = px + 'px';
  menu.style.top = py + 'px';
}

export function hideContextMenu() {
  el('#contextMenu').classList.add('hidden');
}

document.addEventListener('click', hideContextMenu);
document.addEventListener('contextmenu', (e) => {
  if (!e.target.closest('.tree-node') && !e.target.closest('.tab')) {
    hideContextMenu();
  }
});
