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
const userStates = new Map(); // Para edição de transações

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

// Menu Principal Dinâmico com Botões Nativos do Telegram
async function enviarMenuPrincipal(chatId, messageId = null) {
  const statusVip = await verificarAcesso(chatId);
  const welcomeText = `🚀 *Bem-vindo ao Imperium Cash!*\n\nO seu assistente financeiro pessoal inteligente.\n\n` +
                      `Status atual: *${statusVip.ativo ? 'VIP (Imperium Plus) 👑' : 'FREE 🟢'}*`;

  const keyboardRows = [
    [{ text: '📊 Minha Conta & VIP', callback_data: 'minha_conta' }]
  ];

  if (!statusVip.ativo) {
    keyboardRows.push([{ text: '💎 Assinar Imperium Plus', callback_data: 'ver_plus' }]);
  } else {
    keyboardRows.push([{ text: '👑 Renovar / Gerenciar Imperium Plus', callback_data: 'ver_plus' }]);
  }

  keyboardRows.push(
    [{ text: '💸 Registrar Transação', callback_data: 'ajuda_transacoes' }],
    [{ text: '📜 Histórico de Transações', callback_data: 'listar_transacoes' }]
  );

  const keyboard = { inline_keyboard: keyboardRows };

  if (messageId) {
    try {
      await bot.editMessageText(welcomeText, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: keyboard
      });
      return;
    } catch (e) {
      // Ignora caso não possa editar
    }
  }
  bot.sendMessage(chatId, welcomeText, { parse_mode: 'Markdown', reply_markup: keyboard });
}

// Comando /start
bot.onText(/\/start/, async (msg) => {
  await garantirUsuario(msg);
  await enviarMenuPrincipal(msg.chat.id);
});

bot.onText(/\/meuid/, async (msg) => {
  await garantirUsuario(msg);
  bot.sendMessage(msg.chat.id, `🆔 Seu ID do Telegram é: \`${msg.chat.id}\``, { parse_mode: 'Markdown' });
});

bot.onText(/\/(clean|cls)/, (msg) => {
  bot.sendMessage(msg.chat.id, '🧹 Para limpar o chat, utilize a opção do menu do seu aplicativo do Telegram (Limpar histórico).');
});

