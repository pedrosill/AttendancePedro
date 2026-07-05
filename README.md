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
3. Create a Google Sheet with columns:
   - savedAt
   - date
   - classId
   - className
   - memberName
   - status
4. Create a Google Apps Script attached to the sheet using the code below.
5. Deploy the Apps Script as a Web App with access for anyone with the link.
6. Paste the generated webhook URL into the app's Edit screen.

## Google Apps Script example
```javascript
function doPost(e) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Attendance');
  var data = JSON.parse(e.postData.contents);

  data.members.forEach(function(member) {
    sheet.appendRow([
      data.savedAt,
      data.date,
      data.classId,
      data.className,
      member.name,
      member.status
    ]);
  });

  return ContentService
    .createTextOutput(JSON.stringify({ ok: true }))
    .setMimeType(ContentService.MimeType.JSON);
}
```

## Suggested next version
- Add login with Supabase if you want multi-device sync without relying on one browser.
- Add export CSV per class and date.
- Add student notes and attendance history.
- Add class/date filters for reports.
