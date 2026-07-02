const { OpenAI }       = require('openai');
const { createClient } = require('@supabase/supabase-js');

const GROQ_MODEL      = 'llama-3.3-70b-versatile';
const MAX_HISTORY     = 10;
const MAX_CONTENT_LEN = 600;
const MAX_TOOL_ROUNDS = 4;

// ══════════════════════════════════════════════
// FERRAMENTAS (3 ativas: listar, buscar, cadastrar)
// ══════════════════════════════════════════════
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'listar_pacientes',
      description: 'Lista os pacientes cadastrados na clínica. Leitura — execute direto, sem confirmação.',
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
      name: 'buscar_paciente',
      description: 'Busca pacientes por nome ou telefone. Leitura — execute direto, sem confirmação.',
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
      name: 'cadastrar_paciente',
      description: 'Cadastra um novo paciente. ESCRITA — só chame após o usuário confirmar com "sim", "pode" ou "confirmo".',
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

  return `Você é a assistente do RWDent para a clínica "${clinicName}" (${dentistName}).
Data de hoje: ${today}.

FERRAMENTAS DISPONÍVEIS:
• listar_pacientes   → lista pacientes (leitura, execute direto)
• buscar_paciente    → busca por nome ou telefone (leitura, execute direto)
• cadastrar_paciente → cadastra novo paciente (⚠️ ESCRITA — exige confirmação)

REGRAS OBRIGATÓRIAS:
1. NUNCA invente, suponha ou fabrique nomes de pacientes, telefones ou qualquer dado do banco. Se não tiver acesso às ferramentas, diga isso claramente.
2. Só execute listar_pacientes quando o usuário pedir claramente para listar/ver/mostrar pacientes.
3. Só execute buscar_paciente quando o usuário pedir claramente para procurar/buscar/encontrar um paciente específico.
4. Perguntas de capacidade, como "você consegue agendar?", "dá para marcar consulta?" ou "você faz procedimento?", devem ser respondidas em texto, sem chamar ferramentas.
5. Agendamento, Google Agenda, procedimentos, financeiro e estoque AINDA NÃO têm ferramenta ativa. Se perguntarem, explique que por enquanto você orienta como fazer no sistema e que a automação ainda será implementada.
6. cadastrar: SEMPRE apresente os dados e aguarde "sim"/"pode"/"confirmo" ANTES de chamar a ferramenta.
7. Se faltar o nome para cadastrar, pergunte antes.
8. Se houver pacientes com nomes parecidos ao buscar, liste as opções reais retornadas pela ferramenta.
9. Nunca apague dados. Nunca acesse dados de outras clínicas.

Responda sempre em português do Brasil. Seja breve e direto.`;
}

// ══════════════════════════════════════════════
// EXECUÇÃO DAS FERRAMENTAS
// ══════════════════════════════════════════════
async function runTool(name, args, sb, clinicId) {
  switch (name) {

    case 'listar_pacientes': {
      const lim = Math.min(Math.max(Number(args.limite) || 10, 1), 20);
      const { data, error } = await sb
        .from('pacientes')
        .select('id, nome, telefone')
        .eq('clinica_id', clinicId)
        .order('nome')
        .limit(lim);
      if (error) throw new Error(error.message);
      if (!data?.length) return JSON.stringify({
        tool: name,
        ok: true,
        kind: 'patient_list',
        total: 0,
        message: 'Nenhum paciente cadastrado ainda.',
        patients: []
      });
      return JSON.stringify({
        tool: name,
        ok: true,
        kind: 'patient_list',
        total: data.length,
        limit: lim,
        patients: data.map(p => ({
          id: p.id,
          nome: p.nome,
          telefone: p.telefone || null
        }))
      });
    }

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
      if (!data?.length) return JSON.stringify({
        tool: name,
        ok: true,
        kind: 'patient_search',
        query: q,
        total: 0,
        message: `Nenhum paciente encontrado para "${q}".`,
        patients: []
      });
      return JSON.stringify({
        tool: name,
        ok: true,
        kind: 'patient_search',
        query: q,
        total: data.length,
        patients: data.map(p => ({
          id: p.id,
          nome: p.nome,
          telefone: p.telefone || null,
          email: p.email || null
        }))
      });
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
          clinica_id:      clinicId
        }])
        .select('id, nome, telefone')
        .single();
      if (error) throw new Error(error.message);
      return JSON.stringify({
        tool: name,
        ok: true,
        kind: 'patient_created',
        patient: {
          id: data.id,
          nome: data.nome,
          telefone: data.telefone || null
        }
      });
    }

    default:
      return `Ferramenta "${name}" não reconhecida.`;
  }
}

