const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { GoogleGenAI } = require('@google/genai');
const pino = require('pino');
const express = require('express');

// 🌐 啟動簡單的 Express 網頁伺服器，用來應付 Render 的 Port 掃描與 UptimeRobot 心跳監控
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.send('🌱 Pikmin Bot is running smoothly!');
});

app.listen(PORT, () => {
    console.log(`🌐 網頁伺服器已成功在 Port ${PORT} 上啟動`);
});

// 🔑 從環境變數安全讀取 API Key
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

// 📌 你的群組 ID 設定（已新增 Admin 群組）
const GROUPS = {
    MUSHROOM: '120363411620446782@g.us', // 🍄 菇勇者 (禁聊天/僅指令)
    CAFE: '120363429454802566@g.us',     // ☕️ 皮克敏悠閒咖啡室 (AI 智慧問答/聊天)
    FLYER: '120363409915956994@g.us',    // 🍑 飛人專用 (禁聊天/僅指令)
    ADMIN: '120363428639707848@g.us' // 🛡️ Admin 管理員群組 (AI 智慧問答/聊天)
};

// 🤖 香港專屬皮克敏 AI System Prompt
const PIKMIN_SYSTEM_PROMPT = `
你是一位專屬於香港《皮克敏 Bloom》(Pikmin Bloom) 玩家群組的智慧助手，名叫「皮克敏小管家」。
你的任務是協助香港玩家解答遊戲相關問題、提供本地攻略建議、說明活動規則，並保持親切熱情的態度。
回答請簡潔明瞭、使用道地的香港繁體中文與粵語習慣用語，並適當加上可愛的 emoji（如 🍄, 🌸, 🌱, 🚶‍♂️, 🇭🇰）。
`;

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys2');
    
    const sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        auth: state,
        browser: ['Chrome (Linux)', 'Chrome', '120.0.0.0']
    });

    // 📱 電話號碼配對碼機制
    if (!sock.authState.creds.registered) {
        // ⚠️ 請把下面引號內的號碼改成你的機器人 WhatsApp 電話號碼（例如 "85212345678"）
        const phoneNumber = "85251180937"; 
        
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(phoneNumber);
                console.log('\n========================================');
                console.log(`📱 你的 WhatsApp 配對碼是: ${code}`);
                console.log('請在手機 WhatsApp 點選「已連結的裝置」 -> 「連結裝置」 -> 「改用電話號碼連結」輸入此代碼！');
                console.log('========================================\n');
            } catch (err) {
                console.error('❌ 請求配對碼失敗:', err);
            }
        }, 50000);
    }

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('connection closed, reconnecting:', shouldReconnect);
            if (shouldReconnect) {
                connectToWhatsApp();
            } else {
                console.log('❌ 帳號已被登出，請清除授權資料夾重新配對。');
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
        
        // 🔍 廣泛解析訊息文字（相容半形 ! 與全形 ！）
        const messageContent = (
            m.message.conversation || 
            m.message.extendedTextMessage?.text || 
            m.message.imageMessage?.caption || 
            ''
        ).trim();

        if (!messageContent) return;

        console.log(`[收到訊息] 群組: ${remoteJid}`);
        console.log(`[訊息內容]: "${messageContent}"`);

        // 🎯 1. 基礎指令 (!id)
        if (messageContent === '!id' || messageContent === '！id') {
            await sock.sendMessage(remoteJid, { text: `🔑 本群組 ID：${remoteJid}` }, { quoted: m });
            return;
        }

        // 🎯 2. ☕️ 咖啡室 與 🛡️ Admin 群組共用 AI 智慧問答邏輯
        if (remoteJid === GROUPS.CAFE || remoteJid === GROUPS.ADMIN) {
            const isCommand = messageContent.startsWith('!') || messageContent.startsWith('！');

            if (isCommand && messageContent.length > 1) {
                const query = messageContent.substring(1).trim();
                console.log(`🤖 準備呼叫 Gemini AI，查詢內容: "${query}"`);
                
                try {
                    await sock.sendPresenceUpdate('composing', remoteJid);
                    
                    // ⏱️ 建立 10 秒逾時保護機制
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
            } else {
                console.log('ℹ️ 訊息非 ! 開頭，忽略不處理');
            }
        }
    });
}

connectToWhatsApp();
