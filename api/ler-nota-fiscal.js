const { OpenAI } = require('openai');
const { createClient } = require('@supabase/supabase-js');

// Lê uma (ou várias, ex: nota de 2 páginas) foto/print de nota fiscal via
// Gemini com visão computacional e devolve cada produto já casado com um
// material existente no estoque da clínica — mesma ideia de
// classificar-imagem-galeria.js, mas extraindo uma lista estruturada em vez
// de uma categoria só.
//
// NUNCA escreve nada sozinho: só lê e sugere. Quem decide se adiciona ao
// estoque é o usuário, na tela de revisão, depois de conferir cada linha —
// exatamente como toda outra ação de escrita da IA no sistema (mesmo padrão
// de confirmação do assistente em api/chat.js).

const RATE_LIMIT_WINDOW_MS = 60000;
const RATE_LIMIT_MAX_REQ   = 8; // ler nota é mais pesado (imagem grande + JSON longo) que classificar 1 foto
const _rateBuckets = new Map();
function isRateLimited(userId) {
  const now = Date.now();
  const hits = (_rateBuckets.get(userId) || []).filter(t => now - t < RATE_LIMIT_WINDOW_MS);
  hits.push(now);
  _rateBuckets.set(userId, hits);
  if (_rateBuckets.size > 500) {
    const oldest = _rateBuckets.keys().next().value;
    _rateBuckets.delete(oldest);
  }
  return hits.length > RATE_LIMIT_MAX_REQ;
}

// Aceita os dois formatos de resposta: {"itens":[...]} (modo com esquema
// JSON) ou [...] solto (modo antigo, sem esquema). No modo antigo o modelo
// às vezes envolve em ```json ... ``` — tira a cerca antes de parsear.
function extrairJson(texto) {
  const limpo = String(texto || '').replace(/```json/gi, '').replace(/```/g, '').trim();
  try {
    const obj = JSON.parse(limpo);
    if (Array.isArray(obj)) return obj;
    if (obj && Array.isArray(obj.itens)) return obj.itens;
  } catch (e) { /* cai pra extração por colchetes abaixo */ }
  const inicio = limpo.indexOf('[');
  const fim = limpo.lastIndexOf(']');
  if (inicio === -1 || fim === -1 || fim < inicio) throw new Error('Resposta da IA não veio em formato de lista.');
  return JSON.parse(limpo.slice(inicio, fim + 1));
}

