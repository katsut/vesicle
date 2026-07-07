// Load ./.env into process.env if present — Node's built-in loader, no dependency. Import this FIRST
// (before anything that reads process.env at module load). A missing .env is fine: we fall back to the
// ambient environment.
try {
  process.loadEnvFile();
} catch {
  // no .env file — rely on the ambient environment
}
