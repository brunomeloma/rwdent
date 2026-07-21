const { OpenAI }       = require('openai');
const { createClient } = require('@supabase/supabase-js');

// Corrente de provedores/modelos: tenta na ordem; qualquer falha (cota,
// capacidade, modelo inexistente, chave inválida daquele provedor) cai para
// o próximo. GROQ_MODEL (env) tem prioridade. GEMINI_API_KEY (opcional)
// adiciona o Gemini gratuito no fim — cobre quando a cota da Groq esgota.
function montarCandidatos(clients){
  const c = [];
  // Groq descontinua modelos com frequência (kimi-k2-instruct-0905 caiu em
  // 23/03/2026, llama-3.3-70b-versatile e qwen/qwen3-32b caíram em
  // 17/06/2026 — todos com o mesmo substituto recomendado pela própria Groq:
  // openai/gpt-oss-120b, hoje o modelo "produção" estável deles). Confirmado
  // em console.groq.com/docs/deprecations em jul/2026.
  if (clients.groq) {
    if (process.env.GROQ_MODEL) c.push({ prov:'groq', model: process.env.GROQ_MODEL.trim() });
    c.push({ prov:'groq', model:'openai/gpt-oss-120b' });
    c.push({ prov:'groq', model:'openai/gpt-oss-20b' });
  }
  // Cerebras: gratuito com limites folgados. O catálogo de modelos da
  // Cerebras muda com o tempo — confirmado ao vivo em jul/2026 via
  // cloud.cerebras.ai/.../playground (botão "View Code") que o modelo
  // disponível na conta é gpt-oss-120b (não mais llama-3.3-70b, que
  // passou a dar 404). gpt-oss-120b tem suporte nativo forte a tool calling.
  if (clients.cerebras) {
    c.push({ prov:'cerebras', model:'gpt-oss-120b' });
  }
  // OpenRouter: agregador com variantes gratuitas
  if (clients.openrouter) {
    c.push({ prov:'openrouter', model:'meta-llama/llama-3.3-70b-instruct:free' });
  }
  if (clients.gemini) {
    c.push({ prov:'gemini', model:'gemini-2.0-flash' });
    c.push({ prov:'gemini', model:'gemini-1.5-flash' });
  }
  return c;
}
let _candIdx = 0; // cache por instância: pula candidatos que já falharam
const MAX_HISTORY     = 14;
const MAX_CONTENT_LEN = 900;
const MAX_TOOL_ROUNDS = 4;

// Rate limit em memória, por instância da function (best-effort — reseta a
// cada cold start e não é compartilhado entre instâncias). Serve como
// segunda camada de defesa contra abuso vindo de um único usuário
// autenticado; a cota dos provedores de IA continua sendo o limite real.
const RATE_LIMIT_WINDOW_MS = 60000;
const RATE_LIMIT_MAX_REQ   = 12;
const _rateBuckets = new Map();
function isRateLimited(userId) {
  const now = Date.now();
  const hits = (_rateBuckets.get(userId) || []).filter(t => now - t < RATE_LIMIT_WINDOW_MS);
  hits.push(now);
  _rateBuckets.set(userId, hits);
  // Evita crescimento ilimitado do Map em instâncias de longa duração
  if (_rateBuckets.size > 500) {
    const oldest = _rateBuckets.keys().next().value;
    _rateBuckets.delete(oldest);
  }
  return hits.length > RATE_LIMIT_MAX_REQ;
}

// gpt-oss é modelo de raciocínio (pensa antes de responder). Para um
// assistente de tarefas simples (agenda/paciente/preço), esforço "low" já
// basta e corta bastante a latência — evita estourar o tempo da function
// (FUNCTION_INVOCATION_TIMEOUT visto em produção com o esforço padrão).
function _paramsExtra(model){
  return model.includes('gpt-oss') ? { reasoning_effort: 'low' } : {};
}

// chat.completions.create com fallback de provedor/modelo
async function aiCreate(clients, params){
  const candidatos = montarCandidatos(clients);
  if (!candidatos.length) throw new Error('Nenhum provedor de IA configurado.');
  if (_candIdx >= candidatos.length) _candIdx = candidatos.length - 1;
  const falhas = [];
  let ultimoErr = null;
  for (let i = _candIdx; i < candidatos.length; i++) {
    const { prov, model } = candidatos[i];
    try {
      const resp = await clients[prov].chat.completions.create({ ...params, ..._paramsExtra(model), model });
      _candIdx = i;
      return { resp, model: `${prov}/${model}` };
    } catch (err) {
      ultimoErr = err;
      falhas.push(`${prov}/${model}:${err?.status||'?'}`);
      console.log(`[AI] ${prov}/${model} falhou (${err?.status||''} ${String(err?.message||'').slice(0,140)})`);
      // 429 não avança o cache permanente (cota renova); os demais avançam
      if (err?.status !== 429) _candIdx = Math.min(i + 1, candidatos.length - 1);
    }
  }
  // Último recurso (exceto cota esgotada em tudo): último candidato sem tools
  if (params.tools && ultimoErr?.status !== 429) {
    try {
      const semTools = { ...params };
      delete semTools.tools; delete semTools.tool_choice;
      const { prov, model } = candidatos[candidatos.length - 1];
      const resp = await clients[prov].chat.completions.create({ ...semTools, ..._paramsExtra(model), model });
      console.log(`[AI] respondeu SEM ferramentas após falhas: ${falhas.join(' ')}`);
      return { resp, model: `${prov}/${model} (sem tools)` };
    } catch (err2) {
      falhas.push(`sem-tools:${err2?.status||'?'}`);
    }
  }
  ultimoErr = ultimoErr || new Error('Nenhum modelo disponível.');
  ultimoErr.falhas = falhas.join(' ');
  throw ultimoErr;
}

