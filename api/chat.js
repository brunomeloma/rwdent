const { OpenAI } = require('openai');

const SYSTEM_PROMPT = `Você é o Assistente Rhaiza, assistente virtual da Clínica Odontológica da Dra. Rhaiza Barroso.

Diretrizes obrigatórias:
- Responda SEMPRE em português do Brasil.
- Tom: acolhedor, profissional, objetivo e humano. Use emojis com moderação.
- NUNCA dê diagnóstico definitivo.
- NUNCA prescreva nem sugira medicação ou dosagem.
- Sempre lembre que sua orientação NÃO substitui avaliação odontológica presencial.
- Em caso de dor forte, trauma, inchaço, febre ou sangramento, oriente buscar atendimento odontológico URGENTE imediatamente — deixe isso bem claro.
- Quando fizer sentido no contexto, convide o usuário para agendar pelo WhatsApp: https://wa.me/5599982706186
- Foque apenas em temas odontológicos: consultas, limpeza, clareamento, ortodontia, implantes, facetas, tratamento de canal, odontopediatria, urgências e dúvidas gerais sobre saúde bucal.
- Para perguntas completamente fora da área odontológica, redirecione gentilmente.
- Respostas curtas e objetivas (no máximo 4 parágrafos). Prefira marcadores quando listar itens.`;

const MAX_HISTORY = 10;
const MAX_CONTENT_LENGTH = 800;

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido.' });
  }

  if (!process.env.OPENAI_API_KEY) {
    console.error('OPENAI_API_KEY não configurada.');
    return res.status(500).json({ error: 'Serviço temporariamente indisponível.' });
  }

  const { messages } = req.body || {};

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Requisição inválida.' });
  }

  // Sanitize and limit history
  const history = messages
    .slice(-MAX_HISTORY)
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map(m => ({
      role: m.role,
      content: m.content.slice(0, MAX_CONTENT_LENGTH)
    }));

  if (history.length === 0 || history[history.length - 1].role !== 'user') {
    return res.status(400).json({ error: 'Requisição inválida.' });
  }

  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...history],
      max_tokens: 450,
      temperature: 0.7,
    });

    const reply =
      completion.choices?.[0]?.message?.content?.trim() ||
      'Desculpe, não consegui gerar uma resposta agora. Tente novamente em instantes.';

    return res.status(200).json({ reply });
  } catch (err) {
    console.error('OpenAI error:', err?.message || err);
    return res.status(500).json({
      error: 'Erro ao processar sua mensagem. Tente novamente ou fale direto pelo WhatsApp.'
    });
  }
};
