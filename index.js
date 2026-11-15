require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { Pool } = require('pg');
const express = require('express');
const ExcelJS = require('exceljs');

const token = process.env.BOT_TOKEN;
const ownerId = process.env.OWNER_ID ? Number(process.env.OWNER_ID) : null;
const connectionString = process.env.DATABASE_URL;

if (!token || !connectionString) {
  console.error('ERRO CRÍTICO: BOT_TOKEN ou DATABASE_URL não configurados nas variáveis de ambiente.');
  process.exit(1);
}

// Configuração do Banco de Dados (Supabase/PostgreSQL com Pooler IPv4)
const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false }
});

const bot = new TelegramBot(token, { polling: true });
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('Imperium Cash Bot está rodando com sucesso!');
});

app.listen(PORT, () => {
  console.log(`Servidor Express rodando na porta ${PORT}`);
});

// Armazenamento em memória temporário para estados
const awaitingReceipt = new Set();
const userStates = new Map();

// Teclado Principal Fixo (Reply Keyboard) original + novo botão de Assinatura
const mainReplyKeyboard = {
  reply_markup: {
    keyboard: [
      ['Ganhei', 'Gastei', 'Investi'],
      ['Análise', 'Histórico', 'Minha Conta'],
      ['💎 Assinar Imperium Plus']
    ],
    resize_keyboard: true,
    is_persistent: true
  }
};

// Função auxiliar para verificar acesso VIP
async function verificarAcesso(telegramId) {
  try {
    const res = await pool.query('SELECT plano, vip_expiracao FROM usuarios WHERE telegram_id = $1', [telegramId]);
    if (res.rows.length === 0) return { plano: 'FREE', ativo: false };
    
    const user = res.rows[0];
    if (user.plano === 'VIP') {
      if (user.vip_expiracao && new Date(user.vip_expiracao) > new Date()) {
        return { plano: 'VIP', ativo: true, expiracao: user.vip_expiracao };
      } else {
        await pool.query("UPDATE usuarios SET plano = 'FREE', vip_expiracao = NULL WHERE telegram_id = $1", [telegramId]);
        return { plano: 'FREE', ativo: false };
      }
    }
    return { plano: 'FREE', ativo: false };
  } catch (err) {
    console.error('Erro ao verificar acesso:', err);
    return { plano: 'FREE', ativo: false };
  }
}

// Garantir cadastro do usuário ao interagir
async function garantirUsuario(msg) {
  const chatId = msg.chat.id;
  const user = msg.from;
  const username = user.username ? `@${user.username}` : user.first_name || 'Usuário';
  const origem = msg.text && msg.text.startsWith('/start ') ? msg.text.split(' ')[1] : 'direto';

  try {
    const check = await pool.query('SELECT * FROM usuarios WHERE telegram_id = $1', [chatId]);
    if (check.rows.length === 0) {
      await pool.query(
        'INSERT INTO usuarios (telegram_id, plano, username, data_cadastro, origem) VALUES ($1, $2, $3, NOW(), $4)',
        [chatId, 'FREE', username, origem]
      );
    } else {
      await pool.query('UPDATE usuarios SET username = $1 WHERE telegram_id = $2', [username, chatId]);
    }
  } catch (err) {
    console.error('Erro ao garantir usuário:', err);
  }
}

// Comando /start
bot.onText(/\/start/, async (msg) => {
  await garantirUsuario(msg);
  const chatId = msg.chat.id;
  const statusVip = await verificarAcesso(chatId);
  const welcomeText = `🚀 *Bem-vindo ao Imperium Cash!*\n\nO seu assistente financeiro pessoal inteligente.\n\n` +
                      `Status atual: *${statusVip.ativo ? 'VIP (Imperium Plus) 👑' : 'FREE 🟢'}*\n\n` +
                      `Utilize os botões abaixo para navegar:`;

  bot.sendMessage(chatId, welcomeText, { parse_mode: 'Markdown', ...mainReplyKeyboard });
});

