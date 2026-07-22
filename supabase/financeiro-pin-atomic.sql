-- Corrige uma falha de segurança encontrada em pentest: o contador de
-- tentativas erradas do PIN financeiro era lido e escrito em dois passos
-- separados dentro do código JavaScript (api/financeiro-pin.js). Se um
-- atacante mandasse várias tentativas de PIN AO MESMO TEMPO (em paralelo,
-- não uma de cada vez), todas liam o mesmo valor do contador antes de
-- qualquer uma escrever de volta — então o contador nunca passava de 1,
-- o bloqueio de 5 tentativas nunca disparava, e dava pra tentar todas as
-- 10.000 combinações de um PIN de 4 dígitos sem limite nenhum, só mandando
-- os pedidos em lotes simultâneos em vez de um por vez.
--
-- A correção: o incremento agora acontece inteiro dentro de um único
-- UPDATE no Postgres, que trava a linha durante a operação — então mesmo
-- que 100 tentativas cheguem exatamente juntas, o banco as processa uma
-- de cada vez de verdade, e o bloqueio dispara certinho na 5a tentativa
-- errada, não importa quantas chegaram em paralelo.

CREATE OR REPLACE FUNCTION public.financeiro_pin_registrar_erro(p_clinica_id uuid)
RETURNS TABLE(tentativas_erradas int, bloqueado_ate timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  UPDATE public.financeiro_pin_secreto AS f
  SET tentativas_erradas = CASE WHEN f.tentativas_erradas + 1 >= 5 THEN 0 ELSE f.tentativas_erradas + 1 END,
      bloqueado_ate       = CASE WHEN f.tentativas_erradas + 1 >= 5 THEN now() + interval '15 minutes' ELSE f.bloqueado_ate END
  WHERE f.clinica_id = p_clinica_id
  RETURNING f.tentativas_erradas, f.bloqueado_ate;
END;
$$;

-- Só o servidor (service role, dentro de api/financeiro-pin.js) chama essa
-- função — nunca o navegador. Trava explícita por segurança, caso alguém
-- tente chamar isso direto com a chave anônima no futuro.
REVOKE ALL ON FUNCTION public.financeiro_pin_registrar_erro(uuid) FROM public, anon, authenticated;