function parseToolResult(raw) {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : { ok: true, message: String(raw || '') };
  } catch {
    return { ok: true, message: String(raw || '') };
  }
}

function formatPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return 'sem telefone';
  if (digits.length === 11) return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`;
  if (digits.length === 10) return `(${digits.slice(0, 2)}) ${digits.slice(2, 6)}-${digits.slice(6)}`;
  return digits;
}

function formatToolReply(outputs) {
  const last = outputs[outputs.length - 1];
  if (!last) return null;

  const data = last.data || {};
  const patients = Array.isArray(data.patients) ? data.patients : [];

  if (data.kind === 'patient_list') {
    if (!patients.length) return data.message || 'Nenhum paciente cadastrado ainda.';
    const lines = patients.map((p, idx) => `${idx + 1}. ${p.nome} - ${formatPhone(p.telefone)}`);
    const suffix = data.total >= data.limit ? '\n\nMostrando os primeiros pacientes da lista.' : '';
    return `Encontrei estes pacientes:\n\n${lines.join('\n')}${suffix}`;
  }

  if (data.kind === 'patient_search') {
    if (!patients.length) return data.message || `Nenhum paciente encontrado para "${data.query || 'sua busca'}".`;
    const lines = patients.map((p, idx) => {
      const email = p.email ? ` - ${p.email}` : '';
      return `${idx + 1}. ${p.nome} - ${formatPhone(p.telefone)}${email}`;
    });
    return `Resultado da busca por "${data.query || 'paciente'}":\n\n${lines.join('\n')}`;
  }

  if (data.kind === 'patient_created' && data.patient) {
    return `Paciente cadastrado com sucesso:\n\n${data.patient.nome} - ${formatPhone(data.patient.telefone)}`;
  }

  if (data.message) return data.message;
  return null;
}

// ══════════════════════════════════════════════
// HANDLER PRINCIPAL
// ══════════════════════════════════════════════
module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido.' });
  if (!process.env.GROQ_API_KEY)  return res.status(500).json({ error: 'Serviço de IA não configurado.' });

  const { messages, context } = req.body || {};

  if (!Array.isArray(messages) || messages.length === 0)
    return res.status(400).json({ error: 'Requisição inválida.' });

  // ── Autenticação via Authorization: Bearer <token> ──
  const authHeader  = req.headers['authorization'] || '';
  const accessToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';

  let clinicId = null;
  let authedSb = null;

  // Remove caracteres fora do ASCII imprimível (bullets copiados acidentalmente de dashboards)
  const cleanStr = s => String(s || '').replace(/[^\x20-\x7E]/g, '').trim();
  const supabaseUrl  = cleanStr(process.env.SUPABASE_URL);
  const supabaseAnon = cleanStr(process.env.SUPABASE_ANON_KEY);
  const cleanToken   = cleanStr(accessToken);

  if (!cleanToken) {
    console.log('[AI] auth: sem token');
  } else if (!supabaseUrl || !supabaseAnon) {
    console.log('[AI] auth: variáveis Supabase ausentes');
  } else {
    try {
      // Valida o JWT e obtém o user_id real
      const sbAnon = createClient(supabaseUrl, supabaseAnon);
      const { data: { user }, error: authErr } = await sbAnon.auth.getUser(cleanToken);
      if (authErr) {
        console.log(`[AI] auth error: ${authErr.message}`);
      } else if (!user) {
        console.log('[AI] auth: nenhum usuário para o token');
      } else {
        console.log(`[AI] auth ok: user=${user.id}`);
        // Cria cliente com o token do usuário para respeitar RLS
        authedSb = createClient(supabaseUrl, supabaseAnon, {
          global: { headers: { Authorization: `Bearer ${cleanToken}` } }
        });
        // Filtra explicitamente por user_id para garantir isolamento entre clínicas
        const { data: cli, error: cliErr } = await authedSb
          .from('clinicas')
          .select('id')
          .eq('user_id', user.id)
          .eq('status', 'aprovado')
          .single();
        if (cliErr) {
          console.log(`[AI] clinica error: ${cliErr.message}`);
        } else if (cli) {
          clinicId = cli.id;
          console.log(`[AI] clinicId=${clinicId}`);
        } else {
          console.log('[AI] clinica: não encontrada');
        }
      }
    } catch (e) {
      console.log(`[AI] auth exception: ${e.message}`);
    }
  }

  // ── Histórico ──
  const history = messages
    .slice(-MAX_HISTORY)
    .filter(m => m && ['user', 'assistant'].includes(m.role) && typeof m.content === 'string')
    .map(m => ({ role: m.role, content: m.content.slice(0, MAX_CONTENT_LEN) }));

  if (!history.length || history[history.length - 1].role !== 'user')
    return res.status(400).json({ error: 'Requisição inválida.' });

  const withTools = !!(clinicId && authedSb);

  const groqKey = String(process.env.GROQ_API_KEY || '').replace(/[^\x20-\x7E]/g, '').trim();
  const groq = new OpenAI({
    apiKey:  groqKey,
    baseURL: 'https://api.groq.com/openai/v1'
  });

  let oaiMessages = [
    { role: 'system', content: buildSystemPrompt(context) },
    ...history
  ];

  console.log(`[AI] provider=groq model=${GROQ_MODEL} tools=${withTools} clinic=${clinicId}`);

  try {
    let rounds = 0;
    let response;
    const toolOutputs = [];

    while (rounds++ < MAX_TOOL_ROUNDS) {
      response = await groq.chat.completions.create({
        model:       GROQ_MODEL,
        messages:    oaiMessages,
        tools:       withTools ? TOOLS : undefined,
        tool_choice: withTools ? 'auto' : undefined,
        max_tokens:  400,
        temperature: 0.3
      });

      const choice = response.choices[0];
      if (choice.finish_reason !== 'tool_calls') break;

      oaiMessages.push(choice.message);

      for (const tc of (choice.message.tool_calls || [])) {
        let result;
        try {
          if (!clinicId || !authedSb) {
            result = 'Sessão expirada. Peça ao usuário para recarregar a página.';
          } else {
            const args = JSON.parse(tc.function.arguments || '{}');
            result = await runTool(tc.function.name, args, authedSb, clinicId);
          }
        } catch (e) {
          result = JSON.stringify({ tool: tc.function.name, ok: false, message: `Erro: ${e.message}` });
        }
        console.log(`[AI] tool=${tc.function.name} ok`);
        toolOutputs.push({ name: tc.function.name, data: parseToolResult(result) });
        oaiMessages.push({ role: 'tool', tool_call_id: tc.id, content: result });
      }
    }

    const toolReply = formatToolReply(toolOutputs);
    if (toolReply) return res.status(200).json({ reply: toolReply });

    const reply = response.choices[0].message.content?.trim() || 'Ação executada.';
    return res.status(200).json({ reply });

  } catch (err) {
    const detail = err?.message || String(err);
    console.error(`[AI] provider=groq model=${GROQ_MODEL} erro: ${detail}`);
    return res.status(500).json({ error: 'Serviço de IA temporariamente indisponível. Tente novamente.' });
  }
};
