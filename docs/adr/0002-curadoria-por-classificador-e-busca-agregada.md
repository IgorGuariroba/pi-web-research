# Curadoria por classificador barato, guiada pelo Critério do agente pai, com Busca agregada por padrão

O objetivo da extensão é trazer muitas fontes boas sem gastar tokens de chat nem o contexto do Agente pai. Decidimos fazer a curadoria do Funil (Fora do tema, Nível de fonte, Categoria do Critério, relevância dos trechos na Extração focada) com um modelo classificador (Jev, cerca de US$0,04 por milhão de tokens de entrada), com regras determinísticas como fallback quando não houver classificador. Também decidimos consultar todos os Providers com chave em toda busca (Busca agregada) por padrão, aceitando gastar mais cota de API em troca de abrangência, com um modo `econômica` opcional para quem quiser poupar cota.

## Considered Options

- **LLM de chat por página para extrair e classificar** (como o intelli-search): rejeitado, porque multiplica o gasto de tokens a cada leitura, justamente o que a extensão existe para evitar.
- **Somente regras (listas de domínios, sobreposição de termos)**: rejeitado como caminho principal, porque "oficial" depende do assunto e regras não entendem Categorias livres. Fica como fallback.
- **Categorias fixas definidas pela extensão**: rejeitado. O Agente pai é quem sabe que tipo de fonte serve para o problema, então o Critério é passado por chamada e complementa (não substitui) o Nível de fonte genérico.
- **Um Provider por vez como padrão**: rejeitado, porque perde abrangência e o sinal de Concordância. Continua disponível como modo `econômica`.

## Consequences

- Sem classificador disponível, o Critério é ignorado com aviso explícito; a curadoria cai para as regras.
- Busca e leitura passam a depender de uma chamada extra ao classificador, o que aumenta a latência; o timeout do `deep` será recalibrado medindo antes do PR.
- Lacuna declarada e rótulos das Fontes são gerados pelo código a partir do que foi de fato lido e classificado, não pelo subagente.