// ══════════════════════════════════════════════
// FERRAMENTAS (4 ativas: listar, buscar, cadastrar, agendar)
// ══════════════════════════════════════════════
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'listar_pacientes',
      description: 'Lista os pacientes cadastrados na clínica. Leitura — execute direto, sem confirmação.',
      parameters: {
        type: 'object',
        additionalProperties: false,
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
        additionalProperties: false,
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
        additionalProperties: false,
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
      name: 'registrar_venda_avulsa',
      description: 'Lança no faturamento um valor recebido sem cadastro/prontuário na clínica — ex: paciente de outra dentista que só passou pra um procedimento pontual, ou uma cobrança na maquininha (InfinitePay etc.) onde só se sabe o valor e a forma de pagamento, sem nome nem procedimento. Nome e procedimento são opcionais. Não cria paciente nem prontuário, só entra no financeiro. ESCRITA — só chame após o usuário confirmar com "sim", "pode" ou "confirmo".',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          paciente_nome:    { type: 'string', description: 'Nome do paciente, se souber (opcional — não precisa estar cadastrado)' },
          procedimento:     { type: 'string', description: 'Procedimento realizado, se souber, ex: "Profilaxia", "Restauração" (opcional)' },
          valor:            { type: 'number', description: 'Valor cobrado em reais' },
          forma_pagamento:  { type: 'string', enum: ['pix','dinheiro','debito','credito'], description: 'Forma de pagamento (padrão: pix)' },
          parcelas:         { type: 'integer', description: 'Número de parcelas, só se crédito (padrão: 1)' },
          profissional:     { type: 'string', description: 'Nome do profissional que atendeu, se informado (opcional)' },
          data:             { type: 'string', description: 'Data do atendimento YYYY-MM-DD (padrão: hoje)' }
        },
        required: ['valor']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'ver_agenda',
      description: 'Mostra os agendamentos da clínica em uma data ou período. Leitura — execute direto, sem confirmação.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          data:     { type: 'string', description: 'Data inicial YYYY-MM-DD (padrão: hoje)' },
          data_fim: { type: 'string', description: 'Data final YYYY-MM-DD para período (opcional)' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'horarios_livres',
      description: 'Lista horários livres para agendar em uma data (08:00-18:00, blocos de 30min). Leitura — execute direto.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          data: { type: 'string', description: 'Data YYYY-MM-DD' },
          profissional_id: { type: 'integer', description: 'ID do profissional (opcional; usa o principal)' }
        },
        required: ['data']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'aniversariantes_mes',
      description: 'Lista pacientes que fazem aniversário no mês. Leitura — execute direto.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          mes: { type: 'integer', description: 'Mês 1-12 (padrão: mês atual)' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'retornos_atrasados',
      description: 'Lista pacientes sem consulta há X meses e sem agendamento futuro (recall). Leitura — execute direto.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          meses: { type: 'integer', description: 'Meses sem visita (padrão: 6)' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'ficha_paciente',
      description: 'Resumo do paciente: contato, próxima consulta, última visita e últimos atendimentos. Leitura — execute direto.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          paciente_query: { type: 'string', description: 'Nome ou telefone do paciente' }
        },
        required: ['paciente_query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'remarcar_consulta',
      description: 'Muda a data/horário de uma consulta existente. ESCRITA — só chame após o usuário confirmar com "sim", "pode" ou "confirmo".',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          paciente_query: { type: 'string', description: 'Nome ou telefone do paciente' },
          data_atual:     { type: 'string', description: 'Data atual da consulta YYYY-MM-DD (se o paciente tiver mais de uma)' },
          nova_data:      { type: 'string', description: 'Nova data YYYY-MM-DD' },
          novo_horario:   { type: 'string', description: 'Novo horário HH:MM' }
        },
        required: ['paciente_query', 'nova_data', 'novo_horario']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'cancelar_consulta',
      description: 'Marca uma consulta como cancelada (não apaga o registro). ESCRITA — só chame após o usuário confirmar com "sim", "pode" ou "confirmo".',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          paciente_query: { type: 'string', description: 'Nome ou telefone do paciente' },
          data:           { type: 'string', description: 'Data da consulta YYYY-MM-DD (se o paciente tiver mais de uma)' }
        },
        required: ['paciente_query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'agendar_consulta',
      description: 'Cria um agendamento na agenda da clínica. ESCRITA — só chame após o usuário confirmar com "sim", "pode" ou "confirmo".',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          paciente_query: { type: 'string', description: 'Nome ou telefone do paciente a agendar' },
          data:           { type: 'string', description: 'Data da consulta em YYYY-MM-DD' },
          horario:        { type: 'string', description: 'Horário em HH:MM, 24 horas' },
          procedimento:   { type: 'string', description: 'Procedimento ou motivo da consulta' },
          profissional_id:{ type: 'integer', description: 'ID do profissional, se o usuário informar' },
          observacoes:    { type: 'string', description: 'Observações opcionais' }
        },
        required: ['paciente_query', 'data', 'horario']
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
  const procedures = normalizeProcedureContext(ctx?.procedures);
  const today = new Date().toLocaleDateString('pt-BR', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'America/Sao_Paulo'
  });

  return `Você é a assistente do RWDent para a clínica "${clinicName}" (${dentistName}).
Data de hoje: ${today}.

VOCÊ TAMBÉM É SUPORTE DO SISTEMA RWDENT:
• Responda dúvidas de uso do site de forma prática, como "onde agendo?", "como faço orçamento?", "onde vejo odontograma?", "como cadastro paciente?".
• Se o usuário fizer pergunta de continuação ("e onde eu agendo tal coisa?"), use o histórico da conversa para entender o contexto.
• Oriente por caminho de tela, nome de botão e aba, sem inventar botão que não existe.
• Pode explicar fluxos e localização das telas. Não precisa ferramenta para dúvidas de uso.

GUIA RÁPIDO DAS TELAS:
• Agendar consulta: menu Agenda > Novo Agendamento, ou no prontuário do paciente botão "Agendar". Escolha paciente, profissional, data, horário, procedimento e confirme.
• Ver agenda: menu Agenda > Agenda do Dia ou Calendário.
• Pacientes: menu Pacientes. Busque pelo nome; abra o paciente para ver Dados, Anamnese, Histórico, Odontograma, Plano, Orçamentos, Realizados, Financeiro, Termo, Galeria e Timeline.
• Odontograma: Pacientes > abrir paciente > aba Odontograma. Clique no desenho do dente para abrir o painel do dente; clique nos quadradinhos das faces para marcar Tratado/Não tratado/limpar.
• Tecidos moles e duros: Pacientes > abrir paciente > Odontograma > subaba Tecidos moles e duros.
• Periodontia: Pacientes > abrir paciente > Odontograma > subaba Periodontia. Toque em S1-S6 e selecione procedimentos periodontais, se necessário.
• Orçamento: Pacientes > abrir paciente > aba Odontograma ou aba Orçamentos. No odontograma use "Orçamento rápido" / "Montar orçamento"; no orçamento do paciente você pode adicionar itens, aprovar, consolidar e enviar por WhatsApp.
• Procedimentos e preços: menu Financeiro > Procedimentos. A IA pode informar preço de procedimento se ele estiver na lista segura abaixo.
• Realizados/histórico clínico: Pacientes > abrir paciente > Realizados ou Histórico.
• Galeria: Pacientes > abrir paciente > Galeria para fotos, radiografias e antes/depois.

LIMITES DE PRIVACIDADE E FINANCEIRO:
• Não informe faturamento, lucro, vendas, recebimentos, dívidas, caixa, relatórios financeiros, materiais/estoque ou dados sensíveis da clínica.
• Se perguntarem sobre dinheiro da clínica, diga que não pode consultar essa parte e oriente a usar as telas Financeiro/Vendas/Relatórios.
• Exceção permitida: você pode informar PREÇOS DE PROCEDIMENTOS da lista segura enviada pelo sistema.

PROCEDIMENTOS/PREÇOS DISPONÍVEIS PARA CONSULTA:
${procedures || 'Nenhuma lista de procedimentos foi enviada nesta conversa. Se perguntarem preço, oriente a abrir Financeiro > Procedimentos.'}

FERRAMENTAS DISPONÍVEIS:
• listar_pacientes    → lista pacientes (leitura, execute direto)
• buscar_paciente     → busca por nome ou telefone (leitura, execute direto)
• ver_agenda          → agendamentos de uma data ou período (leitura, execute direto). "O que tenho hoje/amanhã/semana?"
• horarios_livres     → horários vagos de um dia para agendar (leitura, execute direto)
• aniversariantes_mes → aniversariantes do mês (leitura, execute direto)
• retornos_atrasados  → pacientes sem retorno há X meses, recall (leitura, execute direto)
• ficha_paciente      → resumo do paciente: contato, próxima consulta, última visita, atendimentos (leitura, execute direto)
• cadastrar_paciente  → cadastra novo paciente (⚠️ ESCRITA — exige confirmação)
• agendar_consulta    → cria consulta/agendamento (⚠️ ESCRITA — exige confirmação)
• remarcar_consulta   → muda data/horário de consulta existente (⚠️ ESCRITA — exige confirmação)
• cancelar_consulta   → marca consulta como cancelada, sem apagar (⚠️ ESCRITA — exige confirmação)
• registrar_venda_avulsa → lança no faturamento um valor recebido de paciente sem cadastro/prontuário, ex: "entrou uma paciente da outra dentista, cobrei 150 de profilaxia no pix" (⚠️ ESCRITA — exige confirmação). Não cadastra paciente nem cria prontuário. Se o usuário pedir vários valores de uma vez (ex: "adiciona 250, 500 e 1000"), depois de confirmado chame essa ferramenta uma vez pra cada valor na mesma resposta — não precisa fazer um por vez em mensagens separadas.

Converta SEMPRE datas relativas ("hoje", "amanhã", "sexta", "semana que vem") para YYYY-MM-DD usando a data de hoje acima antes de chamar as ferramentas de agenda. Para "esta semana", use data + data_fim.${ctx?.currentPatient ? `

