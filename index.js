const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const { GoogleGenAI } = require('@google/genai');
const pino = require('pino');
const express = require('express');
const qrcode = require('qrcode');

// 🌐 啟動簡單的 Express 網頁伺服器
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.send('🌱 Pikmin Bot is running smoothly!');
});

app.listen(PORT, () => {
    console.log(`🌐 網頁伺服器已成功在 Port ${PORT} 上啟動`);
});

// 🔑 從環境變數安全讀取 API Key (若讀不到可直接填入雙引號內測試)
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

// 📌 你的群組 ID 設定
const GROUPS = {
    MUSHROOM: '120363411620446782@g.us', // 🍄 菇勇者
    CAFE: '120363429454802566@g.us',     // ☕️ 皮克敏悠閒咖啡室
    FLYER: '120363409915956994@g.us',    // 🍑 飛人專用
    ADMIN: '120363428639707848@g.us'     // 🛡️ Admin 管理員群組
};

// 🤖 香港專屬皮克敏 AI System Prompt
const PIKMIN_SYSTEM_PROMPT = `
你是一位專屬於香港《皮克敏 Bloom》(Pikmin Bloom) 玩家群組的智慧助手，名叫「皮克敏小管家」。
你的任務是協助香港玩家解答遊戲相關問題、提供本地攻略建議、說明活動規則，並保持親切熱情的態度。
回答請簡潔明瞭、使用道地的香港繁體中文與粵語習慣用語，並適當加上可愛的 emoji（如 🍄, 🌸, 🌱, 🚶‍♂️, 🇭🇰）。
`;

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_qr');
    
    const sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        auth: state,
        // 🔄 改用 Windows Desktop 瀏覽器特徵，避開 428 錯誤防護
        browser: Browsers.windows('Desktop'),
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
            console.log('\n📱 成功取得 QR Code！正在產生高畫質圖片...');
            try {
                await qrcode.toFile('qrcode.png', qr, { width: 400, margin: 2 });
                console.log('✅ 「qrcode.png」圖片已更新！請到資料夾打開它並用手機掃描！');
            } catch (err) {
                console.error('❌ 產生 QR Code 圖片失敗:', err);
            }
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            console.log(`❌ 連線關閉，錯誤代碼: ${statusCode}`);
            
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                console.log('⏳ 3 秒後自動重新嘗試連線...');
                setTimeout(() => connectToWhatsApp(), 3000);
            } else {
                console.log('🚫 裝置已被登出，請刪除 auth_info_qr 資料夾後重試。');
            }
        } else if (connection === 'open') {
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

        console.log(`[收到訊息] 群組: ${remoteJid}`);
        console.log(`[訊息內容]: "${messageContent}"`);

        if (messageContent === '!id' || messageContent === '！id') {
            await sock.sendMessage(remoteJid, { text: `🔑 本群組 ID：${remoteJid}` }, { quoted: m });
            return;
        }

        if (remoteJid === GROUPS.CAFE || remoteJid === GROUPS.ADMIN) {
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
        }
    });
}

connectToWhatsApp();