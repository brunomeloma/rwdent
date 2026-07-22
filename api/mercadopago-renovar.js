const { createClient } = require('@supabase/supabase-js');

// Auto-serviço: a própria clínica gera o link de assinatura pra ela mesma
// quando o acesso expira (botão "Assinar agora" na tela de expirado), sem
// precisar pedir pro admin. Sempre assinatura completa, sem free_trial — o
// teste grátis já foi oferecido uma vez, no cadastro. A clínica é sempre a
// do próprio usuário autenticado (via user_id do token), nunca um id vindo
// do corpo da requisição, então não dá pra gerar link pra clínica alheia.

const PLANO_MENSAL_VALOR = 69.90;

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido.' });

  const cleanStr = s => String(s || '').replace(/[^\x20-\x7E]/g, '').trim();
  const supabaseUrl    = cleanStr(process.env.SUPABASE_URL);
  const supabaseAnon   = cleanStr(process.env.SUPABASE_ANON_KEY);
  const serviceRoleKey = cleanStr(process.env.SUPABASE_SERVICE_ROLE_KEY);
  const mpToken         = cleanStr(process.env.MERCADOPAGO_ACCESS_TOKEN);
  const appUrl           = cleanStr(process.env.APP_URL) || 'https://rwdent.vercel.app';

  if (!supabaseUrl || !supabaseAnon || !serviceRoleKey) {
    return res.status(500).json({ error: 'Servidor sem SUPABASE_SERVICE_ROLE_KEY configurada.' });
  }
  if (!mpToken) {
    return res.status(500).json({ error: 'Servidor sem MERCADOPAGO_ACCESS_TOKEN configurada.' });
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
  const { data: clinica, error: cliErr } = await sbAdmin
    .from('clinicas').select('id, nome_cli, email').eq('user_id', user.id).single();
  if (cliErr || !clinica) return res.status(404).json({ error: 'Clínica não encontrada.' });

  const payload = {
    reason: `Assinatura RWDent — ${clinica.nome_cli || 'Clínica'}`,
    auto_recurring: {
      frequency: 1,
      frequency_type: 'months',
      transaction_amount: PLANO_MENSAL_VALOR,
      currency_id: 'BRL'
    },
    back_url: appUrl,
    external_reference: String(clinica.id),
    status: 'pending'
  };
  if (clinica.email) payload.payer_email = clinica.email;

  const mpResp = await fetch('https://api.mercadopago.com/preapproval', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${mpToken}` },
    body: JSON.stringify(payload)
  });
  const mpJson = await mpResp.json();
  if (!mpResp.ok) {
    console.error('[mercadopago-renovar] erro MP:', JSON.stringify(mpJson));
    return res.status(502).json({ error: 'Erro ao criar assinatura no Mercado Pago: ' + (mpJson.message || mpResp.status) });
  }

  await sbAdmin.from('clinicas')
    .update({ mp_subscription_id: mpJson.id, mp_trial_dias: null })
    .eq('id', clinica.id);

  console.log(`[mercadopago-renovar] assinatura auto-serviço criada: clinica=${clinica.id} preapproval=${mpJson.id} por ${user.email}`);
  return res.status(200).json({ ok: true, link: mpJson.init_point });
};
