const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');

// Lê a nota fiscal (PDF ou foto) com o Claude Opus e devolve cada produto já
// casado com um material existente no estoque da clínica.
//
// Antes usava Gemini com o PDF convertido em imagem no navegador — perdia
// linha (o kit clareador sumia), estourava tempo e às vezes devolvia texto
// que não era JSON. Agora o PDF vai direto (o Claude lê a camada de texto da
// DANFE, não só a imagem), e a resposta é forçada num esquema JSON pela API
// (output_config.format), então não existe mais "resposta não parseável".
//
// NUNCA escreve nada sozinho: só lê e sugere. Quem decide se adiciona ao
// estoque é o usuário, na tela de revisão, depois de conferir cada linha.

const MODEL = 'claude-opus-5';

const RATE_LIMIT_WINDOW_MS = 60000;
const RATE_LIMIT_MAX_REQ   = 6;
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

// A compressão do navegador devolve o arquivo original quando ele já é
// pequeno (ex: print PNG), então o tipo real pode não ser JPEG — a API
// rejeita imagem com media_type errado, por isso detecta pelos primeiros bytes.
function tipoImagem(b64) {
  if (b64.startsWith('iVBORw0KGgo')) return 'image/png';
  if (b64.startsWith('R0lGOD')) return 'image/gif';
  if (b64.startsWith('UklGR')) return 'image/webp';
  return 'image/jpeg';
}

const ESQUEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['itens'],
  properties: {
    itens: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['produto_nota', 'quantidade', 'valor_unitario', 'material_id', 'confianca', 'observacao'],
        properties: {
          produto_nota:   { type: 'string' },
          quantidade:     { type: 'number' },
          valor_unitario: { anyOf: [{ type: 'number' }, { type: 'null' }] },
          material_id:    { anyOf: [{ type: 'integer' }, { type: 'null' }] },
          confianca:      { type: 'string', enum: ['alta', 'media', 'baixa'] },
          observacao:     { type: 'string' }
        }
      }
    }
  }
};

