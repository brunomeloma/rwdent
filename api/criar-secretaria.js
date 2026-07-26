const { createClient } = require('@supabase/supabase-js');

// Gestão do login da secretária. Só o DONO de uma clínica aprovada pode usar.
// Criar/remover usuário no Supabase Auth exige a service role, então isso vive
// aqui no servidor — mesmo padrão de api/admin-reset-demo-password.js.
//
// A clínica é SEMPRE a do dono autenticado (achada pelo user_id do token),
// nunca um id vindo do corpo da requisição — então não dá pra cadastrar
// secretária em clínica alheia.
//
// Ações:
//   { action:'listar' }                       -> lista as secretárias da clínica
//   { action:'criar', email, senha }          -> cria login e vincula como secretária
//   { action:'remover', userId }              -> desvincula (e desativa o login)

// Remove a "clínica fantasma" que o gatilho handle_new_user cria pra todo
// usuário novo. A secretária não deve ter clínica própria — ela usa a clínica
// do dono. Deleta SÓ clínicas do PRÓPRIO userId (a clínica real é do dono, com
// outro user_id, então nunca é tocada), junto do financeiro_config delas.
// Best-effort: falha aqui não quebra o fluxo (o login já funciona pelo vínculo).
async function limparClinicaFantasma(sbAdmin, userId) {
  try {
    const { data: fantasmas } = await sbAdmin
      .from('clinicas').select('id').eq('user_id', userId);
    for (const c of (fantasmas || [])) {
      try { await sbAdmin.from('financeiro_config').delete().eq('clinica_id', c.id); } catch (e) {}
      try { await sbAdmin.from('clinicas').delete().eq('id', c.id); } catch (e) {}
    }
  } catch (e) { console.error('[criar-secretaria] limparClinicaFantasma:', e.message); }
}

