const { createClient } = require('@supabase/supabase-js');
const webpush = require('web-push');

// CRON — roda de minuto em minuto (chamado por um agendador externo, ver o
// comentário no fim). Acha as consultas que começam dentro da antecedência
// que cada clínica escolheu (15/30/60min, em Configurações) e manda um push
// pra TODOS os aparelhos daquela clínica que ativaram notificações. Usa a
// service role (ignora RLS) e é protegido por um segredo, já que quem chama
// é uma máquina, não um usuário logado.
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

const JANELAS_VALIDAS = [15, 30, 60];
function antecedenciaTexto(min) {
  return min === 60 ? '1 hora' : `${min} minutos`;
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
  const JANELA_MAX = Math.max(...JANELAS_VALIDAS); // maior antecedência possível (60min) — pré-filtro solto

  // Consultas de hoje (a filtragem fina por horário é feita aqui no JS).
  const { data: ags, error: agErr } = await sb
    .from('agendamentos')
    .select('id, nome, procedimento, horario, prof_nome, clinica_id')
    .eq('data', hojeStr);
  if (agErr) return res.status(500).json({ error: 'Erro ao ler agendamentos: ' + agErr.message });

  const proximas = (ags || []).filter(a => {
    const m = horarioParaMinutos(a.horario);
    if (m === null) return false;
    const falta = m - agoraMin;
    return falta >= 0 && falta <= JANELA_MAX;
  });

  // Cada clínica escolhe sua própria antecedência (15/30/60min, em
  // Configurações → Lembrete por notificação). Busca só as clínicas que têm
  // consulta próxima. Se a coluna ainda não existir no banco (migração não
  // rodada), cai no padrão de 15min pra todo mundo, sem quebrar o robô.
  const clinicaIds = [...new Set(proximas.map(a => a.clinica_id).filter(Boolean))];
  const janelaPorClinica = {};
  if (clinicaIds.length) {
    const { data: clinicasData, error: cliErr } = await sb
      .from('clinicas').select('id, lembrete_minutos').in('id', clinicaIds);
    if (!cliErr && clinicasData) {
      for (const c of clinicasData) {
        janelaPorClinica[c.id] = JANELAS_VALIDAS.includes(c.lembrete_minutos) ? c.lembrete_minutos : 15;
      }
    }
  }
  const janelaDaClinica = (clinicaId) => janelaPorClinica[clinicaId] ?? 15;

  const candidatas = proximas.filter(a => {
    const m = horarioParaMinutos(a.horario);
    const falta = m - agoraMin;
    return falta <= janelaDaClinica(a.clinica_id);
  });

  let enviados = 0, semAssinatura = 0, jaEnviados = 0, mortas = 0;
  const erros = []; // diagnóstico: detalhe de qualquer envio que não deu certo

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
    const janela = janelaDaClinica(a.clinica_id);
    const tipo = janela + 'min';

    // RESERVA atômica (INSERT com chave única): se duas execuções caírem no
    // mesmo instante — o robô automático de 1 em 1 minuto E uma checagem
    // manual, por exemplo — só UMA consegue inserir; a outra recebe erro de
    // duplicidade (23505) e desiste na hora, sem mandar push nenhum. Isso é o
    // que evita a consulta receber a notificação 2x.
    const { error: reservaErr } = await sb.from('push_enviados')
      .insert({ agendamento_id: a.id, tipo });
    if (reservaErr) { jaEnviados++; continue; }

    const subs = await assinaturasDaClinica(a.clinica_id);
    if (!subs.length) {
      // Sem assinatura ainda: desfaz a reserva pra poder tentar de novo no
      // próximo minuto (a pessoa pode ativar as notificações a qualquer
      // momento dentro da janela escolhida).
      await sb.from('push_enviados').delete().eq('agendamento_id', a.id).eq('tipo', tipo);
      semAssinatura++; continue;
    }

    const hhmm = String(a.horario || '').slice(0, 5);
    const payload = JSON.stringify({
      title: `Consulta em ${antecedenciaTexto(janela)}`,
      body: `${a.nome || 'Paciente'} — ${a.procedimento || 'Consulta'} às ${hhmm}${a.prof_nome ? ' (' + a.prof_nome + ')' : ''}`,
      url: '/app.html',
      tag: 'ag-' + a.id
    });

    let algumSucesso = false, algumPendente = false;

    for (const s of subs) {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          payload
        );
        enviados++;
        algumSucesso = true;
      } catch (e) {
        const status = e && e.statusCode;
        const corpo = e && e.body ? String(e.body).slice(0, 200) : '';
        if (status === 404 || status === 410) {
          // Aparelho não aceita mais (desinstalou/limpou) -> remove de vez.
          try { await sb.from('push_subscriptions').delete().eq('endpoint', s.endpoint); } catch (_) {}
          mortas++;
        } else {
          // Qualquer outro erro (ex: chave VAPID errada = 401/403, rede, etc.)
          // fica registrado no retorno E tenta de novo no próximo minuto.
          algumPendente = true;
          erros.push({ agendamento_id: a.id, status: status || null, mensagem: (e && e.message) || String(e), corpo });
          console.error('[enviar-lembretes] falha no envio:', status, e && e.message, corpo);
        }
      }
    }

    // A reserva já foi feita no início (é o que trava duplicidade). Só
    // precisa desfazer se NADA deu certo e ainda sobrou pendência real (erro
    // que não é 404/410) — aí libera pra tentar de novo no próximo minuto.
    // Se teve sucesso, ou só sobrou aparelho morto (sem mais o que tentar), a
    // reserva fica valendo como "concluído".
    if (!algumSucesso && algumPendente) {
      await sb.from('push_enviados').delete().eq('agendamento_id', a.id).eq('tipo', tipo);
    }
  }

  return res.status(200).json({
    ok: true, hora: `${hojeStr} ${String(Math.floor(agoraMin/60)).padStart(2,'0')}:${String(agoraMin%60).padStart(2,'0')}`,
    candidatas: candidatas.length, enviados, jaEnviados, semAssinatura, mortas,
    erros: erros.length ? erros : undefined
  });
};
