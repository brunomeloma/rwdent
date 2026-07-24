const { OpenAI } = require('openai');
const { createClient } = require('@supabase/supabase-js');

// Classifica uma imagem odontológica (foto clínica x radiografia) usando o
// Gemini via visão computacional — mesma chave GEMINI_API_KEY já usada como
// fallback no assistente de IA (api/chat.js). Os outros provedores da
// corrente (Groq, Cerebras, OpenRouter/Llama) não têm suporte a imagem, só
// texto, então aqui é sempre Gemini direto, sem cadeia de fallback.
//
// "Antes/Depois" nunca é sugerido pela IA de propósito: visualmente uma foto
// de antes/depois é idêntica a uma foto clínica normal — a diferença é só a
// INTENÇÃO de quem tirou, algo que não dá pra ver na imagem. Só radiografia
// (preto-e-branco, estrutura óssea) tem uma assinatura visual confiável pra
// IA distinguir de uma foto colorida comum.

const RATE_LIMIT_WINDOW_MS = 60000;
const RATE_LIMIT_MAX_REQ   = 30; // um upload em lote chama isso várias vezes seguidas
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

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido.' });

  const cleanStr = s => String(s || '').replace(/[^\x20-\x7E]/g, '').trim();
  const geminiKey = cleanStr(process.env.GEMINI_API_KEY);
  if (!geminiKey) return res.status(200).json({ categoria: 'foto', fallback: true });

  const { imageBase64 } = req.body || {};
  if (!imageBase64 || typeof imageBase64 !== 'string' || imageBase64.length < 100) {
    return res.status(400).json({ error: 'Imagem inválida.' });
  }
  if (imageBase64.length > 2_000_000) {
    return res.status(413).json({ error: 'Imagem grande demais para classificar.' });
  }

  // ── Autenticação — mesmo padrão do api/chat.js: exige login, pra não
  // deixar uma chamada anônima esgotar a cota gratuita de IA compartilhada
  // por todas as clínicas.
  const authHeader  = req.headers['authorization'] || '';
  const accessToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  const supabaseUrl  = cleanStr(process.env.SUPABASE_URL);
  const supabaseAnon = cleanStr(process.env.SUPABASE_ANON_KEY);
  let userId = null;
  if (accessToken && supabaseUrl && supabaseAnon) {
    try {
      const sbAnon = createClient(supabaseUrl, supabaseAnon);
      const { data: { user }, error } = await sbAnon.auth.getUser(accessToken);
      if (!error && user) userId = user.id;
    } catch (e) { /* segue userId null, cai no 401 abaixo */ }
  }
  if (!userId) return res.status(401).json({ error: 'Faça login para usar a classificação automática.' });
  if (isRateLimited(userId)) return res.status(429).json({ error: 'Muitas classificações em pouco tempo. Aguarde um instante.' });

  try {
    const client = new OpenAI({
      apiKey: geminiKey,
      baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
      timeout: 15000,
      maxRetries: 0
    });
    const resp = await client.chat.completions.create({
      model: 'gemini-2.0-flash',
      max_tokens: 10,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Esta é uma imagem odontológica. Responda com UMA ÚNICA PALAVRA: "radiografia" se for um raio-x (imagem em tons de cinza/preto-e-branco mostrando estrutura óssea ou dentes em radiografia), ou "foto" se for uma foto clínica colorida normal (boca, dentes, rosto, sorriso). Não explique nada, responda só a palavra.'
          },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}` } }
        ]
      }]
    });
    const texto = (resp.choices?.[0]?.message?.content || '').toLowerCase();
    const categoria = texto.includes('radiograf') ? 'radiografia' : 'foto';
    return res.status(200).json({ categoria });
  } catch (err) {
    console.error('[ClassificarImagemGaleria] erro:', err?.message || err);
    // Nunca bloqueia o upload por falha da IA — cai pro padrão "foto" e a
    // pessoa confirma/corrige na revisão antes de enviar de qualquer jeito.
    return res.status(200).json({ categoria: 'foto', fallback: true });
  }
};