bot.onText(/\/meuid/, async (msg) => {
  await garantirUsuario(msg);
  bot.sendMessage(msg.chat.id, `🆔 Seu ID do Telegram é: \`${msg.chat.id}\``, { parse_mode: 'Markdown', ...mainReplyKeyboard });
});

bot.onText(/\/(clean|cls)/, (msg) => {
  bot.sendMessage(msg.chat.id, '🧹 Para limpar o chat, utilize a opção do menu do seu aplicativo do Telegram.', mainReplyKeyboard);
});

// Tratamento de interações por texto do Teclado Fixo
bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;
  await garantirUsuario(msg);
  const chatId = msg.chat.id;
  const text = msg.text.trim();

  if (text.toLowerCase() === 'cancelar') {
    awaitingReceipt.delete(chatId);
    userStates.delete(chatId);
    bot.sendMessage(chatId, '❌ Operação cancelada.', mainReplyKeyboard);
    return;
  }

  // Se o usuário clicou nos botões principais do teclado fixo
  if (text === 'Ganhei') {
    bot.sendMessage(chatId, '🟢 *Registrar Ganho*\n\nEnvie no formato:\n`ganhei [valor] [descrição]`\nExemplo: `ganhei 1500 salário`', { parse_mode: 'Markdown', ...mainReplyKeyboard });
    return;
  }
  if (text === 'Gastei') {
    bot.sendMessage(chatId, '🔴 *Registrar Gasto*\n\nEnvie no formato:\n`gastei [valor] [descrição]`\nExemplo: `gastei 45.90 mercado`', { parse_mode: 'Markdown', ...mainReplyKeyboard });
    return;
  }
  if (text === 'Investi') {
    bot.sendMessage(chatId, '🔵 *Registrar Investimento*\n\nEnvie no formato:\n`investi [valor] [descrição]`\nExemplo: `investi 200 acoes`', { parse_mode: 'Markdown', ...mainReplyKeyboard });
    return;
  }
  if (text === 'Análise') {
    try {
      const res = await pool.query('SELECT tipo, SUM(valor) as total FROM transacoes WHERE telegram_id = $1 OR user_id = $1 GROUP BY tipo', [chatId]);
      let ganhos = 0, gastos = 0, investimentos = 0;
      res.rows.forEach(r => {
        if (r.tipo === 'ganho') ganhos = Number(r.total);
        if (r.tipo === 'gasto') gastos = Number(r.total);
        if (r.tipo === 'investimento') investimentos = Number(r.total);
      });
      const saldo = ganhos - gastos - investimentos;
      const textAnise = `📊 *Sua Análise Financeira*\n\n` +
                        `🟢 Total Ganho: R$ ${ganhos.toFixed(2)}\n` +
                        `🔴 Total Gasto: R$ ${gastos.toFixed(2)}\n` +
                        `🔵 Total Investido: R$ ${investimentos.toFixed(2)}\n` +
                        `💰 *Saldo Líquido:* R$ ${saldo.toFixed(2)}`;
      bot.sendMessage(chatId, textAnise, { parse_mode: 'Markdown', ...mainReplyKeyboard });
    } catch (err) {
      console.error('Erro na análise:', err);
      bot.sendMessage(chatId, '❌ Erro ao carregar análise.', mainReplyKeyboard);
    }
    return;
  }
  if (text === 'Histórico') {
    try {
      const res = await pool.query('SELECT * FROM transacoes WHERE telegram_id = $1 OR user_id = $1 ORDER BY data DESC LIMIT 10', [chatId]);
      if (res.rows.length === 0) {
        bot.sendMessage(chatId, '📜 Nenhuma transação encontrada.', mainReplyKeyboard);
        return;
      }
      let histText = '📜 *Suas Últimas 10 Transações:*\n\n';
      const inlineKeyboard = [];
      res.rows.forEach((tx, idx) => {
        const dataF = new Date(tx.data).toLocaleDateString('pt-BR');
        const valorF = Number(tx.valor).toFixed(2);
        const tipoEmoji = tx.tipo === 'ganho' ? '🟢' : tx.tipo === 'investimento' ? '🔵' : '🔴';
        histText += `${idx + 1}. ${tipoEmoji} *${tx.tipo.toUpperCase()}* | R$ ${valorF} | ${tx.descricao} (${dataF})\n`;
        inlineKeyboard.push([
          { text: `✏️ Editar #${tx.id}`, callback_data: `edit_tx_${tx.id}` },
          { text: `🗑️ Excluir #${tx.id}`, callback_data: `del_tx_${tx.id}` }
        ]);
      });
      bot.sendMessage(chatId, histText, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } });
      bot.sendMessage(chatId, 'Para voltar ao menu, use o teclado abaixo:', mainReplyKeyboard);
    } catch (err) {
      console.error('Erro ao listar:', err);
      bot.sendMessage(chatId, '❌ Erro ao carregar histórico.', mainReplyKeyboard);
    }
    return;
  }
  if (text === 'Minha Conta') {
    const statusVip = await verificarAcesso(chatId);
    const userRes = await pool.query('SELECT * FROM usuarios WHERE telegram_id = $1', [chatId]);
    const txCountRes = await pool.query('SELECT COUNT(*) FROM transacoes WHERE telegram_id = $1 OR user_id = $1', [chatId]);
    const userData = userRes.rows[0];
    const txCount = txCountRes.rows[0].count;

    let vipInfo = 'Plano Atual: **FREE 🟢**\n• Tenha recursos avançados com o Imperium Plus.';
    if (statusVip.ativo) {
      const expDate = new Date(statusVip.expiracao).toLocaleDateString('pt-BR');
      vipInfo = `Plano Atual: **VIP (Imperium Plus) 👑**\n📅 Vencimento: \`${expDate}\`\nStatus: Ativo`;
    }

    const contaText = `👤 *Minha Conta*\n\n` +
                      `🆔 ID: \`${chatId}\`\n` +
                      `🏷️ Username: ${userData.username || 'Não definido'}\n` +
                      `${vipInfo}\n\n` +
                      `📊 Total de Registros: \`${txCount}\`\n` +
                      `📌 Origem: \`${userData.origem || 'direto'}\``;
    bot.sendMessage(chatId, contaText, { parse_mode: 'Markdown', ...mainReplyKeyboard });
    return;
  }

  if (text === '💎 Assinar Imperium Plus') {
    const pixKey = process.env.PIX_KEY;
    const receiverName = process.env.PIX_RECEIVER_NAME;
    const description = process.env.PIX_PAYMENT_DESCRIPTION || 'Assinatura Imperium Plus';
    const statusVip = await verificarAcesso(chatId);

    if (!pixKey || !receiverName) {
      bot.sendMessage(chatId, '⚠️ O sistema de pagamentos via Pix está temporariamente indisponível.', mainReplyKeyboard);
      return;
    }

    const pendRes = await pool.query("SELECT * FROM pagamento_solicitacoes WHERE telegram_id = $1 AND status = 'PENDING'", [chatId]);
    if (pendRes.rows.length > 0) {
      bot.sendMessage(chatId, '⏳ Você já possui uma solicitação pendente aguardando análise administrativa.', mainReplyKeyboard);
      return;
    }

    let infoVipAtivo = '';
    if (statusVip.ativo) {
      const expDate = new Date(statusVip.expiracao).toLocaleDateString('pt-BR');
      infoVipAtivo = `\nℹ️ *Nota:* Você já é VIP até \`${expDate}\`. Pagamentos adicionais somarão 30 dias à validade atual!\n`;
    }

    const plusText = `💎 *Imperium Plus* — Assinatura Mensal\n\n` +
                     `• *Preço:* R$ 5,00\n` +
                     `• *Duração:* 30 dias de acesso VIP\n` +
                     `• *Benefícios:* Gráficos avançados, exportação ilimitada de planilhas Excel e relatórios detalhados.\n` +
                     `${infoVipAtivo}\n` +
                     `📌 *Dados para Pagamento via Pix:*\n` +
                     `• **Chave Pix:** \`${pixKey}\`\n` +
                     `• **Nome:** ${receiverName}\n` +
                     `• **Descrição:** ${description}\n\n` +
                     `💳 *Como proceder:*\n` +
                     `1. Faça um Pix no valor exato de **R$ 5,00**.\n` +
                     `2. Clique no botão abaixo para confirmar e enviar o comprovante.`;

    const inlineKeyboard = {
      inline_keyboard: [
        [{ text: '✅ Já realizei o pagamento', callback_data: 'enviar_comprovante_fluxo' }],
        [{ text: '↩️ Cancelar', callback_data: 'cancelar_assinatura' }]
      ]
    };

    bot.sendMessage(chatId, plusText, { parse_mode: 'Markdown', reply_markup: inlineKeyboard });
    return;
  }

  // Tratamento de estados (edição de transações)
  if (userStates.has(chatId)) {
    const state = userStates.get(chatId);
    if (state.action === 'editing') {
      const parts = text.split(/\s+/);
      if (parts.length < 2) {
        bot.sendMessage(chatId, '⚠️ Formato inválido. Use: `[tipo] [valor] [descrição]`', mainReplyKeyboard);
        return;
      }
      const tipoBruto = parts[0].toLowerCase();
      let tipo = 'gasto';
      if (tipoBruto.startsWith('ganh')) tipo = 'ganho';
      if (tipoBruto.startsWith('inv')) tipo = 'investimento';

      const valor = parseFloat(parts[1].replace(',', '.'));
      const descricao = parts.slice(2).join(' ') || 'Sem descrição';

      if (isNaN(valor) || valor <= 0) {
        bot.sendMessage(chatId, '⚠️ Valor numérico inválido.', mainReplyKeyboard);
        return;
      }

      try {
        await pool.query(
          'UPDATE transacoes SET tipo = $1, valor = $2, descricao = $3 WHERE id = $4 AND (telegram_id = $5 OR user_id = $5)',
          [tipo, valor, descricao, state.txId, chatId]
        );
        userStates.delete(chatId);
        bot.sendMessage(chatId, `✅ Transação #${state.txId} atualizada com sucesso!`, mainReplyKeyboard);
      } catch (err) {
        console.error('Erro ao atualizar:', err);
        bot.sendMessage(chatId, '❌ Erro ao atualizar transação.', mainReplyKeyboard);
      }
      return;
    }
  }
});

