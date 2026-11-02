# AGENTS.md

Instruções e diretrizes operacionais para agentes de IA atuando no repositório `pi-web-research`.

## Visão Geral

`pi-web-research` é uma extensão para o [Pi Coding Agent](https://github.com/earendil-works/pi) que expõe a ferramenta `research` ao agente pai. Toda a busca e leitura web ocorre em um **subagente isolado** em processo com contexto limpo; o contexto do agente pai recebe exclusivamente a Síntese final e a lista de Fontes lidas.

## Referências de Contexto

Consulte antes de modificar regras de negócio, arquitetura ou validações:

- [CONTEXT.md](CONTEXT.md): Glossário oficial e terminologia canônica do domínio (**Agente pai**, **Subagente de pesquisa**, **Funil**, **Busca agregada**, **Critério**, **Síntese**, **Fonte lida**, **Fallback cru**). Mantenha aderência estrita a esses termos em código, testes e documentação.
- [docs/adr/](docs/adr/): Registro de decisões de arquitetura (ADR 0001: subagente isolado; ADR 0002: curadoria por classificador e busca agregada).
- [docs/measurements/](docs/measurements/): Medições de desempenho, calibrações de limiar e benchmarks de mutação.
- [docs/releasing.md](docs/releasing.md): Políticas de CI, auditoria de dependências e regras de publicação.

## Mapa da Base de Código

O projeto usa TypeScript ESM nativo (`"type": "module"`), sem etapa de compilação intermediária. A extensão é carregada diretamente pelo Pi a partir de `index.ts`.

- `index.ts`: Ponto de entrada da extensão. Registra a tool `research`, o comando `/web-search` e o fluxo da TUI.
- `research-runner.ts` / `research-run.ts`: Ciclo de vida da pesquisa, criação do subagente isolado via SDK do Pi, controle de orçamento (`quick` vs `deep`) e timeouts.
- `aggregate-search.ts`: Busca agregada paralela em múltiplos providers com deduplicação por URL canônica.
- `http-search-provider.ts`, `tavily-provider.ts`, `exa-provider.ts`, `goose-provider.ts`: Adaptadores de busca. Goose CLI é reservado para fallback quando nenhuma API key está configurada.
- `classifier.ts` / `classifier-settings.ts`: Interface com o classificador semântico (Jev/Clef) e fallback para regras estáticas.
- `curation.ts` / `criteria.ts` / `source-level.ts`: Funil de curadoria — descarte por spam/fora do tema, classificação em Categorias do Critério e ordenação por Nível de fonte.
- `fetch-url.ts` / `focused-extract.ts` / `read-sources.ts`: Leitura segura de páginas, proteção contra SSRF em redirects, limpeza via Readability e extração focada em ~5k caracteres.
- `state.ts`: Persistência local em `~/.pi/agent/extensions/web-search/state.json` com permissões seguras (`0600`/`0700`).
- `web-search.tests/`: Suíte de testes automatizados com mocks, HOME isolado e fake timers.

## Comandos de Desenvolvimento e Validação

Execute as validações nesta ordem antes de concluir qualquer tarefa:

```sh
# 1. Instalação exata de dependências
npm ci

# 2. Suíte de testes com runner padrão (node:test)
npm test

# 3. Suíte de testes via Vitest (necessário para compatibilidade Stryker)
npm run test:vitest

# 4. Teste de mutação nas alterações staged (gate obrigatório: >= 85%)
npm run test:mutation
```

Comandos adicionais para mutação e diagnóstico:

- `node scripts/mutation.mjs --base main`: Avalia mutação do HEAD contra a branch base.
- `npm run test:mutation:full`: Avalia mutantes em toda a base de código.
- `npm run test:mutation:smoke`: Executa o teste de fumaça do gate de mutação em repositório temporário.

Ao clonar ou preparar o ambiente, habilite o hook versionado:
```sh
git config core.hooksPath .githooks
```

## Invariantes e Regras Não Negociáveis

1. **Proteção do Contexto do Agente Pai**: Resultados brutos de busca e dumps de páginas nunca devem chegar ao agente pai. Em caso de falha do subagente, o retorno é o `Fallback cru` explicitamente marcado.
2. **Fontes Verificadas**: Apenas páginas efetivamente lidas com sucesso via `fetch_url` podem constar na seção "Fontes" da Síntese. Citações não lidas devem disparar reprompt corretivo ou ser expurgadas. Sem páginas lidas, a resposta é classificada como **Síntese não verificada**.
3. **Isolamento de Testes**: Testes automatizados executam 100% offline. Nunca realize requisições reais ou dependa de chaves externas de API na suíte padrão. Arquivos `raw-*.test.mjs` são diagnósticos manuais opt-in.
4. **Segurança de Rede (SSRF)**: `fetch_url` deve validar e bloquear estritamente hosts locais, IPs privados (`127.0.0.1`, `10.0.0.0/8`, `169.254.169.254`, etc.) e esquemas não-HTTP(S) em cada salto de redirect.
5. **Permissões de Arquivos Sensíveis**: Qualquer arquivo que armazene credenciais ou estado de usuário deve ser mantido com permissão `0600` e seu diretório pai com `0700`.
6. **Threshold de Mutação (85%)**: Toda nova funcionalidade ou correção de bug em TypeScript deve ser acompanhada de testes que eliminem mutantes. Nunca reduza o score mínimo em `stryker.config.mjs`. Mutantes equivalentes reais devem receber anotação de exclusão pontual no código (`// Stryker disable ...`) com justificativa explícita.