// Callback Queries (Gerenciamento de Botões Inline Nativos)
bot.on('callback_query', async (callbackQuery) => {
  const msg = callbackQuery.message;
  const chatId = msg.chat.id;
  const data = callbackQuery.data;
  const userId = callbackQuery.from.id;

  await garantirUsuario({ chat: { id: userId }, from: callbackQuery.from });

  if (data === 'minha_conta') {
    const statusVip = await verificarAcesso(userId);
    const userRes = await pool.query('SELECT * FROM usuarios WHERE telegram_id = $1', [userId]);
    const txCountRes = await pool.query('SELECT COUNT(*) FROM transacoes WHERE telegram_id = $1 OR user_id = $1', [userId]);
    const userData = userRes.rows[0];
    const txCount = txCountRes.rows[0].count;

    let vipInfo = 'Plano Atual: **FREE 🟢**\n• Tenha recursos avançados assinando o Imperium Plus.';
    let btnTexto = '💎 Assinar Imperium Plus';
    if (statusVip.ativo) {
      const expDate = new Date(statusVip.expiracao).toLocaleDateString('pt-BR');
      vipInfo = `Plano Atual: **VIP (Imperium Plus) 👑**\n📅 Vencimento: \`${expDate}\`\nStatus: Ativo`;
      btnTexto = '👑 Renovar Imperium Plus (Mais 30 dias)';
    }

    const text = `👤 *Minha Conta*\n\n` +
                 `🆔 ID: \`${userId}\`\n` +
                 `🏷️ Username: ${userData.username || 'Não definido'}\n` +
                 `${vipInfo}\n\n` +
                 `📊 Total de Registros Financeiros: \`${txCount}\`\n` +
                 `📌 Origem: \`${userData.origem || 'direto'}\``;

    const keyboard = {
      inline_keyboard: [
        [{ text: btnTexto, callback_data: 'ver_plus' }],
        [{ text: '↩️ Voltar ao menu', callback_data: 'voltar_inicio' }]
      ]
    };

    bot.editMessageText(text, {
      chat_id: chatId,
      message_id: msg.message_id,
      parse_mode: 'Markdown',
      reply_markup: keyboard
    });
  }

  else if (data === 'ver_plus') {
    const pixKey = process.env.PIX_KEY;
    const receiverName = process.env.PIX_RECEIVER_NAME;
    const description = process.env.PIX_PAYMENT_DESCRIPTION || 'Assinatura Imperium Plus';
    const statusVip = await verificarAcesso(userId);

    if (!pixKey || !receiverName) {
      bot.answerCallbackQuery(callbackQuery.id, { text: 'Configuração de pagamento pendente pelo administrador.', show_alert: true });
      if (ownerId && userId === ownerId) {
        bot.sendMessage(userId, '⚠️ *Atenção Administrador:* As variáveis \`PIX_KEY\` e \`PIX_RECEIVER_NAME\` não estão configuradas no arquivo .env.', { parse_mode: 'Markdown' });
      } else {
        bot.sendMessage(userId, '⚠️ O sistema de pagamentos via Pix está temporariamente indisponível. O administrador foi avisado.');
      }
      return;
    }

    // Verificar solicitação pendente
    const pendRes = await pool.query("SELECT * FROM pagamento_solicitacoes WHERE telegram_id = $1 AND status = 'PENDING'", [userId]);
    if (pendRes.rows.length > 0) {
      bot.answerCallbackQuery(callbackQuery.id, { text: 'Você já possui uma solicitação pendente!', show_alert: true });
      bot.sendMessage(userId, '⏳ Você já enviou um comprovante que está aguardando análise administrativa. Aguarde a confirmação.');
      return;
    }

    let infoVipAtivo = '';
    if (statusVip.ativo) {
      const expDate = new Date(statusVip.expiracao).toLocaleDateString('pt-BR');
      infoVipAtivo = `\nℹ️ *Nota de Renovação:* Você já é VIP até \`${expDate}\`. Se aprovar um novo pagamento agora, os 30 dias serão adicionados ao final da sua validade atual!\n`;
    }

    const text = `💎 *Imperium Plus* — Assinatura Mensal\n\n` +
                 `• *Preço:* R$ 5,00\n` +
                 `• *Duração:* 30 dias de acesso VIP\n` +
                 `• *Benefícios:* Gráficos avançados, exportação ilimitada de planilhas Excel, relatórios detalhados e prioridade.\n` +
                 `${infoVipAtivo}\n` +
                 `📌 *Dados para Pagamento via Pix:*\n` +
                 `• **Chave Pix:** \`${pixKey}\`\n` +
                 `• **Nome:** ${receiverName}\n` +
                 `• **Descrição:** ${description}\n\n` +
                 `💳 *Como proceder:*\n` +
                 `1. Faça um Pix no valor exato de **R$ 5,00** para a chave acima.\n` +
                 `2. Clique no botão abaixo para informar que realizou o pagamento e enviar o comprovante.`;

    const keyboard = {
      inline_keyboard: [
        [{ text: '✅ Já realizei o pagamento', callback_data: 'enviar_comprovante_fluxo' }],
        [{ text: '↩️ Voltar ao menu', callback_data: 'voltar_inicio' }]
      ]
    };

    bot.editMessageText(text, {
      chat_id: chatId,
      message_id: msg.message_id,
      parse_mode: 'Markdown',
      reply_markup: keyboard
    });
  }

  else if (data === 'enviar_comprovante_fluxo') {
    awaitingReceipt.add(userId);
    bot.answerCallbackQuery(callbackQuery.id);
    bot.sendMessage(userId, '📥 *Envio de Comprovante*\n\nPor favor, envie agora a **foto** ou o **arquivo PDF** do seu comprovante de pagamento Pix.\n\n*Nota:* O sistema aceita imagens e documentos PDF.', { parse_mode: 'Markdown' });
  }

  else if (data === 'voltar_inicio') {
    await enviarMenuPrincipal(chatId, msg.message_id);
  }

  else if (data === 'ajuda_transacoes') {
    const text = `💸 *Como Registrar Transações:*\n\n` +
                 `Utilize os comandos diretos no chat:\n` +
                 `• Ganho: \`ganhei [valor] [descrição]\`\n` +
                 `• Gasto: \`gastei [valor] [descrição]\`\n` +
                 `• Investimento: \`investi [valor] [descrição]\`\n\n` +
                 `Exemplo: \`gastei 45.90 almoço\``;
    const keyboard = { inline_keyboard: [[{ text: '↩️ Voltar ao menu', callback_data: 'voltar_inicio' }]] };
    bot.editMessageText(text, { chat_id: chatId, message_id: msg.message_id, parse_mode: 'Markdown', reply_markup: keyboard });
  }

  else if (data === 'listar_transacoes') {
    try {
      const res = await pool.query('SELECT * FROM transacoes WHERE telegram_id = $1 OR user_id = $1 ORDER BY data DESC LIMIT 10', [userId]);
      if (res.rows.length === 0) {
        bot.answerCallbackQuery(callbackQuery.id, { text: 'Nenhuma transação encontrada.', show_alert: true });
        return;
      }

      let text = '📜 *Suas Últimas 10 Transações:*\n\n';
      const inlineKeyboard = [];

      res.rows.forEach((tx, idx) => {
        const dataF = new Date(tx.data).toLocaleDateString('pt-BR');
        const valorF = Number(tx.valor).toFixed(2);
        const tipoEmoji = tx.tipo === 'ganho' ? '🟢' : tx.tipo === 'investimento' ? '🔵' : '🔴';
        text += `${idx + 1}. ${tipoEmoji} *${tx.tipo.toUpperCase()}* | R$ ${valorF} | ${tx.descricao} (${dataF})\n`;
        
        inlineKeyboard.push([
          { text: `✏️ Editar #${tx.id}`, callback_data: `edit_tx_${tx.id}` },
          { text: `🗑️ Excluir #${tx.id}`, callback_data: `del_tx_${tx.id}` }
        ]);
      });

      inlineKeyboard.push([{ text: '↩️ Voltar ao menu', callback_data: 'voltar_inicio' }]);

      bot.editMessageText(text, {
        chat_id: chatId,
        message_id: msg.message_id,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: inlineKeyboard }
      });
    } catch (err) {
      console.error('Erro ao listar transações:', err);
      bot.answerCallbackQuery(callbackQuery.id, { text: 'Erro ao carregar histórico.', show_alert: true });
    }
  }

  else if (data.startsWith('del_tx_')) {
    const txId = parseInt(data.split('_')[2]);
    const keyboard = {
      inline_keyboard: [
        [
          { text: '✅ Sim, excluir', callback_data: `confirm_del_${txId}` },
          { text: '❌ Cancelar', callback_data: 'listar_transacoes' }
        ]
      ]
    };
    bot.editMessageText(`⚠️ Tem certeza que deseja excluir permanentemente a transação #${txId}?`, {
      chat_id: chatId,
      message_id: msg.message_id,
      reply_markup: keyboard
    });
  }

  else if (data.startsWith('confirm_del_')) {
    const txId = parseInt(data.split('_')[2]);
    try {
      await pool.query('DELETE FROM transacoes WHERE id = $1 AND (telegram_id = $2 OR user_id = $2)', [txId, userId]);
      bot.answerCallbackQuery(callbackQuery.id, { text: 'Transação excluída com sucesso!' });
      const res = await pool.query('SELECT * FROM transacoes WHERE telegram_id = $1 OR user_id = $1 ORDER BY data DESC LIMIT 10', [userId]);
      if (res.rows.length === 0) {
        bot.editMessageText('📜 Histórico vazio.', { chat_id: chatId, message_id: msg.message_id, reply_markup: { inline_keyboard: [[{ text: '↩️ Voltar ao menu', callback_data: 'voltar_inicio' }]] } });
        return;
      }
      let text = '📜 *Suas Últimas 10 Transações:*\n\n';
      const inlineKeyboard = [];
      res.rows.forEach((tx, idx) => {
        const dataF = new Date(tx.data).toLocaleDateString('pt-BR');
        const valorF = Number(tx.valor).toFixed(2);
        const tipoEmoji = tx.tipo === 'ganho' ? '🟢' : tx.tipo === 'investimento' ? '🔵' : '🔴';
        text += `${idx + 1}. ${tipoEmoji} *${tx.tipo.toUpperCase()}* | R$ ${valorF} | ${tx.descricao} (${dataF})\n`;
        inlineKeyboard.push([
          { text: `✏️ Editar #${tx.id}`, callback_data: `edit_tx_${tx.id}` },
          { text: `🗑️ Excluir #${tx.id}`, callback_data: `del_tx_${tx.id}` }
        ]);
      });
      inlineKeyboard.push([{ text: '↩️ Voltar ao menu', callback_data: 'voltar_inicio' }]);
      bot.editMessageText(text, { chat_id: chatId, message_id: msg.message_id, parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } });
    } catch (err) {
      console.error('Erro ao excluir:', err);
      bot.answerCallbackQuery(callbackQuery.id, { text: 'Erro ao excluir transação.', show_alert: true });
    }
  }

  else if (data.startsWith('edit_tx_')) {
    const txId = parseInt(data.split('_')[2]);
    const txRes = await pool.query('SELECT * FROM transacoes WHERE id = $1 AND (telegram_id = $2 OR user_id = $2)', [txId, userId]);
    if (txRes.rows.length === 0) {
      bot.answerCallbackQuery(callbackQuery.id, { text: 'Transação não encontrada ou sem permissão.', show_alert: true });
      return;
    }
    const tx = txRes.rows[0];
    userStates.set(userId, { action: 'editing', txId: tx.id });

    const text = `✏️ *Editar Transação #${tx.id}*\n\n` +
                 `Atual: ${tx.tipo.toUpperCase()} | R$ ${tx.valor} | ${tx.descricao}\n\n` +
                 `Envie os novos dados no formato:\n\`[tipo] [valor] [descrição]\`\n` +
                 `Exemplo: \`gastei 55.00 mercado extra\`\n\n` +
                 `*(Envie 'cancelar' para abortar)*`;

    const keyboard = { inline_keyboard: [[{ text: '❌ Cancelar Edição', callback_data: 'listar_transacoes' }]] };
    bot.editMessageText(text, { chat_id: chatId, message_id: msg.message_id, parse_mode: 'Markdown', reply_markup: keyboard });
  }

  // Ações do Administrador (Aprovar / Rejeitar com botões solicitados)
  else if (data.startsWith('aprovar_pag_') || data.startsWith('rejeitar_pag_')) {
    if (!ownerId || userId !== ownerId) {
      bot.answerCallbackQuery(callbackQuery.id, { text: 'Acesso negado. Apenas o administrador.', show_alert: true });
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
          bot.answerCallbackQuery(callbackQuery.id, { text: 'Solicitação não encontrada.', show_alert: true });
          return;
        }

        const solicitacao = reqRes.rows[0];
        if (solicitacao.status !== 'PENDING') {
          await client.query('ROLLBACK');
          bot.answerCallbackQuery(callbackQuery.id, { text: `Esta solicitação já foi processada (${solicitacao.status}).`, show_alert: true });
          return;
        }

        if (action === 'aprovar') {
          await client.query(
            "UPDATE pagamento_solicitacoes SET status = 'APPROVED', reviewed_at = NOW(), reviewed_by = $1 WHERE id = $2",
            [userId, reqId]
          );

          const userRes = await client.query('SELECT plano, vip_expiracao FROM usuarios WHERE telegram_id = $1', [solicitacao.telegram_id]);
          let novaData;
          const agora = new Date();

          if (userRes.rows.length > 0 && userRes.rows[0].plano === 'VIP' && userRes.rows[0].vip_expiracao) {
            const expAtual = new Date(userRes.rows[0].vip_expiracao);
            novaData = expAtual > agora ? new Date(expAtual.getTime() + 30 * 24 * 60 * 60 * 1000) : new Date(agora.getTime() + 30 * 24 * 60 * 60 * 1000);
          } else {
            novaData = new Date(agora.getTime() + 30 * 24 * 60 * 60 * 1000);
          }

          await client.query(
            "UPDATE usuarios SET plano = 'VIP', vip_expiracao = $1 WHERE telegram_id = $2",
            [novaData, solicitacao.telegram_id]
          );

          await client.query('COMMIT');

          const dataFormatada = novaData.toLocaleDateString('pt-BR');
          bot.answerCallbackQuery(callbackQuery.id, { text: 'Pagamento aprovado e VIP ativado com sucesso!' });
          bot.editMessageCaption(`✅ *SOLICITAÇÃO APROVADA*\nID: \`${reqId}\`\nCliente: ${solicitacao.username} (\`${solicitacao.telegram_id}\`)\nAprovado por Admin em ${new Date().toLocaleString('pt-BR')}`, {
            chat_id: chatId,
            message_id: msg.message_id,
            parse_mode: 'Markdown'
          });

          bot.sendMessage(solicitacao.telegram_id, `🎉 *Pagamento Aprovado!*\n\nSua assinatura do **Imperium Plus** foi ativada com sucesso.\n📅 Seu acesso VIP é válido até: \`${dataFormatada}\`.`, { parse_mode: 'Markdown' })
             .catch(err => console.error('Erro ao notificar usuário aprovado:', err));

        } else if (action === 'rejeitar') {
          await client.query(
            "UPDATE pagamento_solicitacoes SET status = 'REJECTED', reviewed_at = NOW(), reviewed_by = $1 WHERE id = $2",
            [userId, reqId]
          );

          await client.query('COMMIT');

          bot.answerCallbackQuery(callbackQuery.id, { text: 'Solicitação rejeitada.' });
          bot.editMessageCaption(`❌ *SOLICITAÇÃO REJEITADA*\nID: \`${reqId}\`\nCliente: ${solicitacao.username} (\`${solicitacao.telegram_id}\`)\nRejeitado por Admin em ${new Date().toLocaleString('pt-BR')}`, {
            chat_id: chatId,
            message_id: msg.message_id,
            parse_mode: 'Markdown'
          });

          bot.sendMessage(solicitacao.telegram_id, `⚠️ *Aviso sobre seu pagamento*\n\nSeu comprovante enviado para o Imperium Plus **não foi aprovado**.\n\nPor favor, verifique se o Pix foi realizado corretamente ou entre em contato para enviar um novo comprovante válido.`, { parse_mode: 'Markdown' })
             .catch(err => console.error('Erro ao notificar usuário rejeitado:', err));
        }

      } catch (err) {
        await client.query('ROLLBACK');
        console.error('Erro na transação de aprovação/rejeição:', err);
        bot.answerCallbackQuery(callbackQuery.id, { text: 'Erro interno ao processar solicitação.', show_alert: true });
      } finally {
        client.release();
      }
    } catch (err) {
      console.error('Erro de conexão ao processar callback:', err);
    }
  }
});

