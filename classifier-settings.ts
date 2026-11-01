/** Configuração do Classificador; credenciais ficam exclusivamente no login nativo do Pi. */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { detectClassifier, type ClassifierChoice } from "./classifier.ts";
import { loadState, saveState, type WebSearchState } from "./state.ts";

export const describeClassifierChoice = (choice: ClassifierChoice | undefined) =>
  choice === undefined || choice === "auto" ? "automático" : choice === "none" ? "desativado (só regras)" : `${choice.provider}/${choice.id}`;

export async function classifierStatus(ctx: ExtensionCommandContext, state: WebSearchState): Promise<string> {
  if (state.classifier === "none") return "desativado (só regras)";
  let classifier;
  try {
    classifier = await detectClassifier(ctx.modelRegistry, state.classifier, { throwOnRegistryError: true });
  } catch {
    return `indisponível/erro — falha ao consultar o model registry do Pi · ${describeClassifierChoice(state.classifier)}`;
  }
  if (!classifier) {
    const history = state.classifierValidation;
    return [
      typeof state.classifier === "object" ? "indisponível — autentique o provider no /login" : "não configurado — conectar Jev",
      describeClassifierChoice(state.classifier),
      history && `último teste: ${history.model} em ${history.testedAt} (${history.ok ? "validado na ocasião" : "erro"}); não garante disponibilidade atual`,
    ].filter(Boolean).join(" · ");
  }
  const last = state.classifierValidation;
  const testStatus = last?.model === classifier.name
    ? `${last.ok ? "conexão validada" : "indisponível/erro"} — último teste: ${last.testedAt}; não garante disponibilidade atual`
    : "configurado — não validado";
  return `${testStatus} · ${classifier.name} · ${describeClassifierChoice(state.classifier)}`;
}

export async function configureClassifier(ctx: ExtensionCommandContext, statePath: string) {
  let available: Awaited<ReturnType<typeof ctx.modelRegistry.getAvailableOfType<"classifier">>>;
  try {
    available = await ctx.modelRegistry.getAvailableOfType("classifier");
  } catch {
    ctx.ui.notify("Não foi possível consultar os classificadores. Verifique o login do provider no Pi.", "warning");
    available = [];
  }
  const AUTO = "automático — detecta pela lista de preferência (Jev, depois Clef)";
  const NONE = "nenhum (só regras)";
  const CONNECT = "Conectar Jev — login nativo do Pi";
  const VALIDATE = "Validar conexão — chamada real de classificação (pode ter custo)";
  const choice = await ctx.ui.select("Classificador", [CONNECT, VALIDATE, AUTO, NONE, ...available.map((m) => `${m.provider}/${m.id}`)]);
  if (!choice) return;
  if (choice === VALIDATE) {
    const classifier = await detectClassifier(ctx.modelRegistry, loadState(statePath).classifier);
    if (!classifier) {
      ctx.ui.notify("Classificador indisponível ou desativado. Escolha Conectar Jev, conclua o /login do Pi e tente novamente.", "warning");
      return;
    }
    ctx.ui.notify(`Validando ${classifier.name} com uma classificação real…`, "info");
    let ok = false;
    try {
      await classifier.judgeResults({
        goal: "Documentação oficial do Node.js",
        query: "Node.js documentação",
        results: [{ title: "Node.js Documentation", url: "https://nodejs.org/api/", summary: "Official Node.js API documentation." }],
      }, AbortSignal.timeout(15_000));
      ok = true;
    } catch {
      // Não reproduzimos mensagens do provider: elas podem conter credenciais ou payloads.
    }
    const latest = loadState(statePath);
    latest.classifierValidation = { model: classifier.name, testedAt: new Date().toISOString(), ok };
    saveState(statePath, latest);
    ctx.ui.notify(ok
      ? `${classifier.name}: conexão validada — último teste; o uso efetivo será informado em cada pesquisa.`
      : `${classifier.name}: indisponível/erro no último teste. Verifique /login, saldo/cota e acesso ao modelo; a pesquisa usará fallback por regras se a falha persistir.`, ok ? "info" : "warning");
    return;
  }
  if (choice === CONNECT) {
    const provider = await ctx.ui.select("Conectar Jev — escolha o provider", [
      "OpenRouter — /login openrouter ou OPENROUTER_API_KEY",
      "TypeSafe — /login typesafe ou TYPESAFE_API_KEY",
    ]);
    if (!provider) return;
    const latest = loadState(statePath);
    latest.classifier = provider.startsWith("OpenRouter")
      ? { provider: "openrouter", id: "typesafe/jev-1.14" }
      : { provider: "typesafe", id: "jev-latest" };
    saveState(statePath, latest);
    ctx.ui.notify(`Jev selecionado, ainda não validado. Conclua /login ${latest.classifier.provider} no Pi (credencial em auth.json, não nesta extensão). Depois abra /web-search → Classificador → Validar conexão. Não é necessário editar o model registry.`, "info");
    ctx.ui.setEditorText(`/login ${latest.classifier.provider}`);
    return;
  }
  const picked = available.find((m) => `${m.provider}/${m.id}` === choice);
  const latest = loadState(statePath);
  latest.classifier = choice === AUTO ? "auto" : choice === NONE ? "none" : { provider: picked!.provider, id: picked!.id };
  saveState(statePath, latest);
  ctx.ui.notify(`Classificador: ${describeClassifierChoice(latest.classifier)} ✓`, "info");
}
