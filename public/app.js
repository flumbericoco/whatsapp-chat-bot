/**
 * Pesat.ai WhatsApp console.
 *
 * Plain ES modules-free script, no build step: the whole dashboard is served
 * as a static asset by the same Worker that hosts /api, so it shares an origin
 * and needs no CORS handling.
 *
 * Routing is on the URL hash rather than the path, so that unmatched paths
 * still reach the Worker instead of being swallowed by an SPA fallback.
 */

const STORAGE_KEY = 'pesat.apiKey';

const state = {
  key: null,
  role: null,
  /** The tenant behind the key, when a tenant key is used. */
  ownTenant: null,
  tenantId: null,
  currentTenant: null,
  conversations: [],
  convStatusFilter: '',
  activeConversationId: null,
  timers: [],
};

// --- Utilities -----------------------------------------------------------

/**
 * Everything rendered through innerHTML passes through here. Conversation
 * content is written by customers, so it is untrusted input.
 */
function esc(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function el(id) {
  return document.getElementById(id);
}

let toastTimer = null;
function toast(message, isError = false) {
  const node = el('toast');
  node.textContent = message;
  node.classList.toggle('bad', isError);
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.hidden = true;
  }, isError ? 5000 : 2600);
}

function fmtDateTime(seconds) {
  if (!seconds) return '-';
  return new Date(seconds * 1000).toLocaleString('id-ID', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function fmtRelative(seconds) {
  if (!seconds) return '';
  const diff = Date.now() / 1000 - seconds;
  if (diff < 60) return 'baru saja';
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}j`;
  return `${Math.floor(diff / 86400)}h`;
}

function fmtNumber(value) {
  return Number(value ?? 0).toLocaleString('id-ID');
}

/** Meta only allows free-form replies within 24 hours of the last inbound. */
function withinServiceWindow(lastInboundAt) {
  if (!lastInboundAt) return false;
  return Date.now() / 1000 - lastInboundAt < 86400;
}

async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${state.key}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers ?? {}),
    },
  });

  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};

  if (!response.ok) {
    if (response.status === 401) {
      logout('Key tidak berlaku. Silakan masuk lagi.');
    }
    throw new Error(payload.error ?? `Permintaan gagal (${response.status})`);
  }
  return payload;
}

function clearTimers() {
  for (const timer of state.timers) clearInterval(timer);
  state.timers = [];
}

// --- Session -------------------------------------------------------------

async function connect(key, remember) {
  const previous = state.key;
  state.key = key;
  try {
    const me = await api('/me');
    state.role = me.role;
    state.ownTenant = me.tenant;
    if (remember) localStorage.setItem(STORAGE_KEY, key);
    return true;
  } catch (error) {
    state.key = previous;
    throw error;
  }
}

function logout(message) {
  clearTimers();
  localStorage.removeItem(STORAGE_KEY);
  state.key = null;
  state.role = null;
  state.ownTenant = null;
  state.currentTenant = null;
  el('app').hidden = true;
  el('login').hidden = false;
  el('key-input').value = '';
  if (message) {
    const error = el('login-error');
    error.textContent = message;
    error.hidden = false;
  }
}

function showApp() {
  el('login').hidden = true;
  el('app').hidden = false;
  const pill = el('role-pill');
  pill.textContent = state.role === 'admin' ? 'Admin platform' : 'Tenant';
  pill.className = state.role === 'admin' ? 'pill ok' : 'pill';
}

// --- Routing -------------------------------------------------------------

function parseRoute() {
  const hash = location.hash.replace(/^#\/?/, '');
  const parts = hash.split('/').filter(Boolean);

  if (parts[0] === 't' && parts[1]) {
    return { name: parts[2] ?? 'inbox', tenantId: parts[1] };
  }
  if (parts[0] === 'tenants') {
    return { name: parts[1] === 'new' ? 'tenant-new' : 'tenants' };
  }
  return null;
}

function defaultRoute() {
  if (state.role === 'admin') return '#/tenants';
  return `#/t/${state.ownTenant.id}/inbox`;
}

function navigate(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

const TENANT_VIEWS = [
  { key: 'inbox', label: 'Inbox', icon: '💬' },
  { key: 'kb', label: 'Knowledge base', icon: '📚' },
  { key: 'leads', label: 'Lead', icon: '🎯' },
  { key: 'usage', label: 'Pemakaian', icon: '📊' },
  { key: 'settings', label: 'Pengaturan', icon: '⚙️' },
];

function renderSidebar(route) {
  const nav = el('sidebar');
  const items = [];

  if (state.role === 'admin') {
    items.push(`<div class="section-label">Platform</div>`);
    items.push(
      `<a class="nav-item ${route.name === 'tenants' || route.name === 'tenant-new' ? 'active' : ''}"
          href="#/tenants">🏢 Daftar tenant</a>`,
    );
  }

  if (route.tenantId) {
    const name = state.currentTenant?.name ?? 'Tenant';
    items.push(`<div class="section-label">${esc(name)}</div>`);
    for (const view of TENANT_VIEWS) {
      items.push(
        `<a class="nav-item ${route.name === view.key ? 'active' : ''}"
            href="#/t/${esc(route.tenantId)}/${view.key}">${view.icon} ${view.label}</a>`,
      );
    }
  }

  nav.innerHTML = items.join('');
  nav.classList.remove('open');
}

async function render() {
  clearTimers();
  if (!state.key) return;

  const route = parseRoute();
  if (!route) {
    location.hash = defaultRoute();
    return;
  }

  // A tenant key may only ever look at its own tenant.
  if (state.role === 'tenant' && route.tenantId && route.tenantId !== state.ownTenant.id) {
    location.hash = defaultRoute();
    return;
  }
  if (state.role === 'tenant' && !route.tenantId) {
    location.hash = defaultRoute();
    return;
  }

  const main = el('main');
  main.innerHTML = '<div class="empty">Memuat...</div>';

  try {
    if (route.tenantId && state.tenantId !== route.tenantId) {
      state.tenantId = route.tenantId;
      state.activeConversationId = null;
      state.currentTenant = null;
    }
    if (route.tenantId && !state.currentTenant) {
      const data = await api(`/tenants/${route.tenantId}`);
      state.currentTenant = data.tenant;
    }

    renderSidebar(route);

    switch (route.name) {
      case 'tenants':
        await renderTenants(main);
        break;
      case 'tenant-new':
        renderTenantNew(main);
        break;
      case 'inbox':
        await renderInbox(main);
        break;
      case 'kb':
        await renderKnowledge(main);
        break;
      case 'leads':
        await renderLeads(main);
        break;
      case 'usage':
        await renderUsage(main);
        break;
      case 'settings':
        renderSettings(main);
        break;
      default:
        location.hash = defaultRoute();
    }
  } catch (error) {
    main.innerHTML = `<div class="card"><p class="error">${esc(error.message)}</p></div>`;
  }
}

// --- Admin: tenant list --------------------------------------------------

async function renderTenants(main) {
  const { tenants } = await api('/tenants');

  const rows = tenants
    .map(
      (tenant) => `
      <tr>
        <td><strong>${esc(tenant.name)}</strong><br /><span class="muted small">${esc(tenant.slug)}</span></td>
        <td>${esc(tenant.plan)}</td>
        <td class="num">${fmtNumber(tenant.monthly_quota)}</td>
        <td>${
          tenant.wa_phone_number_id
            ? `<span class="pill ok">tersambung</span>`
            : `<span class="pill warn">belum diisi</span>`
        }</td>
        <td>${
          tenant.status === 'active'
            ? '<span class="pill ok">aktif</span>'
            : '<span class="pill bad">suspend</span>'
        }</td>
        <td>${esc(fmtDateTime(tenant.created_at))}</td>
        <td><a class="btn sm" href="#/t/${esc(tenant.id)}/inbox">Buka</a></td>
      </tr>`,
    )
    .join('');

  main.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Daftar tenant</h1>
        <p class="muted">${tenants.length} company terdaftar.</p>
      </div>
      <div class="actions">
        <a class="btn primary" href="#/tenants/new">+ Tenant baru</a>
      </div>
    </div>
    ${
      tenants.length === 0
        ? '<div class="card"><div class="empty">Belum ada tenant. Buat yang pertama.</div></div>'
        : `<div class="table-wrap"><table>
            <thead><tr>
              <th>Company</th><th>Paket</th><th>Kuota/bulan</th><th>WhatsApp</th>
              <th>Status</th><th>Dibuat</th><th></th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table></div>`
    }`;
}

function renderTenantNew(main) {
  main.innerHTML = `
    <div class="page-head">
      <div><h1>Tenant baru</h1><p class="muted">Company yang akan dilayani bot.</p></div>
      <div class="actions"><a class="btn ghost" href="#/tenants">Batal</a></div>
    </div>
    <form class="card" id="tenant-form">
      <div class="form-grid">
        <div class="form-row">
          <label for="f-name">Nama company *</label>
          <input id="f-name" required placeholder="Toko Sinar Jaya" />
        </div>
        <div class="form-row">
          <label for="f-slug">Slug *</label>
          <input id="f-slug" required placeholder="sinar-jaya" pattern="[a-z0-9-]+" />
        </div>
        <div class="form-row">
          <label for="f-plan">Paket</label>
          <select id="f-plan">
            <option value="starter">starter (1.000 pesan)</option>
            <option value="growth" selected>growth (5.000 pesan)</option>
            <option value="scale">scale (25.000 pesan)</option>
          </select>
        </div>
        <div class="form-row">
          <label for="f-lang">Bahasa</label>
          <select id="f-lang">
            <option value="id" selected>Bahasa Indonesia</option>
            <option value="en">English</option>
            <option value="ms">Bahasa Melayu</option>
            <option value="jv">Basa Jawa</option>
          </select>
        </div>
        <div class="form-row">
          <label for="f-phone">WhatsApp phone number ID</label>
          <input id="f-phone" placeholder="123456789012345" />
        </div>
        <div class="form-row">
          <label for="f-escalation">Nomor agent untuk eskalasi</label>
          <input id="f-escalation" placeholder="628123456789" />
        </div>
      </div>
      <div class="form-row">
        <label for="f-token">Meta access token</label>
        <input id="f-token" type="password" autocomplete="off" placeholder="EAAG..." />
        <span class="muted small">Dienkripsi sebelum disimpan dan tidak bisa dibaca lagi.</span>
      </div>
      <div class="form-row">
        <label for="f-persona">Tentang bisnis (persona)</label>
        <textarea id="f-persona" placeholder="Toko elektronik di Surabaya, buka 09.00-17.00 WIB, melayani pengiriman se-Jawa Timur."></textarea>
      </div>
      <div class="form-row">
        <label for="f-greeting">Sapaan pertama</label>
        <input id="f-greeting" placeholder="Halo! Ada yang bisa kami bantu?" />
      </div>
      <button class="btn primary" type="submit">Buat tenant</button>
      <p class="error" id="form-error" hidden></p>
    </form>
    <div class="card" id="key-card" hidden>
      <h2>API key tenant</h2>
      <p class="muted small">
        Hanya ditampilkan sekali. Simpan sekarang lalu berikan ke client.
      </p>
      <div class="key-reveal" id="key-value"></div>
    </div>`;

  el('tenant-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const error = el('form-error');
    error.hidden = true;

    const body = {
      name: el('f-name').value,
      slug: el('f-slug').value,
      plan: el('f-plan').value,
      language: el('f-lang').value,
      wa_phone_number_id: el('f-phone').value,
      escalation_number: el('f-escalation').value,
      wa_access_token: el('f-token').value,
      persona: el('f-persona').value,
      greeting: el('f-greeting').value,
    };

    try {
      const result = await api('/tenants', { method: 'POST', body: JSON.stringify(body) });
      el('tenant-form').hidden = true;
      el('key-card').hidden = false;
      el('key-value').textContent = result.api_key;
      toast('Tenant dibuat.');
    } catch (requestError) {
      error.textContent = requestError.message;
      error.hidden = false;
    }
  });
}

// --- Inbox ---------------------------------------------------------------

async function renderInbox(main) {
  main.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Inbox</h1>
        <p class="muted">Percakapan berjalan. Ambil alih untuk membalas manual.</p>
      </div>
    </div>
    <div class="inbox">
      <section class="conv-list">
        <div class="conv-list-head">
          <select id="conv-filter">
            <option value="">Semua status</option>
            <option value="bot">Dijawab bot</option>
            <option value="human">Ditangani agent</option>
          </select>
          <button class="btn sm ghost" id="conv-refresh" title="Muat ulang">↻</button>
        </div>
        <div class="conv-scroll" id="conv-scroll"><div class="empty">Memuat...</div></div>
      </section>
      <section class="chat" id="chat">
        <div class="empty">Pilih percakapan di kiri.</div>
      </section>
    </div>`;

  const filter = el('conv-filter');
  filter.value = state.convStatusFilter;
  filter.addEventListener('change', () => {
    state.convStatusFilter = filter.value;
    loadConversations();
  });
  el('conv-refresh').addEventListener('click', () => loadConversations());

  await loadConversations();

  // Polling keeps the inbox live without a websocket. The list moves slowly;
  // the open thread is checked more often.
  state.timers.push(setInterval(() => loadConversations(true), 12000));
  state.timers.push(
    setInterval(() => {
      if (state.activeConversationId) loadMessages(state.activeConversationId, true);
    }, 5000),
  );
}

async function loadConversations(quiet = false) {
  const scroll = el('conv-scroll');
  if (!scroll) return;

  try {
    const query = state.convStatusFilter ? `?status=${encodeURIComponent(state.convStatusFilter)}` : '';
    const { conversations } = await api(`/tenants/${state.tenantId}/conversations${query}`);
    state.conversations = conversations;

    if (conversations.length === 0) {
      scroll.innerHTML = '<div class="empty">Belum ada percakapan.</div>';
      return;
    }

    scroll.innerHTML = conversations
      .map(
        (conversation) => `
        <button class="conv ${conversation.id === state.activeConversationId ? 'active' : ''}"
                data-id="${esc(conversation.id)}">
          <span class="row1">
            <span class="name">${esc(conversation.contact_name || conversation.contact_wa_id)}</span>
            <span class="when">${esc(fmtRelative(conversation.last_message_at))}</span>
          </span>
          <span class="muted small">
            ${esc(conversation.contact_wa_id)}
            ${
              conversation.status === 'human'
                ? '<span class="pill warn">agent</span>'
                : '<span class="pill ok">bot</span>'
            }
          </span>
        </button>`,
      )
      .join('');

    for (const button of scroll.querySelectorAll('.conv')) {
      button.addEventListener('click', () => openConversation(button.dataset.id));
    }
  } catch (error) {
    if (!quiet) scroll.innerHTML = `<div class="empty">${esc(error.message)}</div>`;
  }
}

function openConversation(id) {
  state.activeConversationId = id;
  for (const button of document.querySelectorAll('.conv')) {
    button.classList.toggle('active', button.dataset.id === id);
  }
  loadMessages(id);
}

async function loadMessages(conversationId, quiet = false) {
  const chat = el('chat');
  if (!chat) return;

  const conversation = state.conversations.find((item) => item.id === conversationId);
  if (!conversation) return;

  if (!quiet) chat.innerHTML = '<div class="empty">Memuat...</div>';

  let messages;
  try {
    const data = await api(`/tenants/${state.tenantId}/conversations/${conversationId}/messages`);
    messages = data.messages;
  } catch (error) {
    if (!quiet) chat.innerHTML = `<div class="empty">${esc(error.message)}</div>`;
    return;
  }

  // A quiet refresh must not steal focus or scroll position while the agent
  // is mid-sentence.
  const composer = el('composer-text');
  const draft = composer ? composer.value : '';
  const hadFocus = composer && document.activeElement === composer;

  const isHuman = conversation.status === 'human';
  const canReply = withinServiceWindow(conversation.last_inbound_at);

  const bubbles = messages
    .map((message) => {
      const outbound = message.role !== 'user';
      const who =
        message.role === 'user'
          ? esc(conversation.contact_name || conversation.contact_wa_id)
          : message.role === 'agent'
            ? 'Agent'
            : 'Bot';
      return `<div class="bubble ${outbound ? 'out' : ''}">${esc(message.content)}
        <span class="meta">${who} · ${esc(fmtDateTime(message.created_at))}</span></div>`;
    })
    .join('');

  chat.innerHTML = `
    <div class="chat-head">
      <div>
        <strong>${esc(conversation.contact_name || conversation.contact_wa_id)}</strong>
        <div class="muted small">${esc(conversation.contact_wa_id)}</div>
      </div>
      <div style="margin-left:auto; display:flex; gap:8px; align-items:center;">
        ${isHuman ? '<span class="pill warn">agent</span>' : '<span class="pill ok">bot</span>'}
        <button class="btn sm" id="toggle-owner">${isHuman ? 'Kembalikan ke bot' : 'Ambil alih'}</button>
      </div>
    </div>
    <div class="chat-scroll" id="chat-scroll">
      ${messages.length ? bubbles : '<div class="empty">Belum ada pesan.</div>'}
    </div>
    ${
      canReply
        ? `<div class="composer">
            <textarea id="composer-text" placeholder="Tulis balasan sebagai agent..."></textarea>
            <button class="btn primary" id="composer-send">Kirim</button>
          </div>
          ${
            isHuman
              ? ''
              : '<div class="notice">Bot masih menjawab percakapan ini. Ambil alih dulu agar tidak dobel jawaban.</div>'
          }`
        : `<div class="notice">
            Di luar jendela 24 jam WhatsApp. Balasan teks bebas ditolak Meta,
            gunakan template yang sudah disetujui.
          </div>`
    }`;

  const scroll = el('chat-scroll');
  if (scroll) scroll.scrollTop = scroll.scrollHeight;

  const newComposer = el('composer-text');
  if (newComposer && draft) {
    newComposer.value = draft;
    if (hadFocus) newComposer.focus();
  }

  el('toggle-owner').addEventListener('click', async (event) => {
    event.target.disabled = true;
    try {
      const action = isHuman ? 'release' : 'takeover';
      await api(`/tenants/${state.tenantId}/conversations/${conversationId}/${action}`, {
        method: 'POST',
      });
      toast(isHuman ? 'Dikembalikan ke bot.' : 'Percakapan diambil alih.');
      await loadConversations(true);
      await loadMessages(conversationId);
    } catch (error) {
      toast(error.message, true);
      event.target.disabled = false;
    }
  });

  const sendButton = el('composer-send');
  if (sendButton) {
    const send = async () => {
      const text = el('composer-text').value.trim();
      if (!text) return;
      sendButton.disabled = true;
      try {
        await api(`/tenants/${state.tenantId}/conversations/${conversationId}/send`, {
          method: 'POST',
          body: JSON.stringify({ text }),
        });
        el('composer-text').value = '';
        await loadMessages(conversationId);
      } catch (error) {
        toast(error.message, true);
      } finally {
        sendButton.disabled = false;
      }
    };
    sendButton.addEventListener('click', send);
    el('composer-text').addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        send();
      }
    });
  }
}

