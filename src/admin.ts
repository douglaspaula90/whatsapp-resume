import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { config } from './config';
import {
  getMonitoredGroupsWithNames,
  addMonitoredGroup,
  removeMonitoredGroup,
  getSetting,
  setSetting,
  saveMessage,
} from './database';
import { runDailySummary } from './scheduler';

const router = Router();
const tokens = new Set<string>();

function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const token = req.cookies?.token || req.headers['x-auth-token'];
  if (token && tokens.has(token)) {
    next();
    return;
  }
  if (req.path === '/login' || req.path === '/api/login') {
    next();
    return;
  }
  res.redirect('/admin/login');
}

router.use(authMiddleware);

// --- Login ---
router.get('/login', (_req: Request, res: Response) => {
  res.send(loginPage());
});

router.post('/api/login', (req: Request, res: Response) => {
  const { user, password } = req.body;
  if (user === config.admin.user && password === config.admin.password) {
    const token = crypto.randomBytes(32).toString('hex');
    tokens.add(token);
    res.cookie('token', token, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 });
    res.json({ ok: true });
  } else {
    res.status(401).json({ error: 'Credenciais inválidas' });
  }
});

router.post('/api/logout', (req: Request, res: Response) => {
  const token = req.cookies?.token;
  if (token) tokens.delete(token);
  res.clearCookie('token');
  res.json({ ok: true });
});

// --- Dashboard ---
router.get('/', (_req: Request, res: Response) => {
  res.send(dashboardPage());
});

