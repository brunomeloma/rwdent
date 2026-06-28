# RWDent — Arquitetura atual e caminho seguro

## Estado atual

O projeto e um app estatico publicado como arquivos HTML. O front-end conversa direto com o Supabase usando a anon key publica.

Arquivos principais:

- `landing.html`: pagina comercial.
- `index.html`: login/cadastro e redirecionamento para o app.
- `app.html`: aplicacao principal, com agenda, pacientes, financeiro, estoque, odontograma, configuracoes e painel admin interno.
- `admin.html`: painel admin separado.
- `anamnese.html`: ficha publica de saude preenchida pelo paciente.
- `manifest.json`: configuracao PWA basica.

## O que nao deve ser perdido

Dados reais ficam no Supabase, nao nos arquivos HTML:

- pacientes
- estoque
- precos e procedimentos
- financeiro/vendas
- agendamentos
- prontuarios/anamneses
- odontograma

Mudancas no repositorio nao devem executar migracoes destrutivas nem limpar tabelas.

## Pontos de risco

1. `app.html` concentra muita coisa em um unico arquivo. Isso dificulta revisao e aumenta risco de quebrar fluxo ao editar.
2. A seguranca depende muito das policies RLS do Supabase. O JavaScript publicado no navegador nao e barreira de seguranca.
3. `anamnese.html` deve migrar para links com token aleatorio antes de remover suporte ao formato antigo.
4. Admin deve ser validado pelo banco, nao apenas por lista no front-end.

## Ordem segura de melhoria

1. Criar backup do Supabase.
2. Aplicar hardening SQL conservador em ambiente revisado.
3. Adicionar suporte a links de anamnese por token, mantendo fallback antigo temporariamente.
4. Mover CSS/JS aos poucos para pastas separadas, sem reescrever a logica de negocio de uma vez.
5. Adicionar testes simples para funcoes puras antes de refatorar financeiro/estoque.

## Refatoracao recomendada, por etapas

Evite um grande rewrite. Separe por fatias pequenas:

- `assets/css/app.css`
- `assets/js/supabase-client.js`
- `assets/js/auth.js`
- `assets/js/pacientes.js`
- `assets/js/agenda.js`
- `assets/js/financeiro.js`
- `assets/js/odontograma.js`
- `assets/js/admin.js`

Cada etapa deve manter a tela funcionando antes de seguir para a proxima.
