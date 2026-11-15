require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const QuickChart = require('quickchart-js');
const { Pool } = require('pg');
const ExcelJS = require('exceljs');
const fs = require('fs');

const token = process.env.BOT_TOKEN;
const OWNER_ID = String(process.env.OWNER_ID || '').trim();

if (!token) {
    console.error("❌ BOT_TOKEN não configurado.");
    process.exit(1);
}

if (!process.env.DATABASE_URL) {
    console.error("❌ DATABASE_URL não configurado.");
    process.exit(1);
}

if (!OWNER_ID) {
    console.error("⚠️ OWNER_ID não configurado no .env.");
}

const bot = new TelegramBot(token, { polling: true });

// --- CONEXÃO COM BANCO ---
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// --- VERIFICAR DONO ---
function isOwner(userId) {
    return OWNER_ID !== '' && String(userId).trim() === OWNER_ID;
}

// --- ERROS DO TELEGRAM ---
bot.on('polling_error', (error) => {
    console.error("❌ Erro no polling do Telegram:", error.message);
});

// --- INICIALIZAÇÃO DO BANCO ---
async function setupDB() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS usuarios (
                telegram_id BIGINT PRIMARY KEY,
                plano TEXT DEFAULT 'FREE',
                username TEXT,
                vip_expiracao TIMESTAMP,
                data_cadastro TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                origem TEXT DEFAULT 'organico'
            );

            ALTER TABLE usuarios
            ADD COLUMN IF NOT EXISTS vip_expiracao TIMESTAMP;

            ALTER TABLE usuarios
            ADD COLUMN IF NOT EXISTS origem TEXT DEFAULT 'organico';

            CREATE TABLE IF NOT EXISTS transacoes (
                id SERIAL PRIMARY KEY,
                user_id BIGINT REFERENCES usuarios(telegram_id),
                tipo TEXT,
                valor DECIMAL(12,2),
                descricao TEXT,
                data TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS pagamento_solicitacoes (
                id SERIAL PRIMARY KEY,
                telegram_id BIGINT,
                username TEXT,
                valor DECIMAL(12,2),
                status TEXT DEFAULT 'PENDING',
                telegram_file_id TEXT,
                file_type TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                reviewed_at TIMESTAMP,
                reviewed_by BIGINT
            );
        `);

        console.log("✅ Banco conectado: Gestão original, Imperium Plus e Edição ativados.");
        console.log(`🔐 OWNER_ID configurado: ${OWNER_ID ? 'SIM' : 'NÃO'}`);
    } catch (err) {
        console.error("❌ Erro ao conectar ao banco:", err);
    }
}

setupDB();

const estados = {};
const awaitingReceipt = new Set();

// --- INTERFACE ORIGINAL + NOVOS BOTÕES ---
const menuPrincipal = {
    reply_markup: {
        keyboard: [
            ['💰 Ganhei', '💸 Gastei', '📈 Investi'],
            ['📊 Análise', '📄 Histórico'],
            ['👤 Minha Conta', '💎 Assinar Imperium Plus'],
            ['✏️ Editar lançamento']
        ],
        resize_keyboard: true
    }
};

const tecladoVoltar = {
    reply_markup: {
        keyboard: [['⬅️ Voltar']],
        resize_keyboard: true
    }
};

// --- FUNÇÃO DE ACESSO ---
async function verificarAcesso(userId) {
    const res = await pool.query(
        'SELECT plano, vip_expiracao FROM usuarios WHERE telegram_id = $1',
        [userId]
    );

    const user = res.rows[0];
    let plano = user?.plano || 'FREE';
    const expiracao = user?.vip_expiracao;

    if (plano === 'VIP') {
        if (expiracao && new Date() > new Date(expiracao)) {
            await pool.query(
                "UPDATE usuarios SET plano = 'FREE', vip_expiracao = NULL WHERE telegram_id = $1",
                [userId]
            );

            plano = 'FREE';
        } else {
            return {
                pode: true,
                plano: 'VIP'
            };
        }
    }

    return {
        pode: true,
        plano: 'FREE'
    };
}

// --- CONVERTER VALOR ---
function parseValor(texto) {
    let limpo = texto
        .toLowerCase()
        .replace('r$', '')
        .replace(/\s/g, '')
        .trim();

    if (limpo.endsWith('k')) {
        return parseFloat(
            limpo.replace('k', '').replace(',', '.')
        ) * 1000;
    }

    return parseFloat(
        limpo.replace(/\./g, '').replace(',', '.')
    );
}

// --- LÓGICA DO BOT ---
bot.on('message', async (msg) => {
    try {
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        const text = msg.text;

        if (!text) return;

        // --- SISTEMA DE RASTREAMENTO ---
        let origem = 'organico';

        if (text.startsWith('/start ')) {
            origem = text.split(' ')[1];
        }

        await pool.query(
            `INSERT INTO usuarios
            (telegram_id, username, origem)
            VALUES ($1, $2, $3)
            ON CONFLICT (telegram_id)
            DO UPDATE SET username = $2`,
            [
                userId,
                msg.from.username || 'Usuario',
                origem
            ]
        );

        // --- MOSTRAR MEU ID ---
        if (text === '/meuid') {
            return bot.sendMessage(
                chatId,
                `🆔 Seu ID do Telegram é:\n<code>${userId}</code>`,
                {
                    parse_mode: 'HTML'
                }
            );
        }

        // --- COMANDO /CLEAN ---
        if (text === '/clean') {
            try {
                await pool.query(
                    "DELETE FROM transacoes WHERE user_id = $1",
                    [userId]
                );

                return bot.sendMessage(
                    chatId,
                    "🗑️ <b>Histórico limpo!</b> Todos os seus registros foram apagados com sucesso.",
                    {
                        parse_mode: 'HTML'
                    }
                );
            } catch (e) {
                console.error("Erro no /clean:", e);

                return bot.sendMessage(
                    chatId,
                    "❌ Erro ao limpar histórico."
                );
            }
        }

        // --- COMANDO /CLS ---
        if (text === '/cls') {

            if (!isOwner(userId)) {
                return bot.sendMessage(
                    chatId,
                    "❌ Apenas o dono pode utilizar este comando."
                );
            }

            try {
                await pool.query(
                    "TRUNCATE TABLE transacoes, usuarios, pagamento_solicitacoes RESTART IDENTITY CASCADE;"
                );

                return bot.sendMessage(
                    chatId,
                    "⚠️ <b>BANCO DE DADOS TOTALMENTE ZERADO!</b>\nTodos os usuários, contas e registros financeiros foram apagados permanentemente.",
                    {
                        parse_mode: 'HTML'
                    }
                );

            } catch (e) {
                console.error("Erro no /cls:", e);

                return bot.sendMessage(
                    chatId,
                    "❌ Erro ao limpar o banco de dados geral."
                );
            }
        }

        // --- /ADDVIP ---
        if (text === '/addvip') {

            if (!isOwner(userId)) {
                return bot.sendMessage(
                    chatId,
                    "❌ Apenas o dono pode gerenciar assinaturas."
                );
            }

            estados[userId] = {
                acao: 'pedir_id_vip'
            };

            return bot.sendMessage(
                chatId,
                "👤 <b>Adicionar Imperium Plus</b>\n\nEnvie o <b>ID do usuário</b> que você deseja promover (30 dias):",
                {
                    parse_mode: 'HTML',
                    ...tecladoVoltar
                }
            );
        }

        // --- /VIP E /VIPS ---
        if (
            text.startsWith('/vip ') ||
            text === '/vips'
        ) {

            if (!isOwner(userId)) {
                return bot.sendMessage(
                    chatId,
                    "❌ Apenas o dono pode gerenciar assinaturas."
                );
            }

            if (text.startsWith('/vip ')) {
                const idParaPromover = text
                    .replace('/vip', '')
                    .trim();

                if (
                    !idParaPromover ||
                    isNaN(idParaPromover)
                ) {
                    return bot.sendMessage(
                        chatId,
                        "⚠️ Use: /vip ID"
                    );
                }

                try {
                    await pool.query(
                        "UPDATE usuarios SET plano = 'VIP', vip_expiracao = NOW() + INTERVAL '30 days' WHERE telegram_id = $1",
                        [idParaPromover]
                    );

                    return bot.sendMessage(
                        chatId,
                        `⭐ ID <code>${idParaPromover}</code> promovido para Imperium Plus por 30 dias!`,
                        {
                            parse_mode: 'HTML'
                        }
                    );

                } catch (e) {
                    console.error("Erro no /vip:", e);

                    return bot.sendMessage(
                        chatId,
                        "❌ Erro no banco."
                    );
                }
            }

            if (text === '/vips') {
                try {
                    const res = await pool.query(
                        "SELECT telegram_id, username, vip_expiracao FROM usuarios WHERE plano = 'VIP' ORDER BY vip_expiracao ASC"
                    );

                    if (res.rowCount === 0) {
                        return bot.sendMessage(
                            chatId,
                            "Nenhum usuário Imperium Plus ativo no momento."
                        );
                    }

                    let lista = "📋 <b>CLIENTES IMPERIUM PLUS ATIVOS:</b>\n\n";

                    res.rows.forEach(u => {
                        const dataExp = u.vip_expiracao
                            ? new Date(u.vip_expiracao).toLocaleDateString('pt-BR')
                            : "Sem data";

                        lista +=
                            `👤 @${u.username || 'Sem User'} (<code>${u.telegram_id}</code>)\n` +
                            `📅 Vence em: <b>${dataExp}</b>\n\n`;
                    });

                    return bot.sendMessage(
                        chatId,
                        lista,
                        {
                            parse_mode: 'HTML'
                        }
                    );

                } catch (e) {
                    console.error("Erro no /vips:", e);

                    return bot.sendMessage(
                        chatId,
                        "❌ Erro ao consultar os usuários VIP."
                    );
                }
            }
        }

        // --- PLANILHAS ---
        if (
            text === '/planilha_vip' ||
            text === '/planilha_geral'
        ) {

            if (!isOwner(userId)) {
                return bot.sendMessage(
                    chatId,
                    "❌ Apenas o dono pode exportar dados."
                );
            }

            const queryStr =
                text === '/planilha_geral'
                    ? "SELECT telegram_id, username, plano, vip_expiracao, data_cadastro, origem FROM usuarios"
                    : "SELECT telegram_id, username, plano, vip_expiracao, data_cadastro, origem FROM usuarios WHERE plano = 'VIP'";

            const nomeArquivo =
                text === '/planilha_geral'
                    ? 'Relatorio_Todos_Usuarios.xlsx'
                    : 'Relatorio_Imperium_Plus.xlsx';

            try {
                const res = await pool.query(queryStr);
                const workbook = new ExcelJS.Workbook();
                const worksheet = workbook.addWorksheet('Clientes');

                worksheet.columns = [
                    { header: 'Telegram ID', key: 'id', width: 20 },
                    { header: 'Username', key: 'user', width: 20 },
                    { header: 'Plano', key: 'plano', width: 10 },
                    { header: 'Origem (Parceiro)', key: 'origem', width: 20 },
                    { header: 'Data Expiração', key: 'expira', width: 25 },
                    { header: 'Cadastrado em', key: 'cadastro', width: 25 }
                ];

                res.rows.forEach(u => {
                    worksheet.addRow({
                        id: String(u.telegram_id),
                        user: u.username || 'N/A',
                        plano: u.plano,
                        origem: u.origem || 'organico',
                        expira: u.vip_expiracao ? new Date(u.vip_expiracao).toLocaleString('pt-BR') : '-',
                        cadastro: u.data_cadastro ? new Date(u.data_cadastro).toLocaleString('pt-BR') : '-'
                    });
                });

                const filePath = `./${nomeArquivo}`;
                await workbook.xlsx.writeFile(filePath);

                await bot.sendDocument(chatId, filePath, {
                    caption: '📊 Planilha atualizada.'
                });

                if (fs.existsSync(filePath)) {
                    fs.unlinkSync(filePath);
                }

                return;

            } catch (e) {
                console.error("Erro ao gerar planilha:", e);
                return bot.sendMessage(chatId, "❌ Erro ao gerar a planilha.");
            }
        }

        // --- COMANDO START (ORIGINAL RESTAURADO) ---
        if (
            text.startsWith('/start') ||
            text === '⬅️ Voltar'
        ) {
            delete estados[userId];
            awaitingReceipt.delete(userId);

            const msgStart =
                `👑 <b>Imperium Cash</b>\n\n` +
                `Organize seu dinheiro de forma simples, rápida e sem complicação.\n\n` +
                `Com o Imperium Cash você:\n` +
                `• Registra ganhos, gastos e investimentos em segundos\n` +
                `• Visualiza tudo com gráficos automáticos\n` +
                `• Entende exatamente para onde seu dinheiro está indo\n\n` +
                `━━━━━━━━━━━━━━━━━━\n\n` +
                `💡 <b>Comece agora:</b>\n` +
                `Escolha uma opção no menu abaixo e registre seu primeiro valor.`;

            if (text.startsWith('/start')) {
                try {
                    return await bot.sendPhoto(
                        chatId,
                        './imperium_cash.jpg',
                        {
                            caption: msgStart,
                            parse_mode: 'HTML',
                            ...menuPrincipal
                        }
                    );
                } catch (error) {
                    return bot.sendMessage(
                        chatId,
                        msgStart,
                        {
                            parse_mode: 'HTML',
                            ...menuPrincipal
                        }
                    );
                }
            }

            return bot.sendMessage(
                chatId,
                msgStart,
                {
                    parse_mode: 'HTML',
                    ...menuPrincipal
                }
            );
        }

        // --- MINHA CONTA ---
        if (text === '👤 Minha Conta') {
            try {
                const res = await pool.query(
                    'SELECT plano, vip_expiracao FROM usuarios WHERE telegram_id = $1',
                    [userId]
                );

                const count = await pool.query(
                    'SELECT COUNT(*) as total FROM transacoes WHERE user_id = $1',
                    [userId]
                );

                const user = res.rows[0];

                let exp = "";
                let nomePlano = 'Básico (Free)';

                if (user?.plano === 'VIP') {
                    nomePlano = '👑 Imperium Plus';

                    if (user.vip_expiracao) {
                        const d = new Date(user.vip_expiracao);
                        const dia = String(d.getDate()).padStart(2, '0');
                        const mes = String(d.getMonth() + 1).padStart(2, '0');
                        const ano = d.getFullYear();

                        exp = `\n\nSeu Imperium Plus expira dia (${dia}/${mes}/${ano})`;
                    }
                }

                const mensagem =
                    `👤 <b>Minha Conta</b>\n\n` +
                    `ID: <code>${userId}</code>\n` +
                    `Plano: <b>${nomePlano}</b>\n` +
                    `Total de Registros: <b>${count.rows[0].total}</b>${exp}`;

                return bot.sendMessage(
                    chatId,
                    mensagem,
                    {
                        parse_mode: 'HTML',
                        ...menuPrincipal
                    }
                );

            } catch (error) {
                console.error("❌ Erro em Minha Conta:", error);
                return bot.sendMessage(chatId, "❌ Não foi possível carregar os dados da sua conta.", menuPrincipal);
            }
        }

        // --- ASSINAR IMPERIUM PLUS (COM BOTÃO DE LINK NUBANK) ---
        if (text === '💎 Assinar Imperium Plus') {
            const pixKey = process.env.PIX_KEY || 'Chave Pix não configurada';
            const receiverName = process.env.PIX_RECEIVER_NAME || 'Administrador';
            const description = process.env.PIX_PAYMENT_DESCRIPTION || 'Assinatura Imperium Plus';
            const pixPaymentUrl = process.env.PIX_PAYMENT_URL; // Link de cobrança Nubank via variável de ambiente
            const statusVip = await verificarAcesso(userId);

            const pendRes = await pool.query("SELECT * FROM pagamento_solicitacoes WHERE telegram_id = $1 AND status = 'PENDING'", [userId]);
            if (pendRes.rows.length > 0) {
                return bot.sendMessage(chatId, '⏳ Você já possui uma solicitação pendente aguardando análise administrativa.', menuPrincipal);
            }

            let infoVipAtivo = '';
            if (statusVip.plano === 'VIP') {
                infoVipAtivo = `\nℹ️ *Nota:* Você já possui assinatura ativa. Um novo pagamento estenderá seu VIP por mais 30 dias!\n`;
            }

            const plusText =
                `💎 <b>Imperium Plus</b> — Assinatura Mensal\n\n` +
                `• <b>Preço:</b> R$ 5,00\n` +
                `• <b>Duração:</b> 30 dias de acesso VIP\n` +
                `• <b>Benefícios:</b> Gráficos avançados, exportação ilimitada de relatórios e prioridade.\n` +
                `${infoVipAtivo}\n` +
                `📌 <b>Dados para Pagamento via Pix:</b>\n` +
                `• Chave Pix: <code>${pixKey}</code>\n` +
                `• Nome: ${receiverName}\n` +
                `• Descrição: ${description}\n\n` +
                `💳 <b>Como proceder:</b>\n` +
                `1. Clique no botão abaixo para pagar via Pix pelo Nubank, ou copie a chave acima.\n` +
                `2. Após realizar o pagamento, retorne e clique em "✅ Já realizei o pagamento".`;

            const inlineRows = [];
            
            // Adiciona o botão de link do Nubank apenas se a variável estiver configurada
            if (pixPaymentUrl) {
                inlineRows.push([{ text: '🔗 Pagar R$ 5,00 via Pix', url: pixPaymentUrl }]);
            }

            inlineRows.push([{ text: '✅ Já realizei o pagamento', callback_data: 'enviar_comprovante_fluxo' }]);
            inlineRows.push([{ text: '❌ Cancelar', callback_data: 'cancelar_assinatura' }]);

            const keyboardPlus = {
                reply_markup: {
                    inline_keyboard: inlineRows
                }
            };

            return bot.sendMessage(chatId, plusText, { parse_mode: 'HTML', ...keyboardPlus });
        }

        // --- EDITAR LANÇAMENTO (FLUXO CONVERSACIONAL) ---
        if (text === '✏️ Editar lançamento') {
            try {
                const res = await pool.query('SELECT * FROM transacoes WHERE user_id = $1 ORDER BY data DESC LIMIT 10', [userId]);
                if (res.rowCount === 0) {
                    return bot.sendMessage(chatId, '📜 Nenhuma transação encontrada para edição.', menuPrincipal);
                }

                let listText = '✏️ <b>Qual lançamento você deseja editar?</b>\nEnvie o número correspondente:\n\n';
                const userTxList = [];
                res.rows.forEach((tx, idx) => {
                    userTxList.push(tx);
                    const valorF = Number(tx.valor).toFixed(2);
                    const tipoFormatado = tx.tipo === 'entrada' ? 'Ganhei' : tx.tipo === 'saida' ? 'Gastei' : 'Investi';
                    listText += `<b>${idx + 1}.</b> ${tipoFormatado} — R$ ${valorF} — ${tx.descricao}\n`;
                });

                estados[userId] = {
                    acao: 'edit_select_tx',
                    txList: userTxList
                };

                return bot.sendMessage(chatId, listText, { parse_mode: 'HTML', ...tecladoVoltar });
            } catch (err) {
                console.error('Erro ao listar para edição:', err);
                return bot.sendMessage(chatId, '❌ Erro ao carregar lançamentos.', menuPrincipal);
            }
        }

        const estado = estados[userId];

        // --- MENU NORMAL / FLUXO PASSO A PASSO ORIGINAL ---
        if (!estado) {

            if (
                text === '💸 Gastei' ||
                text === '💰 Ganhei' ||
                text === '📈 Investi'
            ) {

                const check = await verificarAcesso(userId);

                if (!check.pode) {
                    return bot.sendMessage(chatId, check.msg, { parse_mode: 'HTML' });
                }

                let tipo = 'saida';
                let conversa = "Qual o valor que você gastou? (Ex: 50.00)";

                if (text === '💰 Ganhei') {
                    tipo = 'entrada';
                    conversa = "Que ótimo! Qual foi o valor que você recebeu? (Ex: 150.50)";
                } else if (text === '📈 Investi') {
                    tipo = 'investimento';
                    conversa = "📈 Hora de multiplicar! Quanto você investiu hoje? (Ex: 100.00)";
                }

                estados[userId] = {
                    acao: 'pedir_valor',
                    tipo: tipo
                };

                return bot.sendMessage(chatId, conversa, tecladoVoltar);
            }

            if (text === '📊 Análise') {
                return enviarGraficoCompleto(chatId, userId);
            }

            if (text === '📄 Histórico') {
                return enviarRelatorio(chatId, userId);
            }

            return bot.sendMessage(chatId, "🤖 Use o menu abaixo:", menuPrincipal);
        }

        // --- PEDIR ID VIP ---
        if (estado.acao === 'pedir_id_vip') {
            const idPromover = text.trim();

            if (isNaN(idPromover)) {
                return bot.sendMessage(
                    chatId,
                    "⚠️ O ID deve conter apenas números. Tente novamente ou use '⬅️ Voltar':",
                    tecladoVoltar
                );
            }

            try {
                await pool.query(
                    "UPDATE usuarios SET plano = 'VIP', vip_expiracao = NOW() + INTERVAL '30 days' WHERE telegram_id = $1",
                    [idPromover]
                );

                await bot.sendMessage(
                    chatId,
                    `⭐ Sucesso! O usuário de ID <code>${idPromover}</code> agora possui o Imperium Plus por 30 dias!`,
                    {
                        parse_mode: 'HTML',
                        ...menuPrincipal
                    }
                );

            } catch (e) {
                console.error("Erro ao promover usuário:", e);
                await bot.sendMessage(chatId, "❌ Erro ao promover usuário.", menuPrincipal);
            }

            delete estados[userId];
            return;
        }

        // --- PEDIR VALOR (ORIGINAL) ---
        if (estado.acao === 'pedir_valor') {
            const v = parseValor(text);

            if (isNaN(v)) {
                return bot.sendMessage(chatId, "⚠️ Valor inválido. Digite apenas números.", tecladoVoltar);
            }

            estado.valor = v;
            estado.acao = 'pedir_desc';

            let msgDesc = "";

            if (estado.tipo === 'entrada') {
                msgDesc = "De onde veio esse dinheiro? (Ex: Salário, Venda de bolo, Pix do João)";
            } else if (estado.tipo === 'saida') {
                msgDesc = "Com o que você gastou? (Ex: Mercado, Conta de Luz, Lanche)";
            } else if (estado.tipo === 'investimento') {
                msgDesc = "Onde você aplicou esse valor? (Ex: Tesouro Direto, CDB Banco, Bitcoin)";
            }

            return bot.sendMessage(chatId, msgDesc, tecladoVoltar);
        }

        // --- PEDIR DESCRIÇÃO E SALVAR (ORIGINAL) ---
        if (estado.acao === 'pedir_desc') {
            await pool.query(
                'INSERT INTO transacoes (user_id, tipo, valor, descricao) VALUES ($1, $2, $3, $4)',
                [userId, estado.tipo, estado.valor, text]
            );

            const contagemQuery = await pool.query(
                'SELECT COUNT(*) as total FROM transacoes WHERE user_id = $1',
                [userId]
            );

            const totalRegistros = parseInt(contagemQuery.rows[0].total);

            let emojiFinal = '🔴';
            if (estado.tipo === 'entrada') emojiFinal = '🟢';
            if (estado.tipo === 'investimento') emojiFinal = '📈';

            await bot.sendMessage(
                chatId,
                `${emojiFinal} Tudo certo! Registro de <b>R$ ${estado.valor.toFixed(2)}</b> salvo com sucesso.\n\n` +
                `🟢 +1 registro adicionado\n` +
                `Você está no controle.\n` +
                `📊 Progresso financeiro: ${totalRegistros} registros feitos.`,
                {
                    parse_mode: 'HTML',
                    ...menuPrincipal
                }
            );

            delete estados[userId];
            return;
        }

        // --- MÁQUINA DE ESTADOS DA EDIÇÃO ---
        if (estado.acao === 'edit_select_tx') {
            const index = parseInt(text) - 1;
            if (isNaN(index) || !estado.txList[index]) {
                return bot.sendMessage(chatId, '⚠️ Número inválido. Escolha um número válido da lista:', tecladoVoltar);
            }
            estado.selectedTx = estado.txList[index];
            estado.acao = 'edit_select_field';
            return bot.sendMessage(chatId, 'Qual informação deseja corrigir? (Responda: Valor, Descrição, Tipo ou Data)', tecladoVoltar);
        }

        if (estado.acao === 'edit_select_field') {
            const field = text.toLowerCase().trim();
            if (!['valor', 'descrição', 'descricao', 'tipo', 'data'].includes(field)) {
                return bot.sendMessage(chatId, '⚠️ Opção inválida. Escolha entre: Valor, Descrição, Tipo ou Data', tecladoVoltar);
            }
            estado.fieldToEdit = field.replace('descricao', 'descrição');
            estado.acao = 'edit_get_new_value';
            return bot.sendMessage(chatId, `Informe o novo valor para ${estado.fieldToEdit}:`, tecladoVoltar);
        }

        if (estado.acao === 'edit_get_new_value') {
            estado.newValue = text;
            estado.acao = 'edit_confirm';
            let oldVal = `R$ ${Number(estado.selectedTx.valor).toFixed(2)}`;
            if (estado.fieldToEdit === 'descrição') oldVal = estado.selectedTx.descricao;
            if (estado.fieldToEdit === 'tipo') oldVal = estado.selectedTx.tipo;
            if (estado.fieldToEdit === 'data') oldVal = new Date(estado.selectedTx.data).toLocaleDateString('pt-BR');

            return bot.sendMessage(chatId, `Confirma a alteração de "${oldVal}" para "${estado.newValue}"? Responda 'sim' ou 'não'.`, tecladoVoltar);
        }

        if (estado.acao === 'edit_confirm') {
            if (text.toLowerCase() === 'sim' || text.toLowerCase() === 's') {
                try {
                    let queryField = 'descricao';
                    let valToSave = estado.newValue;

                    if (estado.fieldToEdit === 'valor') {
                        queryField = 'valor';
                        valToSave = parseValor(estado.newValue);
                        if (isNaN(valToSave) || valToSave <= 0) {
                            delete estados[userId];
                            return bot.sendMessage(chatId, '⚠️ Valor numérico inválido. Edição cancelada.', menuPrincipal);
                        }
                    } else if (estado.fieldToEdit === 'tipo') {
                        queryField = 'tipo';
                        const t = estado.newValue.toLowerCase();
                        if (t.includes('ganh') || t.includes('entrada')) valToSave = 'entrada';
                        else if (t.includes('inv')) valToSave = 'investimento';
                        else valToSave = 'saida';
                    } else if (estado.fieldToEdit === 'data') {
                        queryField = 'data';
                    }

                    await pool.query(
                        `UPDATE transacoes SET ${queryField} = $1 WHERE id = $2 AND user_id = $3`,
                        [valToSave, estado.selectedTx.id, userId]
                    );

                    delete estados[userId];
                    return bot.sendMessage(chatId, '✅ Lançamento atualizado com sucesso!', menuPrincipal);
                } catch (err) {
                    console.error('Erro ao atualizar transação:', err);
                    delete estados[userId];
                    return bot.sendMessage(chatId, '❌ Erro ao atualizar o registro no banco.', menuPrincipal);
                }
            } else {
                delete estados[userId];
                return bot.sendMessage(chatId, '❌ Edição cancelada.', menuPrincipal);
            }
        }

    } catch (error) {
        console.error("❌ Erro ao processar mensagem:", error);
        try {
            await bot.sendMessage(msg.chat.id, "❌ Ocorreu um erro ao processar sua solicitação. Tente novamente.", menuPrincipal);
        } catch (sendError) {
            console.error("❌ Erro ao enviar mensagem de erro:", sendError);
        }
    }
});

// --- CALLBACK QUERIES (COMPROVANTES E ADMIN) ---
bot.on('callback_query', async (callbackQuery) => {
    const msg = callbackQuery.message;
    const chatId = msg.chat.id;
    const data = callbackQuery.data;
    const userId = callbackQuery.from.id;

    if (data === 'enviar_comprovante_fluxo') {
        awaitingReceipt.add(userId);
        await bot.answerCallbackQuery(callbackQuery.id, { text: 'Envie o comprovante!' });
        return bot.sendMessage(userId, '📥 <b>Envio de Comprovante</b>\n\nPor favor, envie agora a foto ou o arquivo PDF do seu comprovante de pagamento Pix.', { parse_mode: 'HTML' });
    }

    if (data === 'cancelar_assinatura') {
        awaitingReceipt.delete(userId);
        await bot.answerCallbackQuery(callbackQuery.id);
        return bot.sendMessage(userId, '❌ Processo de assinatura cancelado.', menuPrincipal);
    }

    if (data.startsWith('aprovar_pag_') || data.startsWith('rejeitar_pag_')) {
        if (!isOwner(userId)) {
            return bot.answerCallbackQuery(callbackQuery.id, { text: 'Acesso negado.', show_alert: true });
        }

        const parts = data.split('_');
        const action = parts[0];
        const reqId = parseInt(parts[2]);

        try {
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                const reqRes = await client.query('SELECT * FROM pagamento_solicitacoes WHERE id = $1 FOR UPDATE', [reqId]);
                if (reqRes.rowCount === 0) {
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
                    await client.query(
                        "UPDATE pagamento_solicitacoes SET status = 'APPROVED', reviewed_at = NOW(), reviewed_by = $1 WHERE id = $2",
                        [userId, reqId]
                    );

                    await client.query(
                        "UPDATE usuarios SET plano = 'VIP', vip_expiracao = NOW() + INTERVAL '30 days' WHERE telegram_id = $1",
                        [solicitacao.telegram_id]
                    );

                    await client.query('COMMIT');

                    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Aprovado com sucesso!' });
                    await bot.editMessageCaption(
                        `✅ <b>SOLICITAÇÃO APROVADA</b>\nID: <code>${reqId}</code>\nCliente: ${solicitacao.username} (<code>${solicitacao.telegram_id}</code>)`,
                        {
                            chat_id: chatId,
                            message_id: msg.message_id,
                            parse_mode: 'HTML'
                        }
                    );

                    await bot.sendMessage(
                        solicitacao.telegram_id,
                        `🎉 <b>Pagamento Aprovado!</b>\n\nSua assinatura do <b>Imperium Plus</b> foi ativada por 30 dias com sucesso!`,
                        { parse_mode: 'HTML', ...menuPrincipal }
                    );

                } else if (action === 'rejeitar') {
                    await client.query(
                        "UPDATE pagamento_solicitacoes SET status = 'REJECTED', reviewed_at = NOW(), reviewed_by = $1 WHERE id = $2",
                        [userId, reqId]
                    );

                    await client.query('COMMIT');

                    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Rejeitado.' });
                    await bot.editMessageCaption(
                        `❌ <b>SOLICITAÇÃO REJEITADA</b>\nID: <code>${reqId}</code>\nCliente: ${solicitacao.username} (<code>${solicitacao.telegram_id}</code>)`,
                        {
                            chat_id: chatId,
                            message_id: msg.message_id,
                            parse_mode: 'HTML'
                        }
                    );

                    await bot.sendMessage(
                        solicitacao.telegram_id,
                        `⚠️ Seu comprovante do Imperium Plus não foi aprovado. Verifique os dados do Pix ou entre em contato com o suporte.`,
                        { parse_mode: 'HTML', ...menuPrincipal }
                    );
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

// --- RECEBIMENTO DE COMPROVANTES (FOTOS / DOCUMENTOS) ---
bot.on('photo', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    if (isOwner(userId)) return;

    if (awaitingReceipt.has(userId)) {
        awaitingReceipt.delete(userId);
        const photo = msg.photo[msg.photo.length - 1];
        await registrarEEnviarSolicitacao(msg, photo.file_id, 'photo');
    }
});

bot.on('document', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    if (isOwner(userId)) return;

    if (awaitingReceipt.has(userId)) {
        awaitingReceipt.delete(userId);
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

        await bot.sendMessage(
            chatId,
            '✅ <b>Comprovante recebido!</b>\n\nSua solicitação foi enviada para análise administrativa. Você será avisado em breve.',
            { parse_mode: 'HTML', ...menuPrincipal }
        );

        if (OWNER_ID) {
            const captionAdmin =
                `💰 <b>NOVA SOLICITAÇÃO DE ASSINATURA</b>\n\n` +
                `• <b>Nome do cliente:</b> ${nomeCliente}\n` +
                `• <b>Username:</b> ${username}\n` +
                `• <b>ID do cliente:</b> <code>${chatId}</code>\n` +
                `• <b>Plano:</b> Imperium Plus\n` +
                `• <b>Valor esperado:</b> R$ 5,00\n` +
                `• <b>ID da solicitação:</b> <code>${reqId}</code>\n` +
                `• <b>Data/Hora:</b> ${dataHoraEnvio}`;

            const keyboardAdmin = {
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '✅ Aprovar pagamento', callback_data: `aprovar_pag_${reqId}` },
                            { text: '❌ Rejeitar pagamento', callback_data: `rejeitar_pag_${reqId}` }
                        ]
                    ]
                }
            };

            if (fileType === 'photo') {
                await bot.sendPhoto(OWNER_ID, fileId, { caption: captionAdmin, parse_mode: 'HTML', ...keyboardAdmin });
            } else {
                await bot.sendDocument(OWNER_ID, fileId, { caption: captionAdmin, parse_mode: 'HTML', ...keyboardAdmin });
            }
        }
    } catch (err) {
        console.error('Erro ao registrar solicitação de pagamento:', err);
        await bot.sendMessage(chatId, '❌ Ocorreu um erro ao enviar seu comprovante. Tente novamente mais tarde.', menuPrincipal);
    }
}

// --- COMANDO /PAGAMENTOS (ADMIN) ---
bot.onText(/\/pagamentos/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    if (!isOwner(userId)) return;

    try {
        const res = await pool.query("SELECT * FROM pagamento_solicitacoes WHERE status = 'PENDING' ORDER BY created_at ASC");
        if (res.rowCount === 0) {
            return bot.sendMessage(chatId, '𭭢 Não há solicitações de pagamento pendentes no momento.');
        }

        let text = '📋 <b>Solicitações Pendentes:</b>\n\n';
        res.rows.forEach(r => {
            const dataF = new Date(r.created_at).toLocaleString('pt-BR');
            text += `• ID: <code>${r.id}</code> | User: ${r.username} (<code>${r.telegram_id}</code>) | Data: ${dataF}\n`;
        });
        return bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
    } catch (err) {
        console.error(err);
    }
});

// --- GRÁFICO / ANÁLISE (ORIGINAL RESTAURADO) ---
async function enviarGraficoCompleto(
    chatId,
    userId
) {
    try {
        const res =
            await pool.query(
                "SELECT tipo, SUM(valor) as total FROM transacoes WHERE user_id = $1 GROUP BY tipo",
                [userId]
            );

        if (res.rowCount === 0) {
            return bot.sendMessage(
                chatId,
                "Sem dados suficientes para gerar uma análise.",
                menuPrincipal
            );
        }

        let gn = 0;
        let gs = 0;
        let inv = 0;

        res.rows.forEach(r => {
            if (r.tipo === 'entrada') {
                gn = parseFloat(r.total);
            } else if (r.tipo === 'saida') {
                gs = parseFloat(r.total);
            } else if (r.tipo === 'investimento') {
                inv = parseFloat(r.total);
            }
        });

        const saldoDisponivel = gn - gs - inv;
        const patrimonioTotal = saldoDisponivel + inv;

        const chart = new QuickChart();

        chart.setConfig({
            type: 'doughnut',
            data: {
                labels: ['Ganhos', 'Gastos', 'Investimentos'],
                datasets: [
                    {
                        data: [gn, gs, inv],
                        backgroundColor: ['#2ecc71', '#e74c3c', '#3498db'],
                        borderWidth: 2
                    }
                ]
            },
            options: {
                plugins: {
                    legend: {
                        position: 'bottom',
                        labels: { fontSize: 16 }
                    }
                }
            }
        })
        .setWidth(500)
        .setHeight(350);

        const msgInfo =
            `📊 <b>RESUMO FINANCEIRO DETALHADO</b>\n\n` +
            `🟢 <b>Ganhos Totais:</b> R$ ${gn.toFixed(2)}\n` +
            `🔴 <b>Gastos Totais:</b> R$ ${gs.toFixed(2)}\n` +
            `📈 <b>Investimentos:</b> R$ ${inv.toFixed(2)}\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `💰 <b>Dinheiro Disponível (Conta):</b> R$ ${saldoDisponivel.toFixed(2)}\n` +
            `🏦 <b>Patrimônio Total:</b> R$ ${patrimonioTotal.toFixed(2)}\n\n` +
            `<i>*Seu Patrimônio Total é a soma do dinheiro na conta mais os seus investimentos.</i>`;

        return bot.sendPhoto(
            chatId,
            await chart.getShortUrl(),
            {
                caption: msgInfo,
                parse_mode: 'HTML',
                ...menuPrincipal
            }
        );

    } catch (error) {
        console.error("❌ Erro na análise:", error);
        return bot.sendMessage(chatId, "❌ Não foi possível gerar a análise financeira.", menuPrincipal);
    }
}

