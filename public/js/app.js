/* VR Salas — SPA (vanilla JS) */
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const state = { me: null, settings: null, rooms: [], directory: [], agendaDate: null };

  // ---------- Utilidades ----------
  const todayStr = () => new Date().toLocaleDateString('sv-SE');
  const addDays = (d, n) => { const x = new Date(d + 'T12:00:00'); x.setDate(x.getDate() + n); return x.toLocaleDateString('sv-SE'); };
  const brDate = (d) => d.split('-').reverse().join('/');
  const WEEK = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
  const MONTH = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  const longDate = (d) => { const x = new Date(d + 'T12:00:00'); return `${['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'][x.getDay()]}, ${x.getDate()} de ${MONTH[x.getMonth()]}. de ${x.getFullYear()}`; };
  const toMin = (t) => { const [h, m] = t.slice(0, 5).split(':').map(Number); return h * 60 + m; };
  const fromMin = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const nowMin = () => { const n = new Date(); return n.getHours() * 60 + n.getMinutes(); };
  const roundUp15 = (m) => Math.ceil(m / 15) * 15;
  const initials = (n) => n.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('');
  const relTime = (iso) => {
    const s = (Date.now() - new Date(iso)) / 1000;
    if (s < 60) return 'agora';
    if (s < 3600) return `há ${Math.floor(s / 60)} min`;
    if (s < 86400) return `há ${Math.floor(s / 3600)} h`;
    return new Date(iso).toLocaleDateString('pt-BR');
  };
  const STATUS = { confirmed: 'Confirmada', checked_in: 'Check-in feito', no_show: 'Sem check-in', cancelled: 'Cancelada' };
  const statusChip = (s) => `<span class="chip chip-${s}">${STATUS[s] || s}</span>`;
  const isAdmin = () => state.me?.role === 'admin';

  async function api(url, opts = {}) {
    const r = await fetch('/api' + url, {
      method: opts.method || 'GET',
      headers: opts.body ? { 'Content-Type': 'application/json' } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    if (r.status === 401) {
      const d = await r.json().catch(() => ({}));
      location.href = d.code === 'replaced' ? '/?error=' + encodeURIComponent(d.error) : '/';
      throw new Error('Sessão expirada');
    }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'Erro inesperado');
    return data;
  }

  function toast(title, msg = '', type = 'ok') {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.innerHTML = `<span class="ic">${icon(type === 'ok' ? 'checkCircle' : 'alert')}</span><div style="flex:1"><b>${esc(title)}</b>${msg ? `<p>${esc(msg)}</p>` : ''}</div>
      <button class="btn-ghost" style="border:0;background:none;cursor:pointer;color:#71717A;align-self:flex-start">${icon('x')}</button>`;
    $('button', el).onclick = () => el.remove();
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), type === 'ok' ? 4000 : 7000);
  }
  const fail = (e) => toast('Não foi possível concluir', e.message, 'error');

  // ---------- Modal ----------
  function modal({ title, body, foot, size = '', onMount }) {
    const root = $('#modal-root');
    const ov = document.createElement('div');
    ov.className = 'overlay';
    ov.innerHTML = `<div class="modal ${size}" role="dialog" aria-modal="true">
      <div class="modal-head"><h3>${esc(title)}</h3><button class="tb-btn" data-close>${icon('x')}</button></div>
      <div class="modal-body">${body}</div>${foot ? `<div class="modal-foot">${foot}</div>` : ''}</div>`;
    const close = () => ov.remove();
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
    $$('[data-close]', ov).forEach((b) => (b.onclick = close));
    document.addEventListener('keydown', function k(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', k); } });
    root.appendChild(ov);
    onMount && onMount(ov, close);
    const first = $('input:not([type=hidden]),select,textarea', ov); first && first.focus();
    return { el: ov, close };
  }

  function confirmDialog({ title, message, confirmLabel = 'Confirmar', danger = false, extra = '' }) {
    return new Promise((resolve) => {
      modal({
        title, size: 'sm',
        body: `<p style="margin:0 0 ${extra ? 14 : 0}px;line-height:1.5">${message}</p>${extra}`,
        foot: `<button class="btn btn-outline" data-close>Voltar</button><button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" id="cf-ok">${confirmLabel}</button>`,
        onMount: (el, close) => {
          $$('[data-close]', el).forEach((b) => b.addEventListener('click', () => resolve(null)));
          $('#cf-ok', el).onclick = () => { const data = Object.fromEntries($$('[name]', el).map((i) => [i.name, i.type === 'radio' ? (i.checked ? i.value : undefined) : i.value]).filter(([, v]) => v !== undefined)); close(); resolve(data); };
        },
      });
    });
  }

  // ---------- Layout ----------
  const NAV = [
    { r: 'inicio', label: 'Início', ic: 'home' },
    { r: 'disponibilidade', label: 'Disponibilidade', ic: 'search' },
    { r: 'agenda', label: 'Agenda das salas', ic: 'calendar' },
    { r: 'minhas', label: 'Minhas reservas', ic: 'list' },
    { sec: 'Administração', admin: true },
    { r: 'salas', label: 'Salas', ic: 'door', admin: true },
    { r: 'usuarios', label: 'Usuários', ic: 'users', admin: true },
    { r: 'relatorios', label: 'Relatórios', ic: 'chart', admin: true },
    { r: 'configuracoes', label: 'Configurações', ic: 'gear', admin: true },
  ];

  function renderShell() {
    $('#nav').innerHTML = NAV.filter((n) => !n.admin || isAdmin()).map((n) =>
      n.sec ? `<div class="sec">${n.sec}</div>` : `<a href="#/${n.r}" data-r="${n.r}">${icon(n.ic)}${n.label}</a>`).join('');
    const me = state.me;
    $('#sb-user').innerHTML = `<div class="avatar">${initials(me.name)}</div>
      <div style="flex:1;min-width:0"><div class="nm">${esc(me.name)}</div><div class="rl">${me.role === 'admin' ? 'Administrador' : 'Usuário'}</div></div>${icon('chevD')}
      <div class="menu hidden" id="user-menu">
        <button data-a="pw">${icon('key')} Alterar senha</button>
        <button data-a="google">${GOOGLE_SVG} ${me.google_linked ? 'Desvincular Google Agenda' : 'Vincular Google Agenda'}</button>
        <button data-a="logout">${icon('logout')} Sair</button>
      </div>`;
    $('#sb-user').onclick = (e) => {
      const act = e.target.closest('[data-a]')?.dataset.a;
      if (!act) return $('#user-menu').classList.toggle('hidden');
      $('#user-menu').classList.add('hidden');
      if (act === 'logout') api('/auth/logout', { method: 'POST' }).then(() => (location.href = '/'));
      if (act === 'pw') changePassword();
      if (act === 'google') toggleGoogle();
    };
    $('#menu-toggle').innerHTML = icon('menu');
    $('#menu-toggle').onclick = () => $('#sidebar').classList.toggle('open');
    $('#tb-new').innerHTML = `${icon('plus')}<span class="tb-new-label">Nova reserva</span>`;
    $('#tb-new').onclick = () => bookingForm({});
    $('#tb-qr').innerHTML = `${icon('qr')}<span class="tb-new-label">Check-in QR</span>`;
    $('#tb-qr').onclick = () => qrCheckin();
    $('#tb-bell').innerHTML = icon('bell') + '<span class="badge-dot hidden" id="bell-count"></span>';
    $('#tb-bell').onclick = (e) => { e.stopPropagation(); toggleNotifications(); };
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#notif-panel') && !e.target.closest('#tb-bell')) $('#notif-panel').classList.add('hidden');
      if (!e.target.closest('#sb-user')) $('#user-menu')?.classList.add('hidden');
    });
  }

  async function toggleGoogle() {
    if (state.me.google_linked) {
      const ok = await confirmDialog({ title: 'Desvincular Google Agenda', message: 'Novas reservas deixarão de ser criadas na sua agenda Google. Deseja continuar?', confirmLabel: 'Desvincular', danger: true });
      if (!ok) return;
      await api('/auth/google/unlink', { method: 'POST' });
      state.me.google_linked = false; renderShell(); route();
      toast('Google Agenda desvinculado');
    } else {
      const cfg = await api('/auth/config');
      if (cfg.ipBlocked) return toast('Indisponível pelo IP', 'O Google só aceita localhost ou o domínio da empresa. Abra o sistema por http://localhost:3000 na máquina do servidor para vincular.', 'warn');
      if (!cfg.googleEnabled) return toast('Integração não configurada', 'Peça ao administrador para configurar as credenciais Google (GOOGLE_CLIENT_ID).', 'warn');
      location.href = '/api/auth/google';
    }
  }

  function changePassword() {
    modal({
      title: 'Alterar senha', size: 'sm',
      body: `<div class="field"><label>Senha atual</label><input class="input" type="password" id="pw-cur" autocomplete="current-password">
          <span class="help">Deixe em branco se você acessa apenas pelo Google.</span></div>
        <div class="field"><label>Nova senha</label><input class="input" type="password" id="pw-new" autocomplete="new-password"><span class="help">Mínimo de 8 caracteres.</span></div>`,
      foot: '<button class="btn btn-outline" data-close>Cancelar</button><button class="btn btn-primary" id="pw-save">Salvar</button>',
      onMount: (el, close) => {
        $('#pw-save', el).onclick = async () => {
          try { await api('/auth/change-password', { method: 'POST', body: { current: $('#pw-cur', el).value, next: $('#pw-new', el).value } }); close(); toast('Senha alterada'); } catch (e) { fail(e); }
        };
      },
    });
  }

  // ---------- Notificações ----------
  async function refreshBell() {
    try {
      const { unread } = await api('/notifications');
      const b = $('#bell-count');
      b.textContent = unread > 9 ? '9+' : unread;
      b.classList.toggle('hidden', !unread);
    } catch {}
  }
  async function toggleNotifications() {
    const p = $('#notif-panel');
    if (!p.classList.contains('hidden')) return p.classList.add('hidden');
    const { items } = await api('/notifications');
    p.innerHTML = `<div class="nh"><b style="font-weight:500">Notificações</b>${items.some((n) => !n.read_at) ? '<a href="#" id="nt-all" style="font-size:12.5px">Marcar todas como lidas</a>' : ''}</div>
      ${items.length ? items.map((n) => `<div class="notif-item ${n.read_at ? '' : 'unread'}" data-id="${n.id}">
        <span class="ic">${icon(n.type.includes('no_show') ? 'alert' : n.type === 'checkin_reminder' ? 'clock' : 'bell')}</span>
        <div><b>${esc(n.title)}</b><p>${esc(n.message)}</p><small>${relTime(n.created_at)}</small></div></div>`).join('')
        : `<div class="empty">${icon('bell')}<div>Nenhuma notificação</div></div>`}`;
    p.classList.remove('hidden');
    const all = $('#nt-all', p);
    if (all) all.onclick = async (e) => { e.preventDefault(); await api('/notifications/read-all', { method: 'POST' }); p.classList.add('hidden'); refreshBell(); };
    $$('.notif-item', p).forEach((it) => (it.onclick = async () => {
      await api(`/notifications/${it.dataset.id}/read`, { method: 'POST' });
      p.classList.add('hidden'); refreshBell();
      const n = items.find((x) => String(x.id) === it.dataset.id);
      location.hash = n.type === 'team_no_show' && isAdmin() ? '#/relatorios' : '#/minhas';
    }));
  }

  // ---------- Router ----------
  const VIEWS = {};
  const TITLES = { inicio: 'Início', disponibilidade: 'Disponibilidade', agenda: 'Agenda das salas', minhas: 'Minhas reservas', salas: 'Salas', usuarios: 'Usuários', relatorios: 'Relatórios', configuracoes: 'Configurações' };
  // Serializa a navegação: se o hash mudar durante um carregamento, renderiza de novo com o destino final
  let routing = false, routePending = false;
  async function route() {
    if (routing) { routePending = true; return; }
    routing = true;
    try { do { routePending = false; await renderRoute(); } while (routePending); } finally { routing = false; }
  }
  async function renderRoute() {
    let r = (location.hash.replace(/^#\/?/, '') || 'inicio').split('?')[0];
    if (!VIEWS[r] || (NAV.find((n) => n.r === r)?.admin && !isAdmin())) r = 'inicio';
    $$('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.r === r));
    $('#crumb').innerHTML = `VR Salas / <b>${TITLES[r]}</b>`;
    $('#sidebar').classList.remove('open');
    $('#notif-panel').classList.add('hidden');
    const view = $('#view');
    view.innerHTML = '<div class="empty">Carregando...</div>';
    try { await VIEWS[r](view); } catch (e) { view.innerHTML = `<div class="empty">${icon('alert')}<div>${esc(e.message)}</div></div>`; }
  }
  window.addEventListener('hashchange', route);
  const rerender = () => route();

  const loadRooms = async () => (state.rooms = await api('/rooms'));

  // ---------- Início ----------
  VIEWS.inicio = async (v) => {
    const [stats, rooms, mine] = await Promise.all([api('/admin/stats'), loadRooms(), api('/bookings/mine')]);
    const gBanner = !state.me.google_linked
      ? `<div class="gbanner">${GOOGLE_SVG}<div class="grow"><b style="font-weight:500">Conecte o Google Agenda</b><br><span class="help">Suas reservas passam a aparecer automaticamente na agenda do Google Workspace, com convite aos participantes.</span></div><button class="btn btn-outline btn-sm" id="g-link">Vincular</button></div>` : '';
    v.innerHTML = `
      <div class="page-head"><div><h1>Olá, ${esc(state.me.name.split(' ')[0])}</h1><p>${longDate(todayStr())}</p></div></div>
      ${gBanner}
      <div class="kpis">
        <div class="card kpi"><div class="lbl">${icon('calendar')} Reservas hoje</div><div class="val">${stats.today}</div><div class="hint">em todas as salas</div></div>
        <div class="card kpi"><div class="lbl">${icon('clock')} Em andamento</div><div class="val">${stats.ongoing}</div><div class="hint">de ${rooms.length} salas ativas</div></div>
        <div class="card kpi"><div class="lbl">${icon('alert')} Taxa de no-show</div><div class="val">${stats.noshowRate}%</div><div class="hint">${stats.noshows} reservas sem check-in · ${stats.days} dias</div></div>
        <div class="card kpi"><div class="lbl">${icon('x')} Cancelamentos</div><div class="val">${stats.cancelled}</div><div class="hint">últimos ${stats.days} dias</div></div>
      </div>
      <div class="cols">
        <div class="card"><div class="card-head"><h3>Minhas próximas reuniões</h3><a href="#/minhas" style="font-size:13px">Ver todas</a></div>
          <div id="home-mine">${mine.length ? mine.slice(0, 5).map(bookingItem).join('') : `<div class="empty">${icon('calendar')}<div>Você não tem reservas futuras.</div><button class="btn btn-primary btn-sm" style="margin-top:12px" id="home-new">${icon('plus')} Reservar sala</button></div>`}</div></div>
        <div class="card"><div class="card-head"><h3>Salas agora</h3><a href="#/agenda" style="font-size:13px">Agenda</a></div>
          <div class="status-list">${rooms.length ? rooms.map((r) => {
            const c = r.current_booking;
            return `<div class="status-item" style="--c:${r.color}"><span class="sw"></span>
              <div class="inf"><b>${esc(r.name)}</b><small>${c ? `${esc(c.title)} · até ${new Date(c.ends_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`
                : r.next_start ? `Livre até ${new Date(r.next_start).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}` : 'Livre pelo resto do dia'}</small></div>
              ${c ? '<span class="chip chip-busy">Ocupada</span>' : `<button class="btn btn-outline btn-sm" data-room="${r.id}">Reservar</button>`}</div>`;
          }).join('') : `<div class="empty">Nenhuma sala cadastrada.${isAdmin() ? ' <a href="#/salas">Cadastrar sala</a>' : ''}</div>`}</div></div>
      </div>`;
    $('#g-link', v) && ($('#g-link', v).onclick = toggleGoogle);
    $('#home-new', v) && ($('#home-new', v).onclick = () => bookingForm({}));
    $$('[data-room]', v).forEach((b) => (b.onclick = () => {
      const s = roundUp15(nowMin());
      bookingForm({ room_id: Number(b.dataset.room), date: todayStr(), start: fromMin(s), end: fromMin(Math.min(s + 60, 23 * 60 + 45)) });
    }));
    bindBookingActions(v);
  };

  // Item de reserva (lista)
  function checkinState(b) {
    if (!b.requires_checkin) return null;
    const s = state.settings;
    const start = new Date(b.starts_at).getTime(), now = Date.now();
    if (b.status === 'checked_in') return 'done';
    if (b.status !== 'confirmed') return null;
    if (now < start - s.checkin_open_before_min * 60000) return 'soon';
    if (now <= start + s.checkin_tolerance_min * 60000) return 'open';
    return null;
  }
  // Só QR quando o usuário está em "Somente QR code" (admin confirmando reunião de outra pessoa pode usar o botão)
  const mustUseQr = (b) => state.me.checkin_mode === 'qr' && !(isAdmin() && b.user_id !== state.me.id);
  function ckButtons(b, size = '') {
    const qr = (primary) => `<button class="btn ${primary ? 'btn-primary' : 'btn-outline btn-icon'} ${size}" data-act="qr" data-id="${b.id}" title="Check-in por QR code">${icon('qr')}${primary ? ' Check-in por QR' : ''}</button>`;
    return mustUseQr(b) ? qr(true) : `${qr(false)}<button class="btn btn-primary ${size}" data-act="checkin" data-id="${b.id}">${icon('check')} Check-in</button>`;
  }
  function bookingItem(b) {
    const d = new Date(b.local_date + 'T12:00:00');
    const ck = checkinState(b);
    const owner = b.user_id === state.me.id || isAdmin();
    const ongoing = Date.now() >= new Date(b.starts_at) && Date.now() < new Date(b.ends_at) && ['confirmed', 'checked_in'].includes(b.status);
    const future = new Date(b.starts_at) > Date.now() && b.status === 'confirmed';
    return `<div class="bk-item">
      <div class="bk-date"><small>${WEEK[d.getDay()]}</small><b>${d.getDate()}</b><small>${MONTH[d.getMonth()]}</small></div>
      <div class="bk-info"><b>${esc(b.title)}</b> ${b.series_id ? `<span title="Reserva recorrente" style="color:var(--muted)">${icon('repeat')}</span>` : ''}
        <div class="sub"><span>${icon('clock')} ${b.local_start}–${b.local_end}</span><span>${icon('door')} ${esc(b.room_name)}</span>${b.user_id !== state.me.id ? `<span>${icon('person')} ${esc(b.user_name)}</span>` : ''}</div></div>
      <div class="bk-actions">
        ${statusChip(b.status)}
        ${ck === 'open' ? ckButtons(b, 'btn-sm') : ''}
        ${ck === 'soon' ? `<span class="help" title="O check-in abre ${state.settings.checkin_open_before_min} min antes">Check-in a partir de ${fromMin(Math.max(0, toMin(b.local_start) - state.settings.checkin_open_before_min))}</span>` : ''}
        ${ongoing && (ck === 'done' || !b.requires_checkin) ? `<button class="btn btn-outline btn-sm" data-act="finish" data-id="${b.id}" title="Encerrar e liberar a sala">${icon('stop')} Encerrar</button>` : ''}
        ${owner && future ? `<button class="btn btn-ghost btn-sm btn-icon" data-act="edit" data-id="${b.id}" title="Editar">${icon('edit')}</button>
          <button class="btn btn-ghost btn-sm btn-icon" data-act="cancel" data-id="${b.id}" data-series="${b.series_id ? 1 : ''}" title="Cancelar">${icon('trash')}</button>` : ''}
      </div></div>`;
  }

  function bindBookingActions(root) {
    $$('[data-act]', root).forEach((btn) => (btn.onclick = async (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      try {
        if (btn.dataset.act === 'qr') return qrCheckin();
        if (btn.dataset.act === 'checkin') {
          await api(`/bookings/${id}/checkin`, { method: 'POST' });
          toast('Check-in realizado', 'Boa reunião!');
        } else if (btn.dataset.act === 'finish') {
          const ok = await confirmDialog({ title: 'Encerrar reunião', message: 'A sala será liberada a partir de agora para outras reservas.', confirmLabel: 'Encerrar e liberar' });
          if (!ok) return;
          await api(`/bookings/${id}/finish`, { method: 'POST' });
          toast('Sala liberada');
        } else if (btn.dataset.act === 'edit') {
          const b = await api(`/bookings/${id}`);
          return bookingForm(b);
        } else if (btn.dataset.act === 'cancel') {
          const extra = `${btn.dataset.series ? `<div class="field"><label class="check"><input type="radio" name="scope" value="one" checked> Somente esta ocorrência</label>
              <label class="check"><input type="radio" name="scope" value="series"> Esta e as próximas da série</label></div>` : ''}
            <div class="field" style="margin:0"><label>Motivo (opcional)</label><input class="input" name="reason" maxlength="200"></div>`;
          const r = await confirmDialog({ title: 'Cancelar reserva', message: 'A sala ficará disponível para outras pessoas e o evento será removido do Google Agenda.', confirmLabel: 'Cancelar reserva', danger: true, extra });
          if (!r) return;
          const res = await api(`/bookings/${id}/cancel`, { method: 'POST', body: r });
          toast(res.cancelled > 1 ? `${res.cancelled} reservas canceladas` : 'Reserva cancelada');
        }
        rerender();
      } catch (err) { fail(err); }
    }));
  }

  // ---------- Check-in por QR (câmera do celular ou webcam) ----------
  function qrCheckin() {
    let stop = null;
    const m = modal({
      title: 'Check-in por QR code', size: 'sm',
      body: `<p style="margin:0 0 12px;color:var(--muted)">Aponte a câmera para o QR code colado na porta da sala.</p>
        <div class="qr-video"><video id="qr-video" muted playsinline></video><span class="ck-frame"></span></div>
        <div class="help" id="qr-msg" style="text-align:center"></div>`,
      foot: '<button class="btn btn-outline" data-close>Fechar</button>',
      onMount: async (el, close) => {
        const msg = $('#qr-msg', el);
        const origRemove = el.remove.bind(el);
        el.remove = () => { stop && stop(); origRemove(); };
        const begin = async () => {
          try {
            stop = await QRScan.start($('#qr-video', el), async (text) => {
              const token = QRScan.tokenFrom(text);
              if (!token) { msg.textContent = 'Este QR não é de uma sala do VR Salas.'; return setTimeout(begin, 1200); }
              msg.textContent = 'Confirmando check-in...';
              try {
                const r = await fetch('/api/checkin/' + token, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
                const d = await r.json().catch(() => ({}));
                if (!r.ok) throw new Error(d.error || 'Erro inesperado');
                close();
                toast(d.already ? 'Check-in já realizado' : 'Check-in confirmado', `${d.booking.title} · ${d.room.name}`);
                rerender();
              } catch (e) { msg.innerHTML = `<span style="color:var(--danger)">${esc(e.message)}</span>`; setTimeout(begin, 2500); }
            });
          } catch (e) {
            const v = $('.qr-video', el); if (v) v.remove();
            msg.innerHTML = `<span style="color:var(--warning)">${esc(QRScan.cameraError(e))}</span>`;
          }
        };
        begin();
      },
    });
    return m;
  }

  // ---------- Formulário de reserva ----------
  function timeOptions(sel, from = 0, to = 24 * 60) {
    const out = [];
    for (let m = from; m <= to && m < 24 * 60; m += 15) out.push(`<option ${fromMin(m) === sel ? 'selected' : ''}>${fromMin(m)}</option>`);
    return out.join('');
  }

  async function bookingForm(b) {
    if (!state.rooms.length) await loadRooms();
    if (!state.rooms.length) return toast('Nenhuma sala disponível', isAdmin() ? 'Cadastre uma sala em Administração › Salas.' : 'Peça a um administrador para cadastrar salas.', 'warn');
    if (!state.directory.length) state.directory = await api('/users/directory').catch(() => []);
    const editing = Boolean(b.id);
    const s0 = roundUp15(nowMin() + 5);
    const data = {
      room_id: b.room_id || state.rooms[0].id,
      title: b.title || '', description: b.description || '',
      date: b.local_date || b.date || todayStr(),
      start: b.local_start || b.start || fromMin(Math.max(s0, 8 * 60)),
      end: b.local_end || b.end || fromMin(Math.max(s0, 8 * 60) + 60),
      participants: [...(b.participants || [])],
    };
    const roomOpts = state.rooms.map((r) => `<option value="${r.id}" ${r.id === data.room_id ? 'selected' : ''}>${esc(r.name)} · ${r.capacity} lugares${r.location ? ' · ' + esc(r.location) : ''}</option>`).join('');
    const body = `
      ${!state.me.google_linked ? `<div class="gbanner" style="margin-bottom:16px">${GOOGLE_SVG}<span class="grow help">Sem Google Agenda vinculado: os participantes recebem o convite por e-mail.</span></div>` : ''}
      <div class="field"><label>Sala <span class="req">*</span></label><select class="input" id="bf-room">${roomOpts}</select><span class="help" id="bf-room-info"></span></div>
      <div class="field"><label>Assunto <span class="req">*</span></label><input class="input" id="bf-title" maxlength="160" value="${esc(data.title)}" placeholder="Ex.: Refinamento do backlog"></div>
      <div class="grid-3">
        <div class="field"><label>Data <span class="req">*</span></label><input class="input" type="date" id="bf-date" min="${todayStr()}" value="${data.date}"></div>
        <div class="field"><label>Início <span class="req">*</span></label><input class="input" type="time" step="60" id="bf-start" required></div>
        <div class="field"><label>Fim <span class="req">*</span></label><input class="input" type="time" step="60" id="bf-end" required></div>
      </div>
      <div class="durs" id="bf-durs"><span class="help">Duração:</span>${[15, 30, 45, 60, 90, 120].map((m) => `<button type="button" class="dur" data-dur="${m}">${m < 60 ? m + ' min' : (m / 60 + 'h').replace('.5h', 'h30')}</button>`).join('')}<span class="help" id="bf-dur-txt"></span></div>
      <div class="help" id="bf-avail" style="margin:0 0 14px"></div>
      <div class="field"><label>Participantes</label>
        <div class="chips-input" id="bf-chips"><input id="bf-pinput" list="bf-dir" placeholder="Digite nome ou e-mail e pressione Enter"></div>
        <datalist id="bf-dir">${state.directory.filter((u) => u.id !== state.me.id).map((u) => `<option value="${esc(u.email)}">${esc(u.name)}</option>`).join('')}</datalist>
        <span class="help" id="bf-cap"></span></div>
      <div class="field"><label>Descrição / pauta</label><textarea class="input" id="bf-desc" maxlength="2000">${esc(data.description)}</textarea></div>
      ${!editing ? `<div class="grid-2">
        <div class="field"><label>Repetir</label><select class="input" id="bf-repeat"><option value="none">Não repetir</option><option value="daily">Diariamente (dias úteis)</option><option value="weekly">Semanalmente</option></select></div>
        <div class="field hidden" id="bf-count-f"><label>Nº de ocorrências</label><input class="input" type="number" min="2" max="26" value="4" id="bf-count"></div>
      </div>` : ''}
      ${isAdmin() && !editing ? `<div class="field"><label>Reservar em nome de</label><select class="input" id="bf-owner"><option value="">Eu mesmo(a)</option>${state.directory.filter((u) => u.id !== state.me.id).map((u) => `<option value="${u.id}">${esc(u.name)}</option>`).join('')}</select></div>` : ''}`;

    modal({
      title: editing ? 'Editar reserva' : 'Nova reserva', body,
      foot: `<button class="btn btn-outline" data-close>Cancelar</button><button class="btn btn-primary" id="bf-save">${editing ? 'Salvar alterações' : 'Reservar'}</button>`,
      onMount: (el, close) => {
        const room = () => state.rooms.find((r) => r.id === Number($('#bf-room', el).value));
        const sIn = () => $('#bf-start', el), eIn = () => $('#bf-end', el);
        const showDur = () => {
          const d = toMin(eIn().value || '00:00') - toMin(sIn().value || '00:00');
          $('#bf-dur-txt', el).textContent = d > 0 ? `= ${d >= 60 ? Math.floor(d / 60) + 'h' + (d % 60 ? String(d % 60).padStart(2, '0') : '') : d + ' min'}` : '';
          $$('.dur', el).forEach((x) => x.classList.toggle('on', Number(x.dataset.dur) === d));
        };
        const fillTimes = () => {
          const r = room(), o = toMin(r.open_time), c = toMin(r.close_time);
          let st = toMin(sIn().value || data.start), en = toMin(eIn().value || data.end);
          st = Math.min(Math.max(st, o), c - 1);
          if (en <= st) en = Math.min(st + 60, c);
          en = Math.min(en, c);
          sIn().min = fromMin(o); sIn().max = fromMin(c - 1); eIn().min = fromMin(o + 1); eIn().max = fromMin(c);
          sIn().value = fromMin(st); eIn().value = fromMin(en);
          data.start = sIn().value; data.end = eIn().value; showDur();
          $('#bf-room-info', el).innerHTML = `${icon('clock')} ${r.open_time.slice(0, 5)}–${r.close_time.slice(0, 5)}${r.resources.length ? ' · ' + r.resources.map(esc).join(', ') : ''}${r.requires_checkin ? ' · exige check-in' : ''}`;
          checkAvail(); capInfo();
        };
        const renderChips = () => {
          $$('.pchip', el).forEach((c) => c.remove());
          data.participants.forEach((p, i) => {
            const u = state.directory.find((d) => d.email === p);
            $('#bf-pinput', el).insertAdjacentHTML('beforebegin', `<span class="pchip">${esc(u ? u.name : p)}<button type="button" data-i="${i}">×</button></span>`);
          });
          $$('.pchip button', el).forEach((x) => (x.onclick = () => { data.participants.splice(Number(x.dataset.i), 1); renderChips(); capInfo(); }));
        };
        const addParticipant = () => {
          const inp = $('#bf-pinput', el);
          inp.value.split(/[,;\s]+/).map((v) => v.trim().toLowerCase()).filter(Boolean).forEach((v) => {
            const u = state.directory.find((d) => d.email === v || d.name.toLowerCase() === v);
            const email = u ? u.email : v;
            if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return toast('E-mail inválido', v, 'warn');
            if (!data.participants.includes(email)) data.participants.push(email);
          });
          inp.value = ''; renderChips(); capInfo();
        };
        const capInfo = () => {
          const r = room(), n = data.participants.length + 1;
          $('#bf-cap', el).innerHTML = n > r.capacity ? `<span style="color:var(--warning)">${icon('alert')} ${n} pessoas para ${r.capacity} lugares — confirme se parte participará remotamente.</span>` : `${n} de ${r.capacity} lugares`;
        };
        // Validação em tempo real do horário (antes de consultar a disponibilidade)
        const timeError = () => {
          const r = room(), st = sIn().value, en = eIn().value, date = $('#bf-date', el).value;
          const o = r.open_time.slice(0, 5), c = r.close_time.slice(0, 5);
          if (!date) return { f: 'date', m: 'Informe a data.' };
          if (!st) return { f: 'start', m: 'Informe o horário de início.' };
          if (!en) return { f: 'end', m: 'Informe o horário de fim.' };
          if (st < o) return { f: 'start', m: `A ${r.name} abre às ${o}.` };
          if (st >= c) return { f: 'start', m: `A ${r.name} fecha às ${c}.` };
          if (en <= st) return { f: 'end', m: 'O fim deve ser depois do início.' };
          if (en > c) return { f: 'end', m: `A ${r.name} fecha às ${c}.` };
          const dur = toMin(en) - toMin(st);
          if (dur > state.settings.max_duration_min) return { f: 'end', m: `Duração máxima por reserva: ${Math.floor(state.settings.max_duration_min / 60)}h${state.settings.max_duration_min % 60 ? String(state.settings.max_duration_min % 60).padStart(2, '0') : ''}.` };
          const unchanged = editing && date === b.local_date && st === b.local_start;
          if (!unchanged && date < todayStr()) return { f: 'date', m: 'Essa data já passou.' };
          if (!unchanged && date === todayStr() && toMin(st) < nowMin()) return { f: 'start', m: `Esse horário já passou (agora são ${fromMin(nowMin())}).` };
          if (date > addDays(todayStr(), state.settings.max_advance_days)) return { f: 'date', m: `Reservas com até ${state.settings.max_advance_days} dias de antecedência.` };
          return null;
        };
        const markTime = (err) => {
          [['date', '#bf-date'], ['start', '#bf-start'], ['end', '#bf-end']].forEach(([f, sel]) => $(sel, el).classList.toggle('invalid', Boolean(err && err.f === f)));
          $('#bf-save', el).disabled = Boolean(err);
          if (err) $('#bf-avail', el).innerHTML = `<span style="color:var(--danger)">${icon('alert')} ${esc(err.m)}</span>`;
          return err;
        };
        let availTimer;
        const checkAvail = () => {
          clearTimeout(availTimer);
          if (markTime(timeError())) return;
          availTimer = setTimeout(async () => {
            const date = $('#bf-date', el).value, start = $('#bf-start', el).value, end = $('#bf-end', el).value;
            if (!date || !start || !end) return;
            try {
              const list = await api(`/bookings/availability?date=${date}&start=${start}&end=${end}`);
              const cur = list.find((r) => r.id === room().id);
              const box = $('#bf-avail', el);
              if (editing && date === b.local_date && start === b.local_start && end === b.local_end && room().id === b.room_id) { box.innerHTML = ''; return; }
              if (cur && cur.free) box.innerHTML = `<span style="color:var(--success)">${icon('checkCircle')} Sala livre neste horário</span>`;
              else {
                const alt = list.filter((r) => r.free && r.within_hours && r.id !== room().id).slice(0, 3);
                box.innerHTML = `<span style="color:var(--danger)">${icon('alert')} Sala ocupada neste horário.</span>${alt.length ? ' Livres: ' + alt.map((a) => `<a href="#" data-alt="${a.id}">${esc(a.name)}</a>`).join(', ') : ''}`;
                $$('[data-alt]', box).forEach((a) => (a.onclick = (e) => { e.preventDefault(); $('#bf-room', el).value = a.dataset.alt; fillTimes(); }));
              }
            } catch {}
          }, 250);
        };

        fillTimes(); renderChips();
        $('#bf-title', el).addEventListener('input', (e) => e.target.classList.remove('invalid'));
        $('#bf-room', el).onchange = fillTimes;
        // Ao mudar o início, mantém a duração; o fim pode ser digitado minuto a minuto
        sIn().onchange = () => {
          if (!sIn().value) return;
          const dur = Math.max(1, toMin(data.end) - toMin(data.start));
          const c = toMin(room().close_time);
          eIn().value = fromMin(Math.min(toMin(sIn().value) + dur, c));
          data.start = sIn().value; data.end = eIn().value; showDur(); checkAvail();
        };
        eIn().onchange = () => { if (!eIn().value) return; data.end = eIn().value; showDur(); checkAvail(); };
        $$('.dur', el).forEach((x) => (x.onclick = () => {
          const c = toMin(room().close_time), st = toMin(sIn().value || data.start);
          if (st + Number(x.dataset.dur) > c) return toast('Passa do horário da sala', `A sala fecha às ${fromMin(c)}.`, 'warn');
          eIn().value = fromMin(st + Number(x.dataset.dur)); data.end = eIn().value; showDur(); checkAvail();
        }));
        $('#bf-date', el).onchange = checkAvail;
        // Enquanto digita: valida na hora, sem esperar sair do campo
        ['#bf-start', '#bf-end', '#bf-date'].forEach((sel) => $(sel, el).addEventListener('input', () => { showDur(); checkAvail(); }));
        $('#bf-pinput', el).addEventListener('keydown', (e) => {
          if (['Enter', ',', ';', 'Tab'].includes(e.key) && e.target.value.trim()) { e.preventDefault(); addParticipant(); }
          if (e.key === 'Backspace' && !e.target.value && data.participants.length) { data.participants.pop(); renderChips(); capInfo(); }
        });
        $('#bf-pinput', el).addEventListener('change', (e) => { if (e.target.value.includes('@')) addParticipant(); });
        const rep = $('#bf-repeat', el);
        if (rep) rep.onchange = () => $('#bf-count-f', el).classList.toggle('hidden', rep.value === 'none');

        $('#bf-save', el).onclick = async () => {
          if ($('#bf-pinput', el).value.trim()) addParticipant();
          const payload = {
            room_id: Number($('#bf-room', el).value), title: $('#bf-title', el).value.trim(),
            date: $('#bf-date', el).value, start: $('#bf-start', el).value, end: $('#bf-end', el).value,
            participants: data.participants, description: $('#bf-desc', el).value,
          };
          if (!payload.title) { $('#bf-title', el).classList.add('invalid'); return $('#bf-title', el).focus(); }
          const terr = markTime(timeError());
          if (terr) return $(`#bf-${terr.f}`, el).focus();
          if (rep && rep.value !== 'none') { payload.repeat = rep.value; payload.repeat_count = Number($('#bf-count', el).value); }
          if ($('#bf-owner', el)?.value) payload.user_id = Number($('#bf-owner', el).value);
          const btn = $('#bf-save', el); btn.disabled = true;
          try {
            if (editing) {
              await api(`/bookings/${b.id}`, { method: 'PUT', body: payload });
              toast('Reserva atualizada');
            } else {
              const r = await api('/bookings', { method: 'POST', body: payload });
              if (r.skipped.length) toast(`${r.created.length} reserva(s) criada(s)`, `${r.skipped.length} ocorrência(s) não reservada(s): ` + r.skipped.map((s) => `${brDate(s.date)} — ${s.reason}`).join('; '), 'warn');
              else toast(r.created.length > 1 ? `${r.created.length} reservas criadas` : 'Sala reservada', state.me.google_linked ? 'Evento criado no seu Google Agenda.' : '');
            }
            close(); state.rooms = []; rerender();
          } catch (e) { btn.disabled = false; fail(e); }
        };
      },
    });
  }

  // ---------- Disponibilidade ----------
  VIEWS.disponibilidade = async (v) => {
    await loadRooms();
    const resources = [...new Set(state.rooms.flatMap((r) => r.resources))].sort();
    const s = roundUp15(nowMin());
    const def = { date: todayStr(), start: fromMin(Math.min(Math.max(s, 8 * 60), 22 * 60)), end: fromMin(Math.min(Math.max(s, 8 * 60) + 60, 23 * 60)) };
    v.innerHTML = `
      <div class="page-head"><div><h1>Disponibilidade</h1><p>Encontre uma sala livre para o seu horário.</p></div></div>
      <div class="card card-pad" style="margin-bottom:18px"><div class="toolbar" style="margin:0">
        <div class="field"><label>Data</label><input class="input" type="date" id="av-date" value="${def.date}"></div>
        <div class="field"><label>Início</label><input class="input" type="time" step="60" id="av-start" value="${def.start}"></div>
        <div class="field"><label>Fim</label><input class="input" type="time" step="60" id="av-end" value="${def.end}"></div>
        <div class="field"><label>Pessoas</label><input class="input" type="number" min="1" value="2" id="av-cap" style="width:90px"></div>
        <div class="field"><label>Recurso</label><select class="input" id="av-res"><option value="">Qualquer</option>${resources.map((r) => `<option>${esc(r)}</option>`).join('')}</select></div>
        <div class="field"><label class="check" style="height:36px"><input type="checkbox" id="av-only" checked> Somente livres</label></div>
      </div></div>
      <div id="av-result"></div>`;
    const run = async () => {
      const q = { date: $('#av-date').value, start: $('#av-start').value, end: $('#av-end').value };
      if (!q.date || !q.start || !q.end) return;
      if (toMin(q.end) <= toMin(q.start)) return ($('#av-result').innerHTML = '<div class="empty">O horário final deve ser maior que o inicial.</div>');
      const list = await api(`/bookings/availability?date=${q.date}&start=${q.start}&end=${q.end}&capacity=${$('#av-cap').value || 1}${$('#av-res').value ? '&resource=' + encodeURIComponent($('#av-res').value) : ''}`);
      const only = $('#av-only').checked;
      const shown = list.filter((r) => !only || (r.free && r.within_hours));
      $('#av-result').innerHTML = shown.length ? `<div class="room-cards">${shown.map((r) => {
        const ok = r.free && r.within_hours;
        return `<div class="card room-card" style="--c:${r.color}">
          <h4>${esc(r.name)} ${ok ? '<span class="chip chip-free">Livre</span>' : `<span class="chip chip-busy">${r.within_hours ? 'Ocupada' : 'Fora do horário'}</span>`}</h4>
          <div class="meta"><span>${icon('users')} ${r.capacity} lugares</span>${r.location ? `<span>${icon('pin')} ${esc(r.location)}</span>` : ''}<span>${icon('clock')} ${r.open_time.slice(0, 5)}–${r.close_time.slice(0, 5)}</span></div>
          <div>${r.resources.map((x) => `<span class="tag">${esc(x)}</span>`).join('')}</div>
          ${r.description ? `<div class="help">${esc(r.description)}</div>` : ''}
          <div class="foot"><button class="btn ${ok ? 'btn-primary' : 'btn-outline'} btn-sm btn-block" data-book="${r.id}" ${ok ? '' : 'disabled'}>Reservar ${q.start}–${q.end}</button></div>
        </div>`;
      }).join('')}</div>` : `<div class="card empty">${icon('search')}<div>Nenhuma sala livre com esses critérios. Tente outro horário ou veja a <a href="#/agenda">agenda</a>.</div></div>`;
      $$('[data-book]').forEach((b) => (b.onclick = () => bookingForm({ room_id: Number(b.dataset.book), ...q })));
    };
    $$('#av-date,#av-start,#av-end,#av-cap,#av-res,#av-only').forEach((i) => (i.onchange = () => run().catch(fail)));
    await run();
  };

  // ---------- Agenda (linha do tempo) ----------
  VIEWS.agenda = async (v) => {
    const date = state.agendaDate || todayStr();
    const [rooms, bookings] = await Promise.all([loadRooms(), api(`/bookings?from=${date}`)]);
    const startM = rooms.length ? Math.min(...rooms.map((r) => toMin(r.open_time))) : 8 * 60;
    const endM = rooms.length ? Math.max(...rooms.map((r) => toMin(r.close_time))) : 18 * 60;
    const span = endM - startM;
    const pct = (m) => ((m - startM) / span) * 100;
    const hours = []; for (let m = Math.ceil(startM / 60) * 60; m <= endM; m += 60) hours.push(m);
    const isToday = date === todayStr();
    const nm = nowMin();

    v.innerHTML = `
      <div class="page-head"><div><h1>Agenda das salas</h1><p>${longDate(date)} · clique em um horário vazio para reservar</p></div>
        <div style="display:flex;gap:8px;align-items:center">
          <button class="btn btn-outline btn-icon" id="ag-prev" title="Dia anterior">${icon('chevL')}</button>
          <button class="btn btn-outline" id="ag-today">Hoje</button>
          <button class="btn btn-outline btn-icon" id="ag-next" title="Próximo dia">${icon('chevR')}</button>
          <input class="input" type="date" id="ag-date" value="${date}" style="width:160px">
        </div></div>
      <div class="card tl-wrap">${rooms.length ? `<div class="tl">
        <div class="tl-head"><div class="tl-room" style="padding:0 14px;justify-content:center"><small>Sala</small></div>
          <div class="tl-hours">${hours.map((m) => `<span style="left:${pct(m)}%">${fromMin(m)}</span>`).join('')}</div></div>
        ${rooms.map((r) => {
          const o = toMin(r.open_time), c = toMin(r.close_time);
          const bs = bookings.filter((b) => b.room_id === r.id);
          return `<div class="tl-row"><div class="tl-room"><b>${esc(r.name)}</b><small>${r.capacity} lugares${r.location ? ' · ' + esc(r.location) : ''}</small></div>
            <div class="tl-track" data-room="${r.id}" data-open="${o}" data-close="${c}">
              ${hours.map((m) => `<span class="gl" style="left:${pct(m)}%"></span>`).join('')}
              ${o > startM ? `<span class="closed" style="left:0;width:${pct(o)}%"></span>` : ''}
              ${c < endM ? `<span class="closed" style="left:${pct(c)}%;right:0"></span>` : ''}
              ${bs.map((b) => {
                const s = toMin(b.local_start), e = toMin(b.local_end);
                return `<div class="tl-bk ${b.status}" data-bk="${b.id}" style="left:${pct(s)}%;width:calc(${pct(e) - pct(s)}% - 2px);background:${r.color}" title="${esc(b.title)} · ${b.local_start}–${b.local_end} · ${esc(b.user_name)}">
                  <b>${esc(b.title)}</b><span>${b.local_start}–${b.local_end} · ${esc(b.user_name.split(' ')[0])}</span></div>`;
              }).join('')}
              ${isToday && nm >= startM && nm <= endM ? `<span class="tl-now" style="left:${pct(nm)}%"></span>` : ''}
            </div></div>`;
        }).join('')}</div>` : `<div class="empty">Nenhuma sala cadastrada.</div>`}</div>
      <div class="legend"><span><i style="background:var(--primary)"></i>Reservado</span><span><i style="background:repeating-linear-gradient(45deg,#D4D4D8,#D4D4D8 3px,#E4E4E7 3px,#E4E4E7 6px)"></i>Sem check-in (liberada)</span><span><i style="background:#F1F1F3"></i>Fora do horário da sala</span><span><i style="background:var(--danger);width:3px"></i>Agora</span></div>`;

    const go = (d) => { state.agendaDate = d; rerender(); };
    $('#ag-prev').onclick = () => go(addDays(date, -1));
    $('#ag-next').onclick = () => go(addDays(date, 1));
    $('#ag-today').onclick = () => go(todayStr());
    $('#ag-date').onchange = (e) => e.target.value && go(e.target.value);

    $$('.tl-track').forEach((t) => (t.onclick = (e) => {
      if (e.target.closest('.tl-bk') || e.target.classList.contains('closed')) return;
      const rect = t.getBoundingClientRect();
      let m = startM + Math.floor((((e.clientX - rect.left) / rect.width) * span) / 30) * 30;
      const o = Number(t.dataset.open), c = Number(t.dataset.close);
      m = Math.max(o, Math.min(m, c - 30));
      if (isToday && m + 30 <= nm) return toast('Horário já passou', 'Escolha um horário futuro.', 'warn');
      if (isToday && m < nm) m = roundUp15(nm);
      bookingForm({ room_id: Number(t.dataset.room), date, start: fromMin(m), end: fromMin(Math.min(m + 60, c)) });
    }));
    $$('[data-bk]').forEach((el) => (el.onclick = () => bookingDetails(bookings.find((b) => String(b.id) === el.dataset.bk))));
  };

  function bookingDetails(b) {
    const owner = b.user_id === state.me.id || isAdmin();
    const future = new Date(b.starts_at) > Date.now() && b.status === 'confirmed';
    const ck = checkinState(b);
    const canCk = ck === 'open' && (owner || b.participants.includes(state.me.email));
    modal({
      title: b.title,
      body: `<div style="display:flex;flex-direction:column;gap:10px">
        <div>${statusChip(b.status)}</div>
        <div class="help" style="font-size:13px;color:var(--text)">${icon('calendar')} ${brDate(b.local_date)} · ${b.local_start}–${b.local_end}</div>
        <div class="help" style="font-size:13px;color:var(--text)">${icon('door')} ${esc(b.room_name)}${b.room_location ? ' · ' + esc(b.room_location) : ''}</div>
        <div class="help" style="font-size:13px;color:var(--text)">${icon('person')} ${esc(b.user_name)} <span class="help">(${esc(b.user_email)})</span></div>
        ${b.participants.length ? `<div>${b.participants.map((p) => `<span class="tag">${esc(p)}</span>`).join('')}</div>` : ''}
        ${b.description ? `<div style="white-space:pre-wrap;background:#FAFAFA;border-radius:6px;padding:10px">${esc(b.description)}</div>` : ''}
        ${b.checkin_at ? `<div class="help">Check-in às ${new Date(b.checkin_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</div>` : ''}
      </div>`,
      foot: `${owner && future ? `<button class="btn btn-ghost btn-danger-text" style="margin-right:auto" data-act="cancel" data-id="${b.id}" data-series="${b.series_id ? 1 : ''}">${icon('trash')} Cancelar reserva</button>
          <button class="btn btn-outline" data-act="edit" data-id="${b.id}">${icon('edit')} Editar</button>` : ''}
        ${canCk ? ckButtons(b) : ''}
        ${!(owner && future) && !canCk ? '<button class="btn btn-outline" data-close>Fechar</button>' : ''}`,
      onMount: (el, close) => { bindBookingActions(el); $$('[data-act]', el).forEach((x) => x.addEventListener('click', close, { capture: true })); },
    });
  }

  // ---------- Minhas reservas ----------
  VIEWS.minhas = async (v) => {
    const tab = state.mineTab || 'upcoming';
    const list = await api(`/bookings/mine?scope=${tab}`);
    v.innerHTML = `
      <div class="page-head"><div><h1>Minhas reservas</h1><p>Reservas que você organiza ou para as quais foi convidado(a). Faça o check-in em até ${state.settings.checkin_tolerance_min} min após o início.</p></div>
        <div class="seg">${[['all', 'Todas'], ['upcoming', 'Próximas'], ['past', 'Passadas']].map(([k, l]) => `<button data-tab="${k}" class="${tab === k ? 'on' : ''}">${l}</button>`).join('')}</div></div>
      <div class="card">${list.length ? list.map(bookingItem).join('') : `<div class="empty">${icon('calendar')}<div>${{ all: 'Você ainda não tem reservas.', upcoming: 'Você não tem reservas futuras.', past: 'Nenhuma reserva passada.' }[tab]}</div></div>`}</div>`;
    $$('[data-tab]', v).forEach((b) => (b.onclick = () => { state.mineTab = b.dataset.tab; rerender(); }));
    bindBookingActions(v);
  };

  // ---------- Admin: Salas ----------
  VIEWS.salas = async (v) => {
    const rooms = await api('/rooms?all=1');
    v.innerHTML = `
      <div class="page-head"><div><h1>Salas</h1><p>${rooms.length} sala(s) cadastrada(s)</p></div><button class="btn btn-primary" id="rm-new">${icon('plus')} Nova sala</button></div>
      <div class="card" style="overflow:auto"><table class="tbl"><thead><tr><th>Sala</th><th>Capacidade</th><th>Horário</th><th>Recursos</th><th>Check-in</th><th>Situação</th><th></th></tr></thead><tbody>
      ${rooms.map((r) => `<tr><td><div style="display:flex;align-items:center;gap:10px"><span style="width:10px;height:10px;border-radius:3px;background:${r.color}"></span><div><b style="font-weight:500">${esc(r.name)}</b><div class="sub">${esc(r.location || '—')}</div></div></div></td>
        <td>${r.capacity}</td><td>${r.open_time.slice(0, 5)}–${r.close_time.slice(0, 5)}</td>
        <td>${r.resources.map((x) => `<span class="tag">${esc(x)}</span>`).join('') || '<span class="sub">—</span>'}</td>
        <td>${r.requires_checkin ? 'Obrigatório' : '<span class="sub">Não exige</span>'}</td>
        <td>${r.active ? '<span class="chip chip-free">Ativa</span>' : '<span class="chip chip-cancelled">Inativa</span>'}</td>
        <td class="actions"><button class="btn btn-ghost btn-sm btn-icon" data-qr="${r.id}" title="QR code de check-in">${icon('qr')}</button><button class="btn btn-ghost btn-sm btn-icon" data-edit="${r.id}" title="Editar">${icon('edit')}</button><button class="btn btn-ghost btn-sm btn-icon" data-del="${r.id}" title="Excluir">${icon('trash')}</button></td></tr>`).join('')
      || `<tr><td colspan="7"><div class="empty">${icon('door')}<div>Nenhuma sala cadastrada ainda.</div></div></td></tr>`}
      </tbody></table></div>`;
    $('#rm-new').onclick = () => roomForm({});
    $$('[data-qr]', v).forEach((b) => (b.onclick = () => roomQr(rooms.find((r) => String(r.id) === b.dataset.qr))));
    $$('[data-edit]', v).forEach((b) => (b.onclick = () => roomForm(rooms.find((r) => String(r.id) === b.dataset.edit))));
    $$('[data-del]', v).forEach((b) => (b.onclick = async () => {
      const r = rooms.find((x) => String(x.id) === b.dataset.del);
      if (!(await confirmDialog({ title: 'Excluir sala', message: `Excluir <b>${esc(r.name)}</b>? O histórico de reservas desta sala também será removido. Para apenas impedir novas reservas, prefira <b>desativar</b> a sala.`, confirmLabel: 'Excluir', danger: true }))) return;
      try { await api(`/rooms/${r.id}`, { method: 'DELETE' }); toast('Sala excluída'); state.rooms = []; rerender(); } catch (e) { fail(e); }
    }));
  };

  function roomQr(r) {
    modal({
      title: `QR code · ${r.name}`, size: 'sm',
      body: `<img class="qr-img" id="qr-img" src="/api/rooms/${r.id}/qr.svg?v=${Date.now()}" alt="QR code de check-in">
        <p class="help" style="text-align:center;margin:0">Imprima e cole na porta da sala. Quem tiver reunião lê o QR com a câmera do celular
          ou pelo botão <b>Check-in QR</b> e o check-in é feito na hora.</p>`,
      foot: `<button class="btn btn-ghost" id="qr-new" title="Invalida o QR atual">Gerar novo QR</button>
        <button class="btn btn-outline" data-close>Fechar</button>
        <a class="btn btn-primary" href="/api/rooms/${r.id}/qr/print" target="_blank" rel="noopener">${icon('printer')} Imprimir</a>`,
      onMount: (el) => {
        $('#qr-new', el).onclick = async () => {
          const ok = await confirmDialog({ title: 'Gerar novo QR code', message: `O QR impresso atual da <b>${esc(r.name)}</b> deixa de funcionar. Use se o QR vazou ou foi fotografado para check-in à distância.`, confirmLabel: 'Gerar novo', danger: true });
          if (!ok) return;
          try { await api(`/rooms/${r.id}/qr/regenerate`, { method: 'POST' }); $('#qr-img', el).src = `/api/rooms/${r.id}/qr.svg?v=${Date.now()}`; toast('Novo QR gerado', 'Imprima novamente e troque o da porta.'); } catch (e) { fail(e); }
        };
      },
    });
  }

  const COLORS = ['#E8620E', '#2563EB', '#16A34A', '#9333EA', '#DB2777', '#0891B2', '#CA8A04', '#475569'];
  function roomForm(r) {
    const editing = Boolean(r.id);
    modal({
      title: editing ? 'Editar sala' : 'Nova sala',
      body: `<div class="grid-2">
          <div class="field"><label>Nome <span class="req">*</span></label><input class="input" id="rf-name" value="${esc(r.name || '')}" maxlength="80"></div>
          <div class="field"><label>Localização</label><input class="input" id="rf-loc" value="${esc(r.location || '')}" placeholder="Ex.: 2º andar, bloco B"></div>
        </div>
        <div class="grid-3">
          <div class="field"><label>Capacidade <span class="req">*</span></label><input class="input" type="number" min="1" id="rf-cap" value="${r.capacity || 6}"></div>
          <div class="field"><label>Abre às</label><input class="input" type="time" step="60" id="rf-open" value="${(r.open_time || '08:00').slice(0, 5)}"></div>
          <div class="field"><label>Fecha às</label><input class="input" type="time" step="60" id="rf-close" value="${(r.close_time || '18:00').slice(0, 5)}"></div>
        </div>
        <div class="field"><label>Recursos</label><input class="input" id="rf-res" value="${esc((r.resources || []).join(', '))}" placeholder="TV, Videoconferência, Quadro branco"><span class="help">Separe por vírgula. Usados no filtro de disponibilidade.</span></div>
        <div class="field"><label>Cor na agenda</label><div style="display:flex;gap:8px" id="rf-colors">${COLORS.map((c) => `<button type="button" data-c="${c}" style="width:26px;height:26px;border-radius:50%;border:2px solid ${c === (r.color || COLORS[0]) ? '#27272A' : 'transparent'};background:${c};cursor:pointer"></button>`).join('')}</div></div>
        <div class="field"><label>E-mail do recurso no Google Workspace</label><input class="input" id="rf-gres" value="${esc(r.google_resource_email || '')}" placeholder="c_xxxx@resource.calendar.google.com"><span class="help">Opcional. Adiciona a sala como recurso no evento do Google Agenda.</span></div>
        <div class="field"><label>Descrição</label><textarea class="input" id="rf-desc">${esc(r.description || '')}</textarea></div>
        <div style="display:flex;gap:24px"><label class="check"><input type="checkbox" id="rf-ck" ${r.requires_checkin !== false ? 'checked' : ''}> Exige check-in</label>
          <label class="check"><input type="checkbox" id="rf-active" ${r.active !== false ? 'checked' : ''}> Sala ativa</label></div>`,
      foot: `<button class="btn btn-outline" data-close>Cancelar</button><button class="btn btn-primary" id="rf-save">Salvar</button>`,
      onMount: (el, close) => {
        let color = r.color || COLORS[0];
        $$('[data-c]', el).forEach((b) => (b.onclick = () => { color = b.dataset.c; $$('[data-c]', el).forEach((x) => (x.style.borderColor = x === b ? '#27272A' : 'transparent')); }));
        $('#rf-save', el).onclick = async () => {
          const body = {
            name: $('#rf-name', el).value, location: $('#rf-loc', el).value, capacity: Number($('#rf-cap', el).value),
            open_time: $('#rf-open', el).value, close_time: $('#rf-close', el).value,
            resources: $('#rf-res', el).value.split(',').map((s) => s.trim()).filter(Boolean), color,
            google_resource_email: $('#rf-gres', el).value.trim(), description: $('#rf-desc', el).value,
            requires_checkin: $('#rf-ck', el).checked, active: $('#rf-active', el).checked,
          };
          try { await api(editing ? `/rooms/${r.id}` : '/rooms', { method: editing ? 'PUT' : 'POST', body }); close(); toast(editing ? 'Sala atualizada' : 'Sala cadastrada'); state.rooms = []; rerender(); } catch (e) { fail(e); }
        };
      },
    });
  }

  // ---------- Admin: Usuários ----------
  VIEWS.usuarios = async (v) => {
    const users = await api('/users');
    state.directory = [];
    v.innerHTML = `
      <div class="page-head"><div><h1>Usuários</h1><p>Cadastre usuários, defina administradores e vincule o gestor que será avisado quando não houver check-in.</p></div>
        <div style="display:flex;gap:8px"><div class="search">${icon('search')}<input class="input" id="us-q" placeholder="Buscar por nome, e-mail ou área"></div><button class="btn btn-primary" id="us-new">${icon('plus')} Novo usuário</button></div></div>
      <div class="bulkbar hidden" id="us-bulk"><b id="us-count"></b><button class="btn btn-primary btn-sm" id="us-batch">${icon('edit')} Alterar em lote</button><button class="btn btn-ghost btn-sm" id="us-clear">Limpar seleção</button></div>
      <div class="card" style="overflow:auto"><table class="tbl"><thead><tr><th style="width:36px"><input type="checkbox" class="cb" id="us-all" title="Selecionar todos"></th><th>Usuário</th><th>Área</th><th>Perfil</th><th>Gestor (notificado no no-show)</th><th>Check-in</th><th>Google</th><th>No-shows</th><th>Situação</th><th></th></tr></thead><tbody id="us-body"></tbody></table></div>`;
    const sel = new Set();
    const syncBulk = (list) => {
      $('#us-bulk').classList.toggle('hidden', !sel.size);
      $('#us-count').textContent = `${sel.size} selecionado(s)`;
      const all = $('#us-all');
      all.checked = list.length > 0 && list.every((u) => sel.has(u.id));
      all.indeterminate = !all.checked && list.some((u) => sel.has(u.id));
    };
    const draw = () => {
      const q = $('#us-q').value.toLowerCase();
      const list = users.filter((u) => !q || [u.name, u.email, u.department].join(' ').toLowerCase().includes(q));
      $('#us-body').innerHTML = list.map((u) => `<tr class="${sel.has(u.id) ? 'sel' : ''}">
        <td><input type="checkbox" class="cb" data-sel="${u.id}" ${sel.has(u.id) ? 'checked' : ''}></td>
        <td><div style="display:flex;gap:10px;align-items:center"><div class="avatar" style="background:${u.role === 'admin' ? 'var(--primary)' : '#2563EB'}">${initials(u.name)}</div><div><b style="font-weight:500">${esc(u.name)}</b><div class="sub">${esc(u.email)}</div></div></div></td>
        <td>${esc(u.department || '—')}</td>
        <td><span class="chip chip-plain chip-${u.role}">${u.role === 'admin' ? 'Administrador' : 'Usuário'}</span></td>
        <td>${u.manager_name ? `${esc(u.manager_name)}<div class="sub">${esc(u.manager_email)}</div>` : '<span class="sub" style="color:var(--warning)">Sem gestor vinculado</span>'}</td>
        <td>${u.checkin_mode === 'qr' ? `<span class="tag">${icon('qr')} Só QR</span>` : '<span class="sub">QR ou botão</span>'}</td>
        <td>${u.google_linked ? '<span class="chip chip-free">Vinculado</span>' : '<span class="sub">—</span>'}</td>
        <td>${u.noshow_count ? `<b style="color:${u.noshow_count >= 3 ? 'var(--danger)' : 'inherit'}">${u.noshow_count}</b>` : '0'}</td>
        <td>${u.active ? '<span class="chip chip-free">Ativo</span>' : '<span class="chip chip-cancelled">Inativo</span>'}</td>
        <td class="actions"><button class="btn btn-ghost btn-sm btn-icon" data-edit="${u.id}" title="Editar">${icon('edit')}</button>${u.id !== state.me.id ? `<button class="btn btn-ghost btn-sm btn-icon" data-del="${u.id}" title="Excluir">${icon('trash')}</button>` : ''}</td></tr>`).join('')
        || '<tr><td colspan="10"><div class="empty">Nenhum usuário encontrado.</div></td></tr>';
      $$('[data-sel]').forEach((c) => (c.onchange = () => { const id = Number(c.dataset.sel); c.checked ? sel.add(id) : sel.delete(id); c.closest('tr').classList.toggle('sel', c.checked); syncBulk(list); }));
      $('#us-all').onchange = (e) => { list.forEach((u) => (e.target.checked ? sel.add(u.id) : sel.delete(u.id))); draw(); };
      syncBulk(list);
      $$('[data-edit]').forEach((b) => (b.onclick = () => userForm(users.find((u) => String(u.id) === b.dataset.edit), users)));
      $$('[data-del]').forEach((b) => (b.onclick = async () => {
        const u = users.find((x) => String(x.id) === b.dataset.del);
        const subs = users.filter((x) => x.manager_id === u.id).length;
        if (!(await confirmDialog({ title: 'Excluir usuário', message: `Excluir <b>${esc(u.name)}</b>? As reservas futuras dele(a) serão canceladas${subs ? ` e ${subs} usuário(s) ficarão sem gestor vinculado` : ''}. Para manter o histórico, prefira <b>inativar</b>.`, confirmLabel: 'Excluir', danger: true }))) return;
        try { await api(`/users/${u.id}`, { method: 'DELETE' }); toast('Usuário excluído'); rerender(); } catch (e) { fail(e); }
      }));
    };
    $('#us-q').oninput = draw;
    $('#us-new').onclick = () => userForm({}, users);
    $('#us-clear').onclick = () => { sel.clear(); draw(); };
    $('#us-batch').onclick = () => batchUserForm(users.filter((u) => sel.has(u.id)), users);
    draw();
  };

  // Alteração em lote: cada campo só é aplicado se "Alterar" estiver marcado
  function batchUserForm(selected, users) {
    const ids = selected.map((u) => u.id);
    const managers = users.filter((x) => x.active && !ids.includes(x.id));
    const deps = [...new Set(users.map((u) => u.department).filter(Boolean))].sort();
    const row = (key, label, control) => `<div class="bfield" data-key="${key}">
        <label class="check"><input type="checkbox" class="bf-on"> ${label}</label><div class="bf-ctl">${control}</div></div>`;
    modal({
      title: `Alterar ${selected.length} usuário(s)`,
      body: `<p class="help" style="margin:0 0 14px">Marque só o que deseja trocar. Os campos não marcados ficam como estão em cada usuário.</p>
        ${row('role', 'Perfil', `<select class="input" disabled><option value="user">Usuário</option><option value="admin">Administrador</option></select>`)}
        ${row('department', 'Área / departamento', `<input class="input" list="bf-deps" disabled placeholder="Deixe vazio para remover a área"><datalist id="bf-deps">${deps.map((d) => `<option value="${esc(d)}">`).join('')}</datalist>`)}
        ${row('manager_id', 'Gestor (chefe)', `<select class="input" disabled><option value="">— Sem gestor —</option>${managers.map((m) => `<option value="${m.id}">${esc(m.name)} · ${esc(m.email)}</option>`).join('')}</select>`)}
        ${row('checkin_mode', 'Forma de check-in', `<select class="input" disabled><option value="both">QR code ou botão</option><option value="qr">Somente QR code</option></select>`)}
        ${row('active', 'Situação', `<select class="input" disabled><option value="true">Ativo</option><option value="false">Inativo</option></select>`)}
        <details class="help" style="margin-top:6px"><summary>Selecionados</summary><div style="margin-top:6px">${selected.map((u) => `<span class="tag">${esc(u.name)}</span>`).join('')}</div></details>`,
      foot: `<button class="btn btn-outline" data-close>Cancelar</button><button class="btn btn-primary" id="bf-save" disabled>Aplicar</button>`,
      onMount: (el, close) => {
        const refresh = () => { $('#bf-save', el).disabled = !$$('.bf-on', el).some((c) => c.checked); };
        $$('.bfield', el).forEach((f) => {
          const on = $('.bf-on', f), ctl = $('.bf-ctl .input', f);
          on.onchange = () => { ctl.disabled = !on.checked; f.classList.toggle('on', on.checked); if (on.checked) ctl.focus(); refresh(); };
        });
        $('#bf-save', el).onclick = async () => {
          const changes = {};
          $$('.bfield', el).forEach((f) => {
            if (!$('.bf-on', f).checked) return;
            const v = $('.bf-ctl .input', f).value;
            changes[f.dataset.key] = f.dataset.key === 'active' ? v === 'true' : f.dataset.key === 'manager_id' ? (v ? Number(v) : null) : v;
          });
          try {
            const r = await api('/users/batch', { method: 'PUT', body: { ids, changes } });
            close(); toast(`${r.updated} usuário(s) atualizado(s)`); rerender();
          } catch (e) { fail(e); }
        };
      },
    });
  }

  function userForm(u, users) {
    const editing = Boolean(u.id);
    const managers = users.filter((x) => x.id !== u.id && x.active);
    modal({
      title: editing ? 'Editar usuário' : 'Novo usuário',
      body: `<div class="grid-2">
          <div class="field"><label>Nome <span class="req">*</span></label><input class="input" id="uf-name" value="${esc(u.name || '')}"></div>
          <div class="field"><label>E-mail <span class="req">*</span></label><input class="input" type="email" id="uf-email" value="${esc(u.email || '')}" placeholder="nome@vrsoft.com.br"></div>
        </div>
        <div class="grid-2">
          <div class="field"><label>Área / departamento</label><input class="input" id="uf-dep" value="${esc(u.department || '')}"></div>
          <div class="field"><label>Perfil</label><select class="input" id="uf-role"><option value="user">Usuário</option><option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Administrador</option></select></div>
        </div>
        <div class="field"><label>Gestor (chefe)</label><select class="input" id="uf-mgr"><option value="">— Sem gestor —</option>${managers.map((m) => `<option value="${m.id}" ${m.id === u.manager_id ? 'selected' : ''}>${esc(m.name)} · ${esc(m.email)}</option>`).join('')}</select>
          <span class="help">O gestor recebe e-mail e notificação no sistema quando este usuário não fizer check-in.</span></div>
        <div class="field"><label>${editing ? 'Redefinir senha' : 'Senha inicial'}</label><input class="input" type="password" id="uf-pw" autocomplete="new-password" placeholder="${editing ? 'Deixe em branco para manter' : 'Mínimo 8 caracteres'}">
          <span class="help">Opcional quando o acesso é feito pelo Google Workspace.</span></div>
        <div class="field"><label>Forma de check-in</label><select class="input" id="uf-ck">
            <option value="both">QR code ou botão</option>
            <option value="qr" ${u.checkin_mode === 'qr' ? 'selected' : ''}>Somente QR code</option></select>
          <span class="help">"Somente QR code" exige ler o QR colado na porta da sala, o que comprova que a pessoa está lá.</span></div>
        <label class="check"><input type="checkbox" id="uf-active" ${u.active !== false ? 'checked' : ''}> Usuário ativo</label>`,
      foot: `<button class="btn btn-outline" data-close>Cancelar</button><button class="btn btn-primary" id="uf-save">Salvar</button>`,
      onMount: (el, close) => {
        $('#uf-save', el).onclick = async () => {
          const body = { name: $('#uf-name', el).value, email: $('#uf-email', el).value, department: $('#uf-dep', el).value,
            role: $('#uf-role', el).value, manager_id: $('#uf-mgr', el).value || null, active: $('#uf-active', el).checked, checkin_mode: $('#uf-ck', el).value };
          if ($('#uf-pw', el).value) body.password = $('#uf-pw', el).value;
          try { await api(editing ? `/users/${u.id}` : '/users', { method: editing ? 'PUT' : 'POST', body }); close(); toast(editing ? 'Usuário atualizado' : 'Usuário cadastrado'); rerender(); } catch (e) { fail(e); }
        };
      },
    });
  }

  // ---------- Admin: Relatórios ----------
  VIEWS.relatorios = async (v) => {
    const days = state.repDays || 30;
    const [ns, stats, auditLog] = await Promise.all([api(`/admin/reports/noshow?days=${days}`), api(`/admin/stats?days=${days}`), api('/admin/audit')]);
    const maxH = Math.max(1, ...stats.byRoom.map((r) => r.hours));
    const ACT = { login: 'Login', create: 'Criou', update: 'Alterou', delete: 'Excluiu', cancel: 'Cancelou', checkin: 'Check-in', finish: 'Encerrou', google_link: 'Vinculou Google —' };
    const ENT = { user: 'usuário', room: 'sala', booking: 'reserva', settings: 'configurações' };
    v.innerHTML = `
      <div class="page-head"><div><h1>Relatórios</h1><p>Uso das salas e reservas sem check-in.</p></div>
        <div class="seg">${[7, 30, 90].map((d) => `<button data-d="${d}" class="${d === days ? 'on' : ''}">${d} dias</button>`).join('')}</div></div>
      <div class="kpis">
        <div class="card kpi"><div class="lbl">Taxa de no-show</div><div class="val">${stats.noshowRate}%</div></div>
        <div class="card kpi"><div class="lbl">Reservas sem check-in</div><div class="val">${stats.noshows}</div></div>
        <div class="card kpi"><div class="lbl">Cancelamentos</div><div class="val">${stats.cancelled}</div></div>
        <div class="card kpi"><div class="lbl">Horas reservadas</div><div class="val">${stats.byRoom.reduce((a, r) => a + r.hours, 0).toFixed(1).replace('.', ',')}</div></div>
      </div>
      <div class="cols">
        <div class="card"><div class="card-head"><h3>Usuários com no-show</h3></div>
          <div style="overflow:auto"><table class="tbl"><thead><tr><th>Usuário</th><th>Gestor</th><th>No-shows</th><th>Check-ins</th><th>Último</th></tr></thead><tbody>
          ${ns.map((r) => `<tr><td><b style="font-weight:500">${esc(r.name)}</b><div class="sub">${esc(r.department || r.email)}</div></td><td>${esc(r.manager_name || '—')}</td>
            <td><b style="color:var(--danger)">${r.noshows}</b></td><td>${r.checkins}</td><td class="sub">${new Date(r.last_noshow).toLocaleDateString('pt-BR')}</td></tr>`).join('')
            || '<tr><td colspan="5"><div class="empty">Nenhum no-show no período.</div></td></tr>'}
          </tbody></table></div></div>
        <div class="card"><div class="card-head"><h3>Horas reservadas por sala</h3></div>
          <div class="bars">${stats.byRoom.map((r) => `<div class="bar-row"><span>${esc(r.name)}</span><div class="track"><div class="fill" style="width:${(r.hours / maxH) * 100}%;--c:${r.color}"></div></div><span class="v">${String(r.hours).replace('.', ',')} h</span></div>`).join('') || '<div class="empty">Sem dados.</div>'}</div></div>
      </div>
      <div class="card" style="margin-top:18px"><div class="card-head"><h3>Log de auditoria</h3><span class="help">Últimos 200 eventos</span></div>
        <div style="max-height:360px;overflow:auto"><table class="tbl"><thead><tr><th>Quando</th><th>Quem</th><th>Ação</th></tr></thead><tbody>
        ${auditLog.map((a) => `<tr><td class="sub">${new Date(a.created_at).toLocaleString('pt-BR')}</td><td>${esc(a.user_name || 'Sistema')}</td><td>${ACT[a.action] || a.action} ${ENT[a.entity] || a.entity}${a.entity_id ? ' #' + a.entity_id : ''}</td></tr>`).join('')}
        </tbody></table></div></div>`;
    $$('[data-d]', v).forEach((b) => (b.onclick = () => { state.repDays = Number(b.dataset.d); rerender(); }));
  };

  // ---------- Admin: Configurações ----------
  VIEWS.configuracoes = async (v) => {
    const s = await api('/admin/settings');
    const cfg = await api('/auth/config');
    const F = (k, label, help, unit = 'min') => `<div class="field"><label>${label}</label><div style="display:flex;align-items:center;gap:8px"><input class="input" type="number" min="0" id="st-${k}" value="${s[k]}" style="width:120px"><span class="help">${unit}</span></div><span class="help">${help}</span></div>`;
    v.innerHTML = `
      <div class="page-head"><div><h1>Configurações</h1><p>Regras gerais de reserva e check-in.</p></div></div>
      <div class="cols">
        <div class="card"><div class="card-head"><h3>Regras de check-in</h3></div><div class="card-pad">
          ${F('checkin_open_before_min', 'Check-in liberado antes do início', 'Quantos minutos antes do início o botão de check-in fica disponível.')}
          ${F('checkin_tolerance_min', 'Tolerância após o início', 'Sem check-in após este prazo, a reserva vira no-show, a sala é liberada e o gestor é notificado.')}
          ${F('reminder_before_min', 'Lembrete ao organizador', 'Envia lembrete de check-in este tempo antes do início.')}
          <div class="help" style="margin-top:-4px">A forma de check-in (QR code ou botão, ou somente QR code) é definida em cada usuário, em <a href="#/usuarios">Usuários</a>.</div>
        </div></div>
        <div class="card"><div class="card-head"><h3>Limites de reserva</h3></div><div class="card-pad">
          ${F('max_duration_min', 'Duração máxima por reserva', 'Evita que uma sala fique bloqueada o dia todo.')}
          ${F('max_advance_days', 'Antecedência máxima', 'Até quantos dias no futuro é possível reservar.', 'dias')}
          <div class="field"><label>Integração Google Workspace</label>
            <div>${cfg.googleEnabled ? `<span class="chip chip-free">Configurada</span> <span class="help">Domínio: ${esc(cfg.domain || 'qualquer')}</span>` : '<span class="chip chip-no_show">Não configurada</span> <span class="help">Defina GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET no .env</span>'}</div></div>
        </div></div>
      </div>
      <div style="margin-top:16px;display:flex;justify-content:flex-end"><button class="btn btn-primary" id="st-save">Salvar configurações</button></div>`;
    $('#st-save').onclick = async () => {
      const body = {};
      Object.keys(s).forEach((k) => { const i = $('#st-' + k); if (i) body[k] = i.type === 'checkbox' ? i.checked : Number(i.value); });
      try { state.settings = await api('/admin/settings', { method: 'PUT', body }); toast('Configurações salvas'); } catch (e) { fail(e); }
    };
  };

  // ---------- Boot ----------
  (async () => {
    try {
      [state.me, state.settings] = await Promise.all([api('/auth/me'), api('/admin/settings')]);
    } catch { return; }
    renderShell();
    route();
    refreshBell();
    setInterval(refreshBell, 30000);
    // Atualiza a tela de início/agenda a cada minuto (status das salas, linha do "agora")
    setInterval(() => { if (!$('.overlay') && /^#\/?(inicio|agenda|minhas)?$/.test(location.hash || '#/')) route(); }, 60000);
  })();
})();
