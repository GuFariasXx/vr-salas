(() => {
  const $ = (s) => document.querySelector(s);
  document.querySelectorAll('[data-icon]').forEach((el) => el.insertAdjacentHTML('afterbegin', icon(el.dataset.icon)));
  $('#toggle-pw').innerHTML = icon('eyeOff');
  $('#toggle-pw').onclick = () => {
    const p = $('#password'); const show = p.type === 'password';
    p.type = show ? 'text' : 'password';
    $('#toggle-pw').innerHTML = icon(show ? 'eye' : 'eyeOff');
  };
  $('#btn-google').innerHTML = GOOGLE_SVG + ' Entrar com Google';

  const alertBox = (id, msg, type = 'error') => { $(id).innerHTML = msg ? `<div class="alert alert-${type}">${msg}</div>` : ''; };
  const show = (id) => ['#f-login', '#f-forgot', '#f-reset'].forEach((f) => $(f).classList.toggle('hidden', f !== id));

  const post = async (url, body) => {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'Erro inesperado');
    return data;
  };

  // Já existe sessão neste navegador? Mostra quem é, em vez de entrar direto
  fetch('/api/auth/me').then((r) => (r.ok ? r.json() : null)).then((me) => {
    if (!me || new URLSearchParams(location.search).get('reset')) return;
    const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    $('#login-alert').innerHTML = `<div class="alert alert-ok" style="display:flex;flex-direction:column;gap:8px">
      <span>Este navegador já está conectado como <b>${esc(me.name)}</b> (${esc(me.email)}).</span>
      <span style="display:flex;gap:8px"><a class="btn btn-primary btn-sm" href="${next}">Continuar</a>
      <button type="button" class="btn btn-outline btn-sm" id="switch-user">Entrar com outro usuário</button></span></div>`;
    $('#switch-user').onclick = async () => {
      await fetch('/api/auth/logout', { method: 'POST' });
      $('#login-alert').innerHTML = '';
      $('#email').value = ''; $('#password').value = ''; $('#email').focus();
    };
  });
  fetch('/api/auth/config').then((r) => r.json()).then((c) => { if (c.googleEnabled) $('#google-area').classList.remove('hidden'); });

  try { const saved = localStorage.getItem('vrsalas_user'); if (saved) $('#email').value = saved; } catch {}

  const qs = new URLSearchParams(location.search);
  const rawNext = qs.get('next') || '';
  const next = /^\/(app|checkin)([?#/].*)?$/.test(rawNext) ? rawNext : '/app';
  if (next !== '/app') $('#btn-google').href = '/api/auth/google?next=' + encodeURIComponent(next);
  if (qs.get('error')) alertBox('#login-alert', qs.get('error'));
  if (qs.get('reset')) show('#f-reset');

  const setErr = (id, on) => {
    $('#' + id).classList.toggle('invalid', on);
    document.querySelector(`[data-for="${id}"]`).classList.toggle('hidden', !on);
  };

  $('#f-login').onsubmit = async (e) => {
    e.preventDefault();
    const email = $('#email').value.trim(), password = $('#password').value;
    setErr('email', !email); setErr('password', !password);
    if (!email || !password) return;
    const btn = $('#btn-login'); btn.disabled = true; btn.textContent = 'Entrando...';
    try {
      await post('/api/auth/login', { email, password });
      try { $('#remember').checked ? localStorage.setItem('vrsalas_user', email) : localStorage.removeItem('vrsalas_user'); } catch {}
      location.href = next;
    } catch (err) {
      alertBox('#login-alert', err.message);
      btn.disabled = false; btn.textContent = 'Entrar';
    }
  };
  ['email', 'password'].forEach((id) => $('#' + id).addEventListener('input', () => setErr(id, false)));

  $('#go-forgot').onclick = (e) => { e.preventDefault(); $('#f-email').value = $('#email').value; show('#f-forgot'); };
  document.querySelectorAll('.go-login').forEach((a) => (a.onclick = (e) => { e.preventDefault(); history.replaceState(null, '', '/'); show('#f-login'); }));

  $('#f-forgot').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await post('/api/auth/forgot', { email: $('#f-email').value });
      alertBox('#forgot-alert', 'Se o e-mail estiver cadastrado, você receberá um link em instantes.', 'ok');
    } catch (err) { alertBox('#forgot-alert', err.message); }
  };

  $('#f-reset').onsubmit = async (e) => {
    e.preventDefault();
    if ($('#r-pw').value !== $('#r-pw2').value) return alertBox('#reset-alert', 'As senhas não conferem');
    try {
      await post('/api/auth/reset', { token: qs.get('reset'), password: $('#r-pw').value });
      history.replaceState(null, '', '/');
      show('#f-login');
      alertBox('#login-alert', 'Senha alterada. Faça login com a nova senha.', 'ok');
    } catch (err) { alertBox('#reset-alert', err.message); }
  };
})();