PACIENTE ABERTO NA TELA AGORA: ${String(ctx.currentPatient).slice(0,120)}
Se o usuário disser "ele", "ela", "esse paciente" ou pedir algo sem citar nome, assuma que é este paciente.` : ''}

REGRAS OBRIGATÓRIAS:
1. NUNCA invente, suponha ou fabrique nomes de pacientes, telefones ou qualquer dado do banco. Se não tiver acesso às ferramentas, diga isso claramente.
2. Só execute listar_pacientes quando o usuário pedir claramente para listar/ver/mostrar pacientes.
3. Só execute buscar_paciente quando o usuário pedir claramente para procurar/buscar/encontrar um paciente específico PELO NOME OU TELEFONE dele. NUNCA use buscar_paciente nem listar_pacientes para perguntas sobre procedimento, tratamento ou preço — nomes de procedimento (ex: "profilaxia", "canal", "clareamento") NÃO são nomes de paciente.
3.1. Exemplo errado: usuário pergunta "qual o preço da profilaxia?" → NÃO chame buscar_paciente(query="profilaxia"). Certo: responda direto com o valor da lista de PROCEDIMENTOS/PREÇOS abaixo, sem chamar nenhuma ferramenta.
4. Perguntas de capacidade, como "você consegue agendar?" ou "dá para marcar consulta?", devem ser respondidas dizendo que sim, você consegue agendar pacientes cadastrados depois de receber paciente, data, horário e confirmação.
5. Agendar/cadastrar são ações de escrita: SEMPRE apresente os dados e aguarde "sim"/"pode"/"confirmo" ANTES de chamar a ferramenta.
6. Para agendar, colete no mínimo paciente, data e horário. Se faltar algum, pergunte antes. Use procedimento "Consulta" se o usuário não informar.
6.1. Ao chamar agendar_consulta, converta datas relativas ("hoje", "amanhã", "sexta") para YYYY-MM-DD usando a data de hoje acima e horário HH:MM.
7. Se o paciente não for encontrado ou houver vários pacientes parecidos, use os dados reais retornados pela ferramenta e peça para o usuário escolher.
8. Google Agenda direto AINDA NÃO tem OAuth conectado. Depois de agendar, forneça o link gerado para adicionar ao Google Agenda.
9. Procedimentos/preços: use apenas a lista segura "PROCEDIMENTOS/PREÇOS" acima. Não invente preço. Se não encontrar, diga para conferir em Financeiro > Procedimentos.
9.1. Financeiro, vendas, faturamento, lucro, caixa e estoque não têm consulta permitida pela IA; apenas oriente onde ficam.
10. Nunca apague dados. Nunca acesse dados de outras clínicas.

Responda sempre em português do Brasil. Seja breve e direto.`;
}

