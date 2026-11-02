/**
 * model-picker.ts — seletor do Modelo de pesquisa com filtro por digitação.
 *
 * Com centenas de modelos disponíveis (ex.: OpenRouter), a lista crua é
 * inutilizável. Digitar filtra por nome, provider e id (fuzzy, como o seletor
 * de modelos do Pi); setas/enter/esc operam sobre a lista filtrada.
 */
import { fuzzyFilter, Input, matchesKey, SelectList, type SelectItem } from "@earendil-works/pi-tui";
import type { ThemeColor } from "@earendil-works/pi-coding-agent";

export interface PickableModel {
  provider: string;
  id: string;
  name?: string;
}

interface PickerTheme {
  fg: (color: ThemeColor, text: string) => string;
}

const MAX_VISIBLE = 12;
/** Teclas que operam a lista; todo o resto vai para o campo de filtro. */
const LIST_KEYS = ["up", "down", "pageUp", "pageDown", "enter", "escape"] as const;

/** Valor do item: `provider\0id` (o id pode conter `/`). */
export const modelValue = (model: PickableModel) => `${model.provider}\u0000${model.id}`;

/** Decompõe `provider\0id` de volta em provider e id. */
export function parseModelValue(value: string): { provider: string; id: string } {
  const sep = value.indexOf("\u0000");
  if (sep === -1) return { provider: value, id: "" };
  return { provider: value.slice(0, sep), id: value.slice(sep + 1) };
}

/** Componente para `ctx.ui.custom`: devolve `provider\0id` em `done`, ou `null` ao cancelar. */
export function createModelPicker(models: readonly PickableModel[], theme: PickerTheme, done: (value: string | null) => void) {
  const items: SelectItem[] = models.map((model) => ({
    value: modelValue(model),
    label: model.name ?? model.id,
    description: `${model.provider}/${model.id}`,
  }));
  const listTheme = {
    selectedPrefix: (t: string) => theme.fg("accent", t),
    selectedText: (t: string) => theme.fg("accent", t),
    description: (t: string) => theme.fg("muted", t),
    scrollInfo: (t: string) => theme.fg("dim", t),
    noMatch: (t: string) => theme.fg("warning", t),
  };
  const input = new Input({ prompt: "Filtrar: ", placeholder: "digite nome, provider ou id" });
  input.focused = true;
  let filtered = items;
  let list = new SelectList(filtered, MAX_VISIBLE, listTheme);
  const rebuild = () => {
    const query = input.getValue().trim();
    filtered = query ? fuzzyFilter(items, query, (item) => `${item.label} ${item.description}`) : items;
    list = new SelectList(filtered, MAX_VISIBLE, listTheme);
    list.onSelect = (item) => done(item.value);
    list.onCancel = () => done(null);
  };
  rebuild();
  return {
    render: (width: number) => [
      ...input.render(width),
      ...(filtered.length
        ? list.render(width)
        : [theme.fg("warning", "  Nenhum modelo corresponde ao filtro")]),
      theme.fg("dim", `  ${filtered.length}/${items.length} modelos · ↑↓ navegar · enter selecionar · esc cancelar`),
    ],
    invalidate: () => { input.invalidate(); list.invalidate(); },
    handleInput: (data: string) => {
      if (LIST_KEYS.some((key) => matchesKey(data, key))) {
        list.handleInput(data);
        return;
      }
      input.handleInput(data);
      rebuild();
    },
  };
}
