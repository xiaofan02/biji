// SSH / Telnet 远程终端
import { el, els, toast, bus, showContextMenu } from './utils.js';

export class TerminalManager {
  constructor() {
    this.sessions = new Map();
    this.activeId = null;
  }

  async init() {
    if (!window.Terminal) {
      toast('终端模块未加载,请检查 xterm.js 路径', 'error');
      return;
    }
    this.containerEl = el('#terminalContainer');
    this.selectEl = el('#terminalSelect');

    el('#termNew').addEventListener('click', () => this.showConnectMenu());
    el('#termClose').addEventListener('click', () => this.closeActive());
    el('#termManage').addEventListener('click', () => bus.emit('settings:open', 'ssh'));

    this.selectEl.addEventListener('change', () => {
      this.activate(this.selectEl.value);
    });

    bus.on('resize', () => this.refit());
    window.addEventListener('resize', () => this.refit());
  }

  async showConnectMenu() {
    const ssh = await window.biji.settings.get('sshHosts') || [];
    const telnet = await window.biji.settings.get('telnetHosts') || [];

    if (ssh.length === 0 && telnet.length === 0) {
      toast('请先在设置中添加 SSH 或 Telnet 主机', 'warning');
      bus.emit('settings:open', 'ssh');
      return;
    }

    const items = [];
    for (const h of ssh) {
      items.push({
        label: `🔐 ${h.name} (SSH ${h.host}:${h.port || 22})`,
        action: () => this.connectSSH(h)
      });
    }
    if (ssh.length && telnet.length) items.push({ divider: true });
    for (const h of telnet) {
      items.push({
        label: `📡 ${h.name} (Telnet ${h.host}:${h.port || 23})`,
        action: () => this.connectTelnet(h)
      });
    }

    const btn = el('#termNew');
    const rect = btn.getBoundingClientRect();
    showContextMenu(rect.left, rect.bottom + 4, items);
  }

  async connectSSH(host) {
    const label = `🔐 ${host.name}`;
    let pkContent = null;
    if (host.authMethod === 'key' && host.keyPath) {
      try {
        pkContent = await window.biji.sys.readFile(host.keyPath);
      } catch (e) {
        toast('无法读取私钥文件:' + e.message, 'error');
        return;
      }
    }
    const cfg = {
      host: host.host,
      port: host.port || 22,
      username: host.username
    };
    if (host.authMethod === 'key') {
      cfg.privateKey = pkContent;
      if (host.passphrase) cfg.passphrase = host.passphrase;
    } else {
      cfg.password = host.password;
    }

    toast(`正在连接 ${host.name}…`, 'info');
    try {
      const { id } = await window.biji.ssh.connect(cfg);
      this.createTerminal(id, label, 'ssh', host);
      toast(`✓ 已连接 ${host.name}`, 'success');
    } catch (e) {
      toast(`连接失败:${e.message}`, 'error');
    }
  }

  async connectTelnet(host) {
    const label = `📡 ${host.name}`;
    toast(`正在连接 ${host.name}…`, 'info');
    try {
      const { id } = await window.biji.telnet.connect({
        host: host.host,
        port: host.port || 23
      });
      this.createTerminal(id, label, 'telnet', host);
      toast(`✓ 已连接 ${host.name}`, 'success');
    } catch (e) {
      toast(`连接失败:${e.message}`, 'error');
    }
  }

