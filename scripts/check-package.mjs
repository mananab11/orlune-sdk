import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { execFileSync } from "node:child_process"

const root = fileURLToPath(new URL("../", import.meta.url))
const directory = await mkdtemp(join(tmpdir(), "orlune-package-"))
const npm = process.platform === "win32" ? "npm.cmd" : "npm"
const run = (command, args, cwd) => execFileSync(command, args, {
  cwd, encoding: "utf8", env: { ...process.env, npm_config_cache: join(directory, "cache") },
})

try {
  await mkdir(join(root, "dist"), { recursive: true })
  await writeFile(join(root, "dist/stale-build-artifact.js"), "// Must not ship.\n")
  const [pack] = JSON.parse(run(npm, ["pack", "--json", "--pack-destination", directory], root))
  assert.ok(!pack.files.some(file => file.path.includes("stale-build-artifact") || file.path.includes("detect-client")))
  assert.ok(pack.files.some(file => file.path === "dist/index.d.ts"))
  assert.ok(!pack.files.some(file => /(^|\/)(node_modules|test|\.env)(\/|$)/.test(file.path)))
  const { PRODUCTION_BASE_URL } = await import("../dist/config.js")
  for (const file of pack.files) {
    const contents = await readFile(join(root, file.path), "utf8")
    const endpoints = contents.match(/https:\/\/[a-z0-9]+\.execute-api\.[a-z0-9-]+\.amazonaws\.com/g) ?? []
    assert.ok(endpoints.every(endpoint => endpoint === PRODUCTION_BASE_URL), `Nonproduction API endpoint in ${file.path}`)
  }
  await writeFile(join(directory, "package.json"), JSON.stringify({ private: true, type: "module" }))
  run(npm, ["install", join(directory, pack.filename), "--offline", "--ignore-scripts", "--no-audit", "--no-fund"], directory)
  await writeFile(join(directory, "consumer.ts"), await readFile(join(root, "test/package-consumer.ts")))
  run(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "consumer.ts", "--strict",
    "--target", "es2022", "--module", "nodenext", "--moduleResolution", "nodenext", "--skipLibCheck"], directory)
  run(process.execPath, ["consumer.js"], directory)
  console.log(`Package install, public types, imports, and telemetry smoke test passed (${pack.size} bytes packed).`)
} finally {
  await rm(directory, { recursive: true, force: true })
}
