// 设置面板 (通用 / AI / SSH / Telnet)
import { el, els, toast, bus, escapeHtml } from './utils.js';

export class Settings {
  constructor() {
    this.editingProvider = null;
    this.editingSsh = null;
    this.editingTelnet = null;
  }

  async init() {
    this.modal = el('#settingsModal');
    el('#btnSettings').addEventListener('click', () => this.open());
    el('#closeSettings').addEventListener('click', () => this.close());
    el('.modal-backdrop', this.modal).addEventListener('click', () => this.close());
    window.biji.menu.on('menu:settings', () => this.open());
    bus.on('settings:open', (tab) => this.open(tab));

    // 切换 tab
    els('.settings-tab').forEach(tab => {
      tab.addEventListener('click', () => this.switchTab(tab.dataset.tab));
    });

    await this.loadGeneral();
    this.bindGeneral();
    await this.refreshAIProviders();
    this.bindAI();
    await this.refreshSSH();
    this.bindSSH();
    await this.refreshTelnet();
    this.bindTelnet();
  }

  open(tab) {
    this.modal.classList.remove('hidden');
    if (tab) this.switchTab(tab);
  }

  close() {
    this.modal.classList.add('hidden');
  }

  switchTab(name) {
    els('.settings-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
    els('.settings-content').forEach(c => c.classList.toggle('active', c.dataset.tab === name));
  }

  // ===== 通用 =====
  async loadGeneral() {
    const ws = await window.biji.settings.get('workspace');
    const theme = await window.biji.settings.get('theme') || 'dark';
    const fontSize = await window.biji.settings.get('fontSize') || 14;
    el('#settingWorkspace').value = ws || '';
    el('#settingTheme').value = theme;
    el('#settingFontSize').value = fontSize;
    document.documentElement.setAttribute('data-theme', theme);
  }

  bindGeneral() {
    el('#changeWorkspace').addEventListener('click', async () => {
      const folder = await window.biji.sys.chooseFolder();
      if (folder) {
        await window.biji.settings.set('workspace', folder);
        el('#settingWorkspace').value = folder;
        el('#workspaceName').textContent = '· ' + folder;
        bus.emit('workspace:changed', folder);
      }
    });
    el('#settingTheme').addEventListener('change', async (e) => {
      await window.biji.settings.set('theme', e.target.value);
      document.documentElement.setAttribute('data-theme', e.target.value);
      bus.emit('theme:changed', e.target.value);
    });
    el('#settingFontSize').addEventListener('change', async (e) => {
      const size = parseInt(e.target.value, 10);
      await window.biji.settings.set('fontSize', size);
      bus.emit('fontSize:changed', size);
    });
  }

  // ===== AI 服务商 =====
  async refreshAIProviders() {
    const list = await window.biji.settings.get('aiProviders') || [];
    const container = el('#aiProvidersList');
    container.innerHTML = '';
    if (list.length === 0) {
      container.innerHTML = '<p style="color:var(--text-dim);font-size:12px">还没有配置任何 AI 服务商,点击"添加"来配置。<br>支持的服务商:<br>· OpenAI 官方/兼容 (GPT-4、GPT-3.5)<br>· Anthropic Claude<br>· Ollama 本地模型<br>· 自定义代理 (DeepSeek、Moonshot、智谱、Kimi、One-API 等使用 OpenAI 协议的代理)</p>';
      return;
    }
    for (const p of list) {
      const item = document.createElement('div');
      item.className = 'ai-provider-item';
      item.innerHTML = `
        <div class="info">
          <div class="name">${escapeHtml(p.name)}</div>
          <div class="meta">${escapeHtml(p.type)} · ${escapeHtml(p.model || '未指定模型')} · ${escapeHtml(p.baseUrl || '默认地址')}</div>
        </div>
      `;
      const editBtn = document.createElement('button');
      editBtn.className = 'btn';
      editBtn.textContent = '编辑';
      editBtn.onclick = () => this.editAIProvider(p);
      const delBtn = document.createElement('button');
      delBtn.className = 'btn danger';
      delBtn.textContent = '删除';
      delBtn.onclick = () => this.deleteAIProvider(p.id);
      item.appendChild(editBtn);
      item.appendChild(delBtn);
      container.appendChild(item);
    }
  }

  bindAI() {
    el('#aiAddProvider').addEventListener('click', () => this.editAIProvider(null));
    el('#aipCancel').addEventListener('click', () => this.hideAIEditor());
    el('#aipSave').addEventListener('click', () => this.saveAIProvider());
    el('#aipTest').addEventListener('click', () => this.testAIProvider());
    el('#aipType').addEventListener('change', (e) => this.suggestDefaults(e.target.value));
  }

  suggestDefaults(type) {
    const baseUrlInput = el('#aipBaseUrl');
    const modelInput = el('#aipModel');
    if (!baseUrlInput.value || baseUrlInput.dataset.auto) {
      const defaults = {
        openai: { url: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
        anthropic: { url: 'https://api.anthropic.com', model: 'claude-sonnet-4-6' },
        ollama: { url: 'http://localhost:11434', model: 'llama3' },
        custom: { url: '', model: '' }
      };
      baseUrlInput.value = defaults[type]?.url || '';
      baseUrlInput.dataset.auto = 'true';
      if (!modelInput.value || modelInput.dataset.auto) {
        modelInput.value = defaults[type]?.model || '';
        modelInput.dataset.auto = 'true';
      }
    }
  }

  editAIProvider(p) {
    this.editingProvider = p;
    el('#aiProviderEditorTitle').textContent = p ? '编辑服务商' : '添加服务商';
    el('#aipName').value = p?.name || '';
    el('#aipType').value = p?.type || 'openai';
    el('#aipBaseUrl').value = p?.baseUrl || '';
    el('#aipApiKey').value = p?.apiKey || '';
    el('#aipModel').value = p?.model || '';
    el('#aipTemp').value = p?.temperature ?? 0.7;
    el('#aipTestResult').textContent = '';
    delete el('#aipBaseUrl').dataset.auto;
    delete el('#aipModel').dataset.auto;
    if (!p) this.suggestDefaults('openai');
    el('#aiProviderEditor').classList.remove('hidden');
  }

  hideAIEditor() {
    el('#aiProviderEditor').classList.add('hidden');
    this.editingProvider = null;
  }

  async saveAIProvider() {
    const name = el('#aipName').value.trim();
    const type = el('#aipType').value;
    const baseUrl = el('#aipBaseUrl').value.trim();
    const apiKey = el('#aipApiKey').value;
    const model = el('#aipModel').value.trim();
    const temperature = parseFloat(el('#aipTemp').value) || 0.7;

    if (!name) { toast('请输入名称', 'warning'); return; }
    if (!model && type !== 'custom') { toast('请输入模型名', 'warning'); return; }

    const id = this.editingProvider?.id || ('p_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6));
    const provider = { id, name, type, baseUrl, apiKey, model, temperature };

    const list = await window.biji.settings.get('aiProviders') || [];
    const idx = list.findIndex(x => x.id === id);
    if (idx >= 0) list[idx] = provider;
    else list.push(provider);
    await window.biji.settings.set('aiProviders', list);
    bus.emit('providers:changed');
    this.hideAIEditor();
    await this.refreshAIProviders();
    toast('✓ 已保存', 'success');
  }

  async deleteAIProvider(id) {
    if (!confirm('确定删除此服务商配置?')) return;
    const list = await window.biji.settings.get('aiProviders') || [];
    const next = list.filter(p => p.id !== id);
    await window.biji.settings.set('aiProviders', next);
    bus.emit('providers:changed');
    await this.refreshAIProviders();
    toast('已删除', 'success');
  }

  async testAIProvider() {
    const result = el('#aipTestResult');
    result.textContent = '⏳ 测试中…';
    result.style.color = 'var(--text-dim)';
    const provider = {
      type: el('#aipType').value,
      baseUrl: el('#aipBaseUrl').value.trim(),
      apiKey: el('#aipApiKey').value,
      model: el('#aipModel').value.trim() || 'gpt-3.5-turbo',
      temperature: 0.7
    };
    try {
      const r = await window.biji.ai.test(provider);
      if (r.ok) {
        result.textContent = '✓ 连接成功';
        result.style.color = 'var(--success)';
      } else {
        result.textContent = '✗ ' + (r.error || '失败');
        result.style.color = 'var(--error)';
      }
    } catch (e) {
      result.textContent = '✗ ' + e.message;
      result.style.color = 'var(--error)';
    }
  }

  // ===== SSH =====
  async refreshSSH() {
    const list = await window.biji.settings.get('sshHosts') || [];
    const container = el('#sshList');
    container.innerHTML = '';
    if (list.length === 0) {
      container.innerHTML = '<p style="color:var(--text-dim);font-size:12px">还没有保存的 SSH 主机</p>';
      return;
    }
    for (const h of list) {
      const item = document.createElement('div');
      item.className = 'ai-provider-item';
      item.innerHTML = `
        <div class="info">
          <div class="name">${escapeHtml(h.name)}</div>
          <div class="meta">${escapeHtml(h.username)}@${escapeHtml(h.host)}:${h.port || 22} · ${h.authMethod === 'key' ? '🔑 私钥' : '🔐 密码'}</div>
        </div>
      `;
      const edit = document.createElement('button');
      edit.className = 'btn';
      edit.textContent = '编辑';
      edit.onclick = () => this.editSSH(h);
      const del = document.createElement('button');
      del.className = 'btn danger';
      del.textContent = '删除';
      del.onclick = () => this.deleteSSH(h.id);
      item.appendChild(edit);
      item.appendChild(del);
      container.appendChild(item);
    }
  }

  bindSSH() {
    el('#sshAdd').addEventListener('click', () => this.editSSH(null));
    el('#sshCancel').addEventListener('click', () => this.hideSSHEditor());
    el('#sshSave').addEventListener('click', () => this.saveSSH());
    el('#sshAuth').addEventListener('change', (e) => {
      const v = e.target.value;
      el('#sshPasswordGroup').classList.toggle('hidden', v !== 'password');
      el('#sshKeyGroup').classList.toggle('hidden', v !== 'key');
    });
    el('#sshKeyBrowse').addEventListener('click', async () => {
      const p = await window.biji.sys.chooseFile();
      if (p) el('#sshKeyPath').value = p;
    });
  }

  editSSH(h) {
    this.editingSsh = h;
    el('#sshName').value = h?.name || '';
    el('#sshHost').value = h?.host || '';
    el('#sshPort').value = h?.port || 22;
    el('#sshUser').value = h?.username || '';
    el('#sshAuth').value = h?.authMethod || 'password';
    el('#sshPassword').value = h?.password || '';
    el('#sshKeyPath').value = h?.keyPath || '';
    el('#sshKeyPass').value = h?.passphrase || '';
    const v = el('#sshAuth').value;
    el('#sshPasswordGroup').classList.toggle('hidden', v !== 'password');
    el('#sshKeyGroup').classList.toggle('hidden', v !== 'key');
    el('#sshEditor').classList.remove('hidden');
  }

  hideSSHEditor() {
    el('#sshEditor').classList.add('hidden');
    this.editingSsh = null;
  }

  async saveSSH() {
    const data = {
      id: this.editingSsh?.id || ('s_' + Date.now()),
      name: el('#sshName').value.trim(),
      host: el('#sshHost').value.trim(),
      port: parseInt(el('#sshPort').value, 10) || 22,
      username: el('#sshUser').value.trim(),
      authMethod: el('#sshAuth').value,
      password: el('#sshPassword').value,
      keyPath: el('#sshKeyPath').value,
      passphrase: el('#sshKeyPass').value
    };
    if (!data.name || !data.host || !data.username) {
      toast('请填写名称、主机、用户名', 'warning');
      return;
    }
    const list = await window.biji.settings.get('sshHosts') || [];
    const idx = list.findIndex(x => x.id === data.id);
    if (idx >= 0) list[idx] = data;
    else list.push(data);
    await window.biji.settings.set('sshHosts', list);
    this.hideSSHEditor();
    await this.refreshSSH();
    toast('✓ 已保存', 'success');
  }

  async deleteSSH(id) {
    if (!confirm('删除此 SSH 主机?')) return;
    const list = await window.biji.settings.get('sshHosts') || [];
    await window.biji.settings.set('sshHosts', list.filter(h => h.id !== id));
    await this.refreshSSH();
    toast('已删除', 'success');
  }

  // ===== Telnet =====
  async refreshTelnet() {
    const list = await window.biji.settings.get('telnetHosts') || [];
    const container = el('#telnetList');
    container.innerHTML = '';
    if (list.length === 0) {
      container.innerHTML = '<p style="color:var(--text-dim);font-size:12px">还没有保存的 Telnet 主机</p>';
      return;
    }
    for (const h of list) {
      const item = document.createElement('div');
      item.className = 'ai-provider-item';
      item.innerHTML = `
        <div class="info">
          <div class="name">${escapeHtml(h.name)}</div>
          <div class="meta">${escapeHtml(h.host)}:${h.port || 23}</div>
        </div>
      `;
      const edit = document.createElement('button');
      edit.className = 'btn';
      edit.textContent = '编辑';
      edit.onclick = () => this.editTelnet(h);
      const del = document.createElement('button');
      del.className = 'btn danger';
      del.textContent = '删除';
      del.onclick = () => this.deleteTelnet(h.id);
      item.appendChild(edit);
      item.appendChild(del);
      container.appendChild(item);
    }
  }

  bindTelnet() {
    el('#telnetAdd').addEventListener('click', () => this.editTelnet(null));
    el('#telnetCancel').addEventListener('click', () => this.hideTelnetEditor());
    el('#telnetSave').addEventListener('click', () => this.saveTelnet());
  }

  editTelnet(h) {
    this.editingTelnet = h;
    el('#telnetName').value = h?.name || '';
    el('#telnetHost').value = h?.host || '';
    el('#telnetPort').value = h?.port || 23;
    el('#telnetEditor').classList.remove('hidden');
  }

  hideTelnetEditor() {
    el('#telnetEditor').classList.add('hidden');
    this.editingTelnet = null;
  }

  async saveTelnet() {
    const data = {
      id: this.editingTelnet?.id || ('t_' + Date.now()),
      name: el('#telnetName').value.trim(),
      host: el('#telnetHost').value.trim(),
      port: parseInt(el('#telnetPort').value, 10) || 23
    };
    if (!data.name || !data.host) {
      toast('请填写名称、主机', 'warning');
      return;
    }
    const list = await window.biji.settings.get('telnetHosts') || [];
    const idx = list.findIndex(x => x.id === data.id);
    if (idx >= 0) list[idx] = data;
    else list.push(data);
    await window.biji.settings.set('telnetHosts', list);
    this.hideTelnetEditor();
    await this.refreshTelnet();
    toast('✓ 已保存', 'success');
  }

  async deleteTelnet(id) {
    if (!confirm('删除此 Telnet 主机?')) return;
    const list = await window.biji.settings.get('telnetHosts') || [];
    await window.biji.settings.set('telnetHosts', list.filter(h => h.id !== id));
    await this.refreshTelnet();
    toast('已删除', 'success');
  }
}
