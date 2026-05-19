const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const net = require('net');
const https = require('https');
const http = require('http');
const { spawn } = require('child_process');
const Store = require('electron-store');
const MarkdownIt = require('markdown-it');
const markdownItTaskLists = require('markdown-it-task-lists');
const hljs = require('highlight.js');

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  typographer: true,
  highlight: (str, lang) => {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return '<pre class="hljs"><code>' +
          hljs.highlight(str, { language: lang, ignoreIllegals: true }).value +
          '</code></pre>';
      } catch {}
    }
    return '<pre class="hljs"><code>' + md.utils.escapeHtml(str) + '</code></pre>';
  }
}).use(markdownItTaskLists, { enabled: true });

const store = new Store({
  name: 'biji-settings',
  defaults: {
    workspace: path.join(app.getPath('documents'), 'BijiNotes'),
    theme: 'dark',
    fontSize: 14,
    aiProviders: [],
    activeProvider: null,
    sshHosts: [],
    telnetHosts: []
  }
});

let mainWindow = null;
const sshSessions = new Map();
const telnetSessions = new Map();

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#1e1e1e',
    title: '笔记 Biji - 本地知识库',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    },
    show: false
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());

  if (process.env.NODE_ENV === 'development' || process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    sshSessions.forEach(s => s.client.end());
    sshSessions.clear();
    telnetSessions.forEach(s => s.socket.destroy());
    telnetSessions.clear();
  });
}

function ensureWorkspace() {
  const ws = store.get('workspace');
  if (!fs.existsSync(ws)) fs.mkdirSync(ws, { recursive: true });
  return ws;
}

app.whenReady().then(() => {
  ensureWorkspace();
  createWindow();
  Menu.setApplicationMenu(buildMenu());

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

function buildMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        {
          label: '新建笔记',
          accelerator: 'CmdOrCtrl+N',
          click: () => mainWindow?.webContents.send('menu:new-note')
        },
        {
          label: '新建文件夹',
          accelerator: 'CmdOrCtrl+Shift+N',
          click: () => mainWindow?.webContents.send('menu:new-folder')
        },
        { type: 'separator' },
        {
          label: '保存',
          accelerator: 'CmdOrCtrl+S',
          click: () => mainWindow?.webContents.send('menu:save')
        },
        {
          label: '切换工作区',
          click: async () => {
            const result = await dialog.showOpenDialog(mainWindow, {
              properties: ['openDirectory', 'createDirectory']
            });
            if (!result.canceled && result.filePaths[0]) {
              store.set('workspace', result.filePaths[0]);
              mainWindow?.webContents.send('workspace:changed', result.filePaths[0]);
            }
          }
        },
        { type: 'separator' },
        { role: 'quit', label: '退出' }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' }
      ]
    },
    {
      label: '视图',
      submenu: [
        {
          label: '切换 Markdown 预览',
          accelerator: 'CmdOrCtrl+Shift+P',
          click: () => mainWindow?.webContents.send('menu:toggle-preview')
        },
        {
          label: 'AI 助手',
          accelerator: 'CmdOrCtrl+I',
          click: () => mainWindow?.webContents.send('menu:toggle-ai')
        },
        {
          label: '远程终端',
          accelerator: 'CmdOrCtrl+T',
          click: () => mainWindow?.webContents.send('menu:toggle-terminal')
        },
        { type: 'separator' },
        { role: 'reload', label: '重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '重置缩放' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { role: 'togglefullscreen', label: '全屏' }
      ]
    },
    {
      label: '设置',
      submenu: [
        {
          label: '偏好设置',
          accelerator: 'CmdOrCtrl+,',
          click: () => mainWindow?.webContents.send('menu:settings')
        }
      ]
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '关于 笔记 Biji',
          click: () => mainWindow?.webContents.send('menu:about')
        },
        {
          label: 'GitHub 仓库',
          click: () => shell.openExternal('https://github.com/')
        }
      ]
    }
  ];
  return Menu.buildFromTemplate(template);
}

