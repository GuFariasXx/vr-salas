# VR Salas

Sistema web de agendamento de salas de reunião da VR Software, com check-in obrigatório, aviso ao gestor em caso de no-show e integração com o Google Workspace (login e Google Agenda).

**Stack:** Node.js 18+ (Express) · PostgreSQL 14+ · HTML/CSS/JS puro (sem build) · roda direto no navegador.

## Funcionalidades

| Área | O que faz |
|---|---|
| **Login** | E-mail e senha, "Lembrar meu usuário", "Esqueci minha senha" (link por e-mail) e **Entrar com Google** (restrito ao domínio `@vrsoft.com.br`) |
| **Início** | Indicadores do dia, status de cada sala agora (livre/ocupada) e suas próximas reuniões com botão de check-in |
| **Disponibilidade** | Consulta aberta a todos: data, horário, nº de pessoas e recurso (TV, videoconferência…) → salas livres com botão "Reservar" |
| **Agenda das salas** | Linha do tempo do dia (salas × horários) com indicador de "agora"; clique num espaço vazio para reservar |
| **Reservas** | Participantes (com autocomplete), pauta, recorrência diária (dias úteis) ou semanal, aviso de capacidade, sugestão de sala alternativa quando há conflito, edição, cancelamento (ocorrência ou série), encerrar antes e liberar a sala |
| **Check-in por QR code** | Cada sala tem um QR para imprimir e colar na porta (*Salas › ícone QR › Imprimir*). A pessoa lê com a câmera do celular ou pelo botão **Check-in QR** do sistema (webcam). Por usuário, o admin define se o check-in pode ser **por QR ou botão** ou **somente por QR** |
| **Check-in** | Liberado X min antes do início; sem check-in até a tolerância → reserva vira *no-show*, a **sala é liberada** e **organizador e gestor são notificados** (e-mail + sino no sistema). Lembrete automático antes da reunião |
| **Usuários (admin)** | Criar, editar, inativar e excluir usuários, definir administradores e **vincular o gestor (chefe)** de cada pessoa. Bloqueia ciclos de chefia e impede remover o último admin |
| **Salas (admin)** | Nome, local, capacidade, horário de funcionamento, recursos, cor, se exige check-in, e-mail de recurso do Google Workspace |
| **Relatórios (admin)** | Taxa de no-show, ranking de usuários sem check-in (com gestor), horas reservadas por sala, log de auditoria |
| **Configurações (admin)** | Janela de check-in, tolerância, lembrete, duração máxima e antecedência máxima |

Conflitos de horário são impedidos no próprio banco (constraint `EXCLUDE` com `tstzrange`), então duas pessoas nunca conseguem reservar o mesmo horário, mesmo clicando ao mesmo tempo.

## Como rodar

### Opção A — Docker (recomendado)

```bash
cp .env.example .env        # ajuste JWT_SECRET, ADMIN_*, SMTP_* e GOOGLE_*
docker compose up -d --build
```

Acesse http://localhost:3000 e entre com o admin definido em `ADMIN_EMAIL` / `ADMIN_PASSWORD` (padrão `admin@vrsoft.com.br` / `Admin@123`, **troque no primeiro acesso**).

### Opção B — Node + Postgres existente

```bash
createdb vrsalas                      # ou use um banco já existente
cp .env.example .env                  # ajuste DATABASE_URL
npm install
npm start
```

As tabelas são criadas automaticamente na inicialização (`db/schema.sql`, idempotente). O Postgres precisa da extensão `btree_gist` (vem no pacote padrão; o usuário precisa de permissão para `CREATE EXTENSION` na primeira execução).

## Integração Google Workspace

