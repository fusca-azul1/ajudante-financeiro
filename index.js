require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const QuickChart = require('quickchart-js');
const { Pool } = require('pg');
const ExcelJS = require('exceljs');
const fs = require('fs');

const token = process.env.BOT_TOKEN;
const OWNER_ID = String(process.env.OWNER_ID || '').trim();
const MAX_BIGINT = 9223372036854775807n;
const MAX_VALOR = 9999999999.99; // Limite de DECIMAL(12,2) no PostgreSQL

if (!token) {
    console.error('❌ BOT_TOKEN não configurado.');
    process.exit(1);
}

if (!process.env.DATABASE_URL) {
    console.error('❌ DATABASE_URL não configurado.');
    process.exit(1);
}

if (!OWNER_ID) {
    console.error('⚠️ OWNER_ID não configurado no .env.');
}

// O polling só será iniciado depois que o banco estiver pronto.
const bot = new TelegramBot(token, { polling: false });

// --- CONEXÃO COM BANCO ---
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

pool.on('error', (error) => {
    console.error('❌ Erro inesperado no pool PostgreSQL:', error);
});

// --- VERIFICAR DONO ---
function isOwner(userId) {
    return OWNER_ID !== '' && String(userId).trim() === OWNER_ID;
}

// --- VALIDAÇÃO DE ID DO TELEGRAM / BIGINT ---
function isValidTelegramId(value) {
    const id = String(value ?? '').trim();
    if (!/^[1-9]\d*$/.test(id)) return false;

    try {
        const parsed = BigInt(id);
        return parsed > 0n && parsed <= MAX_BIGINT;
    } catch (_) {
        return false;
    }
}

// --- FUNÇÃO DE SEGURANÇA HTML ---
function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// --- VALIDAR LINK DE PAGAMENTO ---
function getPixPaymentUrl() {
    const rawUrl = String(process.env.PIX_PAYMENT_URL || '').trim();
    if (!rawUrl) return null;

    try {
        const parsed = new URL(rawUrl);
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
        return parsed.toString();
    } catch (_) {
        console.error('⚠️ PIX_PAYMENT_URL inválida. O botão de pagamento será ocultado.');
        return null;
    }
}

// --- ERROS DO TELEGRAM ---
bot.on('polling_error', (error) => {
    console.error('❌ Erro no polling do Telegram:', error.message);
});

