require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const QuickChart = require('quickchart-js');
const { Pool } = require('pg');
const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');

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

// Inicializa o bot com polling: false para iniciar somente após o setupDB
const bot = new TelegramBot(token, { polling: false });

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

            ALTER TABLE pagamento_solicitacoes
            ADD COLUMN IF NOT EXISTS telegram_file_id TEXT;

            ALTER TABLE pagamento_solicitacoes
            ADD COLUMN IF NOT EXISTS file_type TEXT;

            ALTER TABLE pagamento_solicitacoes
            ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMP;

            ALTER TABLE pagamento_solicitacoes
            ADD COLUMN IF NOT EXISTS reviewed_by BIGINT;

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

        // Migração de comissões antigas com status PENDING para PENDENTE
        await pool.query(`
            UPDATE comissoes_afiliados 
            SET status = 'PENDENTE' 
            WHERE status = 'PENDING';
        `);

        // Cadastra ou atualiza o afiliado samuel
        await pool.query(`
            INSERT INTO afiliados (codigo, nome, percentual_comissao, ativo)
            VALUES ('samuel', 'Samuel', 20.00, TRUE)
            ON CONFLICT (codigo) DO UPDATE SET nome = 'Samuel';
        `);

        console.log("✅ Banco conectado com sucesso: Tabelas e colunas verificadas e prontas.");
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
            ['📊 Análise', '📄 Histórico', '📊 Exportar Excel'],
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

// --- CONVERTER VALOR COM CORREÇÃO ROBUSTA (parseValor) ---
function parseValor(texto) {
    if (!texto) return NaN;
    let limpo = String(texto)
        .toLowerCase()
        .replace('r$', '')
        .replace(/\s/g, '')
        .trim();

    if (!limpo) return NaN;

    let isK = false;
    if (limpo.endsWith('k')) {
        isK = true;
        limpo = limpo.slice(0, -1).trim();
    }

    if (!/^[0-9.,]+$/.test(limpo)) {
        return NaN;
    }

    let limpoNum = '';
    if (limpo.includes(',')) {
        if ((limpo.match(/,/g) || []).length > 1) return NaN;
        limpoNum = limpo.replace(/\./g, '').replace(',', '.');
    } else {
        let dotCount = (limpo.match(/\./g) || []).length;
        if (dotCount > 1) {
            limpoNum = limpo.replace(/\./g, '');
        } else if (dotCount === 1) {
            let parts = limpo.split('.');
            if (isK) {
                limpoNum = limpo;
            } else if (parts[1].length === 3 && parts[0].length <= 3) {
                limpoNum = limpo.replace(/\./g, '');
            } else {
                limpoNum = limpo;
            }
        } else {
            limpoNum = limpo;
        }
    }

    let val = parseFloat(limpoNum);
    if (!Number.isFinite(val)) return NaN;

    if (isK) {
        val = val * 1000;
    }

    if (val <= 0) {
        return NaN;
    }
    return val;
}

// --- VALIDAÇÃO DE DOCUMENTO DE COMPROVANTE ---
function validarDocumentoComprovante(document) {
    if (!document) return { valido: false, tipoInterno: null };

    const mimeType = String(document.mime_type || '').toLowerCase().trim();
    const fileName = String(document.file_name || '').toLowerCase().trim();
    const ext = path.extname(fileName);

    if (mimeType === 'application/pdf') {
        if (ext && ext !== '.pdf') {
            return { valido: false, tipoInterno: null };
        }
        return { valido: true, tipoInterno: 'document' };
    }

    const allowedImageMimes = {
        'image/jpeg': ['.jpg', '.jpeg'],
        'image/jpg': ['.jpg', '.jpeg'],
        'image/png': ['.png'],
        'image/webp': ['.webp']
    };

    if (allowedImageMimes[mimeType]) {
        const validExts = allowedImageMimes[mimeType];
        if (ext && !validExts.includes(ext)) {
            return { valido: false, tipoInterno: null };
        }
        return { valido: true, tipoInterno: 'document' };
    }

    return { valido: false, tipoInterno: null };
}

const MSG_FORMATO_INVALIDO_COMPROVANTE =
    `⚠️ <b>Formato de comprovante não aceito!</b>\n\n` +
    `Por favor, envie o seu comprovante em um dos seguintes formatos válidos:\n` +
    `• 📸 <b>Foto</b> enviada diretamente pelo Telegram (JPEG/JPG)\n` +
    `• 🖼️ <b>Print de tela</b> ou imagem (JPG, JPEG, PNG ou WEBP)\n` +
    `• 📄 <b>Arquivo PDF</b> (.pdf)\n\n` +
    `<i>Arquivos executáveis, áudios, vídeos ou outros documentos não são aceitos. Envie novamente um arquivo válido ou clique em "⬅️ Voltar" para cancelar.</i>`;

