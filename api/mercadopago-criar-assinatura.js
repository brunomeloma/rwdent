const { createClient } = require('@supabase/supabase-js');

// Gera o link de assinatura mensal recorrente (R$69,90/mês) de uma clínica
// no Mercado Pago — só admin pode chamar. O link volta pronto pra você
// copiar e mandar no WhatsApp; quando o cliente autoriza o pagamento, o
// Mercado Pago avisa api/mercadopago-webhook.js sozinho, que aprova a
// clínica automaticamente — sem você precisar entrar e clicar em nada.
//
// Modo "trial": o cliente cadastra o cartão e autoriza a assinatura, mas
// só é cobrado depois de TRIAL_DIAS — se cancelar antes disso, nunca paga
// nada. O webhook sabe diferenciar (via mp_trial_dias salvo na clínica) e
// só libera o período de teste na autorização inicial, não o mês inteiro.

const PLANO_MENSAL_VALOR = 69.90;
const TRIAL_DIAS = 3;

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

  const { data: isAdmin, error: adminErr } = await sbCaller.rpc('rwdent_is_admin');
  if (adminErr || !isAdmin) return res.status(403).json({ error: 'Acesso negado.' });

  const { clinicaId, trial } = req.body || {};
  if (!clinicaId) return res.status(400).json({ error: 'clinicaId obrigatório.' });

  const sbAdmin = createClient(supabaseUrl, serviceRoleKey);
  const { data: clinica, error: cliErr } = await sbAdmin
    .from('clinicas').select('id, nome_cli, email').eq('id', clinicaId).single();
  if (cliErr || !clinica) return res.status(404).json({ error: 'Clínica não encontrada.' });

  const autoRecurring = {
    frequency: 1,
    frequency_type: 'months',
    transaction_amount: PLANO_MENSAL_VALOR,
    currency_id: 'BRL'
  };
  if (trial) {
    autoRecurring.free_trial = { frequency: TRIAL_DIAS, frequency_type: 'days' };
  }

  const payload = {
    reason: trial
      ? `RWDent — Teste grátis ${TRIAL_DIAS} dias (${clinica.nome_cli || 'Clínica'})`
      : `Assinatura RWDent — ${clinica.nome_cli || 'Clínica'}`,
    auto_recurring: autoRecurring,
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
    console.error('[mercadopago-criar-assinatura] erro MP:', JSON.stringify(mpJson));
    return res.status(502).json({ error: 'Erro ao criar assinatura no Mercado Pago: ' + (mpJson.message || mpResp.status) });
  }

  await sbAdmin.from('clinicas')
    .update({ mp_subscription_id: mpJson.id, mp_trial_dias: trial ? TRIAL_DIAS : null })
    .eq('id', clinicaId);

  console.log(`[mercadopago] assinatura criada: clinica=${clinicaId} preapproval=${mpJson.id} trial=${!!trial} por ${user.email}`);
  return res.status(200).json({ ok: true, link: mpJson.init_point, preapprovalId: mpJson.id });
};
