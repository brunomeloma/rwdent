-- ============================================================
-- RWDent — Script de Seguranca para Supabase (RLS + Cadastro)
-- Execute INTEIRO no SQL Editor do Supabase Dashboard.
-- Idempotente: pode rodar mais de uma vez sem erro.
-- Nao quebra o formulario publico de anamnese (usa RPCs rwdent_*).
-- ============================================================

-- ============================================================
-- 0. HELPERS (SECURITY DEFINER evita recursao de RLS)
-- ============================================================

-- Ids das clinicas do usuario logado
CREATE OR REPLACE FUNCTION public.my_clinica_ids()
RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$ SELECT id FROM public.clinicas WHERE user_id = auth.uid() $$;

-- Admin do sistema? (mesmos IDs do _ADMIN_IDS no front-end)
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT auth.uid() IN (
    '09f21b22-76c8-4aee-8af4-9fc292ff08d4'::uuid,
    'b39d8b67-0610-4708-9733-104db7f0307b'::uuid
  )
$$;

REVOKE ALL ON FUNCTION public.my_clinica_ids() FROM public, anon;
REVOKE ALL ON FUNCTION public.is_admin()      FROM public, anon;
GRANT EXECUTE ON FUNCTION public.my_clinica_ids() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_admin()       TO authenticated;

-- ============================================================
-- 1. BUCKET "galeria" + POLICIES DE STORAGE
-- Bucket privado (fotos/radiografias sao dado sensivel de saude — LGPD
-- art. 5o) e policies isoladas por clinica via storage.foldername(name)[1],
-- que e o mesmo prefixo de clinica_id usado no caminho salvo pelo app.js
-- (galeriaUpload/galeriaCarregar, que ja usa createSignedUrls em vez de
-- getPublicUrl). Achado em auditoria/pentest — ver supabase/storage-hardening.sql.
-- ============================================================
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('galeria', 'galeria', false, 10485760)
ON CONFLICT (id) DO UPDATE SET public = false;

DROP POLICY IF EXISTS "galeria_select" ON storage.objects;
DROP POLICY IF EXISTS "galeria_insert" ON storage.objects;
DROP POLICY IF EXISTS "galeria_delete" ON storage.objects;

CREATE POLICY "galeria_select" ON storage.objects FOR SELECT
  TO authenticated USING (
    bucket_id = 'galeria'
    AND (storage.foldername(name))[1] IN (SELECT id::text FROM public.clinicas WHERE user_id = auth.uid())
  );
CREATE POLICY "galeria_insert" ON storage.objects FOR INSERT
  TO authenticated WITH CHECK (
    bucket_id = 'galeria'
    AND (storage.foldername(name))[1] IN (SELECT id::text FROM public.clinicas WHERE user_id = auth.uid())
  );
CREATE POLICY "galeria_delete" ON storage.objects FOR DELETE
  TO authenticated USING (
    bucket_id = 'galeria'
    AND (storage.foldername(name))[1] IN (SELECT id::text FROM public.clinicas WHERE user_id = auth.uid())
  );

-- ============================================================
-- 2. COLUNAS extras em clinicas (salvamento direto de endereco/maps)
-- ============================================================
ALTER TABLE public.clinicas ADD COLUMN IF NOT EXISTS endereco  TEXT DEFAULT '';
ALTER TABLE public.clinicas ADD COLUMN IF NOT EXISTS maps_link TEXT DEFAULT '';

-- ============================================================
-- 3. CLINICAS (dono ve a sua, admin ve todas)
-- ============================================================
ALTER TABLE public.clinicas ENABLE ROW LEVEL SECURITY;

-- remove policies antigas (incluindo a versao anterior "clinicas_own")
DROP POLICY IF EXISTS clinicas_own    ON public.clinicas;
DROP POLICY IF EXISTS clinicas_select ON public.clinicas;
DROP POLICY IF EXISTS clinicas_insert ON public.clinicas;
DROP POLICY IF EXISTS clinicas_update ON public.clinicas;
DROP POLICY IF EXISTS clinicas_delete ON public.clinicas;

CREATE POLICY clinicas_select ON public.clinicas FOR SELECT TO authenticated
  USING ( user_id = (SELECT auth.uid()) OR (SELECT public.is_admin()) );

-- cadastro: so para si mesmo e SEMPRE como 'pendente' (impede auto-aprovacao no insert)
CREATE POLICY clinicas_insert ON public.clinicas FOR INSERT TO authenticated
  WITH CHECK ( user_id = (SELECT auth.uid()) AND status = 'pendente' );

CREATE POLICY clinicas_update ON public.clinicas FOR UPDATE TO authenticated
  USING  ( user_id = (SELECT auth.uid()) OR (SELECT public.is_admin()) )
  WITH CHECK ( user_id = (SELECT auth.uid()) OR (SELECT public.is_admin()) );

CREATE POLICY clinicas_delete ON public.clinicas FOR DELETE TO authenticated
  USING ( (SELECT public.is_admin()) );

-- Trava: usuario comum NAO altera status/expira_em/user_id (anti auto-aprovacao).
-- Somente admin aprova/renova via painel.
CREATE OR REPLACE FUNCTION public.protect_clinica_fields()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NOT public.is_admin() THEN
    new.status    := old.status;
    new.expira_em := old.expira_em;
    new.user_id   := old.user_id;
  END IF;
  RETURN new;
