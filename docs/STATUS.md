# STATUS — Mirante

Atualizado: 2026-11-09

## Onde estamos

- **Produto:** app desktop v0.1.47 — mesh P2P de tela e câmera, sinalização no worker Cloudflare, servidor Node local opcional, instalador Windows via GitHub Releases.
- **Stack:** Electron + React (Vite), sinalização em `server/` (Node) e `worker/` (Cloudflare Durable Objects).
- **Processo:** track MVP do Agent Delivery Workflow adotado no estado dos commits de 2026-11-06 (`AGENTS.md`, `docs/MAP.md`, journal, gate de UI condicional, portas fixas). A v1 da raiz não é o default.
- **UI:** superfície já shipped. `PRODUCT.md` ainda não existe. A autoridade visual até um redesign autorizado é a seção Design do `README.md` mais `src/renderer/src/styles/tokens.css`. A próxima fatia que tocar UI precisa cumprir o gate (verdade de produto e documentar o sistema a partir do que já shipa) antes de implementar.
- **Portas:** sinalização local já fixa em `8787` (`PORT` em `server/src/index.ts`). `npm run dev` fala por padrão com o worker publicado, não com localhost. O mapa cross-repo `C:\Users\a\PhpstormProjects\port-status\registry\ports.json` não está nesta máquina, então esta fatia não reatribuiu porta nem escreveu no registro.

## Próximo passo

Aguardar a próxima fatia de produto autorizada (ask-before-implement). Se ela tocar UI, rodar o gate antes de autorizar. Retomar por este STATUS + `docs/MAP.md`.

## Bloqueios

- Registro da porta `8787` na SoT cross-repo: o arquivo `ports.json` não está neste computador.
