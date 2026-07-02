const { createClient } = require('@supabase/supabase-js');

const GEMINI_MODEL = 'gemini-2.0-flash-lite';
const GEMINI_URL   = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const MAX_HISTORY     = 10;
const MAX_CONTENT_LEN = 600;
const MAX_TOOL_ROUNDS = 4;

// ══════════════════════════════════════════════
// FERRAMENTAS (3 ativas: listar, buscar, cadastrar)
// ══════════════════════════════════════════════
const FUNCTION_DECLARATIONS = [
  {
    name: 'listar_pacientes',
    description: 'Lista os pacientes cadastrados na clínica. Leitura — não requer confirmação.',
    parameters: {
      type: 'object',
      properties: {
        limite: { type: 'integer', description: 'Quantidade (padrão: 10, máximo: 20)' }
      }
    }
  },
  {
    name: 'buscar_paciente',
    description: 'Busca pacientes por nome ou telefone. Leitura — não requer confirmação.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Nome (parcial) ou telefone do paciente' }
      },
      required: ['query']
    }
  },
  {
    name: 'cadastrar_paciente',
    description: 'Cadastra um novo paciente. ESCRITA — só chame após confirmação explícita do usuário (sim/pode/confirmo).',
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
• listar_pacientes  → lista pacientes da clínica (leitura, execute direto)
• buscar_paciente   → busca por nome ou telefone (leitura, execute direto)
• cadastrar_paciente → cadastra novo paciente (⚠️ ESCRITA — exige confirmação)

REGRAS:
1. listar e buscar: execute imediatamente sem pedir confirmação.
2. cadastrar: SEMPRE apresente os dados ("Vou cadastrar:\n• Nome: X\n• Tel: Y\nConfirma?") e aguarde "sim"/"pode"/"confirmo" antes de chamar a ferramenta.
3. Se faltar o nome do paciente, pergunte antes de cadastrar.
4. Se encontrar pacientes com nomes parecidos ao buscar, liste as opções.
5. Nunca apague dados. Nunca acesse dados de outras clínicas.

Responda em português do Brasil. Seja breve e direto.`;
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
// CHAMADA GEMINI REST NATIVA
// ══════════════════════════════════════════════
async function callGemini(apiKey, payload) {
  const resp = await fetch(GEMINI_URL, {
    method:  'POST',
    headers: {
      'Content-Type':   'application/json',
      'x-goog-api-key': apiKey
    },
    body: JSON.stringify(payload)
  });

  if (!resp.ok) {
    let body = '';
    try { body = await resp.text(); } catch (_) {}

    // Detecta chave inválida explicitamente
    if (resp.status === 400 && (body.includes('API_KEY_INVALID') || body.includes('API key not valid'))) {
      throw new Error('GEMINI_KEY_INVALID');
    }
    throw new Error(`HTTP ${resp.status}${body ? ': ' + body.slice(0, 200) : ''}`);
  }

  return resp.json();
}

// ══════════════════════════════════════════════
// HANDLER PRINCIPAL
// ══════════════════════════════════════════════
module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido.' });
  if (!process.env.GEMINI_API_KEY) return res.status(500).json({ error: 'Serviço de IA não configurado.' });

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

  // ── Histórico em formato Gemini (role: "user"/"model") ──
  const contents = messages
    .slice(-MAX_HISTORY)
    .filter(m => m && ['user', 'assistant'].includes(m.role) && typeof m.content === 'string')
    .map(m => ({
      role:  m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content.slice(0, MAX_CONTENT_LEN) }]
    }));

  if (!contents.length || contents[contents.length - 1].role !== 'user')
    return res.status(400).json({ error: 'Requisição inválida.' });

  const withTools = !!(clinicId && authedSb);

  const payload = {
    system_instruction: { parts: [{ text: buildSystemPrompt(context) }] },
    contents,
    generationConfig: { maxOutputTokens: 400, temperature: 0.25 }
  };

  if (withTools) {
    payload.tools = [{ function_declarations: FUNCTION_DECLARATIONS }];
  }

  console.log(`[AI] provider=gemini model=${GEMINI_MODEL} tools=${withTools} clinic=${clinicId}`);

  try {
    let rounds = 0;
    let geminiData;

    while (rounds++ < MAX_TOOL_ROUNDS) {
      geminiData = await callGemini(process.env.GEMINI_API_KEY, payload);

      const candidate = geminiData.candidates?.[0];
      if (!candidate) throw new Error('Resposta vazia do modelo.');

      const parts    = candidate.content?.parts || [];
      const fnCalls  = parts.filter(p => p.functionCall);

      if (!fnCalls.length) break;

      // Acrescenta resposta do modelo (com functionCalls) ao histórico
      payload.contents.push({ role: 'model', parts });

      // Executa ferramentas e envia respostas
      const responseParts = [];
      for (const part of fnCalls) {
        const { name, args } = part.functionCall;
        let result;
        try {
          if (!clinicId || !authedSb) {
            result = 'Sessão expirada. Peça ao usuário para recarregar a página.';
          } else {
            result = await runTool(name, args || {}, authedSb, clinicId);
          }
        } catch (e) {
          result = `Erro na ferramenta: ${e.message}`;
        }
        console.log(`[AI] tool=${name} ok`);
        responseParts.push({ functionResponse: { name, response: { content: result } } });
      }

      // Gemini espera role "user" para respostas de função
      payload.contents.push({ role: 'user', parts: responseParts });
    }

    const finalParts = geminiData.candidates?.[0]?.content?.parts || [];
    const reply = finalParts.find(p => p.text)?.text?.trim() || 'Ação executada.';
    return res.status(200).json({ reply });

  } catch (err) {
    const detail = err?.message || String(err);
    if (detail === 'GEMINI_KEY_INVALID') {
      console.error('[AI] GEMINI_KEY_INVALID — verifique a variável GEMINI_API_KEY na Vercel');
      return res.status(500).json({ error: 'Chave da IA inválida. Verifique a variável GEMINI_API_KEY na Vercel.' });
    }
    console.error(`[AI] provider=gemini model=${GEMINI_MODEL} erro: ${detail}`);
    return res.status(500).json({ error: 'Serviço de IA temporariamente indisponível. Tente novamente.' });
  }
};
