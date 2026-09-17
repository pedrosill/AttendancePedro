# Presenças de Ginástica

Aplicação web estática, mobile-first, para registar presenças de turmas de ginástica. O HTML/CSS/JavaScript é servido pelo Cloudflare e os dados partilhados são guardados no Google Sheets através de um Google Apps Script Web App.

## Fluxo da aplicação

1. Passo 1: escolher a turma.
2. Passo 2: escolher a data. A lista é sempre relativa ao dia de hoje: mostra os dois treinos mais recentes e quaisquer treinos anteriores ainda por preencher. Carregar num treino seleciona essa data; se for o treino de hoje por preencher, avança diretamente para o Passo 3.
3. Passo 3: escolher o modo de registo, normal ou rápido.
4. Registar `Presente`, `Atrasado` ou `Falta`, incluindo a justificação quando aplicável.

As preferências locais limitam-se ao tema, ao modo de seleção de turmas, à última turma/data e aos URLs configurados dos serviços. O backend D1 é a fonte rápida de leitura e escrita; o Apps Script/Sheets mantém uma cópia sincronizada em segundo plano. As fotografias reais são guardadas fora do Sheets, num bucket privado.

## Backend rápido

O ficheiro [attendance-data-worker.js](attendance-data-worker.js) expõe a mesma API que a app já usa. A app consulta primeiro o D1, e o Worker coloca as alterações numa fila `outbox` para as enviar ao Apps Script através de `ctx.waitUntil`. O Sheets deixa de bloquear o carregamento normal.

Quando o D1 ainda não tem dados, o primeiro pedido importa o estado atual do Sheets. Depois disso, o Worker responde do D1 e tenta atualizar o estado em segundo plano a cada minuto. Se o Sheets estiver temporariamente indisponível, os dados já guardados no D1 continuam disponíveis e as gravações pendentes permanecem na fila.

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

O Worker só deve ser publicado depois de o novo [ScriptForSheets](ScriptForSheets) estar implementado como Web App. O D1 é a fonte principal nesta arquitetura; o Sheets continua como cópia de segurança e relatório.

## API do Apps Script

O endpoint é o URL `/exec` da implementação do Apps Script.

- `GET ?action=state`: devolve todas as turmas, membros e configuração dos treinos.
- `GET ?action=attendance&classId=...&date=yyyy-MM-dd`: devolve presenças de uma turma/data.
- `GET ?action=recentAttendance&classId=...&date=yyyy-MM-dd&count=2`: devolve os últimos treinos agendados e indica se estão preenchidos.
- `POST { action: "saveClass", class: {...} }`: cria ou renomeia uma turma sem substituir as restantes.
- `POST { action: "addMember", classId, member }`: adiciona um membro à turma, incluindo o perfil e a referência da fotografia.
- `POST { action: "removeMember", classId, memberName }`: remove um membro e a respetiva linha da folha.
- `POST { action: "removeClass", classId }`: remove a turma e a respetiva folha.
- `POST { action: "saveClasses", classes: [...] }`: mantém-se para compatibilidade e sincronização completa.
- `POST { action: "saveAttendance", classId, className, date, members: [...] }`: guarda ou atualiza uma presença.

As gravações são protegidas por `LockService` para evitar que duas gravações simultâneas criem a mesma data duas vezes.

## Optimização e preservação de dados

Ao abrir a aplicação, as turmas e os membros são apresentados assim que o estado partilhado chega. As presenças são carregadas em segundo plano. Durante a sessão, pedidos repetidos para a mesma turma/data são reutilizados em memória; este cache não é guardado no navegador e é invalidado ao mudar de turma, mudar de data, alterar o URL ou guardar presenças. O Apps Script mantém ainda uma cache partilhada de turmas e membros durante cinco minutos, eliminada imediatamente após qualquer alteração gravada pela aplicação; assim, abrir a app noutro dispositivo não precisa de percorrer todas as folhas de presenças.

As operações de membros não reconstroem a folha inteira: adicionar um membro acrescenta a linha em falta e ordena linhas completas, mantendo as presenças associadas ao nome; remover um membro elimina apenas a sua linha. Renomear uma turma move a folha existente. O Apps Script lê `__classes__` uma vez por operação e escreve o estado actualizado sob lock.

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

O endpoint é público na configuração atual. Não devem ser guardados dados sensíveis sem adicionar autenticação ou uma camada de proteção.

## Fotografias de membros

A app inclui quatro retratos genéricos em `assets/avatars/`. Estes são usados automaticamente até existir uma fotografia própria. Não são fotografias de membros reais.

Fotografias próprias são convertidas no browser para WebP quadrado com, no máximo, `256 x 256` px e 1 MB. O ficheiro [photo-worker.js](photo-worker.js) guarda-as num bucket R2 privado; o Sheets recebe apenas a referência, nunca o ficheiro.

### Configurar R2 e o Worker

1. No Cloudflare, criar o bucket R2 privado `attendance-pedro-member-photos`.
2. Criar uma aplicação Cloudflare Access para o domínio do Worker e permitir apenas os emails dos treinadores.
3. Atualizar `ALLOWED_ORIGIN` e `ACCESS_EMAILS` em [wrangler.jsonc](wrangler.jsonc). Usar o domínio final sem `/` no fim.
4. Configurar uma rota personalizada protegida por Access. `workers_dev` está desativado para impedir acesso não protegido pelo domínio `workers.dev`.
5. Executar `npx wrangler deploy`.
6. Na app, abrir `Definições` → `Editar script`, inserir o URL do Worker em `URL do servidor de fotografias` e guardar.

O Worker rejeita pedidos sem email autorizado, tipos que não sejam WebP e imagens acima de 1 MB. As fotos são entregues com cache privada. Como o controlo de acesso depende do Cloudflare Access, não publique nem ative um endpoint público do bucket.

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

Se o `ScriptForSheets` ou o Worker tiverem sido alterados, o lançador avisa. A publicação continua a ser manual: Apps Script requer uma nova implementação e o Worker requer `npx wrangler deploy`.
