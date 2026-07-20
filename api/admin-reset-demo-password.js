const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

// Escopo intencionalmente travado a UMA única conta (a demo). Isso existe
// pra permitir que o admin troque a senha da demo pelo próprio app, sem
// entrar no Supabase Dashboard — não é um endpoint genérico de "resetar
// senha de qualquer usuário". Mesmo que a checagem de admin abaixo falhe
// por algum bug futuro, o pior caso continua sendo só a conta demo (que
// não tem paciente real nenhum), nunca a conta de uma clínica de verdade.
const DEMO_USER_ID = 'a0e811f6-fefb-4677-8a01-0cd031821b5f';
const DEMO_EMAIL   = 'demo@rwdent.app';

function gerarSenha() {
  // 16 chars, alfanumérico — fácil de ditar/copiar no celular, sem
  // caracteres ambíguos (0/O, 1/l) nem símbolos que compliquem colar.
  const alfabeto = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let senha = '';
  const bytes = crypto.randomBytes(16);
  for (let i = 0; i < 16; i++) senha += alfabeto[bytes[i] % alfabeto.length];
  return senha;
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido.' });

  const cleanStr = s => String(s || '').replace(/[^\x20-\x7E]/g, '').trim();
  const supabaseUrl     = cleanStr(process.env.SUPABASE_URL);
  const supabaseAnon    = cleanStr(process.env.SUPABASE_ANON_KEY);
  const serviceRoleKey  = cleanStr(process.env.SUPABASE_SERVICE_ROLE_KEY);

  if (!supabaseUrl || !supabaseAnon || !serviceRoleKey) {
    return res.status(500).json({ error: 'Servidor sem SUPABASE_SERVICE_ROLE_KEY configurada.' });
  }

  const authHeader  = req.headers['authorization'] || '';
  const accessToken = cleanStr(authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '');
  if (!accessToken) return res.status(401).json({ error: 'Faça login.' });

  // Client com o token do chamador — usado só pra validar o token e checar
  // admin via RPC (respeita RLS, mesma checagem que admin.html e o painel
  // admin do app.html já fazem). O service role só entra depois de confirmado.
  const sbCaller = createClient(supabaseUrl, supabaseAnon, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } }
  });

  const { data: { user }, error: authErr } = await sbCaller.auth.getUser(accessToken);
  if (authErr || !user) return res.status(401).json({ error: 'Sessão inválida.' });

  const { data: isAdmin, error: adminErr } = await sbCaller.rpc('rwdent_is_admin');
  if (adminErr || !isAdmin) return res.status(403).json({ error: 'Acesso negado.' });

  const sbAdmin = createClient(supabaseUrl, serviceRoleKey);
  const novaSenha = gerarSenha();
  const { error: updErr } = await sbAdmin.auth.admin.updateUserById(DEMO_USER_ID, { password: novaSenha });
  if (updErr) return res.status(500).json({ error: 'Erro ao trocar senha: ' + updErr.message });

  console.log(`[admin] senha da demo redefinida por ${user.email || user.id}`);
  return res.status(200).json({ ok: true, email: DEMO_EMAIL, password: novaSenha });
};
