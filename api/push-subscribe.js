const { createClient } = require('@supabase/supabase-js');

// Guarda (ou remove) a "assinatura de push" de um aparelho — o endereço pra
// onde o servidor manda a notificação. Cada aparelho que ativa notificações
// chama isto com { action:'salvar', subscription }. Sair/desativar chama
// { action:'remover', endpoint }.
//
// A clínica é descoberta pelo TOKEN do usuário (membro primeiro, senão dono) —
// nunca vem do corpo — então um aparelho só recebe lembretes da clínica certa.

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido.' });

  const cleanStr = s => String(s || '').replace(/[^\x20-\x7E]/g, '').trim();
  const supabaseUrl    = cleanStr(process.env.SUPABASE_URL);
  const supabaseAnon   = cleanStr(process.env.SUPABASE_ANON_KEY);
  const serviceRoleKey = cleanStr(process.env.SUPABASE_SERVICE_ROLE_KEY);
  if (!supabaseUrl || !supabaseAnon || !serviceRoleKey) {
    return res.status(500).json({ error: 'Servidor sem chaves do Supabase configuradas.' });
  }

  const authHeader  = req.headers['authorization'] || '';
  const accessToken = cleanStr(authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '');
  if (!accessToken) return res.status(401).json({ error: 'Faça login.' });

  const sbCaller = createClient(supabaseUrl, supabaseAnon, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } }
  });
  const { data: { user }, error: authErr } = await sbCaller.auth.getUser(accessToken);
  if (authErr || !user) return res.status(401).json({ error: 'Sessão inválida.' });

  const sbAdmin = createClient(supabaseUrl, serviceRoleKey);

  const { action, subscription, endpoint } = req.body || {};

  // ── REMOVER ───────────────────────────────────────────────────────────────
  if (action === 'remover') {
    const ep = String(endpoint || (subscription && subscription.endpoint) || '');
    if (!ep) return res.status(400).json({ error: 'endpoint obrigatório.' });
    // Só remove uma assinatura DO PRÓPRIO usuário (trava anti-abuso).
    await sbAdmin.from('push_subscriptions').delete().eq('endpoint', ep).eq('user_id', user.id);
    return res.status(200).json({ ok: true });
  }

  // ── SALVAR ────────────────────────────────────────────────────────────────
  if (action === 'salvar') {
    const sub = subscription || {};
    const ep  = String(sub.endpoint || '');
    const p256dh = sub.keys && sub.keys.p256dh;
    const auth   = sub.keys && sub.keys.auth;
    if (!ep || !p256dh || !auth) return res.status(400).json({ error: 'Assinatura inválida.' });

    // Descobre a clínica do usuário: membro (secretária) primeiro, senão dono.
    let clinicaId = null;
    const { data: vinc } = await sbAdmin
      .from('clinica_membros').select('clinica_id').eq('user_id', user.id).limit(1);
    if (vinc && vinc.length) clinicaId = vinc[0].clinica_id;
    if (!clinicaId) {
      const { data: cli } = await sbAdmin
        .from('clinicas').select('id').eq('user_id', user.id).maybeSingle();
      if (cli) clinicaId = cli.id;
    }
    if (!clinicaId) return res.status(403).json({ error: 'Usuário sem clínica.' });

    // upsert pelo endpoint: se o mesmo aparelho reassinar, atualiza as chaves e
    // a clínica em vez de duplicar. Guarda o user_id atual (dono do aparelho).
    const { error } = await sbAdmin.from('push_subscriptions').upsert({
      clinica_id: clinicaId,
      user_id: user.id,
      endpoint: ep,
      p256dh: String(p256dh),
      auth: String(auth),
      user_agent: cleanStr((req.headers['user-agent'] || '')).slice(0, 300)
    }, { onConflict: 'endpoint' });
    if (error) return res.status(500).json({ error: 'Erro ao salvar assinatura: ' + error.message });

    return res.status(200).json({ ok: true, clinicaId });
  }

  return res.status(400).json({ error: 'Ação inválida.' });
};