// Esquema da resposta — o Gemini (via endpoint compatível com OpenAI)
// passa a devolver JSON válido garantido, sem texto de raciocínio misturado
// (era a causa dos erros "resposta não parseável"). Sem campos nulos pra
// ficar no subconjunto de JSON Schema que o Gemini aceita: valor_unitario
// 0 = não deu pra calcular; material_id 0 = nenhum material casou.
const ESQUEMA_RESPOSTA = {
  type: 'json_schema',
  json_schema: {
    name: 'itens_nota_fiscal',
    schema: {
      type: 'object',
      properties: {
        itens: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              produto_nota:   { type: 'string' },
              quantidade:     { type: 'number' },
              valor_unitario: { type: 'number' },
              material_id:    { type: 'integer' },
              confianca:      { type: 'string', enum: ['alta', 'media', 'baixa'] },
              observacao:     { type: 'string' }
            },
            required: ['produto_nota', 'quantidade', 'valor_unitario', 'material_id', 'confianca', 'observacao']
          }
        }
      },
      required: ['itens']
    }
  }
};

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido.' });

  const cleanStr = s => String(s || '').replace(/[^\x20-\x7E]/g, '').trim();
  const geminiKey       = cleanStr(process.env.GEMINI_API_KEY);
  const supabaseUrl     = cleanStr(process.env.SUPABASE_URL);
  const supabaseAnon    = cleanStr(process.env.SUPABASE_ANON_KEY);
  const serviceRoleKey  = cleanStr(process.env.SUPABASE_SERVICE_ROLE_KEY);
  if (!geminiKey) return res.status(500).json({ error: 'Leitura de nota fiscal não configurada (falta GEMINI_API_KEY).' });
  if (!supabaseUrl || !supabaseAnon || !serviceRoleKey) return res.status(500).json({ error: 'Servidor sem chaves do Supabase configuradas.' });

  // Aceita fotos (imagesBase64 / imageBase64) e/ou o texto extraído do PDF
  // no navegador (textoPdf) — PDF com camada de texto chega só como texto.
  const body = req.body || {};
  let imagens = Array.isArray(body.imagesBase64) ? body.imagesBase64 : (body.imageBase64 ? [body.imageBase64] : []);
  imagens = imagens.filter(s => typeof s === 'string' && s.length >= 100).slice(0, 8);
  const textoPdf = typeof body.textoPdf === 'string' ? body.textoPdf.slice(0, 80000).trim() : '';
  if (!imagens.length && !textoPdf) return res.status(400).json({ error: 'Envie a nota fiscal (PDF ou foto).' });
  for (const img of imagens) {
    if (img.length > 4_000_000) return res.status(413).json({ error: 'Uma das imagens está grande demais.' });
  }

  // ── Autenticação + descoberta da clínica: membro (secretária) primeiro,
  // senão dono — mesmo padrão do api/push-subscribe.js. Nunca confia em
  // clinica_id vindo do corpo da requisição.
  const authHeader  = req.headers['authorization'] || '';
  const accessToken = cleanStr(authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '');
  if (!accessToken) return res.status(401).json({ error: 'Faça login.' });

  const sbCaller = createClient(supabaseUrl, supabaseAnon, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } }
  });
  const { data: { user }, error: authErr } = await sbCaller.auth.getUser(accessToken);
  if (authErr || !user) return res.status(401).json({ error: 'Sessão inválida.' });
  if (isRateLimited(user.id)) return res.status(429).json({ error: 'Muitas notas lidas em pouco tempo. Aguarde um instante.' });

  const sbAdmin = createClient(supabaseUrl, serviceRoleKey);
  let clinicaId = null;
  const { data: vinc } = await sbAdmin.from('clinica_membros').select('clinica_id').eq('user_id', user.id).limit(1);
  if (vinc && vinc.length) clinicaId = vinc[0].clinica_id;
  if (!clinicaId) {
    const { data: cli } = await sbAdmin.from('clinicas').select('id').eq('user_id', user.id).maybeSingle();
    if (cli) clinicaId = cli.id;
  }
  if (!clinicaId) return res.status(403).json({ error: 'Usuário sem clínica.' });

  const { data: fcRows, error: fcErr } = await sbAdmin.from('financeiro_config')
    .select('mats').eq('clinica_id', clinicaId).order('updated_at', { ascending: false }).limit(1);
  if (fcErr) return res.status(500).json({ error: fcErr.message });
  let mats = [];
  try { mats = JSON.parse((fcRows && fcRows[0] && fcRows[0].mats) || '[]'); } catch { mats = []; }
  if (!mats.length) return res.status(200).json({
    ok: true, itens: [],
    aviso: 'Você ainda não tem nenhum material cadastrado em Financeiro > Materiais — cadastre pelo menos os materiais que compra sempre antes de ler notas fiscais, pra IA ter o que casar.'
  });

  mats = mats.filter(m => !m.arquivado);
  const listaMateriais = mats.map(m => `${m.id} | ${m.nome} | ${m.unid || 'unid'} | ${m.qtde || 1}`).join('\n');

  const fonteNota = textoPdf
    ? `A nota veio em PDF. Abaixo está o TEXTO extraído do PDF, página por página, com uma linha por produto na tabela "DADOS DOS PRODUTOS" (colunas: código, descrição, NCM, CST, CFOP, unidade, quantidade, valor unitário, valor total, e impostos). Descrições longas continuam na(s) linha(s) seguinte(s), sem código na frente — junte com o produto de cima. Números usam vírgula decimal ("1,0000" = 1; "24,08" = 24.08). Esse texto é exato — confie nele pra nome, quantidade e valor.\n\n${textoPdf}`
    : 'A nota veio como foto(s), anexadas abaixo. Leia a tabela de produtos com atenção à letra miúda.';

  const prompt = `Você lê notas fiscais de compra de uma clínica odontológica e transforma cada produto comprado num item, casando com os materiais que a clínica já tem cadastrados no estoque. O resultado vai pra uma tela de revisão onde a pessoa confere linha por linha antes de somar ao estoque — então é melhor trazer um item marcado como incerto do que deixar de trazer.

Materiais cadastrados no estoque desta clínica (id | nome | unidade | unidades por embalagem):
${listaMateriais}
"Unidades por embalagem" é quantas unidades a clínica considera que vêm em cada caixa/pacote fechado (ex: caixa de luvas com 100 → unidade "unid", 100 por embalagem).

Como casar produto da nota com material cadastrado:
- Produtos genéricos (babador, algodão, gaze, sugador, copo, luva, máscara, touca...): a clínica não costuma separar por marca. Se a nota traz um nome comercial comprido e existe um material genérico cadastrado que é claramente a mesma coisa, case com o genérico.
- Produtos em que a especificação importa (fio/arco ortodôntico por calibre e arcada, agulha por calibre/comprimento, anestésico por princípio ativo, broca/ponta diamantada por número, braquete por dente): case pela especificação exata. Diferenças só de formatação no número ("0.019", "0,019", "19") valem como o mesmo produto; especificação diferente é outro produto.
- Se ficar entre dois materiais, ou não tiver certeza, use material_id 0 e explique a dúvida em observacao, com confianca "baixa".
- Se o produto não existe em nenhum material cadastrado: material_id 0 e observacao "material novo, não cadastrado ainda".
- Kits e combos ("kit", "edição limitada", "combo"): a nota não diz o que vem dentro — pode ser vários produtos diferentes na mesma caixa (ex: um kit de clareador que junta clareador de consultório e clareador caseiro). Só case com um material se tiver certeza de que é exatamente o mesmo conteúdo; senão confianca "baixa" e observacao avisando que é kit e que a pessoa precisa conferir quantos itens tem dentro.

Todo produto que aparece na nota vira um item, inclusive os incertos, os kits e os que se repetem em mais de uma linha (cada linha de produto da nota é um item). Só ficam de fora linhas que não são produto: frete, impostos, totais, faturas/duplicatas, dados do emitente, destinatário e transportadora.

Quantidade e preço — sempre na unidade do material cadastrado:
A nota pode vender em caixa/pacote enquanto a clínica controla em unidade. Quando casar com um material, converta usando "unidades por embalagem": ex. nota com 3 CX a R$45,00, material em "unid" com 100 por embalagem → quantidade 300 e valor_unitario 0.45. Se a nota já está na mesma unidade do material, não converta. valor_unitario é sempre o preço de UMA unidade do material (0 se a nota não permitir calcular). Diga em observacao quando tiver convertido.
Se o produto não casou com nenhum material, use a quantidade e o preço unitário exatamente como estão na nota.

Campos de cada item: produto_nota (descrição completa como está na nota), quantidade, valor_unitario, material_id (id da lista acima, ou 0), confianca ("alta" quando nome/especificação bateram claramente, "media" quando bateu com alguma diferença de nome, "baixa" quando é chute ou material_id é 0), observacao ("" quando a confiança é alta e não houve conversão).

${fonteNota}`;

  const client = new OpenAI({
    apiKey: geminiKey,
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    timeout: 55000,
    maxRetries: 0
  });
  const pedido = {
    model: 'gemini-3.5-flash',
    // Modelo "thinking" por padrão — reasoning_effort 'low' reduz o
    // raciocínio interno pra resposta caber no tempo da função serverless
    // (sem isso, nota com muitos itens estourava 55s).
    max_tokens: 32000,
    reasoning_effort: 'low',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        ...imagens.map(img => ({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${img}` } }))
      ]
    }]
  };

  try {
    let resp;
    try {
      resp = await client.chat.completions.create({ ...pedido, response_format: ESQUEMA_RESPOSTA });
    } catch (e) {
      // Se o Gemini recusar o esquema (400), tenta de novo sem ele — o
      // extrairJson abaixo ainda sabe achar a lista no texto solto.
      if (e?.status !== 400) throw e;
      console.error('[LerNotaFiscal] esquema recusado, tentando sem:', e?.message);
      resp = await client.chat.completions.create(pedido);
    }
    const texto = resp.choices?.[0]?.message?.content || '';
    let itensBrutos;
    try { itensBrutos = extrairJson(texto); }
    catch (parseErr) {
      console.error('[LerNotaFiscal] resposta não parseável:', String(texto).slice(0, 300));
      return res.status(502).json({ error: 'Não consegui ler essa nota — tente uma foto mais nítida, com o produto e a quantidade visíveis.' });
    }
    if (!Array.isArray(itensBrutos)) itensBrutos = [];

    const matsById = new Map(mats.map(m => [Number(m.id), m]));
    console.log('[LerNotaFiscal] ok', { itens: itensBrutos.length, texto: !!textoPdf, imagens: imagens.length, uso: resp.usage });
    const itens = itensBrutos.slice(0, 150).map(it => {
      const matId = it.material_id ? Number(it.material_id) : null;
      const mat = (matId != null && matsById.has(matId)) ? matsById.get(matId) : null;
      const vu = Number(it.valor_unitario);
      return {
        produto_nota: String(it.produto_nota || '').slice(0, 200),
        quantidade: Number(it.quantidade) || 0,
        valor_unitario: Number.isFinite(vu) && vu > 0 ? vu : null,
        material_id: mat ? mat.id : null,
        material_nome: mat ? mat.nome : null,
        material_unid: mat ? (mat.unid || 'unid') : null,
        confianca: ['alta', 'media', 'baixa'].includes(it.confianca) ? it.confianca : 'baixa',
        observacao: String(it.observacao || '').slice(0, 200)
      };
    }).filter(it => it.produto_nota && it.quantidade > 0);

    return res.status(200).json({ ok: true, itens });
  } catch (err) {
    console.error('[LerNotaFiscal] erro:', err?.message || err);
    return res.status(502).json({ error: 'Erro ao ler a nota fiscal com a IA: ' + (err?.message || 'tente de novo em instantes.') });
  }
};