// Recebimento de Comprovantes (Fotos ou Documentos) com Notificação Detalhada ao Admin
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
    const mimeType = document.mime_type || '';
    
    if (!mimeType.includes('image') && !mimeType.includes('pdf')) {
      bot.sendMessage(chatId, '⚠️ Formato não recomendado. Aceitamos preferencialmente imagens (JPG/PNG) ou arquivos PDF.');
    }
    
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

    bot.sendMessage(chatId, '✅ *Comprovante recebido!*\n\nSeu pagamento está aguardando análise administrativa. Você receberá uma mensagem assim que a verificação for concluída.', { parse_mode: 'Markdown' });

    // Envio estruturado exigido para o Administrador com botões nativos exatos
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
        await bot.sendPhoto(ownerId, fileId, { caption: captionAdmin, parse_mode: 'Markdown', reply_markup: keyboardAdmin })
           .catch(err => console.error('Erro ao enviar foto para o owner:', err));
      } else {
        await bot.sendDocument(ownerId, fileId, { caption: captionAdmin, parse_mode: 'Markdown', reply_markup: keyboardAdmin })
           .catch(err => console.error('Erro ao enviar documento para o owner:', err));
      }
    }
  } catch (err) {
    console.error('Erro ao registrar solicitação de pagamento:', err);
    bot.sendMessage(chatId, '❌ Ocorreu um erro ao enviar seu comprovante. Tente novamente mais tarde.');
  }
}

