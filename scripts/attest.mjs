import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const graphPath = join(root, "data", "knowledge_graph.json");
const attestDir = join(root, "attestations");
const webAttestPath = join(root, "web", "data", "attestation.json");

const fileBuffer = readFileSync(graphPath);
const blob = new Blob([fileBuffer], { type: "application/json" });
const form = new FormData();
form.append("file", blob, "knowledge_graph.json");
form.append("content_name", "uv-temperature-knowledge-graph.json");
form.append("model", "Auto");
form.append("role", "collaborated");
form.append("author", "97115104");
form.append("platform", "Cursor");

const response = await fetch("https://attest.97115104.com/api/create-upload", {
  method: "POST",
  body: form,
});

if (!response.ok) {
  throw new Error(`Attestation failed: HTTP ${response.status} ${response.statusText}`);
}

const result = await response.json();
if (!result.success) {
  throw new Error(`Attestation failed: ${result.error || "unknown error"}`);
}

mkdirSync(attestDir, { recursive: true });
writeFileSync(join(attestDir, "knowledge_graph.json"), JSON.stringify(result, null, 2));

const webMeta = {
  verify_url: result.urls?.short || result.urls?.verify,
  attestation_id: result.attestation?.id,
  generated_at: result.attestation?.timestamp,
};
mkdirSync(dirname(webAttestPath), { recursive: true });
writeFileSync(webAttestPath, JSON.stringify(webMeta, null, 2));

console.log("Attestation created:", result.urls?.short || result.urls?.verify);