// Tratamento de Callback Queries (Inline buttons para assinatura e histórico)
bot.on('callback_query', async (callbackQuery) => {
  const msg = callbackQuery.message;
  const chatId = msg.chat.id;
  const data = callbackQuery.data;
  const userId = callbackQuery.from.id;

  await garantirUsuario({ chat: { id: userId }, from: callbackQuery.from });

  if (data === 'enviar_comprovante_fluxo') {
    awaitingReceipt.add(userId);
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Envie o comprovante agora!' });
    bot.sendMessage(userId, '📥 *Envio de Comprovante*\n\nPor favor, envie a foto ou documento PDF do seu comprovante de pagamento Pix.', { parse_mode: 'Markdown' });
  }

  else if (data === 'cancelar_assinatura' || data === 'voltar_inicio') {
    awaitingReceipt.delete(userId);
    await bot.answerCallbackQuery(callbackQuery.id);
    bot.sendMessage(userId, '❌ Processo de assinatura cancelado.', mainReplyKeyboard);
  }

  else if (data.startsWith('del_tx_')) {
    await bot.answerCallbackQuery(callbackQuery.id);
    const txId = parseInt(data.split('_')[2]);
    const keyboard = {
      inline_keyboard: [
        [
          { text: '✅ Sim, excluir', callback_data: `confirm_del_${txId}` },
          { text: '❌ Cancelar', callback_data: 'voltar_inicio' }
        ]
      ]
    };
    bot.sendMessage(chatId, `⚠️ Tem certeza que deseja excluir permanentemente a transação #${txId}?`, { reply_markup: keyboard });
  }

  else if (data.startsWith('confirm_del_')) {
    const txId = parseInt(data.split('_')[2]);
    try {
      await pool.query('DELETE FROM transacoes WHERE id = $1 AND (telegram_id = $2 OR user_id = $2)', [txId, userId]);
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'Excluído com sucesso!' });
      bot.sendMessage(userId, '🗑️ Transação excluída com sucesso!', mainReplyKeyboard);
    } catch (err) {
      console.error('Erro ao excluir:', err);
    }
  }

  else if (data.startsWith('edit_tx_')) {
    await bot.answerCallbackQuery(callbackQuery.id);
    const txId = parseInt(data.split('_')[2]);
    const txRes = await pool.query('SELECT * FROM transacoes WHERE id = $1 AND (telegram_id = $2 OR user_id = $2)', [txId, userId]);
    if (txRes.rows.length === 0) return;
    const tx = txRes.rows[0];
    userStates.set(userId, { action: 'editing', txId: tx.id });

    bot.sendMessage(userId, `✏️ *Editar Transação #${tx.id}*\n\nAtual: ${tx.tipo.toUpperCase()} | R$ ${tx.valor} | ${tx.descricao}\n\nEnvie os novos dados no formato: \`[tipo] [valor] [descrição]\``, { parse_mode: 'Markdown' });
  }

  // Aprovação ou Rejeição Administrativa
  else if (data.startsWith('aprovar_pag_') || data.startsWith('rejeitar_pag_')) {
    if (!ownerId || userId !== ownerId) {
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'Acesso negado.', show_alert: true });
      return;
    }

    const parts = data.split('_');
    const action = parts[0];
    const reqId = parseInt(parts[2]);

    try {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const reqRes = await client.query('SELECT * FROM pagamento_solicitacoes WHERE id = $1 FOR UPDATE', [reqId]);
        if (reqRes.rows.length === 0) {
          await client.query('ROLLBACK');
          await bot.answerCallbackQuery(callbackQuery.id, { text: 'Solicitação não encontrada.', show_alert: true });
          return;
        }

        const solicitacao = reqRes.rows[0];
        if (solicitacao.status !== 'PENDING') {
          await client.query('ROLLBACK');
          await bot.answerCallbackQuery(callbackQuery.id, { text: 'Já processada.', show_alert: true });
          return;
        }

        if (action === 'aprovar') {
          await client.query("UPDATE pagamento_solicitacoes SET status = 'APPROVED', reviewed_at = NOW(), reviewed_by = $1 WHERE id = $2", [userId, reqId]);

          const userRes = await client.query('SELECT plano, vip_expiracao FROM usuarios WHERE telegram_id = $1', [solicitacao.telegram_id]);
          let novaData;
          const agora = new Date();
          if (userRes.rows.length > 0 && userRes.rows[0].plano === 'VIP' && userRes.rows[0].vip_expiracao) {
            const expAtual = new Date(userRes.rows[0].vip_expiracao);
            novaData = expAtual > agora ? new Date(expAtual.getTime() + 30 * 24 * 60 * 60 * 1000) : new Date(agora.getTime() + 30 * 24 * 60 * 60 * 1000);
          } else {
            novaData = new Date(agora.getTime() + 30 * 24 * 60 * 60 * 1000);
          }

          await client.query("UPDATE usuarios SET plano = 'VIP', vip_expiracao = $1 WHERE telegram_id = $2", [novaData, solicitacao.telegram_id]);
          await client.query('COMMIT');

          await bot.answerCallbackQuery(callbackQuery.id, { text: 'Aprovado com sucesso!' });
          bot.editMessageCaption(`✅ *SOLICITAÇÃO APROVADA*\nID: \`${reqId}\`\nCliente: ${solicitacao.username} (\`${solicitacao.telegram_id}\`)`, { parse_mode: 'Markdown' });

          bot.sendMessage(solicitacao.telegram_id, `🎉 *Pagamento Aprovado!*\n\nSua assinatura do **Imperium Plus** foi ativada até \`${novaData.toLocaleDateString('pt-BR')}\`.`, { parse_mode: 'Markdown', ...mainReplyKeyboard });
        } else if (action === 'rejeitar') {
          await client.query("UPDATE pagamento_solicitacoes SET status = 'REJECTED', reviewed_at = NOW(), reviewed_by = $1 WHERE id = $2", [userId, reqId]);
          await client.query('COMMIT');

          await bot.answerCallbackQuery(callbackQuery.id, { text: 'Rejeitado.' });
          bot.editMessageCaption(`❌ *SOLICITAÇÃO REJEITADA*\nID: \`${reqId}\`\nCliente: ${solicitacao.username} (\`${solicitacao.telegram_id}\`)`, { parse_mode: 'Markdown' });

          bot.sendMessage(solicitacao.telegram_id, `⚠️ Seu comprovante do Imperium Plus não foi aprovado. Entre em contato com o suporte.`, { parse_mode: 'Markdown', ...mainReplyKeyboard });
        }
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(err);
      } finally {
        client.release();
      }
    } catch (err) {
      console.error(err);
    }
  }
});

