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
let isConnected = false;
const AUTH_DIR = path.join(__dirname, 'auth_info_qr');

// 🛡️ 四個主要群組 ID 定義
const GROUPS = {
    MUSHROOM: '120363411620446782@g.us',
    CAFE: '120363429454802566@g.us',
    FLYER: '120363409915956994@g.us',
    ADMIN: '120363428639707848@g.us'
};

// 🌐 Express 網頁伺服器
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
    } else if (isConnected) {
        res.send('<h2>🌱 Pikmin Bot 已成功連線，目前穩定運行中！</h2>');
    } else {
        res.send('<h2>⏳ Bot 正在初始化連線，請稍後重整...</h2>');
    }
});

app.listen(PORT, () => {
    console.log(`🌐 [Web Server] 網頁伺服器已成功在 Port ${PORT} 上啟動`);
});

// 💓 心跳機制：每 30 秒確認容器運作正常
setInterval(() => {
    const memory = process.memoryUsage();
    const rssMB = (memory.rss / 1024 / 1024).toFixed(2);
    console.log(`💓 [Heartbeat] Bot 運作中... 連線狀態: ${isConnected ? '🟢 已連線' : '🔴 斷線中'} | 記憶體使用: ${rssMB} MB`);
}, 30000);

// 🤖 Gemini AI 設定
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

const PIKMIN_SYSTEM_PROMPT = `
你是一位專屬香港《皮克敏 Bloom》(Pikmin Bloom) 玩家群組的智慧助手，名叫「皮克敏小管家」。
你的任務是協助香港玩家解答遊戲相關問題、提供本地攻略建議、說明活動規則，並保持親切熱情的態度。
回答請簡潔明瞭、使用道地的香港繁體中文與粵語習慣用語，並適當加上可愛的 emoji（如 🍄, 🌸, 🌱, 🚶‍♂️, 🇭🇰）。
`;

async function connectToWhatsApp() {
    console.log('🚀 [Init] 正在讀取登入憑證與建立 Socket 連線...');
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    
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
        if (events['connection.update']) {
            const update = events['connection.update'];
            const { connection, lastDisconnect, qr } = update;
            
            console.log('🔄 [Connection Update]', { 
                connection, 
                hasQR: !!qr, 
                statusCode: lastDisconnect?.error?.output?.statusCode 
            });

            if (qr) {
                latestQR = await qrcode.toDataURL(qr);
                console.log('📱 [QR Code] 已產生新的 QR Code，請至網頁掃描！');
            }

            if (connection === 'close') {
                isConnected = false;
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                console.log(`❌ [Connection Closed] 連線斷開，錯誤代碼: ${statusCode}`);
                
                if (statusCode === 428 || statusCode === DisconnectReason.loggedOut || statusCode === 401) {
                    console.log('🚨 [Auth Clean] 憑證無效或衝突，清除憑證資料夾以重置...');
                    try {
                        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
                    } catch (e) {
                        console.error('清除憑證資料夾失敗:', e);
                    }
                }

                console.log('⏳ [Reconnect] 3 秒後自動重新嘗試連線...');
                setTimeout(() => connectToWhatsApp(), 3000);

            } else if (connection === 'open') {
                latestQR = '';
                isConnected = true;
                console.log('\n========================================');
                console.log('✅ 皮克敏 AI 機器人 (香港版) 已成功連線上線！');
                console.log('========================================\n');

                try {
                    const groups = await sock.groupFetchAllParticipating();
                    console.log(`📂 [Groups Loaded] 成功同步，目前參與群組數量: ${Object.keys(groups).length}`);
                } catch (err) {
                    console.error('⚠️ [Groups Load Error] 抓取群組清單失敗:', err);
                }
            }
        }

        if (events['messages.upsert']) {
            const upsert = events['messages.upsert'];
            console.log(`🔥 [Event: messages.upsert] 收到訊息推播！型態: ${upsert.type}, 訊息筆數: ${upsert.messages.length}`);

            for (const m of upsert.messages) {
                if (!m.message || m.key.fromMe) continue;

                const remoteJid = m.key.remoteJid;
                const messageContent = (
                    m.message.conversation || 
                    m.message.extendedTextMessage?.text || 
                    m.message.imageMessage?.caption || 
                    ''
                ).trim();

                console.log(`📢 [New Message] 來自 JID: ${remoteJid}`);
                console.log(`💬 [Message Text]: "${messageContent}"`);

                if (!messageContent) continue;

                // 測試指令: !id (任何地方打都能回傳 JID 讓你確認)
                if (messageContent === '!id' || messageContent === '！id') {
                    await sock.sendMessage(remoteJid, { text: `🔑 本群組 ID：${remoteJid}` }, { quoted: m });
                    continue;
                }

                // 🔒 權限控制：只有 CAFE 和 ADMIN 群組才允許 AI 回應
                const isAllowedAIgroup = (remoteJid === GROUPS.CAFE || remoteJid === GROUPS.ADMIN);
                
                if (!isAllowedAIgroup) {
                    console.log(`🛡️ [AI Blocked] 來自非 AI 授權群組，略過 AI 回應。`);
                    continue;
                }

                // AI 觸發（只有 Coffee 和 Admin 群組且帶有驚嘆號才會到這裡）
                const isCommand = messageContent.startsWith('!') || messageContent.startsWith('！');
                if (isCommand && messageContent.length > 1) {
                    const query = messageContent.substring(1).trim();
                    console.log(`🤖 [AI Start] 準備在授權群組呼叫 Gemini AI，內容: "${query}"`);
                    
                    try {
                        await sock.sendPresenceUpdate('composing', remoteJid);
                        
                        const response = await ai.models.generateContent({
                            model: 'gemini-2.5-flash',
                            contents: query,
                            config: {
                                systemInstruction: PIKMIN_SYSTEM_PROMPT
                            }
                        });

                        console.log('✨ [AI Success] 成功回傳 AI 結果，準備發送至 WhatsApp...');
                        await sock.sendMessage(remoteJid, { text: response.text }, { quoted: m });
                    } catch (err) {
                        console.error('❌ [AI Error] Gemini API 發生錯誤:', err);
                        await sock.sendMessage(remoteJid, { 
                            text: '🌱 哎呀，皮克敏小管家頭先個腦袋塞咗一下，不如陣間再試過啦！' 
                        }, { quoted: m });
                    }
                }
            }
        }
    });
}

connectToWhatsApp();