  createTerminal(id, label, type, host) {
    const TerminalCtor = window.Terminal;
    const FitAddonCtor = window.FitAddon?.FitAddon || window.FitAddon;
    const WebLinksAddonCtor = window.WebLinksAddon?.WebLinksAddon || window.WebLinksAddon;

    const term = new TerminalCtor({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: '"Cascadia Code", "Fira Code", Consolas, "Liberation Mono", Menlo, monospace',
      theme: {
        background: '#000000',
        foreground: '#d4d4d4',
        cursor: '#d4d4d4',
        black: '#000000',
        red: '#cd3131',
        green: '#0dbc79',
        yellow: '#e5e510',
        blue: '#2472c8',
        magenta: '#bc3fbc',
        cyan: '#11a8cd',
        white: '#e5e5e5',
        brightBlack: '#666666',
        brightRed: '#f14c4c',
        brightGreen: '#23d18b',
        brightYellow: '#f5f543',
        brightBlue: '#3b8eea',
        brightMagenta: '#d670d6',
        brightCyan: '#29b8db',
        brightWhite: '#e5e5e5'
      },
      scrollback: 5000
    });

    const fitAddon = FitAddonCtor ? new FitAddonCtor() : null;
    if (fitAddon) term.loadAddon(fitAddon);
    if (WebLinksAddonCtor) {
      term.loadAddon(new WebLinksAddonCtor((_e, url) => window.biji.sys.openExternal(url)));
    }

    const div = document.createElement('div');
    div.className = 'terminal-instance';
    div.dataset.sessionId = id;
    this.containerEl.appendChild(div);
    term.open(div);
    fitAddon?.fit();

    const session = { id, label, type, term, fitAddon, div, host };
    this.sessions.set(id, session);

    const off1 = window.biji.term.onData(id, (data) => term.write(data));
    const off2 = window.biji.term.onClose(id, () => {
      term.writeln('\r\n\x1b[31m[连接已关闭]\x1b[0m');
      session.closed = true;
    });
    const off3 = window.biji.term.onError(id, (msg) => {
      term.writeln(`\r\n\x1b[31m[错误] ${msg}\x1b[0m`);
    });

    const disposableData = term.onData((data) => {
      if (session.closed) return;
      if (type === 'ssh') window.biji.ssh.write(id, data);
      else if (type === 'telnet') window.biji.telnet.write(id, data);
    });

    const disposableResize = term.onResize(({ cols, rows }) => {
      if (type === 'ssh' && !session.closed) {
        window.biji.ssh.resize(id, cols, rows);
      }
    });

    // 右键菜单 - 复制粘贴
    div.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const selection = term.getSelection();
      const items = [];

      if (selection) {
        items.push({
          label: '📋 复制',
          action: () => {
            navigator.clipboard.writeText(selection).catch(() => {});
          }
        });
      }

      items.push({
        label: '📌 粘贴',
        action: async () => {
          try {
            const text = await navigator.clipboard.readText();
            if (type === 'ssh') window.biji.ssh.write(id, text);
            else if (type === 'telnet') window.biji.telnet.write(id, text);
          } catch (e) {}
        }
      });

      if (items.length > 0) {
        const rect = div.getBoundingClientRect();
        showContextMenu(e.clientX, e.clientY, items);
      }
    });

    // 快捷键支持
    const keyHandler = (e) => {
      // Ctrl+Shift+C - 复制
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.code === 'KeyC') {
        e.preventDefault();
        const selection = term.getSelection();
        if (selection) {
          navigator.clipboard.writeText(selection).catch(() => {});
        }
      }
      // Ctrl+Shift+V - 粘贴
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.code === 'KeyV') {
        e.preventDefault();
        navigator.clipboard.readText().then(text => {
          if (type === 'ssh') window.biji.ssh.write(id, text);
          else if (type === 'telnet') window.biji.telnet.write(id, text);
        }).catch(() => {});
      }
    };
    div.addEventListener('keydown', keyHandler);

    session.cleanup = () => {
      off1(); off2(); off3();
      disposableData?.dispose?.();
      disposableResize?.dispose?.();
      div.removeEventListener('keydown', keyHandler);
    };

    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = label;
    this.selectEl.appendChild(opt);
    this.selectEl.value = id;
    this.activate(id);

    bus.emit('terminal:visible');
  }

  activate(id) {
    if (!id) return;
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.forEach(s => s.div.classList.remove('active'));
    session.div.classList.add('active');
    this.selectEl.value = id;
    this.activeId = id;
    requestAnimationFrame(() => {
      try { session.fitAddon?.fit(); } catch {}
      session.term.focus();
    });
  }

  async closeActive() {
    if (!this.activeId) return;
    const session = this.sessions.get(this.activeId);
    if (!session) return;
    if (session.type === 'ssh') await window.biji.ssh.close(this.activeId);
    else if (session.type === 'telnet') await window.biji.telnet.close(this.activeId);
    session.cleanup?.();
    session.div.remove();
    Array.from(this.selectEl.options).forEach(o => {
      if (o.value === this.activeId) o.remove();
    });
    this.sessions.delete(this.activeId);
    this.activeId = null;
    const next = this.sessions.keys().next().value;
    if (next) this.activate(next);
  }

  refit() {
    if (!this.activeId) return;
    const session = this.sessions.get(this.activeId);
    if (session) {
      try { session.fitAddon?.fit(); } catch {}
    }
  }
}