// Recebimento de Comprovantes (Fotos ou Documentos)
bot.on('photo', async (msg) => {
  const chatId = msg.chat.id;
  if (ownerId && chatId === ownerId) return;

  if (awaitingReceipt.has(chatId)) {
    awaitingReceipt.delete(chatId);
    const photo = msg.photo[msg.photo.length - 1];
    await registrarEEnviarSolicitacao(msg, photo.file_id, 'photo');
  }
});

bot.on('document', async (msg) => {
  const chatId = msg.chat.id;
  if (ownerId && chatId === ownerId) return;

  if (awaitingReceipt.has(chatId)) {
    awaitingReceipt.delete(chatId);
    const document = msg.document;
    await registrarEEnviarSolicitacao(msg, document.file_id, 'document');
  }
});

async function registrarEEnviarSolicitacao(msg, fileId, fileType) {
  const chatId = msg.chat.id;
  const user = msg.from;
  const nomeCliente = user.first_name || 'Cliente';
  const username = user.username ? `@${user.username}` : 'Não disponível';

  try {
    const res = await pool.query(
      `INSERT INTO pagamento_solicitacoes (telegram_id, username, valor, status, telegram_file_id, file_type, created_at)
       VALUES ($1, $2, 5.00, 'PENDING', $3, $4, NOW()) RETURNING id`,
      [chatId, username, fileId, fileType]
    );

    const reqId = res.rows[0].id;
    const dataHoraEnvio = new Date().toLocaleString('pt-BR');

    bot.sendMessage(chatId, '✅ *Comprovante recebido!*\n\nSua solicitação foi enviada para análise administrativa.', { parse_mode: 'Markdown', ...mainReplyKeyboard });

    if (ownerId) {
      const captionAdmin = `💰 *NOVA SOLICITAÇÃO DE ASSINATURA*\n\n` +
                           `• **Nome do cliente:** ${nomeCliente}\n` +
                           `• **Username do Telegram:** ${username}\n` +
                           `• **ID numérico do cliente:** \`${chatId}\`\n` +
                           `• **Plano solicitado:** Imperium Plus\n` +
                           `• **Valor esperado:** R$ 5,00\n` +
                           `• **ID único da solicitação:** \`${reqId}\`\n` +
                           `• **Data e horário:** ${dataHoraEnvio}`;

      const keyboardAdmin = {
        inline_keyboard: [
          [
            { text: '✅ Aprovar pagamento', callback_data: `aprovar_pag_${reqId}` },
            { text: '❌ Rejeitar pagamento', callback_data: `rejeitar_pag_${reqId}` }
          ]
        ]
      };

      if (fileType === 'photo') {
        await bot.sendPhoto(ownerId, fileId, { caption: captionAdmin, parse_mode: 'Markdown', reply_markup: keyboardAdmin });
      } else {
        await bot.sendDocument(ownerId, fileId, { caption: captionAdmin, parse_mode: 'Markdown', reply_markup: keyboardAdmin });
      }
    }
  } catch (err) {
    console.error('Erro ao registrar:', err);
    bot.sendMessage(chatId, '❌ Erro ao enviar comprovante.', mainReplyKeyboard);
  }
}

