# Presenças de Ginástica

Aplicação web estática, mobile-first, para registar presenças de turmas de ginástica. O HTML/CSS/JavaScript é servido pelo Cloudflare, o D1 é a fonte principal de leitura e escrita, e o Google Sheets mantém uma cópia sincronizada em segundo plano através de um Google Apps Script Web App.

## Fluxo da aplicação

1. Passo 1: escolher a turma.
2. Passo 2: escolher a data. A lista é sempre relativa ao dia de hoje: mostra os dois treinos mais recentes e quaisquer treinos anteriores ainda por preencher. Carregar num treino seleciona essa data; se for o treino de hoje por preencher, avança diretamente para o Passo 3. O calendário de cada classe (dias da semana e início da época) é configurado na gestão das classes.
3. Passo 3: escolher o modo de registo, normal ou rápido.
4. Registar `Presente`, `Atrasado` ou `Falta`, incluindo a justificação quando aplicável.

As preferências locais limitam-se ao tema, ao modo de seleção de turmas, à última turma/data e aos URLs configurados dos serviços. O backend D1 é a fonte rápida de leitura e escrita; o Apps Script/Sheets mantém uma cópia sincronizada em segundo plano. As fotografias reais são guardadas fora do Sheets, num bucket privado.

## Backend rápido

O ficheiro [attendance-data-worker.js](attendance-data-worker.js) expõe a mesma API que a app já usa. A app consulta primeiro o D1, e o Worker coloca as alterações numa fila `outbox` para as enviar ao Apps Script através de `ctx.waitUntil`. O Sheets deixa de bloquear o carregamento normal.

Quando o D1 ainda não tem dados, o primeiro pedido importa o estado atual do Sheets. Depois disso, as leituras normais usam apenas o D1. O histórico antigo de presenças é importado uma vez por classe, em segundo plano, para as tabelas D1; as novas gravações são guardadas primeiro no D1 e copiadas para o Sheets através da fila `outbox`. Se o Sheets estiver temporariamente indisponível, as leituras continuam disponíveis e as gravações pendentes permanecem na fila.

### Configurar D1

1. Criar a base de dados e guardar o ID devolvido:

```powershell
npx wrangler d1 create attendance-pedro-data
```

2. Substituir `REPLACE_WITH_D1_DATABASE_ID` e `REPLACE_WITH_DEPLOYED_SCRIPT_ID` em [data-wrangler.jsonc](data-wrangler.jsonc). Confirmar também o domínio em `ALLOWED_ORIGIN`.
3. Aplicar a migração:

```powershell
npx wrangler d1 migrations apply attendance-pedro-data --remote --config data-wrangler.jsonc
```

4. Publicar o Worker:

```powershell
npx wrangler deploy --config data-wrangler.jsonc
```

5. Testar o URL do Worker com `?action=state`. Só depois colocar esse URL em `Definições` → `Editar script` → `URL do backend`.

O Worker só deve ser publicado depois de o novo [ScriptForSheets](ScriptForSheets) estar implementado como Web App. O D1 é a fonte principal nesta arquitetura; o Sheets continua como cópia de segurança e relatório. As gravações de class/members são serializadas no D1 e as presenças usam a chave única `classId + date`.

## API do backend

O frontend comunica com o Worker D1. O Worker usa o URL `/exec` da implementação do Apps Script apenas para a sincronização de fundo.

- `GET ?action=state`: devolve todas as turmas, membros e configuração dos treinos.
- `GET ?action=bootstrap&classId=...&date=yyyy-MM-dd`: devolve o estado, a presença local e a cache de treinos recentes num único pedido.
- `GET ?action=attendance&classId=...&date=yyyy-MM-dd`: devolve presenças de uma turma/data.
- `GET ?action=recentAttendance&classId=...&date=yyyy-MM-dd&count=2`: calcula no D1 os últimos treinos agendados e indica se estão preenchidos. Se o histórico ainda não tiver sido importado, devolve `historyReady: false` em vez de classificar datas como por preencher.
- `GET ?action=syncStatus`: devolve o número de operações pendentes e o último erro de sincronização.
- `POST { action: "saveClass", class: {...} }`: cria ou renomeia uma turma sem substituir as restantes.
- `POST { action: "addMember", classId, member }`: adiciona um membro à turma, incluindo o perfil e a referência da fotografia.
- `POST { action: "removeMember", classId, memberName }`: remove um membro e a respetiva linha da folha.
- `POST { action: "removeClass", classId }`: remove a turma e a respetiva folha.
- `POST { action: "saveClasses", classes: [...] }`: mantém-se para compatibilidade e sincronização completa.
- `POST { action: "saveAttendance", classId, className, date, members: [...] }`: guarda ou atualiza uma presença.