// Comandos Administrativos
bot.onText(/\/pagamentos/, async (msg) => {
  const chatId = msg.chat.id;
  if (!ownerId || chatId !== ownerId) return;

  try {
    const res = await pool.query("SELECT * FROM pagamento_solicitacoes WHERE status = 'PENDING' ORDER BY created_at ASC");
    if (res.rows.length === 0) {
      bot.sendMessage(chatId, '𭭢 Não há solicitações de pagamento pendentes no momento.');
      return;
    }

    let text = '📋 *Solicitações Pendentes:*\n\n';
    res.rows.forEach(row => {
      const dataF = new Date(row.created_at).toLocaleString('pt-BR');
      text += `• ID: \`${row.id}\` | Usuário: ${row.username} (\`${row.telegram_id}\`) | Data: ${dataF}\n`;
    });
    text += `\nUse \`/pagamento ID\` para ver detalhes.`;
    bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('Erro ao listar pagamentos:', err);
    bot.sendMessage(chatId, '❌ Erro ao buscar pagamentos pendentes.');
  }
});

bot.onText(/\/pagamento (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!ownerId || chatId !== ownerId) return;

  const reqId = parseInt(match[1]);
  if (isNaN(reqId)) {
    bot.sendMessage(chatId, '⚠️ ID inválido. Use: \`/pagamento [ID]\`', { parse_mode: 'Markdown' });
    return;
  }

  try {
    const res = await pool.query('SELECT * FROM pagamento_solicitacoes WHERE id = $1', [reqId]);
    if (res.rows.length === 0) {
      bot.sendMessage(chatId, '❌ Solicitação não encontrada.');
      return;
    }

    const row = res.rows[0];
    const caption = `📄 *Detalhes da Solicitação #${row.id}*\n\n` +
                    `• Usuário: ${row.username}\n` +
                    `• Telegram ID: \`${row.telegram_id}\`\n` +
                    `• Valor: R$ ${row.valor}\n` +
                    `• Status: *${row.status}*\n` +
                    `• Data Envio: ${new Date(row.created_at).toLocaleString('pt-BR')}`;

    const keyboard = {
      inline_keyboard: [
        [
          { text: '✅ Aprovar pagamento', callback_data: `aprovar_pag_${row.id}` },
          { text: '❌ Rejeitar pagamento', callback_data: `rejeitar_pag_${row.id}` }
        ]
      ]
    };

    if (row.file_type === 'photo') {
      await bot.sendPhoto(chatId, row.telegram_file_id, { caption, parse_mode: 'Markdown', reply_markup: keyboard });
    } else {
      await bot.sendDocument(chatId, row.telegram_file_id, { caption, parse_mode: 'Markdown', reply_markup: keyboard });
    }
  } catch (err) {
    console.error('Erro ao consultar pagamento:', err);
    bot.sendMessage(chatId, '❌ Erro ao consultar solicitação.');
  }
});