// ============ IPC: Settings ============
ipcMain.handle('settings:get', (_e, key) => store.get(key));
ipcMain.handle('settings:set', (_e, key, value) => { store.set(key, value); return true; });
ipcMain.handle('settings:all', () => store.store);

// ============ IPC: File system / Notes ============
ipcMain.handle('fs:list', async (_e, dirPath) => {
  const root = dirPath || store.get('workspace');
  return walkDir(root);
});

async function walkDir(dir) {
  const result = [];
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
  catch { return result; }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push({
        type: 'dir',
        name: entry.name,
        path: full,
        children: await walkDir(full)
      });
    } else {
      result.push({
        type: 'file',
        name: entry.name,
        path: full,
        ext: path.extname(entry.name).slice(1).toLowerCase()
      });
    }
  }
  result.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh');
  });
  return result;
}

ipcMain.handle('fs:read', async (_e, filePath) => {
  return await fsp.readFile(filePath, 'utf-8');
});

ipcMain.handle('fs:write', async (_e, filePath, content) => {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, content, 'utf-8');
  return true;
});

ipcMain.handle('fs:create', async (_e, parent, name, isDir) => {
  const full = path.join(parent, name);
  if (isDir) {
    await fsp.mkdir(full, { recursive: true });
  } else {
    await fsp.mkdir(path.dirname(full), { recursive: true });
    await fsp.writeFile(full, '', 'utf-8');
  }
  return full;
});

ipcMain.handle('fs:rename', async (_e, oldPath, newPath) => {
  await fsp.rename(oldPath, newPath);
  return true;
});

ipcMain.handle('fs:delete', async (_e, target) => {
  const stat = await fsp.stat(target);
  if (stat.isDirectory()) await fsp.rm(target, { recursive: true, force: true });
  else await fsp.unlink(target);
  return true;
});

ipcMain.handle('fs:workspace', () => store.get('workspace'));

ipcMain.handle('fs:search', async (_e, query) => {
  if (!query) return [];
  const ws = store.get('workspace');
  const results = [];
  const needle = query.toLowerCase();
  await searchRecursive(ws, needle, results);
  return results.slice(0, 200);
});

async function searchRecursive(dir, needle, results) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
  catch { return; }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await searchRecursive(full, needle, results);
    } else {
      if (entry.name.toLowerCase().includes(needle)) {
        results.push({ path: full, name: entry.name, match: 'filename' });
        continue;
      }
      try {
        const text = await fsp.readFile(full, 'utf-8');
        const lower = text.toLowerCase();
        const idx = lower.indexOf(needle);
        if (idx >= 0) {
          const start = Math.max(0, idx - 30);
          const end = Math.min(text.length, idx + needle.length + 50);
          results.push({
            path: full,
            name: entry.name,
            match: 'content',
            snippet: text.slice(start, end).replace(/\s+/g, ' ')
          });
        }
      } catch {}
    }
  }
}

// ============ IPC: AI ============
ipcMain.handle('ai:chat', async (event, payload) => {
  const { provider, messages, stream } = payload;
  if (!provider) throw new Error('未配置 AI 服务商');

  const reqId = payload.reqId || Math.random().toString(36).slice(2);

  switch (provider.type) {
    case 'openai':
      return await callOpenAICompatible(provider, messages, stream, event, reqId);
    case 'anthropic':
      return await callAnthropic(provider, messages, stream, event, reqId);
    case 'ollama':
      return await callOllama(provider, messages, stream, event, reqId);
    case 'custom':
      return await callOpenAICompatible(provider, messages, stream, event, reqId);
    default:
      throw new Error(`不支持的 AI 类型: ${provider.type}`);
  }
});