As gravações no D1 usam a chave única `classId + date`; a cópia do Sheets continua a atualizar a coluna existente pela mesma data. O histórico do Sheets é lido pelo endpoint `attendanceHistory` e importado de forma idempotente: registos que já existem no D1 nunca são substituídos pela importação.

Em `Classes` → `Configurar dias de treino`, é possível editar a data de início da época e os dias de treino de cada classe. A app grava esta configuração na classe partilhada (D1 e `__classes__` no Sheets); não é necessário editar manualmente a folha técnica. Se a época estiver configurada para começar há mais de 800 dias, o endpoint devolve um erro visível para corrigir a data em vez de fazer uma pesquisa excessivamente longa.

O Worker aceita pedidos apenas da origem pública configurada em `ALLOWED_ORIGIN` e exige um token assinado emitido depois da validação do PIN da app. A sessão fica válida durante 30 dias nesse dispositivo.

## Optimização e preservação de dados

Ao abrir a aplicação, turmas e membros vêm do D1. As presenças e o resumo de treinos também são lidos do D1; o Apps Script só é chamado para a importação inicial do estado, para importar o histórico de uma classe ainda não sincronizada, e para copiar alterações pendentes. A importação por classe é repetível sem duplicar nem substituir registos, e o cron processa gradualmente as restantes classes. Se a importação falhar, a app mostra o erro e não apresenta datas como por preencher até o histórico estar pronto.

As operações de membros não reconstroem a folha inteira: adicionar um membro acrescenta a linha em falta e ordena linhas completas, mantendo as presenças associadas ao nome; remover um membro elimina apenas a sua linha. Renomear uma turma move a folha existente. O Apps Script lê `__classes__` uma vez por operação e escreve o estado actualizado sob lock.

A migração `0003_core_tables.sql` cria tabelas D1 separadas para turmas, membros e presenças. A migração `0004_attendance_history.sql` acrescenta o índice de datas de presença e o estado de importação do histórico por classe. O `kv` antigo mantém-se como compatibilidade e recuperação durante a transição; os registos de presença usam a chave única `classId + date`.

## Estrutura do Sheets

A folha `__classes__` contém:

`id | name | membersJson | trainingDaysJson | seasonStart | memberProfilesJson`

`membersJson` preserva a lista de nomes usada nas folhas de presenças. `memberProfilesJson` contém objetos com `id`, `name`, `photoKey` e `photoVersion`. As turmas antigas são migradas automaticamente, recebendo IDs estáveis sem alterar as respetivas folhas ou presenças.

Cada turma tem uma folha com o mesmo nome. O formato de presenças é:

`Membro | 08/09 | 10/09 | ...`

Os membros ficam nas linhas e as datas nas colunas. A mesma data é atualizada em vez de duplicada, as datas ficam ordenadas da mais antiga para a mais recente e as cores são:

- Presente: `*`, com texto verde.
- Atrasado: `A`, com texto amarelo quando justificado e vermelho quando não justificado.
- Falta: `F`, com texto amarelo quando justificada e vermelho quando não justificada.

As células não usam fundos coloridos. A cor do texto conserva a informação da justificação quando a folha é lida novamente pela aplicação.

As folhas no formato antigo, com datas nas linhas, são migradas automaticamente na primeira leitura. Células vazias são preservadas e os códigos com as respetivas cores de texto são reaplicados.

## Configuração dos treinos

Os dias da semana usam o formato JavaScript `0 = domingo` até `6 = sábado`. A configuração atual por defeito é aplicada pelo Apps Script apenas quando uma turma ainda não tem configuração guardada:

- `Minigami`: `1, 2, 4` (segunda, terça e quinta).
- `Gami`: `2, 4` (terça e quinta).
- Início da época: `2026-09-08`.

Depois de guardada, a configuração fica em `trainingDaysJson` e `seasonStart` na folha `__classes__`.

## Publicação

1. Publicar o conteúdo de `ScriptForSheets` numa nova versão do Google Apps Script como Web App.
2. Confirmar que o acesso da implementação permite o uso pela aplicação.
3. Guardar o URL `/exec` nas definições da aplicação, se for diferente do predefinido.
4. Fazer push de `index.html` para o repositório ligado ao Cloudflare.

### Deploy automático com GitHub Actions

O workflow [deploy.yml](.github/workflows/deploy.yml) valida o código, aplica as migrações D1 e publica os três Workers sempre que há um push para `main`. Para o activar, criar estes secrets no repositório em `Settings` -> `Secrets and variables` -> `Actions`:

