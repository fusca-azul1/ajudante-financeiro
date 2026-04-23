require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const QuickChart = require('quickchart-js');
const { Pool } = require('pg');
const ExcelJS = require('exceljs');
const fs = require('fs');

const token = process.env.BOT_TOKEN;
const bot = new TelegramBot(token, { polling: true });

// --- CONEXÃO COM BANCO ---
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Inicialização do Banco
async function setupDB() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS usuarios (
                telegram_id BIGINT PRIMARY KEY,
                plano TEXT DEFAULT 'FREE',
                username TEXT,
                vip_expiracao TIMESTAMP,
                data_cadastro TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS vip_expiracao TIMESTAMP;
            CREATE TABLE IF NOT EXISTS transacoes (
                id SERIAL PRIMARY KEY,
                user_id BIGINT REFERENCES usuarios(telegram_id),
                tipo TEXT, 
                valor DECIMAL(12,2),
                descricao TEXT,
                data TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log("✅ Banco conectado e sincronizado.");
    } catch (err) {
        console.error("❌ Erro ao conectar ao banco:", err);
    }
}
setupDB();

const ID_DONO = 7255640135; 
const estados = {};

// --- INTERFACE ---
const menuPrincipal = {
    reply_markup: {
        keyboard: [['💰 Ganhei', '💸 Gastei'], ['📊 Gráfico', '📄 Relatório'], ['💎 Plano VIP', '👤 Perfil']],
        resize_keyboard: true
    }
};

const tecladoVoltar = {
    reply_markup: { keyboard: [['⬅️ Voltar']], resize_keyboard: true }
};

// --- FUNÇÃO DE LIMITE ---
async function verificarAcesso(userId) {
    const res = await pool.query('SELECT plano, vip_expiracao FROM usuarios WHERE telegram_id = $1', [userId]);
    const user = res.rows[0];
    const plano = user?.plano || 'FREE';
    const expiracao = user?.vip_expiracao;

    if (plano === 'VIP') {
        if (expiracao && new Date() > new Date(expiracao)) {
            await pool.query("UPDATE usuarios SET plano = 'FREE', vip_expiracao = NULL WHERE telegram_id = $1", [userId]);
            return { pode: false, msg: "⚠️ <b>Seu plano VIP expirou!</b>\n\nSua assinatura chegou ao fim. Renove enviando o PIX para continuar sem limites." };
        }
        return { pode: true, plano: 'VIP' };
    }

    const contagem = await pool.query('SELECT COUNT(*) as total FROM transacoes WHERE user_id = $1', [userId]);
    const totalRegistros = parseInt(contagem.rows[0].total);
    if (totalRegistros >= 15) {
        return { pode: false, msg: `🔒 <b>Limite Atingido!</b>\n\nVocê atingiu o teto de 15 registros do plano Free. Torne-se <b>VIP</b> para liberar o acesso!` };
    }
    return { pode: true, plano: 'FREE' };
}

function parseValor(texto) {
    let limpo = texto.toLowerCase().replace('r$', '').replace(/\s/g, '').trim();
    if (limpo.endsWith('k')) return parseFloat(limpo.replace('k', '').replace(',', '.')) * 1000;
    return parseFloat(limpo.replace(/\./g, '').replace(',', '.'));
}

