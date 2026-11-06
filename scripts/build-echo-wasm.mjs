/**
 * Compila o supressor de eco para WebAssembly e embute o binario como
 * base64 num modulo TypeScript.
 *
 * Base64 e nao `?url` por um motivo concreto: o AudioWorklet nao tem fetch,
 * e a pagina empacotada roda em file://, onde buscar o proprio asset
 * tambem nao funciona. O RNNoise ja resolve assim — o build `-sync` do
 * Jitsi existe exatamente por isso.
 *
 *   node scripts/build-echo-wasm.mjs
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..')
const crate = join(raiz, 'native', 'echo-wasm')

execFileSync(
  'cargo',
  ['build', '--release', '--target', 'wasm32-unknown-unknown', '--manifest-path', join(crate, 'Cargo.toml')],
  { stdio: 'inherit' }
)

const wasm = readFileSync(
  join(crate, 'target', 'wasm32-unknown-unknown', 'release', 'mirante_echo_wasm.wasm')
)

const destino = join(raiz, 'src', 'renderer', 'src', 'rtc', 'echo-wasm.ts')
writeFileSync(
  destino,
  `/**
 * O supressor de eco, compilado para WebAssembly, em base64.
 *
 * GERADO — nao edite. Rode \`node scripts/build-echo-wasm.mjs\` depois de
 * mexer em \`native/echo\`.
 *
 * Embutido em vez de carregado por URL porque um AudioWorklet nao tem
 * fetch, e a pagina empacotada roda em file://, onde buscar o proprio
 * asset tambem falha.
 */
export const ECHO_WASM_BASE64 =
  '${wasm.toString('base64')}'
`,
  'utf8'
)

console.log(`${destino} — ${(wasm.length / 1024).toFixed(0)} KB de wasm`)
