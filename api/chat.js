const { OpenAI }      = require('openai');
const { createClient } = require('@supabase/supabase-js');

const MAX_HISTORY     = 12;
const MAX_CONTENT_LEN = 800;
const MAX_TOOL_ROUNDS = 5;

// ══════════════════════════════════════════════
// FERRAMENTAS (tool calling OpenAI)
// ══════════════════════════════════════════════
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'buscar_paciente',
      description: 'Busca pacientes por nome ou telefone. Leitura — não requer confirmação.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Nome (parcial) ou telefone do paciente' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'listar_pacientes',
      description: 'Lista os pacientes cadastrados na clínica. Leitura — não requer confirmação.',
      parameters: {
        type: 'object',
        properties: {
          limite: { type: 'integer', description: 'Quantidade (padrão: 10, máximo: 20)' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'cadastrar_paciente',
      description: 'Cadastra um novo paciente. ESCRITA — só chame após confirmação explícita do usuário.',
      parameters: {
        type: 'object',
        properties: {
          nome:            { type: 'string', description: 'Nome completo' },
          telefone:        { type: 'string', description: 'Telefone (somente números)' },
          email:           { type: 'string', description: 'E-mail (opcional)' },
          data_nascimento: { type: 'string', description: 'Data de nascimento YYYY-MM-DD (opcional)' }
        },
        required: ['nome']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'buscar_agenda_dia',
      description: 'Retorna os agendamentos de um dia. Leitura — não requer confirmação.',
      parameters: {
        type: 'object',
        properties: {
          data: { type: 'string', description: 'Data YYYY-MM-DD (omitir = hoje)' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'criar_agendamento',
      description: 'Cria um novo agendamento. ESCRITA — só chame após confirmação explícita do usuário.',
      parameters: {
        type: 'object',
        properties: {
          nome:         { type: 'string',  description: 'Nome do paciente' },
          paciente_id:  { type: 'integer', description: 'ID do paciente (se conhecido)' },
          telefone:     { type: 'string',  description: 'Telefone do paciente' },
          data:         { type: 'string',  description: 'Data YYYY-MM-DD' },
          horario:      { type: 'string',  description: 'Horário HH:MM' },
          procedimento: { type: 'string',  description: 'Procedimento ou motivo da consulta' }
        },
        required: ['nome', 'data', 'horario']
      }
    }
  }
];

// ══════════════════════════════════════════════
// SYSTEM PROMPT
// ══════════════════════════════════════════════
function buildSystemPrompt(ctx) {
  const clinicName  = String(ctx?.clinicName  || 'Clínica').slice(0, 80);
  const dentistName = String(ctx?.dentistName || 'Profissional').slice(0, 60);
  const today = new Date().toLocaleDateString('pt-BR', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
  });

  return `Você é a Assistente Operacional do RWDent — sistema de gestão odontológica da ${clinicName} (${dentistName}).
Data de hoje: ${today}.

Você conversa naturalmente E executa ações reais no sistema usando ferramentas.

FERRAMENTAS DISPONÍVEIS:
• buscar_paciente     → busca paciente por nome ou telefone
• listar_pacientes    → lista pacientes cadastrados
• cadastrar_paciente  → cadastra novo paciente  ⚠️ REQUER CONFIRMAÇÃO
• buscar_agenda_dia   → mostra agenda do dia
• criar_agendamento   → cria agendamento         ⚠️ REQUER CONFIRMAÇÃO

REGRAS OBRIGATÓRIAS:
1. Para LEITURA (buscar, listar, agenda): execute direto, sem pedir confirmação.
2. Para ESCRITA (cadastrar, criar): SEMPRE apresente os dados e aguarde "sim"/"pode"/"confirmo" ANTES de chamar a ferramenta.
3. Se o usuário disser "não", "cancela" ou "para": NÃO execute.
4. Se faltar informação para criar/cadastrar: pergunte antes de chamar a ferramenta.

EXEMPLO DE FLUXO CORRETO:
Usuário: "cadastra a Maria, tel 99982706186"
Você: "Posso cadastrar:\n• Nome: Maria\n• Telefone: 99982706186\n\nConfirma?"  ← NÃO chama ferramenta
Usuário: "sim"
Você: [chama cadastrar_paciente]  ← SÓ agora executa
Você: "Paciente Maria cadastrada com sucesso! ✅"

Responda sempre em português do Brasil. Seja breve, direto e humano.`;
}

// ══════════════════════════════════════════════
// EXECUÇÃO DAS FERRAMENTAS
// ══════════════════════════════════════════════
async function runTool(name, args, sb, clinicId) {
  switch (name) {

    case 'buscar_paciente': {
      const q = String(args.query || '').trim().slice(0, 100);
      if (!q) return 'Informe um nome ou telefone para buscar.';
      const { data, error } = await sb
        .from('pacientes')
        .select('id, nome, telefone, email')
        .eq('clinica_id', clinicId)
        .or(`nome.ilike.%${q}%,telefone.ilike.%${q}%`)
        .order('nome')
        .limit(10);
      if (error) throw new Error(error.message);
      if (!data?.length) return `Nenhum paciente encontrado para "${q}".`;
      return `${data.length} resultado(s):\n` +
        data.map(p => `• [ID:${p.id}] ${p.nome} | ${p.telefone || 'sem telefone'}`).join('\n');
    }

    case 'listar_pacientes': {
      const lim = Math.min(Math.max(Number(args.limite) || 10, 1), 20);
      const { data, error } = await sb
        .from('pacientes')
        .select('id, nome, telefone')
        .eq('clinica_id', clinicId)
        .order('nome')
        .limit(lim);
      if (error) throw new Error(error.message);
      if (!data?.length) return 'Nenhum paciente cadastrado ainda.';
      return `${data.length} paciente(s):\n` +
        data.map(p => `• ${p.nome} | ${p.telefone || 'sem telefone'}`).join('\n');
    }

    case 'cadastrar_paciente': {
      const nome = String(args.nome || '').trim().slice(0, 200);
      if (!nome) throw new Error('Nome do paciente é obrigatório.');
      const { data, error } = await sb
        .from('pacientes')
        .insert([{
          nome,
          telefone:        args.telefone        ? String(args.telefone).replace(/\D/g, '').slice(0, 20) : null,
          email:           args.email           ? String(args.email).slice(0, 200) : null,
          data_nascimento: args.data_nascimento || null,
          clinica_id: clinicId
        }])
        .select('id, nome, telefone')
        .single();
      if (error) throw new Error(error.message);
      return `✅ Paciente "${data.nome}" cadastrado(a) com sucesso! (ID: ${data.id})`;
    }

    case 'buscar_agenda_dia': {
      const dataBusca = args.data || new Date().toISOString().split('T')[0];
      const { data, error } = await sb
        .from('agendamentos')
        .select('id, nome, horario, procedimento, prof_nome, obs')
        .eq('clinica_id', clinicId)
        .eq('data', dataBusca)
        .order('horario');
      if (error) throw new Error(error.message);
      if (!data?.length) return `Nenhum agendamento para ${dataBusca}.`;
      const linhas = data.map(a => {
        const st = a.obs?.includes('AGSTATUS:confirmado') ? 'confirmado'
                 : a.obs?.includes('AGSTATUS:realizado')  ? 'realizado'
                 : 'agendado';
        return `• ${a.horario} — ${a.nome} | ${a.procedimento || 'Consulta'} [${st}]`;
      });
      return `Agenda de ${dataBusca} — ${data.length} consulta(s):\n${linhas.join('\n')}`;
    }

    case 'criar_agendamento': {
      const nome    = String(args.nome    || '').trim().slice(0, 200);
      const data    = String(args.data    || '').trim();
      const horario = String(args.horario || '').trim();
      if (!nome || !data || !horario) throw new Error('Nome, data e horário são obrigatórios.');

      // Busca o profissional principal da clínica
      const { data: profs } = await sb
        .from('profissionais')
        .select('id, nome, cor')
        .eq('clinica_id', clinicId)
        .order('id')
        .limit(1);
      const prof = profs?.[0];

      const { data: ag, error } = await sb
        .from('agendamentos')
        .insert([{
          nome,
          paciente_id:  args.paciente_id || null,
          telefone:     args.telefone ? String(args.telefone).replace(/\D/g, '') : null,
          data,
          horario,
          procedimento: args.procedimento ? String(args.procedimento).slice(0, 200) : 'Consulta',
          obs:          '',
          prof_id:      prof?.id   || null,
          prof_nome:    prof?.nome || null,
          prof_cor:     prof?.cor  || '#d4735a',
          clinica_id:   clinicId
        }])
        .select('id, nome, data, horario')
        .single();
      if (error) throw new Error(error.message);
      return `✅ Agendamento criado! ${ag.nome} — ${ag.data} às ${ag.horario}.`;
    }

    default:
      return `Ferramenta "${name}" não reconhecida.`;
  }
}

// ══════════════════════════════════════════════
// HANDLER PRINCIPAL
// ══════════════════════════════════════════════
module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido.' });
  if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: 'Serviço indisponível.' });

  const { messages, context, accessToken } = req.body || {};

  if (!Array.isArray(messages) || messages.length === 0)
    return res.status(400).json({ error: 'Requisição inválida.' });

  // ── Verificar autenticação e obter clinicId ──
  let clinicId   = null;
  let authedSb   = null;

  if (accessToken && process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
    try {
      authedSb = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_ANON_KEY,
        { global: { headers: { Authorization: `Bearer ${accessToken}` } } }
      );
      const { data: { user }, error: authErr } = await authedSb.auth.getUser();
      if (!authErr && user) {
        const { data: cli } = await authedSb
          .from('clinicas')
          .select('id')
          .eq('user_id', user.id)
          .eq('status', 'aprovado')
          .single();
        if (cli) clinicId = cli.id;
      }
    } catch (_) {}
  }

  // Monta histórico para OpenAI
  const history = messages
    .slice(-MAX_HISTORY)
    .filter(m => m && ['user', 'assistant'].includes(m.role) && typeof m.content === 'string')
    .map(m => ({ role: m.role, content: m.content.slice(0, MAX_CONTENT_LEN) }));

  if (!history.length || history[history.length - 1].role !== 'user')
    return res.status(400).json({ error: 'Requisição inválida.' });

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  // Ferramentas só disponíveis se autenticado
  const tools = (clinicId && authedSb) ? TOOLS : undefined;

  let oaiMessages = [
    { role: 'system', content: buildSystemPrompt(context) },
    ...history
  ];

  try {
    let rounds = 0;
    let response;

    // Loop de tool calling (OpenAI pode encadear múltiplas ferramentas)
    while (rounds++ < MAX_TOOL_ROUNDS) {
      response = await openai.chat.completions.create({
        model:        'gpt-4o-mini',
        messages:     oaiMessages,
        tools,
        tool_choice:  tools ? 'auto' : undefined,
        max_tokens:   500,
        temperature:  0.3
      });

      const choice = response.choices[0];
      if (choice.finish_reason !== 'tool_calls') break;

      // Adiciona resposta do assistente (com tool_calls)
      oaiMessages.push(choice.message);

      // Executa cada ferramenta e adiciona resultado
      for (const tc of (choice.message.tool_calls || [])) {
        let result;
        try {
          if (!clinicId || !authedSb) {
            result = 'Erro: sessão expirada. Recarregue a página.';
          } else {
            const args = JSON.parse(tc.function.arguments || '{}');
            result = await runTool(tc.function.name, args, authedSb, clinicId);
          }
        } catch (e) {
          result = `Erro: ${e.message}`;
        }
        oaiMessages.push({ role: 'tool', tool_call_id: tc.id, content: result });
      }
    }

    const reply = response.choices[0].message.content?.trim() || 'Ação executada.';
    return res.status(200).json({ reply });

  } catch (err) {
    console.error('AI error:', err?.message || err);
    return res.status(500).json({ error: 'Erro ao processar. Tente novamente.' });
  }
};