// --- LÓGICA DO BOT ---
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const text = msg.text;

    if (!text) return;

    await pool.query('INSERT INTO usuarios (telegram_id, username) VALUES ($1, $2) ON CONFLICT (telegram_id) DO UPDATE SET username = $2', [userId, msg.from.username || 'Usuario']);

    // --- COMANDOS EXCLUSIVOS DO DONO ---
    if (text.startsWith('/vip') || text === '/vips' || text === '/planilha_vips') {
        if (userId !== ID_DONO) {
            return bot.sendMessage(chatId, "❌ Apenas o dono pode gerenciar assinaturas.");
        }

        // COMANDO: /vip ID
        if (text.startsWith('/vip ')) {
            const idParaPromover = text.replace('/vip', '').trim();
            if (!idParaPromover || isNaN(idParaPromover)) return bot.sendMessage(chatId, "⚠️ Use: /vip ID");
            try {
                await pool.query("UPDATE usuarios SET plano = 'VIP', vip_expiracao = NOW() + INTERVAL '30 days' WHERE telegram_id = $1", [idParaPromover]);
                return bot.sendMessage(chatId, `⭐ ID <code>${idParaPromover}</code> promovido por 30 dias!`, { parse_mode: 'HTML' });
            } catch (e) { return bot.sendMessage(chatId, "❌ Erro no banco."); }
        }

        // COMANDO: /vips (CORREÇÃO DA DATA 1970)
        if (text === '/vips') {
            const res = await pool.query("SELECT telegram_id, username, vip_expiracao FROM usuarios WHERE plano = 'VIP' ORDER BY vip_expiracao ASC");
            if (res.rowCount === 0) return bot.sendMessage(chatId, "Nenhum VIP ativo no momento.");
            
            let lista = "📋 <b>CLIENTES VIP ATIVOS:</b>\n\n";
            res.rows.forEach(u => {
                const dataExp = u.vip_expiracao ? new Date(u.vip_expiracao).toLocaleDateString('pt-BR') : "Data não definida";
                lista += `👤 @${u.username || 'Sem Username'} (<code>${u.telegram_id}</code>)\n📅 Vence em: <b>${dataExp}</b>\n\n`;
            });
            return bot.sendMessage(chatId, lista, { parse_mode: 'HTML' });
        }

        // COMANDO: /planilha_vips (CORREÇÃO COLUNA EXPIRAÇÃO)
        if (text === '/planilha_vips') {
            const res = await pool.query("SELECT telegram_id, username, plano, vip_expiracao, data_cadastro FROM usuarios WHERE plano = 'VIP'");
            
            const workbook = new ExcelJS.Workbook();
            const worksheet = workbook.addWorksheet('Clientes VIP');
            worksheet.columns = [
                { header: 'Telegram ID', key: 'id', width: 20 },
                { header: 'Username', key: 'user', width: 20 },
                { header: 'Plano', key: 'plano', width: 10 },
                { header: 'Data Expiração', key: 'expira', width: 25 },
                { header: 'Cadastrado em', key: 'cadastro', width: 25 }
            ];

            res.rows.forEach(u => {
                worksheet.addRow({
                    id: String(u.telegram_id),
                    user: u.username || 'N/A',
                    plano: u.plano,
                    expira: u.vip_expiracao ? new Date(u.vip_expiracao).toLocaleString('pt-BR') : 'Expirado/Sem Data',
                    cadastro: u.data_cadastro ? new Date(u.data_cadastro).toLocaleString('pt-BR') : '-'
                });
            });

            const filePath = './VIPS_Financeiro.xlsx';
            await workbook.xlsx.writeFile(filePath);
            await bot.sendDocument(chatId, filePath, { caption: "📊 Planilha de controle VIP atualizada." });
            return fs.unlinkSync(filePath);
        }
    }

    if (text === '/start' || text === '⬅️ Voltar') {
        delete estados[userId];
        return bot.sendMessage(chatId, "<b>Financeiro Pro 🚀</b>\nEscolha uma opção:", { parse_mode: 'HTML', ...menuPrincipal });
    }

    if (text === '💎 Plano VIP') {
        return bot.sendMessage(chatId, `👑 <b>MODO VIP ILIMITADO</b>\n\nAssine por <b>R$ 2,50/mês</b>!\n🔑 PIX: <code>d6e581ca-196b-4c5b-a4d4-33947695144e</code>\nEnvie comprovante para @fusca_azul1`, { parse_mode: 'HTML' });
    }

    if (text === '👤 Perfil') {
        const res = await pool.query('SELECT plano, vip_expiracao FROM usuarios WHERE telegram_id = $1', [userId]);
        const count = await pool.query('SELECT COUNT(*) as total FROM transacoes WHERE user_id = $1', [userId]);
        const user = res.rows[0];
        
        let exp = "";
        if (user?.plano === 'VIP' && user.vip_expiracao) {
            const d = new Date(user.vip_expiracao);
            exp = `\n📅 Expira: <b>${d.toLocaleDateString('pt-BR')} às ${d.toLocaleTimeString('pt-BR', {hour: '2-digit', minute:'2-digit'})}</b>`;
        }

        return bot.sendMessage(chatId, `👤 <b>Perfil</b>\nID: <code>${userId}</code>\nPlano: <b>${user?.plano || 'FREE'}</b>${exp}\nRegistros: ${count.rows[0].total}`, { parse_mode: 'HTML' });
    }

    const estado = estados[userId];
    if (!estado) {
        if (text === '💸 Gastei' || text === '💰 Ganhei') {
            const check = await verificarAcesso(userId);
            if (!check.pode) return bot.sendMessage(chatId, check.msg, { parse_mode: 'HTML' });
            estados[userId] = { acao: 'pedir_valor', tipo: text === '💸 Gastei' ? 'saida' : 'entrada' };
            return bot.sendMessage(chatId, "Qual o valor? (Ex: 50.00)", tecladoVoltar);
        }
        if (text === '📊 Gráfico') return enviarGraficoCompleto(chatId, userId);
        if (text === '📄 Relatório') return enviarRelatorio(chatId, userId);
        return bot.sendMessage(chatId, "🤖 Use o menu abaixo:", menuPrincipal);
    }

    if (estado.acao === 'pedir_valor') {
        const v = parseValor(text);
        if (isNaN(v)) return bot.sendMessage(chatId, "⚠️ Valor inválido.", tecladoVoltar);
        estado.valor = v; estado.acao = 'pedir_desc';
        return bot.sendMessage(chatId, "Digite a descrição:", tecladoVoltar);
    }

    if (estado.acao === 'pedir_desc') {
        await pool.query('INSERT INTO transacoes (user_id, tipo, valor, descricao) VALUES ($1, $2, $3, $4)', [userId, estado.tipo, estado.valor, text]);
        bot.sendMessage(chatId, `✅ Salvo: R$${estado.valor.toFixed(2)}`, menuPrincipal);
        delete estados[userId];
    }
});

