# Mirante — regras para agentes

App desktop para assistir junto: tela e câmera ao vivo entre amigos, mesh P2P. Lema: **Suba no mirante. Mostra a tela. Assiste junto.** Electron + React; sinalização local em `server/` e worker Cloudflare em `worker/`.

## Standing project rules (track MVP)

- **Docs SoT:** o chat não é fonte da verdade; use `docs/STATUS.md`, `docs/MAP.md` e planos/fatias aprovados.
- **Ask before product implement** quando a mudança for voltada a produto e ainda não estiver autorizada por plano/fatia.
- **UI gate (condicional):** antes de autorizar uma fatia que toque UI ou identidade visual, seguir o gate de UI do track MVP (verdade de produto → sistema visual ou documentar o que já shipa → só então autorizar). Pular em trabalho sem UI. Detalhe: `mvp/ui-design-gate.md` em [agent-delivery-workflow](https://github.com/edy-rodrigues/agent-delivery-workflow).
- **Fatias:** trabalhar em fatias pequenas e autorizadas; fechar com evidência curta (smoke/checklist/comandos).
- **Diário por fatia:** ao fechar, registrar em `docs/journal/YYYY-MM-DD.md` (só velocidade — não é timeline cross-harness).
- **Continuidade:** captura de sessão/hooks basta durante o turno. Na troca de harness ou fim de sessão: handoff via ai-memory (resumo + próximos passos). Wiki durável só para regra/decisão relevante. Journal **não** substitui handoff.
- **Workflow:** seguir Agent Delivery Workflow track **MVP** (`mvp/` em [edy-rodrigues/agent-delivery-workflow](https://github.com/edy-rodrigues/agent-delivery-workflow)). **Não** tratar delivery-contract / pipeline multi-fase da v1 na raiz como default deste projeto.
- **Portas fixas:** serviços HTTP locais usam portas estáveis registradas na SoT `C:\Users\a\PhpstormProjects\port-status\registry\ports.json`. Em adoção ou `EADDRINUSE`: ler o mapa → escolher porta livre no range → fixar no projeto → registrar. Não matar processo alheio para “liberar” porta.

## Consultation map

| Preciso | Abrir |
| --- | --- |
| Onde estamos | `docs/STATUS.md` |
| O que ler quando | `docs/MAP.md` |
| Journal de velocidade | `docs/journal/README.md` |
| Gate de UI / design | `mvp/ui-design-gate.md` no agent-delivery-workflow + seção Design do `README.md` e `src/renderer/src/styles/tokens.css` |
| Portas fixas / conflito | `C:\Users\a\PhpstormProjects\port-status\registry\ports.json` + skill `port-map` |