bot.onText(/\/aprovar (\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!ownerId || chatId !== ownerId) return;

  const reqId = parseInt(match[1]);
  try {
    const res = await pool.query('SELECT * FROM pagamento_solicitacoes WHERE id = $1', [reqId]);
    if (res.rows.length === 0 || res.rows[0].status !== 'PENDING') {
      bot.sendMessage(chatId, '❌ Solicitação não encontrada ou já processada.');
      return;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const solicitacao = res.rows[0];

      await client.query("UPDATE pagamento_solicitacoes SET status = 'APPROVED', reviewed_at = NOW(), reviewed_by = $1 WHERE id = $2", [chatId, reqId]);

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

      bot.sendMessage(chatId, `✅ Solicitação #${reqId} aprovada com sucesso! VIP ativo até ${novaData.toLocaleDateString('pt-BR')}.`);
      bot.sendMessage(solicitacao.telegram_id, `🎉 *Pagamento Aprovado!*\n\nSua assinatura do **Imperium Plus** foi ativada. Válido até: \`${novaData.toLocaleDateString('pt-BR')}\`.`, { parse_mode: 'Markdown' });
    } catch (e) {
      await client.query('ROLLBACK');
      console.error(e);
      bot.sendMessage(chatId, '❌ Erro ao aprovar transação.');
    } finally {
      client.release();
    }
  } catch (err) {
    console.error(err);
  }
});