// --- Knowledge base ------------------------------------------------------

async function renderKnowledge(main) {
  const { documents } = await api(`/tenants/${state.tenantId}/documents`);

  main.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Knowledge base</h1>
        <p class="muted">Sumber jawaban bot. Tanpa ini bot tidak tahu apa pun soal bisnis.</p>
      </div>
    </div>

    <div class="card">
      <h2>Tambah dokumen</h2>
      <form id="doc-form">
        <div class="form-row">
          <label for="d-title">Judul *</label>
          <input id="d-title" required placeholder="Daftar Harga 2026" />
        </div>
        <div class="form-row">
          <label for="d-content">Isi *</label>
          <textarea id="d-content" required rows="8"
            placeholder="Tempel teks harga, FAQ, kebijakan pengembalian, jam operasional..."></textarea>
          <span class="muted small">Teks biasa. PDF dan DOCX harus diubah ke teks dulu.</span>
        </div>
        <button class="btn primary" type="submit" id="doc-submit">Simpan dan indeks</button>
      </form>
    </div>

    <div class="card">
      <h2>Tes retrieval</h2>
      <p class="muted small">Lihat passage yang akan dibaca bot sebelum customer bertanya.</p>
      <div class="form-row" style="margin-top:10px">
        <input id="q-input" placeholder="berapa ongkir ke Malang?" />
      </div>
      <button class="btn" id="q-btn">Cari</button>
      <div id="q-result"></div>
    </div>

    <h2 style="margin:18px 0 8px">${documents.length} dokumen terindeks</h2>
    ${
      documents.length === 0
        ? '<div class="card"><div class="empty">Belum ada dokumen.</div></div>'
        : `<div class="table-wrap"><table>
            <thead><tr><th>Judul</th><th class="num">Chunk</th><th>Ditambahkan</th><th></th></tr></thead>
            <tbody>${documents
              .map(
                (document_) => `<tr>
                  <td class="wrap">${esc(document_.title)}</td>
                  <td class="num">${fmtNumber(document_.chunk_count)}</td>
                  <td>${esc(fmtDateTime(document_.created_at))}</td>
                  <td><button class="btn sm danger" data-doc="${esc(document_.id)}">Hapus</button></td>
                </tr>`,
              )
              .join('')}</tbody>
          </table></div>`
    }`;

  el('doc-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = el('doc-submit');
    button.disabled = true;
    button.textContent = 'Mengindeks...';
    try {
      const result = await api(`/tenants/${state.tenantId}/documents`, {
        method: 'POST',
        body: JSON.stringify({
          title: el('d-title').value,
          content: el('d-content').value,
        }),
      });
      toast(
        result.deduplicated
          ? 'Dokumen identik sudah ada, tidak diindeks ulang.'
          : `Terindeks jadi ${result.chunkCount} chunk.`,
      );
      render();
    } catch (error) {
      toast(error.message, true);
      button.disabled = false;
      button.textContent = 'Simpan dan indeks';
    }
  });

  el('q-btn').addEventListener('click', async () => {
    const query = el('q-input').value.trim();
    if (!query) return;
    const box = el('q-result');
    box.innerHTML = '<p class="muted small">Mencari...</p>';
    try {
      const { chunks } = await api(`/tenants/${state.tenantId}/search`, {
        method: 'POST',
        body: JSON.stringify({ query }),
      });
      box.innerHTML = chunks.length
        ? chunks
            .map(
              (chunk) => `<div class="key-reveal" style="margin-top:10px">
                <strong>${esc(chunk.title)}</strong>
                <span class="pill">skor ${chunk.score.toFixed(3)}</span>
                <div style="margin-top:6px; white-space:pre-wrap">${esc(chunk.text)}</div>
              </div>`,
            )
            .join('')
        : `<p class="muted small" style="margin-top:10px">
             Tidak ada passage yang cocok. Bot akan menjawab tidak tahu dan menawarkan agent.
           </p>`;
    } catch (error) {
      box.innerHTML = `<p class="error" style="margin-top:10px">${esc(error.message)}</p>`;
    }
  });

  for (const button of main.querySelectorAll('[data-doc]')) {
    button.addEventListener('click', async () => {
      if (!confirm('Hapus dokumen ini beserta vektornya?')) return;
      try {
        await api(`/tenants/${state.tenantId}/documents/${button.dataset.doc}`, {
          method: 'DELETE',
        });
        toast('Dokumen dihapus.');
        render();
      } catch (error) {
        toast(error.message, true);
      }
    });
  }
}

// --- Leads ---------------------------------------------------------------

async function renderLeads(main) {
  const { leads } = await api(`/tenants/${state.tenantId}/leads`);

  main.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Lead</h1>
        <p class="muted">Dikumpulkan bot saat customer menyebut nama dan minatnya.</p>
      </div>
    </div>
    ${
      leads.length === 0
        ? '<div class="card"><div class="empty">Belum ada lead.</div></div>'
        : `<div class="table-wrap"><table>
            <thead><tr>
              <th>Nama</th><th>WhatsApp</th><th>Email</th><th>Minat</th><th>Catatan</th><th>Waktu</th>
            </tr></thead>
            <tbody>${leads
              .map(
                (lead) => `<tr>
                  <td>${esc(lead.name || '-')}</td>
                  <td>${esc(lead.phone || '-')}</td>
                  <td>${esc(lead.email || '-')}</td>
                  <td class="wrap">${esc(lead.interest || '-')}</td>
                  <td class="wrap">${esc(lead.notes || '-')}</td>
                  <td>${esc(fmtDateTime(lead.created_at))}</td>
                </tr>`,
              )
              .join('')}</tbody>
          </table></div>`
    }`;
}

