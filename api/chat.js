const { OpenAI }       = require('openai');
const { createClient } = require('@supabase/supabase-js');

const GROQ_MODEL      = 'llama-3.1-8b-instant';
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

REGRAS:
1. listar e buscar: execute imediatamente, sem pedir confirmação.
2. cadastrar: SEMPRE apresente os dados e aguarde "sim"/"pode"/"confirmo" ANTES de chamar a ferramenta.
3. Se faltar o nome para cadastrar, pergunte antes.
4. Se houver pacientes com nomes parecidos ao buscar, liste as opções.
5. Nunca apague dados. Nunca acesse dados de outras clínicas.

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
      if (!data?.length) return 'Nenhum paciente cadastrado ainda.';
      return `${data.length} paciente(s):\n` +
        data.map(p => `• ${p.nome} | ${p.telefone || 'sem telefone'}`).join('\n');
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
      if (!data?.length) return `Nenhum paciente encontrado para "${q}".`;
      return `${data.length} resultado(s):\n` +
        data.map(p => `• [ID:${p.id}] ${p.nome} | ${p.telefone || 'sem telefone'}`).join('\n');
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
      return `✅ Paciente "${data.nome}" cadastrado com sucesso! (ID: ${data.id})`;
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
  if (!process.env.GROQ_API_KEY)  return res.status(500).json({ error: 'Serviço de IA não configurado.' });

  const { messages, context } = req.body || {};

  if (!Array.isArray(messages) || messages.length === 0)
    return res.status(400).json({ error: 'Requisição inválida.' });

  // ── Autenticação via Authorization: Bearer <token> ──
  const authHeader  = req.headers['authorization'] || '';
  const accessToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';

  let clinicId = null;
  let authedSb = null;

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

  // ── Histórico ──
  const history = messages
    .slice(-MAX_HISTORY)
    .filter(m => m && ['user', 'assistant'].includes(m.role) && typeof m.content === 'string')
    .map(m => ({ role: m.role, content: m.content.slice(0, MAX_CONTENT_LEN) }));

  if (!history.length || history[history.length - 1].role !== 'user')
    return res.status(400).json({ error: 'Requisição inválida.' });

  const withTools = !!(clinicId && authedSb);

  const groq = new OpenAI({
    apiKey:  process.env.GROQ_API_KEY,
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
          result = `Erro: ${e.message}`;
        }
        console.log(`[AI] tool=${tc.function.name} ok`);
        oaiMessages.push({ role: 'tool', tool_call_id: tc.id, content: result });
      }
    }

    const reply = response.choices[0].message.content?.trim() || 'Ação executada.';
    return res.status(200).json({ reply });

  } catch (err) {
    const detail = err?.message || String(err);
    console.error(`[AI] provider=groq model=${GROQ_MODEL} erro: ${detail}`);
    return res.status(500).json({ error: 'Serviço de IA temporariamente indisponível. Tente novamente.' });
  }
};