function httpRequest(urlString, options, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlString);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: options.method || 'POST',
      headers: options.headers || {}
    }, (res) => {
      let data = '';
      res.setEncoding('utf-8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function streamRequest(urlString, options, body, onChunk) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlString);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: options.method || 'POST',
      headers: options.headers || {}
    }, (res) => {
      if (res.statusCode >= 400) {
        let err = '';
        res.on('data', c => err += c);
        res.on('end', () => reject(new Error(`HTTP ${res.statusCode}: ${err}`)));
        return;
      }
      res.setEncoding('utf-8');
      let buf = '';
      res.on('data', chunk => {
        buf += chunk;
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) onChunk(line);
      });
      res.on('end', () => { if (buf) onChunk(buf); resolve(); });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function callOpenAICompatible(provider, messages, stream, event, reqId) {
  const url = (provider.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '') + '/chat/completions';
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${provider.apiKey || ''}`
  };
  const body = JSON.stringify({
    model: provider.model,
    messages,
    stream: !!stream,
    temperature: provider.temperature ?? 0.7
  });

  if (!stream) {
    const r = await httpRequest(url, { method: 'POST', headers }, body);
    if (r.status >= 400) throw new Error(`AI 请求失败 (${r.status}): ${r.body}`);
    const json = JSON.parse(r.body);
    return { text: json.choices?.[0]?.message?.content || '' };
  }

  let full = '';
  await streamRequest(url, { method: 'POST', headers }, body, (line) => {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return;
    try {
      const obj = JSON.parse(data);
      const delta = obj.choices?.[0]?.delta?.content || '';
      if (delta) {
        full += delta;
        event.sender.send(`ai:stream:${reqId}`, delta);
      }
    } catch {}
  });
  event.sender.send(`ai:done:${reqId}`);
  return { text: full };
}

async function callAnthropic(provider, messages, stream, event, reqId) {
  const url = (provider.baseUrl || 'https://api.anthropic.com').replace(/\/$/, '') + '/v1/messages';
  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': provider.apiKey || '',
    'anthropic-version': '2023-06-01'
  };
  let system = '';
  const userMsgs = [];
  for (const m of messages) {
    if (m.role === 'system') system += (system ? '\n' : '') + m.content;
    else userMsgs.push({ role: m.role, content: m.content });
  }
  const body = JSON.stringify({
    model: provider.model,
    messages: userMsgs,
    system,
    max_tokens: provider.maxTokens || 4096,
    stream: !!stream
  });

  if (!stream) {
    const r = await httpRequest(url, { method: 'POST', headers }, body);
    if (r.status >= 400) throw new Error(`Anthropic 请求失败 (${r.status}): ${r.body}`);
    const json = JSON.parse(r.body);
    return { text: json.content?.[0]?.text || '' };
  }

  let full = '';
  await streamRequest(url, { method: 'POST', headers }, body, (line) => {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data) return;
    try {
      const obj = JSON.parse(data);
      if (obj.type === 'content_block_delta' && obj.delta?.text) {
        full += obj.delta.text;
        event.sender.send(`ai:stream:${reqId}`, obj.delta.text);
      }
    } catch {}
  });
  event.sender.send(`ai:done:${reqId}`);
  return { text: full };
}

async function callOllama(provider, messages, stream, event, reqId) {
  const base = (provider.baseUrl || 'http://localhost:11434').replace(/\/$/, '');
  const url = base + '/api/chat';
  const headers = { 'Content-Type': 'application/json' };
  const body = JSON.stringify({
    model: provider.model || 'llama3',
    messages,
    stream: !!stream
  });

  if (!stream) {
    const r = await httpRequest(url, { method: 'POST', headers }, body);
    if (r.status >= 400) throw new Error(`Ollama 请求失败 (${r.status}): ${r.body}`);
    const json = JSON.parse(r.body);
    return { text: json.message?.content || '' };
  }

  let full = '';
  await streamRequest(url, { method: 'POST', headers }, body, (line) => {
    line = line.trim();
    if (!line) return;
    try {
      const obj = JSON.parse(line);
      const delta = obj.message?.content || '';
      if (delta) {
        full += delta;
        event.sender.send(`ai:stream:${reqId}`, delta);
      }
    } catch {}
  });
  event.sender.send(`ai:done:${reqId}`);
  return { text: full };
}

ipcMain.handle('ai:test', async (_e, provider) => {
  try {
    if (provider.type === 'ollama') {
      const base = (provider.baseUrl || 'http://localhost:11434').replace(/\/$/, '');
      const r = await httpRequest(base + '/api/tags', { method: 'GET' });
      if (r.status >= 400) return { ok: false, error: `状态 ${r.status}` };
      return { ok: true, info: JSON.parse(r.body) };
    }
    const testMsgs = [{ role: 'user', content: 'hi' }];
    let result;
    if (provider.type === 'anthropic') {
      result = await callAnthropic(provider, testMsgs, false, null, null);
    } else {
      result = await callOpenAICompatible(provider, testMsgs, false, null, null);
    }
    return { ok: true, info: { reply: (result.text || '').slice(0, 100) } };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ============ IPC: SSH ============
ipcMain.handle('ssh:connect', async (event, config) => {
  return new Promise((resolve, reject) => {
    const id = `ssh-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    tryOpenSSHDirect(id, config, event, resolve, reject);
  });
});

