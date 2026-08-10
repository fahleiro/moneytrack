Você vai gerar insights e bets para o moneytrack a partir dos fatos já coletados.

ANTES DE QUALQUER COISA, leia o diretório `.claude/` deste repositório. É de lá que
vem o VIÉS — a lente com que você deve interpretar o material. Sem aplicar essa
lente você produz resumo de notícia, que não serve: um insight sem posição não
gera bet assertiva. Leia também `CLAUDE.md` para as convenções do projeto.

Depois leia `.briefing/briefing.json`. Ele já traz, prontos:

- `factsWithoutInsight` — a FILA DE TRABALHO. Cada fato vem com suas tags, os
  tickers citados, o corpo da matéria (`content`, quando a extração funcionou) e,
  o mais importante, `relatedInsights` e `relatedFacts`: com quem esse fato se
  relaciona por TAG COMPARTILHADA.
- `existingInsights` — as teses já escritas, com tags e apostas.
- `openBets` — as apostas vivas, já resolvidas contra o histórico de preços.
- `catalog` — os ativos com série de preço, com retornos de 1 semana, 1 mês e no
  ano. Só existe aposta sobre ticker que esteja aqui.
- `tagVocabulary` — o vocabulário de tags em uso, com contagem.

## O que fazer

Escreva no máximo {{LIMITE}} insights novos. Para cada um:

1. Agrupe fatos que contam a MESMA história. Um insight nasce de um conjunto de
   fatos que se sustentam, não de uma manchete isolada. Use `relatedFacts` para
   achar o agrupamento.
2. Decida entre ESTENDER uma tese existente ou abrir uma nova. Se
   `relatedInsights` mostra sobreposição forte de tags, provavelmente é extensão
   — e nesse caso o insight novo deve LINKAR para o antigo e dizer o que muda.
3. Tome posição. Diga o que o fato IMPLICA e por quê, não o que ele diz.
4. Só abra bet quando houver tese direcional com ticker no `catalog`. Antes de
   abrir, confira em `catalog` se o movimento JÁ ACONTECEU: entrar depois de uma
   alta de 20% numa semana é perseguir preço, não antecipar. E confira em
   `openBets` se você não está duplicando ou contradizendo uma aposta viva sem
   perceber — se contradiz, diga isso explicitamente no texto.
5. Registre os RISCOS da própria tese, com nomes e números. Um insight que só
   argumenta a favor de si é propaganda, não análise.

Vale escrever insight SEM bet quando o material é contexto ou risco relevante.
Vale também gerar MENOS que o limite: é melhor 2 teses fortes que 5 fracas.

## Formato dos arquivos

Siga exatamente o schema dos arquivos já existentes em `data/insights/` (leia um
ou dois antes). Cada insight é um arquivo `dd-mm-aaaa_HH_MM_SS.json` com:
`code`, `title`, `summary`, `tags`, `source`, `date`, e opcionalmente `bets`,
`assets`, `links`.

Regras que não podem ser quebradas:

- `tags` deve usar o vocabulário de `tagVocabulary`. Só crie tag nova se o tema
  realmente não existir — tag é o que liga os documentos, e vocabulário inflado
  quebra as relações.
- Uma tag só vale se o PRÓPRIO documento a sustenta. Não herde tag do tópico.
- `links` deve apontar para arquivos que existem em `data/insights/`.
- `bets[].ticker` deve existir em `catalog`.
- `date` é o dia do briefing (campo `day`).

## Ao terminar

1. Adicione cada insight novo no topo de `data/insights/insights.json`
   (`{file, title, date}`).
2. No arquivo de fatos do dia (`data/news/<file>` do briefing), marque os fatos
   que você usou: `reviewed: true` e `insight: "<CODE>"`.
3. Valide antes de encerrar: todo JSON parseia, todo link resolve, todo ticker de
   bet existe no catálogo. Se algo falhar, corrija.

Não altere nada fora de `data/insights/` e `data/news/`.
