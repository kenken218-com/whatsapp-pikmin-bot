const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const { GoogleGenAI } = require('@google/genai');
const pino = require('pino');
const express = require('express');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

let latestQR = '';
const AUTH_DIR = path.join(__dirname, 'auth_info_qr');

app.get('/', (req, res) => {
    if (latestQR) {
        res.send(`
            <html>
                <head>
                    <title>WhatsApp Bot QR Code</title>
                    <meta http-equiv="refresh" content="5">
                </head>
                <body style="text-align: center; margin-top: 50px; font-family: sans-serif;">
                    <h2>🌱 請使用 WhatsApp 掃描下方 QR Code 登入</h2>
                    <p>（畫面每 5 秒會自動更新）</p>
                    <img src="${latestQR}" alt="QR Code" style="width: 300px; height: 300px; border: 5px solid #ccc; border-radius: 10px;" />
                </body>
            </html>
        `);
    } else {
        res.send('<h2>🌱 Pikmin Bot 已成功連線，目前運行中！</h2>');
    }
});

app.listen(PORT, () => {
    console.log(`🌐 網頁伺服器已成功在 Port ${PORT} 上啟動`);
});

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

const PIKMIN_SYSTEM_PROMPT = `
你是一位專屬於香港《皮克敏 Bloom》(Pikmin Bloom) 玩家群組的智慧助手，名叫「皮克敏小管家」。
你的任務是協助香港玩家解答遊戲相關問題、提供本地攻略建議、說明活動規則，並保持親切熱情的態度。
回答請簡潔明瞭、使用道地的香港繁體中文與粵語習慣用語，並適當加上可愛的 emoji（如 🍄, 🌸, 🌱, 🚶‍♂️, 🇭🇰）。
`;

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    
    const sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        auth: state,
        browser: Browsers.ubuntu('Chrome'), // 改用 Ubuntu Chrome 模擬，提升雲端相容性
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 25000,
        markOnlineOnConnect: true,
        syncFullHistory: false
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        console.log('🔄 連線狀態更新:', { connection, hasQR: !!qr, statusCode: lastDisconnect?.error?.output?.statusCode });

        if (qr) {
            latestQR = await qrcode.toDataURL(qr);
            console.log('\n📱 已更新 QR Code 網頁圖片！\n');
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            console.log(`❌ 連線關閉，錯誤代碼: ${statusCode}`);
            
            // 若遇到 428 或 401，代表 Session 已失效，強制刪除舊憑證以重新抓取 QR Code
            if (statusCode === 428 || statusCode === DisconnectReason.loggedOut || statusCode === 401) {
                console.log('🚨 憑證已失效，正在清除憑證資料夾以重新產生 QR Code...');
                try {
                    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
                } catch (e) {
                    console.error('清除憑證失敗:', e);
                }
            }

            console.log('⏳ 3 秒後自動重新嘗試連線...');
            setTimeout(() => connectToWhatsApp(), 3000);

        } else if (connection === 'open') {
            latestQR = '';
            console.log('\n========================================');
            console.log('✅ 皮克敏 AI 機器人 (香港版) 已成功連線上線！');
            console.log('========================================\n');
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const m = messages[0];
        if (!m.message || m.key.fromMe) return;

        const remoteJid = m.key.remoteJid;
        
        const messageContent = (
            m.message.conversation || 
            m.message.extendedTextMessage?.text || 
            m.message.imageMessage?.caption || 
            ''
        ).trim();

        if (!messageContent) return;

        console.log(`\n📢 收到來自 [${remoteJid}] 的訊息: "${messageContent}"`);

        if (messageContent === '!id' || messageContent === '！id') {
            await sock.sendMessage(remoteJid, { text: `🔑 本群組 ID：${remoteJid}` }, { quoted: m });
            return;
        }

        const isCommand = messageContent.startsWith('!') || messageContent.startsWith('！');

        if (isCommand && messageContent.length > 1) {
            const query = messageContent.substring(1).trim();
            console.log(`🤖 準備呼叫 Gemini AI，查詢內容: "${query}"`);
            
            try {
                await sock.sendPresenceUpdate('composing', remoteJid);
                
                const aiPromise = ai.models.generateContent({
                    model: 'gemini-2.5-flash',
                    contents: query,
                    config: {
                        systemInstruction: PIKMIN_SYSTEM_PROMPT
                    }
                });

                const timeoutPromise = new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('AI Request Timeout')), 50000)
                );

                const response = await Promise.race([aiPromise, timeoutPromise]);

                console.log('✨ AI 回應成功，傳送至群組...');
                await sock.sendMessage(remoteJid, { text: response.text }, { quoted: m });
            } catch (err) {
                console.error('❌ Gemini API 發生錯誤或逾時:', err);
                await sock.sendMessage(remoteJid, { text: '🌱 哎呀，皮克敏小管家頭先個腦袋塞咗一下，不如陣間再試過啦！' }, { quoted: m });
            }
        }
    });
}

connectToWhatsApp();