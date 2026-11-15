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

// --- FUNÇÃO DE SEGURANÇA HTML ---
function escapeHtml(text) {
    if (!text) return '';
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// --- ERROS DO TELEGRAM ---
bot.on('polling_error', (error) => {
    console.error("❌ Erro no polling do Telegram:", error.message);
});

// --- INICIALIZAÇÃO DO BANCO (ROBUSTA) ---
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

            CREATE TABLE IF NOT EXISTS afiliados (
                id SERIAL PRIMARY KEY,
                codigo TEXT UNIQUE,
                nome TEXT,
                percentual_comissao DECIMAL(5,2) DEFAULT 20.00,
                ativo BOOLEAN DEFAULT TRUE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS comissoes_afiliados (
                id SERIAL PRIMARY KEY,
                affiliate_id INT REFERENCES afiliados(id),
                telegram_id BIGINT,
                solicitacao_id INT REFERENCES pagamento_solicitacoes(id) UNIQUE,
                valor_assinatura DECIMAL(12,2),
                valor_comissao DECIMAL(12,2),
                status TEXT DEFAULT 'PENDENTE',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                paid_at TIMESTAMP
            );
        `);

        // Cadastra ou atualiza o afiliado samuel
        await pool.query(`
            INSERT INTO afiliados (codigo, nome, percentual_comissao, ativo)
            VALUES ('samuel', 'Samuel', 20.00, TRUE)
            ON CONFLICT (codigo) DO UPDATE SET nome = 'Samuel';
        `);

        console.log("✅ Banco conectado com sucesso: Tabelas verificadas e prontas.");
        console.log(`🔐 OWNER_ID configurado: ${OWNER_ID ? 'SIM' : 'NÃO'}`);
    } catch (err) {
        console.error("❌ Erro crítico ao conectar ou inicializar o banco de dados:", err);
        process.exit(1);
    }
}

const estados = {};
const awaitingReceipt = new Set();
const clsConfirmations = new Map(); // Controle de confirmação do comando /cls

// --- INTERFACE ---
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
    try {
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
                return { pode: true, plano: 'VIP' };
            }
        }
        return { pode: true, plano: 'FREE' };
    } catch (err) {
        console.error("Erro ao verificar acesso:", err);
        return { pode: true, plano: 'FREE' };
    }
}

// --- CONVERTER VALOR COM VALIDAÇÃO ESTRITA ---
function parseValor(texto) {
    if (!texto) return NaN;
    let limpo = String(texto)
        .toLowerCase()
        .replace('r$', '')
        .replace(/\s/g, '')
        .trim();

    let val = NaN;
    if (limpo.endsWith('k')) {
        val = parseFloat(limpo.replace('k', '').replace(',', '.')) * 1000;
    } else {
        val = parseFloat(limpo.replace(/\./g, '').replace(',', '.'));
    }

    if (!Number.isFinite(val) || val <= 0) {
        return NaN;
    }
    return val;
}

// --- LÓGICA PRINCIPAL DO BOT ---
bot.on('message', async (msg) => {
    try {
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        const chatType = msg.chat.type;
        const text = msg.text;

        if (!text) return;

        // --- PROTEÇÃO DE CHAT PRIVADO ---
        if (chatType !== 'private') {
            return bot.sendMessage(
                chatId,
                "⚠️ Por questões de segurança e privacidade, o <b>Imperium Cash</b> funciona exclusivamente em mensagens privadas (chat 1 a 1). Por favor, clique no nome do bot e envie uma mensagem direta para mim.",
                { parse_mode: 'HTML' }
            );
        }

        // --- SISTEMA DE RASTREAMENTO DE AFILIADO/ORIGEM ---
        let origem = 'organico';
        if (text.startsWith('/start ')) {
            const param = text.split(' ')[1]?.trim();
            if (param) {
                const checkAfiliado = await pool.query('SELECT id FROM afiliados WHERE codigo = $1 AND ativo = TRUE', [param]);
                if (checkAfiliado.rowCount > 0) {
                    origem = param;
                }
            }
        }

        const usernameSafe = escapeHtml(msg.from.username || 'Usuario');
        
        // Verifica se usuário já existe para não sobrescrever origem caso já tenha
        const userExists = await pool.query('SELECT origem FROM usuarios WHERE telegram_id = $1', [userId]);
        if (userExists.rowCount === 0) {
            await pool.query(
                `INSERT INTO usuarios (telegram_id, username, origem)
                 VALUES ($1, $2, $3)`,
                [userId, usernameSafe, origem]
            );
        } else {
            await pool.query(
                `UPDATE usuarios SET username = $1 WHERE telegram_id = $2`,
                [usernameSafe, userId]
            );
        }

        // --- MOSTRAR MEU ID ---
        if (text === '/meuid') {
            return bot.sendMessage(
                chatId,
                `🆔 Seu ID do Telegram é:\n<code>${userId}</code>`,
                { parse_mode: 'HTML' }
            );
        }

        // --- COMANDO /HELP (ADMIN) ---
        if (text === '/help') {
            if (!isOwner(userId)) {
                return bot.sendMessage(chatId, "❌ Apenas o administrador pode utilizar este comando.");
            }

            const helpText =
                `🛠️ <b>PAINEL DE AJUDA ADMINISTRATIVA — IMPERIUM CASH</b>\n\n` +
                `Lista de comandos e suas funcionalidades:\n\n` +
                `• /assinantes — Exibe um resumo estatístico com a quantidade de assinantes VIP ativos, usuários FREE e o total geral cadastrados.\n` +
                `• /pagamentos — Lista todas as solicitações de assinatura Pix pendentes aguardando aprovação.\n` +
                `• /afiliado — Exibe o relatório completo de indicações, conversões e comissões do afiliado Samuel.\n` +
                `• /comissoes — Mostra todas as comissões geradas (pendentes e pagas) detalhando os valores e usuários responsáveis.\n` +
                `• /pagarcomissao [ID] — Altera o status de uma comissão específica de PENDENTE para PAGO após a realização do Pix manual.\n` +
                `• /addvip — Inicia o fluxo interativo para promover um usuário ao plano Imperium Plus por 30 dias (renovação acumulativa).\n` +
                `• /vip [ID] — Promove ou renova diretamente o usuário especificado por ID para o plano VIP por mais 30 dias.\n` +
                `• /vips — Exibe a lista detalhada de todos os clientes Imperium Plus ativos.\n` +
                `• /planilha_vip — Exporta uma planilha Excel (.xlsx) contendo apenas os assinantes VIP ativos.\n` +
                `• /planilha_geral — Exporta uma planilha Excel (.xlsx) com o cadastro completo de todos os usuários e suas origens.\n` +
                `• /cls — Inicia o processo de limpeza total do banco de dados (exige confirmação interativa de segurança).`;

            return bot.sendMessage(chatId, helpText, { parse_mode: 'HTML' });
        }

        // --- COMANDO /AFILIADO (ADMIN) ---
        if (text === '/afiliado') {
            if (!isOwner(userId)) {
                return bot.sendMessage(chatId, "❌ Apenas o administrador pode utilizar este comando.");
            }

            try {
                const afRes = await pool.query("SELECT id FROM afiliados WHERE codigo = 'samuel'");
                if (afRes.rowCount === 0) {
                    return bot.sendMessage(chatId, "⚠️ Afiliado Samuel não encontrado no banco de dados.");
                }
                const affId = afRes.rows[0].id;

                const totalIndicadosRes = await pool.query("SELECT COUNT(*) as total FROM usuarios WHERE origem = 'samuel'");
                const indicadosAssinaramRes = await pool.query(
                    `SELECT COUNT(DISTINCT u.telegram_id) as total 
                     FROM usuarios u 
                     JOIN pagamento_solicitacoes p ON u.telegram_id = p.telegram_id 
                     WHERE u.origem = 'samuel' AND p.status = 'APPROVED'`
                );

                const totalIndicados = parseInt(totalIndicadosRes.rows[0].total);
                const indicadosAssinaram = parseInt(indicadosAssinaramRes.rows[0].total);
                const indicadosNaoAssinaram = totalIndicados - indicadosAssinaram;

                const pagamentosAprovadosRes = await pool.query(
                    `SELECT COUNT(p.id) as total 
                     FROM pagamento_solicitacoes p 
                     JOIN usuarios u ON p.telegram_id = u.telegram_id 
                     WHERE u.origem = 'samuel' AND p.status = 'APPROVED'`
                );
                const pagamentosAprovados = parseInt(pagamentosAprovadosRes.rows[0].total);

                const comissoesRes = await pool.query(
                    `SELECT 
                        COALESCE(SUM(valor_comissao), 0) as total_gerado,
                        COALESCE(SUM(CASE WHEN status = 'PAGO' THEN valor_comissao ELSE 0 END), 0) as total_pago,
                        COALESCE(SUM(CASE WHEN status = 'PENDENTE' THEN valor_comissao ELSE 0 END), 0) as total_pendente
                     FROM comissoes_afiliados WHERE affiliate_id = $1`,
                    [affId]
                );

                const comissoesData = comissoesRes.rows[0];
                const totalGerado = parseFloat(comissoesData.total_gerado);
                const totalPago = parseFloat(comissoesData.total_pago);
                const totalPendente = parseFloat(comissoesData.total_pendente);

                const listaIndicadosRes = await pool.query(
                    `SELECT u.telegram_id, u.username, 
                            (SELECT COUNT(p.id) FROM pagamento_solicitacoes p WHERE p.telegram_id = u.telegram_id AND p.status = 'APPROVED') as aprovados,
                            (SELECT COALESCE(SUM(c.valor_comissao), 0) FROM comissoes_afiliados c WHERE c.telegram_id = u.telegram_id) as comissao_gerada
                     FROM usuarios u WHERE u.origem = 'samuel' ORDER BY u.data_cadastro DESC LIMIT 15`
                );

                let relatorioAfiliado =
                    `📈 <b>RELATÓRIO DO AFILIADO — SAMUEL</b>\n\n` +
                    `• Total de pessoas indicadas: <b>${totalIndicados}</b>\n` +
                    `• Pessoas que já assinaram: <b>${indicadosAssinaram}</b>\n` +
                    `• Pessoas que ainda não assinaram: <b>${indicadosNaoAssinaram}</b>\n` +
                    `• Quantidade de pagamentos aprovados: <b>${pagamentosAprovados}</b>\n` +
                    `• Total de comissões geradas: <b>R$ ${totalGerado.toFixed(2)}</b>\n` +
                    `• Total de comissões pagas: <b>R$ ${totalPago.toFixed(2)}</b>\n` +
                    `• Total de comissões pendentes: <b>R$ ${totalPendente.toFixed(2)}</b>\n\n` +
                    `👥 <b>Últimos usuários indicados:</b>\n`;

                if (listaIndicadosRes.rowCount === 0) {
                    relatorioAfiliado +='<i>Nenhum usuário indicado até o momento.</i>';
                } else {
                    listaIndicadosRes.rows.forEach(row => {
                        const assinouStr = parseInt(row.aprovados) > 0 ? 'Sim' : 'Não';
                        relatorioAfiliado += `• @${escapeHtml(row.username || 'N/A')} (<code>${row.telegram_id}</code>) | Assinou: <b>${assinouStr}</b> | Aprovados: ${row.aprovados} | Comissão: R$ ${parseFloat(row.comissao_gerada).toFixed(2)}\n`;
                    });
                }

                return bot.sendMessage(chatId, relatorioAfiliado, { parse_mode: 'HTML' });
            } catch (e) {
                console.error("Erro no /afiliado:", e);
                return bot.sendMessage(chatId, "❌ Erro ao consultar o relatório de afiliados.");
            }
        }

        // --- COMANDO /COMISSOES (ADMIN) ---
        if (text === '/comissoes') {
            if (!isOwner(userId)) {
                return bot.sendMessage(chatId, "❌ Apenas o administrador pode utilizar este comando.");
            }

            try {
                const afRes = await pool.query("SELECT id FROM afiliados WHERE codigo = 'samuel'");
                if (afRes.rowCount === 0) {
                    return bot.sendMessage(chatId, "⚠️ Afiliado Samuel não encontrado.");
                }
                const affId = afRes.rows[0].id;

                const comissoesRes = await pool.query(
                    `SELECT c.id, c.telegram_id, c.valor_comissao, c.status, c.created_at, u.username 
                     FROM comissoes_afiliados c
                     LEFT JOIN usuarios u ON c.telegram_id = u.telegram_id
                     WHERE c.affiliate_id = $1
                     ORDER BY c.created_at DESC LIMIT 20`,
                    [affId]
                );

                const totaisRes = await pool.query(
                    `SELECT 
                        COALESCE(SUM(CASE WHEN status = 'PENDENTE' THEN valor_comissao ELSE 0 END), 0) as pendente,
                        COALESCE(SUM(CASE WHEN status = 'PAGO' THEN valor_comissao ELSE 0 END), 0) as pago
                     FROM comissoes_afiliados WHERE affiliate_id = $1`,
                    [affId]
                );

                const tPendente = parseFloat(totaisRes.rows[0].pendente);
                const tPago = parseFloat(totaisRes.rows[0].pago);

                let respComissoes =
                    `💰 <b>COMISSÕES DE AFILIADOS — SAMUEL</b>\n\n` +
                    `• Total Pendente: <b>R$ ${tPendente.toFixed(2)}</b>\n` +
                    `• Total Pago: <b>R$ ${tPago.toFixed(2)}</b>\n\n` +
                    `📋 <b>Últimas Comissões:</b>\n`;

                if (comissoesRes.rowCount === 0) {
                    respComissoes += `<i>Nenhuma comissão registrada.</i>`;
                } else {
                    comissoesRes.rows.forEach(c => {
                        const dataF = new Date(c.created_at).toLocaleString('pt-BR');
                        const statusEmoji = c.status === 'PAGO' ? '✅' : '⏳';
                        respComissoes += `• ID: <code>${c.id}</code> | ${statusEmoji} <b>R$ ${parseFloat(c.valor_comissao).toFixed(2)}</b> (${c.status}) | User: @${escapeHtml(c.username || 'N/A')} (<code>${c.telegram_id}</code>) | Data: ${dataF}\n`;
                    });
                }

                return bot.sendMessage(chatId, respComissoes, { parse_mode: 'HTML' });
            } catch (e) {
                console.error("Erro no /comissoes:", e);
                return bot.sendMessage(chatId, "❌ Erro ao consultar comissões.");
            }
        }

        // --- COMANDO /PAGARCOMISSAO ID (ADMIN) ---
        if (text.startsWith('/pagarcomissao ')) {
            if (!isOwner(userId)) {
                return bot.sendMessage(chatId, "❌ Apenas o administrador pode utilizar este comando.");
            }

            const comissaoId = parseInt(text.replace('/pagarcomissao', '').trim());
            if (isNaN(comissaoId)) {
                return bot.sendMessage(chatId, "⚠️ Use o formato correto: /pagarcomissao [ID]");
            }

            try {
                const checkC = await pool.query("SELECT * FROM comissoes_afiliados WHERE id = $1", [comissaoId]);
                if (checkC.rowCount === 0) {
                    return bot.sendMessage(chatId, `❌ Comissão com ID ${comissaoId} não foi encontrada.`);
                }

                const comissao = checkC.rows[0];
                if (comissao.status === 'PAGO') {
                    return bot.sendMessage(chatId, `⚠️ Esta comissão (ID ${comissaoId}) já consta como PAGA.`);
                }

                await pool.query(
                    "UPDATE comissoes_afiliados SET status = 'PAGO', paid_at = NOW() WHERE id = $1",
                    [comissaoId]
                );

                return bot.sendMessage(
                    chatId,
                    `✅ <b>Comissão atualizada com sucesso!</b>\nO registro de ID <code>${comissaoId}</code> no valor de R$ ${parseFloat(comissao.valor_comissao).toFixed(2)} foi marcado como <b>PAGO</b>.`,
                    { parse_mode: 'HTML' }
                );
            } catch (e) {
                console.error("Erro no /pagarcomissao:", e);
                return bot.sendMessage(chatId, "❌ Erro ao atualizar o status da comissão.");
            }
        }

        // --- COMANDO /ASSINANTES (ADMIN) ---
        if (text === '/assinantes') {
            if (!isOwner(userId)) {
                return bot.sendMessage(chatId, "❌ Apenas o administrador pode utilizar este comando.");
            }

            try {
                await pool.query(
                    "UPDATE usuarios SET plano = 'FREE', vip_expiracao = NULL WHERE plano = 'VIP' AND vip_expiracao IS NOT NULL AND vip_expiracao < NOW()"
                );

                const countVipRes = await pool.query(
                    "SELECT COUNT(*) as total FROM usuarios WHERE plano = 'VIP' AND (vip_expiracao IS NULL OR vip_expiracao >= NOW())"
                );
                const countFreeRes = await pool.query(
                    "SELECT COUNT(*) as total FROM usuarios WHERE plano = 'FREE' OR (plano = 'VIP' AND vip_expiracao < NOW())"
                );
                const countTotalRes = await pool.query("SELECT COUNT(*) as total FROM usuarios");

                const ativosVip = countVipRes.rows[0].total;
                const totalFree = countFreeRes.rows[0].total;
                const totalGeral = countTotalRes.rows[0].total;

                const relatorioAssinantes =
                    `📊 <b>RELATÓRIO DE ASSINATURAS — IMPERIUM CASH</b>\n\n` +
                    `• 👑 Assinantes ativos do Imperium Plus: <b>${ativosVip}</b>\n` +
                    `• 🆓 Usuários no plano FREE: <b>${totalFree}</b>\n` +
                    `• 👥 Total de usuários cadastrados: <b>${totalGeral}</b>`;

                return bot.sendMessage(chatId, relatorioAssinantes, { parse_mode: 'HTML' });
            } catch (e) {
                console.error("Erro no /assinantes:", e);
                return bot.sendMessage(chatId, "❌ Erro ao consultar o relatório de assinantes.");
            }
        }

        // --- COMANDO /PAGAMENTOS (ADMIN) ---
        if (text === '/pagamentos') {
            if (!isOwner(userId)) {
                return bot.sendMessage(chatId, "❌ Apenas o administrador pode utilizar este comando.");
            }

            try {
                const res = await pool.query("SELECT * FROM pagamento_solicitacoes WHERE status = 'PENDING' ORDER BY created_at ASC");
                if (res.rowCount === 0) {
                    return bot.sendMessage(chatId, '📭 Não há solicitações de pagamento pendentes no momento.');
                }

                let textResp = '📋 <b>Solicitações Pendentes:</b>\n\n';
                res.rows.forEach(r => {
                    const dataF = new Date(r.created_at).toLocaleString('pt-BR');
                    textResp += `• ID: <code>${r.id}</code> | User: ${escapeHtml(r.username)} (<code>${r.telegram_id}</code>) | Data: ${dataF}\n`;
                });
                return bot.sendMessage(chatId, textResp, { parse_mode: 'HTML' });
            } catch (err) {
                console.error("Erro em /pagamentos:", err);
                return bot.sendMessage(chatId, "❌ Erro ao consultar pagamentos pendentes.");
            }
        }

        // --- COMANDO /CLEAN ---
        if (text === '/clean') {
            try {
                await pool.query("DELETE FROM transacoes WHERE user_id = $1", [userId]);
                return bot.sendMessage(
                    chatId,
                    "🗑️ <b>Histórico limpo!</b> Todos os seus registros foram apagados com sucesso.",
                    { parse_mode: 'HTML' }
                );
            } catch (e) {
                console.error("Erro no /clean:", e);
                return bot.sendMessage(chatId, "❌ Erro ao limpar histórico.");
            }
        }

        // --- COMANDO /CLS (COM CONFIRMAÇÃO SEGURA) ---
        if (text === '/cls') {
            if (!isOwner(userId)) {
                return bot.sendMessage(chatId, "❌ Apenas o dono pode utilizar este comando.");
            }

            const confirmKey = `cls_${userId}_${Date.now()}`;
            clsConfirmations.set(userId, { key: confirmKey, expires: Date.now() + 300000 }); // 5 min

            const confirmKeyboard = {
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '⚠️ Sim, apagar TUDO', callback_data: `confirm_cls_${confirmKey}` },
                            { text: '❌ Cancelar', callback_data: `cancel_cls_${confirmKey}` }
                        ]
                    ]
                }
            };

            return bot.sendMessage(
                chatId,
                "⚠️ <b>ATENÇÃO:</b> Você solicitou a limpeza total do banco de dados (usuários, transações e solicitações). Esta ação é irreversível!\n\nDeseja realmente prosseguir?",
                { parse_mode: 'HTML', ...confirmKeyboard }
            );
        }

        // --- /ADDVIP ---
        if (text === '/addvip') {
            if (!isOwner(userId)) {
                return bot.sendMessage(chatId, "❌ Apenas o dono pode gerenciar assinaturas.");
            }

            estados[userId] = { acao: 'pedir_id_vip' };
            return bot.sendMessage(
                chatId,
                "👤 <b>Adicionar Imperium Plus</b>\n\nEnvie o <b>ID do usuário</b> que você deseja promover (renovação acumulativa):",
                { parse_mode: 'HTML', ...tecladoVoltar }
            );
        }

        // --- /VIP E /VIPS ---
        if (text.startsWith('/vip ') || text === '/vips') {
            if (!isOwner(userId)) {
                return bot.sendMessage(chatId, "❌ Apenas o dono pode gerenciar assinaturas.");
            }

            if (text.startsWith('/vip ')) {
                const idParaPromover = text.replace('/vip', '').trim();
                if (!idParaPromover || isNaN(idParaPromover)) {
                    return bot.sendMessage(chatId, "⚠️ Use: /vip ID");
                }

                try {
                    await pool.query(
                        `UPDATE usuarios 
                         SET plano = 'VIP', 
                             vip_expiracao = GREATEST(COALESCE(vip_expiracao, NOW()), NOW()) + INTERVAL '30 days' 
                         WHERE telegram_id = $1`,
                        [idParaPromover]
                    );

                    return bot.sendMessage(
                        chatId,
                        `⭐ ID <code>${idParaPromover}</code> promovido/renovado para Imperium Plus por mais 30 dias (acumulado com sucesso)!`,
                        { parse_mode: 'HTML' }
                    );
                } catch (e) {
                    console.error("Erro no /vip:", e);
                    return bot.sendMessage(chatId, "❌ Erro no banco ao atualizar VIP.");
                }
            }

            if (text === '/vips') {
                try {
                    const res = await pool.query(
                        "SELECT telegram_id, username, vip_expiracao FROM usuarios WHERE plano = 'VIP' AND (vip_expiracao IS NULL OR vip_expiracao >= NOW()) ORDER BY vip_expiracao ASC"
                    );

                    if (res.rowCount === 0) {
                        return bot.sendMessage(chatId, "Nenhum usuário Imperium Plus ativo no momento.");
                    }

                    let lista = "📋 <b>CLIENTES IMPERIUM PLUS ATIVOS:</b>\n\n";
                    res.rows.forEach(u => {
                        const dataExp = u.vip_expiracao
                            ? new Date(u.vip_expiracao).toLocaleDateString('pt-BR')
                            : "Vitalício/Sem data";

                        lista += `👤 @${escapeHtml(u.username || 'Sem User')} (<code>${u.telegram_id}</code>)\n` +
                                 `📅 Vence em: <b>${dataExp}</b>\n\n`;
                    });

                    return bot.sendMessage(chatId, lista, { parse_mode: 'HTML' });
                } catch (e) {
                    console.error("Erro no /vips:", e);
                    return bot.sendMessage(chatId, "❌ Erro ao consultar os usuários VIP.");
                }
            }
        }

        // --- PLANILHAS ---
        if (text === '/planilha_vip' || text === '/planilha_geral') {
            if (!isOwner(userId)) {
                return bot.sendMessage(chatId, "❌ Apenas o dono pode exportar dados.");
            }

            const queryStr = text === '/planilha_geral'
                ? "SELECT telegram_id, username, plano, vip_expiracao, data_cadastro, origem FROM usuarios"
                : "SELECT telegram_id, username, plano, vip_expiracao, data_cadastro, origem FROM usuarios WHERE plano = 'VIP' AND (vip_expiracao IS NULL OR vip_expiracao >= NOW())";

            const nomeArquivo = text === '/planilha_geral' ? 'Relatorio_Todos_Usuarios.xlsx' : 'Relatorio_Imperium_Plus.xlsx';

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

                await bot.sendDocument(chatId, filePath, { caption: '📊 Planilha atualizada.' });

                if (fs.existsSync(filePath)) {
                    fs.unlinkSync(filePath);
                }
                return;
            } catch (e) {
                console.error("Erro ao gerar planilha:", e);
                return bot.sendMessage(chatId, "❌ Erro ao gerar a planilha.");
            }
        }

        // --- COMANDO START ---
        if (text.startsWith('/start') || text === '⬅️ Voltar') {
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
                    return await bot.sendPhoto(chatId, './imperium_cash.jpg', {
                        caption: msgStart,
                        parse_mode: 'HTML',
                        ...menuPrincipal
                    });
                } catch (error) {
                    return bot.sendMessage(chatId, msgStart, {
                        parse_mode: 'HTML',
                        ...menuPrincipal
                    });
                }
            }

            return bot.sendMessage(chatId, msgStart, {
                parse_mode: 'HTML',
                ...menuPrincipal
            });
        }

        // --- MINHA CONTA ---
        if (text === '👤 Minha Conta') {
            try {
                const res = await pool.query('SELECT plano, vip_expiracao FROM usuarios WHERE telegram_id = $1', [userId]);
                const count = await pool.query('SELECT COUNT(*) as total FROM transacoes WHERE user_id = $1', [userId]);

                const user = res.rows[0];
                let exp = "";
                let nomePlano = 'Básico (Free)';

                if (user?.plano === 'VIP') {
                    if (!user.vip_expiracao || new Date(user.vip_expiracao) > new Date()) {
                        nomePlano = '👑 Imperium Plus';
                        if (user.vip_expiracao) {
                            const d = new Date(user.vip_expiracao);
                            const dia = String(d.getDate()).padStart(2, '0');
                            const mes = String(d.getMonth() + 1).padStart(2, '0');
                            const ano = d.getFullYear();
                            exp = `\n\nSeu Imperium Plus expira dia (${dia}/${mes}/${ano})`;
                        }
                    }
                }

                const mensagem =
                    `👤 <b>Minha Conta</b>\n\n` +
                    `ID: <code>${userId}</code>\n` +
                    `Plano: <b>${nomePlano}</b>\n` +
                    `Total de Registros: <b>${count.rows[0].total}</b>${exp}`;

                return bot.sendMessage(chatId, mensagem, { parse_mode: 'HTML', ...menuPrincipal });
            } catch (error) {
                console.error("❌ Erro em Minha Conta:", error);
                return bot.sendMessage(chatId, "❌ Não foi possível carregar os dados da sua conta.", menuPrincipal);
            }
        }

        // --- ASSINAR IMPERIUM PLUS ---
        if (text === '💎 Assinar Imperium Plus') {
            const pixKey = process.env.PIX_KEY || 'Chave Pix não configurada';
            const receiverName = process.env.PIX_RECEIVER_NAME || 'Administrador';
            const description = process.env.PIX_PAYMENT_DESCRIPTION || 'Assinatura Imperium Plus';
            const pixPaymentUrl = process.env.PIX_PAYMENT_URL;
            const statusVip = await verificarAcesso(userId);

            const pendRes = await pool.query("SELECT * FROM pagamento_solicitacoes WHERE telegram_id = $1 AND status = 'PENDING'", [userId]);
            if (pendRes.rows.length > 0) {
                return bot.sendMessage(chatId, '⏳ Você já possui uma solicitação pendente aguardando análise administrativa.', menuPrincipal);
            }

            let infoVipAtivo = '';
            if (statusVip.plano === 'VIP') {
                infoVipAtivo = `\nℹ️ <b>Nota:</b> Você já possui assinatura ativa. Um novo pagamento estenderá seu VIP por mais 30 dias (acumulativo)!\n`;
            }

            const plusText =
                `💎 <b>Imperium Plus</b> — Assinatura Mensal\n\n` +
                `• <b>Preço:</b> R$ 5,00\n` +
                `• <b>Duração:</b> 30 dias de acesso VIP\n` +
                `• <b>Benefícios:</b> Lançamentos ilimitados, gráficos avançados, exportação ilimitada de relatórios e prioridade.\n` +
                `${infoVipAtivo}\n` +
                `📌 <b>Dados para Pagamento via Pix:</b>\n` +
                `• Chave Pix: <code>${escapeHtml(pixKey)}</code>\n` +
                `• Nome: ${escapeHtml(receiverName)}\n` +
                `• Descrição: ${escapeHtml(description)}\n\n` +
                `💳 <b>Como proceder:</b>\n` +
                `1. Clique no botão abaixo para pagar via Pix pelo Nubank, ou copie a chave acima.\n` +
                `2. Após realizar o pagamento, retorne e clique em "✅ Já realizei o pagamento".`;

            const inlineRows = [];
            if (pixPaymentUrl) {
                inlineRows.push([{ text: '🔗 Pagar R$ 5,00 via Pix', url: pixPaymentUrl }]);
            }
            inlineRows.push([{ text: '✅ Já realizei o pagamento', callback_data: 'enviar_comprovante_fluxo' }]);
            inlineRows.push([{ text: '❌ Cancelar', callback_data: 'cancelar_assinatura' }]);

            return bot.sendMessage(chatId, plusText, { parse_mode: 'HTML', reply_markup: { inline_keyboard: inlineRows } });
        }

        // --- EDITAR LANÇAMENTO ---
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
                    listText += `<b>${idx + 1}.</b> ${tipoFormatado} — R$ ${valorF} — ${escapeHtml(tx.descricao)}\n`;
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

        // --- MENU NORMAL ---
        if (!estado) {
            if (text === '💸 Gastei' || text === '💰 Ganhei' || text === '📈 Investi') {
                const check = await verificarAcesso(userId);

                if (!check.pode) {
                    return bot.sendMessage(chatId, check.msg, { parse_mode: 'HTML' });
                }

                // --- VERIFICAÇÃO DE LIMITE DE 15 LANÇAMENTOS PARA FREE ---
                if (check.plano !== 'VIP') {
                    const countRes = await pool.query('SELECT COUNT(*) as total FROM transacoes WHERE user_id = $1', [userId]);
                    const totalLancamentos = parseInt(countRes.rows[0].total);

                    if (totalLancamentos >= 15) {
                        const msgLimite =
                            `🚀 <b>Você atingiu o limite do plano gratuito!</b>\n` +
                            `Você já utilizou seus 15 lançamentos gratuitos.\n` +
                            `Com o <b>Imperium Plus</b>, você tem lançamentos ilimitados e pode continuar organizando suas finanças sem restrições.\n` +
                            `💎 Assine o Imperium Plus para continuar!`;

                        const keyboardAssinar = {
                            reply_markup: {
                                inline_keyboard: [
                                    [{ text: '💎 Assinar Imperium Plus', callback_data: 'clique_assinar_plus' }]
                                ]
                            }
                        };

                        return bot.sendMessage(chatId, msgLimite, { parse_mode: 'HTML', ...keyboardAssinar });
                    }
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

        // --- PEDIR ID VIP (/ADDVIP) ---
        if (estado.acao === 'pedir_id_vip') {
            const idPromover = text.trim();
            if (isNaN(idPromover)) {
                return bot.sendMessage(chatId, "⚠️ O ID deve conter apenas números. Tente novamente ou use '⬅️ Voltar':", tecladoVoltar);
            }

            try {
                await pool.query(
                    `UPDATE usuarios 
                     SET plano = 'VIP', 
                         vip_expiracao = GREATEST(COALESCE(vip_expiracao, NOW()), NOW()) + INTERVAL '30 days' 
                     WHERE telegram_id = $1`,
                    [idPromover]
                );

                await bot.sendMessage(
                    chatId,
                    `⭐ Sucesso! O usuário de ID <code>${idPromover}</code> agora possui o Imperium Plus por mais 30 dias (renovação acumulada)!`,
                    { parse_mode: 'HTML', ...menuPrincipal }
                );
            } catch (e) {
                console.error("Erro ao promover usuário:", e);
                await bot.sendMessage(chatId, "❌ Erro ao promover usuário.", menuPrincipal);
            }

            delete estados[userId];
            return;
        }

        // --- PEDIR VALOR ---
        if (estado.acao === 'pedir_valor') {
            const v = parseValor(text);

            if (isNaN(v)) {
                return bot.sendMessage(chatId, "⚠️ Valor inválido. Digite apenas números maiores que zero (ex: 50.00).", tecladoVoltar);
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

        // --- PEDIR DESCRIÇÃO E SALVAR ---
        if (estado.acao === 'pedir_desc') {
            const descricaoSegura = escapeHtml(text);

            await pool.query(
                'INSERT INTO transacoes (user_id, tipo, valor, descricao) VALUES ($1, $2, $3, $4)',
                [userId, estado.tipo, estado.valor, descricaoSegura]
            );

            const contagemQuery = await pool.query('SELECT COUNT(*) as total FROM transacoes WHERE user_id = $1', [userId]);
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
                { parse_mode: 'HTML', ...menuPrincipal }
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

            return bot.sendMessage(chatId, `Confirma a alteração de "${escapeHtml(oldVal)}" para "${escapeHtml(estado.newValue)}"? Responda 'sim' ou 'não'.`, tecladoVoltar);
        }

        if (estado.acao === 'edit_confirm') {
            if (text.toLowerCase() === 'sim' || text.toLowerCase() === 's') {
                try {
                    let queryField = 'descricao';
                    let valToSave = escapeHtml(estado.newValue);

                    if (estado.fieldToEdit === 'valor') {
                        queryField = 'valor';
                        valToSave = parseValor(estado.newValue);
                        if (isNaN(valToSave)) {
                            delete estados[userId];
                            return bot.sendMessage(chatId, '⚠️ Valor numérico inválido. Edição cancelada.', menuPrincipal);
                        }
                    } else if (estado.fieldToEdit === 'tipo') {
                        queryField = 'tipo';
                        const t = estado.newValue.toLowerCase();
                        if (t.includes('ganh') || t.includes('entrada')) valToSave = 'entrada';
                        else if (t.includes('inv')) valToSave = 'investimento';
                        else if (t.includes('gast') || t.includes('saída') || t.includes('saida')) valToSave = 'saida';
                        else {
                            delete estados[userId];
                            return bot.sendMessage(chatId, '⚠️ Tipo inválido. Utilize apenas: Ganhei, Gastei ou Investi. Edição cancelada.', menuPrincipal);
                        }
                    } else if (estado.fieldToEdit === 'data') {
                        queryField = 'data';
                        const parsedDate = new Date(estado.newValue);
                        if (isNaN(parsedDate.getTime())) {
                            delete estados[userId];
                            return bot.sendMessage(chatId, '⚠️ Data inválida. Edição cancelada.', menuPrincipal);
                        }
                        valToSave = parsedDate;
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

// --- CALLBACK QUERIES ---
bot.on('callback_query', async (callbackQuery) => {
    const msg = callbackQuery.message;
    const chatId = msg.chat.id;
    const data = callbackQuery.data;
    const userId = callbackQuery.from.id;

    try {
        // --- TRATAMENTO DE CONFIRMAÇÃO DO /CLS ---
        if (data.startsWith('confirm_cls_') || data.startsWith('cancel_cls_')) {
            const parts = data.split('_');
            const action = parts[0]; // confirm ou cancel
            const confirmKey = parts[2] + '_' + parts[3];

            const stored = clsConfirmations.get(userId);
            if (!stored || stored.key !== confirmKey || Date.now() > stored.expires) {
                await bot.answerCallbackQuery(callbackQuery.id, { text: 'Esta solicitação de limpeza expirou.', show_alert: true });
                return bot.deleteMessage(chatId, msg.message_id).catch(() => {});
            }

            clsConfirmations.delete(userId);

            if (action === 'cancel') {
                await bot.answerCallbackQuery(callbackQuery.id, { text: 'Operação cancelada.' });
                return bot.editMessageText('❌ Limpeza do banco de dados cancelada com sucesso.', { chat_id: chatId, message_id: msg.message_id });
            }

            if (action === 'confirm' && isOwner(userId)) {
                await pool.query("TRUNCATE TABLE transacoes, usuarios, pagamento_solicitacoes, comissoes_afiliados RESTART IDENTITY CASCADE;");
                await bot.answerCallbackQuery(callbackQuery.id, { text: 'Banco zerado!' });
                return bot.editMessageText('⚠️ <b>BANCO DE DADOS TOTALMENTE ZERADO!</b>\nTodos os dados foram apagados permanentemente.', { chat_id: chatId, message_id: msg.message_id, parse_mode: 'HTML' });
            }
            return;
        }

        if (data === 'clique_assinar_plus') {
            await bot.answerCallbackQuery(callbackQuery.id);
            const pixKey = process.env.PIX_KEY || 'Chave Pix não configurada';
            const receiverName = process.env.PIX_RECEIVER_NAME || 'Administrador';
            const description = process.env.PIX_PAYMENT_DESCRIPTION || 'Assinatura Imperium Plus';
            const pixPaymentUrl = process.env.PIX_PAYMENT_URL;
            const statusVip = await verificarAcesso(userId);

            const pendRes = await pool.query("SELECT * FROM pagamento_solicitacoes WHERE telegram_id = $1 AND status = 'PENDING'", [userId]);
            if (pendRes.rows.length > 0) {
                return bot.sendMessage(chatId, '⏳ Você já possui uma solicitação pendente aguardando análise administrativa.', menuPrincipal);
            }

            let infoVipAtivo = '';
            if (statusVip.plano === 'VIP') {
                infoVipAtivo = `\nℹ️ <b>Nota:</b> Você já possui assinatura ativa. Um novo pagamento estenderá seu VIP por mais 30 dias!\n`;
            }

            const plusText =
                `💎 <b>Imperium Plus</b> — Assinatura Mensal\n\n` +
                `• <b>Preço:</b> R$ 5,00\n` +
                `• <b>Duração:</b> 30 dias de acesso VIP\n` +
                `• <b>Benefícios:</b> Lançamentos ilimitados, gráficos avançados, exportação ilimitada de relatórios e prioridade.\n` +
                `${infoVipAtivo}\n` +
                `📌 <b>Dados para Pagamento via Pix:</b>\n` +
                `• Chave Pix: <code>${escapeHtml(pixKey)}</code>\n` +
                `• Nome: ${escapeHtml(receiverName)}\n` +
                `• Descrição: ${escapeHtml(description)}\n\n` +
                `💳 <b>Como proceder:</b>\n` +
                `1. Clique no botão abaixo para pagar via Pix pelo Nubank, ou copie a chave acima.\n` +
                `2. Após realizar o pagamento, retorne e clique em "✅ Já realizei o pagamento".`;

            const inlineRows = [];
            if (pixPaymentUrl) {
                inlineRows.push([{ text: '🔗 Pagar R$ 5,00 via Pix', url: pixPaymentUrl }]);
            }
            inlineRows.push([{ text: '✅ Já realizei o pagamento', callback_data: 'enviar_comprovante_fluxo' }]);
            inlineRows.push([{ text: '❌ Cancelar', callback_data: 'cancelar_assinatura' }]);

            return bot.sendMessage(chatId, plusText, { parse_mode: 'HTML', reply_markup: { inline_keyboard: inlineRows } });
        }

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
                    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Esta solicitação já foi processada.', show_alert: true });
                    return;
                }

                if (action === 'aprovar') {
                    await client.query(
                        "UPDATE pagamento_solicitacoes SET status = 'APPROVED', reviewed_at = NOW(), reviewed_by = $1 WHERE id = $2",
                        [userId, reqId]
                    );

                    await client.query(
                        `UPDATE usuarios 
                         SET plano = 'VIP', 
                             vip_expiracao = GREATEST(COALESCE(vip_expiracao, NOW()), NOW()) + INTERVAL '30 days' 
                         WHERE telegram_id = $1`,
                        [solicitacao.telegram_id]
                    );

                    // --- REGISTRAR COMISSÃO PARA O AFILIADO SAMUEL CASO APLICÁVEL ---
                    const userOrigemRes = await client.query("SELECT origem FROM usuarios WHERE telegram_id = $1", [solicitacao.telegram_id]);
                    if (userOrigemRes.rowCount > 0 && userOrigemRes.rows[0].origem === 'samuel') {
                        const afRes = await client.query("SELECT id FROM afiliados WHERE codigo = 'samuel'");
                        if (afRes.rowCount > 0) {
                            const affId = afRes.rows[0].id;
                            const valorAssinatura = 5.00;
                            const valorComissao = 1.00; // 20% de R$ 5,00

                            // Insere comissão com restrição UNIQUE na solicitacao_id para evitar duplicidade
                            await client.query(
                                `INSERT INTO comissoes_afiliados (affiliate_id, telegram_id, solicitacao_id, valor_assinatura, valor_comissao, status)
                                 VALUES ($1, $2, $3, $4, $5, 'PENDING')
                                 ON CONFLICT (solicitacao_id) DO NOTHING`,
                                [affId, solicitacao.telegram_id, reqId, valorAssinatura, valorComissao]
                            );
                        }
                    }

                    await client.query('COMMIT');

                    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Aprovado com sucesso!' });
                    await bot.editMessageCaption(
                        `✅ <b>SOLICITAÇÃO APROVADA</b>\nID: <code>${reqId}</code>\nCliente: ${escapeHtml(solicitacao.username)} (<code>${solicitacao.telegram_id}</code>)`,
                        { chat_id: chatId, message_id: msg.message_id, parse_mode: 'HTML' }
                    );

                    await bot.sendMessage(
                        solicitacao.telegram_id,
                        `🎉 <b>Pagamento Aprovado!</b>\n\nSua assinatura do <b>Imperium Plus</b> foi ativada/renovada por mais 30 dias com sucesso!`,
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
                        `❌ <b>SOLICITAÇÃO REJEITADA</b>\nID: <code>${reqId}</code>\nCliente: ${escapeHtml(solicitacao.username)} (<code>${solicitacao.telegram_id}</code>)`,
                        { chat_id: chatId, message_id: msg.message_id, parse_mode: 'HTML' }
                    );

                    await bot.sendMessage(
                        solicitacao.telegram_id,
                        `⚠️ Seu comprovante do Imperium Plus não foi aprovado. Verifique os dados do Pix ou entre em contato com o suporte.`,
                        { parse_mode: 'HTML', ...menuPrincipal }
                    );
                }
            } catch (err) {
                await client.query('ROLLBACK');
                console.error("Erro no callback de pagamento:", err);
            } finally {
                client.release();
            }
        }
    } catch (err) {
        console.error("Erro geral em callback_query:", err);
    }
});

// --- RECEBIMENTO DE COMPROVANTES (FOTOS / DOCUMENTOS) COM PROTEÇÃO CONTRA DUPLICIDADE ---
bot.on('photo', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    if (msg.chat.type !== 'private' || isOwner(userId)) return;

    if (awaitingReceipt.has(userId)) {
        awaitingReceipt.delete(userId);
        const photo = msg.photo[msg.photo.length - 1];
        await registrarEEnviarSolicitacao(msg, photo.file_id, 'photo');
    }
});

bot.on('document', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    if (msg.chat.type !== 'private' || isOwner(userId)) return;

    if (awaitingReceipt.has(userId)) {
        awaitingReceipt.delete(userId);
        const document = msg.document;
        await registrarEEnviarSolicitacao(msg, document.file_id, 'document');
    }
});

async function registrarEEnviarSolicitacao(msg, fileId, fileType) {
    const chatId = msg.chat.id;
    const user = msg.from;
    const nomeCliente = escapeHtml(user.first_name || 'Cliente');
    const username = escapeHtml(user.username ? `@${user.username}` : 'Não disponível');

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        // Verifica se já existe solicitação pendente de forma segura (Lock)
        const checkPend = await client.query(
            "SELECT id FROM pagamento_solicitacoes WHERE telegram_id = $1 AND status = 'PENDING' FOR UPDATE",
            [chatId]
        );

        if (checkPend.rowCount > 0) {
            await client.query('ROLLBACK');
            return bot.sendMessage(chatId, '⏳ Você já possui uma solicitação pendente aguardando análise administrativa.', menuPrincipal);
        }

        const res = await client.query(
            `INSERT INTO pagamento_solicitacoes (telegram_id, username, valor, status, telegram_file_id, file_type, created_at)
             VALUES ($1, $2, 5.00, 'PENDING', $3, $4, NOW()) RETURNING id`,
            [chatId, username, fileId, fileType]
        );

        const reqId = res.rows[0].id;
        await client.query('COMMIT');

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
        await client.query('ROLLBACK');
        console.error('Erro ao registrar solicitação de pagamento:', err);
        await bot.sendMessage(chatId, '❌ Ocorreu um erro ao enviar seu comprovante. Tente novamente mais tarde.', menuPrincipal);
    } finally {
        client.release();
    }
}

// --- GRÁFICO / ANÁLISE ---
async function enviarGraficoCompleto(chatId, userId) {
    try {
        const res = await pool.query(
            "SELECT tipo, SUM(valor) as total FROM transacoes WHERE user_id = $1 GROUP BY tipo",
            [userId]
        );

        if (res.rowCount === 0) {
            return bot.sendMessage(chatId, "Sem dados suficientes para gerar uma análise.", menuPrincipal);
        }

        let gn = 0;
        let gs = 0;
        let inv = 0;

        res.rows.forEach(r => {
            if (r.tipo === 'entrada') gn = parseFloat(r.total);
            else if (r.tipo === 'saida') gs = parseFloat(r.total);
            else if (r.tipo === 'investimento') inv = parseFloat(r.total);
        });

        const saldoDisponivel = gn - gs - inv;
        const patrimonioTotal = saldoDisponivel + inv;

        const chart = new QuickChart();
        chart.setConfig({
            type: 'doughnut',
            data: {
                labels: ['Ganhos', 'Gastos', 'Investimentos'],
                datasets: [{
                    data: [gn, gs, inv],
                    backgroundColor: ['#2ecc71', '#e74c3c', '#3498db'],
                    borderWidth: 2
                }]
            },
            options: {
                plugins: {
                    legend: { position: 'bottom', labels: { fontSize: 16 } }
                }
            }
        }).setWidth(500).setHeight(350);

        const msgInfo =
            `📊 <b>RESUMO FINANCEIRO DETALHADO</b>\n\n` +
            `🟢 <b>Ganhos Totais:</b> R$ ${gn.toFixed(2)}\n` +
            `🔴 <b>Gastos Totais:</b> R$ ${gs.toFixed(2)}\n` +
            `📈 <b>Investimentos:</b> R$ ${inv.toFixed(2)}\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `💰 <b>Dinheiro Disponível (Conta):</b> R$ ${saldoDisponivel.toFixed(2)}\n` +
            `🏦 <b>Patrimônio Total:</b> R$ ${patrimonioTotal.toFixed(2)}\n\n` +
            `<i>*Seu Patrimônio Total é a soma do dinheiro na conta mais os seus investimentos.</i>`;

        return bot.sendPhoto(chatId, await chart.getShortUrl(), {
            caption: msgInfo,
            parse_mode: 'HTML',
            ...menuPrincipal
        });
    } catch (error) {
        console.error("❌ Erro na análise:", error);
        return bot.sendMessage(chatId, "❌ Não foi possível gerar a análise financeira.", menuPrincipal);
    }
}

