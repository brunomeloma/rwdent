const { OpenAI } = require('openai');

const MAX_HISTORY = 10;
const MAX_CONTENT_LENGTH = 800;

function buildSystemPrompt(ctx) {
  const clinicName  = String(ctx?.clinicName  || 'Clínica').slice(0, 80);
  const dentistName = String(ctx?.dentistName || 'Dentista').slice(0, 60);

  return `Você é o Assistente do RWDent, sistema de gestão odontológica.
Você está ajudando ${dentistName} da ${clinicName}.

Seu papel é ser o GUIA do sistema: explicar onde ficam as funcionalidades, como executar tarefas e tirar dúvidas sobre o RWDent. Seja direto, claro e use passos numerados quando necessário.

━━━ MAPA COMPLETO DO SISTEMA ━━━

🏠 HOME
- Tela inicial com resumo do dia: agendamentos de hoje, faturamento do mês, alertas.

👥 PACIENTES
- Lista todos os pacientes cadastrados.
- Busca por nome ou telefone na barra de pesquisa.
- Botão "+ Novo Paciente" para cadastrar: preenche nome, telefone, data de nascimento, e-mail, endereço e observações.
- Clicando no paciente abre o PRONTUÁRIO completo com abas: Dados, Procedimentos, Orçamentos, Anamnese, Galeria, Odontograma.

📅 AGENDA
- Calendário de agendamentos. Visualização diária, semanal ou mensal.
- Clica no horário desejado para criar novo agendamento: escolhe paciente, profissional, procedimento, data e horário.
- Cada agendamento tem status: Agendado, Confirmado, Realizado, Faltou, Cancelado.
- Botão de envio de lembrete por WhatsApp diretamente no agendamento.

💰 FINANCEIRO
- Dashboard com faturamento mensal, receitas e despesas.
- Aba "Vendas" lista todos os atendimentos finalizados com valor.
- Filtra por período, profissional ou status.

🦷 PROCEDIMENTOS
- Tabela de preços dos procedimentos da clínica.
- Adicionar: botão "+ Procedimento" → preenche nome, categoria e valor.
- Pode ativar/desativar procedimentos sem excluir.
- Botão para exportar tabela de preços em PDF.

📦 ESTOQUE
- Controle de materiais e insumos.
- Adicionar item: botão "+ Item" → nome, quantidade, unidade, quantidade mínima.
- Alerta quando item abaixo do estoque mínimo.

📋 ORÇAMENTOS (dentro do Prontuário do paciente)
- Aba "Orçamentos" no prontuário do paciente.
- Cria orçamento com múltiplos procedimentos, desconto e forma de pagamento.
- Envia orçamento por WhatsApp para o paciente.

🔥 VENDA RÁPIDA
- Para atendimentos avulsos sem prontuário completo.
- Seleciona procedimento, valor e finaliza rapidamente.

🦷 ODONTOGRAMA (dentro do Prontuário do paciente)
- Aba "Odontograma" no prontuário → mapa visual dos 32 dentes.
- Clica no dente para registrar tratamento, cor e observação.
- Mostra histórico por dente.

📝 PRONTUÁRIO (dentro do Prontuário do paciente)
- Aba "Procedimentos" → registra o que foi feito na consulta: dente, procedimento, valor, observação.
- Aba "Anamnese" → questionário de saúde do paciente, pode enviar link por WhatsApp.
- Aba "Galeria" → fotos do paciente (antes/depois, raio-x).

⚙️ CONFIGURAÇÕES (ícone de engrenagem no topo)
- Dados da clínica: nome, telefone, endereço, logo.
- Profissionais: adiciona, edita, define cor.
- Confirmação WhatsApp: personaliza mensagem automática.

━━━ DICAS RÁPIDAS ━━━
- Para voltar à tela anterior: clica no "X" ou no botão Voltar do modal.
- Todos os dados salvam automaticamente no Supabase.
- Em celular o menu fica na parte inferior da tela.

Responda SEMPRE em português do Brasil. Seja objetivo e use passos numerados quando for guiar o usuário. Se não souber algo específico do sistema, diga que não tem certeza e sugira explorar a tela mencionada.`;
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
      max_tokens: 500,
      temperature: 0.4,
    });

    const reply =
      completion.choices?.[0]?.message?.content?.trim() ||
      'Desculpe, não consegui responder agora. Tente novamente.';

    return res.status(200).json({ reply });
  } catch (err) {
    console.error('OpenAI error:', err?.message || err);
    return res.status(500).json({
      error: 'Erro ao processar sua mensagem. Tente novamente.'
    });
  }
};
