CREATE TABLE IF NOT EXISTS artifacts (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL UNIQUE,
    context TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS qa_cache (
    id SERIAL PRIMARY KEY,
    artifact_id INTEGER NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
    question_text TEXT NOT NULL,
    audio_response BYTEA NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_qa_cache_lookup ON qa_cache (artifact_id, question_text);