// --- Usage ---------------------------------------------------------------

async function renderUsage(main) {
  const usage = await api(`/tenants/${state.tenantId}/usage`);
  const used = usage.this_month.messages;
  const percent = usage.monthly_quota ? Math.min(100, (used / usage.monthly_quota) * 100) : 0;

  main.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Pemakaian</h1>
        <p class="muted">Paket ${esc(usage.plan)}. Kuota berjalan per bulan kalender UTC.</p>
      </div>
    </div>

    <div class="grid">
      <div class="stat">
        <div class="label">Pesan bulan ini</div>
        <div class="value">${fmtNumber(used)}</div>
        <div class="meter ${percent >= 100 ? 'over' : ''}"><span style="width:${percent}%"></span></div>
        <div class="muted small" style="margin-top:6px">
          dari ${fmtNumber(usage.monthly_quota)} · sisa ${fmtNumber(usage.remaining)}
        </div>
      </div>
      <div class="stat">
        <div class="label">Token input</div>
        <div class="value">${fmtNumber(usage.this_month.input_tokens)}</div>
      </div>
      <div class="stat">
        <div class="label">Token output</div>
        <div class="value">${fmtNumber(usage.this_month.output_tokens)}</div>
      </div>
    </div>

    <h2 style="margin:18px 0 8px">Harian (30 hari terakhir)</h2>
    ${
      usage.daily.length === 0
        ? '<div class="card"><div class="empty">Belum ada pemakaian.</div></div>'
        : `<div class="table-wrap"><table>
            <thead><tr><th>Tanggal</th><th class="num">Pesan</th><th class="num">Token in</th><th class="num">Token out</th></tr></thead>
            <tbody>${usage.daily
              .map(
                (day) => `<tr>
                  <td>${esc(day.day)}</td>
                  <td class="num">${fmtNumber(day.messages)}</td>
                  <td class="num">${fmtNumber(day.input_tokens)}</td>
                  <td class="num">${fmtNumber(day.output_tokens)}</td>
                </tr>`,
              )
              .join('')}</tbody>
          </table></div>`
    }
    <p class="muted small" style="margin-top:10px">
      Token di sini adalah angka sungguhan yang dilaporkan provider, jadi bisa
      dipakai menghitung biaya per balasan.
    </p>`;
}

// --- Settings ------------------------------------------------------------

function renderSettings(main) {
  const tenant = state.currentTenant;
  const isAdmin = state.role === 'admin';

  main.innerHTML = `
    <div class="page-head">
      <div><h1>Pengaturan</h1><p class="muted">${esc(tenant.name)} · ${esc(tenant.slug)}</p></div>
    </div>

    <form class="card" id="settings-form">
      <h2>Perilaku bot</h2>
      <div class="form-grid" style="margin-top:10px">
        <div class="form-row">
          <label for="s-name">Nama company</label>
          <input id="s-name" value="${esc(tenant.name)}" />
        </div>
        <div class="form-row">
          <label for="s-lang">Bahasa</label>
          <select id="s-lang">
            ${['id', 'en', 'ms', 'jv']
              .map(
                (code) =>
                  `<option value="${code}" ${tenant.language === code ? 'selected' : ''}>${code}</option>`,
              )
              .join('')}
          </select>
        </div>
        <div class="form-row">
          <label for="s-model">Model</label>
          <select id="s-model">
            <option value="" ${!tenant.model ? 'selected' : ''}>default platform</option>
            ${['pesat-flash', 'pesat-pro', 'pesat-lite']
              .map(
                (id) =>
                  `<option value="${id}" ${tenant.model === id ? 'selected' : ''}>${id}</option>`,
              )
              .join('')}
          </select>
        </div>
        <div class="form-row">
          <label for="s-escalation">Nomor agent untuk eskalasi</label>
          <input id="s-escalation" value="${esc(tenant.escalation_number ?? '')}" />
        </div>
      </div>
      <div class="form-row">
        <label for="s-persona">Tentang bisnis (persona)</label>
        <textarea id="s-persona">${esc(tenant.persona ?? '')}</textarea>
      </div>
      <div class="form-row">
        <label for="s-greeting">Sapaan pertama</label>
        <input id="s-greeting" value="${esc(tenant.greeting ?? '')}" />
      </div>
      <div class="form-row">
        <label for="s-fallback">Pesan cadangan saat bot gagal</label>
        <input id="s-fallback" value="${esc(tenant.fallback_message ?? '')}" />
      </div>

      <h2 style="margin-top:18px">Sambungan WhatsApp</h2>
      <div class="form-grid" style="margin-top:10px">
        <div class="form-row">
          <label for="s-phone">Phone number ID</label>
          <input id="s-phone" value="${esc(tenant.wa_phone_number_id ?? '')}" />
        </div>
        <div class="form-row">
          <label for="s-token">Access token baru</label>
          <input id="s-token" type="password" autocomplete="off" placeholder="kosongkan bila tidak diubah" />
        </div>
      </div>

      ${
        isAdmin
          ? `<h2 style="margin-top:18px">Komersial (admin)</h2>
             <div class="form-grid" style="margin-top:10px">
               <div class="form-row">
                 <label for="s-plan">Paket</label>
                 <select id="s-plan">
                   ${['starter', 'growth', 'scale']
                     .map(
                       (plan) =>
                         `<option value="${plan}" ${tenant.plan === plan ? 'selected' : ''}>${plan}</option>`,
                     )
                     .join('')}
                 </select>
               </div>
               <div class="form-row">
                 <label for="s-quota">Kuota pesan per bulan</label>
                 <input id="s-quota" type="number" min="0" value="${esc(tenant.monthly_quota)}" />
               </div>
               <div class="form-row">
                 <label for="s-status">Status</label>
                 <select id="s-status">
                   <option value="active" ${tenant.status === 'active' ? 'selected' : ''}>aktif</option>
                   <option value="suspended" ${tenant.status === 'suspended' ? 'selected' : ''}>suspend</option>
                 </select>
               </div>
             </div>`
          : ''
      }

      <button class="btn primary" type="submit" id="s-save">Simpan</button>
      <p class="error" id="s-error" hidden></p>
    </form>

    ${
      isAdmin
        ? `<div class="card">
            <h2>Tindakan admin</h2>
            <p class="muted small">Rotasi key mencabut key lama milik client seketika.</p>
            <div style="display:flex; gap:8px; margin-top:10px; flex-wrap:wrap">
              <button class="btn" id="rotate-btn">Rotasi API key</button>
              <button class="btn danger" id="delete-btn">Hapus tenant</button>
            </div>
            <div class="key-reveal" id="new-key" hidden></div>
          </div>`
        : ''
    }`;

  el('settings-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const error = el('s-error');
    error.hidden = true;
    const button = el('s-save');
    button.disabled = true;

    const body = {
      name: el('s-name').value,
      language: el('s-lang').value,
      model: el('s-model').value,
      escalation_number: el('s-escalation').value,
      persona: el('s-persona').value,
      greeting: el('s-greeting').value,
      fallback_message: el('s-fallback').value,
      wa_phone_number_id: el('s-phone').value,
    };
    if (el('s-token').value) body.wa_access_token = el('s-token').value;
    if (isAdmin) {
      body.plan = el('s-plan').value;
      body.monthly_quota = Number(el('s-quota').value);
      body.status = el('s-status').value;
    }

    try {
      const result = await api(`/tenants/${state.tenantId}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      state.currentTenant = result.tenant;
      toast('Pengaturan disimpan.');
      render();
    } catch (requestError) {
      error.textContent = requestError.message;
      error.hidden = false;
      button.disabled = false;
    }
  });

  if (isAdmin) {
    el('rotate-btn').addEventListener('click', async () => {
      if (!confirm('Key lama akan langsung tidak berlaku. Lanjutkan?')) return;
      try {
        const result = await api(`/tenants/${state.tenantId}/rotate-key`, { method: 'POST' });
        const box = el('new-key');
        box.hidden = false;
        box.textContent = result.api_key;
        toast('Key baru dibuat. Simpan sekarang.');
      } catch (error) {
        toast(error.message, true);
      }
    });

    el('delete-btn').addEventListener('click', async () => {
      if (!confirm(`Hapus ${state.currentTenant.name} beserta seluruh data dan vektornya?`)) return;
      try {
        await api(`/tenants/${state.tenantId}`, { method: 'DELETE' });
        state.currentTenant = null;
        state.tenantId = null;
        toast('Tenant dihapus.');
        navigate('#/tenants');
      } catch (error) {
        toast(error.message, true);
      }
    });
  }
}

// --- Boot ----------------------------------------------------------------

el('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const error = el('login-error');
  const button = el('login-btn');
  error.hidden = true;
  button.disabled = true;
  button.textContent = 'Memeriksa...';

  try {
    await connect(el('key-input').value.trim(), el('remember-key').checked);
    showApp();
    if (!parseRoute()) location.hash = defaultRoute();
    else render();
  } catch (requestError) {
    error.textContent = requestError.message;
    error.hidden = false;
  } finally {
    button.disabled = false;
    button.textContent = 'Masuk';
  }
});

el('logout-btn').addEventListener('click', () => logout());
el('menu-toggle').addEventListener('click', () => el('sidebar').classList.toggle('open'));
window.addEventListener('hashchange', render);

(async function boot() {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (!stored) return;
  try {
    await connect(stored, true);
    showApp();
    if (!parseRoute()) location.hash = defaultRoute();
    else render();
  } catch {
    localStorage.removeItem(STORAGE_KEY);
  }
})();
