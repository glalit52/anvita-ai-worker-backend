-- Semantic search for knowledge bases. pgvector is optional: without it, search stays keyword-only.
DO $$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS vector;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'pgvector is not available (%); knowledge search stays keyword-only', SQLERRM;
  END;
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    EXECUTE 'CREATE TABLE IF NOT EXISTS kb_embeddings (
      chunk_id text PRIMARY KEY REFERENCES kb_chunks(id) ON DELETE CASCADE,
      workspace_id text NOT NULL,
      kb_id text NOT NULL,
      model text NOT NULL,
      embedding vector(1024) NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )';
    EXECUTE 'CREATE INDEX IF NOT EXISTS kb_embeddings_ws_kb_idx ON kb_embeddings (workspace_id, kb_id)';
    EXECUTE 'CREATE INDEX IF NOT EXISTS kb_embeddings_hnsw_idx ON kb_embeddings USING hnsw (embedding vector_cosine_ops)';
  END IF;
END $$;
