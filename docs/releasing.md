# Validação e publicação

## CI

`npm ci && npm test` executa a suíte offline com HOME descartável e sem chaves
Exa/Tavily. Os scripts `raw-*.test.mjs` são diagnósticos reais opt-in, não testes
automáticos. O check obrigatório da main é `Tests (Node 24)`; a branch deve estar
atualizada antes do merge. Dependabot acompanha npm e GitHub Actions semanalmente.

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

### Auditoria de 2026-11-01

`npm audit` reportou três pacotes afetados na instalação limpa: o peer
`@earendil-works/pi-coding-agent@1.4.0` e suas dependências `undici@8.10.2`
(high) e `minimatch@10.2.6` (moderate). O Pi fixa essas versões exatamente.
`fixAvailable: false` não significa ausência de patches nas bibliotecas:

- undici: avisos consultados corrigidos a partir de 8.12.2;
  https://github.com/advisories/GHSA-2m5v-pch6-74hx
- minimatch: aviso corrigido a partir de 11.0.1;
  https://github.com/advisories/GHSA-g3hv-75wg-m249

Não existe atualização aplicável do Pi no momento da consulta (latest 1.4.0).
Não aplicamos `npm audit fix --force` nem overrides: minimatch exigiria salto
major, e overrides desta extensão não corrigem a instalação externa do Pi host.
A ação necessária é o upstream atualizar essas dependências e publicar uma nova
versão do Pi; depois atualizar o lockfile, executar a suíte e repetir a auditoria.

A API de alertas do Dependabot estava vazia nesta consulta, apesar do resultado
do npm audit. Não tratamos ausência de alerta GitHub como ausência de risco;
sem alerta/PR elegível, o auto-merge não pode remediar essas ocorrências sozinho.

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
