# Journal de velocidade

Mede **ritmo real** (humano + agentes) por fatia, para recalibrar prazo depois de dias úteis com entradas honestas. **Não** substitui handoff cross-harness (ai-memory).

## Quando anotar

Ao fechar cada fatia (ou a cada 1–2h se a fatia for longa). O agente escreve 3–6 bullets; o humano só corrige.

## Formato

Arquivo do dia: `docs/journal/YYYY-MM-DD.md`. Template: [`_template.md`](./_template.md).

```markdown
### Fatia — <rótulo curto>

- Feito:
- Arquivos / docs:
- Smoke / verificação:
- Aberto / próximo:
```

No fim do dia: totais + o que ficou aberto. No dia seguinte: arquivo novo + ler ontem + `docs/STATUS.md`.

## Recalibrar

Após 2+ dias úteis com entradas: somar fatias, atualizar horizonte do plano MVP do produto e uma linha no `STATUS.md`.