// Regex rápido para transações (Ganhei / Gastei / Investi direto por texto)
bot.onText(/(ganhei|gastei|investi)\s+([0-9.,]+)(?:\s+(.*))?/i, async (msg, match) => {
  if (userStates.has(msg.chat.id)) return;
  await garantirUsuario(msg);
  const chatId = msg.chat.id;
  const tipoBruto = match[1].toLowerCase();
  let tipo = 'gasto';
  if (tipoBruto.startsWith('ganh')) tipo = 'ganho';
  if (tipoBruto.startsWith('inv')) tipo = 'investimento';

  const valorStr = match[2].replace(',', '.');
  const valor = parseFloat(valorStr);
  const descricao = match[3] || 'Sem descrição';

  if (isNaN(valor) || valor <= 0) return;

  try {
    await pool.query(
      'INSERT INTO transacoes (telegram_id, user_id, tipo, valor, descricao, data) VALUES ($1, $1, $2, $3, $4, NOW())',
      [chatId, tipo, valor, descricao]
    );

    const emoji = tipo === 'ganho' ? '🟢' : tipo === 'investimento' ? '🔵' : '🔴';
    bot.sendMessage(chatId, `${emoji} *Transação registrada!*\nTipo: *${tipo.toUpperCase()}*\nValor: *R$ ${valor.toFixed(2)}*\nDescrição: ${descricao}`, { parse_mode: 'Markdown', ...mainReplyKeyboard });
  } catch (err) {
    console.error('Erro:', err);
  }
});

