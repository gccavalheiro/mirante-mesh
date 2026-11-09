# MAP — o que ler quando

| Preciso | Abrir |
| --- | --- |
| Onde estamos / próximo passo | `docs/STATUS.md` |
| Regras permanentes do agente | `AGENTS.md` |
| Visão do produto, arquitetura, design shipped | `README.md` |
| Subir o app e o sinal local | `README.md` (seções Rodar e Servidor de sinalização) |
| Processo Electron | `src/main/index.ts` |
| Topologia da sessão | `src/renderer/src/rtc/mesh-session.ts` |
| Um peer / ICE | `src/renderer/src/rtc/peer-link.ts` |
| Codecs e bitrate | `src/renderer/src/rtc/sdp.ts` |
| Tokens visuais já shipped | `src/renderer/src/styles/tokens.css` |
| Sinalização local (porta `8787`) | `server/src/index.ts` |
| Sinalização publicada (worker) | `worker/src/index.ts`, `worker/wrangler.jsonc` |
| URL de sinal no dev/build | `electron.vite.config.ts` |
| Journal de velocidade | `docs/journal/README.md` |
| Método de agentes (MVP) | `mvp/` em [edy-rodrigues/agent-delivery-workflow](https://github.com/edy-rodrigues/agent-delivery-workflow) |
| Gate de UI (condicional) | `mvp/ui-design-gate.md` no mesmo repositório. Verdade de produto (`PRODUCT.md`) ainda ausente. Sistema visual durável a extrair do que já shipa na próxima fatia de UI. |
| Portas fixas / conflito | SoT `C:\Users\a\PhpstormProjects\port-status\registry\ports.json` + skill `port-map`. Porta local deste produto: `8787`. |
