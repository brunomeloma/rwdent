# Login separado da secretária — Design

Data: 2026-07-24
Status: aprovado pelo dono (aguardando execução em fases)

## Objetivo

Dar à secretária da clínica um **login próprio** (e-mail e senha dela), em vez
de ela usar o mesmo login do dono. No login de secretária, o site funciona
normalmente — inclusive registrar vendas do dia — mas ficam escondidas
exatamente as telas financeiras que **já hoje** estão atrás do PIN financeiro.

A separação passa a ser por **identidade** (quem entrou), não por um PIN
compartilhado que qualquer um digita. Isso elimina o ponto fraco do PIN (uma
senha única que vaza) e deixa a experiência da secretária limpa: ela nunca vê
tela financeira, nem um cadeado tentador.

## O que a secretária VÊ (tudo normal)

- Início (com o card de faturamento trocado — ver abaixo)
- Agenda, calendário, lista de espera
- Pacientes, prontuário, odontograma, anamnese, termo, galeria, timeline
- Vendas / Venda Rápida — **registrar venda e receber pagamento do dia**
- Procedimentos, Materiais, Estoque (modo secretária, como já é hoje)
- Captação, Resgate

## O que a secretária NÃO VÊ (as mesmas coisas já protegidas hoje pelo PIN)

- Painel Financeiro (aba `financeiro`)
- Produtividade
- Comissões
- Faturamento **acumulado** do mês (card da Home)

Nada novo é escondido — é o mesmo conjunto que hoje fica atrás de
`_finVerificado` / `api/financeiro-pin.js`. A diferença é que agora o gatilho é
o **papel do login**, não um PIN.

## Troca do card de faturamento

No login de secretária, o card "Faturamento do mês" da Home é substituído por
**"Vendas de hoje"**: começa zerado a cada dia e sobe conforme ela registra
vendas. Serve pra ela saber quanto passou pelo site naquele dia. A conferência
("bater caixa") é **manual, sem recurso no sistema** — o dono compara depois o
total do site com o físico (cartão/dinheiro/pix). Não há função de abrir/fechar
caixa.

## Arquitetura

### 1. Modelo de associação (tabela nova `clinica_membros`)

```
clinica_membros(
  user_id     uuid  -> auth.users
  clinica_id  uuid  -> clinicas
  papel       text  check (papel in ('secretaria'))
  created_at  timestamptz default now()
  primary key (user_id, clinica_id)
)
```

O **dono** continua sendo `clinicas.user_id` (nada muda pra ele). Só a
secretária entra nesta tabela nova. Mudança 100% **aditiva**: enquanto a tabela
estiver vazia, o sistema se comporta exatamente como hoje.

RLS da própria `clinica_membros`: cada usuário lê as próprias linhas; o dono da
clínica lê/gerencia os membros da clínica dele; admin vê tudo.

### 2. Regra de segurança do banco (RLS) reconhece a secretária

Hoje o helper que diz "quais clínicas são suas" considera só o dono
(`clinicas.user_id = auth.uid()`). No banco de produção esse helper se chama
**`my_clinica_ids()`** (confirmado no dump de policies do pentest); o script do
repositório usa o nome `rwdent_user_clinica_ids()`. **Antes de editar, conferir
a definição real da função no banco** (`select prosrc from pg_proc where
proname='my_clinica_ids'`) e estender a MESMA função que as policies usam.

A extensão é um UNION aditivo:

```
-- clínicas onde sou dono (como hoje)
select id from clinicas where user_id = auth.uid()
union
-- clínicas onde sou membro (novo)
select clinica_id from clinica_membros where user_id = auth.uid()
```

Seguro por padrão: tabela de membros vazia → resultado idêntico ao de hoje.

Helper novo `meu_papel(clinica_id)` → retorna `'dono'` ou `'secretaria'`, usado
tanto no servidor quanto (informativamente) no cliente.

### 3. Criar o login da secretária (fluxo do dono)

Criar um usuário no Supabase Auth exige a service role — então é um endpoint
novo, no mesmo padrão dos que já existem (`api/admin-reset-demo-password.js`,
`api/mercadopago-criar-assinatura.js`):

