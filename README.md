# Gymnastics Attendance App

A mobile-first static web app for class attendance tracking.

## What it does
- Screen 1: choose a class from a dropdown
- Screen 2: choose Edit, Attendance, or Go back
- Screen 3: quickly mark each member as Attended, Late, or Not attended
- Optional Google Sheets sync through a Google Apps Script webhook

## Best free stack
- Frontend: static HTML, CSS and vanilla JavaScript
- Data storage: browser localStorage for offline/simple use
- Cloud sync: Google Sheets + Google Apps Script Web App webhook
- Hosting: Cloudflare Pages or GitHub Pages

## Why this stack
- Free hosting
- No backend server cost
- Fast on mobile
- Easy to maintain
- Google Sheets works as a lightweight admin database

## Recommended deployment
1. Upload the HTML file to a GitHub repository.
2. Deploy it with Cloudflare Pages or GitHub Pages.
3. Create a Google Apps Script attached to the sheet using the code below.
4. Deploy the Apps Script as a Web App with access for anyone with the link.
5. Paste the generated webhook URL into the app's Class management screen.

## Google Apps Script example
```javascript
const HEADER = ['savedAt', 'date', 'className', 'memberName', 'status'];
const STATUS_COLORS = {
  attended: '#e0ead9',
  late: '#f2e8bf',
  absent: '#f2d9dd'
};
const COLOR_TEXT = {
  attended: '#437a22',
  late: '#7a5600',
  absent: '#a13544'
};

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = getOrCreateClassSheet(ss, data.className);
    ensureHeaders(sheet);

    var row = findOrCreateDateRow(sheet, data.date, data.savedAt, data.className);
    var memberMap = {};
    data.members.forEach(function(member) {
      memberMap[member.name] = member.status;
    });

    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    var headerIndex = {};
    headers.forEach(function(header, index) {
      headerIndex[header] = index + 1;
    });

    Object.keys(memberMap).forEach(function(name) {
      var column = ensureMemberColumn(sheet, name, headerIndex);
      sheet.getRange(row, column).setValue(memberMap[name]);
      applyStatusColor(sheet.getRange(row, column), memberMap[name]);
    });

    sortSheetByDate(sheet);

    return ContentService
      .createTextOutput(JSON.stringify({ ok: true, sheetName: sheet.getName() }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (error) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: String(error) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function getOrCreateClassSheet(ss, className) {
  var name = sanitizeSheetName(className);
  var sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  return sheet;
}

function ensureHeaders(sheet) {
  var headers = sheet.getLastColumn() ? sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0] : [];
  var existing = headers.filter(String);
  if (!existing.length) {
    sheet.getRange(1, 1, 1, HEADER.length).setValues([HEADER]);
    return;
  }

  HEADER.forEach(function(header, index) {
    if (existing[index] !== header) {
      sheet.getRange(1, index + 1).setValue(header);
    }
  });
}

function findOrCreateDateRow(sheet, dateValue, savedAt, className) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    var row = 2;
    sheet.getRange(row, 1, 1, 3).setValues([[savedAt, dateValue, className]]);
    return row;
  }

  var dates = sheet.getRange(2, 2, lastRow - 1, 1).getValues().flat();
  for (var i = 0; i < dates.length; i++) {
    if (String(dates[i]) === String(dateValue)) {
      sheet.getRange(i + 2, 1, 1, 3).setValues([[savedAt, dateValue, className]]);
      return i + 2;
    }
  }

  var nextRow = lastRow + 1;
  sheet.getRange(nextRow, 1, 1, 3).setValues([[savedAt, dateValue, className]]);
  return nextRow;
}

function ensureMemberColumn(sheet, memberName, headerIndex) {
  if (headerIndex[memberName]) return headerIndex[memberName];
  var nextColumn = sheet.getLastColumn() + 1;
  sheet.getRange(1, nextColumn).setValue(memberName);
  headerIndex[memberName] = nextColumn;
  return nextColumn;
}

function sortSheetByDate(sheet) {
  var lastRow = sheet.getLastRow();
  var lastColumn = sheet.getLastColumn();
  if (lastRow <= 2 || lastColumn < 2) return;

  var range = sheet.getRange(2, 1, lastRow - 1, lastColumn);
  range.sort({ column: 2, ascending: true });
}

function applyStatusColor(range, status) {
  var fill = STATUS_COLORS[status];
  var text = COLOR_TEXT[status];
  if (!fill || !text) return;
  range.setBackground(fill).setFontColor(text);
}

function sanitizeSheetName(value) {
  return String(value || 'Class')
    .replace(/[\[\]\:\*\?\/\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
}
```

## Suggested next version
- Add login with Supabase if you want multi-device sync without relying on one browser.
- Add export CSV per class and date.
- Add student notes and attendance history.
- Add class/date filters for reports.
