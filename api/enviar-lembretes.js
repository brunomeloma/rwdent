const { createClient } = require('@supabase/supabase-js');
const webpush = require('web-push');

// CRON — roda de minuto em minuto (chamado por um agendador externo, ver o
// comentário no fim). Acha as consultas que começam nos próximos ~15 min e
// manda um push pra TODOS os aparelhos daquela clínica que ativaram
// notificações. Usa a service role (ignora RLS) e é protegido por um segredo,
// já que quem chama é uma máquina, não um usuário logado.
//
// Não manda o mesmo lembrete duas vezes: antes de enviar, "carimba" na tabela
// push_enviados; se já estiver carimbado, pula.

// Horário local de São Paulo (Brasil = UTC-3, sem horário de verão). Usa o
// fuso de verdade via Intl pra não errar se a regra mudar um dia.
function agoraSaoPaulo() {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  });
  const p = {}; for (const part of fmt.formatToParts(new Date())) p[part.type] = part.value;
  return { data: `${p.year}-${p.month}-${p.day}`, minutos: (+p.hour) * 60 + (+p.minute) };
}

function horarioParaMinutos(h) {
  const m = String(h || '').match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return (+m[1]) * 60 + (+m[2]);
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  const clean = s => String(s || '').replace(/[^\x20-\x7E]/g, '').trim();
  const segredo = clean(process.env.LEMBRETES_SECRET);
  const supabaseUrl    = clean(process.env.SUPABASE_URL);
  const serviceRoleKey = clean(process.env.SUPABASE_SERVICE_ROLE_KEY);
  const vapidPublic    = clean(process.env.VAPID_PUBLIC_KEY);
  const vapidPrivate   = clean(process.env.VAPID_PRIVATE_KEY);
  const vapidSubject   = clean(process.env.VAPID_SUBJECT) || 'mailto:contato@rwdent.app';

  if (!segredo) return res.status(500).json({ error: 'LEMBRETES_SECRET não configurado.' });
  if (!supabaseUrl || !serviceRoleKey) return res.status(500).json({ error: 'Supabase não configurado.' });
  if (!vapidPublic || !vapidPrivate) return res.status(500).json({ error: 'Chaves VAPID não configuradas.' });

  // Confere o segredo (via ?secret= ou header x-cron-secret).
  const recebido = clean(req.query && req.query.secret) || clean(req.headers['x-cron-secret']);
  if (recebido !== segredo) return res.status(401).json({ error: 'Não autorizado.' });

  webpush.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate);
  const sb = createClient(supabaseUrl, serviceRoleKey);

  const { data: hojeStr, minutos: agoraMin } = agoraSaoPaulo();
  const JANELA = 15; // avisa quando faltam de 0 a 15 minutos

  // Consultas de hoje (a filtragem fina por horário é feita aqui no JS).
  const { data: ags, error: agErr } = await sb
    .from('agendamentos')
    .select('id, nome, procedimento, horario, prof_nome, clinica_id')
    .eq('data', hojeStr);
  if (agErr) return res.status(500).json({ error: 'Erro ao ler agendamentos: ' + agErr.message });

  const candidatas = (ags || []).filter(a => {
    const m = horarioParaMinutos(a.horario);
    if (m === null) return false;
    const falta = m - agoraMin;
    return falta >= 0 && falta <= JANELA;
  });

  let enviados = 0, semAssinatura = 0, jaEnviados = 0, mortas = 0;

  // Cache de assinaturas por clínica (evita reconsultar a mesma clínica).
  const subsPorClinica = {};
  async function assinaturasDaClinica(clinicaId) {
    if (subsPorClinica[clinicaId]) return subsPorClinica[clinicaId];
    const { data } = await sb.from('push_subscriptions')
      .select('endpoint, p256dh, auth').eq('clinica_id', clinicaId);
    subsPorClinica[clinicaId] = data || [];
    return subsPorClinica[clinicaId];
  }

  for (const a of candidatas) {
    // "Carimba" antes de enviar pra não duplicar entre execuções. Se já existe,
    // o insert falha por chave única (23505) e a gente pula.
    const { error: carimboErr } = await sb.from('push_enviados')
      .insert({ agendamento_id: a.id, tipo: '15min' });
    if (carimboErr) { jaEnviados++; continue; }

    const subs = await assinaturasDaClinica(a.clinica_id);
    if (!subs.length) { semAssinatura++; continue; }

    const hhmm = String(a.horario || '').slice(0, 5);
    const payload = JSON.stringify({
      title: 'Consulta em 15 minutos',
      body: `${a.nome || 'Paciente'} — ${a.procedimento || 'Consulta'} às ${hhmm}${a.prof_nome ? ' (' + a.prof_nome + ')' : ''}`,
      url: '/app.html',
      tag: 'ag-' + a.id
    });

    for (const s of subs) {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          payload
        );
        enviados++;
      } catch (e) {
        // 404/410 = aparelho não aceita mais (desinstalou/limpou) -> remove.
        if (e && (e.statusCode === 404 || e.statusCode === 410)) {
          try { await sb.from('push_subscriptions').delete().eq('endpoint', s.endpoint); mortas++; } catch (_) {}
        } else {
          console.error('[enviar-lembretes] falha no envio:', e && e.statusCode, e && e.message);
        }
      }
    }
  }

  return res.status(200).json({
    ok: true, hora: `${hojeStr} ${String(Math.floor(agoraMin/60)).padStart(2,'0')}:${String(agoraMin%60).padStart(2,'0')}`,
    candidatas: candidatas.length, enviados, jaEnviados, semAssinatura, mortas
  });
};