function normalizeProcedureContext(value) {
  if (!Array.isArray(value)) return '';
  const rows = value
    .filter(p => p && typeof p.nome === 'string')
    .slice(0, 120)
    .map(p => {
      const nome = String(p.nome || '').replace(/\s+/g, ' ').trim().slice(0, 120);
      const grupo = String(p.grupo || 'Procedimentos').replace(/\s+/g, ' ').trim().slice(0, 80);
      const preco = Number(p.precoFinal ?? p.preco ?? 0);
      const tipo = String(p.tipo_cobranca || '').replace(/\s+/g, ' ').trim().slice(0, 30);
      if (!nome) return '';
      const precoTxt = Number.isFinite(preco) && preco > 0
        ? preco.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
        : 'sem preço definido';
      return `• ${nome} — ${precoTxt} (${grupo}${tipo ? ', ' + tipo : ''})`;
    })
    .filter(Boolean);
  return rows.join('\n').slice(0, 4000);
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
      // Remove caracteres que quebram a sintaxe de filtro do PostgREST
      const q = String(args.query || '').replace(/[,()%]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
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
      const telefoneDigits = args.telefone ? String(args.telefone).replace(/\D/g, '').slice(0, 20) : '';

      // Idempotência: se o mesmo telefone já foi cadastrado (ex.: a resposta
      // do cadastro anterior se perdeu por timeout e o cliente reenviou a
      // mesma confirmação), devolve o paciente existente em vez de criar
      // um registro duplicado.
      if (telefoneDigits) {
        const { data: existente } = await sb
          .from('pacientes')
          .select('id, nome, telefone')
          .eq('clinica_id', clinicId)
          .eq('telefone', telefoneDigits)
          .limit(1);
        if (existente?.length) {
          return JSON.stringify({
            tool: name,
            ok: true,
            kind: 'patient_created',
            jaExistia: true,
            patient: { id: existente[0].id, nome: existente[0].nome, telefone: existente[0].telefone || null }
          });
        }
      }

      const { data, error } = await sb
        .from('pacientes')
        .insert([{
          nome,
          telefone:        telefoneDigits || null,
          email:           args.email           ? String(args.email).slice(0, 200) : null,
          nascimento:      args.data_nascimento || null,
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

    case 'registrar_venda_avulsa': {
      const nomePac = String(args.paciente_nome || '').trim().slice(0, 200) || 'Não identificado';
      const proc    = String(args.procedimento || '').trim().slice(0, 200) || 'Recebimento avulso';
      const valor   = Number(args.valor);
      if (!Number.isFinite(valor) || valor <= 0) throw new Error('Informe um valor válido.');

      const formaRaw = String(args.forma_pagamento || 'pix').toLowerCase();
      const forma = ['pix', 'dinheiro', 'debito', 'credito'].includes(formaRaw) ? formaRaw : 'pix';
      const parcelas = forma === 'credito' ? Math.min(12, Math.max(1, Number(args.parcelas) || 1)) : 1;
      const dataStr = normalizeDate(args.data) || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });

      let profId = null, profNome = '';
      if (args.profissional) {
        const { data: profsEnc } = await sb.from('profissionais').select('id, nome')
          .eq('clinica_id', clinicId).ilike('nome', `%${String(args.profissional).replace(/[,()%]/g,' ').slice(0, 100)}%`).limit(1);
        if (profsEnc?.length) { profId = profsEnc[0].id; profNome = profsEnc[0].nome; }
      }

      // vendas vive como JSON dentro de financeiro_config (não é tabela normal) —
      // por isso lê, adiciona e grava só essa coluna (update parcial, não mexe
      // em procs/mats/estoque/cfg que também moram nessa mesma linha).
      const { data: fc, error: fcErr } = await sb.from('financeiro_config').select('vendas').eq('clinica_id', clinicId).single();
      if (fcErr) throw new Error(fcErr.message);
      let vendasAtuais = [];
      try { vendasAtuais = JSON.parse(fc?.vendas || '[]'); } catch { vendasAtuais = []; }
      const nextId = vendasAtuais.length ? Math.max(...vendasAtuais.map(v => Number(v.id) || 0)) + 1 : 1;
      const isoData = new Date(dataStr + 'T12:00:00').toISOString();

      const novaVenda = {
        id: nextId, status: 'finalizada', origem: 'avulso',
        formaPagamento: forma, parcelas,
        pacienteId: null, pacienteNome: nomePac,
        itens: [{ procId: null, qtd: 1, nome: proc, precoUnit: valor, dente: '', descDente: '' }],
        subtotal: valor, desconto: 0, entrada: 0, restante: 0, total: valor,
        obs: 'Lançado via assistente de IA',
        profissional_id: profId, profissional_nome: profNome,
        data: isoData, dataFinal: isoData,
        pagamentos: [{ id: Date.now(), valor, forma, parcelas_cartao: parcelas, data: new Date().toISOString(), obs: 'Lançamento avulso (IA)' }]
      };
      vendasAtuais.push(novaVenda);

      const { error: updErr } = await sb.from('financeiro_config')
        .update({ vendas: JSON.stringify(vendasAtuais) }).eq('clinica_id', clinicId);
      if (updErr) throw new Error(updErr.message);

      return JSON.stringify({
        tool: name, ok: true, kind: 'sale_created',
        venda: { nome: nomePac, procedimento: proc, valor, forma_pagamento: forma, profissional: profNome || null, data: dataStr }
      });
    }

    case 'ver_agenda': {
      const hoje = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
      const ini = normalizeDate(args.data) || hoje;
      const fim = normalizeDate(args.data_fim) || ini;
      const { data, error } = await sb
        .from('agendamentos')
        .select('nome, data, horario, procedimento, prof_nome')
        .eq('clinica_id', clinicId)
        .gte('data', ini).lte('data', fim)
        .order('data').order('horario')
        .limit(30);
      if (error) throw new Error(error.message);
      return JSON.stringify({
        tool: name, ok: true, kind: 'agenda_list',
        inicio: ini, fim, total: (data||[]).length,
        agendamentos: (data||[]).map(a => ({
          nome: a.nome, data: a.data, horario: (a.horario||'').slice(0,5),
          procedimento: a.procedimento || 'Consulta', prof: a.prof_nome || ''
        }))
      });
    }

    case 'horarios_livres': {
      const data = normalizeDate(args.data);
      if (!data) throw new Error('Informe a data no formato YYYY-MM-DD.');
      const prof = await findProfessional(sb, clinicId, args.profissional_id);
      if (!prof) throw new Error('Nenhum profissional cadastrado.');
      const { data: ags, error } = await sb
        .from('agendamentos')
        .select('horario')
        .eq('clinica_id', clinicId).eq('prof_id', prof.id).eq('data', data);
      if (error) throw new Error(error.message);
      const ocupados = new Set((ags||[]).map(a => (a.horario||'').slice(0,5)));
      const livres = [];
      for (let h = 8; h < 18; h++) {
        for (const m of ['00','30']) {
          const slot = `${String(h).padStart(2,'0')}:${m}`;
          if (!ocupados.has(slot)) livres.push(slot);
        }
      }
      return JSON.stringify({
        tool: name, ok: true, kind: 'free_slots',
        data, profissional: prof.nome, ocupados: ocupados.size, livres
      });
    }

    case 'aniversariantes_mes': {
      const mesAtual = Number(new Date().toLocaleDateString('en-CA',{timeZone:'America/Sao_Paulo'}).slice(5,7));
      const mes = Math.min(12, Math.max(1, Number(args.mes) || mesAtual));
      const { data, error } = await sb
        .from('pacientes')
        .select('nome, telefone, nascimento')
        .eq('clinica_id', clinicId)
        .not('nascimento', 'is', null)
        .limit(500);
      if (error) throw new Error(error.message);
      const lista = (data||[])
        .filter(p => Number(String(p.nascimento).slice(5,7)) === mes)
        .map(p => ({ nome: p.nome, telefone: p.telefone || null, dia: Number(String(p.nascimento).slice(8,10)) }))
        .sort((a,b) => a.dia - b.dia)
        .slice(0, 30);
      return JSON.stringify({ tool: name, ok: true, kind: 'birthday_list', mes, total: lista.length, aniversariantes: lista });
    }

    case 'retornos_atrasados': {
      const meses = Math.min(24, Math.max(1, Number(args.meses) || 6));
      const hoje = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
      const corte = new Date(Date.now() - meses * 2629800000).toISOString().slice(0,10);
      const { data: ags, error } = await sb
        .from('agendamentos')
        .select('paciente_id, nome, telefone, data')
        .eq('clinica_id', clinicId)
        .order('data', { ascending: false })
        .limit(1500);
      if (error) throw new Error(error.message);
      const porPac = new Map();
      (ags||[]).forEach(a => {
        if (!a.paciente_id) return;
        const cur = porPac.get(a.paciente_id);
        if (!cur) porPac.set(a.paciente_id, { nome: a.nome, telefone: a.telefone || null, ultima: a.data, temFuturo: a.data >= hoje });
        else {
          if (a.data > cur.ultima) cur.ultima = a.data;
          if (a.data >= hoje) cur.temFuturo = true;
        }
      });
      const lista = [...porPac.values()]
        .filter(p => !p.temFuturo && p.ultima && p.ultima < corte)
        .sort((a,b) => a.ultima.localeCompare(b.ultima))
        .slice(0, 20);
      return JSON.stringify({ tool: name, ok: true, kind: 'recall_list', meses, total: lista.length, pacientes: lista });
    }

    case 'ficha_paciente': {
      const q = String(args.paciente_query || '').trim();
      if (!q) throw new Error('Informe o paciente.');
      const patients = await findPatients(sb, clinicId, q);
      if (!patients.length) return JSON.stringify({ tool: name, ok: false, message: `Nenhum paciente encontrado para "${q}".` });
      if (patients.length > 1) return JSON.stringify({ tool: name, ok: false, kind: 'appointment_patient_ambiguous', query: q, patients });
      const pac = patients[0];
      const hoje = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
      const [{ data: dados }, { data: futuras }, { data: passadas }, { data: atends }] = await Promise.all([
        sb.from('pacientes').select('nome, telefone, email, nascimento').eq('clinica_id', clinicId).eq('id', pac.id).single(),
        sb.from('agendamentos').select('data, horario, procedimento, prof_nome').eq('clinica_id', clinicId).eq('paciente_id', pac.id).gte('data', hoje).order('data').order('horario').limit(2),
        sb.from('agendamentos').select('data, horario, procedimento').eq('clinica_id', clinicId).eq('paciente_id', pac.id).lt('data', hoje).order('data', { ascending: false }).limit(1),
        sb.from('atendimentos_odonto').select('data, procedimentos').eq('clinica_id', clinicId).eq('paciente_id', pac.id).order('data', { ascending: false }).limit(3)
      ]);
      return JSON.stringify({
        tool: name, ok: true, kind: 'patient_profile',
        paciente: {
          nome: dados?.nome || pac.nome, telefone: dados?.telefone || pac.telefone || null,
          email: dados?.email || null, data_nascimento: dados?.nascimento || null
        },
        proximas: (futuras||[]).map(a => ({ data: a.data, horario: (a.horario||'').slice(0,5), procedimento: a.procedimento || 'Consulta', prof: a.prof_nome || '' })),
        ultima_visita: passadas?.[0] ? { data: passadas[0].data, procedimento: passadas[0].procedimento || 'Consulta' } : null,
        atendimentos: (atends||[]).map(a => ({ data: a.data, procedimentos: String(a.procedimentos||'').slice(0,120) }))
      });
    }

    case 'remarcar_consulta': {
      const q = String(args.paciente_query || '').trim();
      const novaData = normalizeDate(args.nova_data);
      const novoHorario = normalizeTime(args.novo_horario);
      if (!q) throw new Error('Informe o paciente.');
      if (!novaData || !novoHorario) throw new Error('Informe a nova data (YYYY-MM-DD) e o novo horário (HH:MM).');
      const alvo = await findAppointment(sb, clinicId, q, normalizeDate(args.data_atual));
      if (alvo.erro) return alvo.erro;
      const ag = alvo.ag;
      // Conflito no novo horário (mesmo profissional)
      const { data: conflito } = await sb.from('agendamentos').select('id, nome')
        .eq('clinica_id', clinicId).eq('prof_id', ag.prof_id).eq('data', novaData).eq('horario', novoHorario).neq('id', ag.id).limit(1);
      if (conflito?.length) return JSON.stringify({
        tool: name, ok: false,
        message: `${formatDateBR(novaData)} às ${novoHorario} já está ocupado (${conflito[0].nome}). Escolha outro horário — posso listar os livres.`
      });
      const deAntes = { data: ag.data, horario: (ag.horario||'').slice(0,5) };
      const { error } = await sb.from('agendamentos').update({ data: novaData, horario: novoHorario }).eq('id', ag.id).eq('clinica_id', clinicId);
      if (error) throw new Error(error.message);
      return JSON.stringify({
        tool: name, ok: true, kind: 'appointment_rescheduled',
        appointment: { nome: ag.nome, de: deAntes, para: { data: novaData, horario: novoHorario }, procedimento: ag.procedimento || 'Consulta', prof_nome: ag.prof_nome || '',
          google_calendar_url: buildGoogleCalendarUrl({ nome: ag.nome, data: novaData, horario: novoHorario, procedimento: ag.procedimento, prof_nome: ag.prof_nome, obs: '' }) }
      });
    }

    case 'cancelar_consulta': {
      const q = String(args.paciente_query || '').trim();
      if (!q) throw new Error('Informe o paciente.');
      const alvo = await findAppointment(sb, clinicId, q, normalizeDate(args.data));
      if (alvo.erro) return alvo.erro;
      const ag = alvo.ag;
      // Status vive dentro de obs, no mesmo marcador que o app usa — sem apagar nada
      const novoObs = buildObsComStatus(ag.obs, 'cancelado');
      const { error } = await sb.from('agendamentos').update({ obs: novoObs }).eq('id', ag.id).eq('clinica_id', clinicId);
      if (error) throw new Error(error.message);
      return JSON.stringify({
        tool: name, ok: true, kind: 'appointment_cancelled',
        appointment: { nome: ag.nome, data: ag.data, horario: (ag.horario||'').slice(0,5), procedimento: ag.procedimento || 'Consulta' }
      });
    }

    case 'agendar_consulta': {
      const pacienteQuery = String(args.paciente_query || '').trim().slice(0, 120);
      const data = normalizeDate(args.data);
      const horario = normalizeTime(args.horario);
      const procedimento = String(args.procedimento || 'Consulta').trim().slice(0, 160) || 'Consulta';
      const obs = String(args.observacoes || '').trim().slice(0, 500);

      if (!pacienteQuery) throw new Error('Informe o paciente para agendar.');
      if (!data) throw new Error('Informe a data no formato YYYY-MM-DD.');
      if (!horario) throw new Error('Informe o horário no formato HH:MM.');

      const patients = await findPatients(sb, clinicId, pacienteQuery);
      if (!patients.length) return JSON.stringify({
        tool: name,
        ok: false,
        kind: 'appointment_patient_not_found',
        message: `Não encontrei paciente para "${pacienteQuery}". Cadastre o paciente primeiro ou informe outro nome/telefone.`
      });
      if (patients.length > 1) return JSON.stringify({
        tool: name,
        ok: false,
        kind: 'appointment_patient_ambiguous',
        query: pacienteQuery,
        patients
      });

      const paciente = patients[0];
      const prof = await findProfessional(sb, clinicId, args.profissional_id);
      if (!prof) throw new Error('Nenhum profissional cadastrado para criar o agendamento.');

      const { data: conflito, error: conflictError } = await sb
        .from('agendamentos')
        .select('id, nome, data, horario, prof_nome')
        .eq('clinica_id', clinicId)
        .eq('prof_id', prof.id)
        .eq('data', data)
        .eq('horario', horario)
        .limit(1);
      if (conflictError) throw new Error(conflictError.message);
      if (conflito?.length) return JSON.stringify({
        tool: name,
        ok: false,
        kind: 'appointment_conflict',
        appointment: conflito[0],
        message: `Já existe agendamento para ${prof.nome} em ${formatDateBR(data)} às ${horario}.`
      });

      const { data: novo, error } = await sb
        .from('agendamentos')
        .insert([{
          paciente_id: paciente.id,
          nome: paciente.nome,
          telefone: paciente.telefone || '',
          prof_id: prof.id,
          prof_nome: prof.nome,
          prof_cor: prof.cor || '#d4735a',
          data,
          horario,
          procedimento,
          obs,
          clinica_id: clinicId
        }])
        .select('id, paciente_id, nome, telefone, prof_id, prof_nome, data, horario, procedimento, obs')
        .single();
      if (error) throw new Error(error.message);

      return JSON.stringify({
        tool: name,
        ok: true,
        kind: 'appointment_created',
        appointment: {
          id: novo.id,
          nome: novo.nome,
          telefone: novo.telefone || null,
          prof_nome: novo.prof_nome,
          data: novo.data,
          horario: novo.horario,
          procedimento: novo.procedimento || 'Consulta',
          obs: novo.obs || '',
          google_calendar_url: buildGoogleCalendarUrl(novo)
        }
      });
    }

    default:
      return `Ferramenta "${name}" não reconhecida.`;
  }
}

// Status do agendamento vive na coluna obs entre marcadores (mesma convenção do app)
const AG_ST_INI = '<!--AGSTATUS:';
const AG_ST_FIM = ':AGSTATUS-->';
function buildObsComStatus(obsRaw, status) {
  const raw = String(obsRaw || '');
  const i = raw.indexOf(AG_ST_INI), j = raw.indexOf(AG_ST_FIM);
  const texto = (i !== -1 && j > i) ? (raw.slice(0, i) + raw.slice(j + AG_ST_FIM.length)).trim() : raw.trim();
  return texto + (texto ? '\n' : '') + AG_ST_INI + status + AG_ST_FIM;
}
function agStatusDe(obsRaw) {
  const raw = String(obsRaw || '');
  const i = raw.indexOf(AG_ST_INI), j = raw.indexOf(AG_ST_FIM);
  return (i !== -1 && j > i) ? raw.slice(i + AG_ST_INI.length, j) : '';
}

// Localiza UMA consulta futura do paciente (para remarcar/cancelar).
// Retorna {ag} ou {erro: JSON-string com lista para o usuário escolher}.
async function findAppointment(sb, clinicId, pacienteQuery, dataFiltro) {
  const patients = await findPatients(sb, clinicId, pacienteQuery);
  if (!patients.length) return { erro: JSON.stringify({ ok: false, message: `Nenhum paciente encontrado para "${pacienteQuery}".` }) };
  if (patients.length > 1) return { erro: JSON.stringify({ ok: false, kind: 'appointment_patient_ambiguous', query: pacienteQuery, patients }) };
  const pac = patients[0];
  const hoje = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
  let query = sb.from('agendamentos')
    .select('id, nome, telefone, prof_id, prof_nome, data, horario, procedimento, obs')
    .eq('clinica_id', clinicId).eq('paciente_id', pac.id)
    .order('data').order('horario').limit(10);
  query = dataFiltro ? query.eq('data', dataFiltro) : query.gte('data', hoje);
  const { data: ags, error } = await query;
  if (error) throw new Error(error.message);
  const ativos = (ags || []).filter(a => agStatusDe(a.obs).toLowerCase() !== 'cancelado');
  if (!ativos.length) return { erro: JSON.stringify({ ok: false, message: `${pac.nome} não tem consulta ${dataFiltro ? 'em ' + formatDateBR(dataFiltro) : 'futura'} para alterar.` }) };
  if (ativos.length > 1) return { erro: JSON.stringify({
    ok: false, kind: 'appointment_choose', paciente: pac.nome,
    consultas: ativos.map(a => ({ data: a.data, horario: (a.horario||'').slice(0,5), procedimento: a.procedimento || 'Consulta' }))
  }) };
  return { ag: ativos[0] };
}

async function findPatients(sb, clinicId, query) {
  const q = String(query || '').trim();
  const digits = q.replace(/\D/g, '');
  const filters = [`nome.ilike.%${q.replace(/[,()%]/g, ' ')}%`];
  if (digits) filters.push(`telefone.ilike.%${digits}%`);

  const { data, error } = await sb
    .from('pacientes')
    .select('id, nome, telefone')
    .eq('clinica_id', clinicId)
    .or(filters.join(','))
    .order('nome')
    .limit(10);
  if (error) throw new Error(error.message);

  const rows = data || [];
  const exact = rows.filter(p =>
    String(p.nome || '').toLowerCase() === q.toLowerCase() ||
    (digits && String(p.telefone || '').replace(/\D/g, '') === digits)
  );
  const chosen = exact.length === 1 ? exact : rows;
  return chosen.map(p => ({ id: p.id, nome: p.nome, telefone: p.telefone || null }));
}

async function findProfessional(sb, clinicId, profissionalId) {
  let query = sb
    .from('profissionais')
    .select('id, nome, cor, principal')
    .eq('clinica_id', clinicId);

  if (profissionalId) {
    query = query.eq('id', Number(profissionalId));
  } else {
    query = query.order('principal', { ascending: false }).order('id');
  }

  const { data, error } = await query.limit(1);
  if (error) throw new Error(error.message);
  return data?.[0] || null;
}

function normalizeDate(value) {
  const s = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}

function normalizeTime(value) {
  const m = String(value || '').trim().match(/^(\d{1,2}):(\d{2})/);
  if (!m) return '';
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return '';
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

function formatDateBR(isoDate) {
  const [y, m, d] = String(isoDate || '').split('-');
  return y && m && d ? `${d}/${m}/${y}` : String(isoDate || '');
}

function buildGoogleCalendarUrl(appointment) {
  const data = String(appointment.data || '');
  const horario = String(appointment.horario || '00:00');
  const [ano, mes, dia] = data.split('-');
  const [hh, mm] = horario.split(':');
  const start = `${ano}${mes}${dia}T${String(hh).padStart(2, '0')}${String(mm).padStart(2, '0')}00`;
  const endHour = Math.min((Number(hh) || 0) + 1, 23);
  const end = `${ano}${mes}${dia}T${String(endHour).padStart(2, '0')}${String(mm).padStart(2, '0')}00`;
  const title = encodeURIComponent(`${appointment.procedimento || 'Consulta'} - ${appointment.nome || 'Paciente'}`);
  const details = encodeURIComponent(`Paciente: ${appointment.nome || ''}\nProfissional: ${appointment.prof_nome || ''}\n${appointment.obs ? 'Observações: ' + appointment.obs : ''}`);
  return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${title}&dates=${start}/${end}&details=${details}&ctz=America/Sao_Paulo`;
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
  // Vários lançamentos avulsos na mesma mensagem (ex: "adiciona 250, 500 e
  // 1000") viram várias chamadas da mesma ferramenta numa resposta só — sem
  // isso, só o último lançamento apareceria na resposta pro usuário, mesmo
  // com todos já salvos.
  const vendasCriadas = outputs.filter(o => o?.data?.kind === 'sale_created' && o.data.venda);
  if (vendasCriadas.length > 1) {
    const linhas = vendasCriadas.map(o => {
      const v = o.data.venda;
      const valorTxt = Number(v.valor).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
      return `• ${v.nome} — ${v.procedimento} — ${valorTxt} via ${v.forma_pagamento}`;
    });
    const total = vendasCriadas
      .reduce((s, o) => s + (Number(o.data.venda.valor) || 0), 0)
      .toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    return `${vendasCriadas.length} lançamentos adicionados ao faturamento! ✅\n\n${linhas.join('\n')}\n\nTotal: ${total}`;
  }

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
    if (data.jaExistia) return `Esse paciente já estava cadastrado:\n\n${data.patient.nome} - ${formatPhone(data.patient.telefone)}`;
    return `Paciente cadastrado com sucesso:\n\n${data.patient.nome} - ${formatPhone(data.patient.telefone)}`;
  }

  if (data.kind === 'agenda_list') {
    const ags = Array.isArray(data.agendamentos) ? data.agendamentos : [];
    const periodo = data.inicio === data.fim ? formatDateBR(data.inicio) : `${formatDateBR(data.inicio)} a ${formatDateBR(data.fim)}`;
    if (!ags.length) return `Nenhum agendamento em ${periodo}. Agenda livre! 🎉`;
    const porData = {};
    ags.forEach(a => { (porData[a.data] = porData[a.data] || []).push(a); });
    const blocos = Object.keys(porData).sort().map(d => {
      const linhas = porData[d].map(a => `${a.horario} — ${a.nome} (${a.procedimento}${a.prof ? ', ' + a.prof.split(' ')[0] + ' ' + (a.prof.split(' ')[1]||'') : ''})`);
      return (data.inicio === data.fim ? '' : `*${formatDateBR(d)}*\n`) + linhas.join('\n');
    });
    return `Agenda de ${periodo} — ${ags.length} consulta(s):\n\n${blocos.join('\n\n')}`;
  }

  if (data.kind === 'free_slots') {
    const livres = Array.isArray(data.livres) ? data.livres : [];
    if (!livres.length) return `Nenhum horário livre em ${formatDateBR(data.data)} para ${data.profissional}. Dia lotado!`;
    return `Horários livres em ${formatDateBR(data.data)} (${data.profissional}):\n\n${livres.join('  ·  ')}\n\nQuer que eu agende algum? Me diga o paciente e o horário.`;
  }

  if (data.kind === 'birthday_list') {
    const lst = Array.isArray(data.aniversariantes) ? data.aniversariantes : [];
    const nomesMes = ['','janeiro','fevereiro','março','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];
    if (!lst.length) return `Nenhum aniversariante em ${nomesMes[data.mes]||'este mês'}.`;
    const linhas = lst.map(p => `Dia ${String(p.dia).padStart(2,'0')} — ${p.nome} · ${formatPhone(p.telefone)}`);
    return `🎂 Aniversariantes de ${nomesMes[data.mes]||'este mês'}:\n\n${linhas.join('\n')}\n\nNa tela Início tem o botão de WhatsApp para enviar os parabéns.`;
  }

  if (data.kind === 'recall_list') {
    const lst = Array.isArray(data.pacientes) ? data.pacientes : [];
    if (!lst.length) return `Nenhum paciente sem retorno há mais de ${data.meses} meses. Tudo em dia! ✅`;
    const linhas = lst.map(p => `${p.nome} — última visita ${formatDateBR(p.ultima)} · ${formatPhone(p.telefone)}`);
    return `📞 Pacientes sem retorno há ${data.meses}+ meses:\n\n${linhas.join('\n')}\n\nNa tela Início, o card "Retornos atrasados" tem o WhatsApp pronto para chamá-los.`;
  }

  if (data.kind === 'appointment_patient_ambiguous') {
    const options = patients.map((p, idx) => `${idx + 1}. ${p.nome} - ${formatPhone(p.telefone)}`);
    return `Encontrei mais de um paciente parecido. Qual deles você quer agendar?\n\n${options.join('\n')}`;
  }

  if (data.kind === 'patient_profile' && data.paciente) {
    const p = data.paciente;
    const linhas = [`*${p.nome}*`, `📱 ${formatPhone(p.telefone)}${p.email ? ' · ' + p.email : ''}`];
    if (p.data_nascimento) linhas.push(`🎂 Nascimento: ${formatDateBR(p.data_nascimento)}`);
    if (data.proximas?.length) linhas.push(`\n📅 Próxima consulta: ${formatDateBR(data.proximas[0].data)} às ${data.proximas[0].horario} — ${data.proximas[0].procedimento}`);
    else linhas.push('\n📅 Sem consulta futura marcada.');
    if (data.ultima_visita) linhas.push(`🕐 Última visita: ${formatDateBR(data.ultima_visita.data)} (${data.ultima_visita.procedimento})`);
    if (data.atendimentos?.length) {
      linhas.push('\nÚltimos atendimentos:');
      data.atendimentos.forEach(a => linhas.push(`• ${formatDateBR(a.data)} — ${a.procedimentos}`));
    }
    return linhas.join('\n');
  }

  if (data.kind === 'appointment_choose') {
    const cs = (data.consultas||[]).map((c,i)=>`${i+1}. ${formatDateBR(c.data)} às ${c.horario} — ${c.procedimento}`);
    return `${data.paciente} tem mais de uma consulta marcada. Qual delas?\n\n${cs.join('\n')}\n\nMe diga a data da que você quer alterar.`;
  }

  if (data.kind === 'appointment_rescheduled' && data.appointment) {
    const a = data.appointment;
    const link = a.google_calendar_url ? `\n\nAdicionar ao Google Agenda:\n${a.google_calendar_url}` : '';
    return `Consulta remarcada! ✅\n\n${a.nome}\nDe: ${formatDateBR(a.de.data)} às ${a.de.horario}\nPara: *${formatDateBR(a.para.data)} às ${a.para.horario}*\n${a.procedimento} com ${a.prof_nome || 'profissional'}${link}`;
  }

  if (data.kind === 'appointment_cancelled' && data.appointment) {
    const a = data.appointment;
    return `Consulta cancelada. ❌\n\n${a.nome} — ${formatDateBR(a.data)} às ${a.horario} (${a.procedimento})\n\nO registro fica na agenda com status "cancelado" (nada é apagado). Quer remarcar para outra data?`;
  }

  if (data.kind === 'appointment_created' && data.appointment) {
    const a = data.appointment;
    const link = a.google_calendar_url ? `\n\nAdicionar ao Google Agenda:\n${a.google_calendar_url}` : '';
    return `Agendamento criado com sucesso:\n\n${a.nome}\n${formatDateBR(a.data)} às ${a.horario}\n${a.procedimento || 'Consulta'} com ${a.prof_nome || 'profissional'}${link}`;
  }

  if (data.kind === 'sale_created' && data.venda) {
    const v = data.venda;
    const valorTxt = Number(v.valor).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    const profTxt = v.profissional ? `\nProfissional: ${v.profissional}` : '';
    return `Lançado no faturamento! ✅\n\n${v.nome} — ${v.procedimento}\n${valorTxt} via ${v.forma_pagamento}${profTxt}\n${formatDateBR(v.data)}`;
  }

  // Mensagens que começam com "Erro:" vêm do catch técnico (ex.: exceção do
  // banco) — não mostra o texto cru para o usuário, troca por algo seguro.
  if (typeof data.message === 'string' && data.message.startsWith('Erro:'))
    return 'Não consegui concluir essa ação agora. Tente novamente em instantes ou confira manualmente na tela.';
  if (data.message) return data.message;
  return null;
}

// Resultado "vazio/negativo" (nada encontrado, ok:false) não carrega dado
// real para alucinar — nesses casos é seguro deixar o texto final do próprio
// modelo prevalecer (ele pode ter percebido que chamou a ferramenta errada,
// como buscar_paciente para uma pergunta de preço, e se corrigido na resposta).
// Resultado com dados reais (pacientes, agenda, criação/edição) SEMPRE usa a
// formatação determinística abaixo, para não arriscar o modelo inventar nomes,
// telefones, horários ou preços.
function _resultadoTemDadosReais(data) {
  if (!data) return false;
  // Estes "kind" carregam dados reais de paciente/consulta mesmo quando
  // ok:false (ex.: múltiplos pacientes encontrados, precisa escolher) — a
  // checagem tem que vir ANTES do "ok===false" abaixo, senão nunca dispara
  // e o modelo poderia parafrasear/inventar em cima de nomes reais.
  if (data.kind === 'patient_created' || data.kind === 'appointment_created' ||
      data.kind === 'appointment_rescheduled' || data.kind === 'appointment_cancelled' ||
      data.kind === 'patient_profile' || data.kind === 'appointment_choose' ||
      data.kind === 'appointment_patient_ambiguous' || data.kind === 'sale_created') return true;
  if (data.ok === false) return false;
  if (typeof data.total === 'number') return data.total > 0;
  if (Array.isArray(data.livres)) return data.livres.length > 0;
  return false;
}

function shouldRefreshApp(toolOutputs) {
  return toolOutputs.some(o => ['patient_created', 'appointment_created', 'appointment_rescheduled', 'appointment_cancelled', 'sale_created'].includes(o?.data?.kind));
}

// ══════════════════════════════════════════════
// HANDLER PRINCIPAL
// ══════════════════════════════════════════════
module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido.' });
  if (!process.env.GROQ_API_KEY && !process.env.CEREBRAS_API_KEY && !process.env.OPENROUTER_API_KEY && !process.env.GEMINI_API_KEY)
    return res.status(500).json({ error: 'Serviço de IA não configurado.' });

  const { messages, context } = req.body || {};

  if (!Array.isArray(messages) || messages.length === 0)
    return res.status(400).json({ error: 'Requisição inválida.' });

  // ── Autenticação via Authorization: Bearer <token> ──
  const authHeader  = req.headers['authorization'] || '';
  const accessToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';

  let clinicId = null;
  let authedSb = null;
  let userId = null;

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
        userId = user.id;
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

  // Endpoint exige login: sem isso, qualquer script externo poderia bater
  // aqui direto (sem passar pela UI) e consumir a cota gratuita da IA que é
  // compartilhada por todas as clínicas.
  if (!userId) {
    return res.status(401).json({ error: 'Faça login para usar o assistente.' });
  }

  // Rate limit best-effort por usuário (janela deslizante em memória do
  // processo). Não é distribuído entre instâncias serverless — é uma camada
  // extra além dos limites de cota dos provedores, não a defesa principal.
  if (isRateLimited(userId)) {
    return res.status(429).json({ error: 'Muitas mensagens em pouco tempo. Aguarde um instante.' });
  }

  // ── Histórico ──
  const history = messages
    .slice(-MAX_HISTORY)
    .filter(m => m && ['user', 'assistant'].includes(m.role) && typeof m.content === 'string')
    .map(m => ({ role: m.role, content: m.content.slice(0, MAX_CONTENT_LEN) }));

  if (!history.length || history[history.length - 1].role !== 'user')
    return res.status(400).json({ error: 'Requisição inválida.' });

  const withTools = !!(clinicId && authedSb);

  const _limpa = s => String(s || '').replace(/[^\x20-\x7E]/g, '').trim();
  const groqKey = _limpa(process.env.GROQ_API_KEY);
  const cerKey  = _limpa(process.env.CEREBRAS_API_KEY);
  const orKey   = _limpa(process.env.OPENROUTER_API_KEY);
  const gemKey  = _limpa(process.env.GEMINI_API_KEY);
  const clients = {};
  // Timeout curto por chamada: o SDK da OpenAI usa 10 minutos por padrão, o
  // que deixaria um provedor lento consumir sozinho todo o tempo da function
  // (60s no Vercel) sem nunca acionar o fallback para o próximo candidato.
  const PROVIDER_TIMEOUT_MS = 15000;
  if (groqKey) clients.groq       = new OpenAI({ apiKey: groqKey, baseURL: 'https://api.groq.com/openai/v1', timeout: PROVIDER_TIMEOUT_MS, maxRetries: 0 });
  if (cerKey)  clients.cerebras   = new OpenAI({ apiKey: cerKey,  baseURL: 'https://api.cerebras.ai/v1', timeout: PROVIDER_TIMEOUT_MS, maxRetries: 0 });
  if (orKey)   clients.openrouter = new OpenAI({ apiKey: orKey,   baseURL: 'https://openrouter.ai/api/v1', timeout: PROVIDER_TIMEOUT_MS, maxRetries: 0 });
  if (gemKey)  clients.gemini     = new OpenAI({ apiKey: gemKey,  baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/', timeout: PROVIDER_TIMEOUT_MS, maxRetries: 0 });

  let oaiMessages = [
    { role: 'system', content: buildSystemPrompt(context) },
    ...history
  ];

  console.log(`[AI] provedores=${Object.keys(clients).join('+')} tools=${withTools} clinic=${clinicId}`);

  let modeloUsado = '?';
  try {
    let rounds = 0;
    let response;
    const toolOutputs = [];

    while (rounds++ < MAX_TOOL_ROUNDS) {
      const r = await aiCreate(clients, {
        messages:    oaiMessages,
        tools:       withTools ? TOOLS : undefined,
        tool_choice: withTools ? 'auto' : undefined,
        max_tokens:  800,
        temperature: 0.3
      });
      response = r.resp;
      modeloUsado = r.model;

      const choice = response.choices[0];
      if (choice.finish_reason !== 'tool_calls') break;

      oaiMessages.push(choice.message);

      for (const tc of (choice.message.tool_calls || [])) {
        let result;
        let falhouExecucao = false;
        try {
          if (!clinicId || !authedSb) {
            result = 'Sessão expirada. Peça ao usuário para recarregar a página.';
          } else {
            const args = JSON.parse(tc.function.arguments || '{}');
            result = await runTool(tc.function.name, args, authedSb, clinicId);
          }
        } catch (e) {
          falhouExecucao = true;
          result = JSON.stringify({ tool: tc.function.name, ok: false, message: `Erro: ${e.message}` });
        }
        // Log real: só marca "ok" quando a execução realmente não lançou
        // exceção. Resultado negativo esperado (paciente não encontrado,
        // horário em conflito) não é falha de execução — continua "ok".
        if (falhouExecucao) console.error(`[AI] tool=${tc.function.name} FALHOU: ${result}`);
        else console.log(`[AI] tool=${tc.function.name} ok`);
        toolOutputs.push({ name: tc.function.name, data: parseToolResult(result) });
        oaiMessages.push({ role: 'tool', tool_call_id: tc.id, content: result });
      }
    }

    const ultimaSaida = toolOutputs[toolOutputs.length - 1];
    const modeloRespondeu = response.choices[0].message.content?.trim();
    const usarFormatoFixo = ultimaSaida && (_resultadoTemDadosReais(ultimaSaida.data) || !modeloRespondeu);

    if (usarFormatoFixo) {
      const toolReply = formatToolReply(toolOutputs);
      if (toolReply) return res.status(200).json({ reply: toolReply, refresh: shouldRefreshApp(toolOutputs) });
    }

    const reply = modeloRespondeu || 'Ação executada.';
    return res.status(200).json({ reply });

  } catch (err) {
    const detail = err?.message || String(err);
    console.error(`[AI] provider=groq model=${modeloUsado} status=${err?.status||'?'} falhas=${err?.falhas||'-'} erro: ${detail}`);
    if (err?.status === 429) {
      // 429 vai como 429 mesmo: o app NÃO retenta (retentar só queima mais cota)
      return res.status(429).json({ error: 'Limite de uso da IA atingido. Aguarde 1 minuto e tente de novo.' });
    }
    let msg = 'Serviço de IA temporariamente indisponível. Tente novamente.';
    if (err?.status === 401) msg = 'Chave da IA inválida no servidor. Avise o administrador.';
    else if (err?.status === 413 || /too large|maximum context|token/i.test(detail)) msg = 'A conversa ficou longa demais. Feche e abra o chat para começar de novo.';
    return res.status(500).json({ error: msg });
  }
};
