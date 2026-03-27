import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { config } from './config';
import {
  getMonitoredGroupsWithNames,
  addMonitoredGroup,
  removeMonitoredGroup,
  getSetting,
  setSetting,
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
      config.evolution.apiUrl + '/group/fetchAllGroups/' + config.evolution.instanceName,
      { headers: { 'apikey': config.evolution.apiKey } }
    );
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.get('/api/groups/monitored', (_req: Request, res: Response) => {
  const groups = getMonitoredGroupsWithNames();
  res.json(groups);
});

router.post('/api/groups/add', (req: Request, res: Response) => {
  const { group_jid, group_name } = req.body;
  if (!group_jid) {
    res.status(400).json({ error: 'group_jid required' });
    return;
  }
  addMonitoredGroup(group_jid, group_name || group_jid);

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

// --- API: Trigger ---
router.post('/api/trigger', async (_req: Request, res: Response) => {
  try {
    await runDailySummary();
    res.json({ ok: true, message: 'Resumo enviado!' });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

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
      <button class="btn btn-outline" onclick="loadAvailableGroups()" style="margin-bottom:12px;">Atualizar lista</button>
      <div id="available-list">
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
      list.innerHTML = data.map(g =>
        '<li><div><div class="group-name">' + g.group_name + '</div><div class="group-jid">' + g.group_jid + '</div></div>' +
        '<button class="btn btn-danger" onclick="removeGroup(\\'' + g.group_jid + '\\')">Remover</button></li>'
      ).join('');
    }

    async function loadAvailableGroups() {
      const container = document.getElementById('available-list');
      container.innerHTML = '<div class="loading">Carregando grupos...</div>';
      try {
        const data = await api('/api/groups/available');
        const groups = Array.isArray(data) ? data : (data?.groups || []);
        const monitored = await api('/api/groups/monitored');
        const monitoredJids = new Set(monitored.map(g => g.group_jid));

        if (!groups.length) {
          container.innerHTML = '<div class="loading">Nenhum grupo encontrado. Conecte o WhatsApp primeiro.</div>';
          return;
        }
        container.innerHTML = groups.map(g => {
          const jid = g.id || g.jid;
          const name = g.subject || g.name || jid;
          const isMonitored = monitoredJids.has(jid);
          return '<div class="available-group"><div><div class="group-name">' + name + '</div><div class="group-jid">' + jid + '</div></div>' +
            (isMonitored
              ? '<button class="btn btn-outline" disabled>Ja adicionado</button>'
              : '<button class="btn btn-primary" onclick="addGroup(\\'' + jid + '\\', \\'' + name.replace(/'/g, '') + '\\')">Adicionar</button>') +
            '</div>';
        }).join('');
      } catch {
        container.innerHTML = '<div class="loading">Erro ao carregar grupos. Conecte o WhatsApp primeiro.</div>';
      }
    }

    async function addGroup(jid, name) {
      await api('/api/groups/add', { method: 'POST', body: JSON.stringify({ group_jid: jid, group_name: name }) });
      loadMonitoredGroups();
      loadAvailableGroups();
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
