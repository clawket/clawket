// Lattice embeddings module — local embedding generation using @xenova/transformers
// Model: all-MiniLM-L6-v2 (384 dimensions, ~23MB download on first use)

let pipeline = null;
let modelLoading = null;

const MODEL_NAME = 'Xenova/all-MiniLM-L6-v2';
const EMBEDDING_DIM = 384;

async function getEmbedder() {
  if (pipeline) return pipeline;
  if (modelLoading) return modelLoading;

  modelLoading = (async () => {
    const { pipeline: createPipeline } = await import('@xenova/transformers');
    pipeline = await createPipeline('feature-extraction', MODEL_NAME, {
      quantized: true,
    });
    return pipeline;
  })();

  return modelLoading;
}

/**
 * Generate embedding for a text string.
 * @param {string} text
 * @returns {Promise<Float32Array>} 384-dimensional embedding vector
 */
export async function embed(text) {
  if (!text || text.trim().length === 0) return null;

  // Truncate to ~512 tokens worth of text (~2000 chars)
  const truncated = text.slice(0, 2000);

  try {
    const embedder = await getEmbedder();
    const output = await embedder(truncated, { pooling: 'mean', normalize: true });
    return output.data;
  } catch (err) {
    process.stderr.write(`[lattice-embeddings] Error: ${err.message}\n`);
    return null;
  }
}

export { EMBEDDING_DIM };