bot.onText(/\/rejeitar (\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!ownerId || chatId !== ownerId) return;

  const reqId = parseInt(match[1]);
  try {
    const res = await pool.query('SELECT * FROM pagamento_solicitacoes WHERE id = $1', [reqId]);
    if (res.rows.length === 0 || res.rows[0].status !== 'PENDING') {
      bot.sendMessage(chatId, '❌ Solicitação não encontrada ou já processada.');
      return;
    }

    await pool.query("UPDATE pagamento_solicitacoes SET status = 'REJECTED', reviewed_at = NOW(), reviewed_by = $1 WHERE id = $2", [chatId, reqId]);
    const solicitacao = res.rows[0];

    bot.sendMessage(chatId, `❌ Solicitação #${reqId} rejeitada.`);
    bot.sendMessage(solicitacao.telegram_id, `⚠️ Seu comprovante do Imperium Plus não foi aprovado. Entre em contato com o suporte ou envie um novo comprovante válido.`, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error(err);
    bot.sendMessage(chatId, '❌ Erro ao rejeitar solicitação.');
  }
});

bot.onText(/\/addvip (\d+) (\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!ownerId || chatId !== ownerId) return;

  const targetId = parseInt(match[1]);
  const dias = parseInt(match[2]);

  try {
    const userCheck = await pool.query('SELECT * FROM usuarios WHERE telegram_id = $1', [targetId]);
    if (userCheck.rows.length === 0) {
      bot.sendMessage(chatId, '❌ Usuário não encontrado no banco de dados.');
      return;
    }

    const agora = new Date();
    const expAtual = userCheck.rows[0].vip_expiracao ? new Date(userCheck.rows[0].vip_expiracao) : null;
    let novaData;

    if (userCheck.rows[0].plano === 'VIP' && expAtual && expAtual > agora) {
      novaData = new Date(expAtual.getTime() + dias * 24 * 60 * 60 * 1000);
    } else {
      novaData = new Date(agora.getTime() + dias * 24 * 60 * 60 * 1000);
    }

    await pool.query("UPDATE usuarios SET plano = 'VIP', vip_expiracao = $1 WHERE telegram_id = $2", [novaData, targetId]);
    bot.sendMessage(chatId, `✅ VIP adicionado para \`${targetId}\`. Novo vencimento: ${novaData.toLocaleDateString('pt-BR')}`, { parse_mode: 'Markdown' });
    bot.sendMessage(targetId, `🎉 Sua conta recebeu VIP por ${dias} dias! Válido até ${novaData.toLocaleDateString('pt-BR')}.`, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('Erro em /addvip:', err);
    bot.sendMessage(chatId, '❌ Erro ao adicionar VIP.');
  }
});

