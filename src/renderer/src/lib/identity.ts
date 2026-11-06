/**
 * Quem você é, sem conta.
 *
 * O app até aqui não tem identidade: o nome é uma string no localStorage e
 * o `clientId` vive enquanto a janela viver. Isso basta para entrar numa
 * sala combinada por fora, e não basta para nada que precise lembrar de
 * você — uma sala com dono, uma lista de amigos, um convite.
 *
 * A saída óbvia seria conta com e-mail e senha. Seria também o oposto do
 * que o produto promete em toda tela: "sem cadastro, sem convite". E
 * resolveria o problema errado — ninguém quer uma conta no Mirante, as
 * pessoas querem que o Mirante saiba que elas são elas.
 *
 * Então: um par de chaves gerado no primeiro uso. A chave pública É a
 * identidade. Provar quem você é passa a ser assinar um desafio, não
 * digitar um segredo que o servidor também guarda — e um servidor que
 * nunca viu uma senha não tem senha para vazar.
 *
 * ## Onde a chave privada mora
 *
 * No IndexedDB, como `CryptoKey` não extraível. Isso importa: uma chave
 * guardada como texto em localStorage pode ser lida por qualquer código
 * que rode na página e copiada para outro lugar. Uma `CryptoKey` não
 * extraível não pode ser lida nem por nós — dá para assinar com ela, e só.
 */

const BANCO = 'mirante-identidade'
const LOJA = 'chaves'
const ID = 'eu'

export interface Identidade {
  /** A chave pública em base64url. É o identificador, e é público. */
  publica: string
  /** Oito caracteres da pública, para mostrar a um humano. */
  curta: string
}

interface Guardado {
  publica: string
  privada: CryptoKey
  publicaKey: CryptoKey
}

let cache: Guardado | null = null

function abrir(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(BANCO, 1)
    req.onupgradeneeded = () => {
      req.result.createObjectStore(LOJA)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function transacao<T>(db: IDBDatabase, modo: IDBTransactionMode, fn: (loja: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(LOJA, modo)
    const req = fn(tx.objectStore(LOJA))
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function base64url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * A identidade deste dispositivo, criando-a no primeiro uso.
 *
 * ECDSA sobre P-256: curva que o WebCrypto implementa em todo lugar, o
 * Cloudflare Workers inclusive, o que importa porque é lá que a assinatura
 * vai ser conferida.
 */
export async function identidade(): Promise<Identidade> {
  const g = await carregar()
  return { publica: g.publica, curta: g.publica.slice(0, 8) }
}

async function carregar(): Promise<Guardado> {
  if (cache) return cache

  const db = await abrir()
  const existente = await transacao<Guardado | undefined>(db, 'readonly', (loja) =>
    loja.get(ID)
  )
  if (existente) {
    cache = existente
    return existente
  }

  const par = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    // Não extraível: nem nós conseguimos ler a privada depois disto. Dá
    // para assinar com ela, e só — que é exatamente o que ela precisa
    // fazer, e o que impede que vazar o IndexedDB vire vazar a identidade.
    false,
    ['sign', 'verify']
  )
  const publica = base64url(await crypto.subtle.exportKey('raw', par.publicKey))
  const novo: Guardado = { publica, privada: par.privateKey, publicaKey: par.publicKey }
  await transacao(db, 'readwrite', (loja) => loja.put(novo, ID))
  cache = novo
  return novo
}

/**
 * Assina um desafio do servidor.
 *
 * O servidor manda bytes aleatórios, isto devolve a assinatura, e ele
 * confere contra a chave pública que já conhece. Nada secreto atravessa a
 * rede em nenhum momento — e um desafio novo a cada vez é o que impede que
 * capturar uma assinatura antiga sirva para alguma coisa.
 */
export async function assinar(desafio: ArrayBuffer): Promise<string> {
  const g = await carregar()
  const assinatura = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    g.privada,
    desafio
  )
  return base64url(assinatura)
}

/**
 * Começa de novo, com outra identidade.
 *
 * Existe porque a alternativa é alguém ficar preso a uma identidade que
 * não quer mais e sem caminho visível para trocar. Apaga a chave: as salas
 * e amizades ligadas a ela não voltam, e isso precisa estar dito na tela
 * antes de alguém clicar.
 */
export async function esquecer(): Promise<void> {
  const db = await abrir()
  await transacao(db, 'readwrite', (loja) => loja.delete(ID))
  cache = null
}