// --- HISTÓRICO (ORIGINAL RESTAURADO, SEM BOTÕES ANEXADOS) ---
async function enviarRelatorio(
    chatId,
    userId
) {
    try {
        const res =
            await pool.query(
                "SELECT * FROM transacoes WHERE user_id = $1 ORDER BY data DESC LIMIT 15",
                [userId]
            );

        if (res.rowCount === 0) {
            return bot.sendMessage(
                chatId,
                "Seu histórico está vazio no momento.",
                menuPrincipal
            );
        }

        let m =
            "📋 <b>SEUS ÚLTIMOS LANÇAMENTOS:</b>\n" +
            "━━━━━━━━━━━━━━━━━━━━━━\n";

        res.rows.forEach(t => {
            let icone = '🔴';
            if (t.tipo === 'entrada') icone = '🟢';
            if (t.tipo === 'investimento') icone = '📈';

            const d = new Date(t.data);
            const dataFormatada =
                `${String(d.getDate()).padStart(2, '0')}/` +
                `${String(d.getMonth() + 1).padStart(2, '0')}`;

            m +=
                `${icone} <b>R$ ${parseFloat(t.valor).toFixed(2)}</b> - ` +
                `${t.descricao} ` +
                `<i>(${dataFormatada})</i>\n`;
        });

        m +=
            "━━━━━━━━━━━━━━━━━━━━━━\n" +
            "<i>Seu histórico financeiro está organizado aqui.</i>";

        return bot.sendMessage(
            chatId,
            m,
            {
                parse_mode: 'HTML',
                ...menuPrincipal
            }
        );

    } catch (error) {
        console.error("❌ Erro no histórico:", error);
        return bot.sendMessage(chatId, "❌ Não foi possível carregar seu histórico.", menuPrincipal);
    }
}

// --- SERVIDOR WEB ---
const app = express();

app.get('/', (req, res) => {
    res.send('Bot Online - Gestão Premium Ativa');
});

app.listen(
    process.env.PORT || 3000,
    () => {
        console.log(`🌐 Servidor online na porta ${process.env.PORT || 3000}`);
    }
);

// --- PROTEÇÃO CONTRA ERROS ---
process.on('unhandledRejection', (reason) => {
    console.error("❌ Unhandled Rejection:", reason);
});

process.on('uncaughtException', (error) => {
    console.error("❌ Uncaught Exception:", error);
});