function tryOpenSSHDirect(id, config, event, resolve, reject) {
  const sshCmd = process.platform === 'win32' ? 'ssh.exe' : 'ssh';
  console.log(`[SSH] Connecting to ${config.host}:${config.port || 22} with ${sshCmd}`);

  const args = [
    '-tt',  // Force PTY allocation
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'PasswordAuthentication=yes',
    '-o', 'PubkeyAuthentication=yes',
    '-o', 'PreferredAuthentications=password,publickey',
    '-o', 'ConnectTimeout=15',
    '-o', 'KexAlgorithms=diffie-hellman-group1-sha1,diffie-hellman-group14-sha1,ecdh-sha2-nistp256',
    '-o', 'HostKeyAlgorithms=ssh-rsa,rsa-sha2-256,rsa-sha2-512',
    '-o', 'PubkeyAcceptedAlgorithms=ssh-rsa,rsa-sha2-256,rsa-sha2-512',
    '-o', 'Ciphers=3des-cbc,aes128-cbc,aes128-ctr,aes256-cbc,aes256-ctr',
    '-o', 'MACs=hmac-sha1,hmac-sha2-256',
    '-p', String(config.port || 22)
  ];

  args.push(`${config.username}@${config.host}`);

  const proc = spawn(sshCmd, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
    windowsVerbatimArguments: true
  });

  console.log(`[SSH] Process spawned with PID ${proc.pid}`);
  sshSessions.set(id, { process: proc, stdin: proc.stdin, stdout: proc.stdout, stderr: proc.stderr, type: 'openssh-spawn' });

  let resolved = false;
  let passwordSent = false;
  let dataBuffer = '';

  const sendData = (data) => {
    event.sender.send(`term:data:${id}`, data);
  };

  // Combined stdout and stderr
  const handleData = (data, source) => {
    const text = data.toString('utf-8');
    dataBuffer += text;
    sendData(text);

    console.log(`[SSH] ${source} (${text.length} bytes):`, text.slice(0, 100).replace(/\n/g, '\\n'));

    // Look for password prompt
    if (!passwordSent && config.password && /[Pp]assword[:\s]|[Pp]assphrase/i.test(text)) {
      console.log('[SSH] Password prompt detected, sending password');
      proc.stdin.write(config.password + '\n');
      passwordSent = true;
    }

    // Resolve on first shell prompt or substantial data after password
    if (!resolved && passwordSent && (
      /[$#>~][\s\n]*$/.test(text) ||  // Shell prompts
      text.includes('\n') ||           // Any newline data after password
      dataBuffer.length > 100          // Or enough data accumulated
    )) {
      console.log('[SSH] Shell detected, resolving connection');
      resolved = true;
      resolve({ id });
    }
  };

  proc.stdout.on('data', (data) => handleData(data, 'stdout'));
  proc.stderr.on('data', (data) => handleData(data, 'stderr'));

  proc.on('error', (err) => {
    console.log(`[SSH] Process error: ${err.message}`);
    if (!resolved) {
      resolved = true;
      reject(err);
    }
  });

  proc.on('exit', (code, signal) => {
    console.log(`[SSH] Process exited with code ${code}, signal ${signal}`);
    event.sender.send(`term:close:${id}`);
    sshSessions.delete(id);
  });

  // Timeout - longer now
  const timeout = setTimeout(() => {
    if (!resolved) {
      console.log(`[SSH] Connection timeout (received ${dataBuffer.length} bytes of data)`);
      resolved = true;
      reject(new Error('SSH connection timeout'));
      proc.kill();
    }
  }, 30000);

  // Ensure timeout is cleared
  const origResolve = resolve;
  const origReject = reject;
  resolve = (val) => { clearTimeout(timeout); origResolve(val); };
  reject = (err) => { clearTimeout(timeout); origReject(err); };
}