`api/criar-secretaria.js`:
- valida o token do chamador e confirma que ele é **dono** de uma clínica
  aprovada;
- recebe `email` e `senha` da nova secretária;
- cria o usuário via `sbAdmin.auth.admin.createUser` (e-mail já confirmado);
- insere a linha em `clinica_membros` (papel `secretaria`, clinica_id do dono);
- retorna ok/erro. Nunca deixa criar membro pra clínica alheia (clinica_id vem
  sempre do dono autenticado, nunca do corpo da requisição).

UI: um bloco em Configurações → "Equipe / Acesso da secretária" (só aparece pro
dono): campo e-mail, senha, botão criar; lista de secretárias com opção de
remover (remover = apagar a linha de `clinica_membros`; opcionalmente desativar
o usuário no Auth).

### 4. Gating por papel no cliente

O app já detecta o financeiro via `_finVerificado`. Passa a detectar também o
papel: ao carregar, descobre se o login é `secretaria` (via `clinica_membros`).
Se for:
- esconde as 4 telas protegidas (as mesmas do PIN) — bloqueio no `switchTab` e
  nos menus;
- troca o card "Faturamento do mês" por "Vendas de hoje";
- não mostra a UI de PIN financeiro (não faz sentido pra ela).

Para o dono, nada muda.

## Fronteira de segurança — o que é garantido e o que não é (honesto)

- **Garantido:** as telas financeiras acumuladas nunca aparecem pra secretária;
  fim do PIN compartilhado; separação por identidade real; base pra permissões
  futuras. O login dela, no banco, só alcança a própria clínica.
- **NÃO garantido:** como ela registra vendas, vê o valor de cada venda do dia —
  e faturamento é a soma de vendas. Uma secretária tecnicamente habilidosa e
  mal-intencionada ainda poderia somar as vendas que passam por ela. Blindar até
  isso exigiria reconstruir como as vendas são guardadas (`vendas` hoje é um JSON
  dentro de `financeiro_config`, carregado inteiro) — grande, arriscado e não
  testável fora do banco de produção. **Fora de escopo**, decisão consciente do
  dono (base de confiança).

## Não-objetivos (fora de escopo)

- Recurso de caixa (abrir/fechar/conferir) — conferência é manual.
- Blindagem criptográfica contra um insider técnico (ver fronteira acima).
- Outros papéis além de `dono` e `secretaria`.
- Múltiplas clínicas por dono (o modelo suporta, mas não é foco agora).

## Riscos e como mitigar

- **Mexe em login + RLS, sem eu poder testar no banco real.** Erro aqui pode
  trancar o dono pra fora ou furar o isolamento entre clínicas (que hoje está
  correto). Mitigação: mudanças **aditivas** (membros vazio = comportamento de
  hoje), **backup antes**, e execução **em fases** com o dono validando cada uma
  antes de seguir.
- **Nome da função RLS.** Conferir `my_clinica_ids()` real antes de editar; não
  assumir o nome do script do repo.
- **Criação de usuário.** Só o dono cria; clinica_id sempre do dono autenticado.

## Fases de execução (cada uma testada pelo dono antes da próxima)

1. **Fundação no banco:** tabela `clinica_membros` + RLS dela + estender
   `my_clinica_ids()` + helper `meu_papel()`. Teste: dono continua vendo tudo
   normal (nada quebrou).
2. **Criar login da secretária:** `api/criar-secretaria.js` + UI em
   Configurações. Teste: dono cria o login; secretária consegue entrar e vê a
   clínica (agenda, pacientes, vendas).
3. **Gating por papel:** esconder as 4 telas + trocar card de faturamento por
   "vendas de hoje" no login de secretária. Teste: no login dela o financeiro
   some; no login do dono tudo continua igual.
4. **Remoção/ajuste:** remover secretária, revisar bordas.

## Critério de sucesso

- Dono cria o login da secretária pelo próprio app.
- Secretária entra com conta própria, opera agenda/pacientes/vendas do dia.
- As 4 telas financeiras não aparecem pra ela; o card mostra "vendas de hoje"
  zerando a cada dia.
- Nada muda pro dono. Isolamento entre clínicas segue intacto.
