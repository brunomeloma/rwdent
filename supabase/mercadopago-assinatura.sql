-- Guarda o ID da assinatura (preapproval) do Mercado Pago em cada clínica,
-- pra que o webhook (api/mercadopago-webhook.js) consiga achar a clínica
-- certa quando o Mercado Pago avisar que um pagamento recorrente caiu.
ALTER TABLE public.clinicas ADD COLUMN IF NOT EXISTS mp_subscription_id TEXT;