1. No [Google Cloud Console](https://console.cloud.google.com/), crie ou selecione um projeto e ative a **Google Calendar API**.
2. Em **Tela de consentimento OAuth**, escolha o tipo **Interno** (só contas do Workspace da VR).
   Escopos: `openid`, `email`, `profile`, `.../auth/calendar.events`.
3. Em **Credenciais → Criar credenciais → ID do cliente OAuth → Aplicativo da Web**:
   - URI de redirecionamento autorizado: `https://SEU-DOMINIO/api/auth/google/callback`
     (local: `http://localhost:3000/api/auth/google/callback`)
4. Preencha no `.env`: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_ALLOWED_DOMAIN=vrsoft.com.br` e `APP_URL`.

Com isso:

- O botão **Entrar com Google** aparece no login. Com `GOOGLE_AUTO_PROVISION=true`, o primeiro login cria o usuário automaticamente como "Usuário"; o admin depois define gestor e área. Com `false`, só entra quem o admin cadastrou.
- Cada reserva **cria o evento na agenda do organizador**, com os participantes convidados (o Google envia os convites). Edição atualiza o evento, cancelamento remove o evento e no-show renomeia o evento para `[Sala liberada]`.
- Se a sala tiver o **e-mail de recurso** do Workspace (Admin Console → Diretório → Edifícios e recursos), ela entra como recurso no evento.
- Quem entrou por senha pode vincular o Google em *menu do usuário → Vincular Google Agenda*. Sem Google vinculado, os participantes recebem o convite por e-mail do próprio sistema.

## E-mail

Configure `SMTP_*` com uma conta do Workspace usando **senha de app** (`smtp.gmail.com:465`) ou o relay SMTP do Workspace (`smtp-relay.gmail.com:587`, `SMTP_SECURE=false`). Sem SMTP configurado, o sistema funciona normalmente e só registra no log o que teria enviado. As notificações no sino do sistema funcionam de qualquer forma.

E-mails enviados: lembrete de check-in, aviso de no-show (organizador), **aviso ao gestor**, reserva cancelada por admin, convite a participantes (quando não há Google) e redefinição de senha.

## Regra do check-in (monitor automático)

Um job roda a cada minuto (`src/jobs.js`):

1. **Lembrete:** reservas que começam nos próximos `reminder_before_min` minutos → notifica o organizador.
2. **No-show:** reservas `confirmed` em salas que exigem check-in, e cujo início + `checkin_tolerance_min` já passou → status `no_show`, sala liberada, contador de no-show do usuário +1, notificação para o usuário e **para o gestor vinculado**.

Podem fazer check-in: o organizador, qualquer participante convidado ou um admin. Salas com "Exige check-in" desmarcado não entram nessa regra.

## Check-in por QR code

- Cada sala tem um token aleatório no QR (`/checkin?t=...`). Se um QR vazar (ex.: foto enviada no grupo para fazer check-in de casa), use **Gerar novo QR** e reimprima; o anterior deixa de funcionar.
- **Câmera do celular:** qualquer app de câmera abre o link do QR; se a pessoa não estiver logada, faz login e volta direto para o check-in.
- **Webcam / câmera dentro do navegador (botão "Check-in QR"):** o navegador só libera a câmera em endereço seguro (**https** ou **localhost**). Acessando por IP (`http://192.168...`), use a câmera do celular; com o domínio HTTPS funciona em qualquer dispositivo.
- O celular precisa estar na mesma rede do servidor (Wi-Fi da empresa) enquanto o sistema estiver num IP interno.

## Estrutura

```
db/schema.sql            Tabelas, constraint anti-conflito e configurações padrão
src/server.js            Express, segurança (helmet, CSP), rotas e inicialização
src/routes/              auth, users, rooms (+ QR), bookings, checkin (QR), notifications, admin
src/services/            google (OAuth + Agenda), mail (SMTP), notify, settings, audit
src/jobs.js              Lembrete e processamento de no-show
public/                  index.html (login), app.html + js/app.js (SPA), checkin.html (check-in pelo celular), css/app.css
```

## Produção

- Rode atrás de HTTPS (Nginx, Traefik ou o balanceador da empresa) e defina `APP_URL=https://...` — o cookie de sessão passa a ser `Secure`.
- Gere um `JWT_SECRET` forte: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`.
- Faça backup do volume `pgdata` (ou do banco externo).
- Se rodar mais de uma instância, o job de no-show é seguro (usa `UPDATE ... RETURNING` atômico), mas basta uma instância para o volume de uma empresa.
