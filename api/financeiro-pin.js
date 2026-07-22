const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

// PIN financeiro — protege o faturamento agregado da clínica (ver
// supabase/financeiro-pin-secreto.sql pro porquê disso ser uma tabela
// separada em vez de ficar dentro de financeiro_config). O hash nunca sai
// do servidor: o navegador só manda o PIN em texto (via HTTPS) pra cá e
// recebe de volta ok/erro, nunca o hash armazenado.

function hashPin(pin) {
  return crypto.createHash('sha256').update('rwdent-fin:' + pin).digest('hex');
}

// Verifica um PIN contra o hash salvo, respeitando/atualizando o contador
// de tentativas erradas — usado tanto por 'check' quanto pelo 'pinAtual' de
// 'set', já que os dois são formas de adivinhar o PIN certo por tentativa e
// erro. Trava por 15 min depois de 5 erros seguidos.
async function verificarPin(sbAdmin, clinicaId, existing, pinDigitado) {
  if (existing.bloqueado_ate && new Date(existing.bloqueado_ate) > new Date()) {
    const minutos = Math.ceil((new Date(existing.bloqueado_ate) - new Date()) / 60000);
    return { ok: false, status: 429, error: `Muitas tentativas erradas. Tente de novo em ${minutos} min.` };
  }
  if (hashPin(String(pinDigitado || '')) !== existing.pin_hash) {
    // Incremento ATÔMICO via RPC (UPDATE de uma linha só, travado pelo
    // Postgres) — em vez de ler e escrever separado aqui em JS, o que
    // deixava a contagem burlável mandando várias tentativas em paralelo
    // (achado em pentest; ver supabase/financeiro-pin-atomic.sql).
    const { data: novoEstado, error: rpcErr } = await sbAdmin.rpc('financeiro_pin_registrar_erro', { p_clinica_id: clinicaId });
    const estado = Array.isArray(novoEstado) ? novoEstado[0] : novoEstado;
    if (rpcErr) console.error('[financeiro-pin] erro ao registrar tentativa errada:', rpcErr.message);
    const agoraBloqueado = estado?.bloqueado_ate && new Date(estado.bloqueado_ate) > new Date();
    if (agoraBloqueado) {
      return { ok: false, status: 429, error: 'Muitas tentativas erradas. Tente de novo em 15 min.' };
    }
    return { ok: false, status: 403, error: 'PIN incorreto.' };
  }
  if (existing.tentativas_erradas || existing.bloqueado_ate) {
    await sbAdmin.from('financeiro_pin_secreto')
      .update({ tentativas_erradas: 0, bloqueado_ate: null }).eq('clinica_id', clinicaId);
  }
  return { ok: true };
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

  const sbCaller = createClient(supabaseUrl, supabaseAnon, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } }
  });
  const { data: { user }, error: authErr } = await sbCaller.auth.getUser(accessToken);
  if (authErr || !user) return res.status(401).json({ error: 'Sessão inválida.' });

  const { data: cli, error: cliErr } = await sbCaller
    .from('clinicas').select('id').eq('user_id', user.id).eq('status', 'aprovado').single();
  if (cliErr || !cli) return res.status(403).json({ error: 'Clínica não encontrada ou não aprovada.' });
  const clinicaId = cli.id;

  const { action, pin, pinAtual } = req.body || {};
  const sbAdmin = createClient(supabaseUrl, serviceRoleKey);

  if (action === 'status') {
    const { data } = await sbAdmin
      .from('financeiro_pin_secreto').select('clinica_id').eq('clinica_id', clinicaId).maybeSingle();
    return res.status(200).json({ hasPin: !!data });
  }

  if (action === 'set') {
    if (!/^\d{4,6}$/.test(String(pin || ''))) {
      return res.status(400).json({ error: 'O PIN deve ter de 4 a 6 dígitos.' });
    }
    const { data: existing } = await sbAdmin
      .from('financeiro_pin_secreto')
      .select('pin_hash, tentativas_erradas, bloqueado_ate')
      .eq('clinica_id', clinicaId).maybeSingle();
    if (existing) {
      const v = await verificarPin(sbAdmin, clinicaId, existing, pinAtual);
      if (!v.ok) return res.status(v.status).json({ error: v.error });
    }
    const { error: upErr } = await sbAdmin
      .from('financeiro_pin_secreto')
      .upsert({ clinica_id: clinicaId, pin_hash: hashPin(String(pin)), updated_at: new Date().toISOString(), tentativas_erradas: 0, bloqueado_ate: null });
    if (upErr) return res.status(500).json({ error: 'Erro ao salvar: ' + upErr.message });
    return res.status(200).json({ ok: true });
  }

  if (action === 'check') {
    const { data: existing } = await sbAdmin
      .from('financeiro_pin_secreto')
      .select('pin_hash, tentativas_erradas, bloqueado_ate')
      .eq('clinica_id', clinicaId).maybeSingle();
    if (!existing) return res.status(404).json({ error: 'PIN financeiro ainda não configurado. Configure em Configurações → PIN financeiro.' });
    const v = await verificarPin(sbAdmin, clinicaId, existing, pin);
    if (!v.ok) return res.status(v.status).json({ error: v.error });
    return res.status(200).json({ ok: true });
  }

  return res.status(400).json({ error: 'Ação inválida.' });
};
