# Validação e publicação

## CI

`npm ci && npm test` executa a suíte offline com HOME descartável e sem chaves
Exa/Tavily. Os scripts `raw-*.test.mjs` são diagnósticos reais opt-in, não testes
automáticos. Os checks obrigatórios da main (ruleset `default-branch: protection`)
são `Tests (Node 24)`, `Mutation score (85%)` e `Secret scan (gitleaks)`; a branch
deve estar atualizada antes do merge, só squash é permitido e tags `v*` (ruleset
`tags: release`) só podem ser criadas pelo admin e nunca movidas ou apagadas. Dependabot acompanha npm e GitHub Actions semanalmente.

## Atualizações automáticas de segurança

O workflow `dependabot-auto-merge.yml` habilita auto-merge somente quando:

- O PR é do `dependabot[bot]`, originado neste repositório e direcionado à main.
- A action oficial verifica a autoria e assinatura dos commits do Dependabot.
- O ecossistema é npm e o grupo é `security-patch-minor`, reservado em
  `dependabot.yml` para `security-updates` patch/minor.
- O maior salto semântico do PR é patch ou minor.

O merge continua sujeito ao CI obrigatório, branch atualizada e demais proteções;
nenhuma aprovação é fabricada e não há bypass de administradores. Atualizações
major, atualizações comuns de versão, GitHub Actions e metadados não reconhecidos
ficam para revisão manual. O workflow privilegiado não faz checkout nem executa
código do PR. Se futuramente exigirmos revisão humana, ela também será exigida
para esses PRs automáticos.

### Auditoria de 2026-11-02

`npm audit fix` (sem `--force`) atualizou o lockfile: Pi `1.4.0 → 1.5.0`
(traz `undici@8.12.3` e `minimatch@11.0.3`), `qs 6.15.1 → 6.17.1` e
`typed-rest-client 2.3.1 → 2.3.0`. Restam 3 ocorrências moderate, todas na
cadeia de devDependencies do Stryker (`@stryker-mutator/core@10.1.1` →
`minimatch@10.2.6`), sem correção semver-compatível:
https://github.com/advisories/GHSA-g3hv-75wg-m249

Não aplicamos `--force` nem overrides: o fix exigiria salto major do minimatch
dentro do Stryker, que só roda no desenvolvimento/CI e não é publicado. Aguardar
o upstream do Stryker; o Dependabot abre o PR quando houver versão compatível.

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
