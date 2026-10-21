const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { GoogleGenAI } = require('@google/genai');
const pino = require('pino');

// 🔑 從環境變數安全讀取 API Key (之後在 Koyeb 後台設定)
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

// 📌 你的三個群組 ID 設定
const GROUPS = {
    MUSHROOM: '120363411620446782@g.us', // 🍄 菇勇者 (禁聊天/僅指令)
    CAFE: '120363429454802566@g.us',     // ☕️ 皮克敏悠閒咖啡室 (AI 智慧問答/聊天)
    FLYER: '120363409915956994@g.us'     // 🍑 飛人專用 (禁聊天/僅指令)
};

// 🤖 皮克敏專屬 AI System Prompt
const PIKMIN_SYSTEM_PROMPT = `
你是一位專屬於《皮克敏 Bloom》(Pikmin Bloom) 玩家群組的智慧助手，名叫「皮克敏小管家」。
你的任務是協助玩家解答遊戲相關問題、提供攻略建議、說明活動規則，並保持親切熱情的態度。
回答請簡潔明瞭、使用繁體中文，適當加上可愛的 emoji（如 🍄, 🌸, 🌱, 🚶‍♂️）。
`;

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    
    const sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        auth: state
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) connectToWhatsApp();
        } else if (connection === 'open') {
            console.log('\n========================================');
            console.log('✅ 皮克敏 AI 機器人已成功連線上線！');
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

        // 🎯 2. ☕️ 皮克敏悠閒咖啡室
        if (remoteJid === GROUPS.CAFE) {
            const isCommand = messageContent.startsWith('!') || messageContent.startsWith('！');

            if (isCommand && messageContent.length > 1) {
                const query = messageContent.substring(1).trim();
                console.log(`🤖 準備呼叫 Gemini AI，查詢內容: "${query}"`);
                
                try {
                    await sock.sendPresenceUpdate('composing', remoteJid);
                    
                    const response = await ai.models.generateContent({
                        model: 'gemini-3.8-flash',
                        contents: query,
                        config: {
                            systemInstruction: PIKMIN_SYSTEM_PROMPT
                        }
                    });

                    console.log('✨ AI 回應成功，傳送至群組...');
                    await sock.sendMessage(remoteJid, { text: response.text }, { quoted: m });
                } catch (err) {
                    console.error('❌ Gemini API 發生錯誤:', err);
                    await sock.sendMessage(remoteJid, { text: '🌱 抱歉，皮克敏小管家剛才腦袋塞住了，請稍後再試一次！' }, { quoted: m });
                }
            } else {
                console.log('ℹ️ 訊息非 ! 開頭，忽略不處理');
            }
        }
    });
}

connectToWhatsApp();