// Acha um usuário do Auth pelo e-mail (o Auth guarda o e-mail, não a senha).
// Percorre as páginas do listUsers — suficiente pra base pequena/média.
async function acharUsuarioPorEmail(sbAdmin, email) {
  const alvo = String(email || '').toLowerCase();
  for (let page = 1; page <= 30; page++) {
    let data;
    try { ({ data } = await sbAdmin.auth.admin.listUsers({ page, perPage: 200 })); }
    catch (e) { break; }
    const users = (data && data.users) || [];
    const achado = users.find(u => (u.email || '').toLowerCase() === alvo);
    if (achado) return achado;
    if (users.length < 200) break; // última página
  }
  return null;
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido.' });

  const cleanStr = s => String(s || '').replace(/[^\x20-\x7E]/g, '').trim();
  const supabaseUrl    = cleanStr(process.env.SUPABASE_URL);
  const supabaseAnon   = cleanStr(process.env.SUPABASE_ANON_KEY);
  const serviceRoleKey = cleanStr(process.env.SUPABASE_SERVICE_ROLE_KEY);

  if (!supabaseUrl || !supabaseAnon || !serviceRoleKey) {
    return res.status(500).json({ error: 'Servidor sem SUPABASE_SERVICE_ROLE_KEY configurada.' });
  }

  const authHeader  = req.headers['authorization'] || '';
  const accessToken = cleanStr(authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '');
  if (!accessToken) return res.status(401).json({ error: 'Faça login.' });

  // 1) Valida o token do chamador (respeita RLS).
  const sbCaller = createClient(supabaseUrl, supabaseAnon, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } }
  });
  const { data: { user }, error: authErr } = await sbCaller.auth.getUser(accessToken);
  if (authErr || !user) return res.status(401).json({ error: 'Sessão inválida.' });

  // 2) Confirma que o chamador é DONO de uma clínica aprovada. clinicaId sai
  //    daqui — nunca do corpo — então a ação só afeta a clínica dele.
  const sbAdmin = createClient(supabaseUrl, serviceRoleKey);
  const { data: clinica, error: cliErr } = await sbAdmin
    .from('clinicas').select('id, status').eq('user_id', user.id).maybeSingle();
  if (cliErr) return res.status(500).json({ error: 'Erro ao buscar clínica: ' + cliErr.message });
  if (!clinica) return res.status(403).json({ error: 'Só o dono da clínica pode gerenciar secretárias.' });
  if (clinica.status !== 'aprovado') return res.status(403).json({ error: 'Clínica não está aprovada.' });

  // Defesa extra: quem é secretária (membro de alguma clínica) NUNCA gerencia
  // logins — nem que por algum motivo possua uma clínica-fantasma própria.
  const { data: souMembro } = await sbAdmin
    .from('clinica_membros').select('clinica_id').eq('user_id', user.id).maybeSingle();
  if (souMembro) return res.status(403).json({ error: 'Secretárias não podem gerenciar logins.' });

  const clinicaId = clinica.id;

  const { action, email, senha, userId } = req.body || {};

  // ── LISTAR ────────────────────────────────────────────────────────────────
  if (action === 'listar') {
    const { data: membros, error } = await sbAdmin
      .from('clinica_membros')
      .select('user_id, papel, created_at')
      .eq('clinica_id', clinicaId)
      .order('created_at', { ascending: true });
    if (error) return res.status(500).json({ error: 'Erro ao listar: ' + error.message });
    // Junta o e-mail de cada uma (via Auth admin).
    const lista = [];
    for (const m of (membros || [])) {
      let email = '';
      try {
        const { data: u } = await sbAdmin.auth.admin.getUserById(m.user_id);
        email = u?.user?.email || '';
      } catch (e) { /* mantém vazio */ }
      lista.push({ userId: m.user_id, email, papel: m.papel, criadoEm: m.created_at });
    }
    return res.status(200).json({ ok: true, secretarias: lista });
  }

  // ── CRIAR ───────────────────────────────────────────────────────────────
  if (action === 'criar') {
    const emailLimpo = cleanStr(email).toLowerCase();
    const senhaLimpa = String(senha || '');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(emailLimpo)) {
      return res.status(400).json({ error: 'E-mail inválido.' });
    }
    if (senhaLimpa.length < 6) {
      return res.status(400).json({ error: 'A senha deve ter no mínimo 6 caracteres.' });
    }

    // Cria o usuário no Auth com e-mail já confirmado (é a dona quem cadastra).
    const { data: novo, error: cErr } = await sbAdmin.auth.admin.createUser({
      email: emailLimpo,
      password: senhaLimpa,
      email_confirm: true
    });

    let novoId;
    if (cErr) {
      // E-mail já existe. Isso acontece porque remover uma secretária deixava o
      // login só desativado. Aqui a gente REAPROVEITA esse login — mas só se for
      // seguro (não pode "roubar" a conta de um dono ou de secretária de outra
      // clínica).
      if (/already|registered|exists|duplicate/i.test(cErr.message || '')) {
        const existente = await acharUsuarioPorEmail(sbAdmin, emailLimpo);
        if (!existente) {
          return res.status(400).json({ error: 'Já existe um login com esse e-mail e não consegui reaproveitar. Use outro e-mail.' });
        }
        const { data: dono } = await sbAdmin.from('clinicas').select('id').eq('user_id', existente.id).maybeSingle();
        const { data: vinculos } = await sbAdmin.from('clinica_membros').select('clinica_id').eq('user_id', existente.id);
        const membroDeOutra   = (vinculos || []).some(v => v.clinica_id !== clinicaId);
        // Se é dono de uma clínica REAL (não a fantasma vazia) ou secretária de
        // OUTRA clínica, não pode virar secretária aqui.
        if (membroDeOutra) {
          return res.status(400).json({ error: 'Esse e-mail já é secretária de outra clínica. Use um e-mail diferente.' });
        }
        if (dono) {
          // Pode ser só a clínica-fantasma vazia dela — se tiver dado, é conta real.
          const { count } = await sbAdmin.from('pacientes').select('id', { count: 'exact', head: true }).eq('clinica_id', dono.id);
          if (count && count > 0) {
            return res.status(400).json({ error: 'Esse e-mail já é dono de uma clínica com dados. Use um e-mail diferente.' });
          }
        }
        // Seguro reaproveitar. Em vez de tentar "desbanir" o login velho (que às
        // vezes continua bloqueado ou com e-mail não confirmado, e a pessoa não
        // consegue entrar), a gente APAGA o login travado e CRIA um novo limpo —
        // sem ban e com e-mail confirmado. Isso garante que o login funcione.
        // Limpa a clínica-fantasma ANTES, pra o delete do usuário não esbarrar
        // em chave estrangeira da tabela clinicas.
        await limparClinicaFantasma(sbAdmin, existente.id);
        try { await sbAdmin.auth.admin.deleteUser(existente.id); } catch (e) { /* segue */ }

        const { data: recriado, error: rErr } = await sbAdmin.auth.admin.createUser({
          email: emailLimpo, password: senhaLimpa, email_confirm: true
        });
        if (rErr || !recriado?.user?.id) {
          return res.status(500).json({ error: 'Não consegui recriar o login: ' + (rErr?.message || 'tente outro e-mail') });
        }
        novoId = recriado.user.id;
        const { error: mErr2 } = await sbAdmin.from('clinica_membros')
          .insert({ user_id: novoId, clinica_id: clinicaId, papel: 'secretaria' });
        if (mErr2) {
          try { await sbAdmin.auth.admin.deleteUser(novoId); } catch (e) {}
          return res.status(500).json({ error: 'Erro ao vincular secretária: ' + mErr2.message });
        }
        await limparClinicaFantasma(sbAdmin, novoId);
        console.log(`[criar-secretaria] clinica=${clinicaId} RECRIOU login=${emailLimpo} por ${user.email}`);
        return res.status(200).json({ ok: true, userId: novoId, email: emailLimpo, reaproveitado: true });
      }
      return res.status(400).json({ error: 'Erro ao criar login: ' + cErr.message });
    }

    novoId = novo?.user?.id;
    if (!novoId) return res.status(500).json({ error: 'Login criado, mas não retornou id.' });

    // Vincula como secretária desta clínica.
    const { error: mErr } = await sbAdmin.from('clinica_membros')
      .insert({ user_id: novoId, clinica_id: clinicaId, papel: 'secretaria' });
    if (mErr) {
      // Desfaz o usuário órfão pra não deixar login sem vínculo.
      try { await sbAdmin.auth.admin.deleteUser(novoId); } catch (e) { /* ignora */ }
      return res.status(500).json({ error: 'Erro ao vincular secretária: ' + mErr.message });
    }

    // Remove a clínica-fantasma criada pelo gatilho pra ela (ela usa a do dono).
    await limparClinicaFantasma(sbAdmin, novoId);

    console.log(`[criar-secretaria] clinica=${clinicaId} nova secretaria=${emailLimpo} por ${user.email}`);
    return res.status(200).json({ ok: true, userId: novoId, email: emailLimpo });
  }

  // ── TROCAR SENHA ────────────────────────────────────────────────────────
  // A senha antiga NÃO pode ser lida (fica só como hash no Auth) — então "caso
  // esqueça" a gente define uma NOVA. Só o dono, e só pra secretária DESTA
  // clínica.
  if (action === 'resetar-senha') {
    const alvo = cleanStr(userId);
    const senhaLimpa = String(senha || '');
    if (!alvo) return res.status(400).json({ error: 'userId obrigatório.' });
    if (senhaLimpa.length < 6) return res.status(400).json({ error: 'A senha deve ter no mínimo 6 caracteres.' });
    // Confirma que a pessoa é MESMO secretária desta clínica (anti-abuso).
    const { data: vinc } = await sbAdmin
      .from('clinica_membros').select('user_id')
      .eq('clinica_id', clinicaId).eq('user_id', alvo).maybeSingle();
    if (!vinc) return res.status(404).json({ error: 'Essa secretária não é desta clínica.' });

    const { error: upErr } = await sbAdmin.auth.admin.updateUserById(alvo, { password: senhaLimpa });
    if (upErr) return res.status(500).json({ error: 'Erro ao trocar a senha: ' + upErr.message });
    console.log(`[criar-secretaria] clinica=${clinicaId} trocou senha de=${alvo} por ${user.email}`);
    return res.status(200).json({ ok: true });
  }

  // ── REMOVER ─────────────────────────────────────────────────────────────
  if (action === 'remover') {
    const alvo = cleanStr(userId);
    if (!alvo) return res.status(400).json({ error: 'userId obrigatório.' });
    // Só remove se a pessoa for MESMO membro DESTA clínica (trava anti-abuso).
    const { data: vinc } = await sbAdmin
      .from('clinica_membros').select('user_id')
      .eq('clinica_id', clinicaId).eq('user_id', alvo).maybeSingle();
    if (!vinc) return res.status(404).json({ error: 'Essa secretária não é desta clínica.' });

    const { error: delErr } = await sbAdmin.from('clinica_membros')
      .delete().eq('clinica_id', clinicaId).eq('user_id', alvo);
    if (delErr) return res.status(500).json({ error: 'Erro ao remover vínculo: ' + delErr.message });
    // Limpa a clínica-fantasma dela (some do "Gerenciar contas").
    await limparClinicaFantasma(sbAdmin, alvo);
    // Se ela não for secretária de NENHUMA outra clínica nem dona de clínica,
    // APAGA o login de vez — assim o e-mail fica livre pra ser reusado depois.
    // Se ainda tiver vínculo em outra clínica, só desativa aqui (não derruba lá).
    let apagou = false;
    const { data: aindaVinculada } = await sbAdmin.from('clinica_membros').select('clinica_id').eq('user_id', alvo);
    const { data: aindaDona } = await sbAdmin.from('clinicas').select('id').eq('user_id', alvo).maybeSingle();
    if ((!aindaVinculada || !aindaVinculada.length) && !aindaDona) {
      try { await sbAdmin.auth.admin.deleteUser(alvo); apagou = true; } catch (e) { /* cai no ban abaixo */ }
    }
    if (!apagou) {
      try { await sbAdmin.auth.admin.updateUserById(alvo, { ban_duration: '876000h' }); } catch (e) { /* ok */ }
    }

    console.log(`[criar-secretaria] clinica=${clinicaId} removeu secretaria=${alvo} por ${user.email}`);
    return res.status(200).json({ ok: true });
  }

  return res.status(400).json({ error: 'Ação inválida.' });
};
