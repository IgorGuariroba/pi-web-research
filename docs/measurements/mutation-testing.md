# Mutation testing: custo e validação

Medições locais em Node 26.13.0. O CI usa Node 24. Os resultados são amostras, não benchmarks estatísticos nem comprovação do score da base inteira.

## Antes

- Stryker 10.1.1 com command runner, `coverageAnalysis: off`.
- Cada mutante executava a suíte inteira por `npm test`.
- A suíte usava esperas reais nos retries de Tavily/Exa.
- A execução completa instrumentou 23 arquivos e gerou 3.304 mutantes. Foi interrompida após cerca de 3 minutos, com 20 mutantes avaliados e estimativas oscilando em torno de 8–9 horas restantes.
- Tavily isolado, antes do relógio controlado: **6,402 segundos** (11 testes).

## Depois

- `@stryker-mutator/vitest-runner` 10.1.1 e Vitest 4.1.12, versões fixadas.
- Cobertura `perTest`; `related: false` para coletar inicialmente a suíte completa, sem depender somente do grafo de imports estáticos.
- Pool `forks`, preservando isolamento de ambiente. O pool `threads` reproduziu falhas nos testes de credenciais; o mesmo arquivo passou com `forks`.
- Adaptador `scripts/vitest-node-test.mjs` apenas para as APIs usadas (`test`, `beforeEach`, `afterEach`, `t.after`). O mesmo conjunto continua executável no Node, incluindo testes que abrem subprocessos nativos.
- Relógio controlado com `@sinonjs/fake-timers`, sem alterar o código dos providers nem pular backoff. Testes específicos avançam até imediatamente antes/depois do delay esperado e validam cancelamento por abort.
- Tavily + Exa + backoff, juntos: **0,225 segundo** (mais casos que o Tavily isolado acima). Esta comparação demonstra a remoção das esperas, não uma razão exata de aceleração entre cargas idênticas.
- Suíte completa: **293/293 no Node (~6,9 s)** e **293/293 no Vitest (~7,5 s)**. Inicialização, imports e integração continuam tendo custo.

## Mesma amostra de mutação

Alvo: `canonical-url.ts:9-9` (`canonicalHost`), 5 mutantes, concorrência 4.

| Runner | Tempo Stryker | Mortos | Timeouts | Sobreviventes | Score |
|---|---:|---:|---:|---:|---:|
| Command (antes) | ~70 s | 4 | 1 | 0 | 100% |
| Vitest perTest (depois) | ~35 s | 5 | 0 | 0 | 100% |

O Vitest reportou **44,6 testes executados por mutante em média**, contra uma suíte atual de 293 testes. A suíte ganhou 7 casos de backoff entre essas medições; o alvo e os 5 mutantes são os mesmos. O score padrão do Stryker considera timeout como detecção; por isso o resultado novo é mais forte apesar do mesmo percentual.

O gate é exercitado por `npm run test:mutation:smoke` em um Git descartável: conteúdo staged isolado, aprovação com testes fortes, rejeição com testes fracos e falha da suíte normal. A regressão também verifica cobertura por teste no JSON e que um teste não relacionado não cobre os mutantes.

## Limites e reprodução

- O limite continua em **85%**; não foram adicionadas exclusões para melhorar artificialmente o score.
- A amostra não permite extrapolar o tempo ou o score dos 3.304 mutantes. A base completa precisa ser medida novamente.
- A seleção pode continuar ampla em módulos usados por muitos testes ou mutantes estáticos. O runner deve executar esses testes, não restringi-los manualmente para caber no prazo.
- Testes alterados mutam a produção que alcançam (grafo de referências), não mais a base completa. Testes de integração via `research-harness.mjs` ou `index.ts` ainda alcançam quase toda a produção; testes unitários de módulo ficam restritos a 1–3 arquivos.
- Infraestrutura de execução (configs, scripts de teste, versões de Stryker/Vitest) ainda exige base completa; release (`version`) e bump de dependência de runtime rodam só a suíte normal.
- Não há cache incremental; mudanças nos testes nunca herdam aprovação anterior.

```sh
npm ci
npm test
npm run test:vitest
npm run test:mutation:smoke
# Depois de commitar a implementação (usa HEAD):
npm run test:mutation:full
```

A medição da implementação ainda não commitada é feita em snapshot temporário de HEAD + alterações locais, sem alterar o index. Seus relatórios ficam em `reports/mutation-baseline/`; a amostra real validada fica em `reports/mutation-vitest-sample/`. Esses diretórios são ignorados pelo Git. O relatório JSON registra os fontes instrumentados, configuração e resultados.

## Redução de custo do gate

- Escopo por impacto em `scripts/mutation-scope.mjs` (ver README). Antes, qualquer mudança em `web-search.tests/`, `scripts/`, `package.json` ou `package-lock.json` disparava os ~3.304 mutantes, inclusive commits de release e bumps do Dependabot.
- Mutação fora do pre-commit: o hook roda só a suíte normal sobre o snapshot staged (`--tests-only`). Testes alterados que alcançam `index.ts`/harness geram ~3.400 mutantes, inviáveis no commit; o CI é o gate obrigatório e `npm run test:mutation` fica disponível para execução manual.
- `concurrency` usa o padrão do Stryker (n-1 núcleos; n se n <= 4). Cada worker já roda o Vitest com um único worker, então não há multiplicação de processos.
- `timeoutMS` 30 s → 10 s. O limite efetivo continua sendo `timeoutFactor` × tempo medido dos testes que cobrem o mutante + `timeoutMS`. Timeout conta como detecção; se aparecerem timeouts suspeitos em máquina carregada, aumente este valor, nunca o reduza abaixo do padrão (5 s).
- O smoke deixou de ser um passo fixo do CI: roda dentro do gate quando `scripts/mutation*.mjs` muda ou em base completa. Medido localmente: ~18 s.
