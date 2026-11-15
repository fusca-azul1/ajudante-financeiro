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

// Estados de conversas em memória (Fluxo original passo a passo + Edição + Comprovante)
const userStates = new Map();
const awaitingReceipt = new Set();

// Teclado principal original restaurado com os dois novos botões solicitados: 💎 Assinar Imperium Plus e ✏️ Editar lançamento
const mainReplyKeyboard = {
  reply_markup: {
    keyboard: [
      ['💰 Ganhei', '💸 Gastei'],
      ['📈 Investi', '📊 Análise'],
      ['📜 Histórico', '👤 Minha Conta'],
      ['💎 Assinar Imperium Plus', '✏️ Editar lançamento']
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

// Comando /start restaurado fielmente à mensagem inicial original
bot.onText(/\/start/, async (msg) => {
  await garantirUsuario(msg);
  const chatId = msg.chat.id;
  const welcomeText = `🚀 *Bem-vindo ao Imperium Cash!*\n\nO seu assistente financeiro pessoal inteligente.\n\nEscolha uma opção abaixo para começar:`;
  bot.sendMessage(chatId, welcomeText, { parse_mode: 'Markdown', ...mainReplyKeyboard });
});

bot.onText(/\/meuid/, async (msg) => {
  await garantirUsuario(msg);
  bot.sendMessage(msg.chat.id, `🆔 Seu ID do Telegram é: \`${msg.chat.id}\``, { parse_mode: 'Markdown', ...mainReplyKeyboard });
});

bot.onText(/\/(clean|cls)/, (msg) => {
  bot.sendMessage(msg.chat.id, '🧹 Para limpar o chat, utilize a opção do menu do seu aplicativo do Telegram.', mainReplyKeyboard);
});

// Máquina de Estados baseada em conversas passo a passo para Ganhei, Gastei, Investi e Edição
bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;
  await garantirUsuario(msg);
  const chatId = msg.chat.id;
  const text = msg.text.trim();

  if (text.toLowerCase() === 'cancelar') {
    userStates.delete(chatId);
    awaitingReceipt.delete(chatId);
    bot.sendMessage(chatId, '❌ Operação cancelada.', mainReplyKeyboard);
    return;
  }

  // 1. Tratamento dos botões do menu principal original
  if (text === '💰 Ganhei') {
    userStates.set(chatId, { step: 'ganho_valor' });
    bot.sendMessage(chatId, 'Quanto você ganhou?', mainReplyKeyboard);
    return;
  }
  if (text === '💸 Gastei') {
    userStates.set(chatId, { step: 'gasto_valor' });
    bot.sendMessage(chatId, 'Quanto você gastou?', mainReplyKeyboard);
    return;
  }
  if (text === '📈 Investi') {
    userStates.set(chatId, { step: 'investimento_valor' });
    bot.sendMessage(chatId, 'Quanto você investiu?', mainReplyKeyboard);
    return;
  }

  // 2. Apresentação original da Análise
  if (text === '📊 Análise') {
    try {
      const res = await pool.query('SELECT tipo, SUM(valor) as total FROM transacoes WHERE telegram_id = $1 OR user_id = $1 GROUP BY tipo', [chatId]);
      let ganhos = 0, gastos = 0, investimentos = 0;
      res.rows.forEach(r => {
        if (r.tipo === 'ganho') ganhos = Number(r.total);
        if (r.tipo === 'gasto') gastos = Number(r.total);
        if (r.tipo === 'investimento') investimentos = Number(r.total);
      });
      const saldo = ganhos - gastos - investimentos;
      const analysisText = `📊 *Sua Análise Financeira*\n\n` +
                           `🟢 Total Ganho: R$ ${ganhos.toFixed(2)}\n` +
                           `🔴 Total Gasto: R$ ${gastos.toFixed(2)}\n` +
                           `🔵 Total Investido: R$ ${investimentos.toFixed(2)}\n` +
                           `💰 *Saldo Líquido:* R$ ${saldo.toFixed(2)}`;
      bot.sendMessage(chatId, analysisText, { parse_mode: 'Markdown', ...mainReplyKeyboard });
    } catch (err) {
      console.error('Erro na análise:', err);
      bot.sendMessage(chatId, '❌ Erro ao carregar análise.', mainReplyKeyboard);
    }
    return;
  }

  // 3. Apresentação original do Histórico (limpo e sem botões inline por lançamento)
  if (text === '📜 Histórico') {
    try {
      const res = await pool.query('SELECT * FROM transacoes WHERE telegram_id = $1 OR user_id = $1 ORDER BY data DESC LIMIT 10', [chatId]);
      if (res.rows.length === 0) {
        bot.sendMessage(chatId, '📜 Nenhuma transação encontrada.', mainReplyKeyboard);
        return;
      }
      let histText = '📜 *Suas Últimas 10 Transações:*\n\n';
      res.rows.forEach((tx, idx) => {
        const dataF = new Date(tx.data).toLocaleDateString('pt-BR');
        const valorF = Number(tx.valor).toFixed(2);
        const tipoEmoji = tx.tipo === 'ganho' ? '🟢' : tx.tipo === 'investimento' ? '🔵' : '🔴';
        histText += `${idx + 1}. ${tipoEmoji} *${tx.tipo.toUpperCase()}* | R$ ${valorF} | ${tx.descricao} (${dataF})\n`;
      });
      bot.sendMessage(chatId, histText, { parse_mode: 'Markdown', ...mainReplyKeyboard });
    } catch (err) {
      console.error('Erro ao listar histórico:', err);
      bot.sendMessage(chatId, '❌ Erro ao carregar histórico.', mainReplyKeyboard);
    }
    return;
  }

  if (text === '👤 Minha Conta') {
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

  // 4. Fluxo de Assinatura VIP
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

  // 5. Novo botão: ✏️ Editar lançamento (Por conversa, sem botões embaixo do histórico)
  if (text === '✏️ Editar lançamento') {
    try {
      const res = await pool.query('SELECT * FROM transacoes WHERE telegram_id = $1 OR user_id = $1 ORDER BY data DESC LIMIT 10', [chatId]);
      if (res.rows.length === 0) {
        bot.sendMessage(chatId, '📜 Nenhuma transação encontrada para edição.', mainReplyKeyboard);
        return;
      }
      let listText = 'Qual lançamento você deseja editar?\n\n';
      const userTxList = [];
      res.rows.forEach((tx, idx) => {
        userTxList.push(tx);
        const valorF = Number(tx.valor).toFixed(2);
        listText += `${idx + 1}. ${tx.tipo.toUpperCase()} — R$ ${valorF} — ${tx.descricao}\n`;
      });
      userStates.set(chatId, { step: 'edit_select_tx', txList: userTxList });
      bot.sendMessage(chatId, listText, mainReplyKeyboard);
    } catch (err) {
      console.error('Erro ao listar para edição:', err);
      bot.sendMessage(chatId, '❌ Erro ao carregar lançamentos.', mainReplyKeyboard);
    }
    return;
  }

  // Máquina de estados conversacional para Ganhei, Gastei, Investi e Edição
  if (userStates.has(chatId)) {
    const state = userStates.get(chatId);

    // Fluxo Ganhei (Passo 1: Valor -> Passo 2: Descrição -> Passo 3: Confirmação)
    if (state.step === 'ganho_valor') {
      const valor = parseFloat(text.replace(',', '.'));
      if (isNaN(valor) || valor <= 0) {
        bot.sendMessage(chatId, '⚠️ Valor inválido. Informe um número válido:', mainReplyKeyboard);
        return;
      }
      state.valor = valor;
      state.step = 'ganho_desc';
      bot.sendMessage(chatId, 'Como você ganhou esse dinheiro?', mainReplyKeyboard);
      return;
    }
    if (state.step === 'ganho_desc') {
      state.descricao = text;
      state.step = 'ganho_conf';
      bot.sendMessage(chatId, `Confirma o lançamento de R$ ${state.valor.toFixed(2)} referente a ${state.descricao}? Responda 'sim' ou 'não'.`, mainReplyKeyboard);
      return;
    }
    if (state.step === 'ganho_conf') {
      if (text.toLowerCase() === 'sim') {
        try {
          await pool.query(
            'INSERT INTO transacoes (telegram_id, user_id, tipo, valor, descricao, data) VALUES ($1, $1, $2, $3, $4, NOW())',
            [chatId, 'ganho', state.valor, state.descricao]
          );
          userStates.delete(chatId);
          bot.sendMessage(chatId, '🟢 Transação registrada com sucesso!', mainReplyKeyboard);
        } catch (err) {
          console.error(err);
          bot.sendMessage(chatId, '❌ Erro ao salvar transação.', mainReplyKeyboard);
        }
      } else {
        userStates.delete(chatId);
        bot.sendMessage(chatId, '❌ Lançamento cancelado.', mainReplyKeyboard);
      }
      return;
    }

    // Fluxo Gastei
    if (state.step === 'gasto_valor') {
      const valor = parseFloat(text.replace(',', '.'));
      if (isNaN(valor) || valor <= 0) {
        bot.sendMessage(chatId, '⚠️ Valor inválido. Informe um número válido:', mainReplyKeyboard);
        return;
      }
      state.valor = valor;
      state.step = 'gasto_desc';
      bot.sendMessage(chatId, 'Com que você gastou esse dinheiro?', mainReplyKeyboard);
      return;
    }
    if (state.step === 'gasto_desc') {
      state.descricao = text;
      state.step = 'gasto_conf';
      bot.sendMessage(chatId, `Confirma o lançamento de R$ ${state.valor.toFixed(2)} referente a ${state.descricao}? Responda 'sim' ou 'não'.`, mainReplyKeyboard);
      return;
    }
    if (state.step === 'gasto_conf') {
      if (text.toLowerCase() === 'sim') {
        try {
          await pool.query(
            'INSERT INTO transacoes (telegram_id, user_id, tipo, valor, descricao, data) VALUES ($1, $1, $2, $3, $4, NOW())',
            [chatId, 'gasto', state.valor, state.descricao]
          );
          userStates.delete(chatId);
          bot.sendMessage(chatId, '🔴 Transação registrada com sucesso!', mainReplyKeyboard);
        } catch (err) {
          console.error(err);
          bot.sendMessage(chatId, '❌ Erro ao salvar transação.', mainReplyKeyboard);
        }
      } else {
        userStates.delete(chatId);
        bot.sendMessage(chatId, '❌ Lançamento cancelado.', mainReplyKeyboard);
      }
      return;
    }

    // Fluxo Investi
    if (state.step === 'investimento_valor') {
      const valor = parseFloat(text.replace(',', '.'));
      if (isNaN(valor) || valor <= 0) {
        bot.sendMessage(chatId, '⚠️ Valor inválido. Informe um número válido:', mainReplyKeyboard);
        return;
      }
      state.valor = valor;
      state.step = 'investimento_desc';
      bot.sendMessage(chatId, 'Onde você investiu esse dinheiro?', mainReplyKeyboard);
      return;
    }
    if (state.step === 'investimento_desc') {
      state.descricao = text;
      state.step = 'investimento_conf';
      bot.sendMessage(chatId, `Confirma o lançamento de R$ ${state.valor.toFixed(2)} referente a ${state.descricao}? Responda 'sim' ou 'não'.`, mainReplyKeyboard);
      return;
    }
    if (state.step === 'investimento_conf') {
      if (text.toLowerCase() === 'sim') {
        try {
          await pool.query(
            'INSERT INTO transacoes (telegram_id, user_id, tipo, valor, descricao, data) VALUES ($1, $1, $2, $3, $4, NOW())',
            [chatId, 'investimento', state.valor, state.descricao]
          );
          userStates.delete(chatId);
          bot.sendMessage(chatId, '🔵 Transação registrada com sucesso!', mainReplyKeyboard);
        } catch (err) {
          console.error(err);
          bot.sendMessage(chatId, '❌ Erro ao salvar transação.', mainReplyKeyboard);
        }
      } else {
        userStates.delete(chatId);
        bot.sendMessage(chatId, '❌ Lançamento cancelado.', mainReplyKeyboard);
      }
      return;
    }

    // Fluxo de Edição por Conversa (Seguro por ID do usuário)
    if (state.step === 'edit_select_tx') {
      const index = parseInt(text) - 1;
      if (isNaN(index) || !state.txList[index]) {
        bot.sendMessage(chatId, '⚠️ Número inválido. Escolha um número válido da lista:', mainReplyKeyboard);
        return;
      }
      state.selectedTx = state.txList[index];
      state.step = 'edit_select_field';
      bot.sendMessage(chatId, 'Qual informação deseja alterar? (Digite: Valor, Descrição, Tipo ou Data)', mainReplyKeyboard);
      return;
    }
    if (state.step === 'edit_select_field') {
      const field = text.toLowerCase();
      if (!['valor', 'descrição', 'descricao', 'tipo', 'data'].includes(field)) {
        bot.sendMessage(chatId, '⚠️ Opção inválida. Escolha entre: Valor, Descrição, Tipo ou Data', mainReplyKeyboard);
        return;
      }
      state.fieldToEdit = field.replace('descricao', 'descrição');
      state.step = 'edit_get_new_value';
      bot.sendMessage(chatId, `Informe o novo valor para ${state.fieldToEdit}:`, mainReplyKeyboard);
      return;
    }
    if (state.step === 'edit_get_new_value') {
      state.newValue = text;
      state.step = 'edit_confirm';
      const oldVal = state.fieldToEdit === 'valor' ? `R$ ${Number(state.selectedTx.valor).toFixed(2)}` : state.selectedTx[state.fieldToEdit === 'descrição' ? 'descricao' : state.fieldToEdit];
      bot.sendMessage(chatId, `Confirme a alteração de ${oldVal} para ${state.newValue}? Responda 'sim' ou 'não'.`, mainReplyKeyboard);
      return;
    }
    if (state.step === 'edit_confirm') {
      if (text.toLowerCase() === 'sim') {
        try {
          let queryField = 'descricao';
          let valToSave = state.newValue;

          if (state.fieldToEdit === 'valor') {
            queryField = 'valor';
            valToSave = parseFloat(state.newValue.replace(',', '.'));
            if (isNaN(valToSave) || valToSave <= 0) {
              bot.sendMessage(chatId, '⚠️ Valor numérico inválido. Edição cancelada.', mainReplyKeyboard);
              userStates.delete(chatId);
              return;
            }
          } else if (state.fieldToEdit === 'tipo') {
            queryField = 'tipo';
            const t = state.newValue.toLowerCase();
            if (t.includes('ganh')) valToSave = 'ganho';
            else if (t.includes('inv')) valToSave = 'investimento';
            else valToSave = 'gasto';
          } else if (state.fieldToEdit === 'data') {
            queryField = 'data';
          }

          await pool.query(
            `UPDATE transacoes SET ${queryField} = $1 WHERE id = $2 AND (telegram_id = $3 OR user_id = $3)`,
            [valToSave, state.selectedTx.id, chatId]
          );
          userStates.delete(chatId);
          bot.sendMessage(chatId, '✅ Registro atualizado com sucesso!', mainReplyKeyboard);
        } catch (err) {
          console.error(err);
          bot.sendMessage(chatId, '❌ Erro ao atualizar registro.', mainReplyKeyboard);
        }
      } else {
        userStates.delete(chatId);
        bot.sendMessage(chatId, '❌ Edição cancelada.', mainReplyKeyboard);
      }
      return;
    }
  }
});

// Tratamento de Callback Queries (Assinatura VIP e Painel do Administrador)
bot.on('callback_query', async (callbackQuery) => {
  const msg = callbackQuery.message;
  const chatId = msg.chat.id;
  const data = callbackQuery.data;
  const userId = callbackQuery.from.id;

  await garantirUsuario({ chat: { id: userId }, from: callbackQuery.from });

  if (data === 'enviar_comprovante_fluxo') {
    awaitingReceipt.add(userId);
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Envie o comprovante!' });
    bot.sendMessage(userId, '📥 *Envio de Comprovante*\n\nPor favor, envie agora a foto ou o arquivo PDF do seu comprovante de pagamento Pix.', { parse_mode: 'Markdown' });
  }

  else if (data === 'cancelar_assinatura') {
    awaitingReceipt.delete(userId);
    await bot.answerCallbackQuery(callbackQuery.id);
    bot.sendMessage(userId, '❌ Processo de assinatura cancelado.', mainReplyKeyboard);
  }

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

// Recebimento de Comprovantes (Fotos ou Documentos) e Notificação ao Admin
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
    console.error('Erro ao registrar solicitação:', err);
    bot.sendMessage(chatId, '❌ Erro ao enviar comprovante.', mainReplyKeyboard);
  }
}

// Comandos administrativos preservados
bot.onText(/\/pagamentos/, async (msg) => {
  const chatId = msg.chat.id;
  if (!ownerId || chatId !== ownerId) return;

  try {
    const res = await pool.query("SELECT * FROM pagamento_solicitacoes WHERE status = 'PENDING' ORDER BY created_at ASC");
    if (res.rows.length === 0) {
      bot.sendMessage(chatId, '𭭢 Não há solicitações pendentes.');
      return;
    }
    let text = '📋 *Solicitações Pendentes:*\n\n';
    res.rows.forEach(r => {
      text += `• ID: \`${r.id}\` | Usuário: ${r.username} (\`${r.telegram_id}\`)\n`;
    });
    bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error(err);
  }
});

// Avisos de vencimento automático
async function verificarVencimentosAutomaticos() {
  try {
    const agora = new Date();
    const res = await pool.query("SELECT * FROM usuarios WHERE plano = 'VIP' AND vip_expiracao IS NOT NULL");
    
    for (const user of res.rows) {
      const expDate = new Date(user.vip_expiracao);
      const diffTime = expDate.getTime() - agora.getTime();
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

      if (diffDays === 3) {
        bot.sendMessage(user.telegram_id, `⚠️ *Aviso de Vencimento*\n\nSua assinatura vence em **3 dias** (${expDate.toLocaleDateString('pt-BR')}).`, { parse_mode: 'Markdown', ...mainReplyKeyboard })
           .catch(() => {});
      } else if (diffDays === 0) {
        bot.sendMessage(user.telegram_id, `🚨 *Seu VIP vence hoje!*\n\nSua assinatura expira hoje (${expDate.toLocaleDateString('pt-BR')}).`, { parse_mode: 'Markdown', ...mainReplyKeyboard })
           .catch(() => {});
      }
    }
  } catch (err) {
    console.error(err);
  }
}

setInterval(verificarVencimentosAutomaticos, 12 * 60 * 60 * 1000);

console.log('🤖 Bot Imperium Cash restaurado e iniciado com sucesso!');