bot.onText(/\/vip (\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!ownerId || chatId !== ownerId) return;

  const targetId = parseInt(match[1]);
  const status = await verificarAcesso(targetId);
  bot.sendMessage(chatId, `🔍 Status VIP do usuário \`${targetId}\`:\nPlano: *${status.plano}*\nAtivo: *${status.ativo ? 'Sim' : 'Não'}*\nVencimento: \`${status.expiracao ? new Date(status.expiracao).toLocaleDateString('pt-BR') : 'N/A'}\``, { parse_mode: 'Markdown' });
});

bot.onText(/\/vips/, async (msg) => {
  const chatId = msg.chat.id;
  if (!ownerId || chatId !== ownerId) return;

  try {
    const res = await pool.query("SELECT * FROM usuarios WHERE plano = 'VIP' AND vip_expiracao > NOW()");
    if (res.rows.length === 0) {
      bot.sendMessage(chatId, '𭭢 Não há usuários VIP ativos no momento.');
      return;
    }

    let text = `👑 *Usuários VIP Ativos (${res.rows.length}):*\n\n`;
    res.rows.forEach(u => {
      const exp = new Date(u.vip_expiracao).toLocaleDateString('pt-BR');
      text += `• ${u.username || 'Sem user'} (\`${u.telegram_id}\`) - Vence: ${exp}\n`;
    });
    bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('Erro em /vips:', err);
    bot.sendMessage(chatId, '❌ Erro ao listar VIPs.');
  }
});

// Planilhas Excel
bot.onText(/\/planilha_vip/, async (msg) => {
  const chatId = msg.chat.id;
  if (!ownerId || chatId !== ownerId) return;

  try {
    const res = await pool.query("SELECT * FROM usuarios WHERE plano = 'VIP'");
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Usuários VIP');

    sheet.columns = [
      { header: 'Telegram ID', key: 'telegram_id', width: 20 },
      { header: 'Username', key: 'username', width: 20 },
      { header: 'Plano', key: 'plano', width: 10 },
      { header: 'Expiração', key: 'vip_expiracao', width: 20 },
      { header: 'Data Cadastro', key: 'data_cadastro', width: 20 }
    ];

    res.rows.forEach(row => sheet.addRow(row));
    const buffer = await workbook.xlsx.writeBuffer();
    await bot.sendDocument(chatId, Buffer.from(buffer), {
      filename: 'usuarios_vip.xlsx',
      caption: '📊 Planilha de Usuários VIP'
    });
  } catch (err) {
    console.error('Erro em /planilha_vip:', err);
    bot.sendMessage(chatId, '❌ Erro ao gerar planilha VIP.');
  }
});

bot.onText(/\/planilha_geral/, async (msg) => {
  const chatId = msg.chat.id;
  if (!ownerId || chatId !== ownerId) return;

  try {
    const res = await pool.query('SELECT * FROM usuarios');
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Todos os Usuários');

    sheet.columns = [
      { header: 'Telegram ID', key: 'telegram_id', width: 20 },
      { header: 'Username', key: 'username', width: 20 },
      { header: 'Plano', key: 'plano', width: 10 },
      { header: 'Expiração', key: 'vip_expiracao', width: 20 },
      { header: 'Data Cadastro', key: 'data_cadastro', width: 20 },
      { header: 'Origem', key: 'origem', width: 15 }
    ];

    res.rows.forEach(row => sheet.addRow(row));
    const buffer = await workbook.xlsx.writeBuffer();
    await bot.sendDocument(chatId, Buffer.from(buffer), {
      filename: 'usuarios_geral.xlsx',
      caption: '📊 Planilha Geral de Usuários'
    });
  } catch (err) {
    console.error('Erro em /planilha_geral:', err);
    bot.sendMessage(chatId, '❌ Erro ao gerar planilha geral.');
  }
});