ipcMain.handle('ssh:write', (_e, id, data) => {
  const s = sshSessions.get(id);
  if (!s) return false;

  if (s.type === 'openssh-spawn') {
    s.stdin.write(data);
  }
  return true;
});

ipcMain.handle('ssh:resize', (_e, id, cols, rows) => {
  // OpenSSH spawned without PTY doesn't support resize
  return true;
});

ipcMain.handle('ssh:close', (_e, id) => {
  const s = sshSessions.get(id);
  if (!s) return false;

  if (s.type === 'openssh-spawn') {
    s.stdin.end();
    s.process.kill();
  }
  sshSessions.delete(id);
  return true;
});

// ============ IPC: Telnet ============
ipcMain.handle('telnet:connect', async (event, config) => {
  return new Promise((resolve, reject) => {
    const id = `telnet-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const socket = new net.Socket();
    socket.setTimeout(15000);

    socket.connect(config.port || 23, config.host, () => {
      socket.setTimeout(0);
      telnetSessions.set(id, { socket });
      resolve({ id });
    });

    socket.on('data', (data) => {
      const processed = handleTelnetNegotiation(socket, data);
      if (processed.length) {
        event.sender.send(`term:data:${id}`, processed.toString('utf-8'));
      }
    });
    socket.on('error', (err) => {
      event.sender.send(`term:error:${id}`, err.message);
      reject(err);
    });
    socket.on('close', () => {
      event.sender.send(`term:close:${id}`);
      telnetSessions.delete(id);
    });
    socket.on('timeout', () => {
      event.sender.send(`term:error:${id}`, '连接超时');
      socket.destroy();
    });
  });
});

const IAC = 255, DONT = 254, DO = 253, WONT = 252, WILL = 251, SB = 250, SE = 240;
function handleTelnetNegotiation(socket, data) {
  const out = [];
  let i = 0;
  while (i < data.length) {
    if (data[i] === IAC) {
      if (i + 1 >= data.length) break;
      const cmd = data[i + 1];
      if (cmd === DO || cmd === DONT) {
        if (i + 2 >= data.length) break;
        socket.write(Buffer.from([IAC, WONT, data[i + 2]]));
        i += 3;
      } else if (cmd === WILL || cmd === WONT) {
        if (i + 2 >= data.length) break;
        socket.write(Buffer.from([IAC, DONT, data[i + 2]]));
        i += 3;
      } else if (cmd === SB) {
        let j = i + 2;
        while (j < data.length - 1 && !(data[j] === IAC && data[j + 1] === SE)) j++;
        i = j + 2;
      } else {
        i += 2;
      }
    } else {
      out.push(data[i]);
      i++;
    }
  }
  return Buffer.from(out);
}

ipcMain.handle('telnet:write', (_e, id, data) => {
  const s = telnetSessions.get(id);
  if (s) s.socket.write(data);
  return true;
});

ipcMain.handle('telnet:close', (_e, id) => {
  const s = telnetSessions.get(id);
  if (s) { s.socket.destroy(); telnetSessions.delete(id); }
  return true;
});

// ============ IPC: System ============
ipcMain.handle('sys:open-external', (_e, url) => shell.openExternal(url));
ipcMain.handle('sys:show-in-folder', (_e, p) => shell.showItemInFolder(p));
ipcMain.handle('sys:choose-file', async () => {
  const r = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('sys:choose-folder', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory']
  });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('sys:read-file', async (_e, p) => fsp.readFile(p, 'utf-8'));

// ============ IPC: Markdown ============
ipcMain.handle('md:render', (_e, text) => md.render(text || ''));
