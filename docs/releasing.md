# Validação e publicação

## CI

`npm ci && npm test` executa a suíte offline com HOME descartável e sem chaves
Exa/Tavily. Os scripts `raw-*.test.mjs` são diagnósticos reais opt-in, não testes
automáticos. O check obrigatório da main é `Tests (Node 24)`; a branch deve estar
atualizada antes do merge. Dependabot acompanha npm e GitHub Actions semanalmente.

## Configuração inicial do npm (mantenedor)

O workflow não usa token de publicação. Cadastre um Trusted Publisher em
https://www.npmjs.com/package/@igor-guari/pi-web-research/access :

- Provider: GitHub Actions
- Owner: `IgorGuariroba`
- Repository: `pi-web-research`
- Workflow: `publish.yml`
- Environment: `npm`
- Permitir publicação direta (`npm publish`).

Alternativamente, com npm >= 11.15.0, login e 2FA habilitado:

```sh
npm login
npm trust github @igor-guari/pi-web-research \
  --repo IgorGuariroba/pi-web-research \
  --file publish.yml --environment npm --allow-publish
npm trust list @igor-guari/pi-web-research
```

Depois de validar a primeira publicação OIDC, revogue tokens antigos de publicação
no npm e configure o pacote para não permitir publicação por tokens tradicionais.
Não remova credenciais antes de confirmar que o novo fluxo funciona.

## Nova versão

1. Em um PR, atualize `package.json` e `package-lock.json` com a nova versão.
2. Aguarde o CI e faça merge na main.
3. Crie uma GitHub Release publicada (não prerelease), com tag `v<versão>` no commit
   já incorporado à main. A versão deve coincidir exatamente com `package.json`.
4. Aprove o deployment no ambiente `npm` no GitHub Actions.
5. O workflow reinstala dependências, executa testes e publica com OIDC e provenance.

A versão 0.2.1 já publicada não deve ser republicada. Alterar arquivos do workflow
não publica nada por si só. O ambiente GitHub `npm` aceita somente tags `v*` e
solicita aprovação de IgorGuariroba antes da execução.

## Revisão obrigatória

Hoje só existe um mantenedor. A main exige PR, mas zero aprovações para evitar
bloqueio: o autor não pode aprovar o próprio PR. Após adicionar um segundo
mantenedor com permissão de escrita, configure uma aprovação obrigatória em
Settings → Branches → main. Mantenha a aplicação aos administradores, invalidação
de aprovações antigas e resolução obrigatória das conversas.