const INSTRUCOES = `Você lê notas fiscais de compra de uma clínica odontológica e transforma cada produto comprado num item estruturado, casando com os materiais que a clínica já tem cadastrados no estoque. O resultado vai pra uma tela de revisão onde a pessoa confere linha por linha antes de somar ao estoque — então é melhor trazer um item marcado como incerto do que deixar de trazer.

Como casar produto da nota com material cadastrado:
- Produtos genéricos (babador, algodão, gaze, sugador, copo, luva, máscara, touca...): a clínica não costuma separar por marca. Se a nota traz um nome comercial comprido e existe um material genérico cadastrado que é claramente a mesma coisa, case com o genérico.
- Produtos em que a especificação importa (fio/arco ortodôntico por calibre e arcada, agulha por calibre/comprimento, anestésico por princípio ativo, broca/ponta diamantada por número, braquete por dente): case pela especificação exata. Diferenças só de formatação no número ("0.019", "0,019", "19") valem como o mesmo produto; especificação diferente é outro produto.
- Se ficar entre dois materiais, ou não tiver certeza, deixe material_id null e explique a dúvida em observacao, com confianca "baixa".
- Se o produto não existe em nenhum material cadastrado, material_id null e observacao "material novo, não cadastrado ainda".
- Kits e combos ("kit", "edição limitada", "combo"): a nota não diz o que vem dentro — pode ser vários produtos diferentes na mesma caixa (ex: um kit de clareador que junta clareador de consultório e clareador caseiro). Só case com um material se tiver certeza de que é exatamente o mesmo conteúdo; senão confianca "baixa" e observacao avisando que é kit e que a pessoa precisa conferir quantos itens tem dentro.

Todo produto que aparece na nota vira um item, inclusive os incertos, kits e os que se repetem em mais de uma linha (cada linha da nota é um item). Só ficam de fora linhas que não são produto: frete, impostos, totais, faturas/duplicatas, dados do emitente, destinatário e transportadora.

Quantidade e preço — sempre na unidade do material cadastrado:
A nota pode vender em caixa/pacote enquanto a clínica controla em unidade. Quando casar com um material, converta usando "unidades por embalagem": ex. nota com 3 CX a R$45,00, material em "unid" com 100 por embalagem → quantidade 300 e valor_unitario 0.45. Se a nota já está na mesma unidade do material, não converta. valor_unitario é sempre o preço de UMA unidade do material (null se a nota não permitir calcular). Diga em observacao quando tiver convertido.
Se o produto não casou com nenhum material, use a quantidade e o preço unitário exatamente como estão na nota.

confianca: "alta" quando nome/especificação bateram claramente, "media" quando bateu com alguma diferença de nome, "baixa" quando é chute ou material_id é null. observacao fica "" quando a confiança é alta e não houve conversão.`;

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido.' });

  const cleanStr = s => String(s || '').replace(/[^\x20-\x7E]/g, '').trim();
  const anthropicKey    = cleanStr(process.env.ANTHROPIC_API_KEY);
  const supabaseUrl     = cleanStr(process.env.SUPABASE_URL);
  const supabaseAnon    = cleanStr(process.env.SUPABASE_ANON_KEY);
  const serviceRoleKey  = cleanStr(process.env.SUPABASE_SERVICE_ROLE_KEY);
  if (!anthropicKey) return res.status(500).json({ error: 'Leitura de nota fiscal não configurada (falta ANTHROPIC_API_KEY no Vercel).' });
  if (!supabaseUrl || !supabaseAnon || !serviceRoleKey) return res.status(500).json({ error: 'Servidor sem chaves do Supabase configuradas.' });

  // PDFs chegam crus (pdfsBase64) — o Claude lê o PDF nativamente, texto e
  // imagem. Fotos chegam em imagesBase64 (ou imageBase64, formato antigo).
  const body = req.body || {};
  const soStrings = arr => (Array.isArray(arr) ? arr : []).filter(s => typeof s === 'string' && s.length >= 100);
  const pdfs = soStrings(body.pdfsBase64).slice(0, 3);
  let imagens = soStrings(Array.isArray(body.imagesBase64) ? body.imagesBase64 : (body.imageBase64 ? [body.imageBase64] : []));
  imagens = imagens.slice(0, 8);
  if (!pdfs.length && !imagens.length) return res.status(400).json({ error: 'Envie a nota fiscal (PDF ou foto).' });
  for (const b64 of [...pdfs, ...imagens]) {
    if (b64.length > 4_000_000) return res.status(413).json({ error: 'Um dos arquivos está grande demais.' });
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
  mats = mats.filter(m => !m.arquivado);
  if (!mats.length) return res.status(200).json({
    ok: true, itens: [],
    aviso: 'Você ainda não tem nenhum material cadastrado em Financeiro > Materiais — cadastre pelo menos os materiais que compra sempre antes de ler notas fiscais, pra IA ter o que casar.'
  });

  const listaMateriais = mats.map(m => `${m.id} | ${m.nome} | ${m.unid || 'unid'} | ${m.qtde || 1}`).join('\n');

  const conteudo = [
    ...pdfs.map(data => ({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } })),
    ...imagens.map(data => ({ type: 'image', source: { type: 'base64', media_type: tipoImagem(data), data } })),
    {
      type: 'text',
      text: `Materiais cadastrados no estoque desta clínica (id | nome | unidade | unidades por embalagem):\n${listaMateriais}\n\nExtraia todos os produtos da nota fiscal acima.`
    }
  ];

  try {
    const client = new Anthropic({ apiKey: anthropicKey, timeout: 280000, maxRetries: 1 });
    // Streaming só pra não esbarrar em timeout HTTP numa nota grande —
    // finalMessage() devolve a resposta inteira no fim.
    const stream = client.beta.messages.stream({
      model: MODEL,
      max_tokens: 32000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: {
        effort: 'medium',
        format: { type: 'json_schema', schema: ESQUEMA }
      },
      system: INSTRUCOES,
      messages: [{ role: 'user', content: conteudo }]
    });
    const msg = await stream.finalMessage();

    if (msg.stop_reason === 'refusal') {
      console.error('[LerNotaFiscal] recusa:', msg.stop_details);
      return res.status(502).json({ error: 'A IA não conseguiu processar essa nota. Tente de novo ou envie outra foto.' });
    }
    if (msg.stop_reason === 'max_tokens') {
      console.error('[LerNotaFiscal] resposta cortada (max_tokens)', msg.usage);
      return res.status(502).json({ error: 'A nota tem produtos demais pra ler de uma vez — envie em partes (algumas páginas por vez).' });
    }

    const texto = msg.content.filter(b => b.type === 'text').map(b => b.text).join('');
    let itensBrutos = [];
    try { itensBrutos = JSON.parse(texto).itens || []; }
    catch (e) {
      console.error('[LerNotaFiscal] JSON inválido:', texto.slice(0, 300));
      return res.status(502).json({ error: 'Não consegui ler essa nota — tente de novo.' });
    }
    console.log('[LerNotaFiscal] ok', { modelo: msg.model, itens: itensBrutos.length, uso: msg.usage });

    const matsById = new Map(mats.map(m => [Number(m.id), m]));
    const itens = itensBrutos.slice(0, 150).map(it => {
      const matId = it.material_id != null ? Number(it.material_id) : null;
      const mat = (matId != null && matsById.has(matId)) ? matsById.get(matId) : null;
      return {
        produto_nota: String(it.produto_nota || '').slice(0, 200),
        quantidade: Number(it.quantidade) || 0,
        valor_unitario: it.valor_unitario != null && Number.isFinite(Number(it.valor_unitario)) ? Number(it.valor_unitario) : null,
        material_id: mat ? mat.id : null,
        material_nome: mat ? mat.nome : null,
        material_unid: mat ? (mat.unid || 'unid') : null,
        confianca: ['alta', 'media', 'baixa'].includes(it.confianca) ? it.confianca : 'baixa',
        observacao: String(it.observacao || '').slice(0, 200)
      };
    }).filter(it => it.produto_nota && it.quantidade > 0);

    return res.status(200).json({ ok: true, itens });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      return res.status(500).json({ error: 'ANTHROPIC_API_KEY inválida — confira a chave no Vercel.' });
    }
    if (err instanceof Anthropic.RateLimitError) {
      return res.status(429).json({ error: 'IA ocupada no momento — tente de novo em alguns segundos.' });
    }
    console.error('[LerNotaFiscal] erro:', err?.status, err?.message || err);
    return res.status(502).json({ error: 'Erro ao ler a nota fiscal com a IA: ' + (err?.message || 'tente de novo em instantes.') });
  }
};