END $$;

DROP TRIGGER IF EXISTS trg_protect_clinica ON public.clinicas;
CREATE TRIGGER trg_protect_clinica BEFORE UPDATE ON public.clinicas
  FOR EACH ROW EXECUTE FUNCTION public.protect_clinica_fields();

-- ============================================================
-- 4. TABELAS COM clinica_id (loop uniforme; pula as que nao existirem)
-- ============================================================
DO $$
DECLARE
  t text;
  tabelas text[] := ARRAY[
    'pacientes','agendamentos','profissionais','anamneses','anamnese_links',
    'procedimentos_dentes','atendimentos_odonto','plano_tratamento',
    'financeiro_config','log_atividades'
  ];
BEGIN
  FOREACH t IN ARRAY tabelas LOOP
    IF to_regclass('public.'||t) IS NULL THEN
      RAISE NOTICE 'pulando % (nao existe)', t; CONTINUE;
    END IF;
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    -- limpa policies antigas conhecidas + a nova
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t||'_own', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t||'_rls', t);
    EXECUTE format($f$
      CREATE POLICY %I ON public.%I FOR ALL TO authenticated
        USING ( clinica_id IN (SELECT public.my_clinica_ids()) OR (SELECT public.is_admin()) )
        WITH CHECK ( clinica_id IN (SELECT public.my_clinica_ids()) OR (SELECT public.is_admin()) )
    $f$, t||'_rls', t);
    RAISE NOTICE 'RLS aplicado em %', t;
  END LOOP;
END $$;

-- limpa nomes antigos de policies que este script substituiu
DROP POLICY IF EXISTS financeiro_own   ON public.financeiro_config;
DROP POLICY IF EXISTS atendimentos_own ON public.atendimentos_odonto;
DROP POLICY IF EXISTS plano_own        ON public.plano_tratamento;
DROP POLICY IF EXISTS anamneses_own    ON public.anamneses;
DROP POLICY IF EXISTS procdentes_own   ON public.procedimentos_dentes;

-- ============================================================
-- 5. PRONTUARIOS (legado: liga por paciente_id, sem clinica_id proprio)
-- ============================================================
DO $$
BEGIN
  IF to_regclass('public.prontuarios') IS NOT NULL THEN
    ALTER TABLE public.prontuarios ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS prontuarios_own ON public.prontuarios;
    DROP POLICY IF EXISTS prontuarios_rls ON public.prontuarios;
    CREATE POLICY prontuarios_rls ON public.prontuarios FOR ALL TO authenticated
      USING ( paciente_id IN (
                SELECT id FROM public.pacientes
                WHERE clinica_id IN (SELECT public.my_clinica_ids())
              ) OR (SELECT public.is_admin()) )
      WITH CHECK ( paciente_id IN (
                SELECT id FROM public.pacientes
                WHERE clinica_id IN (SELECT public.my_clinica_ids())
              ) OR (SELECT public.is_admin()) );
  END IF;
END $$;

-- ============================================================
-- 6. RPCs PUBLICAS DE ANAMNESE (paciente anonimo — via link com token)
-- ============================================================
DO $$
BEGIN
  IF to_regprocedure('public.rwdent_get_anamnese_context(text)') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.rwdent_get_anamnese_context(text) TO anon, authenticated;
  END IF;
  IF to_regprocedure('public.rwdent_submit_anamnese(text,jsonb)') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.rwdent_submit_anamnese(text,jsonb) TO anon, authenticated;
  END IF;
END $$;

-- ============================================================
-- 7. TRIGGER DE CADASTRO: cria a clinica automaticamente no signUp
--    (le nome_resp/nome_cli/telefone do user_metadata enviado pelo front)
-- ============================================================
CREATE UNIQUE INDEX IF NOT EXISTS clinicas_user_id_key ON public.clinicas(user_id);

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  INSERT INTO public.clinicas (user_id, nome_resp, nome_cli, email, telefone, status)
  VALUES (
    new.id,
    COALESCE(new.raw_user_meta_data->>'nome_resp', ''),
    COALESCE(new.raw_user_meta_data->>'nome_cli',  ''),
    new.email,
    COALESCE(new.raw_user_meta_data->>'telefone',  ''),
    'pendente'
  )
  ON CONFLICT (user_id) DO NOTHING;
  RETURN new;
END $$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ============================================================
-- 8. VERIFICACAO (rode e confira; nao altera nada)
-- ============================================================
-- 8a. Toda tabela de 'public' deve ter rowsecurity = true
--   SELECT tablename, rowsecurity FROM pg_tables
--     WHERE schemaname='public' ORDER BY rowsecurity, tablename;
-- 8b. Policies por tabela
--   SELECT tablename, policyname, cmd FROM pg_policies
--     WHERE schemaname='public' ORDER BY tablename, policyname;
-- 8c. RPCs de anamnese devem ser security_definer = true
--   SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args, p.prosecdef
--     FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
--     WHERE n.nspname='public' AND p.proname LIKE 'rwdent_%';
