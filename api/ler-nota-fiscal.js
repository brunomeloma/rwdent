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

function extrairJson(texto) {
  // O modelo às vezes envolve a resposta em ```json ... ``` mesmo pedindo
  // pra não fazer isso — tira a cerca de código antes de tentar parsear.
  const limpo = String(texto || '').replace(/```json/gi, '').replace(/```/g, '').trim();
  const inicio = limpo.indexOf('[');
  const fim = limpo.lastIndexOf(']');
  if (inicio === -1 || fim === -1 || fim < inicio) throw new Error('Resposta da IA não veio em formato de lista.');
  return JSON.parse(limpo.slice(inicio, fim + 1));
}

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

  // Aceita uma imagem só (imageBase64) ou várias (imagesBase64, nota de
  // várias páginas/fotos) — sempre normaliza pra lista internamente.
  const body = req.body || {};
  let imagens = Array.isArray(body.imagesBase64) ? body.imagesBase64 : (body.imageBase64 ? [body.imageBase64] : []);
  imagens = imagens.filter(s => typeof s === 'string' && s.length >= 100).slice(0, 5);
  if (!imagens.length) return res.status(400).json({ error: 'Envie ao menos uma foto da nota fiscal.' });
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

  const listaMateriais = mats.map(m => `${m.id}|${m.nome}|${m.unid || 'unid'}|${m.qtde || 1}`).join('\n');

  const prompt = `Você vai ler uma nota fiscal (ou várias fotos da mesma nota) de uma clínica odontológica e extrair CADA produto comprado.

MATERIAIS JÁ CADASTRADOS NO ESTOQUE DESTA CLÍNICA (formato "id|nome|unidade|unidades por embalagem"):
${listaMateriais}
"unidades por embalagem" é quantas unidades a clínica considera que tem em CADA caixa/pacote fechado desse material (ex: uma caixa de luvas com 100 = unidade "unid", unidades_por_embalagem 100).

REGRAS DE CASAMENTO (isto é o mais importante):
1. Para PRODUTOS GENÉRICOS (ex: babador, algodão, gaze, sugador, copo descartável) — a clínica normalmente não compra várias marcas diferentes do mesmo item. Se a nota trouxer um nome de marca/linha comprido (ex: "Babador Descartável Premium Line c/100"), mas já existir um material genérico cadastrado que é claramente a mesma coisa (ex: "Babador"), CASE com esse material genérico existente. NÃO crie/sugira nome novo com a marca completa.
2. Para PRODUTOS ESPECÍFICOS onde a especificação importa muito (ex: fio ortodôntico NiTi 0.19, agulha gengival curta, anestésico com um princípio ativo específico) — case pelo NÚMERO/ESPECIFICAÇÃO exata, não pelo nome genérico. Pequenas diferenças de formatação no número (ex: "0.19", "0,19", "ponto 19", "19") que claramente se referem ao MESMO valor contam como o mesmo produto.
3. Se o nome da nota for parecido mas você não tiver certeza (nome ambíguo, número que pode ser outro, produto que pode ser dois materiais diferentes cadastrados), NÃO adivinhe: deixe material_id null e explique em "observacao" por que ficou em dúvida.
4. Se o produto da nota claramente não existir em NENHUM material cadastrado, deixe material_id null e diga isso em "observacao" (ex: "material novo, não cadastrado ainda").

REGRA DE QUANTIDADE E PREÇO (muito importante, gente erra fácil aqui):
A nota fiscal pode vender por CAIXA/PACOTE FECHADO (ex: "3 CX" de luvas) mesmo quando o material é controlado pela clínica em unidades individuais. SEMPRE converta a quantidade pra bater com a UNIDADE cadastrada do material que você casou (coluna "unidade" da lista acima), usando "unidades por embalagem" pra multiplicar quando a nota vender em caixa/pacote/kit. Ex: nota mostra "3 CX" a R$45,00 a caixa, material cadastrado tem unidade "unid" e 100 unidades por embalagem → quantidade = 300, valor_unitario = 45/100 = 0.45 (preço por UNIDADE, não por caixa). Se o material já for vendido e controlado na mesma unidade que a nota mostra (ex: ambos em "ml"), não precisa converter nada. valor_unitario SEMPRE tem que ser o preço de UMA unidade da coluna "unidade" do material — nunca o preço da caixa/pacote inteiro.

Responda APENAS com um array JSON (sem markdown, sem texto antes/depois), um item por produto da nota, neste formato exato:
[{"produto_nota":"texto exatamente como aparece na nota","quantidade":0,"valor_unitario":0,"material_id":0,"confianca":"alta","observacao":""}]

- quantidade: já convertida pra unidade do material cadastrado (ver regra acima)
- valor_unitario: preço de UMA unidade do material (ver regra acima), se a nota permitir calcular (senão null)
- material_id: o id de MATERIAIS JÁ CADASTRADOS acima que bate com este produto, ou null se não tiver certeza ou não existir
- confianca: "alta" (nome/especificação bateu claramente), "media" (bateu mas com alguma diferença de nome) ou "baixa" (chute, ou material_id null)
- observacao: string curta explicando a dúvida (inclua aqui se converteu de caixa pra unidade), vazio "" se confianca alta e sem conversão

Ignore linhas que não são produtos (frete, impostos, totais, dados da empresa). Se não conseguir ler nenhum produto, responda [].`;

  try {
    const client = new OpenAI({
      apiKey: geminiKey,
      baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
      timeout: 45000,
      maxRetries: 0
    });
    const resp = await client.chat.completions.create({
      model: 'gemini-2.0-flash',
      max_tokens: 4000,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          ...imagens.map(img => ({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${img}` } }))
        ]
      }]
    });
    const texto = resp.choices?.[0]?.message?.content || '';
    let itensBrutos;
    try { itensBrutos = extrairJson(texto); }
    catch (parseErr) {
      console.error('[LerNotaFiscal] resposta não parseável:', String(texto).slice(0, 300));
      return res.status(502).json({ error: 'Não consegui ler essa nota — tente uma foto mais nítida, com o produto e a quantidade visíveis.' });
    }
    if (!Array.isArray(itensBrutos)) itensBrutos = [];

    const matsById = new Map(mats.map(m => [Number(m.id), m]));
    const itens = itensBrutos.slice(0, 100).map(it => {
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
    console.error('[LerNotaFiscal] erro:', err?.message || err);
    return res.status(502).json({ error: 'Erro ao ler a nota fiscal com a IA: ' + (err?.message || 'tente de novo em instantes.') });
  }
};
