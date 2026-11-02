# pi-web-research

Extensão de pesquisa web para o [Pi Coding Agent](https://github.com/earendil-works/pi) que delega buscas a um **subagente isolado** e devolve ao agente principal apenas a síntese final e as fontes — o contexto do agente pai nunca recebe resultados brutos de busca.

## Como funciona

O agente pai só enxerga a tool `research`. Ao ser chamada, ela sobe uma sessão de agente isolada (via SDK do Pi), com apenas duas tools internas:

- `web_search` — **Busca agregada**: consulta todos os providers com chave (Tavily e Exa) em paralelo, remove duplicatas pela URL canônica e trata a Concordância entre providers como sinal positivo
- `fetch_url` — lê uma página HTTP(S) pública (segue redirects revalidando cada salto contra host local/IP privado), limpa menu e rodapé com Readability e devolve só os trechos mais relevantes ao goal/focus/query (~5k caracteres). PDF não é suportado e não consome orçamento

Entre a busca e o subagente há um **Funil** de curadoria:

```
busca agregada → descarte (spam, Fora do tema, Categorias de descarte) → classificação (Nível, Categoria) → leitura → Síntese
```

- **Classificador barato** (Jev via OpenRouter/TypeSafe/Cloudflare/opencode; depois Clef), detectado automaticamente: descarta resultados Fora do tema, atribui o **Nível de fonte** (`oficial`, `docs`, `blog`, `fórum`) e a Categoria do Critério, e reordena os trechos lidos. Sem classificador, o Funil usa só regras (domínios para o Nível, sobreposição de termos para os trechos), com aviso.
- O subagente vê no máximo 8 resultados por busca, rotulados `[categoria · nível · providers]`.
- **Fontes verificadas**: a seção "Fontes" só aceita páginas efetivamente lidas. Citações não lidas geram um pedido de correção ao subagente; as que persistirem são removidas. Cada fonte ganha o rótulo `[categoria · nível]`. Sem nenhuma Fonte lida, a Síntese vem marcada como **não verificada**.
- Na TUI, o progresso mostra o Funil ao vivo e termina com a linha `32 resultados → 14 após descarte → 6 lidos`. Os `details` da tool trazem os contadores do Funil, leituras por Categoria, o Modelo de pesquisa, o classificador e o custo dele.

Se o subagente falhar, a tool cai em um **Fallback cru**: resultados da Busca agregada sem duplicatas e ordenados por Nível, marcados como "sem síntese".

```
research(goal, focus?, depth?, criteria?) → subagente isolado → web_search / fetch_url → Síntese + Fontes verificadas
```

## Instalação

Como pacote Pi, direto do GitHub (recomendado):

```bash
pi install https://github.com/IgorGuariroba/pi-web-research
```

Via npm (após publicação no registry):

```bash
pi install npm:@igor-guari/pi-web-research
```

Ou manualmente, copiando a pasta para as extensões do Pi:

```bash
mkdir -p ~/.pi/agent/extensions
cp -r pi-web-research ~/.pi/agent/extensions/web-search
```

Em sessões do Pi já abertas, rode `/reload` para carregar a extensão.

## Configuração

Use o comando `/web-search` na TUI para:

1. **Provider** — escolher Tavily ou Exa e colar a chave de API (validada antes de salvar). Para providers configurados, oferece **Usar chave atual**, **Trocar chave** e **Remover chave salva/desconectar**. Cancelar a troca ou falhar na validação preserva a chave anterior; em HTTP 401/403, é possível trocar a chave ou voltar ao menu. Com as duas chaves, ambas entram na Busca agregada; o Goose (CLI) só é usado quando nenhum provider tem chave.
2. **Modelo de pesquisa** — entrada independente para escolher ou trocar o modelo do subagente sem reconfigurar providers ou revalidar chaves. Cancelar preserva a escolha anterior. Também é oferecido após configurar um provider. Sem escolha salva, usa o primeiro modelo barato disponível (Haiku → Flash → mini) e, na falta, o modelo atual do agente pai.
3. **Modo de busca** — `agregada` (padrão: todos os providers com chave em paralelo) ou `econômica` (um provider por vez; o próximo só em erro ou resultado vazio, para poupar cota).
4. **Classificador** — conectar Jev pelo login nativo do Pi, validar a conexão com uma chamada real, escolher `automático` (padrão), um modelo específico ou `nenhum (só regras)`. A entrada mostra status de configuração, provider/modelo e o último teste, quando houver.
5. **Domínios bloqueados** — lista extra de domínios tratados como spam (além da lista fixa), separados por vírgula; subdomínios também são bloqueados. A lista digitada substitui a atual; vazio limpa.

### Conectar Jev (OpenRouter ou TypeSafe)

1. `/web-search` → **Classificador** → **Conectar Jev** → escolha **OpenRouter** ou **TypeSafe**.
2. A extensão prepara `/login openrouter` ou `/login typesafe` no editor. Confirme o comando e conclua o login nativo do Pi com a chave do provider. Não é necessário editar o model registry.
3. Volte a `/web-search` → **Classificador** → **Validar conexão**. O teste faz uma classificação real (pode ter custo), com timeout de 15s. Uma resposta incompleta ou um erro não contam como validação.

Alternativamente, inicie o Pi com `OPENROUTER_API_KEY` ou `TYPESAFE_API_KEY`. As credenciais do Classificador são gerenciadas pelo Pi (`auth.json`/ambiente); **não** são salvas no estado da extensão. A escolha fica separada do Modelo de pesquisa e das chaves Tavily/Exa.

O status distingue **não configurado**, **configurado — não validado**, **conexão validada** (com data do último teste, sem garantia de disponibilidade atual), **indisponível/erro** e **desativado (só regras)**. Em cada pesquisa, o progresso e a notificação final informam **Jev usado**, **outro classificador usado** ou **fallback por regras**, inclusive em falhas parciais. Os `details.classifierUsage` registram chamadas bem-sucedidas, falhas e fallback; o menu também mostra o uso da última pesquisa na sessão.

As credenciais dos providers de busca e preferências ficam em `~/.pi/agent/extensions/web-search/state.json`, criado com permissão `0600`:

```json
{
  "activeProvider": "tavily",
  "keys": { "tavily": "tvly-...", "exa": "..." },
  "researchModel": { "provider": "openrouter", "id": "anthropic/claude-haiku-4.5" },
  "searchMode": "agregada",
  "classifier": "auto",
  "blockedDomains": ["fazenda-de-conteudo.com"]
}
```

O menu informa a origem da credencial: `state.json` ou variável de ambiente. A chave salva tem prioridade; removê-la faz valer `TAVILY_API_KEY`/`EXA_API_KEY`, se definida. Nesse caso o provider continua disponível, e é necessário remover a variável de ambiente para desconectá-lo por completo.

### Variáveis de ambiente

| Variável | Efeito |
|---|---|
| `TAVILY_API_KEY` | Chave da API Tavily (alternativa a configurar via `/web-search`) |
| `EXA_API_KEY` | Chave da API Exa (alternativa a configurar via `/web-search`) |
| `PI_GOOSE_PATH` | Caminho customizado do binário `goose` (provider CLI) |
| `PI_WEB_SEARCH_TIMEOUT_MS` | Timeout por chamada de busca |
| `PI_WEB_SEARCH_MAX_TURNS` | Máximo de turnos internos do provider Goose |

## Uso

O modelo escolhe a tool `research` normalmente durante a conversa. Parâmetros:

- `goal` (obrigatório) — o que precisa ser descoberto, não uma query literal
- `focus` (opcional) — o que interessa ao agente pai ou o formato desejado da Síntese
- `depth` (opcional, padrão `quick`):
  - `quick` — até 3 buscas e 4 leituras de página em 90s, resposta curta
  - `deep` — até 12 buscas e 15 leituras de página em 180s, investigação multi-fonte
- `criteria` (opcional) — **Critério**: 2 a 8 Categorias `{ category, description, discard? }` em ordem de prioridade, com ao menos uma sem `discard`. O subagente busca ativamente cada Categoria, lê para cobri-las (no `deep`, todas as não descartadas; no `quick`, as duas primeiras) e a Síntese termina com **"Não encontrado"** listando as Categorias sem nenhuma Fonte lida. Resultados de Categorias com `discard: true` nunca chegam ao subagente. Exige classificador; sem ele, o Critério é ignorado com aviso no topo da Síntese e nos `details`.

Uma Busca agregada conta como uma única busca no orçamento.

Exemplo simples:

```json
{
  "goal": "versão estável (LTS) atual do Node.js",
  "focus": "somente o número da versão",
  "depth": "quick"
}
```

Exemplo com Critério:

```json
{
  "goal": "Bun está maduro para servidores HTTP em produção?",
  "depth": "deep",
  "criteria": [
    { "category": "relato-producao", "description": "relatos de equipes que usam Bun em produção" },
    { "category": "benchmark", "description": "benchmarks independentes e reproduzíveis" },
    { "category": "docs-oficiais", "description": "documentação oficial do Bun ou do Node.js" },
    { "category": "marketing", "description": "páginas promocionais do fabricante", "discard": true }
  ]
}
```

Resposta recebida pelo agente pai — apenas a Síntese, nunca os resultados brutos:

```
Bun é viável para APIs HTTP simples, mas ...

Fontes
- https://bun.sh/docs/runtime/nodejs-apis [docs-oficiais · oficial]
- https://example-eng-blog.com/bun-in-production [relato-producao · blog]

Não encontrado
- benchmark: benchmarks independentes e reproduzíveis
```

## Validação

```sh
npm ci
npm test
npm run test:vitest
```

A suíte usa HOME descartável e não faz buscas reais. O comparativo real da #13 e suas limitações estão em [docs/measurements/issue-13.md](docs/measurements/issue-13.md). A recalibração com Jev autenticado continua pendente; esta versão não altera o limiar de Fora do tema (0,7) nem o timeout do `deep` (180s).

### Hook de pré-commit

Ative o hook versionado uma vez em cada clone:

```sh
git config core.hooksPath .githooks
```

A `main` só muda via PR. Os hooks bloqueiam localmente commit na `main` (`pre-commit`) e push para `main` (`pre-push`), antes de esbarrar na proteção do GitHub.

Requer Node.js 24 e `npm ci` (incluindo devDependencies). O hook bloqueia o commit se qualquer etapa falhar:

1. `git diff --cached --check`: whitespace e marcadores de conflito adicionados.
2. `npm test`: suíte normal sobre uma cópia exata do **conteúdo staged**.
3. StrykerJS: mutation testing no escopo do diff (abaixo), com **score mínimo de 85%**, configurado em `stryker.config.mjs`. O hook usa `--defer-full`: quando a infraestrutura de testes muda, ele valida o escopo do diff e delega a base completa ao CI. Nesse modo a mutação tem limite de **5 minutos** (`MUTATION_TIME_LIMIT_SECONDS`); se estourar, o Stryker é interrompido, o commit segue e a validação fica só para o CI.

Código e testes unstaged/untracked não participam da aprovação. O snapshot usa `git write-tree` e `git archive`, sem criar commits ou alterar o index. As dependências instaladas são compartilhadas; mantenha manifesto e lockfile alinhados ao snapshot e rode `npm ci` após mudanças de dependências.

O escopo é escolhido por impacto (`scripts/mutation-scope.mjs`):

- **Linhas TypeScript** adicionadas/modificadas são mutadas. Hunks de deleção pura validam o arquivo restante inteiro. Arquivos removidos não têm código para mutar.
- **Testes e helpers alterados** em `web-search.tests/` mutam, inteiros, os arquivos de produção alcançados (transitivamente, nas versões anterior e nova) por qualquer teste que alcance o arquivo alterado. Um teste enfraquecido ou removido é avaliado contra toda a produção que ele exercitava. Todo literal com caminho de módulo conta como aresta, inclusive imports dinâmicos e arquivos executados por subprocesso.
- **Base completa** quando muda a execução dos testes: `stryker.config.mjs`, `vitest.config.mjs`, `tsconfig.json`, scripts fora do gate, campos de `package.json` que não sejam metadados (por exemplo `scripts`, `type`) e versões de Stryker/Vitest/Vite/tinypool/fake-timers em `package.json` ou `package-lock.json`.
- **Gate alterado** (`scripts/mutation*.mjs`): roda o smoke end-to-end.
- **Metadados, dependências de runtime e documentação**: apenas a suíte normal (ou nada, se só documentação mudou). Sem mutantes gerados não há score mensurável — isso não significa cobertura de 100%.

```sh
npm run test:mutation                  # snapshot staged + diff
node scripts/mutation.mjs --base main  # HEAD comparado à base (conteúdo commitado)
npm run test:mutation:full             # base completa do HEAD, não working tree
npm run test:mutation:smoke            # verifica o gate em repositório descartável
```

O limite de 85% é agregado no escopo selecionado, não uma garantia por linha ou do projeto inteiro. Mutantes sobreviventes aparecem em `reports/mutation/index.html` e `reports/mutation/mutation.json`. Não há reutilização incremental de resultados. O runner Vitest coleta cobertura por teste em uma execução inicial completa (`related: false`) e seleciona os testes que exercitam cada mutante. Mutantes estáticos podem exigir uma execução mais ampla. Casos sem cobertura continuam reprovando o score; não são descartados para acelerar.

Os arquivos continuam usando `node:test` em `npm test`. No Vitest, um adaptador limitado às APIs usadas pela suíte preserva registro de testes e cleanup (`t.after`); ambos os runners são validados no CI. O pool é `forks`, pois `threads` apresentou falhas nos testes de credenciais/ambiente. Cada arquivo recebe HOME descartável e chaves de busca vazias. Os testes de retry usam relógio controlado, executando os timers reais da implementação sem esperas de parede. Testes específicos verificam os delays e o cancelamento do timer por abort.

Medições e limitações: [docs/measurements/mutation-testing.md](docs/measurements/mutation-testing.md). Exclusões de mutantes equivalentes devem ser pontuais, com justificativa no código usando as diretivas do Stryker, nunca uma redução silenciosa do limite.

O CI repete o gate sem `--defer-full`: diff contra a base do PR ou o commit anterior do push; execução manual (`workflow_dispatch`) mede a base completa. Relatórios ficam como artefatos do job. Erros de execução bloqueiam a aprovação; o job tem limite de 360 minutos. A validação inicial instrumentou 23 arquivos e gerou 3.304 mutantes. A amostra com seleção por cobertura passou, mas isso não comprova que a base completa já atinge 85%. Configure o check **Mutation score (85%)** como obrigatório na proteção da branch para impedir merge sem aprovação. Hooks locais podem ser ignorados e não substituem essa proteção.

## Licença

[MIT](LICENSE)
