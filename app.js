// ══════════════════════════════════════════════════════
// SUPABASE CLIENT
// ══════════════════════════════════════════════════════
const _sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage: window.localStorage,
    storageKey: 'rwdent-auth',
    flowType: 'implicit',
    detectSessionInUrl: true,
    persistSession: true,
    autoRefreshToken: true
  }
});

// ══════════════════════════════════════════════════════
// STATE
// ══════════════════════════════════════════════════════
let agendamentos = [];
let profissionais = [];
let pacientes = [];
let selectedPatientId = null;
let editingPatientId = null;
let currentUser = null;
let clinicaId = null;       // ID da clínica do usuário logado (multi-tenant)
let clinicaData = null;     // Dados completos da clínica
let _isRhaizaClinic = false; // Recursos exclusivos da clínica Rhaiza
const _ADMIN_IDS = ['09f21b22-76c8-4aee-8af4-9fc292ff08d4','b39d8b67-0610-4708-9733-104db7f0307b'];

// Calendário state
const CAL_START_HOUR = 7, CAL_END_HOUR = 19;
const CAL_START_MIN = CAL_START_HOUR * 60, CAL_END_MIN = CAL_END_HOUR * 60;
const CAL_SLOT_PX = 48;
let calView = 'semana';
let calRef = new Date();
const DAYS_PT = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];
const MONTHS_PT = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];

// ══════════════════════════════════════════════════════
// UI HELPERS
// ══════════════════════════════════════════════════════
function showLoading(v){ document.getElementById('loading').style.display = v ? 'flex' : 'none'; }
function showToast(msg, type='success'){
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = `toast show ${type}`;
  setTimeout(()=>{ t.className='toast'; }, 3800);
}
function escapeHtml(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }

// ── MÁSCARAS DE INPUT ──
function maskTel(el){
  let v=el.value.replace(/\D/g,'').slice(0,11);
  if(v.length>6) v=v.replace(/^(\d{2})(\d{5})(\d{0,4}).*/,'($1) $2-$3');
  else if(v.length>2) v=v.replace(/^(\d{2})(\d{0,5}).*/,'($1) $2');
  else if(v.length) v='('+v;
  el.value=v;
}
function maskCPF(el){
  let v=el.value.replace(/\D/g,'').slice(0,11);
  if(v.length>9) v=v.replace(/^(\d{3})(\d{3})(\d{3})(\d{0,2}).*/,'$1.$2.$3-$4');
  else if(v.length>6) v=v.replace(/^(\d{3})(\d{3})(\d{0,3}).*/,'$1.$2.$3');
  else if(v.length>3) v=v.replace(/^(\d{3})(\d{0,3}).*/,'$1.$2');
  el.value=v;
}
function validarCPF(cpf){
  cpf=cpf.replace(/\D/g,'');
  if(cpf.length!==11||/^(\d)\1{10}$/.test(cpf)) return false;
  let soma=0;
  for(let i=0;i<9;i++) soma+=parseInt(cpf[i])*(10-i);
  let resto=11-(soma%11); if(resto>=10) resto=0;
  if(parseInt(cpf[9])!==resto) return false;
  soma=0;
  for(let i=0;i<10;i++) soma+=parseInt(cpf[i])*(11-i);
  resto=11-(soma%11); if(resto>=10) resto=0;
  return parseInt(cpf[10])===resto;
}
function toLocalISO(d){ return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
function hoje(){ return toLocalISO(new Date()); }
function formatDate(v){ if(!v)return''; const [y,m,d]=v.split('-'); return`${d}/${m}/${y}`; }
function initials(text){ return String(text||'').split(' ').filter(Boolean).slice(0,2).map(w=>w[0].toUpperCase()).join(''); }
function hashColor(text){
  let h=0; for(let i=0;i<text.length;i++) h=text.charCodeAt(i)+((h<<5)-h);
  const c=(h&0x00FFFFFF).toString(16).toUpperCase();
  return'00000'.substring(0,6-c.length)+c;
}
function homeAvatar(nome){
  return `<div class="home-row-avatar" style="background:#${hashColor(nome||'?')}">${initials(nome)}</div>`;
}

// ══════════════════════════════════════════════════════
// AUTH
// ══════════════════════════════════════════════════════
async function doLogin(){
  const email = document.getElementById('login-email').value.trim();
  const pass  = document.getElementById('login-pass').value;
  const errEl = document.getElementById('login-err');
  const btn   = document.getElementById('btn-login');
  errEl.className='login-err'; errEl.textContent='';
  if(!email||!pass){ errEl.textContent='Preencha e-mail e senha.'; errEl.className='login-err show'; return; }
  btn.disabled=true; document.getElementById('btn-login-text').textContent='Entrando...';
  const { data, error } = await _sb.auth.signInWithPassword({ email, password: pass });
  btn.disabled=false; document.getElementById('btn-login-text').textContent='Entrar';
  if(error){ errEl.textContent=error.message==='Invalid login credentials'?'E-mail ou senha inválidos.':error.message; errEl.className='login-err show'; return; }
  currentUser = data.user;
  // Multi-tenant: verifica aprovação e carrega clinicaId
  const ok = await checkClinicaApproval();
  if(!ok) return;
  await loadAll();
  document.getElementById('login-screen').style.display='none';
  document.getElementById('app').style.display='block';
  _sessionStartTimer();
  window.aiOnLogin?.();
}

async function checkClinicaApproval(){
  const errEl = document.getElementById('login-err');
  const { data: cli } = await _sb
    .from('clinicas')
    .select('*')
    .eq('user_id', currentUser.id)
    .single();
  if(!cli){
    await _sb.auth.signOut(); currentUser=null;
    window.location.replace('index.html?msg=sem_clinica');
    return false;
  }
  if(cli.status !== 'aprovado'){
    await _sb.auth.signOut(); currentUser=null;
    window.location.replace('index.html?msg=pendente');
    return false;
  }
  clinicaId   = cli.id;
  clinicaData = cli;
  // Atualiza nome da clínica na interface
  const el = document.getElementById('header-clinica');
  if(el) el.textContent = cli.nome_cli || 'Minha Clínica';
  // Recursos exclusivos da Rhaiza: alinhadores e aparelhos
  const _isMainClinic = cli.user_id === 'b39d8b67-0610-4708-9733-104db7f0307b';
  _isRhaizaClinic = _isMainClinic;
  document.querySelectorAll('[data-tab="invisalign_apresentacao"], [onclick*="invisalign"], .rhaiza-only').forEach(b=>{
    b.style.display = _isMainClinic ? '' : 'none';
  });
  // Admin panel — apenas para o administrador
  const _isAdmin = _ADMIN_IDS.includes(cli.user_id);
  document.querySelectorAll('.admin-only').forEach(b=>{
    b.style.display = _isAdmin ? '' : 'none';
  });
  return true;
}

// ══════════════════════════════════════════════════════
// ADMIN PANEL
// ══════════════════════════════════════════════════════
let _adminClinics = [];
let _adminFilterStatus = 'todos';

async function loadAdminPanel(){
  if(!_ADMIN_IDS.includes(currentUser?.id)) return;
  const { data: isDbAdmin } = await _sb.rpc('rwdent_is_admin');
  if(!isDbAdmin){ showToast('Acesso admin negado pelo servidor.','error'); return; }
  showLoading(true);
  const { data, error } = await _sb.from('clinicas').select('*').order('created_at',{ascending:false});
  showLoading(false);
  if(error){ showToast('Erro ao carregar contas: '+error.message,'error'); return; }
  _adminClinics = data || [];
  renderAdminStats();
  renderAdminTable();
}

function renderAdminStats(){
  const el = document.getElementById('admin-stats');
  const pending = _adminClinics.filter(c=>c.status==='pendente').length;
  const approved = _adminClinics.filter(c=>c.status==='aprovado' && (!c.expira_em || new Date(c.expira_em)>new Date())).length;
  const expired = _adminClinics.filter(c=>c.status==='aprovado' && c.expira_em && new Date(c.expira_em)<=new Date()).length;
  const rejected = _adminClinics.filter(c=>c.status==='rejeitado').length;
  el.innerHTML = `
    <div class="admin-stat-card pending"><div class="stat-num">${pending}</div><div class="stat-label">Pendentes</div></div>
    <div class="admin-stat-card active"><div class="stat-num">${approved}</div><div class="stat-label">Ativos</div></div>
    <div class="admin-stat-card expired"><div class="stat-num">${expired}</div><div class="stat-label">Expirados</div></div>
    <div class="admin-stat-card"><div class="stat-num">${rejected}</div><div class="stat-label">Rejeitados</div></div>
  `;
}

function adminFilter(status){
  _adminFilterStatus = status;
  document.querySelectorAll('.admin-filter-btn').forEach(b=>{
    b.classList.toggle('active', b.textContent.toLowerCase().includes(status==='todos'?'todos':status));
  });
  renderAdminTable();
}

function renderAdminTable(){
  const wrap = document.getElementById('admin-table-wrap');
  let list = _adminClinics;
  if(_adminFilterStatus==='pendente') list = list.filter(c=>c.status==='pendente');
  else if(_adminFilterStatus==='aprovado') list = list.filter(c=>c.status==='aprovado');
  else if(_adminFilterStatus==='rejeitado') list = list.filter(c=>c.status==='rejeitado');

  if(list.length===0){
    wrap.innerHTML = '<div class="admin-empty"><i class="ti ti-inbox"></i>Nenhuma conta encontrada.</div>';
    return;
  }
  let html = `<table class="admin-table">
    <thead><tr><th>Clínica</th><th>Responsável</th><th>E-mail</th><th>Status</th><th>Expira em</th><th>Ações</th></tr></thead><tbody>`;
  list.forEach(c=>{
    const isExpired = c.expira_em && new Date(c.expira_em) <= new Date();
    let badge = '';
    if(c.status==='pendente') badge='<span class="admin-badge pendente"><i class="ti ti-clock"></i> Pendente</span>';
    else if(c.status==='aprovado' && isExpired) badge='<span class="admin-badge expirado"><i class="ti ti-clock-off"></i> Expirado</span>';
    else if(c.status==='aprovado') badge='<span class="admin-badge aprovado"><i class="ti ti-check"></i> Aprovado</span>';
    else badge='<span class="admin-badge rejeitado"><i class="ti ti-x"></i> Rejeitado</span>';

    let expiraStr = '-';
    if(c.expira_em){
      const d = new Date(c.expira_em);
      expiraStr = d.toLocaleDateString('pt-BR')+' '+d.toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});
      if(isExpired) expiraStr = '<span style="color:#c0392b;">'+expiraStr+'</span>';
    }

    let actions = '';
    if(c.status==='pendente'){
      actions = `<button class="admin-btn aprovar" onclick="adminAprovar('${c.id}')"><i class="ti ti-check"></i> Aprovar 24h</button>
        <button class="admin-btn rejeitar" onclick="adminRejeitar('${c.id}')"><i class="ti ti-x"></i></button>`;
    } else if(c.status==='aprovado' && isExpired){
      actions = `<button class="admin-btn renovar" onclick="adminRenovar('${c.id}')"><i class="ti ti-refresh"></i> Renovar 24h</button>`;
    } else if(c.status==='aprovado'){
      actions = `<button class="admin-btn rejeitar" onclick="adminRejeitar('${c.id}')"><i class="ti ti-x"></i> Revogar</button>`;
    } else {
      actions = `<button class="admin-btn aprovar" onclick="adminAprovar('${c.id}')"><i class="ti ti-check"></i> Aprovar</button>`;
    }
    // Assinatura mensal via Mercado Pago — gera o link, a aprovação depois
    // acontece sozinha quando o pagamento cair (api/mercadopago-webhook.js).
    actions += ` <button class="admin-btn" style="background:#e8f5e9;color:#2e7d32;border-color:#a5d6a7;" onclick="adminGerarAssinatura('${c.id}')" title="Gera o link de assinatura mensal (R$197) pra mandar no WhatsApp"><i class="ti ti-credit-card"></i> Assinatura</button>`;

    // Don't show action buttons for admin's own clinics
    if(_ADMIN_IDS.includes(c.user_id)) actions = '<span style="color:var(--rose-text);font-size:11px;">Admin</span>';

    html += `<tr>
      <td style="font-weight:600;">${c.nome_cli||'-'}</td>
      <td>${c.nome_resp||'-'}</td>
      <td>${c.email||'-'}</td>
      <td>${badge}</td>
      <td>${expiraStr}</td>
      <td>${actions}</td>
    </tr>`;
  });
  html += '</tbody></table>';
  wrap.innerHTML = html;
}

async function adminAprovar(id){
  const expira = new Date(Date.now() + 24*60*60*1000).toISOString();
  const { error } = await _sb.from('clinicas').update({status:'aprovado', expira_em: expira}).eq('id', id);
  if(error){ showToast('Erro: '+error.message,'error'); return; }
  showToast('Conta aprovada! Acesso de 24h ativado.','ok');
  loadAdminPanel();
}

async function adminGerarAssinatura(clinicaId){
  showLoading(true);
  try{
    const { data:{ session } } = await _sb.auth.getSession();
    const resp = await fetch('/api/mercadopago-criar-assinatura', {
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'Authorization':'Bearer '+(session?.access_token||'') },
      body: JSON.stringify({ clinicaId })
    });
    const json = await resp.json();
    showLoading(false);
    if(!resp.ok){ showToast('Erro: '+(json.error||'falha ao gerar assinatura'),'error'); return; }
    navigator.clipboard?.writeText(json.link).catch(()=>{});
    // Aprovação real acontece sozinha quando o Mercado Pago confirmar o
    // pagamento (webhook) — este link só inicia a autorização da assinatura.
    prompt('Link da assinatura mensal (já copiado — Ctrl+C se precisar de novo). Manda pro cliente no WhatsApp. A clínica é aprovada sozinha assim que ele autorizar o pagamento:', json.link);
    showToast('Link gerado e copiado!');
  } catch(e){
    showLoading(false);
    showToast('Erro ao gerar assinatura: '+e.message,'error');
  }
}

async function adminRejeitar(id){
  if(!confirm('Tem certeza que deseja rejeitar/revogar esta conta?')) return;
  const { error } = await _sb.from('clinicas').update({status:'rejeitado', expira_em: null}).eq('id', id);
  if(error){ showToast('Erro: '+error.message,'error'); return; }
  showToast('Conta rejeitada.','warn');
  loadAdminPanel();
}

async function adminRenovar(id){
  const expira = new Date(Date.now() + 24*60*60*1000).toISOString();
  const { error } = await _sb.from('clinicas').update({expira_em: expira}).eq('id', id);
  if(error){ showToast('Erro: '+error.message,'error'); return; }
  showToast('Acesso renovado por mais 24h!','ok');
  loadAdminPanel();
}

async function redefinirSenhaDemo(){
  if(!_ADMIN_IDS.includes(currentUser?.id)) return;
  if(!confirm('Gerar uma senha nova para demo@rwdent.app? A senha atual deixa de funcionar.')) return;
  const resultEl = document.getElementById('demo-pass-result');
  showLoading(true);
  try{
    const { data: { session } } = await _sb.auth.getSession();
    const resp = await fetch('/api/admin-reset-demo-password', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + (session?.access_token || '') }
    });
    const json = await resp.json();
    showLoading(false);
    if(!resp.ok){ showToast('Erro: ' + (json.error || 'falha ao trocar senha'), 'error'); return; }
    resultEl.innerHTML = `<div style="background:var(--rose-lighter);border:1px solid var(--rose-light);border-radius:10px;padding:12px 14px;font-size:13px;">
      <div>E-mail: <strong>${json.email}</strong></div>
      <div style="margin-top:4px;">Senha nova: <strong style="font-family:monospace;font-size:14px;">${json.password}</strong>
        <button class="btn-secondary" style="padding:4px 10px;font-size:11px;margin-left:8px;" onclick="navigator.clipboard.writeText('${json.password}');showToast('Copiado!')"><i class="ti ti-copy"></i> Copiar</button>
      </div>
      <div style="font-size:11px;color:var(--rose-text);margin-top:6px;">Anote agora — essa senha não fica salva em lugar nenhum do painel.</div>
    </div>`;
    showToast('Senha da conta demo redefinida!','ok');
  }catch(e){
    showLoading(false);
    showToast('Erro: ' + e.message, 'error');
  }
}

async function esqueciSenha(){
  const email = document.getElementById('login-email').value.trim();
  const errEl = document.getElementById('login-err');
  if(!email){ errEl.textContent='Digite seu e-mail primeiro.'; errEl.className='login-err show'; return; }
  errEl.className='login-err'; errEl.textContent='';
  try {
    const { error } = await _sb.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin + '/app.html' });
    if(error){ errEl.textContent=error.message; errEl.className='login-err show'; return; }
    errEl.textContent='E-mail de recuperacao enviado! Verifique sua caixa de entrada.';
    errEl.style.background='#edf7ee'; errEl.style.color='#2e6b32'; errEl.style.borderColor='#a5d6a7';
    errEl.className='login-err show';
  } catch(e){ errEl.textContent='Erro: '+e.message; errEl.className='login-err show'; }
}

// Enter key on login
document.addEventListener('keydown', e=>{ if(e.key==='Enter'&&document.getElementById('login-screen').style.display!=='none') doLogin(); });

async function doLogout(){
  _sessionResetTimer();
  try {
    if(_financeiroCarregado) { const _e=await saveFinanceiro(); if(!_e) showToast('Dados salvos!'); }
  } catch(e){ console.error('Erro ao salvar:', e); }
  await _sb.auth.signOut();
  localStorage.removeItem('rwdent-demo');
  window.aiOnLogout?.();
  // Volta pra tela de login nova (index.html) em vez de reexibir o
  // #login-screen antigo daqui, que ficou desatualizado visualmente.
  window.location.replace('index.html');
}

// Timeout de inatividade — desloga após 30 min sem interação
let _sessionTimer = null;
const SESSION_TIMEOUT = 30*60*1000;
function _sessionResetTimer(){
  if(_sessionTimer) clearTimeout(_sessionTimer);
  _sessionTimer = null;
}
function _sessionStartTimer(){
  _sessionResetTimer();
  _sessionTimer = setTimeout(()=>{
    if(currentUser){ showToast('Sessão expirada por inatividade.','warn'); doLogout(); }
  }, SESSION_TIMEOUT);
}
['click','keydown','touchstart','scroll'].forEach(ev=>
  document.addEventListener(ev, ()=>{ if(currentUser) _sessionStartTimer(); }, {passive:true})
);

// Check existing session on load
(async()=>{
  try {
    const { data:{ session } } = await _sb.auth.getSession();
    if(session){
      currentUser=session.user;
      const ok = await checkClinicaApproval();
      if(ok){
        // Verifica expiração da conta (trial 24h)
        if(clinicaData.expira_em){
          const expiraEm = new Date(clinicaData.expira_em);
          if(Date.now() > expiraEm.getTime()){
            await _sb.auth.signOut();
            window.location.replace('index.html?msg=demo_expirado');
            return;
          }
          document.body.classList.add('demo-mode');
          const banner=document.getElementById('demo-banner');
          const restante=expiraEm.getTime()-Date.now();
          const horas=Math.floor(restante/3600000);
          const mins=Math.floor((restante%3600000)/60000);
          banner.innerHTML='<i class="ti ti-info-circle"></i> Acesso expira em '+horas+'h'+String(mins).padStart(2,'0')+'min — <a href="/landing">Assinar plano completo</a>';
          banner.classList.add('active');
        }
        await loadAll();
        document.getElementById('boot-loading').style.display='none';
        document.getElementById('login-screen').style.display='none';
        document.getElementById('app').style.display='block';
        _sessionStartTimer();
        window.aiOnLogin?.();
        return;
      }
    }
  } catch(e){
    console.warn('Erro sessão:', e.message);
  }
  // Sem sessão (ou clínica pendente/inexistente, já tratado dentro de
  // checkClinicaApproval) — sempre acaba redirecionando pra index.html,
  // então o login-screen daqui nunca chega a ser o estado final; só
  // esconde o boot antes de navegar, por segurança.
  document.getElementById('boot-loading').style.display='none';
  window.location.replace('index.html');
})();

// ══════════════════════════════════════════════════════
// LOAD DATA FROM SUPABASE
// ══════════════════════════════════════════════════════
async function loadAll(){
  showLoading(true);
  try {
    const [{ data: ag }, { data: pr }, { data: pa }] = await Promise.all([
      _sb.from('agendamentos').select('*').eq('clinica_id', clinicaId).order('data').order('horario'),
      _sb.from('profissionais').select('*').eq('clinica_id', clinicaId).order('id'),
      _sb.from('pacientes').select('*, prontuarios(*)').eq('clinica_id', clinicaId)
    ]);
    agendamentos = ag || [];
    // Ensure default professional exists
    if(!pr || pr.length===0){
      const nomeProf = clinicaData?.nome_resp || 'Profissional Principal';
      const { data: novoPr } = await _sb.from('profissionais').insert([
        { nome: nomeProf, especialidade:'Dentista Principal', cro:'', cor:'#d4735a', principal:true, clinica_id: clinicaId }
      ]).select();
      profissionais = novoPr || [];
    } else {
      profissionais = pr;
    }
    pacientes = (pa||[]).map(p=>({ ...p, prontuarios: p.prontuarios||[] }));
    // Carrega anamneses da tabela separada e mescla
    try {
      const { data: anList } = await _sb.from('anamneses').select('*').eq('clinica_id', clinicaId);
      if(anList && anList.length){
        const anMap = {};
        anList.forEach(a=>{ anMap[a.paciente_id] = a.dados; });
        pacientes = pacientes.map(p=>({
          ...p,
          anamnese: anMap[p.id] || p.anamnese || null
        }));
      }
    } catch(e){ /* tabela pode não existir ainda, usa anamnese do próprio paciente */ }
    try {
      const { data: links } = await _sb.from('anamnese_links').select('token,paciente_id,expires_at,used_at,created_at').eq('clinica_id', clinicaId).order('created_at',{ascending:false});
      if(links && links.length){
        const linkMap = {};
        links.forEach(l=>{ if(!linkMap[l.paciente_id]) linkMap[l.paciente_id] = l; });
        pacientes = pacientes.map(p=>({ ...p, _anamneseLink: linkMap[p.id]||null }));
      }
    } catch(e){ /* tabela pode não existir */ }
    await loadFinanceiro();
    initApp();
  } catch(e){
    showToast('Erro ao carregar dados: '+e.message,'error');
  }
  showLoading(false);
}

function initApp(){
  // Garante que todas as modais estejam fechadas ao inicializar
  document.querySelectorAll('.modal-overlay, .sign-overlay').forEach(m=>m.classList.remove('open'));
  document.getElementById('data').value = hoje();
  renderSelectProf();
  renderProfissionais();
  renderPatients();
  renderScheduleOptions();
  renderHomeStats();
  calSetView('semana', false);
  carregarConfigWhatsApp();
}

// ══════════════════════════════════════════════════════
// NAVIGATION
// ══════════════════════════════════════════════════════

function toggleFaq(i){
  const body=document.getElementById('faq-body-'+i);
  const ico=document.getElementById('faq-ico-'+i);
  const open=body.style.display==='none';
  body.style.display=open?'block':'none';
  ico.style.transform=open?'rotate(180deg)':'';
}

function atualizarPrecosAlinhador(){
  const fmtBRL = v => 'R$ '+Number(v).toLocaleString('pt-BR',{minimumFractionDigits:0,maximumFractionDigits:0});
  const proc207 = procs.find(p=>p.id===207);
  const proc214 = procs.find(p=>p.id===214);
  const total = proc207 ? (proc207.precoFinal||0) : 0;
  const refin = proc214 ? (proc214.precoFinal||0) : 0;
  if(total>0){
    const el=document.getElementById('alin-preco-total');
    if(el) el.textContent=fmtBRL(total);
    const entrada=Math.round(total*0.2);
    const restante=total-entrada;
    const parcelas=10;
    const valorParc=Math.round(restante/parcelas);
    const elE=document.getElementById('alin-entrada');
    if(elE) elE.textContent=fmtBRL(entrada);
    const elPD=document.getElementById('alin-parcela-desc');
    if(elPD) elPD.textContent='Restante ('+fmtBRL(restante)+') em '+parcelas+'x';
    const elPV=document.getElementById('alin-parcela-valor');
    if(elPV) elPV.textContent=fmtBRL(valorParc)+'/mês';
  }
  if(refin>0){
    const el=document.getElementById('alin-preco-refin');
    if(el) el.textContent=fmtBRL(refin);
    const elA=document.getElementById('alin-refin-apart');
    if(elA) elA.textContent=fmtBRL(refin)+' à parte';
    const elS=document.getElementById('alin-refin-sep');
    if(elS) elS.textContent=fmtBRL(refin);
  }
}

// ── TOPNAV DROPDOWNS ──
function tnToggle(id){
  const grp = document.getElementById(id);
  const isOpen = grp.classList.contains('open');
  tnClose();
  if(!isOpen) grp.classList.add('open');
}
function tnClose(){
  document.querySelectorAll('.tn-group.open').forEach(g=>g.classList.remove('open'));
}
// Fechar ao clicar fora
document.addEventListener('click', e=>{
  if(!e.target.closest('.tn-group')) tnClose();
});
// Destacar grupo quando tab ativa é filha
function tnUpdateActive(tab){
  const agendaTabs = ['agendar','lista','calendario'];
  const finTabs = ['financeiro','vendas_fin','procedimentos_fin','materiais_fin','estoque_fin'];
  const maisTabs = ['profissionais','resgate','invisalign_apresentacao','admin'];
  const grpAgenda = document.getElementById('tng-agenda');
  const grpFin = document.getElementById('tng-fin');
  const grpMais = document.getElementById('tng-mais');
  if(grpAgenda) grpAgenda.querySelector('.tn-group-btn').classList.toggle('has-active', agendaTabs.includes(tab));
  if(grpFin) grpFin.querySelector('.tn-group-btn').classList.toggle('has-active', finTabs.includes(tab));
  if(grpMais) grpMais.querySelector('.tn-group-btn').classList.toggle('has-active', maisTabs.includes(tab));
  // atualizar itens dentro dos dropdowns
  document.querySelectorAll('.tn-dropdown-item').forEach(b=>{
    b.classList.toggle('active', b.dataset.tab===tab);
  });
}

function toggleMobileMore(){
  const ov=document.getElementById('mobile-more-overlay');
  if(ov) ov.classList.toggle('show');
}

// ── PIN FINANCEIRO — único PIN do app. Vendas, Procedimentos, Materiais e
// Estoque ficam sempre abertos (modo secretária); só o faturamento agregado
// (card da Home, Painel Financeiro, Produtividade, Comissões) fica atrás
// deste PIN. O hash NUNCA é carregado pro navegador (fica numa tabela
// própria, só acessível pela service role dentro de api/financeiro-pin.js),
// então não dá pra atacar por força bruta no console. Verificado uma vez
// por sessão de página (_finVerificado fica só em memória, reseta ao
// recarregar).
let _finVerificado = false;
async function _finApi(body){
  const { data:{ session } } = await _sb.auth.getSession();
  const resp = await fetch('/api/financeiro-pin', {
    method:'POST',
    headers:{ 'Content-Type':'application/json', 'Authorization':'Bearer '+(session?.access_token||'') },
    body: JSON.stringify(body)
  });
  const json = await resp.json().catch(()=>({}));
  return { ok: resp.ok, json };
}
async function pedirFinPinFaturamento(){
  if(_finVerificado) return true;
  const pin = prompt('🔒 Faturamento protegido. Digite o PIN financeiro:');
  if(pin===null) return false;
  showLoading(true);
  const { ok, json } = await _finApi({ action:'check', pin:String(pin).trim() });
  showLoading(false);
  if(!ok){ showToast(json.error||'PIN incorreto.','error'); return false; }
  _finVerificado = true;
  return true;
}
async function definirFinPinFaturamento(){
  const novo = (document.getElementById('fin-pin-fat-input')?.value||'').trim();
  const atual = (document.getElementById('fin-pin-fat-atual')?.value||'').trim();
  if(!/^\d{4,6}$/.test(novo)){ showToast('O novo PIN deve ter de 4 a 6 dígitos.','warn'); return; }
  showLoading(true);
  const { ok, json } = await _finApi({ action:'set', pin:novo, pinAtual:atual });
  showLoading(false);
  if(!ok){ showToast(json.error||'Erro ao definir PIN financeiro.','error'); return; }
  document.getElementById('fin-pin-fat-input').value='';
  document.getElementById('fin-pin-fat-atual').value='';
  _finVerificado = true; // quem acabou de definir/trocar já sabe o PIN novo
  atualizarFinPinFaturamentoStatus();
  showToast('PIN financeiro salvo!');
}
// Esconder não precisa de senha (é a ação "segura"); só reaparecer o
// faturamento pede o PIN. "Ativado/desativado" aqui é sobre ESTA sessão do
// navegador (_finVerificado), não sobre o PIN estar configurado ou não.
function ativarModoSecretaria(){
  _finVerificado = false;
  atualizarFinPinFaturamentoStatus();
  renderHomeStats();
  showToast('Modo secretária ativado — faturamento escondido.');
}
async function atualizarFinPinFaturamentoStatus(){
  const el = document.getElementById('fin-pin-fat-status');
  if(!el) return;
  const { ok, json } = await _finApi({ action:'status' });
  if(!ok){ el.innerHTML = '<span style="color:var(--rose-text);">Não foi possível checar o status agora.</span>'; return; }
  if(!json.hasPin){
    el.innerHTML = '<span style="color:#b33;font-weight:700;"><i class="ti ti-shield-off"></i> Nenhum PIN definido — o faturamento fica visível pra qualquer um que usar o sistema. Defina um PIN abaixo.</span>';
    return;
  }
  if(_finVerificado){
    el.innerHTML = `<span style="color:#856404;font-weight:700;"><i class="ti ti-lock-open"></i> Modo secretária DESATIVADO — o faturamento está visível agora.</span>
      <div style="margin-top:8px;"><button class="btn-secondary" onclick="ativarModoSecretaria()" style="padding:6px 14px;font-size:12px;"><i class="ti ti-eye-off"></i> Ativar modo secretária (esconder faturamento)</button></div>`;
  } else {
    el.innerHTML = `<span style="color:#2e7d32;font-weight:700;"><i class="ti ti-shield-lock"></i> Modo secretária ATIVADO — faturamento escondido.</span>
      <div style="margin-top:8px;"><button class="btn-secondary" onclick="pedirFinPinFaturamento().then(ok=>{if(ok){atualizarFinPinFaturamentoStatus();renderHomeStats();}})" style="padding:6px 14px;font-size:12px;"><i class="ti ti-eye"></i> Ver faturamento (digitar PIN)</button></div>`;
  }
}

function switchTab(tab){
  if(tab==='invisalign_apresentacao' && !_isRhaizaClinic) tab='home';
  if(tab==='financeiro' && !_finVerificado){
    pedirFinPinFaturamento().then(ok=>{ if(ok) switchTab('financeiro'); });
    return;
  }
  ['home','agendar','lista','calendario','pacientes','profissionais','configuracoes','financeiro','procedimentos_fin','materiais_fin','estoque_fin','vendas_fin','venda_rapida','resgate','captacao','invisalign_apresentacao','admin'].forEach(t=>{
    const el=document.getElementById('tab-'+t);
    if(el) el.style.display = t===tab?'':'none';
  });
  tnUpdateActive(tab);
  document.querySelectorAll('.mobile-nav-item,.topnav-item').forEach(b=>{
    b.classList.toggle('active', b.dataset.tab===tab);
  });
  const _maisBtn=document.getElementById('mobile-mais-btn');
  if(_maisBtn){
    const _mainTabs=['home','lista','pacientes','venda_rapida'];
    _maisBtn.classList.toggle('active',!_mainTabs.includes(tab));
  }
  const _tituloAba = {
    home:'Agendamentos e Prontuários Odontológicos', agendar:'Novo agendamento', lista:'Agenda do dia',
    calendario:'Calendário de atendimentos', pacientes:'Cadastro de pacientes',
    profissionais:'Equipe e profissionais', financeiro:'Painel financeiro', procedimentos_fin:'Procedimentos e precificação',
    materiais_fin:'Materiais e insumos', estoque_fin:'Controle de estoque', vendas_fin:'Vendas e orçamentos',
    venda_rapida:'Vendas', resgate:'Resgate de pacientes', captacao:'Captação de contatos', invisalign_apresentacao:'Alinhador Transparente', configuracoes:'Configurações da clínica', admin:'Painel Administrativo'
  };
  const _subEl = document.getElementById('header-subtitulo');
  if(_subEl) _subEl.textContent = _tituloAba[tab] || 'Agendamentos e Prontuários Odontológicos';
  if(tab==='agendar') renderScheduleOptions();
  if(tab==='lista'){
    const _fdEl = document.getElementById('filtro-data');
    if(_fdEl && !_fdEl.value) _fdEl.value = hoje();
    renderLista();
  }
  if(tab==='calendario') renderCalendario();
  if(tab==='pacientes') renderPatients();
  if(tab==='profissionais') renderProfissionais();
  if(tab==='home') renderHomeStats();
  if(tab==='configuracoes'){ renderConfiguracoes(); atualizarFinPinFaturamentoStatus(); }
  if(tab==='resgate') renderResgate();
  if(tab==='admin') loadAdminPanel();
  if(tab==='invisalign_apresentacao'){
    if(!_financeiroCarregado){ loadFinanceiro().then(()=>atualizarPrecosAlinhador()); }
    else atualizarPrecosAlinhador();
  }
  if(tab==='venda_rapida'){
    // Sempre abre na Venda Rápida — Aparelhos/Alinhador/Clareamento ficam a
    // um clique, mas não são mais a aba padrão (nem pra Rhaiza).
    vendasSubTab('vr');
    // No mobile, foca busca automaticamente
    setTimeout(()=>{ const _s=document.getElementById('vr-search-m'); if(_s&&window.innerWidth<=768) _s.focus(); },200);
  }
  if(tab==='captacao'){
    if(!_financeiroCarregado){ loadFinanceiro().then(()=>capRender()); }
    else capRender();
  }
  if(tab==='venda_rapida'||tab==='financeiro'||tab==='procedimentos_fin'||tab==='materiais_fin'||tab==='estoque_fin'||tab==='vendas_fin'){
    if(!_financeiroCarregado){
      showLoading(true);
      loadFinanceiro().then(()=>{
        showLoading(false);
        if(tab==='financeiro') renderFinanceiroDash();
        if(tab==='procedimentos_fin'){ recalcularInsumos(true); renderProcs(); }
        if(tab==='materiais_fin') renderMats();
        if(tab==='estoque_fin') renderEstoque();
        if(tab==='vendas_fin') renderVendas();
        if(tab==='venda_rapida') vrInit();
      });
      return;
    }
    requestAnimationFrame(()=>{
      if(tab==='financeiro') renderFinanceiroDash();
      if(tab==='procedimentos_fin'){ recalcularInsumos(true); renderProcs(); }
      if(tab==='materiais_fin') renderMats();
      if(tab==='estoque_fin') renderEstoque();
      if(tab==='vendas_fin') renderVendas();
      if(tab==='venda_rapida') vrInit();
    });
  }
  window.scrollTo(0,0);
}

// ══════════════════════════════════════════════════════
// HOME STATS
// ══════════════════════════════════════════════════════
function renderHomeStats(){
  const hoje_str = hoje();
  // Popula hero banner
  const _heroDate = document.getElementById('home-hero-date');
  if(_heroDate){
    _heroDate.textContent = new Date().toLocaleDateString('pt-BR',{weekday:'long',day:'numeric',month:'long',year:'numeric'});
  }
  const _heroGreeting = document.getElementById('home-hero-greeting');
  if(_heroGreeting){
    const _hr = new Date().getHours();
    const _saudacao = _hr < 12 ? 'Bom dia' : _hr < 18 ? 'Boa tarde' : 'Boa noite';
    const _nomeResp = (clinicaData?.nome_resp || '').trim() || (clinicaData?.nome_cli || '').trim() || 'Dra. Rhaiza';
    _heroGreeting.textContent = _saudacao + ', ' + _nomeResp + '! 👋';
  }
  const hoje_count = agendamentos.filter(a=>a.data===hoje_str).length;
  const semana_end = new Date(); semana_end.setDate(semana_end.getDate()+7);
  const semana_count = agendamentos.filter(a=>a.data>=hoje_str && a.data<=toLocalISO(semana_end)).length;
  const confirmadas = agendamentos.filter(a=>a.data===hoje_str && ['compareceu','confirmado'].includes((agGetStatus(a)||'').toLowerCase())).length;

  const _mesStat = hoje_str.slice(0,7);
  const _fatMes = vendas.filter(v=>v.status==='finalizada'&&(v.data||v.dataFinal||'').slice(0,7)===_mesStat).reduce((a,v)=>a+(Number(v.total)||0),0);
  const _mesLabel = new Date(_mesStat+'-02').toLocaleDateString('pt-BR',{month:'long',year:'numeric'});
  // Faturamento agregado só aparece com o PIN financeiro verificado nesta
  // sessão — sem ele, mostra um cadeado clicável em vez do valor.
  const _fatMesHtml = _finVerificado
    ? fmtBRL(_fatMes)
    : `<span onclick="pedirFinPinFaturamento().then(ok=>{if(ok)renderHomeStats();})" style="cursor:pointer;" title="Digite o PIN financeiro pra ver">🔒</span>`;
  document.getElementById('home-hero-stats').innerHTML = `
    <div class="home-hero-stat"><div class="home-hero-stat-val">${_fatMesHtml}</div><div class="home-hero-stat-lbl">Faturamento do mês</div></div>
    <div class="home-hero-stat"><div class="home-hero-stat-val">${hoje_count}</div><div class="home-hero-stat-lbl">Consultas hoje</div></div>
    <div class="home-hero-stat"><div class="home-hero-stat-val">${semana_count}</div><div class="home-hero-stat-lbl">Na semana</div></div>
    <div class="home-hero-stat"><div class="home-hero-stat-val">${pacientes.length}</div><div class="home-hero-stat-lbl">Pacientes</div></div>
  `;
  document.getElementById('home-stats').innerHTML = `
    <div class="home-stat-card">
      <div class="home-stat-icon" style="background:#fdf0eb;color:#d4735a;"><i class="ti ti-users"></i></div>
      <div><div class="home-stat-num">${pacientes.length}</div><div class="home-stat-label">Total de Pacientes</div></div>
    </div>
    <div class="home-stat-card">
      <div class="home-stat-icon" style="background:#e8f5e9;color:#2e7d32;"><i class="ti ti-currency-dollar"></i></div>
      <div><div class="home-stat-num money">${_fatMesHtml}</div><div class="home-stat-label">Faturamento ${_mesLabel}</div></div>
    </div>
    <div class="home-stat-card">
      <div class="home-stat-icon" style="background:#fff4e5;color:#e08a20;"><i class="ti ti-calendar"></i></div>
      <div><div class="home-stat-num">${semana_count}</div><div class="home-stat-label">Consultas na semana</div></div>
    </div>
    <div class="home-stat-card">
      <div class="home-stat-icon" style="background:#e3f2fd;color:#1565c0;"><i class="ti ti-clock"></i></div>
      <div><div class="home-stat-num">${hoje_count}</div><div class="home-stat-label">Consultas hoje</div></div>
    </div>
    <div class="home-stat-card">
      <div class="home-stat-icon" style="background:#fce4e4;color:#c0392b;"><i class="ti ti-check"></i></div>
      <div><div class="home-stat-num">${confirmadas}</div><div class="home-stat-label">Confirmadas hoje</div></div>
    </div>
  `;

  // Próximas consultas de hoje
  const todayAgs = agendamentos
    .filter(a=>a.data===hoje_str)
    .sort((a,b)=>(a.horario||'').localeCompare(b.horario||''))
    .slice(0,5);
  const todayEl = document.getElementById('home-today-list');
  if(todayEl){
    if(!todayAgs.length){
      todayEl.innerHTML='<div class="home-empty">Nenhuma consulta hoje.</div>';
    } else {
      todayEl.innerHTML = todayAgs.map(a=>{
        const pac = pacientes.find(p=>p.id===a.paciente_id);
        const nome = pac ? pac.nome : (a.nome_paciente||'—');
        const st = (agGetStatus(a)||'pendente').toLowerCase();
        const badgeCls = st.includes('confirm') ? 'confirmada' : st.includes('complet') ? 'completada' : 'pendente';
        const badgeTxt = st.includes('confirm') ? 'Confirmada' : st.includes('complet') ? 'Completada' : 'Pendente';
        const telAg = a.telefone || pac?.telefone || '';
        const btnWpp = telAg ? `<button class="home-btn-ver" style="min-height:32px;padding:5px 9px;border-radius:8px;background:#25d366;color:#fff;border-color:#25d366;" title="Lembrar via WhatsApp" onclick="enviarConfirmacaoWpp('${escapeHtml(telAg).replace(/'/g,'&#39;')}','${escapeHtml(nome).replace(/'/g,'&#39;')}','${a.data}','${a.horario||''}','${escapeHtml(a.procedimento||'Consulta').replace(/'/g,'&#39;')}')"><i class="ti ti-brand-whatsapp"></i></button>` : '';
        return `<div class="home-table-row">
          <div class="home-row-main">
            ${homeAvatar(nome)}
            <div>
              <div class="home-table-name">${escapeHtml(nome)}</div>
              <div class="home-table-sub">${escapeHtml(a.procedimento||'')}</div>
            </div>
          </div>
          <div style="font-weight:700;color:#3a2020;min-width:44px;text-align:center;">${(a.horario||'').slice(0,5)}</div>
          <span class="home-badge ${badgeCls}">${badgeTxt}</span>
          ${btnWpp}
        </div>`;
      }).join('');
    }
  }

  // Últimos pacientes registrados
  const recentPacs = [...pacientes]
    .sort((a,b)=>new Date(b.created_at||0)-new Date(a.created_at||0))
    .slice(0,5);
  const recEl = document.getElementById('home-recent-patients');
  if(recEl){
    if(!recentPacs.length){
      recEl.innerHTML='<div class="home-empty">Nenhum paciente cadastrado.</div>';
    } else {
      recEl.innerHTML = recentPacs.map(p=>{
        const dt = p.created_at ? new Date(p.created_at).toLocaleDateString('pt-BR',{day:'2-digit',month:'short',year:'numeric'}) : '—';
        return `<div class="home-table-row">
          <div class="home-row-main">
            ${homeAvatar(p.nome)}
            <div>
              <div class="home-table-name">${escapeHtml(p.nome)}</div>
              <div class="home-table-sub">${dt}</div>
            </div>
          </div>
          <button class="home-btn-ver" onclick="verPacienteHome('${p.id}')" style="min-height:36px;padding:6px 14px;border-radius:8px;">Ver</button>
        </div>`;
      }).join('');
    }
  }

  // Pagamentos pendentes
  const pagPendEl = document.getElementById('home-pag-pendentes');
  if(pagPendEl){
    const _vendaPago = vendaValorPago;
    const pendentes = vendas.filter(v=>v.status==='finalizada'&&_vendaPago(v)<(v.total||0));
    if(!pendentes.length){
      pagPendEl.innerHTML='<div class="home-empty">Nenhum pagamento pendente.</div>';
    } else {
      const sorted = pendentes.sort((a,b)=>((a.dataFinal||a.data||'').localeCompare(b.dataFinal||b.data||'')));
      const _hj = new Date().toISOString().slice(0,10);
      pagPendEl.innerHTML = sorted.slice(0,5).map(v=>{
        const saldo = (v.total||0)-_vendaPago(v);
        const pac = pacientes.find(p=>p.id===v.pacienteId);
        const dt = v.dataFinal||v.data||'';
        const vencido = v.vencimento && v.vencimento < _hj;
        return `<div class="home-table-row">
          <div class="home-row-main">
            ${homeAvatar(pac?.nome||v.pacienteNome||'?')}
            <div>
              <div class="home-table-name">${escapeHtml(pac?.nome||v.pacienteNome||'—')}</div>
              <div class="home-table-sub">${dt?new Date(dt).toLocaleDateString('pt-BR'):'—'}${v.vencimento?' · vence '+new Date(v.vencimento+'T12:00:00').toLocaleDateString('pt-BR'):''}</div>
            </div>
          </div>
          ${vencido?'<span class="fin-badge danger" style="font-size:9px;">VENCIDO</span>':''}
          <span style="font-weight:700;color:#dc2626;font-size:13px;white-space:nowrap;">${fmtBRL(saldo)}</span>
        </div>`;
      }).join('')+(pendentes.length>5?`<div style="text-align:center;padding:6px;"><button class="btn-secondary" style="font-size:11px;" onclick="switchTab('vendas_fin')">Ver todos (${pendentes.length})</button></div>`:'');
    }
  }

  // Anamneses recebidas recentemente
  const anamEl = document.getElementById('home-anamneses-recebidas');
  if(anamEl){
    const comAnam = pacientes.filter(p=>p.anamnese&&Object.keys(p.anamnese).length>0)
      .sort((a,b)=>new Date(b.updated_at||b.created_at||0)-new Date(a.updated_at||a.created_at||0))
      .slice(0,5);
    if(!comAnam.length){
      anamEl.innerHTML='<div class="home-empty">Nenhuma anamnese recente.</div>';
    } else {
      anamEl.innerHTML = comAnam.map(p=>`<div class="home-table-row">
        <div class="home-row-main">
          ${homeAvatar(p.nome)}
          <div class="home-table-name">${escapeHtml(p.nome)}</div>
        </div>
        <span class="home-badge confirmada" style="font-size:10px;">Recebida</span>
        <button class="home-btn-ver" onclick="verPacienteHome('${p.id}')" style="min-height:36px;padding:6px 14px;border-radius:8px;">Ver</button>
      </div>`).join('');
    }
  }

  // Retornos atrasados (recall 6+ meses)
  const recallEl = document.getElementById('home-recall');
  if(recallEl){
    const hoje6m = new Date(); hoje6m.setMonth(hoje6m.getMonth()-6);
    const hojeStr = new Date().toISOString().slice(0,10);
    const recall = pacientes.map(p=>{
      const agsPac = agendamentos.filter(a=>a.paciente_id===p.id);
      if(!agsPac.length) return null;
      const temFuturo = agsPac.some(a=>(a.data||'')>=hojeStr && (agGetStatus(a)||'').toLowerCase()!=='cancelado');
      if(temFuturo) return null;
      const ultima = agsPac.map(a=>a.data||'').sort().pop();
      if(!ultima || new Date(ultima) > hoje6m) return null;
      return { p, ultima };
    }).filter(Boolean).sort((a,b)=>a.ultima.localeCompare(b.ultima)).slice(0,6);
    if(!recall.length){
      recallEl.innerHTML='<div class="home-empty">Nenhum retorno atrasado.</div>';
    } else {
      recallEl.innerHTML = recall.map(({p,ultima})=>{
        const meses = Math.floor((Date.now()-new Date(ultima).getTime())/2629800000);
        const tel = (p.telefone||'').replace(/\D/g,'');
        const btnW = tel ? `<button class="home-btn-ver" style="min-height:32px;padding:5px 9px;border-radius:8px;background:#25d366;color:#fff;" title="Chamar para retorno" onclick="homeRecallWpp(${p.id})"><i class="ti ti-brand-whatsapp"></i></button>` : '';
        return `<div class="home-table-row">
          <div class="home-row-main">
            ${homeAvatar(p.nome)}
            <div>
              <div class="home-table-name">${escapeHtml(p.nome)}</div>
              <div class="home-table-sub">Última visita: ${new Date(ultima+'T12:00:00').toLocaleDateString('pt-BR')} (${meses} meses)</div>
            </div>
          </div>
          ${btnW}
          <button class="home-btn-ver" onclick="verPacienteHome('${p.id}')" style="min-height:32px;padding:5px 12px;border-radius:8px;">Ver</button>
        </div>`;
      }).join('');
    }
  }

  // Aniversariantes do mês
  const aniverEl = document.getElementById('home-aniversariantes');
  if(aniverEl){
    const mesAtual = new Date().getMonth()+1;
    const diaAtual = new Date().getDate();
    const aniver = pacientes.filter(p=>{
      const dn = (p.nascimento||'').slice(5,7);
      return dn && parseInt(dn)===mesAtual;
    }).map(p=>({p, dia: parseInt((p.nascimento||'').slice(8,10))||0}))
      .sort((a,b)=>a.dia-b.dia);
    if(!aniver.length){
      aniverEl.innerHTML='<div class="home-empty">Nenhum aniversariante este mês.</div>';
    } else {
      aniverEl.innerHTML = aniver.slice(0,8).map(({p,dia})=>{
        const hojeAniv = dia===diaAtual;
        const tel = (p.telefone||'').replace(/\D/g,'');
        const btnW = tel ? `<button class="home-btn-ver" style="min-height:32px;padding:5px 9px;border-radius:8px;background:#25d366;color:#fff;" title="Enviar parabéns" onclick="homeAniverWpp(${p.id})"><i class="ti ti-brand-whatsapp"></i></button>` : '';
        return `<div class="home-table-row" ${hojeAniv?'style="background:#fff3f6;border-radius:8px;"':''}>
          <div class="home-row-main">
            ${homeAvatar(p.nome)}
            <div>
              <div class="home-table-name">${hojeAniv?'🎂 ':''}${escapeHtml(p.nome)}</div>
              <div class="home-table-sub">Dia ${dia}${hojeAniv?' — hoje!':''}</div>
            </div>
          </div>
          ${btnW}
        </div>`;
      }).join('')+(aniver.length>8?`<div style="text-align:center;padding:6px;font-size:11px;color:var(--rose-text);">+${aniver.length-8} aniversariante(s)</div>`:'');
    }
  }

  // Lembrete mensal de backup
  const bkEl = document.getElementById('home-backup-banner');
  if(bkEl){
    const last = localStorage.getItem('rwdent-ultimo-backup');
    const dias = last ? Math.floor((Date.now()-new Date(last).getTime())/86400000) : null;
    if(dias===null || dias>30){
      bkEl.innerHTML = `<div class="card" style="border:1.5px solid #90caf9;display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
        <i class="ti ti-database-export" style="font-size:24px;color:#1565c0;"></i>
        <div style="flex:1;min-width:200px;">
          <div style="font-size:13px;font-weight:700;color:#0d47a1;">Hora de fazer backup</div>
          <div style="font-size:12px;color:var(--rose-text);">${dias===null?'Nenhum backup registrado ainda.':'Seu último backup foi há '+dias+' dias.'} Exporte seus dados por segurança.</div>
        </div>
        <button class="btn-primary" style="font-size:12px;" onclick="switchTab('configuracoes')"><i class="ti ti-download"></i> Fazer backup</button>
      </div>`;
      bkEl.style.display='';
    } else { bkEl.style.display='none'; bkEl.innerHTML=''; }
  }

  // Alertas de estoque baixo
  const estAlertEl = document.getElementById('home-estoque-alertas');
  if(estAlertEl && mats.length){
    const criticos = mats.filter(m=>!m.arquivado&&getEstStatus(m.id)==='danger');
    const atencao = mats.filter(m=>!m.arquivado&&getEstStatus(m.id)==='warn');
    if(criticos.length || atencao.length){
      let html = '<div class="card" style="border:1.5px solid '+(criticos.length?'#fca5a5':'#ffe082')+';"><h3 style="font-size:13px;color:'+(criticos.length?'#dc2626':'#856404')+';margin-bottom:10px;display:flex;align-items:center;gap:6px;"><i class="ti ti-alert-triangle"></i> Estoque com atenção</h3>';
      if(criticos.length){ html+='<div style="font-size:12px;color:#dc2626;font-weight:600;margin-bottom:6px;">Nível crítico ('+criticos.length+'):</div>'; criticos.slice(0,5).forEach(m=>{ const e=estoque[m.id]||{}; html+='<div style="font-size:12px;padding:4px 0;color:#3a2020;">• '+escapeHtml(m.nome)+' — <strong style="color:#dc2626;">'+(e.atual||0)+' '+(m.unid||'un')+'</strong> (mín: '+(e.min||0)+')</div>'; }); }
      if(atencao.length){ html+='<div style="font-size:12px;color:#856404;font-weight:600;margin-bottom:6px;'+(criticos.length?'margin-top:8px;':'')+'">Atenção ('+atencao.length+'):</div>'; atencao.slice(0,5).forEach(m=>{ const e=estoque[m.id]||{}; html+='<div style="font-size:12px;padding:4px 0;color:#3a2020;">• '+escapeHtml(m.nome)+' — <strong style="color:#856404;">'+(e.atual||0)+' '+(m.unid||'un')+'</strong></div>'; }); }
      html+='<button class="btn-secondary" onclick="switchTab(\'estoque_fin\')" style="margin-top:10px;font-size:11px;padding:6px 12px;"><i class="ti ti-box"></i> Ver estoque completo</button></div>';
      estAlertEl.innerHTML=html; estAlertEl.style.display='';
    } else { estAlertEl.style.display='none'; estAlertEl.innerHTML=''; }
  }
}

function verPacienteHome(id){
  switchTab('pacientes');
  setTimeout(()=>{ selectPatient(parseInt(id)); }, 150);
}

// ══════════════════════════════════════════════════════
// AGENDAMENTOS
// ══════════════════════════════════════════════════════
function renderScheduleOptions(){
  const sel = document.getElementById('schedule-patient');
  if(!sel) return;
  const cur = sel.value;
  sel.innerHTML='<option value="">Selecione o paciente</option>'+pacientes.map(p=>`<option value="${p.id}">${escapeHtml(p.nome)}</option>`).join('');
  sel.value=cur; onSchedulePatientChange();
}

function onSchedulePatientChange(){
  const sel=document.getElementById('schedule-patient');
  const ph=document.getElementById('schedule-phone');
  if(!sel||!ph) return;
  const p=pacientes.find(p=>p.id==sel.value);
  ph.value=p&&p.telefone?p.telefone:'';
}

function renderSelectProf(){
  const sel=document.getElementById('profissional');
  const fil=document.getElementById('filtro-prof');
  const calSel=document.getElementById('cal-prof');
  if(!sel) return;
  const cur=sel.value;
  const opts=profissionais.map(p=>`<option value="${p.id}">${escapeHtml(p.nome)} — ${escapeHtml(p.especialidade)}</option>`).join('');
  sel.innerHTML=opts; if(cur) sel.value=cur;
  if(fil) fil.innerHTML='<option value="">Todos os profissionais</option>'+profissionais.map(p=>`<option value="${p.id}">${escapeHtml(p.nome)}</option>`).join('');
  if(calSel) calSel.innerHTML='<option value="">Todos</option>'+profissionais.map(p=>`<option value="${p.id}">${escapeHtml(p.nome)}</option>`).join('');
}

// ── Agendar direto do prontuário ──
function agendarDoProntuario(pacId){
  switchTab('agendar');
  setTimeout(()=>{
    const sel = document.getElementById('schedule-patient');
    if(sel){ sel.value = pacId; onSchedulePatientChange(); }
    const dataEl = document.getElementById('data');
    if(dataEl && !dataEl.value) dataEl.value = hoje();
  }, 250);
}

// ── Lembretes de amanhã em lote via WhatsApp ──
function lembrarTodosAmanha(){
  const amanha = new Date(); amanha.setDate(amanha.getDate()+1);
  const amanhaISO = toLocalISO(amanha);
  const lista = agendamentos.filter(a=>a.data===amanhaISO && a.telefone);
  if(!lista.length){ showToast('Nenhum agendamento com telefone para amanhã.','warn'); return; }

  // Remove modal anterior
  document.getElementById('lembretes-modal')?.remove();
  const modal = document.createElement('div');
  modal.id = 'lembretes-modal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(60,30,20,.5);z-index:9000;display:flex;align-items:center;justify-content:center;padding:16px;';
  const fmtD = amanha.toLocaleDateString('pt-BR',{weekday:'long',day:'numeric',month:'long'});
  const clinicaNome = document.getElementById('header-clinica')?.textContent||'Clínica';
  modal.innerHTML = `<div style="background:#fff;border-radius:18px;max-width:440px;width:100%;max-height:80vh;overflow:auto;box-shadow:0 20px 60px rgba(0,0,0,.3);">
    <div style="background:linear-gradient(135deg,#25d366,#1a9e4e);padding:16px 20px;border-radius:18px 18px 0 0;color:#fff;">
      <div style="font-size:13px;opacity:.9;"><i class="ti ti-brand-whatsapp"></i> Lembretes de amanhã</div>
      <div style="font-size:16px;font-weight:800;margin-top:2px;">${fmtD} — ${lista.length} paciente(s)</div>
    </div>
    <div style="padding:14px 16px;display:flex;flex-direction:column;gap:8px;">
      ${lista.map(a=>{
        const tel = a.telefone.replace(/\D/g,'');
        let _loc = '';
        const _end = clinicaData?.endereco || cfg.endereco || '';
        const _mpl = clinicaData?.maps_link || cfg.maps_link || '';
        if(_end || _mpl){
          _loc = '\n📍 *Local:* ' + (_end || clinicaNome);
          if(_mpl) _loc += '\n🗺️ *Como chegar:* ' + _mpl;
          _loc += '\n';
        }
        const msg = `Olá, ${a.nome.split(' ')[0]}! 😊\n\nPassando para lembrar que amanhã é o seu dia ${_prepClinica(clinicaNome)}!\n\n📅 *Horário:* ${a.horario}\n🦷 *Procedimento:* ${a.procedimento||'Consulta'}${_loc}\n\nPor favor, confirme sua presença respondendo *SIM* — ou nos avise caso precise reagendar. Estaremos esperando por você! 🙏`;
        const url = `https://wa.me/55${tel}?text=${encodeURIComponent(msg)}`;
        return `<div style="display:flex;align-items:center;gap:10px;padding:10px;border:1.5px solid #e8f5e9;border-radius:10px;">
          <div style="flex:1;min-width:0;">
            <div style="font-weight:700;font-size:13px;">${escapeHtml(a.nome)}</div>
            <div style="font-size:11px;color:#555;">${a.horario} · ${escapeHtml(a.procedimento||'Consulta')}</div>
          </div>
          <a href="${url}" target="_blank" style="display:inline-flex;align-items:center;gap:5px;background:#25d366;color:#fff;border-radius:8px;padding:7px 12px;font-size:12px;font-weight:700;text-decoration:none;flex-shrink:0;"><i class="ti ti-brand-whatsapp"></i> Enviar</a>
        </div>`;
      }).join('')}
    </div>
    <div style="padding:0 16px 16px;display:flex;justify-content:flex-end;">
      <button class="btn-secondary" onclick="document.getElementById('lembretes-modal').remove()">Fechar</button>
    </div>
  </div>`;
  document.body.appendChild(modal);
  modal.addEventListener('click',e=>{if(e.target===modal) modal.remove();});
}

function buildGoogleCalendarUrl(nome, data, horario, procedimento, profNome, obs){
  // Monta URL do Google Agenda com os dados preenchidos
  // data: 'YYYY-MM-DD', horario: 'HH:MM'
  const [ano, mes, dia] = data.split('-');
  const [hh, mm] = horario.split(':');
  // Formato Google: YYYYMMDDTHHmmss
  const pad = n => String(n).padStart(2,'0');
  const dtStart = `${ano}${mes}${dia}T${pad(hh)}${pad(mm)}00`;
  // Duração padrão: 1 hora
  const endH = (parseInt(hh)||0)+1;
  const dtEnd = `${ano}${mes}${dia}T${pad(endH)}${pad(mm)}00`;
  const clinica = (clinicaData?.nome_cli) ? clinicaData.nome_cli : 'Clínica';
  const title = encodeURIComponent(`${procedimento||'Consulta'} — ${nome}`);
  const details = encodeURIComponent(`Paciente: ${nome}\nProfissional: ${profNome||''}\n${obs?'Observações: '+obs:''}`);
  const location = encodeURIComponent(clinica);
  return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${title}&dates=${dtStart}/${dtEnd}&details=${details}&location=${location}`;
}

function abrirGoogleAgenda(nome, data, horario, procedimento, profNome, obs){
  const url = buildGoogleCalendarUrl(nome, data, horario, procedimento, profNome, obs);
  window.open(url, '_blank');
}

function mostrarBotaoGoogleAgenda(nome, data, horario, procedimento, profNome, obs){
  // Remove banner anterior se existir
  const anterior = document.getElementById('gcal-banner');
  if(anterior) anterior.remove();

  const [ano, mes, dia] = data.split('-');
  const dataFmt = `${dia}/${mes}/${ano}`;
  const url = buildGoogleCalendarUrl(nome, data, horario, procedimento, profNome, obs);

  const banner = document.createElement('div');
  banner.id = 'gcal-banner';
  banner.innerHTML = `
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
      <div style="flex:1;min-width:180px;">
        <div style="font-size:13px;font-weight:700;color:#1a1a1a;margin-bottom:2px;">✅ Agendamento confirmado!</div>
        <div style="font-size:12px;color:#555;">${escapeHtml(nome)} · ${dataFmt} às ${horario}</div>
      </div>
      <a href="${url}" target="_blank" style="display:inline-flex;align-items:center;gap:7px;background:#4285f4;color:#fff;border-radius:10px;padding:9px 16px;font-size:13px;font-weight:700;text-decoration:none;white-space:nowrap;box-shadow:0 2px 8px rgba(66,133,244,.35);flex-shrink:0;">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="24" height="24" rx="4" fill="white"/><path d="M17.5 7.5h-11A1.5 1.5 0 0 0 5 9v9a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 18V9a1.5 1.5 0 0 0-1.5-1.5Z" stroke="#4285f4" stroke-width="1.4"/><path d="M8 7.5V6M16 7.5V6M5 11h14" stroke="#4285f4" stroke-width="1.4" stroke-linecap="round"/><rect x="8" y="13" width="2.5" height="2.5" rx=".5" fill="#ea4335"/></svg>
        Adicionar ao Google Agenda
      </a>
      <button onclick="document.getElementById('gcal-banner').remove()" style="background:none;border:none;color:#999;font-size:20px;cursor:pointer;line-height:1;padding:2px 4px;flex-shrink:0;" title="Fechar">×</button>
    </div>
  `;
  Object.assign(banner.style, {
    position:'fixed', bottom:'24px', left:'50%', transform:'translateX(-50%)',
    background:'#fff', borderRadius:'14px', padding:'14px 18px',
    boxShadow:'0 8px 32px rgba(0,0,0,.18)', zIndex:'9999',
    maxWidth:'520px', width:'calc(100% - 32px)',
    border:'1.5px solid #e0e0e0', animation:'gcalSlideUp .3s ease'
  });

  // Auto-fechar após 12 segundos
  document.body.appendChild(banner);
  setTimeout(()=>{ if(document.getElementById('gcal-banner')) banner.remove(); }, 12000);
}

async function agendarConsulta(){
  const patientId = document.getElementById('schedule-patient').value;
  const paciente = pacientes.find(p=>p.id==patientId);
  const telefone = document.getElementById('schedule-phone').value.trim();
  const profId = parseInt(document.getElementById('profissional').value);
  const data = document.getElementById('data').value;
  const horario = document.getElementById('horario').value;
  const procedimento = document.getElementById('procedimento').value.trim();
  const obs = document.getElementById('obs').value.trim();
  if(!paciente){ showToast('Selecione um paciente.','warn'); return; }
  if(!profId){ showToast('Selecione um profissional.','warn'); return; }
  if(!data){ showToast('Escolha a data.','warn'); return; }
  if(!horario){ showToast('Escolha o horário.','warn'); return; }
  const conflito = agendamentos.find(a=>a.prof_id===profId&&a.data===data&&a.horario===horario);
  if(conflito){ showToast('Conflito de horário para o profissional.','error'); return; }
  const prof = profissionais.find(p=>p.id===profId);
  if(!prof){ showToast('Profissional inválido.','warn'); return; }
  showLoading(true);
  // Confere de novo direto no banco (não só na lista em memória) bem antes de salvar,
  // para reduzir a chance de duas pessoas agendarem o mesmo horário ao mesmo tempo
  // em sessões diferentes (a checagem acima só vê o que já estava carregado nesta aba).
  const { data: conflitoBanco } = await _sb.from('agendamentos')
    .select('id').eq('clinica_id', clinicaId).eq('prof_id', profId).eq('data', data).eq('horario', horario).limit(1);
  if(conflitoBanco && conflitoBanco.length){
    showLoading(false);
    showToast('Esse horário acabou de ser ocupado por outro agendamento. Escolha outro horário.','error');
    return;
  }
  const { data: novo, error } = await _sb.from('agendamentos').insert([{
    paciente_id: paciente.id, nome: paciente.nome,
    telefone: telefone||paciente.telefone||'',
    prof_id: profId, prof_nome: prof.nome, prof_cor: prof.cor,
    data, horario, procedimento, obs,
    clinica_id: clinicaId
  }]).select().single();
  showLoading(false);
  if(error){ showToast('Erro ao salvar: '+error.message,'error'); return; }
  agendamentos.push(novo);
  agendamentos.sort((a,b)=>(a.data+a.horario).localeCompare(b.data+b.horario));
  ['schedule-phone','horario','procedimento','obs'].forEach(id=>{ const el=document.getElementById(id); if(el) el.value=''; });
  document.getElementById('data').value=hoje();
  logAtividade('Agendamento criado', `${paciente.nome} — ${data} ${horario}`);
  showToast('Agendamento salvo!');
  renderLista(); renderHomeStats();
  switchTab('lista');
  // Botão Google Agenda
  mostrarBotaoGoogleAgenda(novo.nome, novo.data, novo.horario, novo.procedimento, novo.prof_nome, novo.obs);
}

function renderLista(){
  const container=document.getElementById('lista-agendamentos');
  if(!container) return;
  const dataFiltro=document.getElementById('filtro-data')?.value||'';
  const profFiltro=document.getElementById('filtro-prof')?.value||'';
  let lista=agendamentos.filter(a=>{
    if(dataFiltro&&a.data!==dataFiltro) return false;
    if(profFiltro&&a.prof_id!==parseInt(profFiltro)) return false;
    return true;
  });
  if(!lista.length){ container.innerHTML='<div class="empty"><i class="ti ti-calendar-off" style="font-size:32px;display:block;margin-bottom:10px;opacity:.35"></i>Nenhum agendamento encontrado.</div>'; return; }
  container.innerHTML=lista.map(a=>{
    const status = (agGetStatus(a)||'').toLowerCase();
    const statusBadge = status==='faltou'
      ? '<span class="fin-badge danger" style="font-size:9px;margin-left:6px;">NÃO VEIO</span>'
      : status==='compareceu'
      ? '<span class="fin-badge ok" style="font-size:9px;margin-left:6px;">COMPARECEU</span>'
      : status==='confirmado'
      ? '<span class="fin-badge" style="font-size:9px;margin-left:6px;background:#dbeafe;color:#1e40af;">CONFIRMADO</span>'
      : status==='remarcado'
      ? '<span class="fin-badge" style="font-size:9px;margin-left:6px;background:#fef3c7;color:#92400e;">REMARCADO</span>'
      : status==='cancelado'
      ? '<span class="fin-badge danger" style="font-size:9px;margin-left:6px;">CANCELADO</span>'
      : '';
    return `
    <div class="appt-item">
      <div class="appt-time">${(a.horario||'--:--').slice(0,5)}<small>${formatDate(a.data)}</small></div>
      <div class="appt-info" ${a.paciente_id?'onclick="verPacienteHome('+a.paciente_id+')" style="cursor:pointer;"':''}>
        <div class="name">${escapeHtml(a.nome)} ${statusBadge}${a.paciente_id?'<i class="ti ti-chevron-right" style="font-size:10px;opacity:.4;margin-left:3px;"></i>':''}</div>
        <div class="detail">${escapeHtml(a.procedimento||'Consulta')} · ${escapeHtml(a.prof_nome)} · ${escapeHtml(a.telefone||'Sem telefone')}</div>
      </div>
      <span class="appt-badge badge-main">${escapeHtml((a.prof_nome||'').split(' ')[0])}</span>
      <button class="btn-secondary" style="padding:6px 10px;background:${status==='confirmado'?'#1e40af':'#fff'};color:${status==='confirmado'?'#fff':'#1e40af'};border-color:#1e40af;" onclick="calMarcarPresenca(${a.id},'confirmado')" title="Confirmar presença"><i class="ti ti-circle-check"></i></button>
      <button class="btn-secondary" style="padding:6px 10px;background:${status==='compareceu'?'#2e7d32':'#fff'};color:${status==='compareceu'?'#fff':'#2e7d32'};border-color:#2e7d32;" onclick="calMarcarPresenca(${a.id},'compareceu')" title="Marcar que veio"><i class="ti ti-check"></i></button>
      <button class="btn-secondary" style="padding:6px 10px;background:${status==='faltou'?'#dc2626':'#fff'};color:${status==='faltou'?'#fff':'#dc2626'};border-color:#dc2626;" onclick="calMarcarPresenca(${a.id},'faltou')" title="Marcar que não veio"><i class="ti ti-x"></i></button>
      ${a.telefone ? `<button class="btn-secondary" style="padding:6px 10px;background:#25d366;color:#fff;border-color:#25d366;" onclick="enviarConfirmacaoWpp('${escapeHtml(a.telefone).replace(/'/g,'&#39;')}','${escapeHtml(a.nome).replace(/'/g,'&#39;')}','${escapeHtml(a.data).replace(/'/g,'&#39;')}','${escapeHtml(a.horario).replace(/'/g,'&#39;')}','${escapeHtml(a.procedimento||'Consulta').replace(/'/g,'&#39;')}')" title="Confirmar via WhatsApp"><i class="ti ti-brand-whatsapp"></i></button>` : ''}
      <a href="${buildGoogleCalendarUrl(a.nome, a.data, a.horario, a.procedimento||'Consulta', a.prof_nome, a.obs||'')}" target="_blank" class="btn-secondary" style="padding:6px 10px;background:#4285f4;color:#fff;border-color:#4285f4;text-decoration:none;display:inline-flex;align-items:center;" title="Adicionar ao Google Agenda"><i class="ti ti-brand-google"></i></a>
      <button class="btn-danger" onclick="removerAgendamento(${a.id})"><i class="ti ti-trash"></i></button>
    </div>
  `;}).join('');
}

async function removerAgendamento(id){
  if(!confirm('Remover este agendamento?')) return;
  showLoading(true);
  const { error } = await _sb.from('agendamentos').delete().eq('id',id);
  showLoading(false);
  if(error){ showToast('Erro ao remover.','error'); return; }
  agendamentos=agendamentos.filter(a=>a.id!==id);
  renderLista(); renderHomeStats(); renderCalendario();
  showToast('Agendamento removido.');
}

// ══════════════════════════════════════════════════════
// PROFISSIONAIS
// ══════════════════════════════════════════════════════
function toggleFormProf(){ const el=document.getElementById('form-prof'); el.style.display=el.style.display==='none'?'':'none'; }

function renderProfissionais(){
  const c=document.getElementById('lista-profissionais');
  if(!c) return;
  c.innerHTML=profissionais.map(p=>`
    <div class="prof-card">
      <div class="patient-avatar" style="background:${p.cor}">${initials(p.nome)}</div>
      <div class="patient-info">
        <div class="name">${escapeHtml(p.nome)}${p.principal?' <span class="badge-principal">Principal</span>':''}</div>
        <div class="meta">${escapeHtml(p.especialidade)}${p.cro?' · '+escapeHtml(p.cro):''}</div>
      </div>
      <button class="btn-secondary" style="padding:6px 10px;" onclick="editarProfissional(${p.id})" title="Editar"><i class="ti ti-pencil"></i></button>
      ${p.principal?'':`<button class="btn-danger" style="padding:6px 10px;" onclick="removerProfissional(${p.id})"><i class="ti ti-trash"></i></button>`}
    </div>
  `).join('');
  renderSelectProf();
}

async function adicionarProfissional(){
  const nome=document.getElementById('p-nome').value.trim();
  const esp=document.getElementById('p-esp').value.trim();
  const cro=document.getElementById('p-cro').value.trim();
  const cor=document.getElementById('p-cor').value;
  if(!nome||!esp){ showToast('Preencha nome e especialidade.','warn'); return; }
  showLoading(true);
  const { data:novo, error } = await _sb.from('profissionais').insert([{ nome, especialidade:esp, cro, cor, principal:false, clinica_id: clinicaId }]).select().single();
  showLoading(false);
  if(error){ showToast('Erro: '+error.message,'error'); return; }
  profissionais.push(novo);
  ['p-nome','p-esp','p-cro'].forEach(id=>document.getElementById(id).value='');
  document.getElementById('p-cor').value='#d4735a';
  toggleFormProf(); renderProfissionais();
  logAtividade('Profissional adicionado', nome);
  showToast('Profissional adicionado.');
}

function editarProfissional(id){
  const p = profissionais.find(x=>x.id===id); if(!p) return;
  document.getElementById('p-nome').value = p.nome||'';
  document.getElementById('p-esp').value  = p.especialidade||'';
  document.getElementById('p-cro').value  = p.cro||'';
  document.getElementById('p-cor').value  = p.cor||'#d4735a';
  const btn = document.getElementById('btn-salvar-prof');
  if(btn){ btn.innerHTML='<i class="ti ti-device-floppy"></i> Salvar alterações'; btn.onclick=()=>salvarEdicaoProfissional(id); }
  const form = document.getElementById('form-prof');
  form.style.display='';
  form.scrollIntoView({behavior:'smooth',block:'nearest'});
}

async function salvarEdicaoProfissional(id){
  const nome = document.getElementById('p-nome').value.trim();
  const esp  = document.getElementById('p-esp').value.trim();
  const cro  = document.getElementById('p-cro').value.trim();
  const cor  = document.getElementById('p-cor').value;
  if(!nome||!esp){ showToast('Preencha nome e especialidade.','warn'); return; }
  showLoading(true);
  const { error } = await _sb.from('profissionais').update({nome, especialidade:esp, cro, cor}).eq('id',id);
  showLoading(false);
  if(error){ showToast('Erro: '+error.message,'error'); return; }
  profissionais = profissionais.map(p=> p.id===id ? {...p,nome,especialidade:esp,cro,cor} : p);
  // Reset form para modo "adicionar"
  ['p-nome','p-esp','p-cro'].forEach(fid=>{ const el=document.getElementById(fid); if(el) el.value=''; });
  document.getElementById('p-cor').value='#d4735a';
  const btn = document.getElementById('btn-salvar-prof');
  if(btn){ btn.innerHTML='<i class="ti ti-check"></i> Salvar profissional'; btn.onclick=adicionarProfissional; }
  document.getElementById('form-prof').style.display='none';
  renderProfissionais(); renderSelectProf();
  showToast('Profissional atualizado!');
}

async function removerProfissional(id){
  if(agendamentos.some(a=>a.prof_id===id)){ showToast('Profissional possui agendamentos e não pode ser removido.','error'); return; }
  if(!confirm('Remover este profissional?')) return;
  showLoading(true);
  const { error } = await _sb.from('profissionais').delete().eq('id',id);
  showLoading(false);
  if(error){ showToast('Erro: '+error.message,'error'); return; }
  profissionais=profissionais.filter(p=>p.id!==id);
  renderProfissionais(); showToast('Profissional removido.');
}

// ══════════════════════════════════════════════════════
// PACIENTES
// ══════════════════════════════════════════════════════
function togglePatientForm(){
  const el=document.getElementById('form-paciente');
  el.style.display=el.style.display==='none'?'':'none';
  if(el.style.display===''){
    document.getElementById('save-patient-btn').onclick=adicionarPaciente;
    document.getElementById('save-patient-btn').innerHTML='<i class="ti ti-check"></i> Salvar paciente';
    editingPatientId=null;
  }
}

function cancelPatientEdit(){ togglePatientForm(); resetPatientForm(); }

function calcIdade(dataNasc){
  if(!dataNasc) return null;
  const hoje = new Date();
  const nasc = new Date(dataNasc+'T00:00:00');
  let idade = hoje.getFullYear() - nasc.getFullYear();
  const m = hoje.getMonth() - nasc.getMonth();
  if(m<0 || (m===0 && hoje.getDate()<nasc.getDate())) idade--;
  return idade;
}

function ptCheckMenor(){
  const nasc = document.getElementById('pt-nascimento')?.value;
  const idade = calcIdade(nasc);
  const ehMenor = idade!==null && idade<18;
  const alerta = document.getElementById('pt-menor-alerta');
  const obrig  = document.getElementById('pt-resp-obrig');
  if(alerta) alerta.style.display = ehMenor ? 'block' : 'none';
  if(obrig)  obrig.style.display  = ehMenor ? 'inline' : 'none';
  return ehMenor;
}

// Responsável/contato de emergência são guardados dentro da coluna "notas" (texto livre,
// já existente no banco), num bloco JSON marcado — assim não exigimos nenhuma coluna nova
// no Supabase nem corremos o risco de serem sobrescritos pela tela de Anamnese clínica
// (que grava em "anamnese"/tabela "anamneses", reconstruindo o objeto do zero).
const PT_META_INICIO = '<!--RWDENT_META:';
const PT_META_FIM = ':RWDENT_META-->';

function ptParseNotas(notasRaw){
  const raw = notasRaw||'';
  const i = raw.indexOf(PT_META_INICIO);
  const j = raw.indexOf(PT_META_FIM);
  if(i===-1 || j===-1 || j<i) return { texto: raw.trim(), meta: {} };
  const jsonStr = raw.slice(i+PT_META_INICIO.length, j);
  const texto = (raw.slice(0,i)+raw.slice(j+PT_META_FIM.length)).trim();
  let meta = {};
  try { meta = JSON.parse(jsonStr)||{}; } catch(e){ meta = {}; }
  return { texto, meta };
}

function ptBuildNotas(texto, meta){
  const temMeta = (meta.responsavel && (meta.responsavel.nome||meta.responsavel.telefone||meta.responsavel.cpf||meta.responsavel.parentesco))
                || (meta.emergencia && (meta.emergencia.nome||meta.emergencia.telefone||meta.emergencia.parentesco));
  if(!temMeta) return (texto||'').trim();
  return (texto||'').trim() + (texto?'\n\n':'') + PT_META_INICIO + JSON.stringify(meta) + PT_META_FIM;
}

function readPatientForm(){
  const responsavel = {
    nome:document.getElementById('pt-resp-nome').value.trim(),
    parentesco:document.getElementById('pt-resp-parentesco').value.trim(),
    cpf:document.getElementById('pt-resp-cpf').value.trim(),
    telefone:document.getElementById('pt-resp-telefone').value.trim()
  };
  const emergencia = {
    nome:document.getElementById('pt-emerg-nome').value.trim(),
    parentesco:document.getElementById('pt-emerg-parentesco').value.trim(),
    telefone:document.getElementById('pt-emerg-telefone').value.trim()
  };
  const textoNotas = document.getElementById('pt-notas').value.trim();
  const notas = ptBuildNotas(textoNotas, {responsavel, emergencia});
  return {
    nome:document.getElementById('pt-nome').value.trim(),
    nascimento:document.getElementById('pt-nascimento').value,
    telefone:document.getElementById('pt-telefone').value.trim(),
    email:document.getElementById('pt-email').value.trim(),
    plano:document.getElementById('pt-plano').value.trim(),
    cpf:document.getElementById('pt-cpf').value.trim(),
    notas,
    _responsavel: responsavel, // só para validação em memória, não vai pro banco
  };
}

function resetPatientForm(){
  ['pt-nome','pt-nascimento','pt-telefone','pt-email','pt-plano','pt-cpf','pt-notas',
   'pt-resp-nome','pt-resp-parentesco','pt-resp-cpf','pt-resp-telefone',
   'pt-emerg-nome','pt-emerg-parentesco','pt-emerg-telefone'].forEach(id=>document.getElementById(id).value='');
  const alerta = document.getElementById('pt-menor-alerta'); if(alerta) alerta.style.display='none';
  const obrig  = document.getElementById('pt-resp-obrig');   if(obrig) obrig.style.display='none';
}

async function adicionarPaciente(){
  const dados=readPatientForm();
  if(!dados.nome){ showToast('Preencha o nome do paciente.','warn'); return; }
  if(dados.cpf && !validarCPF(dados.cpf)){ showToast('CPF inválido. Verifique os números.','warn'); document.getElementById('pt-cpf').focus(); return; }
  if(ptCheckMenor() && !dados._responsavel.nome){
    showToast('Paciente menor de idade: preencha o nome do responsável.','warn');
    document.getElementById('pt-resp-nome').focus();
    return;
  }
  delete dados._responsavel;
  showLoading(true);
  const { data:novo, error } = await _sb.from('pacientes').insert([{...dados, clinica_id: clinicaId}]).select().single();
  showLoading(false);
  if(error){ showToast('Erro: '+error.message,'error'); return; }
  novo.prontuarios=[]; pacientes.push(novo);
  resetPatientForm(); togglePatientForm();
  renderPatients(); renderScheduleOptions(); renderHomeStats();
  logAtividade('Paciente adicionado', dados.nome);
  showToast('Paciente adicionado.');
}

function renderPatientDropdown(){
  const input = document.getElementById('busca-paciente');
  const dropdown = document.getElementById('pac-dropdown');
  if(!input || !dropdown) return;
  const busca = input.value.toLowerCase().trim();
  if(!busca){ dropdown.style.display='none'; return; }
  const _mostrarArq = document.getElementById('pac-mostrar-arquivados')?.checked;
  const filtrados = pacientes.filter(p =>
    (_mostrarArq || !p.arquivado) &&
    (_norm(p.nome).includes(_norm(busca)) ||
    (p.cpf||'').includes(busca) ||
    (p.telefone||'').includes(busca))
  ).slice(0,10);
  if(!filtrados.length){
    dropdown.innerHTML = `<div style="padding:14px;text-align:center;font-size:13px;color:var(--rose-text);"><i class="ti ti-user-off"></i> Nenhum paciente encontrado.</div>`;
    dropdown.style.display='block'; return;
  }
  dropdown.innerHTML = filtrados.map(p=>`
    <div onmousedown="abrirPacienteDetalhe(${p.id})"
      style="display:flex;align-items:center;gap:10px;padding:10px 14px;cursor:pointer;border-bottom:1px solid var(--rose-light);transition:background .15s;"
      onmouseover="this.style.background='#fdf0ec'" onmouseout="this.style.background=''">
      <div style="width:36px;height:36px;border-radius:10px;background:#${hashColor(p.nome)};display:grid;place-items:center;color:#fff;font-weight:800;font-size:13px;flex-shrink:0;">${initials(p.nome)}</div>
      <div style="flex:1;min-width:0;">
        <div style="font-size:13px;font-weight:700;color:var(--rose-dark);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(p.nome)}${p.arquivado?' <span style="background:#fca5a5;color:#7f1d1d;font-size:9px;padding:1px 6px;border-radius:4px;font-weight:700;">ARQUIVADO</span>':''}</div>
        <div style="font-size:11px;color:var(--rose-text);">${escapeHtml(p.telefone||'Sem telefone')}${p.cpf?' · '+escapeHtml(p.cpf):''}</div>
      </div>
      <i class="ti ti-chevron-right" style="color:var(--rose-light);font-size:15px;flex-shrink:0;"></i>
    </div>
  `).join('');
  // remove última borda
  const items = dropdown.querySelectorAll('div[onmousedown]');
  if(items.length) items[items.length-1].style.borderBottom='none';
  dropdown.style.display='block';
}

function renderPatients(){
  // mantida para compatibilidade com outras chamadas internas
  renderPatientDropdown();
}


function abrirPacienteDetalhe(id){
  selectedPatientId = id;
  const dropdown = document.getElementById('pac-dropdown');
  if(dropdown) dropdown.style.display='none';
  document.getElementById('lista-pacientes').style.display = 'none';
  document.getElementById('btn-novo-paciente') && (document.getElementById('btn-novo-paciente').style.display='none');
  renderPatientDetail();
}

function voltarListaPacientes(){
  selectedPatientId = null;
  document.getElementById('painel-paciente').style.display = 'none';
  document.getElementById('lista-pacientes').style.display = 'none';
  const busca = document.getElementById('busca-paciente');
  if(busca){ busca.value=''; busca.style.display=''; }
  const dropdown = document.getElementById('pac-dropdown');
  if(dropdown) dropdown.style.display='none';
}

function selectPatient(id){ abrirPacienteDetalhe(id); }

function pacPeriodontiaSvg(){
  const sup = [
    [18,28,118,12,18],[17,39,91,13,18],[16,55,68,15,17],[15,75,50,13,16],
    [14,98,38,12,15],[13,122,28,11,18],[12,148,22,10,18],[11,176,18,11,19],
    [21,204,18,11,19],[22,232,22,10,18],[23,258,28,11,18],[24,282,38,12,15],
    [25,305,50,13,16],[26,325,68,15,17],[27,341,91,13,18],[28,352,118,12,18]
  ];
  const inf = [
    [48,32,242,14,18],[47,48,266,14,18],[46,67,286,15,18],[45,90,304,13,16],
    [44,114,316,12,15],[43,139,327,11,18],[42,164,336,10,18],[41,190,340,10,19],
    [31,214,340,10,19],[32,240,336,10,18],[33,265,327,11,18],[34,290,316,12,15],
    [35,314,304,13,16],[36,337,286,15,18],[37,356,266,14,18],[38,372,242,14,18]
  ];
  const tooth = ([n,x,y,rx,ry]) => `<g>
    <ellipse class="tooth" cx="${x}" cy="${y}" rx="${rx}" ry="${ry}"/>
    <path class="groove" d="M${x-rx*.55} ${y} C${x-rx*.2} ${y-ry*.2} ${x+rx*.2} ${y-ry*.2} ${x+rx*.55} ${y}"/>
    <text class="num" x="${x}" y="${y + (y < 180 ? -22 : 28)}" text-anchor="middle">${n}</text>
  </g>`;
  return `<svg class="perio-mouth" viewBox="0 0 400 380" role="img" aria-label="Registro periodontal por sextantes">
    <path class="gum" d="M35 138 C46 48 142 14 200 14 C258 14 354 48 365 138 C370 172 350 198 316 202 C260 198 232 180 200 180 C168 180 140 198 84 202 C50 198 30 172 35 138 Z"/>
    <path class="gum" d="M35 238 C46 332 142 366 200 366 C258 366 354 332 365 238 C370 204 350 182 316 178 C260 182 232 200 200 200 C168 200 140 182 84 178 C50 182 30 204 35 238 Z"/>
    <path class="gum-soft" d="M67 137 C83 65 150 39 200 39 C250 39 317 65 333 137 C302 128 258 120 200 120 C142 120 98 128 67 137 Z"/>
    <path class="gum-soft" d="M67 243 C83 315 150 341 200 341 C250 341 317 315 333 243 C302 252 258 260 200 260 C142 260 98 252 67 243 Z"/>
    <path id="pac-perio-z-S1" class="perio-zone" onclick="pacPerioToggleSextant('S1')" title="Sextante S1" d="M49 137 C56 82 92 48 125 33 L147 96 C123 102 101 116 84 144 Z"/>
    <path id="pac-perio-z-S2" class="perio-zone" onclick="pacPerioToggleSextant('S2')" title="Sextante S2" d="M125 33 C169 14 231 14 275 33 L253 96 C221 86 179 86 147 96 Z"/>
    <path id="pac-perio-z-S3" class="perio-zone" onclick="pacPerioToggleSextant('S3')" title="Sextante S3" d="M275 33 C308 48 344 82 351 137 L316 144 C299 116 277 102 253 96 Z"/>
    <path id="pac-perio-z-S6" class="perio-zone" onclick="pacPerioToggleSextant('S6')" title="Sextante S6" d="M49 243 C56 298 92 332 125 347 L147 284 C123 278 101 264 84 236 Z"/>
    <path id="pac-perio-z-S5" class="perio-zone" onclick="pacPerioToggleSextant('S5')" title="Sextante S5" d="M125 347 C169 366 231 366 275 347 L253 284 C221 294 179 294 147 284 Z"/>
    <path id="pac-perio-z-S4" class="perio-zone" onclick="pacPerioToggleSextant('S4')" title="Sextante S4" d="M275 347 C308 332 344 298 351 243 L316 236 C299 264 277 278 253 284 Z"/>
    <path class="line" d="M200 180 L125 33 M200 180 L275 33 M200 200 L125 347 M200 200 L275 347"/>
    ${sup.map(tooth).join('')}
    ${inf.map(tooth).join('')}
    <text class="label" x="105" y="122" text-anchor="middle">S1</text>
    <text class="label" x="200" y="82" text-anchor="middle">S2</text>
    <text class="label" x="295" y="144" text-anchor="middle">S3</text>
    <text class="label" x="295" y="244" text-anchor="middle">S4</text>
    <text class="label" x="200" y="292" text-anchor="middle">S5</text>
    <text class="label" x="105" y="244" text-anchor="middle">S6</text>
    <text class="num" x="200" y="10" text-anchor="middle">FRENTE</text>
    <text class="num" x="18" y="193" text-anchor="middle">DIREITA</text>
    <text class="num" x="382" y="193" text-anchor="middle">ESQUERDA</text>
  </svg>`;
}

function renderPatientDetail(abaAtiva){
  abaAtiva = abaAtiva || 'info';
  const panel=document.getElementById('painel-paciente');
  const p=pacientes.find(pt=>pt.id===selectedPatientId);
  if(!p){ panel.style.display='none'; return; }
  // Esconde lista, mostra detalhe em tela cheia
  document.getElementById('lista-pacientes').style.display='none';
  panel.style.display='';
  panel.innerHTML=`
    <div class="card">
      <!-- HEADER -->
      <div class="section-header">
        <div style="display:flex;align-items:center;gap:14px;">
          <div class="home-row-avatar" style="width:52px;height:52px;font-size:18px;border-radius:14px;background:#${hashColor(p.nome||'?')};flex-shrink:0;">${initials(p.nome)}</div>
          <div>
            <h2>${escapeHtml(p.nome)} ${calcIdade(p.nascimento)!==null && calcIdade(p.nascimento)<18 ? '<span class="fin-badge danger" style="font-size:10px;">MENOR DE IDADE</span>' : ''}</h2>
            <p style="color:var(--rose-text);margin-top:4px;font-size:13px;">${escapeHtml(p.plano||'Sem plano')} · ${p.nascimento?'Nasc. '+formatDate(p.nascimento)+(calcIdade(p.nascimento)!==null?' ('+calcIdade(p.nascimento)+' anos)':''):''}</p>
          </div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button class="btn-secondary" style="background:#e8f5e9;border-color:#a5d6a7;color:#2e7d32;" onclick="agendarDoProntuario(${p.id})"><i class="ti ti-calendar-plus"></i> Agendar</button>
          <button class="btn-secondary" onclick="editPatient(${p.id})"><i class="ti ti-pencil"></i> Editar</button>
          ${p.arquivado ? `<button class="btn-secondary" style="background:#e8f5e9;border-color:#a5d6a7;color:#2e7d32;" onclick="restaurarPaciente(${p.id})"><i class="ti ti-refresh"></i> Restaurar</button>` : `<button class="btn-secondary" style="color:#dc2626;border-color:#fca5a5;" onclick="arquivarPaciente(${p.id})"><i class="ti ti-archive"></i> Arquivar</button>`}
          <button class="btn-secondary" onclick="voltarListaPacientes()"><i class="ti ti-arrow-left"></i> Voltar</button>
        </div>
      </div>

      <!-- ABAS DO PACIENTE -->
      <div class="pac-tabs">
        <button class="pac-tab ${abaAtiva==='info'?'active':''}" onclick="renderPatientDetail('info')"><i class="ti ti-info-circle"></i> Dados</button>
        <button class="pac-tab ${abaAtiva==='anamnese'?'active':''}" onclick="renderPatientDetail('anamnese')"><i class="ti ti-clipboard-heart"></i> Anamnese</button>
        <button class="pac-tab ${abaAtiva==='historico'?'active':''}" onclick="renderPatientDetail('historico')"><i class="ti ti-history"></i> Histórico</button>
        <button class="pac-tab ${abaAtiva==='odonto'?'active':''}" onclick="renderPatientDetail('odonto')"><i class="ti ti-tooth"></i> Odontograma</button>
        <button class="pac-tab ${abaAtiva==='plano'?'active':''}" onclick="renderPatientDetail('plano')"><i class="ti ti-clipboard-list"></i> Plano</button>
        <button class="pac-tab ${abaAtiva==='orcamentos'?'active':''}" onclick="renderPatientDetail('orcamentos')"><i class="ti ti-receipt"></i> Orçamentos</button>
        <button class="pac-tab ${abaAtiva==='procs'?'active':''}" onclick="renderPatientDetail('procs')"><i class="ti ti-check"></i> Realizados</button>
        <button class="pac-tab ${abaAtiva==='financeiro'?'active':''}" onclick="renderPatientDetail('financeiro')"><i class="ti ti-cash"></i> Financeiro</button>
        <button class="pac-tab ${abaAtiva==='termo'?'active':''}" onclick="renderPatientDetail('termo')"><i class="ti ti-file-signature"></i> Termo</button>
        <button class="pac-tab ${abaAtiva==='galeria'?'active':''}" onclick="renderPatientDetail('galeria')"><i class="ti ti-photo"></i> Galeria</button>
        <button class="pac-tab ${abaAtiva==='timeline'?'active':''}" onclick="renderPatientDetail('timeline')"><i class="ti ti-timeline-event"></i> Timeline</button>
      </div>

      <!-- ABA: DADOS -->
      <div id="pac-aba-info" style="display:${abaAtiva==='info'?'':'none'};">
        ${(()=>{ const _pn = ptParseNotas(p.notas); return `
        <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:10px;font-size:13px;margin-top:14px;">
          <div><strong>CPF:</strong> ${escapeHtml(p.cpf||'-')}</div>
          <div><strong>Tel:</strong> ${escapeHtml(p.telefone||'-')}</div>
          <div><strong>E-mail:</strong> ${escapeHtml(p.email||'-')}</div>
          <div><strong>Plano:</strong> ${escapeHtml(p.plano||'-')}</div>
          ${_pn.texto?`<div style="grid-column:span 2"><strong>Obs:</strong> ${escapeHtml(_pn.texto)}</div>`:''}
        </div>
        ${(_pn.meta.responsavel?.nome||(calcIdade(p.nascimento)!==null&&calcIdade(p.nascimento)<18)) ? `
        <div style="margin-top:16px;background:var(--rose-lighter);border-radius:10px;padding:12px;">
          <div style="font-size:12px;font-weight:700;color:var(--rose-dark);margin-bottom:8px;display:flex;align-items:center;gap:6px;"><i class="ti ti-user-shield"></i> Responsável</div>
          <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:8px;font-size:13px;">
            <div><strong>Nome:</strong> ${escapeHtml(_pn.meta.responsavel?.nome||'-')}</div>
            <div><strong>Parentesco:</strong> ${escapeHtml(_pn.meta.responsavel?.parentesco||'-')}</div>
            <div><strong>CPF:</strong> ${escapeHtml(_pn.meta.responsavel?.cpf||'-')}</div>
            <div><strong>Telefone:</strong> ${escapeHtml(_pn.meta.responsavel?.telefone||'-')}</div>
          </div>
        </div>` : ''}
        ${(_pn.meta.emergencia?.nome||_pn.meta.emergencia?.telefone) ? `
        <div style="margin-top:12px;background:#fff8e1;border-radius:10px;padding:12px;">
          <div style="font-size:12px;font-weight:700;color:#856404;margin-bottom:8px;display:flex;align-items:center;gap:6px;"><i class="ti ti-phone-call"></i> Contato de emergência</div>
          <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:8px;font-size:13px;">
            <div><strong>Nome:</strong> ${escapeHtml(_pn.meta.emergencia?.nome||'-')}</div>
            <div><strong>Relação:</strong> ${escapeHtml(_pn.meta.emergencia?.parentesco||'-')}</div>
            <div style="grid-column:span 2"><strong>Telefone:</strong> ${escapeHtml(_pn.meta.emergencia?.telefone||'-')}</div>
          </div>
        </div>` : ''}
        `; })()}
        ${(()=>{
          const hoje_iso = hoje();
          const proximas = agendamentos.filter(a=>a.paciente_id===p.id && a.data>=hoje_iso).sort((a,b)=>a.data.localeCompare(b.data)||a.horario.localeCompare(b.horario)).slice(0,5);
          if(!proximas.length) return '';
          return `<div style="margin-top:16px;border:1.5px solid var(--rose-light);border-radius:12px;overflow:hidden;">
            <div style="background:var(--rose-lighter);padding:10px 14px;font-size:12px;font-weight:800;color:var(--rose-dark);display:flex;align-items:center;gap:6px;">
              <i class="ti ti-calendar-event"></i> Próximas Consultas
            </div>
            ${proximas.map(a=>`<div style="display:flex;align-items:center;gap:10px;padding:10px 14px;border-top:1px solid var(--rose-light);font-size:13px;">
              <div style="text-align:center;background:var(--rose-lighter);border-radius:8px;padding:4px 8px;min-width:44px;flex-shrink:0;">
                <div style="font-size:10px;font-weight:700;color:var(--rose-text);">${new Date(a.data+'T12:00').toLocaleDateString('pt-BR',{month:'short'}).toUpperCase()}</div>
                <div style="font-size:18px;font-weight:900;color:var(--rose-dark);line-height:1;">${new Date(a.data+'T12:00').getDate()}</div>
              </div>
              <div style="flex:1;min-width:0;">
                <div style="font-weight:700;color:#3a2020;">${escapeHtml(a.procedimento||'Consulta')}</div>
                <div style="font-size:11px;color:var(--rose-text);">${a.horario} · ${escapeHtml(a.prof_nome||'')}</div>
              </div>
            </div>`).join('')}
          </div>`;
        })()}
      </div>

      <!-- ABA: ANAMNESE -->
      <div id="pac-aba-anamnese" style="display:${abaAtiva==='anamnese'?'':'none'};">
        <div style="margin-top:14px;" id="pac-anam-body">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;flex-wrap:wrap;gap:8px;">
            <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
              <span style="font-size:13px;font-weight:700;color:var(--rose-dark);"><i class="ti ti-clipboard-heart"></i> Anamnese</span>
              ${(()=>{
                const hasData = p.anamnese && Object.keys(p.anamnese).length>0;
                if(hasData) return '<span style="background:#e8f5e9;color:#2e7d32;font-size:10px;padding:2px 8px;border-radius:6px;font-weight:700;">RECEBIDA</span>';
                const linkInfo = p._anamneseLink;
                if(linkInfo && linkInfo.used_at) return '<span style="background:#e8f5e9;color:#2e7d32;font-size:10px;padding:2px 8px;border-radius:6px;font-weight:700;">RECEBIDA</span>';
                if(linkInfo && new Date(linkInfo.expires_at) < new Date()) return '<span style="background:#fef3c7;color:#92400e;font-size:10px;padding:2px 8px;border-radius:6px;font-weight:700;">EXPIRADA</span>';
                if(linkInfo) return '<span style="background:#dbeafe;color:#1e40af;font-size:10px;padding:2px 8px;border-radius:6px;font-weight:700;">ENVIADA</span>';
                return '<span style="background:#fef3c7;color:#92400e;font-size:10px;padding:2px 8px;border-radius:6px;font-weight:700;">PENDENTE</span>';
              })()}
            </div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;">
              <button class="btn-secondary" onclick="anamneseEnviarWhatsApp(${p.id})" style="background:#25d366;color:#fff;border-color:#25d366;font-size:12px;padding:6px 12px;border-radius:8px;"><i class="ti ti-brand-whatsapp"></i> ${p._anamneseLink?'Reenviar':'Enviar'} por WhatsApp</button>
              <button class="btn-primary" onclick="anamneseSalvar(${p.id})"><i class="ti ti-device-floppy"></i> Salvar</button>
            </div>
          </div>

          <!-- ── SEÇÃO 1: ANAMNESE ── -->
          <div style="border:1.5px solid var(--rose-light);border-radius:12px;padding:16px;margin-bottom:14px;background:#fff;">
            <div style="font-size:12px;font-weight:800;color:var(--rose-dark);text-transform:uppercase;letter-spacing:.5px;margin-bottom:14px;border-bottom:1px solid var(--rose-light);padding-bottom:8px;">📋 Anamnese</div>

            <div class="form-group" style="margin-bottom:12px;">
              <label>Queixa principal</label>
              <textarea id="an-queixa" rows="2" placeholder="Descreva a queixa principal do paciente..." style="resize:vertical;">${escapeHtml(p.anamnese?.queixa||'')}</textarea>
            </div>

            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px;" class="an-grid-2">
              <div class="form-group">
                <label>Uso de medicação</label>
                <div style="display:flex;gap:8px;margin-top:4px;">
                  <label style="display:flex;align-items:center;gap:5px;font-size:13px;font-weight:400;text-transform:none;letter-spacing:0;cursor:pointer;"><input type="radio" name="an-med" value="sim" ${p.anamnese?.medicacao==='sim'?'checked':''} onchange="anamneseToggle('an-med-qual','sim')"> Sim</label>
                  <label style="display:flex;align-items:center;gap:5px;font-size:13px;font-weight:400;text-transform:none;letter-spacing:0;cursor:pointer;"><input type="radio" name="an-med" value="nao" ${p.anamnese?.medicacao==='nao'||!p.anamnese?.medicacao?'checked':''} onchange="anamneseToggle('an-med-qual','nao')"> Não</label>
                </div>
                <input type="text" id="an-med-qual" placeholder="Qual medicação?" value="${escapeHtml(p.anamnese?.medicacaoQual||'')}" style="margin-top:6px;display:${p.anamnese?.medicacao==='sim'?'':'none'};"/>
              </div>
              <div class="form-group">
                <label>Alergia</label>
                <div style="display:flex;gap:8px;margin-top:4px;">
                  <label style="display:flex;align-items:center;gap:5px;font-size:13px;font-weight:400;text-transform:none;letter-spacing:0;cursor:pointer;"><input type="radio" name="an-alergia" value="sim" ${p.anamnese?.alergia==='sim'?'checked':''} onchange="anamneseToggle('an-alergia-qual','sim')"> Sim</label>
                  <label style="display:flex;align-items:center;gap:5px;font-size:13px;font-weight:400;text-transform:none;letter-spacing:0;cursor:pointer;"><input type="radio" name="an-alergia" value="nao" ${p.anamnese?.alergia==='nao'||!p.anamnese?.alergia?'checked':''} onchange="anamneseToggle('an-alergia-qual','nao')"> Não</label>
                </div>
                <input type="text" id="an-alergia-qual" placeholder="Qual alergia?" value="${escapeHtml(p.anamnese?.alergiaQual||'')}" style="margin-top:6px;display:${p.anamnese?.alergia==='sim'?'':'none'};"/>
              </div>
            </div>

            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px;" class="an-grid-2">
              <div class="form-group">
                <label>Pressão arterial</label>
                <div style="display:flex;gap:8px;margin-top:4px;flex-wrap:wrap;">
                  ${['alta','baixa','normal'].map(v=>`<label style="display:flex;align-items:center;gap:5px;font-size:13px;font-weight:400;text-transform:none;letter-spacing:0;cursor:pointer;"><input type="radio" name="an-pa-tipo" value="${v}" ${p.anamnese?.paTipo===v?'checked':''}> ${v.charAt(0).toUpperCase()+v.slice(1)}</label>`).join('')}
                </div>
              </div>
              <div class="form-group">
                <label>PA (mmHg)</label>
                <input type="text" id="an-pa" placeholder="Ex: 120/80" value="${escapeHtml(p.anamnese?.pa||'')}"/>
              </div>
            </div>

            <!-- DOENÇAS -->
            <div style="margin-bottom:12px;">
              <label style="display:block;margin-bottom:8px;">Sofre ou sofreu alguma dessas doenças?</label>
              <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:6px;">
                ${[['anemia','Anemia'],['diabete','Diabete'],['respiratoria','Respiratória'],['osteoporose','Osteoporose'],['sifilis','Sífilis'],['hiv','HIV'],['epilepsia','Epilepsia'],['cancer','Câncer'],['cardiaco','Problemas cardíacos'],['febreReumatica','Febre reumática'],['hemorragia','Hemorragia'],['hepatite','Hepatite'],['hipertensao','Hipertensão'],['endocrino','Endócrino'],['herpes','Herpes'],['endocardite','Endocardite bacteriana'],['tuberculose','Tuberculose'],['afta','Afta'],['distPsicologico','Distúrbios psicológicos']].map(([k,l])=>`
                <label style="display:flex;align-items:center;gap:7px;font-size:13px;font-weight:400;text-transform:none;letter-spacing:0;cursor:pointer;background:var(--rose-lighter);border:1px solid var(--rose-light);border-radius:8px;padding:7px 10px;">
                  <input type="checkbox" id="an-d-${k}" ${(p.anamnese?.doencas||{})[k]?'checked':''} style="width:15px;height:15px;accent-color:var(--rose);flex-shrink:0;cursor:pointer;"> ${l}
                </label>`).join('')}
              </div>
              <div class="form-group" style="margin-top:10px;">
                <label>Especificar</label>
                <textarea id="an-doenca-esp" rows="2" placeholder="Detalhes sobre as doenças marcadas...">${escapeHtml(p.anamnese?.doencaEsp||'')}</textarea>
              </div>
            </div>

            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px;" class="an-grid-2">
              <div class="form-group">
                <label>Passou por alguma cirurgia?</label>
                <div style="display:flex;gap:8px;margin-top:4px;">
                  <label style="display:flex;align-items:center;gap:5px;font-size:13px;font-weight:400;text-transform:none;letter-spacing:0;cursor:pointer;"><input type="radio" name="an-cirurgia" value="sim" ${p.anamnese?.cirurgia==='sim'?'checked':''}> Sim</label>
                  <label style="display:flex;align-items:center;gap:5px;font-size:13px;font-weight:400;text-transform:none;letter-spacing:0;cursor:pointer;"><input type="radio" name="an-cirurgia" value="nao" ${p.anamnese?.cirurgia==='nao'||!p.anamnese?.cirurgia?'checked':''}> Não</label>
                </div>
              </div>
              <div class="form-group">
                <label>Quando se fere, sangramento é:</label>
                <div style="display:flex;gap:8px;margin-top:4px;">
                  <label style="display:flex;align-items:center;gap:5px;font-size:13px;font-weight:400;text-transform:none;letter-spacing:0;cursor:pointer;"><input type="radio" name="an-sangramento" value="normal" ${p.anamnese?.sangramento==='normal'||!p.anamnese?.sangramento?'checked':''}> Normal</label>
                  <label style="display:flex;align-items:center;gap:5px;font-size:13px;font-weight:400;text-transform:none;letter-spacing:0;cursor:pointer;"><input type="radio" name="an-sangramento" value="excessivo" ${p.anamnese?.sangramento==='excessivo'?'checked':''}> Excessivo</label>
                </div>
              </div>
              <div class="form-group">
                <label>Cicatrização:</label>
                <div style="display:flex;gap:8px;margin-top:4px;">
                  <label style="display:flex;align-items:center;gap:5px;font-size:13px;font-weight:400;text-transform:none;letter-spacing:0;cursor:pointer;"><input type="radio" name="an-cicatriz" value="normal" ${p.anamnese?.cicatriz==='normal'||!p.anamnese?.cicatriz?'checked':''}> Normal</label>
                  <label style="display:flex;align-items:center;gap:5px;font-size:13px;font-weight:400;text-transform:none;letter-spacing:0;cursor:pointer;"><input type="radio" name="an-cicatriz" value="complicada" ${p.anamnese?.cicatriz==='complicada'?'checked':''}> Complicada</label>
                </div>
              </div>
              <div class="form-group">
                <label>Gestante?</label>
                <div style="display:flex;gap:8px;margin-top:4px;flex-wrap:wrap;">
                  <label style="display:flex;align-items:center;gap:5px;font-size:13px;font-weight:400;text-transform:none;letter-spacing:0;cursor:pointer;"><input type="radio" name="an-gestante" value="sim" ${p.anamnese?.gestante==='sim'?'checked':''} onchange="anamneseToggle('an-gestante-semana','sim')"> Sim</label>
                  <label style="display:flex;align-items:center;gap:5px;font-size:13px;font-weight:400;text-transform:none;letter-spacing:0;cursor:pointer;"><input type="radio" name="an-gestante" value="nao" ${p.anamnese?.gestante==='nao'||!p.anamnese?.gestante?'checked':''} onchange="anamneseToggle('an-gestante-semana','nao')"> Não</label>
                </div>
                <input type="text" id="an-gestante-semana" placeholder="Período (semanas)" value="${escapeHtml(p.anamnese?.gestanteSemana||'')}" style="margin-top:6px;display:${p.anamnese?.gestante==='sim'?'':'none'};width:140px;"/>
              </div>
            </div>
          </div>

          <!-- ── SEÇÃO 2: PROBLEMA COM O PACIENTE ── -->
          <div style="border:1.5px solid var(--rose-light);border-radius:12px;padding:16px;margin-bottom:14px;background:#fff;">
            <div style="font-size:12px;font-weight:800;color:var(--rose-dark);text-transform:uppercase;letter-spacing:.5px;margin-bottom:14px;border-bottom:1px solid var(--rose-light);padding-bottom:8px;">🦷 Problema com o Paciente</div>

            <div class="an-grid-2" style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">

              ${[
                ['an-anest','an-anest','an-anest-nao','Teve reação com anestésico local?','anestesia','anestesiaNao'],
                ['an-dordente','an-dordente','an-dordente-nao','Sente dor nos dentes ou gengiva?','dorDente','dorDenteNao'],
                ['an-sangGeng','an-sangGeng','an-sangGeng-nao','Sangramento gengival?','sangGeng','sangGengNao'],
              ].map(([rname,,, lbl, k])=>`
              <div class="form-group" style="grid-column:${rname==='an-sangGeng'?'span 2':''};">
                <label>${lbl}</label>
                <div style="display:flex;gap:8px;margin-top:4px;">
                  <label style="display:flex;align-items:center;gap:5px;font-size:13px;font-weight:400;text-transform:none;letter-spacing:0;cursor:pointer;"><input type="radio" name="${rname}" value="sim" ${p.anamnese?.[k]==='sim'?'checked':''}> Sim</label>
                  <label style="display:flex;align-items:center;gap:5px;font-size:13px;font-weight:400;text-transform:none;letter-spacing:0;cursor:pointer;"><input type="radio" name="${rname}" value="nao" ${p.anamnese?.[k]==='nao'||!p.anamnese?.[k]?'checked':''}> Não</label>
                </div>
              </div>`).join('')}

              <div class="form-group">
                <label>Sangramento gengival — quando?</label>
                <input type="text" id="an-sangGeng-quando" placeholder="Ex: ao escovar" value="${escapeHtml(p.anamnese?.sangGengQuando||'')}"/>
              </div>

              ${[
                ['an-dormaxilar','Dor no maxilar ou ouvido?','dorMaxilar'],
                ['an-parasFunc','Tem hábitos parafuncionais?','parasFunc'],
                ['an-tatuagem','Tatuagem?','tatuagem'],
                ['an-fumante','Fumante?','fumante'],
              ].map(([rname,lbl,k])=>`
              <div class="form-group">
                <label>${lbl}</label>
                <div style="display:flex;gap:8px;margin-top:4px;">
                  <label style="display:flex;align-items:center;gap:5px;font-size:13px;font-weight:400;text-transform:none;letter-spacing:0;cursor:pointer;"><input type="radio" name="${rname}" value="sim" ${p.anamnese?.[k]==='sim'?'checked':''}> Sim</label>
                  <label style="display:flex;align-items:center;gap:5px;font-size:13px;font-weight:400;text-transform:none;letter-spacing:0;cursor:pointer;"><input type="radio" name="${rname}" value="nao" ${p.anamnese?.[k]==='nao'||!p.anamnese?.[k]?'checked':''}> Não</label>
                </div>
              </div>`).join('')}

              <div class="form-group">
                <label>Usa fio dental?</label>
                <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:4px;">
                  <label style="display:flex;align-items:center;gap:5px;font-size:13px;font-weight:400;text-transform:none;letter-spacing:0;cursor:pointer;white-space:nowrap;"><input type="radio" name="an-fio" value="sim" ${p.anamnese?.fio==='sim'?'checked':''}> Sim</label>
                  <label style="display:flex;align-items:center;gap:5px;font-size:13px;font-weight:400;text-transform:none;letter-spacing:0;cursor:pointer;white-space:nowrap;"><input type="radio" name="an-fio" value="nao" ${p.anamnese?.fio==='nao'||!p.anamnese?.fio?'checked':''}> Não</label>
                  <label style="display:flex;align-items:center;gap:5px;font-size:13px;font-weight:400;text-transform:none;letter-spacing:0;cursor:pointer;white-space:nowrap;"><input type="radio" name="an-fio" value="asvezes" ${p.anamnese?.fio==='asvezes'?'checked':''}> Às vezes</label>
                </div>
              </div>

              <div class="form-group">
                <label>Gosto ruim ou boca seca?</label>
                <div style="display:flex;gap:8px;margin-top:4px;">
                  <label style="display:flex;align-items:center;gap:5px;font-size:13px;font-weight:400;text-transform:none;letter-spacing:0;cursor:pointer;"><input type="radio" name="an-bocaseca" value="sim" ${p.anamnese?.bocaSeca==='sim'?'checked':''}> Sim</label>
                  <label style="display:flex;align-items:center;gap:5px;font-size:13px;font-weight:400;text-transform:none;letter-spacing:0;cursor:pointer;"><input type="radio" name="an-bocaseca" value="nao" ${p.anamnese?.bocaSeca==='nao'||!p.anamnese?.bocaSeca?'checked':''}> Não</label>
                </div>
              </div>

              <div class="form-group">
                <label>Escova os dentes quantas vezes ao dia?</label>
                <input type="number" id="an-escovacoes" min="0" max="10" placeholder="Ex: 3" value="${p.anamnese?.escovacoes||''}"/>
              </div>

              <div class="form-group">
                <label>Último tratamento odontológico</label>
                <input type="text" id="an-ultimo-trat" placeholder="Ex: há 6 meses, limpeza..." value="${escapeHtml(p.anamnese?.ultimoTrat||'')}"/>
              </div>

              <div class="form-group" style="grid-column:span 2;">
                <label>Antecedentes familiares</label>
                <textarea id="an-antec-fam" rows="2" placeholder="Doenças relevantes na família...">${escapeHtml(p.anamnese?.antecFam||'')}</textarea>
              </div>
            </div>
          </div>

          ${renderAnamneseSignArea(p.id, p.nome, (profissionais.find(pr=>pr.id==p.anamnese?.profissionalId)?.nome)||'', (profissionais.find(pr=>pr.id==p.anamnese?.profissionalId)?.cro)||'', p.anamnese?.assinaturas||{})}

          <div style="display:flex;justify-content:flex-end;margin-top:4px;">
            <button class="btn-primary" onclick="anamneseSalvar(${p.id})"><i class="ti ti-device-floppy"></i> Salvar anamnese</button>
          </div>
        </div>
      </div>

      <!-- ABA: HISTÓRICO -->
      <div id="pac-aba-historico" style="display:${abaAtiva==='historico'?'':'none'};">
        <div style="margin-top:14px;">
          <p style="font-size:13px;color:var(--rose-text);margin-bottom:14px;">
            <i class="ti ti-info-circle"></i> Adicione procedimentos anteriores do paciente. Ideal para registrar histórico de pacientes antigos.
          </p>

          <!-- Formulário de histórico rápido -->
          <div style="border:1.5px solid var(--rose-light);border-radius:12px;padding:14px;margin-bottom:14px;background:#fdfaf9;">
            <div style="font-size:13px;font-weight:700;color:var(--rose-dark);margin-bottom:12px;"><i class="ti ti-plus"></i> Adicionar procedimento ao histórico</div>
            <div class="form-grid">
              <div class="form-group">
                <label>Data do procedimento</label>
                <input type="date" id="hist-data" value="${hoje()}"/>
              </div>
              <div class="form-group">
                <label>Profissional</label>
                <select id="hist-prof">
                  <option value="">Selecione</option>
                  ${profissionais.map(pr=>`<option value="${pr.id}">${escapeHtml(pr.nome)}</option>`).join('')}
                </select>
              </div>
              <div class="form-group full" style="min-width:0;">
                <label>Clique em cada dente para marcar o que foi feito nele</label>
                <div id="hist-odonto-wrap" style="overflow-x:auto;padding:6px 0;max-width:100%;">
                  <div id="hist-dentes-sel" style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px;min-height:24px;"></div>
                  <div style="font-size:11px;color:var(--rose-text);margin-bottom:4px;">Permanentes superiores:</div>
                  <div style="display:flex;gap:3px;flex-wrap:nowrap;width:max-content;padding-bottom:4px;">
                    ${[18,17,16,15,14,13,12,11,21,22,23,24,25,26,27,28].map(d=>`<button type="button" data-hist-dente="${d}" onclick="histAbrirDente(${d})" style="min-width:30px;height:30px;border:1.5px solid var(--rose-light);border-radius:5px;background:#fff;font-size:10px;cursor:pointer;flex-shrink:0;position:relative;">${d}</button>`).join('')}
                  </div>
                  <div style="font-size:11px;color:var(--rose-text);margin:4px 0;">Permanentes inferiores:</div>
                  <div style="display:flex;gap:3px;flex-wrap:nowrap;width:max-content;padding-bottom:4px;">
                    ${[48,47,46,45,44,43,42,41,31,32,33,34,35,36,37,38].map(d=>`<button type="button" data-hist-dente="${d}" onclick="histAbrirDente(${d})" style="min-width:30px;height:30px;border:1.5px solid var(--rose-light);border-radius:5px;background:#fff;font-size:10px;cursor:pointer;flex-shrink:0;">${d}</button>`).join('')}
                  </div>
                  <div style="font-size:11px;color:var(--rose-text);margin:4px 0;">Decíduos:</div>
                  <div style="display:flex;gap:3px;flex-wrap:nowrap;width:max-content;">
                    ${[55,54,53,52,51,61,62,63,64,65,85,84,83,82,81,71,72,73,74,75].map(d=>`<button type="button" data-hist-dente="${d}" onclick="histAbrirDente(${d})" style="min-width:30px;height:30px;border:1.5px solid var(--rose-light);border-radius:5px;background:#fff;font-size:10px;cursor:pointer;flex-shrink:0;">${d}</button>`).join('')}
                  </div>
                </div>
                <!-- Painel do dente selecionado -->
                <div id="hist-dente-painel" style="display:none;border:1.5px solid var(--rose);border-radius:12px;padding:14px;margin-top:10px;background:var(--rose-lighter);">
                  <div style="font-size:13px;font-weight:700;color:var(--rose-dark);margin-bottom:10px;">🦷 Dente <span id="hist-dente-num"></span> — O que foi feito?</div>
                  <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px;">
                    ${[['restaurado','🔵','Restaurado'],['canal','🟡','Canal'],['coroa','🔷','Coroa'],['extraido','⬜','Extraído'],['implante','🟣','Implante'],['carie','🔴','Cárie'],['selante','🩵','Selante'],['higido','⚪','Hígido'],['fratura','🟠','Fratura'],['outro','⚫','Outro']].map(([v,ic,l])=>`
                      <div data-dcond-wrap="${v}" style="display:inline-flex;align-items:center;border:2px solid var(--rose-light);border-radius:10px;overflow:hidden;background:#fff;">
                        <button type="button" onclick="histDenteToggleCond('${v}')" style="padding:5px 10px;border:none;background:transparent;cursor:pointer;font-size:12px;font-weight:600;color:#3a2020;">${ic} ${l}</button>
                        <div data-dcond-qtd-wrap="${v}" style="display:none;align-items:center;gap:2px;padding-right:6px;">
                          <button type="button" onclick="histDenteCondQtd('${v}',-1)" style="border:none;background:var(--rose-lighter);border-radius:4px;width:20px;height:20px;cursor:pointer;font-size:13px;font-weight:700;color:var(--rose-dark);">−</button>
                          <span data-dcond-num="${v}" style="min-width:18px;text-align:center;font-size:12px;font-weight:800;color:var(--rose-dark);">1</span>
                          <button type="button" onclick="histDenteCondQtd('${v}',+1)" style="border:none;background:var(--rose-lighter);border-radius:4px;width:20px;height:20px;cursor:pointer;font-size:13px;font-weight:700;color:var(--rose-dark);">+</button>
                        </div>
                      </div>`).join('')}
                  </div>
                  <div style="display:flex;gap:8px;">
                    <button class="btn-primary" style="flex:1;justify-content:center;" onclick="histConfirmarDente()"><i class="ti ti-check"></i> Confirmar dente</button>
                    <button class="btn-secondary" onclick="histFecharDente()">Cancelar</button>
                  </div>
                </div>
                <input type="hidden" id="hist-dentes"/>
              </div>
              <div class="form-group full">
                <label>Procedimentos realizados</label>
                <div id="hist-procs-tags" style="display:flex;flex-wrap:wrap;gap:6px;min-height:32px;margin-bottom:8px;"></div>
                <div style="display:flex;gap:6px;">
                  <input type="text" id="hist-proc" placeholder="Digite ou escolha..." style="flex:1;" onkeydown="if(event.key==='Enter'){event.preventDefault();histAdicionarProcDigitado();}"/>
                  <button type="button" onclick="histAdicionarProcDigitado()" style="background:#fff;color:var(--rose-dark);border:1.5px solid var(--rose);border-radius:8px;padding:8px 10px;cursor:pointer;font-size:13px;white-space:nowrap;">+ Add</button>
                  <button type="button" onclick="histAbrirSelectProc()" style="background:var(--rose);color:#fff;border:none;border-radius:8px;padding:8px 12px;cursor:pointer;font-size:13px;white-space:nowrap;"><i class="ti ti-list"></i> Lista</button>
                </div>
                <div id="hist-proc-opcoes" style="display:none;border:1.5px solid var(--rose-light);border-radius:10px;background:#fff;margin-top:6px;max-height:200px;overflow-y:auto;box-shadow:0 4px 16px rgba(0,0,0,.1);"></div>
                <input type="hidden" id="hist-procs-hidden"/>
              </div>
              <div class="form-group full">
                <label>Observações</label>
                <textarea id="hist-obs" rows="2" placeholder="Detalhes adicionais..."></textarea>
              </div>
            </div>
            <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:10px;flex-wrap:wrap;">
              <button class="btn-secondary" onclick="histLimpar()"><i class="ti ti-eraser"></i> Limpar</button>
              <button class="btn-secondary" onclick="histSalvarEIrOdonto(${p.id})"><i class="ti ti-tooth"></i> Salvar e ir ao Odontograma</button>
              <button class="btn-primary" onclick="histSalvar(${p.id})"><i class="ti ti-check"></i> Salvar no histórico</button>
            </div>
          </div>

          <!-- Lista do histórico -->
          <div id="pac-hist-lista"></div>
        </div>
      </div>

      <!-- ABA: ODONTOGRAMA -->
      <div id="pac-aba-odonto" style="display:${abaAtiva==='odonto'?'':'none'};">
        <div class="odonto-subtabs">
          <button type="button" class="odonto-subtab active" data-pac-odonto-subtab="odontograma" onclick="pacOdontoSubtab('odontograma')">Odontograma</button>
          <button type="button" class="odonto-subtab" data-pac-odonto-subtab="tecidos" onclick="pacOdontoSubtab('tecidos')">Tecidos moles e duros</button>
          <button type="button" class="odonto-subtab" data-pac-odonto-subtab="periodontia" onclick="pacOdontoSubtab('periodontia')">Periodontia</button>
        </div>
        <div id="pac-odonto-sub-odontograma" data-pac-odonto-sub style="margin-top:14px;">
          <div style="overflow-x:auto;padding:8px 0;">
            ${calcIdade(p.nascimento)!==null && calcIdade(p.nascimento)<13 ? `
            <div style="text-align:center;font-size:11px;font-weight:700;color:var(--rose-text);text-transform:uppercase;margin-bottom:6px;">Superior — Decíduos</div>
            <div class="odonto-arcada" id="pac-arc-dec-sup"></div>
            <div style="height:8px;"></div>
            ` : ''}
            <div style="text-align:center;font-size:11px;font-weight:700;color:var(--rose-text);text-transform:uppercase;margin-bottom:6px;">Superior — Permanentes</div>
            <div class="odonto-arcada" id="pac-arc-sup"></div>
            <div style="display:flex;align-items:center;gap:8px;margin:6px 0;">
              <div style="flex:1;height:1px;background:var(--rose-light);"></div>
              <span style="font-size:10px;color:var(--rose-text);font-weight:700;">DIR ←→ ESQ</span>
              <div style="flex:1;height:1px;background:var(--rose-light);"></div>
            </div>
            <div class="odonto-arcada" id="pac-arc-inf"></div>
            <div style="text-align:center;font-size:11px;font-weight:700;color:var(--rose-text);text-transform:uppercase;margin-top:6px;">Inferior — Permanentes</div>
            ${calcIdade(p.nascimento)!==null && calcIdade(p.nascimento)<13 ? `
            <div style="height:8px;"></div>
            <div class="odonto-arcada" id="pac-arc-dec-inf"></div>
            <div style="text-align:center;font-size:11px;font-weight:700;color:var(--rose-text);text-transform:uppercase;margin-top:6px;">Inferior — Decíduos</div>
            ` : ''}
          </div>
          <!-- legenda -->
          <div style="display:flex;flex-wrap:wrap;gap:12px;margin:10px 0;justify-content:center;align-items:center;" id="pac-odonto-legenda"></div>
          <!-- painel dente selecionado -->
          <div id="pac-dente-panel" style="display:none;border:2px solid var(--rose);border-radius:14px;padding:14px;margin-top:10px;">
            <h2 style="font-size:14px;margin-bottom:12px;"><i class="ti ti-tooth"></i> Dente <span id="pac-dente-num"></span> — <span id="pac-dente-nome" style="font-weight:400;"></span></h2>

            <!-- CONDIÇÃO -->
            <div style="margin-bottom:12px;">
              <div style="font-size:11px;font-weight:700;color:var(--rose-text);text-transform:uppercase;letter-spacing:.4px;margin-bottom:6px;">Condição</div>
              <div style="display:flex;flex-wrap:wrap;gap:6px;" id="odonto-cond-btns">
                ${[['higido','⚪','Hígido'],['carie','🔴','Cárie'],['restaurado','🔵','Restaurado'],['extraido','⬜','Extraído'],['canal','🟡','Canal'],['coroa','🔷','Coroa'],['implante','🟣','Implante'],['fratura','🟠','Fratura'],['selante','🩵','Selante'],['outro','⚫','Outro']].map(([v,ic,l])=>`
                  <div data-ocond-wrap="${v}" style="display:inline-flex;align-items:center;border:2px solid var(--rose-light);border-radius:10px;overflow:hidden;background:#fff;transition:all .15s;">
                    <button type="button" onclick="odontoToggleCond('${v}')" style="display:flex;align-items:center;gap:5px;padding:6px 10px;border:none;background:transparent;cursor:pointer;font-size:12px;font-weight:600;color:#3a2020;">${ic} ${l}</button>
                    <div data-ocond-qtd-wrap="${v}" style="display:none;align-items:center;gap:2px;padding-right:6px;">
                      <button type="button" onclick="odontoCondQtd('${v}',-1)" style="border:none;background:var(--rose-lighter);border-radius:4px;width:20px;height:20px;cursor:pointer;font-size:13px;font-weight:700;color:var(--rose-dark);">−</button>
                      <span data-ocond-num="${v}" style="min-width:18px;text-align:center;font-size:12px;font-weight:800;color:var(--rose-dark);">1</span>
                      <button type="button" onclick="odontoCondQtd('${v}',+1)" style="border:none;background:var(--rose-lighter);border-radius:4px;width:20px;height:20px;cursor:pointer;font-size:13px;font-weight:700;color:var(--rose-dark);">+</button>
                    </div>
                  </div>`).join('')}
              </div>
              <input type="hidden" id="pac-d-cond" value="higido"/>
            </div>

            <!-- FACES -->
            <div style="margin-bottom:12px;">
              <div style="font-size:11px;font-weight:700;color:var(--rose-text);text-transform:uppercase;letter-spacing:.4px;margin-bottom:6px;">Faces <span style="font-weight:400;font-size:10px;">(selecione uma ou mais)</span></div>
              <div style="display:flex;flex-wrap:wrap;gap:6px;" id="pac-d-faces-btns">
                ${['Oclusal','Vestibular','Lingual','Mesial','Distal','Incisal','Cervical'].map(f=>`
                  <button type="button" data-face="${f}" onclick="pacToggleFace('${f}')"
                    style="padding:5px 12px;border:2px solid var(--rose-light);border-radius:8px;background:#fff;font-size:12px;font-weight:600;color:#3a2020;cursor:pointer;transition:all .15s;">${f}</button>`).join('')}
              </div>
              <input type="hidden" id="pac-d-faces" value=""/>
            </div>

            <!-- PROCEDIMENTOS -->
            <div style="margin-bottom:12px;">
              <div style="font-size:11px;font-weight:700;color:var(--rose-text);text-transform:uppercase;letter-spacing:.4px;margin-bottom:6px;">Procedimentos</div>
              <!-- busca -->
              <div style="position:relative;margin-bottom:8px;">
                <input type="text" id="pac-d-proc-search" placeholder="🔍 Pesquisar procedimento..."
                  oninput="pacDenteFiltrarProcs()"
                  onfocus="pacDenteFiltrarProcs();document.getElementById('pac-d-proc-dd').style.display='block'"
                  onblur="setTimeout(()=>{const d=document.getElementById('pac-d-proc-dd');if(d)d.style.display='none'},350)"
                  style="width:100%;padding:9px 12px;border:1.5px solid var(--rose-light);border-radius:10px;font-size:13px;background:#fff;"/>
                <div id="pac-d-proc-dd" style="display:none;position:absolute;top:100%;left:0;right:0;background:#fff;border:1.5px solid var(--rose-light);border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.15);z-index:300;max-height:200px;overflow-y:auto;margin-top:2px;">
                  <div id="pac-d-proc-opts"></div>
                </div>
              </div>
              <!-- lista de procs adicionados no dente -->
              <div id="pac-d-proc-lista" style="display:flex;flex-direction:column;gap:4px;margin-bottom:4px;"></div>
            </div>

            <!-- OBS -->
            <div style="margin-bottom:12px;">
              <div style="font-size:11px;font-weight:700;color:var(--rose-text);text-transform:uppercase;letter-spacing:.4px;margin-bottom:6px;">Observações</div>
              <textarea id="pac-d-obs" rows="2" placeholder="Materiais, intercorrências..." style="width:100%;padding:9px 12px;border:1.5px solid var(--rose-light);border-radius:10px;font-size:13px;background:#fff;resize:vertical;font-family:inherit;"></textarea>
            </div>

            <div style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;">
              <button class="btn-secondary" onclick="pacFecharDente()">Fechar</button>
              <button class="btn-secondary" onclick="pacSalvarRascunhoDenteAtual();pacFecharDente();showToast('Rascunho guardado — clique em outro dente ou salve tudo.');" style="color:var(--rose-dark);border-color:var(--rose);">
                <i class="ti ti-bookmark"></i> Guardar rascunho
              </button>
              <button class="btn-primary" onclick="pacSalvarDente(${p.id})">
                <i class="ti ti-device-floppy"></i> Salvar todos os dentes
              </button>
            </div>
          </div>
          <!-- histórico por dente -->
          <div id="pac-dentes-historico" style="margin-top:12px;"></div>



          <!-- ORÇAMENTO DIRETO NO ODONTOGRAMA -->
          <div style="margin-top:16px;border-top:1px solid var(--rose-light);padding-top:16px;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
              <span style="font-size:13px;font-weight:700;color:var(--rose-dark);"><i class="ti ti-calculator"></i> Orçamento rápido</span>
              <button class="btn-secondary" style="font-size:11px;" onclick="pacOdontoToggleOrc()"><i class="ti ti-chevron-down" id="pac-odonto-orc-icon"></i> Montar orçamento</button>
            </div>
            <div id="pac-odonto-orc-panel" style="display:none;">
              <div style="font-size:12px;color:var(--rose-text);margin-bottom:8px;">Clique nos dentes acima para marcá-los, depois adicione ao orçamento:</div>
              <div style="margin-bottom:10px;">
                <div style="position:relative;margin-bottom:6px;">
                  <input type="text" id="pac-odonto-orc-search" placeholder="🔍 Pesquisar procedimento..." oninput="pacOdontoFiltrarProcs()" onfocus="pacOdontoFiltrarProcs();document.getElementById('pac-odonto-orc-dropdown').style.display='block'" onblur="setTimeout(()=>{const d=document.getElementById('pac-odonto-orc-dropdown');if(d)d.style.display='none'},350)"
                    style="width:100%;padding:10px 12px;border:1.5px solid var(--rose-light);border-radius:10px;font-size:13px;box-sizing:border-box;background:#fff;"/>
                  <div id="pac-odonto-orc-dropdown" style="display:none;position:absolute;top:100%;left:0;right:0;background:#fff;border:1.5px solid var(--rose-light);border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.15);z-index:200;max-height:260px;overflow-y:auto;margin-top:2px;">
                    <div id="pac-odonto-orc-chips" style="display:flex;gap:6px;padding:8px;flex-wrap:wrap;border-bottom:1px solid var(--rose-light);position:sticky;top:0;background:#fff;"></div>
                    <div id="pac-odonto-orc-opts"></div>
                  </div>
                </div>
                <input type="hidden" id="pac-odonto-orc-proc" value=""/>
                <div style="display:flex;align-items:center;gap:8px;">
                  <span id="pac-odonto-orc-sel-nome" style="flex:1;font-size:12px;color:var(--rose-dark);font-weight:600;min-height:20px;"></span>
                  <button class="btn-primary" style="font-size:12px;white-space:nowrap;" onclick="pacOdontoAddOrc()"><i class="ti ti-plus"></i> Adicionar</button>
                </div>
              </div>
              <div id="pac-odonto-orc-lista" style="margin-bottom:10px;"></div>
              <div style="background:var(--rose-lighter);border-radius:8px;padding:8px 12px;display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                <span style="font-size:13px;font-weight:700;">Total</span>
                <span style="font-size:14px;font-weight:800;color:var(--rose-dark);" id="pac-odonto-orc-total">R$ 0,00</span>
              </div>
              <div style="display:flex;gap:8px;">
                <button class="btn-primary" style="flex:1;justify-content:center;font-size:12px;" onclick="odontogramaSalvarEIrParaPlano(selectedPatientId)" id="pac-odonto-orc-btn-pac"><i class="ti ti-arrow-right"></i> Ir para o Plano</button>
                <button class="btn-danger" style="font-size:12px;" onclick="pacOdontoLimparOrc()"><i class="ti ti-eraser"></i></button>
              </div>
            </div>
          </div>
        </div>
        <div id="pac-odonto-sub-tecidos" data-pac-odonto-sub style="display:none;margin-top:14px;">
          <div class="oral-chart">
            <div class="oral-mouth" aria-hidden="true"></div>
            <div>
              <div style="font-size:13px;font-weight:800;color:var(--rose-dark);margin-bottom:10px;">Tecidos moles e duros</div>
              <div class="form-grid">
                <div class="form-group"><label>Lábios / mucosa</label><input type="text" id="pac-tec-labios" placeholder="Sem alterações"/></div>
                <div class="form-group"><label>Língua / assoalho</label><input type="text" id="pac-tec-lingua" placeholder="Sem alterações"/></div>
                <div class="form-group"><label>Palato / orofaringe</label><input type="text" id="pac-tec-palato" placeholder="Sem alterações"/></div>
                <div class="form-group"><label>ATM / oclusão</label><input type="text" id="pac-tec-atm" placeholder="Sem alterações"/></div>
                <div class="form-group full"><label>Observações</label><textarea id="pac-tec-obs" rows="3" placeholder="Anote achados clínicos, lesões, sensibilidade, assimetrias..."></textarea></div>
              </div>
              <div style="display:flex;justify-content:flex-end;margin-top:10px;"><button class="btn-primary" onclick="pacSalvarTecidos(${p.id})"><i class="ti ti-check"></i> Guardar anotação</button></div>
            </div>
          </div>
        </div>
        <div id="pac-odonto-sub-periodontia" data-pac-odonto-sub style="display:none;margin-top:14px;">
          <!-- DIAGRAMA DE SEXTANTES -->
          <div style="text-align:center;margin-bottom:16px;">
            <div style="font-size:11px;color:var(--rose-text);margin-bottom:6px;">Toque no sextante para marcar</div>
            ${pacPeriodontiaSvg()}
            <div style="display:flex;gap:5px;margin-top:8px;justify-content:center;flex-wrap:wrap;">
              ${['S1','S2','S3','S4','S5','S6'].map(s=>`<span id="pac-perio-chip-${s}" class="perio-chip" onclick="pacPerioToggleSextant('${s}')">${s}</span>`).join('')}
            </div>
          </div>
          <!-- PROCEDIMENTOS REALIZADOS -->
          <div style="margin-bottom:10px;">
            <div style="font-size:12px;font-weight:700;color:var(--rose-dark);margin-bottom:8px;"><i class="ti ti-list-check"></i> Procedimentos realizados</div>
            <div style="position:relative;margin-bottom:8px;">
              <i class="ti ti-search" style="position:absolute;left:9px;top:50%;transform:translateY(-50%);color:var(--rose-text);font-size:13px;pointer-events:none;"></i>
              <input type="text" id="pac-perio-search" placeholder="Buscar procedimento..." oninput="pacPerioRenderProcs()"
                style="width:100%;padding:8px 10px 8px 30px;border:1.5px solid var(--rose-light);border-radius:8px;font-size:13px;box-sizing:border-box;"/>
            </div>
            <div id="pac-perio-proc-list" style="max-height:220px;overflow-y:auto;border:1px solid var(--rose-light);border-radius:10px;background:#fff;"></div>
          </div>
          <!-- RESUMO DA SELEÇÃO -->
          <div id="pac-perio-sel-resumo" style="display:none;background:var(--rose-lighter);border-radius:8px;padding:8px 10px;margin-bottom:10px;font-size:12px;color:var(--rose-dark);line-height:1.6;"></div>
          <!-- OBSERVAÇÕES -->
          <div class="form-group full" style="margin-bottom:10px;">
            <label>Observações</label>
            <textarea id="pac-perio-obs" rows="2" placeholder="Sangramento, mobilidade, bolsa periodontal, recessão, cálculo..."></textarea>
          </div>
          <!-- AÇÕES -->
          <div style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;">
            <button class="btn-secondary" onclick="pacPerioAdicionarOrcamento(${p.id})"><i class="ti ti-receipt"></i> Adicionar ao orçamento</button>
            <button class="btn-primary" onclick="pacSalvarPeriodontia(${p.id})"><i class="ti ti-check"></i> Registrar no histórico</button>
          </div>
        </div>
      </div>

      <!-- ABA: PLANO DE TRATAMENTO (Revisão & Orçamento) -->
      <div id="pac-aba-plano" style="display:${abaAtiva==='plano'?'':'none'};">
        <div style="margin-top:14px;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;flex-wrap:wrap;gap:8px;">
            <div>
              <span style="font-size:13px;font-weight:700;color:var(--rose-dark);">Revisão do Plano &amp; Orçamento</span>
              <div style="font-size:12px;color:var(--rose-text);margin-top:2px;">Confira e ajuste os valores antes de apresentar ao paciente.</div>
            </div>
            <button class="btn-secondary" onclick="renderPatientDetail('odonto')"><i class="ti ti-arrow-left"></i> Voltar ao Odontograma</button>
          </div>

          <!-- resumo valores -->
          <div style="display:flex;gap:10px;margin:14px 0;flex-wrap:wrap;" id="pac-plano-resumo"></div>

          <!-- lista plano (itens revisáveis) -->
          <div id="pac-plano-lista"></div>

          <!-- AÇÃO DO ORÇAMENTO -->
          <div style="margin-top:16px;">
            <!-- Desconto pré-aprovação -->
            <div style="background:var(--rose-lighter);border-radius:10px;padding:12px;margin-bottom:10px;">
              <div style="font-size:11px;font-weight:700;color:var(--rose-text);text-transform:uppercase;letter-spacing:.4px;margin-bottom:8px;"><i class="ti ti-tag"></i> Desconto</div>
              <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
                <select id="plano-desc-tipo" onchange="pacPlanoAtualizarPreview()" style="padding:6px 8px;border:1px solid var(--rose-light);border-radius:8px;font-size:13px;background:#fff;">
                  <option value="pct">%</option>
                  <option value="brl">R$</option>
                </select>
                <input type="number" id="plano-desc-val" min="0" step="0.01" value="0"
                  oninput="pacPlanoAtualizarPreview()"
                  style="width:90px;padding:6px 8px;border:1px solid var(--rose-light);border-radius:8px;font-size:13px;text-align:right;" />
                <span id="plano-desc-preview" style="font-size:12px;color:#2e7d32;font-weight:700;"></span>
              </div>
            </div>
            <!-- Validade -->
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;flex-wrap:wrap;">
              <span style="font-size:11px;font-weight:700;color:var(--rose-text);text-transform:uppercase;letter-spacing:.4px;white-space:nowrap;"><i class="ti ti-calendar-time"></i> Validade:</span>
              <select id="plano-validade" onchange="pacPlanoAtualizarPreview()" style="padding:6px 8px;border:1px solid var(--rose-light);border-radius:8px;font-size:13px;background:#fff;">
                <option value="30">30 dias</option>
                <option value="60">60 dias</option>
                <option value="90">90 dias</option>
                <option value="0">Sem prazo</option>
              </select>
            </div>
            <!-- Simulação de parcelas -->
            <div id="plano-parc-sim" style="border:1px solid var(--rose-light);border-radius:10px;padding:12px;margin-bottom:10px;font-size:12px;display:none;"></div>
            <button class="btn-primary" style="width:100%;justify-content:center;padding:12px;" onclick="pacAprovarOrcamentoPlano(${p.id})">
              <i class="ti ti-circle-check"></i> Aprovar Orçamento
            </button>
          </div>
        </div>
      </div>

      <!-- ABA: ORÇAMENTOS -->
      <div id="pac-aba-orcamentos" style="display:${abaAtiva==='orcamentos'?'':'none'};">
        <div style="margin-top:14px;" id="pac-orc-container">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
            <span style="font-size:13px;font-weight:700;color:var(--rose-dark);">Orçamentos e Vendas</span>
          </div>
          <div id="pac-orc-lista"></div>
        </div>
      </div>

      <!-- ABA: PROCEDIMENTOS REALIZADOS -->
      <div id="pac-aba-procs" style="display:${abaAtiva==='procs'?'':'none'};">
        <div style="margin-top:14px;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;flex-wrap:wrap;gap:8px;">
            <span style="font-size:13px;font-weight:700;color:var(--rose-dark);">Histórico de procedimentos</span>
            <button class="btn-secondary" onclick="pacToggleNovoProc()"><i class="ti ti-plus"></i> Novo</button>
          </div>
          <!-- form novo procedimento -->
          <div id="pac-proc-form" style="display:none;border:1.5px solid var(--rose-light);border-radius:12px;padding:14px;margin-bottom:14px;">
            <div class="form-grid">
              <div class="form-group">
                <label>Data</label>
                <input type="date" id="pac-proc-data"/>
              </div>
              <div class="form-group">
                <label>Profissional</label>
                <select id="pac-proc-prof">
                  <option value="">Selecione</option>
                  ${profissionais.map(pr=>`<option value="${pr.id}">${escapeHtml(pr.nome)}</option>`).join('')}
                </select>
              </div>
              <div class="form-group full">
                <label>Procedimentos realizados</label>
                <textarea id="pac-proc-desc" rows="3" placeholder="Ex: Profilaxia completa, aplicação de flúor, orientação de higiene..."></textarea>
              </div>
              <div class="form-group full">
                <label>Observações</label>
                <textarea id="pac-proc-obs" rows="2" placeholder="Queixas, intercorrências, retorno..."></textarea>
              </div>
            </div>
            <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:10px;">
              <button class="btn-secondary" onclick="pacToggleNovoProc()">Cancelar</button>
              <button class="btn-primary" onclick="pacSalvarProc(${p.id})"><i class="ti ti-check"></i> Salvar</button>
            </div>
          </div>
          <div id="pac-proc-lista"></div>
        </div>
      </div>

      <!-- ABA: FINANCEIRO -->
      <div id="pac-aba-financeiro" style="display:${abaAtiva==='financeiro'?'':'none'};">
        <div style="margin-top:14px;" id="pac-fin-container"></div>
      </div>

      <!-- ABA: TERMO DE CONSENTIMENTO -->
      <div id="pac-aba-termo" style="display:${abaAtiva==='termo'?'':'none'};">
        <div style="margin-top:14px;">
          <div style="border:1.5px solid var(--rose-light);border-radius:12px;padding:18px;background:#fdfaf9;font-size:13px;line-height:1.7;color:#3a2020;">
            <div style="text-align:center;font-size:14px;font-weight:800;color:var(--rose-dark);text-transform:uppercase;letter-spacing:.5px;margin-bottom:14px;">
              Termo de Consentimento Livre e Esclarecido para Tratamento Odontológico
            </div>

            <p style="margin-bottom:10px;">Eu, <strong>${escapeHtml(p.nome)}</strong>${p.cpf?`, portador(a) do CPF nº <strong>${escapeHtml(p.cpf)}</strong>`:''}${p.nascimento?`, nascido(a) em <strong>${formatDate(p.nascimento)}</strong>`:''}, declaro que fui devidamente informado(a), de forma clara e em linguagem acessível, sobre o diagnóstico, o plano de tratamento odontológico proposto, os procedimentos a serem realizados, suas etapas, a duração estimada, os materiais e técnicas empregados, bem como sobre os riscos, benefícios, possíveis complicações, limitações e alternativas de tratamento existentes, incluindo a opção de não realizar o tratamento e suas consequências.</p>

            <p style="margin-bottom:10px;"><strong>1. Consentimento e autonomia.</strong> Declaro que minhas dúvidas foram esclarecidas pelo(a) cirurgião(ã)-dentista responsável e que autorizo, de forma livre, voluntária e esclarecida, a realização dos procedimentos odontológicos indicados no meu plano de tratamento, ciente de que posso solicitar esclarecimentos adicionais, recusar ou interromper o tratamento em qualquer momento, sem que isso implique qualquer penalidade, nos termos da Resolução CFO nº 118/2012 e do Código de Ética Odontológica.</p>

            <p style="margin-bottom:10px;"><strong>2. Riscos e intercorrências.</strong> Estou ciente de que todo procedimento odontológico, ainda que realizado com técnica adequada, pode apresentar riscos inerentes, tais como sensibilidade, dor, sangramento, infecção, reações alérgicas a medicamentos ou materiais, edema, limitações na resposta biológica individual e, em casos específicos, necessidade de retratamento, sem que isso configure, por si só, erro profissional.</p>

            <p style="margin-bottom:10px;"><strong>3. Responsabilidades do paciente.</strong> Comprometo-me a fornecer informações completas e verdadeiras sobre meu histórico de saúde (anamnese), seguir as orientações pós-operatórias e de higiene fornecidas pela equipe, comparecer às consultas de retorno e manutenção agendadas, e comunicar imediatamente qualquer reação adversa, desconforto ou intercorrência.</p>

            <p style="margin-bottom:10px;"><strong>4. Uso de imagens.</strong> Autorizo o registro de fotografias, radiografias e demais documentos referentes ao meu tratamento para fins de prontuário, diagnóstico, acompanhamento clínico e arquivo da clínica, podendo ser utilizados para divulgação de "antes e depois" em redes sociais ou materiais de marketing <strong>somente mediante autorização específica e separada</strong>, conforme o Código de Ética Odontológica (Resolução CFO nº 196/2019).</p>

            <p style="margin-bottom:10px;"><strong>5. Proteção de dados pessoais (LGPD).</strong> Meus dados pessoais e de saúde serão tratados exclusivamente para as finalidades de prestação do atendimento odontológico, elaboração de prontuário, controle financeiro e cumprimento de obrigações legais e regulatórias, em conformidade com a Lei nº 13.709/2018 (Lei Geral de Proteção de Dados Pessoais – LGPD). Os dados serão mantidos sob sigilo profissional, com acesso restrito à equipe envolvida no atendimento, podendo ser conservados pelo prazo exigido pela legislação e pelos conselhos de classe. Tenho direito de acessar, corrigir, solicitar a portabilidade ou, quando aplicável, a exclusão dos meus dados, mediante solicitação à clínica, sem prejuízo de obrigações legais de guarda do prontuário.</p>

            <p style="margin-bottom:10px;"><strong>6. Honorários e condições financeiras.</strong> Declaro estar de acordo com os valores, formas de pagamento e condições financeiras informados e/ou descritos no plano de tratamento e orçamento apresentados, ciente de que alterações no plano de tratamento poderão gerar ajustes nos valores previamente informados.</p>

            <p style="margin-bottom:10px;"><strong>7. Validade.</strong> Este termo é válido para o plano de tratamento atual e procedimentos dele decorrentes, podendo ser complementado por termos específicos para procedimentos que exijam consentimento adicional (cirurgias, uso de sedação, tratamentos estéticos, entre outros).</p>

            <p style="margin-top:14px;">Declaro ter lido e compreendido integralmente este termo, e firmo o presente documento de livre e espontânea vontade.</p>

            <div style="text-align:right;margin-top:14px;font-size:12px;color:var(--rose-text);">
              ${(clinicaData?.nome_cli)?escapeHtml(clinicaData.nome_cli)+' — ':''}${formatDate(hoje())}
            </div>
          </div>

          ${renderTermoSignArea(p.id, p.nome, (profissionais.find(pr=>pr.id==p.termo_consentimento?.profissionalId)?.nome)||'', (profissionais.find(pr=>pr.id==p.termo_consentimento?.profissionalId)?.cro)||'', p.termo_consentimento?.assinaturas||{})}
        </div>
      </div>

      <!-- ABA: GALERIA -->
      <div id="pac-aba-galeria" style="display:${abaAtiva==='galeria'?'':'none'};">
        <div style="margin-top:14px;">
          <div class="galeria-upload" id="galeria-dropzone" onclick="document.getElementById('galeria-input').click()">
            <i class="ti ti-camera-plus"></i>
            <span>Toque para adicionar foto ou radiografia</span>
            <small>JPG, PNG — máx. 10 MB cada</small>
            <input type="file" id="galeria-input" accept="image/*" multiple style="display:none;" onchange="galeriaUpload(this.files, ${p.id})"/>
          </div>
          <div class="galeria-filtros">
            <button class="galeria-filtro active" onclick="galeriaFiltrar('todos',this)">Todas</button>
            <button class="galeria-filtro" onclick="galeriaFiltrar('foto',this)">Fotos</button>
            <button class="galeria-filtro" onclick="galeriaFiltrar('radiografia',this)">Radiografias</button>
            <button class="galeria-filtro" onclick="galeriaFiltrar('antes_depois',this)">Antes/Depois</button>
          </div>
          <div id="galeria-grid" class="galeria-grid"></div>
        </div>
      </div>

      <!-- ABA: TIMELINE -->
      <div id="pac-aba-timeline" style="display:${abaAtiva==='timeline'?'':'none'};">
        <div style="margin-top:14px;" id="pac-timeline-body">
          <div style="text-align:center;color:var(--rose-text);padding:20px;font-size:13px;">Carregando...</div>
        </div>
      </div>

    </div>
  `;

  // Carrega dados das abas
  if(abaAtiva==='odonto') pacCarregarOdonto(p.id);
  if(abaAtiva==='procs') pacCarregarProcs(p.id);
  if(abaAtiva==='historico') histCarregar(p.id);
  if(abaAtiva==='orcamentos') pacRenderOrcamentos(p.id);
  if(abaAtiva==='plano'){ pacCarregarPlano(p.id); }
  if(abaAtiva==='galeria') galeriaCarregar(p.id);
  if(abaAtiva==='financeiro') pagPacRender(p.id);
  if(abaAtiva==='timeline') renderTimeline(p.id);
  requestAnimationFrame(()=>window.scrollTo({top:0,behavior:'instant'}));
}

function anamneseToggle(fieldId, radioVal){
  const el = document.getElementById(fieldId);
  if(!el) return;
  el.style.display = radioVal === 'sim' ? '' : 'none';
}

async function anamneseSalvar(pacId){
  const radio = (name) => document.querySelector(`input[name="${name}"]:checked`)?.value || '';
  const val   = (id)   => document.getElementById(id)?.value || '';
  const chk   = (id)   => document.getElementById(id)?.checked || false;

  const anamnese = {
    queixa        : val('an-queixa'),
    medicacao     : radio('an-med'),
    medicacaoQual : val('an-med-qual'),
    alergia       : radio('an-alergia'),
    alergiaQual   : val('an-alergia-qual'),
    paTipo        : radio('an-pa-tipo'),
    pa            : val('an-pa'),
    doencas: {
      anemia:chk('an-d-anemia'), diabete:chk('an-d-diabete'), respiratoria:chk('an-d-respiratoria'),
      osteoporose:chk('an-d-osteoporose'), sifilis:chk('an-d-sifilis'), hiv:chk('an-d-hiv'),
      epilepsia:chk('an-d-epilepsia'), cancer:chk('an-d-cancer'), cardiaco:chk('an-d-cardiaco'),
      febreReumatica:chk('an-d-febreReumatica'), hemorragia:chk('an-d-hemorragia'), hepatite:chk('an-d-hepatite'),
      hipertensao:chk('an-d-hipertensao'), endocrino:chk('an-d-endocrino'), herpes:chk('an-d-herpes'),
      endocardite:chk('an-d-endocardite'), tuberculose:chk('an-d-tuberculose'), afta:chk('an-d-afta'),
      distPsicologico:chk('an-d-distPsicologico')
    },
    doencaEsp     : val('an-doenca-esp'),
    cirurgia      : radio('an-cirurgia'),
    sangramento   : radio('an-sangramento'),
    cicatriz      : radio('an-cicatriz'),
    gestante      : radio('an-gestante'),
    gestanteSemana: val('an-gestante-semana'),
    anestesia     : radio('an-anest'),
    dorDente      : radio('an-dordente'),
    sangGeng      : radio('an-sangGeng'),
    sangGengQuando: val('an-sangGeng-quando'),
    bocaSeca      : radio('an-bocaseca'),
    dorMaxilar    : radio('an-dormaxilar'),
    parasFunc     : radio('an-parasFunc'),
    tatuagem      : radio('an-tatuagem'),
    fumante       : radio('an-fumante'),
    fio           : radio('an-fio'),
    escovacoes    : val('an-escovacoes'),
    ultimoTrat    : val('an-ultimo-trat'),
    antecFam      : val('an-antec-fam'),
  };

  showLoading(true);
  // Tenta salvar na tabela 'anamneses' (upsert por paciente_id)
  const { error: errAn } = await _sb.from('anamneses')
    .upsert({ paciente_id: pacId, clinica_id: clinicaId, dados: anamnese }, { onConflict: 'paciente_id' });
  if(errAn){
    // Fallback: tenta update direto em pacientes (compatibilidade)
    const { error: errPac } = await _sb.from('pacientes').update({ anamnese }).eq('id', pacId);
    if(errPac){
      showLoading(false);
      showToast('Erro ao salvar: '+errPac.message,'error');
      return;
    }
  }
  showLoading(false);
  // Atualiza objeto local
  const idx = pacientes.findIndex(p=>p.id===pacId);
  if(idx>=0) pacientes[idx].anamnese = anamnese;
  logAtividade('Anamnese salva', pacientes[idx]?.nome||pacId);
  showToast('Anamnese salva!');
}

async function anamneseEnviarWhatsApp(pacId){
  const p = pacientes.find(pt => pt.id === pacId);
  if(!p) return;
  let link;
  const { data: tokenRow, error } = await _sb.from('anamnese_links')
    .insert([{ paciente_id: pacId, clinica_id: clinicaId }])
    .select('token').single();
  if(!error && tokenRow){
    link = `${window.location.origin}/anamnese.html?token=${tokenRow.token}`;
    p._anamneseLink = { token: tokenRow.token, paciente_id: pacId, expires_at: new Date(Date.now()+7*24*3600000).toISOString(), used_at: null, created_at: new Date().toISOString() };
  } else {
    showToast('Erro ao gerar link seguro. Verifique se a tabela anamnese_links existe no Supabase.','error');
    return;
  }
  logAtividade('Anamnese enviada', p.nome||pacId);
  const msg = `Ola${p.nome ? ', ' + p.nome.split(' ')[0] : ''}! Para agilizar seu atendimento, preencha sua ficha de saude antes da consulta: ${link}`;
  navigator.clipboard.writeText(link).then(() => {
    showToast('Link copiado!');
  }).catch(() => {});
  const tel = (p.telefone || '').replace(/\D/g, '');
  const waUrl = tel
    ? `https://wa.me/${tel.startsWith('55') ? tel : '55' + tel}?text=${encodeURIComponent(msg)}`
    : `https://wa.me/?text=${encodeURIComponent(msg)}`;
  window.open(waUrl, '_blank');
}

function editPatient(id){
  const p=pacientes.find(pt=>pt.id===id);
  if(!p) return;
  const formEl=document.getElementById('form-paciente');
  if(formEl.style.display==='none') togglePatientForm();
  editingPatientId=id;
  const campoParaCol = {
    'pt-nome':'nome','pt-nascimento':'nascimento','pt-telefone':'telefone','pt-email':'email',
    'pt-plano':'plano','pt-cpf':'cpf'
  };
  Object.entries(campoParaCol).forEach(([elId,col])=>{
    const el=document.getElementById(elId); if(el) el.value=p[col]||'';
  });
  // Responsável e contato de emergência vêm de dentro do bloco oculto na coluna "notas";
  // o texto livre digitado pelo usuário fica separado e é o que aparece no campo Observações.
  const { texto, meta } = ptParseNotas(p.notas);
  document.getElementById('pt-notas').value = texto;
  const resp = meta.responsavel || {};
  const emer = meta.emergencia || {};
  document.getElementById('pt-resp-nome').value        = resp.nome||'';
  document.getElementById('pt-resp-parentesco').value   = resp.parentesco||'';
  document.getElementById('pt-resp-cpf').value          = resp.cpf||'';
  document.getElementById('pt-resp-telefone').value     = resp.telefone||'';
  document.getElementById('pt-emerg-nome').value        = emer.nome||'';
  document.getElementById('pt-emerg-parentesco').value  = emer.parentesco||'';
  document.getElementById('pt-emerg-telefone').value    = emer.telefone||'';
  ptCheckMenor();
  const btn=document.getElementById('save-patient-btn');
  btn.innerHTML='<i class="ti ti-check"></i> Atualizar paciente';
  btn.onclick=()=>savePatientEdit(id);
  window.scrollTo(0,0);
}

async function savePatientEdit(id){
  const dados=readPatientForm();
  if(!dados.nome){ showToast('Preencha o nome.','warn'); return; }
  if(dados.cpf && !validarCPF(dados.cpf)){ showToast('CPF inválido. Verifique os números.','warn'); document.getElementById('pt-cpf').focus(); return; }
  delete dados._responsavel;
  showLoading(true);
  const { error } = await _sb.from('pacientes').update(dados).eq('id',id);
  showLoading(false);
  if(error){ showToast('Erro: '+error.message,'error'); return; }
  const p=pacientes.find(pt=>pt.id===id);
  if(p) Object.assign(p,dados);
  resetPatientForm(); togglePatientForm();
  logAtividade('Paciente editado', dados.nome||id);
  renderPatients(); renderPatientDetail();
  showToast('Paciente atualizado.');
}

async function arquivarPaciente(id){
  if(!confirm('Arquivar este paciente?\n\nOs dados serão preservados mas o paciente não aparecerá mais nas listas. Você poderá restaurá-lo depois.')) return;
  showLoading(true);
  const { error } = await _sb.from('pacientes').update({ arquivado: true, arquivado_em: new Date().toISOString() }).eq('id',id);
  showLoading(false);
  if(error){ showToast('Erro: '+error.message,'error'); return; }
  const p = pacientes.find(pt=>pt.id===id);
  if(p){ p.arquivado=true; p.arquivado_em=new Date().toISOString(); }
  logAtividade('Paciente arquivado', p?.nome||id);
  selectedPatientId=null;
  renderPatients(); renderHomeStats();
  document.getElementById('painel-paciente').style.display='none';
  showToast('Paciente arquivado.');
}
async function restaurarPaciente(id){
  showLoading(true);
  const { error } = await _sb.from('pacientes').update({ arquivado: false, arquivado_em: null }).eq('id',id);
  showLoading(false);
  if(error){ showToast('Erro: '+error.message,'error'); return; }
  const p = pacientes.find(pt=>pt.id===id);
  if(p){ p.arquivado=false; p.arquivado_em=null; }
  logAtividade('Paciente restaurado', p?.nome||id);
  renderPatients(); renderHomeStats();
  showToast('Paciente restaurado!');
}


// ══════════════════════════════════════════════════════
// CALENDÁRIO
// ══════════════════════════════════════════════════════
function calISO(d){ return toLocalISO(d); }
function calWeekStart(d){ const c=new Date(d); c.setDate(c.getDate()-c.getDay()); return c; }
function calWeekEnd(d){ const c=new Date(d); c.setDate(c.getDate()+(6-c.getDay())); return c; }

function calSetView(v, render=true){ calView=v; document.querySelectorAll('.cal-view-btn').forEach(b=>b.classList.toggle('active',b.dataset.view===v)); const mob=document.getElementById('cal-view-mobile'); if(mob) mob.value=v; if(render) renderCalendario(); }
function calToday(){ calRef=new Date(); renderCalendario(); }
function calNavigate(dir){
  const d=new Date(calRef);
  if(calView==='semana') d.setDate(d.getDate()+dir*7);
  else if(calView==='mes'){ d.setMonth(d.getMonth()+dir); }
  else d.setDate(d.getDate()+dir);
  calRef=d; renderCalendario();
}
function calFullscreen(){
  const el=document.getElementById('cal-card');
  const fn=el.requestFullscreen||el.webkitRequestFullscreen||el.mozRequestFullScreen;
  if(fn){
    if(!document.fullscreenElement){
      fn.call(el);
    } else {
      (document.exitFullscreen||document.webkitExitFullscreen||document.mozCancelFullScreen).call(document);
    }
  } else {
    el.classList.toggle('cal-pseudo-fs');
    const icon=el.querySelector('.cal-full i');
    const isFs=el.classList.contains('cal-pseudo-fs');
    if(icon) icon.className=isFs?'ti ti-minimize':'ti ti-maximize';
    document.body.style.overflow=isFs?'hidden':'';
    renderCalendario();
  }
}
function calIsFullscreen(){
  return !!document.fullscreenElement || document.getElementById('cal-card')?.classList.contains('cal-pseudo-fs');
}
document.getElementById('cal-card')?.addEventListener('wheel',e=>{
  if(e.ctrlKey){ e.preventDefault(); return; }
  if(calIsFullscreen()){
    const body=document.getElementById('cal-body');
    if(body && body.scrollHeight>body.clientHeight){
      body.scrollTop+=e.deltaY;
      e.preventDefault();
    }
  }
},{passive:false});
document.addEventListener('fullscreenchange',()=>{
  const el=document.getElementById('cal-card');
  const icon=el?.querySelector('.cal-full i');
  if(icon) icon.className=document.fullscreenElement?'ti ti-minimize':'ti ti-maximize';
  renderCalendario();
  if(document.fullscreenElement){
    const body=document.getElementById('cal-body');
    if(body){ body.setAttribute('tabindex','0'); body.focus(); }
  }
});
document.addEventListener('keydown',e=>{
  if(!calIsFullscreen()) return;
  const body=document.getElementById('cal-body');
  if(!body) return;
  const step=48;
  if(e.key==='ArrowDown'){ body.scrollTop+=step; e.preventDefault(); }
  else if(e.key==='ArrowUp'){ body.scrollTop-=step; e.preventDefault(); }
  else if(e.key==='PageDown'){ body.scrollTop+=body.clientHeight; e.preventDefault(); }
  else if(e.key==='PageUp'){ body.scrollTop-=body.clientHeight; e.preventDefault(); }
  else if(e.key==='Home'){ body.scrollTop=0; e.preventDefault(); }
  else if(e.key==='End'){ body.scrollTop=body.scrollHeight; e.preventDefault(); }
  else if(e.key==='Escape' && !document.fullscreenElement){
    document.getElementById('cal-card')?.classList.remove('cal-pseudo-fs');
    const icon=document.getElementById('cal-card')?.querySelector('.cal-full i');
    if(icon) icon.className='ti ti-maximize';
    document.body.style.overflow='';
    renderCalendario();
  }
});

// Cor/rótulo por status do agendamento (status vive em obs — ver agGetStatus)
function agStatusInfo(a){
  const s=(agGetStatus(a)||'').toLowerCase();
  const M={
    '':        {k:'agendado',  label:'Agendado',  v:'--st-agendado'},
    confirmado:{k:'confirmado',label:'Confirmado',v:'--st-confirmado'},
    compareceu:{k:'compareceu',label:'Compareceu',v:'--st-compareceu'},
    faltou:    {k:'faltou',    label:'Faltou',    v:'--st-faltou'},
    remarcado: {k:'remarcado', label:'Remarcado', v:'--st-remarcado'},
    cancelado: {k:'cancelado', label:'Cancelado', v:'--st-cancelado'}
  };
  return M[s]||M[''];
}
function _calIni(nome){ const p=(nome||'').trim().split(/\s+/); return (((p[0]||'')[0]||'')+((p[1]||'')[0]||'')).toUpperCase(); }

function renderCalendario(){
  const profFiltro=document.getElementById('cal-prof')?.value;
  const filtered=profFiltro?agendamentos.filter(a=>a.prof_id===parseInt(profFiltro)):agendamentos;
  const body=document.getElementById('cal-body');
  if(!body) return;
  const rangeEl=document.getElementById('cal-range');
  const slot=document.getElementById('cal-summary-slot');
  if(slot) slot.innerHTML='';
  const today=hoje();
  const totalH=(CAL_END_HOUR-CAL_START_HOUR)*2, height=totalH*CAL_SLOT_PX;

  if(calView==='dia'){
    const d=new Date(calRef), iso=calISO(d);
    if(rangeEl) rangeEl.textContent=d.toLocaleDateString('pt-BR',{weekday:'long',day:'numeric',month:'long',year:'numeric'});
    const dayAppts=filtered.filter(a=>a.data===iso);
    // Colunas por profissional
    let cols=[];
    if(profFiltro){ const p=profissionais.find(x=>x.id===parseInt(profFiltro)); if(p) cols=[{id:p.id,nome:p.nome,cor:p.cor,esp:p.especialidade||p.funcao||''}]; }
    else { cols=profissionais.map(p=>({id:p.id,nome:p.nome,cor:p.cor,esp:p.especialidade||p.funcao||''})); }
    const known=new Set(cols.map(c=>c.id));
    const hasOrphan=dayAppts.some(a=>!known.has(a.prof_id));
    if(hasOrphan||cols.length===0) cols.push({id:null,nome:cols.length?'Sem profissional':'Agenda',cor:'#b0a09a',esp:''});
    // Resumo do dia (fica fixo acima da grade)
    const cnt={agendado:0,confirmado:0,compareceu:0,faltou:0,remarcado:0,cancelado:0};
    dayAppts.forEach(a=>cnt[agStatusInfo(a).k]++);
    if(slot) slot.innerHTML=`<div class="cal-summary">
      <div class="cs-item"><b>${dayAppts.length}</b><span>Consultas</span></div>
      <div class="cs-item"><b style="color:var(--st-compareceu)">${cnt.confirmado+cnt.compareceu}</b><span>Confirmadas</span></div>
      <div class="cs-item"><b style="color:var(--rose)">${cnt.agendado}</b><span>A confirmar</span></div>
      <div class="cs-item"><b style="color:var(--st-faltou)">${cnt.faltou}</b><span>Faltas</span></div>
    </div>`;
    const gtc=`52px ${cols.map(()=>'minmax(150px,1fr)').join(' ')}`;
    let html=`<div class="cal-grid cal-day" style="grid-template-columns:${gtc};">
      <div class="cal-grid-head"><div class="cal-corner"></div>
        ${cols.map(c=>`<div class="cal-pro-head"><div class="cal-pro-av" style="background:${c.cor||'var(--rose)'}">${escapeHtml(_calIni(c.nome))||'•'}</div>
          <div><div class="cal-pro-nm">${escapeHtml(c.nome)}</div>${c.esp?`<div class="cal-pro-sub">${escapeHtml(c.esp)}</div>`:''}</div></div>`).join('')}
      </div>
      <div class="cal-timecol">${Array.from({length:totalH},(_,i)=>{const h=CAL_START_HOUR+Math.floor(i/2);return`<div class="cal-time-label">${i%2===0?`<span>${String(h).padStart(2,'0')}:00</span>`:''}</div>`;}).join('')}</div>
      ${cols.map(c=>{
        const colAppts=dayAppts.filter(a=> c.id===null ? !known.has(a.prof_id) : a.prof_id===c.id);
        const events=colAppts.map(a=>{
          const [hh,mm]=((a.horario||'00:00')+':00').split(':').map(Number);
          const top=(hh*60+mm-CAL_START_MIN)/(CAL_END_MIN-CAL_START_MIN)*height;
          const info=agStatusInfo(a);
          return`<div class="cal-event st-${info.k}" style="--sc:var(${info.v});top:${top}px;height:44px;" onclick="calOpenEvent(event,${a.id})" title="${escapeHtml(a.nome)} — ${info.label}">
            <span class="ev-dot"></span><div class="ev-time">${a.horario}</div>
            <div class="ev-name">${escapeHtml(a.nome)}</div><div class="ev-meta">${escapeHtml(a.procedimento||'Consulta')}</div></div>`;
        }).join('');
        return`<div class="cal-daycol${iso===today?' is-today':''}" style="height:${height}px;" onclick="calDayColClick(event,'${iso}')">${events}</div>`;
      }).join('')}
      ${iso===today?`<div class="cal-nowline" id="cal-nowline"></div>`:''}
    </div>`;
    body.innerHTML=html;
    requestAnimationFrame(()=>{
      const corner=body.querySelector('.cal-corner'), headH=corner?corner.offsetHeight:40;
      const now=new Date(), minNow=now.getHours()*60+now.getMinutes(), nl=document.getElementById('cal-nowline');
      if(nl){ if(minNow>=CAL_START_MIN&&minNow<=CAL_END_MIN){ nl.style.top=(headH+(minNow-CAL_START_MIN)/(CAL_END_MIN-CAL_START_MIN)*height)+'px'; } else { nl.style.display='none'; } }
      const st=headH+((minNow-CAL_START_MIN)/(CAL_END_MIN-CAL_START_MIN))*height-body.clientHeight/3;
      if(st>0) body.scrollTop=Math.max(0,st);
    });

  } else if(calView==='semana'){
    const days=Array.from({length:7},(_,i)=>{ const dd=calWeekStart(calRef); dd.setDate(dd.getDate()+i); return dd; });
    if(rangeEl) rangeEl.textContent=`${days[0].getDate()} ${MONTHS_PT[days[0].getMonth()].slice(0,3)} – ${days[6].getDate()} ${MONTHS_PT[days[6].getMonth()].slice(0,3)} ${days[0].getFullYear()}`;
    let html=`<div class="cal-grid" style="grid-template-columns:52px ${days.map(()=>'1fr').join(' ')};">
      <div class="cal-grid-head"><div class="cal-corner"></div>
        ${days.map(d=>`<div class="cal-day-head${calISO(d)===today?' is-today':''}"><div class="dow">${DAYS_PT[d.getDay()]}</div><div class="dnum">${d.getDate()}</div></div>`).join('')}
      </div>
      <div class="cal-timecol">${Array.from({length:totalH},(_,i)=>{const h=CAL_START_HOUR+Math.floor(i/2);return`<div class="cal-time-label">${i%2===0?`<span>${String(h).padStart(2,'0')}:00</span>`:''}</div>`;}).join('')}</div>
      ${days.map(d=>{const iso=calISO(d);const dayAppts=filtered.filter(a=>a.data===iso);
        const events=dayAppts.map(a=>{const [hh,mm]=((a.horario||'00:00')+':00').split(':').map(Number);
          const top=(hh*60+mm-CAL_START_MIN)/(CAL_END_MIN-CAL_START_MIN)*height;const info=agStatusInfo(a);
          return`<div class="cal-event st-${info.k}" style="--sc:var(${info.v});top:${top}px;height:44px;" onclick="calOpenEvent(event,${a.id})" title="${escapeHtml(a.nome)} — ${info.label}">
            <span class="ev-dot"></span><div class="ev-time">${a.horario}</div><div class="ev-name">${escapeHtml(a.nome)}</div>
            <div class="ev-meta">${escapeHtml(a.procedimento||'Consulta')}</div>
            <span class="ev-prof" style="background:${a.prof_cor||'transparent'}"></span></div>`;}).join('');
        return`<div class="cal-daycol${iso===today?' is-today':''}" style="height:${height}px;" onclick="calDayColClick(event,'${iso}')">${events}</div>`;
      }).join('')}
    </div>`;
    body.innerHTML=html;
    requestAnimationFrame(()=>{
      const now=new Date(), minNow=now.getHours()*60+now.getMinutes();
      const st=((minNow-CAL_START_MIN)/(CAL_END_MIN-CAL_START_MIN))*height-body.clientHeight/3;
      if(st>0) body.scrollTop=Math.max(0,st);
    });

  } else {
    // Mês
    const year=calRef.getFullYear(), month=calRef.getMonth();
    if(rangeEl) rangeEl.textContent=`${MONTHS_PT[month]} ${year}`;
    const firstDay=new Date(year,month,1).getDay();
    const daysInMonth=new Date(year,month+1,0).getDate();
    const prevDays=new Date(year,month,0).getDate();
    let cells=[];
    for(let i=firstDay-1;i>=0;i--) cells.push({day:prevDays-i,cur:false,iso:calISO(new Date(year,month-1,prevDays-i))});
    for(let d=1;d<=daysInMonth;d++) cells.push({day:d,cur:true,iso:calISO(new Date(year,month,d))});
    while(cells.length%7!==0) cells.push({day:'',cur:false,iso:''});
    let html=`<div class="cal-month">
      ${DAYS_PT.map(d=>`<div class="cal-month-dow">${d}</div>`).join('')}
      ${cells.map(cell=>{
        const dayAppts=filtered.filter(a=>a.data===cell.iso);
        const pills=dayAppts.slice(0,3).map(a=>{const info=agStatusInfo(a);return`<div class="cal-pill" style="--sc:var(${info.v})" onclick="event.stopPropagation();calOpenEvent(event,${a.id})"><span style="width:5px;height:5px;border-radius:50%;background:${a.prof_cor||'#fff'};flex-shrink:0"></span>${escapeHtml((a.nome||'').split(' ')[0])}</div>`;}).join('');
        const more=dayAppts.length>3?`<div class="cal-more">+${dayAppts.length-3} mais</div>`:'';
        return`<div class="cal-cell${!cell.cur?' out':''}${cell.iso===today?' is-today':''}" onclick="calDayClick('${cell.iso}')">
          <div class="cell-num">${cell.day}</div>${pills}${more}
        </div>`;
      }).join('')}
    </div>`;
    body.innerHTML=html;
  }
}

function calDayClick(iso){ if(!iso) return; calRef=new Date(iso+'T00:00:00'); calSetView('dia'); }

function calDayColClick(e, iso){
  if(e.target.classList.contains('cal-event')) return;
  const rect=e.currentTarget.getBoundingClientRect();
  const y=e.clientY-rect.top;
  const totalH=(CAL_END_HOUR-CAL_START_HOUR)*2;
  const totalPx=totalH*CAL_SLOT_PX;
  let min=CAL_START_MIN+Math.floor(y/totalPx*(CAL_END_MIN-CAL_START_MIN)/30)*30;
  min=Math.max(CAL_START_MIN,Math.min(min,CAL_END_MIN-30));
  const hh=String(Math.floor(min/60)).padStart(2,'0');
  const mm=String(min%60).padStart(2,'0');
  calOpenNewAppt(iso,`${hh}:${mm}`);
}

function calOpenEvent(e, id){
  e.stopPropagation();
  const a=agendamentos.find(x=>x.id===id);
  if(!a) return;
  const prof=profissionais.find(p=>p.id===a.prof_id);
  const bg=document.getElementById('cal-modal-bg');
  const status = (agGetStatus(a)||'').toLowerCase();
  const statusBadge = status==='faltou'
    ? '<span class="fin-badge danger" style="font-size:10px;">NÃO VEIO</span>'
    : status==='compareceu'
    ? '<span class="fin-badge ok" style="font-size:10px;">COMPARECEU</span>'
    : status==='confirmado'
    ? '<span class="fin-badge" style="font-size:10px;background:#dbeafe;color:#1e40af;">CONFIRMADO</span>'
    : status==='remarcado'
    ? '<span class="fin-badge" style="font-size:10px;background:#fef3c7;color:#92400e;">REMARCADO</span>'
    : status==='cancelado'
    ? '<span class="fin-badge danger" style="font-size:10px;">CANCELADO</span>'
    : '';
  bg.innerHTML=`<div class="cal-modal" onclick="event.stopPropagation()">
    <div class="cal-modal-head" style="background:${a.prof_cor||'var(--rose)'};">
      <div class="mh-time"><i class="ti ti-clock"></i> ${a.horario} · ${formatDate(a.data)}</div>
      <div class="mh-name">${escapeHtml(a.nome)} ${statusBadge}</div>
    </div>
    <div class="cal-modal-body">
      <div class="row"><i class="ti ti-stethoscope"></i><span>${escapeHtml(a.procedimento||'Consulta')}</span></div>
      <div class="row"><i class="ti ti-user-check"></i><span>${escapeHtml(a.prof_nome)}</span></div>
      <div class="row"><i class="ti ti-phone"></i><span>${escapeHtml(a.telefone||'Sem telefone')}</span></div>
      ${agParseObs(a.obs).texto?`<div class="row"><i class="ti ti-notes"></i><span>${escapeHtml(agParseObs(a.obs).texto)}</span></div>`:''}
      <div style="display:flex;gap:6px;margin-top:14px;flex-wrap:wrap;">
        <button class="btn-secondary" style="flex:1;background:${status==='confirmado'?'#1e40af':'#fff'};color:${status==='confirmado'?'#fff':'#1e40af'};border-color:#1e40af;" onclick="calMarcarPresenca(${a.id},'confirmado')"><i class="ti ti-circle-check"></i> Confirmado</button>
        <button class="btn-secondary" style="flex:1;background:${status==='compareceu'?'#2e7d32':'#fff'};color:${status==='compareceu'?'#fff':'#2e7d32'};border-color:#2e7d32;" onclick="calMarcarPresenca(${a.id},'compareceu')"><i class="ti ti-check"></i> Veio</button>
        <button class="btn-secondary" style="flex:1;background:${status==='faltou'?'#dc2626':'#fff'};color:${status==='faltou'?'#fff':'#dc2626'};border-color:#dc2626;" onclick="calMarcarPresenca(${a.id},'faltou')"><i class="ti ti-x"></i> Faltou</button>
      </div>
      <div style="display:flex;gap:6px;margin-top:6px;">
        <button class="btn-secondary" style="flex:1;font-size:11px;${status==='remarcado'?'background:#fef3c7;color:#92400e;border-color:#fbbf24;':''}" onclick="calMarcarPresenca(${a.id},'remarcado')"><i class="ti ti-calendar-event"></i> Remarcado</button>
        <button class="btn-secondary" style="flex:1;font-size:11px;${status==='cancelado'?'background:#fee2e2;color:#dc2626;border-color:#fca5a5;':''}" onclick="calMarcarPresenca(${a.id},'cancelado')"><i class="ti ti-calendar-off"></i> Cancelado</button>
      </div>
      <a href="${buildGoogleCalendarUrl(a.nome, a.data, a.horario, a.procedimento||'Consulta', a.prof_nome, agParseObs(a.obs).texto)}" target="_blank" style="display:flex;align-items:center;justify-content:center;gap:8px;margin-top:10px;background:#4285f4;color:#fff;border-radius:10px;padding:9px 14px;font-size:13px;font-weight:700;text-decoration:none;">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="24" height="24" rx="4" fill="white"/><path d="M17.5 7.5h-11A1.5 1.5 0 0 0 5 9v9a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 18V9a1.5 1.5 0 0 0-1.5-1.5Z" stroke="#4285f4" stroke-width="1.4"/><path d="M8 7.5V6M16 7.5V6M5 11h14" stroke="#4285f4" stroke-width="1.4" stroke-linecap="round"/><rect x="8" y="13" width="2.5" height="2.5" rx=".5" fill="#ea4335"/></svg>
        Adicionar ao Google Agenda
      </a>
    </div>
    <div class="cal-modal-foot">
      <button class="btn-danger" onclick="calRemoveFromModal(${a.id})"><i class="ti ti-trash"></i> Remover</button>
      ${a.telefone ? `<button class="btn-secondary" style="background:#25d366;color:#fff;border-color:#25d366;" onclick="enviarConfirmacaoWpp('${escapeHtml(a.telefone).replace(/'/g,'&#39;')}','${escapeHtml(a.nome).replace(/'/g,'&#39;')}','${escapeHtml(a.data).replace(/'/g,'&#39;')}','${escapeHtml(a.horario).replace(/'/g,'&#39;')}','${escapeHtml(a.procedimento||'Consulta').replace(/'/g,'&#39;')}')"><i class="ti ti-brand-whatsapp"></i> Confirmar</button>` : ''}
      ${a.paciente_id?`<button class="btn-secondary" onclick="document.getElementById('cal-modal-bg').classList.remove('show');verPacienteHome(${a.paciente_id})"><i class="ti ti-user"></i> Prontuário</button>`:''}
      <button class="btn-secondary" onclick="document.getElementById('cal-modal-bg').classList.remove('show')">Fechar</button>
    </div>
  </div>`;
  bg.classList.add('show');
}

// Status do agendamento (compareceu/faltou) é guardado dentro da coluna "obs" (já
// existente), num marcador — a tabela "agendamentos" não tem coluna "status".
const AG_STATUS_INICIO = '<!--AGSTATUS:';
const AG_STATUS_FIM = ':AGSTATUS-->';
function agParseObs(obsRaw){
  const raw = obsRaw||'';
  const i = raw.indexOf(AG_STATUS_INICIO);
  const j = raw.indexOf(AG_STATUS_FIM);
  if(i===-1||j===-1||j<i) return { texto: raw, status: '' };
  const status = raw.slice(i+AG_STATUS_INICIO.length, j);
  const texto = (raw.slice(0,i)+raw.slice(j+AG_STATUS_FIM.length)).trim();
  return { texto, status };
}
function agBuildObs(texto, status){
  const t = (texto||'').trim();
  if(!status) return t;
  return t + (t?'\n':'') + AG_STATUS_INICIO + status + AG_STATUS_FIM;
}
function agGetStatus(a){ return agParseObs(a.obs).status; }

async function calMarcarPresenca(id, status){
  const a = agendamentos.find(x=>x.id===id);
  if(!a) return;
  showLoading(true);
  const novoObs = agBuildObs(agParseObs(a.obs).texto, status);
  const { error } = await _sb.from('agendamentos').update({ obs: novoObs }).eq('id', id);
  showLoading(false);
  if(error){ showToast('Erro: '+error.message,'error'); return; }
  a.obs = novoObs;
  document.getElementById('cal-modal-bg').classList.remove('show');
  renderCalendario(); renderLista(); renderHomeStats();
  if(status==='compareceu'){
    showToast(a.nome+' marcado como compareceu. ✅');
    return;
  }
  // Faltou — evita perder o paciente: abre direto a mensagem de reagendamento pronta,
  // e marca para aparecer destacado na aba Resgate até ser remarcado.
  showToast(a.nome+' marcado como não veio.','warn');
  if(a.telefone){
    abrirResgateModalFalta(a.nome, a.telefone, a.procedimento||'Consulta');
  } else {
    showToast('Sem telefone cadastrado para reagendar — adicione o contato no cadastro do paciente.','warn');
  }
}

function _primeiroNome(nome){ return (nome||'').split(' ')[0]; }
function _prepClinica(nome){
  const n = (nome||'').trim().toLowerCase();
  const prep = n.startsWith('clínica')||n.startsWith('clinica') ? 'na' : 'no';
  return prep + ' ' + (nome||'nossa clínica');
}

function gerarMensagemFalta(nome){
  const pn = _primeiroNome(nome);
  return `Oi, ${pn}! Sentimos sua falta na sua consulta recentemente. Está tudo bem por aí? Quer que eu te envie os horários disponíveis desta semana para remarcarmos? 😊`;
}

function abrirResgateModalFalta(nome, tel, proc){
  resgateModalTel = tel;
  document.getElementById('resgate-modal-nome').textContent = nome;
  document.getElementById('resgate-modal-msg').value = gerarMensagemFalta(nome);
  const bg = document.getElementById('resgate-modal-bg');
  if(bg) bg.style.display = 'flex';
}

function calCloseEvent(e){ if(e.target.id==='cal-modal-bg') document.getElementById('cal-modal-bg').classList.remove('show'); }

async function calRemoveFromModal(id){
  if(!confirm('Remover este agendamento?')) return;
  showLoading(true);
  const { error } = await _sb.from('agendamentos').delete().eq('id',id);
  showLoading(false);
  if(error){ showToast('Erro: '+error.message,'error'); return; }
  agendamentos=agendamentos.filter(x=>x.id!==id);
  document.getElementById('cal-modal-bg').classList.remove('show');
  renderCalendario(); renderLista(); renderHomeStats();
  showToast('Agendamento removido.');
}

function calNewQuick(){
  const base=calView==='dia'?calRef:new Date();
  calOpenNewAppt(calISO(base),'');
}

function calOpenNewAppt(iso, horario){
  if(!pacientes.length){ showToast('Cadastre um paciente antes de agendar.','warn'); return; }
  if(!profissionais.length){ showToast('Cadastre um profissional antes de agendar.','warn'); return; }
  const bg=document.getElementById('cal-new-bg');
  const patOpts='<option value="">Selecione o paciente</option>'+pacientes.map(p=>`<option value="${p.id}">${escapeHtml(p.nome)}</option>`).join('');
  const profOpts=profissionais.map(p=>`<option value="${p.id}">${escapeHtml(p.nome)} — ${escapeHtml(p.especialidade)}</option>`).join('');
  bg.innerHTML=`<div class="cal-modal cal-modal-form" onclick="event.stopPropagation()">
    <div class="cal-modal-head" style="background:var(--rose);">
      <div class="mh-time"><i class="ti ti-calendar-plus"></i> Novo agendamento</div>
      <div class="mh-name">${formatDate(iso)}${horario?' · '+horario:''}</div>
    </div>
    <div class="cal-modal-body">
      <div class="form-group"><label>Paciente</label><select id="cn-patient" onchange="cnPatientChange()">${patOpts}</select></div>
      <div class="form-group"><label>Telefone</label><input type="tel" id="cn-phone" /></div>
      <div class="form-group"><label>Profissional</label><select id="cn-prof">${profOpts}</select></div>
      <div class="cal-form-row">
        <div class="form-group"><label>Data</label><input type="date" id="cn-data" value="${iso}" /></div>
        <div class="form-group"><label>Horário</label><input type="time" id="cn-horario" step="1800" value="${horario}" /></div>
      </div>
      <div class="form-group"><label>Procedimento</label><input type="text" id="cn-proc" placeholder="Limpeza, Canal..." /></div>
      <div class="form-group"><label>Observações</label><textarea id="cn-obs" rows="2"></textarea></div>
    </div>
    <div class="cal-modal-foot">
      <button class="btn-secondary" onclick="calCloseNew()">Cancelar</button>
      <button class="btn-primary" onclick="calSaveNewAppt()"><i class="ti ti-check"></i> Salvar</button>
    </div>
  </div>`;
  bg.classList.add('show');
}

function cnPatientChange(){
  const sel=document.getElementById('cn-patient');
  const ph=document.getElementById('cn-phone');
  if(!sel||!ph) return;
  const p=pacientes.find(x=>x.id==sel.value);
  ph.value=p&&p.telefone?p.telefone:'';
}

function calCloseNew(e){
  if(e&&e.target&&e.target.id!=='cal-new-bg') return;
  document.getElementById('cal-new-bg').classList.remove('show');
}


// ══════════════════════════════════════════════════════
// ODONTOGRAMA
// ══════════════════════════════════════════════════════
const FDI_SUP = [18,17,16,15,14,13,12,11,21,22,23,24,25,26,27,28];
const FDI_INF = [48,47,46,45,44,43,42,41,31,32,33,34,35,36,37,38];

const DENTE_NOME = {
  11:'Inc. Central',12:'Inc. Lateral',13:'Canino',14:'Pré-molar 1',15:'Pré-molar 2',16:'Molar 1',17:'Molar 2',18:'Siso',
  21:'Inc. Central',22:'Inc. Lateral',23:'Canino',24:'Pré-molar 1',25:'Pré-molar 2',26:'Molar 1',27:'Molar 2',28:'Siso',
  31:'Inc. Central',32:'Inc. Lateral',33:'Canino',34:'Pré-molar 1',35:'Pré-molar 2',36:'Molar 1',37:'Molar 2',38:'Siso',
  41:'Inc. Central',42:'Inc. Lateral',43:'Canino',44:'Pré-molar 1',45:'Pré-molar 2',46:'Molar 1',47:'Molar 2',48:'Siso',
  51:'Dec. Inc. Central',52:'Dec. Inc. Lateral',53:'Dec. Canino',54:'Dec. Molar 1',55:'Dec. Molar 2',
  61:'Dec. Inc. Central',62:'Dec. Inc. Lateral',63:'Dec. Canino',64:'Dec. Molar 1',65:'Dec. Molar 2',
  71:'Dec. Inc. Central',72:'Dec. Inc. Lateral',73:'Dec. Canino',74:'Dec. Molar 1',75:'Dec. Molar 2',
  81:'Dec. Inc. Central',82:'Dec. Inc. Lateral',83:'Dec. Canino',84:'Dec. Molar 1',85:'Dec. Molar 2'
};
const COND_PT = {higido:'Hígido',carie:'Cárie',restaurado:'Restaurado',extraido:'Extraído',canal:'Canal',coroa:'Coroa',implante:'Implante',fratura:'Fratura',selante:'Selante',outro:'Outro'};
const COND_COR = {higido:'#fff',carie:'#ef5350',restaurado:'#2374c6',extraido:'#9e9e9e',canal:'#ffb300',coroa:'#1e88e5',implante:'#8e24aa',fratura:'#fb8c00',selante:'#00acc1',outro:'#757575'};
const ODONTO_COND_OPTIONS = [
  {id:'ausente', label:'Ausente', code:'A', visual:'extraido'},
  {id:'higido_selado', label:'Hígido selado', code:'Hs', visual:'higido'},
  {id:'incluso', label:'Incluso', code:'I', visual:'outro'},
  {id:'extraido', label:'Extraído', code:'E', visual:'extraido'},
  {id:'protese_parcial_removivel', label:'Prótese parcial removível', code:'PPR', visual:'coroa'},
  {id:'higido', label:'Hígido', code:'H', visual:'higido'},
  {id:'protese_temporaria', label:'Prótese temporária', code:'PT', visual:'coroa'},
  {id:'protese_coronaria', label:'Prótese coronária/unitária', code:'Pc', visual:'coroa'},
  {id:'coroa', label:'Coroa', code:'Co', visual:'coroa'},
  {id:'implante', label:'Implante', code:'Imp', visual:'implante'},
  {id:'pilar', label:'Pilar', code:'P', visual:'coroa'},
  {id:'nucleo', label:'Núcleo', code:'Pino', visual:'coroa'},
  {id:'resto_radicular', label:'Resto radicular', code:'RR', visual:'extraido'},
  {id:'retracao_gengival', label:'Retração gengival', code:'Rg', visual:'outro'},
  {id:'calculo_dental', label:'Cálculo dental', code:'Cd', visual:'outro'},
  {id:'extracao_indicada', label:'Extração indicada', code:'Ei', visual:'extraido'},
  {id:'selante_indicado', label:'Selante indicado', code:'Si', visual:'selante'},
  {id:'fratura', label:'Fratura', code:'Fr', visual:'fratura'},
  {id:'mancha_branca_ativa', label:'Mancha branca ativa', code:'MB', visual:'carie'},
  {id:'cariado', label:'Cariado', code:'C', visual:'carie'},
  {id:'restaurado', label:'Restaurado', code:'R', visual:'restaurado'},
  {id:'carie_raiz', label:'Cárie de raiz', code:'Cr', visual:'carie'},
  {id:'restaurado_com_carie', label:'Restaurado com cárie', code:'Rc', visual:'carie'},
  {id:'raiz_restaurada', label:'Raiz restaurada', code:'Rr', visual:'restaurado'},
  {id:'trat_endodontico', label:'Tratamento endodôntico realizado', code:'Te', visual:'canal'},
  {id:'necessita_endodontico', label:'Necessita de tratamento endodôntico', code:'Ne', visual:'canal'}
];

let odontoPatId = null;
let odontoSelDente = null;
let odontoDentes = {};    // { num: { condicao, procedimento, obs } }
let odontoAtends = [];    // atendimentos salvos
let odontoMainFacesSel = [];
let odontoMainFaceStatus = {};
let odontoMainProcs = [];
let odontoMainReplica = [];
let odontoMainCondsSel = [];

function renderOdontogramaTab(){
  const sel = document.getElementById('odonto-pac-sel');
  if(!sel) return;
  sel.innerHTML = '<option value="">Selecione o paciente</option>' +
    pacientes.map(p=>`<option value="${p.id}"${p.id===odontoPatId?' selected':''}>${escapeHtml(p.nome)}</option>`).join('');
  document.getElementById('odonto-atend-data').value = hoje();
  if(odontoPatId){ renderOdontogramaMain(); }
}

async function onOdontoPacChange(id){
  odontoPatId = id ? parseInt(id) : null;
  odontoSelDente = null;
  document.getElementById('odonto-dente-panel').style.display = 'none';
  if(!odontoPatId){ document.getElementById('odonto-main').style.display='none'; return; }
  showLoading(true);
  // Carrega dentes e atendimentos
  const [{ data: dents }, { data: atends }] = await Promise.all([
    _sb.from('procedimentos_dentes').select('*').eq('clinica_id',clinicaId).eq('paciente_id',odontoPatId),
    _sb.from('atendimentos_odonto').select('*').eq('clinica_id',clinicaId).eq('paciente_id',odontoPatId).order('data',{ascending:false})
  ]);
  showLoading(false);
  // Monta mapa de dentes (último estado de cada dente)
  odontoDentes = {};
  (dents||[]).forEach(d=>{ odontoDentes[d.dente] = d; });
  odontoAtends = atends || [];
  document.getElementById('odonto-main').style.display = '';
  renderOdontogramaMain();
}

function renderOdontogramaMain(){
  renderArcada('arc-sup', FDI_SUP);
  renderArcada('arc-inf', FDI_INF);
  renderLegenda();
  renderHistoricoAtends();
  // Preenche selects de profissional
  const opts = '<option value="">Selecione</option>' + profissionais.map(p=>`<option value="${p.id}">${escapeHtml(p.nome)}</option>`).join('');
  ['odonto-d-prof','odonto-atend-prof'].forEach(id=>{ const el=document.getElementById(id); if(el) el.innerHTML=opts; });
}

/* ── Modern SVG Tooth System — versão anatômica ── */
const TOOTH_COND_COLORS = {
  //                    fill vivo      light(gradiente) stroke escuro    oclFill        raiz
  higido:     { fill:'#fffdf9', light:'#f5eee7', stroke:'#b89b8a', oclFill:'#fffaf4', root:'#d9b98f' },
  carie:      { fill:'#ef5350', light:'#ffcdd2', stroke:'#b71c1c', oclFill:'#ef5350', root:'#c9a080' },
  restaurado: { fill:'#2374c6', light:'#d8eaff', stroke:'#14599c', oclFill:'#2374c6', root:'#d9b98f' },
  extraido:   { fill:'#9e9e9e', light:'#eeeeee', stroke:'#424242', oclFill:'#9e9e9e', root:'#bdbdbd' },
  canal:      { fill:'#ffb300', light:'#fff8e1', stroke:'#e65100', oclFill:'#ffb300', root:'#d9b98f' },
  coroa:      { fill:'#1e88e5', light:'#bbdefb', stroke:'#0d47a1', oclFill:'#1e88e5', root:'#d9b98f' },
  implante:   { fill:'#8e24aa', light:'#e1bee7', stroke:'#4a148c', oclFill:'#8e24aa', root:'#9e9e9e' },
  fratura:    { fill:'#fb8c00', light:'#ffe0b2', stroke:'#bf360c', oclFill:'#fb8c00', root:'#d9b98f' },
  selante:    { fill:'#00acc1', light:'#e0f7fa', stroke:'#006064', oclFill:'#00acc1', root:'#d9b98f' },
  outro:      { fill:'#757575', light:'#eeeeee', stroke:'#212121', oclFill:'#757575', root:'#d9b98f' }
};

function getToothType(num) {
  const u = num % 10;
  if (num >= 51 && num <= 85) {
    if (u === 1 || u === 2) return 'incisor';
    if (u === 3) return 'canine';
    return 'molar_dec';
  }
  if (u === 1 || u === 2) return 'incisor';
  if (u === 3) return 'canine';
  if (u === 4 || u === 5) return 'premolar';
  return 'molar';
}

function isUpperTooth(num) {
  const q = Math.floor(num / 10);
  return q === 1 || q === 2 || q === 5 || q === 6;
}

function toothDefs(id, c){
  const light = c.light || '#f5eee7';
  return `<defs>
    <linearGradient id="${id}c" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%"   stop-color="${light}"/>
      <stop offset="25%"  stop-color="${c.fill}"/>
      <stop offset="65%"  stop-color="${c.fill}"/>
      <stop offset="100%" stop-color="${light}"/>
    </linearGradient>
    <linearGradient id="${id}r" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#f0d8b4"/>
      <stop offset="100%" stop-color="${c.root || '#d9b98f'}"/>
    </linearGradient>
    <filter id="${id}s" x="-30%" y="-30%" width="160%" height="170%">
      <feDropShadow dx="0" dy="2" stdDeviation="1.5" flood-color="#000" flood-opacity="0.18"/>
    </filter>
  </defs>`;
}

function odontoFaceOverlaySVG(faceStatus){
  const status = faceStatus || {};
  const colorFor = (face) => status[face] === 'treated' ? '#2374c6' : status[face] === 'untreated' ? '#d63d46' : '';
  const parts = [
    ['Vestibular', 'M11 9 L29 9 L25 18 L15 18 Z'],
    ['Mesial', 'M8 12 L16 18 L16 34 L9 39 C7 30 6 20 8 12 Z'],
    ['Distal', 'M32 12 C34 20 33 30 31 39 L24 34 L24 18 Z'],
    ['Oclusal', 'M15 18 L25 18 L24 34 L16 34 Z'],
    ['Incisal', 'M15 18 L25 18 L24 34 L16 34 Z'],
    ['Lingual', 'M16 34 L24 34 L29 40 L11 40 Z']
  ];
  return parts.map(([face, d])=>{
    const fill = colorFor(face);
    if(!fill) return '';
    return `<path d="${d}" fill="${fill}" stroke="#fff" stroke-width=".7" opacity=".86"/>`;
  }).join('');
}

function odontoCondSigla(cond){
  return ({extraido:'EX',implante:'IMP',canal:'ENDO',coroa:'CR',fratura:'FX'})[cond] || '';
}

function odontoSiglaSVG(cond){
  const sigla = odontoCondSigla(cond);
  if(!sigla) return '';
  const fs = sigla.length > 3 ? 6 : 7.5;
  return `<g class="odonto-cond-sigla">
    <rect x="8" y="20" width="24" height="11" rx="3" fill="rgba(255,255,255,.88)" stroke="#8f8f8f" stroke-width=".5"/>
    <text x="20" y="28" text-anchor="middle" font-family="Arial, sans-serif" font-size="${fs}" font-weight="800" fill="#3a2020">${sigla}</text>
  </g>`;
}

function getFrontalSVG(type, isUpper, c, isExtr, faceStatus, cond) {
  const id = `t${Math.random().toString(36).slice(2,8)}`;
  const defs = toothDefs(id, c);
  const crownFill = isExtr ? '#ece8e4' : `url(#${id}c)`;
  const rootFill = isExtr ? '#d7d7d7' : `url(#${id}r)`;
  const opacity = isExtr ? ' opacity="0.42"' : '';
  let crown='', root='', grooves='', shine='', sizeW=34;

  if(type === 'incisor'){
    sizeW = 30;
    crown = `<path d="M10 8 C13 4 21 4 24 8 C26 13 25 30 24 36 C21 40 13 40 10 36 C9 29 8 14 10 8 Z" fill="${crownFill}" stroke="${c.stroke}" stroke-width="1.25"${opacity}/>`;
    root = isUpper
      ? `<path d="M13 35 C12 47 13 60 17 70 C21 60 22 47 21 35 Z" fill="${rootFill}" stroke="#caa77f" stroke-width="1"${opacity}/>`
      : `<path d="M13 35 C13 48 14 62 17 70 C20 62 21 48 21 35 Z" fill="${rootFill}" stroke="#caa77f" stroke-width="1"${opacity}/>`;
    shine = `<path d="M13 11 C12 19 12 28 14 34" fill="none" stroke="#fff" stroke-width="2.2" opacity=".55" stroke-linecap="round"/>`;
  } else if(type === 'canine'){
    sizeW = 32;
    crown = `<path d="M8 9 C11 4 23 4 26 9 C27 20 24 32 17 41 C10 32 7 20 8 9 Z" fill="${crownFill}" stroke="${c.stroke}" stroke-width="1.25"${opacity}/>`;
    root = `<path d="M12 38 C11 52 13 66 17 74 C21 66 23 52 22 38 Z" fill="${rootFill}" stroke="#caa77f" stroke-width="1"${opacity}/>`;
    grooves = `<path d="M17 10 C16 20 16 31 17 40" fill="none" stroke="${c.stroke}" stroke-width=".8" opacity=".25"/>`;
    shine = `<path d="M12 11 C10 20 11 28 14 34" fill="none" stroke="#fff" stroke-width="2.2" opacity=".52" stroke-linecap="round"/>`;
  } else if(type === 'premolar'){
    sizeW = 34;
    crown = `<path d="M6 10 C9 5 15 7 17 8 C20 6 26 5 29 10 C31 19 28 32 24 38 C20 41 13 41 10 38 C6 32 4 19 6 10 Z" fill="${crownFill}" stroke="${c.stroke}" stroke-width="1.25"${opacity}/>`;
    root = `<path d="M10 36 C9 50 10 64 13 73 C16 62 17 49 17 37 C18 49 19 62 22 73 C25 64 26 50 24 36 Z" fill="${rootFill}" stroke="#caa77f" stroke-width="1"${opacity}/>`;
    grooves = `<path d="M17 10 C16 20 16 31 17 39 M11 16 C14 14 20 14 23 16" fill="none" stroke="${c.stroke}" stroke-width=".8" opacity=".28" stroke-linecap="round"/>`;
    shine = `<path d="M10 12 C8 20 9 30 12 35" fill="none" stroke="#fff" stroke-width="2.2" opacity=".5" stroke-linecap="round"/>`;
  } else {
    sizeW = type === 'molar_dec' ? 35 : 38;
    crown = `<path d="M5 11 C8 5 15 8 18 9 C22 6 31 5 34 11 C37 20 35 32 31 39 C25 43 14 43 8 39 C4 32 2 20 5 11 Z" fill="${crownFill}" stroke="${c.stroke}" stroke-width="1.25"${opacity}/>`;
    root = isUpper
      ? `<path d="M8 37 C6 49 6 62 9 72 C13 62 14 49 15 38 C16 49 17 60 19 69 C22 59 22 49 22 38 C24 49 26 62 30 72 C33 62 33 49 31 37 Z" fill="${rootFill}" stroke="#caa77f" stroke-width="1"${opacity}/>`
      : `<path d="M9 37 C7 51 8 65 12 74 C16 63 17 50 18 38 C19 50 21 63 26 74 C30 65 31 51 29 37 Z" fill="${rootFill}" stroke="#caa77f" stroke-width="1"${opacity}/>`;
    grooves = `<path d="M18 10 C17 21 17 31 18 40 M9 20 C15 17 25 17 31 20 M11 31 C16 28 24 28 29 31" fill="none" stroke="${c.stroke}" stroke-width=".8" opacity=".28" stroke-linecap="round"/>`;
    shine = `<path d="M9 13 C7 22 8 31 12 36" fill="none" stroke="#fff" stroke-width="2.3" opacity=".5" stroke-linecap="round"/>`;
  }

  const overlay = odontoFaceOverlaySVG(faceStatus);
  const xmark = isExtr ? `<path d="M8 10 L30 38 M30 10 L8 38" stroke="#8f8f8f" stroke-width="3" stroke-linecap="round" opacity=".75"/>` : '';
  const sigla = odontoSiglaSVG(cond);
  return `<svg class="ot-front odonto-tooth-svg" viewBox="0 0 40 78" xmlns="http://www.w3.org/2000/svg" width="${sizeW}" height="66" aria-hidden="true">${defs}<g filter="url(#${id}s)">${root}${crown}${overlay}${grooves}${shine}${xmark}${sigla}</g></svg>`;
}

function getOclusalSVG(type, c) {
  const id = `o${Math.random().toString(36).slice(2,8)}`;
  const defs = `<defs><radialGradient id="${id}g" cx="45%" cy="35%" r="70%"><stop offset="0%" stop-color="#ffffff"/><stop offset="55%" stop-color="${c.oclFill}"/><stop offset="100%" stop-color="#ded3ca"/></radialGradient></defs>`;
  if(type === 'incisor'){
    return `<svg class="ot-ocl" viewBox="0 0 40 18" xmlns="http://www.w3.org/2000/svg" width="30" height="13" aria-hidden="true">${defs}<path d="M8 5 C14 2 26 2 32 5 L33 12 C26 16 14 16 7 12 Z" fill="url(#${id}g)" stroke="${c.stroke}" stroke-width="1.15"/><path d="M13 8 C18 6 23 6 28 8" stroke="${c.stroke}" stroke-width=".7" opacity=".25" fill="none"/></svg>`;
  }
  if(type === 'canine'){
    return `<svg class="ot-ocl" viewBox="0 0 40 20" xmlns="http://www.w3.org/2000/svg" width="31" height="15" aria-hidden="true">${defs}<path d="M20 2 C30 4 35 10 30 16 C24 20 14 20 9 16 C4 10 10 4 20 2 Z" fill="url(#${id}g)" stroke="${c.stroke}" stroke-width="1.15"/><path d="M20 5 L24 10 L20 15 L16 10 Z" fill="none" stroke="${c.stroke}" stroke-width=".75" opacity=".35"/></svg>`;
  }
  if(type === 'premolar'){
    return `<svg class="ot-ocl" viewBox="0 0 40 22" xmlns="http://www.w3.org/2000/svg" width="32" height="17" aria-hidden="true">${defs}<path d="M7 5 C11 1 29 1 33 5 C37 10 35 18 29 20 C24 22 16 22 11 20 C5 18 3 10 7 5 Z" fill="url(#${id}g)" stroke="${c.stroke}" stroke-width="1.15"/><path d="M20 4 C18 9 18 14 20 19 M9 11 C14 7 18 8 20 11 C22 8 27 7 31 11" fill="none" stroke="${c.stroke}" stroke-width=".8" opacity=".42" stroke-linecap="round"/></svg>`;
  }
  return `<svg class="ot-ocl" viewBox="0 0 44 26" xmlns="http://www.w3.org/2000/svg" width="36" height="21" aria-hidden="true">${defs}<path d="M8 5 C13 0 31 0 36 5 C42 11 40 21 32 24 C26 27 18 27 12 24 C4 21 2 11 8 5 Z" fill="url(#${id}g)" stroke="${c.stroke}" stroke-width="1.15"/><path d="M22 4 C24 10 30 10 35 13 C29 14 25 17 22 23 C19 17 15 14 9 13 C14 10 20 10 22 4 Z" fill="none" stroke="${c.stroke}" stroke-width=".85" opacity=".42" stroke-linecap="round"/><path d="M13 7 C16 9 18 10 22 10 M31 7 C28 9 26 10 22 10 M13 20 C16 17 18 16 22 16 M31 20 C28 17 26 16 22 16" fill="none" stroke="${c.stroke}" stroke-width=".65" opacity=".28" stroke-linecap="round"/></svg>`;
}

function getToothSVG(num, cond, extraStyle, faceStatus) {
  const type = getToothType(num);
  const upper = isUpperTooth(num);
  const c = TOOTH_COND_COLORS[cond] || TOOTH_COND_COLORS.higido;
  const isExtr = cond === 'extraido';
  const frontSVG = getFrontalSVG(type, upper, c, isExtr, faceStatus, cond);
  const wStyle = extraStyle ? `style="${extraStyle}"` : '';
  return `<div class="ot-views" ${wStyle}>${frontSVG}</div>`;
}

function odontoFaceGridHTML(num, selectedFaces, handlerName){
  const statusMap = Array.isArray(selectedFaces)
    ? Object.fromEntries(selectedFaces.map(f=>[f,'treated']))
    : (selectedFaces || {});
  const isAnterior = [1,2,3].includes(num % 10);
  const centro = isAnterior ? 'Incisal' : 'Oclusal';
  const cells = [
    ['Vestibular','face-v'],
    ['Mesial','face-m'],
    [centro,'face-c'],
    ['Distal','face-d'],
    ['Lingual','face-l']
  ];
  return `<div class="odonto-facegrid" title="Faces do dente ${num}">${
    cells.map(([face, cls])=>{
      const st = statusMap[face] || '';
      const stCls = st==='treated' ? ' treated' : st==='untreated' ? ' untreated' : '';
      const label = st==='treated' ? `${face}: tratado` : st==='untreated' ? `${face}: não tratado` : face;
      return `<button type="button" class="odonto-facecell ${cls}${stCls}" onclick="${handlerName}(event,${num},'${face}')" title="${label}" aria-label="${label}"></button>`;
    }).join('')
  }</div>`;
}

function odontoToggleFaceInObs(obs, face){
  const status = odontoExtractFaceStatusFromObs(obs);
  if(!status[face]) status[face] = 'treated';
  else if(status[face] === 'treated') status[face] = 'untreated';
  else delete status[face];
  const clean = odontoCleanObsMeta(obs);
  const facesLine = Object.keys(status).length ? 'Faces: '+odontoFaceStatusText(status) : '';
  return [facesLine, clean].filter(Boolean).join('\n');
}

function odontoExtractFacesFromObs(obs){
  return Object.keys(odontoExtractFaceStatusFromObs(obs));
}

function odontoExtractFaceStatusFromObs(obs){
  const match = String(obs||'').match(/^Faces:\s*([^\n]+)\n?/i);
  if(!match) return {};
  const out = {};
  match[1].split(',').map(f=>f.trim()).filter(Boolean).forEach(token=>{
    const parts = token.split('=').map(p=>p.trim());
    if(parts.length===1) out[parts[0]] = 'treated';
    else out[parts[0]] = /nao|não|vermelho|pendente/i.test(parts[1]) ? 'untreated' : 'treated';
  });
  return out;
}

function odontoFaceStatusText(map){
  return Object.entries(map||{}).map(([face,st])=>`${face}=${st==='treated'?'Tratado':'Não tratado'}`).join(', ');
}

function odontoExtractCondsFromObs(obs){
  const match = String(obs||'').match(/^Condições:\s*([^\n]+)\n?/mi);
  if(!match) return [];
  const labels = match[1].split(',').map(s=>s.trim()).filter(Boolean);
  return labels.map(txt=>{
    const code = (txt.match(/\(([^)]+)\)$/)||[])[1];
    const plain = txt.replace(/\s*\([^)]+\)$/,'');
    const found = ODONTO_COND_OPTIONS.find(o=>o.code===code || o.label===plain);
    return found?.id;
  }).filter(Boolean);
}

function odontoCleanObsMeta(obs){
  return String(obs||'')
    .replace(/^Faces:\s*[^\n]+\n?/gmi,'')
    .replace(/^Condições:\s*[^\n]+\n?/gmi,'')
    .trim();
}

function renderArcada(containerId, dentes){
  const c = document.getElementById(containerId);
  if(!c) return;
  const mid = Math.floor(dentes.length / 2);
  c.innerHTML = dentes.map((num, i) => {
    const d = odontoDentes[num] || {};
    const cond = odontoSelDente===num ? odontoCondVisualFromSelected() : (d.condicao || 'higido');
    const sel = odontoSelDente===num ? ' selected' : '';
    const title = d.procedimento ? `${num}: ${d.procedimento}` : `Dente ${num}`;
    const upper = isUpperTooth(num);
    const gap = (i === mid) ? '<div class="odonto-quadrant-gap"></div>' : '';
    const numDiv = `<div class="ot-num">${num}</div>`;
    const faceStatus = odontoSelDente===num ? odontoMainFaceStatus : odontoExtractFaceStatusFromObs(d.obs);
    const toothHTML = getToothSVG(num, cond, '', faceStatus);
    const faceHTML = odontoFaceGridHTML(num, faceStatus, 'odontoFaceGridClick');
    // Upper: frontal → number → faces; Lower: faces → number → frontal
    const inner = upper
      ? `${toothHTML}${numDiv}${faceHTML}`
      : `${faceHTML}${numDiv}${toothHTML}`;
    return `${gap}<div class="odonto-dente-wrap${sel}" onclick="odontoClicarDente(${num})" title="${escapeHtml(title)}">${inner}</div>`;
  }).join('');
}

function renderLegenda(){
  const c = document.getElementById('odonto-legenda');
  if(!c) return;
  const itens = [
    ['higido','#fff','#b89b8a','Hígido'],
    ['carie','#ef5350','#b71c1c','Cárie'],
    ['restaurado','#2374c6','#14599c','Restaurado'],
    ['extraido','#9e9e9e','#424242','Extraído'],
    ['canal','#ffb300','#e65100','Canal'],
    ['coroa','#1e88e5','#0d47a1','Coroa'],
    ['implante','#8e24aa','#4a148c','Implante'],
  ];
  c.innerHTML = itens.map(([,bg,brd,label])=>
    `<div class="odonto-leg"><div class="odonto-leg-dot" style="background:${bg};border-color:${brd};"></div>${label}</div>`
  ).join('');
}

function odontoCondVisualFromSelected(){
  const opt = ODONTO_COND_OPTIONS.find(o=>odontoMainCondsSel.includes(o.id));
  return opt?.visual || 'higido';
}

function odontoMainRenderCondOptions(selectedIds){
  const c = document.getElementById('odonto-d-cond-btns');
  if(!c) return;
  if(selectedIds) odontoMainCondsSel = selectedIds.filter(Boolean);
  document.getElementById('odonto-d-cond').value = odontoCondVisualFromSelected();
  c.innerHTML = ODONTO_COND_OPTIONS.map(o=>{
    const checked = odontoMainCondsSel.includes(o.id);
    return `<label class="odonto-condition-option${checked?' active':''}">
      <input type="checkbox" data-od-main-cond="${o.id}" ${checked?'checked':''} onchange="odontoMainToggleCond('${o.id}')">
      ${escapeHtml(o.label)} (${escapeHtml(o.code)})
    </label>`;
  }).join('');
}

function odontoMainToggleCond(id){
  const idx = odontoMainCondsSel.indexOf(id);
  if(idx>=0) odontoMainCondsSel.splice(idx,1);
  else odontoMainCondsSel.push(id);
  odontoMainRenderCondOptions();
  if(odontoSelDente){
    renderArcada('arc-sup', FDI_SUP);
    renderArcada('arc-inf', FDI_INF);
  }
}

function odontoMainSetCond(cond){
  const match = ODONTO_COND_OPTIONS.find(o=>o.id===cond || o.visual===cond);
  odontoMainRenderCondOptions(match ? [match.id] : []);
}

function odontoMainToggleFace(face){
  const current = odontoMainFaceStatus[face];
  const btn = document.querySelector('[data-odonto-face="'+face+'"]');
  if(!current) odontoMainFaceStatus[face] = 'treated';
  else if(current === 'treated') odontoMainFaceStatus[face] = 'untreated';
  else delete odontoMainFaceStatus[face];
  odontoMainFacesSel = Object.keys(odontoMainFaceStatus);
  if(btn) odontoMainPaintFaceButton(btn, odontoMainFaceStatus[face]);
  if(odontoSelDente){
    renderArcada('arc-sup', FDI_SUP);
    renderArcada('arc-inf', FDI_INF);
  }
}

function odontoMainPaintFaceButton(btn, status){
  if(!status){
    btn.style.borderColor='var(--rose-light)'; btn.style.background='#fff'; btn.style.color='#3a2020';
  } else if(status==='treated'){
    btn.style.borderColor='#14599c'; btn.style.background='#2374c6'; btn.style.color='#fff';
  } else {
    btn.style.borderColor='#a91f2a'; btn.style.background='#d63d46'; btn.style.color='#fff';
  }
}

function odontoMainResetFaces(faces){
  odontoMainFaceStatus = Array.isArray(faces) ? Object.fromEntries(faces.map(f=>[f,'treated'])) : (faces || {});
  odontoMainFacesSel = Object.keys(odontoMainFaceStatus);
  document.querySelectorAll('[data-odonto-face]').forEach(btn=>{
    odontoMainPaintFaceButton(btn, odontoMainFaceStatus[btn.dataset.odontoFace]);
  });
}

function odontoMainFiltrarProcs(){
  const q = _norm(document.getElementById('odonto-d-proc-search')?.value || '');
  const opts = document.getElementById('odonto-d-proc-opts');
  if(!opts) return;
  if(!procs.length){
    opts.innerHTML = "<div style='padding:12px;color:var(--rose-text);text-align:center;font-size:13px;'>Carregando procedimentos...</div>";
    document.getElementById('odonto-d-proc-dd').style.display = 'block';
    loadFinanceiro().then(()=>odontoMainFiltrarProcs());
    return;
  }
  const lista = (q ? procs.filter(p=>_norm(p.nome).includes(q)) : procs)
    .filter(p=>p.ativo!==false)
    .slice(0,80);
  if(!lista.length){
    opts.innerHTML = "<div style='padding:12px;color:var(--rose-text);text-align:center;font-size:13px;'>Nenhum procedimento encontrado.</div>";
    return;
  }
  const grupos = [...new Set(lista.map(p=>p.grupo || 'Procedimentos'))].sort();
  let html = '';
  grupos.forEach(g=>{
    const itens = lista.filter(p=>(p.grupo || 'Procedimentos')===g);
    html += `<div style="padding:5px 10px;font-size:10px;font-weight:700;color:var(--rose-text);text-transform:uppercase;background:var(--rose-lighter);">${escapeHtml(g)}</div>`;
    itens.forEach(p=>{
      const tag = procIsGlobal(p.nome)
        ? '<span style="font-size:10px;background:#e3f2fd;color:#0c5460;border-radius:4px;padding:1px 5px;">Global</span>'
        : '<span style="font-size:10px;background:#e8f5e9;color:#2e7d32;border-radius:4px;padding:1px 5px;">Por dente</span>';
      html += `<div data-od-proc-id="${p.id}" style="padding:9px 14px;cursor:pointer;font-size:13px;border-bottom:1px solid var(--rose-light);display:flex;justify-content:space-between;align-items:center;gap:8px;">
        <span>${escapeHtml(p.nome)} ${tag}</span>
        <span style="color:var(--rose-dark);font-weight:700;white-space:nowrap;">${fmtBRL(p.precoFinal||0)}</span>
      </div>`;
    });
  });
  opts.innerHTML = html;
  opts.querySelectorAll('[data-od-proc-id]').forEach(el=>{
    el.onmouseover = function(){ this.style.background='var(--rose-lighter)'; };
    el.onmouseout  = function(){ this.style.background='#fff'; };
    el.onclick = function(){ odontoMainAddProc(parseInt(this.dataset.odProcId)); };
  });
  document.getElementById('odonto-d-proc-dd').style.display = 'block';
}

function odontoMainAddProc(procId){
  const p = procs.find(x=>x.id===procId);
  if(!p) return;
  if(odontoMainProcs.find(x=>x.nome===p.nome)){ showToast('Procedimento já adicionado.','warn'); return; }
  odontoMainProcs.push({nome:p.nome, preco:p.precoFinal||0, global:procIsGlobal(p.nome)});
  const search = document.getElementById('odonto-d-proc-search');
  if(search) search.value = '';
  const dd = document.getElementById('odonto-d-proc-dd');
  if(dd) dd.style.display = 'none';
  odontoMainRenderProcs();
}

function odontoMainRemoveProc(idx){
  odontoMainProcs.splice(idx,1);
  odontoMainRenderProcs();
}

function odontoMainRenderProcs(){
  const c = document.getElementById('odonto-d-proc-lista');
  const hidden = document.getElementById('odonto-d-proc');
  if(hidden) hidden.value = odontoMainProcs.map(p=>p.nome).join(', ');
  if(!c) return;
  if(!odontoMainProcs.length){
    c.innerHTML = '<div style="font-size:12px;color:var(--rose-text);padding:4px 0;">Nenhum procedimento adicionado.</div>';
    return;
  }
  c.innerHTML = odontoMainProcs.map((p,i)=>{
    const tag = p.global
      ? '<span style="font-size:10px;background:#e3f2fd;color:#0c5460;border-radius:4px;padding:1px 6px;">Global</span>'
      : '<span style="font-size:10px;background:#e8f5e9;color:#2e7d32;border-radius:4px;padding:1px 6px;">Por dente</span>';
    return `<div style="display:flex;align-items:center;gap:8px;padding:6px 10px;background:var(--rose-lighter);border-radius:8px;font-size:13px;">
      <span style="flex:1;">${escapeHtml(p.nome)} ${tag}</span>
      <span style="font-weight:700;color:var(--rose-dark);">${fmtBRL(p.preco||0)}</span>
      <button type="button" onclick="odontoMainRemoveProc(${i})" style="border:none;background:none;cursor:pointer;color:#b33;font-size:16px;padding:0 2px;">×</button>
    </div>`;
  }).join('');
}

function odontoMainToggleReplica(){
  const box = document.getElementById('odonto-replica-box');
  if(!box) return;
  box.style.display = box.style.display==='none' ? '' : 'none';
  odontoMainRenderReplica();
}

function odontoMainRenderReplica(){
  const box = document.getElementById('odonto-replica-dentes');
  if(!box) return;
  const all = [...FDI_SUP, ...FDI_INF].filter(d=>d!==odontoSelDente);
  box.innerHTML = all.map(num=>{
    const active = odontoMainReplica.includes(num);
    return `<button type="button" onclick="odontoMainToggleReplicaDente(${num})" data-odonto-replica="${num}" style="min-width:34px;height:30px;border:1.5px solid ${active?'var(--rose)':'var(--rose-light)'};border-radius:7px;background:${active?'var(--rose)':'#fff'};color:${active?'#fff':'#3a2020'};font-size:11px;font-weight:700;cursor:pointer;">${num}</button>`;
  }).join('');
}

function odontoMainToggleReplicaDente(num){
  const idx = odontoMainReplica.indexOf(num);
  if(idx>=0) odontoMainReplica.splice(idx,1);
  else odontoMainReplica.push(num);
  odontoMainRenderReplica();
}

async function odontoFaceGridClick(evt, num, face){
  if(evt) evt.stopPropagation();
  if(!odontoPatId){ showToast('Selecione um paciente.','warn'); return; }
  const existing = odontoDentes[num];
  const obs = odontoToggleFaceInObs(existing?.obs || '', face);
  const condicao = existing?.condicao || 'higido';
  const data = document.getElementById('odonto-atend-data')?.value || hoje();
  showLoading(true);
  let error = null;
  if(existing?.id){
    ({ error } = await _sb.from('procedimentos_dentes').update({obs, condicao, data}).eq('id', existing.id));
    if(!error) odontoDentes[num] = {...existing, obs, condicao, data};
  } else {
    const { data: novo, error: e } = await _sb.from('procedimentos_dentes').insert([{clinica_id:clinicaId,paciente_id:odontoPatId,dente:num,condicao,procedimento:'',obs,data}]).select().single();
    error = e;
    if(!error) odontoDentes[num] = novo;
  }
  showLoading(false);
  if(error){ showToast('Erro: '+error.message,'error'); return; }
  renderArcada('arc-sup', FDI_SUP);
  renderArcada('arc-inf', FDI_INF);
}

function odontoClicarDente(num){
  if(odontoSelDente === num){
    odontoSelDente = null;
    document.getElementById('odonto-dente-panel').style.display = 'none';
    renderArcada('arc-sup', FDI_SUP);
    renderArcada('arc-inf', FDI_INF);
    return;
  }
  odontoSelDente = num;
  renderArcada('arc-sup', FDI_SUP);
  renderArcada('arc-inf', FDI_INF);
  const panel = document.getElementById('odonto-dente-panel');
  panel.style.display = 'flex';
  document.getElementById('odonto-d-num').textContent = num;
  document.getElementById('odonto-d-nome').textContent = DENTE_NOME[num] || '';
  // Preenche com dados existentes
  const d = odontoDentes[num] || {};
  const obsRaw = d.obs || '';
  const obsClean = odontoCleanObsMeta(obsRaw);
  const facesExistentes = odontoExtractFaceStatusFromObs(obsRaw);
  const condsExistentes = odontoExtractCondsFromObs(obsRaw);
  if(condsExistentes.length) odontoMainRenderCondOptions(condsExistentes);
  else odontoMainSetCond(d.condicao || 'higido');
  odontoMainResetFaces(facesExistentes);
  odontoMainProcs = (d.procedimento || '')
    .split(',')
    .map(s=>s.trim())
    .filter(Boolean)
    .map(nome=>{
      const found = procs.find(p=>p.nome===nome);
      return {nome, preco:found?.precoFinal||0, global:found?procIsGlobal(found.nome):false};
    });
  odontoMainRenderProcs();
  const searchEl = document.getElementById('odonto-d-proc-search');
  if(searchEl) searchEl.value = '';
  odontoMainReplica = [];
  const replicaBox = document.getElementById('odonto-replica-box');
  if(replicaBox) replicaBox.style.display = 'none';
  odontoMainRenderReplica();
  document.getElementById('odonto-d-obs').value  = obsClean;
  panel.scrollIntoView({behavior:'smooth',block:'nearest'});
}

function odontoCancelarDente(){
  odontoSelDente = null;
  document.getElementById('odonto-dente-panel').style.display = 'none';
  odontoMainFacesSel = [];
  odontoMainFaceStatus = {};
  odontoMainProcs = [];
  odontoMainReplica = [];
  odontoMainCondsSel = [];
  renderArcada('arc-sup', FDI_SUP);
  renderArcada('arc-inf', FDI_INF);
}

async function odontoSalvarDente(){
  if(!odontoSelDente || !odontoPatId){ showToast('Selecione um dente.','warn'); return; }
  const condicao     = odontoCondVisualFromSelected();
  const facesTxt     = odontoMainFacesSel.length ? 'Faces: '+odontoFaceStatusText(odontoMainFaceStatus) : '';
  const condsTxt     = odontoMainCondsSel.length
    ? 'Condições: '+odontoMainCondsSel.map(id=>{
        const o = ODONTO_COND_OPTIONS.find(x=>x.id===id);
        return o ? `${o.label} (${o.code})` : id;
      }).join(', ')
    : '';
  const procedimento = odontoMainProcs.map(p=>p.nome).join(', ');
  const obs          = document.getElementById('odonto-d-obs').value.trim();
  const profId       = document.getElementById('odonto-d-prof').value || null;
  const prof         = profissionais.find(p=>p.id==profId);
  const data         = document.getElementById('odonto-atend-data').value || hoje();
  const obsFinal     = [facesTxt, condsTxt, obs].filter(Boolean).join('\n');
  const dentesSalvar = [odontoSelDente, ...odontoMainReplica].filter((v,i,a)=>v && a.indexOf(v)===i);
  showLoading(true);
  let error = null;
  for(const denteNum of dentesSalvar){
    const existing = odontoDentes[denteNum];
    if(existing?.id){
      ({ error } = await _sb.from('procedimentos_dentes').update({
        condicao, procedimento, obs: obsFinal, data,
        profissional_id: profId, profissional_nome: prof?.nome||''
      }).eq('id', existing.id));
      if(!error) odontoDentes[denteNum] = {...existing, condicao, procedimento, obs: obsFinal};
    } else {
      const { data: novo, error: e } = await _sb.from('procedimentos_dentes').insert([{
        clinica_id: clinicaId, paciente_id: odontoPatId,
        dente: denteNum, condicao, procedimento, obs: obsFinal, data,
        profissional_id: profId, profissional_nome: prof?.nome||''
      }]).select().single();
      error = e;
      if(!error) odontoDentes[denteNum] = novo;
    }
    if(error) break;
  }
  showLoading(false);
  if(error){ showToast('Erro: '+error.message,'error'); return; }
  odontoCancelarDente();
  showToast(dentesSalvar.length>1 ? 'Dentes salvos!' : 'Dente salvo!');
}

function odontoToggleForm(){
  const f = document.getElementById('odonto-form-atend');
  f.style.display = f.style.display==='none' ? '' : 'none';
}

async function odontoSalvarAtendimento(){
  if(!odontoPatId){ showToast('Selecione um paciente.','warn'); return; }
  const data     = document.getElementById('odonto-atend-data').value;
  const procs    = document.getElementById('odonto-atend-procs').value.trim();
  const obs      = document.getElementById('odonto-atend-obs').value.trim();
  const profId   = document.getElementById('odonto-atend-prof').value || null;
  const prof     = profissionais.find(p=>p.id==profId);
  if(!data){ showToast('Informe a data.','warn'); return; }
  if(!procs){ showToast('Descreva os procedimentos realizados.','warn'); return; }
  // Coleta dentes que têm procedimentos
  const dentesAtend = Object.entries(odontoDentes)
    .filter(([,d])=>d.procedimento)
    .map(([num,d])=>({ dente:parseInt(num), procedimento:d.procedimento, condicao:d.condicao }));
  showLoading(true);
  const { data: novo, error } = await _sb.from('atendimentos_odonto').insert([{
    clinica_id: clinicaId, paciente_id: odontoPatId,
    data, procedimentos: procs, obs,
    profissional_id: profId, profissional_nome: prof?.nome||'',
    dentes_tratados: JSON.stringify(dentesAtend)
  }]).select().single();
  showLoading(false);
  if(error){ showToast('Erro: '+error.message,'error'); return; }
  odontoAtends.unshift(novo);
  document.getElementById('odonto-atend-procs').value = '';
  document.getElementById('odonto-atend-obs').value = '';
  odontoToggleForm();
  renderHistoricoAtends();
  showToast('Atendimento salvo!');
}

function renderHistoricoAtends(){
  const c = document.getElementById('odonto-historico-list');
  if(!c) return;
  if(!odontoAtends.length){
    c.innerHTML = '<div class="empty"><i class="ti ti-clipboard-off" style="font-size:32px;display:block;margin-bottom:10px;opacity:.35"></i>Nenhum atendimento registrado.</div>';
    return;
  }
  c.innerHTML = odontoAtends.map(a => {
    let dentes = [];
    try { dentes = JSON.parse(a.dentes_tratados||'[]'); } catch(e){}
    return `<div class="atend-card">
      <div class="atend-card-head">
        <span class="atend-card-date"><i class="ti ti-calendar"></i> ${formatDate(a.data)}</span>
        <span style="font-size:12px;color:var(--rose-text);">${escapeHtml(a.profissional_nome||'')}</span>
        <button class="btn-danger" onclick="odontoRemoverAtend(${a.id})"><i class="ti ti-trash"></i></button>
      </div>
      <div class="atend-card-body">
        <strong>Procedimentos:</strong> ${escapeHtml(a.procedimentos)}
        ${a.obs?`<br><strong>Obs:</strong> ${escapeHtml(a.obs)}`:''}
      </div>
      ${dentes.length?`<div class="atend-dentes">${dentes.map(d=>`<span class="atend-dente-badge">Dente ${d.dente}: ${escapeHtml(d.procedimento)}</span>`).join('')}</div>`:''}
    </div>`;
  }).join('');
}

async function odontoRemoverAtend(id){
  if(!confirm('Remover este atendimento?')) return;
  showLoading(true);
  const { error } = await _sb.from('atendimentos_odonto').delete().eq('id',id);
  showLoading(false);
  if(error){ showToast('Erro: '+error.message,'error'); return; }
  odontoAtends = odontoAtends.filter(a=>a.id!==id);
  renderHistoricoAtends();
  showToast('Atendimento removido.');
}



// ══════════════════════════════════════════════════════
// PLANO DE TRATAMENTO DO PACIENTE
// ══════════════════════════════════════════════════════
let pacPlanoList    = [];  // itens do plano
let pacPlanoEditId  = null;
const STATUS_CORES  = {
  pendente : {bg:'#FFF3CD',txt:'#856404',dot:'#FFC107'},
  aprovado : {bg:'#D1ECF1',txt:'#0C5460',dot:'#17A2B8'},
  realizado: {bg:'#D4EDDA',txt:'#155724',dot:'#28A745'},
  cancelado: {bg:'#F8D7DA',txt:'#721C24',dot:'#DC3545'},
};

let _pacCarregarPlanoSeq = 0; // evita que uma busca antiga (lenta) sobrescreva dados mais recentes
async function pacCarregarPlano(pacId){
  const minhaSeq = ++_pacCarregarPlanoSeq;
  const { data } = await _sb.from('plano_tratamento')
    .select('*').eq('clinica_id',clinicaId).eq('paciente_id',pacId)
    .order('created_at',{ascending:false});
  // Se outra chamada mais recente a esta função já rodou enquanto esperávamos
  // a resposta do servidor, descarta este resultado desatualizado (corrige bug
  // em que aprovar o orçamento logo após ir do Odontograma pro Plano fazia o
  // orçamento "desaparecer" — uma busca antiga terminava depois e sobrescrevia
  // a lista já atualizada localmente).
  if(minhaSeq !== _pacCarregarPlanoSeq) return;
  pacPlanoList = data || [];
  pacRenderPlanoResumo();
  pacRenderPlanoLista();
}

async function pacAlterarStatusPlano(id, status){
  let profId = null, profNome = '';
  if(status === 'realizado'){
    const sel = document.getElementById('plano-prof-'+id);
    profId = sel?.value || '';
    if(!profId){ showToast('Selecione quem atendeu o paciente antes de marcar como realizado.','warn'); return; }
    profNome = profissionais.find(p=>p.id==profId)?.nome || '';
  }

  showLoading(true);
  const statusExtra = {};
  if(status === 'aprovado') statusExtra.data_aprovado = new Date().toISOString();
  if(status === 'realizado') statusExtra.data_realizado = new Date().toISOString();
  let { error } = await _sb.from('plano_tratamento').update({ status, ...statusExtra }).eq('id',id);
  if(error && error.message && (error.message.includes('data_aprovado') || error.message.includes('data_realizado'))){
    // Colunas de data não existem na tabela ainda — salva só o status
    ({ error } = await _sb.from('plano_tratamento').update({ status }).eq('id',id));
  }
  showLoading(false);
  if(error){ showToast('Erro: '+error.message,'error'); return; }
  pacPlanoList = pacPlanoList.map(i=> i.id===id ? {...i,status,...statusExtra} : i);

  // Se aprovado, cria venda/orçamento automaticamente
  // Se realizado, marca venda correspondente como finalizada e registra no Histórico
  if(status === 'realizado'){
    const item = pacPlanoList.find(i=>i.id===id);
    if(item){
      const vendaIdx = vendas.findIndex(v=>v.planoItemId===id||
        (v.pacienteId===selectedPatientId && v.status==='orcamento' &&
         v.itens?.some(it=>it.nome===item.procedimento)));
      if(vendaIdx>=0){
        const _v = vendas[vendaIdx];
        // Desconta estoque dos materiais (bug fix: estava faltando aqui)
        const _itensProc = (_v.itens||[]).filter(i=>i.procId).map(i=>({procId:i.procId,qtd:i.qtd||1}));
        const _consumo = computeConsumo(_itensProc);
        const _aplicado = aplicarBaixaEstoque(_consumo);
        _v.status='finalizada';
        _v.dataFinal=new Date().toISOString();
        _v.consumo=_aplicado;
        const _eVF2=await saveFinanceiro(); // bug fix: estava sem await
        if(_eVF2) showToast('Erro ao salvar venda finalizada: '+_eVF2.message,'error');
        renderEstoque();
      }

      const dentesArr = (item.dente||'').split(',').filter(Boolean).map(d=>({dente:parseInt(d)||d,procedimento:item.procedimento}));
      const { error: histErr } = await _sb.from('atendimentos_odonto').insert([{
        clinica_id: clinicaId, paciente_id: selectedPatientId,
        data: hoje(), procedimentos: item.procedimento, obs: item.descricao||'',
        profissional_id: profId||null, profissional_nome: profNome,
        dentes_tratados: JSON.stringify(dentesArr)
      }]);
      if(histErr) showToast('Realizado, mas não consegui registrar no Histórico: '+histErr.message,'warn');
    }
  }

  if(status === 'aprovado'){
    const item = pacPlanoList.find(i=>i.id===id);
    if(item){
      const pacId = selectedPatientId;
      const pac = pacientes.find(p=>p.id===pacId);
      const proc = procs.find(p=>p.nome===item.procedimento);
      const total = parseFloat((item.valor||'0').replace(',','.'));
      const qtd = item.quantidade_dentes||1;
      const precoUnit = qtd > 0 ? total / qtd : total;
      const venda = {
        id: nextVendaId++,
        status: 'orcamento',
        pacienteId: pacId,
        pacienteNome: pac?.nome||'',
        itens: [{
          procId: proc?.id||null,
          qtd: qtd,
          precoUnit: precoUnit,
          nome: item.procedimento,
          dente: item.dente||'',
          descDente: item.descricao||''
        }],
        subtotal: total,
        desconto: 0,
        total: total,
        data: new Date().toISOString(),
        planoItemId: id
      };
      vendas.push(venda);
      const _eOrc=await saveFinanceiro();
      if(!_eOrc) showToast('Orçamento criado para: '+item.procedimento);
      if(document.getElementById('pac-orc-lista')) pacRenderOrcamentos(pacId);
    }
  }

  pacRenderPlanoResumo();
  pacRenderPlanoLista();
}

// Desfazer "Realizado" — volta o item para Aprovado (ou Pendente, se nunca foi aprovado)
async function pacDesfazerRealizadoPlano(id){
  const item = pacPlanoList.find(i=>i.id===id);
  if(!item || item.status!=='realizado') return;
  const novo = item.data_aprovado ? 'aprovado' : 'pendente';
  if(!confirm(`Desfazer "Realizado"? O item volta para ${novo==='aprovado'?'Aprovado':'Pendente'}. Se uma venda foi finalizada junto, ela volta para orçamento e o estoque é devolvido.`)) return;
  showLoading(true);
  let { error } = await _sb.from('plano_tratamento').update({status:novo, data_realizado:null}).eq('id',id);
  if(error && error.message && error.message.includes('data_realizado')){
    ({ error } = await _sb.from('plano_tratamento').update({status:novo}).eq('id',id));
  }
  if(error){ showLoading(false); showToast('Erro: '+error.message,'error'); return; }
  item.status = novo; item.data_realizado = null;
  // Reverte a venda auto-finalizada vinculada exclusivamente a este item
  const v = vendas.find(x=>x.planoItemId===id && x.status==='finalizada');
  if(v){
    if(v.consumo && v.consumo.length) devolverEstoque(v.consumo);
    v.status='orcamento'; v.consumo=null; v.dataFinal=null;
    const _eDesf = await saveFinanceiro();
    if(_eDesf) showToast('Erro ao reverter a venda: '+_eDesf.message,'error');
    renderEstoque();
  }
  showLoading(false);
  pacRenderPlanoResumo();
  pacRenderPlanoLista();
  showToast(`Item voltou para ${novo==='aprovado'?'Aprovado':'Pendente'}. Se um registro foi criado na aba Realizados, apague-o por lá se necessário.`,'warn');
}

// Devolver item do plano para Pendente
async function pacDesaprovarPlano(id){
  if(!confirm('Devolver para Pendente? O orçamento gerado (se houver) não será removido automaticamente.')) return;
  showLoading(true);
  // Tenta limpar data_aprovado; se coluna nao existir, salva so status
  let { error } = await _sb.from('plano_tratamento').update({status:'pendente',data_aprovado:null}).eq('id',id);
  if(error && error.message && error.message.includes('data_aprovado')){
    ({ error } = await _sb.from('plano_tratamento').update({status:'pendente'}).eq('id',id));
  }
  showLoading(false);
  if(error){ showToast('Erro: '+error.message,'error'); return; }
  pacPlanoList = pacPlanoList.map(i=> i.id===id ? {...i,status:'pendente',data_aprovado:null} : i);
  pacRenderPlanoLista();
  showToast('Item voltou para Pendente.');
}

// Atualiza o valor de um item do plano direto na tela de revisão (sem abrir formulário)
async function pacAtualizarValorPlano(id, novoValorStr){
  const item = pacPlanoList.find(i=>i.id===id);
  if(!item) return;
  const limpo = (novoValorStr||'0').replace(/[^\d,.-]/g,'').replace('.',',');
  showLoading(true);
  const { error } = await _sb.from('plano_tratamento').update({ valor: limpo }).eq('id',id);
  showLoading(false);
  if(error){ showToast('Erro: '+error.message,'error'); return; }
  item.valor = limpo;
  pacRenderPlanoResumo();
  showToast('Valor atualizado.');
}

async function pacRemoverPlano(id){
  if(!confirm('Remover este item do plano?')) return;
  showLoading(true);
  const { error } = await _sb.from('plano_tratamento').delete().eq('id',id);
  showLoading(false);
  if(error){ showToast('Erro: '+error.message,'error'); return; }
  pacPlanoList = pacPlanoList.filter(i=>i.id!==id);
  pacRenderPlanoResumo();
  pacRenderPlanoLista();
  showToast('Removido.');
}

function pacRenderPlanoResumo(){
  const c = document.getElementById('pac-plano-resumo');
  if(!c) return;
  const ativos = pacPlanoList.filter(i=>i.status!=='cancelado');
  const totalOrc = ativos.reduce((acc,i)=>acc+parseFloat((i.valor||'0').replace(',','.')),0);
  const realizados = pacPlanoList.filter(i=>i.status==='realizado');
  const totalReal  = realizados.reduce((acc,i)=>acc+parseFloat((i.valor||'0').replace(',','.')),0);
  const pendentes  = pacPlanoList.filter(i=>i.status==='pendente'||i.status==='aprovado').length;
  c.innerHTML = [
    {lbl:'Total orçado',val:`R$ ${totalOrc.toFixed(2).replace('.',',')}`,cor:'var(--rose-dark)'},
    {lbl:'Realizado',val:`R$ ${totalReal.toFixed(2).replace('.',',')}`,cor:'#2e7d32'},
    {lbl:'Pendentes',val:pendentes,cor:'#b36000'},
  ].map(s=>`
    <div style="flex:1;min-width:120px;background:var(--rose-lighter);border:1px solid var(--rose-light);border-radius:10px;padding:12px 16px;">
      <div style="font-size:11px;color:var(--rose-text);margin-bottom:4px;">${s.lbl}</div>
      <div style="font-size:20px;font-weight:800;color:${s.cor};">${s.val}</div>
    </div>
  `).join('');
}

// ══════════════════════════════════════════════════════
// ABAS DO PACIENTE — ODONTOGRAMA + PROCEDIMENTOS
// ══════════════════════════════════════════════════════
const PAC_FDI_SUP = [18,17,16,15,14,13,12,11,21,22,23,24,25,26,27,28];
const PAC_FDI_INF = [48,47,46,45,44,43,42,41,31,32,33,34,35,36,37,38];
const PAC_FDI_DEC_SUP = [55,54,53,52,51,61,62,63,64,65];
const PAC_FDI_DEC_INF = [85,84,83,82,81,71,72,73,74,75];
const PAC_COND_PT = {higido:'Hígido',carie:'Cárie',restaurado:'Restaurado',extraido:'Extraído',canal:'Canal',coroa:'Coroa',implante:'Implante',fratura:'Fratura',selante:'Selante',outro:'Outro'};

let pacDentesMap  = {};  // { dente_num: registro }
let pacDenteSel   = null;
let pacProcsList  = [];
let pacDentesRascunho = {};
let pacFaceStatus = {};
let pacFaceColors = {};  // { dentNum: { FaceName: ''|'treated'|'untreated' } } — cicla: azul→vermelho→limpar
let pacPerioSextants = {};  // { S1: bool, ... } — sextantes selecionados na periodontia
let pacPerioProcSel  = {};  // { procId: qty } — procedimentos periodontal selecionados

async function pacCarregarOdonto(pacId){
  const { data } = await _sb.from('procedimentos_dentes')
    .select('*').eq('clinica_id',clinicaId).eq('paciente_id',pacId);
  pacDentesMap = {};
  (data||[]).forEach(d => { pacDentesMap[d.dente] = d; });
  pacDenteSel = null;
  pacDenteProcs = [];
  pacFacesSel = [];
  pacFaceStatus = {};
  pacDentesRascunho = {};
  pacFaceColors = {};
  pacPerioSextants = {};
  pacPerioProcSel  = {};
  pacOdontoOrcList = [];
  pacRenderArcadas();
  pacRenderLegenda();
  pacRenderDentesHistorico();
}

function pacOdontoSubtab(tab){
  document.querySelectorAll('[data-pac-odonto-sub]').forEach(el=>{ el.style.display = el.id === 'pac-odonto-sub-'+tab ? '' : 'none'; });
  document.querySelectorAll('[data-pac-odonto-subtab]').forEach(btn=>btn.classList.toggle('active', btn.dataset.pacOdontoSubtab===tab));
  if(tab === 'periodontia') pacPerioRenderProcs();
}

async function pacSalvarTecidos(pacId){
  const vals = {
    labios: document.getElementById('pac-tec-labios')?.value.trim() || 'Sem alterações',
    lingua: document.getElementById('pac-tec-lingua')?.value.trim() || 'Sem alterações',
    palato: document.getElementById('pac-tec-palato')?.value.trim() || 'Sem alterações',
    atm: document.getElementById('pac-tec-atm')?.value.trim() || 'Sem alterações',
    obs: document.getElementById('pac-tec-obs')?.value.trim() || ''
  };
  const desc = `Tecidos moles e duros: Lábios/mucosa: ${vals.labios}; Língua/assoalho: ${vals.lingua}; Palato/orofaringe: ${vals.palato}; ATM/oclusão: ${vals.atm}`;
  showLoading(true);
  const { error } = await _sb.from('atendimentos_odonto').insert([{clinica_id:clinicaId,paciente_id:pacId,data:hoje(),procedimentos:desc,obs:vals.obs,dentes_tratados:'[]'}]);
  showLoading(false);
  if(error){ showToast('Erro: '+error.message,'error'); return; }
  showToast('Tecidos moles e duros salvos no histórico.');
}

async function pacSalvarPeriodontia(pacId){
  const sextStr = Object.keys(pacPerioSextants).filter(s=>pacPerioSextants[s]).join(', ') || 'sem sextante';
  const procStr = Object.keys(pacPerioProcSel)
    .filter(id=>(pacPerioProcSel[id]||0)>0)
    .map(id=>{ const p=procs.find(x=>x.id===Number(id)); return p?`${p.nome} (${pacPerioProcSel[id]}×)`:null; })
    .filter(Boolean).join(', ');
  const obs = document.getElementById('pac-perio-obs')?.value.trim() || '';
  const desc = `Periodontia — Sextantes: ${sextStr}${procStr ? '. Procedimentos: '+procStr : ''}`;
  showLoading(true);
  const { error } = await _sb.from('atendimentos_odonto').insert([{clinica_id:clinicaId,paciente_id:pacId,data:hoje(),procedimentos:desc,obs,dentes_tratados:'[]'}]);
  showLoading(false);
  if(error){ showToast('Erro: '+error.message,'error'); return; }
  showToast('Periodontia registrada no histórico.');
}

function pacPerioToggleSextant(s){
  pacPerioSextants[s] = !pacPerioSextants[s];
  const el = document.getElementById('pac-perio-z-'+s);
  if(el) el.classList.toggle('selected', !!pacPerioSextants[s]);
  const chip = document.getElementById('pac-perio-chip-'+s);
  if(chip) chip.classList.toggle('active', !!pacPerioSextants[s]);
  pacPerioRenderResumo();
}

function pacPerioRenderResumo(){
  const resumo = document.getElementById('pac-perio-sel-resumo');
  if(!resumo) return;
  const sel = Object.keys(pacPerioSextants).filter(s=>pacPerioSextants[s]);
  const procSel = Object.keys(pacPerioProcSel).filter(id=>(pacPerioProcSel[id]||0)>0);
  if(!sel.length && !procSel.length){ resumo.style.display='none'; return; }
  resumo.style.display='';
  let html = '';
  if(sel.length) html += `<strong>Sextantes:</strong> ${sel.join(', ')}`;
  if(procSel.length){
    if(sel.length) html += '<br>';
    html += '<strong>Procedimentos:</strong> ' + procSel.map(id=>{
      const p = procs.find(x=>x.id===Number(id));
      return p ? `${escapeHtml(p.nome)} × ${pacPerioProcSel[id]}` : '';
    }).filter(Boolean).join(' · ');
  }
  resumo.innerHTML = html;
}

function pacPerioRenderProcs(){
  const search = (document.getElementById('pac-perio-search')?.value||'').toLowerCase().trim();
  const list = document.getElementById('pac-perio-proc-list');
  if(!list) return;
  const filtered = (procs||[]).filter(p => !p.inativo && (!search || p.nome.toLowerCase().includes(search)));
  if(!filtered.length){
    list.innerHTML = '<div style="padding:14px;text-align:center;color:var(--rose-text);font-size:12px;">Nenhum procedimento encontrado</div>';
    return;
  }
  list.innerHTML = filtered.slice(0,60).map(p => {
    const qty = pacPerioProcSel[p.id] || 0;
    const sel = qty > 0;
    return `<div class="perio-proc-list-item" style="background:${sel?'#fff9f9':'#fff'};">
      <span style="flex:1;font-size:13px;${sel?'font-weight:700;color:var(--rose-dark);':''}">${escapeHtml(p.nome)}</span>
      <span style="font-size:11px;color:var(--rose-text);min-width:52px;text-align:right;">${fmtBRL(p.precoFinal)}</span>
      <div style="display:flex;align-items:center;gap:2px;">
        <button onclick="pacPerioProcChange(${p.id},-1)" style="width:22px;height:22px;border:1px solid var(--rose-light);border-radius:4px;background:var(--rose-lighter);cursor:pointer;font-size:15px;line-height:1;color:var(--rose-dark);display:flex;align-items:center;justify-content:center;">−</button>
        <span style="width:24px;text-align:center;font-size:12px;font-weight:700;color:var(--rose-dark);">${qty||'&nbsp;'}</span>
        <button onclick="pacPerioProcChange(${p.id},1)" style="width:22px;height:22px;border:1.5px solid ${sel?'var(--rose)':'var(--rose-light)'};border-radius:4px;background:${sel?'var(--rose)':'var(--rose-lighter)'};cursor:pointer;font-size:15px;line-height:1;color:${sel?'#fff':'var(--rose-dark)'};display:flex;align-items:center;justify-content:center;">+</button>
      </div>
    </div>`;
  }).join('');
}

function pacPerioProcChange(procId, delta){
  const cur = pacPerioProcSel[procId] || 0;
  const next = Math.max(0, cur + delta);
  if(next === 0) delete pacPerioProcSel[procId];
  else pacPerioProcSel[procId] = next;
  pacPerioRenderProcs();
  pacPerioRenderResumo();
}

function pacPerioAdicionarOrcamento(pacId){
  const procIds = Object.keys(pacPerioProcSel).map(Number).filter(id=>(pacPerioProcSel[id]||0)>0);
  if(!procIds.length){ showToast('Selecione ao menos um procedimento.','warn'); return; }
  const sextStr = Object.keys(pacPerioSextants).filter(s=>pacPerioSextants[s]).join(', ') || 'Periodontia';
  if(!pacOdontoOrcList) pacOdontoOrcList = [];
  procIds.forEach(procId=>{
    const proc = procs.find(p=>p.id===procId);
    if(!proc) return;
    const qty = pacPerioProcSel[procId];
    pacOdontoOrcList.push({
      procId: proc.id,
      nome: `Periodontia (${sextStr}) — ${proc.nome}`,
      precoUnit: proc.precoFinal,
      qtd: qty,
      total: proc.precoFinal * qty,
      dentes: '',
      tipo: 'global'
    });
  });
  pacOdontoRenderOrcLista();
  showToast('Adicionado ao orçamento!');
}

function pacRenderArcadas(){
  pacRenderArcada('pac-arc-sup',     PAC_FDI_SUP);
  pacRenderArcada('pac-arc-inf',     PAC_FDI_INF);
  const pac = pacientes.find(p=>p.id===selectedPatientId);
  const mostrarDeciduos = calcIdade(pac?.nascimento) !== null && calcIdade(pac?.nascimento) < 13;
  if(mostrarDeciduos){
    pacRenderArcada('pac-arc-dec-sup', PAC_FDI_DEC_SUP);
    pacRenderArcada('pac-arc-dec-inf', PAC_FDI_DEC_INF);
  }
}

function pacRenderArcada(id, dentes){
  const c = document.getElementById(id);
  if(!c) return;
  const mid = Math.floor(dentes.length / 2);
  c.innerHTML = dentes.map((num, i) => {
    const r    = pacDentesRascunho[num];
    const d    = pacDentesMap[num] || {};
    const cond = r ? r.condicao : (d.condicao || 'higido');
    const sel  = pacDenteSel===num ? ' selected' : '';
    const hasPending = !!r;
    const tip  = r ? `Dente ${num}: ${r.procs.map(p=>p.nome).join(', ')||'rascunho'} (não salvo)` :
                 d.procedimento ? `${num}: ${d.procedimento}` : `Dente ${num}`;
    const upper = isUpperTooth(num);
    const gap = (i === mid) ? '<div class="odonto-quadrant-gap"></div>' : '';
    const savedFaces = r ? (r.faceStatus || Object.fromEntries((r.faces||[]).map(f=>[f,'treated']))) : (d.face && d.face!=='–' ? Object.fromEntries(d.face.split(',').map(f=>f.trim()).filter(Boolean).map(f=>[f,'treated'])) : odontoExtractFaceStatusFromObs(d.obs));
    const faceStatus = pacDenteSel===num ? pacFaceStatus : savedFaces;
    const pendingDot = hasPending ? '<div class="odonto-pending-dot"></div>' : '';
    const pendingStyle = hasPending ? 'filter:drop-shadow(0 0 4px rgba(245,158,11,.7));' : '';
    // Front SVG clickable (opens detail panel); face grid has its own click (cycles colors)
    const type  = getToothType(num);
    const cl    = TOOTH_COND_COLORS[cond] || TOOTH_COND_COLORS.higido;
    const frontSVG = getFrontalSVG(type, upper, cl, cond === 'extraido', faceStatus, cond);
    const faceGrid = getFaceGridPacHTML(num, faceStatus);
    const frontWrap = `<div onclick="pacClicarDente(${num});event.stopPropagation()" style="cursor:pointer;${pendingStyle}">${frontSVG}</div>`;
    const numDiv = `<div class="ot-num" onclick="pacClicarDente(${num});event.stopPropagation()" style="cursor:pointer;">${num}</div>`;
    const views = `<div class="ot-views">${frontWrap}${faceGrid}</div>`;
    const inner = upper ? `${numDiv}${views}` : `${views}${numDiv}`;
    return `${gap}<div class="odonto-dente-wrap${sel}" title="${escapeHtml(tip)}">${pendingDot}${inner}</div>`;
  }).join('');
}

function pacRenderLegenda(){
  const c = document.getElementById('pac-odonto-legenda');
  if(!c) return;
  const itens2 = [
    ['#fff','#b89b8a','Hígido'],['#ef5350','#b71c1c','Cárie'],['#2374c6','#14599c','Restaurado'],
    ['#9e9e9e','#424242','Extraído'],['#ffb300','#e65100','Canal'],['#1e88e5','#0d47a1','Coroa'],['#8e24aa','#4a148c','Implante']
  ];
  c.innerHTML = '<span class="odonto-face-status untreated">Não tratado</span><span class="odonto-face-status treated">Tratado</span>' + itens2.map(([bg,brd,lbl])=>
    `<div class="odonto-leg"><div class="odonto-leg-dot" style="background:${bg};border-color:${brd};"></div>${lbl}</div>`
  ).join('');
}

function pacToggleFaceStatusMap(status, face){
  const next = {...(status || {})};
  if(!next[face]) next[face] = 'treated';
  else if(next[face] === 'treated') next[face] = 'untreated';
  else delete next[face];
  return next;
}

async function pacClickFace(num, face, e) {
  if(e) e.stopPropagation();
  if(pacDenteSel === num){
    pacFaceStatus = pacToggleFaceStatusMap(pacFaceStatus, face);
    pacFacesSel = Object.keys(pacFaceStatus);
    document.querySelectorAll('[data-face]').forEach(b=>pacPaintFaceButton(b, pacFaceStatus[b.dataset.face]));
    const input = document.getElementById('pac-d-faces');
    if(input) input.value = pacFacesSel.join(',');
    pacRenderArcadas();
    return;
  }
  if(pacDentesRascunho[num]){
    pacDentesRascunho[num].faceStatus = pacToggleFaceStatusMap(pacDentesRascunho[num].faceStatus, face);
    pacDentesRascunho[num].faces = Object.keys(pacDentesRascunho[num].faceStatus);
    pacRenderArcadas();
    return;
  }
  if(!selectedPatientId){ showToast('Selecione um paciente.','warn'); return; }
  const existing = pacDentesMap[num];
  const obs = odontoToggleFaceInObs(existing?.obs || '', face);
  const condicao = existing?.condicao || 'higido';
  showLoading(true);
  let error = null;
  if(existing?.id){
    ({ error } = await _sb.from('procedimentos_dentes').update({obs, condicao, data:hoje()}).eq('id', existing.id));
    if(!error) pacDentesMap[num] = {...existing, obs, condicao, data:hoje()};
  } else {
    const { data: novo, error: e } = await _sb.from('procedimentos_dentes').insert([{clinica_id:clinicaId,paciente_id:selectedPatientId,dente:num,condicao,procedimento:'',obs,data:hoje()}]).select().single();
    error = e;
    if(!error) pacDentesMap[num] = novo;
  }
  showLoading(false);
  if(error){ showToast('Erro: '+error.message,'error'); return; }
  pacRenderArcadas();
  pacRenderDentesHistorico();
}

function getFaceGridPacHTML(num, faceStatus) {
  const fc = faceStatus || {};
  const FILL = {none:'#ffffff', treated:'#2374c6', untreated:'#d63d46'};
  const STROKE = {none:'#b0a09a', treated:'#14599c', untreated:'#a91f2a'};
  function zone(face, pts, isRect) {
    const st = fc[face] || 'none';
    const f = FILL[st] || FILL.none, s = STROKE[st] || STROKE.none;
    const shape = isRect
      ? `<rect x="11" y="11" width="10" height="10" fill="${f}" stroke="${s}" stroke-width="1.1"/>`
      : `<polygon points="${pts}" fill="${f}" stroke="${s}" stroke-width="1.1"/>`;
    return `<g class="fg-zone" onclick="pacClickFace(${num},'${face}',event)">${shape}</g>`;
  }
  return `<svg class="ot-face-grid" width="36" height="36" viewBox="0 0 32 32"
    xmlns="http://www.w3.org/2000/svg" onclick="event.stopPropagation()"
    title="1º toque: tratado; 2º: não tratado; 3º: limpar">
    <rect width="32" height="32" rx="3" fill="#f7f1ee" stroke="#c9b5ae" stroke-width="0.8"/>
    ${zone('Vestibular','1,1 31,1 21,11 11,11')}
    ${zone('Mesial','1,1 11,11 11,21 1,31')}
    ${zone('Oclusal','',true)}
    ${zone('Distal','31,1 21,11 21,21 31,31')}
    ${zone('Lingual','1,31 11,21 21,21 31,31')}
  </svg>`;
}

function pacSalvarRascunhoDenteAtual(){
  if(!pacDenteSel) return;
  pacDentesRascunho[pacDenteSel] = {
    condicao: odontoCondSel.length ? odontoCondSel[0] : 'higido',
    faces: [...pacFacesSel],
    faceStatus: {...pacFaceStatus},
    procs: pacDenteProcs.map(p=>({...p})),
    obs: document.getElementById('pac-d-obs')?.value || ''
  };
  // Atualiza visual do dente no odontograma já com a nova condição
  const cond = pacDentesRascunho[pacDenteSel].condicao;
  if(!pacDentesMap[pacDenteSel]) pacDentesMap[pacDenteSel] = {};
  pacDentesMap[pacDenteSel].condicao = cond;
  pacDentesMap[pacDenteSel].procedimento = pacDenteProcs.map(p=>p.nome).join(', ');
}

function pacClicarDente(num){
  // Salva rascunho do dente atual antes de trocar
  pacSalvarRascunhoDenteAtual();

  if(pacDenteSel === num){
    pacDenteSel = null;
    const panel = document.getElementById('pac-dente-panel');
    if(panel) panel.style.display = 'none';
    pacRenderArcadas();
    return;
  }
  pacDenteSel = num;
  pacRenderArcadas();
  const panel = document.getElementById('pac-dente-panel');
  if(!panel) return;
  panel.style.display = '';
  document.getElementById('pac-dente-num').textContent = num;
  document.getElementById('pac-dente-nome').textContent = DENTE_NOME[num]||'';

  // Carrega rascunho se existir, senão usa dado salvo
  const rascunho = pacDentesRascunho[num];
  const d = rascunho ? null : (pacDentesMap[num] || {});

  // Condição
  odontoCondReset();
  const cond = rascunho ? rascunho.condicao : (d.condicao || 'higido');
  if(cond && cond !== 'higido') odontoToggleCond(cond);
  document.getElementById('pac-d-cond').value = cond;

  // Faces
  pacFaceStatus = rascunho ? {...(rascunho.faceStatus || Object.fromEntries((rascunho.faces||[]).map(f=>[f,'treated'])))} : odontoExtractFaceStatusFromObs(d.obs);
  pacFacesSel = Object.keys(pacFaceStatus);
  document.querySelectorAll('[data-face]').forEach(b=>{
    b.style.borderColor='var(--rose-light)'; b.style.background='#fff'; b.style.color='#3a2020';
  });
  if(!Object.keys(pacFaceStatus).length && d.face && d.face!=='–'){
    pacFaceStatus = Object.fromEntries(d.face.split(',').map(f=>f.trim()).filter(Boolean).map(f=>[f,'treated']));
    pacFacesSel = Object.keys(pacFaceStatus);
  }
  document.querySelectorAll('[data-face]').forEach(b=>pacPaintFaceButton(b, pacFaceStatus[b.dataset.face]));
  document.getElementById('pac-d-faces').value = pacFacesSel.join(',');

  // Procs
  if(rascunho){
    pacDenteProcs = rascunho.procs.map(p=>({...p}));
  } else {
    pacDenteProcs = [];
    if(d.procedimento){
      const found = procs.find(p=>p.nome===d.procedimento);
      if(found) pacDenteProcs = [{nome:found.nome, preco:found.precoFinal||0, global:procIsGlobal(found.nome)}];
      else pacDenteProcs = [{nome:d.procedimento, preco:0, global:false}];
    }
  }
  pacRenderDenteProcs();

  // Obs
  const searchEl = document.getElementById('pac-d-proc-search');
  if(searchEl) searchEl.value = '';
  const obsBase = rascunho ? rascunho.obs : (d.obs || '');
  document.getElementById('pac-d-obs').value = String(obsBase).replace(/^Faces:\s*[^\n]+\n?/i,'').trim();
  panel.scrollIntoView({behavior:'smooth',block:'nearest'});
}

function pacFecharDente(){
  pacDenteSel = null;
  pacDenteProcs = [];
  pacFacesSel = [];
  pacFaceStatus = {};
  const panel = document.getElementById('pac-dente-panel');
  if(panel) panel.style.display = 'none';
  pacRenderArcadas();
}

async function pacSalvarDente(pacId){
  // Primeiro salva o rascunho do dente atual visível
  pacSalvarRascunhoDenteAtual();

  const dentesParaSalvar = Object.entries(pacDentesRascunho);
  if(!dentesParaSalvar.length){ showToast('Nenhuma alteração para salvar.','warn'); return; }

  showLoading(true);

  for(const [numStr, r] of dentesParaSalvar){
    const num = parseInt(numStr);
    const condicao    = r.condicao || 'higido';
    const faces       = r.faces.length ? r.faces.join(',') : '–';
    const procedimento= r.procs.map(p=>p.nome).join(', ');
    const obs         = r.obs || '';
    const obsFinal    = [r.faces.length ? 'Faces: '+odontoFaceStatusText(r.faceStatus || Object.fromEntries(r.faces.map(f=>[f,'treated']))) : '', obs].filter(Boolean).join('\n');
    const data        = hoje();
    const existing    = pacDentesMap[num];

    let error;
    if(existing?.id){
      ({ error } = await _sb.from('procedimentos_dentes').update({ condicao, procedimento, obs: obsFinal, data }).eq('id', existing.id));
      if(!error) pacDentesMap[num] = { ...existing, condicao, procedimento, obs: obsFinal };
    } else {
      const { data: novo, error: e } = await _sb.from('procedimentos_dentes').insert([{
        clinica_id: clinicaId, paciente_id: pacId,
        dente: num, condicao, procedimento, obs: obsFinal, data
      }]).select().single();
      error = e;
      if(!error) pacDentesMap[num] = novo;
    }
    if(error){ showLoading(false); showToast('Erro ao salvar dente '+num+': '+error.message,'error'); return; }

    // Adiciona ao orçamento rápido e plano
    if(r.procs.length){
      const numFaces = r.faces.length || 1;
      for(const dp of r.procs){
        const procObj = pacOdontoFindProcExato(dp.nome) || procs.find(p=>p.nome===dp.nome);
        if(procObj){
          pacOdontoUpsertItemOrc(procObj, num, faces);
        }
        const valor = dp.preco ? dp.preco.toFixed(2).replace('.',',') : '0,00';
        // Evita duplicar no plano se o procedimento já existe (realizado, pendente ou aprovado) para o mesmo dente
        const jaExisteNoBD = await _sb.from('plano_tratamento')
          .select('id').eq('clinica_id',clinicaId).eq('paciente_id',pacId)
          .eq('dente',String(num)).eq('procedimento',dp.nome)
          .in('status',['realizado','pendente','aprovado']);
        const jaExisteLocal = pacPlanoList.some(i =>
          String(i.dente) === String(num) && i.procedimento === dp.nome &&
          (i.status === 'realizado' || i.status === 'pendente' || i.status === 'aprovado')
        );
        if(!jaExisteNoBD.data?.length && !jaExisteLocal){
          const { error: ep } = await _sb.from('plano_tratamento').insert([{
            clinica_id:clinicaId, paciente_id:pacId,
            dente: String(num), face: faces,
            procedimento: dp.nome, valor, descricao:obs||'', status:'pendente'
          }]);
          if(!ep){ pacPlanoList.unshift({id:Date.now(),dente:String(num),face:faces,procedimento:dp.nome,valor,descricao:obs||'',status:'pendente'}); }
        }
      }
    }
  }

  // Limpa apenas o rascunho. Mantém pacOdontoOrcList com os procedimentos exatos salvos,
  // para o orçamento rápido não voltar a sugerir um procedimento parecido pelo nome da condição.
  pacDentesRascunho = {};

  showLoading(false);

  // Abre orçamento automaticamente
  const orcPanel = document.getElementById('pac-odonto-orc-panel');
  if(orcPanel && orcPanel.style.display==='none') pacOdontoToggleOrc();
  pacOdontoRenderOrcLista();

  pacFecharDente();
  pacRenderArcadas();
  pacRenderDentesHistorico();
  pacRenderPlanoResumo();
  pacRenderPlanoLista();
  showToast('Todos os dentes salvos e adicionados ao orçamento!');
}

function pacRenderDentesHistorico(){
  const c = document.getElementById('pac-dentes-historico');
  if(!c) return;
  const dentes = Object.values(pacDentesMap).filter(d=>d.procedimento||d.condicao!=='higido');
  if(!dentes.length){
    c.innerHTML = '<div style="text-align:center;color:var(--rose-text);font-size:13px;padding:16px;">Nenhum dente marcado ainda. Clique num dente acima para registrar.</div>';
    return;
  }
  c.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;flex-wrap:wrap;gap:6px;">
      <span style="font-size:12px;font-weight:700;color:var(--rose-text);text-transform:uppercase;">Dentes com registro</span>
      <button class="btn-secondary" style="font-size:11px;padding:4px 12px;" onclick="pacToggleEvolucao()"><i class="ti ti-timeline"></i> Evolução</button>
    </div><div id="pac-evolucao-panel" style="display:none;margin-bottom:12px;"></div>` +
    dentes.sort((a,b)=>a.dente-b.dente).map(d=>`
      <div class="proc-item">
        <div class="proc-header">
          <span class="proc-dente">Dente ${d.dente}</span>
          <span style="font-size:11px;color:var(--rose-text);">${PAC_COND_PT[d.condicao]||'Hígido'}</span>
          <button class="btn-danger" onclick="pacRemoverDente(${d.id})"><i class="ti ti-trash"></i></button>
        </div>
        ${d.procedimento?`<div style="font-size:13px;margin-top:6px;">${escapeHtml(d.procedimento)}</div>`:''}
        ${d.obs?`<div style="font-size:11px;color:var(--rose-text);margin-top:3px;">${escapeHtml(d.obs)}</div>`:''}
      </div>
    `).join('');
}

// ── Evolução do odontograma: linha do tempo dos atendimentos e dentes tratados ──
async function pacToggleEvolucao(){
  const panel = document.getElementById('pac-evolucao-panel');
  if(!panel) return;
  if(panel.style.display!=='none'){ panel.style.display='none'; return; }
  panel.style.display='';
  panel.innerHTML = '<div style="padding:14px;text-align:center;color:var(--rose-text);font-size:12px;">Carregando evolução...</div>';
  const { data, error } = await _sb.from('atendimentos_odonto')
    .select('*').eq('clinica_id',clinicaId).eq('paciente_id',selectedPatientId)
    .order('data',{ascending:false}).limit(50);
  if(error){ panel.innerHTML = '<div style="padding:12px;color:#b33;font-size:12px;">Erro: '+escapeHtml(error.message)+'</div>'; return; }
  if(!data||!data.length){
    panel.innerHTML = '<div style="padding:14px;text-align:center;color:var(--rose-text);font-size:12px;">Nenhum atendimento registrado ainda. A evolução aparece conforme os procedimentos são realizados.</div>';
    return;
  }
  const itens = data.map(a=>{
    let dentes = [];
    try{ dentes = JSON.parse(a.dentes_tratados||'[]'); }catch(e){}
    const badges = (dentes||[]).map(d=>`<span style="background:var(--rose-lighter);color:var(--rose-dark);border-radius:6px;padding:2px 7px;font-size:10px;font-weight:700;" title="${escapeHtml(d.procedimento||'')}">🦷${d.dente}</span>`).join(' ');
    const [y,m,dd] = (a.data||'').split('-');
    return `<div style="display:flex;gap:10px;padding:10px 0;border-bottom:1px solid var(--rose-lighter);">
      <div style="min-width:64px;text-align:center;">
        <div style="font-size:13px;font-weight:800;color:var(--rose-dark);">${dd||'--'}/${m||'--'}</div>
        <div style="font-size:10px;color:var(--rose-text);">${y||''}</div>
      </div>
      <div style="flex:1;">
        <div style="font-size:13px;font-weight:600;color:#3a2020;">${escapeHtml(a.procedimentos||'Atendimento')}</div>
        ${badges?`<div style="display:flex;flex-wrap:wrap;gap:3px;margin-top:4px;">${badges}</div>`:''}
        ${a.profissional_nome?`<div style="font-size:11px;color:var(--rose-text);margin-top:3px;"><i class="ti ti-user"></i> ${escapeHtml(a.profissional_nome)}</div>`:''}
        ${a.obs?`<div style="font-size:11px;color:var(--rose-text);margin-top:2px;">${escapeHtml(a.obs)}</div>`:''}
      </div>
    </div>`;
  }).join('');
  panel.innerHTML = `<div style="border:1.5px solid var(--rose-light);border-radius:12px;padding:12px 16px;background:#fff;">
    <div style="font-size:12px;font-weight:800;color:var(--rose-dark);margin-bottom:6px;"><i class="ti ti-timeline"></i> Evolução do paciente — ${data.length} atendimento(s)</div>
    <div style="max-height:340px;overflow-y:auto;">${itens}</div>
  </div>`;
}

async function pacRemoverDente(id){
  if(!confirm('Remover registro deste dente?')) return;
  showLoading(true);
  const { error } = await _sb.from('procedimentos_dentes').delete().eq('id',id);
  showLoading(false);
  if(error){ showToast('Erro: '+error.message,'error'); return; }
  Object.keys(pacDentesMap).forEach(k=>{ if(pacDentesMap[k].id===id) delete pacDentesMap[k]; });
  pacRenderArcadas();
  pacRenderDentesHistorico();
  showToast('Removido.');
}

// ── PROCEDIMENTOS GERAIS ──
async function pacCarregarProcs(pacId){
  const { data } = await _sb.from('atendimentos_odonto')
    .select('*').eq('clinica_id',clinicaId).eq('paciente_id',pacId)
    .order('data',{ascending:false});
  pacProcsList = data || [];
  pacRenderProcLista();
  const dataEl = document.getElementById('pac-proc-data');
  if(dataEl) dataEl.value = hoje();
}

function pacToggleNovoProc(){
  const f = document.getElementById('pac-proc-form');
  if(f) f.style.display = f.style.display==='none'?'':'none';
}

async function pacSalvarProc(pacId){
  const data  = document.getElementById('pac-proc-data')?.value;
  const desc  = document.getElementById('pac-proc-desc')?.value.trim();
  const obs   = document.getElementById('pac-proc-obs')?.value.trim();
  const profId= document.getElementById('pac-proc-prof')?.value || null;
  const prof  = profissionais.find(p=>p.id==profId);
  if(!data){ showToast('Informe a data.','warn'); return; }
  if(!desc){ showToast('Descreva os procedimentos.','warn'); return; }
  showLoading(true);
  const { data: novo, error } = await _sb.from('atendimentos_odonto').insert([{
    clinica_id: clinicaId, paciente_id: pacId,
    data, procedimentos: desc, obs: obs||'',
    profissional_id: profId, profissional_nome: prof?.nome||'',
    dentes_tratados: '[]'
  }]).select().single();
  showLoading(false);
  if(error){ showToast('Erro: '+error.message,'error'); return; }
  pacProcsList.unshift(novo);
  document.getElementById('pac-proc-desc').value = '';
  document.getElementById('pac-proc-obs').value  = '';
  pacToggleNovoProc();
  pacRenderProcLista();
  showToast('Procedimento salvo!');
}

function pacRenderProcLista(){
  const c = document.getElementById('pac-proc-lista');
  if(!c) return;
  if(!pacProcsList.length){
    c.innerHTML = '<div style="text-align:center;color:var(--rose-text);font-size:13px;padding:16px;">Nenhum procedimento registrado ainda.</div>';
    return;
  }
  c.innerHTML = pacProcsList.map(a=>{
    const prof = profissionais.find(p=>p.id==a.profissional_id);
    // Carrega assinaturas salvas
    let sigExist = {};
    try{ sigExist = JSON.parse(a.assinaturas||'{}'); }catch(e){}
    const key = getSignKey(selectedPatientId, a.id);
    if(!assinaturasAtend[key] && (sigExist.paciente||sigExist.profissional)){
      assinaturasAtend[key] = sigExist;
    }
    return `<div class="atend-card">
      <div class="atend-card-head">
        <span class="atend-card-date"><i class="ti ti-calendar"></i> ${formatDate(a.data)}</span>
        <span style="font-size:12px;color:var(--rose-text);">${escapeHtml(a.profissional_nome||'')}</span>
        <button class="btn-danger" onclick="pacRemoverProc(${a.id})"><i class="ti ti-trash"></i></button>
      </div>
      <div class="atend-card-body">${escapeHtml(a.procedimentos)}</div>
      ${a.obs?`<div style="font-size:12px;color:var(--rose-text);margin-top:4px;">${escapeHtml(a.obs)}</div>`:''}
      ${renderSignArea(selectedPatientId, a.id, a.procedimentos||'Atendimento', prof?.nome||a.profissional_nome||'', prof?.cro||'', sigExist)}
    </div>`;
  }).join('');
}

async function pacRemoverProc(id){
  if(!confirm('Remover este procedimento?')) return;
  showLoading(true);
  const { error } = await _sb.from('atendimentos_odonto').delete().eq('id',id);
  showLoading(false);
  if(error){ showToast('Erro: '+error.message,'error'); return; }
  pacProcsList = pacProcsList.filter(a=>a.id!==id);
  pacRenderProcLista();
  showToast('Removido.');
}

// ── ODONTOGRAMA: FACES + PROCS POR DENTE ──
let pacFacesSel  = [];
let pacDenteProcs = [];  // [{nome, preco, global}]
let pacDenteProcSelObj = null;

// Procedimentos que cobram POR DENTE / por face
const PROCS_POR_DENTE_KEYWORDS = [
  'restaur','resina','amalgama','civ','faceta','recontorno','selante','coroa','cimentação','núcleo',
  'exodontia','extração','siso','implante','endodontia','canal','pulpotomia','pulpectomia',
  'curativo','retratamento','apicectomia','capeamento','urgência endodôntica',
  'raspagem subgengival','gengivoplastia','frenectomia','biópsia','parendodôntica',
  'núcleo intrarradicular'
];
// Procedimentos GLOBAIS (não por dente)
const PROCS_GLOBAL_KEYWORDS = [
  'profilaxia','limpeza','flúor','clareamento','aparelho','ortodon','manutenção mensal',
  'instalação aparel','remoção de aparel','contenção','placa miorr','toxina','documentação',
  'moldagem','radiografia','tomografia','fotografia','consulta','orientação','prótese total',
  'prótese parcial','implante - fase prot'
];

function procIsGlobal(nome){
  const n = (nome||'').toLowerCase();
  // Checa global primeiro (mais específico)
  if(PROCS_GLOBAL_KEYWORDS.some(k=>n.includes(k))) return true;
  if(PROCS_POR_DENTE_KEYWORDS.some(k=>n.includes(k))) return false;
  return true; // default global se não reconhecido
}

function pacPaintFaceButton(btn, status){
  if(!btn) return;
  if(!status){
    btn.style.borderColor='var(--rose-light)'; btn.style.background='#fff'; btn.style.color='#3a2020';
  } else if(status==='treated'){
    btn.style.borderColor='#14599c'; btn.style.background='#2374c6'; btn.style.color='#fff';
  } else {
    btn.style.borderColor='#a91f2a'; btn.style.background='#d63d46'; btn.style.color='#fff';
  }
}

function pacToggleFace(face){
  const current = pacFaceStatus[face];
  const btn = document.querySelector('[data-face="'+face+'"]');
  if(!current) pacFaceStatus[face] = 'treated';
  else if(current === 'treated') pacFaceStatus[face] = 'untreated';
  else delete pacFaceStatus[face];
  pacFacesSel = Object.keys(pacFaceStatus);
  pacPaintFaceButton(btn, pacFaceStatus[face]);
  document.getElementById('pac-d-faces').value = pacFacesSel.join(',');
  if(pacDenteSel) pacRenderArcadas();
}

async function pacFaceGridClick(evt, num, face){
  if(evt) evt.stopPropagation();
  if(!selectedPatientId){ showToast('Selecione um paciente.','warn'); return; }
  const existing = pacDentesMap[num];
  const obs = odontoToggleFaceInObs(existing?.obs || '', face);
  const condicao = existing?.condicao || 'higido';
  showLoading(true);
  let error = null;
  if(existing?.id){
    ({ error } = await _sb.from('procedimentos_dentes').update({obs, condicao, data:hoje()}).eq('id', existing.id));
    if(!error) pacDentesMap[num] = {...existing, obs, condicao, data:hoje()};
  } else {
    const { data: novo, error: e } = await _sb.from('procedimentos_dentes').insert([{clinica_id:clinicaId,paciente_id:selectedPatientId,dente:num,condicao,procedimento:'',obs,data:hoje()}]).select().single();
    error = e;
    if(!error) pacDentesMap[num] = novo;
  }
  showLoading(false);
  if(error){ showToast('Erro: '+error.message,'error'); return; }
  pacRenderArcadas();
  pacRenderDentesHistorico();
}

function pacDenteFiltrarProcs(){
  const q = (document.getElementById('pac-d-proc-search')?.value||'').toLowerCase().trim();
  const opts = document.getElementById('pac-d-proc-opts');
  if(!opts) return;
  if(!procs.length){
    opts.innerHTML="<div style='padding:12px;color:var(--rose-text);text-align:center;font-size:13px;'>Carregando...</div>";
    document.getElementById('pac-d-proc-dd').style.display='block';
    loadFinanceiro().then(()=>pacDenteFiltrarProcs());
    return;
  }
  const lista = (q ? procs.filter(p=>p.nome.toLowerCase().includes(q)) : procs).filter(p=>p.ativo!==false);
  if(!lista.length){ opts.innerHTML="<div style='padding:12px;color:var(--rose-text);text-align:center;font-size:13px;'>Nenhum encontrado</div>"; return; }
  const grupos = [...new Set(lista.map(p=>p.grupo).filter(Boolean))].sort();
  let html = '';
  grupos.forEach(g=>{
    html += `<div style='padding:4px 10px;font-size:10px;font-weight:700;color:var(--rose-text);text-transform:uppercase;background:var(--rose-lighter);'>${escapeHtml(g)}</div>`;
    lista.filter(p=>p.grupo===g).forEach(p=>{
      const glob = procIsGlobal(p.nome);
      const tag  = glob
        ? '<span style="font-size:10px;background:#e3f2fd;color:#0c5460;border-radius:4px;padding:1px 5px;">Global</span>'
        : '<span style="font-size:10px;background:#e8f5e9;color:#2e7d32;border-radius:4px;padding:1px 5px;">Por dente</span>';
      html += `<div data-dpid="${p.id}" style="padding:9px 14px;cursor:pointer;font-size:13px;border-bottom:1px solid var(--rose-light);display:flex;justify-content:space-between;align-items:center;gap:8px;">
        <span>${escapeHtml(p.nome)} ${tag}</span>
        <span style="color:var(--rose-dark);font-weight:700;white-space:nowrap;">R$ ${(p.precoFinal||0).toFixed(2).replace('.',',')}</span>
      </div>`;
    });
  });
  opts.innerHTML = html;
  opts.querySelectorAll('[data-dpid]').forEach(el=>{
    el.onmouseover = function(){ this.style.background='var(--rose-lighter)'; };
    el.onmouseout  = function(){ this.style.background='#fff'; };
    el.onclick = function(){ pacDenteAddProc(parseInt(this.dataset.dpid)); };
  });
  document.getElementById('pac-d-proc-dd').style.display = 'block';
}

function pacDenteAddProc(procId){
  const p = procs.find(x=>x.id===procId);
  if(!p) return;
  // Não duplicar
  if(pacDenteProcs.find(x=>x.nome===p.nome)){ showToast('Já adicionado.','warn'); return; }
  pacDenteProcs.push({nome:p.nome, preco:p.precoFinal||0, global:procIsGlobal(p.nome)});
  const search = document.getElementById('pac-d-proc-search');
  if(search) search.value='';
  const dd = document.getElementById('pac-d-proc-dd');
  if(dd) dd.style.display='none';
  pacRenderDenteProcs();
}

function pacRenderDenteProcs(){
  const c = document.getElementById('pac-d-proc-lista');
  if(!c) return;
  if(!pacDenteProcs.length){
    c.innerHTML = '<div style="font-size:12px;color:var(--rose-text);padding:4px 0;">Nenhum procedimento adicionado.</div>';
    return;
  }
  c.innerHTML = pacDenteProcs.map((dp,i)=>{
    const tag = dp.global
      ? '<span style="font-size:10px;background:#e3f2fd;color:#0c5460;border-radius:4px;padding:1px 6px;">Global</span>'
      : '<span style="font-size:10px;background:#e8f5e9;color:#2e7d32;border-radius:4px;padding:1px 6px;">Por dente</span>';
    return `<div style="display:flex;align-items:center;gap:8px;padding:6px 10px;background:var(--rose-lighter);border-radius:8px;font-size:13px;">
      <span style="flex:1;">${escapeHtml(dp.nome)} ${tag}</span>
      <span style="font-weight:700;color:var(--rose-dark);">R$ ${(dp.preco||0).toFixed(2).replace('.',',')}</span>
      <button type="button" onclick="pacDenteRemoveProc(${i})" style="border:none;background:none;cursor:pointer;color:#b33;font-size:16px;padding:0 2px;">×</button>
    </div>`;
  }).join('');
}

function pacDenteRemoveProc(idx){
  pacDenteProcs.splice(idx,1);
  pacRenderDenteProcs();
}


// Lógica portada do Pétala e adaptada para RWDent + Supabase
// ══════════════════════════════════════════════════════
const fmtBRL = v => isNaN(v)?'—':Number(v).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
// ── Helper de busca sem acento ──
function _norm(s){ return String(s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,''); }

const fmtN2  = v => isNaN(v)?'—':Number(v).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2});

// ── Unidades "inteiras" (não fracionárias) — agulha, seringa, kit etc. se
// contam em números inteiros; ml/grama/kg/m são medidas contínuas e podem
// ter casas decimais (62,5 ml faz sentido, 62,5 agulha não). Usado pra
// ajustar o step dos campos de quantidade (estoque, cadastro de material,
// insumo do procedimento) e arredondar o valor salvo de acordo.
const _UNIDADES_INTEIRAS = new Set(['unid','und','unidade','uni','kit','caixa','cx','frasco',
  'seringa','ampola','capsula','pacote','pote','par','peca','pç','rolo','placa']);
function unidEhInteira(unid){ return _UNIDADES_INTEIRAS.has(_norm(unid)); }
function passoQtd(unid){ return unidEhInteira(unid) ? '1' : '0.01'; }
function arredondarQtd(val, unid){
  const n = parseFloat(val)||0;
  return unidEhInteira(unid) ? Math.round(n) : parseFloat(n.toFixed(3));
}

// ── Estado financeiro (salvo no Supabase por clínica) ──
let procs       = [];   // procedimentos com precificação
// Materiais que são "kit completo" (20 peças) — nunca usar em procedimentos de recolagem
const MAT_IDS_KIT_COMPLETO = new Set([43,44,45,167,168,169,170]);
// Materiais que são "peça avulsa" (1 unidade, calculada como kit/20) — usar em recolagem
const MAT_IDS_PECA_AVULSA  = new Set([173,174,175,176,177,178]);
// IDs de procedimento que são "Recolagem" — mostram o aviso e priorizam peça avulsa na busca
const PROC_IDS_RECOLAGEM = new Set([46,215,216,217,218,219,220]);
let mats        = [];   // materiais/insumos
let combos      = [];   // combos promocionais
let estoque     = {};   // { matId: { atual, min, compra } }
let procInsumos = {};   // { procId: [{matId, qtd}] }
let vendas      = [];   // histórico de vendas/orçamentos
let pagPac      = [];   // legado — mantido para compatibilidade
let cfg         = { salario:3000, horas:132, trib:0, desperd:5, margem:100, colabPct:50, pct_manut:15, migr_manut_v2:false };
let taxasCfg    = { debito:1.5, credito:[2.49,5.1,6.12,7.15,8.19,9.24,10.3,11.36,12.44,13.52,14.61,15.71] };
let descCfg     = { val:0, tipo:'pct', maxPar:6 };

// Mapeamento manutenção → instalação (para calcular preço como % da instalação)
const _MANUT_TO_INST = {208:44, 209:202, 210:203, 211:204, 212:43, 213:51, 214:207, 38:37};
const _IDS_MANUT = new Set(Object.keys(_MANUT_TO_INST).map(Number));

// IDs locais
let nextProcId  = 1;
let _financeiroCarregado = false;  // evita duplo carregamento
let nextMatId   = 1;
let nextVendaId = 1;
let nextComboId = 201;
let despesas = [];
let nextDespesaId = 1;

// Orçamento atual do simulador (dentro do plano do paciente)
let orcamento      = [];
let orcTotalOverride = null;
let orcDescCfg     = { val:0, tipo:'pct', maxPar:6 };
let vendaModoAtual = 'orcamento'; // 'orcamento' ou 'finalizar'
let estSelected    = new Set();

// ── Carregar dados financeiros do Supabase ──

// ── MAPA CONDIÇÃO → PROCEDIMENTOS ──
const COND_PARA_PROC = {
  'restaurado': ['restaur','resina','civ','amalgama','faceta','recontorno','fechamento'],
  'carie':      ['restaur','resina','civ','selante','exodontia','extração','urgência'],
  'canal':      ['canal','endodontia','pulpotomia','pulpectomia','curativo','retratamento'],
  'coroa':      ['coroa','prótese','cimentação','núcleo','provisória'],
  'extraido':   ['implante','exodontia','extração','siso'],
  'implante':   ['implante','prótese sobre implante','fase protética'],
  'fratura':    ['restaur','resina','exodontia','extração','coroa','urgência'],
  'selante':    ['selante'],
  'higido':     [],
};

// Dentes considerados "anteriores" (incisivos e caninos, permanentes e decíduos)
const DENTES_ANTERIORES = new Set([
  11,12,13,21,22,23,31,32,33,41,42,43,
  51,52,53,61,62,63,71,72,73,81,82,83
]);
// Dentes considerados "posteriores" (pré-molares e molares, permanentes e decíduos)
const DENTES_POSTERIORES = new Set([
  14,15,16,17,18,24,25,26,27,28,34,35,36,37,38,44,45,46,47,48,
  54,55,64,65,74,75,84,85
]);

// Verifica se o procedimento é específico para dentes anteriores ou posteriores
function regiaoDoProcedimento(procNome){
  const n = (procNome||'').toLowerCase();
  if(n.includes('anterior')) return 'anterior';
  if(n.includes('posterior')) return 'posterior';
  return null; // procedimento não restrito a região
}

// Verifica se um dente é compatível com a região exigida pelo procedimento
function denteCompativelComRegiao(dente, regiao){
  if(!regiao) return true;
  if(regiao==='anterior') return DENTES_ANTERIORES.has(dente);
  if(regiao==='posterior') return DENTES_POSTERIORES.has(dente);
  return true;
}

function dentesParaProcedimento(procNome){
  if(!procNome || !pacDentesMap) return [];
  const nome = procNome.toLowerCase();
  const regiao = regiaoDoProcedimento(procNome);
  const encontrados = [];
  Object.entries(COND_PARA_PROC).forEach(([cond, procs])=>{
    if(!procs.some(p=>nome.includes(p)||p.includes(nome.split(' ')[0]))) return;
    Object.entries(pacDentesMap).forEach(([dente, info])=>{
      if(!info||!info.condicao) return;
      if(info.condicao.toLowerCase().includes(cond)){
        const n=parseInt(dente);
        if(isNaN(n)||encontrados.includes(n)) return;
        // Se o procedimento é específico (Anterior/Posterior), só considera dentes da região correta
        if(!denteCompativelComRegiao(n, regiao)) return;
        encontrados.push(n);
      }
    });
  });
  return encontrados.sort((a,b)=>a-b);
}

let pacOdontoOrcSelProc = null;

let pacOdontoOrcCategoriaAtiva = '';
const PAC_ODONTO_CATEGORIAS_RAPIDAS = [
  {label:'Todos', grupo:''},
  {label:'Instalação', grupo:'Ortodontia - Instalação'},
  {label:'Manutenção Mensal', grupo:'Ortodontia - Manutenção Mensal'},
  {label:'Recolagem', grupo:'Ortodontia - Recolagem'},
];

function pacOdontoSetCategoria(grupo){
  pacOdontoOrcCategoriaAtiva = grupo;
  pacOdontoFiltrarProcs();
}

function pacOdontoFiltrarProcs(){
  var q=(document.getElementById("pac-odonto-orc-search")||{value:""}).value.toLowerCase().trim();
  var opts=document.getElementById("pac-odonto-orc-opts");
  var chipsEl=document.getElementById("pac-odonto-orc-chips");
  if(chipsEl){
    chipsEl.innerHTML = PAC_ODONTO_CATEGORIAS_RAPIDAS.map(c=>{
      const ativo = pacOdontoOrcCategoriaAtiva===c.grupo;
      return `<button type="button" onmousedown="event.preventDefault();pacOdontoSetCategoria('${c.grupo}')" style="padding:4px 10px;border-radius:14px;border:1.5px solid ${ativo?'var(--rose)':'var(--rose-light)'};background:${ativo?'var(--rose-lighter)':'#fff'};color:var(--rose-dark);font-size:11px;font-weight:600;cursor:pointer;">${c.label}</button>`;
    }).join('');
  }
  if(!opts) return;
  var lista = procs;
  if(pacOdontoOrcCategoriaAtiva) lista = lista.filter(function(p){return p.grupo===pacOdontoOrcCategoriaAtiva;});
  if(q) lista = lista.filter(function(p){return p.nome.toLowerCase().includes(q);});
  if(!lista.length){ opts.innerHTML="<div style='padding:12px;color:var(--rose-text);text-align:center;'>Nenhum encontrado</div>"; return; }
  var grupos=[...new Set(lista.map(function(p){return p.grupo;}).filter(Boolean))].sort();
  var html2="";
  grupos.forEach(function(g){
    html2+="<div style='padding:4px 10px;font-size:10px;font-weight:700;color:var(--rose-text);text-transform:uppercase;background:var(--rose-lighter);'>"+escapeHtml(g)+"</div>";
    lista.filter(function(p){return p.grupo===g;}).forEach(function(p){
      var preco=(p.precoFinal||0).toFixed(2).replace(".",",");
      html2+="<div data-pid='"+p.id+"' style='padding:10px 14px;cursor:pointer;font-size:13px;border-bottom:1px solid var(--rose-light);display:flex;justify-content:space-between;gap:8px;'><span>"+escapeHtml(p.nome)+"</span><span style='color:var(--rose-dark);font-weight:700;'>R$ "+preco+"</span></div>";
    });
  });
  opts.innerHTML=html2;
  opts.querySelectorAll("[data-pid]").forEach(function(el){
    el.onmouseover=function(){this.style.background="var(--rose-lighter)";};
    el.onmouseout=function(){this.style.background="#fff";};
    el.onclick=function(){pacOdontoSelecionarProc(parseInt(this.dataset.pid));};
  });
  var dd=document.getElementById("pac-odonto-orc-dropdown");
  if(dd) dd.style.display="block";
}

function pacOdontoSelecionarProc(id){
  const p=procs.find(x=>x.id===id)||{};
  const nome=p.nome||''; const preco=p.precoFinal||0;
  pacOdontoOrcSelProc={id,nome,preco};
  const inp=document.getElementById('pac-odonto-orc-proc');
  if(inp) inp.value=id;
  const nm=document.getElementById('pac-odonto-orc-sel-nome');
  if(nm) nm.textContent=nome+' — R$ '+preco.toFixed(2).replace('.',',');
  const srch=document.getElementById('pac-odonto-orc-search');
  if(srch) srch.value=nome;
  const dd=document.getElementById('pac-odonto-orc-dropdown');
  if(dd) dd.style.display='none';
}


// ── Injeta novos materiais e procedimentos de ortodontia ──
async function injetarNovosMatsOrto(){
  // ── MIGRAÇÃO / LIMPEZA TOTAL — dados salvos no Supabase de versões anteriores tinham
  // nomes levemente diferentes (com/sem "Mensal", com/sem hífen) que IMPEDIAM a detecção
  // de duplicatas por nome exato. Esta versão identifica cada procedimento pela
  // COMBINAÇÃO categoria+tipo de aparelho (via palavras-chave no nome, não nome exato),
  // o que é robusto a qualquer variação de escrita já salva.
  let migrou = false;

  // Detecta a categoria do procedimento
  function detectarCategoria(nome){
    const n = nome.toLowerCase();
    if(/recolagem/.test(n)) return 'recolagem';
    if(/manuten/.test(n)) return 'manutencao';
    if(/instala/.test(n) || /tratamento (invisalign|alinhador)/i.test(n)) return 'instalacao';
    return null;
  }
  // Detecta o tipo de aparelho do procedimento
  function detectarTipo(nome){
    const n = nome.toLowerCase();
    if(/invisalign|alinhador\s*transparente/i.test(n)) return 'invisalign';
    if(/safira/.test(n)) return 'safira';
    if(/porcelana/.test(n)) return 'porcelana';
    if(/autoligado.*est|est.*autoligado/.test(n)) return 'autoligado_estetico';
    if(/cer[aâ]mico/.test(n)) return 'ceramico';
    if(/autoligado.*met|met.*autoligado/.test(n)) return 'autoligado_metalico';
    if(/met[aá]lico/.test(n) || /fio ortod[oô]ntico/i.test(nome)) return 'metalico_tradicional';
    return 'generico';
  }

  // IDs canônicos fixos por categoria+tipo — sempre os mesmos, para nunca duplicar de novo
  const ID_CANONICO = {
    'instalacao|ceramico': 44, 'instalacao|porcelana': 202, 'instalacao|safira': 203,
    'instalacao|autoligado_estetico': 204, 'instalacao|metalico_tradicional': 43,
    'instalacao|autoligado_metalico': 51, 'instalacao|invisalign': 207, 'instalacao|generico': 37,
    'manutencao|ceramico': 208, 'manutencao|porcelana': 209, 'manutencao|safira': 210,
    'manutencao|autoligado_estetico': 211, 'manutencao|metalico_tradicional': 212,
    'manutencao|autoligado_metalico': 213, 'manutencao|invisalign': 214, 'manutencao|generico': 38,
    'recolagem|ceramico': 216, 'recolagem|porcelana': 218, 'recolagem|safira': 219,
    'recolagem|autoligado_estetico': 220, 'recolagem|metalico_tradicional': 215,
    'recolagem|autoligado_metalico': 217, 'recolagem|generico': 46,
  };
  const NOMES_CANONICOS = {
    37:"Instalação de Aparelho Fixo (genérico)", 38:"Manutenção Mensal Ortodôntica (genérica)",
    43:"Instalação Aparelho Metálico Tradicional", 44:"Instalação Aparelho Estético Cerâmico",
    46:"Recolagem (peça quebrada) — Genérica", 51:"Instalação Aparelho Metálico Autoligado",
    202:"Instalação Aparelho Estético Porcelana", 203:"Instalação Aparelho Estético Safira",
    204:"Instalação Aparelho Estético Autoligado", 207:"Instalação Alinhador Transparente (tratamento completo)",
    208:"Manutenção Mensal — Aparelho Estético Cerâmico", 209:"Manutenção Mensal — Aparelho Estético Porcelana",
    210:"Manutenção Mensal — Aparelho Estético Safira", 211:"Manutenção Mensal — Aparelho Estético Autoligado",
    212:"Manutenção Mensal — Aparelho Metálico Tradicional", 213:"Manutenção Mensal — Aparelho Metálico Autoligado",
    214:"Manutenção Mensal — Alinhador Transparente (refinamento)",
    215:"Recolagem (peça quebrada) — Metálico Tradicional", 216:"Recolagem (peça quebrada) — Cerâmico",
    217:"Recolagem (peça quebrada) — Metálico Autoligado", 218:"Recolagem (peça quebrada) — Porcelana",
    219:"Recolagem (peça quebrada) — Safira", 220:"Recolagem (peça quebrada) — Autoligado Estético",
  };
  const GRUPOS_CANONICOS = {
    instalacao:'Ortodontia - Instalação', manutencao:'Ortodontia - Manutenção Mensal', recolagem:'Ortodontia - Recolagem',
  };
  // Preços de mercado (pesquisados) usados como fallback quando a fusão de duplicatas
  // resultar em precoFinal zerado (ex: todas as cópias salvas tinham 0 por bug anterior).
  const PRECO_MERCADO_FALLBACK = {
    208: 130, 209: 160, 210: 220, 211: 190, 212: 90, 213: 115, 214: 300,
  };

  (function migrarEDeduplicar(){
    const baldes = {}; // chave "categoria|tipo" -> lista de procs que caem nela
    procs.forEach(p=>{
      const cat = detectarCategoria(p.nome);
      if(!cat) return; // não é ortodontia de instalação/manutenção/recolagem — não toca
      const tipo = detectarTipo(p.nome);
      const chave = cat+'|'+tipo;
      if(!baldes[chave]) baldes[chave] = [];
      baldes[chave].push(p);
    });

    Object.entries(baldes).forEach(([chave, lista])=>{
      const idCanon = ID_CANONICO[chave];
      if(idCanon===undefined) return;
      // Escolhe a "melhor" entrada: a que já está no ID canônico, senão a de maior preço
      lista.sort((a,b)=>{
        const aCan = a.id===idCanon ? 1 : 0;
        const bCan = b.id===idCanon ? 1 : 0;
        if(aCan!==bCan) return bCan-aCan;
        return (b.precoFinal||0)-(a.precoFinal||0);
      });
      const melhor = lista[0];
      // Coleta os melhores dados entre TODAS as duplicatas (maior precoFinal>0 e insumos vinculados)
      let dadosFinais = { insumos:melhor.insumos, horaClin:melhor.horaClin, laboratorio:melhor.laboratorio, margem:melhor.margem, precoFinal:melhor.precoFinal, tempo:melhor.tempo };
      let melhorInsumosId = melhor.id;
      lista.forEach(p=>{
        if((p.precoFinal||0) > (dadosFinais.precoFinal||0)){
          dadosFinais = { insumos:p.insumos, horaClin:p.horaClin, laboratorio:p.laboratorio, margem:p.margem, precoFinal:p.precoFinal, tempo:p.tempo };
          melhorInsumosId = p.id;
        }
      });
      const melhorReceita = procInsumos[melhorInsumosId];

      // Remove TODAS as entradas dessa categoria+tipo do array de procs
      lista.forEach(p=>{
        const idx = procs.findIndex(x=>x===p);
        if(idx>=0) procs.splice(idx,1);
        if(p.id!==idCanon) delete procInsumos[p.id];
      });
      // Recria UMA única entrada limpa, no ID canônico, com nome/grupo padronizados e os
      // melhores dados encontrados entre as duplicatas. Se mesmo assim o preço ficar
      // zerado, usa o valor de mercado calibrado (PRECO_MERCADO_FALLBACK).
      procs.push({
        id: idCanon,
        nome: NOMES_CANONICOS[idCanon] || melhor.nome,
        grupo: GRUPOS_CANONICOS[chave.split('|')[0]],
        tempo: dadosFinais.tempo || melhor.tempo || 30,
        insumos: dadosFinais.insumos || 0,
        horaClin: dadosFinais.horaClin || 0,
        laboratorio: dadosFinais.laboratorio || 0,
        margem: dadosFinais.margem || 100,
        precoFinal: dadosFinais.precoFinal>0 ? dadosFinais.precoFinal : (PRECO_MERCADO_FALLBACK[idCanon] || 0),
        tipo_cobranca: 'global'
      });
      if(melhorReceita && melhorReceita.length) procInsumos[idCanon] = melhorReceita;
      migrou = true;
    });
  })();

  // Materiais novos de ortodontia (fios + kits de braquete que ainda não existem nos
  // materiais padrão). IDs na faixa 150+ para nunca colidir com DEFAULT_MATS_FIN (1-90)
  // nem com os fios NiTi já injetados antes (91-102).
  const NOVOS_MATS = [
    {"id": 91, "nome": "Fio NiTi 0.012 Superior", "cat": "Ortodontia", "unid": "unid", "qtde": 10, "preco": 25, "custo": 2.5},
    {"id": 92, "nome": "Fio NiTi 0.012 Inferior", "cat": "Ortodontia", "unid": "unid", "qtde": 10, "preco": 25, "custo": 2.5},
    {"id": 93, "nome": "Fio NiTi 0.014 Superior", "cat": "Ortodontia", "unid": "unid", "qtde": 10, "preco": 28, "custo": 2.8},
    {"id": 94, "nome": "Fio NiTi 0.014 Inferior", "cat": "Ortodontia", "unid": "unid", "qtde": 10, "preco": 28, "custo": 2.8},
    {"id": 95, "nome": "Fio NiTi 0.016 Superior", "cat": "Ortodontia", "unid": "unid", "qtde": 10, "preco": 30, "custo": 3.0},
    {"id": 96, "nome": "Fio NiTi 0.016 Inferior", "cat": "Ortodontia", "unid": "unid", "qtde": 10, "preco": 30, "custo": 3.0},
    {"id": 97, "nome": "Fio NiTi 0.018 Superior", "cat": "Ortodontia", "unid": "unid", "qtde": 10, "preco": 32, "custo": 3.2},
    {"id": 98, "nome": "Fio NiTi 0.018 Inferior", "cat": "Ortodontia", "unid": "unid", "qtde": 10, "preco": 32, "custo": 3.2},
    {"id": 99, "nome": "Fio NiTi 0.019x25 Superior", "cat": "Ortodontia", "unid": "unid", "qtde": 10, "preco": 35, "custo": 3.5},
    {"id": 100, "nome": "Fio NiTi 0.019x25 Inferior", "cat": "Ortodontia", "unid": "unid", "qtde": 10, "preco": 35, "custo": 3.5},
    {"id": 101, "nome": "Fio NiTi 0.020 Superior", "cat": "Ortodontia", "unid": "unid", "qtde": 10, "preco": 32, "custo": 3.2},
    {"id": 102, "nome": "Fio NiTi 0.020 Inferior", "cat": "Ortodontia", "unid": "unid", "qtde": 10, "preco": 32, "custo": 3.2},
    {"id": 153, "nome": "Fio Aço 0.012 Superior", "cat": "Ortodontia", "unid": "unid", "qtde": 10, "preco": 20, "custo": 2.0},
    {"id": 154, "nome": "Fio Aço 0.012 Inferior", "cat": "Ortodontia", "unid": "unid", "qtde": 10, "preco": 20, "custo": 2.0},
    {"id": 155, "nome": "Fio Aço 0.014 Superior", "cat": "Ortodontia", "unid": "unid", "qtde": 10, "preco": 22, "custo": 2.2},
    {"id": 156, "nome": "Fio Aço 0.014 Inferior", "cat": "Ortodontia", "unid": "unid", "qtde": 10, "preco": 22, "custo": 2.2},
    {"id": 157, "nome": "Fio Aço 0.016 Superior", "cat": "Ortodontia", "unid": "unid", "qtde": 10, "preco": 22, "custo": 2.2},
    {"id": 158, "nome": "Fio Aço 0.016 Inferior", "cat": "Ortodontia", "unid": "unid", "qtde": 10, "preco": 22, "custo": 2.2},
    {"id": 159, "nome": "Fio Aço 0.018 Superior", "cat": "Ortodontia", "unid": "unid", "qtde": 10, "preco": 24, "custo": 2.4},
    {"id": 160, "nome": "Fio Aço 0.018 Inferior", "cat": "Ortodontia", "unid": "unid", "qtde": 10, "preco": 24, "custo": 2.4},
    {"id": 161, "nome": "Fio Aço 0.020 Superior", "cat": "Ortodontia", "unid": "unid", "qtde": 10, "preco": 24, "custo": 2.4},
    {"id": 162, "nome": "Fio Aço 0.020 Inferior", "cat": "Ortodontia", "unid": "unid", "qtde": 10, "preco": 24, "custo": 2.4},
    {"id": 163, "nome": "Fio Aço 0.019x25 Superior", "cat": "Ortodontia", "unid": "unid", "qtde": 10, "preco": 28, "custo": 2.8},
    {"id": 164, "nome": "Fio Aço 0.019x25 Inferior", "cat": "Ortodontia", "unid": "unid", "qtde": 10, "preco": 28, "custo": 2.8},
    {"id": 165, "nome": "Fio Aço 0.017x25 Superior", "cat": "Ortodontia", "unid": "unid", "qtde": 10, "preco": 28, "custo": 2.8},
    {"id": 166, "nome": "Fio Aço 0.017x25 Inferior", "cat": "Ortodontia", "unid": "unid", "qtde": 10, "preco": 28, "custo": 2.8},
    {"id": 167, "nome": "Braquete Porcelana Kit", "cat": "Ortodontia", "unid": "kit", "qtde": 1, "preco": 750, "custo": 750},
    {"id": 168, "nome": "Braquete Safira Kit", "cat": "Ortodontia", "unid": "kit", "qtde": 1, "preco": 890, "custo": 890},
    {"id": 169, "nome": "Braquete Autoligado Estético Kit", "cat": "Ortodontia", "unid": "kit", "qtde": 1, "preco": 980, "custo": 980},
    {"id": 170, "nome": "Alinhador Transparente (jogo completo)", "cat": "Ortodontia", "unid": "kit", "qtde": 1, "preco": 4500, "custo": 4500},
    {"id": 171, "nome": "Refinamento Alinhador Transparente", "cat": "Ortodontia", "unid": "kit", "qtde": 1, "preco": 800, "custo": 800},
    {"id": 172, "nome": "Escaneamento 3D (iTero/similar)", "cat": "Ortodontia", "unid": "unid", "qtde": 1, "preco": 300, "custo": 300},
    {"id": 173, "nome": "Braquete Metálico Tradicional (peça avulsa)", "cat": "Ortodontia", "unid": "unid", "qtde": 1, "preco": 9.45, "custo": 9.45},
    {"id": 174, "nome": "Braquete Cerâmico (peça avulsa)", "cat": "Ortodontia", "unid": "unid", "qtde": 1, "preco": 21.00, "custo": 21.00},
    {"id": 175, "nome": "Braquete Autoligado Metálico (peça avulsa)", "cat": "Ortodontia", "unid": "unid", "qtde": 1, "preco": 16.00, "custo": 16.00},
    {"id": 176, "nome": "Braquete Porcelana (peça avulsa)", "cat": "Ortodontia", "unid": "unid", "qtde": 1, "preco": 37.50, "custo": 37.50},
    {"id": 177, "nome": "Braquete Safira (peça avulsa)", "cat": "Ortodontia", "unid": "unid", "qtde": 1, "preco": 44.50, "custo": 44.50},
    {"id": 178, "nome": "Braquete Autoligado Estético (peça avulsa)", "cat": "Ortodontia", "unid": "unid", "qtde": 1, "preco": 49.00, "custo": 49.00},
    {"id": 179, "nome": "Sugador Descartável", "cat": "Geral", "unid": "unid", "qtde": 100, "preco": 25.00, "custo": 0.25}
  ];
  // Procedimentos de instalação/manutenção de aparelho. IDs na faixa 200+ para nunca
  // colidir com DEFAULT_PROCS_FIN (1-102) nem com os materiais (91-172).
  // precoFinal fica 0 propositalmente — é recalculado abaixo por calcPrecoFinal()
  // a partir de insumos + hora clínica + margem, exatamente como os procedimentos 43/44/51.
  const NOVOS_PROCS = [
    // Instalação — só os tipos que ainda não existem nos procedimentos originais
    // (Metálico Tradicional=43, Cerâmico=44, Metálico Autoligado=51 já existem e NÃO são repetidos aqui)
    {"id": 202, "nome": "Instalação Aparelho Estético Porcelana", "grupo": "Ortodontia - Instalação", "tempo": 120, "insumos": 0, "horaClin": 0, "laboratorio": 0, "margem": 200, "precoFinal": 0, "tipo_cobranca": "global"},
    {"id": 203, "nome": "Instalação Aparelho Estético Safira", "grupo": "Ortodontia - Instalação", "tempo": 120, "insumos": 0, "horaClin": 0, "laboratorio": 0, "margem": 200, "precoFinal": 0, "tipo_cobranca": "global"},
    {"id": 204, "nome": "Instalação Aparelho Estético Autoligado", "grupo": "Ortodontia - Instalação", "tempo": 120, "insumos": 0, "horaClin": 0, "laboratorio": 0, "margem": 200, "precoFinal": 0, "tipo_cobranca": "global"},
    {"id": 207, "nome": "Instalação Alinhador Transparente (tratamento completo)", "grupo": "Ortodontia - Instalação", "tempo": 60, "insumos": 0, "horaClin": 0, "laboratorio": 0, "margem": 100, "precoFinal": 0, "tipo_cobranca": "global"},
    // Manutenção mensal por tipo — nome sempre começa com "Manutenção Mensal —" para nunca
    // ser confundido com Recolagem na busca do orçamento
    {"id": 208, "nome": "Manutenção Mensal — Aparelho Estético Cerâmico", "grupo": "Ortodontia - Manutenção Mensal", "tempo": 30, "insumos": 0, "horaClin": 0, "laboratorio": 0, "margem": 150, "precoFinal": 130, "tipo_cobranca": "global"},
    {"id": 209, "nome": "Manutenção Mensal — Aparelho Estético Porcelana", "grupo": "Ortodontia - Manutenção Mensal", "tempo": 30, "insumos": 0, "horaClin": 0, "laboratorio": 0, "margem": 150, "precoFinal": 160, "tipo_cobranca": "global"},
    {"id": 210, "nome": "Manutenção Mensal — Aparelho Estético Safira", "grupo": "Ortodontia - Manutenção Mensal", "tempo": 30, "insumos": 0, "horaClin": 0, "laboratorio": 0, "margem": 150, "precoFinal": 220, "tipo_cobranca": "global"},
    {"id": 211, "nome": "Manutenção Mensal — Aparelho Estético Autoligado", "grupo": "Ortodontia - Manutenção Mensal", "tempo": 30, "insumos": 0, "horaClin": 0, "laboratorio": 0, "margem": 150, "precoFinal": 190, "tipo_cobranca": "global"},
    {"id": 212, "nome": "Manutenção Mensal — Aparelho Metálico Tradicional", "grupo": "Ortodontia - Manutenção Mensal", "tempo": 30, "insumos": 0, "horaClin": 0, "laboratorio": 0, "margem": 150, "precoFinal": 90, "tipo_cobranca": "global"},
    {"id": 213, "nome": "Manutenção Mensal — Aparelho Metálico Autoligado", "grupo": "Ortodontia - Manutenção Mensal", "tempo": 30, "insumos": 0, "horaClin": 0, "laboratorio": 0, "margem": 150, "precoFinal": 115, "tipo_cobranca": "global"},
    {"id": 214, "nome": "Manutenção Mensal — Alinhador Transparente (refinamento)", "grupo": "Ortodontia - Manutenção Mensal", "tempo": 30, "insumos": 0, "horaClin": 0, "laboratorio": 0, "margem": 100, "precoFinal": 300, "tipo_cobranca": "global"},
    // Recolagem (peça quebrada/perdida) por tipo — nome sempre começa com "Recolagem (peça quebrada) —"
    {"id": 215, "nome": "Recolagem (peça quebrada) — Metálico Tradicional", "grupo": "Ortodontia - Recolagem", "tempo": 20, "insumos": 0, "horaClin": 0, "laboratorio": 0, "margem": 150, "precoFinal": 0, "tipo_cobranca": "global"},
    {"id": 216, "nome": "Recolagem (peça quebrada) — Cerâmico", "grupo": "Ortodontia - Recolagem", "tempo": 20, "insumos": 0, "horaClin": 0, "laboratorio": 0, "margem": 150, "precoFinal": 0, "tipo_cobranca": "global"},
    {"id": 217, "nome": "Recolagem (peça quebrada) — Metálico Autoligado", "grupo": "Ortodontia - Recolagem", "tempo": 20, "insumos": 0, "horaClin": 0, "laboratorio": 0, "margem": 150, "precoFinal": 0, "tipo_cobranca": "global"},
    {"id": 218, "nome": "Recolagem (peça quebrada) — Porcelana", "grupo": "Ortodontia - Recolagem", "tempo": 20, "insumos": 0, "horaClin": 0, "laboratorio": 0, "margem": 150, "precoFinal": 0, "tipo_cobranca": "global"},
    {"id": 219, "nome": "Recolagem (peça quebrada) — Safira", "grupo": "Ortodontia - Recolagem", "tempo": 20, "insumos": 0, "horaClin": 0, "laboratorio": 0, "margem": 150, "precoFinal": 0, "tipo_cobranca": "global"},
    {"id": 220, "nome": "Recolagem (peça quebrada) — Autoligado Estético", "grupo": "Ortodontia - Recolagem", "tempo": 20, "insumos": 0, "horaClin": 0, "laboratorio": 0, "margem": 150, "precoFinal": 0, "tipo_cobranca": "global"}
  ];
  // Receita de insumos por procedimento — mesmo padrão usado nos procedimentos já
  // existentes "Instalação Aparelho Metálico" (id 43) e "Instalação Aparelho Autoligado
  // Metálico" (id 51): kit de braquete + adesivo + primer + arco + EPI (babador, luva,
  // máscara, microbrush). Reaproveita os kits já cadastrados (43, 44, 45) quando existem.
  const NOVOS_PROC_INSUMOS = {
    // Instalação por kit completo (só os tipos que não existem nos originais 43/44/51)
    202: [{matId:167,qtd:1},{matId:48,qtd:0.5},{matId:74,qtd:0.3},{matId:76,qtd:1},{matId:8,qtd:1},{matId:34,qtd:2},{matId:35,qtd:1},{matId:37,qtd:5},{matId:179,qtd:1}], // Porcelana
    203: [{matId:168,qtd:1},{matId:48,qtd:0.5},{matId:74,qtd:0.3},{matId:76,qtd:1},{matId:8,qtd:1},{matId:34,qtd:2},{matId:35,qtd:1},{matId:37,qtd:5},{matId:179,qtd:1}], // Safira
    204: [{matId:169,qtd:1},{matId:48,qtd:0.5},{matId:74,qtd:0.3},{matId:76,qtd:1},{matId:8,qtd:1},{matId:34,qtd:2},{matId:35,qtd:1},{matId:37,qtd:5},{matId:179,qtd:1}], // Autoligado estético
    207: [{matId:172,qtd:1},{matId:8,qtd:1},{matId:34,qtd:1},{matId:179,qtd:1}], // Alinhador Transparente — o alinhador (matId 170) entra como custo de "laboratório" (R$4.500), não como insumo, para não ser contado em dobro
    // Manutenção mensal por tipo — troca de arco + ligadura (quando usa) + EPI completo
    // EPI: babador (8), luva (34), máscara (35)
    // Elástico id 75 = pacote ~1040 unid; 28 ligaduras por sessão = qtd 0.027
    208: [{matId:77,qtd:1},{matId:75,qtd:0.027},{matId:8,qtd:1},{matId:34,qtd:1},{matId:35,qtd:1}],
    209: [{matId:77,qtd:1},{matId:75,qtd:0.027},{matId:8,qtd:1},{matId:34,qtd:1},{matId:35,qtd:1}],
    210: [{matId:77,qtd:1},{matId:75,qtd:0.027},{matId:8,qtd:1},{matId:34,qtd:1},{matId:35,qtd:1}],
    211: [{matId:77,qtd:1},{matId:8,qtd:1},{matId:34,qtd:1},{matId:35,qtd:1}],
    212: [{matId:78,qtd:1},{matId:75,qtd:0.027},{matId:8,qtd:1},{matId:34,qtd:1},{matId:35,qtd:1}],
    213: [{matId:78,qtd:1},{matId:8,qtd:1},{matId:34,qtd:1},{matId:35,qtd:1}],
    214: [{matId:171,qtd:1},{matId:8,qtd:1},{matId:34,qtd:1},{matId:35,qtd:1}],
    // Recolagem: 1 peça avulsa (kit ÷ 20) + um pouco de adesivo + EPI mínimo.
    // NUNCA usar o kit inteiro (matId 43/44/45/167/168/169) aqui — isso cobraria o
    // paciente pelo aparelho completo de novo. A peça avulsa é o material certo.
    215: [{matId:173,qtd:1},{matId:48,qtd:0.05},{matId:8,qtd:1},{matId:34,qtd:1},{matId:179,qtd:1}], // Metálico Tradicional
    216: [{matId:174,qtd:1},{matId:48,qtd:0.05},{matId:8,qtd:1},{matId:34,qtd:1},{matId:179,qtd:1}], // Cerâmico
    217: [{matId:175,qtd:1},{matId:48,qtd:0.05},{matId:8,qtd:1},{matId:34,qtd:1},{matId:179,qtd:1}], // Autoligado Metálico
    218: [{matId:176,qtd:1},{matId:48,qtd:0.05},{matId:8,qtd:1},{matId:34,qtd:1},{matId:179,qtd:1}], // Porcelana
    219: [{matId:177,qtd:1},{matId:48,qtd:0.05},{matId:8,qtd:1},{matId:34,qtd:1},{matId:179,qtd:1}], // Safira
    220: [{matId:178,qtd:1},{matId:48,qtd:0.05},{matId:8,qtd:1},{matId:34,qtd:1},{matId:179,qtd:1}]  // Autoligado Estético
  };
  // Custo de laboratório (alinhador transparente é fabricado fora — não é "insumo" de estoque
  // consumido na consulta, é encomendado por caso, então entra como laboratório).
  const LABORATORIO_POR_PROC = { 207: 4500 };

  // ── MIGRAÇÃO v2: corrige insumos de manutenção que possam ter recebido kits de instalação por engano
  if(!cfg.migr_manut_v2){
    const _MANUT_INSUMOS_CORRETOS = {
      208: [{matId:77,qtd:1},{matId:75,qtd:0.027},{matId:8,qtd:1},{matId:34,qtd:1},{matId:35,qtd:1}],
      209: [{matId:77,qtd:1},{matId:75,qtd:0.027},{matId:8,qtd:1},{matId:34,qtd:1},{matId:35,qtd:1}],
      210: [{matId:77,qtd:1},{matId:75,qtd:0.027},{matId:8,qtd:1},{matId:34,qtd:1},{matId:35,qtd:1}],
      211: [{matId:77,qtd:1},{matId:8,qtd:1},{matId:34,qtd:1},{matId:35,qtd:1}],
      212: [{matId:78,qtd:1},{matId:75,qtd:0.027},{matId:8,qtd:1},{matId:34,qtd:1},{matId:35,qtd:1}],
      213: [{matId:78,qtd:1},{matId:8,qtd:1},{matId:34,qtd:1},{matId:35,qtd:1}],
      214: [{matId:171,qtd:1},{matId:8,qtd:1},{matId:34,qtd:1},{matId:35,qtd:1}],
      38:  [{matId:77,qtd:1},{matId:75,qtd:0.027},{matId:8,qtd:1},{matId:34,qtd:1},{matId:35,qtd:1}],
    };
    Object.entries(_MANUT_INSUMOS_CORRETOS).forEach(([id,receita])=>{
      procInsumos[Number(id)] = JSON.parse(JSON.stringify(receita));
    });
    cfg.migr_manut_v2 = true;
    migrou = true;
    // Recalcula preços de manutenção como % da instalação

    const _INST_MANUT_V2 = {44:208, 202:209, 203:210, 204:211, 43:212, 51:213, 207:214, 37:38};
    const _pct_v2 = cfg.pct_manut || 15;
    Object.entries(_INST_MANUT_V2).forEach(([instId, manutId])=>{
      const _inst  = procs.find(p=>p.id===Number(instId));
      const _manut = procs.find(p=>p.id===manutId);
      if(_inst && _manut && _pct_v2 > 0 && _inst.precoFinal > 0){
        _manut.precoFinal = parseFloat((_inst.precoFinal * _pct_v2 / 100).toFixed(2));
      }
    });
  }

  // ── MIGRAÇÃO v3: adiciona sugador a todos os procedimentos existentes exceto manutenção
  if(!cfg.migr_sugador_v1){
    const _SUG_ID = 179;
    const _SEM_SUG = new Set([13,38,45,208,209,210,211,212,213,214]);
    Object.keys(procInsumos).forEach(function(pid){
      const id = Number(pid);
      if(_SEM_SUG.has(id)) return;
      const lista = procInsumos[id];
      if(!Array.isArray(lista)) return;
      if(!lista.some(function(i){ return i.matId===_SUG_ID; })){
        lista.push({matId:_SUG_ID,qtd:1});
      }
    });
    cfg.migr_sugador_v1 = true;
    migrou = true;
  }

  let alterou = migrou;
  NOVOS_MATS.forEach(nm=>{
    if(!mats.find(m=>m.id===nm.id)){
      mats.push(nm);
      if(!estoque[nm.id]) estoque[nm.id]={atual:0,min:2,compra:5};
      alterou=true;
    }
  });
  NOVOS_PROCS.forEach(np=>{
    if(!procs.find(p=>p.id===np.id)){
      const proc = {...np};
      if(LABORATORIO_POR_PROC[np.id]) proc.laboratorio = LABORATORIO_POR_PROC[np.id];
      procs.push(proc);
      alterou=true;
    }
  });
  // Vincula a receita de insumos a cada procedimento novo (só se ainda não tiver insumos salvos)
  Object.entries(NOVOS_PROC_INSUMOS).forEach(([pid,receita])=>{
    const pidNum = Number(pid);
    if(!procInsumos[pidNum] || !procInsumos[pidNum].length){
      procInsumos[pidNum] = JSON.parse(JSON.stringify(receita));
      alterou = true;
    }
  });
  if(alterou){
    nextMatId = mats.length ? Math.max(...mats.map(m=>m.id||0))+1 : 91;
    nextProcId = procs.length ? Math.max(...procs.map(p=>p.id||0))+1 : 103;
    // Calcula insumos (R$) e hora clínica de todos os procedimentos novos. Para o preço
    // final, usa o valor calibrado por pesquisa de mercado já definido em NOVOS_PROCS
    // (quando > 0); só recorre ao cálculo automático por insumos+margem quando o
    // procedimento não tiver um preço de mercado pré-definido (precoFinal:0 no array).
    // Nunca toca em procedimentos que o usuário já tinha e possa ter personalizado.
    NOVOS_PROCS.forEach(np=>{
      const p = procs.find(x=>x.id===np.id);
      if(!p || p.precoFinal>0) return;
      const ins = procInsumos[p.id]||[];
      p.insumos = parseFloat(ins.reduce((acc,item)=>{const m=mats.find(x=>x.id===item.matId);return acc+(m?m.custo*item.qtd:0);},0).toFixed(2));
      p.horaClin = parseFloat(((p.tempo/60)*calcHora()).toFixed(2));
      p.precoFinal = np.precoFinal>0 ? np.precoFinal : calcPrecoFinal(p);
    });
    const _ePad2=await saveFinanceiro();
    if(_ePad2) showToast('Erro ao salvar padrões: '+_ePad2.message,'error');
  }
}



// ── LANÇAMENTO AVULSO (entrada/saída) ──
let _lavTipo = 'entrada';

function lavSetTipo(tipo){
  _lavTipo = tipo;
  const ehEntrada = tipo==='entrada';
  document.getElementById('lav-campos-entrada').style.display = ehEntrada?'':'none';
  document.getElementById('lav-campos-saida').style.display   = ehEntrada?'none':'';
  document.getElementById('lav-desc-entrada').style.display   = ehEntrada?'':'none';
  document.getElementById('lav-desc-saida').style.display     = ehEntrada?'none':'';
  document.getElementById('lav-info-entrada').style.display   = ehEntrada?'':'none';
  document.getElementById('lav-info-saida').style.display     = ehEntrada?'none':'';
  document.getElementById('lav-prof-wrap').style.display      = ehEntrada?'':'none';
  document.getElementById('lav-valor-label').textContent      = ehEntrada?'Valor cobrado (R$)':'Valor pago (R$)';
  document.getElementById('lav-btn-salvar').innerHTML = ehEntrada
    ? '<i class="ti ti-check"></i> Adicionar ao faturamento'
    : '<i class="ti ti-check"></i> Registrar despesa';
  const tabEntrada = document.getElementById('lav-tab-entrada');
  const tabSaida   = document.getElementById('lav-tab-saida');
  tabEntrada.style.background = ehEntrada?'var(--rose)':'#fff';
  tabEntrada.style.color      = ehEntrada?'#fff':'var(--rose-dark)';
  tabEntrada.style.borderColor= ehEntrada?'var(--rose)':'var(--rose-light)';
  tabSaida.style.background   = ehEntrada?'#fff':'var(--rose)';
  tabSaida.style.color        = ehEntrada?'var(--rose-dark)':'#fff';
  tabSaida.style.borderColor  = ehEntrada?'var(--rose-light)':'var(--rose)';
}

function abrirLancamentoAvulso(){
  document.getElementById('lav-nome').value = '';
  document.getElementById('lav-proc').value = '';
  document.getElementById('lav-categoria').value = 'Protético';
  document.getElementById('lav-descricao').value = '';
  document.getElementById('lav-valor').value = '';
  document.getElementById('lav-data').value = hoje();
  document.getElementById('lav-forma').value = 'pix';
  document.getElementById('lav-parcelas').value = 1;
  document.getElementById('lav-parcelas-wrap').style.display = 'none';
  document.getElementById('lav-obs').value = '';
  document.getElementById('lav-proc-lista').innerHTML = procs.filter(p=>p.ativo!==false).map(p=>`<option value="${escapeHtml(p.nome)}">`).join('');
  const selProf = document.getElementById('lav-prof');
  if(selProf) selProf.innerHTML = '<option value="">— Não informado —</option>' + profissionais.map(p=>`<option value="${p.id}">${escapeHtml(p.nome)}</option>`).join('');
  lavSetTipo('entrada');
  openModal('modal-lancamento-avulso');
}

async function salvarLancamentoAvulso(){
  const valor = parseFloat(document.getElementById('lav-valor').value);
  const data  = document.getElementById('lav-data').value || hoje();
  const forma = document.getElementById('lav-forma').value;
  const parcelas = forma==='credito' ? (parseInt(document.getElementById('lav-parcelas').value)||1) : 1;
  const obs = document.getElementById('lav-obs').value.trim();

  if(!valor || valor<=0){ showToast('Digite o valor.','warn'); return; }

  showLoading(true);

  if(_lavTipo==='saida'){
    const categoria = document.getElementById('lav-categoria').value;
    const descricao = document.getElementById('lav-descricao').value.trim();
    const despesa = {
      id: nextDespesaId++,
      categoria,
      descricao,
      valor,
      formaPagamento: forma,
      parcelas,
      obs,
      data: new Date(data+'T12:00:00').toISOString()
    };
    despesas.push(despesa);
    const _eDesp = await saveFinanceiro();
    showLoading(false);
    if(_eDesp){
      despesas.pop();
      nextDespesaId--;
      showToast('Erro ao salvar: '+_eDesp.message,'error');
      return;
    }
    closeModal('modal-lancamento-avulso');
    showToast(`✅ Despesa de ${fmtBRL(valor)} (${categoria}) registrada!`);
    if(typeof renderFinanceiroDash==='function' && document.getElementById('tab-financeiro')?.style.display!=='none') renderFinanceiroDash();
    return;
  }

  const nome = document.getElementById('lav-nome').value.trim() || 'Não identificado';
  const proc = document.getElementById('lav-proc').value.trim() || 'Recebimento avulso';
  const profId = document.getElementById('lav-prof').value || '';
  const profNome = profId ? (profissionais.find(p=>p.id==profId)?.nome||'') : '';

  nextVendaId = vendas.length ? Math.max(...vendas.map(v=>Number(v.id)||0)) + 1 : 1;

  const venda = {
    id: nextVendaId++,
    status: 'finalizada',
    origem: 'avulso',
    formaPagamento: forma,
    parcelas: parcelas,
    pacienteId: null,
    pacienteNome: nome,
    itens: [{ procId:null, qtd:1, nome:proc, precoUnit:valor, dente:'', descDente:'' }],
    subtotal: valor,
    desconto: 0,
    entrada: 0,
    restante: 0,
    obs: obs,
    total: valor,
    profissional_id: profId||null,
    profissional_nome: profNome,
    data: new Date(data+'T12:00:00').toISOString(),
    dataFinal: new Date(data+'T12:00:00').toISOString(),
    pagamentos: [{ id:Date.now(), valor:valor, forma:forma, parcelas_cartao:parcelas, data:new Date().toISOString(), obs:'Lançamento avulso' }]
  };
  vendas.push(venda);

  const _eVenda = await saveFinanceiro();
  showLoading(false);
  if(_eVenda){
    vendas.pop();
    nextVendaId--;
    showToast('Erro ao salvar: '+_eVenda.message,'error');
    return;
  }
  closeModal('modal-lancamento-avulso');
  showToast(`✅ ${fmtBRL(valor)} adicionado ao faturamento!`);
  if(typeof renderFinanceiroDash==='function' && document.getElementById('tab-financeiro')?.style.display!=='none') renderFinanceiroDash();
}

async function excluirDespesa(id){
  const d = despesas.find(x=>x.id===id); if(!d) return;
  if(!confirm(`Excluir despesa de ${fmtBRL(d.valor)} (${d.categoria})?`)) return;
  const idx = despesas.findIndex(x=>x.id===id);
  const backup = despesas[idx];
  despesas.splice(idx,1);
  showLoading(true);
  const _eDel = await saveFinanceiro();
  showLoading(false);
  if(_eDel){
    despesas.splice(idx,0,backup);
    showToast('Erro ao excluir: '+_eDel.message,'error');
    return;
  }
  showToast('Despesa excluída.');
  renderFinanceiroDash();
}

// ── RELATÓRIO MENSAL ──
function abrirRelatorioMensal(){
  openModal('modal-relatorio');
  const anos = [...new Set(vendas.map(v=>(v.data||v.dataFinal||'').slice(0,4)).filter(Boolean))].sort().reverse();
  const anoAtual = new Date().getFullYear().toString();
  if(!anos.includes(anoAtual)) anos.unshift(anoAtual);
  const mesAtual = (new Date().getMonth()+1).toString().padStart(2,'0');
  const meses=[['01','Janeiro'],['02','Fevereiro'],['03','Março'],['04','Abril'],['05','Maio'],['06','Junho'],['07','Julho'],['08','Agosto'],['09','Setembro'],['10','Outubro'],['11','Novembro'],['12','Dezembro']];
  const sm=document.getElementById('rel-mes');
  const sa=document.getElementById('rel-ano');
  if(sm) sm.innerHTML=meses.map(([v,l])=>`<option value="${v}"${v===mesAtual?' selected':''}>${l}</option>`).join('');
  if(sa) sa.innerHTML=anos.map(a=>`<option value="${a}"${a===anoAtual?' selected':''}>${a}</option>`).join('');
  renderRelatorio();
}

function renderRelatorio(){
  const mes=document.getElementById('rel-mes')?.value||'';
  const ano=document.getElementById('rel-ano')?.value||'';
  const mesesNome={'01':'Janeiro','02':'Fevereiro','03':'Março','04':'Abril','05':'Maio','06':'Junho','07':'Julho','08':'Agosto','09':'Setembro','10':'Outubro','11':'Novembro','12':'Dezembro'};
  const tituloMes=(mes&&ano)?`${mesesNome[mes]||mes} de ${ano}`:ano||'Todos os períodos';
  const filtrarDt=v=>{const dt=(v.data||v.dataFinal||'').slice(0,10);if(ano&&!dt.startsWith(ano))return false;if(mes&&dt.slice(5,7)!==mes)return false;return true;};
  const filtrarAg=a=>{if(ano&&!a.data.startsWith(ano))return false;if(mes&&a.data.slice(5,7)!==mes)return false;return true;};
  const vendasPer=vendas.filter(filtrarDt);
  const finPer=vendasPer.filter(v=>v.status==='finalizada');
  const fat=finPer.reduce((a,v)=>a+(Number(v.total)||0),0);
  const ticket=finPer.length?fat/finPer.length:0;
  const agsPer=agendamentos.filter(filtrarAg);
  const compareceu=agsPer.filter(a=>(agGetStatus(a)||'').toLowerCase()==='compareceu').length;
  const faltou=agsPer.filter(a=>(agGetStatus(a)||'').toLowerCase()==='faltou').length;
  const taxaComp=agsPer.length?Math.round(compareceu/agsPer.length*100):0;
  const contProc={};
  finPer.forEach(v=>(v.itens||[]).forEach(i=>{const n=i.nome||'—';contProc[n]=(contProc[n]||0)+(Number(i.qtd)||1);}));
  const topProcs=Object.entries(contProc).sort((a,b)=>b[1]-a[1]).slice(0,5);
  const fatProf={};
  finPer.forEach(v=>{const n=v.profNome||v.prof_nome||'—';fatProf[n]=(fatProf[n]||0)+(Number(v.total)||0);});
  const topProf=Object.entries(fatProf).sort((a,b)=>b[1]-a[1]);
  const novosPacs=pacientes.filter(p=>{const dt=(p.created_at||'').slice(0,10);if(ano&&!dt.startsWith(ano))return false;if(mes&&dt.slice(5,7)!==mes)return false;return true;}).length;
  const card=(titulo,valor,cor,icon)=>`<div style="background:var(--rose-lighter);border:1px solid var(--rose-light);border-radius:12px;padding:14px 16px;"><div style="font-size:11px;color:var(--rose-text);margin-bottom:4px;"><i class="ti ${icon}"></i> ${titulo}</div><div style="font-size:20px;font-weight:800;color:${cor};">${valor}</div></div>`;
  const barMax=topProcs[0]?.[1]||1;
  const barProcs=topProcs.length?topProcs.map(([nome,qtd])=>`<div style="margin-bottom:10px;"><div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px;"><span style="font-weight:500;color:#3a2020;max-width:75%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(nome)}">${escapeHtml(nome)}</span><span style="color:var(--rose-dark);font-weight:700;">${qtd}×</span></div><div style="background:var(--rose-light);border-radius:4px;height:6px;"><div style="background:var(--rose);border-radius:4px;height:6px;width:${Math.round(qtd/barMax*100)}%;"></div></div></div>`).join(''):'<div style="color:var(--rose-text);font-size:13px;">Sem procedimentos no período.</div>';
  const listProf=topProf.length?topProf.map(([nome,fat])=>`<div style="display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid var(--rose-light);font-size:13px;"><span>${escapeHtml(nome)}</span><strong style="color:var(--rose-dark);">${fmtBRL(fat)}</strong></div>`).join(''):'<div style="color:var(--rose-text);font-size:13px;">Sem dados.</div>';
  const corTaxa=taxaComp>=70?'#2e7d32':taxaComp>=50?'#e08a20':'#dc2626';
  document.getElementById('rel-content').innerHTML=`
    <div style="font-size:14px;font-weight:700;color:var(--rose-dark);margin-bottom:14px;padding-bottom:8px;border-bottom:1px solid var(--rose-light);"><i class="ti ti-calendar-stats"></i> ${tituloMes}</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-bottom:20px;">
      ${card('Faturamento',fmtBRL(fat),'var(--rose-dark)','ti-currency-dollar')}
      ${card('Ticket Médio',fmtBRL(ticket),'#1565c0','ti-receipt')}
      ${card('Vendas finalizadas',finPer.length,'#2e7d32','ti-circle-check')}
      ${card('Novos pacientes',novosPacs,'#7b1fa2','ti-user-plus')}
      ${card('Agendamentos',agsPer.length,'#e08a20','ti-calendar')}
      ${card('Compareceram',compareceu,'#2e7d32','ti-user-check')}
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px;">
      <div><div style="font-size:13px;font-weight:700;color:var(--rose-dark);margin-bottom:10px;"><i class="ti ti-list-numbers"></i> Top procedimentos</div>${barProcs}</div>
      <div><div style="font-size:13px;font-weight:700;color:var(--rose-dark);margin-bottom:10px;"><i class="ti ti-user-dollar"></i> Por profissional</div>${listProf}</div>
    </div>
    <div style="background:var(--rose-lighter);border-radius:12px;padding:14px 16px;margin-bottom:20px;">
      <div style="font-size:13px;font-weight:700;color:var(--rose-dark);margin-bottom:6px;"><i class="ti ti-chart-line"></i> Taxa de comparecimento</div>
      <div style="display:flex;justify-content:space-between;font-size:13px;color:var(--rose-text);flex-wrap:wrap;gap:6px;">
        <span>Compareceram: <strong style="color:#2e7d32;">${compareceu}</strong></span>
        <span>Faltaram: <strong style="color:#dc2626;">${faltou}</strong></span>
        <span>Total agendamentos: <strong>${agsPer.length}</strong></span>
        <span style="font-weight:800;color:${corTaxa};">${taxaComp}%</span>
      </div>
      <div style="background:var(--rose-light);border-radius:8px;height:12px;margin-top:8px;"><div style="background:${corTaxa};border-radius:8px;height:12px;width:${taxaComp}%;"></div></div>
    </div>
    ${(()=>{
      const _vendaPago = vendaValorPago;
      const inadPer = finPer.filter(v=>_vendaPago(v)<(v.total||0));
      const inadTotal = inadPer.reduce((a,v)=>a+((v.total||0)-_vendaPago(v)),0);
      const contMat={};
      finPer.forEach(v=>(v.itens||[]).forEach(it=>{
        const proc=procs.find(p=>p.nome===it.nome||p.id===it.procId);
        if(proc){(procInsumos[proc.id]||[]).forEach(ins=>{const m=mats.find(x=>x.id===ins.matId);if(m)contMat[m.nome]=(contMat[m.nome]||0)+(ins.qtd||1)*(it.qtd||1);});}
      }));
      const topMats=Object.entries(contMat).sort((a,b)=>b[1]-a[1]).slice(0,5);
      const matBarMax=topMats[0]?.[1]||1;
      return `<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px;">
        <div>
          <div style="font-size:13px;font-weight:700;color:var(--rose-dark);margin-bottom:10px;"><i class="ti ti-alert-triangle" style="color:#e65100;"></i> Inadimplência</div>
          ${inadPer.length?`
            <div style="font-size:12px;color:var(--rose-text);margin-bottom:8px;">${inadPer.length} venda(s) com saldo devedor</div>
            <div style="font-size:20px;font-weight:800;color:#dc2626;margin-bottom:10px;">${fmtBRL(inadTotal)}</div>
            ${inadPer.slice(0,5).map(v=>{const pac=pacientes.find(p=>p.id===v.pacienteId);return `<div style="display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid var(--rose-light);font-size:12px;"><span style="max-width:60%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(pac?.nome||v.pacienteNome||'—')}</span><strong style="color:#dc2626;">${fmtBRL((v.total||0)-_vendaPago(v))}</strong></div>`;}).join('')}
          `:`<div style="color:#2e7d32;font-size:13px;"><i class="ti ti-circle-check"></i> Sem inadimplência no período.</div>`}
        </div>
        <div>
          <div style="font-size:13px;font-weight:700;color:var(--rose-dark);margin-bottom:10px;"><i class="ti ti-flask"></i> Materiais mais usados</div>
          ${topMats.length?topMats.map(([nome,qtd])=>`<div style="margin-bottom:8px;"><div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:2px;"><span style="max-width:70%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(nome)}">${escapeHtml(nome)}</span><span style="color:var(--rose-dark);font-weight:700;">${qtd}x</span></div><div style="background:var(--rose-light);border-radius:4px;height:5px;"><div style="background:#7b1fa2;border-radius:4px;height:5px;width:${Math.round(qtd/matBarMax*100)}%;"></div></div></div>`).join(''):`<div style="color:var(--rose-text);font-size:13px;">Sem dados de materiais no período.</div>`}
        </div>
      </div>`;
    })()}`;
}

let fioCallback = null;

function abrirSeletorFio(callback){
  fioCallback = callback;
  fioAtualizarNumeracoes();
  fioAtualizarInfo();
  document.getElementById('fio-modal-bg').style.display='flex';
}

function fioAtualizarNumeracoes(){
  const tipo = document.getElementById('fio-tipo').value;
  const numEl = document.getElementById('fio-num');
  const niti  = ['0.012','0.014','0.016','0.018','0.019x25','0.020'];
  const aco   = ['0.012','0.014','0.016','0.018','0.020','0.019x25','0.017x25'];
  const nums  = tipo==='niti' ? niti : aco;
  numEl.innerHTML = nums.map(n=>`<option value="${n}">${n}</option>`).join('');
  fioAtualizarInfo();
}

function fioAtualizarInfo(){
  const tipo   = document.getElementById('fio-tipo').value;
  const num    = document.getElementById('fio-num')?.value||'';
  const arcada = document.getElementById('fio-arcada')?.value||'';
  const tipoNome = tipo==='niti'?'NiTi':'Aço';
  const arcNome = arcada==='ambas'?'Superior + Inferior':arcada.charAt(0).toUpperCase()+arcada.slice(1);
  // Busca material correspondente
  const matNome = `Fio ${tipoNome} ${num} ${arcNome.split(' ')[0]}`;
  const mat = mats.find(m=>m.nome.toLowerCase().includes(tipo==='niti'?'niti':'aço')&&m.nome.includes(num)&&m.nome.toLowerCase().includes(arcada==='ambas'?'superior':arcada));
  const infoEl = document.getElementById('fio-mat-info');
  if(infoEl){
    if(mat){
      const est = estoque[mat.id]||{atual:0};
      const cor = est.atual<=0?'#dc2626':est.atual<=2?'#856404':'#2e7d32';
      infoEl.innerHTML = `<b>${escapeHtml(mat.nome)}</b><br>Estoque: <span style="color:${cor};font-weight:700;">${est.atual} unid</span> · Custo: R$ ${mat.custo.toFixed(2)}`;
    } else {
      infoEl.innerHTML = `Fio ${escapeHtml(tipoNome)} ${escapeHtml(num)} ${escapeHtml(arcNome)} — material não cadastrado`;
    }
  }
  document.getElementById('fio-tipo').onchange = fioAtualizarInfo;
  document.getElementById('fio-num').onchange = fioAtualizarInfo;
  document.getElementById('fio-arcada').onchange = fioAtualizarInfo;
}

function fioConfirmar(){
  const tipo   = document.getElementById('fio-tipo').value;
  const num    = document.getElementById('fio-num').value;
  const arcada = document.getElementById('fio-arcada').value;
  const tipoNome = tipo==='niti'?'NiTi':'Aço';
  const arcadas = arcada==='ambas'?['superior','inferior']:[arcada];
  
  // Desconta estoque
  arcadas.forEach(arc=>{
    const mat = mats.find(m=>
      m.nome.toLowerCase().includes(tipo==='niti'?'niti':'aço')&&
      m.nome.includes(num)&&
      m.nome.toLowerCase().includes(arc));
    if(mat){
      if(!estoque[mat.id]) estoque[mat.id]={atual:0,min:2,compra:5};
      estoque[mat.id].atual = Math.max(0,(estoque[mat.id].atual||0)-1);
    }
  });

  const desc = `Fio ${tipoNome} ${num} — ${arcada==='ambas'?'Superior+Inferior':arcada.charAt(0).toUpperCase()+arcada.slice(1)}`;
  document.getElementById('fio-modal-bg').style.display='none';
  if(fioCallback) fioCallback(desc);
  showToast('Fio registrado: '+desc);
}


// ══════════════════════════════════════════════════════
// MANUTENÇÃO ORTODÔNTICA COM QUEBRAS/PERDAS
// ══════════════════════════════════════════════════════

// Preços das peças por tipo de aparelho
const PECAS_ORTO = {
  'ceramico':   [
    {id:'bq',nome:'Braquete Cerâmico',preco:50},
    {id:'arc',nome:'Arco',preco:30},
    {id:'lig',nome:'Ligadura Estética',preco:5},
    {id:'tub',nome:'Tubo Molar',preco:35},
    {id:'banda',nome:'Banda Molar',preco:40},
  ],
  'porcelana':  [
    {id:'bq',nome:'Braquete Porcelana',preco:90},
    {id:'arc',nome:'Arco',preco:30},
    {id:'lig',nome:'Ligadura',preco:5},
    {id:'tub',nome:'Tubo Molar',preco:35},
    {id:'banda',nome:'Banda Molar',preco:40},
  ],
  'safira':     [
    {id:'bq',nome:'Braquete Safira',preco:110},
    {id:'arc',nome:'Arco',preco:30},
    {id:'lig',nome:'Ligadura',preco:5},
    {id:'tub',nome:'Tubo Molar',preco:35},
    {id:'banda',nome:'Banda Molar',preco:40},
  ],
  'autoligado_estetico': [
    {id:'bq',nome:'Braquete Autoligado Estético',preco:120},
    {id:'arc',nome:'Arco',preco:35},
    {id:'tub',nome:'Tubo Molar Autoligado',preco:45},
    {id:'banda',nome:'Banda Molar',preco:40},
  ],
  'metalico_tradicional': [
    {id:'bq',nome:'Braquete Metálico',preco:25},
    {id:'arc',nome:'Arco',preco:25},
    {id:'lig',nome:'Ligadura Metálica',preco:3},
    {id:'tub',nome:'Tubo Molar',preco:25},
    {id:'banda',nome:'Banda Molar',preco:35},
    {id:'mola',nome:'Mola de Abertura',preco:30},
  ],
  'metalico_autoligado': [
    {id:'bq',nome:'Braquete Autoligado Metálico',preco:40},
    {id:'arc',nome:'Arco',preco:25},
    {id:'tub',nome:'Tubo Molar Autoligado',preco:35},
    {id:'banda',nome:'Banda Molar',preco:35},
    {id:'mola',nome:'Mola de Abertura',preco:30},
  ],
  'invisalign': [
    {id:'alin',nome:'Alinhador Avulso',preco:350},
    {id:'retent',nome:'Retentor',preco:200},
    {id:'anex',nome:'Attachment',preco:80},
  ],
};

// Preços base de manutenção por tipo
const MANUT_PRECOS = {
  'ceramico':             180,
  'porcelana':            180,
  'safira':               180,
  'autoligado_estetico':  190,
  'metalico_tradicional': 150,
  'metalico_autoligado':  160,
  'invisalign':           250,
};

let manutTipoAtual = 'metalico_tradicional';
let manutPecasSel = {}; // {id: qtd}
let manutCallback = null;

// ── Modal "Recolagem de Braquete" — peça avulsa com preço por tipo de aparelho ──
let recolProcAtual = null;
let recolTipoAtual = 'metalico_tradicional';
let recolPecasSel = {}; // {id: qtd}

function abrirModalRecolagem(proc){
  recolProcAtual = proc;
  recolTipoAtual = 'metalico_tradicional';
  recolPecasSel = {};
  const sel = document.getElementById('recol-tipo');
  if(sel) sel.value = recolTipoAtual;
  recolAtualizarPecas();
  openModal('modal-recolagem');
}

function recolAtualizarPecas(){
  recolTipoAtual = document.getElementById('recol-tipo')?.value || 'metalico_tradicional';
  recolPecasSel = {};
  recolRenderPecas();
  recolCalcTotal();
}

function recolRenderPecas(){
  const pecas = PECAS_ORTO[recolTipoAtual]||[];
  const el = document.getElementById('recol-pecas-btns');
  if(!el) return;
  if(!pecas.length){
    el.innerHTML = `<div style="font-size:12px;color:var(--rose-text);padding:6px 0;">Nenhuma peça cadastrada para este tipo de aparelho.</div>`;
    return;
  }
  el.innerHTML = pecas.map(p=>`
    <button type="button" onclick="recolTogglePeca('${p.id}')"
      data-recol-peca="${p.id}"
      style="padding:6px 12px;border:2px solid var(--rose-light);border-radius:8px;background:#fff;cursor:pointer;font-size:12px;font-weight:600;">
      ${p.nome} <span style="color:var(--rose-dark);">+R$${p.preco}</span>
    </button>`).join('');
}

function recolTogglePeca(id){
  const pecas = PECAS_ORTO[recolTipoAtual]||[];
  const p = pecas.find(x=>x.id===id);
  if(!p) return;
  recolPecasSel[id] = (recolPecasSel[id]||0) + 1;
  const btn = document.querySelector(`[data-recol-peca="${id}"]`);
  if(btn){
    btn.style.borderColor='var(--rose)';
    btn.style.background='var(--rose-lighter)';
    const spanExtra = '<span style="color:var(--rose-dark);">+R$'+(p.preco*recolPecasSel[id])+'</span>';
    const spanX = '<span onclick="event.stopPropagation();recolRemovePeca(\''+id+'\')" style="cursor:pointer;color:#dc2626;font-size:14px;">✕</span>';
    btn.innerHTML = p.nome+' ×'+recolPecasSel[id]+' '+spanExtra+' '+spanX;
  }
  recolCalcTotal();
}

function recolRemovePeca(id){
  delete recolPecasSel[id];
  const pecas = PECAS_ORTO[recolTipoAtual]||[];
  const p = pecas.find(x=>x.id===id);
  const btn = document.querySelector(`[data-recol-peca="${id}"]`);
  if(btn && p){
    btn.style.borderColor='var(--rose-light)';
    btn.style.background='#fff';
    btn.innerHTML = p.nome+' <span style="color:var(--rose-dark);">+R$'+p.preco+'</span>';
  }
  recolCalcTotal();
}

function recolCalcTotal(){
  const base = recolProcAtual ? (recolProcAtual.precoFinal||0) : 0;
  const pecas = PECAS_ORTO[recolTipoAtual]||[];
  let extra = 0;
  Object.entries(recolPecasSel).forEach(([id,qtd])=>{
    const p = pecas.find(x=>x.id===id);
    if(p) extra += p.preco*qtd;
  });
  const total = base + extra;
  const fmt = v => 'R$ '+v.toFixed(2).replace('.',',');
  const elBase = document.getElementById('recol-val-base'); if(elBase) elBase.textContent = fmt(base);
  const elPecas = document.getElementById('recol-val-pecas'); if(elPecas) elPecas.textContent = fmt(extra);
  const elTotal = document.getElementById('recol-val-total'); if(elTotal) elTotal.textContent = fmt(total);
}

function recolConfirmar(){
  if(!recolProcAtual) return;
  const pecas = PECAS_ORTO[recolTipoAtual]||[];
  let extra = 0;
  const pecasDesc = [];
  Object.entries(recolPecasSel).forEach(([id,qtd])=>{
    const p = pecas.find(x=>x.id===id);
    if(p){ extra += p.preco*qtd; pecasDesc.push(p.nome+' ×'+qtd); }
  });
  const base = recolProcAtual.precoFinal||0;
  const total = parseFloat((base+extra).toFixed(2));
  const labelTipo = {
    ceramico:'Estético Cerâmico', porcelana:'Estético Porcelana', safira:'Estético Safira',
    autoligado_estetico:'Estético Autoligado', metalico_tradicional:'Metálico Tradicional',
    metalico_autoligado:'Metálico Autoligado', invisalign:'Alinhador Transparente',
  }[recolTipoAtual] || recolTipoAtual;
  const nomeItem = recolProcAtual.nome + ' — ' + labelTipo + (pecasDesc.length ? ' ('+pecasDesc.join(', ')+')' : '');

  if(typeof pacOdontoOrcList === 'undefined' || !pacOdontoOrcList) pacOdontoOrcList = [];
  pacOdontoOrcList.push({
    procId: recolProcAtual.id, nome: nomeItem, precoUnit: total, qtd: 1,
    dentes: '', tipo: 'global', total: total
  });

  closeModal('modal-recolagem');
  pacOdontoRenderOrcLista();
  showToast(nomeItem+' adicionado — Total: '+'R$ '+total.toFixed(2).replace('.',','));
}


function abrirManutModal(){
  const proc = (document.getElementById('pac-at-proc')?.value||'').toLowerCase();
  let tipo = 'metalico_tradicional';
  if(proc.includes('cerâmic')||proc.includes('ceramic')) tipo='ceramico';
  else if(proc.includes('porcelana')) tipo='porcelana';
  else if(proc.includes('safira')) tipo='safira';
  else if(proc.includes('autoligado') && (proc.includes('estético')||proc.includes('estetico'))) tipo='autoligado_estetico';
  else if(proc.includes('autoligado')) tipo='metalico_autoligado';
  else if(proc.includes('invisalign')||proc.includes('alinhador transparente')) tipo='invisalign';
  
  abrirManutencao(tipo, (desc, total)=>{
    const obsEl=document.getElementById('pac-at-obs');
    if(obsEl) obsEl.value=(obsEl.value?obsEl.value+' | ':'')+desc;
    const valorEl=document.getElementById('pac-at-valor');
    if(valorEl) valorEl.value=total.toFixed(2);
    showToast('Fio e peças registrados!');
  });
}

function abrirManutencao(tipo, callback){
  manutTipoAtual = tipo || 'metalico_tradicional';
  manutPecasSel = {};
  manutCallback = callback;

  const label = {
    ceramico:'Aparelho Estético Cerâmico',
    porcelana:'Aparelho Estético Porcelana',
    safira:'Aparelho Estético Safira',
    autoligado_estetico:'Aparelho Estético Autoligado',
    metalico_tradicional:'Aparelho Metálico Tradicional',
    metalico_autoligado:'Aparelho Metálico Autoligado',
    invisalign:'Alinhador Transparente',
  }[tipo]||tipo;

  document.getElementById('manut-tipo-label').textContent = label;
  manutAtualizarFio();
  manutRenderPecas();
  manutCalcTotal();
  document.getElementById('manut-modal-bg').style.display='flex';
}

function manutAtualizarFio(){
  const tipo = document.getElementById('manut-fio-tipo').value;
  const nums = tipo==='niti'
    ? ['0.012','0.014','0.016','0.018','0.019x25','0.020']
    : ['0.012','0.014','0.016','0.018','0.020','0.019x25','0.017x25'];
  const el = document.getElementById('manut-fio-num');
  if(el) el.innerHTML = nums.map(n=>`<option value="${n}">${n}</option>`).join('');
  manutInfoFio();
}

function manutInfoFio(){
  const tipo = document.getElementById('manut-fio-tipo')?.value||'niti';
  const num  = document.getElementById('manut-fio-num')?.value||'0.016';
  const arc  = document.getElementById('manut-fio-arcada')?.value||'ambas';
  const tn   = tipo==='niti'?'NiTi':'Aço';
  const arcs = arc==='ambas'?['superior','inferior']:[arc];
  let info = `Fio ${tn} ${num} — `;
  let estOk = true;
  arcs.forEach(a=>{
    const mat = mats.find(m=>m.nome.toLowerCase().includes(tn.toLowerCase())&&m.nome.includes(num)&&m.nome.toLowerCase().includes(a));
    if(mat){
      const qt=(estoque[mat.id]||{atual:0}).atual;
      info += `${a}: ${qt} unid  `;
      if(qt<=0) estOk=false;
    }
  });
  const el=document.getElementById('manut-fio-info');
  if(el){ el.textContent=info; el.style.color=estOk?'#2e7d32':'#dc2626'; }
}

function manutRenderPecas(){
  const pecas = PECAS_ORTO[manutTipoAtual]||[];
  const el = document.getElementById('manut-pecas-btns');
  if(!el) return;
  el.innerHTML = pecas.map(p=>`
    <button type="button" onclick="manutTogglePeca('${p.id}')"
      data-peca="${p.id}"
      style="padding:6px 12px;border:2px solid var(--rose-light);border-radius:8px;background:#fff;cursor:pointer;font-size:12px;font-weight:600;">
      ${p.nome} <span style="color:var(--rose-dark);">+R$${p.preco}</span>
    </button>`).join('');
}

function manutTogglePeca(id){
  const pecas = PECAS_ORTO[manutTipoAtual]||[];
  const p = pecas.find(x=>x.id===id);
  if(!p) return;
  if(manutPecasSel[id]){
    manutPecasSel[id]++;
  } else {
    manutPecasSel[id]=1;
  }
  // Atualiza visual do botão
  const btn=document.querySelector(`[data-peca="${id}"]`);
  if(btn){
    btn.style.borderColor='var(--rose)';
    btn.style.background='var(--rose-lighter)';
    btn.textContent='';
    var spanExtra='<span style="color:var(--rose-dark);">+R$'+(p.preco*manutPecasSel[id])+'</span>';
    var spanX='<span onclick="event.stopPropagation();manutRemovePeca(\'' +id+ '\')" style="cursor:pointer;color:#dc2626;font-size:14px;">✕</span>';
    btn.innerHTML=p.nome+' ×'+manutPecasSel[id]+' '+spanExtra+' '+spanX;
  }
  manutCalcTotal();
}

function manutRemovePeca(id){
  delete manutPecasSel[id];
  const pecas=PECAS_ORTO[manutTipoAtual]||[];
  const p=pecas.find(x=>x.id===id);
  const btn=document.querySelector('[data-peca="'+id+'"]');
  if(btn&&p){
    btn.style.borderColor='var(--rose-light)';
    btn.style.background='#fff';
    btn.innerHTML=p.nome+' <span style="color:var(--rose-dark);">+R$'+p.preco+'</span>';
  }
  manutCalcTotal();
}

function manutCalcTotal(){
  const base = MANUT_PRECOS[manutTipoAtual]||150;
  const pecas = PECAS_ORTO[manutTipoAtual]||[];
  let extra = 0;
  Object.entries(manutPecasSel).forEach(([id,qtd])=>{
    const p=pecas.find(x=>x.id===id);
    if(p) extra+=p.preco*qtd;
  });
  const total=base+extra;
  const fmt=v=>'R$ '+v.toFixed(2).replace('.',',');
  const elBase=document.getElementById('manut-val-base'); if(elBase) elBase.textContent=fmt(base);
  const elExtra=document.getElementById('manut-val-extra'); if(elExtra) elExtra.textContent=fmt(extra);
  const elTotal=document.getElementById('manut-val-total'); if(elTotal) elTotal.textContent=fmt(total);
  const rowExtra=document.getElementById('manut-val-extra-row');
  if(rowExtra) rowExtra.style.display=extra>0?'flex':'none';
  const extTotal=document.getElementById('manut-extra-total');
  if(extTotal) extTotal.textContent=extra>0?'Extra total: '+fmt(extra):'';
}

function manutConfirmar(){
  const tipo=document.getElementById('manut-fio-tipo')?.value||'niti';
  const num=document.getElementById('manut-fio-num')?.value||'0.016';
  const arc=document.getElementById('manut-fio-arcada')?.value||'ambas';
  const tn=tipo==='niti'?'NiTi':'Aço';
  const base=MANUT_PRECOS[manutTipoAtual]||150;
  const pecas=PECAS_ORTO[manutTipoAtual]||[];
  let extra=0;
  const pecasDesc=[];
  Object.entries(manutPecasSel).forEach(([id,qtd])=>{
    const p=pecas.find(x=>x.id===id);
    if(p){extra+=p.preco*qtd;pecasDesc.push(p.nome+'×'+qtd);}
  });
  const total=base+extra;
  // Desconta fio do estoque
  const arcs=arc==='ambas'?['superior','inferior']:[arc];
  arcs.forEach(a=>{
    const mat=mats.find(m=>m.nome.toLowerCase().includes(tn.toLowerCase())&&m.nome.includes(num)&&m.nome.toLowerCase().includes(a));
    if(mat){if(!estoque[mat.id])estoque[mat.id]={atual:0,min:2,compra:5};estoque[mat.id].atual=Math.max(0,(estoque[mat.id].atual||0)-1);}
  });
  const desc=`Fio ${tn} ${num} (${arc==='ambas'?'Sup+Inf':arc})${pecasDesc.length?' | Quebras: '+pecasDesc.join(', '):''}`;
  document.getElementById('manut-modal-bg').style.display='none';
  if(manutCallback) manutCallback(desc, total);
  showToast('Manutenção registrada — Total: R$ '+total.toFixed(2).replace('.',','));
}

async function loadFinanceiro(){
  if(!clinicaId) return;

  const safe = (str, def) => { if(str===null||str===undefined) return def; try{ const v=JSON.parse(str); return (v!==null&&v!==undefined)?v:def; }catch(e){ return def; } };

  const { data } = await _sb.from('financeiro_config')
    .select('*').eq('clinica_id', clinicaId).single();

  let precisaSalvar = false;

  if(data){
    // Carrega EXATAMENTE o que está no banco — não sobrescreve com padrões
    const _procs = safe(data.procs, []);
    const _mats  = safe(data.mats,  []);
    procs       = _procs.length ? _procs : [];
    mats        = _mats.length  ? _mats  : [];
    estoque     = safe(data.estoque,     {});
    procInsumos = safe(data.proc_insumos,{});
    vendas      = safe(data.vendas,      []);
    despesas    = safe(data.despesas,    []);
    combos      = safe(data.combos,      []);
    cfg         = safe(data.cfg,         cfg);
    pagPac      = Array.isArray(cfg._pagPac) ? cfg._pagPac : [];
    taxasCfg    = safe(data.taxas_cfg,   taxasCfg);
    descCfg     = safe(data.desc_cfg,    descCfg);
  }

  // Só preenche com padrão se realmente não tem nada salvo
  if(!procs.length){
    procs = DEFAULT_PROCS_FIN.map((p,i)=>({...p,id:p.id||i+1}));
    precisaSalvar = true;
  }
  if(!mats.length){
    mats = DEFAULT_MATS_FIN.map((m,i)=>({...m,id:m.id||i+1}));
    precisaSalvar = true;
  }
  if(!combos.length){
    combos = DEFAULT_COMBOS_FIN.map(c=>({...c}));
    precisaSalvar = true;
  }
  // Insumos: só adiciona padrão para procedimentos que não têm nada salvo
  Object.entries(DEFAULT_PROC_INSUMOS_DATA).forEach(([k,v])=>{
    if(!procInsumos[k] || !procInsumos[k].length){
      procInsumos[k] = JSON.parse(JSON.stringify(v));
      precisaSalvar = true;
    }
  });

  // Reconstrói nextIds
  nextProcId  = procs.length  ? Math.max(...procs.map(p=>p.id||0))   + 1 : 103;
  nextMatId   = mats.length   ? Math.max(...mats.map(m=>m.id||0))    + 1 : 91;
  nextVendaId = vendas.length ? Math.max(...vendas.map(v=>v.id||0))  + 1 : 1;
  nextComboId = combos.length ? Math.max(...combos.map(c=>c.id||200))+ 1 : 207;
  nextDespesaId = despesas.length ? Math.max(...despesas.map(d=>d.id||0)) + 1 : 1;

  recalcularInsumos(true);

  _financeiroCarregado = true;

  // Salva padrões sem sobrescrever estoque
  if(precisaSalvar){
    // Salva padrões mantendo o estoque atual intacto
    const _estoqueBackup = JSON.parse(JSON.stringify(estoque));
    const _eSvPad=await saveFinanceiro();
    if(_eSvPad) showToast('Erro ao salvar padrões: '+_eSvPad.message,'error');
    // Após salvar, restaura o estoque do banco (pode ter sido importado antes)
    const { data: _fresh } = await _sb.from('financeiro_config').select('estoque').eq('clinica_id',clinicaId).single();
    if(_fresh && _fresh.estoque){
      try {
        const _est = JSON.parse(_fresh.estoque);
        // Usa o estoque do banco se tiver mais itens que o atual
        if(typeof _est === 'object' && !Array.isArray(_est) && Object.keys(_est).length > Object.keys(estoque).length){
          estoque = _est;
        }
      } catch(e){ /* mantém estoque atual se JSON inválido */ }
    }
    // Garante que o backup local não seja perdido se o banco estiver vazio
    if(Object.keys(estoque).length === 0 && Object.keys(_estoqueBackup).length > 0){
      estoque = _estoqueBackup;
      const _eReB=await saveFinanceiro(); // re-salva o backup que estava na memória
      if(_eReB) showToast('Erro ao salvar backup de estoque: '+_eReB.message,'error');
    }
  }

  await injetarNovosMatsOrto();
}

let _saveLock = null;
async function saveFinanceiro(){
  if(!clinicaId) return {message:'clinicaId não definido'};
  if(!_financeiroCarregado){
    console.warn('saveFinanceiro bloqueado: dados ainda não carregados do banco');
    return {message:'Dados financeiros ainda não carregados. Aguarde e tente novamente.'};
  }
  if(_saveLock) await _saveLock;
  let _unlock;
  _saveLock = new Promise(r=>{ _unlock=r; });
  try { return await _saveFinanceiroImpl(); }
  finally { _unlock(); _saveLock=null; }
}
async function _saveFinanceiroImpl(){
  cfg._pagPac = pagPac;
  const payload = {
    clinica_id   : clinicaId,
    procs        : JSON.stringify(procs),
    mats         : JSON.stringify(mats),
    estoque      : JSON.stringify(estoque),
    proc_insumos : JSON.stringify(procInsumos),
    vendas       : JSON.stringify(vendas),
    despesas     : JSON.stringify(despesas),
    cfg          : JSON.stringify(cfg),
    taxas_cfg    : JSON.stringify(taxasCfg),
    updated_at   : new Date().toISOString(),
    combos       : JSON.stringify(combos),
    desc_cfg     : JSON.stringify(descCfg)
  };
  // Upsert
  const { data: existing } = await _sb.from('financeiro_config').select('id').eq('clinica_id',clinicaId).single();
  let saveError;
  if(existing){
    const { error } = await _sb.from('financeiro_config').update(payload).eq('clinica_id',clinicaId);
    saveError = error;
  } else {
    const { error } = await _sb.from('financeiro_config').insert([payload]);
    saveError = error;
  }
  if(saveError){ console.error('saveFinanceiro ERRO:', saveError.message); showToast('Erro ao salvar: '+saveError.message,'error'); }
  return saveError || null;
}

// ── Helpers de cálculo ──
function calcHora(){
  const base = (Number(cfg.salario)||0) + gastosTotalMensal();
  const horas = Number(cfg.horas)||132;
  const trib  = Number(cfg.trib)||0;
  const raw   = horas > 0 ? base / horas : 0;
  return parseFloat((raw * (1 + trib/100)).toFixed(2));
}
function gastosTotalMensal(){ return 0; } // simplificado — sem gastos fixos por ora
function custoProc(p){
  const hc = parseFloat(((Number(p.tempo)||0) / 60 * calcHora()).toFixed(2));
  return parseFloat((Number(p.insumos||0) + hc + Number(p.laboratorio||0)).toFixed(2));
}
function calcPrecoFinal(p){
  const custo = custoProc(p);
  const margem = Number(p.margem || cfg.margem || 100);
  const desperd = Number(cfg.desperd||0);
  const raw = custo * (1 + margem/100) * (1 + desperd/100);
  return parseFloat(raw.toFixed(2));
}

function calcPrecoManut(manutId, recalcInst){
  const instId = _MANUT_TO_INST[manutId];
  if(!instId) return null;
  const inst = procs.find(x=>x.id===instId);
  if(!inst) return null;
  const manut = procs.find(x=>x.id===manutId);
  if(!manut) return null;
  if(recalcInst){
    const ins = procInsumos[inst.id]||[];
    if(ins.length){
      inst.insumos = parseFloat(ins.reduce((acc,item)=>{const m=mats.find(x=>x.id===item.matId);return acc+(m?m.custo*item.qtd:0);},0).toFixed(2));
    }
    if(!inst._margemManual) inst.margem = cfg.margem;
    inst.horaClin = parseFloat(((inst.tempo/60)*calcHora()).toFixed(2));
    if(!inst._precoManual) inst.precoFinal = calcPrecoFinal(inst);
  }
  if(!inst.precoFinal) return null;
  const pct = Number(cfg.pct_manut)||15;
  const parcelaInst = parseFloat((inst.precoFinal * pct / 100).toFixed(2));
  const precoManut = calcPrecoFinal(manut);
  return parseFloat((precoManut + parcelaInst).toFixed(2));
}

// ── PAINEL FINANCEIRO ──
// ── HELPERS DE PERÍODO ──
function _periodoPopularSelects(mesId, anoId, prefixo){
  const anos = [...new Set(vendas.map(v=>(v.data||v.dataFinal||'').slice(0,4)).filter(Boolean))].sort().reverse();
  const anoAtual = new Date().getFullYear().toString();
  if(!anos.includes(anoAtual)) anos.unshift(anoAtual);
  const mesAtual = (new Date().getMonth()+1).toString().padStart(2,'0');
  const meses = [
    ['01','Janeiro'],['02','Fevereiro'],['03','Março'],['04','Abril'],
    ['05','Maio'],['06','Junho'],['07','Julho'],['08','Agosto'],
    ['09','Setembro'],['10','Outubro'],['11','Novembro'],['12','Dezembro']
  ];
  const selMes = document.getElementById(mesId);
  const selAno = document.getElementById(anoId);
  if(!selMes || !selAno) return;
  const curMes = selMes.value || mesAtual;
  const curAno = selAno.value || anoAtual;
  selMes.innerHTML = '<option value="">Todos os meses</option>' + meses.map(([v,l])=>`<option value="${v}"${v===curMes?' selected':''}>${l}</option>`).join('');
  selAno.innerHTML = '<option value="">Todos os anos</option>' + anos.map(a=>`<option value="${a}"${a===curAno?' selected':''}>${a}</option>`).join('');
  if(!selMes.value) selMes.value = mesAtual;
  if(!selAno.value) selAno.value = curAno;
}
function finSetPeriodo(modo){
  const sm = document.getElementById('fin-mes');
  const sa = document.getElementById('fin-ano');
  if(!sm||!sa) return;
  if(modo==='tudo'){ sm.value=''; sa.value=''; }
  renderFinanceiroDash();
}
function vendaSetPeriodo(modo){
  const sm = document.getElementById('venda-mes');
  const sa = document.getElementById('venda-ano');
  if(!sm||!sa) return;
  if(modo==='tudo'){ sm.value=''; sa.value=''; }
  renderVendas();
}
function _filtrarVendasPorPeriodo(lista, mesId, anoId){
  const mes = document.getElementById(mesId)?.value||'';
  const ano = document.getElementById(anoId)?.value||'';
  if(!mes && !ano) return lista;
  return lista.filter(v=>{
    const dt = (v.data||v.dataFinal||'').slice(0,10);
    if(ano && !dt.startsWith(ano)) return false;
    if(mes && dt.slice(5,7)!==mes) return false;
    return true;
  });
}
function _labelPeriodo(mesId, anoId){
  const mes = document.getElementById(mesId)?.value||'';
  const ano = document.getElementById(anoId)?.value||'';
  const meses = {
    '01':'Jan','02':'Fev','03':'Mar','04':'Abr','05':'Mai','06':'Jun',
    '07':'Jul','08':'Ago','09':'Set','10':'Out','11':'Nov','12':'Dez'
  };
  if(!mes && !ano) return 'todo o histórico';
  if(mes && ano) return `${meses[mes]||mes}/${ano}`;
  if(ano) return `${ano}`;
  return meses[mes]||mes;
}

function renderFinanceiroDash(){
  // Auto-carrega se vazio (não precisa mais de botão)
  if(procs.length === 0){ carregarPadroes(false); return; }

  _periodoPopularSelects('fin-mes','fin-ano','fin');
  const _periodo = _labelPeriodo('fin-mes','fin-ano');
  const fin = _filtrarVendasPorPeriodo(vendas.filter(v=>v.status==='finalizada'), 'fin-mes','fin-ano');
  const orc = vendas.filter(v=>v.status==='orcamento');
  const fat = fin.reduce((a,v)=>a+(Number(v.total)||0),0);
  const despFin = _filtrarVendasPorPeriodo(despesas, 'fin-mes','fin-ano');
  const totalDesp = despFin.reduce((a,d)=>a+(Number(d.valor)||0),0);
  const fatLiquido = fat - totalDesp;
  const ticket = fin.length ? fat/fin.length : 0;
  const criticos = mats.filter(m=>getEstStatus(m.id)==='danger').length;

  document.getElementById('fin-metrics').innerHTML = [
    {lbl:'Faturamento bruto ('+_periodo+')',val:fmtBRL(fat),cor:'var(--rose-dark)'},
    {lbl:'Despesas (protético etc.)',val:fmtBRL(totalDesp),cor:'#c0392b'},
    {lbl:'Faturamento líquido',val:fmtBRL(fatLiquido),cor:'#2e7d32'},
    {lbl:'Vendas finalizadas',val:fin.length,cor:'#2e7d32'},
    {lbl:'Ticket médio',val:fmtBRL(ticket),cor:'#1565c0'},
    {lbl:'Orçamentos abertos',val:orc.length,cor:'#856404'},
    {lbl:'Estoque crítico',val:criticos,cor:'#dc2626'},
  ].map(s=>`<div style="background:var(--rose-lighter);border:1px solid var(--rose-light);border-radius:12px;padding:14px 18px;">
    <div style="font-size:11px;color:var(--rose-text);margin-bottom:4px;">${s.lbl}</div>
    <div style="font-size:22px;font-weight:800;color:${s.cor};">${s.val}</div>
  </div>`).join('');

  // Vendas recentes do período
  const recentes = fin.slice().reverse().slice(0,5);
  document.getElementById('fin-vendas-recentes').innerHTML = recentes.length
    ? recentes.map(v=>`<div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--rose-light);font-size:13px;">
        <span>${escapeHtml(v.pacienteNome||'—')}</span>
        <span>${fmtBRL(v.total)} <span class="fin-badge ${v.status}">${v.status}</span></span>
      </div>`).join('')
    : '<div style="color:var(--rose-text);font-size:13px;">Nenhuma venda no período.</div>';

  // Despesas recentes do período
  const despRecentesEl = document.getElementById('fin-despesas-recentes');
  if(despRecentesEl){
    const despRecentes = despFin.slice().reverse().slice(0,5);
    despRecentesEl.innerHTML = despRecentes.length
      ? despRecentes.map(d=>`<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--rose-light);font-size:13px;">
          <span>${escapeHtml(d.categoria||'—')}${d.descricao?' — '+escapeHtml(d.descricao):''}</span>
          <span style="display:flex;align-items:center;gap:8px;">
            <span style="color:#c0392b;font-weight:700;">− ${fmtBRL(d.valor)}</span>
            <button class="btn-danger" style="padding:3px 7px;font-size:10px;" onclick="excluirDespesa(${d.id})" title="Excluir"><i class="ti ti-trash"></i></button>
          </span>
        </div>`).join('')
      : '<div style="color:var(--rose-text);font-size:13px;">Nenhuma despesa no período.</div>';
  }

  // Estoque crítico
  const crit = mats.filter(m=>getEstStatus(m.id)==='danger').slice(0,5);
  document.getElementById('fin-estoque-alerta').innerHTML = crit.length
    ? crit.map(m=>`<div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--rose-light);font-size:13px;">
        <span>${escapeHtml(m.nome)}</span>
        <span class="fin-badge danger">Crítico: ${(estoque[m.id]||{}).atual||0} ${m.unid||''}</span>
      </div>`).join('')
    : '<div style="color:#2e7d32;font-size:13px;">✓ Estoque OK</div>';

  renderChartMensal();
  renderChartTopProcs(fin);
}

function renderChartMensal(){
  const el = document.getElementById('fin-chart-mensal'); if(!el) return;
  const hoje = new Date();
  const meses = [];
  for(let i=5;i>=0;i--){
    const d = new Date(hoje.getFullYear(), hoje.getMonth()-i, 1);
    const key = d.toISOString().slice(0,7);
    const label = d.toLocaleDateString('pt-BR',{month:'short'}).replace('.','');
    const total = vendas.filter(v=>v.status==='finalizada'&&(v.data||'').startsWith(key)).reduce((a,v)=>a+(v.total||0),0);
    meses.push({label, total, key});
  }
  const max = Math.max(...meses.map(m=>m.total),1);
  const barW = Math.floor(100/meses.length);
  el.innerHTML = `<div style="display:flex;align-items:flex-end;gap:6px;height:120px;">
    ${meses.map(m=>{
      const h = Math.max(m.total/max*100, 4);
      return `<div style="flex:1;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;gap:4px;">
        <span style="font-size:10px;color:var(--rose-dark);font-weight:700;">${m.total>0?fmtBRL(m.total):''}</span>
        <div style="width:100%;max-width:40px;flex-shrink:0;height:${h}%;background:linear-gradient(180deg,var(--rose),var(--rose-dark));border-radius:6px 6px 2px 2px;transition:height .3s;"></div>
        <span style="font-size:10px;color:var(--rose-text);text-transform:capitalize;">${m.label}</span>
      </div>`;
    }).join('')}
  </div>`;
}

function renderChartTopProcs(finVendas){
  const el = document.getElementById('fin-chart-procs'); if(!el) return;
  const contagem = {};
  (finVendas||[]).forEach(v=>{
    (v.itens||[]).forEach(i=>{
      const nome = i.nome||'Outro';
      contagem[nome] = (contagem[nome]||0) + (i.qtd||1);
    });
  });
  const top = Object.entries(contagem).sort((a,b)=>b[1]-a[1]).slice(0,5);
  if(!top.length){ el.innerHTML='<div style="color:var(--rose-text);font-size:13px;">Sem dados no período.</div>'; return; }
  const maxVal = top[0][1];
  const cores = ['#d4735a','#e8956e','#f0b88a','#c9a87c','#b5978a'];
  el.innerHTML = top.map(([nome, qtd], i)=>{
    const pct = Math.max(qtd/maxVal*100, 8);
    return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
      <span style="font-size:11px;color:var(--rose-dark);min-width:100px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(nome)}">${escapeHtml(nome)}</span>
      <div style="flex:1;background:var(--rose-light);border-radius:4px;height:18px;overflow:hidden;">
        <div style="width:${pct}%;height:100%;background:${cores[i]||cores[0]};border-radius:4px;transition:width .3s;"></div>
      </div>
      <span style="font-size:11px;font-weight:700;color:var(--rose-dark);min-width:28px;text-align:right;">${qtd}x</span>
    </div>`;
  }).join('');
}

// ── PROCEDIMENTOS ──
let editProcId = null;
function openAddProc(){
  editProcId = null;
  mpPrecoEditadoManualmente = false;
  document.getElementById('modal-proc-title').textContent = 'Novo procedimento';
  ['mp-nome','mp-grupo','mp-tempo','mp-insumos','mp-laboratorio','mp-margem','mp-preco'].forEach(id=>{
    const el=document.getElementById(id); if(el) el.value='';
  });
  // Popula datalist de grupos
  const dl = document.getElementById('grupos-list');
  if(dl) dl.innerHTML = [...new Set(procs.map(p=>p.grupo).filter(Boolean))].sort().map(g=>`<option value="${g}">`).join('');
  const mp = document.getElementById('mp-margem'); if(mp) mp.value = cfg.margem||100;
  calcProcPreview(true);
  openModal('modal-proc');
}
function openEditProc(id){
  const p = procs.find(x=>x.id===id); if(!p) return;
  editProcId = id;
  mpPrecoEditadoManualmente = false;
  document.getElementById('modal-proc-title').textContent = 'Editar procedimento';
  document.getElementById('mp-nome').value      = p.nome;
  document.getElementById('mp-grupo').value     = p.grupo||'';
  document.getElementById('mp-tempo').value     = p.tempo||0;
  // Se insumos==0 mas existe receita cadastrada, calcula o custo real dos materiais
  let _insumosVal = p.insumos||0;
  if(!_insumosVal && procInsumos[id]?.length){
    _insumosVal = parseFloat(
      procInsumos[id].reduce((acc,item)=>{
        const m=mats.find(x=>x.id===item.matId);
        return acc+(m?m.custo*item.qtd:0);
      },0).toFixed(2)
    );
  }
  document.getElementById('mp-insumos').value   = _insumosVal;
  document.getElementById('mp-laboratorio').value = p.laboratorio||0;
  document.getElementById('mp-margem').value    = p.margem || cfg.margem || 100;
  document.getElementById('mp-preco').value     = p.precoFinal||0;
  if(p._precoManual) mpPrecoEditadoManualmente = true;
  calcProcPreview(!p._precoManual);
  openModal('modal-proc');
}
let mpPrecoEditadoManualmente = false;
function calcProcPreview(forcarAutoPreco){
  const tempo = Number(document.getElementById('mp-tempo')?.value)||0;
  const insumos = Number(document.getElementById('mp-insumos')?.value)||0;
  const lab   = Number(document.getElementById('mp-laboratorio')?.value)||0;
  const margem= Number(document.getElementById('mp-margem')?.value)||100;
  const hora  = calcHora();
  const hc    = parseFloat(((tempo/60)*hora).toFixed(2));
  const custo = parseFloat((insumos+hc+lab).toFixed(2));
  const lucro = parseFloat((custo*margem/100).toFixed(2));
  const preco = parseFloat((custo+lucro).toFixed(2));
  const set = (id,v) => { const el=document.getElementById(id); if(el) el.textContent=v; };
  set('mp-horaClin-calc', fmtBRL(hc));
  set('mp-custo-calc',    fmtBRL(custo));
  set('mp-lucro-calc',    fmtBRL(lucro));
  set('mp-preco-calc',    fmtBRL(preco));
  const pp = document.getElementById('mp-preco');
  // Só preenche automaticamente o preço final se o usuário ainda não tiver
  // sobrescrito manualmente esse campo (ou se for um recálculo forçado).
  if(pp && (forcarAutoPreco || !mpPrecoEditadoManualmente)){
    pp.value = preco.toFixed(2);
  }
}
function mpMarcarPrecoManual(){
  mpPrecoEditadoManualmente = true;
  const precoInput = parseFloat(document.getElementById('mp-preco')?.value)||0;
  if(precoInput <= 0) return;
  const tempo  = Number(document.getElementById('mp-tempo')?.value)||0;
  const insumos= Number(document.getElementById('mp-insumos')?.value)||0;
  const lab    = Number(document.getElementById('mp-laboratorio')?.value)||0;
  const hora   = calcHora();
  const hc     = parseFloat(((tempo/60)*hora).toFixed(2));
  const custo  = parseFloat((insumos+hc+lab).toFixed(2));
  if(custo <= 0) return;
  const desperd = Number(cfg.desperd||0);
  const custoComDesp = custo * (1 + desperd/100);
  const novaMargemPct = ((precoInput / custoComDesp) - 1) * 100;
  const margemEl = document.getElementById('mp-margem');
  if(margemEl) margemEl.value = Math.max(0, novaMargemPct).toFixed(1);
  const lucro = precoInput - custo;
  const set = (id,v) => { const el=document.getElementById(id); if(el) el.textContent=v; };
  set('mp-horaClin-calc', fmtBRL(hc));
  set('mp-custo-calc',    fmtBRL(custo));
  set('mp-lucro-calc',    fmtBRL(Math.max(0,lucro)));
  set('mp-preco-calc',    fmtBRL(precoInput));
}
function mpUsarPrecoCalculado(){
  mpPrecoEditadoManualmente = false;
  calcProcPreview(true);
  showToast('Preço final recalculado pela margem.');
}
async function saveProc(){
  const nome = document.getElementById('mp-nome')?.value.trim();
  if(!nome){ showToast('Informe o nome do procedimento.','warn'); return; }
  const hora   = calcHora();
  const tempo  = Number(document.getElementById('mp-tempo')?.value)||0;
  const insumos= Number(document.getElementById('mp-insumos')?.value)||0;
  const lab    = Number(document.getElementById('mp-laboratorio')?.value)||0;
  const margem = Number(document.getElementById('mp-margem')?.value)||100;
  const hc     = parseFloat(((tempo/60)*hora).toFixed(2));
  const precoCalc = calcPrecoFinal({tempo,insumos,laboratorio:lab,margem});
  let preco = precoCalc;
  let _precoManual = false;
  if(mpPrecoEditadoManualmente){
    const precoInput = parseFloat(document.getElementById('mp-preco')?.value)||0;
    if(Math.abs(precoInput - precoCalc) > 0.01){
      preco = precoInput;
      _precoManual = true;
    }
  }
  const _margemManual = _precoManual || Math.abs(margem - (cfg.margem||100)) > 0.01;
  const obj    = { nome, grupo:document.getElementById('mp-grupo')?.value||'Geral', tempo, insumos, laboratorio:lab, margem, horaClin:hc, precoFinal:preco, _precoManual, _margemManual };
  if(editProcId){
    const i = procs.findIndex(x=>x.id===editProcId);
    if(i<0){ showToast('Procedimento não encontrado.','error'); return; }
    procs[i] = { ...procs[i], ...obj };
    if(!procs[i]._precoManual){
      const pm = calcPrecoManut(editProcId, true);
      if(pm !== null) procs[i].precoFinal = pm;
    }
  } else {
    procs.push({ id: nextProcId++, ...obj });
  }
  showLoading(true);
  const _eProc=await saveFinanceiro();
  showLoading(false);
  closeModal('modal-proc');
  renderProcs();
  if(!_eProc){ logAtividade('Procedimento salvo', nome); showToast('Procedimento salvo!'); }
}
async function deleteProc(id){
  const _pDel = procs.find(x=>x.id===id);
  const _nomeDel = _pDel?.nome||'este procedimento';
  if(!confirm('Arquivar "'+_nomeDel+'"?\n\nO procedimento será desativado e escondido da lista, mas preservado nos registros históricos.')) return;
  if(_pDel) _pDel.ativo = false;
  showLoading(true);
  const _eDel=await saveFinanceiro();
  showLoading(false);
  logAtividade('Procedimento arquivado', _nomeDel);
  renderProcs();
  if(!_eDel) showToast('Procedimento arquivado.');
}
async function recalcularProc(id){
  const p = procs.find(x=>x.id===id); if(!p) return;
  cfg.salario  = Number(document.getElementById('cfg-salario')?.value)||cfg.salario||0;
  cfg.horas    = Number(document.getElementById('cfg-horas')?.value)||cfg.horas||132;
  cfg.trib     = Number(document.getElementById('cfg-trib')?.value)||cfg.trib||0;
  cfg.desperd  = Number(document.getElementById('cfg-desperd')?.value)||cfg.desperd||0;
  cfg.margem   = Number(document.getElementById('cfg-margem')?.value)||cfg.margem||100;
  cfg.pct_manut = Number(document.getElementById('cfg-pct-manut')?.value)||cfg.pct_manut||15;
  const ins = procInsumos[p.id]||[];
  if(ins.length){
    p.insumos = parseFloat(ins.reduce((acc,item)=>{const m=mats.find(x=>x.id===item.matId);return acc+(m?m.custo*item.qtd:0);},0).toFixed(2));
  }
  p.horaClin = parseFloat(((p.tempo/60)*calcHora()).toFixed(2));
  p._precoManual = false;
  const antes = p.precoFinal;
  const pm = calcPrecoManut(p.id, true);
  p.precoFinal = pm !== null ? pm : calcPrecoFinal(p);
  showLoading(true);
  const _eRC=await saveFinanceiro();
  showLoading(false);
  if(_eRC){ showToast('Erro ao recalcular: '+_eRC.message,'error'); return; }
  renderProcs();
  const info = pm !== null
    ? `custo ${fmtBRL(custoProc(p))} + ${cfg.pct_manut}% da instalação ${fmtBRL(procs.find(x=>x.id===_MANUT_TO_INST[p.id])?.precoFinal||0)}`
    : `margem ${p.margem}%, custo ${fmtBRL(custoProc(p))}`;
  showToast(`${p.nome}: ${fmtBRL(antes)} → ${fmtBRL(p.precoFinal)} (${info})`);
}
async function toggleAtivoProc(id){
  const p = procs.find(x=>x.id===id); if(!p) return;
  p.ativo = p.ativo===false ? true : false;
  showLoading(true);
  const _eT=await saveFinanceiro();
  showLoading(false);
  renderProcs();
  if(!_eT) showToast(p.ativo!==false ? 'Procedimento ativado!' : 'Procedimento desativado. Não aparecerá na venda rápida.');
}
function exportarTabelaPrecos(){
  const ativos = procs.filter(p=>p.ativo!==false);
  const grupos = [...new Set(ativos.map(p=>p.grupo||'Geral'))].sort();
  const clinica = clinicaData?.nome_cli || 'Clínica';
  const data = new Date().toLocaleDateString('pt-BR');
  let rows = '';
  grupos.forEach(g=>{
    rows += `<tr><td colspan="3" style="background:#f5ddd5;font-weight:700;color:#7a3020;padding:8px 12px;font-size:13px;">${escapeHtml(g)}</td></tr>`;
    ativos.filter(p=>(p.grupo||'Geral')===g).forEach(p=>{
      rows += `<tr><td style="padding:7px 12px;border-bottom:1px solid #eee;font-size:13px;">${escapeHtml(p.nome)}</td><td style="padding:7px 12px;border-bottom:1px solid #eee;font-size:12px;color:#888;text-align:center;">${p.tempo||0} min</td><td style="padding:7px 12px;border-bottom:1px solid #eee;text-align:right;font-weight:700;font-size:13px;color:#7a3020;">R$ ${(p.precoFinal||0).toFixed(2).replace('.',',')}</td></tr>`;
    });
  });
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Tabela de Preços - ${escapeHtml(clinica)}</title>
<style>*{margin:0;padding:0;box-sizing:border-box;}body{font-family:'Segoe UI',Arial,sans-serif;padding:30px;color:#3a2020;}
.header{text-align:center;margin-bottom:24px;padding-bottom:16px;border-bottom:2px solid #d4735a;}
.header h1{font-size:20px;color:#7a3020;}.header p{font-size:12px;color:#a05040;margin-top:4px;}
table{width:100%;border-collapse:collapse;margin-top:10px;}
.footer{text-align:center;margin-top:24px;font-size:11px;color:#b08070;border-top:1px solid #f0cfc4;padding-top:12px;}
@media print{body{padding:15px;}}</style></head><body>
<div class="header"><h1>${escapeHtml(clinica)}</h1><p>Tabela de Procedimentos e Valores — ${data}</p></div>
<table><thead><tr style="background:#7a3020;color:#fff;"><th style="padding:8px 12px;text-align:left;font-size:12px;">Procedimento</th><th style="padding:8px 12px;text-align:center;font-size:12px;">Tempo</th><th style="padding:8px 12px;text-align:right;font-size:12px;">Valor</th></tr></thead><tbody>${rows}</tbody></table>
<div class="footer">${escapeHtml(clinica)} · ${data} · ${ativos.length} procedimentos</div>
<`+`script>window.onload=()=>{window.print();}<`+`/script></body></html>`;
  const w = window.open('','_blank');
  if(w){ w.document.write(html); w.document.close(); }
  else { showToast('Permita pop-ups para gerar o PDF.','warn'); }
}
async function duplicarProc(id){
  const orig = procs.find(x=>x.id===id); if(!orig) return;
  const novoId = nextProcId++;
  const copia = { ...JSON.parse(JSON.stringify(orig)), id: novoId, nome: orig.nome + ' (Cópia)' };
  procs.push(copia);
  if(procInsumos[id]?.length){
    procInsumos[novoId] = JSON.parse(JSON.stringify(procInsumos[id]));
  }
  showLoading(true);
  const _eD=await saveFinanceiro();
  showLoading(false);
  renderProcs();
  if(!_eD) showToast('Procedimento duplicado!');
}
function filterProcs(){ renderProcs(); }
function renderProcs(){
  const q     = (document.getElementById('proc-search')||{value:''}).value.toLowerCase();
  const grupo = (document.getElementById('proc-grupo')||{value:''}).value;
  const ordem = (document.getElementById('proc-ordem')||{value:'custom'}).value;
  // Popula select de grupos
  const gsel = document.getElementById('proc-grupo');
  if(gsel){
    const cur = gsel.value;
    const gs  = [...new Set(procs.map(p=>p.grupo).filter(Boolean))].sort();
    gsel.innerHTML = '<option value="">Todos os grupos</option>' + gs.map(g=>`<option value="${escapeHtml(g)}"${g===cur?' selected':''}>${escapeHtml(g)}</option>`).join('');
  }
  const mostrarInativos = document.getElementById('proc-mostrar-inativos')?.checked;
  let list = procs.filter(p=>(!q||_norm(p.nome).includes(_norm(q)))&&(!grupo||p.grupo===grupo)&&(mostrarInativos||p.ativo!==false));
  const soRecolagem = document.getElementById('proc-so-recolagem')?.checked;
  if(soRecolagem) list = list.filter(p=>PROC_IDS_RECOLAGEM.has(p.id)||/recolagem/i.test(p.nome));
  if(ordem==='az') list=[...list].sort((a,b)=>a.nome.localeCompare(b.nome,'pt-BR'));
  else if(ordem==='preco_asc') list=[...list].sort((a,b)=>(a.precoFinal||0)-(b.precoFinal||0));
  else if(ordem==='preco_desc') list=[...list].sort((a,b)=>(b.precoFinal||0)-(a.precoFinal||0));
  const tb = document.getElementById('proc-tbody');
  if(!tb) return;
  if(!list.length){ tb.innerHTML='<tr><td colspan="9" style="text-align:center;color:var(--rose-text);padding:20px;">Nenhum procedimento encontrado.</td></tr>'; return; }
  tb.innerHTML = list.map(p=>{
    // Calcula insumos na hora (não depende de p.insumos salvo, que pode estar desatualizado)
    const _ins = procInsumos[p.id]||[];
    const _insValReal = _ins.length
      ? parseFloat(_ins.reduce((acc,item)=>{ const m=mats.find(x=>x.id===item.matId); return acc+(m?m.custo*item.qtd:0); },0).toFixed(2))
      : (p.insumos||0);
    const _hc = parseFloat(((p.tempo||0)/60*calcHora()).toFixed(2));
    const _custo = parseFloat((_insValReal + _hc + (p.laboratorio||0)).toFixed(2));
    // Badge de tipo de cobrança
    const _global = (p.tipo_cobranca==='global') || PROCS_GLOBAL_KEYWORDS.some(k=>(p.nome||'').toLowerCase().includes(k));
    const _tipoBadge = _global
      ? '<span style="font-size:9px;background:#e8f5e9;color:#2e7d32;border-radius:4px;padding:1px 5px;font-weight:600;">🌍 Global</span>'
      : '<span style="font-size:9px;background:#e3f2fd;color:#1565c0;border-radius:4px;padding:1px 5px;font-weight:600;">🦷 Dente</span>';
    const _recolagBadge = PROC_IDS_RECOLAGEM.has(p.id)||/recolagem/i.test(p.nome)
      ? '<span class="fin-badge ok" style="font-size:9px;">RECOLAGEM</span>' : '';
    const _IDS_MANUT_BADGE = new Set([208,209,210,211,212,213,214,38]);
    const _manutBadge = _IDS_MANUT_BADGE.has(p.id)
      ? `<span style="font-size:9px;background:#e8f5e9;color:#1b5e20;border-radius:4px;padding:1px 5px;font-weight:600;">🔗 ${cfg.pct_manut||15}% instalação</span>` : '';
    // Contagem de insumos no botão flask
    const _insCount = _ins.length;
    const _flaskColor = _insCount>0 ? 'color:#2e7d32;border-color:#a5d6a7;' : '';
    const _flaskBadge = _insCount>0
      ? `<span style="position:absolute;top:-5px;right:-5px;background:#2e7d32;color:#fff;border-radius:50%;width:14px;height:14px;font-size:9px;display:flex;align-items:center;justify-content:center;font-weight:700;line-height:1;">${_insCount}</span>`
      : '';
    const _inativo = p.ativo===false;
    return `<tr style="border-bottom:1px solid var(--rose-light);${_inativo?'opacity:.5;':''}">
      <td data-label="Procedimento" style="padding:10px 8px;"><div style="font-weight:500;">${escapeHtml(p.nome)}${_inativo?' <span style="font-size:9px;background:#eee;color:#999;border-radius:4px;padding:1px 6px;font-weight:600;">INATIVO</span>':''}</div><div style="margin-top:3px;display:flex;gap:4px;flex-wrap:wrap;">${_recolagBadge}${_tipoBadge}${_manutBadge}</div></td>
      <td data-label="Grupo" style="padding:10px 8px;"><span style="background:var(--rose-lighter);color:var(--rose-dark);border-radius:6px;padding:2px 8px;font-size:11px;">${escapeHtml(p.grupo||'—')}</span></td>
      <td data-label="Tempo" style="padding:10px 8px;text-align:right;">${p.tempo||0} min</td>
      <td data-label="Insumos" style="padding:10px 8px;text-align:right;">${fmtBRL(_insValReal)}</td>
      <td data-label="Hora Clínica" style="padding:10px 8px;text-align:right;">${fmtBRL(_hc)}</td>
      <td data-label="Custo Total" style="padding:10px 8px;text-align:right;">${fmtBRL(_custo)}</td>
      <td data-label="Margem %" style="padding:10px 8px;text-align:right;">${p.margem||cfg.margem||100}%</td>
      <td data-label="Preço Final" style="padding:10px 8px;text-align:right;">
        <div style="font-weight:700;color:var(--rose-dark);">${fmtBRL(p.precoFinal||0)}</div>
        ${p._precoManual
          ? '<span style="font-size:9px;background:#fff3cd;color:#8a6d00;border-radius:4px;padding:1px 5px;font-weight:600;white-space:nowrap;" title="Preço ajustado manualmente — não muda com recálculo automático de custos, só se você mesmo editar ou marcar &quot;Recalcular preços de todos os procedimentos&quot; em Configurações → Precificação.">🔒 Manual</span>'
          : '<span style="font-size:9px;color:#8a9a8a;font-weight:600;" title="Segue a fórmula automática (hora clínica × margem)">⚙️ Fórmula</span>'}
      </td>
      <td data-label="Ações" style="padding:10px 6px 10px 8px;">
        <div style="display:flex;gap:4px;justify-content:flex-end;align-items:center;">
          <button class="btn-secondary" style="padding:4px 7px;font-size:11px;position:relative;${_flaskColor}" onclick="openInsumos(${p.id})" title="${_insCount>0?_insCount+' insumo(s) configurado(s)':'Adicionar insumos'}">${_flaskBadge}<i class="ti ti-flask"></i></button>
          <button class="btn-secondary" style="padding:4px 7px;font-size:11px;" onclick="openEditProc(${p.id})" title="Editar"><i class="ti ti-pencil"></i></button>
          <button class="btn-danger" style="padding:4px 7px;font-size:11px;" onclick="deleteProc(${p.id})" title="Excluir"><i class="ti ti-trash"></i></button>
          <button class="btn-secondary" style="padding:4px 7px;font-size:11px;" onclick="toggleProcRowMenu(${p.id},this)" title="Mais ações"><i class="ti ti-dots-vertical"></i></button>
        </div>
      </td>
    </tr>`;
  }).join('');
}

// Menu "⋮" da linha de Procedimentos (Recalcular/Ativar-Desativar/Duplicar).
// Fica fora do wrapper com scroll horizontal da tabela (position:fixed,
// posicionado via getBoundingClientRect do botão) pra nunca ficar cortado.
function toggleProcRowMenu(id, btnEl){
  const menu = document.getElementById('proc-row-menu');
  if(menu.dataset.forId === String(id) && menu.style.display==='block'){
    closeProcRowMenu();
    return;
  }
  const p = procs.find(x=>x.id===id);
  if(!p) return;
  const inativo = p.ativo===false;
  document.getElementById('prm-recalc').onclick = () => { recalcularProc(id); closeProcRowMenu(); };
  document.getElementById('prm-toggle').onclick = () => { toggleAtivoProc(id); closeProcRowMenu(); };
  document.getElementById('prm-toggle').querySelector('i').className = 'ti ti-' + (inativo?'player-play':'player-pause');
  document.getElementById('prm-toggle-label').textContent = inativo?'Ativar':'Desativar';
  document.getElementById('prm-dup').onclick = () => { duplicarProc(id); closeProcRowMenu(); };

  const r = btnEl.getBoundingClientRect();
  menu.style.display = 'block';
  menu.dataset.forId = String(id);
  const menuWidth = menu.offsetWidth || 200;
  menu.style.left = Math.max(8, r.right - menuWidth) + 'px';
  menu.style.top = (r.bottom + 6) + 'px';
}
function closeProcRowMenu(){
  const menu = document.getElementById('proc-row-menu');
  menu.style.display = 'none';
  delete menu.dataset.forId;
}
document.addEventListener('click', e=>{
  if(!e.target.closest('#proc-row-menu') && !e.target.closest('[onclick*="toggleProcRowMenu"]')) closeProcRowMenu();
});
document.addEventListener('scroll', ()=>closeProcRowMenu(), true);

// ── MATERIAIS ──
let editMatId = null;
let activeCat = '';
// Ajusta o step (e arredonda o valor já digitado) dos campos de
// quantidade do material conforme a unidade escolhida em mm-unid —
// unidades inteiras (unid, kit, seringa...) não aceitam casa decimal.
function mmAtualizarPassos(){
  const unid = document.getElementById('mm-unid')?.value||'';
  const passo = passoQtd(unid);
  ['mm-qtde','mm-est-atual','mm-est-min','mm-est-compra'].forEach(id=>{
    const el = document.getElementById(id); if(!el) return;
    el.step = passo;
    if(el.value!=='') el.value = arredondarQtd(el.value, unid);
  });
}
function openAddMat(){
  editMatId = null;
  document.getElementById('modal-mat-title').textContent = 'Novo material';
  ['mm-nome','mm-cat','mm-unid','mm-qtde','mm-preco','mm-est-atual','mm-est-min','mm-est-compra'].forEach(id=>{
    const el=document.getElementById(id); if(el) el.value='';
  });
  document.getElementById('mm-custo-calc').textContent = '—';
  updateCatsList();
  mmAtualizarPassos();
  openModal('modal-mat');
}
function openEditMat(id){
  const m = mats.find(x=>x.id===id); if(!m) return;
  editMatId = id;
  document.getElementById('modal-mat-title').textContent = 'Editar material';
  document.getElementById('mm-nome').value  = m.nome;
  document.getElementById('mm-cat').value   = m.cat||'';
  document.getElementById('mm-unid').value  = m.unid||'';
  document.getElementById('mm-qtde').value  = m.qtde||1;
  document.getElementById('mm-preco').value = m.preco||0;
  const e = estoque[id]||{};
  document.getElementById('mm-est-atual').value   = e.atual??'';
  document.getElementById('mm-est-min').value     = e.min??'';
  document.getElementById('mm-est-compra').value  = e.compra??'';
  updateCatsList();
  calcMatCusto();
  mmAtualizarPassos();
  openModal('modal-mat');
}
function updateCatsList(){
  const dl = document.getElementById('cats-list');
  if(dl) dl.innerHTML = [...new Set(mats.map(m=>m.cat).filter(Boolean))].sort().map(c=>`<option value="${c}">`).join('');
}
function calcMatCusto(){
  const qtde  = Number(document.getElementById('mm-qtde')?.value)||1;
  const preco = Number(document.getElementById('mm-preco')?.value)||0;
  const el = document.getElementById('mm-custo-calc');
  if(el) el.textContent = qtde&&preco ? 'R$ '+fmtN2(preco/qtde) : '—';
}
async function saveMat(){
  const nome = document.getElementById('mm-nome')?.value.trim();
  if(!nome){ showToast('Informe o nome do material.','warn'); return; }
  const unid  = document.getElementById('mm-unid')?.value||'unid';
  const qtde  = arredondarQtd(document.getElementById('mm-qtde')?.value||1, unid) || 1;
  const preco = Number(document.getElementById('mm-preco')?.value)||0;
  const custo = parseFloat((preco/qtde).toFixed(4));
  const obj   = { nome, cat:document.getElementById('mm-cat')?.value||'Geral', unid, qtde, preco, custo };
  let matId;
  if(editMatId){
    matId = editMatId;
    const i = mats.findIndex(x=>x.id===editMatId);
    if(i<0){ showToast('Material não encontrado.','error'); return; }
    mats[i] = { ...mats[i], ...obj };
  } else {
    matId = nextMatId++;
    mats.push({ id:matId, ...obj });
  }
  const ea = document.getElementById('mm-est-atual')?.value;
  const em = document.getElementById('mm-est-min')?.value;
  const ec = document.getElementById('mm-est-compra')?.value;
  if(ea!==''||em!==''||ec!==''||estoque[matId]){
    estoque[matId] = { atual:arredondarQtd(ea,unid), min:arredondarQtd(em,unid), compra:arredondarQtd(ec,unid) };
  }
  showLoading(true);
  const _eM=await saveFinanceiro();
  showLoading(false);
  closeModal('modal-mat');
  renderMats(); renderEstoque();
  recalcularInsumos(true);
  renderProcs();
  if(!_eM) showToast('Material salvo! Custos atualizados.');
}
async function deleteMat(id){
  if(!confirm('Arquivar este material?\n\nEle será escondido das listas mas poderá ser restaurado depois.')) return;
  const m = mats.find(x=>x.id===id);
  if(m) m.arquivado = true;
  showLoading(true);
  const _eMD=await saveFinanceiro();
  showLoading(false);
  logAtividade('Material arquivado', m?.nome||id);
  renderMats(); renderEstoque();
  if(!_eMD) showToast('Material arquivado.');
}
function restaurarMat(id){
  const m = mats.find(x=>x.id===id);
  if(m) m.arquivado = false;
  logAtividade('Material restaurado', m?.nome||id);
  saveFinanceiro();
  renderMats(); renderEstoque();
  showToast('Material restaurado!');
}
function filterMats(){ renderMats(); }
function setCat(c){ activeCat=c; renderMats(); }
function renderMats(){
  const q     = (document.getElementById('mat-search')||{value:''}).value.toLowerCase();
  const ordem = (document.getElementById('mat-ordem')||{value:'az'}).value;
  const catF  = (document.getElementById('mat-cat-filter')||{value:''}).value;
  // Atualiza filter de categorias
  const cats = [...new Set(mats.map(m=>m.cat).filter(Boolean))].sort();
  const cfEl = document.getElementById('cat-filter');
  if(cfEl) cfEl.innerHTML = '<button class="btn-secondary'+(activeCat===''?' active':'')+'" style="font-size:11px;padding:4px 10px;border-radius:20px;" onclick="setCat(\'\')">Todas</button>'+
    cats.map(c=>`<button class="btn-secondary${activeCat===c?' active':''}" style="font-size:11px;padding:4px 10px;border-radius:20px;" onclick="setCat('${escapeHtml(c).replace(/'/g,'&#39;')}')">${escapeHtml(c)}</button>`).join('');
  const matCatSel = document.getElementById('mat-cat-filter');
  if(matCatSel){
    const cur=matCatSel.value;
    matCatSel.innerHTML='<option value="">Todas as categorias</option>'+cats.map(c=>`<option value="${c}"${c===cur?' selected':''}>${c}</option>`).join('');
  }
  let list = mats.filter(m=>!m.arquivado&&(!activeCat||m.cat===activeCat)&&(!catF||m.cat===catF)&&(!q||_norm(m.nome).includes(_norm(q))));
  if(ordem==='az') list=[...list].sort((a,b)=>a.nome.localeCompare(b.nome,'pt-BR'));
  else if(ordem==='za') list=[...list].sort((a,b)=>b.nome.localeCompare(a.nome,'pt-BR'));
  else if(ordem==='cat') list=[...list].sort((a,b)=>(a.cat||'').localeCompare(b.cat||'','pt-BR')||a.nome.localeCompare(b.nome,'pt-BR'));
  else if(ordem==='custo_asc') list=[...list].sort((a,b)=>(a.custo||0)-(b.custo||0));
  else if(ordem==='custo_desc') list=[...list].sort((a,b)=>(b.custo||0)-(a.custo||0));
  const tb = document.getElementById('mat-tbody');
  if(!tb) return;
  if(!list.length){ tb.innerHTML='<tr><td colspan="7" style="text-align:center;color:var(--rose-text);padding:20px;">Nenhum material cadastrado.</td></tr>'; return; }
  tb.innerHTML = list.map(m=>`<tr style="border-bottom:1px solid var(--rose-light);">
    <td data-label="Material" style="padding:10px;font-weight:500;">${escapeHtml(m.nome)}</td>
    <td data-label="Categoria" style="padding:10px;"><span style="background:var(--rose-lighter);color:var(--rose-dark);border-radius:6px;padding:2px 8px;font-size:11px;">${escapeHtml(m.cat||'—')}</span></td>
    <td data-label="Unidade" style="padding:10px;text-align:right;">${escapeHtml(m.unid||'—')}</td>
    <td data-label="Qtde/Emb." style="padding:10px;text-align:right;">${fmtN2(m.qtde||0)}</td>
    <td data-label="Preço Emb." style="padding:10px;text-align:right;">${fmtBRL(m.preco||0)}</td>
    <td data-label="Custo Unit." style="padding:10px;text-align:right;font-weight:700;color:var(--rose-dark);">${m.preco&&m.qtde?fmtN2(m.preco/m.qtde):'—'}</td>
    <td data-label="Ações" style="padding:10px;">
      <div style="display:flex;gap:6px;justify-content:flex-end;">
        <button class="btn-secondary" style="padding:4px 8px;font-size:11px;" onclick="openEditMat(${m.id})"><i class="ti ti-pencil"></i></button>
        <button class="btn-danger" style="padding:4px 8px;font-size:11px;" onclick="deleteMat(${m.id})"><i class="ti ti-trash"></i></button>
      </div>
    </td>
  </tr>`).join('');
}

// ── ESTOQUE ──
function getEstStatus(matId){
  const e = estoque[matId]||{};
  const a = e.atual||0, mn=e.min||0, cp=e.compra||0;
  if(mn>0&&a<=mn) return 'danger';
  if(cp>0&&a<=cp) return 'warn';
  if(a>0) return 'ok';
  return '';
}
function toggleEstSel(id, checked){ if(checked) estSelected.add(id); else estSelected.delete(id); updateEstDelBtn(); }
function updateEstDelBtn(){
  const btn = document.getElementById('btn-del-est');
  if(btn) btn.style.display = estSelected.size > 0 ? '' : 'none';
}
async function deleteEstSelecionados(){
  if(!confirm(`Arquivar ${estSelected.size} material(is)?\n\nEles serão escondidos das listas mas poderão ser restaurados depois.`)) return;
  const nomes = [];
  estSelected.forEach(id=>{ const m=mats.find(x=>x.id===id); if(m){ m.arquivado=true; nomes.push(m.nome); } });
  estSelected.clear();
  showLoading(true); const _eDelEst=await saveFinanceiro(); showLoading(false);
  if(_eDelEst){ showToast('Erro ao arquivar materiais: '+_eDelEst.message,'error'); return; }
  logAtividade('Material arquivado', nomes.join(', '));
  renderMats(); renderEstoque(); updateEstDelBtn();
  showToast('Materiais arquivados.');
}
function openEstEdit(id){
  const m = mats.find(x=>x.id===id); if(!m) return;
  const e = estoque[id]||{};
  document.getElementById('me-nome-label').textContent = m.nome;
  document.getElementById('me-atual').value  = e.atual??0;
  document.getElementById('me-min').value    = e.min??0;
  document.getElementById('me-compra').value = e.compra??0;
  document.getElementById('me-unid').value   = m.unid||'';
  const calcBox = document.getElementById('calc-pacotes-box');
  if(calcBox) calcBox.style.display = 'none'; // não carrega aberto/com dados do material anterior
  openModal('modal-est');
  // guarda id para o save
  document.getElementById('modal-est').dataset.matId = id;
}
async function saveEst(){
  const id = Number(document.getElementById('modal-est').dataset.matId);
  const m = mats.find(x=>x.id===id); if(!m) return;
  const unid = document.getElementById('me-unid')?.value || m.unid;
  estoque[id] = {
    atual  : Number(document.getElementById('me-atual')?.value)||0,
    min    : Number(document.getElementById('me-min')?.value)||0,
    compra : Number(document.getElementById('me-compra')?.value)||0,
  };
  const i = mats.findIndex(x=>x.id===id);
  if(i>=0) mats[i].unid = unid;
  showLoading(true); const _eSvEst=await saveFinanceiro(); showLoading(false);
  closeModal('modal-est');
  renderEstoque(); renderMats();
  if(!_eSvEst) showToast('Estoque atualizado!');
  else showToast('Erro ao salvar estoque: '+_eSvEst.message,'error');
}

// Calculadora "pacotes fechados + soltas" dentro do modal de estoque — pra
// quem compra em caixa/pacote (ex: caixa de máscara com 100, kit de
// clareador com 6 seringas) poder digitar "2 caixas fechadas + 30 soltas
// da caixa aberta" em vez de fazer a conta de cabeça. Usa "Qtde por
// embalagem" já cadastrada no material como referência.
function toggleCalcPacotes(){
  const box = document.getElementById('calc-pacotes-box');
  if(!box) return;
  const abrir = box.style.display==='none';
  box.style.display = abrir?'block':'none';
  if(!abrir) return;
  const matId = Number(document.getElementById('modal-est').dataset.matId);
  const m = mats.find(x=>x.id===matId);
  const qtdePacote = m?.qtde||1;
  const refEl = document.getElementById('calc-pacotes-ref');
  const fechadosEl = document.getElementById('calc-fechados');
  if(qtdePacote<=1){
    refEl.innerHTML = '<i class="ti ti-alert-triangle"></i> Este material não tem "Qtde por embalagem" cadastrada (ou é 1). Edite o material (lápis em Materiais) e informe, por exemplo, quantas unidades vêm numa caixa — aí essa conta funciona.';
    fechadosEl.disabled = true;
  } else {
    refEl.textContent = `Cada pacote/caixa fechado tem ${qtdePacote} ${m.unid||'unid'}.`;
    fechadosEl.disabled = false;
  }
  const passo = passoQtd(m?.unid);
  fechadosEl.step = passo;
  document.getElementById('calc-soltas').step = passo;
  fechadosEl.value = 0;
  document.getElementById('calc-soltas').value = 0;
  calcPacotesAtualizar();
}
function calcPacotesAtualizar(){
  const matId = Number(document.getElementById('modal-est').dataset.matId);
  const m = mats.find(x=>x.id===matId);
  const qtdePacote = m?.qtde||1;
  const fechados = Number(document.getElementById('calc-fechados')?.value)||0;
  const soltas = Number(document.getElementById('calc-soltas')?.value)||0;
  const total = arredondarQtd(fechados*qtdePacote + soltas, m?.unid);
  const el = document.getElementById('calc-pacotes-total');
  if(el) el.textContent = `${total} ${m?.unid||''}`;
  return total;
}
function calcPacotesAplicar(){
  const total = calcPacotesAtualizar();
  document.getElementById('me-atual').value = total;
  showToast('Quantidade atual preenchida: '+total);
}

function filterEstoque(){ renderEstoque(); }
function renderEstoque(){
  const q   = (document.getElementById('est-search')||{value:''}).value.toLowerCase();
  const sf  = (document.getElementById('est-status-filter')||{value:''}).value;
  const ordemEst = (document.getElementById('est-ordem')||{value:'az'}).value;
  let list  = mats.filter(m=>!m.arquivado&&(!q||_norm(m.nome).includes(_norm(q)))&&(!sf||getEstStatus(m.id)===sf));
  if(ordemEst==='az') list=[...list].sort((a,b)=>a.nome.localeCompare(b.nome,'pt-BR'));
  else if(ordemEst==='za') list=[...list].sort((a,b)=>b.nome.localeCompare(a.nome,'pt-BR'));
  else if(ordemEst==='cat') list=[...list].sort((a,b)=>(a.cat||'').localeCompare(b.cat||'','pt-BR')||a.nome.localeCompare(b.nome,'pt-BR'));
  else if(ordemEst==='critico'){
    const ord={danger:0,warn:1,ok:2,'':3};
    list=[...list].sort((a,b)=>(ord[getEstStatus(a.id)]||3)-(ord[getEstStatus(b.id)]||3)||a.nome.localeCompare(b.nome,'pt-BR'));
  } else list=[...list].sort((a,b)=>a.nome.localeCompare(b.nome,'pt-BR'));
  const ok  = mats.filter(m=>getEstStatus(m.id)==='ok').length;
  const warn= mats.filter(m=>getEstStatus(m.id)==='warn').length;
  const dan = mats.filter(m=>getEstStatus(m.id)==='danger').length;
  const estM = document.getElementById('est-metrics');
  if(estM) estM.innerHTML = [
    {lbl:'Total materiais',val:mats.length,cor:'var(--rose-dark)'},
    {lbl:'OK',val:ok,cor:'#2e7d32'},
    {lbl:'Atenção',val:warn,cor:'#856404'},
    {lbl:'Crítico',val:dan,cor:'#dc2626'},
  ].map(s=>`<div style="background:var(--rose-lighter);border:1px solid var(--rose-light);border-radius:12px;padding:12px 16px;">
    <div style="font-size:11px;color:var(--rose-text);">${s.lbl}</div>
    <div style="font-size:20px;font-weight:800;color:${s.cor};">${s.val}</div>
  </div>`).join('');
  const tb = document.getElementById('est-tbody');
  if(!tb) return;
  if(!list.length){ tb.innerHTML='<tr><td colspan="10" style="text-align:center;color:var(--rose-text);padding:20px;">Nenhum material no estoque.</td></tr>'; return; }
  tb.innerHTML = list.map(m=>{
    const e   = estoque[m.id]||{atual:0,min:0,compra:0};
    const st  = getEstStatus(m.id);
    const pct = e.compra>0?Math.min(100,Math.round((e.atual/e.compra)*100)):null;
    const barCls = st==='danger'?'prog-danger':st==='warn'?'prog-warn':'prog-ok';
    const stLbl  = st==='danger'?'Crítico':st==='warn'?'Atenção':st==='ok'?'OK':'—';
    const stCls  = st==='danger'?'danger':st==='warn'?'warn':st==='ok'?'ok':'';
    const passo = passoQtd(m.unid);
    return `<tr style="border-bottom:1px solid var(--rose-light);">
      <td data-label="Selecionar" style="padding:10px;"><input type="checkbox" ${estSelected.has(m.id)?'checked':''} onchange="toggleEstSel(${m.id},this.checked)"/></td>
      <td data-label="Material" style="padding:10px;font-weight:500;">${escapeHtml(m.nome)}</td>
      <td data-label="Categoria" style="padding:10px;"><span style="background:var(--rose-lighter);color:var(--rose-dark);border-radius:6px;padding:2px 8px;font-size:11px;">${escapeHtml(m.cat||'—')}</span></td>
      <td data-label="Unid." style="padding:10px;text-align:right;">${escapeHtml(m.unid||'—')}</td>
      <td data-label="Atual" style="padding:10px;text-align:right;"><input class="edit-input-fin" type="number" min="0" step="${passo}" value="${e.atual||0}" onchange="updateEstField(${m.id},'atual',this.value,this)" style="width:72px;text-align:right;font-weight:700;"/></td>
      <td data-label="Mínimo" style="padding:10px;text-align:right;"><input class="edit-input-fin" type="number" min="0" step="${passo}" value="${e.min||0}" onchange="updateEstField(${m.id},'min',this.value,this)" style="width:66px;text-align:right;color:#dc2626;"/></td>
      <td data-label="Compra" style="padding:10px;text-align:right;"><input class="edit-input-fin" type="number" min="0" step="${passo}" value="${e.compra||0}" onchange="updateEstField(${m.id},'compra',this.value,this)" style="width:66px;text-align:right;color:#856404;"/></td>
      <td data-label="Nível" style="padding:10px;">${pct!==null?`<div class="prog-wrap"><div class="prog-bar ${barCls}" style="width:${pct}%;"></div></div> <span style="font-size:11px;color:var(--rose-text);">${pct}%</span>`:'<span style="font-size:11px;color:var(--rose-text);">—</span>'}</td>
      <td data-label="Status" style="padding:10px;"><span class="fin-badge ${stCls}">${stLbl}</span></td>
      <td data-label="Ações" style="padding:10px;">
        <div style="display:flex;gap:6px;justify-content:flex-end;">
          <button class="btn-secondary" style="padding:4px 8px;font-size:11px;" onclick="openEstEdit(${m.id})"><i class="ti ti-pencil"></i></button>
          <button class="btn-danger" style="padding:4px 8px;font-size:11px;" onclick="deleteMat(${m.id})"><i class="ti ti-trash"></i></button>
        </div>
      </td>
    </tr>`;
  }).join('');
}
function updateEstField(id, field, val, el){
  if(!estoque[id]) estoque[id]={atual:0,min:0,compra:0};
  const m = mats.find(x=>x.id===id);
  const arredondado = arredondarQtd(val, m?.unid);
  estoque[id][field] = arredondado;
  // Se a unidade é inteira (agulha, seringa...) e o usuário digitou/rolou
  // uma casa decimal, corrige o que aparece no campo pro valor arredondado
  // realmente salvo — evita "62,02 UNID" ficando visível na tela.
  if(el && String(arredondado) !== String(val)) el.value = arredondado;
  // NÃO chama renderEstoque() aqui — evita recriar os inputs e perder o foco
  // Atualiza só o badge de status inline sem re-renderizar toda a tabela
  _atualizarStatusEstLinha(id);
  // Autosave com debounce de 2s
  clearTimeout(window._estSaveTimer);
  window._estSaveTimer = setTimeout(async ()=>{
    const _eEst=await saveFinanceiro();
    if(!_eEst) showToast('Estoque salvo!','ok');
  }, 2000);
}
function _atualizarStatusEstLinha(id){
  // Atualiza apenas o badge de status e barra de progresso na linha do material
  const e = estoque[id]||{atual:0,min:0,compra:0};
  const st = getEstStatus(id);
  const stLbl = st==='danger'?'Crítico':st==='warn'?'Atenção':st==='ok'?'OK':'—';
  const stCls = st==='danger'?'danger':st==='warn'?'warn':st==='ok'?'ok':'';
  // Procura na tabela por linhas que contenham o botão de edição desse material
  const btns = document.querySelectorAll(`#est-tbody button[onclick="openEstEdit(${id})"]`);
  btns.forEach(btn=>{
    const tr = btn.closest('tr');
    if(!tr) return;
    const badge = tr.querySelector('.fin-badge');
    if(badge){ badge.className=`fin-badge ${stCls}`; badge.textContent=stLbl; }
    const pct = e.compra>0?Math.min(100,Math.round((e.atual/e.compra)*100)):null;
    const progWrap = tr.querySelector('.prog-wrap');
    const progBar  = tr.querySelector('.prog-bar');
    if(progBar && pct!==null){
      const barCls = st==='danger'?'prog-danger':st==='warn'?'prog-warn':'prog-ok';
      progBar.className = `prog-bar ${barCls}`;
      progBar.style.width = `${pct}%`;
    }
  });
}

// ── INSUMOS DOS PROCEDIMENTOS ──
let insumosEditProcId = null;
let insumosTemp = [];

function matBadge(m){
  if(MAT_IDS_KIT_COMPLETO.has(m.id)) return '<span class="fin-badge danger" style="font-size:9px;">KIT (20 peças)</span>';
  if(MAT_IDS_PECA_AVULSA.has(m.id))  return '<span class="fin-badge ok" style="font-size:9px;">peça avulsa</span>';
  return '';
}

function openInsumos(procId){
  const p = procs.find(x=>x.id===procId); if(!p) return;
  insumosEditProcId = procId;
  // Usa padrão se banco não tem insumos para este procedimento
  const saved = procInsumos[procId];
  const defaults = DEFAULT_PROC_INSUMOS_DATA[procId] || DEFAULT_PROC_INSUMOS_DATA[String(procId)];
  insumosTemp = JSON.parse(JSON.stringify(saved && saved.length ? saved : (defaults || [])));
  document.getElementById('mi-proc-nome').textContent = p.nome;
  const hint = document.getElementById('mi-recolagem-hint');
  const ehRecolagem = PROC_IDS_RECOLAGEM.has(procId) || /recolagem/i.test(p.nome);
  if(hint) hint.style.display = ehRecolagem ? 'block' : 'none';
  const search = document.getElementById('mi-mat-search'); if(search) search.value = '';
  const hid = document.getElementById('mi-mat-sel-id'); if(hid) hid.value = '';
  renderInsumosList();
  openModal('modal-insumos');
}

function miFiltrarMats(){
  const q = (document.getElementById('mi-mat-search')?.value||'').toLowerCase().trim();
  const ehRecolagem = PROC_IDS_RECOLAGEM.has(insumosEditProcId);
  let lista = [...mats];
  // Em procedimento de recolagem, esconde os kits completos por padrão (evita o erro
  // de somar o kit inteiro) — só aparecem se o usuário digitar "kit" explicitamente.
  if(ehRecolagem && !q.includes('kit')){
    lista = lista.filter(m=>!MAT_IDS_KIT_COMPLETO.has(m.id));
  }
  if(q) lista = lista.filter(m=>m.nome.toLowerCase().includes(q));
  lista = lista.slice(0,60); // performance
  const dd = document.getElementById('mi-mat-dropdown');
  if(!dd) return;
  if(!lista.length){
    dd.innerHTML = '<div style="padding:12px;color:var(--rose-text);text-align:center;font-size:12px;">Nenhum material encontrado</div>';
    return;
  }
  dd.innerHTML = lista.map(m=>`
    <div data-matid="${m.id}" style="padding:8px 12px;cursor:pointer;font-size:12px;border-bottom:1px solid var(--rose-light);display:flex;justify-content:space-between;align-items:center;gap:8px;">
      <span>${escapeHtml(m.nome)} ${matBadge(m)}</span>
      <span style="color:var(--rose-dark);font-weight:700;white-space:nowrap;">${fmtBRL(m.custo||0)}/${m.unid||'un'}</span>
    </div>`).join('');
  dd.querySelectorAll('[data-matid]').forEach(el=>{
    el.onmouseover=()=>{el.style.background='var(--rose-lighter)';};
    el.onmouseout=()=>{el.style.background='#fff';};
    el.onclick=()=>miSelecionarMat(parseInt(el.dataset.matid));
  });
}

function miSelecionarMat(matId){
  const m = mats.find(x=>x.id===matId); if(!m) return;
  document.getElementById('mi-mat-sel-id').value = matId;
  document.getElementById('mi-mat-search').value = m.nome;
  document.getElementById('mi-mat-dropdown').style.display = 'none';
  // Unidade inteira (agulha, seringa...) não aceita fração — ajusta o passo
  // do campo de quantidade conforme o material escolhido.
  const qtdEl = document.getElementById('mi-qtd-add');
  if(qtdEl){
    const inteira = unidEhInteira(m.unid);
    qtdEl.step = inteira ? '1' : '0.001';
    qtdEl.min  = inteira ? '1' : '0.001';
    if(qtdEl.value!=='') qtdEl.value = arredondarQtd(qtdEl.value, m.unid) || (inteira?1:0.001);
  }
}

function addInsumoRow(){
  const matId = Number(document.getElementById('mi-mat-sel-id')?.value);
  if(!matId){ showToast('Busque e selecione um material na lista antes de adicionar.','warn'); return; }
  const m = mats.find(x=>x.id===matId);
  const qtd = arredondarQtd(document.getElementById('mi-qtd-add')?.value||1, m?.unid) || 1;
  // Aviso extra de segurança: tentando usar kit completo num procedimento de recolagem
  if(PROC_IDS_RECOLAGEM.has(insumosEditProcId) && m && MAT_IDS_KIT_COMPLETO.has(m.id)){
    if(!confirm('"'+m.nome+'" é o KIT COMPLETO (20 peças), não a peça avulsa. Isso vai cobrar o paciente pelo aparelho inteiro de novo. Tem certeza que quer usar este material aqui?')) return;
  }
  const ex = insumosTemp.findIndex(x=>x.matId===matId);
  if(ex>=0) insumosTemp[ex].qtd = parseFloat((insumosTemp[ex].qtd+qtd).toFixed(4));
  else insumosTemp.push({matId,qtd});
  // Limpa a busca para o próximo insumo
  document.getElementById('mi-mat-search').value='';
  document.getElementById('mi-mat-sel-id').value='';
  renderInsumosList();
}
function renderInsumosList(){
  const ul = document.getElementById('mi-list'); if(!ul) return;
  if(!insumosTemp.length){ ul.innerHTML='<li style="color:var(--rose-text);padding:.5rem 0;font-size:13px;">Nenhum insumo adicionado</li>'; document.getElementById('mi-total-custo').textContent='R$ 0,00'; return; }
  let total=0;
  ul.innerHTML = insumosTemp.map((item,idx)=>{
    const m = mats.find(x=>x.id===item.matId); if(!m) return '';
    const custo=m.custo*item.qtd; total+=custo;
    const e=estoque[m.id]||{atual:0};
    const tagCls=e.atual<item.qtd?'danger':'ok';
    return `<li style="display:grid;grid-template-columns:1fr auto auto auto;gap:8px;align-items:center;padding:6px 0;border-bottom:1px solid var(--rose-light);font-size:12px;">
      <span>${escapeHtml(m.nome)} ${matBadge(m)} <span class="fin-badge ${tagCls}" style="font-size:10px;">est:${e.atual} ${m.unid||''}</span></span>
      <input type="number" class="edit-input-fin" style="width:66px;text-align:center;" min="0.001" step="0.001" value="${item.qtd}" onchange="updateInsumoQtd(${idx},this.value)"/>
      <span style="font-size:11px;color:var(--rose-text);">${m.unid||''}</span>
      <span style="display:flex;align-items:center;gap:4px;">
        <span style="font-size:11px;color:var(--rose-text);">${fmtBRL(custo)}</span>
        <button class="btn-danger" style="padding:2px 6px;" onclick="removeInsumo(${idx})"><i class="ti ti-x"></i></button>
      </span>
    </li>`;
  }).join('');
  document.getElementById('mi-total-custo').textContent = fmtBRL(total);
}
function updateInsumoQtd(idx,val){ insumosTemp[idx].qtd=parseFloat(val)||0; renderInsumosList(); }
function removeInsumo(idx){ insumosTemp.splice(idx,1); renderInsumosList(); }
async function saveInsumos(){
  if(insumosEditProcId===null) return;
  procInsumos[insumosEditProcId]=JSON.parse(JSON.stringify(insumosTemp));
  const totalIns=insumosTemp.reduce((acc,item)=>{const m=mats.find(x=>x.id===item.matId);return acc+(m?m.custo*item.qtd:0);},0);
  const pi=procs.findIndex(x=>x.id===insumosEditProcId);
  if(pi>=0){
    procs[pi].insumos=parseFloat(totalIns.toFixed(2));
    procs[pi].horaClin=parseFloat(((procs[pi].tempo/60)*calcHora()).toFixed(2));
  }
  showLoading(true); const _eIns=await saveFinanceiro(); showLoading(false);
  closeModal('modal-insumos');
  renderProcs(); renderEstoque();
  if(!_eIns) showToast('Insumos salvos!');
}
async function recalcularInsumos(silent){
  if(!silent){
    cfg.salario  = Number(document.getElementById('cfg-salario')?.value)||cfg.salario||0;
    cfg.horas    = Number(document.getElementById('cfg-horas')?.value)||cfg.horas||132;
    cfg.trib     = Number(document.getElementById('cfg-trib')?.value)||cfg.trib||0;
    cfg.desperd  = Number(document.getElementById('cfg-desperd')?.value)||cfg.desperd||0;
    cfg.margem   = Number(document.getElementById('cfg-margem')?.value)||cfg.margem||100;
  }
  let atualizados=0;
  procs.forEach(p=>{
    const ins=procInsumos[p.id]||[];
    if(ins.length){
      const novo=parseFloat(ins.reduce((acc,item)=>{const m=mats.find(x=>x.id===item.matId);return acc+(m?m.custo*item.qtd:0);},0).toFixed(2));
      if(novo!==p.insumos){p.insumos=novo;atualizados++;}
    }
    p.horaClin=parseFloat(((p.tempo/60)*calcHora()).toFixed(2));
    if(!silent){
      if(!p._margemManual) p.margem=cfg.margem;
      if(!p._precoManual) p.precoFinal=calcPrecoFinal(p);
    }
  });
  if(!silent){
    procs.forEach(p=>{
      if(p._precoManual) return;
      const pm = calcPrecoManut(p.id);
      if(pm !== null) p.precoFinal = pm;
    });
  }
  renderProcs();
  if(!silent){
    showLoading(true);
    const _eRI=await saveFinanceiro();
    showLoading(false);
    if(!_eRI) showToast(`${atualizados} procedimento(s) atualizados. Margem: ${cfg.margem}%.`);
  }
}

// ── VENDAS ──
const STATUS_VENDA = {
  orcamento : {lbl:'Orçamento', cls:'orcamento', icon:'ti-clock'},
  finalizada: {lbl:'Finalizada', cls:'finalizada', icon:'ti-circle-check'},
  cancelada : {lbl:'Cancelada',  cls:'cancelada',  icon:'ti-circle-x'},
};

function computeConsumo(itens){
  const map={};
  const addProc=(procId,qtd)=>{ (procInsumos[procId]||[]).forEach(ins=>{ map[ins.matId]=(map[ins.matId]||0)+ins.qtd*qtd; }); };
  (itens||[]).forEach(it=>{
    const qtd=Number(it.qtd)||1;
    if(it.comboId){
      // Item de combo: consome os insumos dos procedimentos internos
      const cb=combos.find(c=>c.id===it.comboId);
      if(cb)(cb.itens||[]).forEach(ci=>addProc(ci.procId,(Number(ci.qtd)||1)*qtd));
    } else if(it.procId){
      addProc(it.procId,qtd);
    }
  });
  return Object.keys(map).map(k=>({matId:Number(k),qtd:parseFloat(map[k].toFixed(4))}));
}

// Valor já pago de uma venda — critério único para todas as telas.
// Vendas antigas finalizadas sem extrato de pagamentos contam como pagas no ato,
// exceto venda rápida com entrada registrada (deve o restante).
function vendaValorPago(v){
  if(Array.isArray(v.pagamentos)) return v.pagamentos.reduce((s,p)=>s+(Number(p.valor)||0),0);
  if(Number(v.restante)>0) return Math.max(0,(Number(v.total)||0)-Number(v.restante));
  return Number(v.total)||0;
}
function aplicarBaixaEstoque(consumo){
  const aplicado=[];
  consumo.forEach(c=>{
    if(!estoque[c.matId]) estoque[c.matId]={atual:0,min:0,compra:0};
    const antes=estoque[c.matId].atual||0;
    const depois=Math.max(0,parseFloat((antes-c.qtd).toFixed(4)));
    aplicado.push({matId:c.matId,qtd:parseFloat((antes-depois).toFixed(4))});
    estoque[c.matId].atual=depois;
  });
  return aplicado;
}
function devolverEstoque(consumo){
  (consumo||[]).forEach(c=>{
    if(!estoque[c.matId]) estoque[c.matId]={atual:0,min:0,compra:0};
    estoque[c.matId].atual=parseFloat(((estoque[c.matId].atual||0)+c.qtd).toFixed(4));
  });
}
function renderVendas(){
  _periodoPopularSelects('venda-mes','venda-ano','venda');
  const q  = (document.getElementById('venda-search')||{value:''}).value.toLowerCase();
  const sf = (document.getElementById('venda-status')||{value:''}).value;
  let list = _filtrarVendasPorPeriodo(vendas, 'venda-mes','venda-ano').filter(v=>{
    const txt=_norm((v.pacienteNome||'')+' '+(v.itens||[]).map(i=>i.nome||'').join(' '));
    return(!q||txt.includes(_norm(q)))&&(!sf||v.status===sf);
  }).slice().reverse();
  const fin     = _filtrarVendasPorPeriodo(vendas.filter(v=>v.status==='finalizada'), 'venda-mes','venda-ano');
  const orcAbertos = vendas.filter(v=>v.status==='orcamento').length;
  // Faturamento/Ticket médio (agregado) saíram daqui de propósito — quem
  // vende não precisa ver o total, só o valor de cada venda individual (que
  // continua na tabela abaixo). Esses números ficam no Painel Financeiro,
  // atrás do PIN financeiro.
  const vm = document.getElementById('vendas-metrics');
  if(vm) vm.innerHTML=[
    {lbl:'Vendas finalizadas',val:fin.length,cor:'#2e7d32'},
    {lbl:'Orçamentos abertos',val:orcAbertos,cor:'#856404'},
  ].map(s=>`<div style="background:var(--rose-lighter);border:1px solid var(--rose-light);border-radius:12px;padding:12px 16px;">
    <div style="font-size:11px;color:var(--rose-text);">${s.lbl}</div>
    <div style="font-size:20px;font-weight:800;color:${s.cor};">${s.val}</div>
  </div>`).join('');
  const tb = document.getElementById('vendas-tbody'); if(!tb) return;
  if(!list.length){ tb.innerHTML='<tr><td colspan="6" style="text-align:center;color:var(--rose-text);padding:20px;">Nenhuma venda registrada ainda.</td></tr>'; return; }
  tb.innerHTML = list.map(v=>{
    const si = STATUS_VENDA[v.status]||STATUS_VENDA.orcamento;
    const data = new Date(v.data).toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit',year:'2-digit'})+' '+new Date(v.data).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});
    const itensRes = (v.itens||[]).map(i=>(i.qtd>1?i.qtd+'× ':'')+escapeHtml(i.nome||'')+(i.dente?` (Dente ${i.dente})`:'')+(i.descDente?` — ${escapeHtml(i.descDente)}`:'')).join(', ');
    let acoes = `<button class="btn-secondary" style="padding:4px 8px;font-size:11px;" onclick="toggleVendaMat(${v.id})" title="Ver materiais"><i class="ti ti-box"></i></button>`;
    if(v.status==='orcamento') acoes += `<button class="btn-secondary" style="padding:4px 8px;font-size:11px;color:#2e7d32;" onclick="finalizarVendaSalva(${v.id})" title="Finalizar venda"><i class="ti ti-circle-check"></i></button>`;
    if(v.status==='finalizada') acoes += `<button class="btn-secondary" style="padding:4px 8px;font-size:11px;color:#2e7d32;" onclick="gerarRecibo(${v.id})" title="Gerar recibo"><i class="ti ti-receipt"></i></button>`;
    if(v.status==='finalizada') acoes += `<button class="btn-secondary" style="padding:4px 8px;font-size:11px;color:#856404;" onclick="cancelarVenda(${v.id})" title="Cancelar venda"><i class="ti ti-arrow-back-up"></i></button>`;
    if(v.status==='cancelada'&&!v.estoqueDevolvido) acoes += `<button class="btn-secondary" style="padding:4px 8px;font-size:11px;color:#2e7d32;" onclick="devolverEstoqueVenda(${v.id})" title="Devolver estoque"><i class="ti ti-package-import"></i></button>`;
    acoes += `<button class="btn-danger" style="padding:4px 8px;font-size:11px;" onclick="excluirVenda(${v.id})"><i class="ti ti-trash"></i></button>`;
    // Detalhe materiais (linha oculta)
    const ci = v.status==='finalizada'?{dir:'saiu',consumo:v.consumo||[]}:v.status==='cancelada'?{dir:'voltou',consumo:v.consumoRevertido||[]}:{dir:'previsto',consumo:computeConsumo(v.itens||[])};
    const matLi = ci.consumo.length?ci.consumo.map(c=>{const m=mats.find(x=>x.id===c.matId);return `<li style="display:flex;justify-content:space-between;font-size:12px;padding:2px 0;"><span>${m?escapeHtml(m.nome):'Material #'+c.matId}</span><span>${fmtN2(c.qtd)}</span></li>`;}).join(''):'<li style="color:var(--rose-text);font-size:12px;">Nenhum insumo vinculado.</li>';
    return `<tr style="border-bottom:1px solid var(--rose-light);">
      <td data-label="Data" style="padding:10px;font-size:12px;white-space:nowrap;">${data}</td>
      <td data-label="Paciente" style="padding:10px;">${escapeHtml(v.pacienteNome||'—')}</td>
      <td data-label="Itens" style="padding:10px;font-size:12px;color:var(--rose-text);max-width:280px;">${itensRes||'—'}</td>
      <td data-label="Total" style="padding:10px;text-align:right;font-weight:700;color:var(--rose-dark);">${fmtBRL(v.total)}</td>
      <td data-label="Status" style="padding:10px;"><span class="fin-badge ${si.cls}"><i class="ti ${si.icon}"></i> ${si.lbl}</span></td>
      <td data-label="Ações" style="padding:10px;"><div style="display:flex;gap:4px;justify-content:flex-end;">${acoes}</div></td>
    </tr>
    <tr id="vd-${v.id}" style="display:none;background:var(--rose-lighter);">
      <td colspan="6" style="padding:10px 16px;">
        <div style="font-size:12px;font-weight:600;color:var(--rose-dark);margin-bottom:4px;">Materiais — ${ci.dir}</div>
        <ul style="list-style:none;">${matLi}</ul>
      </td>
    </tr>`;
  }).join('');
}
function toggleVendaMat(id){ const r=document.getElementById('vd-'+id); if(r) r.style.display=r.style.display==='none'?'':'none'; }
async function finalizarVendaSalva(id){
  const v=vendas.find(x=>x.id===id); if(!v||v.status!=='orcamento') return;
  if(!confirm('Finalizar venda? O estoque dos materiais usados será descontado.')) return;
  const consumo=computeConsumo(v.itens||[]);
  const aplicado=aplicarBaixaEstoque(consumo);
  v.status='finalizada'; v.consumo=aplicado; v.dataFinal=new Date().toISOString();
  // Extrato: pagamento integral no ato (desconta o que já tiver sido pago antes)
  const _jaPago=(v.pagamentos||[]).reduce((s,p)=>s+(Number(p.valor)||0),0);
  const _falta=Math.max(0,(v.total||0)-_jaPago);
  if(_falta>0){
    v.pagamentos=(v.pagamentos||[]).concat([{id:Date.now(),valor:parseFloat(_falta.toFixed(2)),forma:v.formaPagamento==='debito'?'debito':(v.formaPagamento||'').startsWith('credito')?'credito':'dinheiro',parcelas_cartao:1,data:new Date().toISOString(),obs:''}]);
  }
  showLoading(true); const _eVF=await saveFinanceiro(); showLoading(false);
  renderVendas(); renderEstoque();
  if(!_eVF){ logAtividade('Venda finalizada', `${v.pacienteNome||'—'} — ${fmtBRL(v.total)}`); showToast('Venda finalizada! Estoque atualizado.'); }
}
async function cancelarVenda(id){
  const v=vendas.find(x=>x.id===id); if(!v||v.status!=='finalizada') return;
  if(!confirm('Cancelar esta venda? O estoque será devolvido.')) return;
  const consumo=(v.consumo&&v.consumo.length)?v.consumo:computeConsumo(v.itens||[]);
  devolverEstoque(consumo);
  v.status='cancelada'; v.consumoRevertido=consumo; v.estoqueDevolvido=true; v.consumo=null; v.dataCancel=new Date().toISOString();
  showLoading(true);
  // Volta os itens do plano vinculados para 'aprovado'
  if(v.planoIds && v.planoIds.length){
    for(const id2 of v.planoIds){
      const {error:_ePR}=await _sb.from('plano_tratamento').update({ status:'aprovado' }).eq('id',id2);
      if(_ePR) console.error('Erro ao reverter plano:',_ePR.message);
      const item = pacPlanoList.find(i=>i.id===id2);
      if(item) item.status='aprovado';
    }
    if(typeof pacRenderPlanoResumo==='function') pacRenderPlanoResumo();
    if(typeof pacRenderPlanoLista==='function') pacRenderPlanoLista();
  }
  const _eVC=await saveFinanceiro(); showLoading(false);
  renderVendas(); renderEstoque();
  if(!_eVC) showToast('Venda cancelada. Estoque devolvido.');
}
async function devolverEstoqueVenda(id){
  const v=vendas.find(x=>x.id===id); if(!v||v.status!=='cancelada') return;
  if(v.estoqueDevolvido){ showToast('Estoque já foi devolvido.','warn'); return; }
  const consumo=computeConsumo(v.itens||[]);
  devolverEstoque(consumo);
  v.consumoRevertido=consumo; v.estoqueDevolvido=true;
  showLoading(true); const _eED=await saveFinanceiro(); showLoading(false);
  renderVendas(); renderEstoque();
  if(!_eED) showToast('Estoque devolvido!');
}
async function excluirVenda(id){
  const v=vendas.find(x=>x.id===id); if(!v) return;
  const msg = v.status==='finalizada'?'Venda finalizada — excluir NÃO devolve o estoque (cancele antes). Excluir mesmo assim?':'Excluir este registro?';
  if(!confirm(msg)) return;
  vendas=vendas.filter(x=>x.id!==id);
  showLoading(true); const _eVE=await saveFinanceiro(); showLoading(false);
  renderVendas();
  if(!_eVE) showToast('Excluído.');
}

function updateDescPac(){
  descCfg.val  = Number(document.getElementById('sim-desc-val-pac')?.value)||0;
  descCfg.tipo = document.getElementById('sim-desc-tipo-pac')?.value||'pct';
  renderOrcPac();
  updateFormaPag();
}

function updateFormaPag(){
  const sel = document.getElementById('sim-forma-pag');
  const val = sel?.value || '';
  const { total } = calcTotalOrc();
  let taxa = 0, liquido = total, infoTxt = '', liquidoTxt = '';
  if(val === 'debito'){
    taxa = taxasCfg.debito || 0;
    liquido = calcValorLiquido(total,'debito',1);
  } else if(val.startsWith('credito')){
    const par = parseInt(val.replace('credito',''))||1;
    const idx = [1,2,3,4,5,6,7,8,9,10,11,12].indexOf(par);
    taxa = idx>=0 ? (taxasCfg.credito||[])[idx]||0 : 0;
    liquido = calcValorLiquido(total,'credito',par);
  }
  const tiEl = document.getElementById('sim-taxa-info');
  const lqEl = document.getElementById('sim-liquido-info');
  if(tiEl) tiEl.textContent = taxa > 0 ? `Taxa: ${taxa}%` : '';
  if(lqEl){
    if(taxa > 0 && total > 0){
      lqEl.style.display = '';
      lqEl.textContent = `Você recebe: ${fmtBRL(liquido)} (desconta ${fmtBRL(total-liquido)} de taxa)`;
    } else {
      lqEl.style.display = 'none';
    }
  }
}
function renderSimSelectPac(){
  const sel = document.getElementById('sim-select-pac'); if(!sel) return;
  const q = (document.getElementById('sim-search-pac')||{value:''}).value.toLowerCase();
  const g = (document.getElementById('sim-grupo-pac')||{value:''}).value;
  let html2 = '';
  // Combos
  if(g===''||g==='__combo__'){
    let cl = combos.filter(c=>!q||c.nome.toLowerCase().includes(q));
    if(cl.length) html2 += '<optgroup label="🎁 Combos Promocionais">' + cl.map(c=>`<option value="combo:${c.id}">${escapeHtml(c.nome)} — ${fmtBRL(c.preco)}</option>`).join('') + '</optgroup>';
  }
  // Procedimentos
  if(g!=='__combo__'){
    let list = procs.filter(p=>p.ativo!==false&&(!q||p.nome.toLowerCase().includes(q))&&(!g||g==='__combo__'||p.grupo===g));
    if(list.length) html2 += (g===''?'<optgroup label="Procedimentos">':'') + list.map(p=>`<option value="proc:${p.id}">${escapeHtml(p.nome)} — ${fmtBRL(p.precoFinal)}</option>`).join('') + (g===''?'</optgroup>':'');
  }
  sel.innerHTML = html2 || '<option value="">Nenhum item encontrado</option>';
}
function addOrcPac(){
  const raw  = document.getElementById('sim-select-pac')?.value || '';
  const qtd  = Number(document.getElementById('sim-qtd-pac')?.value)||1;
  if(!raw) return;
  if(raw.startsWith('combo:')){
    const cid = Number(raw.split(':')[1]);
    const c = combos.find(x=>x.id===cid); if(!c) return;
    orcamento.push({tipo:'combo',comboId:cid,qtd,nome:'🎁 '+c.nome,precoUnit:c.preco,custo:combosCusto(c),dente:'',descDente:''});
  } else {
    const procId = Number(raw.startsWith('proc:')?raw.split(':')[1]:raw);
    const p = procs.find(x=>x.id===procId); if(!p) return;
    orcamento.push({tipo:'proc',procId,qtd,nome:p.nome,precoUnit:p.precoFinal,custo:custoProc(p),dente:'',descDente:''});
  }
  renderOrcPac();
}

function combosCusto(c){
  return (c.itens||[]).reduce((a,it)=>{const p=procs.find(x=>x.id===it.procId);return a+(p?custoProc(p)*it.qtd:0);},0);
}
function renderOrcPac(){
  const c = document.getElementById('sim-orc-list-pac'); if(!c) return;
  if(!orcamento.length){
    c.innerHTML='<div style="color:var(--rose-text);font-size:13px;text-align:center;padding:10px;">Nenhum item adicionado</div>';
    const t=document.getElementById('sim-orc-total-pac'); if(t) t.textContent='R$ 0,00';
    const l=document.getElementById('sim-orc-lucro-pac'); if(l) l.textContent='';
    return;
  }
  c.innerHTML = orcamento.map((it,i)=>`
    <div style="border:1px solid var(--rose-light);border-radius:10px;padding:10px;margin-bottom:8px;background:#fff;">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px;">
        <span style="flex:1;font-size:13px;font-weight:600;">${escapeHtml(it.nome)}</span>
        <input type="number" min="1" value="${it.qtd}" onchange="orcamento[${i}].qtd=Math.max(1,Number(this.value));renderOrcPac();" style="width:46px;padding:4px;border:1px solid var(--rose-light);border-radius:6px;text-align:center;font-size:12px;" title="Quantidade"/>
        <input type="number" min="0" step="0.01" value="${(it.precoUnit*it.qtd).toFixed(2)}" onchange="orcamento[${i}].precoUnit=parseFloat(this.value)/Math.max(1,orcamento[${i}].qtd);renderOrcPac();" style="width:90px;padding:4px 6px;border:1px solid var(--rose-light);border-radius:6px;text-align:right;font-size:12px;font-weight:700;color:var(--rose-dark);" title="Valor total (editável)"/>
        <button class="btn-danger" style="padding:3px 7px;" onclick="orcamento.splice(${i},1);renderOrcPac();"><i class="ti ti-x"></i></button>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <div style="flex:0 0 auto;">
          <select onchange="orcamento[${i}].dente=this.value" style="padding:4px 8px;border:1px solid var(--rose-light);border-radius:8px;font-size:12px;background:var(--rose-lighter);color:var(--rose-dark);">
            <option value="">Dente</option>
            ${[18,17,16,15,14,13,12,11,21,22,23,24,25,26,27,28,48,47,46,45,44,43,42,41,31,32,33,34,35,36,37,38,55,54,53,52,51,61,62,63,64,65,85,84,83,82,81,71,72,73,74,75].map(d=>`<option value="${d}"${it.dente==d?' selected':''}>${d}</option>`).join('')}
          </select>
        </div>
        <input type="text" value="${escapeHtml(it.descDente||'')}" placeholder="O que foi feito neste dente..." onchange="orcamento[${i}].descDente=this.value" style="flex:1;min-width:140px;padding:4px 8px;border:1px solid var(--rose-light);border-radius:8px;font-size:12px;background:var(--rose-lighter);"/>
      </div>
    </div>
  `).join('');

  // Subtotal, desconto, total com desconto
  const subtotal = orcamento.reduce((a,it)=>a+it.precoUnit*it.qtd, 0);
  const descVal  = descCfg.val||0;
  const descTipo = descCfg.tipo||'pct';
  const descAmt  = descVal>0 ? (descTipo==='pct' ? subtotal*descVal/100 : Math.min(descVal,subtotal)) : 0;
  const totalFinal = Math.max(0, subtotal - descAmt);

  const elTotal = document.getElementById('sim-orc-total-pac');
  if(elTotal) elTotal.textContent = fmtBRL(subtotal);
  // Sincroniza total com plano de tratamento (atualiza resumo)
  pacRenderPlanoResumo();

  const elDescTotal = document.getElementById('sim-desc-total-pac');
  if(elDescTotal){
    if(descAmt>0){
      elDescTotal.style.display='';
      elDescTotal.textContent = `Com desconto: ${fmtBRL(totalFinal)} (economia de ${fmtBRL(descAmt)})`;
    } else {
      elDescTotal.style.display='none';
    }
  }

  // Info desconto
  const elDescInfo = document.getElementById('sim-desc-info-pac');
  if(elDescInfo) elDescInfo.textContent = descAmt>0 ? `− ${fmtBRL(descAmt)}` : '';

  // Lucro (só dentista vê, não aparece para paciente)
  const custoTotal = orcamento.reduce((a,it)=>a+(it.custo||0)*it.qtd, 0);
  const lucroTotal = totalFinal - custoTotal;
  const elLucro = document.getElementById('sim-orc-lucro-pac');
  if(elLucro) elLucro.innerHTML = `
    <span>Custo: <strong>${fmtBRL(custoTotal)}</strong></span>
    &nbsp;·&nbsp;
    <span>Seu lucro: <strong style="color:${lucroTotal>=0?'#2e7d32':'#dc2626'}">${fmtBRL(lucroTotal)}</strong></span>
  `;
}
function calcTotalOrc(){
  const sub = orcamento.reduce((a,it)=>a+it.precoUnit*it.qtd,0);
  const dv  = descCfg.val||0;
  const dt  = descCfg.tipo||'pct';
  const da  = dv>0 ? (dt==='pct'?sub*dv/100:Math.min(dv,sub)) : 0;
  return { subtotal:sub, desconto:parseFloat(da.toFixed(2)), total:parseFloat(Math.max(0,sub-da).toFixed(2)) };
}

async function salvarOrcPac(pacId){
  if(!orcamento.length){ showToast('Adicione procedimentos ao orçamento.','warn'); return; }
  const pac = pacientes.find(p=>p.id===pacId);
  const { subtotal, desconto, total } = calcTotalOrc();
  const venda = {
    id: nextVendaId++, status:'orcamento',
    pacienteId: pacId, pacienteNome: pac?.nome||'',
    itens: orcamento.map(it=>({procId:it.procId||null,comboId:it.comboId||null,qtd:it.qtd,nome:it.nome,dente:it.dente||'',descDente:it.descDente||''})),
    subtotal: parseFloat(subtotal.toFixed(2)),
    desconto, total,
    descCfg: {...descCfg},
    data: new Date().toISOString()
  };
  vendas.push(venda);
  showLoading(true); const _eOrc2=await saveFinanceiro(); showLoading(false);
  if(!_eOrc2) showToast('Orçamento salvo!');
  // Atualiza aba de orçamentos se estiver aberta
  if(document.getElementById('pac-orc-lista')) pacRenderOrcamentos(pacId);
}

async function finalizarVendaPac(pacId){
  if(!orcamento.length){ showToast('Adicione procedimentos ao orçamento.','warn'); return; }
  const { subtotal, desconto, total } = calcTotalOrc();
  // Aplica taxa da maquininha se selecionada
  const formaEl = document.getElementById('sim-forma-pag');
  const forma = formaEl?.value || '';
  let taxa = 0, totalComTaxa = total;
  if(forma === 'debito'){
    taxa = taxasCfg.debito || 0;
    totalComTaxa = parseFloat((total / (1 - taxa/100)).toFixed(2));
  } else if(forma.startsWith('credito')){
    const par = parseInt(forma.replace('credito',''))||1;
    const idx = par - 1;
    taxa = (taxasCfg.credito||[])[idx]||0;
    totalComTaxa = parseFloat((total / (1 - taxa/100)).toFixed(2));
  }
  if(!confirm(`Finalizar venda de ${fmtBRL(totalComTaxa)}${taxa>0?' (inclui taxa '+taxa+'%)':''}? O estoque dos materiais usados será descontado.`)) return;
  const pac = pacientes.find(p=>p.id===pacId);
  const itensProc = orcamento.filter(it=>it.tipo==='proc'||it.procId).map(it=>({procId:it.procId,qtd:it.qtd}));
  // Para combos, expande os procedimentos internos
  orcamento.filter(it=>it.tipo==='combo').forEach(it=>{
    const cb = combos.find(c=>c.id===it.comboId);
    if(cb)(cb.itens||[]).forEach(ci=>itensProc.push({procId:ci.procId,qtd:ci.qtd*it.qtd}));
  });
  const consumo = computeConsumo(itensProc);
  const aplicado = aplicarBaixaEstoque(consumo);
  const _parCredito = forma.startsWith('credito') ? (parseInt(forma.replace('credito',''))||1) : 1;
  const venda = {
    id: nextVendaId++, status:'finalizada',
    formaPagamento: forma,
    pacienteId: pacId, pacienteNome: pac?.nome||'',
    itens: orcamento.map(it=>({procId:it.procId||null,comboId:it.comboId||null,qtd:it.qtd,nome:it.nome,dente:it.dente||'',descDente:it.descDente||''})),
    subtotal: parseFloat(subtotal.toFixed(2)),
    desconto, total, consumo: aplicado,
    data: new Date().toISOString(),
    dataFinal: new Date().toISOString(),
    // Extrato: pagamento integral no ato da finalização
    pagamentos: [{
      id: Date.now(),
      valor: parseFloat(total.toFixed(2)),
      forma: forma==='debito'?'debito':forma.startsWith('credito')?'credito':'dinheiro',
      parcelas_cartao: _parCredito,
      data: new Date().toISOString(),
      obs: ''
    }]
  };
  vendas.push(venda);
  orcamento = [];
  showLoading(true); const _eVP=await saveFinanceiro(); showLoading(false);
  renderOrcPac();
  renderEstoque();
  if(!_eVP) showToast('Venda finalizada!');
  // Atualiza orçamentos e vai para realizados
  if(document.getElementById('pac-orc-lista')) pacRenderOrcamentos(pacId);
  renderPatientDetail('procs');
  setTimeout(()=>{ showToast('Colete as assinaturas na aba Realizados.','warn'); },1000);
}

// ── Carregar padrões manualmente ──
async function carregarPadroes(confirm_ask=true){
  if(confirm_ask && procs.length > 0 && !confirm('Já existem procedimentos. Substituir pelos padrões?')) return;
  showLoading(true);
  procs   = DEFAULT_PROCS_FIN.map((p,i)=>({...p,id:p.id||i+1}));
  mats    = mats.length ? mats : DEFAULT_MATS_FIN.map((m,i)=>({...m,id:m.id||i+1}));
  combos  = combos.length ? combos : DEFAULT_COMBOS_FIN.map(c=>({...c}));
  // Carrega insumos padrão
  Object.entries(DEFAULT_PROC_INSUMOS_DATA).forEach(([k,v])=>{ procInsumos[k]=JSON.parse(JSON.stringify(v)); });
  nextProcId  = 103;
  nextMatId   = mats.length > 50 ? nextMatId : 91;
  nextComboId = 207;
  const _ePad=await saveFinanceiro();
  showLoading(false);
  if(!_ePad && confirm_ask) showToast('Procedimentos e insumos carregados!');
  renderFinanceiroDash();
  renderProcs();
}

// ── Modais (reutiliza funções existentes do app) ──
function openModal(id){ const m=document.getElementById(id); if(m) m.classList.add('open'); }
function closeModal(id){ const m=document.getElementById(id); if(m) m.classList.remove('open'); }


// Insumos pré-configurados por procedimento (baseado em literatura odontológica)

const DEFAULT_PROC_INSUMOS_DATA = {
  // ── PREVENTIVO ──
  1:  [{matId:25,qtd:1},{matId:67,qtd:1},{matId:68,qtd:5},{matId:38,qtd:3},{matId:8,qtd:1},{matId:34,qtd:2},{matId:35,qtd:1},{matId:16,qtd:10},{matId:20,qtd:1}],
  2:  [{matId:25,qtd:1},{matId:67,qtd:1},{matId:68,qtd:5},{matId:38,qtd:3},{matId:8,qtd:1},{matId:34,qtd:2},{matId:35,qtd:1},{matId:16,qtd:10}],
  3:  [{matId:8,qtd:1},{matId:38,qtd:2},{matId:34,qtd:1},{matId:35,qtd:1},{matId:20,qtd:1}],
  4:  [{matId:39,qtd:1},{matId:1,qtd:0.5},{matId:40,qtd:0.3},{matId:37,qtd:2},{matId:8,qtd:1},{matId:23,qtd:1},{matId:34,qtd:2},{matId:69,qtd:1}],
  70: [{matId:8,qtd:1},{matId:38,qtd:2},{matId:34,qtd:1},{matId:35,qtd:1}],
  71: [{matId:25,qtd:1},{matId:67,qtd:1},{matId:29,qtd:2},{matId:38,qtd:2},{matId:8,qtd:1},{matId:34,qtd:1}],
  72: [{matId:8,qtd:1},{matId:38,qtd:2},{matId:37,qtd:1},{matId:34,qtd:1}],
  73: [{matId:8,qtd:1},{matId:38,qtd:2},{matId:29,qtd:2},{matId:34,qtd:1},{matId:35,qtd:1}],
  // ── DENTÍSTICA ──
  5:  [{matId:1,qtd:0.5},{matId:40,qtd:0.3},{matId:52,qtd:2},{matId:53,qtd:1},{matId:37,qtd:3},{matId:21,qtd:1},{matId:36,qtd:1},{matId:22,qtd:2},{matId:23,qtd:1},{matId:8,qtd:1},{matId:34,qtd:2},{matId:69,qtd:1},{matId:41,qtd:1}],
  6:  [{matId:1,qtd:0.5},{matId:40,qtd:0.3},{matId:51,qtd:2},{matId:52,qtd:1},{matId:37,qtd:3},{matId:41,qtd:3},{matId:22,qtd:2},{matId:23,qtd:1},{matId:8,qtd:1},{matId:34,qtd:2},{matId:69,qtd:1}],
  7:  [{matId:13,qtd:1},{matId:3,qtd:0.5},{matId:37,qtd:2},{matId:8,qtd:1},{matId:34,qtd:1},{matId:69,qtd:1}],
  8:  [{matId:2,qtd:0.2},{matId:15,qtd:0.5},{matId:40,qtd:0.5},{matId:52,qtd:3},{matId:51,qtd:2},{matId:37,qtd:5},{matId:22,qtd:3},{matId:41,qtd:4},{matId:23,qtd:1},{matId:8,qtd:1},{matId:34,qtd:2},{matId:69,qtd:1}],
  9:  [{matId:65,qtd:1},{matId:9,qtd:0.5},{matId:8,qtd:1},{matId:38,qtd:2},{matId:34,qtd:1},{matId:35,qtd:1}],
  10: [{matId:64,qtd:1},{matId:9,qtd:1},{matId:8,qtd:1},{matId:38,qtd:2},{matId:34,qtd:1},{matId:35,qtd:1},{matId:20,qtd:1}],
  11: [{matId:37,qtd:2},{matId:8,qtd:1},{matId:38,qtd:1},{matId:34,qtd:1},{matId:69,qtd:1}],
  12: [{matId:40,qtd:0.2},{matId:52,qtd:1},{matId:53,qtd:1},{matId:22,qtd:2},{matId:37,qtd:3},{matId:41,qtd:2},{matId:8,qtd:1},{matId:34,qtd:2},{matId:69,qtd:1}],
  13: [{matId:40,qtd:0.2},{matId:52,qtd:1},{matId:22,qtd:1},{matId:37,qtd:2},{matId:8,qtd:1},{matId:34,qtd:1}],
  14: [{matId:14,qtd:1},{matId:71,qtd:0.5},{matId:38,qtd:2},{matId:8,qtd:1},{matId:34,qtd:1}],
  15: [{matId:14,qtd:1},{matId:55,qtd:0.5},{matId:38,qtd:2},{matId:8,qtd:1},{matId:34,qtd:1}],
  93: [{matId:31,qtd:5},{matId:72,qtd:1},{matId:19,qtd:3},{matId:8,qtd:1},{matId:34,qtd:1},{matId:49,qtd:1}],
  94: [{matId:57,qtd:1},{matId:87,qtd:0.1},{matId:38,qtd:2},{matId:8,qtd:1},{matId:34,qtd:1}],
  95: [{matId:1,qtd:0.5},{matId:40,qtd:0.4},{matId:52,qtd:3},{matId:51,qtd:2},{matId:37,qtd:4},{matId:22,qtd:3},{matId:41,qtd:3},{matId:8,qtd:1},{matId:34,qtd:2},{matId:69,qtd:1}],
  // ── CIRURGIA ──
  16: [{matId:33,qtd:1},{matId:10,qtd:0.5},{matId:5,qtd:1},{matId:30,qtd:4},{matId:38,qtd:4},{matId:8,qtd:1},{matId:34,qtd:2},{matId:35,qtd:1},{matId:4,qtd:1},{matId:20,qtd:1}],
  17: [{matId:33,qtd:2},{matId:10,qtd:1},{matId:5,qtd:1},{matId:30,qtd:6},{matId:38,qtd:4},{matId:8,qtd:1},{matId:34,qtd:2},{matId:35,qtd:1},{matId:4,qtd:1},{matId:28,qtd:1},{matId:11,qtd:1},{matId:86,qtd:1}],
  18: [{matId:33,qtd:2},{matId:10,qtd:1},{matId:6,qtd:1},{matId:30,qtd:8},{matId:38,qtd:6},{matId:8,qtd:1},{matId:34,qtd:2},{matId:35,qtd:1},{matId:4,qtd:1},{matId:27,qtd:1},{matId:11,qtd:1},{matId:86,qtd:1},{matId:26,qtd:1}],
  19: [{matId:33,qtd:2},{matId:10,qtd:1},{matId:6,qtd:1},{matId:86,qtd:1},{matId:27,qtd:1},{matId:30,qtd:8},{matId:38,qtd:6},{matId:4,qtd:1},{matId:8,qtd:1},{matId:34,qtd:2},{matId:11,qtd:1}],
  20: [{matId:33,qtd:1},{matId:10,qtd:1},{matId:5,qtd:1},{matId:86,qtd:1},{matId:28,qtd:1},{matId:30,qtd:4},{matId:38,qtd:4},{matId:8,qtd:1},{matId:34,qtd:2}],
  84: [{matId:33,qtd:1},{matId:10,qtd:1},{matId:5,qtd:1},{matId:86,qtd:1},{matId:27,qtd:1},{matId:30,qtd:4},{matId:38,qtd:4},{matId:4,qtd:1},{matId:8,qtd:1},{matId:34,qtd:2}],
  85: [{matId:33,qtd:1},{matId:10,qtd:1},{matId:5,qtd:1},{matId:17,qtd:5},{matId:30,qtd:4},{matId:38,qtd:4},{matId:8,qtd:1},{matId:34,qtd:2},{matId:49,qtd:1}],
  86: [{matId:33,qtd:2},{matId:10,qtd:1},{matId:6,qtd:1},{matId:86,qtd:1},{matId:27,qtd:1},{matId:30,qtd:6},{matId:38,qtd:4},{matId:4,qtd:1},{matId:8,qtd:1},{matId:34,qtd:2},{matId:11,qtd:1}],
  87: [{matId:33,qtd:2},{matId:10,qtd:1},{matId:6,qtd:1},{matId:86,qtd:1},{matId:27,qtd:1},{matId:30,qtd:6},{matId:38,qtd:4},{matId:4,qtd:1},{matId:8,qtd:1},{matId:34,qtd:2}],
  // ── ENDODONTIA ──
  21: [{matId:33,qtd:1},{matId:10,qtd:0.5},{matId:5,qtd:1},{matId:24,qtd:5},{matId:31,qtd:20},{matId:19,qtd:5},{matId:30,qtd:4},{matId:8,qtd:1},{matId:34,qtd:2},{matId:72,qtd:1}],
  22: [{matId:33,qtd:1},{matId:10,qtd:1},{matId:5,qtd:1},{matId:70,qtd:1},{matId:24,qtd:10},{matId:31,qtd:30},{matId:19,qtd:10},{matId:18,qtd:4},{matId:12,qtd:1},{matId:72,qtd:2},{matId:55,qtd:1},{matId:23,qtd:1},{matId:8,qtd:1},{matId:34,qtd:2}],
  23: [{matId:33,qtd:1},{matId:10,qtd:1},{matId:5,qtd:1},{matId:70,qtd:1},{matId:24,qtd:10},{matId:31,qtd:25},{matId:19,qtd:8},{matId:18,qtd:3},{matId:12,qtd:1},{matId:72,qtd:1},{matId:23,qtd:1},{matId:8,qtd:1}],
  24: [{matId:33,qtd:1},{matId:10,qtd:1},{matId:5,qtd:1},{matId:70,qtd:2},{matId:24,qtd:15},{matId:31,qtd:40},{matId:19,qtd:15},{matId:18,qtd:6},{matId:12,qtd:2},{matId:72,qtd:3},{matId:23,qtd:1},{matId:8,qtd:1}],
  25: [{matId:33,qtd:1},{matId:10,qtd:1},{matId:5,qtd:1},{matId:70,qtd:3},{matId:24,qtd:20},{matId:31,qtd:50},{matId:19,qtd:20},{matId:18,qtd:8},{matId:12,qtd:2},{matId:72,qtd:4},{matId:23,qtd:1},{matId:8,qtd:1}],
  26: [{matId:33,qtd:1},{matId:10,qtd:1},{matId:5,qtd:1},{matId:70,qtd:2},{matId:24,qtd:15},{matId:31,qtd:40},{matId:19,qtd:15},{matId:18,qtd:6},{matId:12,qtd:2},{matId:72,qtd:3},{matId:23,qtd:1},{matId:8,qtd:1}],
  59: [{matId:33,qtd:1},{matId:10,qtd:1},{matId:5,qtd:1},{matId:55,qtd:1},{matId:56,qtd:0.1},{matId:19,qtd:3},{matId:24,qtd:5},{matId:31,qtd:10},{matId:8,qtd:1},{matId:34,qtd:2}],
  60: [{matId:33,qtd:1},{matId:10,qtd:1},{matId:5,qtd:1},{matId:70,qtd:1},{matId:24,qtd:8},{matId:31,qtd:20},{matId:19,qtd:6},{matId:18,qtd:2},{matId:12,qtd:1},{matId:72,qtd:1},{matId:8,qtd:1}],
  61: [{matId:55,qtd:1},{matId:56,qtd:0.1},{matId:40,qtd:0.2},{matId:37,qtd:2},{matId:8,qtd:1},{matId:34,qtd:1},{matId:69,qtd:1}],
  62: [{matId:55,qtd:1},{matId:14,qtd:0.5},{matId:37,qtd:2},{matId:8,qtd:1},{matId:34,qtd:1}],
  63: [{matId:33,qtd:1},{matId:10,qtd:0.5},{matId:5,qtd:1},{matId:55,qtd:1},{matId:19,qtd:4},{matId:24,qtd:6},{matId:31,qtd:15},{matId:18,qtd:2},{matId:12,qtd:1},{matId:8,qtd:1}],
  64: [{matId:33,qtd:1},{matId:10,qtd:0.5},{matId:5,qtd:1},{matId:72,qtd:1},{matId:55,qtd:1},{matId:19,qtd:3},{matId:8,qtd:1},{matId:34,qtd:1}],
  65: [{matId:33,qtd:1},{matId:10,qtd:1},{matId:5,qtd:1},{matId:70,qtd:1},{matId:24,qtd:8},{matId:31,qtd:20},{matId:8,qtd:1},{matId:34,qtd:2}],
  66: [{matId:33,qtd:2},{matId:10,qtd:1},{matId:6,qtd:1},{matId:86,qtd:1},{matId:27,qtd:1},{matId:30,qtd:6},{matId:4,qtd:1},{matId:8,qtd:1},{matId:34,qtd:2},{matId:11,qtd:1}],
  // ── PERIODONTIA ──
  27: [{matId:16,qtd:20},{matId:38,qtd:4},{matId:8,qtd:1},{matId:34,qtd:2},{matId:35,qtd:1},{matId:20,qtd:1}],
  28: [{matId:33,qtd:1},{matId:10,qtd:1},{matId:5,qtd:1},{matId:16,qtd:20},{matId:38,qtd:4},{matId:8,qtd:1},{matId:34,qtd:2}],
  29: [{matId:33,qtd:1},{matId:10,qtd:1},{matId:5,qtd:1},{matId:86,qtd:1},{matId:27,qtd:1},{matId:30,qtd:6},{matId:38,qtd:4},{matId:4,qtd:1},{matId:8,qtd:1},{matId:34,qtd:2}],
  30: [{matId:33,qtd:1},{matId:10,qtd:1},{matId:5,qtd:1},{matId:86,qtd:1},{matId:27,qtd:1},{matId:30,qtd:6},{matId:38,qtd:4},{matId:4,qtd:1},{matId:8,qtd:1},{matId:34,qtd:2}],
  67: [{matId:33,qtd:2},{matId:10,qtd:1},{matId:6,qtd:1},{matId:86,qtd:1},{matId:27,qtd:1},{matId:30,qtd:8},{matId:38,qtd:6},{matId:8,qtd:1},{matId:34,qtd:2},{matId:11,qtd:1}],
  68: [{matId:33,qtd:2},{matId:10,qtd:1},{matId:6,qtd:1},{matId:86,qtd:1},{matId:27,qtd:1},{matId:30,qtd:8},{matId:38,qtd:6},{matId:8,qtd:1},{matId:34,qtd:2},{matId:11,qtd:1}],
  69: [{matId:33,qtd:2},{matId:10,qtd:1},{matId:6,qtd:1},{matId:86,qtd:1},{matId:27,qtd:1},{matId:80,qtd:0.5},{matId:81,qtd:1},{matId:30,qtd:8},{matId:38,qtd:6},{matId:8,qtd:1},{matId:34,qtd:2}],
  // ── PRÓTESE ──
  31: [{matId:7,qtd:30},{matId:58,qtd:200},{matId:63,qtd:5},{matId:62,qtd:2},{matId:8,qtd:1},{matId:34,qtd:2},{matId:35,qtd:1}],
  32: [{matId:7,qtd:30},{matId:58,qtd:150},{matId:63,qtd:3},{matId:62,qtd:2},{matId:8,qtd:1},{matId:34,qtd:2}],
  33: [{matId:63,qtd:5},{matId:14,qtd:2},{matId:62,qtd:1},{matId:8,qtd:1},{matId:34,qtd:1}],
  34: [{matId:73,qtd:1},{matId:15,qtd:0.5},{matId:66,qtd:2},{matId:38,qtd:3},{matId:8,qtd:1},{matId:34,qtd:2}],
  74: [{matId:66,qtd:2},{matId:60,qtd:5},{matId:15,qtd:0.5},{matId:73,qtd:1},{matId:8,qtd:1},{matId:34,qtd:2}],
  75: [{matId:82,qtd:1},{matId:83,qtd:1},{matId:66,qtd:2},{matId:15,qtd:0.5},{matId:8,qtd:1},{matId:34,qtd:2}],
  76: [{matId:2,qtd:0.3},{matId:15,qtd:0.5},{matId:61,qtd:5},{matId:66,qtd:1},{matId:37,qtd:3},{matId:8,qtd:1},{matId:34,qtd:2}],
  77: [{matId:2,qtd:0.3},{matId:61,qtd:5},{matId:15,qtd:0.5},{matId:66,qtd:1},{matId:8,qtd:1},{matId:34,qtd:2}],
  78: [{matId:40,qtd:0.3},{matId:53,qtd:2},{matId:37,qtd:3},{matId:69,qtd:1},{matId:8,qtd:1},{matId:34,qtd:1}],
  79: [{matId:63,qtd:3},{matId:14,qtd:1},{matId:8,qtd:1},{matId:34,qtd:1}],
  80: [{matId:63,qtd:2},{matId:8,qtd:1},{matId:34,qtd:1}],
  // ── IMPLANTODONTIA ──
  35: [{matId:82,qtd:1},{matId:33,qtd:2},{matId:10,qtd:1},{matId:6,qtd:1},{matId:80,qtd:0.5},{matId:81,qtd:1},{matId:30,qtd:8},{matId:38,qtd:6},{matId:4,qtd:1},{matId:27,qtd:1},{matId:8,qtd:1},{matId:34,qtd:2},{matId:11,qtd:1}],
  36: [{matId:83,qtd:1},{matId:66,qtd:1},{matId:15,qtd:0.5},{matId:33,qtd:1},{matId:30,qtd:4},{matId:8,qtd:1},{matId:34,qtd:2}],
  81: [{matId:80,qtd:1},{matId:81,qtd:1},{matId:33,qtd:2},{matId:10,qtd:1},{matId:6,qtd:1},{matId:27,qtd:1},{matId:30,qtd:6},{matId:38,qtd:4},{matId:8,qtd:1},{matId:34,qtd:2}],
  82: [{matId:80,qtd:1},{matId:81,qtd:1},{matId:33,qtd:2},{matId:10,qtd:1},{matId:6,qtd:1},{matId:27,qtd:1},{matId:30,qtd:6},{matId:8,qtd:1},{matId:34,qtd:2}],
  83: [{matId:82,qtd:1},{matId:33,qtd:1},{matId:10,qtd:1},{matId:5,qtd:1},{matId:30,qtd:4},{matId:27,qtd:1},{matId:8,qtd:1},{matId:34,qtd:2}],
  // ── ORTODONTIA ──
  37: [{matId:43,qtd:1},{matId:48,qtd:0.3},{matId:74,qtd:0.2},{matId:76,qtd:1},{matId:8,qtd:1},{matId:34,qtd:2},{matId:35,qtd:1},{matId:37,qtd:4}],
  38: [{matId:75,qtd:0.3},{matId:46,qtd:1},{matId:8,qtd:1},{matId:34,qtd:1},{matId:37,qtd:2}],
  39: [{matId:60,qtd:5},{matId:14,qtd:2},{matId:33,qtd:1},{matId:10,qtd:1},{matId:5,qtd:1},{matId:8,qtd:1}],
  41: [{matId:7,qtd:30},{matId:58,qtd:100},{matId:8,qtd:1},{matId:34,qtd:1}],
  42: [{matId:7,qtd:20},{matId:8,qtd:1},{matId:34,qtd:1}],
  43: [{matId:43,qtd:1},{matId:48,qtd:0.5},{matId:74,qtd:0.3},{matId:76,qtd:1},{matId:8,qtd:1},{matId:34,qtd:2},{matId:35,qtd:1},{matId:37,qtd:5}],
  44: [{matId:44,qtd:1},{matId:48,qtd:0.5},{matId:74,qtd:0.3},{matId:76,qtd:1},{matId:8,qtd:1},{matId:34,qtd:2},{matId:35,qtd:1},{matId:37,qtd:5}],
  45: [{matId:77,qtd:1},{matId:75,qtd:0.5},{matId:8,qtd:1},{matId:34,qtd:1}],
  46: [{matId:48,qtd:0.1},{matId:37,qtd:2},{matId:8,qtd:1},{matId:34,qtd:1}],
  47: [{matId:38,qtd:4},{matId:30,qtd:2},{matId:8,qtd:1},{matId:34,qtd:1}],
  48: [{matId:48,qtd:0.2},{matId:37,qtd:3},{matId:78,qtd:0.3},{matId:8,qtd:1},{matId:34,qtd:1}],
  49: [{matId:63,qtd:3},{matId:8,qtd:1},{matId:34,qtd:1}],
  50: [{matId:8,qtd:1},{matId:29,qtd:1},{matId:38,qtd:2},{matId:34,qtd:1}],
  51: [{matId:45,qtd:1},{matId:48,qtd:0.5},{matId:74,qtd:0.3},{matId:76,qtd:1},{matId:8,qtd:1},{matId:34,qtd:2},{matId:37,qtd:5}],
  // ── ATM ──
  40: [{matId:90,qtd:0.3},{matId:49,qtd:2},{matId:30,qtd:2},{matId:8,qtd:1},{matId:34,qtd:1}],
  96: [{matId:60,qtd:5},{matId:14,qtd:2},{matId:33,qtd:1},{matId:10,qtd:1},{matId:5,qtd:1},{matId:8,qtd:1}],
  97: [{matId:38,qtd:2},{matId:8,qtd:1},{matId:34,qtd:1}],
  98: [{matId:60,qtd:5},{matId:14,qtd:2},{matId:33,qtd:1},{matId:10,qtd:1},{matId:5,qtd:1},{matId:8,qtd:1}],
  // ── DIAGNÓSTICO ──
  52: [{matId:8,qtd:1},{matId:34,qtd:1},{matId:35,qtd:1},{matId:20,qtd:1}],
  53: [{matId:8,qtd:1},{matId:34,qtd:1}],
  54: [{matId:8,qtd:1},{matId:34,qtd:1}],
  55: [{matId:8,qtd:1},{matId:34,qtd:1}],
  56: [{matId:8,qtd:1},{matId:34,qtd:1}],
  57: [{matId:7,qtd:30},{matId:8,qtd:1},{matId:34,qtd:1}],
  58: [{matId:8,qtd:1},{matId:34,qtd:1}],
  // ── ODONTOPEDIATRIA ──
  88: [{matId:8,qtd:1},{matId:38,qtd:2},{matId:34,qtd:1},{matId:35,qtd:1},{matId:20,qtd:1}],
  89: [{matId:40,qtd:0.2},{matId:85,qtd:1},{matId:37,qtd:2},{matId:38,qtd:2},{matId:8,qtd:1},{matId:34,qtd:1},{matId:69,qtd:1}],
  90: [{matId:33,qtd:1},{matId:10,qtd:0.5},{matId:5,qtd:1},{matId:30,qtd:3},{matId:38,qtd:3},{matId:8,qtd:1},{matId:34,qtd:1}],
  91: [{matId:84,qtd:1},{matId:73,qtd:0.5},{matId:33,qtd:1},{matId:10,qtd:0.5},{matId:5,qtd:1},{matId:38,qtd:2},{matId:8,qtd:1},{matId:34,qtd:1}],
  92: [{matId:7,qtd:20},{matId:58,qtd:100},{matId:33,qtd:1},{matId:10,qtd:0.5},{matId:5,qtd:1},{matId:8,qtd:1},{matId:34,qtd:1}],
  // ── ESTÉTICA FACIAL ──
  99: [{matId:89,qtd:1},{matId:49,qtd:2},{matId:30,qtd:2},{matId:8,qtd:1},{matId:34,qtd:1},{matId:35,qtd:1}],
  100:[{matId:90,qtd:0.5},{matId:49,qtd:3},{matId:30,qtd:2},{matId:8,qtd:1},{matId:34,qtd:1},{matId:35,qtd:1}],
  101:[{matId:33,qtd:2},{matId:10,qtd:1},{matId:6,qtd:1},{matId:86,qtd:1},{matId:27,qtd:1},{matId:30,qtd:6},{matId:8,qtd:1},{matId:34,qtd:2}],
  102:[{matId:88,qtd:1},{matId:49,qtd:2},{matId:30,qtd:2},{matId:8,qtd:1},{matId:34,qtd:1},{matId:35,qtd:1}],
};
// IDs 13 (Manutenção de Facetas), 38 (Manutenção Mensal Orto genérica), 45 (Manutenção — Troca de Fio) não recebem sugador
(function(){const _s=new Set([13,38,45]);Object.keys(DEFAULT_PROC_INSUMOS_DATA).forEach(function(k){if(!_s.has(Number(k)))DEFAULT_PROC_INSUMOS_DATA[k].push({matId:179,qtd:1});});})();

// Procedimentos padrão completos (51 procedimentos do Pétala)
const DEFAULT_PROCS_FIN = [
  {id:1,nome:"Consulta Inicial + Profilaxia",grupo:"Preventivo",tempo:60,insumos:10.43,horaClin:70.85,laboratorio:0,margem:100,precoFinal:175.57},
  {id:2,nome:"Profilaxia simples",grupo:"Preventivo",tempo:45,insumos:10.06,horaClin:53.14,laboratorio:0,margem:100,precoFinal:136.50},
  {id:3,nome:"Aplicação de Flúor",grupo:"Preventivo",tempo:20,insumos:1.94,horaClin:23.62,laboratorio:0,margem:100,precoFinal:55.21},
  {id:4,nome:"Selamento de Fossas e Fissuras",grupo:"Preventivo",tempo:45,insumos:102.06,horaClin:53.14,laboratorio:0,margem:100,precoFinal:335.23},
  {id:5,nome:"Restauração Resina Composta Posterior",grupo:"Dentística",tempo:75,insumos:21.29,horaClin:88.56,laboratorio:0,margem:100,precoFinal:237.29},
  {id:6,nome:"Restauração Resina Composta Anterior",grupo:"Dentística",tempo:90,insumos:24.26,horaClin:106.28,laboratorio:0,margem:100,precoFinal:281.95},
  {id:7,nome:"CIV Mod por Resina",grupo:"Dentística",tempo:60,insumos:16.74,horaClin:70.85,laboratorio:0,margem:100,precoFinal:189.19},
  {id:8,nome:"Facetas de Resina Composta",grupo:"Dentística",tempo:120,insumos:33.49,horaClin:141.70,laboratorio:0,margem:100,precoFinal:378.41},
  {id:9,nome:"Clareamento Caseiro",grupo:"Dentística",tempo:60,insumos:10.44,horaClin:70.85,laboratorio:0,margem:100,precoFinal:175.60},
  {id:10,nome:"Clareamento de Consultório",grupo:"Dentística",tempo:90,insumos:35.44,horaClin:106.28,laboratorio:0,margem:100,precoFinal:306.10},
  {id:11,nome:"Tratamento Dessensibilizante",grupo:"Dentística",tempo:30,insumos:2.17,horaClin:35.43,laboratorio:0,margem:100,precoFinal:81.20},
  {id:12,nome:"Recontornos Estéticos",grupo:"Dentística",tempo:45,insumos:25.10,horaClin:53.14,laboratorio:0,margem:100,precoFinal:169.00},
  {id:13,nome:"Manutenção de Facetas",grupo:"Dentística",tempo:45,insumos:14.82,horaClin:53.14,laboratorio:0,margem:100,precoFinal:146.79},
  {id:14,nome:"Restauração Provisória",grupo:"Dentística",tempo:30,insumos:8.93,horaClin:35.43,laboratorio:0,margem:100,precoFinal:95.81},
  {id:15,nome:"Tratamento Expectante",grupo:"Dentística",tempo:45,insumos:11.45,horaClin:53.14,laboratorio:0,margem:100,precoFinal:139.52},
  {id:16,nome:"Exodontia Simples",grupo:"Cirurgia",tempo:30,insumos:10.55,horaClin:35.43,laboratorio:0,margem:100,precoFinal:99.31},
  {id:17,nome:"Exodontia Complexa",grupo:"Cirurgia",tempo:60,insumos:20.22,horaClin:70.85,laboratorio:0,margem:100,precoFinal:196.72},
  {id:18,nome:"Exodontia de Siso",grupo:"Cirurgia",tempo:90,insumos:51.26,horaClin:106.28,laboratorio:0,margem:100,precoFinal:340.28},
  {id:19,nome:"Cirurgia Parendodôntica",grupo:"Cirurgia",tempo:120,insumos:57.05,horaClin:141.70,laboratorio:0,margem:100,precoFinal:429.31},
  {id:20,nome:"Biópsia",grupo:"Cirurgia",tempo:45,insumos:29.31,horaClin:53.14,laboratorio:0,margem:100,precoFinal:178.09},
  {id:21,nome:"Urgência Endodôntica",grupo:"Endodontia",tempo:60,insumos:9.44,horaClin:70.85,laboratorio:0,margem:100,precoFinal:173.42},
  {id:22,nome:"Endodontia - Necro (1 canal)",grupo:"Endodontia",tempo:180,insumos:72.20,horaClin:212.55,laboratorio:0,margem:100,precoFinal:615.07},
  {id:23,nome:"Endodontia - Vital (1 canal)",grupo:"Endodontia",tempo:150,insumos:68.23,horaClin:177.13,laboratorio:0,margem:100,precoFinal:529.98},
  {id:24,nome:"Endodontia - 2 canais",grupo:"Endodontia",tempo:240,insumos:127.82,horaClin:283.41,laboratorio:0,margem:100,precoFinal:888.24},
  {id:25,nome:"Endodontia - 3 canais",grupo:"Endodontia",tempo:300,insumos:190.02,horaClin:354.26,laboratorio:0,margem:100,precoFinal:1175.65},
  {id:26,nome:"Retratamento Endodôntico",grupo:"Endodontia",tempo:300,insumos:196.88,horaClin:354.26,laboratorio:0,margem:100,precoFinal:1190.47},
  {id:27,nome:"Raspagem Supragengival",grupo:"Periodontia",tempo:60,insumos:2.54,horaClin:70.85,laboratorio:0,margem:100,precoFinal:158.52},
  {id:28,nome:"Raspagem Subgengival por Sextante",grupo:"Periodontia",tempo:60,insumos:5.48,horaClin:70.85,laboratorio:0,margem:100,precoFinal:164.88},
  {id:29,nome:"Gengivoplastia",grupo:"Periodontia",tempo:75,insumos:37.75,horaClin:88.56,laboratorio:0,margem:100,precoFinal:272.84},
  {id:30,nome:"Frenectomia",grupo:"Periodontia",tempo:60,insumos:40.81,horaClin:70.85,laboratorio:0,margem:100,precoFinal:241.20},
  {id:31,nome:"Prótese Total",grupo:"Prótese",tempo:60,insumos:6.68,horaClin:70.85,laboratorio:200,margem:100,precoFinal:167.46},
  {id:32,nome:"Prótese Parcial Removível",grupo:"Prótese",tempo:60,insumos:5.89,horaClin:70.85,laboratorio:180,margem:100,precoFinal:165.76},
  {id:33,nome:"Coroa Provisória",grupo:"Prótese",tempo:75,insumos:17.41,horaClin:88.56,laboratorio:0,margem:100,precoFinal:228.90},
  {id:34,nome:"Cimentação de Coroa",grupo:"Prótese",tempo:45,insumos:25.67,horaClin:53.14,laboratorio:0,margem:100,precoFinal:170.22},
  {id:35,nome:"Implante Cirúrgico",grupo:"Implantodontia",tempo:120,insumos:70.70,horaClin:141.70,laboratorio:0,margem:100,precoFinal:458.79},
  {id:36,nome:"Implante - Fase Protética",grupo:"Implantodontia",tempo:90,insumos:19.54,horaClin:106.28,laboratorio:250,margem:100,precoFinal:271.77},
  {id:37,nome:"Instalação de Aparelho Fixo (genérico)",grupo:"Ortodontia - Instalação",tempo:90,insumos:19.59,horaClin:106.28,laboratorio:0,margem:100,precoFinal:271.87},
  {id:38,nome:"Manutenção Mensal Ortodôntica (genérica)",grupo:"Ortodontia - Manutenção Mensal",tempo:30,insumos:2.06,horaClin:35.43,laboratorio:0,margem:100,precoFinal:80.98},
  {id:39,nome:"Placa Miorrelaxante",grupo:"ATM",tempo:75,insumos:10.13,horaClin:88.56,laboratorio:120,margem:100,precoFinal:213.19},
  {id:40,nome:"Toxina Botulínica (Bruxismo)",grupo:"ATM",tempo:30,insumos:2.58,horaClin:35.43,laboratorio:0,margem:100,precoFinal:82.09},
  {id:41,nome:"Documentação Ortodôntica",grupo:"Ortodontia",tempo:60,insumos:1.69,horaClin:70.85,laboratorio:0,margem:100,precoFinal:156.68},
  {id:42,nome:"Moldagem Ortodôntica",grupo:"Ortodontia",tempo:30,insumos:6.68,horaClin:35.43,laboratorio:0,margem:100,precoFinal:90.94},
  {id:43,nome:"Instalação Aparelho Metálico Tradicional",grupo:"Ortodontia - Instalação",tempo:120,insumos:251.72,horaClin:141.70,laboratorio:400,margem:100,precoFinal:849.79},
  {id:44,nome:"Instalação Aparelho Estético Cerâmico",grupo:"Ortodontia - Instalação",tempo:120,insumos:482.60,horaClin:141.70,laboratorio:800,margem:100,precoFinal:1348.50},
  {id:45,nome:"Manutenção Mensal — Troca de Fio (genérica)",grupo:"Ortodontia - Manutenção Mensal",tempo:30,insumos:11.64,horaClin:35.43,laboratorio:0,margem:100,precoFinal:101.65},
  {id:46,nome:"Recolagem (peça quebrada) — Genérica",grupo:"Ortodontia - Recolagem",tempo:20,insumos:13.99,horaClin:23.62,laboratorio:0,margem:100,precoFinal:81.23},
  {id:47,nome:"Remoção de Aparelho Fixo",grupo:"Ortodontia",tempo:60,insumos:24.00,horaClin:70.85,laboratorio:0,margem:100,precoFinal:204.88},
  {id:48,nome:"Contenção Fixa (Fio Colado)",grupo:"Ortodontia",tempo:45,insumos:13.69,horaClin:53.14,laboratorio:0,margem:100,precoFinal:144.35},
  {id:49,nome:"Contenção Removível (Placa Essix)",grupo:"Ortodontia",tempo:30,insumos:15.58,horaClin:35.43,laboratorio:150,margem:100,precoFinal:110.17},
  {id:50,nome:"Orientação e Higiene com Aparelho",grupo:"Ortodontia",tempo:20,insumos:4.21,horaClin:23.62,laboratorio:0,margem:100,precoFinal:60.11},
  {id:51,nome:"Instalação Aparelho Metálico Autoligado",grupo:"Ortodontia - Instalação",tempo:120,insumos:384.03,horaClin:141.70,laboratorio:600,margem:100,precoFinal:1135.58},
  // Diagnóstico e Radiologia
  {id:52,nome:"Consulta Odontológica",grupo:"Diagnóstico",tempo:30,insumos:2.00,horaClin:35.43,laboratorio:0,margem:100,precoFinal:80.00},
  {id:53,nome:"Radiografia Periapical",grupo:"Diagnóstico",tempo:15,insumos:3.00,horaClin:17.71,laboratorio:0,margem:100,precoFinal:50.00},
  {id:54,nome:"Radiografia Panorâmica",grupo:"Diagnóstico",tempo:20,insumos:5.00,horaClin:23.62,laboratorio:0,margem:100,precoFinal:120.00},
  {id:55,nome:"Radiografia Interproximal (Bite-Wing)",grupo:"Diagnóstico",tempo:15,insumos:3.00,horaClin:17.71,laboratorio:0,margem:100,precoFinal:45.00},
  {id:56,nome:"Tomografia Cone Beam",grupo:"Diagnóstico",tempo:30,insumos:10.00,horaClin:35.43,laboratorio:0,margem:100,precoFinal:350.00},
  {id:57,nome:"Documentação Ortodôntica Completa",grupo:"Diagnóstico",tempo:60,insumos:15.00,horaClin:70.85,laboratorio:0,margem:100,precoFinal:350.00},
  {id:58,nome:"Fotografias Clínicas",grupo:"Diagnóstico",tempo:20,insumos:2.00,horaClin:23.62,laboratorio:0,margem:100,precoFinal:60.00},
  // Endodontia complementar
  {id:59,nome:"Pulpotomia",grupo:"Endodontia",tempo:45,insumos:15.00,horaClin:53.14,laboratorio:0,margem:100,precoFinal:150.00},
  {id:60,nome:"Pulpectomia",grupo:"Endodontia",tempo:60,insumos:20.00,horaClin:70.85,laboratorio:0,margem:100,precoFinal:180.00},
  {id:61,nome:"Capeamento Pulpar Direto",grupo:"Endodontia",tempo:45,insumos:18.00,horaClin:53.14,laboratorio:0,margem:100,precoFinal:160.00},
  {id:62,nome:"Capeamento Pulpar Indireto",grupo:"Endodontia",tempo:30,insumos:10.00,horaClin:35.43,laboratorio:0,margem:100,precoFinal:100.00},
  {id:63,nome:"Tratamento Endodôntico Dente Decíduo",grupo:"Endodontia",tempo:60,insumos:18.00,horaClin:70.85,laboratorio:0,margem:100,precoFinal:200.00},
  {id:64,nome:"Curativo de Demora",grupo:"Endodontia",tempo:30,insumos:8.00,horaClin:35.43,laboratorio:0,margem:100,precoFinal:100.00},
  {id:65,nome:"Remoção de Núcleo Intrarradicular",grupo:"Endodontia",tempo:60,insumos:25.00,horaClin:70.85,laboratorio:0,margem:100,precoFinal:220.00},
  {id:66,nome:"Apicectomia com Obturação Retrógrada",grupo:"Endodontia",tempo:90,insumos:45.00,horaClin:106.28,laboratorio:0,margem:100,precoFinal:380.00},
  // Periodontia complementar
  {id:67,nome:"Cirurgia Periodontal a Retalho",grupo:"Periodontia",tempo:90,insumos:45.00,horaClin:106.28,laboratorio:0,margem:100,precoFinal:380.00},
  {id:68,nome:"Enxerto Gengival Livre",grupo:"Periodontia",tempo:90,insumos:30.00,horaClin:106.28,laboratorio:0,margem:100,precoFinal:450.00},
  {id:69,nome:"Enxerto de Tecido Conjuntivo",grupo:"Periodontia",tempo:120,insumos:40.00,horaClin:141.70,laboratorio:0,margem:100,precoFinal:600.00},
  {id:70,nome:"Aplicação de Cariostático",grupo:"Preventivo",tempo:20,insumos:5.00,horaClin:23.62,laboratorio:0,margem:100,precoFinal:60.00},
  {id:71,nome:"Controle de Placa Bacteriana",grupo:"Preventivo",tempo:30,insumos:3.00,horaClin:35.43,laboratorio:0,margem:100,precoFinal:80.00},
  {id:72,nome:"Remineralização Dentária",grupo:"Preventivo",tempo:30,insumos:8.00,horaClin:35.43,laboratorio:0,margem:100,precoFinal:90.00},
  {id:73,nome:"Orientação de Higiene Bucal",grupo:"Preventivo",tempo:20,insumos:2.00,horaClin:23.62,laboratorio:0,margem:100,precoFinal:55.00},
  // Prótese complementar
  {id:74,nome:"Prótese Fixa Unitária (Coroa)",grupo:"Prótese",tempo:120,insumos:30.00,horaClin:141.70,laboratorio:500,margem:100,precoFinal:850.00},
  {id:75,nome:"Prótese sobre Implante",grupo:"Prótese",tempo:90,insumos:25.00,horaClin:106.28,laboratorio:600,margem:100,precoFinal:950.00},
  {id:76,nome:"Faceta Cerâmica",grupo:"Prótese",tempo:90,insumos:20.00,horaClin:106.28,laboratorio:400,margem:100,precoFinal:750.00},
  {id:77,nome:"Inlay / Onlay Cerâmico",grupo:"Prótese",tempo:90,insumos:25.00,horaClin:106.28,laboratorio:350,margem:100,precoFinal:680.00},
  {id:78,nome:"Núcleo de Preenchimento",grupo:"Prótese",tempo:45,insumos:20.00,horaClin:53.14,laboratorio:0,margem:100,precoFinal:180.00},
  {id:79,nome:"Reembasamento de Prótese",grupo:"Prótese",tempo:45,insumos:25.00,horaClin:53.14,laboratorio:80,margem:100,precoFinal:220.00},
  {id:80,nome:"Reparação de Prótese",grupo:"Prótese",tempo:30,insumos:15.00,horaClin:35.43,laboratorio:50,margem:100,precoFinal:130.00},
  // Implantodontia complementar
  {id:81,nome:"Enxerto Ósseo",grupo:"Implantodontia",tempo:120,insumos:200.00,horaClin:141.70,laboratorio:0,margem:100,precoFinal:800.00},
  {id:82,nome:"Levantamento de Seio Maxilar",grupo:"Implantodontia",tempo:120,insumos:250.00,horaClin:141.70,laboratorio:0,margem:100,precoFinal:1200.00},
  {id:83,nome:"Instalação de Mini-implante",grupo:"Implantodontia",tempo:60,insumos:80.00,horaClin:70.85,laboratorio:0,margem:100,precoFinal:400.00},
  // Cirurgia complementar
  {id:84,nome:"Frenectomia Lingual",grupo:"Cirurgia",tempo:45,insumos:30.00,horaClin:53.14,laboratorio:0,margem:100,precoFinal:200.00},
  {id:85,nome:"Drenagem de Abscesso",grupo:"Cirurgia",tempo:30,insumos:20.00,horaClin:35.43,laboratorio:0,margem:100,precoFinal:150.00},
  {id:86,nome:"Remoção de Cisto",grupo:"Cirurgia",tempo:60,insumos:35.00,horaClin:70.85,laboratorio:0,margem:100,precoFinal:350.00},
  {id:87,nome:"Alveoloplastia",grupo:"Cirurgia",tempo:60,insumos:25.00,horaClin:70.85,laboratorio:0,margem:100,precoFinal:280.00},
  // Odontopediatria
  {id:88,nome:"Consulta Odontopediátrica",grupo:"Odontopediatria",tempo:30,insumos:3.00,horaClin:35.43,laboratorio:0,margem:100,precoFinal:90.00},
  {id:89,nome:"Restauração Dente Decíduo",grupo:"Odontopediatria",tempo:45,insumos:12.00,horaClin:53.14,laboratorio:0,margem:100,precoFinal:130.00},
  {id:90,nome:"Exodontia Dente Decíduo",grupo:"Odontopediatria",tempo:20,insumos:8.00,horaClin:23.62,laboratorio:0,margem:100,precoFinal:80.00},
  {id:91,nome:"Coroa de Aço Inoxidável",grupo:"Odontopediatria",tempo:45,insumos:35.00,horaClin:53.14,laboratorio:0,margem:100,precoFinal:180.00},
  {id:92,nome:"Mantenedor de Espaço",grupo:"Odontopediatria",tempo:45,insumos:20.00,horaClin:53.14,laboratorio:80,margem:100,precoFinal:220.00},
  // Dentística complementar
  {id:93,nome:"Clareamento Dente Desvitalizado",grupo:"Dentística",tempo:45,insumos:15.00,horaClin:53.14,laboratorio:0,margem:100,precoFinal:160.00},
  {id:94,nome:"Restauração com Amálgama",grupo:"Dentística",tempo:45,insumos:8.00,horaClin:53.14,laboratorio:0,margem:100,precoFinal:120.00},
  {id:95,nome:"Fechamento de Diastema",grupo:"Dentística",tempo:90,insumos:30.00,horaClin:106.28,laboratorio:0,margem:100,precoFinal:350.00},
  // ATM complementar
  {id:96,nome:"Desprogramador Oclusal",grupo:"ATM",tempo:60,insumos:15.00,horaClin:70.85,laboratorio:0,margem:100,precoFinal:200.00},
  {id:97,nome:"Ajuste Oclusal",grupo:"ATM",tempo:45,insumos:5.00,horaClin:53.14,laboratorio:0,margem:100,precoFinal:140.00},
  {id:98,nome:"Terapia de Bruxismo",grupo:"ATM",tempo:60,insumos:10.00,horaClin:70.85,laboratorio:120,margem:100,precoFinal:300.00},
  // Estética Facial
  {id:99,nome:"Preenchimento Labial",grupo:"Estética Facial",tempo:45,insumos:150.00,horaClin:53.14,laboratorio:0,margem:100,precoFinal:600.00},
  {id:100,nome:"Toxina Botulínica (Estético)",grupo:"Estética Facial",tempo:30,insumos:120.00,horaClin:35.43,laboratorio:0,margem:100,precoFinal:550.00},
  {id:101,nome:"Bichectomia",grupo:"Estética Facial",tempo:60,insumos:40.00,horaClin:70.85,laboratorio:0,margem:100,precoFinal:400.00},
  {id:102,nome:"Bioestimulador de Colágeno",grupo:"Estética Facial",tempo:45,insumos:200.00,horaClin:53.14,laboratorio:0,margem:100,precoFinal:800.00},
];

// 50 materiais padrão do Pétala
const DEFAULT_MATS_FIN = [
  {id:1,nome:"Ácido Fosfórico Ultradent",cat:"Dentística",unid:"ml",qtde:30,preco:218.15,custo:7.27},
  {id:2,nome:"Ácido Fluorídrico",cat:"Dentística",unid:"ml",qtde:2.5,preco:32.97,custo:13.19},
  {id:3,nome:"Ácido Poliacrílico",cat:"Dentística",unid:"ml",qtde:10,preco:79.44,custo:7.94},
  {id:4,nome:"Ácido Tranexâmico",cat:"Cirurgia",unid:"UNID",qtde:12,preco:38.99,custo:3.25},
  {id:5,nome:"Agulha Curta",cat:"Geral",unid:"UNID",qtde:100,preco:48.40,custo:0.48},
  {id:6,nome:"Agulha Longa",cat:"Geral",unid:"UNID",qtde:100,preco:48.40,custo:0.48},
  {id:7,nome:"Alginato Tipo I Dentsply",cat:"Prótese",unid:"Grama",qtde:410,preco:32.00,custo:0.08},
  {id:8,nome:"Babador",cat:"Geral",unid:"unid",qtde:100,preco:24.90,custo:0.25},
  {id:9,nome:"Barreira Gengival Gingi Dam",cat:"Dentística",unid:"grama",qtde:3,preco:16.48,custo:5.49},
  {id:10,nome:"Benzocaína 20% Pomada",cat:"Anestesia",unid:"grama",qtde:30,preco:19.99,custo:0.67},
  {id:11,nome:"Campo Estéril",cat:"Cirurgia",unid:"unid",qtde:1,preco:18.99,custo:18.99},
  {id:12,nome:"Cimento Endodôntico",cat:"Endodontia",unid:"Grama",qtde:4,preco:47.52,custo:11.88},
  {id:13,nome:"Cimento Ionômero de Vidro",cat:"Dentística",unid:"Porção",qtde:30,preco:77.59,custo:2.59},
  {id:14,nome:"Cimento Provisório Cotosol",cat:"Prótese",unid:"grama",qtde:38,preco:53.25,custo:1.40},
  {id:15,nome:"Cimento Resinoso RIVA",cat:"Dentística",unid:"Porção",qtde:20,preco:290.00,custo:14.50},
  {id:16,nome:"Clorexidina 0.12%",cat:"Geral",unid:"ml",qtde:250,preco:10.66,custo:0.04},
  {id:17,nome:"Clorexidina 2%",cat:"Cirurgia",unid:"ml",qtde:1000,preco:26.09,custo:0.03},
  {id:18,nome:"Cone de Guta Percha",cat:"Endodontia",unid:"UNID",qtde:120,preco:34.91,custo:0.29},
  {id:19,nome:"Cones de Papel",cat:"Endodontia",unid:"unid",qtde:300,preco:19.39,custo:0.06},
  {id:20,nome:"Copo Descartável 50ml",cat:"Geral",unid:"unid",qtde:300,preco:49.99,custo:0.17},
  {id:21,nome:"Cunhas de Plástico",cat:"Dentística",unid:"unid",qtde:40,preco:45.90,custo:1.15},
  {id:22,nome:"Discos de Lixa Sof-lex",cat:"Dentística",unid:"unid",qtde:30,preco:155.19,custo:5.17},
  {id:23,nome:"Diques de Borracha",cat:"Geral",unid:"unid",qtde:36,preco:76.90,custo:2.14},
  {id:24,nome:"EDTA",cat:"Endodontia",unid:"ml",qtde:20,preco:9.60,custo:0.48},
  {id:25,nome:"Escova Robinson",cat:"Profilaxia",unid:"unid",qtde:1,preco:7.75,custo:7.75},
  {id:26,nome:"Esponja Hemostática Fibrina",cat:"Cirurgia",unid:"unid",qtde:10,preco:69.83,custo:6.98},
  {id:27,nome:"Fio de Sutura Absorvível",cat:"Cirurgia",unid:"UNID",qtde:36,preco:387.02,custo:10.75},
  {id:28,nome:"Fio de Sutura Seda",cat:"Cirurgia",unid:"UNID",qtde:24,preco:52.37,custo:2.18},
  {id:29,nome:"Fio Dental Comum",cat:"Geral",unid:"m",qtde:100,preco:15.00,custo:0.15},
  {id:30,nome:"Gaze Estéril",cat:"Geral",unid:"unid",qtde:500,preco:20.36,custo:0.04},
  {id:31,nome:"Hipoclorito de Sódio",cat:"Endodontia",unid:"ml",qtde:1000,preco:9.59,custo:0.01},
  {id:32,nome:"Kit de Limas",cat:"Endodontia",unid:"unid",qtde:6,preco:300.00,custo:50.00},
  {id:33,nome:"Lidocaína 2% c/ Epinefrina",cat:"Anestesia",unid:"UNID",qtde:50,preco:129.88,custo:2.60},
  {id:34,nome:"Luva Nitrílica",cat:"Geral",unid:"unid",qtde:100,preco:43.99,custo:0.44},
  {id:35,nome:"Máscara",cat:"Geral",unid:"unid",qtde:50,preco:18.42,custo:0.37},
  {id:36,nome:"Matriz Metálica Pré-fabricada",cat:"Dentística",unid:"unid",qtde:50,preco:193.02,custo:3.86},
  {id:37,nome:"Microbrush",cat:"Dentística",unid:"unid",qtde:100,preco:15.42,custo:0.15},
  {id:38,nome:"Roletes de Algodão",cat:"Geral",unid:"unid",qtde:500,preco:10.66,custo:0.02},
  {id:39,nome:"Selante de Fossas",cat:"Dentística",unid:"unid",qtde:1,preco:89.90,custo:89.90},
  {id:40,nome:"Sistema Adesivo Kerr",cat:"Dentística",unid:"unid",qtde:16,preco:505.27,custo:31.58},
  {id:41,nome:"Tiras de Lixa Epitex",cat:"Dentística",unid:"unid",qtde:1000,preco:256.95,custo:0.26},
  {id:42,nome:"Touca Descartável",cat:"Geral",unid:"unid",qtde:100,preco:17.36,custo:0.17},
  {id:43,nome:"Braquete Metálico Kit",cat:"Ortodontia",unid:"kit",qtde:1,preco:189.00,custo:189.00},
  {id:44,nome:"Braquete Estético Cerâmico Kit",cat:"Ortodontia",unid:"kit",qtde:1,preco:420.00,custo:420.00},
  {id:45,nome:"Braquete Autoligado Metálico Kit",cat:"Ortodontia",unid:"kit",qtde:1,preco:320.00,custo:320.00},
  {id:46,nome:"Fio Ortodôntico NiTi 0.014",cat:"Ortodontia",unid:"unid",qtde:10,preco:9.50,custo:0.95},
  {id:47,nome:"Fio Ortodôntico NiTi 0.016",cat:"Ortodontia",unid:"unid",qtde:10,preco:9.50,custo:0.95},
  {id:48,nome:"Adesivo Ortodôntico Transbond XT",cat:"Ortodontia",unid:"ml",qtde:5,preco:189.90,custo:37.98},
  {id:49,nome:"Seringa 3ml",cat:"Geral",unid:"unid",qtde:120,preco:20.36,custo:0.17},
  {id:50,nome:"Vaselina Sólida",cat:"Geral",unid:"unid",qtde:30,preco:10.57,custo:0.35},
  // Materiais adicionais
  {id:51,nome:"Resina Composta A1",cat:"Dentística",unid:"grama",qtde:4,preco:85.00,custo:21.25},
  {id:52,nome:"Resina Composta A2",cat:"Dentística",unid:"grama",qtde:4,preco:85.00,custo:21.25},
  {id:53,nome:"Resina Composta A3",cat:"Dentística",unid:"grama",qtde:4,preco:85.00,custo:21.25},
  {id:54,nome:"Resina Composta A3.5",cat:"Dentística",unid:"grama",qtde:4,preco:85.00,custo:21.25},
  {id:55,nome:"Hidróxido de Cálcio",cat:"Endodontia",unid:"grama",qtde:25,preco:32.00,custo:1.28},
  {id:56,nome:"MTA (Mineral Trióxido Agregado)",cat:"Endodontia",unid:"grama",qtde:1,preco:180.00,custo:180.00},
  {id:57,nome:"Amálgama dental",cat:"Dentística",unid:"cápsula",qtde:50,preco:145.00,custo:2.90},
  {id:58,nome:"Gesso Tipo III",cat:"Prótese",unid:"kg",qtde:1,preco:22.00,custo:22.00},
  {id:59,nome:"Gesso Tipo IV",cat:"Prótese",unid:"kg",qtde:1,preco:55.00,custo:55.00},
  {id:60,nome:"Silicone de Condensação",cat:"Prótese",unid:"kit",qtde:1,preco:120.00,custo:120.00},
  {id:61,nome:"Silicone de Adição",cat:"Prótese",unid:"kit",qtde:1,preco:280.00,custo:280.00},
  {id:62,nome:"Cera Utilidade",cat:"Prótese",unid:"unid",qtde:20,preco:15.00,custo:0.75},
  {id:63,nome:"Resina Acrílica Autopolimerizável",cat:"Prótese",unid:"kit",qtde:1,preco:45.00,custo:45.00},
  {id:64,nome:"Gel Clareador 35%",cat:"Dentística",unid:"unid",qtde:3,preco:89.00,custo:29.67},
  {id:65,nome:"Gel Clareador Caseiro 10%",cat:"Dentística",unid:"seringa",qtde:4,preco:45.00,custo:11.25},
  {id:66,nome:"Fio Retrator Gengival",cat:"Prótese",unid:"m",qtde:270,preco:35.00,custo:0.13},
  {id:67,nome:"Pasta Profilática",cat:"Profilaxia",unid:"pote",qtde:1,preco:18.00,custo:18.00},
  {id:68,nome:"Bicarbonato de Sódio (jato)",cat:"Profilaxia",unid:"kg",qtde:1,preco:12.00,custo:12.00},
  {id:69,nome:"Fotopolimerizador LED (ponta)",cat:"Dentística",unid:"unid",qtde:1,preco:25.00,custo:25.00},
  {id:70,nome:"Ligas de Titânio (limas rotatórias)",cat:"Endodontia",unid:"unid",qtde:1,preco:180.00,custo:180.00},
  {id:71,nome:"Óxido de Zinco e Eugenol",cat:"Dentística",unid:"kit",qtde:1,preco:38.00,custo:38.00},
  {id:72,nome:"Hidróxido de Cálcio em Pó",cat:"Endodontia",unid:"grama",qtde:50,preco:28.00,custo:0.56},
  {id:73,nome:"Cimento Fosfato de Zinco",cat:"Prótese",unid:"kit",qtde:1,preco:42.00,custo:42.00},
  {id:74,nome:"Primer Ortodôntico",cat:"Ortodontia",unid:"frasco",qtde:1,preco:95.00,custo:95.00},
  {id:75,nome:"Elástico Ortodôntico",cat:"Ortodontia",unid:"pacote",qtde:1,preco:12.00,custo:12.00},
  {id:76,nome:"Arco NiTi 0.012",cat:"Ortodontia",unid:"unid",qtde:10,preco:8.73,custo:0.87},
  {id:77,nome:"Arco NiTi 0.014x0.025",cat:"Ortodontia",unid:"unid",qtde:10,preco:9.50,custo:0.95},
  {id:78,nome:"Arco de Aço 0.019x0.025",cat:"Ortodontia",unid:"unid",qtde:10,preco:8.73,custo:0.87},
  {id:79,nome:"Mola de Níquel-Titânio",cat:"Ortodontia",unid:"unid",qtde:5,preco:45.00,custo:9.00},
  {id:80,nome:"Biomaterial de Enxerto Ósseo",cat:"Cirurgia",unid:"grama",qtde:0.5,preco:350.00,custo:700.00},
  {id:81,nome:"Membrana Reabsorvível (colágeno)",cat:"Cirurgia",unid:"unid",qtde:1,preco:180.00,custo:180.00},
  {id:82,nome:"Implante Osseointegrado",cat:"Implantodontia",unid:"unid",qtde:1,preco:800.00,custo:800.00},
  {id:83,nome:"Cicatrizador de Implante",cat:"Implantodontia",unid:"unid",qtde:1,preco:80.00,custo:80.00},
  {id:84,nome:"Coroa de Aço Inox (pediátrica)",cat:"Odontopediatria",unid:"kit",qtde:10,preco:95.00,custo:9.50},
  {id:85,nome:"Ionômero de Vidro Modificado",cat:"Dentística",unid:"kit",qtde:1,preco:65.00,custo:65.00},
  {id:86,nome:"Bisturi Descartável",cat:"Cirurgia",unid:"unid",qtde:10,preco:28.00,custo:2.80},
  {id:87,nome:"Porta Amálgama",cat:"Dentística",unid:"unid",qtde:1,preco:15.00,custo:15.00},
  {id:88,nome:"Ácido Polilático (bioestimulador)",cat:"Estética Facial",unid:"frasco",qtde:1,preco:450.00,custo:450.00},
  {id:89,nome:"Hialuronato de Sódio (preenchedor)",cat:"Estética Facial",unid:"seringa",qtde:1,preco:380.00,custo:380.00},
  {id:90,nome:"Toxina Botulínica 100U",cat:"Estética Facial",unid:"frasco",qtde:1,preco:650.00,custo:650.00},
];

// 6 combos promocionais padrão
const DEFAULT_COMBOS_FIN = []; // Cada clínica cria seus próprios combos



// ══════════════════════════════════════════════════════
// VENDA RÁPIDA
// ══════════════════════════════════════════════════════
let vrCarrinho = []; // [{procId, nome, preco, qtd}]
let vrPagamento = 'pix';
let vrCatAtiva = '';

// ── VENDA RÁPIDA MOBILE ──
let vrPagamentoMobile = 'pix';

function vrFiltrarMobile(){
  const q=(document.getElementById('vr-search-m')?.value||'').toLowerCase();
  const drop=document.getElementById('vr-dropdown'); if(!drop) return;
  if(!q){ drop.style.display='none'; return; }
  drop.style.display='flex';
  const filtrados=procs.filter(p=>p.ativo!==false&&_norm(p.nome).includes(_norm(q))).slice(0,8);
  if(!filtrados.length){ drop.innerHTML='<div style="padding:14px;text-align:center;color:var(--rose-light);font-size:13px;">Nenhum resultado</div>'; return; }
  drop.innerHTML=filtrados.map(p=>{
    const preco=parseFloat(p.precoFinal||p.preco||0);
    const noCarrinho=vrCarrinho.find(i=>i.procId===p.id);
    return `<div onclick="vrAddItemMobile(${p.id})" style="display:flex;align-items:center;gap:12px;padding:12px 16px;cursor:pointer;border-bottom:1px solid var(--rose-lighter);${noCarrinho?'background:var(--rose-lighter);':''}">
      <div style="flex:1;"><div style="font-size:14px;font-weight:700;color:var(--rose-dark);">${escapeHtml(p.nome)}</div><div style="font-size:12px;color:var(--rose-text);">${escapeHtml(p.cat||p.categoria||'Geral')}</div></div>
      <div style="font-size:15px;font-weight:800;color:var(--rose);">${fmtBRL(preco)}</div>
      <div style="width:28px;height:28px;background:${noCarrinho?'var(--rose-dark)':'var(--rose-lighter)'};border-radius:8px;display:flex;align-items:center;justify-content:center;">
        <i class="ti ${noCarrinho?'ti-check':'ti-plus'}" style="font-size:14px;color:${noCarrinho?'#fff':'var(--rose-dark)'};"></i>
      </div>
    </div>`;
  }).join('');
}

function vrAddItemMobile(procId){
  const proc=procs.find(p=>p.id===procId); if(!proc) return;
  const preco=parseFloat(proc.precoFinal||proc.preco||0);
  const exist=vrCarrinho.find(i=>i.procId===procId);
  if(exist){ exist.qtd++; } else { vrCarrinho.push({procId,nome:proc.nome,preco,qtd:1}); }
  vrRenderCarrinhoMobile(); vrCalcTotalMobile();
  document.getElementById('vr-search-m').value='';
  document.getElementById('vr-dropdown').style.display='none';
}

function vrRemItemMobile(procId){ vrCarrinho=vrCarrinho.filter(i=>i.procId!==procId); vrRenderCarrinhoMobile(); vrCalcTotalMobile(); }

function vrSetQtdMobile(procId,val){
  const item=vrCarrinho.find(i=>i.procId===procId); if(!item) return;
  const n=parseInt(val)||1;
  if(n<=0){ vrRemItemMobile(procId); return; }
  item.qtd=n; vrRenderCarrinhoMobile(); vrCalcTotalMobile();
}

function vrRenderCarrinhoMobile(){
  const wrap=document.getElementById('vr-carrinho-m'); if(!wrap) return;
  const cnt=document.getElementById('vr-count-m'); if(cnt) cnt.textContent=vrCarrinho.reduce((a,i)=>a+i.qtd,0);
  if(!vrCarrinho.length){ wrap.innerHTML=''; return; }
  wrap.innerHTML=vrCarrinho.map(item=>`
    <div style="background:#fff;border:1.5px solid var(--rose-light);border-radius:14px;padding:12px 14px;">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:8px;">
        <div style="font-size:14px;font-weight:700;color:var(--rose-dark);flex:1;">${escapeHtml(item.nome)}</div>
        <button onclick="vrRemItemMobile(${item.procId})" style="border:none;background:none;color:#c0392b;font-size:20px;cursor:pointer;padding:0;">×</button>
      </div>
      <div style="display:flex;align-items:center;justify-content:space-between;">
        <div style="display:flex;align-items:center;gap:10px;">
          <button onclick="vrSetQtdMobile(${item.procId},${item.qtd-1})" style="width:32px;height:32px;border:1.5px solid var(--rose-light);border-radius:8px;background:var(--rose-lighter);color:var(--rose-dark);font-size:18px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;">−</button>
          <span style="font-size:16px;font-weight:800;color:var(--rose-dark);min-width:24px;text-align:center;">${item.qtd}</span>
          <button onclick="vrSetQtdMobile(${item.procId},${item.qtd+1})" style="width:32px;height:32px;border:1.5px solid var(--rose-light);border-radius:8px;background:var(--rose-lighter);color:var(--rose-dark);font-size:18px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;">+</button>
          <span style="font-size:11px;color:var(--rose-text);">${fmtBRL(item.preco)}/un</span>
        </div>
        <span style="font-size:15px;font-weight:900;color:var(--rose);">${fmtBRL(item.preco*item.qtd)}</span>
      </div>
    </div>`).join('');
}

function vrCalcTotalMobile(){
  const subtotal=vrCarrinho.reduce((a,i)=>a+i.preco*i.qtd,0);
  const descTipo=document.getElementById('vr-desc-tipo-m')?.value||'nenhum';
  const descVal=parseFloat(document.getElementById('vr-desc-val-m')?.value)||0;
  let descAmt=0;
  if(descTipo==='pct') descAmt=subtotal*(descVal/100);
  if(descTipo==='fixo') descAmt=Math.min(descVal,subtotal);
  const aposDesc=subtotal-descAmt;
  const parcelas=parseInt(document.getElementById('vr-parcelas-m')?.value)||1;
  const taxaAmt=vrCalcTaxaAmt(aposDesc,vrPagamentoMobile,parcelas);
  const total=aposDesc+taxaAmt;
  const entrada=parseFloat(document.getElementById('vr-entrada-m')?.value)||0;
  const restante=Math.max(0,total-entrada);
  const e1=document.getElementById('vr-sub-m'); if(e1) e1.textContent=fmtBRL(subtotal);
  const e2=document.getElementById('vr-tot-m'); if(e2) e2.textContent=fmtBRL(total);
  const descRow=document.getElementById('vr-desc-row-m');
  if(descRow){ descRow.style.display=descAmt>0?'flex':'none'; document.getElementById('vr-desc-txt-m').textContent='— '+fmtBRL(descAmt); }
  const taxaRow=document.getElementById('vr-taxa-row-m');
  if(taxaRow){ taxaRow.style.display=taxaAmt>0?'flex':'none'; document.getElementById('vr-taxa-txt-m').textContent='— '+fmtBRL(taxaAmt); }
  const entradaRow=document.getElementById('vr-entrada-row-m');
  const restanteRow=document.getElementById('vr-restante-row-m');
  if(entrada>0){
    if(entradaRow){ entradaRow.style.display='flex'; document.getElementById('vr-entrada-txt-m').textContent='— '+fmtBRL(entrada); }
    if(restanteRow){ restanteRow.style.display='flex'; document.getElementById('vr-restante-txt-m').textContent=fmtBRL(restante); }
  } else {
    if(entradaRow) entradaRow.style.display='none';
    if(restanteRow) restanteRow.style.display='none';
  }
}

function vrSelPagMobile(btn,forma){
  btn.closest('.vr-mobile')?.querySelectorAll('.vr-pag-btn').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active'); vrPagamentoMobile=forma;
  const pw=document.getElementById('vr-parcelas-wrap-m');
  if(pw) pw.style.display=forma==='credito'?'':'none';
  vrCalcTotalMobile();
}

async function vrFinalizarMobile(){
  if(!vrCarrinho.length){ showToast('Adicione ao menos um procedimento.','warn'); return; }
  const pacId=document.getElementById('vr-paciente-m')?.value||'';
  const pac=pacId?pacientes.find(p=>p.id==pacId):null;
  const profId=document.getElementById('vr-prof-m')?.value||'';
  const profNome=profId?(profissionais.find(p=>p.id==profId)?.nome||''):'';
  const subtotal=vrCarrinho.reduce((a,i)=>a+i.preco*i.qtd,0);
  const descTipo=document.getElementById('vr-desc-tipo-m')?.value||'nenhum';
  const descVal=parseFloat(document.getElementById('vr-desc-val-m')?.value)||0;
  let descAmt=0;
  if(descTipo==='pct') descAmt=subtotal*(descVal/100);
  if(descTipo==='fixo') descAmt=Math.min(descVal,subtotal);
  const aposDesc=subtotal-descAmt;
  const parcelas=parseInt(document.getElementById('vr-parcelas-m')?.value)||1;
  const taxaAmt=vrCalcTaxaAmt(aposDesc,vrPagamentoMobile,parcelas);
  const total=parseFloat((aposDesc+taxaAmt).toFixed(2));
  const entrada=parseFloat(document.getElementById('vr-entrada-m')?.value)||0;
  const restante=parseFloat(Math.max(0,total-entrada).toFixed(2));
  const obs=document.getElementById('vr-obs-m')?.value?.trim()||'';

  const msgConf=entrada>0?`Finalizar venda de ${fmtBRL(total)} (entrada ${fmtBRL(entrada)}, restante ${fmtBRL(restante)}) via ${vrPagamentoMobile}?`:`Finalizar venda de ${fmtBRL(total)} via ${vrPagamentoMobile}?`;
  if(!confirm(msgConf)) return;
  showLoading(true);

  nextVendaId = vendas.length ? Math.max(...vendas.map(v=>Number(v.id)||0)) + 1 : 1;

  const consumo = computeConsumo(vrCarrinho.map(i=>({procId:i.procId,qtd:i.qtd})));
  const consumoAplicado = aplicarBaixaEstoque(consumo);

  const venda={
    id:nextVendaId++, status:'finalizada', formaPagamento:vrPagamentoMobile,
    parcelas:vrPagamentoMobile==='credito'?parcelas:1,
    pacienteId:pacId||null, pacienteNome:pac?.nome||'Avulso',
    itens:vrCarrinho.map(i=>({procId:i.procId,qtd:i.qtd,nome:i.nome,precoUnit:i.preco,dente:'',descDente:''})),
    subtotal:parseFloat(subtotal.toFixed(2)),
    desconto:parseFloat(descAmt.toFixed(2)),
    entrada:parseFloat(entrada.toFixed(2)),
    restante:restante,
    obs:obs,
    total:total,
    profissional_id:profId||null, profissional_nome:profNome,
    data:new Date().toISOString(), dataFinal:new Date().toISOString(),
    consumo:consumoAplicado,
    // Extrato de pagamento: entrada parcial ou pagamento integral no ato
    pagamentos:[{
      id:Date.now(),
      valor:parseFloat(((entrada>0&&restante>0)?entrada:total).toFixed(2)),
      forma:vrPagamentoMobile,
      parcelas_cartao:vrPagamentoMobile==='credito'?parcelas:1,
      data:new Date().toISOString(),
      obs:(entrada>0&&restante>0)?'Entrada':''
    }],
  };
  vendas.push(venda);

  let avisoAtendimentoMobile = '';
  if(pacId){
    const descProcs = vrCarrinho.map(i=>`${i.nome}${i.qtd>1?' (×'+i.qtd+')':''}`).join(', ');
    const { error: errAt } = await _sb.from('atendimentos_odonto').insert([{
      clinica_id:clinicaId, paciente_id:pacId, data:hoje(),
      procedimentos:descProcs, obs:obs||'Venda rápida',
      profissional_id:profId||null, profissional_nome:profNome, dentes_tratados:'[]'
    }]);
    if(errAt){
      console.warn('Aviso atendimento:', errAt.message);
      avisoAtendimentoMobile = ' (mas o histórico do paciente não foi atualizado — registre manualmente)';
    }
  }

  const { data: existing } = await _sb.from('financeiro_config').select('id').eq('clinica_id',clinicaId).single();
  const payload = {
    clinica_id:clinicaId, procs:JSON.stringify(procs), mats:JSON.stringify(mats),
    estoque:JSON.stringify(estoque), proc_insumos:JSON.stringify(procInsumos),
    vendas:JSON.stringify(vendas), despesas:JSON.stringify(despesas), cfg:JSON.stringify(cfg),
    taxas_cfg:JSON.stringify(taxasCfg), updated_at:new Date().toISOString(),
    combos:JSON.stringify(combos), desc_cfg:JSON.stringify(descCfg)
  };
  const { error: saveErr } = existing
    ? await _sb.from('financeiro_config').update(payload).eq('clinica_id',clinicaId)
    : await _sb.from('financeiro_config').insert([payload]);

  if(saveErr){
    vendas.pop();
    devolverEstoque(consumoAplicado);
    nextVendaId--;
    showLoading(false);
    showToast('Erro ao finalizar venda: '+saveErr.message,'error');
    return;
  }

  showLoading(false);
  vrCarrinho=[];
  vrRenderCarrinhoMobile();
  if(document.getElementById('vr-desc-val-m')) document.getElementById('vr-desc-val-m').value=0;
  if(document.getElementById('vr-desc-tipo-m')) document.getElementById('vr-desc-tipo-m').value='nenhum';
  if(document.getElementById('vr-entrada-m')) document.getElementById('vr-entrada-m').value=0;
  if(document.getElementById('vr-obs-m')) document.getElementById('vr-obs-m').value='';
  vrCalcTotalMobile();
  if(avisoAtendimentoMobile) showToast('✅ Venda finalizada e salva'+avisoAtendimentoMobile+'.', 'warn');
  else showToast('✅ Venda finalizada e salva!');
}

function vendasSubTab(tab){
  document.querySelectorAll('.vendas-subtab').forEach(b=>b.classList.remove('active'));
  document.querySelector(`.vendas-subtab[onclick*="'${tab}'"]`)?.classList.add('active');
  document.getElementById('vendas-sub-aparelhos').style.display = tab==='aparelhos'?'':'none';
  document.getElementById('vendas-sub-alinhador').style.display = tab==='alinhador'?'':'none';
  document.getElementById('vendas-sub-clareamento').style.display = tab==='clareamento'?'':'none';
  document.getElementById('vendas-sub-vr').style.display = tab==='vr'?'':'none';
  if(tab==='vr'){ vrInit(); vrInitMobile(); }
  if(tab==='aparelhos'||tab==='alinhador') atualizarPrecosAparelhos();
  if(tab==='clareamento') atualizarPrecosClareamento();
}

// Preços da tabela comparativa e do card do Alinhador vêm da tabela de
// Procedimentos (por nome) — editar lá muda aqui também, em vez de ficar
// fixo no HTML como estava antes.
function atualizarPrecosAparelhos(){
  const fmtBRL = v => 'R$ '+Number(v).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2});
  const lista = typeof procs!=='undefined' && Array.isArray(procs) ? procs : [];
  const setar = (id, nomeProc) => {
    const el = document.getElementById(id); if(!el) return;
    const p = lista.find(x=>x.nome===nomeProc);
    el.textContent = p ? fmtBRL(p.precoFinal||0) : 'Consulte a equipe';
  };
  setar('ap-tab-inst-metalico',       'Instalação Aparelho Metálico Tradicional');
  setar('ap-tab-inst-autoligado',     'Instalação Aparelho Metálico Autoligado');
  setar('ap-tab-inst-ceramico',       'Instalação Aparelho Estético Cerâmico');
  setar('ap-tab-inst-safira',         'Instalação Aparelho Estético Safira');
  setar('ap-tab-inst-est-autoligado', 'Instalação Aparelho Estético Autoligado');
  setar('ap-tab-inst-alinhador',      'Instalação Alinhador Transparente (tratamento completo)');
  setar('ap-tab-manut-metalico',       'Manutenção Mensal — Aparelho Metálico Tradicional');
  setar('ap-tab-manut-autoligado',     'Manutenção Mensal — Aparelho Metálico Autoligado');
  setar('ap-tab-manut-ceramico',       'Manutenção Mensal — Aparelho Estético Cerâmico');
  setar('ap-tab-manut-safira',         'Manutenção Mensal — Aparelho Estético Safira');
  setar('ap-tab-manut-est-autoligado', 'Manutenção Mensal — Aparelho Estético Autoligado');
  setar('ap-tab-manut-alinhador',      'Manutenção Mensal — Alinhador Transparente (refinamento)');
  setar('alin-preco-instalacao',  'Instalação Alinhador Transparente (tratamento completo)');
  setar('alin-preco-refinamento', 'Manutenção Mensal — Alinhador Transparente (refinamento)');
}

function atualizarPrecosClareamento(){
  const fmtBRL = v => 'R$ '+Number(v).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2});
  const nomeEl = document.getElementById('clar-nome-clinica');
  if(nomeEl) nomeEl.textContent = clinicaData?.nome_cli || 'Consultório';
  const lista = typeof procs!=='undefined' && Array.isArray(procs) ? procs : [];
  const consultorio = lista.find(p=>p.nome==='Clareamento de Consultório');
  const elConsultorio = document.getElementById('clar-preco-consultorio');
  if(elConsultorio) elConsultorio.textContent = consultorio ? fmtBRL(consultorio.precoFinal||0) : 'Consulte a equipe';
}

function clareamentoAdicionarCarrinho(nomeProc){
  const proc = (typeof procs!=='undefined' && Array.isArray(procs) ? procs : []).find(p=>p.nome===nomeProc);
  if(!proc){ showToast('Procedimento não encontrado na tabela de preços','error'); return; }
  vendasSubTab('vr');
  vrAddItem(proc.id);
  showToast(proc.nome+' adicionado à Venda Rápida!');
}

function vrInitMobile(){
  const selPac=document.getElementById('vr-paciente-m');
  if(selPac) selPac.innerHTML='<option value="">— Paciente (opcional) —</option>'+pacientes.map(p=>`<option value="${p.id}">${escapeHtml(p.nome)}</option>`).join('');
  const selProf=document.getElementById('vr-prof-m');
  if(selProf) selProf.innerHTML='<option value="">— Quem atendeu —</option>'+profissionais.map(p=>`<option value="${p.id}">${escapeHtml(p.nome)}</option>`).join('');
}

function vrInit(){
  // Popula select de pacientes
  const selPac = document.getElementById('vr-paciente');
  if(selPac){
    selPac.innerHTML = '<option value="">— Sem vínculo —</option>' +
      pacientes.map(p=>`<option value="${p.id}">${escapeHtml(p.nome)}</option>`).join('');
  }
  // Popula select de profissionais
  const selProf = document.getElementById('vr-prof');
  if(selProf){
    selProf.innerHTML = '<option value="">— Selecionar —</option>' +
      profissionais.map(p=>`<option value="${p.id}">${escapeHtml(p.nome)}</option>`).join('');
  }
  vrRenderCats();
  vrFiltrar();
  vrRenderCarrinho();
  vrInitMobile();
}

function vrRenderCats(){
  const cats = [...new Set(procs.filter(p=>p.ativo!==false).map(p=>p.grupo||p.cat||p.categoria||'Geral'))].sort();
  const wrap = document.getElementById('vr-cats'); if(!wrap) return;
  wrap.innerHTML = `<button class="vr-cat-btn${vrCatAtiva===''?' active':''}" onclick="vrSetCat('')">Todos</button>` +
    cats.map(c=>`<button class="vr-cat-btn${vrCatAtiva===c?' active':''}" onclick="vrSetCat('${escapeHtml(c)}')">${escapeHtml(c)}</button>`).join('');
}

function vrSetCat(cat){ vrCatAtiva = cat; vrRenderCats(); vrFiltrar(); }

function vrFiltrar(){
  const q = (document.getElementById('vr-search')?.value||'').toLowerCase();
  const lista = document.getElementById('vr-lista'); if(!lista) return;
  const filtrados = procs.filter(p=>{
    if(p.ativo===false) return false;
    const cat = p.grupo||p.cat||p.categoria||'Geral';
    const matchCat = vrCatAtiva==='' || cat===vrCatAtiva;
    const matchQ   = !q || _norm(p.nome).includes(_norm(q));
    return matchCat && matchQ;
  });
  if(!filtrados.length){
    lista.innerHTML = '<div style="text-align:center;color:var(--rose-light);font-size:13px;padding:20px 0;">Nenhum procedimento encontrado</div>';
    return;
  }
  lista.innerHTML = filtrados.map(p=>{
    const preco = parseFloat(p.precoFinal||p.preco||0);
    const noCarrinho = vrCarrinho.find(i=>i.procId===p.id);
    const controles = noCarrinho
      ? `<div style="display:flex;align-items:center;gap:6px;flex-shrink:0;" onclick="event.stopPropagation()">
          <button onclick="vrSetQtd(${p.id},${noCarrinho.qtd-1})" style="width:30px;height:30px;border:1.5px solid var(--rose-light);border-radius:8px;background:#fff;color:var(--rose-dark);font-size:18px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;">−</button>
          <span style="font-size:16px;font-weight:800;color:var(--rose-dark);min-width:22px;text-align:center;">${noCarrinho.qtd}</span>
          <button onclick="vrAddItem(${p.id})" style="width:30px;height:30px;border:1.5px solid var(--rose-light);border-radius:8px;background:var(--rose-dark);color:#fff;font-size:18px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;">+</button>
        </div>`
      : `<button onclick="event.stopPropagation();vrAddItem(${p.id})" style="width:32px;height:32px;border:1.5px solid var(--rose-light);border-radius:8px;background:var(--rose-lighter);color:var(--rose-dark);font-size:20px;cursor:pointer;display:flex;align-items:center;justify-content:center;font-weight:700;">+</button>`;
    return `<div class="vr-proc-item" style="${noCarrinho?'border-color:var(--rose);background:var(--rose-lighter);':''}" onclick="${noCarrinho?'':'vrAddItem('+p.id+')'}">
      <div style="flex:1;min-width:0;">
        <div style="font-size:15px;font-weight:700;color:var(--rose-dark);line-height:1.25;">${escapeHtml(p.nome)}</div>
        <div style="font-size:12px;color:var(--rose-text);margin-top:3px;">${escapeHtml(p.cat||p.categoria||'Geral')}</div>
      </div>
      <div style="display:flex;align-items:center;gap:10px;flex-shrink:0;">
        <span style="font-size:17px;font-weight:800;color:var(--rose);">${fmtBRL(preco)}</span>
        ${controles}
      </div>
    </div>`;
  }).join('');
}

function vrAddItem(procId){
  const proc = procs.find(p=>p.id===procId); if(!proc) return;
  const preco = parseFloat(proc.precoFinal||proc.preco||0);
  const exist = vrCarrinho.find(i=>i.procId===procId);
  if(exist){ exist.qtd++; }
  else { vrCarrinho.push({procId, nome:proc.nome, preco, qtd:1}); }
  vrRenderCarrinho(); // já chama vrFiltrar internamente
  vrCalcTotal();
}

function vrRemItem(procId){
  vrCarrinho = vrCarrinho.filter(i=>i.procId!==procId);
  vrRenderCarrinho();
  vrCalcTotal();
}

function vrSetQtd(procId, val){
  const item = vrCarrinho.find(i=>i.procId===procId); if(!item) return;
  const n = parseInt(val)||1;
  if(n<=0){ vrRemItem(procId); return; }
  item.qtd = n;
  vrRenderCarrinho();
  vrCalcTotal();
}

function vrRenderCarrinho(){
  const wrap = document.getElementById('vr-carrinho'); if(!wrap) return;
  const cnt  = document.getElementById('vr-count');
  const total = vrCarrinho.reduce((a,i)=>a+i.qtd,0);
  if(cnt) cnt.textContent = total;
  if(!vrCarrinho.length){
    wrap.innerHTML=`<div style="text-align:center;color:var(--rose-light);padding:24px 0;">
      <i class="ti ti-shopping-cart-off" style="font-size:28px;display:block;margin-bottom:6px;"></i>
      <span style="font-size:12px;">Nenhum item</span>
    </div>`;
    vrFiltrar();
    return;
  }
  wrap.innerHTML = vrCarrinho.map(item=>`
    <div style="background:#fff;border:1.5px solid var(--rose-light);border-radius:12px;padding:10px 14px;display:flex;align-items:center;gap:8px;">
      <div style="flex:1;min-width:0;">
        <div style="font-size:13px;font-weight:700;color:var(--rose-dark);line-height:1.3;">${escapeHtml(item.nome)}</div>
        <div style="font-size:11px;color:var(--rose-text);margin-top:2px;">${fmtBRL(item.preco)}/un</div>
      </div>
      <div style="display:flex;align-items:center;gap:5px;flex-shrink:0;">
        <button onclick="vrSetQtd(${item.procId},${item.qtd-1})" style="width:26px;height:26px;border:1.5px solid var(--rose-light);border-radius:6px;background:var(--rose-lighter);color:var(--rose-dark);font-size:16px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;">−</button>
        <span style="font-size:14px;font-weight:800;color:var(--rose-dark);min-width:20px;text-align:center;">${item.qtd}</span>
        <button onclick="vrAddItem(${item.procId})" style="width:26px;height:26px;border:1.5px solid var(--rose-light);border-radius:6px;background:var(--rose-dark);color:#fff;font-size:16px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;">+</button>
      </div>
      <span style="font-size:14px;font-weight:900;color:var(--rose);white-space:nowrap;min-width:70px;text-align:right;">${fmtBRL(item.preco*item.qtd)}</span>
      <button onclick="vrRemItem(${item.procId})" style="border:none;background:none;color:#c0392b;cursor:pointer;font-size:18px;line-height:1;padding:0;flex-shrink:0;">×</button>
    </div>`).join('');
  vrFiltrar(); // atualiza ícones de check na lista
}

function vrCalcTaxaAmt(base, forma, parcelas){
  let taxa = 0;
  if(forma==='debito') taxa = taxasCfg.debito || 0;
  else if(forma==='credito'){
    const idx = (parcelas||1) - 1;
    taxa = idx>=0 ? (taxasCfg.credito||[])[idx]||0 : 0;
  }
  return parseFloat((base * taxa / 100).toFixed(2));
}

function vrSelPag(btn, forma){
  btn.closest('.vr-desktop,.card')?.querySelectorAll('.vr-pag-btn').forEach(b=>b.classList.remove('active'));
  if(!btn.classList.contains('active')) btn.classList.add('active');
  vrPagamento = forma;
  const pw = document.getElementById('vr-parcelas-wrap');
  if(pw) pw.style.display = forma==='credito' ? '' : 'none';
  vrCalcTotal();
}

function vrCalcTotal(){
  const subtotal = vrCarrinho.reduce((a,i)=>a+i.preco*i.qtd,0);
  const descTipo = document.getElementById('vr-desc-tipo')?.value||'nenhum';
  const descVal  = parseFloat(document.getElementById('vr-desc-val')?.value)||0;
  let descAmt = 0;
  if(descTipo==='pct')  descAmt = subtotal * (descVal/100);
  if(descTipo==='fixo') descAmt = Math.min(descVal, subtotal);
  const aposDesc = subtotal - descAmt;
  const parcelas = parseInt(document.getElementById('vr-parcelas')?.value)||1;
  const taxaAmt  = vrCalcTaxaAmt(aposDesc, vrPagamento, parcelas);
  const total    = aposDesc + taxaAmt;
  const entrada  = parseFloat(document.getElementById('vr-entrada')?.value)||0;
  const restante = Math.max(0, total - entrada);
  document.getElementById('vr-subtotal').textContent    = fmtBRL(subtotal);
  document.getElementById('vr-desconto-txt').textContent = '— '+fmtBRL(descAmt);
  document.getElementById('vr-taxa-txt').textContent     = '— '+fmtBRL(taxaAmt);
  document.getElementById('vr-total').textContent        = fmtBRL(total);
  const entradaRow = document.getElementById('vr-entrada-row');
  const restanteRow = document.getElementById('vr-restante-row');
  if(entrada > 0){
    if(entradaRow){ entradaRow.style.display='flex'; document.getElementById('vr-entrada-txt').textContent='— '+fmtBRL(entrada); }
    if(restanteRow){ restanteRow.style.display='flex'; document.getElementById('vr-restante-txt').textContent=fmtBRL(restante); }
  } else {
    if(entradaRow) entradaRow.style.display='none';
    if(restanteRow) restanteRow.style.display='none';
  }
}

async function vrFinalizar(){
  if(!vrCarrinho.length){ showToast('Adicione pelo menos um procedimento.','warn'); return; }
  const parcelas = parseInt(document.getElementById('vr-parcelas')?.value)||1;
  const descTipo = document.getElementById('vr-desc-tipo')?.value||'nenhum';
  const descVal  = parseFloat(document.getElementById('vr-desc-val')?.value)||0;
  const subtotal = vrCarrinho.reduce((a,i)=>a+i.preco*i.qtd,0);
  let descAmt = 0;
  if(descTipo==='pct')  descAmt = subtotal*(descVal/100);
  if(descTipo==='fixo') descAmt = Math.min(descVal,subtotal);
  const aposDesc = subtotal - descAmt;
  const total = parseFloat((aposDesc + vrCalcTaxaAmt(aposDesc, vrPagamento, parcelas)).toFixed(2));
  const entrada = parseFloat(document.getElementById('vr-entrada')?.value)||0;
  const restante = parseFloat(Math.max(0, total - entrada).toFixed(2));
  const obs = document.getElementById('vr-obs')?.value?.trim()||'';
  const pacId   = document.getElementById('vr-paciente')?.value||'';
  const pac     = pacId ? pacientes.find(p=>p.id==pacId) : null;
  const profId  = document.getElementById('vr-prof')?.value||'';
  const profNome = profId ? (profissionais.find(p=>p.id==profId)?.nome||'') : '';

  const msgConf = entrada>0 ? `Finalizar venda de ${fmtBRL(total)} (entrada ${fmtBRL(entrada)}, restante ${fmtBRL(restante)}) via ${vrPagamento}?` : `Finalizar venda de ${fmtBRL(total)} via ${vrPagamento}?`;
  if(!confirm(msgConf)) return;
  showLoading(true);

  // Garante nextVendaId sempre correto antes de usar
  nextVendaId = vendas.length ? Math.max(...vendas.map(v=>Number(v.id)||0)) + 1 : 1;

  const consumo = computeConsumo(vrCarrinho.map(i=>({procId:i.procId,qtd:i.qtd})));
  const consumoAplicado = aplicarBaixaEstoque(consumo); // desconta memória

  const venda = {
    id: nextVendaId++,
    status: 'finalizada',
    formaPagamento: vrPagamento,
    parcelas: vrPagamento==='credito' ? parcelas : 1,
    pacienteId: pacId||null,
    pacienteNome: pac?.nome||'Avulso',
    itens: vrCarrinho.map(i=>({procId:i.procId,qtd:i.qtd,nome:i.nome,precoUnit:i.preco,dente:'',descDente:''})),
    subtotal: parseFloat(subtotal.toFixed(2)),
    desconto: parseFloat(descAmt.toFixed(2)),
    entrada: parseFloat(entrada.toFixed(2)),
    restante: restante,
    obs: obs,
    total: parseFloat(total.toFixed(2)),
    profissional_id: profId||null,
    profissional_nome: profNome,
    data: new Date().toISOString(),
    dataFinal: new Date().toISOString(),
    consumo: consumoAplicado,
    // Extrato de pagamento: entrada parcial ou pagamento integral no ato
    pagamentos: [{
      id: Date.now(),
      valor: parseFloat(((entrada>0&&restante>0)?entrada:total).toFixed(2)),
      forma: vrPagamento,
      parcelas_cartao: vrPagamento==='credito'?parcelas:1,
      data: new Date().toISOString(),
      obs: (entrada>0&&restante>0)?'Entrada':''
    }],
  };
  vendas.push(venda);

  // Registra atendimento no histórico do paciente (se vinculado)
  let avisoAtendimento = '';
  if(pacId){
    const descProcs = vrCarrinho.map(i=>`${i.nome}${i.qtd>1?' (×'+i.qtd+')':''}`).join(', ');
    const { error: errAt } = await _sb.from('atendimentos_odonto').insert([{
      clinica_id:clinicaId, paciente_id:pacId,
      data:hoje(), procedimentos:descProcs, obs:'Venda rápida',
      profissional_id:profId||null, profissional_nome:profNome,
      dentes_tratados:'[]'
    }]);
    if(errAt){
      console.warn('Aviso: não foi possível registrar atendimento:', errAt.message);
      avisoAtendimento = ' (mas o histórico do paciente não foi atualizado — registre manualmente)';
    }
  }

  // Salva tudo (estoque + venda) atomicamente
  const { data: existing } = await _sb.from('financeiro_config').select('id').eq('clinica_id',clinicaId).single();
  const payload = {
    clinica_id   : clinicaId,
    procs        : JSON.stringify(procs),
    mats         : JSON.stringify(mats),
    estoque      : JSON.stringify(estoque),
    proc_insumos : JSON.stringify(procInsumos),
    vendas       : JSON.stringify(vendas),
    despesas     : JSON.stringify(despesas),
    cfg          : JSON.stringify(cfg),
    taxas_cfg    : JSON.stringify(taxasCfg),
    updated_at   : new Date().toISOString(),
    combos       : JSON.stringify(combos),
    desc_cfg     : JSON.stringify(descCfg)
  };
  const { error: saveErr } = existing
    ? await _sb.from('financeiro_config').update(payload).eq('clinica_id',clinicaId)
    : await _sb.from('financeiro_config').insert([payload]);

  if(saveErr){
    // ROLLBACK: desfaz venda e estoque na memória para não ficar inconsistente
    vendas.pop();
    devolverEstoque(consumoAplicado);
    nextVendaId--;
    showLoading(false);
    showToast('Erro ao finalizar venda: '+saveErr.message,'error');
    return;
  }

  showLoading(false);

  vrCarrinho = [];
  vrRenderCarrinho();
  if(document.getElementById('vr-desc-val')) document.getElementById('vr-desc-val').value = 0;
  if(document.getElementById('vr-desc-tipo')) document.getElementById('vr-desc-tipo').value = 'nenhum';
  if(document.getElementById('vr-entrada')) document.getElementById('vr-entrada').value = 0;
  if(document.getElementById('vr-obs')) document.getElementById('vr-obs').value = '';
  if(document.getElementById('vr-search')) document.getElementById('vr-search').value = '';
  vrCalcTotal();
  vrFiltrar();

  if(avisoAtendimento) showToast('✅ Venda finalizada e salva com sucesso'+avisoAtendimento+'.', 'warn');
  else showToast('✅ Venda finalizada e salva com sucesso!');
}


let pacPlanDentesSel = []; // dentes selecionados no form do plano

function pacPlanAddDente(val){
  if(!val) return;
  const n = parseInt(val);
  if(!pacPlanDentesSel.includes(n)) pacPlanDentesSel.push(n);
  pacPlanRenderDentesSel();
  document.getElementById('pac-plan-dente-add').value = '';
  document.getElementById('pac-plan-dente').value = pacPlanDentesSel.join(',');
  pacPlanSyncValorTotal();
}

function pacPlanRemDente(n){
  pacPlanDentesSel = pacPlanDentesSel.filter(d=>d!==n);
  pacPlanRenderDentesSel();
  document.getElementById('pac-plan-dente').value = pacPlanDentesSel.join(',');
  pacPlanSyncValorTotal();
}

function pacPlanRenderDentesSel(){
  const c = document.getElementById('pac-plan-dentes-sel'); if(!c) return;
  c.innerHTML = pacPlanDentesSel.map(n=>`
    <span style="background:var(--rose-lighter);color:var(--rose-dark);border-radius:20px;padding:3px 10px;font-size:12px;font-weight:700;display:inline-flex;align-items:center;gap:4px;">
      ${n} <button onclick="pacPlanRemDente(${n})" style="border:none;background:none;color:var(--rose);cursor:pointer;font-size:14px;padding:0;line-height:1;">×</button>
    </span>`).join('');
}

function pacPlanSyncValor(){
  // Quando muda procedimento, preenche valor unitário automaticamente
  const sel = document.getElementById('pac-plan-proc');
  const opt = sel?.options[sel.selectedIndex];
  const preco = opt?.dataset?.preco;
  if(preco && preco !== '0'){
    const el = document.getElementById('pac-plan-valor');
    if(el) el.value = parseFloat(preco).toFixed(2).replace('.',',');
  }
  pacPlanSyncValorTotal();
}

function pacPlanSyncValorTotal(){
  const valEl = document.getElementById('pac-plan-valor');
  const totEl = document.getElementById('pac-plan-valor-total');
  if(!valEl || !totEl) return;
  const valUnit = parseFloat((valEl.value||'0').replace(',','.')) || 0;
  const qtdDentes = pacPlanDentesSel.length || 1;
  const total = valUnit * qtdDentes;
  totEl.value = 'R$ ' + total.toFixed(2).replace('.',',');
}

function pacPlanSyncFromValor(){
  pacPlanSyncValorTotal();
}

function pacTogglePlanForm(){
  const f = document.getElementById('pac-plan-form');
  if(!f) return;
  if(f.style.display==='none'){
    f.style.display='';
    pacPlanDentesSel = [];
    pacPlanRenderDentesSel();
    document.getElementById('pac-plan-dente').value = '';
    const totEl = document.getElementById('pac-plan-valor-total');
    if(totEl) totEl.value = '';
    pacPlanoEditId = null;
  } else {
    f.style.display='none';
    pacPlanoEditId = null;
  }
}

// Sobrescreve pacSalvarPlano para usar múltiplos dentes
async function pacSalvarPlano(pacId){
  const dentesVal = document.getElementById('pac-plan-dente')?.value || '';
  const face  = document.getElementById('pac-plan-face')?.value || '–';
  const proc  = document.getElementById('pac-plan-proc')?.value;
  const valorUnit = (document.getElementById('pac-plan-valor')?.value || '0').replace(',','.');
  const desc  = document.getElementById('pac-plan-desc')?.value.trim() || '';
  if(!dentesVal){ showToast('Selecione pelo menos um dente.','warn'); return; }
  if(!proc){ showToast('Selecione o procedimento.','warn'); return; }
  const dentes = dentesVal.split(',').filter(Boolean);
  const qtd = dentes.length;
  const valorTotal = (parseFloat(valorUnit) * qtd).toFixed(2).replace('.',',');
  showLoading(true);
  let error;
  if(pacPlanoEditId){
    ({ error } = await _sb.from('plano_tratamento').update({
      dente: dentesVal, face, procedimento:proc,
      valor: valorTotal, valor_unit: valorUnit,
      quantidade_dentes: qtd, descricao:desc
    }).eq('id',pacPlanoEditId));
    if(!error){
      pacPlanoList = pacPlanoList.map(i=> i.id===pacPlanoEditId
        ? {...i,dente:dentesVal,face,procedimento:proc,valor:valorTotal,valor_unit:valorUnit,quantidade_dentes:qtd,descricao:desc}
        : i);
    }
  } else {
    const { data:novo, error:e } = await _sb.from('plano_tratamento').insert([{
      clinica_id:clinicaId, paciente_id:pacId,
      dente:dentesVal, face, procedimento:proc,
      valor:valorTotal, valor_unit:valorUnit,
      quantidade_dentes:qtd, descricao:desc, status:'pendente'
    }]).select().single();
    error = e;
    if(!error) pacPlanoList.unshift(novo);
  }
  showLoading(false);
  if(error){ showToast('Erro: '+error.message,'error'); return; }
  pacTogglePlanForm();
  pacRenderPlanoResumo();
  pacRenderPlanoLista();
  showToast('Salvo no plano!');
}

// Sobrescreve pacEditarPlano para carregar múltiplos dentes
async function pacEditarPlano(id){
  const item = pacPlanoList.find(i=>i.id===id);
  if(!item) return;
  pacPlanoEditId = id;
  const f = document.getElementById('pac-plan-form');
  if(f) f.style.display='';
  // Carrega dentes
  pacPlanDentesSel = (item.dente||'').split(',').filter(Boolean).map(Number);
  pacPlanRenderDentesSel();
  document.getElementById('pac-plan-dente').value = item.dente||'';
  const set = (elId, val) => { const el=document.getElementById(elId); if(el) el.value=val||''; };
  set('pac-plan-face',  item.face);
  set('pac-plan-proc',  item.procedimento);
  set('pac-plan-valor', (item.valor_unit||item.valor||'').replace(',','.'));
  set('pac-plan-desc',  item.descricao);
  pacPlanSyncValorTotal();
  f?.scrollIntoView({behavior:'smooth',block:'nearest'});
}

// Atualiza renderPlanoLista para mostrar múltiplos dentes

// ══════════════════════════════════════════════════════
// DETECÇÃO DE APARELHO ORTODÔNTICO ATIVO
// Vincula manutenção/recolagem ao tipo de aparelho do paciente
// ══════════════════════════════════════════════════════
const MAPA_APARELHO_ORTO = [
  // Ordem importa: autoligado antes do genérico metálico/estético
  { re: /instalação aparelho metálico autoligado/i,  nome: 'Metálico Autoligado',  manutId: 213, recolagId: 217 },
  { re: /instalação aparelho metálico/i,             nome: 'Metálico Tradicional', manutId: 212, recolagId: 215 },
  { re: /instalação aparelho estético cerâmico/i,    nome: 'Estético Cerâmico',    manutId: 208, recolagId: 216 },
  { re: /instalação aparelho estético porcelana/i,   nome: 'Estético Porcelana',   manutId: 209, recolagId: 218 },
  { re: /instalação aparelho estético safira/i,      nome: 'Estético Safira',      manutId: 210, recolagId: 219 },
  { re: /instalação aparelho estético autoligado/i,  nome: 'Estético Autoligado',  manutId: 211, recolagId: 220 },
  { re: /invisalign|alinhador\s*transparente/i,        nome: 'Alinhador Transparente', manutId: 214, recolagId: null },
];

// Retorna o aparelho ativo do paciente (aprovado ou realizado no plano)
function detectarAparelhoAtivo(){
  for(const mapa of MAPA_APARELHO_ORTO){
    const found = pacPlanoList.find(i=>
      mapa.re.test(i.procedimento||'') &&
      (i.status==='aprovado'||i.status==='realizado')
    );
    if(found) return {...mapa, planoItem: found};
  }
  return null;
}

// Adiciona manutenção ou recolagem ao plano com base no aparelho detectado
async function _adicionarProcOrtoPlano(pacId, procId){
  const p = procs.find(x=>x.id===procId);
  if(!p){ showToast('Procedimento não encontrado.','error'); return; }
  const valor = p.precoFinal ? p.precoFinal.toFixed(2).replace('.',',') : '0,00';
  showLoading(true);
  const { data: novo, error } = await _sb.from('plano_tratamento').insert([{
    clinica_id: clinicaId, paciente_id: pacId,
    dente: '–', face: '–',
    procedimento: p.nome, valor, descricao: '', status: 'pendente'
  }]).select().single();
  showLoading(false);
  if(error){ showToast('Erro: '+error.message,'error'); return; }
  if(novo){
    pacPlanoList.unshift(novo);
  } else {
    // fallback local se select() não retornar
    pacPlanoList.unshift({id:Date.now(),dente:'–',face:'–',procedimento:p.nome,valor,descricao:'',status:'pendente'});
  }
  pacRenderPlanoResumo();
  pacRenderPlanoLista();
  showToast('✅ '+p.nome+' adicionado ao plano!');
}

async function adicionarManutencaoOrtod(pacId){
  const ap = detectarAparelhoAtivo();
  if(ap){
    await _adicionarProcOrtoPlano(pacId, ap.manutId);
  } else {
    // Nenhum aparelho detectado — mostrar seletor
    _modalSelecionarOrto(pacId, 'manut');
  }
}

async function adicionarRecolagemOrtod(pacId){
  const ap = detectarAparelhoAtivo();
  if(ap){
    if(!ap.recolagId){
      showToast('Alinhador transparente não usa braquetes — não há recolagem. Adicione refinamento manualmente.','warn');
      return;
    }
    await _adicionarProcOrtoPlano(pacId, ap.recolagId);
  } else {
    _modalSelecionarOrto(pacId, 'recolag');
  }
}

// Modal de seleção manual quando o aparelho não está detectado
function _modalSelecionarOrto(pacId, tipo){
  const opcoes = tipo==='manut'
    ? [{id:212,label:'Metálico Tradicional — R$ 90,00'},{id:213,label:'Metálico Autoligado — R$ 115,00'},{id:208,label:'Estético Cerâmico — R$ 130,00'},{id:209,label:'Estético Porcelana — R$ 160,00'},{id:211,label:'Estético Autoligado — R$ 190,00'},{id:210,label:'Estético Safira — R$ 220,00'},{id:214,label:'Alinhador Transparente (refinamento) — R$ 300,00'}]
    : [{id:215,label:'Metálico Tradicional'},{id:217,label:'Metálico Autoligado'},{id:216,label:'Cerâmico'},{id:218,label:'Porcelana'},{id:219,label:'Safira'},{id:220,label:'Autoligado Estético'}];
  const titulo = tipo==='manut' ? 'Qual tipo de aparelho para Manutenção?' : 'Qual tipo de aparelho para Recolagem?';
  document.getElementById('_orto_plan_modal')?.remove();
  const modal = document.createElement('div');
  modal.id = '_orto_plan_modal';
  modal.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:10000;display:flex;align-items:center;justify-content:center;';
  modal.innerHTML=`<div style="background:#fff;border-radius:16px;padding:24px;max-width:380px;width:90%;box-shadow:0 8px 40px rgba(0,0,0,.2);">
    <div style="font-size:15px;font-weight:700;color:var(--rose-dark);margin-bottom:16px;"><i class="ti ti-tooth"></i> ${titulo}</div>
    <div style="display:flex;flex-direction:column;gap:8px;" id="_orto_opts">
      ${opcoes.map(o=>`<button class="btn-secondary" style="justify-content:flex-start;font-size:13px;" onclick="document.body.removeChild(this.closest('[style*=position]'));_adicionarProcOrtoPlano(${pacId},${o.id});">${o.label}</button>`).join('')}
    </div>
    <button class="btn-secondary" style="width:100%;margin-top:12px;justify-content:center;color:#666;" onclick="document.body.removeChild(this.closest('[style*=position]'))">Cancelar</button>
  </div>`;
  document.body.appendChild(modal);
}

function pacRenderPlanoLista(){
  const c = document.getElementById('pac-plano-lista');
  if(!c) return;
  // Banner de aparelho ativo com botões inteligentes de manutenção/recolagem
  const _apAtivo = detectarAparelhoAtivo();
  const _smartBar = _apAtivo ? `<div style="background:linear-gradient(135deg,#e8f5e9,#f1f8e9);border:1px solid #a5d6a7;border-radius:10px;padding:10px 14px;margin-bottom:10px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
    <div style="flex:1;min-width:150px;">
      <div style="font-size:11px;color:#2e7d32;font-weight:700;text-transform:uppercase;letter-spacing:.4px;"><i class="ti ti-device-heart-monitor"></i> Aparelho ativo detectado</div>
      <div style="font-size:13px;color:#1b5e20;font-weight:600;margin-top:2px;">🦷 ${_apAtivo.nome}</div>
    </div>
    <button class="btn-secondary" style="font-size:12px;padding:6px 12px;color:#2e7d32;border-color:#a5d6a7;background:#fff;" onclick="adicionarManutencaoOrtod(${selectedPatientId})"><i class="ti ti-refresh"></i> + Manutenção</button>
    ${_apAtivo.recolagId ? `<button class="btn-secondary" style="font-size:12px;padding:6px 12px;color:#7a5c00;border-color:#ffe082;background:#fff;" onclick="adicionarRecolagemOrtod(${selectedPatientId})"><i class="ti ti-tool"></i> + Recolagem</button>` : ''}
  </div>` : '';
  if(!pacPlanoList.length){
    c.innerHTML=_smartBar+'<div style="text-align:center;color:var(--rose-text);font-size:13px;padding:16px;">Nenhum procedimento planejado ainda.</div>';
    return;
  }
  const STATUS_CORES = {
    pendente : {bg:'#FFF3CD',txt:'#856404',dot:'#FFC107'},
    aprovado : {bg:'#D1ECF1',txt:'#0C5460',dot:'#17A2B8'},
    realizado: {bg:'#D4EDDA',txt:'#155724',dot:'#28A745'},
    cancelado: {bg:'#F8D7DA',txt:'#721C24',dot:'#DC3545'},
  };
  const _listaHtml = pacPlanoList.map(item => {
    const sc = STATUS_CORES[item.status] || STATUS_CORES.pendente;
    const statusLabel = {pendente:'Pendente',aprovado:'Aprovado',realizado:'Realizado',cancelado:'Cancelado'}[item.status]||item.status;
    const dentes = (item.dente||'').split(',').filter(Boolean);
    const dentesHtml = dentes.map(d=>`<span style="background:var(--rose-lighter);color:var(--rose-dark);border-radius:6px;padding:2px 7px;font-size:11px;font-weight:700;">🦷${d}</span>`).join(' ');
    const btnAprovar  = item.status==='pendente' ? `<button class="btn-secondary" style="font-size:11px;padding:4px 10px;" onclick="pacAlterarStatusPlano(${item.id},'aprovado')">✔ Aprovar</button>` : '';
    const btnDesaprovar = item.status==='aprovado' ? `<button class="btn-secondary" style="font-size:11px;padding:4px 10px;color:#7a5c00;border-color:#ffe082;background:#fff8e1;" onclick="pacDesaprovarPlano(${item.id})">↩ Pendente</button>` : '';
    const profSelect  = (item.status==='aprovado'||item.status==='pendente') ? `<select id="plano-prof-${item.id}" style="font-size:11px;padding:4px 6px;border:1px solid var(--rose-light);border-radius:8px;max-width:130px;color:#3a2020;">
      <option value="">Quem atendeu?</option>
      ${profissionais.map(pr=>`<option value="${pr.id}">${escapeHtml(pr.nome)}</option>`).join('')}
    </select>` : '';
    const btnRealizar = (item.status==='aprovado'||item.status==='pendente') ? `<button class="btn-secondary" style="font-size:11px;padding:4px 10px;color:#2e7d32;border-color:#a5d6a7;" onclick="pacAlterarStatusPlano(${item.id},'realizado')">✅ Realizado</button>` : '';
    const btnDesfazerReal = item.status==='realizado' ? `<button class="btn-secondary" style="font-size:11px;padding:4px 10px;color:#7a5c00;border-color:#ffe082;background:#fff8e1;" onclick="pacDesfazerRealizadoPlano(${item.id})">↩ Desfazer</button>` : '';
    return `<div style="border:1px solid var(--rose-light);border-radius:12px;padding:13px;margin-bottom:8px;background:#fff;">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:8px;">
        <div>
          <div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:6px;">${dentesHtml}</div>
          <strong style="font-size:13px;">${escapeHtml(item.procedimento)}</strong>${(()=>{const _u=pacPlanoGetUrgencia(item.id);const _ul={urgente:'🔴 Urgente',recomendado:'🟡 Recomendado',eletivo:'🟢 Eletivo'};return _u?`<span class="urg-badge urg-${_u}" style="margin-left:6px;">${_ul[_u]}</span>`:''})()}
          ${item.face&&item.face!=='–'?`<span style="font-size:11px;color:var(--rose-text);margin-left:6px;">(${escapeHtml(item.face)})</span>`:''}
          ${dentes.length>1?`<span style="font-size:11px;color:var(--rose-text);margin-left:6px;">${dentes.length} dentes</span>`:''}
        </div>
        <span style="background:${sc.bg};color:${sc.txt};padding:3px 10px;border-radius:20px;font-size:11px;font-weight:700;display:inline-flex;align-items:center;gap:4px;">
          <span style="width:6px;height:6px;border-radius:50%;background:${sc.dot};display:inline-block;"></span>${statusLabel}
        </span>
      </div>
      ${item.descricao?`<div style="font-size:12px;color:var(--rose-text);margin-top:5px;">${escapeHtml(item.descricao)}</div>`:''}
      <div style="font-size:11px;color:var(--rose-text);margin-top:4px;opacity:.75;">${item.created_at?`📅 Adicionado: ${new Date(item.created_at).toLocaleDateString('pt-BR')}`:''} ${item.data_aprovado&&!item.data_realizado?`· ✔️ Aprovado: ${new Date(item.data_aprovado).toLocaleDateString('pt-BR')}`:''} ${item.data_realizado?`· ✅ Realizado: ${new Date(item.data_realizado).toLocaleDateString('pt-BR')}`:''}</div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px;flex-wrap:wrap;gap:6px;">
        <div style="display:flex;align-items:center;gap:6px;">
          <span style="font-size:13px;color:var(--rose-text);">R$</span>
          <input type="text" value="${escapeHtml(item.valor||'0,00')}" onchange="pacAtualizarValorPlano(${item.id},this.value)" style="width:100px;padding:4px 8px;border:1px solid var(--rose-light);border-radius:8px;text-align:right;font-size:14px;font-weight:700;color:#2e7d32;"/>
          ${dentes.length>1&&item.valor_unit?`<span style="font-size:11px;color:var(--rose-text);">(R$ ${escapeHtml(item.valor_unit)}/dente)</span>`:''}
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;">
          <select onchange="pacPlanoSetUrgencia(${item.id},this.value)" style="font-size:11px;padding:4px 6px;border:1px solid var(--rose-light);border-radius:8px;color:#3a2020;" title="Classificar urgência"><option value="" ${!pacPlanoGetUrgencia(item.id)?'selected':''}>— Urgência</option><option value="urgente" ${pacPlanoGetUrgencia(item.id)==='urgente'?'selected':''}>🔴 Urgente</option><option value="recomendado" ${pacPlanoGetUrgencia(item.id)==='recomendado'?'selected':''}>🟡 Recom.</option><option value="eletivo" ${pacPlanoGetUrgencia(item.id)==='eletivo'?'selected':''}>🟢 Eletivo</option></select>
          ${btnDesaprovar}${btnAprovar}${profSelect}${btnRealizar}${btnDesfazerReal}
          <button class="btn-danger" style="font-size:11px;padding:4px 8px;" onclick="pacRemoverPlano(${item.id})"><i class="ti ti-trash"></i></button>
        </div>
      </div>
    </div>`;
  }).join('');
  c.innerHTML = _smartBar + _listaHtml;
}

// ══════════════════════════════════════════════════════
// REVISÃO DO PLANO → AÇÕES DE ORÇAMENTO
// ══════════════════════════════════════════════════════

// Abre/fecha o painel de ajuste de desconto e forma de pagamento (simulador)
// Aprova todos os itens pendentes do plano (1ª revisão concluída)
let _aprovandoOrcamento = false;
async function pacAprovarOrcamentoPlano(pacId){
  if(_aprovandoOrcamento) return; // evita duplo-toque criando duas vendas
  const ativos = pacPlanoList.filter(i=>i.status!=='cancelado'&&i.status!=='realizado');
  if(!ativos.length){ showToast('Não há itens no plano para aprovar.','warn'); return; }

  // Só os itens ainda pendentes entram nesta aprovação em lote — os que já foram
  // aprovados individualmente (botão "✔ Aprovar" no item) já geraram sua própria
  // venda/orçamento, então não devem ser incluídos de novo aqui (evita duplicar valor).
  const pendentes = ativos.filter(i=>i.status==='pendente');
  if(!pendentes.length){ showToast('Todos os itens já estão aprovados.','warn'); return; }
  if(!confirm(`Aprovar orçamento com ${pendentes.length} item(ns)?`)) return;

  _aprovandoOrcamento = true;
  showLoading(true);

  try{
    // Marca itens pendentes como aprovados
    for(const item of pendentes){
      const { error } = await _sb.from('plano_tratamento').update({ status:'aprovado' }).eq('id',item.id);
      if(error) throw error;
    }
    pacPlanoList = pacPlanoList.map(i=> pendentes.find(x=>x.id===i.id) ? {...i,status:'aprovado'} : i);

    // Monta a venda (orçamento) só com os itens recém-aprovados
    const pac = pacientes.find(p=>p.id===pacId);
    const itensVenda = pendentes.map(item=>{
      const procObj = procs.find(pr=>pr.nome===item.procedimento);
      const dentesArr = (item.dente||'').split(',').filter(Boolean);
      const valorTotal = parseFloat((item.valor||'0').replace(',','.'))||0;
      return {
        procId: procObj?.id||null, qtd:1, nome:item.procedimento,
        dente: dentesArr.join(','), descDente: item.descricao||'',
        precoUnit: valorTotal,
        planoId: item.id
      };
    });
    const subtotal = itensVenda.reduce((a,it)=>a+it.precoUnit*it.qtd,0);

    // Lê desconto e validade configurados antes de aprovar
    const _descTipo = document.getElementById('plano-desc-tipo')?.value||'pct';
    const _descVal  = parseFloat(document.getElementById('plano-desc-val')?.value||0)||0;
    const _validDias = parseInt(document.getElementById('plano-validade')?.value||'30')||0;
    const _descAmt  = _descTipo==='pct' ? subtotal*_descVal/100 : Math.min(_descVal,subtotal);
    const _totalFinal = Math.max(0, subtotal - _descAmt);
    const _validade = _validDias > 0 ? new Date(Date.now()+_validDias*86400000).toISOString() : null;

    const venda = {
      id: nextVendaId++, status:'orcamento', formaPagamento:'',
      pacienteId: pacId, pacienteNome: pac?.nome||'',
      itens: itensVenda,
      subtotal: parseFloat(subtotal.toFixed(2)),
      desconto: parseFloat(_descAmt.toFixed(2)),
      total: parseFloat(_totalFinal.toFixed(2)),
      planoIds: pendentes.map(i=>i.id),
      validade: _validade,
      data: new Date().toISOString()
    };
    vendas.push(venda);
    const _eAprov=await saveFinanceiro();

    pacRenderPlanoResumo();
    pacRenderPlanoLista();
    if(!_eAprov) showToast('Orçamento aprovado!');
    else showToast('Erro ao aprovar orçamento: '+_eAprov.message,'error');
    renderPatientDetail('orcamentos');
  }catch(err){
    showToast('Erro ao aprovar orçamento: '+(err?.message||'tente novamente.'),'error');
  }finally{
    showLoading(false);
    _aprovandoOrcamento = false;
  }
}



function pacOdontoToggleOrc(){
  const panel = document.getElementById('pac-odonto-orc-panel');
  const icon = document.getElementById('pac-odonto-orc-icon');
  if(!panel) return;
  const showing = panel.style.display !== 'none';
  panel.style.display = showing ? 'none' : '';
  if(icon) icon.className = showing ? 'ti ti-chevron-down' : 'ti ti-chevron-up';
  if(!showing){ pacOdontoInitOrc(); pacOdontoPopularSelect(); }
}

function pacOdontoInitOrc(){
  pacOdontoPopularSelect();
  if(!pacOdontoOrcList.length) pacOdontoAutoPopular();
  pacOdontoRenderOrcLista();
}

function pacOdontoAutoPopular(){
  if(!pacDentesMap || !Object.keys(pacDentesMap).length) return;
  const adicionados = new Map();

  Object.entries(pacDentesMap).forEach(([dente, info])=>{
    if(!info) return;
    const num = parseInt(dente);

    // 1) Prioridade máxima: usar exatamente o procedimento que foi salvo no dente.
    // Ex.: se foi salvo "Endodontia - 3 canais", não pode virar "Endodontia - Necro (1 canal)".
    const nomesSalvos = String(info.procedimento || '')
      .split(',')
      .map(x => x.trim())
      .filter(Boolean);

    if(nomesSalvos.length){
      nomesSalvos.forEach(nomeSalvo=>{
        const procExato = pacOdontoFindProcExato(nomeSalvo);
        if(!procExato) return;
        const tipo = getTipoCobranca(procExato.id);
        const dentesStr = tipo!=='global' && !isNaN(num) ? String(num) : '';
        const key = String(procExato.id) + '|' + dentesStr;
        if(adicionados.has(key)) return;
        const preco = procExato.precoFinal || 0;
        const item = {
          procId: procExato.id,
          nome: procExato.nome,
          precoUnit: preco,
          qtd: 1,
          dentes: dentesStr,
          tipo,
          faces: info.face || '',
          total: preco
        };
        adicionados.set(key, item);
        pacOdontoOrcList.push(item);
      });
      return;
    }

    // 2) Só se não houver procedimento salvo, usa sugestão por condição.
    // Essa parte é fallback e pode escolher um procedimento genérico.
    if(!info.condicao || info.condicao==='higido') return;
    const cond = info.condicao.toLowerCase();
    const keywords = COND_PARA_PROC[cond] || [];
    if(!keywords.length) return;

    const proc = procs.find(p=>{
      const n = (p.nome||'').toLowerCase();
      return keywords.some(k=>n.includes(k)) && (p.ativo!==false);
    });
    if(!proc) return;

    const tipo = getTipoCobranca(proc.id);
    const dentesStr = tipo!=='global' && !isNaN(num) ? String(num) : '';
    const key = String(proc.id) + '|' + dentesStr;
    if(adicionados.has(key)) return;

    const preco = proc.precoFinal||0;
    const item = {procId:proc.id, nome:proc.nome, precoUnit:preco, qtd:1, dentes:dentesStr, tipo, faces:info.face||'', total:preco};
    adicionados.set(key, item);
    pacOdontoOrcList.push(item);
  });

  if(pacOdontoOrcList.length) showToast(pacOdontoOrcList.length+' procedimento(s) sugerido(s) pelo odontograma');
}

function pacOdontoPopularSelect(){
  const sel = document.getElementById('pac-odonto-orc-proc');
  if(!sel) return;
  // Garante que procs está carregado
  if(!procs.length){
    sel.innerHTML = '<option value="">Carregando procedimentos...</option>';
    loadFinanceiro().then(()=>{ pacOdontoPopularSelect(); });
    return;
  }
  const grupos = [...new Set(procs.map(p=>p.grupo).filter(Boolean))].sort();
  let optsHtml = '<option value="">Selecione procedimento</option>';
  grupos.forEach(g=>{
    const gProcs = procs.filter(p=>p.grupo===g);
    optsHtml += `<optgroup label="${g}">` +
      gProcs.map(p=>`<option value="${p.id}" data-preco="${p.precoFinal||0}" data-nome="${escapeHtml(p.nome)}">${escapeHtml(p.nome)} — R$ ${(p.precoFinal||0).toFixed(2).replace('.',',')}</option>`).join('') +
      '</optgroup>';
  });
  sel.innerHTML = optsHtml;
}

function getTipoCobranca(procId){
  const p = procs.find(x=>x.id===procId);
  if(!p) return 'global';
  if(p.tipoCobranca) return p.tipoCobranca;
  if(p.tipo_cobranca) return p.tipo_cobranca;
  return procIsGlobal(p.nome) ? 'global' : 'por_dente';
}


// Busca procedimento EXATO salvo no odontograma.
// Importante: não usa busca parcial aqui, para não trocar "Endodontia - 3 canais" por "Endodontia - Necro (1 canal)".
function pacOdontoFindProcExato(nome){
  const alvo = (nome||'').trim().toLowerCase();
  if(!alvo) return null;
  return procs.find(p => (p.nome||'').trim().toLowerCase() === alvo && p.ativo !== false) || null;
}

function pacOdontoUpsertItemOrc(proc, dente, faces){
  if(!proc) return;
  const num = parseInt(dente);
  const tipo = getTipoCobranca(proc.id);
  const preco = proc.precoFinal || 0;
  const dentesStr = tipo !== 'global' && !isNaN(num) ? String(num) : '';
  const key = String(proc.id) + '|' + dentesStr;
  const idx = pacOdontoOrcList.findIndex(x => String(x.procId) + '|' + (x.dentes||'') === key);
  const qtd = tipo === 'global' ? 1 : 1;
  const item = {
    procId: proc.id,
    nome: proc.nome,
    precoUnit: preco,
    qtd,
    dentes: dentesStr,
    tipo,
    faces: tipo === 'global' ? '' : (faces || ''),
    total: preco * qtd
  };
  if(idx >= 0) pacOdontoOrcList[idx] = item;
  else pacOdontoOrcList.push(item);
}

function pacOdontoAddOrc(){
  // Tenta de todas as formas encontrar o procedimento
  let proc = null;

  // 0. Pela variável de seleção (mais confiável)
  if(pacOdontoOrcSelProc && pacOdontoOrcSelProc.id){
    proc = procs.find(p=>p.id===pacOdontoOrcSelProc.id);
  }

  // 1. Pelo hidden input
  if(!proc){
    const hidVal = parseInt(document.getElementById('pac-odonto-orc-proc')?.value||'0');
    if(hidVal) proc = procs.find(p=>p.id===hidVal) || procs.find(p=>String(p.id)===String(hidVal));
  }

  // 2. Pelo texto da busca
  if(!proc){
    const txt = (document.getElementById('pac-odonto-orc-search')?.value||'').trim().toLowerCase();
    if(txt) proc = procs.find(p=>p.nome.toLowerCase()===txt) || procs.find(p=>p.nome.toLowerCase().includes(txt));
  }

  // 3. Pelo nome exibido no sel-nome
  if(!proc){
    const nm = (document.getElementById('pac-odonto-orc-sel-nome')?.textContent||'').split(' — ')[0].trim();
    if(nm) proc = procs.find(p=>p.nome===nm);
  }

  if(!proc){
    showToast('Selecione um procedimento na lista antes de adicionar.','warn');
    // Abre o dropdown para ajudar
    pacOdontoFiltrarProcs();
    document.getElementById('pac-odonto-orc-dropdown').style.display='block';
    return;
  }

  // Recolagem de braquete tem preço variável conforme o tipo de aparelho do paciente —
  // abre o modal de seleção em vez de adicionar direto com o preço fixo do procedimento.
  // Mesma detecção usada no resto do sistema (catálogo atual não tem mais "braquete"/
  // "aparelho" no nome — só "Recolagem (peça quebrada) — X" — a checagem antiga nunca
  // disparava para procedimentos com o nome atual).
  if(PROC_IDS_RECOLAGEM.has(proc.id) || /recolagem/i.test(proc.nome)){
    abrirModalRecolagem(proc);
    return;
  }

  const tipo = getTipoCobranca(proc.id);
  const preco = proc.precoFinal||0;
  const dentesAuto = tipo==='por_dente' ? dentesParaProcedimento(proc.nome) : [];
  const dentesStr = dentesAuto.join(',');
  const qtd = tipo==='global' ? 1 : Math.max(1, dentesAuto.length);

  pacOdontoOrcList.push({procId:proc.id, nome:proc.nome, precoUnit:preco, qtd, dentes:dentesStr, tipo, total:preco*qtd});

  // Limpa
  const srch=document.getElementById('pac-odonto-orc-search'); if(srch) srch.value='';
  const inp=document.getElementById('pac-odonto-orc-proc'); if(inp) inp.value='';
  const nm2=document.getElementById('pac-odonto-orc-sel-nome'); if(nm2) nm2.textContent='';
  pacOdontoOrcSelProc=null;
  pacOdontoRenderOrcLista();
  showToast(proc.nome+' adicionado'+(dentesAuto.length?' ('+dentesAuto.length+' dentes)':tipo==='global'?' (global)':''));
}


function pacOdontoRenderOrcLista(){
  const c = document.getElementById('pac-odonto-orc-lista'); if(!c) return;
  if(!pacOdontoOrcList.length){
    c.innerHTML = '<div style="color:var(--rose-text);font-size:12px;text-align:center;padding:8px;">Pesquise e adicione procedimentos acima.</div>';
    document.getElementById('pac-odonto-orc-total').textContent = 'R$ 0,00';
    return;
  }
  const TODOS = [18,17,16,15,14,13,12,11,21,22,23,24,25,26,27,28,48,47,46,45,44,43,42,41,31,32,33,34,35,36,37,38,55,54,53,52,51,61,62,63,64,65,85,84,83,82,81,71,72,73,74,75];
  let total = 0;
  let out = '';
  pacOdontoOrcList.forEach((it,i)=>{
    total += it.total;
    const dArr = (it.dentes||'').split(',').map(Number).filter(Boolean);
    const isGlobal = getTipoCobranca(it.procId||0)==='global';
    let card = '<div style="border:1px solid var(--rose-light);border-radius:10px;padding:10px;margin-bottom:8px;background:#fff;">';
    card += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">';
    card += '<span style="flex:1;font-size:13px;font-weight:600;">'+escapeHtml(it.nome)+'</span>';
    if(isGlobal) card += '<span style="font-size:11px;color:#1565c0;background:#e3f2fd;padding:2px 7px;border-radius:10px;">Global</span>';
    if(dArr.length) card += '<span style="background:var(--rose-lighter);color:var(--rose-dark);border-radius:6px;padding:2px 6px;font-size:11px;">🦷 '+dArr.join(', ')+'</span>';
    if(it.faces) card += '<span style="background:#f3e5f5;color:#6a1b9a;border-radius:6px;padding:2px 6px;font-size:11px;">'+escapeHtml(it.faces)+'</span>';
    // Controle de quantidade
    card += '<div style="display:flex;align-items:center;gap:2px;border:1px solid var(--rose-light);border-radius:6px;overflow:hidden;">';
    card += '<button type="button" onclick="orcQtdChange('+i+',-1)" style="width:24px;height:24px;border:none;background:var(--rose-lighter);cursor:pointer;font-size:14px;font-weight:700;color:var(--rose-dark);display:flex;align-items:center;justify-content:center;">−</button>';
    card += '<span style="width:24px;text-align:center;font-size:12px;font-weight:700;color:var(--rose-dark);">'+it.qtd+'</span>';
    card += '<button type="button" onclick="orcQtdChange('+i+',1)" style="width:24px;height:24px;border:none;background:var(--rose-lighter);cursor:pointer;font-size:14px;font-weight:700;color:var(--rose-dark);display:flex;align-items:center;justify-content:center;">+</button>';
    card += '</div>';
    if(it.qtd > 1) card += '<span style="font-size:10px;color:var(--rose-text);">'+it.qtd+'x '+fmtBRL(it.precoUnit)+'</span>';
    card += '<input type="number" min="0" step="0.01" value="'+it.total.toFixed(2)+'" onchange="pacOdontoOrcList['+i+'].total=parseFloat(this.value)||0;pacOdontoRenderOrcLista();" style="width:80px;padding:3px 6px;border:1px solid var(--rose-light);border-radius:6px;font-size:12px;text-align:right;font-weight:700;color:var(--rose-dark);"/>';
    card += '<button class="btn-danger" style="padding:2px 6px;" onclick="pacOdontoOrcList.splice('+i+',1);pacOdontoRenderOrcLista();"><i class="ti ti-x"></i></button>';
    card += '</div>';
    if(!isGlobal){
      card += '<div style="margin-top:4px;"><div style="font-size:11px;color:var(--rose-text);margin-bottom:5px;">'+(dArr.length?'Dentes (clique para ajustar):':'Selecione os dentes:')+'</div>';
      card += '<div style="display:flex;flex-wrap:wrap;gap:3px;">';
      TODOS.forEach(d=>{
        const s=dArr.includes(d);
        card+='<button type="button" onclick="orcDenteToggle('+i+','+d+')" style="width:26px;height:26px;border:1.5px solid '+(s?'var(--rose)':'var(--rose-light)')+';border-radius:5px;background:'+(s?'var(--rose)':'#fff')+';color:'+(s?'#fff':'#3a2020')+';font-size:10px;cursor:pointer;padding:0;">'+d+'</button>';
      });
      card += '</div><div style="font-size:11px;color:var(--rose-text);margin-top:4px;">'+(dArr.length?dArr.length+' dente(s)':'Nenhum selecionado')+'</div></div>';
    }
    card += '</div>';
    out += card;
  });
  c.innerHTML = out;
  document.getElementById('pac-odonto-orc-total').textContent = 'R$ '+total.toFixed(2).replace('.',',');
}

function orcDenteToggle(idx,d){
  const it=pacOdontoOrcList[idx]; if(!it) return;
  let arr=(it.dentes||'').split(',').map(Number).filter(Boolean);
  const i=arr.indexOf(d);
  if(i>=0) arr.splice(i,1); else arr.push(d);
  arr.sort((a,b)=>a-b);
  it.dentes=arr.join(','); it.qtd=Math.max(1,arr.length); it.total=it.precoUnit*it.qtd;
  pacOdontoRenderOrcLista();
}

function orcQtdChange(idx, delta){
  const it=pacOdontoOrcList[idx]; if(!it) return;
  it.qtd = Math.max(1, (it.qtd||1) + delta);
  it.total = it.precoUnit * it.qtd;
  pacOdontoRenderOrcLista();
}

function pacOdontoLimparOrc(){
  pacOdontoOrcList = [];
  pacOdontoRenderOrcLista();
}

async function pacOdontoSalvarOrc(){
  if(!pacOdontoOrcList.length){ showToast('Adicione procedimentos ao orçamento.','warn'); return; }
  const pacId = selectedPatientId;
  const pac = pacientes.find(p=>p.id===pacId);
  const total = pacOdontoOrcList.reduce((a,it)=>a+it.total, 0);
  // Salva como orçamento em vendas
  const venda = {
    id: nextVendaId++, status:'orcamento',
    pacienteId: pacId, pacienteNome: pac?.nome||'',
    itens: pacOdontoOrcList.map(it=>({procId:it.procId,qtd:it.qtd,nome:it.nome,dente:it.dentes,descDente:''})),
    subtotal: parseFloat(total.toFixed(2)),
    desconto: 0, total: parseFloat(total.toFixed(2)),
    data: new Date().toISOString()
  };
  vendas.push(venda);
  showLoading(true); const _eOdont=await saveFinanceiro(); showLoading(false);
  pacOdontoOrcList = [];
  pacOdontoRenderOrcLista();
  if(!_eOdont) showToast('Orçamento salvo! Veja em Financeiro → Vendas.');
  else showToast('Erro ao salvar orçamento: '+_eOdont.message,'error');
}


// ── WhatsApp Confirmação ──
function enviarConfirmacaoWpp(tel, nome, data, horario, procedimento){
  const num = tel.replace(/\D/g,'');
  const numBR = num.startsWith('55') ? num : '55' + num;
  const [y,m,d] = data.split('-');
  const dataFmt = `${d}/${m}/${y}`;
  const clinica = clinicaData?.nome_cli || 'nossa clínica';
  const endereco = clinicaData?.endereco || cfg.endereco || '';
  const mapsLink = clinicaData?.maps_link || cfg.maps_link || '';
  let locPart = '';
  if(endereco || mapsLink){
    locPart = '\n📍 *Local:* ' + (endereco || clinica);
    if(mapsLink) locPart += '\n🗺️ *Como chegar:* ' + mapsLink;
    locPart += '\n';
  }
  const msg = `Olá, ${_primeiroNome(nome)}! 😊\n\nTudo bem? Passando para confirmar o seu horário marcado conosco ${_prepClinica(clinica)}:\n\n📅 *Data:* ${dataFmt}\n⏰ *Horário:* ${horario}\n🦷 *Procedimento:* ${procedimento}${locPart}\n\nResponda *SIM* para confirmar ou nos avise caso precise remarcar — será um prazer encontrar o melhor horário pra você! 🙏`;
  const url = `https://wa.me/${numBR}?text=${encodeURIComponent(msg)}`;
  window.open(url, '_blank');
}

// ── WhatsApp Recall (retorno atrasado) ──
function homeRecallWpp(pacId){
  const p = pacientes.find(x=>x.id===pacId); if(!p) return;
  const num = (p.telefone||'').replace(/\D/g,'');
  if(!num){ showToast('Paciente sem telefone cadastrado.','warn'); return; }
  const numBR = num.startsWith('55') ? num : '55' + num;
  const clinica = clinicaData?.nome_cli || 'nossa clínica';
  const msg = `Olá, ${_primeiroNome(p.nome)}! 😊\n\nAqui é ${_prepClinica(clinica)}. Sentimos sua falta por aqui! Já faz um tempinho desde a sua última visita, e a manutenção regular é essencial para a saúde do seu sorriso. 🦷✨\n\nQue tal agendarmos uma avaliação ou limpeza? Me diga qual o melhor dia e horário pra você que encontramos um encaixe! 🙏`;
  window.open(`https://wa.me/${numBR}?text=${encodeURIComponent(msg)}`, '_blank');
}

// ── WhatsApp Aniversário ──
function homeAniverWpp(pacId){
  const p = pacientes.find(x=>x.id===pacId); if(!p) return;
  const num = (p.telefone||'').replace(/\D/g,'');
  if(!num){ showToast('Paciente sem telefone cadastrado.','warn'); return; }
  const numBR = num.startsWith('55') ? num : '55' + num;
  const clinica = clinicaData?.nome_cli || 'nossa clínica';
  const msg = `🎉🎂 Parabéns, ${_primeiroNome(p.nome)}!\n\nToda a equipe ${_prepClinica(clinica)} deseja um feliz aniversário, com muita saúde, alegria e motivos de sobra para sorrir! 😁✨\n\nUm grande abraço! 🥳`;
  window.open(`https://wa.me/${numBR}?text=${encodeURIComponent(msg)}`, '_blank');
}

// ══════════════════════════════════════════════════════
// ASSINATURA DIGITAL
// ══════════════════════════════════════════════════════
let signCanvas = null, signCtx = null, signDrawing = false;
let signCallback = null;
let signLastX = 0, signLastY = 0, signHasStrokes = false;

let _signInited = false;
function initSignCanvas(){
  signCanvas = document.getElementById('sign-canvas');
  if(!signCanvas) return;
  signCtx = signCanvas.getContext('2d');
  signCanvas.width = signCanvas.offsetWidth || 460;
  signCanvas.height = 180;
  signCtx.strokeStyle = '#1a1a2e';
  signCtx.lineWidth = 2.5;
  signCtx.lineCap = 'round';
  signCtx.lineJoin = 'round';

  if(_signInited) return;
  _signInited = true;

  // Mouse
  signCanvas.addEventListener('mousedown', e=>{ signDrawing=true; signHasStrokes=true; const r=signCanvas.getBoundingClientRect(); signLastX=e.clientX-r.left; signLastY=e.clientY-r.top; });
  signCanvas.addEventListener('mousemove', e=>{ if(!signDrawing) return; const r=signCanvas.getBoundingClientRect(); const x=e.clientX-r.left,y=e.clientY-r.top; signCtx.beginPath(); signCtx.moveTo(signLastX,signLastY); signCtx.lineTo(x,y); signCtx.stroke(); signLastX=x; signLastY=y; });
  signCanvas.addEventListener('mouseup', ()=>signDrawing=false);
  signCanvas.addEventListener('mouseleave', ()=>signDrawing=false);

  // Touch
  signCanvas.addEventListener('touchstart', e=>{ e.preventDefault(); signDrawing=true; signHasStrokes=true; const r=signCanvas.getBoundingClientRect(); const t=e.touches[0]; signLastX=t.clientX-r.left; signLastY=t.clientY-r.top; },{passive:false});
  signCanvas.addEventListener('touchmove', e=>{ e.preventDefault(); if(!signDrawing) return; const r=signCanvas.getBoundingClientRect(); const t=e.touches[0]; const x=t.clientX-r.left,y=t.clientY-r.top; signCtx.beginPath(); signCtx.moveTo(signLastX,signLastY); signCtx.lineTo(x,y); signCtx.stroke(); signLastX=x; signLastY=y; },{passive:false});
  signCanvas.addEventListener('touchend', ()=>signDrawing=false);
}

function openSignModal(title, callback){
  const overlay = document.getElementById('sign-overlay');
  const titleEl = document.getElementById('sign-title');
  if(titleEl) titleEl.textContent = '✍️ ' + title;
  overlay.classList.add('open');
  signCallback = callback;
  setTimeout(()=>{ initSignCanvas(); signClear(); }, 100);
}

function closeSignModal(){
  document.getElementById('sign-overlay').classList.remove('open');
  signDrawing = false;
}

function signClear(){
  if(signCtx && signCanvas) signCtx.clearRect(0,0,signCanvas.width,signCanvas.height);
  signHasStrokes = false;
}

function signIsEmpty(){
  return !signHasStrokes;
}

function signConfirm(){
  if(signIsEmpty()){ showToast('Por favor, faça sua assinatura antes de confirmar.','warn'); return; }
  const dataUrl = signCanvas.toDataURL('image/png');
  closeSignModal();
  if(signCallback) signCallback(dataUrl);
  // Re-render é feito pelo _refreshSignArea dentro de cada callback de assinatura
}

// Armazena assinaturas por atendimento (em memória + salva no prontuário)
const assinaturasAtend = {}; // { atendId: { paciente: dataUrl, profissional: dataUrl } }

function getSignKey(pacId, atendId){ return `${pacId}_${atendId}`; }

function abrirAssinaturaPaciente(pacId, atendId, nomeAtend){
  const key = getSignKey(pacId, atendId);
  openSignModal(`Assinatura do Paciente — ${nomeAtend}`, (dataUrl)=>{
    if(!assinaturasAtend[key]) assinaturasAtend[key] = {};
    assinaturasAtend[key].paciente = dataUrl;
    showToast('Assinatura do paciente salva!');
    _refreshSignArea(pacId, atendId, nomeAtend);
    salvarAssinaturas(pacId, atendId);
  });
}

function abrirAssinaturaProfissional(pacId, atendId, nomeAtend){
  const key = getSignKey(pacId, atendId);
  openSignModal(`Assinatura do Profissional — ${nomeAtend}`, (dataUrl)=>{
    if(!assinaturasAtend[key]) assinaturasAtend[key] = {};
    assinaturasAtend[key].profissional = dataUrl;
    showToast('Assinatura do profissional salva!');
    _refreshSignArea(pacId, atendId, nomeAtend);
    salvarAssinaturas(pacId, atendId);
  });
}

function _refreshSignArea(pacId, atendId, nomeAtend){
  // Atualiza o HTML da área de assinatura imediatamente no DOM sem recarregar tudo
  const atend = pacProcsList.find(a => a.id === atendId);
  const prof = atend ? profissionais.find(p=>p.id==atend.profissional_id) : null;
  const profNome = prof?.nome || atend?.profissional_nome || '';
  const profCro  = prof?.cro || '';
  const newHtml = renderSignArea(pacId, atendId, nomeAtend, profNome, profCro);
  // Encontra o container da assinatura dentro do card correto
  const lista = document.getElementById('pac-proc-lista');
  if(!lista) return;
  const cards = lista.querySelectorAll('.atend-card');
  cards.forEach(card => {
    // Identifica o card pelo botão de assinatura que tem o atendId
    if(card.innerHTML.includes(`abrirAssinaturaPaciente(${pacId},${atendId},`)){
      const signDiv = card.querySelector('[data-sign-area]');
      if(signDiv){
        signDiv.outerHTML = newHtml;
      } else {
        // Fallback: re-render full list
        pacRenderProcLista();
      }
    }
  });
}

async function salvarAssinaturas(pacId, atendId){
  const key = getSignKey(pacId, atendId);
  const sigs = assinaturasAtend[key] || {};
  const sigJson = JSON.stringify(sigs);
  showLoading(true);
  const { error } = await _sb.from('atendimentos_odonto').update({ assinaturas: sigJson }).eq('id', atendId).eq('clinica_id', clinicaId);
  showLoading(false);
  if(error){ showToast('Erro ao salvar assinatura: '+error.message,'error'); console.error(error); }
  else { showToast('Assinatura salva!'); }
}

function renderSignArea(pacId, atendId, nomeAtend, profNome, profCro, sigExist){
  const key = getSignKey(pacId, atendId);
  const sigs = assinaturasAtend[key] || sigExist || {};
  const pacSig = sigs.paciente;
  const profSig = sigs.profissional;

  return `<div data-sign-area="1" style="border:1.5px solid var(--rose-light);border-radius:12px;padding:14px;margin-top:10px;background:#fdfaf9;">
    <div style="font-size:12px;font-weight:700;color:var(--rose-dark);margin-bottom:10px;text-transform:uppercase;letter-spacing:.5px;">✍️ Assinaturas</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
      <div>
        <div style="font-size:11px;color:var(--rose-text);margin-bottom:6px;">Paciente</div>
        <div class="sign-preview" style="min-height:60px;">
          ${pacSig ? `<img src="${pacSig}" style="max-height:55px;"/>` : '<span style="font-size:11px;color:var(--rose-text);">Sem assinatura</span>'}
        </div>
        <button class="btn-secondary" style="width:100%;margin-top:6px;font-size:11px;" onclick="abrirAssinaturaPaciente(${pacId},${atendId},'${escapeHtml(nomeAtend).replace(/'/g,"&#39;")}')">
          <i class="ti ti-signature"></i> ${pacSig ? 'Reassinar' : 'Assinar'}
        </button>
      </div>
      <div>
        <div style="font-size:11px;color:var(--rose-text);margin-bottom:6px;">Profissional</div>
        <div class="sign-preview" style="min-height:60px;">
          ${profSig ? `<img src="${profSig}" style="max-height:55px;"/>` : '<span style="font-size:11px;color:var(--rose-text);">Sem assinatura</span>'}
        </div>
        <button class="btn-secondary" style="width:100%;margin-top:6px;font-size:11px;" onclick="abrirAssinaturaProfissional(${pacId},${atendId},'${escapeHtml(nomeAtend).replace(/'/g,"&#39;")}')">
          <i class="ti ti-signature"></i> ${profSig ? 'Reassinar' : 'Assinar'}
        </button>
        ${profNome ? `<div style="font-size:10px;color:var(--rose-text);margin-top:4px;text-align:center;">${escapeHtml(profNome)}${profCro?' · '+escapeHtml(profCro):''}</div>` : ''}
      </div>
    </div>
  </div>`;
}

// ── ASSINATURA DIGITAL — ANAMNESE ──
const assinaturasAnamnese = {}; // { pacId: { paciente: dataUrl, profissional: dataUrl } }

function abrirAssinaturaPacienteAnamnese(pacId, nomePaciente){
  openSignModal(`Assinatura do Paciente — ${nomePaciente}`, (dataUrl)=>{
    if(!assinaturasAnamnese[pacId]) assinaturasAnamnese[pacId] = {};
    assinaturasAnamnese[pacId].paciente = dataUrl;
    showToast('Assinatura do paciente salva!');
    _refreshAnamneseSignArea(pacId, nomePaciente);
    salvarAssinaturasAnamnese(pacId);
  });
}

function abrirAssinaturaProfissionalAnamnese(pacId, nomePaciente){
  openSignModal(`Assinatura do Profissional — ${nomePaciente}`, (dataUrl)=>{
    if(!assinaturasAnamnese[pacId]) assinaturasAnamnese[pacId] = {};
    assinaturasAnamnese[pacId].profissional = dataUrl;
    showToast('Assinatura do profissional salva!');
    _refreshAnamneseSignArea(pacId, nomePaciente);
    salvarAssinaturasAnamnese(pacId);
  });
}

function _refreshAnamneseSignArea(pacId, nomePaciente){
  const p = pacientes.find(pt=>pt.id===pacId);
  const prof = profissionais.find(pr=>pr.id==p?.anamnese?.profissionalId);
  const newHtml = renderAnamneseSignArea(pacId, nomePaciente, prof?.nome||'', prof?.cro||'');
  const container = document.getElementById('pac-aba-anamnese');
  if(!container) return;
  const signDiv = container.querySelector('[data-sign-area]');
  if(signDiv){ signDiv.outerHTML = newHtml; }
}

async function salvarAssinaturasAnamnese(pacId){
  const sigs = assinaturasAnamnese[pacId] || {};
  const p = pacientes.find(pt=>pt.id===pacId);
  if(!p) return;
  const anamnese = { ...(p.anamnese||{}), assinaturas: sigs };
  showLoading(true);
  const { error: errAn } = await _sb.from('anamneses')
    .upsert({ paciente_id: pacId, clinica_id: clinicaId, dados: anamnese }, { onConflict: 'paciente_id' });
  if(errAn){
    const { error: errPac } = await _sb.from('pacientes').update({ anamnese }).eq('id', pacId);
    if(errPac){ showLoading(false); showToast('Erro ao salvar assinatura: '+errPac.message,'error'); return; }
  }
  showLoading(false);
  p.anamnese = anamnese;
  showToast('Assinatura salva!');
}

function renderAnamneseSignArea(pacId, nomePaciente, profNome, profCro, sigExist){
  const sigs = assinaturasAnamnese[pacId] || sigExist || {};
  const pacSig = sigs.paciente;
  const profSig = sigs.profissional;

  return `<div data-sign-area="1" style="border:1.5px solid var(--rose-light);border-radius:12px;padding:14px;margin-top:14px;background:#fdfaf9;">
    <div style="font-size:12px;font-weight:700;color:var(--rose-dark);margin-bottom:10px;text-transform:uppercase;letter-spacing:.5px;">✍️ Assinaturas</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
      <div>
        <div style="font-size:11px;color:var(--rose-text);margin-bottom:6px;">Paciente</div>
        <div class="sign-preview" style="min-height:60px;">
          ${pacSig ? `<img src="${pacSig}" style="max-height:55px;"/>` : '<span style="font-size:11px;color:var(--rose-text);">Sem assinatura</span>'}
        </div>
        <button class="btn-secondary" style="width:100%;margin-top:6px;font-size:11px;" onclick="abrirAssinaturaPacienteAnamnese(${pacId},'${escapeHtml(nomePaciente).replace(/'/g,"&#39;")}')">
          <i class="ti ti-signature"></i> ${pacSig ? 'Reassinar' : 'Assinar'}
        </button>
      </div>
      <div>
        <div style="font-size:11px;color:var(--rose-text);margin-bottom:6px;">Profissional</div>
        <div class="sign-preview" style="min-height:60px;">
          ${profSig ? `<img src="${profSig}" style="max-height:55px;"/>` : '<span style="font-size:11px;color:var(--rose-text);">Sem assinatura</span>'}
        </div>
        <button class="btn-secondary" style="width:100%;margin-top:6px;font-size:11px;" onclick="abrirAssinaturaProfissionalAnamnese(${pacId},'${escapeHtml(nomePaciente).replace(/'/g,"&#39;")}')">
          <i class="ti ti-signature"></i> ${profSig ? 'Reassinar' : 'Assinar'}
        </button>
        ${profNome ? `<div style="font-size:10px;color:var(--rose-text);margin-top:4px;text-align:center;">${escapeHtml(profNome)}${profCro?' · '+escapeHtml(profCro):''}</div>` : ''}
      </div>
    </div>
  </div>`;
}

// ── ASSINATURA DIGITAL — TERMO DE CONSENTIMENTO ──
const assinaturasTermo = {}; // { pacId: { paciente: dataUrl, profissional: dataUrl } }

function abrirAssinaturaPacienteTermo(pacId, nomePaciente){
  openSignModal(`Assinatura do Paciente — ${nomePaciente}`, (dataUrl)=>{
    if(!assinaturasTermo[pacId]) assinaturasTermo[pacId] = {};
    assinaturasTermo[pacId].paciente = dataUrl;
    showToast('Assinatura do paciente salva!');
    _refreshTermoSignArea(pacId, nomePaciente);
    salvarAssinaturasTermo(pacId);
  });
}

function abrirAssinaturaProfissionalTermo(pacId, nomePaciente){
  openSignModal(`Assinatura do Profissional — ${nomePaciente}`, (dataUrl)=>{
    if(!assinaturasTermo[pacId]) assinaturasTermo[pacId] = {};
    assinaturasTermo[pacId].profissional = dataUrl;
    showToast('Assinatura do profissional salva!');
    _refreshTermoSignArea(pacId, nomePaciente);
    salvarAssinaturasTermo(pacId);
  });
}

function _refreshTermoSignArea(pacId, nomePaciente){
  const p = pacientes.find(pt=>pt.id===pacId);
  const prof = profissionais.find(pr=>pr.id==p?.termo_consentimento?.profissionalId);
  const newHtml = renderTermoSignArea(pacId, nomePaciente, prof?.nome||'', prof?.cro||'');
  const container = document.getElementById('pac-aba-termo');
  if(!container) return;
  const signDiv = container.querySelector('[data-sign-area]');
  if(signDiv){ signDiv.outerHTML = newHtml; }
}

async function salvarAssinaturasTermo(pacId){
  const sigs = assinaturasTermo[pacId] || {};
  const p = pacientes.find(pt=>pt.id===pacId);
  if(!p) return;
  const termo = { ...(p.termo_consentimento||{}), assinaturas: sigs, data: hoje() };
  showLoading(true);
  const { error } = await _sb.from('pacientes').update({ termo_consentimento: termo }).eq('id', pacId);
  showLoading(false);
  if(error){ showToast('Erro ao salvar assinatura: '+error.message,'error'); return; }
  p.termo_consentimento = termo;
  showToast('Assinatura salva!');
}

function renderTermoSignArea(pacId, nomePaciente, profNome, profCro, sigExist){
  const sigs = assinaturasTermo[pacId] || sigExist || {};
  const pacSig = sigs.paciente;
  const profSig = sigs.profissional;

  return `<div data-sign-area="1" style="border:1.5px solid var(--rose-light);border-radius:12px;padding:14px;margin-top:14px;background:#fdfaf9;">
    <div style="font-size:12px;font-weight:700;color:var(--rose-dark);margin-bottom:10px;text-transform:uppercase;letter-spacing:.5px;">✍️ Assinaturas do Termo</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
      <div>
        <div style="font-size:11px;color:var(--rose-text);margin-bottom:6px;">Paciente</div>
        <div class="sign-preview" style="min-height:60px;">
          ${pacSig ? `<img src="${pacSig}" style="max-height:55px;"/>` : '<span style="font-size:11px;color:var(--rose-text);">Sem assinatura</span>'}
        </div>
        <button class="btn-secondary" style="width:100%;margin-top:6px;font-size:11px;" onclick="abrirAssinaturaPacienteTermo(${pacId},'${escapeHtml(nomePaciente).replace(/'/g,"&#39;")}')">
          <i class="ti ti-signature"></i> ${pacSig ? 'Reassinar' : 'Assinar'}
        </button>
      </div>
      <div>
        <div style="font-size:11px;color:var(--rose-text);margin-bottom:6px;">Profissional</div>
        <div class="sign-preview" style="min-height:60px;">
          ${profSig ? `<img src="${profSig}" style="max-height:55px;"/>` : '<span style="font-size:11px;color:var(--rose-text);">Sem assinatura</span>'}
        </div>
        <button class="btn-secondary" style="width:100%;margin-top:6px;font-size:11px;" onclick="abrirAssinaturaProfissionalTermo(${pacId},'${escapeHtml(nomePaciente).replace(/'/g,"&#39;")}')">
          <i class="ti ti-signature"></i> ${profSig ? 'Reassinar' : 'Assinar'}
        </button>
        ${profNome ? `<div style="font-size:10px;color:var(--rose-text);margin-top:4px;text-align:center;">${escapeHtml(profNome)}${profCro?' · '+escapeHtml(profCro):''}</div>` : ''}
      </div>
    </div>
  </div>`;
}



// ══════════════════════════════════════════════════════
// FLUXO ODONTOGRAMA → PLANO → ORÇAMENTOS → REALIZADOS
// ══════════════════════════════════════════════════════

// Salva orçamento rápido do odontograma e vai para Plano
async function odontogramaSalvarEIrParaPlano(pacId){
  const pid = pacId || selectedPatientId;
  if(!pid){ showToast('Selecione um paciente.','warn'); return; }

  // Transfere itens do orçamento rápido para o Plano de tratamento (banco de dados)
  if(pacOdontoOrcList.length > 0){
    showLoading(true);
    for(const it of pacOdontoOrcList){
      const dentesArr = (it.dentes||'').split(',').filter(Boolean);
      const dentesStr = dentesArr.join(',') || '–';
      const qtd = it.qtd || 1;
      const valorUnit = it.precoUnit || 0;
      const valorTotal = it.total != null ? it.total : valorUnit*qtd;
      const valorStr = valorTotal.toFixed(2).replace('.',',');
      const valorUnitStr = valorUnit.toFixed(2).replace('.',',');

      // Evita duplicar: checa se já existe no plano (qualquer status exceto cancelado)
      const jaExiste = pacPlanoList.some(i =>
        String(i.dente) === dentesStr &&
        i.procedimento === it.nome &&
        i.status !== 'cancelado'
      );
      if(jaExiste) continue;

      const { data: novo, error } = await _sb.from('plano_tratamento').insert([{
        clinica_id: clinicaId, paciente_id: pid,
        dente: dentesStr, face: it.faces || '–',
        procedimento: it.nome, valor: valorStr, valor_unit: valorUnitStr,
        descricao: '', status: 'pendente'
      }]).select().single();

      if(!error && novo){
        pacPlanoList.unshift(novo);
      } else if(error){
        // Fallback local se a coluna valor_unit não existir na tabela
        const { data: novo2, error: e2 } = await _sb.from('plano_tratamento').insert([{
          clinica_id: clinicaId, paciente_id: pid,
          dente: dentesStr, face: it.faces || '–',
          procedimento: it.nome, valor: valorStr,
          descricao: '', status: 'pendente'
        }]).select().single();
        if(!e2 && novo2) pacPlanoList.unshift(novo2);
      }
    }
    showLoading(false);
    pacOdontoOrcList = [];
    showToast('Procedimentos transferidos para o Plano!');
  } else {
    showToast('Indo para o Plano de Tratamento...','warn');
  }

  // Força seleção do paciente correto
  selectedPatientId = pid;

  // Vai para aba plano e ESPERA o plano carregar de fato do banco antes de
  // liberar a tela — antes havia um setTimeout fixo de 200ms que, em conexões
  // mais lentas (comum no mobile), terminava antes do carregamento do plano
  // concluir; quando o carregamento enfim chegava (já depois do usuário ter
  // clicado em "Aprovar Orçamento"), ele sobrescrevia a lista e fazia o
  // orçamento recém-aprovado desaparecer.
  renderPatientDetail('plano');
  await pacCarregarPlano(pid);
  const lista = document.getElementById('pac-plano-lista');
  if(lista) lista.scrollIntoView({behavior:'smooth',block:'start'});
}

// Ao salvar orçamento no Plano, vai para aba Orçamentos
async function salvarOrcEIrParaOrcamentos(pacId){
  await salvarOrcPac(pacId);
  setTimeout(()=>{ renderPatientDetail('orcamentos'); }, 300);
}

// Ao finalizar na aba Orçamentos, vai para Realizados
async function pacFinalizarEAssinar(vendaId, pacId){
  await pacFinalizarItensSelecionados(vendaId, pacId);
}

// ══════════════════════════════════════════════════════
// ORÇAMENTOS DO PACIENTE
// ══════════════════════════════════════════════════════
function formaPagamentoLabel(val){
  if(!val) return 'Dinheiro / Pix';
  if(val==='debito') return 'Débito';
  if(val.startsWith('credito')) return 'Crédito '+val.replace('credito','')+'x';
  return val;
}

async function pacOrcSetFormaPag(vendaId, valor, pacId){
  const v = vendas.find(x=>x.id===vendaId); if(!v) return;
  v.formaPagamento = valor;
  showLoading(true); const _eFP=await saveFinanceiro(); showLoading(false);
  if(_eFP) showToast('Erro ao salvar forma de pagamento: '+_eFP.message,'error');
  pacRenderOrcamentos(pacId);
}

// Estado dos checkboxes e desconto por venda (em memória)
const _orcSel   = {};  // _orcSel[vendaId]   = Set de índices selecionados
const _orcDesc  = {};  // _orcDesc[vendaId]  = { tipo:'pct'|'brl', valor: number }

function _orcGetSel(v){
  if(!_orcSel[v.id]){
    _orcSel[v.id] = new Set((v.itens||[]).map((_,i)=>i));
  }
  return _orcSel[v.id];
}
function _orcGetDesc(v){
  if(!_orcDesc[v.id]) _orcDesc[v.id]={tipo:'pct',valor:0};
  return _orcDesc[v.id];
}
function _orcCalcTotais(v){
  const sel = _orcGetSel(v);
  const desc = _orcGetDesc(v);
  const subtotalSel = (v.itens||[]).reduce((a,it,i)=> sel.has(i) ? a+(it.precoUnit||0)*(it.qtd||1) : a, 0);
  let descAmt = desc.tipo==='pct' ? subtotalSel*(desc.valor/100) : desc.valor;
  descAmt = Math.min(descAmt, subtotalSel);
  const totalSemTaxa = Math.max(0, subtotalSel - descAmt);
  // Aplica taxa da maquininha
  const forma = v.formaPagamento||'';
  let taxa = 0;
  if(forma==='debito') taxa = taxasCfg.debito||0;
  else if(forma.startsWith('credito')){
    const par = parseInt(forma.replace('credito',''))||1;
    taxa = (taxasCfg.credito||[])[par-1]||0;
  }
  const total = taxa>0 ? parseFloat((totalSemTaxa/(1-taxa/100)).toFixed(2)) : totalSemTaxa;
  const taxaAmt = parseFloat((total - totalSemTaxa).toFixed(2));
  return {subtotalSel, descAmt, total, taxa, taxaAmt, totalSemTaxa};
}

function pacOrcToggleItem(vendaId, idx){
  const v = vendas.find(x=>x.id===vendaId); if(!v) return;
  const sel = _orcGetSel(v);
  if(sel.has(idx)) sel.delete(idx); else sel.add(idx);
  pacRenderOrcamentos(v.pacienteId);
}
function pacOrcSetDesconto(vendaId, tipo, valor){
  const v = vendas.find(x=>x.id===vendaId); if(!v) return;
  _orcDesc[vendaId] = {tipo, valor: parseFloat(valor)||0};
  pacRenderOrcamentos(v.pacienteId);
}

function pacRenderOrcamentos(pacId){
  const c = document.getElementById('pac-orc-lista'); if(!c) return;
  const pacVendas = vendas.filter(v=>v.pacienteId===pacId).slice().reverse();

  // Botão voltar ao plano sempre no topo
  const btnVoltar = `<button class="btn-secondary" style="width:100%;justify-content:center;margin-bottom:12px;" onclick="renderPatientDetail('plano')">
    <i class="ti ti-arrow-left"></i> Voltar ao Plano de Tratamento
  </button>`;

  if(!pacVendas.length){
    c.innerHTML = btnVoltar + '<div style="text-align:center;color:var(--rose-text);font-size:13px;padding:20px;">Nenhum orçamento registrado ainda.<br><small>Monte um orçamento no Plano ou Odontograma.</small></div>';
    return;
  }
  const STATUS = {orcamento:{lbl:'Orçamento',cls:'orcamento'},finalizada:{lbl:'Finalizada',cls:'finalizada'},cancelada:{lbl:'Cancelada',cls:'cancelada'}};
  const cards = pacVendas.map(v=>{
    const si = STATUS[v.status]||STATUS.orcamento;
    const dt = new Date(v.data).toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit',year:'numeric'});
    const isOrc = v.status==='orcamento';
    const sel   = _orcGetSel(v);
    const desc  = _orcGetDesc(v);
    const {subtotalSel, descAmt, total: totalSel, taxa, taxaAmt} = _orcCalcTotais(v);
    const subtotalGeral = v.subtotal||v.total||0;
    const totalGeral = v.total||subtotalGeral;

    // Itens com checkbox (só em orçamentos abertos)
    const itensHtml = (v.itens||[]).map((it,i)=>{
      const valorIt = (it.precoUnit||0)*(it.qtd||1);
      const checked = sel.has(i);
      if(isOrc){
        return `<div style="display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid var(--rose-light);font-size:13px;${!checked?'opacity:.45;':''}">
          <input type="checkbox" ${checked?'checked':''} onchange="pacOrcToggleItem(${v.id},${i})" style="width:16px;height:16px;accent-color:var(--rose);flex-shrink:0;cursor:pointer;" />
          <span style="flex:1;">${escapeHtml(it.nome||'—')}${it.dente?` <span style="font-size:11px;color:var(--rose-text);">🦷${it.dente}</span>`:''} ${(it.qtd||1)>1?`<span style="font-size:11px;color:var(--rose-text);">×${it.qtd}</span>`:''}</span>
          <strong style="color:var(--rose-dark);">${fmtBRL(valorIt)}</strong>
          <button onclick="pacOrcRemoveItem(${v.id},${i},${pacId})" style="border:none;background:none;color:#dc2626;font-size:16px;cursor:pointer;padding:0 2px;flex-shrink:0;line-height:1;" title="Remover item">✕</button>
        </div>`;
      }
      return `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--rose-light);font-size:13px;">
        <span>${escapeHtml(it.nome||'—')}${it.dente?` <span style="font-size:11px;color:var(--rose-text);">🦷${it.dente}</span>`:''} ${(it.qtd||1)>1?`<span style="font-size:11px;color:var(--rose-text);">×${it.qtd}</span>`:''}</span>
        <strong>${fmtBRL(valorIt)}</strong>
      </div>`;
    }).join('');

    // Controles de desconto (só em orçamentos abertos)
    const descontoHtml = isOrc ? `
      <div style="margin-bottom:10px;">
        <label style="display:block;font-size:11px;font-weight:700;color:var(--rose-text);text-transform:uppercase;margin-bottom:6px;">Desconto nos itens selecionados</label>
        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
          <select id="orc-desc-tipo-${v.id}"
            onchange="pacOrcSetDesconto(${v.id},this.value,document.getElementById('orc-desc-val-${v.id}').value)"
            style="padding:6px 8px;border:1px solid var(--rose-light);border-radius:8px;font-size:13px;background:var(--rose-lighter);">
            <option value="pct" ${desc.tipo==='pct'?'selected':''}>%</option>
            <option value="brl" ${desc.tipo==='brl'?'selected':''}>R$</option>
          </select>
          <input id="orc-desc-val-${v.id}" type="number" min="0" step="0.01" value="${desc.valor||0}"
            oninput="pacOrcSetDesconto(${v.id},document.getElementById('orc-desc-tipo-${v.id}').value,this.value)"
            style="width:90px;padding:6px 8px;border:1px solid var(--rose-light);border-radius:8px;font-size:13px;text-align:right;" />
          ${descAmt>0?`<span style="font-size:12px;color:#2e7d32;font-weight:700;">− ${fmtBRL(descAmt)}</span>`:''}
        </div>
      </div>` : '';

    // Forma de pagamento
    const formaPagHtml = isOrc ? `
      <div style="margin-bottom:10px;">
        <label style="display:block;font-size:11px;font-weight:700;color:var(--rose-text);text-transform:uppercase;margin-bottom:4px;">Forma de pagamento</label>
        <select onchange="pacOrcSetFormaPag(${v.id},this.value,${pacId})" style="width:100%;">
          <option value="" ${!v.formaPagamento?'selected':''}>Dinheiro / Pix</option>
          <option value="debito" ${v.formaPagamento==='debito'?'selected':''}>Débito${taxasCfg.debito>0?' ('+taxasCfg.debito+'%)':''}</option>
          ${[1,2,3,4,5,6,7,8,9,10,11,12].map(n=>{const t=(taxasCfg.credito||[])[n-1]||0;return `<option value="credito${n}" ${v.formaPagamento==='credito'+n?'selected':''}>Crédito ${n}x${t>0?' ('+t+'%)':''}</option>`;}).join('')}
        </select>
      </div>` :
      (v.formaPagamento?`<div style="font-size:12px;color:var(--rose-text);margin-bottom:10px;">Pagamento: ${formaPagamentoLabel(v.formaPagamento)}</div>`:'');

    // Resumo financeiro
    const resumoHtml = isOrc ? `
      <div style="background:var(--rose-lighter);border-radius:10px;padding:10px 12px;font-size:13px;margin-bottom:12px;">
        <div style="display:flex;justify-content:space-between;color:var(--rose-text);"><span>Selecionados</span><span>${sel.size} de ${(v.itens||[]).length} item(ns)</span></div>
        <div style="display:flex;justify-content:space-between;margin-top:4px;"><span>Subtotal selecionados</span><span>${fmtBRL(subtotalSel)}</span></div>
        ${descAmt>0?`<div style="display:flex;justify-content:space-between;color:#2e7d32;"><span>Desconto</span><span>− ${fmtBRL(descAmt)}</span></div>`:''}
        ${taxaAmt>0?`<div style="display:flex;justify-content:space-between;color:#856404;font-size:12px;"><span>Taxa maquininha (${taxa}%)</span><span>+ ${fmtBRL(taxaAmt)}</span></div>`:''}
        <div style="display:flex;justify-content:space-between;font-weight:800;font-size:14px;margin-top:6px;border-top:1px solid var(--rose-light);padding-top:6px;"><span>Total a finalizar</span><span style="color:var(--rose-dark);">${fmtBRL(totalSel)}</span></div>
      </div>` : `
      <div style="background:var(--rose-lighter);border-radius:10px;padding:10px 12px;font-size:13px;margin-bottom:12px;">
        <div style="display:flex;justify-content:space-between;"><span>Subtotal</span><span>${fmtBRL(subtotalGeral)}</span></div>
        ${(v.desconto||0)>0?`<div style="display:flex;justify-content:space-between;color:#2e7d32;"><span>Desconto</span><span>− ${fmtBRL(v.desconto)}</span></div>`:''}
        <div style="display:flex;justify-content:space-between;font-weight:800;font-size:14px;margin-top:6px;border-top:1px solid var(--rose-light);padding-top:6px;"><span>Total</span><span style="color:var(--rose-dark);">${fmtBRL(totalGeral)}</span></div>
      </div>`;

    // Aviso de itens pendentes restantes
    const pendentesRestantes = (v.itens||[]).length - sel.size;
    const avisoHtml = isOrc && pendentesRestantes > 0 ? `
      <div style="background:#fff8e1;border:1px solid #ffe082;border-radius:8px;padding:8px 10px;font-size:12px;color:#7a5c00;margin-bottom:8px;">
        <i class="ti ti-info-circle"></i> ${pendentesRestantes} item(ns) não selecionado(s) continuarão pendentes para a próxima visita.
      </div>` : '';

    return `<div style="border:1.5px solid ${isOrc?'var(--rose)':'var(--rose-light)'};border-radius:14px;overflow:hidden;margin-bottom:14px;background:#fff;box-shadow:${isOrc?'0 4px 20px rgba(212,115,90,.13)':'0 1px 6px rgba(0,0,0,.05)'};">
      <!-- Cabeçalho -->
      <div style="background:${isOrc?'var(--rose-lighter)':'#fafafa'};padding:14px 16px;border-bottom:1px solid var(--rose-light);display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:8px;">
        <div style="flex:1;min-width:0;">
          <div style="font-size:15px;font-weight:800;color:var(--rose-dark);">${escapeHtml(v.pacienteNome||'—')}</div>
          <div style="font-size:12px;color:var(--rose-text);margin-top:2px;">📅 ${dt}${v.validade?' · ⏱️ Válido até: '+new Date(v.validade).toLocaleDateString('pt-BR'):''}</div>
          <div style="display:flex;gap:6px;align-items:center;margin-top:6px;flex-wrap:wrap;">
            <span class="fin-badge ${si.cls}">${si.lbl}</span>
            ${isOrc?`<select onchange="pacOrcSetStatus(${v.id},this.value,${pacId})" style="font-size:11px;padding:3px 8px;border:1.5px solid var(--rose-light);border-radius:8px;background:#fff;color:#3a2020;cursor:pointer;"><option value="" ${!v.statusResposta?'selected':''}>⏳ Aguardando</option><option value="pensando" ${v.statusResposta==='pensando'?'selected':''}>🤔 Pensando...</option><option value="aprovado_pac" ${v.statusResposta==='aprovado_pac'?'selected':''}>✅ Paciente aprovou</option><option value="recusado" ${v.statusResposta==='recusado'?'selected':''}>❌ Recusado</option></select>`:''}
          </div>
        </div>
        <div style="text-align:right;flex-shrink:0;">
          <div style="font-size:22px;font-weight:900;color:var(--rose-dark);">${fmtBRL(isOrc?totalSel:totalGeral)}</div>
          ${isOrc&&taxa>0?`<div style="font-size:10px;color:#856404;margin-top:1px;">incl. taxa ${taxa}%</div>`:''}
        </div>
      </div>
      ${isOrc?`
      <!-- Corpo 2 colunas (orçamento aberto) -->
      <div style="display:grid;grid-template-columns:1fr 300px;align-items:start;" class="orc-body-grid">
        <!-- Esquerda: itens -->
        <div style="padding:14px;border-right:1px solid var(--rose-light);">
          ${(v.itens||[]).length>1?`<div style="display:flex;gap:6px;margin-bottom:8px;align-items:center;"><span style="font-size:11px;color:var(--rose-text);flex:1;">${sel.size} de ${(v.itens||[]).length} selecionado(s)</span><button class="btn-secondary" style="font-size:11px;padding:4px 9px;" onclick="pacOrcSelectAll(${v.id},${pacId})"><i class="ti ti-checkbox"></i> Todos</button><button class="btn-secondary" style="font-size:11px;padding:4px 9px;" onclick="pacOrcDeselectAll(${v.id},${pacId})"><i class="ti ti-square"></i> Nenhum</button></div>`:''}
          <div>${itensHtml||'<div style="font-size:13px;color:var(--rose-text);">Sem itens</div>'}</div>
          <textarea placeholder="Observações (ex: inclui anestesia, 2 sessões...)" rows="2" id="orc-obs-${v.id}" oninput="pacOrcSetObs(${v.id},this.value)" style="width:100%;margin-top:8px;padding:8px 10px;border:1.5px solid var(--rose-light);border-radius:8px;font-size:12px;resize:vertical;box-sizing:border-box;">${escapeHtml(v.obs||'')}</textarea>
          <div style="margin-top:8px;"><button class="btn-secondary" style="width:100%;justify-content:center;font-size:12px;" onclick="pacOrcToggleAddItem(${v.id})"><i class="ti ti-plus"></i> Adicionar procedimento</button><div id="orc-add-${v.id}" style="display:none;margin-top:6px;border:1.5px solid var(--rose-light);border-radius:8px;padding:8px;"><div style="position:relative;"><input type="text" id="orc-add-search-${v.id}" placeholder="🔍 Pesquisar procedimento..." oninput="pacOrcSearchItem(${v.id},this.value)" onfocus="pacOrcSearchItem(${v.id},this.value)" onblur="setTimeout(()=>{const d=document.getElementById('orc-add-opts-${v.id}');if(d)d.style.display='none'},300)" style="width:100%;padding:7px 10px;border:1.5px solid var(--rose-light);border-radius:7px;font-size:12px;box-sizing:border-box;"/><div id="orc-add-opts-${v.id}" style="display:none;position:absolute;top:100%;left:0;right:0;background:#fff;border:1.5px solid var(--rose-light);border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.12);z-index:400;max-height:180px;overflow-y:auto;margin-top:2px;"></div></div><input type="hidden" id="orc-add-proc-${v.id}"/><div style="display:flex;gap:6px;align-items:center;margin-top:5px;"><span id="orc-add-nome-${v.id}" style="flex:1;font-size:11px;color:var(--rose-dark);font-weight:600;"></span><button class="btn-primary" style="font-size:11px;" onclick="pacOrcConfirmAddItem(${v.id},${pacId})"><i class="ti ti-plus"></i> Add</button></div></div></div>
        </div>
        <!-- Direita: pagamento + resumo + ações -->
        <div style="padding:14px;display:flex;flex-direction:column;gap:8px;position:sticky;top:0;">
          ${descontoHtml}
          ${formaPagHtml}
          ${resumoHtml}
          <div style="margin-bottom:4px;padding:10px;background:#fff8e1;border:1.5px solid #ffe082;border-radius:10px;">
            <label style="display:flex;align-items:center;gap:4px;font-size:11px;font-weight:700;color:#7a5c00;text-transform:uppercase;margin-bottom:4px;"><i class="ti ti-cash" style="font-size:14px;"></i> Entrada (R$)</label>
            <input type="number" id="orc-entrada-${v.id}" step="0.01" min="0" value="0" placeholder="0,00" style="width:100%;padding:7px 8px;border:1.5px solid #ffe082;border-radius:8px;font-size:13px;box-sizing:border-box;background:#fff;"/>
            <div style="font-size:10px;color:#7a5c00;margin-top:2px;">Deixe 0 se o paciente pagar o total agora</div>
          </div>
          ${avisoHtml}
          <select id="venda-prof-${v.id}" style="width:100%;font-size:12px;padding:7px 8px;border:1.5px solid var(--rose-light);border-radius:8px;color:#3a2020;"><option value="">Quem atendeu?</option>${profissionais.map(pr=>`<option value="${pr.id}">${escapeHtml(pr.nome)}</option>`).join('')}</select>
          <button class="btn-primary" style="width:100%;justify-content:center;padding:11px;" onclick="pacFinalizarItensSelecionados(${v.id},${pacId})" ${sel.size===0?'disabled':''}><i class="ti ti-circle-check"></i> Finalizar${sel.size<(v.itens||[]).length&&sel.size>0?' selecionados':''}</button>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
            <button class="btn-secondary" style="font-size:12px;justify-content:center;padding:8px;" onclick="gerarPdfOrcamento(${v.id},${pacId})"><i class="ti ti-file-type-pdf"></i> PDF</button>
            <button class="btn-secondary" style="font-size:12px;justify-content:center;padding:8px;background:#e8f5e9;border-color:#a5d6a7;color:#2e7d32;" onclick="pacModoApresentacao(${v.id},${pacId})"><i class="ti ti-presentation"></i> Apresentar</button>
          </div>
          <button class="btn-secondary" style="width:100%;justify-content:center;font-size:12px;padding:8px;background:#e8f5e9;border-color:#a5d6a7;color:#1b5e20;" onclick="pacOrcWhatsApp(${v.id},${pacId})"><i class="ti ti-brand-whatsapp"></i> Enviar por WhatsApp</button>
          <button class="btn-danger" style="width:100%;justify-content:center;font-size:12px;" onclick="excluirVenda(${v.id});setTimeout(()=>pacRenderOrcamentos(${pacId}),300)"><i class="ti ti-trash"></i> Excluir</button>
        </div>
      </div>`:`
      <!-- Corpo compacto (finalizado/cancelado) -->
      <div style="padding:14px;">
        <div style="margin-bottom:10px;">${itensHtml||''}</div>
        ${v.obs?`<div style="font-size:12px;color:var(--rose-text);margin-bottom:10px;padding:8px;background:var(--rose-lighter);border-radius:8px;"><i class="ti ti-notes"></i> ${escapeHtml(v.obs)}</div>`:''}
        ${resumoHtml}
        ${v.formaPagamento?`<div style="font-size:12px;color:var(--rose-text);margin-top:6px;">💳 ${formaPagamentoLabel(v.formaPagamento)}</div>`:''}
        ${(()=>{
          if(v.status!=='finalizada'||!v.pagamentos?.length) return '';
          const pgTotal=(v.pagamentos||[]).reduce((s,p)=>s+p.valor,0);
          const saldo=(v.total||0)-pgTotal;
          return `<div style="margin-top:10px;padding:10px;background:${saldo>0?'#fff8e1':'#e8f5e9'};border:1px solid ${saldo>0?'#ffe082':'#a5d6a7'};border-radius:10px;font-size:12px;">
            <div style="font-weight:700;margin-bottom:6px;color:${saldo>0?'#e65100':'#2e7d32'};"><i class="ti ti-${saldo>0?'alert-circle':'circle-check'}"></i> ${saldo>0?'Pagamento parcial — falta '+fmtBRL(saldo):'Totalmente pago'}</div>
            ${v.pagamentos.map(pg=>`<div style="display:flex;justify-content:space-between;padding:3px 0;"><span>${new Date(pg.data).toLocaleDateString('pt-BR')} — ${pg.forma==='pix'?'PIX':pg.forma==='credito'?'Cartão Crédito'+(pg.parcelas_cartao>1?' '+pg.parcelas_cartao+'x':''):pg.forma==='debito'?'Cartão Débito':'Dinheiro'}${pg.obs?' ('+escapeHtml(pg.obs)+')':''}</span><strong>${fmtBRL(pg.valor)}</strong></div>`).join('')}
          </div>`;
        })()}
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px;">
          ${v.status==='finalizada'?`<button class="btn-secondary" style="font-size:12px;" onclick="cancelarVenda(${v.id});setTimeout(()=>pacRenderOrcamentos(${pacId}),300)"><i class="ti ti-arrow-back-up"></i> Cancelar</button>`:''}
          <button class="btn-secondary" style="font-size:12px;" onclick="gerarPdfOrcamento(${v.id},${pacId})"><i class="ti ti-file-type-pdf"></i> PDF</button>
          <button class="btn-danger" style="padding:8px 12px;" onclick="excluirVenda(${v.id});setTimeout(()=>pacRenderOrcamentos(${pacId}),300)"><i class="ti ti-trash"></i></button>
        </div>
      </div>`}
    </div>`;
  }).join('');

  // Botão consolidar (aparece quando há 2+ orçamentos abertos)
  const _orcAbertos = pacVendas.filter(x=>x.status==='orcamento');
  const btnConsolidar = _orcAbertos.length > 1
    ? `<button class="btn-secondary" style="width:100%;justify-content:center;margin-bottom:10px;background:#fff8e1;border-color:#ffe082;color:#7a5c00;" onclick="pacOrcConsolidar(${pacId})"><i class="ti ti-git-merge"></i> Consolidar ${_orcAbertos.length} orçamentos abertos em um só</button>`
    : '';

  c.innerHTML = btnVoltar + btnConsolidar + cards;
}

async function pacFinalizarVendaLista(vendaId, pacId){
  const v = vendas.find(x=>x.id===vendaId); if(!v) return;
  if(!confirm(`Finalizar venda de ${fmtBRL(v.total||0)}? O estoque será descontado.`)) return;
  // Atualiza item do plano para realizado
  if(v.planoItemId){
    const {error:_ePl}=await _sb.from('plano_tratamento').update({status:'realizado'}).eq('id',v.planoItemId);
    if(_ePl) console.error('Erro ao atualizar plano:',_ePl.message);
    pacPlanoList = pacPlanoList.map(i=>i.id===v.planoItemId?{...i,status:'realizado'}:i);
  } else if(v.itens?.length){
    for(const it of v.itens){
      const planoItem = pacPlanoList.find(p=>p.procedimento===it.nome&&p.status==='aprovado');
      if(planoItem){
        const {error:_ePl2}=await _sb.from('plano_tratamento').update({status:'realizado'}).eq('id',planoItem.id);
        if(_ePl2) console.error('Erro ao atualizar plano:',_ePl2.message);
        pacPlanoList = pacPlanoList.map(i=>i.id===planoItem.id?{...i,status:'realizado'}:i);
      }
    }
  }
  const itensProc = (v.itens||[]).filter(i=>i.procId).map(i=>({procId:i.procId,qtd:i.qtd||1}));
  const consumo = computeConsumo(itensProc);
  const aplicado = aplicarBaixaEstoque(consumo);
  v.status='finalizada'; v.consumo=aplicado; v.dataFinal=new Date().toISOString();
  showLoading(true);
  // Marca os itens do plano vinculados como 'realizado'
  if(v.planoIds && v.planoIds.length){
    for(const id of v.planoIds){
      const {error:_ePU}=await _sb.from('plano_tratamento').update({ status:'realizado' }).eq('id',id);
      if(_ePU) console.error('Erro ao atualizar plano:',_ePU.message);
      const item = pacPlanoList.find(i=>i.id===id);
      if(item) item.status='realizado';
    }
    if(typeof pacRenderPlanoResumo==='function') pacRenderPlanoResumo();
    if(typeof pacRenderPlanoLista==='function') pacRenderPlanoLista();
  }
  const _eFinV=await saveFinanceiro();

  // Cria automaticamente o registro de atendimento para assinatura
  const descProcs = (v.itens||[]).map(i=>{
    const dente = i.dente ? ` (dente ${i.dente})` : '';
    return `${i.nome||'Procedimento'}${dente}`;
  }).join(', ');
  const dentesTratados = JSON.stringify(
    (v.itens||[]).flatMap(i=>(i.dente||'').split(',').filter(Boolean).map(d=>({dente:parseInt(d),procedimento:i.nome})))
  );
  const { data: novoAtend, error: eAtend } = await _sb.from('atendimentos_odonto').insert([{
    clinica_id: clinicaId, paciente_id: pacId,
    data: hoje(), procedimentos: descProcs || 'Procedimentos realizados', obs: '',
    profissional_id: null, profissional_nome: '',
    dentes_tratados: dentesTratados
  }]).select().single();
  if(eAtend) console.error('Erro ao registrar atendimento:', eAtend.message);
  if(!eAtend && novoAtend) pacProcsList.unshift(novoAtend);

  showLoading(false);
  if(_eFinV) showToast('Erro ao finalizar venda: '+_eFinV.message,'error');
  else if(eAtend) showToast('Venda finalizada, mas erro ao registrar atendimento.','warn');
  else showToast('Venda finalizada!');
  pacRenderOrcamentos(pacId);
  // Abre aba de realizados para assinar
  renderPatientDetail('procs');
  setTimeout(()=>{ showToast('Colete as assinaturas do procedimento realizado.','warn'); },800);
}


// Finaliza apenas os itens selecionados do orçamento; os demais ficam aprovados (pendentes)
async function pacFinalizarItensSelecionados(vendaId, pacId){
  const v = vendas.find(x=>x.id===vendaId); if(!v) return;
  const sel = _orcGetSel(v);
  const desc = _orcGetDesc(v);
  if(sel.size===0){ showToast('Selecione ao menos um item para finalizar.','warn'); return; }

  const profId = document.getElementById('venda-prof-'+vendaId)?.value || '';
  if(!profId){ showToast('Selecione quem atendeu o paciente antes de finalizar.','warn'); return; }
  const profNome = profissionais.find(p=>p.id==profId)?.nome || '';

  const itensSel   = (v.itens||[]).filter((_,i)=>sel.has(i));
  const itensRest  = (v.itens||[]).filter((_,i)=>!sel.has(i));

  const {subtotalSel, descAmt, total: totalFinal} = _orcCalcTotais(v);

  let entradaVal = parseFloat(document.getElementById('orc-entrada-'+vendaId)?.value)||0;
  if(entradaVal>totalFinal){ showToast('Entrada não pode ser maior que o total.','error'); return; }
  const formaPag = v.formaPagamento||'';
  const temEntrada = entradaVal>0 && entradaVal<totalFinal;

  const msgEntrada = temEntrada ? `\nEntrada: ${fmtBRL(entradaVal)} — Restante: ${fmtBRL(totalFinal-entradaVal)} (vai para aba Financeiro)` : '';
  if(!confirm(`Finalizar ${itensSel.length} item(ns) por ${fmtBRL(totalFinal)}?${msgEntrada}\n${itensRest.length>0?itensRest.length+' item(ns) ficará(ão) pendente(s) para a próxima visita.':''}`)) return;

  showLoading(true);

  // 1. Desconta estoque dos itens selecionados
  const itensProc = itensSel.filter(i=>i.procId).map(i=>({procId:i.procId,qtd:i.qtd||1}));
  const consumo   = computeConsumo(itensProc);
  const aplicado  = aplicarBaixaEstoque(consumo);

  // 2. Marca planoIds dos itens selecionados como 'realizado'
  // Preferência: planoId gravado no próprio item (à prova de remoção/consolidação);
  // fallback por índice só para vendas antigas sem esse campo.
  const _temPlanoIdNosItens = (v.itens||[]).some(i=>i.planoId);
  const planoIdsSel = _temPlanoIdNosItens
    ? itensSel.map(i=>i.planoId).filter(Boolean)
    : (v.planoIds||[]).filter((_,i)=>sel.has(i));
  // Compatibilidade: vendas criadas pelo botão "✔ Aprovar" individual usam
  // planoItemId (singular) em vez de planoIds — sem isso o item ficava
  // "aprovado" pra sempre no Plano mesmo após a venda ser finalizada.
  if(v.planoItemId && !planoIdsSel.includes(v.planoItemId)) planoIdsSel.push(v.planoItemId);
  for(const pid of planoIdsSel){
    const {error:_ePSel}=await _sb.from('plano_tratamento').update({status:'realizado'}).eq('id',pid);
    if(_ePSel){ showLoading(false); showToast('Erro ao marcar item do plano: '+_ePSel.message,'error'); return; }
    const pl = pacPlanoList.find(p=>p.id===pid);
    if(pl) pl.status='realizado';
  }

  // Monta array de pagamentos
  const _pagamentos = [];
  const _valorPag = temEntrada ? entradaVal : totalFinal;
  _pagamentos.push({
    id: Date.now(),
    valor: parseFloat(_valorPag.toFixed(2)),
    forma: formaPag==='debito'?'debito':formaPag.startsWith('credito')?'credito':(formaPag||'dinheiro'),
    parcelas_cartao: formaPag.startsWith('credito')?(parseInt(formaPag.replace('credito',''))||1):1,
    data: new Date().toISOString(),
    obs: temEntrada?'Entrada':''
  });

  if(itensRest.length===0){
    // Finaliza a venda inteira normalmente
    v.status='finalizada';
    v.desconto=parseFloat(descAmt.toFixed(2));
    v.subtotal=parseFloat(subtotalSel.toFixed(2));
    v.total=parseFloat(totalFinal.toFixed(2));
    v.consumo=aplicado;
    v.dataFinal=new Date().toISOString();
    v.profissional_id=profId||null;
    v.profissional_nome=profNome;
    v.pagamentos = (v.pagamentos||[]).concat(_pagamentos);
    delete _orcSel[vendaId];
    delete _orcDesc[vendaId];
  } else {
    // Cria nova venda finalizada só com os itens selecionados
    const novaVenda = {
      id: nextVendaId++, status:'finalizada',
      formaPagamento: v.formaPagamento||'',
      pacienteId: pacId, pacienteNome: v.pacienteNome||'',
      itens: itensSel,
      subtotal: parseFloat(subtotalSel.toFixed(2)),
      desconto: parseFloat(descAmt.toFixed(2)),
      total: parseFloat(totalFinal.toFixed(2)),
      planoIds: planoIdsSel,
      consumo: aplicado,
      data: new Date().toISOString(),
      dataFinal: new Date().toISOString(),
      profissional_id: profId||null,
      profissional_nome: profNome,
      pagamentos: _pagamentos
    };
    vendas.push(novaVenda);

    // Atualiza venda original: remove itens finalizados, recalcula totais
    const planoIdsRest = _temPlanoIdNosItens
      ? itensRest.map(i=>i.planoId).filter(Boolean)
      : (v.planoIds||[]).filter((_,i)=>!sel.has(i));
    v.itens    = itensRest;
    v.planoIds = planoIdsRest;
    const novoSub = itensRest.reduce((a,it)=>(a+(it.precoUnit||0)*(it.qtd||1)),0);
    v.subtotal = parseFloat(novoSub.toFixed(2));
    v.desconto = 0;
    v.total    = parseFloat(novoSub.toFixed(2));
    // Reseta estado de checkboxes para a venda original (agora com menos itens)
    delete _orcSel[vendaId];
    delete _orcDesc[vendaId];
  }

  const _eFinSel=await saveFinanceiro();
  if(_eFinSel){ showLoading(false); showToast('Erro ao finalizar itens: '+_eFinSel.message,'error'); return; }

  // 3. Cria atendimento para os itens finalizados
  const descProcs = itensSel.map(i=>{
    const dente = i.dente ? ` (dente ${i.dente})` : '';
    return `${i.nome||'Procedimento'}${dente}`;
  }).join(', ');
  const dentesTratados = JSON.stringify(
    itensSel.flatMap(i=>(i.dente||'').split(',').filter(Boolean).map(d=>({dente:parseInt(d),procedimento:i.nome})))
  );
  const {data:novoAtend,error:eAtend} = await _sb.from('atendimentos_odonto').insert([{
    clinica_id:clinicaId, paciente_id:pacId,
    data:hoje(), procedimentos:descProcs||'Procedimentos realizados', obs:'',
    profissional_id:profId||null, profissional_nome:profNome,
    dentes_tratados:dentesTratados
  }]).select().single();
  if(!eAtend && novoAtend) pacProcsList.unshift(novoAtend);

  if(typeof pacRenderPlanoResumo==='function') pacRenderPlanoResumo();
  if(typeof pacRenderPlanoLista==='function') pacRenderPlanoLista();

  showLoading(false);
  showToast(itensRest.length>0 ? `${itensSel.length} item(ns) finalizado(s)! ${itensRest.length} ficou(aram) pendente(s).` : 'Venda finalizada!');
  pacRenderOrcamentos(pacId);
  renderPatientDetail('procs');
  setTimeout(()=>{ showToast('Colete as assinaturas do procedimento realizado.','warn'); },800);
}

// ══════════════════════════════════════════════════════
// MELHORIAS DE ORÇAMENTO
// ══════════════════════════════════════════════════════

// ── Selecionar todos / nenhum no orçamento ──
function pacOrcSelectAll(vendaId, pacId){
  const v = vendas.find(x=>x.id===vendaId); if(!v) return;
  _orcSel[vendaId] = new Set((v.itens||[]).map((_,i)=>i));
  pacRenderOrcamentos(pacId);
}
function pacOrcDeselectAll(vendaId, pacId){
  const v = vendas.find(x=>x.id===vendaId); if(!v) return;
  _orcSel[vendaId] = new Set();
  pacRenderOrcamentos(pacId);
}

// ── Observações do orçamento ──
async function pacOrcSetObs(vendaId, obs){
  const v = vendas.find(x=>x.id===vendaId); if(!v) return;
  v.obs = obs;
  const _eObs=await saveFinanceiro();
  if(_eObs) showToast('Erro ao salvar observações: '+_eObs.message,'error');
}

// ── Validade do orçamento (editável no card) ──
async function pacOrcSetValidade(vendaId, val, pacId){
  const v = vendas.find(x=>x.id===vendaId); if(!v) return;
  v.validade = val || null;
  const _eVal=await saveFinanceiro();
  if(_eVal) showToast('Erro ao salvar validade: '+_eVal.message,'error');
}

// ── Adicionar item direto ao orçamento ──
function pacOrcToggleAddItem(vendaId){
  const panel = document.getElementById('orc-add-'+vendaId);
  if(!panel) return;
  panel.style.display = panel.style.display==='none' ? '' : 'none';
  if(panel.style.display!=='none'){
    const inp = document.getElementById('orc-add-search-'+vendaId);
    if(inp){ inp.value=''; inp.focus(); }
    document.getElementById('orc-add-proc-'+vendaId).value='';
    const nome = document.getElementById('orc-add-nome-'+vendaId);
    if(nome) nome.textContent='';
  }
}
function pacOrcSearchItem(vendaId, q){
  const opts = document.getElementById('orc-add-opts-'+vendaId);
  if(!opts) return;
  const term = (q||'').toLowerCase().trim();
  const resultados = procs.filter(p=>p.nome.toLowerCase().includes(term)||
    (p.grupo||'').toLowerCase().includes(term)).slice(0,12);
  if(!resultados.length||!term){ opts.style.display='none'; return; }
  opts.style.display='';
  opts.innerHTML = resultados.map(p=>`
    <div style="padding:8px 12px;cursor:pointer;font-size:13px;border-bottom:1px solid var(--rose-lighter);"
      onmousedown="pacOrcSelectItemAdd(${vendaId},${p.id},'${escapeHtml(p.nome).replace(/'/g,"&#39;")}')"
      onmouseover="this.style.background='var(--rose-lighter)'"
      onmouseout="this.style.background=''"
    >
      <div style="font-weight:600;">${escapeHtml(p.nome)}</div>
      <div style="font-size:11px;color:var(--rose-text);">${escapeHtml(p.grupo||'')} · ${fmtBRL(p.precoFinal||0)}</div>
    </div>`).join('');
}
function pacOrcSelectItemAdd(vendaId, procId, procNome){
  const inp  = document.getElementById('orc-add-search-'+vendaId);
  const hid  = document.getElementById('orc-add-proc-'+vendaId);
  const nome = document.getElementById('orc-add-nome-'+vendaId);
  const opts = document.getElementById('orc-add-opts-'+vendaId);
  if(inp)  inp.value  = procNome;
  if(hid)  hid.value  = procId;
  if(nome) nome.textContent = '';
  if(opts) opts.style.display='none';
}
async function pacOrcConfirmAddItem(vendaId, pacId){
  const v = vendas.find(x=>x.id===vendaId); if(!v) return;
  const procId = parseInt(document.getElementById('orc-add-proc-'+vendaId)?.value||0);
  if(!procId){ showToast('Selecione um procedimento antes de adicionar.','warn'); return; }
  const proc = procs.find(p=>p.id===procId);
  if(!proc){ showToast('Procedimento não encontrado.','error'); return; }
  const novoItem = { procId: proc.id, qtd:1, nome:proc.nome, dente:'', descDente:'', precoUnit: proc.precoFinal||0 };
  v.itens = [...(v.itens||[]), novoItem];
  const novo = (v.itens.length)-1;
  if(!_orcSel[vendaId]) _orcSel[vendaId] = new Set();
  _orcSel[vendaId].add(novo);
  v.subtotal = v.itens.reduce((a,it)=>a+(it.precoUnit||0)*(it.qtd||1),0);
  v.total = v.subtotal - (v.desconto||0);
  const _eAdd=await saveFinanceiro();
  if(!_eAdd) showToast(`${proc.nome} adicionado ao orçamento!`);
  else showToast('Erro ao adicionar item: '+_eAdd.message,'error');
  pacRenderOrcamentos(pacId);
}

// ── Remover item individual do orçamento ──
async function pacOrcRemoveItem(vendaId, idx, pacId){
  const v = vendas.find(x=>x.id===vendaId); if(!v) return;
  if(!confirm('Remover este item do orçamento?')) return;
  // Mantém planoIds alinhado com itens ao remover
  const _removido = (v.itens||[])[idx];
  if(v.planoIds && v.planoIds.length){
    if(_removido && _removido.planoId) v.planoIds = v.planoIds.filter(p=>p!==_removido.planoId);
    else if(v.planoIds.length === (v.itens||[]).length) v.planoIds = v.planoIds.filter((_,i)=>i!==idx);
  }
  v.itens = (v.itens||[]).filter((_,i)=>i!==idx);
  // Recalcular subtotal e total
  v.subtotal = v.itens.reduce((a,it)=>a+(it.precoUnit||0)*(it.qtd||1), 0);
  v.total = Math.max(0, v.subtotal - (v.desconto||0));
  const _eRem=await saveFinanceiro();
  pacRenderOrcamentos(pacId);
  if(!_eRem) showToast('Item removido.');
  else showToast('Erro ao remover item: '+_eRem.message,'error');
}

// ── Consolidar múltiplos orçamentos em um ──
async function pacOrcConsolidar(pacId){
  const abertos = vendas.filter(v=>v.pacienteId===pacId&&v.status==='orcamento');
  if(abertos.length<2){ showToast('Você precisa ter ao menos 2 orçamentos abertos para consolidar.','warn'); return; }
  if(!confirm(`Consolidar ${abertos.length} orçamentos em um único? Os originais serão removidos.`)) return;

  showLoading(true);
  // Junta todos os itens
  const todosItens = abertos.flatMap(v=>v.itens||[]);
  const todosSub   = abertos.reduce((a,v)=>a+(v.subtotal||0),0);
  const pac = pacientes.find(p=>p.id===pacId);
  const novaVenda = {
    id: nextVendaId++, status:'orcamento', formaPagamento:'',
    pacienteId: pacId, pacienteNome: pac?.nome||'',
    itens: todosItens, subtotal: todosSub, desconto:0, total:todosSub,
    planoIds: abertos.flatMap(v=>v.planoIds||[]),
    data: new Date().toISOString(), obs: abertos.map(v=>v.obs||'').filter(Boolean).join(' | ')||''
  };

  // Remove os antigos (backup para rollback em caso de erro)
  const idsRemover = new Set(abertos.map(v=>v.id));
  const _vendasBackup = [...vendas];
  vendas = vendas.filter(v=>!idsRemover.has(v.id));
  vendas.push(novaVenda);
  const _saveErr = await saveFinanceiro();
  showLoading(false);
  if(_saveErr){ vendas = _vendasBackup; nextVendaId--; showToast('Erro ao consolidar — dados restaurados.','error'); return; }
  showToast('Orçamentos consolidados com sucesso!');
  pacRenderOrcamentos(pacId);
}

// ── Status de resposta do paciente ──
async function pacOrcSetStatus(vendaId, status, pacId){
  const v = vendas.find(x=>x.id===vendaId); if(!v) return;
  v.statusResposta = status;
  const _eSts=await saveFinanceiro();
  if(_eSts){ showToast('Erro ao salvar status: '+_eSts.message,'error'); return; }
  // Feedback visual
  const colors = {pensando:'#856404',aprovado_pac:'#2e7d32',recusado:'#b33',''   :'#555'};
  const labels = {pensando:'🤔 Pensando...',aprovado_pac:'✅ Aprovado!',recusado:'❌ Recusado',''   :'⏳ Aguardando'};
  showToast(labels[status]||'Status atualizado');
}

// ── Modo Apresentação (tela cheia para mostrar ao paciente) ──
function pacModoApresentacao(vendaId, pacId){
  const v = vendas.find(x=>x.id===vendaId); if(!v) return;
  const pac = pacientes.find(p=>p.id===pacId);
  const sel = _orcGetSel(v);
  const {subtotalSel, descAmt, total:totalFinal, taxa, taxaAmt} = _orcCalcTotais(v);
  const itensSel = (v.itens||[]).filter((_,i)=>sel.has(i));
  if(!itensSel.length && (v.itens||[]).length>0){
    // Se nada selecionado, mostra tudo
    itensSel.push(...(v.itens||[]));
  }
  const clinicaNome = document.getElementById('header-clinica')?.textContent||'RWDent';

  // Simular parcelas (à vista + 6x)
  const parcOpts = [{n:1,total:totalFinal,taxa:0}];
  const credRates = taxasCfg.credito||[];
  for(let i=1;i<=5;i++){
    const t = credRates[i]||0;
    const tot = totalFinal*(1+t/100);
    parcOpts.push({n:i+1,total:tot,taxa:t});
  }

  document.getElementById('apres-modal')?.remove();
  const modal = document.createElement('div');
  modal.id = 'apres-modal';
  modal.className = 'apres-overlay';
  modal.innerHTML = `
    <button class="apres-close" onclick="document.getElementById('apres-modal').remove()">✕</button>
    <div style="max-width:580px;margin:0 auto;padding:32px 20px 60px;">
      <!-- Clínica -->
      <div style="text-align:center;margin-bottom:28px;padding-bottom:20px;border-bottom:2.5px solid var(--rose);">
        <div style="font-size:30px;font-weight:900;color:var(--rose-dark);letter-spacing:1px;">${escapeHtml(clinicaNome)}</div>
        <div style="font-size:13px;color:var(--rose-text);margin-top:4px;font-weight:600;text-transform:uppercase;letter-spacing:.8px;">Plano de Tratamento Odontológico</div>
      </div>
      <!-- Paciente -->
      <div style="background:var(--rose-lighter);border-radius:14px;padding:16px 20px;margin-bottom:24px;">
        <div style="font-size:11px;color:var(--rose-text);font-weight:700;text-transform:uppercase;letter-spacing:.5px;">Paciente</div>
        <div style="font-size:22px;font-weight:900;color:var(--rose-dark);margin-top:4px;">${escapeHtml(pac?.nome||'—')}</div>
        ${v.validade?`<div style="font-size:12px;color:#856404;margin-top:6px;">⏱️ Proposta válida até ${new Date(v.validade).toLocaleDateString('pt-BR')}</div>`:''}
      </div>
      <!-- Procedimentos -->
      <div style="margin-bottom:24px;">
        <div style="font-size:11px;font-weight:700;color:var(--rose-text);text-transform:uppercase;letter-spacing:.5px;margin-bottom:12px;">Procedimentos incluídos</div>
        ${itensSel.map(it=>`
          <div style="display:flex;justify-content:space-between;align-items:center;padding:12px 0;border-bottom:1px solid var(--rose-light);">
            <div>
              <div style="font-weight:700;color:#3a2020;font-size:14px;">${escapeHtml(it.nome||'—')}</div>
              ${it.dente?`<div style="font-size:12px;color:var(--rose-text);">🦷 Dente ${escapeHtml(String(it.dente))}</div>`:''}
              ${it.qtd>1?`<div style="font-size:11px;color:var(--rose-text);">${it.qtd}x</div>`:''}
            </div>
            <div style="font-weight:800;color:var(--rose);font-size:15px;flex-shrink:0;margin-left:12px;">${fmtBRL((it.precoUnit||0)*(it.qtd||1))}</div>
          </div>`).join('')}
      </div>
      <!-- Total -->
      <div style="background:linear-gradient(135deg,var(--rose),var(--rose-dark));border-radius:16px;padding:22px 24px;margin-bottom:24px;text-align:center;">
        ${descAmt>0?`<div style="font-size:13px;color:rgba(255,255,255,.8);margin-bottom:4px;">De ${fmtBRL(subtotalSel)} com desconto de ${fmtBRL(descAmt)}</div>`:''}
        <div style="font-size:13px;color:rgba(255,255,255,.75);">Investimento total</div>
        <div style="font-size:40px;font-weight:900;color:#fff;letter-spacing:1px;line-height:1.1;">${fmtBRL(totalFinal)}</div>
        ${taxaAmt>0?`<div style="font-size:11px;color:rgba(255,255,255,.65);margin-top:6px;">* inclui taxa de ${taxa}% da maquininha</div>`:''}
      </div>
      <!-- Parcelamento -->
      <div style="margin-bottom:28px;">
        <div style="font-size:11px;font-weight:700;color:var(--rose-text);text-transform:uppercase;letter-spacing:.5px;margin-bottom:12px;">Opções de pagamento</div>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;">
          ${parcOpts.map(p=>`
            <div style="border:2px solid ${p.n===1?'#66bb6a':'var(--rose-light)'};border-radius:12px;padding:12px 8px;text-align:center;background:${p.n===1?'#e8f5e9':'#fff'};">
              <div style="font-size:10px;font-weight:700;color:${p.n===1?'#2e7d32':'var(--rose-text)'};text-transform:uppercase;">${p.n===1?'À VISTA':p.n+'x no cartão'}</div>
              <div style="font-size:${p.n===1?'20':'17'}px;font-weight:900;color:${p.n===1?'#2e7d32':'var(--rose-dark)'};margin-top:2px;">${p.n===1?fmtBRL(p.total):fmtBRL(p.total/p.n)}</div>
              ${p.taxa>0?`<div style="font-size:9px;color:var(--rose-text);margin-top:1px;">total ${fmtBRL(p.total)}</div>`:`<div style="font-size:9px;font-weight:700;color:#2e7d32;">SEM JUROS</div>`}
            </div>`).join('')}
        </div>
      </div>
      ${v.obs?`<div style="background:#fff8e1;border-radius:10px;padding:14px;font-size:13px;color:#7a5c00;margin-bottom:20px;"><strong>Observações:</strong> ${escapeHtml(v.obs)}</div>`:''}
      <div style="display:flex;gap:10px;justify-content:center;" class="apres-acoes no-print">
        <button onclick="apresPrintPDF()" style="background:var(--rose);color:#fff;border:none;border-radius:10px;padding:12px 24px;font-size:14px;font-weight:700;cursor:pointer;display:flex;align-items:center;gap:8px;"><i class="ti ti-file-type-pdf"></i> Salvar PDF</button>
        <button onclick="document.getElementById('apres-modal').remove()" style="background:#fff;color:var(--rose-dark);border:1.5px solid var(--rose-light);border-radius:10px;padding:12px 24px;font-size:14px;font-weight:700;cursor:pointer;">Fechar</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
}
function apresPrintPDF(){
  const modal = document.getElementById('apres-modal');
  if(!modal) return;
  const style = document.createElement('style');
  style.id='apres-print-style';
  style.textContent='@media print{body>*{display:none!important;}#apres-modal{display:block!important;position:static!important;background:#fff!important;}.apres-close,.no-print{display:none!important;}}';
  document.head.appendChild(style);
  window.print();
  setTimeout(()=>document.getElementById('apres-print-style')?.remove(),1000);
}

// ── Enviar orçamento por WhatsApp ──
function pacOrcWhatsApp(vendaId, pacId){
  const v = vendas.find(x=>x.id===vendaId); if(!v) return;
  const pac = pacientes.find(p=>p.id===pacId);
  const sel = _orcGetSel(v);
  const {total:totalFinal} = _orcCalcTotais(v);
  const clinicaNome = document.getElementById('header-clinica')?.textContent||'Clínica';
  const itensSel = (v.itens||[]).filter((_,i)=>sel.has(i));
  const telefone = pac?.telefone?.replace(/\D/g,'')||'';

  let msg = `*${clinicaNome}* — Orçamento Odontológico\n\n`;
  msg += `Olá, ${_primeiroNome(pac?.nome)}! 😊 Preparamos um orçamento personalizado pra você ${_prepClinica(clinicaNome)}. Confira abaixo:\n\n`;
  itensSel.forEach(it=>{
    msg += `• ${it.nome}${it.dente?' (dente '+it.dente+')':''}${it.qtd>1?' x'+it.qtd:''}: ${fmtBRL((it.precoUnit||0)*(it.qtd||1))}\n`;
  });
  msg += `\n*Total: ${fmtBRL(totalFinal)}*`;
  if(v.validade) msg += `\n⏱️ Válido até ${new Date(v.validade).toLocaleDateString('pt-BR')}`;
  if(v.obs) msg += `\n📝 ${v.obs}`;
  msg += '\n\nQualquer dúvida estamos à disposição! 😊';

  const base = telefone ? `https://wa.me/55${telefone}` : 'https://wa.me/';
  const url = base + '?text=' + encodeURIComponent(msg);
  if(!v.statusResposta){ v.statusResposta='pensando'; v.enviadoEm=new Date().toISOString(); saveFinanceiro(); }
  logAtividade('Orçamento enviado', `${pac?.nome||'—'} — ${fmtBRL(totalFinal)}`);
  window.open(url, '_blank');
}

// ── Urgência nos itens do plano (salvo em localStorage) ──
function pacPlanoSetUrgencia(itemId, urgencia){
  const key = 'urg_' + (clinicaId||'0') + '_' + itemId;
  if(urgencia) localStorage.setItem(key, urgencia);
  else localStorage.removeItem(key);
  pacRenderPlanoLista();
}
function pacPlanoGetUrgencia(itemId){
  return localStorage.getItem('urg_' + (clinicaId||'0') + '_' + itemId)||'';
}

// ── Preview de desconto e simulação de parcelas na aba Plano ──
function pacPlanoAtualizarPreview(){
  const ativos = pacPlanoList.filter(i=>i.status!=='cancelado');
  const total  = ativos.reduce((acc,i)=>acc+parseFloat((i.valor||'0').replace(',','.')),0);
  const tipo   = document.getElementById('plano-desc-tipo')?.value||'pct';
  const val    = parseFloat(document.getElementById('plano-desc-val')?.value||0)||0;
  const descAmt = tipo==='pct' ? total*val/100 : Math.min(val,total);
  const totalFinal = Math.max(0, total-descAmt);
  const preview = document.getElementById('plano-desc-preview');
  if(preview) preview.textContent = val>0 ? `Total com desconto: ${fmtBRL(totalFinal)} (− ${fmtBRL(descAmt)})` : '';
  pacPlanoRenderParcelamento(totalFinal||total);
}

function pacPlanoRenderParcelamento(total){
  const c = document.getElementById('plano-parc-sim');
  if(!c) return;
  if(!total||total<=0){ c.style.display='none'; c.innerHTML=''; return; }
  c.style.display='';
  const rows = [];
  for(let n=1;n<=6;n++){
    const taxa = n===1 ? 0 : ((taxasCfg.credito||[])[n-1]||0);
    const totalComTaxa = total*(1+taxa/100);
    const parcela = totalComTaxa/n;
    rows.push(`<div style="display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid var(--rose-lighter);gap:8px;">
      <span style="font-weight:700;min-width:30px;">${n}x</span>
      <span style="font-weight:800;color:var(--rose-dark);flex:1;">${fmtBRL(parcela)}</span>
      ${taxa>0?`<span style="font-size:10px;color:var(--rose-text);">Taxa ${taxa}% · Total ${fmtBRL(totalComTaxa)}</span>`:`<span style="font-size:10px;color:#2e7d32;font-weight:600;">sem juros</span>`}
    </div>`);
  }
  c.innerHTML = `<div style="font-size:11px;font-weight:700;color:var(--rose-text);text-transform:uppercase;letter-spacing:.4px;margin-bottom:8px;"><i class="ti ti-calculator"></i> Simulação de parcelas</div>${rows.join('')}`;
}

// ── Recibo de pagamento em PDF (jsPDF) ──
function gerarReciboPagamento(vendaId, pgId, pacId){
  const v = vendas.find(x=>x.id===vendaId);
  if(!v){ showToast('Venda não encontrada.','error'); return; }
  const pg = (v.pagamentos||[]).find(p=>p.id===pgId);
  if(!pg){ showToast('Pagamento não encontrado.','error'); return; }
  if(!window.jspdf){ showToast('jsPDF não carregado.','error'); return; }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  const pac = pacientes.find(p=>p.id===pacId);
  const clinicaNome = clinicaData?.nome_cli || document.getElementById('header-clinica')?.textContent || 'Clínica';
  const respNome = clinicaData?.nome_resp || '';
  const endereco = clinicaData?.endereco || '';
  const telefone = clinicaData?.telefone || '';
  const rose = [212,115,90], dark = [122,48,32], text = [58,32,32];
  const formaLbl = pg.forma==='pix'?'PIX':pg.forma==='credito'?('Cartão de Crédito'+(pg.parcelas_cartao>1?' em '+pg.parcelas_cartao+'x':'')):pg.forma==='debito'?'Cartão de Débito':'Dinheiro';
  const valorExt = fmtBRL(pg.valor);
  const dtPg = new Date(pg.data);

  // Cabeçalho
  doc.setFillColor(...rose); doc.rect(0,0,210,32,'F');
  doc.setFontSize(18); doc.setTextColor(255,255,255); doc.setFont(undefined,'bold');
  doc.text(clinicaNome,105,14,{align:'center'});
  doc.setFontSize(10); doc.setFont(undefined,'normal');
  doc.text('RECIBO DE PAGAMENTO',105,22,{align:'center'});

  let y = 46;
  doc.setTextColor(...text); doc.setFontSize(11);
  // Nº do recibo e data
  doc.setFont(undefined,'bold'); doc.text(`Recibo Nº ${vendaId}-${String(pgId).slice(-5)}`,14,y);
  doc.setFont(undefined,'normal'); doc.text(dtPg.toLocaleDateString('pt-BR'),196,y,{align:'right'}); y+=12;

  // Valor em destaque
  doc.setFillColor(253,240,235); doc.roundedRect(14,y,182,20,3,3,'F');
  doc.setFontSize(16); doc.setFont(undefined,'bold'); doc.setTextColor(...dark);
  doc.text(valorExt,105,y+13,{align:'center'}); y+=30;

  // Corpo
  doc.setFontSize(11); doc.setTextColor(...text); doc.setFont(undefined,'normal');
  const linhas = doc.splitTextToSize(
    `Recebemos de ${pac?.nome||v.pacienteNome||'—'} a importância de ${valorExt}, `+
    `na forma de pagamento ${formaLbl}, referente a: ${(v.itens||[]).map(i=>i.nome).join(', ')||'serviços odontológicos'}.`+
    (pg.obs?` (${pg.obs})`:''), 182);
  doc.text(linhas,14,y); y += linhas.length*6 + 6;

  // Situação da venda
  const pago = vendaValorPago(v);
  const saldo = Math.max(0,(v.total||0)-pago);
  doc.setFontSize(10);
  doc.text(`Valor total do tratamento: ${fmtBRL(v.total||0)}`,14,y); y+=6;
  doc.text(`Total pago até a data: ${fmtBRL(pago)}`,14,y); y+=6;
  doc.setFont(undefined,'bold');
  doc.text(saldo>0?`Saldo restante: ${fmtBRL(saldo)}`:'Situação: QUITADO',14,y); y+=16;

  // Assinatura
  doc.setFont(undefined,'normal'); doc.setDrawColor(...text);
  doc.line(60,y+18,150,y+18);
  doc.setFontSize(10);
  doc.text(respNome||clinicaNome,105,y+24,{align:'center'});
  const rodape = [endereco, telefone && 'Tel: '+telefone].filter(Boolean).join(' — ');
  if(rodape){ doc.setFontSize(8); doc.setTextColor(120,120,120); doc.text(rodape,105,285,{align:'center'}); }

  doc.save(`recibo-${(pac?.nome||'paciente').split(' ')[0].toLowerCase()}-${dtPg.toISOString().slice(0,10)}.pdf`);
  showToast('Recibo gerado!');
}

// ── Geração de PDF do orçamento (jsPDF) ──
function gerarPdfOrcamento(vendaId, pacId){
  const v = vendas.find(x=>x.id===vendaId);
  if(!v){ showToast('Orçamento não encontrado.','error'); return; }
  if(!window.jspdf){ showToast('jsPDF não carregado.','error'); return; }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  const pac = pacientes.find(p=>p.id===pacId);
  const clinicaNome = document.getElementById('header-clinica')?.textContent||'Clínica';
  const dt = new Date(v.data).toLocaleDateString('pt-BR');
  const sel = _orcGetSel(v);
  const {subtotalSel, descAmt, total:totalFinal, taxa, taxaAmt} = _orcCalcTotais(v);
  const itensSel = (v.itens||[]).filter((_,i)=>sel.has(i));

  // Cores
  const rose = [212,115,90];
  const dark = [122,48,32];
  const text = [58,32,32];

  // Cabeçalho
  doc.setFillColor(...rose);
  doc.rect(0,0,210,32,'F');
  doc.setFontSize(18); doc.setTextColor(255,255,255); doc.setFont(undefined,'bold');
  doc.text(clinicaNome,105,14,{align:'center'});
  doc.setFontSize(10); doc.setFont(undefined,'normal');
  doc.text('ORÇAMENTO DE TRATAMENTO ODONTOLÓGICO',105,22,{align:'center'});

  // Info do paciente
  let y = 42;
  doc.setTextColor(...text); doc.setFontSize(10); doc.setFont(undefined,'bold');
  doc.text('Paciente:',14,y); doc.setFont(undefined,'normal'); doc.text(pac?.nome||'—',46,y); y+=7;
  doc.setFont(undefined,'bold'); doc.text('Data:',14,y); doc.setFont(undefined,'normal'); doc.text(dt,46,y);
  if(v.validade){
    const dtVal = new Date(v.validade).toLocaleDateString('pt-BR');
    doc.setFont(undefined,'bold'); doc.text('Válido até:',100,y); doc.setFont(undefined,'normal'); doc.text(dtVal,128,y);
  }
  y += 10;

  // Linha separadora
  doc.setDrawColor(...rose); doc.setLineWidth(0.5); doc.line(14,y,196,y); y+=6;

  // Cabeçalho tabela
  doc.setFillColor(253,240,235); doc.rect(14,y,182,7,'F');
  doc.setFontSize(9); doc.setFont(undefined,'bold'); doc.setTextColor(...dark);
  doc.text('PROCEDIMENTO',16,y+5);
  doc.text('DENTE',120,y+5);
  doc.text('QTD',148,y+5);
  doc.text('VALOR',170,y+5,{align:'right'});
  y+=9;

  // Itens
  doc.setFont(undefined,'normal'); doc.setTextColor(...text); doc.setFontSize(9);
  itensSel.forEach((it)=>{
    if(y>270){ doc.addPage(); y=20; }
    const valor = (it.precoUnit||0)*(it.qtd||1);
    const nomeStr = it.nome?.length>48 ? it.nome.substring(0,48)+'…' : (it.nome||'—');
    doc.text(nomeStr,16,y);
    doc.text(it.dente||'—',120,y);
    doc.text(String(it.qtd||1),148,y);
    doc.text(fmtBRL(valor),196,y,{align:'right'});
    y+=6;
    doc.setDrawColor(240,230,225); doc.line(14,y-1,196,y-1);
  });
  y+=4;

  // Totais
  doc.setDrawColor(...rose); doc.setLineWidth(0.5); doc.line(120,y,196,y); y+=5;
  doc.setFontSize(10);
  if(descAmt>0){
    doc.setTextColor(...text); doc.text('Subtotal:',120,y); doc.text(fmtBRL(subtotalSel),196,y,{align:'right'}); y+=6;
    doc.setTextColor(46,109,50); doc.text('Desconto:',120,y); doc.text('− '+fmtBRL(descAmt),196,y,{align:'right'}); y+=6;
    doc.setTextColor(...text);
  }
  if(taxaAmt>0){
    doc.setTextColor(133,100,0); doc.text(`Taxa (${taxa}%):`,120,y); doc.text('+ '+fmtBRL(taxaAmt),196,y,{align:'right'}); y+=6;
    doc.setTextColor(...text);
  }
  doc.setFont(undefined,'bold'); doc.setFontSize(12); doc.setTextColor(...dark);
  doc.text('TOTAL:',120,y); doc.text(fmtBRL(totalFinal),196,y,{align:'right'}); y+=8;
  doc.setFont(undefined,'normal'); doc.setTextColor(...text); doc.setFontSize(10);

  if(v.formaPagamento){
    doc.text(`Forma de pagamento: ${formaPagamentoLabel(v.formaPagamento)}`,14,y); y+=7;
  }
  if(v.obs){
    const obsLines = doc.splitTextToSize('Obs: '+v.obs,180);
    obsLines.forEach(l=>{ if(y>275){doc.addPage();y=20;} doc.text(l,14,y); y+=5; });
    y+=2;
  }

  // Assinaturas
  y = Math.max(y+20,230);
  if(y>265){ doc.addPage(); y=30; }
  doc.setDrawColor(...rose); doc.setLineWidth(0.4);
  doc.line(14,y,90,y); doc.line(116,y,196,y);
  doc.setFontSize(8); doc.setTextColor(...dark);
  doc.text('Assinatura do Paciente',14,y+5);
  doc.text('Responsável pela Clínica',116,y+5);

  const nomePac = (pac?.nome||'paciente').replace(/[^a-zA-Z0-9]/g,'_');
  doc.save(`Orcamento_${nomePac}_${dt.replace(/\//g,'-')}.pdf`);
  showToast('PDF gerado com sucesso!');
}

// ══════════════════════════════════════════════════════
// HISTÓRICO DO PACIENTE
// ══════════════════════════════════════════════════════

async function histSalvarEIrOdonto(pacId){
  await histSalvar(pacId);
  // Transfere dentes do histórico para o odontograma
  const dentes = Object.keys(histDentesProc).map(Number);
  if(dentes.length){
    // Salva cada dente no odontograma
    for(const dente of dentes){
      const denteProcs = histDentesProc[dente]||[];
      const cond = denteProcs[0]?.cond||'restaurado';
      const proc = document.getElementById('hist-proc')?.value||'';
      const {data:ex}=await _sb.from('procedimentos_dentes').select('id').eq('clinica_id',clinicaId).eq('paciente_id',pacId).eq('dente',dente).single();
      if(ex){ const {error:_eU}=await _sb.from('procedimentos_dentes').update({condicao:cond,procedimento:proc}).eq('id',ex.id); if(_eU) console.error('Erro odontograma:',_eU.message); }
      else   { const {error:_eI}=await _sb.from('procedimentos_dentes').insert([{clinica_id:clinicaId,paciente_id:pacId,dente,condicao:cond,procedimento:proc,obs:'',data:document.getElementById('hist-data')?.value||hoje()}]); if(_eI) console.error('Erro odontograma:',_eI.message); }
    }
    await pacCarregarOdonto(pacId);
  }
  renderPatientDetail('odonto');
  setTimeout(()=>showToast('Dentes transferidos para o Odontograma!'),300);
}

async function histCarregar(pacId){
  // Carrega atendimentos existentes
  await pacCarregarProcs(pacId);
  histRenderLista(pacId);
}


let odontoCondSel = [];
let odontoCondQtds = {};

function odontoToggleCond(val){
  const idx = odontoCondSel.indexOf(val);
  const wrap = document.querySelector('[data-ocond-wrap="'+val+'"]');
  const qtdWrap = document.querySelector('[data-ocond-qtd-wrap="'+val+'"]');
  if(idx>=0){
    odontoCondSel.splice(idx,1);
    delete odontoCondQtds[val];
    if(wrap){ wrap.style.borderColor='var(--rose-light)'; wrap.style.background='#fff'; }
    if(qtdWrap) qtdWrap.style.display='none';
  } else {
    odontoCondSel.push(val);
    odontoCondQtds[val]=1;
    if(wrap){ wrap.style.borderColor='var(--rose)'; wrap.style.background='var(--rose-lighter)'; }
    if(qtdWrap) qtdWrap.style.display='flex';
  }
  const inp = document.getElementById('pac-d-cond');
  if(inp) inp.value = odontoCondSel[0]||'higido';
}

function odontoCondQtd(val, delta){
  if(!odontoCondQtds[val]) return;
  odontoCondQtds[val] = Math.max(1,(odontoCondQtds[val]||1)+delta);
  const num = document.querySelector('[data-ocond-num="'+val+'"]');
  if(num) num.textContent = odontoCondQtds[val];
}

function odontoCondReset(){
  odontoCondSel=[]; odontoCondQtds={};
  document.querySelectorAll('[data-ocond-wrap]').forEach(w=>{
    w.style.borderColor='var(--rose-light)'; w.style.background='#fff';
  });
  document.querySelectorAll('[data-ocond-qtd-wrap]').forEach(w=>w.style.display='none');
  document.querySelectorAll('[data-ocond-num]').forEach(n=>n.textContent='1');
}


let histCondSel = [];
let histCondQtds = {};

function histToggleCond(val){
  const idx = histCondSel.indexOf(val);
  const wrap = document.querySelector('[data-hist-cond-wrap="'+val+'"]');
  const qtdWrap = document.querySelector('[data-hist-cond-qtd-wrap="'+val+'"]');
  if(idx>=0){
    histCondSel.splice(idx,1);
    delete histCondQtds[val];
    if(wrap){ wrap.style.borderColor='var(--rose-light)'; wrap.style.background='#fff'; }
    if(qtdWrap) qtdWrap.style.display='none';
  } else {
    histCondSel.push(val);
    histCondQtds[val]=1;
    if(wrap){ wrap.style.borderColor='var(--rose)'; wrap.style.background='var(--rose-lighter)'; }
    if(qtdWrap) qtdWrap.style.display='flex';
  }
  const inp=document.getElementById('hist-cond-val');
  if(inp) inp.value=histCondSel.map(v=>v+':'+(histCondQtds[v]||1)).join(',');
}

function histCondQtd(val,delta){
  if(!histCondQtds[val]) return;
  histCondQtds[val]=Math.max(1,(histCondQtds[val]||1)+delta);
  const num=document.querySelector('[data-hist-cond-num="'+val+'"]');
  if(num) num.textContent=histCondQtds[val];
  const inp=document.getElementById('hist-cond-val');
  if(inp) inp.value=histCondSel.map(v=>v+':'+(histCondQtds[v]||1)).join(',');
}

let histDentesSel = [];

function histToggleDente(num){
  const idx = histDentesSel.indexOf(num);
  if(idx>=0) histDentesSel.splice(idx,1);
  else histDentesSel.push(num);
  // Atualiza visual dos botões
  histDentesSel.forEach(d=>{
    const btn=document.getElementById('hist-d-'+d);
    if(btn){ btn.style.background='var(--rose)'; btn.style.color='#fff'; btn.style.borderColor='var(--rose)'; }
  });
  // Desmarca os que saíram
  [18,17,16,15,14,13,12,11,21,22,23,24,25,26,27,28,
   48,47,46,45,44,43,42,41,31,32,33,34,35,36,37,38,
   55,54,53,52,51,61,62,63,64,65,85,84,83,82,81,71,72,73,74,75].forEach(d=>{
    if(!histDentesSel.includes(d)){
      const btn=document.getElementById('hist-d-'+d);
      if(btn){ btn.style.background='#fff'; btn.style.color=''; btn.style.borderColor='var(--rose-light)'; }
    }
  });
  // Atualiza badges
  const sel=document.getElementById('hist-dentes-sel');
  if(sel) sel.innerHTML=histDentesSel.map(d=>`<span style="background:var(--rose);color:#fff;border-radius:6px;padding:2px 8px;font-size:11px;font-weight:700;">🦷${d}</span>`).join('');
  // Atualiza input hidden
  const inp=document.getElementById('hist-dentes');
  if(inp) inp.value=histDentesSel.join(',');
}


// ── HISTÓRICO: PAINEL POR DENTE ──
let histDentesProc = {}; // { dente: [{cond, qtd}] }
let histDenteAtual = null;
let histDenteCondAtual = {}; // condições do dente que está editando

function histAbrirDente(num){
  histDenteAtual = num;
  // Carrega condições já salvas para este dente
  histDenteCondAtual = {};
  const saved = histDentesProc[num] || [];
  saved.forEach(s=>{ histDenteCondAtual[s.cond] = s.qtd; });

  document.getElementById('hist-dente-num').textContent = num;
  document.getElementById('hist-dente-painel').style.display = 'block';
  document.getElementById('hist-dente-painel').scrollIntoView({behavior:'smooth',block:'nearest'});

  // Atualiza visual dos botões de condição
  document.querySelectorAll('[data-dcond-wrap]').forEach(w=>{
    const v = w.dataset.dcondWrap;
    const qtdWrap = w.querySelector('[data-dcond-qtd-wrap]');
    const numEl = w.querySelector('[data-dcond-num]');
    if(histDenteCondAtual[v]){
      w.style.borderColor='var(--rose)'; w.style.background='var(--rose-lighter)';
      if(qtdWrap) qtdWrap.style.display='flex';
      if(numEl) numEl.textContent=histDenteCondAtual[v];
    } else {
      w.style.borderColor='var(--rose-light)'; w.style.background='#fff';
      if(qtdWrap) qtdWrap.style.display='none';
      if(numEl) numEl.textContent='1';
    }
  });
}

function histDenteToggleCond(val){
  if(histDenteCondAtual[val]){
    delete histDenteCondAtual[val];
  } else {
    histDenteCondAtual[val] = 1;
  }
  const wrap = document.querySelector('[data-dcond-wrap="'+val+'"]');
  const qtdWrap = document.querySelector('[data-dcond-qtd-wrap="'+val+'"]');
  if(wrap){
    if(histDenteCondAtual[val]){
      wrap.style.borderColor='var(--rose)'; wrap.style.background='var(--rose-lighter)';
      if(qtdWrap) qtdWrap.style.display='flex';
    } else {
      wrap.style.borderColor='var(--rose-light)'; wrap.style.background='#fff';
      if(qtdWrap) qtdWrap.style.display='none';
    }
  }
}

function histDenteCondQtd(val, delta){
  if(!histDenteCondAtual[val]) return;
  histDenteCondAtual[val] = Math.max(1,(histDenteCondAtual[val]||1)+delta);
  const num = document.querySelector('[data-dcond-num="'+val+'"]');
  if(num) num.textContent = histDenteCondAtual[val];
}

function histConfirmarDente(){
  if(!histDenteAtual) return;
  const conds = Object.keys(histDenteCondAtual);
  if(!conds.length){ showToast('Selecione pelo menos uma condição.','warn'); return; }

  // Salva condições do dente
  histDentesProc[histDenteAtual] = conds.map(c=>({cond:c, qtd:histDenteCondAtual[c]}));

  // Atualiza visual do botão do dente
  const btn = document.querySelector('[data-hist-dente="'+String(histDenteAtual)+'"]');
  if(btn){
    btn.style.background = 'var(--rose)';
    btn.style.color = '#fff';
    btn.style.borderColor = 'var(--rose)';
  }

  // Atualiza badges e hidden input
  histAtualizarResumo();
  histFecharDente();
  showToast('Dente '+histDenteAtual+' registrado!');
}

function histFecharDente(){
  document.getElementById('hist-dente-painel').style.display = 'none';
  histDenteAtual = null;
  histDenteCondAtual = {};
}

function histAtualizarResumo(){
  const sel = document.getElementById('hist-dentes-sel');
  const inp = document.getElementById('hist-dentes');
  const dentes = Object.keys(histDentesProc).map(Number).sort((a,b)=>a-b);

  if(sel){
    sel.innerHTML = dentes.map(d=>{
      const conds = histDentesProc[d].map(c=>c.cond+':'+c.qtd).join(',');
      const labels = histDentesProc[d].map(c=>c.cond+(c.qtd>1?'×'+c.qtd:'')).join('+');
      return '<span onclick="histAbrirDente('+d+')" style="background:var(--rose);color:#fff;border-radius:8px;padding:3px 10px;font-size:12px;font-weight:700;cursor:pointer;display:inline-flex;align-items:center;gap:4px;" title="Clique para editar">🦷'+d+' <span style="font-size:10px;opacity:.85;">'+labels+'</span></span>';
    }).join('');
  }
  if(inp) inp.value = dentes.join(',');
}

async function histAbrirSelectProc(){
  const div = document.getElementById('hist-proc-opcoes');
  if(!div) return;
  if(div.style.display !== 'none'){ div.style.display='none'; return; }
  div.style.display='block';
  div.scrollIntoView({behavior:'smooth',block:'nearest'});
  if(!procs.length && !_financeiroCarregado){
    div.innerHTML='<div style="padding:12px;font-size:13px;color:var(--rose-text);">Carregando...</div>';
    await loadFinanceiro();
  }
  _histRenderListaProcs(document.getElementById('hist-proc')?.value||'');
  const inp = document.getElementById('hist-proc');
  if(inp) inp.oninput = ()=> _histRenderListaProcs(inp.value);
}

function _histRenderListaProcs(filtro){
  const div = document.getElementById('hist-proc-opcoes');
  if(!div || div.style.display==='none') return;
  const f = (filtro||'').toLowerCase();
  const lista = procs.filter(p=> !f || p.nome.toLowerCase().includes(f));
  if(!lista.length){
    div.innerHTML='<div style="padding:12px;font-size:13px;color:var(--rose-text);">'+(procs.length?'Nenhum resultado.':'Nenhum procedimento cadastrado.')+'</div>';
    return;
  }
  const grupos = [...new Set(lista.map(p=>p.grupo).filter(Boolean))].sort();
  let html = '';
  grupos.forEach(g=>{
    html += `<div style="padding:4px 10px;font-size:10px;font-weight:700;color:var(--rose-text);text-transform:uppercase;background:var(--rose-lighter);position:sticky;top:0;">${escapeHtml(g)}</div>`;
    lista.filter(p=>p.grupo===g).forEach(p=>{
      const preco = (p.precoFinal||0).toFixed(2).replace('.',',');
      html += `<button type="button" onclick="histSelecionarProc(${procs.indexOf(p)})"
        style="display:flex;justify-content:space-between;gap:8px;width:100%;text-align:left;padding:11px 14px;border:none;border-bottom:1px solid var(--rose-lighter);background:#fff;font-size:13px;cursor:pointer;color:#3a2020;-webkit-tap-highlight-color:rgba(0,0,0,.08);">
        <span>${escapeHtml(p.nome)}</span><span style="color:var(--rose-dark);font-weight:700;white-space:nowrap;">R$ ${preco}</span>
      </button>`;
    });
  });
  // Procedimentos sem grupo (fallback) ficam por último, sem cabeçalho
  lista.filter(p=>!p.grupo).forEach(p=>{
    const preco = (p.precoFinal||0).toFixed(2).replace('.',',');
    html += `<button type="button" onclick="histSelecionarProc(${procs.indexOf(p)})"
      style="display:flex;justify-content:space-between;gap:8px;width:100%;text-align:left;padding:11px 14px;border:none;border-bottom:1px solid var(--rose-lighter);background:#fff;font-size:13px;cursor:pointer;color:#3a2020;">
      <span>${escapeHtml(p.nome)}</span><span style="color:var(--rose-dark);font-weight:700;white-space:nowrap;">R$ ${preco}</span>
    </button>`;
  });
  div.innerHTML = html;
}

let histProcsLista = []; // lista de procedimentos selecionados

function histAdicionarProcDigitado(){
  const inp = document.getElementById('hist-proc');
  const val = inp?.value.trim();
  if(!val) return;
  if(!histProcsLista.includes(val)) histProcsLista.push(val);
  inp.value = '';
  histRenderProcsTags();
}

function histSelecionarProc(idx){
  const p = procs[idx];
  if(!p) return;
  if(!histProcsLista.includes(p.nome)) histProcsLista.push(p.nome);
  histRenderProcsTags();
  const div = document.getElementById('hist-proc-opcoes');
  if(div) div.style.display='none';
}

function histRemoverProc(idx){
  histProcsLista.splice(idx,1);
  histRenderProcsTags();
}

function histRenderProcsTags(){
  const wrap = document.getElementById('hist-procs-tags');
  const hidden = document.getElementById('hist-procs-hidden');
  if(wrap) wrap.innerHTML = histProcsLista.map((nome,i)=>`
    <span style="display:inline-flex;align-items:center;gap:5px;background:var(--rose);color:#fff;border-radius:20px;padding:4px 12px;font-size:12px;font-weight:600;">
      ${escapeHtml(nome)}
      <button type="button" onclick="histRemoverProc(${i})" style="background:rgba(255,255,255,.3);border:none;border-radius:50%;width:16px;height:16px;cursor:pointer;color:#fff;font-size:11px;display:flex;align-items:center;justify-content:center;padding:0;line-height:1;">×</button>
    </span>`).join('');
  if(hidden) hidden.value = histProcsLista.join(', ');
}

function histLimparDentes(){
  histDentesProc = {};
  histDenteAtual = null;
  histDenteCondAtual = {};
  document.querySelectorAll('[data-hist-dente]').forEach(btn=>{
    btn.style.background='#fff'; btn.style.color='#3a2020'; btn.style.borderColor='var(--rose-light)';
  });
  const sel=document.getElementById('hist-dentes-sel'); if(sel) sel.innerHTML='';
  const inp=document.getElementById('hist-dentes'); if(inp) inp.value='';
}

function histLimpar(){
  histDentesSel=[];
  histProcsLista=[];
  document.querySelectorAll('.hist-dente-btn.sel').forEach(b=>b.classList.remove('sel'));
  ['hist-data','hist-dentes','hist-proc','hist-procs-hidden','hist-obs'].forEach(id=>{
    const el=document.getElementById(id); if(el) el.value='';
  });
  const dd=document.getElementById('hist-data'); if(dd) dd.value=hoje();
  document.querySelectorAll('input[name="hist-cond-cb"]').forEach(cb=>cb.checked=false);
  const sel=document.getElementById('hist-dentes-sel'); if(sel) sel.innerHTML='';
  const tags=document.getElementById('hist-procs-tags'); if(tags) tags.innerHTML='';
}

async function histSalvar(pacId){
  const data   = document.getElementById('hist-data')?.value || hoje();
  const dentesRaw = Object.keys(histDentesProc).join(',') || '';
  const conds  = histCondSel.length ? histCondSel : ['restaurado'];
  const cond   = conds[0];
  const condsStr = conds.map(v=>v+':'+(histCondQtds[v]||1)).join(',');
  const proc   = (document.getElementById('hist-procs-hidden')?.value || document.getElementById('hist-proc')?.value || '').trim();
  const obs    = document.getElementById('hist-obs')?.value.trim() || '';
  const profId = document.getElementById('hist-prof')?.value || null;
  const prof   = profissionais.find(p=>p.id==profId);
  if(!proc){ showToast('Informe o procedimento realizado.','warn'); return; }
  showLoading(true);
  const dentes = dentesRaw ? dentesRaw.split(',').map(d=>parseInt(d.trim())).filter(n=>!isNaN(n)) : [];
  for(const dente of dentes){
    const denteProcs = histDentesProc[dente] || [{cond,qtd:1}];
    const condDente = denteProcs[0]?.cond || cond;
    const {data:ex,error:errSel}=await _sb.from('procedimentos_dentes').select('id').eq('clinica_id',clinicaId).eq('paciente_id',pacId).eq('dente',dente).single();
    if(errSel && errSel.code!=='PGRST116'){
      showLoading(false); showToast('Erro ao carregar dente '+dente+': '+errSel.message,'error'); return;
    }
    if(ex){
      const {error:errU}=await _sb.from('procedimentos_dentes').update({condicao:condDente,procedimento:proc,obs,data}).eq('id',ex.id);
      if(errU){ showLoading(false); showToast('Erro ao atualizar dente '+dente+': '+errU.message,'error'); return; }
    } else {
      const {error:errI}=await _sb.from('procedimentos_dentes').insert([{clinica_id:clinicaId,paciente_id:pacId,dente,condicao:condDente,procedimento:proc,obs,data}]);
      if(errI){ showLoading(false); showToast('Erro ao salvar dente '+dente+': '+errI.message,'error'); return; }
    }
  }
  const dentesArr=dentes.map(d=>({dente:d,procedimento:proc,condicao:condsStr}));
  const {error}=await _sb.from('atendimentos_odonto').insert([{
    clinica_id:clinicaId,paciente_id:pacId,data,procedimentos:proc,obs,
    profissional_id:profId||null,profissional_nome:prof?.nome||'',
    dentes_tratados:JSON.stringify(dentesArr)
  }]);
  showLoading(false);
  if(error){ showToast('Erro: '+error.message,'error'); return; }
  await pacCarregarProcs(pacId);
  histLimpar();
  histRenderLista(pacId);
  showToast('Histórico salvo!');
}

function histRenderLista(pacId){
  const c = document.getElementById('pac-hist-lista'); if(!c) return;
  if(!pacProcsList.length){
    c.innerHTML='<div style="text-align:center;color:var(--rose-text);font-size:13px;padding:20px;"><i class="ti ti-history" style="font-size:28px;display:block;margin-bottom:8px;opacity:.3;"></i>Nenhum histórico registrado ainda.</div>';
    return;
  }
  c.innerHTML = `<div style="font-size:12px;font-weight:700;color:var(--rose-dark);text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px;">Histórico registrado (${pacProcsList.length} atendimento${pacProcsList.length>1?'s':''})</div>` +
    pacProcsList.map(a=>{
      let dentes=[];
      try{ dentes=JSON.parse(a.dentes_tratados||'[]'); }catch(e){}
      return `<div style="border:1px solid var(--rose-light);border-radius:10px;padding:12px;margin-bottom:8px;background:#fff;display:flex;gap:10px;align-items:flex-start;">
        <div style="background:var(--rose-lighter);border-radius:8px;padding:6px 10px;text-align:center;min-width:60px;flex-shrink:0;">
          <div style="font-size:10px;color:var(--rose-text);">${formatDate(a.data).split('/').slice(0,2).join('/')}</div>
          <div style="font-size:12px;font-weight:700;color:var(--rose-dark);">${formatDate(a.data).split('/')[2]}</div>
        </div>
        <div style="flex:1;min-width:0;">
          <div style="font-size:13px;font-weight:600;color:#3a2020;">${escapeHtml(a.procedimentos)}</div>
          ${a.profissional_nome?`<div style="font-size:11px;color:var(--rose-text);margin-top:2px;">👤 ${escapeHtml(a.profissional_nome)}</div>`:''}
          ${dentes.length?`<div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:6px;">${dentes.map(d=>`<span style="background:var(--rose-lighter);color:var(--rose-dark);border-radius:6px;padding:2px 7px;font-size:11px;font-weight:700;">🦷${d.dente}</span>`).join('')}</div>`:''}
          ${a.obs?`<div style="font-size:12px;color:var(--rose-text);margin-top:4px;">${escapeHtml(a.obs)}</div>`:''}
        </div>
        <button class="btn-danger" style="padding:4px 8px;flex-shrink:0;" onclick="pacRemoverProc(${a.id});setTimeout(()=>histRenderLista(${pacId}),300)"><i class="ti ti-trash"></i></button>
      </div>`;
    }).join('');
}

// ══════════════════════════════════════════════════════
// RESGATE DE PACIENTES
// ══════════════════════════════════════════════════════
let resgateFiltrMeses = 1;
let resgateModalTel = '';

function renderResgate(){
  renderResgateFaltas();
  filtrarResgate(resgateFiltrMeses);
}

function renderResgateFaltas(){
  const sec = document.getElementById('resgate-faltas-section');
  const tb  = document.getElementById('resgate-faltas-tbody');
  if(!sec || !tb) return;
  const hoje = new Date();
  const limite60 = new Date(hoje); limite60.setDate(limite60.getDate()-60);
  // Pega faltas dos últimos 60 dias. Se o paciente já tem um agendamento futuro marcado
  // (reagendou), não precisa mais aparecer aqui em destaque.
  const faltas = agendamentos.filter(a=>{
    if((agGetStatus(a)||'').toLowerCase()!=='faltou') return false;
    const d = new Date(a.data+'T00:00:00');
    if(d < limite60) return false;
    const jaReagendou = agendamentos.some(b=>b.paciente_id && b.paciente_id===a.paciente_id && b.id!==a.id && b.data > a.data && (agGetStatus(b)||'').toLowerCase()!=='faltou');
    return !jaReagendou;
  }).sort((a,b)=>b.data.localeCompare(a.data));

  if(!faltas.length){ sec.style.display='none'; return; }
  sec.style.display='block';
  tb.innerHTML = faltas.map(a=>{
    const dataFmt = formatDate(a.data);
    return `<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;background:#fff5f5;border:1px solid #fecaca;border-radius:10px;padding:10px 14px;flex-wrap:wrap;">
      <div>
        <div style="font-weight:700;font-size:13px;">${escapeHtml(a.nome)}</div>
        <div style="font-size:12px;color:var(--rose-text);">${escapeHtml(a.procedimento||'Consulta')} · faltou em ${dataFmt}</div>
      </div>
      ${a.telefone ? `<button onclick="abrirResgateModalFalta('${escapeHtml(a.nome)}','${escapeHtml(a.telefone)}','${escapeHtml(a.procedimento||'Consulta')}')" style="background:#25d366;border:none;border-radius:50%;width:38px;height:38px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;box-shadow:0 2px 8px rgba(37,211,102,.4);" title="Reagendar via WhatsApp"><i class="ti ti-brand-whatsapp" style="color:#fff;font-size:18px;"></i></button>`
      : `<span style="font-size:11px;color:var(--rose-text);">Sem telefone</span>`}
    </div>`;
  }).join('');
}

async function filtrarResgate(meses){
  resgateFiltrMeses = meses;
  // Atualiza botões de filtro
  document.querySelectorAll('#resgate-filtros button').forEach(b=>{
    const m = parseInt(b.dataset.meses);
    b.className = m===meses ? 'btn-primary' : 'btn-secondary';
  });

  // Busca TODOS os últimos atendimentos de uma vez (1 query só)
  const hoje = new Date();
  const { data: todosAtends } = await _sb.from('atendimentos_odonto')
    .select('paciente_id, data, procedimentos')
    .eq('clinica_id', clinicaId)
    .order('data', {ascending: false});

  // Monta mapa: pacienteId → último atendimento
  const mapaAtend = {};
  for(const a of (todosAtends||[])){
    if(!mapaAtend[a.paciente_id]) mapaAtend[a.paciente_id] = a;
  }

  // Para cada paciente, usa o mapa (sem query extra)
  const pacResgate = [];
  for(const pac of pacientes){
    const atend = mapaAtend[pac.id];
    const agsPac = agendamentos.filter(a=>a.paciente_id===pac.id);
    let ultimaData = null, ultimoProc = 'Não informado';

    if(atend){
      ultimaData = atend.data;
      ultimoProc = atend.procedimentos || 'Não informado';
    } else if(agsPac.length){
      const ag = agsPac.sort((a,b)=>b.data.localeCompare(a.data))[0];
      ultimaData = ag.data;
      ultimoProc = ag.procedimento || 'Consulta';
    }

    if(!ultimaData){
      pacResgate.push({ pac, ultimaData: null, ultimoProc: 'Sem registro', dias: 9999, mesesAusencia: 999 });
      continue;
    }

    const dias = Math.floor((hoje - new Date(ultimaData)) / (1000*60*60*24));
    const mesesAusencia = dias/30;

    if(meses === 5){
      if(mesesAusencia < 5) continue;
    } else {
      const min = (meses-1)*30, max = meses*30;
      if(dias < min || dias >= max) continue;
    }

    pacResgate.push({ pac, ultimaData, ultimoProc, dias, mesesAusencia });
  }

  // Métricas
  const metrEl = document.getElementById('resgate-metrics');
  if(metrEl) metrEl.innerHTML = [
    {lbl:'Pacientes encontrados', val:pacResgate.length, cor:'var(--rose-dark)'},
    {lbl:'Com telefone', val:pacResgate.filter(r=>r.pac.telefone).length, cor:'#2e7d32'},
  ].map(s=>`<div style="background:var(--rose-lighter);border:1px solid var(--rose-light);border-radius:12px;padding:12px 16px;">
    <div style="font-size:11px;color:var(--rose-text);">${s.lbl}</div>
    <div style="font-size:22px;font-weight:800;color:${s.cor};">${s.val}</div>
  </div>`).join('');

  const tb = document.getElementById('resgate-tbody');
  if(!tb) return;

  if(!pacResgate.length){
    tb.innerHTML=`<tr><td colspan="5" style="text-align:center;color:var(--rose-text);padding:24px;">
      Nenhum paciente ausente há ${meses === 5 ? '5+' : meses} mese(s).
    </td></tr>`;
    return;
  }

  tb.innerHTML = pacResgate.map(r=>{
    const {pac, ultimaData, ultimoProc, dias, mesesAusencia} = r;
    const semRegistro = !ultimaData;
    const dataFmt = semRegistro ? '—' : formatDate(ultimaData);
    const mesesStr = semRegistro ? 'Nunca veio' : mesesAusencia < 1 ? `${dias} dias` : `${Math.round(mesesAusencia)} meses`;
    const cor = semRegistro ? '#6b21a8' : mesesAusencia >= 5 ? '#dc2626' : mesesAusencia >= 3 ? '#856404' : '#2e7d32';
    const procCurto = ultimoProc.length > 35 ? ultimoProc.slice(0,35)+'...' : ultimoProc;
    const temTel = !!pac.telefone;
    return `<tr style="border-bottom:1px solid var(--rose-light);">
      <td style="padding:10px;font-weight:600;">${escapeHtml(pac.nome)}</td>
      <td style="padding:10px;color:var(--rose-text);font-size:12px;">${escapeHtml(procCurto)}</td>
      <td style="padding:10px;text-align:center;font-size:12px;">${dataFmt}</td>
      <td style="padding:10px;text-align:center;">
        <span style="background:${cor}20;color:${cor};border-radius:20px;padding:3px 10px;font-size:12px;font-weight:700;">${mesesStr}</span>
      </td>
      <td style="padding:10px;text-align:center;">
        ${temTel
          ? `<div style="display:flex;flex-direction:column;align-items:center;gap:3px;">
              <button onclick="abrirResgateModal('${escapeHtml(pac.nome).replace(/'/g,"&#39;")}','${escapeHtml(pac.telefone||'').replace(/'/g,"&#39;")}','${escapeHtml(ultimoProc).replace(/'/g,"&#39;")}',${Math.round(mesesAusencia)})"
                style="background:#25d366;border:none;border-radius:50%;width:38px;height:38px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;box-shadow:0 2px 8px rgba(37,211,102,.4);" title="Enviar WhatsApp">
                <i class="ti ti-brand-whatsapp" style="color:#fff;font-size:18px;"></i>
              </button>
              ${getResgateContador(escapeHtml(pac.nome))>0 ? `<span style="font-size:10px;color:#856404;font-weight:700;">${getResgateContador(escapeHtml(pac.nome))}x enviado(s)</span>` : ''}
            </div>`
          : `<span style="font-size:11px;color:var(--rose-text);">Sem tel.</span>`
        }
      </td>
    </tr>`;
  }).join('');
}

function classificarTratamento(proc){
  const p = (proc||'').toLowerCase();
  if(p.includes('aparelho')||p.includes('manuten')||p.includes('orto')||p.includes('braquete')||p.includes('fio')) return 'ortodontia';
  if(p.includes('limpeza')||p.includes('profilaxia')||p.includes('raspagem')) return 'limpeza';
  if(p.includes('canal')||p.includes('endo')) return 'endodontia';
  if(p.includes('implante')) return 'implante';
  if(p.includes('clareamento')) return 'clareamento';
  if(p.includes('extração')||p.includes('exodontia')||p.includes('siso')) return 'cirurgia';
  if(p.includes('restaur')||p.includes('resina')) return 'restauracao';
  return 'geral';
}

function gerarMensagemResgate(nome, proc, meses){
  const pn = _primeiroNome(nome);
  const clinica = clinicaData?.nome_cli || 'nossa clínica';
  const prepCli = _prepClinica(clinica);
  const ausencia = meses >= 12 ? `${Math.round(meses/12)} ano(s)` : `${Math.round(meses)} meses`;

  if(meses >= 5){
    return `Olá, ${pn}! Tudo bem? Já faz mais de ${ausencia} desde a sua última limpeza ${prepCli}. Como o recomendado para a sua saúde bucal é a prevenção a cada 6 meses, gostaria de dar uma olhada nos dias disponíveis para esta semana? 📅`;
  }

  const procNome = (!proc || proc === 'Sem registro' || proc === 'Não informado') ? 'seu último procedimento' : proc;
  return `Oi, ${pn}, tudo bem? Passando para acompanhar o seu tratamento. Como está o conforto e a adaptação com o procedimento de ${procNome} que fizemos? Se precisar de qualquer suporte, estou por aqui! 🦷`;
}

function abrirResgateModal(nome, tel, proc, meses){
  resgateModalTel = tel;
  document.getElementById('resgate-modal-nome').textContent = nome;
  document.getElementById('resgate-modal-msg').value = gerarMensagemResgate(nome, proc, meses);
  const bg = document.getElementById('resgate-modal-bg');
  if(bg) bg.style.display = 'flex';
}

function fecharResgateModal(){
  const bg = document.getElementById('resgate-modal-bg');
  if(bg) bg.style.display = 'none';
}

// Contador de mensagens por paciente (salvo no localStorage)
function getResgateContador(pacNome){
  try{
    const d=JSON.parse(localStorage.getItem('rwdent_resgate_msgs')||'{}');
    return d[pacNome]||0;
  }catch(e){return 0;}
}
function incResgateContador(pacNome){
  try{
    const d=JSON.parse(localStorage.getItem('rwdent_resgate_msgs')||'{}');
    d[pacNome]=(d[pacNome]||0)+1;
    localStorage.setItem('rwdent_resgate_msgs',JSON.stringify(d));
  }catch(e){}
}

function enviarResgateWpp(){
  const tel = resgateModalTel.replace(/\D/g,'');
  const num = tel.startsWith('55') ? tel : '55'+tel;
  const msg = document.getElementById('resgate-modal-msg')?.value || '';
  const nome = document.getElementById('resgate-modal-nome')?.textContent||'';
  incResgateContador(nome);
  window.open(`https://wa.me/${num}?text=${encodeURIComponent(msg)}`, '_blank');
  // NÃO fecha o modal — só mostra confirmação
  showToast('WhatsApp aberto! Mensagem '+(getResgateContador(nome))+' enviada para '+nome);
}

// ══════════════════════════════════════════════════════
// CAPTAÇÃO DE NOVOS CONTATOS
// ══════════════════════════════════════════════════════
let capModalId = null;
let capModalModo = 'manual'; // 'manual' | 'campanha'
let capFiltroCategoriaAtual = '';
let capBulkAtivo = false;
let capBulkFila = [];
let capBulkPos = 0;
let capBulkEnviados = 0;

const CAP_STATUS_LABEL = {
  novo:'Novo', contatado:'Contatado', respondeu:'Respondeu', agendou:'Agendou', sem_interesse:'Sem interesse'
};
const CAP_STATUS_COR = {
  novo:'#6b21a8', contatado:'#856404', respondeu:'#1d4ed8', agendou:'#2e7d32', sem_interesse:'#dc2626'
};
const CAP_CATEGORIA_LABEL = { lead_st:'Lead ST', connect_vip:'Connect VIP', paciente:'Paciente' };
const CAP_CATEGORIA_COR   = { lead_st:'#7a3020', connect_vip:'#1d4ed8', paciente:'#2e7d32' };

// Mensagens padrão por categoria — nome oficial: "Consultório Odontológico Rhaiza Barroso"
const CAP_MSG_PADRAO_LEAD_ST = `Olá! 😊 Tudo bem?

Aqui é do Consultório Odontológico Rhaiza Barroso.

Estamos entrando em contato porque abrimos algumas vagas para novos pacientes e preparamos uma condição especial de boas-vindas para quem realizar o primeiro atendimento conosco.

É uma excelente oportunidade para conhecer nossa equipe, fazer uma avaliação completa da sua saúde bucal e aproveitar um benefício exclusivo no primeiro atendimento.

Caso tenha interesse, responda esta mensagem com "QUERO" que enviaremos todas as informações e os horários disponíveis.

Será um prazer receber você! 🦷✨`;

const CAP_MSG_PADRAO_CONNECT_VIP = `Olá! 😊 Tudo bem?

Aqui é do Consultório Odontológico Rhaiza Barroso.

Entramos em contato porque, por meio do Clube de Vantagens da Connect Inglês VIP, você tem um benefício exclusivo disponível.

Você pode agendar uma consulta odontológica e receber também um benefício especial em um procedimento da clínica (informaremos todos os detalhes no momento do agendamento).

É uma ótima oportunidade para fazer uma avaliação da sua saúde bucal com uma equipe especializada e conhecer nosso consultório.

As vagas são limitadas para os participantes do Clube de Vantagens.

Se tiver interesse, é só responder esta mensagem com "QUERO" que enviaremos os horários disponíveis. 🦷✨`;

function capContatos(){
  if(!Array.isArray(cfg.captacao)) cfg.captacao = [];
  return cfg.captacao;
}

function capProximoId(){
  const lista = capContatos();
  return lista.length ? Math.max(...lista.map(c=>c.id||0)) + 1 : 1;
}

function capNormalizarTel(tel){
  return String(tel||'').replace(/\D/g,'');
}

// Chave de identidade do telefone p/ dedupe: remove o DDI 55 quando presente,
// já que pacientes cadastrados são salvos só com DDD+número (sem 55) e o CSV
// sempre traz o telefone com 55 na frente — sem isso os dois nunca combinam.
function capChaveTelefone(tel){
  let d = capNormalizarTel(tel);
  if((d.length===12 || d.length===13) && d.startsWith('55')) d = d.slice(2);
  return d;
}

function capFormatarTelefoneExibicao(tel){
  let d = capNormalizarTel(tel);
  if(!d) return '';
  if(d.startsWith('55') && d.length > 11) d = d.slice(2);
  const ddd = d.slice(0,2), num = d.slice(2);
  let numFmt = num;
  if(num.length===9) numFmt = num.slice(0,5)+'-'+num.slice(5);
  else if(num.length===8) numFmt = num.slice(0,4)+'-'+num.slice(4);
  return ddd ? `+55 ${ddd} ${numFmt}` : `+55 ${d}`;
}

async function capSalvar(){
  const err = await saveFinanceiro();
  if(err){ showToast('Erro ao salvar: '+(err.message||err),'error'); return false; }
  return true;
}

function capRender(){
  capRenderTabela();
}

function capAdicionarContato(){
  const nomeEl = document.getElementById('cap-novo-nome');
  const telEl  = document.getElementById('cap-novo-tel');
  const nome = (nomeEl?.value||'').trim();
  const tel  = capChaveTelefone(telEl?.value);
  if(!nome){ showToast('Informe o nome do contato','error'); return; }
  if(!tel){ showToast('Informe o telefone do contato','error'); return; }
  const lista = capContatos();
  if(lista.some(c=>capChaveTelefone(c.telefone)===tel)){
    showToast('Já existe um contato com esse telefone','error');
    return;
  }
  lista.push({ id:capProximoId(), nome, telefone: telEl.value.trim(), categoria:null, status:'novo', origem:'Manual', paciente_novo:'Sim', mensagem_campanha:null, enviados:0, criado_em:new Date().toISOString() });
  nomeEl.value=''; telEl.value='';
  capSalvar().then(()=>{ showToast('Contato adicionado!'); capRenderTabela(); });
}

function capAdicionarLote(){
  const txt = document.getElementById('cap-lote-texto');
  const linhas = (txt?.value||'').split('\n').map(l=>l.trim()).filter(Boolean);
  if(!linhas.length){ showToast('Cole ao menos um contato','error'); return; }

  const lista = capContatos();
  const telsExistentes = new Set(lista.map(c=>capChaveTelefone(c.telefone)));
  let proximoId = capProximoId();
  let adicionados = 0, duplicados = 0, invalidos = 0;

  linhas.forEach(linha=>{
    const partes = linha.split(/[,;\t]|(?<=\D)\s{2,}(?=\d)/).map(p=>p.trim()).filter(Boolean);
    let nome, telRaw;
    if(partes.length >= 2){
      nome = partes[0];
      telRaw = partes[partes.length-1];
    } else {
      // Sem separador claro: assume telefone no final da linha (últimos dígitos/símbolos)
      const m = linha.match(/^(.*?)\s+([\d()+\-\s]{8,})$/);
      if(m){ nome = m[1].trim(); telRaw = m[2].trim(); }
    }
    const tel = capChaveTelefone(telRaw);
    if(!nome || !tel){ invalidos++; return; }
    if(telsExistentes.has(tel)){ duplicados++; return; }
    telsExistentes.add(tel);
    lista.push({ id:proximoId++, nome, telefone:telRaw, categoria:null, status:'novo', origem:'Manual', paciente_novo:'Sim', mensagem_campanha:null, enviados:0, criado_em:new Date().toISOString() });
    adicionados++;
  });

  if(!adicionados){
    showToast(invalidos ? 'Nenhum contato válido encontrado no texto colado' : 'Todos os contatos já existiam', 'error');
    return;
  }

  txt.value = '';
  capSalvar().then(()=>{
    let msg = `${adicionados} contato(s) importado(s)!`;
    if(duplicados) msg += ` ${duplicados} já existiam.`;
    if(invalidos) msg += ` ${invalidos} linha(s) ignorada(s) (sem nome ou telefone).`;
    showToast(msg);
    capRenderTabela();
  });
}

// ── Importação de arquivo CSV (Lead ST / Connect VIP) ──────────────────
function capParseCsvGenerico(text, delimiter){
  delimiter = delimiter || ';';
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for(let i=0;i<text.length;i++){
    const c = text[i];
    if(inQuotes){
      if(c === '"'){
        if(text[i+1] === '"'){ field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else {
      if(c === '"') inQuotes = true;
      else if(c === delimiter){ row.push(field); field=''; }
      else if(c === '\r'){ /* ignora, tratado no \n */ }
      else if(c === '\n'){ row.push(field); rows.push(row); row=[]; field=''; }
      else field += c;
    }
  }
  if(field.length || row.length){ row.push(field); rows.push(row); }
  return rows;
}

function capParseCsvContatos(text){
  if(text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const rows = capParseCsvGenerico(text, ';');
  if(!rows.length) return [];
  const header = rows[0].map(h=>h.trim().toLowerCase());
  const out = [];
  for(let i=1;i<rows.length;i++){
    const r = rows[i];
    if(r.length===1 && !r[0].trim()) continue;
    const obj = {};
    header.forEach((h,idx)=>{ obj[h] = (r[idx]!==undefined ? r[idx] : '').trim(); });
    out.push(obj);
  }
  return out;
}

function capSlugCategoria(cat){
  const c = (cat||'').trim().toLowerCase();
  if(c==='lead st') return 'lead_st';
  if(c==='connect vip') return 'connect_vip';
  if(!c) return null;
  return c.replace(/\s+/g,'_');
}

function capProcessarImportacao(linhas){
  const lista = capContatos();
  let proximoId = capProximoId();
  const porTelefone = new Map(lista.map(c=>[capChaveTelefone(c.telefone), c]));
  const pacientesArr = (typeof pacientes!=='undefined' && Array.isArray(pacientes)) ? pacientes : [];
  const telefonesPacientes = new Set(pacientesArr.map(p=>capChaveTelefone(p.telefone)).filter(Boolean));

  let importados=0, atualizados=0, duplicadosIgnorados=0, jaPacientes=0, invalidos=0;

  linhas.forEach(row=>{
    const nome = (row.nome||'').trim();
    const telRaw = row.telefone||'';
    const tel = capChaveTelefone(telRaw);
    if(!nome || !tel){ invalidos++; return; }

    if(telefonesPacientes.has(tel)){ jaPacientes++; return; }

    const categoria = capSlugCategoria(row.categoria);
    const origem = row.origem || '';
    const pacienteNovo = row.paciente_novo || '';
    const mensagemCampanha = row.mensagem_campanha || '';

    const existente = porTelefone.get(tel);
    if(existente){
      let mudou = false;
      if(categoria && existente.categoria !== categoria){ existente.categoria = categoria; mudou = true; }
      if(origem && existente.origem !== origem){ existente.origem = origem; mudou = true; }
      if(pacienteNovo && existente.paciente_novo !== pacienteNovo){ existente.paciente_novo = pacienteNovo; mudou = true; }
      if(mensagemCampanha && existente.mensagem_campanha !== mensagemCampanha){ existente.mensagem_campanha = mensagemCampanha; mudou = true; }
      if(mudou) atualizados++; else duplicadosIgnorados++;
      return;
    }

    const novoContato = {
      id: proximoId++,
      nome, telefone: (telRaw.trim() || tel),
      categoria, status:'novo', origem, paciente_novo: pacienteNovo,
      mensagem_campanha: mensagemCampanha || null,
      enviados:0, criado_em:new Date().toISOString()
    };
    lista.push(novoContato);
    porTelefone.set(tel, novoContato);
    importados++;
  });

  return { importados, atualizados, duplicadosIgnorados, jaPacientes, invalidos, total: linhas.length };
}

function capExibirResultadoImportacao(r){
  const el = document.getElementById('cap-import-resultado');
  if(!el) return;
  el.style.display = 'block';
  el.innerHTML = `
    <div style="font-weight:700;color:var(--rose-dark);margin-bottom:4px;">Importação concluída (${r.total} linha(s) no arquivo)</div>
    <div>✅ <strong>${r.importados}</strong> contato(s) importado(s)</div>
    <div>🔄 <strong>${r.atualizados}</strong> contato(s) atualizado(s) (categoria/mensagem)</div>
    <div>⏭️ <strong>${r.duplicadosIgnorados}</strong> duplicado(s) ignorado(s) (já cadastrados, sem mudança)</div>
    ${r.jaPacientes ? `<div>🧑‍⚕️ <strong>${r.jaPacientes}</strong> já são pacientes da clínica (não duplicados na captação)</div>` : ''}
    ${r.invalidos ? `<div>⚠️ <strong>${r.invalidos}</strong> linha(s) inválida(s) (sem nome ou telefone)</div>` : ''}
    <div style="margin-top:6px;color:var(--rose-text);">Nenhuma funcionalidade existente foi alterada — apenas contatos de captação foram adicionados/atualizados.</div>
  `;
  showToast(`Importação concluída: ${r.importados} novos, ${r.atualizados} atualizados, ${r.duplicadosIgnorados} duplicados ignorados.`);
}

function capImportarCsv(){
  const fileInput = document.getElementById('cap-import-csv');
  const file = fileInput?.files?.[0];
  if(!file){ showToast('Selecione um arquivo CSV primeiro','error'); return; }
  const reader = new FileReader();
  reader.onload = (e) => {
    try{
      const linhas = capParseCsvContatos(String(e.target.result||''));
      if(!linhas.length){ showToast('Arquivo CSV vazio ou em formato inválido','error'); return; }
      const resultado = capProcessarImportacao(linhas);
      capSalvar().then(()=>{
        capExibirResultadoImportacao(resultado);
        capRenderTabela();
        fileInput.value = '';
      });
    }catch(err){
      showToast('Erro ao importar arquivo: '+err.message,'error');
    }
  };
  reader.onerror = () => showToast('Não foi possível ler o arquivo','error');
  reader.readAsText(file, 'UTF-8');
}

function capMudarStatus(id, status){
  const c = capContatos().find(c=>c.id===id);
  if(!c) return;
  c.status = status;
  capSalvar().then(()=>capRenderTabela());
}

function capExcluirContato(id){
  const c = capContatos().find(c=>c.id===id);
  if(!c) return;
  if(!confirm(`Excluir o contato "${c.nome}"?`)) return;
  cfg.captacao = capContatos().filter(x=>x.id!==id);
  capSalvar().then(()=>{ showToast('Contato removido'); capRenderTabela(); });
}

function capGerarMensagem(nome){
  const pn = _primeiroNome(nome);
  const clinica = clinicaData?.nome_cli || 'nossa clínica';
  return `Olá, ${pn}! Tudo bem? Aqui é da ${clinica}. Gostaria de agendar uma avaliação odontológica gratuita? Temos horários disponíveis essa semana. 🦷📅`;
}

function capMensagemCampanhaPara(c){
  if(c.mensagem_campanha) return c.mensagem_campanha;
  if(c.categoria === 'lead_st') return CAP_MSG_PADRAO_LEAD_ST;
  if(c.categoria === 'connect_vip') return CAP_MSG_PADRAO_CONNECT_VIP;
  return capGerarMensagem(c.nome);
}

function capNomeAcaoCampanha(categoria){
  if(categoria === 'lead_st') return 'Enviar mensagem de captação';
  if(categoria === 'connect_vip') return 'Enviar mensagem Connect';
  return 'Enviar campanha';
}

function capBuscarContatoPorId(id){
  if(typeof id === 'string' && id.startsWith('p_')){
    const pacId = id.slice(2);
    const pacientesArr = (typeof pacientes!=='undefined' && Array.isArray(pacientes)) ? pacientes : [];
    const pac = pacientesArr.find(p=>String(p.id)===pacId);
    if(!pac) return null;
    return { id, nome:pac.nome, telefone:pac.telefone, categoria:'paciente', status:null, enviados:0, _isPaciente:true };
  }
  const numId = typeof id === 'string' ? Number(id) : id;
  return capContatos().find(c=>c.id===numId) || null;
}

function capAbrirModal(id, modo){
  const c = capBuscarContatoPorId(id);
  if(!c) return;
  capModalId = id;
  capModalModo = modo || 'manual';
  document.getElementById('cap-modal-nome').textContent = c.nome;
  document.getElementById('cap-modal-msg').value = capModalModo==='campanha' ? capMensagemCampanhaPara(c) : capGerarMensagem(c.nome);
  const bg = document.getElementById('cap-modal-bg');
  if(bg) bg.style.display = 'flex';
  capAtualizarProgressoBulk();
}

function capAtualizarProgressoBulk(){
  const prog = document.getElementById('cap-modal-progresso');
  const btnTxt = document.getElementById('cap-modal-btn-txt');
  if(!capBulkAtivo){
    if(prog) prog.style.display = 'none';
    if(btnTxt) btnTxt.textContent = 'Enviar via WhatsApp';
    return;
  }
  if(prog){ prog.style.display = 'inline-block'; prog.textContent = `Campanha em massa: ${capBulkPos+1} de ${capBulkFila.length}`; }
  if(btnTxt) btnTxt.textContent = (capBulkPos < capBulkFila.length-1) ? 'Enviar e ir para o próximo' : 'Enviar (último contato)';
}

function capFecharModal(){
  const bg = document.getElementById('cap-modal-bg');
  if(bg) bg.style.display = 'none';
  capModalId = null;
  if(capBulkAtivo){
    capBulkAtivo = false;
    showToast(`Campanha em massa cancelada. ${capBulkEnviados} mensagem(ns) enviada(s) antes de cancelar.`);
    capRenderTabela();
  }
  capAtualizarProgressoBulk();
}

async function capEnviarWpp(){
  const c = capBuscarContatoPorId(capModalId);
  if(!c) return;
  const tel = capNormalizarTel(c.telefone);
  const num = tel.startsWith('55') ? tel : '55'+tel;
  const msg = document.getElementById('cap-modal-msg')?.value || '';

  const abrirWppEFinalizar = () => {
    window.open(`https://wa.me/${num}?text=${encodeURIComponent(msg)}`, '_blank');
    if(capBulkAtivo) capBulkAvancar();
    else { showToast('WhatsApp aberto! Mensagem enviada para '+c.nome); capRenderTabela(); }
  };

  if(c._isPaciente){ abrirWppEFinalizar(); return; }

  // IMPORTANTE: salva ANTES de abrir o WhatsApp. No celular, o link wa.me costuma trocar
  // para o app do WhatsApp e suspender a aba do navegador — se o salvamento rodasse depois
  // de abrir o link (como era antes), a gravação podia nunca terminar e o envio ficava sem
  // registro. Salvando primeiro, o "enviado"/status já está garantido no banco antes do troca de app.
  const btn = document.querySelector('#cap-modal-bg button[onclick="capEnviarWpp()"]');
  if(btn){ btn.disabled = true; }
  const statusAnterior = c.status;
  c.enviados = (c.enviados||0) + 1;
  if(c.status==='novo') c.status = 'contatado';
  const ok = await capSalvar();
  if(btn){ btn.disabled = false; }
  if(!ok){
    // Reverte a mudança local já que não foi possível confirmar a gravação
    c.enviados -= 1;
    c.status = statusAnterior;
    showToast('Não foi possível salvar antes de abrir o WhatsApp. Tente novamente.','error');
    return;
  }
  abrirWppEFinalizar();
  // NÃO fecha o modal fora do modo em massa — permite conferir/reenviar
}

function capSelecionarTodos(checked){
  document.querySelectorAll('#cap-tbody input.cap-check').forEach(chk=>{ chk.checked = checked; });
}

function capContatosSelecionadosIds(){
  return Array.from(document.querySelectorAll('#cap-tbody input.cap-check:checked')).map(el=>el.dataset.id);
}

function capIniciarCampanhaEmMassa(){
  const ids = capContatosSelecionadosIds().filter(Boolean);
  if(!ids.length){ showToast('Selecione ao menos um contato para a campanha em massa','error'); return; }
  capBulkFila = ids;
  capBulkPos = 0;
  capBulkEnviados = 0;
  capBulkAtivo = true;
  capAbrirModal(capBulkFila[0], 'campanha');
}

// Corrige/atualiza o status de vários contatos de uma vez, sem enviar mensagem —
// útil para marcar retroativamente quem já foi contatado por fora do sistema.
function capAplicarStatusEmMassa(){
  const ids = capContatosSelecionadosIds().filter(Boolean);
  if(!ids.length){ showToast('Selecione ao menos um contato','error'); return; }
  const novoStatus = document.getElementById('cap-status-em-massa')?.value || 'contatado';
  const label = CAP_STATUS_LABEL[novoStatus] || novoStatus;
  if(!confirm(`Marcar ${ids.length} contato(s) selecionado(s) como "${label}"? Isso NÃO envia nenhuma mensagem, só atualiza o status.`)) return;
  let alterados = 0;
  ids.forEach(id=>{
    const c = capBuscarContatoPorId(id);
    if(c && !c._isPaciente){ c.status = novoStatus; alterados++; }
  });
  capSalvar().then(()=>{
    showToast(`${alterados} contato(s) marcado(s) como "${label}"`);
    capRenderTabela();
  });
}

function capBulkAvancar(){
  capBulkEnviados++;
  capBulkPos++;
  if(capBulkPos < capBulkFila.length){
    capAbrirModal(capBulkFila[capBulkPos], 'campanha');
    capRenderTabela();
  } else {
    capBulkAtivo = false;
    capFecharModal();
    showToast(`Campanha em massa concluída! ${capBulkEnviados} mensagem(ns) enviada(s).`);
    capRenderTabela();
  }
}

function capFiltrarCategoria(cat){
  capFiltroCategoriaAtual = cat;
  document.querySelectorAll('#cap-filtros-categoria button').forEach(b=>{
    b.className = (b.dataset.cat === cat) ? 'btn-primary' : 'btn-secondary';
  });
  capRenderTabela();
}

// Contatos importados do CSV trazem sua própria mensagem_campanha salva.
// Quando o texto padrão da categoria muda, isso limpa a mensagem individual
// de cada contato da categoria para que volte a usar o padrão atual.
function capRedefinirMensagemPadrao(categoria){
  const lista = capContatos().filter(c=>c.categoria===categoria);
  if(!lista.length){ showToast('Nenhum contato dessa categoria encontrado','error'); return; }
  if(!confirm(`Redefinir a mensagem de campanha de ${lista.length} contato(s) de "${CAP_CATEGORIA_LABEL[categoria]}" para o texto padrão atual? Isso substitui qualquer mensagem já salva para esses contatos.`)) return;
  lista.forEach(c=>{ c.mensagem_campanha = null; });
  capSalvar().then(()=>{
    showToast(`${lista.length} contato(s) de ${CAP_CATEGORIA_LABEL[categoria]} atualizado(s) para a mensagem padrão atual.`);
    capRenderTabela();
  });
}

function capListaExibicao(){
  const lista = capContatos().slice();
  const pacientesArr = (typeof pacientes!=='undefined' && Array.isArray(pacientes)) ? pacientes : [];
  const pacientesComoContatos = pacientesArr.filter(p=>p.telefone).map(p=>({
    id:'p_'+p.id, nome:p.nome, telefone:p.telefone, categoria:'paciente', status:null,
    origem:'Paciente cadastrado', enviados:0, criado_em:p.criado_em||'', _isPaciente:true
  }));
  return { lista, pacientesComoContatos };
}

function capRenderTabela(){
  const { lista, pacientesComoContatos } = capListaExibicao();

  const metrEl = document.getElementById('cap-metrics');
  if(metrEl){
    metrEl.innerHTML = [
      {lbl:'Total captação', val:lista.length, cor:'var(--rose-dark)'},
      {lbl:'Lead ST', val:lista.filter(c=>c.categoria==='lead_st').length, cor:CAP_CATEGORIA_COR.lead_st},
      {lbl:'Connect VIP', val:lista.filter(c=>c.categoria==='connect_vip').length, cor:CAP_CATEGORIA_COR.connect_vip},
      {lbl:'Pacientes', val:pacientesComoContatos.length, cor:CAP_CATEGORIA_COR.paciente},
      {lbl:'Contatados', val:lista.filter(c=>c.status==='contatado').length, cor:CAP_STATUS_COR.contatado},
      {lbl:'Agendaram', val:lista.filter(c=>c.status==='agendou').length, cor:CAP_STATUS_COR.agendou},
    ].map(s=>`<div style="background:var(--rose-lighter);border:1px solid var(--rose-light);border-radius:12px;padding:12px 16px;">
      <div style="font-size:11px;color:var(--rose-text);">${s.lbl}</div>
      <div style="font-size:22px;font-weight:800;color:${s.cor};">${s.val}</div>
    </div>`).join('');
  }

  const busca = (document.getElementById('cap-busca')?.value||'').toLowerCase().trim();
  const filtroStatus = document.getElementById('cap-filtro-status')?.value||'';
  const filtroCat = capFiltroCategoriaAtual;

  let base;
  if(filtroCat === 'paciente') base = pacientesComoContatos.slice();
  else if(filtroCat === 'lead_st' || filtroCat === 'connect_vip') base = lista.filter(c=>c.categoria===filtroCat);
  else base = lista.concat(pacientesComoContatos);

  let filtrados = base.slice().sort((a,b)=>(b.criado_em||'').localeCompare(a.criado_em||''));
  if(busca){
    filtrados = filtrados.filter(c=>
      (c.nome||'').toLowerCase().includes(busca) || capNormalizarTel(c.telefone).includes(busca.replace(/\D/g,''))
    );
  }
  if(filtroStatus) filtrados = filtrados.filter(c=>!c._isPaciente && c.status===filtroStatus);

  const tb = document.getElementById('cap-tbody');
  if(!tb) return;

  if(!filtrados.length){
    tb.innerHTML = `<tr><td colspan="8" style="text-align:center;color:var(--rose-text);padding:24px;">
      ${(lista.length||pacientesComoContatos.length) ? 'Nenhum contato encontrado com esse filtro.' : 'Nenhum contato cadastrado ainda. Adicione acima, importe uma lista ou o arquivo CSV.'}
    </td></tr>`;
    return;
  }

  tb.innerHTML = filtrados.map(c=>{
    const corStatus = CAP_STATUS_COR[c.status] || CAP_STATUS_COR.novo;
    const corCat = CAP_CATEGORIA_COR[c.categoria] || '#888';
    const labelCat = CAP_CATEGORIA_LABEL[c.categoria] || (c.categoria ? c.categoria : '—');
    const nomeAcaoCampanha = capNomeAcaoCampanha(c.categoria);
    return `<tr style="border-bottom:1px solid var(--rose-light);">
      <td style="padding:10px;text-align:center;">
        ${c._isPaciente ? '' : `<input type="checkbox" class="cap-check" data-id="${c.id}">`}
      </td>
      <td style="padding:10px;font-weight:600;">${escapeHtml(c.nome)}</td>
      <td style="padding:10px;color:var(--rose-text);font-size:12px;">${escapeHtml(capFormatarTelefoneExibicao(c.telefone))}</td>
      <td style="padding:10px;text-align:center;">
        <span style="background:${corCat}20;color:${corCat};border-radius:20px;padding:3px 10px;font-size:11.5px;font-weight:700;">${escapeHtml(labelCat)}</span>
      </td>
      <td style="padding:10px;text-align:center;">
        ${c._isPaciente
          ? '<span style="font-size:11px;color:var(--rose-text);">—</span>'
          : `<select onchange="capMudarStatus(${c.id}, this.value)" style="border:1px solid var(--rose-light);border-radius:20px;padding:3px 8px;font-size:12px;font-weight:700;color:${corStatus};background:${corStatus}15;">
              ${Object.entries(CAP_STATUS_LABEL).map(([k,l])=>`<option value="${k}" ${c.status===k?'selected':''}>${l}</option>`).join('')}
            </select>`
        }
      </td>
      <td style="padding:10px;text-align:center;">
        <div style="display:flex;flex-direction:column;align-items:center;gap:3px;">
          <button onclick="capAbrirModal('${c.id}','manual')" style="background:#25d366;border:none;border-radius:50%;width:36px;height:36px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;box-shadow:0 2px 8px rgba(37,211,102,.4);" title="Enviar WhatsApp">
            <i class="ti ti-brand-whatsapp" style="color:#fff;font-size:17px;"></i>
          </button>
          ${c.enviados ? `<span style="font-size:10px;color:#856404;font-weight:700;">${c.enviados}x</span>` : ''}
        </div>
      </td>
      <td style="padding:10px;text-align:center;">
        ${c._isPaciente
          ? `<span style="font-size:10.5px;color:var(--rose-text);" title="Use a aba Resgate de Pacientes para mensagens a pacientes">Use Resgate</span>`
          : `<button onclick="capAbrirModal('${c.id}','campanha')" style="background:var(--rose-dark);border:none;border-radius:8px;padding:6px 10px;cursor:pointer;color:#fff;font-size:11px;font-weight:700;white-space:nowrap;" title="${escapeHtml(nomeAcaoCampanha)}">${escapeHtml(nomeAcaoCampanha)}</button>`
        }
      </td>
      <td style="padding:10px;text-align:center;">
        ${c._isPaciente ? '' : `<button onclick="capExcluirContato(${c.id})" style="background:none;border:none;cursor:pointer;color:#dc2626;font-size:16px;" title="Excluir"><i class="ti ti-trash"></i></button>`}
      </td>
    </tr>`;
  }).join('');
}


// ══════════════════════════════════════════════════════
// CONFIGURAÇÕES DA CLÍNICA
// ══════════════════════════════════════════════════════
async function renderConfiguracoes(){
  if(!clinicaData) return;
  if(!_financeiroCarregado) await loadFinanceiro();
  document.getElementById('cfg-nome-cli').value  = clinicaData.nome_cli  || '';
  document.getElementById('cfg-nome-resp').value = clinicaData.nome_resp || '';
  document.getElementById('cfg-email').value     = clinicaData.email     || '';
  document.getElementById('cfg-telefone').value  = clinicaData.telefone  || '';
  document.getElementById('cfg-endereco').value  = clinicaData.endereco  || cfg.endereco  || '';
  document.getElementById('cfg-maps-link').value = clinicaData.maps_link || cfg.maps_link || '';
  // Taxas
  document.getElementById('cfg-taxa-debito').value = taxasCfg.debito ?? 1.5;
  const cr = taxasCfg.credito || [];
  [1,2,3,4,5,6,7,8,9,10,11,12].forEach(p=>{
    const el = document.getElementById('cfg-taxa-cred'+p);
    if(el) el.value = (cr[p-1] !== undefined && cr[p-1] !== '') ? cr[p-1] : '';
  });
  document.getElementById('cfg-salario').value  = cfg.salario  ?? 3000;
  document.getElementById('cfg-horas').value    = cfg.horas    ?? 132;
  document.getElementById('cfg-trib').value     = cfg.trib     ?? 0;
  document.getElementById('cfg-desperd').value  = cfg.desperd  ?? 5;
  document.getElementById('cfg-margem').value   = cfg.margem   ?? 100;
  document.getElementById('cfg-pct-manut').value = cfg.pct_manut ?? 15;
  cfgAtualizarPreviewHora();
  atualizarUltimoBackup();
}

function cfgAtualizarPreviewHora(){
  const salario = Number(document.getElementById('cfg-salario')?.value)||0;
  const horas   = Number(document.getElementById('cfg-horas')?.value)||1;
  const trib    = Number(document.getElementById('cfg-trib')?.value)||0;
  const hora    = parseFloat(((salario/horas)*(1+trib/100)).toFixed(2));
  const el = document.getElementById('cfg-hora-preview');
  if(el) el.textContent = fmtBRL(hora) + ' / hora';
}

// Recálculo forçado de TODOS os procedimentos (ignora _precoManual/_margemManual)
// — só deve ser chamado a partir do checkbox "Recalcular preços de todos os
// procedimentos" em salvarPrecificacao(), nunca automaticamente.
function _recalcularTodosProcsForcado(){
  procs.forEach(p=>{
    const ins = procInsumos[p.id]||[];
    if(ins.length){
      p.insumos = parseFloat(ins.reduce((acc,item)=>{const m=mats.find(x=>x.id===item.matId);return acc+(m?m.custo*item.qtd:0);},0).toFixed(2));
    }
    p.horaClin = parseFloat(((p.tempo/60)*calcHora()).toFixed(2));
    p.margem = cfg.margem;
    p.precoFinal = calcPrecoFinal(p);
    p._precoManual = false;
    p._margemManual = false;
  });
  // 2ª passada: manutenções dependem do preço de instalação já recalculado acima
  procs.forEach(p=>{
    const pm = calcPrecoManut(p.id, false);
    if(pm !== null) p.precoFinal = pm;
  });
}

async function salvarPrecificacao(){
  cfg.salario  = Number(document.getElementById('cfg-salario')?.value)||0;
  cfg.horas    = Number(document.getElementById('cfg-horas')?.value)||132;
  cfg.trib     = Number(document.getElementById('cfg-trib')?.value)||0;
  cfg.desperd  = Number(document.getElementById('cfg-desperd')?.value)||0;
  cfg.margem   = Number(document.getElementById('cfg-margem')?.value)||100;
  cfg.pct_manut = Number(document.getElementById('cfg-pct-manut')?.value)||15;

  // Salva sempre só a configuração (hora clínica/margem padrão) — NÃO mexe no
  // preço já salvo de nenhum procedimento. O recálculo em massa (que inclusive
  // sobrescreve preços ajustados manualmente) só roda se o usuário marcar o
  // checkbox abaixo e confirmar; nunca acontece sozinho.
  const recalcEl = document.getElementById('cfg-recalc-massa');
  let recalculouTudo = false;
  if(recalcEl?.checked){
    const qtd = procs.length;
    const manuais = procs.filter(p=>p._precoManual).length;
    const msg = `Isso vai recalcular o preço de ${qtd} procedimento(s)`
      + (manuais>0 ? `, incluindo ${manuais} que você ajustou manualmente` : '')
      + `. Essa ação não pode ser desfeita. Continuar?`;
    if(confirm(msg)){
      _recalcularTodosProcsForcado();
      recalculouTudo = true;
    }
    recalcEl.checked = false;
  }

  showLoading(true);
  const _ePrec=await saveFinanceiro();
  showLoading(false);
  renderProcs();
  if(!_ePrec){
    showToast(recalculouTudo
      ? `Precificação salva e ${procs.length} procedimento(s) recalculado(s)! Hora clínica: ${fmtBRL(calcHora())}.`
      : 'Precificação salva! Margem global: '+cfg.margem+'%. Hora clínica: '+fmtBRL(calcHora())+'.');
  }
}

async function salvarTaxas(){
  if(!_financeiroCarregado){
    showLoading(true);
    await loadFinanceiro();
    showLoading(false);
  }
  taxasCfg.debito = parseFloat(document.getElementById('cfg-taxa-debito')?.value)||0;
  taxasCfg.credito = [1,2,3,4,5,6,7,8,9,10,11,12].map(p=>parseFloat(document.getElementById('cfg-taxa-cred'+p)?.value)||0);
  showLoading(true);
  const err = await saveFinanceiro();
  showLoading(false);
  if(err) showToast('Erro ao salvar taxas: '+err.message,'error');
  else showToast('Taxas salvas!');
}

function calcValorLiquido(total, forma, parcelas){
  if(!total) return total;
  let taxa = 0;
  if(forma==='debito') taxa = taxasCfg.debito || 0;
  else if(forma==='credito'){
    const idx = parcelas - 1;
    taxa = idx>=0 ? (taxasCfg.credito||[])[idx]||0 : 0;
  }
  return parseFloat((total * (1 - taxa/100)).toFixed(2));
}

async function salvarConfiguracoes(){
  const nome_cli  = document.getElementById('cfg-nome-cli').value.trim();
  const nome_resp = document.getElementById('cfg-nome-resp').value.trim();
  const telefone  = document.getElementById('cfg-telefone').value.trim();
  const endereco  = document.getElementById('cfg-endereco').value.trim();
  const maps_link = document.getElementById('cfg-maps-link').value.trim();
  if(!nome_cli){ showToast('Preencha o nome da clínica.','warn'); return; }
  showLoading(true);
  const updateData = { nome_cli, nome_resp, telefone };
  let { error } = await _sb.from('clinicas').update({ ...updateData, endereco, maps_link }).eq('id', clinicaId);
  if(error && error.message && (error.message.includes('endereco') || error.message.includes('maps_link'))){
    ({ error } = await _sb.from('clinicas').update(updateData).eq('id', clinicaId));
  }
  if(error){ showLoading(false); showToast('Erro: '+error.message,'error'); return; }
  clinicaData.nome_cli  = nome_cli;
  clinicaData.nome_resp = nome_resp;
  clinicaData.telefone  = telefone;
  clinicaData.endereco  = endereco;
  clinicaData.maps_link = maps_link;
  const el = document.getElementById('header-clinica');
  if(el) el.textContent = nome_cli;
  // Persiste endereco/maps_link + taxas via financeiro_config (fallback confiável)
  cfg.endereco  = endereco;
  cfg.maps_link = maps_link;
  const taxaDebEl = document.getElementById('cfg-taxa-debito');
  if(taxaDebEl){
    taxasCfg.debito = parseFloat(taxaDebEl.value)||0;
    taxasCfg.credito = [1,2,3,4,5,6,7,8,9,10,11,12].map(p=>parseFloat(document.getElementById('cfg-taxa-cred'+p)?.value)||0);
  }
  if(!_financeiroCarregado) await loadFinanceiro();
  const _eCfg=await saveFinanceiro();
  showLoading(false);
  if(_eCfg){ showToast('Erro ao salvar configurações: '+_eCfg.message,'error'); return; }
  showToast('Configurações salvas!');
}

function exportarEstoque(){
  if(!estoque || Object.keys(estoque).length === 0){
    showToast('Estoque vazio, nada para exportar.','warn'); return;
  }
  const dados = { estoque, exportadoEm: new Date().toISOString(), versao: 1 };
  const blob = new Blob([JSON.stringify(dados, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = 'estoque_rhaiza_' + hoje() + '.json';
  a.click();
  URL.revokeObjectURL(url);
  showToast('Estoque exportado!');
}

async function importarEstoque(input){
  const file = input.files[0]; if(!file) return;
  const texto = await file.text();
  let dados;
  try { dados = JSON.parse(texto); } catch(e){ showToast('Arquivo inválido.','error'); return; }
  const novoEstoque = dados.estoque || dados;
  if(typeof novoEstoque !== 'object' || Array.isArray(novoEstoque)){
    showToast('Formato de estoque inválido.','error'); return;
  }
  if(!confirm('Importar estoque do arquivo? Os valores atuais serão substituídos.')) return;
  estoque = novoEstoque;
  showLoading(true);
  const _eImp=await saveFinanceiro();
  showLoading(false);
  input.value = '';
  if(!_eImp) showToast('Estoque importado e salvo com sucesso!');
  else showToast('Erro ao importar estoque: '+_eImp.message,'error');
}

async function alterarSenha(){
  const pass  = document.getElementById('cfg-pass').value;
  const pass2 = document.getElementById('cfg-pass2').value;
  if(!pass){ showToast('Digite a nova senha.','warn'); return; }
  if(pass.length < 6){ showToast('A senha deve ter pelo menos 6 caracteres.','warn'); return; }
  if(pass !== pass2){ showToast('As senhas não coincidem.','warn'); return; }
  showLoading(true);
  const { error } = await _sb.auth.updateUser({ password: pass });
  showLoading(false);
  if(error){ showToast('Erro: '+error.message,'error'); return; }
  document.getElementById('cfg-pass').value  = '';
  document.getElementById('cfg-pass2').value = '';
  showToast('Senha alterada com sucesso!');
}

// ── DARK MODE ──
function toggleDarkMode(){
  const isDark = document.documentElement.classList.toggle('dark-mode');
  localStorage.setItem('rwdent-dark', isDark?'1':'0');
  const icon = document.querySelector('#btn-dark-mode i');
  const label = document.getElementById('dark-mode-label');
  if(icon) icon.className = isDark ? 'ti ti-moon' : 'ti ti-sun';
  if(label) label.textContent = isDark ? 'Ativado' : 'Desativado';
}
(function(){
  if(localStorage.getItem('rwdent-dark')==='1'){
    document.documentElement.classList.add('dark-mode');
    setTimeout(()=>{
      const icon = document.querySelector('#btn-dark-mode i');
      const label = document.getElementById('dark-mode-label');
      if(icon) icon.className='ti ti-moon';
      if(label) label.textContent='Ativado';
    },100);
  }
})();

// ── EXPORTAR BACKUP ──
async function exportarBackup(){
  showLoading(true);
  try {
    const { data: allProcDentes } = await _sb.from('procedimentos_dentes').select('*').eq('clinica_id', clinicaId);
    const procDentesMap = {};
    (allProcDentes||[]).forEach(r => { (procDentesMap[r.paciente_id] = procDentesMap[r.paciente_id] || []).push(r); });
    const pacientesComOdonto = pacientes.map(p => ({ ...p, procedimentos_dentes: procDentesMap[p.id] || [] }));
    const backup = {
      exportadoEm: new Date().toISOString(),
      clinica: clinicaData,
      pacientes: pacientesComOdonto,
      agendamentos: agendamentos,
      profissionais: profissionais,
      financeiro: { procs, mats, estoque, procInsumos, vendas, combos, cfg, taxasCfg, descCfg, pagPac }
    };
    const blob = new Blob([JSON.stringify(backup, null, 2)], {type:'application/json'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `rwdent-backup-${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    localStorage.setItem('rwdent-ultimo-backup', new Date().toISOString());
    logAtividade('Backup exportado', `${pacientes.length} pacientes, ${agendamentos.length} agendamentos`);
    atualizarUltimoBackup();
    showToast('Backup exportado com sucesso!');
  } catch(e){ showToast('Erro ao exportar: '+e.message,'error'); }
  showLoading(false);
}
function atualizarUltimoBackup(){
  const el = document.getElementById('ultimo-backup-info');
  if(!el) return;
  const dt = localStorage.getItem('rwdent-ultimo-backup');
  if(dt){
    const d = new Date(dt);
    const dias = Math.floor((Date.now()-d.getTime())/(1000*60*60*24));
    el.innerHTML = `<i class="ti ti-check" style="color:#2e7d32;"></i> Último backup: ${d.toLocaleDateString('pt-BR')} às ${d.toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'})}` + (dias>7?` <span style="color:#dc2626;font-weight:700;">(${dias} dias atrás — recomendamos fazer backup)</span>`:'');
  } else {
    el.innerHTML = '<i class="ti ti-alert-triangle" style="color:#dc2626;"></i> <span style="color:#dc2626;font-weight:600;">Nenhum backup registrado — exporte seus dados!</span>';
  }
}

// ── NOTIFICAÇÕES DE CONSULTA ──
let _notifInterval = null;
function ativarNotificacoes(){
  if(!('Notification' in window)){ showToast('Seu navegador não suporta notificações.','warn'); return; }
  Notification.requestPermission().then(perm=>{
    if(perm==='granted'){
      showToast('Notificações ativadas! Você será avisado 15min antes de cada consulta.');
      const btn = document.getElementById('btn-notif');
      if(btn) btn.innerHTML='<i class="ti ti-bell-check"></i> Ativado';
      if(_notifInterval) clearInterval(_notifInterval);
      _notifInterval = setInterval(checarLembretesConsulta, 60000);
      checarLembretesConsulta();
    } else { showToast('Permissão de notificação negada.','warn'); }
  });
}
function checarLembretesConsulta(){
  if(Notification.permission!=='granted') return;
  const agora = new Date();
  const hoje = agora.toISOString().slice(0,10);
  const notificados = JSON.parse(localStorage.getItem('rwdent-notif-sent')||'[]');
  agendamentos.filter(a=>a.data===hoje && a.horario).forEach(a=>{
    const [h,m] = a.horario.split(':').map(Number);
    const horaConsulta = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate(), h, m);
    const diff = (horaConsulta - agora) / 60000;
    const key = a.id+'-'+hoje;
    if(diff > 0 && diff <= 15 && !notificados.includes(key)){
      new Notification('Consulta em 15 minutos', {
        body: `${a.nome||'Paciente'} — ${a.procedimento||'Consulta'} às ${a.horario.slice(0,5)}`,
        icon: '/favicon.svg'
      });
      notificados.push(key);
      localStorage.setItem('rwdent-notif-sent', JSON.stringify(notificados.slice(-100)));
    }
  });
}

// ── BUSCA GLOBAL (Ctrl+K) ──
let _buscaGlobalIdx = -1;
document.addEventListener('keydown', e=>{
  if((e.ctrlKey||e.metaKey) && e.key==='k'){
    e.preventDefault();
    abrirBuscaGlobal();
  }
  if(e.key==='Escape'){
    fecharBuscaGlobal();
  }
});
function abrirBuscaGlobal(){
  const ol = document.getElementById('search-overlay');
  ol.classList.add('show');
  const inp = document.getElementById('search-global-input');
  inp.value=''; inp.focus();
  document.getElementById('search-global-results').innerHTML='<div style="padding:16px;text-align:center;color:var(--rose-text);font-size:13px;">Digite para buscar pacientes, procedimentos, materiais, agendamentos ou vendas</div>';
  _buscaGlobalIdx=-1;
}
function fecharBuscaGlobal(){
  document.getElementById('search-overlay').classList.remove('show');
}
function buscaGlobalFiltrar(){
  const q = _norm(document.getElementById('search-global-input').value);
  const res = document.getElementById('search-global-results');
  if(!q){ res.innerHTML='<div style="padding:16px;text-align:center;color:var(--rose-text);font-size:13px;">Digite para buscar pacientes, procedimentos, materiais, agendamentos ou vendas</div>'; return; }
  const items = [];
  const qDigits = q.replace(/\D/g,'');
  pacientes.filter(p=>!p.arquivado&&(_norm(p.nome).includes(q)||(qDigits.length>=2&&((p.cpf||'').replace(/\D/g,'').includes(qDigits)||(p.telefone||'').replace(/\D/g,'').includes(qDigits))))).slice(0,10).forEach(p=>{
    items.push({cat:'Pacientes',icon:'ti-user',label:escapeHtml(p.nome),sub:escapeHtml(p.telefone||p.cpf||''),action:`fecharBuscaGlobal();switchTab('pacientes');setTimeout(()=>selectPatient(${p.id}),150)`});
  });
  procs.filter(p=>p.ativo!==false&&_norm(p.nome).includes(q)).slice(0,15).forEach(p=>{
    items.push({cat:'Procedimentos',icon:'ti-medical-cross',label:escapeHtml(p.nome),sub:fmtBRL(p.precoFinal||0),action:`fecharBuscaGlobal();switchTab('procedimentos_fin')`});
  });
  mats.filter(m=>!m.arquivado&&_norm(m.nome).includes(q)).slice(0,10).forEach(m=>{
    items.push({cat:'Materiais',icon:'ti-package',label:escapeHtml(m.nome),sub:m.unidade?escapeHtml(m.unidade):'Material',action:`fecharBuscaGlobal();switchTab('estoque_fin')`});
  });
  const hoje = new Date().toISOString().slice(0,10);
  agendamentos.filter(a=>a.data>=hoje&&(_norm(a.nome||'').includes(q)||_norm(a.procedimento||'').includes(q))).slice(0,10).forEach(a=>{
    items.push({cat:'Agenda',icon:'ti-calendar',label:escapeHtml(a.nome||''),sub:`${formatDate(a.data)} ${(a.horario||'').slice(0,5)} — ${escapeHtml(a.procedimento||'')}`,action:`fecharBuscaGlobal();switchTab('lista')`});
  });
  vendas.filter(v=>_norm(v.pacienteNome||'').includes(q)||(_norm((v.itens||[]).map(i=>i.nome||'').join(' '))).includes(q)).slice(0,10).forEach(v=>{
    const st = v.status==='finalizada'?'Finalizada':v.status==='orcamento'?'Orçamento':'Venda';
    items.push({cat:'Vendas',icon:'ti-receipt',label:escapeHtml(v.pacienteNome||'Venda'),sub:`${st} — ${fmtBRL(v.total||0)}`,action:`fecharBuscaGlobal();switchTab('vendas_fin')`});
  });
  if(!items.length){ res.innerHTML='<div style="padding:16px;text-align:center;color:var(--rose-text);font-size:13px;">Nenhum resultado encontrado</div>'; return; }
  _buscaGlobalIdx=-1;
  let lastCat='';
  res.innerHTML=items.map((it,i)=>{
    let hdr='';
    if(it.cat!==lastCat){ lastCat=it.cat; hdr=`<div style="padding:6px 14px 2px;font-size:10px;font-weight:700;text-transform:uppercase;color:var(--rose);letter-spacing:.5px;">${it.cat}</div>`; }
    return hdr+`<div class="search-result-item" data-idx="${i}" onclick="${it.action}"><i class="ti ${it.icon}" style="font-size:18px;color:var(--rose);"></i><div style="flex:1;min-width:0;"><div style="font-weight:600;font-size:13px;">${it.label}</div><div style="font-size:11px;color:var(--rose-text);">${it.sub}</div></div><i class="ti ti-chevron-right" style="font-size:14px;color:var(--rose-light);"></i></div>`;
  }).join('');
}
function buscaGlobalNav(e){
  const items = document.querySelectorAll('.search-result-item');
  if(!items.length) return;
  if(e.key==='ArrowDown'){ e.preventDefault(); _buscaGlobalIdx=Math.min(_buscaGlobalIdx+1,items.length-1); }
  else if(e.key==='ArrowUp'){ e.preventDefault(); _buscaGlobalIdx=Math.max(_buscaGlobalIdx-1,0); }
  else if(e.key==='Enter' && _buscaGlobalIdx>=0){ e.preventDefault(); items[_buscaGlobalIdx]?.click(); return; }
  else return;
  items.forEach((it,i)=>it.classList.toggle('active',i===_buscaGlobalIdx));
  items[_buscaGlobalIdx]?.scrollIntoView({block:'nearest'});
}

// ── RECIBO DE VENDA ──
function gerarRecibo(vendaId){
  const v = vendas.find(x=>x.id===vendaId); if(!v) return;
  const clinica = clinicaData?.nome_cli || 'Clínica';
  const data = new Date(v.data).toLocaleDateString('pt-BR',{day:'2-digit',month:'long',year:'numeric'});
  const hora = new Date(v.data).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});
  const itensHtml = (v.itens||[]).map(i=>`<tr><td style="padding:6px 10px;border-bottom:1px solid #eee;font-size:13px;">${escapeHtml(i.nome||'')}</td><td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:center;font-size:13px;">${i.qtd||1}</td><td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;font-size:13px;">R$ ${(i.preco||0).toFixed(2).replace('.',',')}</td></tr>`).join('');
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Recibo - ${escapeHtml(clinica)}</title>
<style>*{margin:0;padding:0;box-sizing:border-box;}body{font-family:'Segoe UI',Arial,sans-serif;padding:30px;color:#3a2020;max-width:400px;margin:0 auto;}
.header{text-align:center;border-bottom:2px dashed #d4735a;padding-bottom:14px;margin-bottom:16px;}
.header h1{font-size:16px;color:#7a3020;}.header p{font-size:11px;color:#a05040;margin-top:3px;}
table{width:100%;border-collapse:collapse;margin:12px 0;}
.total{text-align:right;font-size:16px;font-weight:800;color:#7a3020;border-top:2px solid #d4735a;padding-top:10px;margin-top:10px;}
.footer{text-align:center;margin-top:20px;font-size:10px;color:#b08070;border-top:1px dashed #f0cfc4;padding-top:10px;}
@media print{body{padding:10px;}}</style></head><body>
<div class="header"><h1>${escapeHtml(clinica)}</h1><p>RECIBO DE PAGAMENTO</p><p>${data} - ${hora}</p></div>
${v.pacienteNome?`<p style="font-size:13px;margin-bottom:8px;"><strong>Paciente:</strong> ${escapeHtml(v.pacienteNome)}</p>`:''}
<table><thead><tr style="background:#fdf0eb;"><th style="padding:6px 10px;text-align:left;font-size:11px;">Item</th><th style="padding:6px 10px;text-align:center;font-size:11px;">Qtd</th><th style="padding:6px 10px;text-align:right;font-size:11px;">Valor</th></tr></thead><tbody>${itensHtml}</tbody></table>
${v.desconto?`<p style="font-size:12px;text-align:right;color:#856404;">Desconto: -R$ ${(v.desconto||0).toFixed(2).replace('.',',')}</p>`:''}
<div class="total">Total: R$ ${(v.total||0).toFixed(2).replace('.',',')}</div>
<p style="font-size:12px;margin-top:8px;text-align:right;color:var(--rose-text);">Pagamento: ${escapeHtml(v.pagamento||'Não informado')}</p>
<div class="footer">${escapeHtml(clinica)}<br>Obrigado pela preferência!</div>
<`+`script>window.onload=()=>{window.print();}<`+`/script></body></html>`;
  const w = window.open('','_blank');
  if(w){ w.document.write(html); w.document.close(); }
  else { showToast('Permita pop-ups para gerar o recibo.','warn'); }
}

// ── RELATÓRIO POR PROFISSIONAL ──
function relProdutividade(){
  if(!_finVerificado){ pedirFinPinFaturamento().then(ok=>{ if(ok) relProdutividade(); }); return; }
  if(!vendas.length && !agendamentos.length){ showToast('Sem dados para gerar relatório.','warn'); return; }
  const mesAtual = new Date().toISOString().slice(0,7);
  const profStats = {};
  profissionais.forEach(p=>{ profStats[p.id]={nome:p.nome,atendimentos:0,receita:0,procedimentos:{}}; });
  vendas.filter(v=>v.status==='finalizada'&&(v.data||'').startsWith(mesAtual)).forEach(v=>{
    const profId = v.profId || v.profissionalId;
    if(profId && profStats[profId]){
      profStats[profId].atendimentos++;
      profStats[profId].receita += v.total||0;
      (v.itens||[]).forEach(i=>{
        const nome = i.nome||'Outro';
        profStats[profId].procedimentos[nome] = (profStats[profId].procedimentos[nome]||0) + (i.qtd||1);
      });
    }
  });
  agendamentos.filter(a=>(a.data||'').startsWith(mesAtual)&&a.status==='compareceu').forEach(a=>{
    const profId = a.profissional_id;
    if(profId && profStats[profId]) profStats[profId].atendimentos++;
  });
  const lista = Object.values(profStats).filter(p=>p.atendimentos>0||p.receita>0).sort((a,b)=>b.receita-a.receita);
  const mesNome = new Date().toLocaleDateString('pt-BR',{month:'long',year:'numeric'});
  let html = `<div style="padding:20px;"><h3 style="color:var(--rose-dark);margin-bottom:16px;"><i class="ti ti-chart-bar"></i> Produtividade — ${mesNome}</h3>`;
  if(!lista.length){ html+='<p style="color:var(--rose-text);font-size:13px;">Nenhum dado de produtividade neste mês.</p>'; }
  else {
    lista.forEach(p=>{
      const topProcs = Object.entries(p.procedimentos).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([n,q])=>`${escapeHtml(n)} (${q}x)`).join(', ');
      html+=`<div style="background:var(--rose-lighter);border:1px solid var(--rose-light);border-radius:12px;padding:14px;margin-bottom:10px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
          <span style="font-weight:700;color:var(--rose-dark);">${escapeHtml(p.nome)}</span>
          <span style="font-weight:800;color:var(--rose);">${fmtBRL(p.receita)}</span>
        </div>
        <div style="font-size:12px;color:var(--rose-text);">${p.atendimentos} atendimento(s) ${topProcs?'· '+topProcs:''}</div>
      </div>`;
    });
  }
  html+='</div>';
  const modal = document.createElement('div');
  modal.className='cal-modal-bg show';
  modal.onclick=e=>{if(e.target===modal)modal.remove();};
  modal.innerHTML=`<div class="cal-modal" onclick="event.stopPropagation()" style="max-width:500px;max-height:80vh;overflow:auto;">${html}<div style="padding:0 20px 20px;text-align:right;"><button class="btn-secondary" onclick="this.closest('.cal-modal-bg').remove()">Fechar</button></div></div>`;
  document.body.appendChild(modal);
}

// ── LOG DE ATIVIDADES ──
function logAtividade(acao, detalhe){
  const entry = { data: new Date().toISOString(), acao, detalhe: (detalhe||'').slice(0,200), usuario: currentUser?.email||'', clinica_id: clinicaId||null };
  const logs = JSON.parse(localStorage.getItem('rwdent-log')||'[]');
  logs.unshift(entry);
  localStorage.setItem('rwdent-log', JSON.stringify(logs.slice(0,500)));
  if(clinicaId && _sb){
    _sb.from('log_atividades').insert([{ clinica_id: clinicaId, usuario: currentUser?.email||'', acao, detalhe: (detalhe||'').slice(0,200) }]).then(()=>{});
  }
}
async function verLogAtividades(){
  let logs = JSON.parse(localStorage.getItem('rwdent-log')||'[]');
  if(clinicaId && _sb){
    const { data } = await _sb.from('log_atividades').select('*').eq('clinica_id', clinicaId).order('created_at',{ascending:false}).limit(200);
    if(data && data.length){
      logs = data.map(r=>({ data: r.created_at, acao: r.acao, detalhe: r.detalhe, usuario: r.usuario }));
    }
  }
  const _icoMap = { 'Paciente adicionado':'ti-user-plus', 'Paciente editado':'ti-pencil', 'Paciente arquivado':'ti-archive', 'Paciente restaurado':'ti-refresh', 'Agendamento criado':'ti-calendar-plus', 'Agendamento criado (calendário)':'ti-calendar-plus', 'Venda finalizada':'ti-cash', 'Procedimento salvo':'ti-dental', 'Procedimento arquivado':'ti-archive', 'Backup exportado':'ti-download', 'Backup importado':'ti-database-import', 'Material arquivado':'ti-archive', 'Material restaurado':'ti-refresh', 'Anamnese enviada':'ti-send', 'Anamnese salva':'ti-clipboard-check', 'Anamnese recebida':'ti-clipboard-check', 'Profissional adicionado':'ti-user-plus', 'Config WhatsApp salva':'ti-brand-whatsapp', 'WhatsApp manual':'ti-brand-whatsapp' };
  let html = `<div style="padding:20px;"><h3 style="color:var(--rose-dark);margin-bottom:16px;"><i class="ti ti-history"></i> Log de atividades</h3>`;
  if(!logs.length){ html+='<p style="color:var(--rose-text);font-size:13px;">Nenhuma atividade registrada.</p>'; }
  else {
    html+='<div style="max-height:500px;overflow-y:auto;">';
    logs.slice(0,200).forEach(l=>{
      const dt = new Date(l.data);
      const fmt = dt.toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit',year:'2-digit'})+' '+dt.toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});
      const ico = _icoMap[l.acao]||'ti-activity';
      html+=`<div style="display:flex;gap:10px;padding:8px 0;border-bottom:1px solid var(--rose-light);font-size:12px;align-items:center;">
        <i class="ti ${ico}" style="font-size:14px;color:var(--rose);flex-shrink:0;"></i>
        <span style="color:var(--rose-text);min-width:95px;flex-shrink:0;">${fmt}</span>
        <span style="font-weight:600;color:var(--rose-dark);white-space:nowrap;">${escapeHtml(l.acao)}</span>
        <span style="color:var(--rose-text);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(l.detalhe||'')}</span>
      </div>`;
    });
    html+='</div>';
  }
  html+='</div>';
  const modal = document.createElement('div');
  modal.className='cal-modal-bg show';
  modal.onclick=e=>{if(e.target===modal)modal.remove();};
  modal.innerHTML=`<div class="cal-modal" onclick="event.stopPropagation()" style="max-width:650px;max-height:80vh;overflow:auto;">${html}<div style="padding:0 20px 20px;text-align:right;"><button class="btn-secondary" onclick="this.closest('.cal-modal-bg').remove()">Fechar</button></div></div>`;
  document.body.appendChild(modal);
}

// ── WHATSAPP CONFIRMAÇÃO ──
function salvarConfigWhatsApp(){
  const antecedencia = parseInt(document.getElementById('wpp-antecedencia')?.value)||24;
  const template = document.getElementById('wpp-template')?.value||'';
  localStorage.setItem('rwdent-wpp', JSON.stringify({antecedencia, template}));
  logAtividade('Config WhatsApp salva', `Antecedência: ${antecedencia}h`);
  showToast('Configuração WhatsApp salva!');
}
function carregarConfigWhatsApp(){
  const saved = JSON.parse(localStorage.getItem('rwdent-wpp')||'{}');
  const el1 = document.getElementById('wpp-antecedencia');
  const el2 = document.getElementById('wpp-template');
  if(saved.antecedencia && el1) el1.value = saved.antecedencia;
  if(saved.template && el2) el2.value = saved.template;
}
function wppEnviarManual(){
  const cfg = JSON.parse(localStorage.getItem('rwdent-wpp')||'{}');
  const template = cfg.template || document.getElementById('wpp-template')?.value || 'Olá {nome}, sua consulta está marcada para {data} às {horario}. Confirma?';
  const antecedencia = (cfg.antecedencia||24)*3600000;
  const agora = Date.now();
  const proximos = agendamentos.filter(a=>{
    if(!a.data||!a.horario) return false;
    const dt = new Date(a.data+'T'+a.horario).getTime();
    return dt > agora && dt < agora + antecedencia;
  });
  if(!proximos.length){ showToast('Nenhuma consulta nas próximas '+((antecedencia/3600000))+'h.','warn'); return; }
  let enviados = 0;
  proximos.forEach(a=>{
    const pac = pacientes.find(p=>p.id===a.paciente_id);
    const tel = (a.telefone||pac?.telefone||'').replace(/\D/g,'');
    if(!tel){ return; }
    const dataFmt = new Date(a.data).toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit',year:'numeric'});
    const msg = template
      .replace(/{nome}/g, a.nome||pac?.nome||'')
      .replace(/{data}/g, dataFmt)
      .replace(/{horario}/g, a.horario||'')
      .replace(/{profissional}/g, a.prof_nome||'')
      .replace(/{procedimento}/g, a.procedimento||'');
    window.open('https://wa.me/55'+tel+'?text='+encodeURIComponent(msg),'_blank');
    enviados++;
  });
  logAtividade('WhatsApp manual', `${enviados} mensagem(ns) aberta(s)`);
  showToast(`${enviados} mensagem(ns) aberta(s) no WhatsApp Web.`);
}

async function calSaveNewAppt(){
  const patientId=document.getElementById('cn-patient').value;
  const paciente=pacientes.find(p=>p.id==patientId);
  const telefone=document.getElementById('cn-phone').value.trim();
  const profId=parseInt(document.getElementById('cn-prof').value);
  const data=document.getElementById('cn-data').value;
  const horario=document.getElementById('cn-horario').value;
  const procedimento=document.getElementById('cn-proc').value.trim();
  const obs=document.getElementById('cn-obs').value.trim();
  if(!paciente){ showToast('Selecione um paciente.','warn'); return; }
  if(!profId){ showToast('Selecione um profissional.','warn'); return; }
  if(!data){ showToast('Escolha a data.','warn'); return; }
  if(!horario){ showToast('Escolha o horário.','warn'); return; }
  const conflito=agendamentos.find(a=>a.prof_id===profId&&a.data===data&&a.horario===horario);
  if(conflito){ showToast('Conflito de horário.','error'); return; }
  const prof=profissionais.find(p=>p.id===profId);
  if(!prof){ showToast('Profissional inválido.','warn'); return; }
  showLoading(true);
  // Confere de novo direto no banco antes de salvar (mesma proteção do agendamento pela tela normal).
  const { data: conflitoBanco } = await _sb.from('agendamentos')
    .select('id').eq('clinica_id', clinicaId).eq('prof_id', profId).eq('data', data).eq('horario', horario).limit(1);
  if(conflitoBanco && conflitoBanco.length){
    showLoading(false);
    showToast('Esse horário acabou de ser ocupado por outro agendamento. Escolha outro horário.','error');
    return;
  }
  const { data:novo, error } = await _sb.from('agendamentos').insert([{
    paciente_id: paciente.id, nome: paciente.nome,
    telefone: telefone||paciente.telefone||'',
    prof_id: profId, prof_nome: prof.nome, prof_cor: prof.cor,
    data, horario, procedimento, obs,
    clinica_id: clinicaId
  }]).select().single();
  showLoading(false);
  if(error){ showToast('Erro: '+error.message,'error'); return; }
  agendamentos.push(novo);
  agendamentos.sort((a,b)=>(a.data+a.horario).localeCompare(b.data+b.horario));
  document.getElementById('cal-new-bg').classList.remove('show');
  renderCalendario(); renderLista(); renderHomeStats();
  logAtividade('Agendamento criado (calendário)', `${paciente.nome} — ${data} ${horario}`);
  showToast('Agendamento salvo!');
  // Botão Google Agenda
  mostrarBotaoGoogleAgenda(novo.nome, novo.data, novo.horario, novo.procedimento, novo.prof_nome, novo.obs);
}

// ══════════════════════════════════════════════════════
// CONTAS A RECEBER (painel global)
// ══════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════
// COMISSÕES POR PROFISSIONAL
// ══════════════════════════════════════════════════════
function toggleComissoes(){
  const panel = document.getElementById('comissoes-panel');
  if(!panel) return;
  if(panel.style.display!=='none'){ panel.style.display='none'; return; }
  if(!_finVerificado){ pedirFinPinFaturamento().then(ok=>{ if(ok) toggleComissoes(); }); return; }
  renderComissoes();
  panel.style.display='';
}

function renderComissoes(){
  const panel = document.getElementById('comissoes-panel');
  if(!panel) return;
  if(!cfg.comissoes) cfg.comissoes = {};
  const fin = _filtrarVendasPorPeriodo(vendas.filter(v=>v.status==='finalizada'), 'venda-mes','venda-ano');
  const _periodo = _labelPeriodo('venda-mes','venda-ano');
  // Agrupa produção por profissional
  const porProf = {};
  let semProf = 0;
  fin.forEach(v=>{
    const pid = v.profissional_id;
    if(!pid){ semProf += (v.total||0); return; }
    if(!porProf[pid]) porProf[pid] = { nome: v.profissional_nome||profissionais.find(p=>p.id==pid)?.nome||'—', total:0, qtd:0 };
    porProf[pid].total += (v.total||0);
    porProf[pid].qtd++;
  });
  // Inclui profissionais cadastrados mesmo sem produção no período
  profissionais.forEach(pr=>{ if(!porProf[pr.id]) porProf[pr.id]={nome:pr.nome,total:0,qtd:0}; });
  const rows = Object.entries(porProf).sort((a,b)=>b[1].total-a[1].total);
  let totalComissoes = 0;
  const linhas = rows.map(([pid,d])=>{
    const pct = Number(cfg.comissoes[pid])||0;
    const val = d.total*pct/100;
    totalComissoes += val;
    return `<div class="comissao-row">
      <span class="comissao-cell" data-label="Profissional" style="font-weight:600;">${escapeHtml(d.nome)}</span>
      <span class="comissao-cell" data-label="Vendas" style="color:var(--rose-text);">${d.qtd} venda(s)</span>
      <span class="comissao-cell" data-label="Produção" style="font-weight:700;">${fmtBRL(d.total)}</span>
      <span class="comissao-cell" data-label="% comissão"><input type="number" min="0" max="100" step="0.5" value="${pct}" onchange="setComissaoPct(${pid},this.value)" class="comissao-pct-input" title="% de comissão"/></span>
      <span class="comissao-cell" data-label="Comissão" style="font-weight:800;color:#2e7d32;">${fmtBRL(val)}</span>
    </div>`;
  }).join('');
  panel.innerHTML = `
    <div style="border:1.5px solid var(--rose-light);border-radius:14px;overflow:hidden;background:#fff;">
      <div style="background:var(--rose-lighter);padding:16px;border-bottom:1px solid var(--rose-light);display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
        <div style="font-size:14px;font-weight:800;color:var(--rose-dark);"><i class="ti ti-percentage"></i> Comissões — ${_periodo}</div>
        <div style="font-size:13px;color:var(--rose-text);">Total em comissões: <strong style="color:#2e7d32;font-size:15px;">${fmtBRL(totalComissoes)}</strong></div>
      </div>
      <div class="comissao-header-row">
        <span>Profissional</span><span style="text-align:center;">Vendas</span><span style="text-align:right;">Produção</span><span style="text-align:center;">%</span><span style="text-align:right;">Comissão</span>
      </div>
      <div style="max-height:320px;overflow-y:auto;">${linhas||'<div style="padding:20px;text-align:center;color:var(--rose-text);font-size:13px;">Nenhum profissional cadastrado.</div>'}</div>
      ${semProf>0?`<div style="padding:10px 16px;font-size:11px;color:var(--rose-text);background:#fffde7;border-top:1px solid #ffe082;"><i class="ti ti-info-circle"></i> ${fmtBRL(semProf)} em vendas do período sem profissional vinculado (não entram na comissão). Nas próximas finalizações, selecione quem atendeu.</div>`:''}
      <div style="padding:8px 16px;font-size:11px;color:var(--rose-text);border-top:1px solid var(--rose-light);">O período segue os filtros de mês/ano da lista de vendas acima. A % fica salva por profissional.</div>
    </div>`;
}

async function setComissaoPct(profId, val){
  if(!cfg.comissoes) cfg.comissoes = {};
  cfg.comissoes[profId] = Math.min(100, Math.max(0, parseFloat(val)||0));
  const _eCom = await saveFinanceiro();
  if(_eCom){ showToast('Erro ao salvar comissão: '+_eCom.message,'error'); return; }
  renderComissoes();
  showToast('Comissão salva.');
}

function toggleContasReceber(){
  const panel = document.getElementById('contas-receber-panel');
  if(!panel) return;
  if(panel.style.display!=='none'){ panel.style.display='none'; return; }
  const _vPago = vendaValorPago;
  const pendentes = vendas.filter(v=>v.status==='finalizada'&&_vPago(v)<(v.total||0));
  const totalDevedor = pendentes.reduce((a,v)=>a+((v.total||0)-_vPago(v)),0);
  const totalGeral = pendentes.reduce((a,v)=>a+(v.total||0),0);
  const totalPago = pendentes.reduce((a,v)=>a+_vPago(v),0);
  const porPac = {};
  pendentes.forEach(v=>{
    const k = v.pacienteId||0;
    if(!porPac[k]) porPac[k]={nome:v.pacienteNome||'—',pacId:k,total:0,pago:0,vendas:[]};
    porPac[k].total+=(v.total||0); porPac[k].pago+=_vPago(v); porPac[k].vendas.push(v);
  });
  const lista = Object.values(porPac).sort((a,b)=>(b.total-b.pago)-(a.total-a.pago));
  let html = `
    <div style="border:1.5px solid var(--rose-light);border-radius:14px;overflow:hidden;background:#fff;">
      <div style="background:var(--rose-lighter);padding:16px;border-bottom:1px solid var(--rose-light);">
        <div style="font-size:14px;font-weight:800;color:var(--rose-dark);margin-bottom:10px;"><i class="ti ti-report-money"></i> Contas a receber</div>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;">
          <div style="text-align:center;"><div style="font-size:11px;color:var(--rose-text);">Total</div><div style="font-size:18px;font-weight:800;color:var(--rose-dark);">${fmtBRL(totalGeral)}</div></div>
          <div style="text-align:center;"><div style="font-size:11px;color:var(--rose-text);">Recebido</div><div style="font-size:18px;font-weight:800;color:#2e7d32;">${fmtBRL(totalPago)}</div></div>
          <div style="text-align:center;"><div style="font-size:11px;color:var(--rose-text);">A receber</div><div style="font-size:18px;font-weight:800;color:#dc2626;">${fmtBRL(totalDevedor)}</div></div>
        </div>
      </div>
      <div style="max-height:400px;overflow-y:auto;">`;
  if(!lista.length){
    html+='<div style="padding:24px;text-align:center;color:var(--rose-text);font-size:13px;"><i class="ti ti-circle-check" style="font-size:28px;display:block;margin-bottom:6px;color:#2e7d32;"></i>Sem contas pendentes.</div>';
  } else {
    const _hjCR = new Date().toISOString().slice(0,10);
    lista.forEach(p=>{
      const saldo = p.total-p.pago;
      const pac = pacientes.find(x=>x.id===p.pacId);
      const vencidas = p.vendas.filter(v=>v.vencimento && v.vencimento < _hjCR);
      const proxVenc = p.vendas.map(v=>v.vencimento).filter(Boolean).sort()[0];
      html+=`<div style="padding:12px 16px;border-bottom:1px solid var(--rose-light);${vencidas.length?'background:#fff8f8;':''}">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
          <div style="font-weight:700;color:#3a2020;font-size:13px;cursor:pointer;" onclick="switchTab('pacientes');setTimeout(()=>selectPatient(${p.pacId}),200);setTimeout(()=>renderPatientDetail('financeiro'),400);">${escapeHtml(pac?.nome||p.nome)} ${vencidas.length?'<span class="fin-badge danger" style="font-size:9px;margin-left:4px;">VENCIDO</span>':''} <i class="ti ti-chevron-right" style="font-size:10px;opacity:.4;"></i></div>
          <span style="font-weight:800;color:#dc2626;font-size:14px;">${fmtBRL(saldo)}</span>
        </div>
        <div style="display:flex;gap:16px;font-size:11px;color:var(--rose-text);flex-wrap:wrap;">
          <span>Total: ${fmtBRL(p.total)}</span>
          <span>Pago: ${fmtBRL(p.pago)}</span>
          <span>${p.vendas.length} venda(s)</span>
          ${proxVenc?`<span style="${proxVenc<_hjCR?'color:#dc2626;font-weight:700;':''}">Vencimento: ${new Date(proxVenc+'T12:00:00').toLocaleDateString('pt-BR')}</span>`:''}
        </div>
      </div>`;
    });
  }
  html+='</div></div>';
  panel.innerHTML=html; panel.style.display='';
}

// ══════════════════════════════════════════════════════
// GALERIA DE FOTOS / RADIOGRAFIAS
// ══════════════════════════════════════════════════════
let _galeriaFotos = [];
let _galeriaFiltro = 'todos';
let _galeriaLbIdx = 0;
let _galeriaPacId = null;

const GALERIA_BUCKET = 'galeria';

async function _galeriaEnsureBucket(){ return true; }

// ── TIMELINE DO PACIENTE ──
function renderTimeline(pacId){
  const container = document.getElementById('pac-timeline-body');
  if(!container) return;
  const p = pacientes.find(pt=>pt.id===pacId);
  if(!p){ container.innerHTML=''; return; }
  const events = [];
  events.push({date:p.created_at||'',type:'cadastro',icon:'ti-user-plus',color:'#7b1fa2',title:'Cadastro do paciente',detail:''});
  if(p.anamnese && Object.keys(p.anamnese).length>0){
    events.push({date:p.updated_at||p.created_at||'',type:'anamnese',icon:'ti-clipboard-heart',color:'#2e7d32',title:'Anamnese preenchida',detail:p.anamnese.queixa?'Queixa: '+p.anamnese.queixa.slice(0,80):''});
  }
  if(p._anamneseLink){
    events.push({date:p._anamneseLink.created_at||'',type:'link',icon:'ti-send',color:'#1e40af',title:'Link de anamnese enviado',detail:p._anamneseLink.used_at?'Preenchido pelo paciente':'Aguardando preenchimento'});
  }
  agendamentos.filter(a=>a.paciente_id===pacId).forEach(a=>{
    const st = (agGetStatus(a)||'').toLowerCase();
    const stLabel = st==='compareceu'?'Compareceu':st==='faltou'?'Faltou':st==='confirmado'?'Confirmado':st==='cancelado'?'Cancelado':st==='remarcado'?'Remarcado':'Agendado';
    const stColor = st==='compareceu'?'#2e7d32':st==='faltou'?'#dc2626':st==='confirmado'?'#1e40af':'#e08a20';
    events.push({date:a.data+'T'+(a.horario||'00:00'),type:'agendamento',icon:'ti-calendar',color:stColor,title:`Consulta: ${a.procedimento||'Geral'}`,detail:`${a.prof_nome||''} — ${stLabel}`});
  });
  vendas.filter(v=>v.pacienteId===pacId).forEach(v=>{
    const desc = (v.itens||[]).map(i=>i.nome).filter(Boolean).join(', ')||'Venda';
    if(v.status==='orcamento'){
      const stResp = v.statusResposta==='aprovado_pac'?'Aprovado':v.statusResposta==='recusado'?'Recusado':v.statusResposta==='pensando'?'Pensando':'Aguardando';
      events.push({date:v.data||'',type:'orcamento',icon:'ti-receipt',color:'#e08a20',title:'Orçamento: '+desc.slice(0,60),detail:`${fmtBRL(v.total||0)} — ${stResp}`});
    } else if(v.status==='finalizada'){
      events.push({date:v.dataFinal||v.data||'',type:'venda',icon:'ti-cash',color:'#2e7d32',title:'Venda: '+desc.slice(0,60),detail:fmtBRL(v.total||0)});
      (v.pagamentos||[]).forEach(pg=>{
        events.push({date:pg.data||v.dataFinal||v.data||'',type:'pagamento',icon:'ti-coin',color:'#1565c0',title:'Pagamento recebido',detail:`${fmtBRL(pg.valor)} — ${pg.forma==='pix'?'PIX':pg.forma==='credito'?'Cartão':pg.forma==='debito'?'Débito':'Dinheiro'}`});
      });
    }
  });
  (p.prontuarios||[]).forEach(pr=>{
    events.push({date:pr.data||pr.created_at||'',type:'prontuario',icon:'ti-stethoscope',color:'#d4735a',title:pr.procedimento||'Procedimento',detail:`${pr.prof_nome||''} ${pr.dente?'Dente '+pr.dente:''}`});
  });
  events.sort((a,b)=>new Date(b.date||0)-new Date(a.date||0));
  if(!events.length){
    container.innerHTML='<div style="text-align:center;color:var(--rose-text);padding:30px;font-size:13px;">Nenhum evento registrado.</div>';
    return;
  }
  let lastMonth='';
  let html='<div style="position:relative;padding-left:28px;">';
  html+='<div style="position:absolute;left:10px;top:0;bottom:0;width:2px;background:var(--rose-light);"></div>';
  events.forEach(ev=>{
    const dt = ev.date ? new Date(ev.date) : null;
    const month = dt ? dt.toLocaleDateString('pt-BR',{month:'long',year:'numeric'}) : '';
    if(month && month!==lastMonth){
      lastMonth=month;
      html+=`<div style="font-size:11px;font-weight:700;color:var(--rose);text-transform:uppercase;letter-spacing:.5px;margin:16px 0 8px -28px;padding-left:28px;">${month}</div>`;
    }
    const dtFmt = dt ? dt.toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit'})+(dt.getHours()?` ${dt.toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'})}`:'') : '—';
    html+=`<div style="position:relative;margin-bottom:12px;padding:10px 14px;background:#fff;border:1px solid var(--rose-light);border-radius:10px;">
      <div style="position:absolute;left:-23px;top:12px;width:12px;height:12px;border-radius:50%;background:${ev.color};border:2px solid #fff;box-shadow:0 0 0 1px var(--rose-light);"></div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:2px;">
        <span style="font-size:13px;font-weight:700;color:${ev.color};display:flex;align-items:center;gap:6px;"><i class="ti ${ev.icon}" style="font-size:14px;"></i> ${escapeHtml(ev.title)}</span>
        <span style="font-size:11px;color:var(--rose-text);white-space:nowrap;margin-left:8px;">${dtFmt}</span>
      </div>
      ${ev.detail?`<div style="font-size:12px;color:var(--rose-text);margin-top:2px;">${escapeHtml(ev.detail)}</div>`:''}
    </div>`;
  });
  html+='</div>';
  container.innerHTML=html;
}

// ── FINANCEIRO PACIENTE ──
// Reads from vendas (finalized sales with outstanding balance)

function pagPacRender(pacId){
  const container = document.getElementById('pac-fin-container');
  if(!container) return;

  const formaIcon = f => f==='pix'?'ti-brand-cashapp':f==='credito'?'ti-credit-card':f==='debito'?'ti-credit-card':'ti-cash';
  const formaClass = f => f==='pix'?'pix':(f==='credito'||f==='debito')?'cartao':'dinheiro';
  const formaLabel = f => f==='pix'?'PIX':f==='credito'?'Cartão Crédito':f==='debito'?'Cartão Débito':'Dinheiro';

  const finVendas = vendas.filter(v=>v.pacienteId===pacId && v.status==='finalizada');
  const _vendaPago = vendaValorPago;
  const pendentes = finVendas.filter(v=> _vendaPago(v) < (v.total||0));
  const quitadas = finVendas.filter(v=> _vendaPago(v) >= (v.total||0));

  const totalGeral = finVendas.reduce((a,v)=>a+(v.total||0),0);
  const pagoGeral = finVendas.reduce((a,v)=>a+_vendaPago(v),0);
  const saldoGeral = totalGeral - pagoGeral;

  const vendaDesc = v => (v.itens||[]).map(i=>i.nome||'Procedimento').join(', ') || 'Venda #'+v.id;

  const renderVendaCard = (v) => {
    const pago = _vendaPago(v);
    const saldo = (v.total||0) - pago;
    const isQuitado = saldo <= 0;
    return `<div class="fin-pac-cob">
      <div class="fin-pac-cob-head">
        <div>
          <div class="fin-pac-cob-titulo"><i class="ti ti-tooth"></i> ${escapeHtml(vendaDesc(v))}</div>
          <div style="font-size:11px;color:var(--rose-text);margin-top:2px;">${new Date(v.dataFinal||v.data||'').toLocaleDateString('pt-BR')}</div>
        </div>
        <div style="display:flex;gap:6px;align-items:center;">
          <span class="fin-pac-badge ${isQuitado?'quitado':'aberto'}">${isQuitado?'Quitado':'Em aberto'}</span>
          <button style="border:none;background:none;cursor:pointer;color:#ccc;font-size:16px;" onclick="pagPacDelVenda(${v.id},${pacId})" title="Excluir"><i class="ti ti-trash"></i></button>
        </div>
      </div>
      <div class="fin-pac-valores">
        <div><strong>Total</strong>${fmtBRL(v.total||0)}</div>
        <div><strong>Pago</strong>${fmtBRL(pago)}</div>
        <div><strong>Saldo</strong><span style="color:${saldo>0?'#dc2626':'#2e7d32'};font-weight:700;">${fmtBRL(Math.max(0,saldo))}</span></div>
      </div>
      ${(v.pagamentos||[]).length?`<div style="margin-bottom:8px;">
        <div style="font-size:10px;font-weight:700;color:var(--rose-text);text-transform:uppercase;margin-bottom:6px;">Pagamentos</div>
        ${(v.pagamentos||[]).map(pg=>`<div class="fin-pac-pag-item">
          <div class="pag-icon ${formaClass(pg.forma)}"><i class="ti ${formaIcon(pg.forma)}"></i></div>
          <div style="flex:1;">
            <div style="font-weight:600;">${fmtBRL(pg.valor)} <span style="font-weight:400;color:var(--rose-text);">— ${formaLabel(pg.forma)}${pg.parcelas_cartao>1?' '+pg.parcelas_cartao+'x':''}</span></div>
            <div style="font-size:11px;color:var(--rose-text);">${new Date(pg.data).toLocaleDateString('pt-BR')}${pg.obs?' — '+escapeHtml(pg.obs):''}</div>
          </div>
          <button class="pag-del" style="color:#1565c0;" onclick="gerarReciboPagamento(${v.id},${pg.id},${pacId})" title="Gerar recibo PDF"><i class="ti ti-file-download"></i></button>
          <button class="pag-del" onclick="pagPacDelPag(${v.id},${pg.id},${pacId})" title="Remover"><i class="ti ti-x"></i></button>
        </div>`).join('')}
      </div>`:''}
      ${saldo>0?`<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;font-size:12px;color:var(--rose-text);flex-wrap:wrap;">
        <span style="font-weight:700;"><i class="ti ti-calendar-due"></i> Vencimento:</span>
        <input type="date" value="${v.vencimento||''}" onchange="pagPacSetVenc(${v.id},this.value,${pacId})" style="padding:4px 8px;border:1px solid var(--rose-light);border-radius:8px;font-size:12px;"/>
        ${v.vencimento && v.vencimento < new Date().toISOString().slice(0,10) ? '<span class="fin-badge danger" style="font-size:10px;">VENCIDO</span>' : ''}
      </div>
      <button class="btn-secondary" style="width:100%;justify-content:center;" onclick="pagPacFormPag(${v.id},${pacId},${saldo})"><i class="ti ti-plus"></i> Registrar pagamento</button>
      <div id="pac-fin-form-pag-${v.id}"></div>`:''}
    </div>`;
  };

  const showQuitadas = quitadas.length > 0;

  container.innerHTML = `
    <div class="fin-pac-resumo">
      <div class="fin-pac-resumo-item"><div class="val">${fmtBRL(totalGeral)}</div><div class="lbl">Total</div></div>
      <div class="fin-pac-resumo-item positivo"><div class="val">${fmtBRL(pagoGeral)}</div><div class="lbl">Pago</div></div>
      <div class="fin-pac-resumo-item ${saldoGeral>0?'negativo':'positivo'}"><div class="val">${fmtBRL(saldoGeral)}</div><div class="lbl">Saldo devedor</div></div>
    </div>
    ${pendentes.length>0?`
      <div style="font-size:13px;font-weight:700;color:var(--rose-dark);margin-bottom:10px;"><i class="ti ti-alert-circle" style="color:#e65100;"></i> Pendentes (${pendentes.length})</div>
      ${pendentes.sort((a,b)=>(b.dataFinal||b.data||'').localeCompare(a.dataFinal||a.data||'')).map(renderVendaCard).join('')}
    `:`
      <div style="text-align:center;padding:30px;color:var(--rose-text);font-size:13px;">
        <i class="ti ti-circle-check" style="font-size:32px;display:block;margin-bottom:8px;color:#2e7d32;opacity:.7;"></i>
        Nenhum pagamento pendente.
      </div>
    `}
    ${showQuitadas?`
      <details style="margin-top:14px;">
        <summary style="font-size:13px;font-weight:700;color:var(--rose-dark);cursor:pointer;margin-bottom:10px;"><i class="ti ti-circle-check" style="color:#2e7d32;"></i> Quitados (${quitadas.length})</summary>
        ${quitadas.sort((a,b)=>(b.dataFinal||b.data||'').localeCompare(a.dataFinal||a.data||'')).map(renderVendaCard).join('')}
      </details>
    `:''}`;
}

async function pagPacSetVenc(vendaId, val, pacId){
  const v = vendas.find(x=>x.id===vendaId); if(!v) return;
  v.vencimento = val || null;
  const _eVc = await saveFinanceiro();
  if(_eVc){ showToast('Erro ao salvar vencimento: '+_eVc.message,'error'); return; }
  pagPacRender(pacId);
  showToast(val ? 'Vencimento salvo.' : 'Vencimento removido.');
}

function pagPacFormPag(vendaId, pacId, saldoRestante){
  const f = document.getElementById('pac-fin-form-pag-'+vendaId);
  if(!f) return;
  if(f.innerHTML.trim()){ f.innerHTML=''; return; }
  f.innerHTML = `<div class="fin-pac-form" style="margin-top:10px;">
    <div class="form-grid">
      <div>
        <label>Valor (R$)</label>
        <input type="number" id="fpp-valor-${vendaId}" step="0.01" min="0" value="${saldoRestante.toFixed(2)}" placeholder="0,00"/>
      </div>
      <div>
        <label>Forma de pagamento</label>
        <select id="fpp-forma-${vendaId}" onchange="document.getElementById('fpp-parc-wrap-${vendaId}').style.display=this.value==='credito'?'':'none'">
          <option value="dinheiro">Dinheiro</option>
          <option value="pix">PIX</option>
          <option value="credito">Cartão Crédito</option>
          <option value="debito">Cartão Débito</option>
        </select>
      </div>
      <div id="fpp-parc-wrap-${vendaId}" style="display:none;">
        <label>Parcelas no cartão</label>
        <select id="fpp-parc-${vendaId}">
          ${Array.from({length:12},(_,i)=>`<option value="${i+1}">${i+1}x</option>`).join('')}
        </select>
      </div>
      <div>
        <label>Data</label>
        <input type="date" id="fpp-data-${vendaId}" value="${new Date().toISOString().slice(0,10)}"/>
      </div>
      <div style="grid-column:1/-1;">
        <label>Observação</label>
        <input type="text" id="fpp-obs-${vendaId}" placeholder="Ex: Restante parcelado"/>
      </div>
    </div>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px;">
      <button class="btn-secondary" onclick="document.getElementById('pac-fin-form-pag-${vendaId}').innerHTML=''">Cancelar</button>
      <button class="btn-primary" onclick="pagPacAddPag(${vendaId},${pacId})"><i class="ti ti-check"></i> Confirmar</button>
    </div>
  </div>`;
}

async function pagPacAddPag(vendaId, pacId){
  const v = vendas.find(x=>x.id===vendaId);
  if(!v) return;
  const valor = parseFloat(document.getElementById('fpp-valor-'+vendaId)?.value)||0;
  const forma = document.getElementById('fpp-forma-'+vendaId)?.value||'dinheiro';
  const parcelas = parseInt(document.getElementById('fpp-parc-'+vendaId)?.value)||1;
  const data = document.getElementById('fpp-data-'+vendaId)?.value||new Date().toISOString().slice(0,10);
  const obs = document.getElementById('fpp-obs-'+vendaId)?.value.trim()||'';
  if(valor<=0){ showToast('Informe o valor.','error'); return; }

  v.pagamentos = v.pagamentos||[];
  const _newPag = {
    id: Date.now(),
    valor,
    forma,
    parcelas_cartao: forma==='credito'?parcelas:1,
    data: new Date(data+'T12:00:00').toISOString(),
    obs
  };
  v.pagamentos.push(_newPag);

  showLoading(true); const _ePagR=await saveFinanceiro(); showLoading(false);
  if(!_ePagR) showToast('Pagamento registrado!');
  else{ v.pagamentos=v.pagamentos.filter(p=>p!==_newPag); showToast('Erro ao registrar pagamento: '+_ePagR.message,'error'); return; }
  pagPacRender(pacId);
}

async function pagPacDelPag(vendaId, pagId, pacId){
  if(!confirm('Remover este pagamento?')) return;
  const v = vendas.find(x=>x.id===vendaId);
  if(!v) return;
  v.pagamentos = (v.pagamentos||[]).filter(p=>p.id!==pagId);
  showLoading(true); const _ePagD=await saveFinanceiro(); showLoading(false);
  if(!_ePagD) showToast('Pagamento removido.');
  else{ showToast('Erro ao remover pagamento: '+_ePagD.message,'error'); return; }
  pagPacRender(pacId);
}

async function pagPacDelVenda(vendaId, pacId){
  if(!confirm('Excluir esta venda e todos os pagamentos registrados?')) return;
  vendas = vendas.filter(x=>x.id!==vendaId);
  showLoading(true); const _eVDel=await saveFinanceiro(); showLoading(false);
  if(!_eVDel) showToast('Venda excluída.');
  else{ showToast('Erro ao excluir venda: '+_eVDel.message,'error'); return; }
  pagPacRender(pacId);
}

function _galeriaPath(pacId, filename){
  return `${clinicaId}/${pacId}/${filename}`;
}

async function galeriaCarregar(pacId){
  _galeriaPacId = pacId;
  const grid = document.getElementById('galeria-grid');
  if(!grid) return;
  grid.innerHTML = '<div class="galeria-vazia"><div class="spinner"></div>Carregando...</div>';

  const ok = await _galeriaEnsureBucket();
  if(!ok){ grid.innerHTML='<div class="galeria-vazia"><i class="ti ti-alert-triangle"></i>Não foi possível acessar o storage.</div>'; return; }

  const { data: files, error: err2 } = await _sb.storage.from(GALERIA_BUCKET).list(`${clinicaId}/${pacId}`, {
    limit: 200,
    sortBy: { column: 'created_at', order: 'desc' }
  });

  if(err2){ grid.innerHTML=`<div class="galeria-vazia"><i class="ti ti-alert-triangle"></i>${escapeHtml(err2.message)}</div>`; return; }

  const validFiles = (files||[]).filter(f=>f.name && !f.name.endsWith('/'));
  const paths = validFiles.map(f=>`${clinicaId}/${pacId}/${f.name}`);
  // Bucket é privado (fotos/radiografias são dado sensível de saúde) — URL
  // assinada com expiração de 1h em vez de getPublicUrl(), que exigiria o
  // bucket público e deixaria qualquer arquivo acessível por quem tivesse o link.
  const { data: signedUrls, error: errSigned } = paths.length
    ? await _sb.storage.from(GALERIA_BUCKET).createSignedUrls(paths, 3600)
    : { data: [], error: null };
  if(errSigned){ grid.innerHTML=`<div class="galeria-vazia"><i class="ti ti-alert-triangle"></i>${escapeHtml(errSigned.message)}</div>`; return; }

  _galeriaFotos = validFiles.map((f,i)=>{
    const parts = f.name.split('__');
    const cat = parts.length>=2 ? parts[0] : 'foto';
    return {
      name: f.name,
      categoria: cat,
      url: signedUrls[i]?.signedUrl || '',
      created: f.created_at || f.updated_at || '',
      size: f.metadata?.size || 0
    };
  });

  _galeriaRenderGrid();
}

function _galeriaRenderGrid(){
  const grid = document.getElementById('galeria-grid');
  if(!grid) return;
  const lista = _galeriaFiltro==='todos' ? _galeriaFotos : _galeriaFotos.filter(f=>f.categoria===_galeriaFiltro);
  if(!lista.length){
    grid.innerHTML = `<div class="galeria-vazia" style="grid-column:1/-1;"><i class="ti ti-photo-off"></i>${_galeriaFotos.length ? 'Nenhuma imagem nesta categoria.' : 'Nenhuma imagem ainda.<br>Toque acima para adicionar.'}</div>`;
    return;
  }
  const catLabel = {foto:'Foto',radiografia:'RX',antes_depois:'A/D'};
  grid.innerHTML = lista.map((f,i)=>{
    const dt = f.created ? new Date(f.created).toLocaleDateString('pt-BR') : '';
    return `<div class="galeria-item" onclick="galeriaLbOpen(${i})">
      <img src="${f.url}" alt="" loading="lazy"/>
      <span class="galeria-tag">${catLabel[f.categoria]||f.categoria}</span>
      <button class="galeria-del" onclick="event.stopPropagation();galeriaDel('${escapeHtml(f.name)}')" title="Excluir"><i class="ti ti-trash"></i></button>
      ${dt?`<span class="galeria-data">${dt}</span>`:''}
    </div>`;
  }).join('');
}

function galeriaFiltrar(cat, btn){
  _galeriaFiltro = cat;
  document.querySelectorAll('.galeria-filtro').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  _galeriaRenderGrid();
}

async function galeriaUpload(fileList, pacId){
  if(!fileList || !fileList.length) return;

  const ok = await _galeriaEnsureBucket();
  if(!ok) return;

  const cats = ['foto','radiografia','antes_depois'];
  const catLabels = ['Foto clínica','Radiografia','Antes/Depois'];
  const cat = await new Promise(resolve=>{
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.style.cssText = 'display:flex;align-items:center;justify-content:center;padding:20px;';
    modal.innerHTML = `<div class="modal-box" style="max-width:340px;padding:24px;">
      <h3 style="font-size:15px;font-weight:800;color:var(--rose-dark);margin-bottom:16px;"><i class="ti ti-tag"></i> Categoria das imagens</h3>
      ${cats.map((c,i)=>`<button class="btn-secondary" style="width:100%;margin-bottom:8px;text-align:left;padding:12px 16px;" onclick="this.closest('.modal-overlay')._resolve('${c}');this.closest('.modal-overlay').remove()"><i class="ti ti-${c==='foto'?'camera':c==='radiografia'?'bone':'arrows-exchange'}"></i> ${catLabels[i]}</button>`).join('')}
      <button class="btn-secondary" style="width:100%;margin-top:4px;color:#999;" onclick="this.closest('.modal-overlay')._resolve(null);this.closest('.modal-overlay').remove()">Cancelar</button>
    </div>`;
    modal._resolve = resolve;
    document.body.appendChild(modal);
  });

  if(!cat) return;

  showLoading(true);
  let uploaded = 0;
  for(const file of fileList){
    if(!file.type.startsWith('image/')){ continue; }
    if(file.size > 10*1024*1024){ showToast(`${file.name} excede 10 MB.`,'error'); continue; }

    try {
      const compressed = await _galeriaCompress(file, 1600);
      const ts = Date.now();
      const extRaw = file.name.split('.').pop().toLowerCase().replace(/[^a-z0-9]/g,'');
      const ext = extRaw || 'jpg';
      const fname = `${cat}__${ts}_${Math.random().toString(36).slice(2,6)}.${ext}`;
      const path = _galeriaPath(pacId, fname);

      const { error } = await _sb.storage.from(GALERIA_BUCKET).upload(path, compressed, {
        contentType: compressed.type || 'image/jpeg',
        upsert: false
      });
      if(error){ showToast('Erro upload: '+error.message,'error'); }
      else { uploaded++; }
    } catch(e){ showToast('Erro: '+e.message,'error'); }
  }
  showLoading(false);
  if(uploaded){ showToast(`${uploaded} imagen${uploaded>1?'s':''} adicionada${uploaded>1?'s':''}!`); }
  document.getElementById('galeria-input').value = '';
  galeriaCarregar(pacId);
}

function _galeriaCompress(file, maxDim){
  return new Promise((resolve)=>{
    if(file.size < 500*1024){ resolve(file); return; }
    const img = new Image();
    const url = URL.createObjectURL(file);
    const timeout = setTimeout(()=>{ URL.revokeObjectURL(url); resolve(file); }, 30000);
    img.onload = ()=>{
      clearTimeout(timeout);
      URL.revokeObjectURL(url);
      let w=img.width, h=img.height;
      if(w>maxDim || h>maxDim){
        const r = Math.min(maxDim/w, maxDim/h);
        w=Math.round(w*r); h=Math.round(h*r);
      }
      const c=document.createElement('canvas');
      c.width=w; c.height=h;
      c.getContext('2d').drawImage(img,0,0,w,h);
      c.toBlob(blob=>{ resolve(blob||file); },'image/jpeg',0.82);
    };
    img.onerror = ()=>{ clearTimeout(timeout); URL.revokeObjectURL(url); resolve(file); };
    img.src = url;
  });
}

async function galeriaDel(filename){
  if(!confirm('Excluir esta imagem?')) return;
  const path = _galeriaPath(_galeriaPacId, filename);
  showLoading(true);
  const { error } = await _sb.storage.from(GALERIA_BUCKET).remove([path]);
  showLoading(false);
  if(error){ showToast('Erro ao excluir: '+error.message,'error'); return; }
  showToast('Imagem excluída.');
  galeriaCarregar(_galeriaPacId);
}

function galeriaLbOpen(idx){
  const lista = _galeriaFiltro==='todos' ? _galeriaFotos : _galeriaFotos.filter(f=>f.categoria===_galeriaFiltro);
  if(!lista[idx]) return;
  _galeriaLbIdx = idx;
  const lb = document.getElementById('galeria-lightbox');
  document.getElementById('galeria-lb-img').src = lista[idx].url;
  const catLabel = {foto:'Foto clínica',radiografia:'Radiografia',antes_depois:'Antes/Depois'};
  const dt = lista[idx].created ? new Date(lista[idx].created).toLocaleDateString('pt-BR') : '';
  document.getElementById('galeria-lb-info').textContent = (catLabel[lista[idx].categoria]||'') + (dt?' · '+dt:'');
  lb.classList.add('open');
}

function galeriaLbClose(){
  document.getElementById('galeria-lightbox').classList.remove('open');
}

function galeriaLbNav(dir){
  const lista = _galeriaFiltro==='todos' ? _galeriaFotos : _galeriaFotos.filter(f=>f.categoria===_galeriaFiltro);
  _galeriaLbIdx = (_galeriaLbIdx + dir + lista.length) % lista.length;
  if(!lista[_galeriaLbIdx]) return;
  document.getElementById('galeria-lb-img').src = lista[_galeriaLbIdx].url;
  const catLabel = {foto:'Foto clínica',radiografia:'Radiografia',antes_depois:'Antes/Depois'};
  const dt = lista[_galeriaLbIdx].created ? new Date(lista[_galeriaLbIdx].created).toLocaleDateString('pt-BR') : '';
  document.getElementById('galeria-lb-info').textContent = (catLabel[lista[_galeriaLbIdx].categoria]||'') + (dt?' · '+dt:'');
}

document.addEventListener('keydown', e=>{
  if(!document.getElementById('galeria-lightbox')?.classList.contains('open')) return;
  if(e.key==='Escape') galeriaLbClose();
  if(e.key==='ArrowLeft') galeriaLbNav(-1);
  if(e.key==='ArrowRight') galeriaLbNav(1);
});
