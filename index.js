require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const QuickChart = require('quickchart-js');
const { Pool } = require('pg');

const token = process.env.BOT_TOKEN;
const bot = new TelegramBot(token, { polling: true });

// --- CONEXÃO COM BANCO (RENDER/POSTGRES) ---
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
                data_cadastro TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS transacoes (
                id SERIAL PRIMARY KEY,
                user_id BIGINT REFERENCES usuarios(telegram_id),
                tipo TEXT, 
                valor DECIMAL(12,2),
                descricao TEXT,
                data TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log("✅ Banco de Dados SQL conectado e blindado.");
    } catch (err) {
        console.error("❌ Erro ao conectar ao banco:", err);
    }
}
setupDB();

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
    const res = await pool.query('SELECT plano FROM usuarios WHERE telegram_id = $1', [userId]);
    const plano = res.rows[0]?.plano || 'FREE';

    if (plano === 'VIP') return { pode: true, plano: 'VIP' };

    const contagem = await pool.query('SELECT COUNT(*) as total FROM transacoes WHERE user_id = $1', [userId]);
    const totalRegistros = parseInt(contagem.rows[0].total);

    const LIMITE_FREE = 15; 

    if (totalRegistros >= LIMITE_FREE) {
        return { 
            pode: false, 
            msg: `🔒 <b>Limite Atingido!</b>\n\nVocê já usou seus ${LIMITE_FREE} registros gratuitos. Seu ID <code>${userId}</code> atingiu o teto do plano Free.\n\nPara continuar, torne-se <b>VIP</b>!` 
        };
    }
    return { pode: true, plano: 'FREE', total: totalRegistros };
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

    // Registrar usuário se não existir
    await pool.query('INSERT INTO usuarios (telegram_id, username) VALUES ($1, $2) ON CONFLICT (telegram_id) DO UPDATE SET username = $2', [userId, msg.from.username || 'Usuario']);

    // Comando de Voltar ou Start cancela qualquer ação em andamento
    if (text === '/start' || text === '⬅️ Voltar') {
        delete estados[userId];
        return bot.sendMessage(chatId, "<b>Financeiro Pro 🚀</b>\nOlá! O que vamos registrar agora? Escolha uma opção abaixo:", { parse_mode: 'HTML', ...menuPrincipal });
    }

    if (text === '💎 Plano VIP') {
        return bot.sendMessage(chatId, 
            `👑 <b>MODO VIP ILIMITADO</b>\n\n` +
            `Assine para remover todas as travas do seu ID <code>${userId}</code>.\n\n` +
            `🔑 <b>PIX:</b> <code>d6e581ca-196b-4c5b-a4d4-33947695144e</code>\n\n` +
            `Envie o comprovante para @fusca_azul1`, 
            { parse_mode: 'HTML' }
        );
    }

    if (text === '👤 Perfil') {
        const res = await pool.query('SELECT plano FROM usuarios WHERE telegram_id = $1', [userId]);
        const count = await pool.query('SELECT COUNT(*) as total FROM transacoes WHERE user_id = $1', [userId]);
        const plano = res.rows[0]?.plano || 'FREE';
        return bot.sendMessage(chatId, 
            `👤 <b>Seu Perfil</b>\n\n` +
            `ID: <code>${userId}</code>\n` +
            `Plano: <b>${plano}</b>\n` +
            `Total de registros: ${count.rows[0].total}`, 
            { parse_mode: 'HTML' }
        );
    }

    const estado = estados[userId];

    // SE O USUÁRIO NÃO ESTIVER NO MEIO DE UMA AÇÃO
    if (!estado) {
        if (text === '💸 Gastei' || text === '💰 Ganhei') {
            const check = await verificarAcesso(userId);
            if (!check.pode) return bot.sendMessage(chatId, check.msg, { parse_mode: 'HTML' });

            estados[userId] = { acao: 'pedir_valor', tipo: text === '💸 Gastei' ? 'saida' : 'entrada' };
            return bot.sendMessage(chatId, `Legal! Me diga qual foi o valor.\nExemplo: <code>50.00</code> ou <code>150.50</code>`, { parse_mode: 'HTML', ...tecladoVoltar });
        }
        
        if (text === '📊 Gráfico') return enviarGraficoCompleto(chatId, userId);
        if (text === '📄 Relatório') return enviarRelatorio(chatId, userId);

        // RESPOSTA PADRÃO (FALLBACK) - Impede que o bot fique mudo
        return bot.sendMessage(chatId, "🤖 Ops, não entendi! Por favor, use os botões do menu abaixo para conversarmos:", menuPrincipal);
    }

    // SE O USUÁRIO ESTIVER DIGITANDO O VALOR
    if (estado?.acao === 'pedir_valor') {
        const v = parseValor(text);
        if (isNaN(v)) return bot.sendMessage(chatId, "⚠️ Valor inválido. Digite apenas números, como 50.00 ou 100", tecladoVoltar);
        
        estado.valor = v;
        estado.acao = 'pedir_desc';
        return bot.sendMessage(chatId, "Ótimo! Agora digite uma breve descrição para esse lançamento (Ex: Mercado, Salário, Conta de Luz):", tecladoVoltar);
    }

    // SE O USUÁRIO ESTIVER DIGITANDO A DESCRIÇÃO
    if (estado?.acao === 'pedir_desc') {
        const checkFinal = await verificarAcesso(userId);
        if (!checkFinal.pode) {
            delete estados[userId];
            return bot.sendMessage(chatId, checkFinal.msg, { parse_mode: 'HTML' });
        }

        await pool.query('INSERT INTO transacoes (user_id, tipo, valor, descricao) VALUES ($1, $2, $3, $4)', 
            [userId, estado.tipo, estado.valor, text]);
        
        const emoji = estado.tipo === 'entrada' ? '🟢' : '🔴';
        bot.sendMessage(chatId, `${emoji} Sucesso! Lançamento de <b>R$${estado.valor.toFixed(2)}</b> (${text}) foi salvo!`, { parse_mode: 'HTML', ...menuPrincipal });
        delete estados[userId]; // Limpa o estado para voltar ao menu
    }
});

