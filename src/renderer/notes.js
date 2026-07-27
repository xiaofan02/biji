// 笔记 / 文件树管理
import { el, basename, dirname, toast, showContextMenu, confirmDialog, prompt, bus } from './utils.js';

export class Notes {
  constructor() {
    this.tree = [];
    this.workspace = null;
    this.expandedDirs = new Set();
    this.activePath = null;
  }

  async init() {
    this.workspace = await window.biji.fs.workspace();
    el('#workspaceName').textContent = '· ' + this.workspace;
    await this.refresh();

    el('#btnRefresh').addEventListener('click', () => this.refresh());
    el('#btnNewNote').addEventListener('click', () => this.createNote(this.workspace));
    el('#btnNewFolder').addEventListener('click', () => this.createFolder(this.workspace));
    el('#emptyNewNote').addEventListener('click', () => this.createNote(this.workspace));
    el('#emptyOpenWs').addEventListener('click', () => this.openWorkspace());

    window.biji.menu.on('menu:new-note', () => this.createNote(this.workspace));
    window.biji.menu.on('menu:new-folder', () => this.createFolder(this.workspace));
    window.biji.menu.on('workspace:changed', async (newWs) => {
      this.workspace = newWs;
      el('#workspaceName').textContent = '· ' + newWs;
      await this.refresh();
    });
  }

  async refresh() {
    this.tree = await window.biji.fs.list();
    this.render();
  }

  render() {
    const treeEl = el('#fileTree');
    treeEl.innerHTML = '';
    this.renderNodes(this.tree, treeEl, 0);
  }

  renderNodes(nodes, parent, depth) {
    for (const node of nodes) {
      const item = document.createElement('div');
      item.className = 'tree-node';
      item.dataset.path = node.path;
      item.dataset.type = node.type;
      if (this.activePath === node.path) item.classList.add('active');

      const indent = document.createElement('span');
      indent.className = 'indent';
      indent.style.width = (depth * 14) + 'px';
      item.appendChild(indent);

      const arrow = document.createElement('span');
      arrow.className = 'arrow';
      if (node.type === 'dir') {
        arrow.textContent = this.expandedDirs.has(node.path) ? '▼' : '▶';
      }
      item.appendChild(arrow);

      const icon = document.createElement('span');
      icon.className = 'icon';
      icon.textContent = node.type === 'dir'
        ? (this.expandedDirs.has(node.path) ? '📂' : '📁')
        : this.fileIcon(node.name);
      item.appendChild(icon);

      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = node.name;
      item.appendChild(name);

      item.addEventListener('click', () => this.handleClick(node));
      item.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.showNodeMenu(e, node);
      });

      parent.appendChild(item);

      if (node.type === 'dir' && this.expandedDirs.has(node.path) && node.children) {
        this.renderNodes(node.children, parent, depth + 1);
      }
    }
  }

  fileIcon(name) {
    const ext = name.split('.').pop().toLowerCase();
    const map = {
      md: '📝', markdown: '📝',
      py: '🐍',
      js: '🟨', mjs: '🟨', ts: '🔷', tsx: '🔷', jsx: '🟨',
      json: '🔧', yaml: '⚙️', yml: '⚙️',
      sh: '🔨', bash: '🔨',
      html: '🌐', css: '🎨',
      sql: '🗄️',
      txt: '📄', log: '📋'
    };
    return map[ext] || '📄';
  }

  handleClick(node) {
    if (node.type === 'dir') {
      if (this.expandedDirs.has(node.path)) this.expandedDirs.delete(node.path);
      else this.expandedDirs.add(node.path);
      this.render();
    } else {
      bus.emit('note:open', node.path);
    }
  }

  showNodeMenu(e, node) {
    const items = [];
    const parentDir = node.type === 'dir' ? node.path : dirname(node.path);

    if (node.type === 'dir') {
      items.push({
        label: '📝 新建笔记',
        action: () => this.createNote(node.path)
      });
      items.push({
        label: '📁 新建文件夹',
        action: () => this.createFolder(node.path)
      });
      items.push({ divider: true });
    } else {
      items.push({
        label: '✏️ 打开',
        action: () => bus.emit('note:open', node.path)
      });
      items.push({ divider: true });
    }

    items.push({
      label: '🔤 重命名',
      action: () => this.rename(node)
    });
    items.push({
      label: '🗑️ 删除',
      action: () => this.delete(node)
    });
    items.push({ divider: true });
    items.push({
      label: '📂 在文件管理器中显示',
      action: () => window.biji.sys.showInFolder(node.path)
    });

    showContextMenu(e.clientX, e.clientY, items);
  }

  async createNote(parentDir) {
    const name = await prompt('笔记名称(支持 .md / .py / .json / .yaml 等扩展名):', 'untitled.md');
    if (!name) return;
    const fullPath = parentDir + '/' + name;
    try {
      await window.biji.fs.create(parentDir, name, false);
      this.expandedDirs.add(parentDir);
      await this.refresh();
      bus.emit('note:open', fullPath);
      toast(`✓ 已创建 ${name}`, 'success');
    } catch (e) {
      toast('创建失败:' + e.message, 'error');
    }
  }

  async createFolder(parentDir) {
    const name = await prompt('文件夹名称:', 'new-folder');
    if (!name) return;
    try {
      await window.biji.fs.create(parentDir, name, true);
      this.expandedDirs.add(parentDir);
      await this.refresh();
      toast(`✓ 已创建文件夹 ${name}`, 'success');
    } catch (e) {
      toast('创建失败:' + e.message, 'error');
    }
  }

  async rename(node) {
    const newName = await prompt('新名称:', node.name);
    if (!newName || newName === node.name) return;
    const newPath = dirname(node.path) + '/' + newName;
    try {
      await window.biji.fs.rename(node.path, newPath);
      bus.emit('note:renamed', node.path, newPath);
      await this.refresh();
      toast(`✓ 已重命名`, 'success');
    } catch (e) {
      toast('重命名失败:' + e.message, 'error');
    }
  }

  async delete(node) {
    if (!await confirmDialog(`确定删除 "${node.name}"?` + (node.type === 'dir' ? '\n(将递归删除所有子内容)' : ''))) return;
    try {
      await window.biji.fs.delete(node.path);
      bus.emit('note:deleted', node.path);
      await this.refresh();
      toast(`✓ 已删除`, 'success');
    } catch (e) {
      toast('删除失败:' + e.message, 'error');
    }
  }

  async openWorkspace() {
    const folder = await window.biji.sys.chooseFolder();
    if (folder) {
      await window.biji.settings.set('workspace', folder);
      this.workspace = folder;
      el('#workspaceName').textContent = '· ' + folder;
      await this.refresh();
    }
  }

  setActivePath(p) {
    this.activePath = p;
    this.render();
  }
}
