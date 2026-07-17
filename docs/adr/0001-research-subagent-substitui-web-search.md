# `research` (subagente) substitui `web_search` na sessão do agente pai

Resultados brutos de busca poluíam o contexto do agente principal. Decidimos que a extensão web-search deixa de registrar `web_search` na sessão pai e passa a expor apenas `research`: uma tool que cria um subagente SDK in-process (contexto zerado, modelo barato configurável via TUI) com acesso exclusivo a `web_search` + `fetch_url`, e devolve ao pai somente uma síntese com fontes citadas.

## Considered Options

- **Manter web_search visível ao pai junto com research** — rejeitado: o pai continuaria poluindo o próprio contexto com buscas diretas.
- **Spawn do CLI `pi` headless como subprocesso** — rejeitado: mais lento, frágil de parsear e herda config global.
- **Pipeline fixo sem subagente (busca + 1 chamada de sumarização)** — rejeitado: inviabiliza o modo `deep` (multi-busca iterativa).
- **Extensão nova separada** — rejeitado: reuso do SearchEngine/providers fica mais simples evoluindo a extensão existente, sem risco de registrar as duas tools.

## Consequences

- Prompts/hábitos que citavam `web_search` devem passar a usar `research`.
- Toda pesquisa (mesmo `quick`) paga a latência/custo de um turno de subagente; em troca, o pai sempre recebe conteúdo apurado.
- Em falha do subagente, a tool degrada para o fallback cru do `web_search` com aviso — o pai nunca fica sem resposta.
