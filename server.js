require('dotenv').config();

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const pool = require('./db');

const askRouter = require('./routes/ask');
const { handleLiveConnection } = require('./routes/live');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Routes
app.use('/api/ask', askRouter);

// Diagnostic: list models that support bidiGenerateContent (Live API)
app.get('/debug/live-models', async (req, res) => {
    try {
        const apiKey = process.env.GEMINI_API_KEY;
        const versions = ['v1beta', 'v1alpha'];
        const out = {};
        for (const v of versions) {
            const r = await fetch(`https://generativelanguage.googleapis.com/${v}/models?key=${apiKey}&pageSize=1000`);
            const json = await r.json();
            if (!json.models) {
                out[v] = { error: json.error || json };
                continue;
            }
            out[v] = json.models
                .filter(m => (m.supportedGenerationMethods || []).includes('bidiGenerateContent'))
                .map(m => m.name);
        }
        res.json(out);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Health check
app.get('/health', async (req, res) => {
    try {
        await pool.query('SELECT 1');
        res.json({ status: 'ok', db: 'connected' });
    } catch (err) {
        res.status(500).json({ status: 'error', db: 'disconnected', message: err.message });
    }
});

const server = http.createServer(app);

// WebSocket server for live audio streaming via Gemini Multimodal Live API
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
    console.log('[ws] Client connected');
    handleLiveConnection(ws);
});

server.listen(PORT, () => {
    console.log(`Museum Tour API running on port ${PORT}`);
});
