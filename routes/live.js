const { GoogleGenAI, Modality } = require('@google/genai');
const pool = require('../db');

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const LIVE_MODEL = 'gemini-3.1-flash-live-preview';

function buildSystemPrompt(artifact) {
    const artifactName = artifact ? artifact.name : 'an unknown artifact';

    return `You are a museum audio guide standing next to a visitor. The visitor is looking at "${artifactName}".

You have ONE job: answer the visitor's question and NOTHING ELSE.

Imagine the visitor asked you this question face-to-face. You would answer it directly, maybe add one interesting related detail, and then stop talking and wait for their next question. That is exactly what you must do here.

DO NOT dump facts. DO NOT give an overview of the artifact. DO NOT mention details the visitor did not ask about. Every sentence you say must be directly relevant to the specific question asked.

Keep it to 2-3 sentences. Speak naturally.`;
}

async function fetchArtifactContext(artifactId) {
    const result = await pool.query(
        'SELECT id, name, context FROM artifacts WHERE name = $1',
        [artifactId]
    );
    return result.rows.length > 0 ? result.rows[0] : null;
}

/**
 * Handles a single WebSocket client connection for live audio streaming.
 * Protocol (Unity ↔ Server):
 *   → { type: "setup", artifactId: "..." }
 *   ← { type: "ready" }
 *   → { type: "audio", data: "<base64 PCM 16kHz mono 16-bit>" }
 *   ← { type: "audio", data: "<base64 PCM 24kHz mono 16-bit>" }
 *   ← { type: "turnComplete" }
 *   ← { type: "interrupted" }
 *   → { type: "interrupt" }
 *   → { type: "text", text: "..." }
 *   ← { type: "error", message: "..." }
 */
async function handleLiveConnection(ws) {
    let geminiSession = null;
    let audioChunkCount = 0;

    ws.on('message', async (raw) => {
        let msg;
        try {
            msg = JSON.parse(raw);
        } catch {
            ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
            return;
        }

        if (msg.type === 'setup') {
            await handleSetup(ws, msg.artifactId, (session) => {
                geminiSession = session;
            });
        } else if (msg.type === 'audio') {
            if (!geminiSession) {
                ws.send(JSON.stringify({ type: 'error', message: 'Session not established. Send setup first.' }));
                return;
            }
            audioChunkCount++;
            if (audioChunkCount === 1 || audioChunkCount % 20 === 0) {
                console.log(`[live] Forwarded audio chunk #${audioChunkCount} (${msg.data?.length || 0} b64 chars) to Gemini`);
            }
            // Forward audio chunk to Gemini Live API
            geminiSession.sendRealtimeInput({
                audio: {
                    data: msg.data,
                    mimeType: 'audio/pcm;rate=16000'
                }
            });
        } else if (msg.type === 'endAudio') {
            if (!geminiSession) return;
            console.log('[live] User finished speaking — signalling audioStreamEnd');
            try {
                geminiSession.sendRealtimeInput({ audioStreamEnd: true });
            } catch (e) {
                console.error('[live] audioStreamEnd failed, falling back to turnComplete:', e.message);
                geminiSession.sendClientContent({ turnComplete: true });
            }
        } else if (msg.type === 'interrupt') {
            if (!geminiSession) return;
            geminiSession.sendClientContent({ turnComplete: true });
        } else if (msg.type === 'text') {
            if (!geminiSession) {
                ws.send(JSON.stringify({ type: 'error', message: 'Session not established. Send setup first.' }));
                return;
            }
            const text = (msg.text || '').trim();
            if (!text) return;
            console.log(`[live] Forwarding text question to Gemini: ${text}`);
            try {
                geminiSession.sendClientContent({
                    turns: [{ role: 'user', parts: [{ text }] }],
                    turnComplete: true
                });
            } catch (e) {
                console.error('[live] sendClientContent(text) failed:', e.message);
                ws.send(JSON.stringify({ type: 'error', message: `Text send failed: ${e.message}` }));
            }
        }
    });

    ws.on('close', () => {
        if (geminiSession) {
            try { geminiSession.close(); } catch { /* ignore */ }
            geminiSession = null;
        }
        console.log('[live] Client disconnected');
    });

    ws.on('error', (err) => {
        console.error('[live] WebSocket error:', err.message);
        if (geminiSession) {
            try { geminiSession.close(); } catch { /* ignore */ }
            geminiSession = null;
        }
    });
}