// --- LÓGICA PRINCIPAL DO BOT ---
bot.on('message', async (msg) => {
    try {
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        const chatType = msg.chat.type;
        const text = msg.text;

        // --- PROTEÇÃO DE CHAT PRIVADO ---
        if (chatType !== 'private') {
            if (text) {
                return bot.sendMessage(
                    chatId,
                    "⚠️ Por questões de segurança e privacidade, o <b>Imperium Cash</b> funciona exclusivamente em mensagens privadas (chat 1 a 1). Por favor, clique no nome do bot e envie uma mensagem direta para mim.",
                    { parse_mode: 'HTML' }
                );
            }
            return;
        }

        if (!text && awaitingReceipt.has(userId) && !isOwner(userId)) {
            if (!msg.photo && !msg.document) {
                return bot.sendMessage(chatId, MSG_FORMATO_INVALIDO_COMPROVANTE, {
                    parse_mode: 'HTML',
                    ...tecladoVoltar
                });
            }
            return;
        }

        if (!text) return;

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

        const usernameOriginal = msg.from.username || 'Usuario';
        
        const userExists = await pool.query('SELECT origem FROM usuarios WHERE telegram_id = $1', [userId]);
        if (userExists.rowCount === 0) {
            await pool.query(
                `INSERT INTO usuarios (telegram_id, username, origem)
                 VALUES ($1, $2, $3)`,
                [userId, usernameOriginal, origem]
            );
        } else {
            await pool.query(
                `UPDATE usuarios SET username = $1 WHERE telegram_id = $2`,
                [usernameOriginal, userId]
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
                `• /pagamentos — Lista todas as solicitações de assinatura Pix pendentes com opção de consulta e aprovação/rejeição.\n` +
                `• /solicitacao [ID] — Consulta detalhadamente uma solicitação de pagamento específica pelo número do ID.\n` +
                `• /afiliado — Exibe o relatório completo de indicações, conversões e comissões do afiliado Samuel.\n` +
                `• /comissoes — Mostra todas as comissões geradas (pendentes e pagas) detalhando os valores e usuários responsáveis.\n` +
                `• /pagarcomissao [ID] — Altera o status de uma comissão específica de PENDENTE para PAGO após a realização do Pix manual.\n` +
                `• /addvip — Inicia o fluxo interativo para promover um usuário ao plano Imperium Plus por 30 dias (renovação acumulativa).\n` +
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
                    relatorioAfiliado += '<i>Nenhum usuário indicado até o momento.</i>';
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

        // --- COMANDO /PAGARCOMISSAO ID (ADMIN - ATUALIZAÇÃO CONDICIONAL COM PENDENTE) ---
        if (text.startsWith('/pagarcomissao ')) {
            if (!isOwner(userId)) {
                return bot.sendMessage(chatId, "❌ Apenas o administrador pode utilizar este comando.");
            }

            const arg = text.replace('/pagarcomissao', '').trim();
            if (!/^\d+$/.test(arg)) {
                return bot.sendMessage(chatId, "⚠️ Use o formato correto com ID numérico inteiro: /pagarcomissao [ID]");
            }
            const comissaoId = parseInt(arg, 10);

            const client = await pool.connect();
            let comissaoAtualizada = false;
            let comissaoValor = 0;

            try {
                await client.query('BEGIN');
                
                const checkC = await client.query("SELECT * FROM comissoes_afiliados WHERE id = $1 FOR UPDATE", [comissaoId]);
                if (checkC.rowCount === 0) {
                    await client.query('ROLLBACK');
                    return bot.sendMessage(chatId, `❌ Comissão com ID ${comissaoId} não foi encontrada.`);
                }

                const comissao = checkC.rows[0];
                comissaoValor = parseFloat(comissao.valor_comissao);
                
                if (comissao.status === 'PAGO') {
                    await client.query('ROLLBACK');
                    return bot.sendMessage(chatId, `⚠️ A comissão de ID <code>${comissaoId}</code> já foi marcada como <b>PAGO</b> anteriormente e não pode ser paga novamente.`, { parse_mode: 'HTML' });
                }

                // Atualização condicional estrita com PENDENTE e verificação rowCount === 1
                const updateRes = await client.query(
                    "UPDATE comissoes_afiliados SET status = 'PAGO', paid_at = NOW() WHERE id = $1 AND status = 'PENDENTE' RETURNING id",
                    [comissaoId]
                );

                if (updateRes.rowCount !== 1) {
                    await client.query('ROLLBACK');
                    return bot.sendMessage(chatId, `❌ A comissão de ID <code>${comissaoId}</code> não pôde ser atualizada (status inválido ou já processada).`, { parse_mode: 'HTML' });
                }

                await client.query('COMMIT');
                comissaoAtualizada = true;
            } catch (e) {
                await client.query('ROLLBACK');
                console.error("Erro no /pagarcomissao (DB):", e);
                return bot.sendMessage(chatId, "❌ Erro ao atualizar o status da comissão no banco de dados.");
            } finally {
                client.release();
            }

            if (comissaoAtualizada) {
                try {
                    return await bot.sendMessage(
                        chatId,
                        `✅ <b>Comissão atualizada com sucesso!</b>\nO registro de ID <code>${comissaoId}</code> no valor de R$ ${comissaoValor.toFixed(2)} foi marcado como <b>PAGO</b>.`,
                        { parse_mode: 'HTML' }
                    );
                } catch (msgErr) {
                    console.error("Erro ao enviar confirmação de /pagarcomissao ao admin após COMMIT:", msgErr);
                }
            }
            return;
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

                let textResp = '📋 <b>Solicitações Pendentes:</b>\n\nSelecione uma solicitação para visualizar os detalhes e o comprovante:\n';
                await bot.sendMessage(chatId, textResp, { parse_mode: 'HTML' });

                for (const r of res.rows) {
                    const dataF = new Date(r.created_at).toLocaleString('pt-BR');
                    const msgItem = `• ID: <code>${r.id}</code>\n• Usuário ID: <code>${r.telegram_id}</code>\n• Username: ${escapeHtml(r.username)}\n• Data: ${dataF}`;
                    
                    const inlineKeyboardRows = [[{ text: `🔍 Ver Comprovante (ID ${r.id})`, callback_data: `ver_solicitacao_${r.id}` }]];
                    if (r.status === 'PENDING') {
                        inlineKeyboardRows.push([
                            { text: '✅ Aprovar', callback_data: `aprovar_pag_${r.id}` },
                            { text: '❌ Rejeitar', callback_data: `rejeitar_pag_${r.id}` }
                        ]);
                    }

                    await bot.sendMessage(chatId, msgItem, { parse_mode: 'HTML', reply_markup: { inline_keyboard: inlineKeyboardRows } });
                }
                return;
            } catch (err) {
                console.error("Erro em /pagamentos:", err);
                return bot.sendMessage(chatId, "❌ Erro ao consultar pagamentos pendentes.");
            }
        }

        // --- COMANDO /SOLICITACAO ID (ADMIN) ---
        if (text.startsWith('/solicitacao ')) {
            if (!isOwner(userId)) {
                return bot.sendMessage(chatId, "❌ Apenas o administrador pode utilizar este comando.");
            }

            const arg = text.replace('/solicitacao', '').trim();
            if (!/^\d+$/.test(arg)) {
                return bot.sendMessage(chatId, "⚠️ Use o formato correto com ID numérico inteiro: /solicitacao [ID]");
            }
            const reqId = parseInt(arg, 10);

            try {
                const res = await pool.query("SELECT * FROM pagamento_solicitacoes WHERE id = $1", [reqId]);
                if (res.rowCount === 0) {
                    return bot.sendMessage(chatId, `❌ Solicitação com ID <code>${reqId}</code> não foi encontrada.`, { parse_mode: 'HTML' });
                }

                const r = res.rows[0];
                const dataF = new Date(r.created_at).toLocaleString('pt-BR');
                const statusEmoji = r.status === 'APPROVED' ? '✅ Aprovada' : r.status === 'REJECTED' ? '❌ Rejeitada' : '⏳ Pendente';

                const infoText =
                    `🔍 <b>DETALHES DA SOLICITAÇÃO — ID ${r.id}</b>\n\n` +
                    `• <b>Status:</b> ${statusEmoji}\n` +
                    `• <b>ID do Cliente:</b> <code>${r.telegram_id}</code>\n` +
                    `• <b>Username:</b> ${escapeHtml(r.username)}\n` +
                    `• <b>Valor:</b> R$ ${parseFloat(r.valor).toFixed(2)}\n` +
                    `• <b>Data/Hora:</b> ${dataF}\n` +
                    `• <b>Tipo de Arquivo:</b> ${r.file_type || 'N/A'}`;

                const inlineKeyboardRows = [];
                if (r.status === 'PENDING') {
                    inlineKeyboardRows.push([
                        { text: '✅ Aprovar pagamento', callback_data: `aprovar_pag_${r.id}` },
                        { text: '❌ Rejeitar pagamento', callback_data: `rejeitar_pag_${r.id}` }
                    ]);
                }

                if (r.telegram_file_id) {
                    if (r.file_type === 'photo') {
                        await bot.sendPhoto(chatId, r.telegram_file_id, { caption: infoText, parse_mode: 'HTML', reply_markup: { inline_keyboard: inlineKeyboardRows } });
                    } else {
                        await bot.sendDocument(chatId, r.telegram_file_id, { caption: infoText, parse_mode: 'HTML', reply_markup: { inline_keyboard: inlineKeyboardRows } });
                    }
                } else {
                    await bot.sendMessage(chatId, infoText + '\n\n<i>(Arquivo de comprovante não registrado no banco)</i>', { parse_mode: 'HTML', reply_markup: { inline_keyboard: inlineKeyboardRows } });
                }
                return;
            } catch (err) {
                console.error("Erro em /solicitacao:", err);
                return bot.sendMessage(chatId, "❌ Erro ao consultar a solicitação.");
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

        // --- COMANDO START / VOLTAR ---
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

        // --- SE USUÁRIO ESTÁ AGUARDANDO ENVIO DE COMPROVANTE E ENVIA TEXTO ---
        if (awaitingReceipt.has(userId) && !isOwner(userId)) {
            return bot.sendMessage(
                chatId,
                `📥 <b>Aguardando seu comprovante!</b>\n\n` +
                `Por favor, envie uma <b>foto</b>, um <b>print de tela</b> (JPG, PNG ou WEBP) ou um <b>arquivo PDF</b> do comprovante Pix.\n\n` +
                `Caso queira cancelar o envio, clique em "⬅️ Voltar".`,
                { parse_mode: 'HTML', ...tecladoVoltar }
            );
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
                `2. Após realizar o pagamento, retorne e clique em "✅ Já realizei o pagamento" para enviar sua <b>foto, print de tela ou arquivo PDF</b> do comprovante.`;

            const inlineRows = [];
            if (pixPaymentUrl) {
                inlineRows.push([{ text: '🔗 Pagar R$ 5,00 via Pix', url: pixPaymentUrl }]);
            }
            inlineRows.push([{ text: '✅ Já realizei o pagamento', callback_data: 'enviar_comprovante_fluxo' }]);
            inlineRows.push([{ text: '❌ Cancelar', callback_data: 'cancelar_assinatura' }]);

            return bot.sendMessage(chatId, plusText, { parse_mode: 'HTML', reply_markup: { inline_keyboard: inlineRows } });
        }

        // --- EXPORTAR EXCEL ---
        if (text === '📊 Exportar Excel') {
            try {
                const txRes = await pool.query("SELECT tipo, valor, descricao, data FROM transacoes WHERE user_id = $1 ORDER BY data DESC", [userId]);
                const userRes = await pool.query("SELECT plano, vip_expiracao, data_cadastro FROM usuarios WHERE telegram_id = $1", [userId]);

                const workbook = new ExcelJS.Workbook();
                workbook.creator = 'Imperium Cash Bot';
                workbook.created = new Date();

                // Aba 1: Transações
                const sheetTx = workbook.addWorksheet('Lançamentos');
                sheetTx.columns = [
                    { header: 'Tipo', key: 'tipo', width: 15 },
                    { header: 'Valor (R$)', key: 'valor', width: 15 },
                    { header: 'Descrição', key: 'descricao', width: 35 },
                    { header: 'Data', key: 'data', width: 20 }
                ];

                sheetTx.getRow(1).font = { bold: true, color: { argb: 'FFFFFF' } };
                sheetTx.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '2C3E50' } };
                sheetTx.getRow(1).alignment = { horizontal: 'center' };

                if (txRes.rows.length === 0) {
                    sheetTx.addRow({ tipo: 'Nenhum lançamento encontrado', valor: '', descricao: '', data: '' });
                } else {
                    txRes.rows.forEach(row => {
                        const tipoStr = row.tipo === 'entrada' ? 'Ganhei' : row.tipo === 'saida' ? 'Gastei' : 'Investimento';
                        const addedRow = sheetTx.addRow({
                            tipo: tipoStr,
                            valor: parseFloat(row.valor),
                            descricao: row.descricao,
                            data: new Date(row.data).toLocaleString('pt-BR')
                        });
                        addedRow.getCell('valor').numFmt = '"R$ "#,##0.00';
                    });
                }

                // Aba 2: Resumo da Conta
                const sheetConta = workbook.addWorksheet('Resumo da Conta');
                sheetConta.columns = [
                    { header: 'Parâmetro', key: 'param', width: 25 },
                    { header: 'Valor', key: 'val', width: 30 }
                ];
                sheetConta.getRow(1).font = { bold: true, color: { argb: 'FFFFFF' } };
                sheetConta.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '27AE60' } };

                const userData = userRes.rows[0] || {};
                sheetConta.addRow({ param: 'ID do Usuário', val: String(userId) });
                sheetConta.addRow({ param: 'Plano Atual', val: userData.plano || 'FREE' });
                sheetConta.addRow({ param: 'Expiração VIP', val: userData.vip_expiracao ? new Date(userData.vip_expiracao).toLocaleString('pt-BR') : 'N/A' });
                sheetConta.addRow({ param: 'Data de Cadastro', val: userData.data_cadastro ? new Date(userData.data_cadastro).toLocaleString('pt-BR') : 'N/A' });
                sheetConta.addRow({ param: 'Total de Lançamentos', val: txRes.rows.length });

                const tempFilePath = path.join(__dirname, `relatorio_${userId}_${Date.now()}.xlsx`);
                await workbook.xlsx.writeFile(tempFilePath);

                await bot.sendDocument(chatId, tempFilePath, {
                    caption: '📊 <b>Relatório Financeiro Exportado</b>\nAqui está a sua planilha Excel completa com todos os seus lançamentos e dados da conta.',
                    parse_mode: 'HTML',
                    ...menuPrincipal
                });

                fs.unlink(tempFilePath, () => {});
                return;
            } catch (err) {
                console.error("Erro ao exportar Excel:", err);
                return bot.sendMessage(chatId, "❌ Ocorreu um erro ao gerar a sua planilha Excel. Tente novamente mais tarde.", menuPrincipal);
            }
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

        // --- PEDIR ID VIP (/ADDVIP COM VALIDAÇÃO ESTRITA DE ID POSITIVO) ---
        if (estado.acao === 'pedir_id_vip') {
            const idPromover = text.trim();
            if (!/^[1-9]\d*$/.test(idPromover)) {
                return bot.sendMessage(chatId, "⚠️ O ID deve ser um número inteiro estritamente positivo (ex: 12345678). Tente novamente ou use '⬅️ Voltar':", tecladoVoltar);
            }

            try {
                const checkUser = await pool.query("SELECT telegram_id FROM usuarios WHERE telegram_id = $1", [idPromover]);
                if (checkUser.rowCount === 0) {
                    delete estados[userId];
                    return bot.sendMessage(
                        chatId,
                        `❌ <b>Usuário não encontrado!</b>\nO ID <code>${idPromover}</code> não está cadastrado no banco de dados do bot. O usuário precisa iniciar uma conversa com o bot primeiro.`,
                        { parse_mode: 'HTML', ...menuPrincipal }
                    );
                }

                const updateRes = await pool.query(
                    `UPDATE usuarios 
                     SET plano = 'VIP', 
                         vip_expiracao = GREATEST(COALESCE(vip_expiracao, NOW()), NOW()) + INTERVAL '30 days' 
                     WHERE telegram_id = $1 RETURNING plano, vip_expiracao`,
                    [idPromover]
                );

                if (updateRes.rowCount > 0 && updateRes.rows[0].plano === 'VIP') {
                    await bot.sendMessage(
                        chatId,
                        `⭐ Sucesso! O usuário de ID <code>${idPromover}</code> agora possui o Imperium Plus por mais 30 dias (renovação acumulada)!`,
                        { parse_mode: 'HTML', ...menuPrincipal }
                    );
                } else {
                    await bot.sendMessage(chatId, "❌ Falha ao confirmar a atualização do plano no banco de dados.", menuPrincipal);
                }
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
            const descricaoOriginal = text;

            await pool.query(
                'INSERT INTO transacoes (user_id, tipo, valor, descricao) VALUES ($1, $2, $3, $4)',
                [userId, estado.tipo, estado.valor, descricaoOriginal]
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
                    let valToSave = estado.newValue;

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
        // --- TRATAMENTO DE CONSULTA DE SOLICITAÇÃO ESPECÍFICA VIA BOTÃO ---
        if (data.startsWith('ver_solicitacao_')) {
            if (!isOwner(userId)) {
                return bot.answerCallbackQuery(callbackQuery.id, { text: 'Acesso negado.', show_alert: true });
            }
            const reqId = parseInt(data.replace('ver_solicitacao_', ''), 10);
            await bot.answerCallbackQuery(callbackQuery.id);

            const res = await pool.query("SELECT * FROM pagamento_solicitacoes WHERE id = $1", [reqId]);
            if (res.rowCount === 0) {
                return bot.sendMessage(chatId, `❌ Solicitação ID <code>${reqId}</code> não encontrada.`, { parse_mode: 'HTML' });
            }

            const r = res.rows[0];
            const dataF = new Date(r.created_at).toLocaleString('pt-BR');
            const statusEmoji = r.status === 'APPROVED' ? '✅ Aprovada' : r.status === 'REJECTED' ? '❌ Rejeitada' : '⏳ Pendente';

            const infoText =
                `🔍 <b>DETALHES DA SOLICITAÇÃO — ID ${r.id}</b>\n\n` +
                `• <b>Status:</b> ${statusEmoji}\n` +
                `• <b>ID do Cliente:</b> <code>${r.telegram_id}</code>\n` +
                `• <b>Username:</b> ${escapeHtml(r.username)}\n` +
                `• <b>Valor:</b> R$ ${parseFloat(r.valor).toFixed(2)}\n` +
                `• <b>Data/Hora:</b> ${dataF}\n` +
                `• <b>Tipo de Arquivo:</b> ${r.file_type || 'N/A'}`;

            const inlineKeyboardRows = [];
            if (r.status === 'PENDING') {
                inlineKeyboardRows.push([
                    { text: '✅ Aprovar pagamento', callback_data: `aprovar_pag_${r.id}` },
                    { text: '❌ Rejeitar pagamento', callback_data: `rejeitar_pag_${r.id}` }
                ]);
            }

            if (r.telegram_file_id) {
                if (r.file_type === 'photo') {
                    return bot.sendPhoto(chatId, r.telegram_file_id, { caption: infoText, parse_mode: 'HTML', reply_markup: { inline_keyboard: inlineKeyboardRows } });
                } else {
                    return bot.sendDocument(chatId, r.telegram_file_id, { caption: infoText, parse_mode: 'HTML', reply_markup: { inline_keyboard: inlineKeyboardRows } });
                }
            } else {
                return bot.sendMessage(chatId, infoText + '\n\n<i>(Arquivo de comprovante não registrado no banco)</i>', { parse_mode: 'HTML', reply_markup: { inline_keyboard: inlineKeyboardRows } });
            }
        }

        // --- TRATAMENTO DE CONFIRMAÇÃO DO /CLS ---
        if (data.startsWith('confirm_cls_') || data.startsWith('cancel_cls_')) {
            const parts = data.split('_');
            const action = parts[0];
            const confirmKey = parts.slice(2).join('_');

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
                `2. Após realizar o pagamento, retorne e clique em "✅ Já realizei o pagamento" para enviar sua <b>foto, print de tela ou arquivo PDF</b> do comprovante.`;

            const inlineRows = [];
            if (pixPaymentUrl) {
                inlineRows.push([{ text: '🔗 Pagar R$ 5,00 via Pix', url: pixPaymentUrl }]);
            }
            inlineRows.push([{ text: '✅ Já realizei o pagamento', callback_data: 'enviar_comprovante_fluxo' }]);
            inlineRows.push([{ text: '❌ Cancelar', callback_data: 'cancelar_assinatura' }]);

            return bot.sendMessage(chatId, plusText, { parse_mode: 'HTML', reply_markup: { inline_keyboard: inlineRows } });
        }

        if (data === 'enviar_comprovante_fluxo') {
            const pendRes = await pool.query(
                "SELECT id FROM pagamento_solicitacoes WHERE telegram_id = $1 AND status = 'PENDING'",
                [userId]
            );
            if (pendRes.rowCount > 0) {
                awaitingReceipt.delete(userId);
                await bot.answerCallbackQuery(callbackQuery.id, { text: 'Você já tem uma solicitação pendente.', show_alert: true });
                return bot.sendMessage(userId, '⏳ Você já possui uma solicitação pendente aguardando análise administrativa.', menuPrincipal);
            }

            awaitingReceipt.add(userId);
            await bot.answerCallbackQuery(callbackQuery.id, { text: 'Envie o comprovante!' });
            return bot.sendMessage(
                userId,
                `📥 <b>Envio de Comprovante</b>\n\n` +
                `Por favor, envie agora o comprovante do seu pagamento Pix em um dos formatos aceitos:\n` +
                `• 📸 <b>Foto</b> enviada diretamente pelo Telegram\n` +
                `• 🖼️ <b>Print de tela</b> ou imagem (JPG, JPEG, PNG ou WEBP)\n` +
                `• 📄 <b>Arquivo PDF</b> (.pdf)\n\n` +
                `<i>Caso queira cancelar, clique em "⬅️ Voltar" no menu.</i>`,
                { parse_mode: 'HTML', ...tecladoVoltar }
            );
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
            let dbCommitted = false;
            let solicitacaoInfo = null;

            try {
                await client.query('BEGIN');
                const reqRes = await client.query('SELECT * FROM pagamento_solicitacoes WHERE id = $1 FOR UPDATE', [reqId]);
                if (reqRes.rowCount === 0) {
                    await client.query('ROLLBACK');
                    return bot.answerCallbackQuery(callbackQuery.id, { text: 'Solicitação não encontrada.', show_alert: true });
                }

                solicitacaoInfo = reqRes.rows[0];
                if (solicitacaoInfo.status !== 'PENDING') {
                    await client.query('ROLLBACK');
                    return bot.answerCallbackQuery(callbackQuery.id, { text: 'Esta solicitação já foi processada anteriormente.', show_alert: true });
                }

                if (action === 'aprovar') {
                    // Verificação obrigatória de existência do usuário apenas na aprovação
                    const userCheck = await client.query('SELECT telegram_id FROM usuarios WHERE telegram_id = $1', [solicitacaoInfo.telegram_id]);
                    if (userCheck.rowCount === 0) {
                        await client.query('ROLLBACK');
                        return bot.answerCallbackQuery(callbackQuery.id, { text: 'Erro: O cliente não está cadastrado no banco.', show_alert: true });
                    }

                    await client.query(
                        "UPDATE pagamento_solicitacoes SET status = 'APPROVED', reviewed_at = NOW(), reviewed_by = $1 WHERE id = $2",
                        [userId, reqId]
                    );

                    const updateVipRes = await client.query(
                        `UPDATE usuarios 
                         SET plano = 'VIP', 
                             vip_expiracao = GREATEST(COALESCE(vip_expiracao, NOW()), NOW()) + INTERVAL '30 days' 
                         WHERE telegram_id = $1 RETURNING plano, vip_expiracao`,
                        [solicitacaoInfo.telegram_id]
                    );

                    if (updateVipRes.rowCount === 0 || updateVipRes.rows[0].plano !== 'VIP') {
                        await client.query('ROLLBACK');
                        return bot.answerCallbackQuery(callbackQuery.id, { text: 'Erro: Falha ao atualizar o plano VIP do usuário no banco.', show_alert: true });
                    }

                    const userOrigemRes = await client.query("SELECT origem FROM usuarios WHERE telegram_id = $1", [solicitacaoInfo.telegram_id]);
                    if (userOrigemRes.rowCount > 0 && userOrigemRes.rows[0].origem === 'samuel') {
                        const afRes = await client.query("SELECT id FROM afiliados WHERE codigo = 'samuel'");
                        if (afRes.rowCount > 0) {
                            const affId = afRes.rows[0].id;
                            const valorAssinatura = 5.00;
                            const valorComissao = 1.00;

                            await client.query(
                                `INSERT INTO comissoes_afiliados (affiliate_id, telegram_id, solicitacao_id, valor_assinatura, valor_comissao, status)
                                 VALUES ($1, $2, $3, $4, $5, 'PENDENTE')
                                 ON CONFLICT (solicitacao_id) DO NOTHING`,
                                [affId, solicitacaoInfo.telegram_id, reqId, valorAssinatura, valorComissao]
                            );
                        }
                    }

                    await client.query('COMMIT');
                    dbCommitted = true;

                } else if (action === 'rejeitar') {
                    // Na rejeição, não é necessário exigir que o usuário ainda esteja cadastrado
                    await client.query(
                        "UPDATE pagamento_solicitacoes SET status = 'REJECTED', reviewed_at = NOW(), reviewed_by = $1 WHERE id = $2",
                        [userId, reqId]
                    );

                    await client.query('COMMIT');
                    dbCommitted = true;
                }
            } catch (err) {
                await client.query('ROLLBACK');
                console.error("Erro no callback de pagamento (DB):", err);
                return bot.answerCallbackQuery(callbackQuery.id, { text: 'Erro ao processar solicitação no banco.', show_alert: true });
            } finally {
                client.release();
            }

            if (dbCommitted && solicitacaoInfo) {
                try {
                    await bot.answerCallbackQuery(callbackQuery.id, { text: action === 'aprovar' ? 'Aprovado com sucesso!' : 'Rejeitado.' });
                } catch (e) {
                    console.error("Erro ao responder callback query:", e);
                }

                try {
                    const statusText = action === 'aprovar' ? 'APROVADA' : 'REJEITADA';
                    const emojiStatus = action === 'aprovar' ? '✅' : '❌';
                    const newCaptionOrText = `${emojiStatus} <b>SOLICITAÇÃO ${statusText}</b>\nID: <code>${reqId}</code>\nCliente: ${escapeHtml(solicitacaoInfo.username)} (<code>${solicitacaoInfo.telegram_id}</code>)`;
                    
                    if (msg.photo || msg.document || msg.caption !== undefined) {
                        await bot.editMessageCaption(newCaptionOrText, {
                            chat_id: chatId,
                            message_id: msg.message_id,
                            parse_mode: 'HTML'
                        });
                    } else {
                        await bot.editMessageText(newCaptionOrText, {
                            chat_id: chatId,
                            message_id: msg.message_id,
                            parse_mode: 'HTML'
                        });
                    }
                } catch (e) {
                    console.error("Erro ao atualizar mensagem administrativa após COMMIT:", e);
                }

                try {
                    if (action === 'aprovar') {
                        await bot.sendMessage(
                            solicitacaoInfo.telegram_id,
                            `🎉 <b>Pagamento Aprovado!</b>\n\nSua assinatura do <b>Imperium Plus</b> foi ativada/renovada por mais 30 dias com sucesso!`,
                            { parse_mode: 'HTML', ...menuPrincipal }
                        );
                    } else {
                        await bot.sendMessage(
                            solicitacaoInfo.telegram_id,
                            `⚠️ Seu comprovante do Imperium Plus não foi aprovado. Verifique os dados do Pix ou entre em contato com o suporte.`,
                            { parse_mode: 'HTML', ...menuPrincipal }
                        );
                    }
                } catch (e) {
                    console.error("Erro ao notificar cliente sobre o status do pagamento:", e);
                }
            }
        }
    } catch (err) {
        console.error("Erro geral em callback_query:", err);
    }
});

// --- RECEBIMENTO DE COMPROVANTES (FOTOS E PRINTS DE TELA) ---
bot.on('photo', async (msg) => {
    try {
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        if (msg.chat.type !== 'private' || isOwner(userId)) return;

        if (!awaitingReceipt.has(userId)) {
            return;
        }

        if (!Array.isArray(msg.photo) || msg.photo.length === 0) {
            return bot.sendMessage(chatId, MSG_FORMATO_INVALIDO_COMPROVANTE, {
                parse_mode: 'HTML',
                ...tecladoVoltar
            });
        }

        const photoMaiorResolucao = msg.photo.reduce((prev, curr) => {
            const prevPixels = (prev.width || 0) * (prev.height || 0);
            const currPixels = (curr.width || 0) * (curr.height || 0);
            return currPixels >= prevPixels ? curr : prev;
        }, msg.photo[msg.photo.length - 1]);

        await registrarEEnviarSolicitacao(msg, photoMaiorResolucao.file_id, 'photo');
    } catch (err) {
        console.error('Erro no evento photo:', err);
    }
});

// --- RECEBIMENTO DE COMPROVANTES (DOCUMENTOS PDF OU IMAGENS SEM COMPRESSÃO) ---
bot.on('document', async (msg) => {
    try {
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        if (msg.chat.type !== 'private' || isOwner(userId)) return;

        if (!awaitingReceipt.has(userId)) {
            return;
        }

        const document = msg.document;
        const validacao = validarDocumentoComprovante(document);

        if (!validacao.valido) {
            return bot.sendMessage(chatId, MSG_FORMATO_INVALIDO_COMPROVANTE, {
                parse_mode: 'HTML',
                ...tecladoVoltar
            });
        }

        await registrarEEnviarSolicitacao(msg, document.file_id, validacao.tipoInterno);
    } catch (err) {
        console.error('Erro no evento document:', err);
    }
});

async function registrarEEnviarSolicitacao(msg, fileId, fileType) {
    const chatId = msg.chat.id;
    const user = msg.from;
    const nomeClienteOriginal = user.first_name || 'Cliente';
    const usernameOriginal = user.username ? `@${user.username}` : 'Não disponível';

    const client = await pool.connect();
    let reqId = null;
    let dbCommitted = false;

    try {
        await client.query('BEGIN');
        
        // Bloqueio transacional seguro por usuário usando pg_advisory_xact_lock para impedir envios simultâneos duplicados
        await client.query('SELECT pg_advisory_xact_lock($1)', [chatId]);

        const checkPend = await client.query(
            "SELECT id FROM pagamento_solicitacoes WHERE telegram_id = $1 AND status = 'PENDING'",
            [chatId]
        );

        if (checkPend.rowCount > 0) {
            await client.query('ROLLBACK');
            awaitingReceipt.delete(chatId);
            return bot.sendMessage(chatId, '⏳ Você já possui uma solicitação pendente aguardando análise administrativa.', menuPrincipal);
        }

        const res = await client.query(
            `INSERT INTO pagamento_solicitacoes (telegram_id, username, valor, status, telegram_file_id, file_type, created_at)
             VALUES ($1, $2, 5.00, 'PENDING', $3, $4, NOW()) RETURNING id`,
            [chatId, usernameOriginal, fileId, fileType]
        );

        reqId = res.rows[0].id;
        await client.query('COMMIT');
        dbCommitted = true;
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Erro ao registrar solicitação de pagamento no banco:', err);
        return bot.sendMessage(chatId, '❌ Ocorreu um erro ao salvar seu comprovante no banco. Por favor, envie novamente.', menuPrincipal);
    } finally {
        client.release();
    }

    if (dbCommitted) {
        awaitingReceipt.delete(chatId);

        try {
            await bot.sendMessage(
                chatId,
                '✅ <b>Comprovante recebido!</b>\n\nSua solicitação foi enviada para análise administrativa e está aguardando aprovação. Você será avisado em breve.',
                { parse_mode: 'HTML', ...menuPrincipal }
            );
        } catch (userNotifyErr) {
            console.error('Erro ao enviar confirmação ao usuário após o commit:', userNotifyErr);
        }

        try {
            if (OWNER_ID && reqId) {
                const dataHoraEnvio = new Date().toLocaleString('pt-BR');
                const tipoArquivoLegenda = fileType === 'photo' ? 'Foto / Print de Tela' : 'Documento (PDF / Imagem)';
                const captionAdmin =
                    `💰 <b>NOVA SOLICITAÇÃO DE ASSINATURA</b>\n\n` +
                    `• <b>Nome do cliente:</b> ${escapeHtml(nomeClienteOriginal)}\n` +
                    `• <b>Username:</b> ${escapeHtml(usernameOriginal)}\n` +
                    `• <b>ID do cliente:</b> <code>${chatId}</code>\n` +
                    `• <b>Plano:</b> Imperium Plus\n` +
                    `• <b>Valor esperado:</b> R$ 5,00\n` +
                    `• <b>Formato recebido:</b> ${tipoArquivoLegenda}\n` +
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
        } catch (adminNotifyErr) {
            console.error('Erro ao enviar notificação para o administrador:', adminNotifyErr);
        }
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

// --- INICIALIZAÇÃO CORRETA: O servidor e o bot.startPolling() só sobem APÓS o banco estar pronto ---
setupDB().then(() => {
    bot.startPolling().then(() => {
        console.log("🚀 Telegram Bot polling iniciado com sucesso.");
    }).catch(err => {
        console.error("❌ Erro ao iniciar polling do Telegram:", err);
    });

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