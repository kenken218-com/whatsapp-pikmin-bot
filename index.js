const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const { GoogleGenAI } = require('@google/genai');
const pino = require('pino');
const express = require('express');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');

process.on('uncaughtException', (err) => {
    console.error('💥 [Uncaught Exception 嚴重錯誤]:', err.stack || err.message);
});

process.on('unhandledRejection', (reason) => {
    console.error('💥 [Unhandled Rejection 未處理拒絕]:', reason);
});

const app = express();
const PORT = process.env.PORT || 3000;

let latestQR = '';
let isConnected = false;
const AUTH_DIR = path.join(__dirname, 'auth_info_qr');

const GROUPS = {
    MUSHROOM: '120363411620446782@g.us',
    CAFE: '120363429454802566@g.us',
    FLYER: '120363409915956994@g.us',
    ADMIN: '120363428639707848@g.us',
    RICE: '120363428639707848@g.us' // 暫時代替，後續可改
};

app.get('/', (req, res) => {
    if (latestQR) {
        res.send(`
            <html>
                <head>
                    <title>WhatsApp Bot QR Code</title>
                    <meta http-equiv="refresh" content="3">
                </head>
                <body style="text-align: center; margin-top: 50px; font-family: sans-serif;">
                    <h2>🌱 請使用 WhatsApp 掃描下方 QR Code 登入</h2>
                    <img src="${latestQR}" alt="QR Code" style="width: 300px; height: 300px; border: 5px solid #ccc; border-radius: 10px;" />
                </body>
            </html>
        `);
    } else if (isConnected) {
        res.send('<h2>🌱 Pikmin Bot 已成功連線，穩定運行中！</h2>');
    } else {
        res.send('<h2>⏳ Bot 初始化中，請稍後...</h2>');
    }
});

app.listen(PORT, () => {
    console.log(`🌐 [Web Server] 網頁伺服器已啟動於 Port ${PORT}`);
});

// 💓 縮短為每 15 秒一次心跳，確保主執行緒有沒有被卡死
setInterval(() => {
    const memory = process.memoryUsage();
    const rssMB = (memory.rss / 1024 / 1024).toFixed(1);
    console.log(`💓 [Heartbeat 探針] 程式運行正常中... 連線狀態: ${isConnected ? '🟢 已連線' : '🔴 斷線中'} | 記憶體: ${rssMB} MB`);
}, 15000);

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

const PIKMIN_SYSTEM_PROMPT = `
你是一位專屬香港《皮克敏 Bloom》(Pikmin Bloom) 玩家群組的智慧助手，名叫「皮克敏小管家」。
回答請簡潔明瞭、使用道地的香港繁體中文與粵語習慣用語，並適當加上可愛的 emoji（如 🍄, 🌸, 🌱, 🇭🇰）。
`;

async function connectToWhatsApp() {
    console.log('🚀 [Init] 正在載入 WhatsApp 認證狀態...');
    
    let state, saveCreds;
    try {
        const auth = await useMultiFileAuthState(AUTH_DIR);
        state = auth.state;
        saveCreds = auth.saveCreds;
    } catch (e) {
        console.error('⚠️ 載入認證失敗，重建資料夾:', e);
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        const auth = await useMultiFileAuthState(AUTH_DIR);
        state = auth.state;
        saveCreds = auth.saveCreds;
    }
    
    const sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        auth: state,
        browser: Browsers.ubuntu('Chrome'),
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 15000,
        markOnlineOnConnect: true,
        syncFullHistory: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.process(async (events) => {
        try {
            if (events['connection.update']) {
                const update = events['connection.update'];
                const { connection, lastDisconnect, qr } = update;
                
                console.log('🔄 [Connection Update 狀態更新]:', { 
                    connection, 
                    hasQR: !!qr, 
                    statusCode: lastDisconnect?.error?.output?.statusCode 
                });

                if (qr) {
                    latestQR = await qrcode.toDataURL(qr);
                    console.log('📱 [QR Code] 已產生新的 QR Code！');
                }

                if (connection === 'close') {
                    isConnected = false;
                    const statusCode = lastDisconnect?.error?.output?.statusCode;
                    console.log(`❌ [連線中斷] 錯誤代碼: ${statusCode}`);
                    
                    if (statusCode === 428 || statusCode === DisconnectReason.loggedOut || statusCode === 401) {
                        console.log('🚨 憑證失效，清除資料夾...');
                        try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch (e) {}
                    }

                    console.log('⏳ 3 秒後自動重新連線...');
                    setTimeout(() => connectToWhatsApp(), 3000);

                } else if (connection === 'open') {
                    latestQR = '';
                    isConnected = true;
                    console.log('✅ [連線成功] 皮克敏 AI 機器人已成功上線！');
                }
            }

            if (events['messages.upsert']) {
                const upsert = events['messages.upsert'];
                console.log(`📥 [收到訊息事件] 類型: ${upsert.type}, 筆數: ${upsert.messages.length}`);

                for (const m of upsert.messages) {
                    if (!m.message || m.key.fromMe) continue;

                    const remoteJid = m.key.remoteJid;
                    const messageContent = (
                        m.message.conversation || 
                        m.message.extendedTextMessage?.text || 
                        m.message.imageMessage?.caption || 
                        ''
                    ).trim();

                    if (!messageContent) continue;
                    console.log(`💬 [訊息內容] 來自 ${remoteJid}: "${messageContent}"`);

                    if (messageContent === '!id' || messageContent === '！id') {
                        await sock.sendMessage(remoteJid, { text: `🔑 本群組 ID：\n${remoteJid}` }, { quoted: m });
                        continue;
                    }

                    const isAllowedAIgroup = (
                        remoteJid === GROUPS.CAFE || 
                        remoteJid === GROUPS.ADMIN || 
                        remoteJid === GROUPS.RICE
                    );
                    
                    if (!isAllowedAIgroup) {
                        console.log(`🛡️ [略過] 非 AI 授權群組: ${remoteJid}`);
                        continue;
                    }

                    const isCommand = messageContent.startsWith('!') || messageContent.startsWith('！');
                    if (isCommand && messageContent.length > 1) {
                        const query = messageContent.substring(1).trim();
                        console.log(`🤖 [AI 請求觸發] 查詢內容: "${query}"`);
                        
                        try {
                            await sock.sendPresenceUpdate('composing', remoteJid);
                            
                            const response = await ai.models.generateContent({
                                model: 'gemini-2.5-flash',
                                contents: query,
                                config: { systemInstruction: PIKMIN_SYSTEM_PROMPT }
                            });

                            const replyText = response.text || '🌱 收到！';
                            console.log('✨ [AI 回應成功] 傳送中...');
                            await sock.sendMessage(remoteJid, { text: replyText }, { quoted: m });
                        } catch (err) {
                            console.error('❌ [AI 呼叫失敗]:', err.message);
                            await sock.sendMessage(remoteJid, { 
                                text: '🌱 哎呀，皮克敏小管家頭先個腦袋塞咗一下，不如陣間再試過啦！' 
                            }, { quoted: m });
                        }
                    }
                }
            }
        } catch (err) {
            console.error('⚠️ [事件處理發生例外]:', err);
        }
    });
}

connectToWhatsApp();