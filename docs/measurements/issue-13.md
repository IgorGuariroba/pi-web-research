# Issue #13 — configuração do Classificador e comparação real parcial

## Escopo entregue

- Modelo de pesquisa acessível diretamente em `/web-search`, sem revalidar a chave do Provider.
- Classificador com conexão guiada do Jev por `/login openrouter` ou `/login typesafe`, sem armazenamento paralelo de credenciais.
- Validação por classificação real; status distingue configuração, último teste e uso efetivo na pesquisa.
- Fallback por regras visível, inclusive em falhas parciais; respostas de classificação incompletas/invalidas não contam como sucesso.

A issue **não está concluída**: falta autenticar Jev e repetir as medições do descarte com a pergunta corrigida. Não há justificativa nova para declarar o limiar calibrado.

## Método — 2026-11-01

Goal, igual ao da #11:

> Como Bun se compara ao Node.js como runtime de servidores HTTP em produção em 2025 (desempenho, compatibilidade, estabilidade)

Focus: comparar desempenho, compatibilidade e estabilidade, concisamente em português.

- Referência: tag `v0.1.1`. Atual: código desta implementação, baseado em `ffb8acb` (a atualização posterior da main acrescentou apenas CI/publicação).
- Agente pai e Modelo de pesquisa: `openai-codex/gpt-6.1-sol`, disponível nas duas versões. Não é o Haiku da medição anterior: não comparar tempos entre estas rodadas e as da #11 como se o modelo fosse igual.
- Execução: CLI real, `pi -p --mode json --no-session --no-extensions ... -e <diretório-da-versão>`, uma chamada de `research` por rodada. Tempo medido entre `tool_execution_start` e `tool_execution_end`, excluindo inicialização e resposta final do Agente pai.
- Cada rodada usou HOME temporário e `PI_CODING_AGENT_DIR` correspondente. Estado e autenticação foram copiados; apenas a cópia recebeu o Modelo de pesquisa disponível. Não houve escrita no `state.json` real; sua igualdade byte a byte foi verificada por SHA-256 após cada rodada.
- O snapshot usado na comparação já tinha Tavily **e Exa**, com Exa ativo. A 0.1.1 consultou Exa; a atual consultou ambos em paralelo. A disponibilidade foi confirmada pelo HTTP real: todas as requisições de busca responderam 200 e 10 resultados. Nenhum Fallback cru.
- Classificador: nenhum disponível no model registry. Portanto as linhas com Critério exercitam **Critério ignorado**, não curadoria por Categoria.
- Critério enviado na versão atual: `relato-producao` > `benchmark` > `docs-oficiais` > `marketing` (descarte). A 0.1.1 não aceita `criteria`; não foram inventadas linhas equivalentes com suporte a Critério nessa versão.
- Uma amostra por combinação, sem inferência estatística. Os modelos escolheram quantas buscas/leituras fazer; não consumiram o orçamento máximo do `deep`.

## Resultados

| Versão | Depth | Critério | Tempo | Buscas lógicas | HTTP de busca | Fontes lidas | URLs citadas | Síntese (caracteres) |
|---|---|---|---:|---:|---:|---:|---:|---:|
| 0.1.1 | quick | não suportado | 21,634s | 2 | 2 Exa | não instrumentado (2 tentativas) | 3, sem Nível | 1.481 |
| atual | quick | ausente | 20,033s | 2 | 2 Exa + 2 Tavily | 3 | 3 oficiais por regras | 1.417 |
| atual | quick | enviado, ignorado | 19,581s | 2 | 2 Exa + 2 Tavily | 3 | 3 oficiais por regras | 1.638 |
| 0.1.1 | deep | não suportado | 22,434s | 3 | 3 Exa | não instrumentado (5 tentativas) | 5, sem Nível | 1.843 |
| atual | deep | ausente | 33,563s | 5 | 5 Exa + 5 Tavily | 6 | 5 oficiais por regras | 2.078 |
| atual | deep | enviado, ignorado | 30,971s | 4 | 4 Exa + 4 Tavily | 7 | 5 oficiais por regras | 2.183 |

A contagem de URLs citadas não é a contagem de Fontes lidas. Em particular, a 0.1.1 não verifica citações e não oferece os mesmos details de leitura da versão atual.

Funil da versão atual (acumulado por busca):

| Depth / Critério | Encontrados | Únicos | Duplicatas entre Providers | Spam | Após descarte | Lidos |
|---|---:|---:|---:|---:|---:|---:|
| quick / ausente | 40 | 37 | 3 | 0 | 37 | 3 |
| quick / ignorado | 40 | 38 | 2 | 0 | 38 | 3 |
| deep / ausente | 100 | 95 | 5 | 0 | 95 | 6 |
| deep / ignorado | 80 | 77 | 3 | 0 | 77 | 7 |

## Limiar e timeout

**Fora do tema:** não medido. Não interpretar a ausência do contador `offTopic`/`offTopicDiscarded` como taxa zero: nenhum classificador rodou. O limiar **0,7 permanece inalterado, provisoriamente**, não recalibrado por estes dados. Há teste pelo núcleo confirmando que 0,70 passa e 0,71 é descartado, com URL/probabilidade na auditoria.

**Timeout do deep:** **180s permanece inalterado, provisoriamente**. O máximo observado na versão atual foi 33,563s, mas sem as chamadas de classificação e sem orçamento cheio. Isso não confirma o timeout do caminho completo com Jev. Não reduzir o timeout com base nesta amostra.

## Para concluir a #13

1. Conectar Jev em `/web-search` → Classificador → Conectar Jev; concluir o login nativo do Pi.
2. Validar a conexão e verificar, numa pesquisa real, `Jev usado` e `classifierUsage.successfulCalls > 0`.
3. Repetir a matriz atual `quick`/`deep`, com e sem Critério, e as rodadas 0.1.1 com o mesmo Modelo de pesquisa, sempre com estado isolado.
4. Auditar `details.offTopicDiscarded` (amostra de até 20 URLs/probabilidades por pesquisa), registrar falsos positivos e justificar o limiar com esses dados. A ausência de uma URL na amostra não prova que foi mantida.
5. Medir o tempo com o Classificador ativo, incluindo falhas parciais, e confirmar ou ajustar 180s.
6. Acrescentar os resultados ao comentário da issue #1, sem substituir estes resultados parciais por uma alegação de calibração concluída.
