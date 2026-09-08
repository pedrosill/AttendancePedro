# Presenças de Ginástica

Aplicação web estática, mobile-first, para registar presenças de turmas de ginástica. O HTML/CSS/JavaScript é servido pelo Cloudflare e os dados partilhados são guardados no Google Sheets através de um Google Apps Script Web App.

## Fluxo da aplicação

1. Passo 1: escolher a turma.
2. Passo 2: escolher a data. Os dois últimos treinos definidos para a turma aparecem com o estado `Preenchido` ou `Por preencher`.
3. Passo 3: escolher o modo de registo, normal ou rápido.
4. Registar `Presente`, `Atrasado` ou `Falta`, incluindo a justificação quando aplicável.

As preferências locais limitam-se ao tema, ao modo de seleção de turmas, à última turma/data e ao URL configurado do Apps Script. Turmas, membros e presenças são dados partilhados no Sheets.

## API do Apps Script

O endpoint é o URL `/exec` da implementação do Apps Script.

- `GET ?action=state`: devolve todas as turmas, membros e configuração dos treinos.
- `GET ?action=attendance&classId=...&date=yyyy-MM-dd`: devolve presenças de uma turma/data.
- `GET ?action=recentAttendance&classId=...&date=yyyy-MM-dd&count=2`: devolve os últimos treinos agendados e indica se estão preenchidos.
- `POST { action: "saveClass", class: {...} }`: cria ou renomeia uma turma sem substituir as restantes.
- `POST { action: "addMember", classId, memberName }`: adiciona um membro à turma.
- `POST { action: "removeMember", classId, memberName }`: remove um membro e a respetiva linha da folha.
- `POST { action: "removeClass", classId }`: remove a turma e a respetiva folha.
- `POST { action: "saveClasses", classes: [...] }`: mantém-se para compatibilidade e sincronização completa.
- `POST { action: "saveAttendance", classId, className, date, members: [...] }`: guarda ou atualiza uma presença.

As gravações são protegidas por `LockService` para evitar que duas gravações simultâneas criem a mesma data duas vezes.

## Estrutura do Sheets

A folha `__classes__` contém:

`id | name | membersJson | trainingDaysJson | seasonStart`

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

## Testes locais

Validar sintaxe e executar os testes:

```powershell
node --check ScriptForSheets
node --test tests/attendance.test.js
```
