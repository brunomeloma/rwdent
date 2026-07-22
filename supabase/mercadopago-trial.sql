-- Guarda quantos dias de teste grátis a assinatura da clínica tem, quando
-- ela foi criada como "trial" (cliente autorizou o cartão, mas ainda não
-- foi cobrado). O webhook usa isso pra conceder só o período de teste na
-- autorização inicial, em vez do ciclo mensal completo — e limpa esse
-- campo assim que o primeiro pagamento de verdade cair.
ALTER TABLE public.clinicas ADD COLUMN IF NOT EXISTS mp_trial_dias INT;
