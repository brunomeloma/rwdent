-- RWDent — Correção de segurança do bucket "galeria"
-- Execute no Supabase SQL Editor após backup.
-- Não apaga nenhum arquivo, paciente ou registro — só corrige permissões.
--
-- Achado (pentest): o bucket "galeria" foi criado como público
-- (supabase-seguranca.sql) e as policies de storage.objects não
-- verificavam a clínica do usuário — qualquer pessoa autenticada de
-- QUALQUER clínica podia ler, sobrescrever ou apagar fotos/radiografias
-- de QUALQUER outra clínica, e o bucket público permitia leitura sem
-- login nenhum a quem tivesse a URL. Fotos e radiografias são dado
-- sensível de saúde (LGPD art. 5º).
--
-- Esta correção:
--   1. Torna o bucket privado (leitura só via URL assinada com expiração,
--      já implementado no app.js com createSignedUrls()).
--   2. Restringe SELECT/INSERT/DELETE em storage.objects ao primeiro
--      segmento do caminho do arquivo (a clínica dona), usando
--      storage.foldername() — o mesmo padrão de isolamento das
--      demais tabelas do sistema.

update storage.buckets set public = false where id = 'galeria';

alter policy "galeria_select" on storage.objects
  using (
    bucket_id = 'galeria'
    and (storage.foldername(name))[1] in (
      select id::text from clinicas where user_id = auth.uid()
    )
  );

alter policy "galeria_insert" on storage.objects
  with check (
    bucket_id = 'galeria'
    and (storage.foldername(name))[1] in (
      select id::text from clinicas where user_id = auth.uid()
    )
  );

alter policy "galeria_delete" on storage.objects
  using (
    bucket_id = 'galeria'
    and (storage.foldername(name))[1] in (
      select id::text from clinicas where user_id = auth.uid()
    )
  );