// --- HISTÓRICO ---
async function enviarRelatorio(chatId, userId) {
    try {
        const res = await pool.query(
            "SELECT * FROM transacoes WHERE user_id = $1 ORDER BY data DESC LIMIT 15",
            [userId]
        );

        if (res.rowCount === 0) {
            return bot.sendMessage(chatId, "Seu histórico está vazio no momento.", menuPrincipal);
        }

        let m = "📋 <b>SEUS ÚLTIMOS LANÇAMENTOS:</b>\n━━━━━━━━━━━━━━━━━━━━━━\n";

        res.rows.forEach(t => {
            let icone = '🔴';
            if (t.tipo === 'entrada') icone = '🟢';
            if (t.tipo === 'investimento') icone = '📈';

            const d = new Date(t.data);
            const dataFormatada = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;

            m += `${icone} <b>R$ ${parseFloat(t.valor).toFixed(2)}</b> - ${escapeHtml(t.descricao)} <i>(${dataFormatada})</i>\n`;
        });

        m += "━━━━━━━━━━━━━━━━━━━━━━\n<i>Seu histórico financeiro está organizado aqui.</i>";

        return bot.sendMessage(chatId, m, { parse_mode: 'HTML', ...menuPrincipal });
    } catch (error) {
        console.error("❌ Erro no histórico:", error);
        return bot.sendMessage(chatId, "❌ Não foi possível carregar seu histórico.", menuPrincipal);
    }
}

// --- SERVIDOR WEB EXPRESS ---
const app = express();
app.get('/', (req, res) => {
    res.send('Bot Online - Gestão Premium Ativa');
});

const PORT = process.env.PORT || 3000;

// --- INICIALIZAÇÃO CORRETA: O servidor e o polling só sobem APÓS o banco estar pronto ---
setupDB().then(() => {
    app.listen(PORT, () => {
        console.log(`🌐 Servidor online na porta ${PORT}`);
    });
});

// --- PROTEÇÃO CONTRA EXCEÇÕES GLOBAIS ---
process.on('unhandledRejection', (reason) => {
    console.error("❌ Unhandled Rejection:", reason);
});

process.on('uncaughtException', (error) => {
    console.error("❌ Uncaught Exception:", error);
});