bot.on('webhook_error', (error) => {
    console.error('❌ Erro de webhook do Telegram:', error.message);
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

            -- Compatibilidade com instalações anteriores destas tabelas.
            ALTER TABLE pagamento_solicitacoes
                ADD COLUMN IF NOT EXISTS telegram_file_id TEXT;
            ALTER TABLE pagamento_solicitacoes
                ADD COLUMN IF NOT EXISTS file_type TEXT;
            ALTER TABLE pagamento_solicitacoes
                ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMP;
            ALTER TABLE pagamento_solicitacoes
                ADD COLUMN IF NOT EXISTS reviewed_by BIGINT;
            ALTER TABLE comissoes_afiliados
                ADD COLUMN IF NOT EXISTS paid_at TIMESTAMP;
        `);

        await pool.query(`
            UPDATE comissoes_afiliados
            SET status = 'PENDENTE'
            WHERE status = 'PENDING';
        `);

        // Mantém o afiliado existente e sua configuração; cria-o somente se ainda não existir.
        await pool.query(`
            INSERT INTO afiliados (codigo, nome, percentual_comissao, ativo)
            VALUES ('samuel', 'Samuel', 20.00, TRUE)
            ON CONFLICT (codigo) DO NOTHING;
        `);

        console.log('✅ Banco conectado com sucesso: tabelas verificadas e prontas.');
        console.log(`🔐 OWNER_ID configurado: ${OWNER_ID ? 'SIM' : 'NÃO'}`);
    } catch (err) {
        console.error('❌ Erro crítico ao conectar ou inicializar o banco de dados:', err);
        throw err;
    }
}

const estados = Object.create(null);
const awaitingReceipt = new Set();
const clsConfirmations = new Map();

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
        console.error('Erro ao verificar acesso:', err);
        // Falha fechada: não inicia uma operação financeira se não for possível validar o acesso.
        return {
            pode: false,
            plano: 'INDEFINIDO',
            msg: '⚠️ Não foi possível verificar seu plano agora. Tente novamente em instantes.'
        };
    }
}

// --- CONVERTER VALOR ---
// Aceita: 50 | 50.00 | 50,00 | 1.500,50 | 1.500 | R$ 50,00 | 2k | 1,5k.
// Rejeita separadores inconsistentes, mais de duas casas decimais, zero e negativos.
function parseValor(texto) {
    if (texto === null || texto === undefined) return NaN;

    let valorTexto = String(texto).trim().toLowerCase();
    if (!valorTexto) return NaN;

    valorTexto = valorTexto.replace(/\s+/g, '');
    if (valorTexto.startsWith('r$')) {
        valorTexto = valorTexto.slice(2);
    }
    if (!valorTexto || valorTexto.includes('r$')) return NaN;

    let multiplicadorK = false;
    if (valorTexto.endsWith('k')) {
        multiplicadorK = true;
        valorTexto = valorTexto.slice(0, -1);
    }

    if (!valorTexto) return NaN;

    let normalizado;

    if (multiplicadorK) {
        // Para o sufixo k, só aceita um número simples com até duas casas decimais.
        if (!/^\d+(?:[.,]\d{1,2})?$/.test(valorTexto)) return NaN;
        normalizado = valorTexto.replace(',', '.');
    } else if (/^\d+$/.test(valorTexto)) {
        normalizado = valorTexto;
    } else if (/^\d+,\d{1,2}$/.test(valorTexto)) {
        normalizado = valorTexto.replace(',', '.');
    } else if (/^\d+\.\d{1,2}$/.test(valorTexto)) {
        normalizado = valorTexto;
    } else if (/^\d{1,3}(?:\.\d{3})+,\d{1,2}$/.test(valorTexto)) {
        normalizado = valorTexto.replace(/\./g, '').replace(',', '.');
    } else if (/^\d{1,3}(?:\.\d{3})+$/.test(valorTexto)) {
        normalizado = valorTexto.replace(/\./g, '');
    } else {
        return NaN;
    }

    let valor = Number(normalizado);
    if (!Number.isFinite(valor)) return NaN;
    if (multiplicadorK) valor *= 1000;

    if (!Number.isFinite(valor) || valor <= 0 || valor > MAX_VALOR) return NaN;

    valor = Math.round((valor + Number.EPSILON) * 100) / 100;
    if (valor <= 0 || valor > MAX_VALOR) return NaN;
    return valor;
}

// --- VALIDAR DATA INFORMADA PELO USUÁRIO ---
// Aceita DD/MM/AAAA ou AAAA-MM-DD e salva a data no horário local, sem parsing ambíguo.
function parseDataUsuario(texto) {
    const valor = String(texto || '').trim();
    let ano;
    let mes;
    let dia;

    let match = valor.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (match) {
        dia = Number(match[1]);
        mes = Number(match[2]);
        ano = Number(match[3]);
    } else {
        match = valor.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (!match) return null;        ano = Number(match[1]);
        mes = Number(match[2]);
        dia = Number(match[3]);
    }

    const data = new Date(ano, mes - 1, dia, 12, 0, 0, 0);
    if (
        data.getFullYear() !== ano ||
        data.getMonth() !== mes - 1 ||
        data.getDate() !== dia
    ) {
        return null;
    }
    return data;
}

// --- COMANDO START / RASTREAMENTO ---
function isStartCommand(text) {
    return /^\/start(?:@\w+)?(?:\s|$)/i.test(String(text || ''));
}

function getStartParameter(text) {
    const match = String(text || '').match(/^\/start(?:@\w+)?(?:\s+(.+))?$/i);
    return match && match[1] ? match[1].trim().split(/\s+/)[0].toLowerCase() : null;
}

// --- LÓGICA PRINCIPAL DO BOT ---
bot.on('message', async (msg) => {
    try {
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        const chatType = msg.chat.type;
        const text = msg.text;

        if (typeof text !== 'string') return;

        // --- PROTEÇÃO DE CHAT PRIVADO ---
        if (chatType !== 'private') {
            return bot.sendMessage(
                chatId,
                '⚠️ Por questões de segurança e privacidade, o <b>Imperium Cash</b> funciona exclusivamente em mensagens privadas (chat 1 a 1). Por favor, clique no nome do bot e envie uma mensagem direta para mim.',
                { parse_mode: 'HTML' }
            );
        }

        // --- CADASTRO / RASTREAMENTO DE AFILIADO ---
        let origemInicial = 'organico';
        const startParameter = getStartParameter(text);

        if (startParameter) {
            const checkAfiliado = await pool.query(
                'SELECT id FROM afiliados WHERE codigo = $1 AND ativo = TRUE',
                [startParameter]
            );
            if (checkAfiliado.rowCount > 0) origemInicial = startParameter;
        }

        const usernameOriginal = msg.from.username || 'Usuario';
        // UPSERT evita corrida entre duas mensagens simultâneas e nunca sobrescreve a origem inicial.
        await pool.query(
            `INSERT INTO usuarios (telegram_id, username, origem)
             VALUES ($1, $2, $3)
             ON CONFLICT (telegram_id)
             DO UPDATE SET username = EXCLUDED.username`,
            [userId, usernameOriginal, origemInicial]
        );

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
                return bot.sendMessage(chatId, '❌ Apenas o administrador pode utilizar este comando.');
            }

            const helpText =
                `🛠️ <b>PAINEL DE AJUDA ADMINISTRATIVA — IMPERIUM CASH</b>\n\n` +
                `Lista de comandos e suas funcionalidades:\n\n` +
                `• /assinantes — Exibe a quantidade de assinantes VIP ativos, usuários FREE e total cadastrado.\n` +
                `• /pagamentos — Lista solicitações Pix pendentes.\n` +
                `• /afiliado — Exibe indicações, conversões e comissões do afiliado Samuel.\n` +
                `• /comissoes — Lista comissões pendentes e pagas.\n` +
                `• /pagarcomissao [ID] — Marca uma comissão pendente como paga após a transferência Pix.\n` +
                `• /addvip — Promove um usuário ao Imperium Plus por 30 dias, com renovação acumulativa.\n` +
                `• /cls — Inicia a limpeza total do banco de dados, com confirmação de segurança.`;

            return bot.sendMessage(chatId, helpText, { parse_mode: 'HTML' });
        }

        // --- COMANDO /AFILIADO (ADMIN) ---
        if (text === '/afiliado') {
            if (!isOwner(userId)) {
                return bot.sendMessage(chatId, '❌ Apenas o administrador pode utilizar este comando.');
            }

            try {
                const afRes = await pool.query("SELECT id FROM afiliados WHERE codigo = 'samuel'");
                if (afRes.rowCount === 0) {
                    return bot.sendMessage(chatId, '⚠️ Afiliado Samuel não encontrado no banco de dados.');
                }
                const affId = afRes.rows[0].id;

                const totalIndicadosRes = await pool.query(
                    "SELECT COUNT(*) AS total FROM usuarios WHERE origem = 'samuel'"
                );
                const indicadosAssinaramRes = await pool.query(
                    `SELECT COUNT(DISTINCT u.telegram_id) AS total
                     FROM usuarios u
                     JOIN pagamento_solicitacoes p ON u.telegram_id = p.telegram_id
                     WHERE u.origem = 'samuel' AND p.status = 'APPROVED'`
                );

                const totalIndicados = Number.parseInt(totalIndicadosRes.rows[0].total, 10);
                const indicadosAssinaram = Number.parseInt(indicadosAssinaramRes.rows[0].total, 10);
                const indicadosNaoAssinaram = Math.max(0, totalIndicados - indicadosAssinaram);

                const pagamentosAprovadosRes = await pool.query(
                    `SELECT COUNT(p.id) AS total
                     FROM pagamento_solicitacoes p
                     JOIN usuarios u ON p.telegram_id = u.telegram_id
                     WHERE u.origem = 'samuel' AND p.status = 'APPROVED'`
                );
                const pagamentosAprovados = Number.parseInt(pagamentosAprovadosRes.rows[0].total, 10);

                const comissoesRes = await pool.query(
                    `SELECT
                        COALESCE(SUM(valor_comissao), 0) AS total_gerado,
                        COALESCE(SUM(CASE WHEN status = 'PAGO' THEN valor_comissao ELSE 0 END), 0) AS total_pago,
                        COALESCE(SUM(CASE WHEN status = 'PENDENTE' THEN valor_comissao ELSE 0 END), 0) AS total_pendente
                     FROM comissoes_afiliados WHERE affiliate_id = $1`,
                    [affId]
                );

                const comissoesData = comissoesRes.rows[0];
                const totalGerado = Number.parseFloat(comissoesData.total_gerado);
                const totalPago = Number.parseFloat(comissoesData.total_pago);
                const totalPendente = Number.parseFloat(comissoesData.total_pendente);

                const listaIndicadosRes = await pool.query(
                    `SELECT u.telegram_id, u.username,
                            (SELECT COUNT(p.id) FROM pagamento_solicitacoes p WHERE p.telegram_id = u.telegram_id AND p.status = 'APPROVED') AS aprovados,
                            (SELECT COALESCE(SUM(c.valor_comissao), 0) FROM comissoes_afiliados c WHERE c.telegram_id = u.telegram_id AND c.affiliate_id = $1) AS comissao_gerada
                     FROM usuarios u
                     WHERE u.origem = 'samuel'
                     ORDER BY u.data_cadastro DESC
                     LIMIT 15`,
                    [affId]
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
                    relatorioAfiliado += '<i>Nenhum usuário indicado até o momento.</i>';
                } else {
                    listaIndicadosRes.rows.forEach((row) => {
                        const assinouStr = Number.parseInt(row.aprovados, 10) > 0 ? 'Sim' : 'Não';
                        relatorioAfiliado +=
                            `• @${escapeHtml(row.username || 'N/A')} (<code>${row.telegram_id}</code>) | ` +
                            `Assinou: <b>${assinouStr}</b> | Aprovados: ${row.aprovados} | ` +
                            `Comissão: R$ ${Number.parseFloat(row.comissao_gerada).toFixed(2)}\n`;
                    });
                }

                return bot.sendMessage(chatId, relatorioAfiliado, { parse_mode: 'HTML' });
            } catch (e) {
                console.error('Erro no /afiliado:', e);
                return bot.sendMessage(chatId, '❌ Erro ao consultar o relatório de afiliados.');
            }
        }

        // --- COMANDO /COMISSOES (ADMIN) ---
        if (text === '/comissoes') {
            if (!isOwner(userId)) {
                return bot.sendMessage(chatId, '❌ Apenas o administrador pode utilizar este comando.');
            }

            try {
                const afRes = await pool.query("SELECT id FROM afiliados WHERE codigo = 'samuel'");
                if (afRes.rowCount === 0) {
                    return bot.sendMessage(chatId, '⚠️ Afiliado Samuel não encontrado.');
                }
                const affId = afRes.rows[0].id;

                const comissoesRes = await pool.query(
                    `SELECT c.id, c.telegram_id, c.valor_comissao, c.status, c.created_at, u.username
                     FROM comissoes_afiliados c
                     LEFT JOIN usuarios u ON c.telegram_id = u.telegram_id
                     WHERE c.affiliate_id = $1
                     ORDER BY c.created_at DESC
                     LIMIT 20`,
                    [affId]
                );

                const totaisRes = await pool.query(
                    `SELECT
                        COALESCE(SUM(CASE WHEN status = 'PENDENTE' THEN valor_comissao ELSE 0 END), 0) AS pendente,
                        COALESCE(SUM(CASE WHEN status = 'PAGO' THEN valor_comissao ELSE 0 END), 0) AS pago
                     FROM comissoes_afiliados WHERE affiliate_id = $1`,
                    [affId]
                );

                const tPendente = Number.parseFloat(totaisRes.rows[0].pendente);
                const tPago = Number.parseFloat(totaisRes.rows[0].pago);

                let respComissoes =
                    `💰 <b>COMISSÕES DE AFILIADOS — SAMUEL</b>\n\n` +
                    `• Total Pendente: <b>R$ ${tPendente.toFixed(2)}</b>\n` +
                    `• Total Pago: <b>R$ ${tPago.toFixed(2)}</b>\n\n` +
                    `📋 <b>Últimas Comissões:</b>\n`;

                if (comissoesRes.rowCount === 0) {
                    respComissoes += '<i>Nenhuma comissão registrada.</i>';
                } else {
                    comissoesRes.rows.forEach((c) => {
                        const dataF = new Date(c.created_at).toLocaleString('pt-BR');
                        const statusEmoji = c.status === 'PAGO' ? '✅' : '⏳';
                        respComissoes +=
                            `• ID: <code>${c.id}</code> | ${statusEmoji} ` +
                            `<b>R$ ${Number.parseFloat(c.valor_comissao).toFixed(2)}</b> (${escapeHtml(c.status)}) | ` +
                            `User: @${escapeHtml(c.username || 'N/A')} (<code>${c.telegram_id}</code>) | Data: ${dataF}\n`;
                    });
                }

                return bot.sendMessage(chatId, respComissoes, { parse_mode: 'HTML' });
            } catch (e) {
                console.error('Erro no /comissoes:', e);
                return bot.sendMessage(chatId, '❌ Erro ao consultar comissões.');
            }
        }

        // --- COMANDO /PAGARCOMISSAO ID (ADMIN) ---
        if (text === '/pagarcomissao' || text.startsWith('/pagarcomissao ')) {
            if (!isOwner(userId)) {
                return bot.sendMessage(chatId, '❌ Apenas o administrador pode utilizar este comando.');
            }

            const match = text.match(/^\/pagarcomissao\s+(\d+)$/);
            if (!match || !/^[1-9]\d*$/.test(match[1])) {
                return bot.sendMessage(chatId, '⚠️ Use o formato correto: /pagarcomissao [ID inteiro positivo]');
            }

            const comissaoId = Number(match[1]);
            if (!Number.isSafeInteger(comissaoId) || comissaoId <= 0) {
                return bot.sendMessage(chatId, '⚠️ ID de comissão inválido.');
            }

            const client = await pool.connect();
            let transactionOpen = false;
            let valorComissao = 0;
            let jaEstavaPaga = false;

            try {
                await client.query('BEGIN');
                transactionOpen = true;

                const checkC = await client.query(
                    'SELECT id, valor_comissao, status FROM comissoes_afiliados WHERE id = $1 FOR UPDATE',
                    [comissaoId]
                );

                if (checkC.rowCount === 0) {
                    await client.query('ROLLBACK');
                    transactionOpen = false;
                    return bot.sendMessage(chatId, `❌ Comissão com ID ${comissaoId} não foi encontrada.`);
                }

                const comissao = checkC.rows[0];
                valorComissao = Number.parseFloat(comissao.valor_comissao);

                if (comissao.status === 'PAGO') {
                    jaEstavaPaga = true;
                    await client.query('ROLLBACK');
                    transactionOpen = false;
                } else if (comissao.status !== 'PENDENTE') {
                    await client.query('ROLLBACK');
                    transactionOpen = false;
                    return bot.sendMessage(
                        chatId,
                        `⚠️ Esta comissão (ID ${comissaoId}) possui status inválido: ${escapeHtml(comissao.status)}.`
                    );
                } else {
                    const updateRes = await client.query(
                        "UPDATE comissoes_afiliados SET status = 'PAGO', paid_at = NOW() WHERE id = $1 AND status = 'PENDENTE'",
                        [comissaoId]
                    );

                    if (updateRes.rowCount !== 1) {
                        throw new Error('A comissão não pôde ser atualizada de PENDENTE para PAGO.');
                    }

                    await client.query('COMMIT');
                    transactionOpen = false;
                }
            } catch (e) {
                if (transactionOpen) {
                    try { await client.query('ROLLBACK'); } catch (rollbackError) {
                        console.error('Erro ao desfazer transação de comissão:', rollbackError);
                    }
                }
                console.error('Erro no /pagarcomissao (DB):', e);
                return bot.sendMessage(chatId, '❌ Erro ao atualizar o status da comissão no banco de dados.');
            } finally {
                client.release();
            }            if (jaEstavaPaga) {
                return bot.sendMessage(
                    chatId,
                    `ℹ️ A comissão de ID <code>${comissaoId}</code> já estava marcada como <b>PAGO</b>. Nenhuma alteração foi feita.`,
                    { parse_mode: 'HTML' }
                );
            }

            return bot.sendMessage(
                chatId,
                `✅ <b>Comissão atualizada com sucesso!</b>\nO registro de ID <code>${comissaoId}</code>, no valor de R$ ${valorComissao.toFixed(2)}, foi marcado como <b>PAGO</b>.`,
                { parse_mode: 'HTML' }
            );
        }

        // --- COMANDO /ASSINANTES (ADMIN) ---
        if (text === '/assinantes') {
            if (!isOwner(userId)) {
                return bot.sendMessage(chatId, '❌ Apenas o administrador pode utilizar este comando.');
            }

            try {
                await pool.query(
                    "UPDATE usuarios SET plano = 'FREE', vip_expiracao = NULL WHERE plano = 'VIP' AND vip_expiracao IS NOT NULL AND vip_expiracao < NOW()"
                );

                const countVipRes = await pool.query(
                    "SELECT COUNT(*) AS total FROM usuarios WHERE plano = 'VIP' AND (vip_expiracao IS NULL OR vip_expiracao >= NOW())"
                );
                const countFreeRes = await pool.query(
                    "SELECT COUNT(*) AS total FROM usuarios WHERE plano = 'FREE' OR (plano = 'VIP' AND vip_expiracao < NOW())"
                );
                const countTotalRes = await pool.query('SELECT COUNT(*) AS total FROM usuarios');

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
                console.error('Erro no /assinantes:', e);
                return bot.sendMessage(chatId, '❌ Erro ao consultar o relatório de assinantes.');
            }
        }

        // --- COMANDO /PAGAMENTOS (ADMIN) ---
        if (text === '/pagamentos') {
            if (!isOwner(userId)) {
                return bot.sendMessage(chatId, '❌ Apenas o administrador pode utilizar este comando.');
            }

            try {
                const res = await pool.query(
                    "SELECT * FROM pagamento_solicitacoes WHERE status = 'PENDING' ORDER BY created_at ASC"
                );
                if (res.rowCount === 0) {
                    return bot.sendMessage(chatId, '📭 Não há solicitações de pagamento pendentes no momento.');
                }

                let textResp = '📋 <b>Solicitações Pendentes:</b>\n\n';
                res.rows.forEach((r) => {
                    const dataF = new Date(r.created_at).toLocaleString('pt-BR');
                    textResp +=
                        `• ID: <code>${r.id}</code> | User: ${escapeHtml(r.username || 'N/A')} ` +
                        `(<code>${r.telegram_id}</code>) | Data: ${dataF}\n`;
                });
                return bot.sendMessage(chatId, textResp, { parse_mode: 'HTML' });
            } catch (err) {
                console.error('Erro em /pagamentos:', err);
                return bot.sendMessage(chatId, '❌ Erro ao consultar pagamentos pendentes.');
            }
        }

        // --- COMANDO /CLEAN ---
        if (text === '/clean') {
            try {
                await pool.query('DELETE FROM transacoes WHERE user_id = $1', [userId]);
                return bot.sendMessage(
                    chatId,
                    '🗑️ <b>Histórico limpo!</b> Todos os seus registros foram apagados com sucesso.',
                    { parse_mode: 'HTML' }
                );
            } catch (e) {
                console.error('Erro no /clean:', e);
                return bot.sendMessage(chatId, '❌ Erro ao limpar histórico.');
            }
        }

        // --- COMANDO /CLS (COM CONFIRMAÇÃO SEGURA) ---
        if (text === '/cls') {
            if (!isOwner(userId)) {
                return bot.sendMessage(chatId, '❌ Apenas o dono pode utilizar este comando.');
            }

            const confirmKey = `cls_${userId}_${Date.now()}`;
            clsConfirmations.set(userId, {
                key: confirmKey,
                expires: Date.now() + 300000
            });

            const confirmKeyboard = {
                reply_markup: {
                    inline_keyboard: [[
                        { text: '⚠️ Sim, apagar TUDO', callback_data: `confirm_cls_${confirmKey}` },
                        { text: '❌ Cancelar', callback_data: `cancel_cls_${confirmKey}` }
                    ]]
                }
            };

            return bot.sendMessage(
                chatId,
                '⚠️ <b>ATENÇÃO:</b> Você solicitou a limpeza total do banco de dados (usuários, transações, solicitações de pagamento e comissões). Esta ação é irreversível!\n\nDeseja realmente prosseguir?',
                { parse_mode: 'HTML', ...confirmKeyboard }
            );
        }

        // --- /ADDVIP ---
        if (text === '/addvip') {
            if (!isOwner(userId)) {
                return bot.sendMessage(chatId, '❌ Apenas o dono pode gerenciar assinaturas.');
            }

            estados[userId] = { acao: 'pedir_id_vip' };
            return bot.sendMessage(
                chatId,
                '👤 <b>Adicionar Imperium Plus</b>\n\nEnvie o <b>ID numérico do usuário</b> que você deseja promover (renovação acumulativa):',
                { parse_mode: 'HTML', ...tecladoVoltar }
            );
        }

        // --- COMANDO START / VOLTAR ---
        if (isStartCommand(text) || text === '⬅️ Voltar') {
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

            if (isStartCommand(text)) {
                try {
                    if (fs.existsSync('./imperium_cash.jpg')) {
                        return await bot.sendPhoto(chatId, './imperium_cash.jpg', {
                            caption: msgStart,
                            parse_mode: 'HTML',
                            ...menuPrincipal
                        });
                    }
                } catch (error) {
                    console.error('Erro ao enviar imagem inicial:', error.message);
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
                const res = await pool.query(
                    'SELECT plano, vip_expiracao FROM usuarios WHERE telegram_id = $1',
                    [userId]
                );
                const count = await pool.query(
                    'SELECT COUNT(*) AS total FROM transacoes WHERE user_id = $1',
                    [userId]
                );

                const user = res.rows[0];
                let exp = '';
                let nomePlano = 'Básico (Free)';

                if (user?.plano === 'VIP' && (!user.vip_expiracao || new Date(user.vip_expiracao) > new Date())) {
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

                return bot.sendMessage(chatId, mensagem, { parse_mode: 'HTML', ...menuPrincipal });
            } catch (error) {
                console.error('❌ Erro em Minha Conta:', error);
                return bot.sendMessage(chatId, '❌ Não foi possível carregar os dados da sua conta.', menuPrincipal);
            }
        }

        // --- FUNÇÃO DE MONTAGEM DA MENSAGEM DE ASSINATURA ---
        async function enviarTelaAssinatura() {
            const pixKey = process.env.PIX_KEY || 'Chave Pix não configurada';
            const receiverName = process.env.PIX_RECEIVER_NAME || 'Administrador';
            const description = process.env.PIX_PAYMENT_DESCRIPTION || 'Assinatura Imperium Plus';
            const pixPaymentUrl = getPixPaymentUrl();
            const statusVip = await verificarAcesso(userId);

            const pendRes = await pool.query(
                "SELECT id FROM pagamento_solicitacoes WHERE telegram_id = $1 AND status = 'PENDING'",
                [userId]
            );
            if (pendRes.rowCount > 0) {
                return bot.sendMessage(
                    chatId,
                    '⏳ Você já possui uma solicitação pendente aguardando análise administrativa.',
                    menuPrincipal
                );
            }

            let infoVipAtivo = '';
            if (statusVip.plano === 'VIP') {
                infoVipAtivo = '\nℹ️ <b>Nota:</b> Você já possui assinatura ativa. Um novo pagamento estenderá seu VIP por mais 30 dias!\n';
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

            return bot.sendMessage(chatId, plusText, {
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: inlineRows }
            });
        }

        // --- ASSINAR IMPERIUM PLUS ---
        if (text === '💎 Assinar Imperium Plus') {
            return enviarTelaAssinatura();
        }

        // --- EDITAR LANÇAMENTO ---
        if (text === '✏️ Editar lançamento') {
            try {
                const res = await pool.query(
                    'SELECT * FROM transacoes WHERE user_id = $1 ORDER BY data DESC LIMIT 10',
                    [userId]
                );
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

                estados[userId] = { acao: 'edit_select_tx', txList: userTxList };
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
                    return bot.sendMessage(chatId, check.msg || '⚠️ Não foi possível verificar seu plano.', { parse_mode: 'HTML' });
                }

                if (check.plano !== 'VIP') {
                    const countRes = await pool.query(
                        'SELECT COUNT(*) AS total FROM transacoes WHERE user_id = $1',
                        [userId]
                    );
                    const totalLancamentos = Number.parseInt(countRes.rows[0].total, 10);

                    if (totalLancamentos >= 15) {
                        const msgLimite =
                            `🚀 <b>Você atingiu o limite do plano gratuito!</b>\n` +
                            `Você já utilizou seus 15 lançamentos gratuitos.\n` +
                            `Com o <b>Imperium Plus</b>, você tem lançamentos ilimitados e pode continuar organizando suas finanças sem restrições.\n` +                            `💎 Assine o Imperium Plus para continuar!`;

                        const keyboardAssinar = {
                            reply_markup: {
                                inline_keyboard: [[
                                    { text: '💎 Assinar Imperium Plus', callback_data: 'clique_assinar_plus' }
                                ]]
                            }
                        };
                        return bot.sendMessage(chatId, msgLimite, { parse_mode: 'HTML', ...keyboardAssinar });
                    }
                }

                let tipo = 'saida';
                let conversa = 'Qual o valor que você gastou? (Ex: 50,00)';

                if (text === '💰 Ganhei') {
                    tipo = 'entrada';
                    conversa = 'Que ótimo! Qual foi o valor que você recebeu? (Ex: 150,50)';
                } else if (text === '📈 Investi') {
                    tipo = 'investimento';
                    conversa = '📈 Hora de multiplicar! Quanto você investiu hoje? (Ex: 100,00)';
                }

                estados[userId] = { acao: 'pedir_valor', tipo };
                return bot.sendMessage(chatId, conversa, tecladoVoltar);
            }

            if (text === '📊 Análise') return enviarGraficoCompleto(chatId, userId);
            if (text === '📄 Histórico') return enviarRelatorio(chatId, userId);

            return bot.sendMessage(chatId, '🤖 Use o menu abaixo:', menuPrincipal);
        }

        // --- PEDIR ID VIP (/ADDVIP) ---
        if (estado.acao === 'pedir_id_vip') {
            const idPromover = text.trim();
            if (!isOwner(userId)) {
                delete estados[userId];
                return bot.sendMessage(chatId, '❌ Apenas o dono pode gerenciar assinaturas.', menuPrincipal);
            }
            if (!isValidTelegramId(idPromover)) {
                return bot.sendMessage(
                    chatId,
                    "⚠️ O ID deve ser um número inteiro positivo válido do Telegram. Tente novamente ou use '⬅️ Voltar':",
                    tecladoVoltar
                );
            }

            try {
                const updateRes = await pool.query(
                    `UPDATE usuarios
                     SET plano = 'VIP',
                         vip_expiracao = GREATEST(COALESCE(vip_expiracao, NOW()), NOW()) + INTERVAL '30 days'
                     WHERE telegram_id = $1`,
                    [idPromover]
                );

                if (updateRes.rowCount !== 1) {
                    return bot.sendMessage(
                        chatId,
                        '⚠️ Esse ID não está cadastrado no bot. Peça para a pessoa iniciar uma conversa com o bot usando /start e tente novamente.',
                        tecladoVoltar
                    );
                }

                delete estados[userId];
                return bot.sendMessage(
                    chatId,
                    `⭐ Sucesso! O usuário de ID <code>${idPromover}</code> agora possui o Imperium Plus por mais 30 dias (renovação acumulada)!`,
                    { parse_mode: 'HTML', ...menuPrincipal }
                );
            } catch (e) {
                console.error('Erro ao promover usuário:', e);
                return bot.sendMessage(chatId, '❌ Erro ao promover usuário no banco de dados.', menuPrincipal);
            }
        }

        // --- PEDIR VALOR ---
        if (estado.acao === 'pedir_valor') {
            const v = parseValor(text);
            if (!Number.isFinite(v) || v <= 0) {
                return bot.sendMessage(
                    chatId,
                    '⚠️ Valor inválido. Use um valor positivo, por exemplo: 50,00, 50.00 ou 1.500,50.',
                    tecladoVoltar
                );
            }

            estado.valor = v;
            estado.acao = 'pedir_desc';

            let msgDesc = '';
            if (estado.tipo === 'entrada') {
                msgDesc = 'De onde veio esse dinheiro? (Ex: Salário, Venda de bolo, Pix do João)';
            } else if (estado.tipo === 'saida') {
                msgDesc = 'Com o que você gastou? (Ex: Mercado, Conta de Luz, Lanche)';
            } else if (estado.tipo === 'investimento') {
                msgDesc = 'Onde você aplicou esse valor? (Ex: Tesouro Direto, CDB Banco, Bitcoin)';
            }

            return bot.sendMessage(chatId, msgDesc, tecladoVoltar);
        }

        // --- PEDIR DESCRIÇÃO E SALVAR ---
        if (estado.acao === 'pedir_desc') {
            const descricaoOriginal = text.trim();
            if (!descricaoOriginal) {
                return bot.sendMessage(chatId, '⚠️ A descrição não pode ficar vazia. Informe uma descrição:', tecladoVoltar);
            }

            await pool.query(
                'INSERT INTO transacoes (user_id, tipo, valor, descricao) VALUES ($1, $2, $3, $4)',
                [userId, estado.tipo, estado.valor, descricaoOriginal]
            );

            const contagemQuery = await pool.query(
                'SELECT COUNT(*) AS total FROM transacoes WHERE user_id = $1',
                [userId]
            );
            const totalRegistros = Number.parseInt(contagemQuery.rows[0].total, 10);

            let emojiFinal = '🔴';
            if (estado.tipo === 'entrada') emojiFinal = '🟢';
            if (estado.tipo === 'investimento') emojiFinal = '📈';

            delete estados[userId];
            return bot.sendMessage(
                chatId,
                `${emojiFinal} Tudo certo! Registro de <b>R$ ${estado.valor.toFixed(2)}</b> salvo com sucesso.\n\n` +
                `🟢 +1 registro adicionado\n` +
                `Você está no controle.\n` +
                `📊 Progresso financeiro: ${totalRegistros} registros feitos.`,
                { parse_mode: 'HTML', ...menuPrincipal }
            );
        }

        // --- MÁQUINA DE ESTADOS DA EDIÇÃO ---
        if (estado.acao === 'edit_select_tx') {
            if (!/^\d+$/.test(text.trim())) {
                return bot.sendMessage(chatId, '⚠️ Envie somente o número correspondente ao lançamento:', tecladoVoltar);
            }
            const index = Number(text.trim()) - 1;
            if (!Number.isInteger(index) || index < 0 || !estado.txList[index]) {
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
            estado.fieldToEdit = field === 'descricao' ? 'descrição' : field;
            estado.acao = 'edit_get_new_value';
            const exemploData = estado.fieldToEdit === 'data' ? ' (DD/MM/AAAA ou AAAA-MM-DD)' : '';
            return bot.sendMessage(chatId, `Informe o novo valor para ${estado.fieldToEdit}${exemploData}:`, tecladoVoltar);
        }

        if (estado.acao === 'edit_get_new_value') {
            if (!text.trim()) {
                return bot.sendMessage(chatId, '⚠️ O novo valor não pode ficar vazio. Informe novamente:', tecladoVoltar);
            }
            estado.newValue = text.trim();
            estado.acao = 'edit_confirm';

            let oldVal = `R$ ${Number(estado.selectedTx.valor).toFixed(2)}`;
            if (estado.fieldToEdit === 'descrição') oldVal = estado.selectedTx.descricao;
            if (estado.fieldToEdit === 'tipo') oldVal = estado.selectedTx.tipo;
            if (estado.fieldToEdit === 'data') oldVal = new Date(estado.selectedTx.data).toLocaleDateString('pt-BR');

            return bot.sendMessage(
                chatId,
                `Confirma a alteração de "${escapeHtml(oldVal)}" para "${escapeHtml(estado.newValue)}"? Responda 'sim' ou 'não'.`,
                { parse_mode: 'HTML', ...tecladoVoltar }
            );
        }

        if (estado.acao === 'edit_confirm') {
            if (text.toLowerCase().trim() === 'sim' || text.toLowerCase().trim() === 's') {
                try {
                    let queryField = 'descricao';
                    let valToSave = estado.newValue;

                    if (estado.fieldToEdit === 'valor') {
                        queryField = 'valor';
                        valToSave = parseValor(estado.newValue);
                        if (!Number.isFinite(valToSave) || valToSave <= 0) {
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
                        valToSave = parseDataUsuario(estado.newValue);
                        if (!valToSave) {
                            delete estados[userId];
                            return bot.sendMessage(chatId, '⚠️ Data inválida. Use DD/MM/AAAA ou AAAA-MM-DD. Edição cancelada.', menuPrincipal);
                        }
                    }

                    const updateRes = await pool.query(
                        `UPDATE transacoes SET ${queryField} = $1 WHERE id = $2 AND user_id = $3`,
                        [valToSave, estado.selectedTx.id, userId]
                    );

                    delete estados[userId];
                    if (updateRes.rowCount !== 1) {
                        return bot.sendMessage(chatId, '⚠️ O lançamento não foi encontrado para atualização. Atualize seu histórico e tente novamente.', menuPrincipal);
                    }
                    return bot.sendMessage(chatId, '✅ Lançamento atualizado com sucesso!', menuPrincipal);
                } catch (err) {
                    console.error('Erro ao atualizar transação:', err);
                    delete estados[userId];
                    return bot.sendMessage(chatId, '❌ Erro ao atualizar o registro no banco.', menuPrincipal);
                }
            }

            delete estados[userId];
            return bot.sendMessage(chatId, '❌ Edição cancelada.', menuPrincipal);
        }

        // Recuperação de estado desconhecido/inconsistente.
        delete estados[userId];
        return bot.sendMessage(chatId, '⚠️ A operação anterior foi encerrada porque seu estado não era válido. Use o menu para começar novamente.', menuPrincipal);
    } catch (error) {
        console.error('❌ Erro ao processar mensagem:', error);
        try {
            await bot.sendMessage(
                msg.chat.id,
                '❌ Ocorreu um erro ao processar sua solicitação. Tente novamente.',
                menuPrincipal
            );
        } catch (sendError) {
            console.error('❌ Erro ao enviar mensagem de erro:', sendError);
        }
    }
});

// --- CALLBACK QUERIES ---
bot.on('callback_query', async (callbackQuery) => {
    const msg = callbackQuery.message;
    const data = String(callbackQuery.data || '');
    const userId = callbackQuery.from.id;
    const chatId = msg?.chat?.id;

    try {
        if (!msg || !chatId || msg.chat.type !== 'private') {
            return bot.answerCallbackQuery(callbackQuery.id, {
                text: 'Esta ação só pode ser utilizada no chat privado.',
                show_alert: true
            });
        }

        // --- CONFIRMAÇÃO DO /CLS ---
        if (data.startsWith('confirm_cls_') || data.startsWith('cancel_cls_')) {
            if (!isOwner(userId)) {
                return bot.answerCallbackQuery(callbackQuery.id, { text: 'Acesso negado.', show_alert: true });
            }

            const action = data.startsWith('confirm_cls_') ? 'confirm' : 'cancel';
            const confirmKey = data.substring(action === 'confirm' ? 'confirm_cls_'.length : 'cancel_cls_'.length);
            const stored = clsConfirmations.get(userId);

            if (!stored || stored.key !== confirmKey || Date.now() > stored.expires) {
                clsConfirmations.delete(userId);
                await bot.answerCallbackQuery(callbackQuery.id, {
                    text: 'Esta solicitação de limpeza expirou.',
                    show_alert: true
                });
                return bot.deleteMessage(chatId, msg.message_id).catch(() => {});
            }

            clsConfirmations.delete(userId);

            if (action === 'cancel') {
                await bot.answerCallbackQuery(callbackQuery.id, { text: 'Operação cancelada.' });
                return bot.editMessageText(
                    '❌ Limpeza do banco de dados cancelada com sucesso.',
                    { chat_id: chatId, message_id: msg.message_id }
                );
            }

            await pool.query(
                'TRUNCATE TABLE transacoes, usuarios, pagamento_solicitacoes, comissoes_afiliados RESTART IDENTITY CASCADE'
            );
            for (const key of Object.keys(estados)) delete estados[key];
            awaitingReceipt.clear();
            clsConfirmations.clear();
            await bot.answerCallbackQuery(callbackQuery.id, { text: 'Banco zerado!' });
            return bot.editMessageText(
                '⚠️ <b>BANCO DE DADOS TOTALMENTE ZERADO!</b>\nTodos os dados de usuários, transações, pagamentos e comissões foram apagados permanentemente. O cadastro do afiliado foi preservado.',
                { chat_id: chatId, message_id: msg.message_id, parse_mode: 'HTML' }
            );
        }

        if (data === 'clique_assinar_plus') {
            await bot.answerCallbackQuery(callbackQuery.id);

            const pixKey = process.env.PIX_KEY || 'Chave Pix não configurada';
            const receiverName = process.env.PIX_RECEIVER_NAME || 'Administrador';
            const description = process.env.PIX_PAYMENT_DESCRIPTION || 'Assinatura Imperium Plus';
            const pixPaymentUrl = getPixPaymentUrl();
            const statusVip = await verificarAcesso(userId);

            const pendRes = await pool.query(
                "SELECT id FROM pagamento_solicitacoes WHERE telegram_id = $1 AND status = 'PENDING'",
                [userId]             RETURNING id`,
            [chatId, usernameOriginal, fileId, fileType]
        );

        reqId = res.rows[0].id;
        await client.query('COMMIT');
        transactionOpen = false;
        dbCommitted = true;
        awaitingReceipt.delete(user.id);
    } catch (err) {
        if (transactionOpen && client) {
            try { await client.query('ROLLBACK'); } catch (rollbackError) {
                console.error('Erro ao desfazer registro de comprovante:', rollbackError);
            }
        }
        console.error('Erro ao registrar solicitação de pagamento no banco:', err);
        // Mantém o estado de espera para o usuário poder tentar novamente.
        awaitingReceipt.add(user.id);
        await bot.sendMessage(
            chatId,
            '❌ Não foi possível registrar seu comprovante agora. O envio continua aguardando: tente enviar a foto ou o PDF novamente em instantes.',
            menuPrincipal
        );
        return false;
    } finally {
        if (client) client.release();
    }

    if (dbCommitted) {
        // Confirmação ao usuário não interfere na gravação já confirmada no banco.
        try {
            await bot.sendMessage(
                chatId,
                '✅ <b>Comprovante recebido!</b>\n\nSua solicitação foi enviada para análise administrativa. Você será avisado em breve.',
                { parse_mode: 'HTML', ...menuPrincipal }
            );
        } catch (userNotifyErr) {
            console.error('Erro ao enviar confirmação ao usuário após o commit:', userNotifyErr);
        }

        // Notificação ao administrador é independente da confirmação ao usuário.
        try {
            if (OWNER_ID && reqId) {
                const dataHoraEnvio = new Date().toLocaleString('pt-BR');
                const captionAdmin =
                    `💰 <b>NOVA SOLICITAÇÃO DE ASSINATURA</b>\n\n` +
                    `• <b>Nome do cliente:</b> ${escapeHtml(nomeClienteOriginal)}\n` +
                    `• <b>Username:</b> ${escapeHtml(usernameOriginal)}\n` +
                    `• <b>ID do cliente:</b> <code>${chatId}</code>\n` +
                    `• <b>Plano:</b> Imperium Plus\n` +
                    `• <b>Valor esperado:</b> R$ 5,00\n` +
                    `• <b>ID da solicitação:</b> <code>${reqId}</code>\n` +
                    `• <b>Data/Hora:</b> ${dataHoraEnvio}`;

                const keyboardAdmin = {
                    reply_markup: {
                        inline_keyboard: [[
                            { text: '✅ Aprovar pagamento', callback_data: `aprovar_pag_${reqId}` },
                            { text: '❌ Rejeitar pagamento', callback_data: `rejeitar_pag_${reqId}` }
                        ]]
                    }
                };

                if (fileType === 'photo') {
                    await bot.sendPhoto(OWNER_ID, fileId, {
                        caption: captionAdmin,
                        parse_mode: 'HTML',
                        ...keyboardAdmin
                    });
                } else {
                    await bot.sendDocument(OWNER_ID, fileId, {
                        caption: captionAdmin,
                        parse_mode: 'HTML',
                        ...keyboardAdmin
                    });
                }
            }
        } catch (adminNotifyErr) {
            console.error('Erro ao enviar notificação para o administrador:', adminNotifyErr);
            // A solicitação continua PENDING; o administrador pode consultá-la com /pagamentos.
        }
    }

    return true;
}

