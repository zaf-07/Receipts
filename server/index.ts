import { config, llmEnabled } from './config';
import { start } from './app';

const { port } = await start();

console.log(`
  Receipts is running at http://localhost:${port}

  Source   ${config.source === 'world' ? 'seeded demo world (fictional companies, served locally)' : 'live web'}
  Agents   ${llmEnabled() ? `model-backed (${config.model}), with deterministic fallbacks` : 'deterministic (no model credentials found)'}
`);
