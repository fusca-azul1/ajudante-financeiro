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
        `);

        console.log("✅ Banco conectado: Gestão de Investimentos, VIP 2.0 e Rastreamento ativados.");
        console.log(`🔐 OWNER_ID configurado: ${OWNER_ID ? 'SIM' : 'NÃO'}`);
    } catch (err) {
        console.error("❌ Erro ao conectar ao banco:", err);
    }
}

setupDB();

const estados = {};

// --- INTERFACE ---
const menuPrincipal = {
    reply_markup: {
        keyboard: [
            ['💰 Ganhei', '💸 Gastei', '📈 Investi'],
            ['📊 Análise', '📄 Histórico'],
            ['👤 Minha Conta']
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
                console.log(
                    `⚠️ Tentativa de /cls negada. User ID: ${userId}`
                );

                return bot.sendMessage(
                    chatId,
                    "❌ Apenas o dono pode utilizar este comando."
                );
            }

            try {
                await pool.query(
                    "TRUNCATE TABLE transacoes, usuarios RESTART IDENTITY CASCADE;"
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
                    console.error(
                        "Erro no /vip:",
                        e
                    );

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

                    let lista =
                        "📋 <b>CLIENTES IMPERIUM PLUS ATIVOS:</b>\n\n";

                    res.rows.forEach(u => {
                        const dataExp = u.vip_expiracao
                            ? new Date(
                                u.vip_expiracao
                            ).toLocaleDateString('pt-BR')
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
                    console.error(
                        "Erro no /vips:",
                        e
                    );

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
                const res = await pool.query(
                    queryStr
                );

                const workbook =
                    new ExcelJS.Workbook();

                const worksheet =
                    workbook.addWorksheet('Clientes');

                worksheet.columns = [
                    {
                        header: 'Telegram ID',
                        key: 'id',
                        width: 20
                    },
                    {
                        header: 'Username',
                        key: 'user',
                        width: 20
                    },
                    {
                        header: 'Plano',
                        key: 'plano',
                        width: 10
                    },
                    {
                        header: 'Origem (Parceiro)',
                        key: 'origem',
                        width: 20
                    },
                    {
                        header: 'Data Expiração',
                        key: 'expira',
                        width: 25
                    },
                    {
                        header: 'Cadastrado em',
                        key: 'cadastro',
                        width: 25
                    }
                ];

                res.rows.forEach(u => {
                    worksheet.addRow({
                        id: String(
                            u.telegram_id
                        ),
                        user:
                            u.username || 'N/A',
                        plano: u.plano,
                        origem:
                            u.origem || 'organico',
                        expira:
                            u.vip_expiracao
                                ? new Date(
                                    u.vip_expiracao
                                ).toLocaleString(
                                    'pt-BR'
                                )
                                : '-',
                        cadastro:
                            u.data_cadastro
                                ? new Date(
                                    u.data_cadastro
                                ).toLocaleString(
                                    'pt-BR'
                                )
                                : '-'
                    });
                });

                const filePath =
                    `./${nomeArquivo}`;

                await workbook.xlsx.writeFile(
                    filePath
                );

                await bot.sendDocument(
                    chatId,
                    filePath,
                    {
                        caption:
                            '📊 Planilha atualizada. Veja a origem de todos os clientes na coluna "Origem".'
                    }
                );

                if (
                    fs.existsSync(
                        filePath
                    )
                ) {
                    fs.unlinkSync(
                        filePath
                    );
                }

                return;

            } catch (e) {
                console.error(
                    "Erro ao gerar planilha:",
                    e
                );

                return bot.sendMessage(
                    chatId,
                    "❌ Erro ao gerar a planilha."
                );
            }
        }

        // --- COMANDO START ---
        if (
            text.startsWith('/start') ||
            text === '⬅️ Voltar'
        ) {
            delete estados[userId];

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

            if (
                text.startsWith('/start')
            ) {
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
        if (
            text === '👤 Minha Conta'
        ) {
            try {
                const res =
                    await pool.query(
                        'SELECT plano, vip_expiracao FROM usuarios WHERE telegram_id = $1',
                        [userId]
                    );

                const count =
                    await pool.query(
                        'SELECT COUNT(*) as total FROM transacoes WHERE user_id = $1',
                        [userId]
                    );

                const user =
                    res.rows[0];

                let exp = "";
                let nomePlano =
                    'Básico (Free)';

                if (
                    user?.plano === 'VIP'
                ) {
                    nomePlano =
                        '👑 Imperium Plus';

                    if (
                        user.vip_expiracao
                    ) {
                        const d =
                            new Date(
                                user.vip_expiracao
                            );

                        const dia =
                            String(
                                d.getDate()
                            ).padStart(
                                2,
                                '0'
                            );

                        const mes =
                            String(
                                d.getMonth() + 1
                            ).padStart(
                                2,
                                '0'
                            );

                        const ano =
                            d.getFullYear();

                        exp =
                            `\n\nSeu Imperium Plus expira dia (${dia}/${mes}/${ano})`;
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
                        parse_mode: 'HTML'
                    }
                );

            } catch (error) {
                console.error(
                    "❌ Erro em Minha Conta:",
                    error
                );

                return bot.sendMessage(
                    chatId,
                    "❌ Não foi possível carregar os dados da sua conta."
                );
            }
        }

        const estado =
            estados[userId];

        // --- MENU NORMAL ---
        if (!estado) {

            if (
                text === '💸 Gastei' ||
                text === '💰 Ganhei' ||
                text === '📈 Investi'
            ) {

                const check =
                    await verificarAcesso(
                        userId
                    );

                if (!check.pode) {
                    return bot.sendMessage(
                        chatId,
                        check.msg,
                        {
                            parse_mode: 'HTML'
                        }
                    );
                }

                let tipo = 'saida';

                let conversa =
                    "Qual o valor que você gastou? (Ex: 50.00)";

                if (
                    text === '💰 Ganhei'
                ) {
                    tipo = 'entrada';

                    conversa =
                        "Que ótimo! Qual foi o valor que você recebeu? (Ex: 150.50)";
                }

                else if (
                    text === '📈 Investi'
                ) {
                    tipo =
                        'investimento';

                    conversa =
                        "📈 Hora de multiplicar! Quanto você investiu hoje? (Ex: 100.00)";
                }

                estados[userId] = {
                    acao:
                        'pedir_valor',
                    tipo: tipo
                };

                return bot.sendMessage(
                    chatId,
                    conversa,
                    tecladoVoltar
                );
            }

            if (
                text === '📊 Análise'
            ) {
                return enviarGraficoCompleto(
                    chatId,
                    userId
                );
            }

            if (
                text === '📄 Histórico'
            ) {
                return enviarRelatorio(
                    chatId,
                    userId
                );
            }

            return bot.sendMessage(
                chatId,
                "🤖 Use o menu abaixo:",
                menuPrincipal
            );
        }

        // --- PEDIR ID VIP ---
        if (
            estado.acao ===
            'pedir_id_vip'
        ) {
            const idPromover =
                text.trim();

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
                console.error(
                    "Erro ao promover usuário:",
                    e
                );

                await bot.sendMessage(
                    chatId,
                    "❌ Erro ao promover usuário. Verifique se o ID existe no banco.",
                    menuPrincipal
                );
            }

            delete estados[userId];
            return;
        }

        // --- PEDIR VALOR ---
        if (
            estado.acao ===
            'pedir_valor'
        ) {
            const v =
                parseValor(text);

            if (isNaN(v)) {
                return bot.sendMessage(
                    chatId,
                    "⚠️ Valor inválido. Digite apenas números.",
                    tecladoVoltar
                );
            }

            estado.valor = v;
            estado.acao =
                'pedir_desc';

            let msgDesc = "";

            if (
                estado.tipo ===
                'entrada'
            ) {
                msgDesc =
                    "De onde veio esse dinheiro? (Ex: Salário, Venda de bolo, Pix do João)";
            }

            else if (
                estado.tipo ===
                'saida'
            ) {
                msgDesc =
                    "Com o que você gastou? (Ex: Mercado, Conta de Luz, Lanche)";
            }

            else if (
                estado.tipo ===
                'investimento'
            ) {
                msgDesc =
                    "Onde você aplicou esse valor? (Ex: Tesouro Direto, CDB Banco, Bitcoin)";
            }

            return bot.sendMessage(
                chatId,
                msgDesc,
                tecladoVoltar
            );
        }

        // --- PEDIR DESCRIÇÃO ---
        if (
            estado.acao ===
            'pedir_desc'
        ) {
            await pool.query(
                'INSERT INTO transacoes (user_id, tipo, valor, descricao) VALUES ($1, $2, $3, $4)',
                [
                    userId,
                    estado.tipo,
                    estado.valor,
                    text
                ]
            );

            const contagemQuery =
                await pool.query(
                    'SELECT COUNT(*) as total FROM transacoes WHERE user_id = $1',
                    [userId]
                );

            const totalRegistros =
                parseInt(
                    contagemQuery.rows[0].total
                );

            let emojiFinal = '🔴';

            if (
                estado.tipo ===
                'entrada'
            ) {
                emojiFinal = '🟢';
            }

            if (
                estado.tipo ===
                'investimento'
            ) {
                emojiFinal = '📈';
            }

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

    } catch (error) {
        console.error(
            "❌ Erro ao processar mensagem:",
            error
        );

        try {
            await bot.sendMessage(
                msg.chat.id,
                "❌ Ocorreu um erro ao processar sua solicitação. Tente novamente."
            );
        } catch (sendError) {
            console.error(
                "❌ Erro ao enviar mensagem de erro:",
                sendError
            );
        }
    }
});

// --- GRÁFICO / ANÁLISE ---
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
                "Sem dados suficientes para gerar uma análise."
            );
        }

        let gn = 0;
        let gs = 0;
        let inv = 0;

        res.rows.forEach(r => {

            if (
                r.tipo === 'entrada'
            ) {
                gn =
                    parseFloat(
                        r.total
                    );
            }

            else if (
                r.tipo === 'saida'
            ) {
                gs =
                    parseFloat(
                        r.total
                    );
            }

            else if (
                r.tipo ===
                'investimento'
            ) {
                inv =
                    parseFloat(
                        r.total
                    );
            }
        });

        const saldoDisponivel =
            gn - gs - inv;

        const patrimonioTotal =
            saldoDisponivel + inv;

        const chart =
            new QuickChart();

        chart.setConfig({
            type: 'doughnut',

            data: {
                labels: [
                    'Ganhos',
                    'Gastos',
                    'Investimentos'
                ],

                datasets: [
                    {
                        data: [
                            gn,
                            gs,
                            inv
                        ],

                        backgroundColor: [
                            '#2ecc71',
                            '#e74c3c',
                            '#3498db'
                        ],

                        borderWidth: 2
                    }
                ]
            },

            options: {
                plugins: {
                    legend: {
                        position:
                            'bottom',

                        labels: {
                            fontSize: 16
                        }
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
                parse_mode: 'HTML'
            }
        );

    } catch (error) {
        console.error(
            "❌ Erro na análise:",
            error
        );

        return bot.sendMessage(
            chatId,
            "❌ Não foi possível gerar a análise financeira."
        );
    }
}

// --- HISTÓRICO ---
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
                "Seu histórico está vazio no momento."
            );
        }

        let m =
            "📋 <b>SEUS ÚLTIMOS LANÇAMENTOS:</b>\n" +
            "━━━━━━━━━━━━━━━━━━━━━━\n";

        res.rows.forEach(t => {
            let icone = '🔴';

            if (
                t.tipo === 'entrada'
            ) {
                icone = '🟢';
            }

            if (
                t.tipo ===
                'investimento'
            ) {
                icone = '📈';
            }

            const d =
                new Date(t.data);

            const dataFormatada =
                `${String(
                    d.getDate()
                ).padStart(2, '0')}/` +
                `${String(
                    d.getMonth() + 1
                ).padStart(2, '0')}`;

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
                parse_mode: 'HTML'
            }
        );

    } catch (error) {
        console.error(
            "❌ Erro no histórico:",
            error
        );

        return bot.sendMessage(
            chatId,
            "❌ Não foi possível carregar seu histórico."
        );
    }
}

// --- SERVIDOR WEB ---
const app = express();

app.get('/', (req, res) => {
    res.send(
        'Bot Online - Gestão Premium Ativa'
    );
});

app.listen(
    process.env.PORT || 3000,
    () => {
        console.log(
            `🌐 Servidor online na porta ${process.env.PORT || 3000}`
        );
    }
);

// --- PROTEÇÃO CONTRA ERROS ---
process.on(
    'unhandledRejection',
    (reason) => {
        console.error(
            "❌ Unhandled Rejection:",
            reason
        );
    }
);

process.on(
    'uncaughtException',
    (error) => {
        console.error(
            "❌ Uncaught Exception:",
            error
        );
    }
);