// --- FUNÇÕES DE GRÁFICO E RELATÓRIO ---
async function enviarGraficoCompleto(chatId, userId) {
    try {
        const res = await pool.query("SELECT tipo, SUM(valor) as total FROM transacoes WHERE user_id = $1 GROUP BY tipo", [userId]);
        
        if (res.rowCount === 0) return bot.sendMessage(chatId, "Você ainda não tem dados para gerar gráficos. Registre algo primeiro!");

        let ganhos = 0;
        let gastos = 0;

        res.rows.forEach(row => {
            if (row.tipo === 'entrada') ganhos = parseFloat(row.total);
            if (row.tipo === 'saida') gastos = parseFloat(row.total);
        });

        const saldo = ganhos - gastos;

        const chart = new QuickChart();
        chart.setConfig({
            type: 'pie',
            data: {
                labels: ['Ganhos', 'Gastos'],
                datasets: [{ 
                    data: [ganhos, gastos], 
                    backgroundColor: ['#2ecc71', '#e74c3c'] 
                }]
            },
            options: {
                plugins: {
                    legend: { position: 'bottom', labels: { fontSize: 18 } }
                }
            }
        }).setWidth(500).setHeight(350);

        const url = await chart.getShortUrl();

        const mensagemTexto = `📊 <b>SEU RESUMO FINANCEIRO</b>\n\n` +
            `🟢 <b>Total Ganhos:</b> R$ ${ganhos.toFixed(2)}\n` +
            `🔴 <b>Total Gastos:</b> R$ ${gastos.toFixed(2)}\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `💰 <b>SALDO ATUAL:</b> R$ ${saldo.toFixed(2)}\n\n` +
            `<i>Status: ${saldo >= 0 ? 'Conta no azul! ✅' : 'Cuidado com as dívidas! ⚠️'}</i>`;

        await bot.sendPhoto(chatId, url, { 
            caption: mensagemTexto, 
            parse_mode: 'HTML' 
        });

    } catch (e) {
        console.error("Erro no gráfico:", e);
        bot.sendMessage(chatId, "Erro ao processar dados do gráfico. Tente novamente.");
    }
}

async function enviarRelatorio(chatId, userId) {
    const res = await pool.query("SELECT * FROM transacoes WHERE user_id = $1 ORDER BY data DESC LIMIT 10", [userId]);
    if (res.rowCount === 0) return bot.sendMessage(chatId, "Seu histórico está vazio. Comece a registrar seus ganhos e gastos!");

    let m = "📋 <b>Últimos 10 Lançamentos:</b>\n\n";
    res.rows.forEach(t => {
        const icone = t.tipo === 'entrada' ? '🟢' : '🔴';
        m += `${icone} R$${parseFloat(t.valor).toFixed(2)} - ${t.descricao}\n`;
    });
    bot.sendMessage(chatId, m, { parse_mode: 'HTML' });
}

// Servidor para manter vivo
const app = express();
app.get('/', (req, res) => res.send('Bot Financeiro Online'));
app.listen(process.env.PORT || 3000);