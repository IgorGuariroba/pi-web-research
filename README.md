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

1. **Provider** — escolher Tavily ou Exa e colar a chave de API (validada antes de salvar). Com as duas chaves, ambas entram na Busca agregada; o Goose (CLI) só é usado quando nenhum provider tem chave.
2. **Modelo de pesquisa** — escolher o modelo do subagente (oferecido logo após configurar um provider). Sem escolha salva, usa o primeiro modelo barato disponível (Haiku → Flash → mini) e, na falta, o modelo atual do agente pai.
3. **Modo de busca** — `agregada` (padrão: todos os providers com chave em paralelo) ou `econômica` (um provider por vez; o próximo só em erro ou resultado vazio, para poupar cota).
4. **Classificador** — `automático` (padrão), um modelo classificador específico ou `nenhum (só regras)`.
5. **Domínios bloqueados** — lista extra de domínios tratados como spam (além da lista fixa), separados por vírgula; subdomínios também são bloqueados. A lista digitada substitui a atual; vazio limpa.

As credenciais e preferências ficam em `~/.pi/agent/extensions/web-search/state.json`, criado com permissão `0600`:

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
  - `deep` — até 12 buscas e 15 leituras de página em 300s, investigação multi-fonte
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

## Licença

[MIT](LICENSE)