// --- API: WhatsApp Connection ---
router.post('/api/instance/create', async (_req: Request, res: Response) => {
  try {
    const response = await fetch(config.evolution.apiUrl + '/instance/create', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': config.evolution.apiKey,
      },
      body: JSON.stringify({
        instanceName: config.evolution.instanceName,
        integration: 'WHATSAPP-BAILEYS',
        qrcode: true,
      }),
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.get('/api/instance/status', async (_req: Request, res: Response) => {
  try {
    const response = await fetch(
      config.evolution.apiUrl + '/instance/connectionState/' + config.evolution.instanceName,
      { headers: { 'apikey': config.evolution.apiKey } }
    );
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.get('/api/instance/qrcode', async (_req: Request, res: Response) => {
  try {
    const response = await fetch(
      config.evolution.apiUrl + '/instance/connect/' + config.evolution.instanceName,
      { headers: { 'apikey': config.evolution.apiKey } }
    );
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// --- API: Groups ---
router.get('/api/groups/available', async (_req: Request, res: Response) => {
  try {
    const response = await fetch(
      config.evolution.apiUrl + '/chat/findChats/' + config.evolution.instanceName,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': config.evolution.apiKey,
        },
        body: JSON.stringify({}),
      }
    );
    const data = await response.json() as Array<{ remoteJid?: string; pushName?: string; name?: string }>;
    // Filter only groups (@g.us)
    const groups = Array.isArray(data)
      ? data
          .filter(c => c.remoteJid?.endsWith('@g.us'))
          .map(c => ({ id: c.remoteJid, subject: c.pushName || c.name || c.remoteJid }))
      : [];
    res.json(groups);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.get('/api/groups/monitored', (_req: Request, res: Response) => {
  const groups = getMonitoredGroupsWithNames();
  res.json(groups);
});

router.post('/api/groups/add', async (req: Request, res: Response) => {
  const { group_jid, group_name } = req.body;
  if (!group_jid) {
    res.status(400).json({ error: 'group_jid required' });
    return;
  }
  addMonitoredGroup(group_jid, group_name || group_jid);

  // Import last 24h of messages for this group
  importGroupHistory(group_jid, group_name || group_jid)
    .catch(err => console.error('[admin] History import error:', err));

  // Configure webhook for this instance
  configureWebhook().catch(err => console.error('[admin] Webhook config error:', err));

  res.json({ ok: true });
});

router.post('/api/groups/remove', (req: Request, res: Response) => {
  const { group_jid } = req.body;
  if (!group_jid) {
    res.status(400).json({ error: 'group_jid required' });
    return;
  }
  removeMonitoredGroup(group_jid);
  res.json({ ok: true });
});

// --- API: Settings ---
router.get('/api/settings', (_req: Request, res: Response) => {
  const cron = getSetting('summary_cron') || config.summaryCron;
  const emailTo = getSetting('email_to') || config.email.to;
  res.json({ summary_cron: cron, email_to: emailTo });
});

router.post('/api/settings', (req: Request, res: Response) => {
  const { summary_cron, email_to } = req.body;
  if (summary_cron) setSetting('summary_cron', summary_cron);
  if (email_to) setSetting('email_to', email_to);
  res.json({ ok: true });
});

// --- API: Import history for a single group (returns count) ---
router.post('/api/import-history', async (req: Request, res: Response) => {
  const { group_jid, group_name } = req.body;
  if (group_jid) {
    const count = await importGroupHistory(group_jid, group_name || group_jid);
    res.json({ ok: true, group_jid, group_name, imported: count });
    return;
  }
  // If no group specified, import all
  const groups = getMonitoredGroupsWithNames();
  if (!groups.length) {
    res.json({ ok: false, message: 'Nenhum grupo monitorado.' });
    return;
  }
  const results: { group_name: string; imported: number }[] = [];
  for (const g of groups) {
    const count = await importGroupHistory(g.group_jid, g.group_name);
    results.push({ group_name: g.group_name, imported: count });
  }
  res.json({ ok: true, results });
});

// --- API: Trigger ---
router.post('/api/trigger', async (_req: Request, res: Response) => {
  try {
    await runDailySummary();
    res.json({ ok: true, message: 'Resumo enviado!' });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// --- History import helper ---
interface EvolutionMessage {
  key?: { remoteJid?: string; fromMe?: boolean; participant?: string };
  pushName?: string;
  message?: { conversation?: string; extendedTextMessage?: { text?: string } };
  messageTimestamp?: number | string;
  messageType?: string;
}

interface FindMessagesResponse {
  messages?: {
    total?: number;
    pages?: number;
    currentPage?: number;
    records?: EvolutionMessage[];
  };
}

async function importGroupHistory(groupJid: string, groupName: string): Promise<number> {
  console.log('[import] Importing 24h history for ' + groupName + '...');
  const since = Date.now() - 24 * 60 * 60 * 1000;

  try {
    let imported = 0;
    let page = 1;
    let totalPages = 1;

    while (page <= totalPages) {
      const response = await fetch(
        config.evolution.apiUrl + '/chat/findMessages/' + config.evolution.instanceName,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': config.evolution.apiKey,
          },
          body: JSON.stringify({
            where: {
              key: { remoteJid: groupJid },
            },
            page,
          }),
        }
      );

      const data = await response.json() as FindMessagesResponse;
      const messages = data?.messages;

      if (!messages?.records) {
        console.log('[import] No records in response for ' + groupName + ' page ' + page);
        break;
      }

      totalPages = messages.pages || 1;
      let foundOldMessage = false;

      for (const msg of messages.records) {
        if (!msg.key || !msg.message) continue;
        if (msg.key.fromMe) continue;

        const content = msg.message.conversation || msg.message.extendedTextMessage?.text;
        if (!content) continue;

        const ts = typeof msg.messageTimestamp === 'number'
          ? msg.messageTimestamp * 1000
          : parseInt(String(msg.messageTimestamp || '0'), 10) * 1000;

        if (ts < since) {
          foundOldMessage = true;
          continue;
        }

        try {
          saveMessage({
            group_jid: groupJid,
            group_name: groupName,
            sender_jid: msg.key.participant || groupJid,
            sender_name: msg.pushName || 'Desconhecido',
            content,
            message_type: msg.messageType || 'text',
            timestamp: new Date(ts).toISOString(),
          });
          imported++;
        } catch {
          // Skip duplicates
        }
      }

      // If we found messages older than 24h, no need to fetch more pages
      if (foundOldMessage) break;
      page++;
    }

    console.log('[import] Imported ' + imported + ' messages for ' + groupName + ' (' + totalPages + ' pages scanned)');
    return imported;
  } catch (err) {
    console.error('[import] Error importing history for ' + groupName + ':', err);
    return 0;
  }
}

// --- Webhook config helper ---
async function configureWebhook(): Promise<void> {
  const webhookUrl = 'http://' + (process.env.HOSTNAME || 'localhost') + ':' + config.port + '/webhook/messages';
  await fetch(config.evolution.apiUrl + '/webhook/set/' + config.evolution.instanceName, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': config.evolution.apiKey,
    },
    body: JSON.stringify({
      webhook: {
        enabled: true,
        url: webhookUrl,
        webhookByEvents: false,
        events: ['MESSAGES_UPSERT'],
      },
    }),
  });
}

// --- HTML Pages ---
function loginPage(): string {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>WhatsApp Resume - Login</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #111b21; color: #e9edef; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .login-box { background: #1f2c33; padding: 40px; border-radius: 12px; width: 100%; max-width: 400px; }
    .login-box h1 { font-size: 24px; margin-bottom: 8px; color: #00a884; }
    .login-box p { font-size: 14px; color: #8696a0; margin-bottom: 24px; }
    label { display: block; font-size: 13px; color: #8696a0; margin-bottom: 4px; }
    input { width: 100%; padding: 12px; background: #2a3942; border: 1px solid #3b4a54; border-radius: 8px; color: #e9edef; font-size: 15px; margin-bottom: 16px; outline: none; }
    input:focus { border-color: #00a884; }
    button { width: 100%; padding: 12px; background: #00a884; color: white; border: none; border-radius: 8px; font-size: 15px; cursor: pointer; font-weight: 600; }
    button:hover { background: #008f72; }
    .error { color: #ff6b6b; font-size: 13px; margin-bottom: 12px; display: none; }
  </style>
</head>
<body>
  <div class="login-box">
    <h1>WhatsApp Resume</h1>
    <p>Painel de administracao</p>
    <div class="error" id="error">Credenciais invalidas</div>
    <form id="form">
      <label>Usuario</label>
      <input type="text" id="user" required />
      <label>Senha</label>
      <input type="password" id="password" required />
      <button type="submit">Entrar</button>
    </form>
  </div>
  <script>
    document.getElementById('form').onsubmit = async (e) => {
      e.preventDefault();
      const res = await fetch('/admin/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user: document.getElementById('user').value, password: document.getElementById('password').value })
      });
      if (res.ok) { window.location.href = '/admin'; }
      else { document.getElementById('error').style.display = 'block'; }
    };
  </script>
</body>
</html>`;
}

function dashboardPage(): string {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>WhatsApp Resume - Admin</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #111b21; color: #e9edef; }
    .header { background: #1f2c33; padding: 16px 24px; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #2a3942; }
    .header h1 { font-size: 20px; color: #00a884; }
    .header button { background: none; border: 1px solid #3b4a54; color: #8696a0; padding: 8px 16px; border-radius: 6px; cursor: pointer; }
    .container { max-width: 900px; margin: 0 auto; padding: 24px; }
    .card { background: #1f2c33; border-radius: 10px; padding: 24px; margin-bottom: 20px; }
    .card h2 { font-size: 16px; color: #00a884; margin-bottom: 16px; display: flex; align-items: center; gap: 8px; }
    .status-dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
    .status-dot.green { background: #00a884; }
    .status-dot.red { background: #ff6b6b; }
    .status-dot.yellow { background: #f0b429; }
    .btn { padding: 10px 20px; border: none; border-radius: 8px; cursor: pointer; font-size: 14px; font-weight: 600; }
    .btn-primary { background: #00a884; color: white; }
    .btn-primary:hover { background: #008f72; }
    .btn-danger { background: #ff6b6b; color: white; }
    .btn-danger:hover { background: #e05555; }
    .btn-outline { background: none; border: 1px solid #3b4a54; color: #e9edef; }
    .btn-outline:hover { background: #2a3942; }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .group-list { list-style: none; }
    .group-list li { padding: 12px 16px; border-bottom: 1px solid #2a3942; display: flex; justify-content: space-between; align-items: center; }
    .group-list li:last-child { border-bottom: none; }
    .group-name { font-size: 15px; }
    .group-jid { font-size: 12px; color: #8696a0; }
    .available-group { padding: 10px 16px; border-bottom: 1px solid #2a3942; display: flex; justify-content: space-between; align-items: center; }
    .qr-container { text-align: center; padding: 20px; }
    .qr-container img { max-width: 300px; border-radius: 8px; }
    input, select { padding: 10px; background: #2a3942; border: 1px solid #3b4a54; border-radius: 6px; color: #e9edef; font-size: 14px; }
    .settings-row { display: flex; gap: 12px; align-items: center; margin-bottom: 12px; }
    .settings-row label { min-width: 140px; font-size: 14px; color: #8696a0; }
    .settings-row input { flex: 1; }
    .msg { padding: 10px 16px; border-radius: 6px; margin-bottom: 12px; font-size: 14px; display: none; }
    .msg.success { background: #00a88422; color: #00a884; display: block; }
    .msg.error { background: #ff6b6b22; color: #ff6b6b; display: block; }
    .loading { color: #8696a0; font-size: 14px; padding: 12px; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
  </style>
</head>
<body>
  <div class="header">
    <h1>WhatsApp Resume</h1>
    <button onclick="logout()">Sair</button>
  </div>
  <div class="container">
    <!-- WhatsApp Connection -->
    <div class="card">
      <h2><span class="status-dot" id="conn-dot"></span> Conexao WhatsApp</h2>
      <div id="conn-status" class="loading">Verificando...</div>
      <div id="qr-area" class="qr-container" style="display:none;"></div>
      <div style="margin-top:12px;">
        <button class="btn btn-primary" id="btn-connect" onclick="connectWhatsApp()">Conectar WhatsApp</button>
      </div>
    </div>

    <!-- Monitored Groups -->
    <div class="card">
      <h2>Grupos Monitorados</h2>
      <ul class="group-list" id="monitored-list">
        <li class="loading">Carregando...</li>
      </ul>
    </div>

    <!-- Available Groups -->
    <div class="card">
      <h2>Grupos Disponiveis</h2>
      <p style="font-size:13px;color:#8696a0;margin-bottom:12px;">Selecione os grupos que deseja monitorar</p>
      <div style="display:flex;gap:12px;margin-bottom:12px;">
        <input type="text" id="group-filter" placeholder="Filtrar grupos..." oninput="filterGroups()" style="flex:1;" />
        <button class="btn btn-outline" onclick="loadAvailableGroups()">Atualizar lista</button>
      </div>
      <div id="available-list" style="max-height:400px;overflow-y:auto;">
        <div class="loading">Clique em "Atualizar lista" apos conectar o WhatsApp</div>
      </div>
    </div>

    <!-- Settings -->
    <div class="card">
      <h2>Configuracoes</h2>
      <div class="settings-row">
        <label>Horario do resumo</label>
        <select id="cron-hour" style="width:80px;">
          ${Array.from({ length: 24 }, (_, i) => '<option value="' + i + '">' + String(i).padStart(2, '0') + ':00</option>').join('')}
        </select>
      </div>
      <div class="settings-row">
        <label>Email destino</label>
        <input type="email" id="email-to" placeholder="seu@email.com" />
      </div>
      <button class="btn btn-primary" onclick="saveSettings()">Salvar configuracoes</button>
      <div class="msg" id="settings-msg"></div>
    </div>

    <!-- Manual Trigger -->
    <div class="card">
      <h2>Envio Manual</h2>
      <p style="font-size:13px;color:#8696a0;margin-bottom:12px;">Envia o resumo das ultimas 24h agora</p>
      <button class="btn btn-primary" id="btn-trigger" onclick="triggerSummary()">Enviar resumo agora</button>
      <div class="msg" id="trigger-msg"></div>
    </div>
  </div>

  <script>
    async function api(path, opts) {
      const res = await fetch('/admin' + path, { ...opts, headers: { 'Content-Type': 'application/json', ...opts?.headers } });
      return res.json();
    }

    async function checkConnection() {
      try {
        const data = await api('/api/instance/status');
        const dot = document.getElementById('conn-dot');
        const status = document.getElementById('conn-status');
        const state = data?.instance?.state || data?.state || 'unknown';
        if (state === 'open') {
          dot.className = 'status-dot green';
          status.textContent = 'Conectado';
          document.getElementById('btn-connect').textContent = 'Reconectar';
        } else if (state === 'connecting') {
          dot.className = 'status-dot yellow';
          status.textContent = 'Conectando...';
        } else {
          dot.className = 'status-dot red';
          status.textContent = 'Desconectado';
        }
      } catch {
        document.getElementById('conn-dot').className = 'status-dot red';
        document.getElementById('conn-status').textContent = 'Erro ao verificar conexao';
      }
    }

    let connPollInterval = null;

    function startConnectionPolling() {
      if (connPollInterval) clearInterval(connPollInterval);
      connPollInterval = setInterval(async () => {
        const data = await api('/api/instance/status');
        const state = data?.instance?.state || data?.state || 'unknown';
        if (state === 'open') {
          clearInterval(connPollInterval);
          connPollInterval = null;
          document.getElementById('qr-area').style.display = 'none';
          checkConnection();
          loadAvailableGroups();
        }
      }, 5000);
    }

    async function connectWhatsApp() {
      const btn = document.getElementById('btn-connect');
      btn.disabled = true;
      btn.textContent = 'Criando instancia...';
      try {
        await api('/api/instance/create', { method: 'POST' });
        const qr = await api('/api/instance/qrcode');
        const area = document.getElementById('qr-area');
        if (qr?.base64) {
          area.innerHTML = '<p style="margin-bottom:12px;">Escaneie o QR Code com seu WhatsApp:</p><img src="' + qr.base64 + '" />';
          area.style.display = 'block';
        } else if (qr?.code) {
          area.innerHTML = '<p style="margin-bottom:12px;">Escaneie o QR Code com seu WhatsApp:</p><img src="data:image/png;base64,' + qr.code + '" />';
          area.style.display = 'block';
        } else {
          area.innerHTML = '<p>Nao foi possivel gerar QR Code. Verifique se a Evolution API esta rodando.</p>';
          area.style.display = 'block';
        }
        startConnectionPolling();
      } catch (err) {
        alert('Erro: ' + err.message);
      }
      btn.disabled = false;
      btn.textContent = 'Conectar WhatsApp';
    }

    async function loadMonitoredGroups() {
      const data = await api('/api/groups/monitored');
      const list = document.getElementById('monitored-list');
      if (!data.length) {
        list.innerHTML = '<li class="loading">Nenhum grupo monitorado. Adicione grupos abaixo.</li>';
        return;
      }
      list.innerHTML = data.map(g => {
        const statusId = 'status-' + g.group_jid.replace(/[^a-zA-Z0-9]/g, '');
        return '<li style="flex-wrap:wrap;"><div style="flex:1;"><div class="group-name">' + g.group_name + '</div><div class="group-jid">' + g.group_jid + '</div>' +
          '<div id="' + statusId + '" style="font-size:12px;margin-top:4px;"></div>' +
          '</div><button class="btn btn-danger" onclick="removeGroup(\\'' + g.group_jid + '\\')">Remover</button></li>';
      }).join('');
    }

    let cachedGroups = [];
    let cachedMonitoredJids = new Set();

    async function loadAvailableGroups() {
      const container = document.getElementById('available-list');
      container.innerHTML = '<div class="loading">Carregando grupos...</div>';
      document.getElementById('group-filter').value = '';
      try {
        const data = await api('/api/groups/available');
        cachedGroups = Array.isArray(data) ? data : (data?.groups || []);
        const monitored = await api('/api/groups/monitored');
        cachedMonitoredJids = new Set(monitored.map(g => g.group_jid));

        if (!cachedGroups.length) {
          container.innerHTML = '<div class="loading">Nenhum grupo encontrado. Conecte o WhatsApp primeiro.</div>';
          return;
        }
        renderGroups(cachedGroups);
      } catch {
        container.innerHTML = '<div class="loading">Erro ao carregar grupos. Conecte o WhatsApp primeiro.</div>';
      }
    }

    function renderGroups(groups) {
      const container = document.getElementById('available-list');
      if (!groups.length) {
        container.innerHTML = '<div class="loading">Nenhum grupo corresponde ao filtro.</div>';
        return;
      }
      container.innerHTML = groups.map(g => {
        const jid = g.id || g.jid;
        const name = g.subject || g.name || jid;
        const isMonitored = cachedMonitoredJids.has(jid);
        return '<div class="available-group"><div><div class="group-name">' + name + '</div><div class="group-jid">' + jid + '</div></div>' +
          (isMonitored
            ? '<button class="btn btn-outline" disabled>Ja adicionado</button>'
            : '<button class="btn btn-primary" onclick="addGroup(\\'' + jid + '\\', \\'' + name.replace(/'/g, '') + '\\')">Adicionar</button>') +
          '</div>';
      }).join('');
    }

    function filterGroups() {
      const query = document.getElementById('group-filter').value.toLowerCase();
      if (!query) { renderGroups(cachedGroups); return; }
      const filtered = cachedGroups.filter(g => {
        const name = (g.subject || g.name || '').toLowerCase();
        const jid = (g.id || g.jid || '').toLowerCase();
        return name.includes(query) || jid.includes(query);
      });
      renderGroups(filtered);
    }

    async function addGroup(jid, name) {
      await api('/api/groups/add', { method: 'POST', body: JSON.stringify({ group_jid: jid, group_name: name }) });
      await loadMonitoredGroups();
      loadAvailableGroups();

      // Show importing status inline
      const statusId = 'status-' + jid.replace(/[^a-zA-Z0-9]/g, '');
      const statusEl = document.getElementById(statusId);
      if (statusEl) {
        statusEl.innerHTML = '<span style="color:#f0b429;"><span class="status-dot yellow" style="display:inline-block;margin-right:6px;animation:pulse 1s infinite;"></span>Importando historico (24h)...</span>';
      }

      // Import history
      const result = await api('/api/import-history', { method: 'POST', body: JSON.stringify({ group_jid: jid, group_name: name }) });
      const count = result?.imported || 0;
      if (statusEl) {
        statusEl.innerHTML = '<span style="color:#00a884;">' + count + ' mensagens importadas</span>';
        setTimeout(() => { if (statusEl) statusEl.innerHTML = ''; }, 15000);
      }
    }

    async function removeGroup(jid) {
      if (!confirm('Remover este grupo do monitoramento?')) return;
      await api('/api/groups/remove', { method: 'POST', body: JSON.stringify({ group_jid: jid }) });
      loadMonitoredGroups();
      loadAvailableGroups();
    }

    async function loadSettings() {
      const data = await api('/api/settings');
      const hour = parseInt(data.summary_cron?.split(' ')[1] || '23');
      document.getElementById('cron-hour').value = hour;
      document.getElementById('email-to').value = data.email_to || '';
    }

    async function saveSettings() {
      const hour = document.getElementById('cron-hour').value;
      const emailTo = document.getElementById('email-to').value;
      const cron = '0 ' + hour + ' * * *';
      await api('/api/settings', { method: 'POST', body: JSON.stringify({ summary_cron: cron, email_to: emailTo }) });
      const msg = document.getElementById('settings-msg');
      msg.className = 'msg success';
      msg.textContent = 'Configuracoes salvas! Reinicie o app para aplicar o novo horario.';
      setTimeout(() => msg.style.display = 'none', 5000);
    }

    async function triggerSummary() {
      const btn = document.getElementById('btn-trigger');
      const msg = document.getElementById('trigger-msg');
      btn.disabled = true;
      btn.textContent = 'Enviando...';
      try {
        const data = await api('/api/trigger', { method: 'POST' });
        msg.className = 'msg success';
        msg.textContent = data.message || 'Resumo enviado!';
      } catch {
        msg.className = 'msg error';
        msg.textContent = 'Erro ao enviar resumo.';
      }
      btn.disabled = false;
      btn.textContent = 'Enviar resumo agora';
      setTimeout(() => msg.style.display = 'none', 5000);
    }

    async function logout() {
      await api('/api/logout', { method: 'POST' });
      window.location.href = '/admin/login';
    }

    // Init
    checkConnection();
    loadMonitoredGroups();
    loadSettings();
  </script>
</body>
</html>`;
}

export default router;
