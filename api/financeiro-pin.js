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
      .from('financeiro_pin_secreto').select('pin_hash').eq('clinica_id', clinicaId).maybeSingle();
    if (existing) {
      if (hashPin(String(pinAtual || '')) !== existing.pin_hash) {
        return res.status(403).json({ error: 'PIN financeiro atual incorreto.' });
      }
    }
    const { error: upErr } = await sbAdmin
      .from('financeiro_pin_secreto')
      .upsert({ clinica_id: clinicaId, pin_hash: hashPin(String(pin)), updated_at: new Date().toISOString() });
    if (upErr) return res.status(500).json({ error: 'Erro ao salvar: ' + upErr.message });
    return res.status(200).json({ ok: true });
  }

  if (action === 'check') {
    const { data: existing } = await sbAdmin
      .from('financeiro_pin_secreto').select('pin_hash').eq('clinica_id', clinicaId).maybeSingle();
    if (!existing) return res.status(404).json({ error: 'PIN financeiro ainda não configurado. Configure em Configurações → PIN financeiro.' });
    if (hashPin(String(pin || '')) !== existing.pin_hash) {
      return res.status(403).json({ error: 'PIN incorreto.' });
    }
    return res.status(200).json({ ok: true });
  }

  return res.status(400).json({ error: 'Ação inválida.' });
};
