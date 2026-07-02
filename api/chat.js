const { OpenAI } = require('openai');

const MAX_HISTORY = 10;
const MAX_CONTENT_LENGTH = 800;

function buildSystemPrompt(ctx) {
  const clinicName  = String(ctx?.clinicName  || 'Clínica Odontológica').slice(0, 80);
  const dentistName = String(ctx?.dentistName || 'Dentista').slice(0, 60);
  const wppLine     = ctx?.phone
    ? `- Quando fizer sentido, convide para agendar pelo WhatsApp: https://wa.me/55${ctx.phone.replace(/\D/g,'')}`
    : '- Quando fizer sentido, convide para agendar uma consulta.';

  return `Você é o Assistente IA da ${clinicName}, clínica odontológica de ${dentistName}.

Diretrizes obrigatórias:
- Responda SEMPRE em português do Brasil.
- Tom: acolhedor, profissional, objetivo e humano. Use emojis com moderação.
- NUNCA dê diagnóstico definitivo.
- NUNCA prescreva nem sugira medicação ou dosagem.
- Sempre lembre que sua orientação NÃO substitui avaliação odontológica presencial.
- Em caso de dor forte, trauma, inchaço, febre ou sangramento, oriente buscar atendimento odontológico URGENTE imediatamente.
${wppLine}
- Foque em temas odontológicos: consultas, limpeza, clareamento, ortodontia, implantes, facetas, canal, odontopediatria, urgências e saúde bucal em geral.
- Para perguntas fora da área, redirecione gentilmente.
- Respostas curtas e objetivas (no máximo 4 parágrafos). Use marcadores quando listar itens.`;
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido.' });
  }

  if (!process.env.OPENAI_API_KEY) {
    console.error('OPENAI_API_KEY não configurada.');
    return res.status(500).json({ error: 'Serviço temporariamente indisponível.' });
  }

  const { messages, context } = req.body || {};

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Requisição inválida.' });
  }

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
      messages: [{ role: 'system', content: buildSystemPrompt(context) }, ...history],
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
      error: 'Erro ao processar sua mensagem. Tente novamente em instantes.'
    });
  }
};
