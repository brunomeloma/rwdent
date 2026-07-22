const { createClient } = require('@supabase/supabase-js');

// Recebe os avisos do Mercado Pago (assinatura autorizada, pagamento
// mensal aprovado, etc.) e aprova a clínica sozinho — sem admin precisar
// clicar em nada. Segurança: NUNCA confia no conteúdo que vem no corpo do
// aviso (poderia ser forjado por qualquer um, já que o Mercado Pago não
// assina o payload nesse formato) — sempre busca o estado real de volta
// na API do Mercado Pago usando o Access Token antes de decidir algo.
//
// Configurar em Mercado Pago → Developers → sua aplicação → Webhooks:
// URL de produção = https://SEU-DOMINIO/api/mercadopago-webhook
// Eventos: "Assinaturas" (preapproval) e "Pagamentos" (payment).

const DIAS_ACESSO_POR_CICLO = 31; // um pouco mais que 30 pra dar folga

module.exports = async function handler(req, res) {
  // Mercado Pago espera 200 rápido — responde cedo e loga qualquer
  // problema, em vez de deixar a requisição pendurada.
  const cleanStr = s => String(s || '').replace(/[^\x20-\x7E]/g, '').trim();
  const supabaseUrl    = cleanStr(process.env.SUPABASE_URL);
  const serviceRoleKey = cleanStr(process.env.SUPABASE_SERVICE_ROLE_KEY);
  const mpToken         = cleanStr(process.env.MERCADOPAGO_ACCESS_TOKEN);

  if (!supabaseUrl || !serviceRoleKey || !mpToken) {
    console.error('[mp-webhook] variáveis de ambiente ausentes.');
    return res.status(200).json({ ok: true }); // sempre 200 pro MP não ficar retentando à toa
  }

  const body = req.body || {};
  const query = req.query || {};
  // Mercado Pago manda o tipo/id tanto no corpo (Webhooks novos) quanto
  // via querystring (formato IPN mais antigo) — cobre os dois.
  const tipo = body.type || body.topic || query.type || query.topic || '';
  const id   = (body.data && body.data.id) || query.id || query['data.id'] || '';

  console.log(`[mp-webhook] recebido: tipo=${tipo} id=${id}`);
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

async function liberarClinica(sbAdmin, clinicaId, origem) {
  const expira = new Date(Date.now() + DIAS_ACESSO_POR_CICLO * 24 * 60 * 60 * 1000).toISOString();
  const { error } = await sbAdmin.from('clinicas')
    .update({ status: 'aprovado', expira_em: expira })
    .eq('id', clinicaId);
  if (error) {
    console.error(`[mp-webhook] erro ao liberar clínica ${clinicaId}:`, error.message);
    return;
  }
  console.log(`[mp-webhook] clínica ${clinicaId} liberada até ${expira} (origem: ${origem})`);
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
  await liberarClinica(sbAdmin, clinicaId, 'preapproval autorizado');
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
  await liberarClinica(sbAdmin, clinicaId, 'pagamento aprovado');
}