// --- GRÁFICO / ANÁLISE ---
async function enviarGraficoCompleto(chatId, userId) {
    try {
        const res = await pool.query(
            'SELECT tipo, SUM(valor) AS total FROM transacoes WHERE user_id = $1 GROUP BY tipo',
            [userId]
        );

        if (res.rowCount === 0) {
            return bot.sendMessage(chatId, 'Sem dados suficientes para gerar uma análise.', menuPrincipal);
        }

        let gn = 0;
        let gs = 0;
        let inv = 0;

        res.rows.forEach((r) => {
            if (r.tipo === 'entrada') gn = Number.parseFloat(r.total);
            else if (r.tipo === 'saida') gs = Number.parseFloat(r.total);
            else if (r.tipo === 'investimento') inv = Number.parseFloat(r.total);
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
        console.error('❌ Erro na análise:', error);
        return bot.sendMessage(chatId, '❌ Não foi possível gerar a análise financeira.', menuPrincipal);
    }
}

// --- HISTÓRICO ---
async function enviarRelatorio(chatId, userId) {
    try {
        const res = await pool.query(
            'SELECT * FROM transacoes WHERE user_id = $1 ORDER BY data DESC LIMIT 15',
            [userId]
        );

        if (res.rowCount === 0) {
            return bot.sendMessage(chatId, 'Seu histórico está vazio no momento.', menuPrincipal);
        }

        let m = '📋 <b>SEUS ÚLTIMOS LANÇAMENTOS:</b>\n━━━━━━━━━━━━━━━━━━━━━━\n';
        res.rows.forEach((t) => {
            let icone = '🔴';
            if (t.tipo === 'entrada') icone = '🟢';
            if (t.tipo === 'investimento') icone = '📈';

            const d = new Date(t.data);
            const dataFormatada = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
            m += `${icone} <b>R$ ${Number.parseFloat(t.valor).toFixed(2)}</b> - ${escapeHtml(t.descricao)} <i>(${dataFormatada})</i>\n`;
        });

        m += '━━━━━━━━━━━━━━━━━━━━━━\n<i>Seu histórico financeiro está organizado aqui.</i>';
        return bot.sendMessage(chatId, m, { parse_mode: 'HTML', ...menuPrincipal });
    } catch (error) {
        console.error('❌ Erro no histórico:', error);
        return bot.sendMessage(chatId, '❌ Não foi possível carregar seu histórico.', menuPrincipal);
    }
}

// --- SERVIDOR WEB EXPRESS ---
const app = express();
app.get('/', (req, res) => {
    res.status(200).send('Bot Online - Gestão Premium Ativa');
});

const PORT = Number(process.env.PORT) || 3000;

// --- INICIALIZAÇÃO: BANCO PRIMEIRO, DEPOIS BOT E SERVIDOR ---
async function startApplication() {
    try {
        await setupDB();

        await bot.startPolling();
        console.log('🚀 Telegram Bot polling iniciado com sucesso.');

        app.listen(PORT, '0.0.0.0', () => {
            console.log(`🌐 Servidor online na porta ${PORT}`);
        });
    } catch (error) {
        console.error('❌ Falha ao iniciar a aplicação:', error);
        process.exit(1);
    }
}

startApplication();

// --- PROTEÇÃO CONTRA EXCEÇÕES GLOBAIS ---
process.on('unhandledRejection', (reason) => {
    console.error('❌ Unhandled Rejection:', reason);
});

process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error);
    // Estado do processo pode estar inconsistente; encerra para o supervisor reiniciar com segurança.
    process.exit(1);
});

// --- ENCERRAMENTO CONTROLADO ---
async function gracefulShutdown(signal) {
    console.log(`⏹️ Recebido ${signal}. Encerrando aplicação...`);
    try {
        await bot.stopPolling();
    } catch (error) {
        console.error('Erro ao parar polling:', error.message);
    }
    try {
        await pool.end();
    } catch (error) {
        console.error('Erro ao encerrar pool PostgreSQL:', error.message);
    }
    process.exit(0);
}

process.once('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.once('SIGINT', () => gracefulShutdown('SIGINT'));