- `CLOUDFLARE_API_TOKEN`: token Cloudflare com permissões para publicar Workers e gerir D1.
- `CLOUDFLARE_ACCOUNT_ID`: ID da conta Cloudflare.

O workflow não recria os secrets `APP_PIN` e `APP_AUTH_SECRET`: esses secrets permanecem guardados nos Workers Cloudflare durante cada deploy. O job de publicação usa o ambiente GitHub `production`; se esse ambiente tiver reviewers obrigatórios, o deploy aguarda aprovação antes de publicar.

O acesso à app e às fotografias é protegido pelo PIN da app e por tokens de sessão. O URL do backend não deve ser tratado como uma API pública sem autenticação.
Utilizadores com sessão iniciada podem consultar o PIN partilhado em `Definições` → `Ver PIN` e transmiti-lo manualmente a novos utilizadores.

## Fotografias de membros

A app inclui quatro retratos genéricos em `assets/avatars/`. Estes são usados automaticamente até existir uma fotografia própria. Não são fotografias de membros reais.

Fotografias próprias são convertidas no browser para WebP quadrado, ou JPEG como fallback em browsers móveis que não exportem WebP, com no máximo `256 x 256` px e 1 MB. O ficheiro [photo-worker.js](photo-worker.js) guarda-as num bucket R2 privado; o Sheets recebe apenas a referência, nunca o ficheiro.

### Configurar R2 e o Worker

1. No Cloudflare, criar o bucket R2 privado `attendance-pedro-member-photos`.
2. Atualizar `ALLOWED_ORIGIN` em [wrangler.jsonc](wrangler.jsonc). O acesso às fotografias usa o PIN da app, não Cloudflare Access.
3. Configurar os secrets `APP_AUTH_SECRET` no Worker D1 e no Worker de fotografias, e `APP_PIN` no Worker D1.
5. Executar `npx wrangler deploy --config .\wrangler.jsonc` ou, preferencialmente, usar `.\Deploy-AttendanceApp.ps1`, que valida os nomes dos três Workers antes de publicar.
6. Na app, abrir `Definições` → `Editar script`, inserir `https://attendance-pedro-media-public.pedrosill1944.workers.dev` em `URL do servidor de fotografias` e guardar.

O Worker rejeita pedidos sem token válido, tipos que não sejam WebP e imagens acima de 1 MB. As fotos são entregues com cache privada; o bucket R2 continua privado.

Antes de usar fotos reais, confirmar consentimento dos encarregados de educação e uma política de remoção. Ao remover um membro na app, a respetiva fotografia própria é também eliminada do Worker.

## Testes locais

Validar sintaxe e executar os testes:

```powershell
node --check ScriptForSheets
node --check photo-worker.js
node --test tests/attendance.test.js
```

## Iniciar localmente

Para abrir a versão atual da app no computador:

```powershell
powershell -ExecutionPolicy Bypass -File .\Start-AttendanceApp.ps1
```

O lançador compara os ficheiros atuais com a última execução local, confirma que o Apps Script responde, termina apenas instâncias anteriores iniciadas por [local_server.py](local_server.py) na mesma porta e abre `http://127.0.0.1:8765/index.html`.

Opções úteis:

```powershell
# Apenas verificar alterações e o backend
.\Start-AttendanceApp.ps1 -CheckOnly

# Iniciar sem abrir o browser
.\Start-AttendanceApp.ps1 -NoBrowser

# Usar outra porta
.\Start-AttendanceApp.ps1 -Port 8766

# Confirmar um Apps Script diferente do URL predefinido
.\Start-AttendanceApp.ps1 -CheckOnly -BackendUrl "https://script.google.com/macros/s/.../exec"
```

Se o `ScriptForSheets` ou o Worker tiverem sido alterados, o lançador avisa. A publicação do Apps Script requer uma nova implementação. Para publicar D1, migrações e a app estática numa sequência validada, usar [Publish-AttendanceApp.ps1](Publish-AttendanceApp.ps1).

### Publicar a app estática

O HTML público usa o Worker `attendance-pedro`. A configuração [static-wrangler.jsonc](static-wrangler.jsonc) publica apenas a pasta `public/`, evitando expor o Apps Script, a base D1 ou as configurações locais.

Depois de alterar `index.html`, logótipos, manifesto ou avatares:

```powershell
Copy-Item .\index.html, .\Logo1.png, .\LogoAppSCP.png, .\manifest.webmanifest -Destination .\public\ -Force
Copy-Item .\assets\avatars\*.png -Destination .\public\assets\avatars\ -Force
npx wrangler deploy --config static-wrangler.jsonc
```

Ou executar tudo de uma vez:

```powershell
.\Publish-AttendanceApp.ps1
```
