# 🔒 Guia de Segurança - RWDent

## EMERGÊNCIA: Credenciais Supabase Expostas 🚨

Se você NUNCA compartilhou este repositório publicamente, o risco é menor.  
Se o repositório é **público no GitHub**, siga TODOS os passos abaixo IMEDIATAMENTE.

---

## Passo 1: Regenerar Credenciais Supabase (IMEDIATO)

1. Acesse https://supabase.com/dashboard
2. Selecione seu projeto RWDent
3. Vá para **Settings → API**
4. Clique em **Regenerate** ao lado de `anon public`
5. Copie a NOVA chave gerada

---

## Passo 2: Criar `.env.local` (NUNCA commitar)

1. Na raiz do projeto, crie um arquivo `.env.local`
2. Copie o conteúdo de `.env.example.secure`
3. Preencha com suas credenciais NOVAS do Supabase
4. **NUNCA** faça commit deste arquivo

```bash
# Nunca commitar .env.local
git status  # Verifique que .env.local não aparece
```

---

## Passo 3: Atualizar `.gitignore`

Adicione ao final do `.gitignore`:

```
# Environment variables
.env
.env.local
.env.*.local
.env.production.local

# Secrets
*.pem
*.key
*.crt
private_key.txt
credentials.json
secrets.json
```

---

## Passo 4: Remover Credenciais do Git History (SE REPOSITÓRIO É PÚBLICO)

```bash
# ⚠️ CUIDADO: Isto modifica o histórico Git

# Opção 1: Filter out sensitive commits
git filter-branch --force --index-filter \
  "git rm --cached --ignore-unmatch app.html" \
  --prune-empty --tag-name-filter cat -- --all

# Opção 2: Use BFG Repo Cleaner (mais fácil)
# Download: https://rtyley.github.io/bfg-repo-cleaner/
bfg --replace-text passwords.txt
git reflog expire --expire=now --all && git gc --prune=now --aggressive

# Force push (USE COM CUIDADO!)
git push origin --force --all
```

---

## Passo 5: Atualizar `app.html` para Usar `.env`

NO SERVIDOR (Vercel), configure variáveis de ambiente:

```bash
# Vercel Dashboard → Settings → Environment Variables

SUPABASE_URL=https://xdncwmxjdqiwykbcaddd.supabase.co
SUPABASE_ANON_KEY=your_new_key_here
```

Então atualize `app.html`:

```javascript
// ANTES (❌ Inseguro - hardcoded):
const SUPABASE_URL      = 'https://xdncwmxjdqiwykbcaddd.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...';

// DEPOIS (✅ Seguro - variáveis de ambiente):
// Para aplicações estáticas servidas no cliente, as credenciais Supabase
// DEVEM ser públicas (anon key é apenas para read). Use Row Level Security!
```

⚠️ **NOTA:** A chave "anon" do Supabase é DESIGNADA para ser pública.  
O que importa é ter **Row Level Security** ativada para proteger dados.

---

## Passo 6: Ativar Row Level Security (RLS) no Supabase

No console Supabase, execute este SQL:

```sql
-- Ativar RLS em todas as tabelas
ALTER TABLE clinicas ENABLE ROW LEVEL SECURITY;
ALTER TABLE pacientes ENABLE ROW LEVEL SECURITY;
ALTER TABLE agendamentos ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendas ENABLE ROW LEVEL SECURITY;
ALTER TABLE profissionais ENABLE ROW LEVEL SECURITY;
ALTER TABLE procedimentos ENABLE ROW LEVEL SECURITY;
ALTER TABLE log_atividades ENABLE ROW LEVEL SECURITY;

-- Criar política: Users só veem dados de sua clínica
CREATE POLICY "Usuários só veem sua clínica"
  ON pacientes
  FOR SELECT
  USING (clinica_id = (auth.jwt() ->> 'clinic_id')::uuid);

-- Exemplo completo (copiar para cada tabela):
CREATE POLICY "clinicas_select_own"
  ON clinicas
  FOR SELECT
  USING (id = auth.uid());

CREATE POLICY "clinicas_insert_own"
  ON clinicas
  FOR INSERT
  WITH CHECK (id = auth.uid());

CREATE POLICY "clinicas_update_own"
  ON clinicas
  FOR UPDATE
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid());

CREATE POLICY "clinicas_delete_own"
  ON clinicas
  FOR DELETE
  USING (id = auth.uid());
```

