const express = require('express');
const { GoogleGenAI } = require('@google/genai');
const pool = require('../db');

const router = express.Router();
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const TRANSCRIPTION_MODEL = 'gemini-2.5-flash';
const GENERATION_MODEL = 'gemini-2.5-flash';
const TTS_MODEL = 'gemini-2.5-flash-preview-tts';

// Shared handler for both audio and text input
async function handleAskRequest(artifactId, questionText, imageBase64, res) {
    // Look up artifact context (optional — may not exist for unknown artifacts)
    const artifactResult = await pool.query(
        'SELECT id, name, context FROM artifacts WHERE name = $1',
        [artifactId]
    );
    const artifact = artifactResult.rows.length > 0 ? artifactResult.rows[0] : null;

    // Step B: Check cache for similar question (only if artifact exists in DB)
    if (artifact) {
        const cached = await checkCache(artifact.id, questionText);
        if (cached) {
            console.log(`[ask] Cache hit for artifact ${artifactId}`);
            res.set('Content-Type', 'audio/wav');
            return res.send(cached.audio_response);
        }
    }

    // Step C: Generate grounded response with optional screenshot
    const responseText = await generateGroundedResponse(artifact, artifactId, questionText, imageBase64);
    console.log(`[ask] Generated response: "${responseText.substring(0, 100)}..."`);

    // Step C.2: Convert response text to audio via TTS
    const audioBytes = await textToSpeech(responseText);

    // Step D: Save to cache (only if artifact exists in DB)
    if (artifact) {
        await saveToCache(artifact.id, questionText, audioBytes);
        console.log(`[ask] Cached response for artifact ${artifactId}`);
    }

    res.set('Content-Type', 'audio/wav');
    res.send(audioBytes);
}

// Audio input: transcribe then process
router.post('/', express.raw({ type: 'application/octet-stream', limit: '10mb' }), async (req, res) => {
    try {
        const artifactId = req.headers['x-artifact-id'];
        if (!artifactId) {
            return res.status(400).json({ error: 'Missing x-artifact-id header' });
        }

        const imageBase64 = req.headers['x-image-base64'] || null;
        const audioBase64 = req.body.toString('base64');

        // Step A: Transcribe audio with Gemini
        const transcription = await transcribeAudio(audioBase64);
        console.log(`[ask] Transcription: "${transcription}"`);

        await handleAskRequest(artifactId, transcription, imageBase64, res);
    } catch (err) {
        console.error('[ask] Error:', err.message);
        res.status(500).json({ error: 'Internal server error', details: err.message });
    }
});

// Text input: skip transcription
router.post('/text', express.json({ limit: '10mb' }), async (req, res) => {
    try {
        const { artifactId, question, imageBase64 } = req.body;
        if (!artifactId || !question) {
            return res.status(400).json({ error: 'Missing artifactId or question in body' });
        }

        console.log(`[ask/text] Question: "${question}"`);
        await handleAskRequest(artifactId, question, imageBase64 || null, res);
    } catch (err) {
        console.error('[ask/text] Error:', err.message);
        res.status(500).json({ error: 'Internal server error', details: err.message });
    }
});

async function transcribeAudio(audioBase64) {
    const response = await ai.models.generateContent({
        model: TRANSCRIPTION_MODEL,
        contents: [{
            role: 'user',
            parts: [
                { text: 'Transcribe this audio clip verbatim. Return only the transcribed text, nothing else.' },
                { inlineData: { mimeType: 'audio/wav', data: audioBase64 } }
            ]
        }]
    });
    return response.text.trim();
}

async function checkCache(artifactDbId, questionText) {
    const result = await pool.query(
        `SELECT audio_response FROM qa_cache
         WHERE artifact_id = $1 AND LOWER(question_text) = LOWER($2)
         LIMIT 1`,
        [artifactDbId, questionText]
    );
    return result.rows.length > 0 ? result.rows[0] : null;
}

