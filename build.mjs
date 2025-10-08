import { build } from "esbuild";
import { readdir, readFile, writeFile, mkdir, rm } from "fs/promises";
import { join, resolve } from "path";
import { fileURLToPath } from "url";
import { readFile as rf } from 'fs/promises';
import { marked } from 'marked';

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PLUGINS_DIR = resolve(__dirname, "plugins");
const DIST_DIR = resolve(__dirname, "dist");

async function buildPlugin(pluginName) {
  console.log(`\n📦 Building ${pluginName}...`);
  
  const pluginDir = join(PLUGINS_DIR, pluginName);
  const manifestPath = join(pluginDir, "manifest.json");
  
  // Lire le manifest
  let manifest;
  try {
    const manifestContent = await readFile(manifestPath, "utf-8");
    manifest = JSON.parse(manifestContent);
  } catch (error) {
    console.error(`❌ Cannot read manifest.json for ${pluginName}:`, error.message);
    return false;
  }
  
  // Créer le dossier de sortie
  const outDir = join(DIST_DIR, pluginName);
  await mkdir(outDir, { recursive: true });
  
  const outfile = join(outDir, "index.js");
  const entryPoint = join(pluginDir, manifest.main);
  
  try {
    // Build avec esbuild
    await build({
      entryPoints: [entryPoint],
      outfile,
      bundle: true,
      format: "esm",
      external: [
        "@vendetta",
        "@vendetta*",
        "react",
        "react-native",
      ],
      minify: true,
      target: "esnext",
      treeShaking: true,
      logLevel: "info",
    });
    
    console.log(`   ✓ Compiled ${manifest.main}`);
  } catch (error) {
    console.error(`   ❌ Build failed:`, error.message);
    return false;
  }
  
  // Calculer le hash SHA-256 du fichier compilé
  const compiledCode = await readFile(outfile, "utf-8");
  const { createHash } = await import("crypto");
  const hash = createHash("sha256").update(compiledCode).digest("hex");
  
  console.log(`   ✓ Generated hash: ${hash}`);
  
  // Mettre à jour le hash et le champ "main" dans le manifest
  manifest.hash = hash;
  manifest.main = "index.js"
  
  // Écrire le manifest avec le hash mis à jour
  const manifestOutput = JSON.stringify(manifest, null, 2);
  await writeFile(
    join(outDir, "manifest.json"),
    manifestOutput
  );
  
  console.log(`   ✓ Wrote manifest.json with hash with the correct main`);
  console.log(`✅ Successfully built ${pluginName}`);
  
  return true;
}

async function main() {
  console.log("🚀 Starting build process...\n");
  
  // Nettoyer le dossier dist
  try {
    await rm(DIST_DIR, { recursive: true, force: true });
    console.log("🧹 Cleaned dist directory");
  } catch (error) {
    // Le dossier n'existe peut-être pas encore
  }
  
  // Créer le dossier dist
  await mkdir(DIST_DIR, { recursive: true });
  
  // Lire tous les plugins
  let plugins;
  try {
    plugins = await readdir(PLUGINS_DIR);
  } catch (error) {
    console.error("❌ Cannot read plugins directory:", error.message);
    process.exit(1);
  }
  
  // Filtrer pour ne garder que les dossiers avec un manifest.json
  const validPlugins = [];
  for (const plugin of plugins) {
    const manifestPath = join(PLUGINS_DIR, plugin, "manifest.json");
    try {
      await readFile(manifestPath);
      validPlugins.push(plugin);
    } catch {
      // Pas de manifest, on ignore
    }
  }
  
  console.log(`📋 Found ${validPlugins.length} plugin(s):\n   - ${validPlugins.join("\n   - ")}\n`);
  
  // Builder chaque plugin
  let successCount = 0;
  let failCount = 0;
  
  for (const plugin of validPlugins) {
    const success = await buildPlugin(plugin);
    if (success) {
      successCount++;
    } else {
      failCount++;
    }
  }
  
  // Résumé
  console.log("\n" + "=".repeat(50));
  console.log(`✅ ${successCount} plugin(s) built successfully`);
  if (failCount > 0) {
    console.log(`❌ ${failCount} plugin(s) failed`);
  }
  console.log("=".repeat(50) + "\n");
  
  if (failCount > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("❌ Build script failed:", error);
  process.exit(1);
});
