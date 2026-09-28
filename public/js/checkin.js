(() => {
  const box = document.getElementById('ck');
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  let token = new URLSearchParams(location.search).get('t');

  async function api(method, body) {
    const r = await fetch('/api/checkin/' + encodeURIComponent(token), {
      method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 401) {
      const d = await r.clone().json().catch(() => ({}));
      location.href = '/?next=' + encodeURIComponent(location.pathname + location.search) + (d.code === 'replaced' ? '&error=' + encodeURIComponent(d.error) : '');
      throw new Error('login');
    }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(data.error || 'Erro inesperado'), { status: r.status });
    return data;
  }

  const view = (state, title, text, extra = '') => {
    const ic = { ok: 'checkCircle', warn: 'clock', err: 'alert', info: 'door' }[state];
    box.innerHTML = `<div class="ck-state ck-${state}">${icon(ic)}</div><h1>${title}</h1>${text ? `<p>${text}</p>` : ''}${extra}`;
  };

  function success(b, room, already) {
    view('ok', already ? 'Check-in já realizado' : 'Check-in confirmado',
      `<b>${esc(b.title)}</b><br>${esc(room.name)} · ${b.local_start}–${b.local_end}`,
      '<p class="help">Boa reunião! Você já pode fechar esta página.</p>');
  }

  async function doCheckin(bookingId) {
    view('info', 'Confirmando...', '');
    try {
      const r = await api('POST', bookingId ? { booking_id: bookingId } : {});
      success(r.booking, r.room, r.already);
    } catch (e) { if (e.message !== 'login') view('err', 'Não foi possível fazer o check-in', esc(e.message), retryBtn()); }
  }
  const retryBtn = () => '<button class="btn btn-outline btn-block" id="ck-retry">Tentar novamente</button>';
  box.addEventListener('click', (e) => { if (e.target.closest('#ck-retry')) location.reload(); });

  async function load() {
    if (!token) return scanner();
    view('info', 'Carregando...', '');
    let data;
    try { data = await api('GET'); } catch (e) {
      if (e.message !== 'login') view('err', 'QR code inválido', esc(e.message), '<button class="btn btn-primary btn-block" id="scan-again">Ler outro QR</button>');
      const again = document.getElementById('scan-again'); if (again) again.onclick = () => { token = null; scanner(); };
      return;
    }
    const { room, bookings } = data;
    const done = bookings.find((b) => b.status === 'checked_in' && new Date(b.starts_at) <= Date.now() + data.settings.open_before * 60000);
    const open = bookings.filter((b) => b.status === 'confirmed' && b.in_window);
    if (open.length === 1) return doCheckin(open[0].id);
    if (open.length > 1) {
      view('info', esc(room.name), 'Escolha a reunião para confirmar a presença:',
        open.map((b) => `<button class="btn btn-primary btn-block ck-opt" data-id="${b.id}">${b.local_start}–${b.local_end} · ${esc(b.title)}</button>`).join(''));
      box.querySelectorAll('[data-id]').forEach((el) => (el.onclick = () => doCheckin(Number(el.dataset.id))));
      return;
    }
    if (done) return success(done, room, true);
    const next = bookings.find((b) => b.status === 'confirmed');
    if (next) return view('warn', 'Ainda não é hora', `O check-in de <b>${esc(next.title)}</b> (${next.local_start}) abre às <b>${next.opens_at}</b>.`, retryBtn());
    view('info', esc(room.name), 'Você não tem reunião agora nesta sala.',
      '<a class="btn btn-primary btn-block" href="/app#/disponibilidade">Reservar uma sala</a>');
  }

  async function scanner() {
    box.innerHTML = `<h1>Check-in por QR</h1><p>Aponte a câmera para o QR code colado na porta da sala.</p>
      <div class="ck-video"><video id="ck-video" muted></video><span class="ck-frame"></span></div><p class="help" id="ck-msg"></p>`;
    try {
      await QRScan.start(document.getElementById('ck-video'), (text) => {
        const t = QRScan.tokenFrom(text);
        if (!t) { document.getElementById('ck-msg').textContent = 'Este QR não é de uma sala do VR Salas.'; return setTimeout(scanner, 1500); }
        token = t; history.replaceState(null, '', '/checkin?t=' + t); load();
      });
    } catch (e) {
      box.querySelector('.ck-video').remove();
      document.getElementById('ck-msg').textContent = QRScan.cameraError(e);
    }
  }

  load();
})();
