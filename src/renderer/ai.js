// AI 助手 (本地 Ollama + 第三方代理)
import { el, els, toast, bus, escapeHtml } from './utils.js';

export class AIChat {
  constructor() {
    this.providers = [];
    this.activeProviderId = null;
    this.messages = [];
    this.streaming = false;
    this.currentReqId = null;
  }

  async init() {
    this.providers = await window.biji.settings.get('aiProviders') || [];
    this.activeProviderId = await window.biji.settings.get('activeProvider');

    this.providerSelect = el('#aiProviderSelect');
    this.messagesEl = el('#aiMessages');
    this.inputEl = el('#aiInput');
    this.useContextEl = el('#aiUseContext');
    this.streamEl = el('#aiStream');

    el('#aiSend').addEventListener('click', () => this.send());
    this.inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        this.send();
      }
    });

    el('#aiManageProviders').addEventListener('click', () => {
      bus.emit('settings:open', 'ai');
    });

    el('#aiClearChat').addEventListener('click', () => {
      this.messages = [];
      this.render();
    });

    this.providerSelect.addEventListener('change', async () => {
      this.activeProviderId = this.providerSelect.value;
      await window.biji.settings.set('activeProvider', this.activeProviderId);
    });

    bus.on('providers:changed', async () => {
      this.providers = await window.biji.settings.get('aiProviders') || [];
      this.renderProviderSelect();
    });

    this.renderProviderSelect();
    this.renderWelcome();
  }

  renderProviderSelect() {
    this.providerSelect.innerHTML = '';
    if (this.providers.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = '— 未配置,请先添加 —';
      this.providerSelect.appendChild(opt);
      return;
    }
    for (const p of this.providers) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = `${p.name} (${p.type})`;
      this.providerSelect.appendChild(opt);
    }
    if (this.activeProviderId && this.providers.find(p => p.id === this.activeProviderId)) {
      this.providerSelect.value = this.activeProviderId;
    } else if (this.providers[0]) {
      this.activeProviderId = this.providers[0].id;
      this.providerSelect.value = this.activeProviderId;
      window.biji.settings.set('activeProvider', this.activeProviderId);
    }
  }

  renderWelcome() {
    if (this.messages.length === 0) {
      this.messagesEl.innerHTML = `
        <div style="color:var(--text-dim);text-align:center;padding:24px 12px;font-size:12px;line-height:1.7">
          <div style="font-size:32px;margin-bottom:12px">🤖</div>
          <div style="color:var(--text-bright);font-size:14px;margin-bottom:6px">AI 助手</div>
          <div>支持本地 Ollama 与第三方代理:</div>
          <div style="margin-top:6px">OpenAI · Claude · DeepSeek · 月之暗面 · 智谱 · Ollama 等</div>
          <div style="margin-top:12px">在 <strong>设置 → AI 大模型</strong> 中配置服务商</div>
        </div>`;
    }
  }

  render() {
    if (this.messages.length === 0) {
      this.renderWelcome();
      return;
    }
    this.messagesEl.innerHTML = '';
    for (const msg of this.messages) {
      this.appendMessageEl(msg);
    }
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  appendMessageEl(msg) {
    const div = document.createElement('div');
    div.className = `ai-msg ${msg.role}`;
    const role = document.createElement('div');
    role.className = 'ai-msg-role';
    role.textContent = msg.role === 'user' ? '你' : (msg.role === 'system' ? '系统' : 'AI');
    const content = document.createElement('div');
    content.className = 'ai-msg-content';
    content.textContent = msg.content;
    div.appendChild(role);
    div.appendChild(content);
    this.messagesEl.appendChild(div);
    msg._el = content;
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  async send() {
    if (this.streaming) {
      toast('正在生成中,请稍候…', 'warning');
      return;
    }
    const text = this.inputEl.value.trim();
    if (!text) return;
    if (!this.activeProviderId) {
      toast('请先在设置中配置 AI 服务商', 'warning');
      bus.emit('settings:open', 'ai');
      return;
    }
    const provider = this.providers.find(p => p.id === this.activeProviderId);
    if (!provider) {
      toast('当前服务商已失效,请重新选择', 'error');
      return;
    }

    this.inputEl.value = '';

    const useCtx = this.useContextEl.checked;
    const stream = this.streamEl.checked;

    // 构建消息
    const sendMessages = [];
    sendMessages.push({
      role: 'system',
      content: '你是一个有帮助的笔记助手,使用中文回答问题。当用户引用笔记内容时,基于笔记内容回答。'
    });

    if (useCtx) {
      bus.emit('ai:request-context', (tab) => {
        if (tab && tab.content) {
          sendMessages.push({
            role: 'system',
            content: `当前笔记 "${tab.name}" 的内容:\n\n${tab.content.slice(0, 12000)}`
          });
        }
      });
    }

    for (const m of this.messages) {
      sendMessages.push({ role: m.role, content: m.content });
    }
    sendMessages.push({ role: 'user', content: text });

    this.messages.push({ role: 'user', content: text });
    this.appendMessageEl(this.messages[this.messages.length - 1]);

    const assistantMsg = { role: 'assistant', content: '' };
    this.messages.push(assistantMsg);
    this.appendMessageEl(assistantMsg);
    assistantMsg._el.textContent = '思考中…';

    this.streaming = true;
    const reqId = Math.random().toString(36).slice(2);
    this.currentReqId = reqId;

    let offStream, offDone;
    if (stream) {
      let first = true;
      offStream = window.biji.ai.onStream(reqId, (chunk) => {
        if (first) {
          assistantMsg._el.textContent = '';
          first = false;
        }
        assistantMsg.content += chunk;
        assistantMsg._el.textContent = assistantMsg.content;
        this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
      });
      offDone = window.biji.ai.onDone(reqId, () => {
        this.streaming = false;
        offStream?.();
      });
    }

    try {
      const result = await window.biji.ai.chat({
        provider,
        messages: sendMessages,
        stream,
        reqId
      });
      if (!stream) {
        assistantMsg.content = result.text || '';
        assistantMsg._el.textContent = assistantMsg.content;
      }
    } catch (e) {
      assistantMsg.content = '❌ 请求失败:' + e.message;
      assistantMsg._el.textContent = assistantMsg.content;
      toast('AI 请求失败:' + e.message, 'error');
    } finally {
      this.streaming = false;
      offStream?.();
      offDone?.();
    }
  }

  // 用于 AI 助手获取当前打开笔记的回调注入
  setContextProvider(fn) {
    bus.on('ai:request-context', (cb) => cb(fn()));
  }
}