async function enviarGraficoCompleto(chatId, userId) {
    const res = await pool.query("SELECT tipo, SUM(valor) as total FROM transacoes WHERE user_id = $1 GROUP BY tipo", [userId]);
    if (res.rowCount === 0) return bot.sendMessage(chatId, "Sem dados.");
    let gn = 0, gs = 0; res.rows.forEach(r => { if (r.tipo === 'entrada') gn = parseFloat(r.total); else gs = parseFloat(r.total); });
    const chart = new QuickChart();
    chart.setConfig({ type: 'pie', data: { labels: ['Ganhos', 'Gastos'], datasets: [{ data: [gn, gs], backgroundColor: ['#2ecc71', '#e74c3c'] }] } });
    bot.sendPhoto(chatId, await chart.getShortUrl(), { caption: `💰 Saldo: R$ ${(gn - gs).toFixed(2)}`, parse_mode: 'HTML' });
}

async function enviarRelatorio(chatId, userId) {
    const res = await pool.query("SELECT * FROM transacoes WHERE user_id = $1 ORDER BY data DESC LIMIT 10", [userId]);
    let m = "📋 <b>Últimos Lançamentos:</b>\n\n";
    res.rows.forEach(t => m += `${t.tipo === 'entrada' ? '🟢' : '🔴'} R$${parseFloat(t.valor).toFixed(2)} - ${t.descricao}\n`);
    bot.sendMessage(chatId, m, { parse_mode: 'HTML' });
}

const app = express(); app.get('/', (r, s) => s.send('Online')); app.listen(process.env.PORT || 3000);