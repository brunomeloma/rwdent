const { createClient } = require('@supabase/supabase-js');

// Deleta uma clínica e TODOS os dados dela — ação irreversível, só pra admin.
// Travas (em camadas):
//   1. Precisa estar logado e ser ADMIN (checado no servidor via rwdent_is_admin).
//   2. Precisa reenviar a SENHA do próprio admin (reautenticação) — evita que
//      alguém com a tela aberta apague uma clínica sem querer.
//   3. NUNCA deleta uma clínica de admin (as clínicas reais ficam protegidas).
//
// O login (usuário no Auth) do dono da clínica só é removido se ele NÃO for
// membro/secretária de outra clínica — assim não derruba uma secretária ativa
// que por acaso seja "dona" de uma clínica-fantasma vazia.

// Tabelas com coluna clinica_id que devem ser limpas junto. Se alguma não
// existir nesta base, o erro é ignorado.
const TABELAS_CLINICA = [
  'financeiro_config', 'clinica_membros', 'agendamentos', 'anamneses',
  'anamnese_links', 'atendimentos_odonto', 'procedimentos_dentes',
  'plano_tratamento', 'log_atividades', 'lista_espera', 'profissionais'
];

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

  // 1) Valida o token e confirma ADMIN (mesma checagem do resto do painel).
  const sbCaller = createClient(supabaseUrl, supabaseAnon, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } }
  });
  const { data: { user }, error: authErr } = await sbCaller.auth.getUser(accessToken);
  if (authErr || !user) return res.status(401).json({ error: 'Sessão inválida.' });

  const { data: isAdmin, error: adminErr } = await sbCaller.rpc('rwdent_is_admin');
  if (adminErr || !isAdmin) return res.status(403).json({ error: 'Só um administrador pode deletar clínicas.' });

  const { clinicaId, senha } = req.body || {};
  if (!clinicaId) return res.status(400).json({ error: 'clinicaId obrigatório.' });
  if (!senha)     return res.status(400).json({ error: 'Digite sua senha de administrador para confirmar.' });

  // 2) Reautentica: confere a senha do próprio admin logado.
  const sbCheck = createClient(supabaseUrl, supabaseAnon);
  const { error: pwErr } = await sbCheck.auth.signInWithPassword({ email: user.email, password: String(senha) });
  if (pwErr) return res.status(403).json({ error: 'Senha incorreta.' });

  const sbAdmin = createClient(supabaseUrl, serviceRoleKey);

  // Busca a clínica-alvo.
  const { data: clinica, error: cliErr } = await sbAdmin
    .from('clinicas').select('id, user_id, nome_cli').eq('id', clinicaId).maybeSingle();
  if (cliErr) return res.status(500).json({ error: 'Erro ao buscar clínica: ' + cliErr.message });
  if (!clinica) return res.status(404).json({ error: 'Clínica não encontrada.' });

  // 3) NUNCA deleta clínica de admin (protege as clínicas reais).
  const { data: donoAdmin } = await sbAdmin
    .from('admin_users').select('user_id').eq('user_id', clinica.user_id).maybeSingle();
  if (donoAdmin) return res.status(403).json({ error: 'Esta é uma clínica de administrador e não pode ser deletada por segurança.' });

  // Impede o admin de deletar a própria clínica (defesa extra).
  if (clinica.user_id === user.id) return res.status(403).json({ error: 'Você não pode deletar a sua própria clínica por aqui.' });

  // ── Deleção em cascata (service role ignora RLS). Ordem: filhos → clínica. ──
  // prontuarios pode se ligar por paciente_id; limpa antes de pacientes.
  try {
    const { data: pacs } = await sbAdmin.from('pacientes').select('id').eq('clinica_id', clinicaId);
    const ids = (pacs || []).map(p => p.id);
    if (ids.length) { try { await sbAdmin.from('prontuarios').delete().in('paciente_id', ids); } catch (e) {} }
    try { await sbAdmin.from('prontuarios').delete().eq('clinica_id', clinicaId); } catch (e) {}
    try { await sbAdmin.from('pacientes').delete().eq('clinica_id', clinicaId); } catch (e) {}
  } catch (e) { /* segue */ }

  for (const t of TABELAS_CLINICA) {
    try { await sbAdmin.from(t).delete().eq('clinica_id', clinicaId); } catch (e) { /* tabela pode não existir */ }
  }

  const { error: delCliErr } = await sbAdmin.from('clinicas').delete().eq('id', clinicaId);
  if (delCliErr) return res.status(500).json({ error: 'Erro ao deletar a clínica: ' + delCliErr.message });

  // Remove o login do dono SÓ se ele não for membro de outra clínica.
  try {
    const { data: outros } = await sbAdmin
      .from('clinica_membros').select('clinica_id').eq('user_id', clinica.user_id);
    if (!outros || !outros.length) {
      try { await sbAdmin.auth.admin.deleteUser(clinica.user_id); } catch (e) { /* ok */ }
    }
  } catch (e) { /* ok */ }

  console.log(`[admin-deletar-clinica] clinica=${clinicaId} (${clinica.nome_cli||'-'}) deletada por ${user.email}`);
  return res.status(200).json({ ok: true });
};