async function generateGroundedResponse(artifact, artifactId, questionText, imageBase64) {
    // Build the user message parts
    const userParts = [{ text: questionText }];

    // Include screenshot if provided so the model can see what the user sees
    if (imageBase64) {
        userParts.push({
            inlineData: { mimeType: 'image/jpeg', data: imageBase64 }
        });
    }

    const artifactName = artifact ? artifact.name : artifactId;

    const systemText = `You are a museum audio guide standing next to a visitor. The visitor is looking at "${artifactName}". A screenshot from their phone camera is attached.

You have ONE job: answer the visitor's question and NOTHING ELSE.

Imagine the visitor asked you this question face-to-face. You would answer it directly, maybe add one interesting related detail, and then stop talking and wait for their next question. That is exactly what you must do here.

DO NOT dump facts. DO NOT give an overview of the artifact. DO NOT mention details the visitor did not ask about. Every sentence you say must be directly relevant to the specific question asked.

Example — visitor asks "who painted this?":
GOOD: "This was painted by Leonardo da Vinci. He was actually trained as an apprentice under Andrea del Verrocchio in Florence, starting when he was just fourteen years old."
BAD: "This was painted by Leonardo da Vinci between 1503 and 1519. It's an oil painting on poplar wood and depicts Lisa Gherardini. It's housed in the Louvre."

The BAD answer mentions dates, medium, subject, and location — none of which were asked about.

Keep it to 2-3 sentences. Speak naturally. No markdown or formatting.`;

    // Try with grounding first, fall back without if it fails
    try {
        const response = await ai.models.generateContent({
            model: GENERATION_MODEL,
            contents: [{ role: 'user', parts: userParts }],
            systemInstruction: { parts: [{ text: systemText }] },
            config: {
                tools: [{ googleSearch: {} }]
            }
        });
        return response.text.trim();
    } catch (err) {
        console.warn(`[ask] Grounded generation failed (${err.message}), retrying without grounding...`);
        const response = await ai.models.generateContent({
            model: GENERATION_MODEL,
            contents: [{ role: 'user', parts: userParts }],
            systemInstruction: { parts: [{ text: systemText }] }
        });
        return response.text.trim();
    }
}

async function textToSpeech(text) {
    const response = await ai.models.generateContent({
        model: TTS_MODEL,
        contents: [{
            role: 'user',
            parts: [{ text: text }]
        }],
        config: {
            responseModalities: ['AUDIO'],
            speechConfig: {
                voiceConfig: {
                    prebuiltVoiceConfig: { voiceName: 'Kore' }
                }
            }
        }
    });

    // Extract audio data from response
    const audioPart = response.candidates[0].content.parts.find(p => p.inlineData);
    if (!audioPart) {
        throw new Error('No audio data in TTS response');
    }

    const pcmBuffer = Buffer.from(audioPart.inlineData.data, 'base64');

    // Wrap PCM in WAV header (16-bit, mono, 24kHz — Gemini TTS default)
    return createWavBuffer(pcmBuffer, 24000, 1, 16);
}

function createWavBuffer(pcmData, sampleRate, channels, bitsPerSample) {
    const byteRate = sampleRate * channels * (bitsPerSample / 8);
    const blockAlign = channels * (bitsPerSample / 8);
    const dataSize = pcmData.length;
    const headerSize = 44;

    const buffer = Buffer.alloc(headerSize + dataSize);

    // RIFF header
    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(36 + dataSize, 4);
    buffer.write('WAVE', 8);

    // fmt chunk
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20);
    buffer.writeUInt16LE(channels, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(byteRate, 28);
    buffer.writeUInt16LE(blockAlign, 32);
    buffer.writeUInt16LE(bitsPerSample, 34);

    // data chunk
    buffer.write('data', 36);
    buffer.writeUInt32LE(dataSize, 40);
    pcmData.copy(buffer, 44);

    return buffer;
}

async function saveToCache(artifactDbId, questionText, audioBuffer) {
    await pool.query(
        `INSERT INTO qa_cache (artifact_id, question_text, audio_response)
         VALUES ($1, $2, $3)`,
        [artifactDbId, questionText, audioBuffer]
    );
}

module.exports = router;
