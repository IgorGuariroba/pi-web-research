# pi-web-research

Extensão de pesquisa web para o [Pi Coding Agent](https://github.com/earendil-works/pi) que delega buscas a um **subagente isolado** e devolve ao agente principal apenas a síntese final e as fontes — o contexto do agente pai nunca recebe resultados brutos de busca.

## Como funciona

O agente pai só enxerga a tool `research`. Ao ser chamada, ela sobe uma sessão de agente isolada (via SDK do Pi), com apenas duas tools internas:

- `web_search` — busca através do provider configurado (Tavily, Exa ou Goose)
- `fetch_url` — lê uma página HTTP(S) pública, converte para texto e trunca

O subagente investiga, sintetiza e retorna somente o resultado final com as fontes citadas. Se o subagente falhar, a tool cai em um fallback com os resultados brutos da busca, marcado como "sem síntese".

```
research(goal, focus?, depth?) → subagente isolado → web_search / fetch_url → síntese + fontes
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

1. Escolher o provider de busca (Tavily ou Exa) e colar a chave de API — validada antes de salvar.
2. Escolher o modelo usado pelo subagente de pesquisa (qualquer modelo disponível no seu catálogo).

As credenciais e preferências ficam em `~/.pi/agent/extensions/web-search/state.json`, criado com permissão `0600`.

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
- `focus` (opcional) — o que interessa ao agente pai; garante que só o essencial retorne ao contexto
- `depth` (opcional, padrão `quick`):
  - `quick` — até 2 buscas e 2 leituras de página, resposta curta
  - `deep` — até 8 buscas e 8 leituras de página, investigação multi-fonte

Exemplo de chamada feita pelo modelo:

```json
{
  "goal": "versão estável (LTS) atual do Node.js",
  "focus": "somente o número da versão",
  "depth": "quick"
}
```

Resposta recebida pelo agente pai — apenas a síntese, nunca os resultados brutos:

```
Versão LTS atual do Node.js: v24.18.0

Fontes:
- https://nodejs.org/en
```

## Licença

[MIT](LICENSE)
