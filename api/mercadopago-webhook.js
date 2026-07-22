const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

// Recebe os avisos do Mercado Pago (assinatura autorizada, pagamento
// mensal aprovado, etc.) e aprova a clínica sozinho — sem admin precisar
// clicar em nada. Segurança em duas camadas:
// 1) Verifica a assinatura HMAC do cabeçalho x-signature (MERCADOPAGO_WEBHOOK_SECRET)
//    — mas só como alerta/log, nunca bloqueia sozinha (se o formato mudar
//    e a verificação falhar por bug nosso, não pode travar pagamento real).
// 2) A decisão de verdade NUNCA confia no conteúdo do aviso em si — sempre
//    busca o estado real de volta na API do Mercado Pago usando o Access
//    Token antes de liberar qualquer clínica. Essa é a proteção que
//    realmente importa.
//
// Configurar em Mercado Pago → Developers → sua aplicação → Webhooks:
// URL de produção = https://SEU-DOMINIO/api/mercadopago-webhook
// Eventos: "Planos e assinaturas" (preapproval) e "Pagamentos" (payment).

const DIAS_ACESSO_POR_CICLO = 31; // um pouco mais que 30 pra dar folga

function verificarAssinatura(req, secret) {
  try {
    if (!secret) return null;
    const xSignature = req.headers['x-signature'];
    const xRequestId = req.headers['x-request-id'];
    if (!xSignature || !xRequestId) return null;
    const partes = {};
    xSignature.split(',').forEach(p => {
      const [k, v] = p.split('=');
      if (k && v) partes[k.trim()] = v.trim();
    });
    if (!partes.ts || !partes.v1) return null;
    const dataId = (req.query && req.query['data.id']) || '';
    const manifest = `id:${String(dataId).toLowerCase()};request-id:${xRequestId};ts:${partes.ts};`;
    const hash = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
    return hash === partes.v1;
  } catch (e) {
    console.error('[mp-webhook] erro ao verificar assinatura:', e.message);
    return null;
  }
}

module.exports = async function handler(req, res) {
  // Mercado Pago espera 200 rápido — responde cedo e loga qualquer
  // problema, em vez de deixar a requisição pendurada.
  const cleanStr = s => String(s || '').replace(/[^\x20-\x7E]/g, '').trim();
  const supabaseUrl    = cleanStr(process.env.SUPABASE_URL);
  const serviceRoleKey = cleanStr(process.env.SUPABASE_SERVICE_ROLE_KEY);
  const mpToken         = cleanStr(process.env.MERCADOPAGO_ACCESS_TOKEN);
  const webhookSecret    = cleanStr(process.env.MERCADOPAGO_WEBHOOK_SECRET);

  if (!supabaseUrl || !serviceRoleKey || !mpToken) {
    console.error('[mp-webhook] variáveis de ambiente ausentes.');
    return res.status(200).json({ ok: true }); // sempre 200 pro MP não ficar retentando à toa
  }

  const assinaturaOk = verificarAssinatura(req, webhookSecret);
  if (assinaturaOk === false) {
    console.warn('[mp-webhook] ALERTA: assinatura x-signature não bateu — aviso pode não ser genuíno. Prosseguindo mesmo assim (a decisão real depende da confirmação via API, não deste header), mas vale investigar se isso persistir.');
  }

  const body = req.body || {};
  const query = req.query || {};
  // Mercado Pago manda o tipo/id tanto no corpo (Webhooks novos) quanto
  // via querystring (formato IPN mais antigo) — cobre os dois.
  const tipo = body.type || body.topic || query.type || query.topic || '';
  const id   = (body.data && body.data.id) || query.id || query['data.id'] || '';

  console.log(`[mp-webhook] recebido: tipo=${tipo} id=${id} assinaturaOk=${assinaturaOk}`);
  if (!id) return res.status(200).json({ ok: true });

  const sbAdmin = createClient(supabaseUrl, serviceRoleKey);

  try {
    if (tipo === 'preapproval' || tipo === 'subscription_preapproval') {
      await tratarPreapproval(sbAdmin, mpToken, id);
    } else if (tipo === 'payment') {
      await tratarPagamento(sbAdmin, mpToken, id);
    } else {
      console.log(`[mp-webhook] tipo não tratado: ${tipo}`);
    }
  } catch (e) {
    console.error('[mp-webhook] erro ao processar:', e.message);
  }

  return res.status(200).json({ ok: true });
};