async function handleSetup(ws, artifactId, onSession) {
    if (!artifactId) {
        ws.send(JSON.stringify({ type: 'error', message: 'Missing artifactId in setup' }));
        return;
    }

    console.log(`[live] Setup requested for artifact: ${artifactId}`);

    const artifact = await fetchArtifactContext(artifactId);
    const systemPrompt = buildSystemPrompt(artifact);

    // Prepend artifact context if available
    let fullPrompt = systemPrompt;
    if (artifact && artifact.context) {
        fullPrompt += `\n\nHere is background context about this artifact (use it to answer questions accurately, but do NOT recite it unprompted):\n${artifact.context}`;
    }

    try {
        const session = await ai.live.connect({
            model: LIVE_MODEL,
            config: {
                responseModalities: [Modality.AUDIO],
                systemInstruction: fullPrompt,
                // googleSearch grounding temporarily disabled to verify base flow.
                // Re-enable once basic audio round-trip works.
                // tools: [{ googleSearch: {} }],
                speechConfig: {
                    voiceConfig: {
                        prebuiltVoiceConfig: { voiceName: 'Kore' }
                    }
                }
            },
            callbacks: {
                onopen: () => {
                    console.log(`[live] Gemini session opened for artifact: ${artifactId}`);
                    ws.send(JSON.stringify({ type: 'ready' }));
                },
                onmessage: (message) => {
                    if (ws.readyState !== ws.OPEN) return;

                    // Verbose: log every message we receive from Gemini so we can see what's happening
                    const summary = {
                        hasData: !!message.data,
                        dataLen: message.data?.length,
                        setupComplete: !!message.setupComplete,
                        modelTurn: !!message.serverContent?.modelTurn,
                        turnComplete: !!message.serverContent?.turnComplete,
                        interrupted: !!message.serverContent?.interrupted,
                        toolCall: !!message.toolCall,
                        text: message.text?.substring(0, 80)
                    };
                    console.log('[live] Gemini → server:', JSON.stringify(summary));

                    // Forward audio data from Gemini to Unity
                    if (message.data) {
                        ws.send(JSON.stringify({
                            type: 'audio',
                            data: message.data
                        }));
                    }

                    if (message.serverContent) {
                        if (message.serverContent.interrupted) {
                            ws.send(JSON.stringify({ type: 'interrupted' }));
                        }
                        if (message.serverContent.turnComplete) {
                            ws.send(JSON.stringify({ type: 'turnComplete' }));
                        }
                    }
                },
                onerror: (e) => {
                    console.error('[live] Gemini session error:', JSON.stringify({
                        message: e?.message,
                        error: e?.error,
                        type: e?.type,
                        raw: String(e)
                    }));
                    if (ws.readyState === ws.OPEN) {
                        ws.send(JSON.stringify({ type: 'error', message: `Gemini error: ${e?.message || 'unknown'}` }));
                    }
                },
                onclose: (e) => {
                    console.log('[live] Gemini session closed:', JSON.stringify({
                        code: e?.code,
                        reason: e?.reason,
                        wasClean: e?.wasClean
                    }));
                    if (ws.readyState === ws.OPEN) {
                        ws.send(JSON.stringify({
                            type: 'error',
                            message: `Gemini closed: code=${e?.code || '?'} reason=${e?.reason || 'none'}`
                        }));
                    }
                }
            }
        });

        onSession(session);
    } catch (err) {
        console.error('[live] Failed to connect to Gemini Live API:', err.message);
        ws.send(JSON.stringify({ type: 'error', message: `Failed to connect: ${err.message}` }));
    }
}

module.exports = { handleLiveConnection };
