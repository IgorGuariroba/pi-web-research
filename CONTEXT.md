# Web Research

Extensão do pi que expõe ao agente principal uma única ferramenta de pesquisa (`research`), executada por um subagente isolado — o contexto do agente pai recebe apenas a síntese apurada, nunca os resultados brutos da web.

## Language

**Agente pai**:
A sessão principal do pi, cujo contexto deve ser protegido de resultados brutos de busca.
_Avoid_: agente principal, host agent

**Subagente de pesquisa**:
Sessão SDK in-process, com contexto zerado, criada por chamada da tool `research`; é o único que enxerga `web_search` e `fetch_url`.
_Avoid_: background agent, worker

**Research**:
A tool exposta ao agente pai. Recebe `goal`, `focus` (opcional) e `depth`; devolve uma Síntese.
_Avoid_: web_search (na sessão pai), search

**Goal**:
O que o subagente deve descobrir — um objetivo de investigação, não uma query literal.

**Focus**:
Instrução opcional do agente pai sobre o que interessa e em que formato — o filtro que garante "somente o que importa" na Síntese.

**Depth**:
Nível de orçamento da pesquisa: `quick` (1–2 buscas, síntese curta) ou `deep` (multi-busca iterativa com leitura de fontes).

**Síntese**:
O único artefato que retorna ao contexto do agente pai: texto respondendo o Goal sob o Focus, com as URLs das fontes usadas ao final.
_Avoid_: resultados, dump

**Fallback cru**:
Resultado degradado devolvido quando o subagente falha: saída direta do `web_search`, marcada como "sem síntese".

**Provider**:
Backend de busca do SearchEngine (Tavily, Exa ou Goose), resolvido dinamicamente a cada busca.