async function liberarClinica(sbAdmin, clinicaId, dias, origem) {
  const expira = new Date(Date.now() + dias * 24 * 60 * 60 * 1000).toISOString();
  const { error } = await sbAdmin.from('clinicas')
    .update({ status: 'aprovado', expira_em: expira })
    .eq('id', clinicaId);
  if (error) {
    console.error(`[mp-webhook] erro ao liberar clínica ${clinicaId}:`, error.message);
    return;
  }
  console.log(`[mp-webhook] clínica ${clinicaId} liberada por ${dias} dia(s), até ${expira} (origem: ${origem})`);
}

async function tratarPreapproval(sbAdmin, mpToken, preapprovalId) {
  const resp = await fetch(`https://api.mercadopago.com/preapproval/${preapprovalId}`, {
    headers: { Authorization: `Bearer ${mpToken}` }
  });
  const data = await resp.json();
  if (!resp.ok) { console.error('[mp-webhook] erro ao buscar preapproval:', JSON.stringify(data)); return; }

  console.log(`[mp-webhook] preapproval ${preapprovalId} status=${data.status} external_reference=${data.external_reference}`);
  if (data.status !== 'authorized') return; // pending/cancelled/paused — não libera

  const clinicaId = data.external_reference;
  if (!clinicaId) { console.error('[mp-webhook] preapproval sem external_reference — não sei qual clínica liberar.'); return; }

  // Se a clínica está marcada como "em teste" (mp_trial_dias definido), a
  // autorização inicial (sem cobrança ainda) só dá direito ao período de
  // teste — não ao ciclo mensal completo. Isso evita que alguém autorize
  // um teste grátis, cancele antes de ser cobrado, e ganhe um mês de
  // graça mesmo assim.
  const { data: clinica } = await sbAdmin.from('clinicas').select('mp_trial_dias').eq('id', clinicaId).maybeSingle();
  const diasTrial = clinica?.mp_trial_dias;
  const dias = (diasTrial && diasTrial > 0) ? diasTrial + 1 : DIAS_ACESSO_POR_CICLO; // +1 dia de folga no trial
  await liberarClinica(sbAdmin, clinicaId, dias, diasTrial ? `preapproval autorizado (trial ${diasTrial}d)` : 'preapproval autorizado');
}

async function tratarPagamento(sbAdmin, mpToken, paymentId) {
  const resp = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
    headers: { Authorization: `Bearer ${mpToken}` }
  });
  const data = await resp.json();
  if (!resp.ok) { console.error('[mp-webhook] erro ao buscar pagamento:', JSON.stringify(data)); return; }

  console.log(`[mp-webhook] pagamento ${paymentId} status=${data.status} external_reference=${data.external_reference}`);
  if (data.status !== 'approved') return;

  // Pagamentos recorrentes de uma assinatura costumam herdar o
  // external_reference do preapproval que os gerou.
  let clinicaId = data.external_reference;
  if (!clinicaId) {
    console.error(`[mp-webhook] pagamento ${paymentId} aprovado mas sem external_reference — não consegui achar a clínica automaticamente. Verifique manualmente no painel do Mercado Pago.`);
    return;
  }
  // Um pagamento de verdade caiu — não é mais trial, a partir de agora
  // ganha o ciclo mensal completo (inclusive nas próximas renovações).
  await sbAdmin.from('clinicas').update({ mp_trial_dias: null }).eq('id', clinicaId);
  await liberarClinica(sbAdmin, clinicaId, DIAS_ACESSO_POR_CICLO, 'pagamento aprovado');
}
