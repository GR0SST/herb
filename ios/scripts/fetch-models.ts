// Downloads the Supertonic 3 weights to bundle in the app. Run: bun run ios/scripts/fetch-models.ts
import { createHash } from "node:crypto";
import { mkdirSync, renameSync, rmSync } from "node:fs";
import { basename, join } from "node:path";

const REPO = "supertone-oss-archive/supertonic-3";
// Pinned model revision.
const REVISION = "aafc6e32416a594460b32413efc49d7fe4ce6d46";
const FILES = [
  "onnx/duration_predictor.onnx", "onnx/text_encoder.onnx", "onnx/vector_estimator.onnx", "onnx/vocoder.onnx",
  "onnx/tts.json", "onnx/unicode_indexer.json", "voice_styles/F2.json", "LICENSE",
];
const out = join(import.meta.dir, "..", "Herb", "Models");
mkdirSync(out, { recursive: true });

const listing = await fetch(`https://huggingface.co/api/models/${REPO}/tree/${REVISION}?recursive=true`);
if (!listing.ok) throw new Error(`Could not list files: ${listing.status}`);
const entries = (await listing.json()) as { path: string; size: number; lfs?: { oid: string } }[];

async function valid(path: string, entry: (typeof entries)[number]) {
  const file = Bun.file(path);
  if (!(await file.exists()) || file.size !== entry.size) return false;
  if (!entry.lfs) return true;
  const hash = createHash("sha256");
  for await (const part of file.stream()) hash.update(part);
  return hash.digest("hex") === entry.lfs.oid;
}

for (const name of FILES) {
  const entry = entries.find((e) => e.path === name);
  if (!entry) throw new Error(`File missing from revision: ${name}`);
  const target = join(out, name === "LICENSE" ? "Supertonic-Model-LICENSE.txt" : basename(name));
  if (await valid(target, entry)) {
    console.log(`Already present: ${basename(target)}`);
    continue;
  }
  console.log(`Downloading ${basename(target)} (${Math.round(entry.size / 1048576)} MB)`);
  const response = await fetch(`https://huggingface.co/${REPO}/resolve/${REVISION}/${name}`);
  if (!response.ok) throw new Error(`Download failed: ${name}: ${response.status}`);
  const temp = `${target}.tmp`;
  await Bun.write(temp, response);
  if (!(await valid(temp, entry))) {
    rmSync(temp, { force: true });
    throw new Error(`Checksum mismatch: ${name}`);
  }
  renameSync(temp, target);
}
console.log("Model ready:", out);