---

## Passo 7: Adicionar Headers de Segurança

Se usar Vercel, crie `vercel.json`:

```json
{
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        {
          "key": "X-Content-Type-Options",
          "value": "nosniff"
        },
        {
          "key": "X-Frame-Options",
          "value": "DENY"
        },
        {
          "key": "X-XSS-Protection",
          "value": "1; mode=block"
        },
        {
          "key": "Referrer-Policy",
          "value": "strict-origin-when-cross-origin"
        },
        {
          "key": "Content-Security-Policy",
          "value": "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; img-src 'self' data: https:; connect-src 'self' https://xdncwmxjdqiwykbcaddd.supabase.co"
        }
      ]
    }
  ]
}
```

---

## Passo 8: Implementar Rate Limiting

Backend (API endpoint em Vercel):

```javascript
// api/chat.js (exemplo)
const rateLimit = new Map();

module.exports = async (req, res) => {
  const userId = req.headers['x-user-id'];
  const now = Date.now();
  
  // Rate limit: 10 requests per minute
  if (!rateLimit.has(userId)) {
    rateLimit.set(userId, []);
  }
  
  const requests = rateLimit.get(userId).filter(t => now - t < 60000);
  
  if (requests.length >= 10) {
    return res.status(429).json({ error: 'Too many requests' });
  }
  
  requests.push(now);
  rateLimit.set(userId, requests);
  
  // ... rest of API
};
```

---

## Passo 9: Setup de Auditoria

Criar trigger Supabase para registrar acessos:

```sql
CREATE TABLE audit_logs (
  id BIGSERIAL PRIMARY KEY,
  clinica_id UUID NOT NULL REFERENCES clinicas(id),
  usuario_id UUID NOT NULL REFERENCES auth.users(id),
  tabela TEXT NOT NULL,
  acao TEXT NOT NULL, -- SELECT, INSERT, UPDATE, DELETE
  dados_antigos JSONB,
  dados_novos JSONB,
  ip_address INET,
  user_agent TEXT,
  timestamp TIMESTAMP DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

-- Policy
CREATE POLICY "audit_logs_readable"
  ON audit_logs
  FOR SELECT
  USING (clinica_id = (auth.jwt() ->> 'clinic_id')::uuid OR
         auth.jwt() ->> 'role' = 'admin');
```

---

## Passo 10: Teste de Segurança

```bash
# 1. Verificar se credenciais ainda estão em git
git log -p -S 'SUPABASE_ANON_KEY' | head -20

# 2. Verificar .gitignore
cat .gitignore | grep -E "\.env|secret"

# 3. Teste local
npm install dotenv
node -e "require('dotenv').config(); console.log(process.env.SUPABASE_URL)"

# 4. Verificar headers HTTPS
curl -I https://seu-dominio.vercel.app | grep -E "X-Content|X-Frame"
```

---

## Checklist Final

- [ ] Regenerou chave Supabase
- [ ] Criou `.env.local` (não commitado)
- [ ] Removeu credenciais do Git history
- [ ] Atualizou `.gitignore`
- [ ] Ativou Row Level Security
- [ ] Configurou variáveis Vercel
- [ ] Adicionou headers de segurança
- [ ] Implementou rate limiting
- [ ] Testou tudo localmente
- [ ] Fez deploy para produção

---

## Recursos Adicionais

- Supabase Security: https://supabase.com/docs/guides/auth/social-auth
- OWASP Top 10: https://owasp.org/Top10/
- Vercel Security: https://vercel.com/docs/security
- Git History Cleanup: https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository

---

**Status:** Crítico - Atuar IMEDIATAMENTE  
**Tempo Estimado:** 2-4 horas para todas as correções  
**Prioridade:** MÁXIMA
