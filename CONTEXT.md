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
Nível de orçamento da pesquisa: `quick` (até 3 buscas e 4 leituras, síntese curta) ou `deep` (até 12 buscas e 15 leituras, investigação iterativa). Uma Busca agregada conta como uma busca.

**Síntese**:
O único artefato que retorna ao contexto do agente pai: texto respondendo o Goal sob o Focus, com as URLs das fontes usadas ao final.
_Avoid_: resultados, dump

**Síntese não verificada**:
Síntese que terminou sem nenhuma Fonte lida; é devolvida mesmo assim, com aviso explícito de que se apoia apenas em resultados de busca.

**Fallback cru**:
Resultado degradado devolvido quando o subagente falha: resultados da Busca agregada, sem duplicatas e ordenados por Nível de fonte, marcados como "sem síntese".

**Provider**:
Backend de busca do SearchEngine (Tavily, Exa ou Goose), resolvido dinamicamente a cada busca.

**Busca agregada**:
Uma busca do subagente consultada em todos os Providers com chave ao mesmo tempo; os resultados viram uma lista única. Goose só entra quando nenhum Provider tem chave.
_Avoid_: fan-out, multi-search

**URL canônica**:
Forma normalizada de uma URL usada para decidir se dois resultados são a mesma fonte (ignora `www.`, fragmento, parâmetros de rastreio, barra final e http vs https).

**Concordância**:
Quando a mesma URL canônica é encontrada por mais de um Provider; conta a favor da fonte na ordenação.

**Nível de fonte**:
Confiabilidade genérica de um resultado, válida para qualquer pesquisa: `oficial`, `docs`, `blog` ou `fórum`. Desempata a ordenação depois do Critério e é exibida ao subagente; só spam é removido por ele.
_Avoid_: nota, score (não é um número)

**Critério**:
Lista ordenada de Categorias definida pelo Agente pai em uma chamada de Research, dizendo que tipo de fonte serve para aquele problema. A ordem é a prioridade. É o roteiro do Funil inteiro: o subagente busca ativamente cada Categoria, lê para cobri-las e declara as que faltaram. Opcional; sem classificador disponível é ignorado com aviso.
_Avoid_: filtro, funil

**Categoria**:
Item do Critério: um nome curto, uma descrição do que se encaixa nele e, opcionalmente, a marca de descarte. Resultados que não se encaixam em nenhuma Categoria ficam em `outros`, no fim.

**Cobertura**:
Regra de leitura com Critério: ler ao menos uma Fonte lida de cada Categoria antes de ler a segunda de qualquer uma. No `deep` vale para todas as Categorias não descartadas; no `quick`, só para as duas de maior prioridade.

**Lacuna declarada**:
Seção "Não encontrado" ao fim de uma Síntese com Critério, listando as Categorias que terminaram sem nenhuma Fonte lida.

**Fora do tema**:
Resultado que não trata do Goal; é sempre descartado, com ou sem Critério.

**Funil**:
O caminho completo de uma Research: busca → descarte → classificação → leitura → Síntese.
_Avoid_: pipeline, filtro

**Fonte lida**:
Página que o subagente efetivamente leu com sucesso via `fetch_url`. Só Fontes lidas podem aparecer na seção "Fontes" da Síntese.
_Avoid_: fonte vista, resultado de busca

**Extração focada**:
O que `fetch_url` devolve ao subagente: apenas os trechos da página mais relacionados ao Goal, Focus e query, em vez da página inteira.
_Avoid_: resumo (não há LLM envolvido)

**Modelo de pesquisa**:
Modelo que roda o Subagente de pesquisa. Escolhido em `/web-search`; sem escolha, um modelo barato disponível, e na falta dele o modelo do Agente pai.