// Avisos automáticos de vencimento VIP
async function verificarVencimentosAutomaticos() {
  try {
    const agora = new Date();
    const res = await pool.query("SELECT * FROM usuarios WHERE plano = 'VIP' AND vip_expiracao IS NOT NULL");
    
    for (const user of res.rows) {
      const expDate = new Date(user.vip_expiracao);
      const diffTime = expDate.getTime() - agora.getTime();
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

      if (diffDays === 3) {
        bot.sendMessage(user.telegram_id, `⚠️ *Aviso de Vencimento*\n\nSua assinatura do **Imperium Plus** vence em **3 dias** (${expDate.toLocaleDateString('pt-BR')}).`, { parse_mode: 'Markdown', ...mainReplyKeyboard })
           .catch(() => {});
      } else if (diffDays === 0) {
        bot.sendMessage(user.telegram_id, `🚨 *Seu VIP vence hoje!*\n\nSua assinatura expira hoje (${expDate.toLocaleDateString('pt-BR')}).`, { parse_mode: 'Markdown', ...mainReplyKeyboard })
           .catch(() => {});
      }
    }
  } catch (err) {
    console.error('Erro na verificação:', err);
  }
}

setInterval(verificarVencimentosAutomaticos, 12 * 60 * 60 * 1000);

console.log('🤖 Bot Imperium Cash iniciado com sucesso!');