// Mensagens gerais (Edição Interativa)
bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;
  await garantirUsuario(msg);
  const chatId = msg.chat.id;
  const text = msg.text.trim();

  if (text.toLowerCase() === 'cancelar') {
    if (userStates.has(chatId)) {
      userStates.delete(chatId);
      bot.sendMessage(chatId, '❌ Operação cancelada.');
    }
    return;
  }

  if (userStates.has(chatId)) {
    const state = userStates.get(chatId);
    if (state.action === 'editing') {
      const parts = text.split(/\s+/);
      if (parts.length < 2) {
        bot.sendMessage(chatId, '⚠️ Formato inválido. Use: \`[tipo] [valor] [descrição]\` (Ex: gastei 50 almoço)');
        return;
      }
      const tipoBruto = parts[0].toLowerCase();
      let tipo = 'gasto';
      if (tipoBruto.startsWith('ganh')) tipo = 'ganho';
      if (tipoBruto.startsWith('inv')) tipo = 'investimento';

      const valor = parseFloat(parts[1].replace(',', '.'));
      const descricao = parts.slice(2).join(' ') || 'Sem descrição';

      if (isNaN(valor) || valor <= 0) {
        bot.sendMessage(chatId, '⚠️ Valor numérico inválido.');
        return;
      }

      try {
        await pool.query(
          'UPDATE transacoes SET tipo = $1, valor = $2, descricao = $3 WHERE id = $4 AND (telegram_id = $5 OR user_id = $5)',
          [tipo, valor, descricao, state.txId, chatId]
        );
        userStates.delete(chatId);
        bot.sendMessage(chatId, `✅ Transação #${state.txId} atualizada com sucesso!`);
      } catch (err) {
        console.error('Erro ao atualizar transação:', err);
        bot.sendMessage(chatId, '❌ Erro ao atualizar transação no banco de dados.');
      }
      return;
    }
  }
});

// Transações por Regex
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

  if (isNaN(valor) || valor <= 0) {
    bot.sendMessage(chatId, '⚠️ Valor inválido. Use formato exato, por exemplo: \`gastei 50.00 mercado\`', { parse_mode: 'Markdown' });
    return;
  }

  try {
    await pool.query(
      'INSERT INTO transacoes (telegram_id, user_id, tipo, valor, descricao, data) VALUES ($1, $1, $2, $3, $4, NOW())',
      [chatId, tipo, valor, descricao]
    );

    const emoji = tipo === 'ganho' ? '🟢' : tipo === 'investimento' ? '🔵' : '🔴';
    bot.sendMessage(chatId, `${emoji} *Transação registrada com sucesso!*\n\nTipo: *${tipo.toUpperCase()}*\nValor: *R$ ${valor.toFixed(2)}*\nDescrição: ${descricao}`, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('Erro ao registrar transação:', err);
    bot.sendMessage(chatId, '❌ Erro ao salvar transação no banco de dados.');
  }
});

// Avisos de Vencimento
async function verificarVencimentosAutomaticos() {
  try {
    const agora = new Date();
    const res = await pool.query("SELECT * FROM usuarios WHERE plano = 'VIP' AND vip_expiracao IS NOT NULL");
    
    for (const user of res.rows) {
      const expDate = new Date(user.vip_expiracao);
      const diffTime = expDate.getTime() - agora.getTime();
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

      if (diffDays === 3) {
        bot.sendMessage(user.telegram_id, `⚠️ *Aviso de Vencimento*\n\nSua assinatura do **Imperium Plus** vence em **3 dias** (${expDate.toLocaleDateString('pt-BR')}). Renove agora para não perder os benefícios!`, { parse_mode: 'Markdown' })
           .catch(err => console.error(`Erro ao enviar aviso 3 dias para ${user.telegram_id}:`, err));
      } else if (diffDays === 0) {
        bot.sendMessage(user.telegram_id, `🚨 *Seu VIP vence hoje!*\n\nSua assinatura do **Imperium Plus** expira hoje (${expDate.toLocaleDateString('pt-BR')}). Renove já via Pix para continuar com acesso total.`, { parse_mode: 'Markdown' })
           .catch(err => console.error(`Erro ao enviar aviso hoje para ${user.telegram_id}:`, err));
      }
    }
  } catch (err) {
    console.error('Erro na verificação automática de vencimentos:', err);
  }
}

setInterval(verificarVencimentosAutomaticos, 12 * 60 * 60 * 1000);

console.log('🤖 Bot Imperium Cash iniciado com sucesso!');