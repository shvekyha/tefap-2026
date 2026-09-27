/**
 * TEFAP 2026 - RSVP + shirt orders backend (Google Apps Script).
 *
 * Receives two kinds of submissions from the website and writes each one as a
 * row in the Google Sheet this script is attached to:
 *   - RSVP form        (type: "rsvp")   -> "RSVP" tab
 *   - Shirt order form (type: "shirts") -> "shirts" tab, one column per size
 * Submissions that look like bots are logged to a "Spam" tab instead.
 * All tabs (and their header rows) are created automatically on first use.
 *
 * Setup:
 *   1. Create a new Google Sheet, then Extensions > Apps Script.
 *   2. Replace everything in Code.gs with this file and save.
 *   3. Deploy > New deployment > type "Web app".
 *      Execute as: Me. Who has access: Anyone. Deploy and authorize.
 *   4. Copy the Web app URL (ends in /exec) into RSVP_SCRIPT_URL in index.html.
 * Later code changes: Deploy > Manage deployments > pencil > New version > Deploy
 * (editing the existing deployment keeps the same URL).
 */

var RSVP_HEADERS = [
  'תאריך', 'שם מלא', 'מגיעים?', 'מבוגרים', 'ילדים', 'סה"כ',
  'מה מביאים', 'אחר (פירוט)', 'ציוד/דוכן/עזרה', 'וואטסאפ/אינסטגרם'
];

var BRING_LABELS = {
  drinks: 'שתיה',
  salad: 'סלט',
  side: 'תוספת',
  dessert: 'קינוח',
  other: 'אחר'
};

var SOCIAL_LABELS = {
  joined: 'נכנסתי לקבוצת וואטסאפ ולדף באינסטגרם',
  later: 'אני אכנס, עוד לא יצא לי',
  no: 'לא מעוניין תודה'
};

// Shirt sizes, in the same order as the columns in the "shirts" tab.
var SHIRT_SIZES = ['4', '6', '8', '10', '12', '14', '16', '18', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL'];
var SHIRTS_SHEET = 'shirts';
var SHIRTS_HEADERS = ['תאריך', 'שם מלא', 'כמות'].concat(SHIRT_SIZES);
var MAX_SHIRTS = 10;

// A person can't fill a form in under 3 seconds.
var MIN_FILL_MS = 3000;

function doGet() {
  return ContentService.createTextOutput('TEFAP 2026 RSVP endpoint is running.');
}

function doPost(e) {
  try {
    // The form sends a JSON string as the request body.
    var data = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (data.type === 'rsvp') {
      return handleRsvp_(data);
    }
    if (data.type === 'shirts') {
      return handleShirts_(data);
    }
    return json_({ status: 'error', message: 'unknown request' });
  } catch (err) {
    return json_({ status: 'error', message: 'bad request' });
  }
}

function handleRsvp_(d) {
  // Bot checks: the hidden honeypot fields must be empty, the form must have
  // been open for a few seconds, and the slide-to-verify must be done.
  var spamReason = '';
  if (text_(d.website) || text_(d.email_address)) {
    spamReason = 'honeypot filled';
  } else if (!(Number(d.elapsed) >= MIN_FILL_MS)) {
    spamReason = 'submitted too fast';
  } else if (d.captcha !== true) {
    spamReason = 'slider not completed';
  }
  if (spamReason) {
    withLock_(function () {
      getSheet_('Spam', ['Timestamp', 'Reason', 'Raw data'])
        .appendRow([new Date(), spamReason, text_(JSON.stringify(d), 1000)]);
    });
    return json_({ status: 'ok' }); // look like a normal success to the bot
  }

  var name = text_(d.name, 80);
  var attending = (d.attending === 'yes' || d.attending === 'no') ? d.attending : '';
  if (!name || !attending) {
    return json_({ status: 'error', message: 'missing required fields' });
  }

  var adults = '', kids = '', total = '', bring = '', bringOther = '', volunteer = '';
  if (attending === 'yes') {
    adults = int_(d.adults);
    kids = int_(d.kids);
    if (adults < 1 || adults > 10) {
      return json_({ status: 'error', message: 'invalid adults count' });
    }
    if (kids < 0 || kids > 10) kids = 0;
    total = adults + kids;

    var items = Array.isArray(d.bring) ? d.bring : [];
    bring = items
      .filter(function (k) { return BRING_LABELS.hasOwnProperty(k); })
      .map(function (k) { return BRING_LABELS[k]; })
      .join(', ');
    if (items.indexOf('other') !== -1) bringOther = text_(d.bringOther, 50);
    volunteer = d.volunteer === true ? 'כן' : '';
  }
  var social = SOCIAL_LABELS.hasOwnProperty(d.social) ? SOCIAL_LABELS[d.social] : '';

  withLock_(function () {
    getSheet_('RSVP', RSVP_HEADERS).appendRow([
      new Date(), name, attending === 'yes' ? 'מגיעים' : 'לא מגיעים',
      adults, kids, total, bring, bringOther, volunteer, social
    ]);
  });
  return json_({ status: 'ok' });
}

function handleShirts_(d) {
  // Same honeypot + timing checks as the RSVP form (the shirt form has no slider).
  var spamReason = '';
  if (text_(d.website) || text_(d.email_address)) {
    spamReason = 'shirts: honeypot filled';
  } else if (!(Number(d.elapsed) >= MIN_FILL_MS)) {
    spamReason = 'shirts: submitted too fast';
  }
  if (spamReason) {
    withLock_(function () {
      getSheet_('Spam', ['Timestamp', 'Reason', 'Raw data'])
        .appendRow([new Date(), spamReason, text_(JSON.stringify(d), 1000)]);
    });
    return json_({ status: 'ok' });
  }

  var name = text_(d.name, 80);
  var sizes = Array.isArray(d.sizes) ? d.sizes.map(String) : [];
  var count = int_(d.count);
  if (!name) {
    return json_({ status: 'error', message: 'missing name' });
  }
  if (count < 1 || count > MAX_SHIRTS || sizes.length !== count) {
    return json_({ status: 'error', message: 'invalid shirt count' });
  }
  for (var i = 0; i < sizes.length; i++) {
    if (SHIRT_SIZES.indexOf(sizes[i]) === -1) {
      return json_({ status: 'error', message: 'invalid size' });
    }
  }

  // How many of each size this person ordered.
  var perSize = {};
  sizes.forEach(function (s) { perSize[s] = (perSize[s] || 0) + 1; });

  withLock_(function () {
    var sheet = getSheet_(SHIRTS_SHEET, SHIRTS_HEADERS);
    // Fill the row by matching the tab's own header row, so a column added,
    // removed or moved in the sheet (e.g. an old "XS" column) never shifts the data.
    var header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    var row = header.map(function (h) {
      h = String(h).trim();
      if (h === 'תאריך') return new Date();
      if (h === 'שם מלא') return name;
      if (h === 'כמות') return count;
      return perSize[h] || '';
    });
    sheet.appendRow(row);
  });
  return json_({ status: 'ok' });
}

/* ---------- helpers ---------- */

// Returns the named tab, creating it (with a bold, frozen header row) if needed.
function getSheet_(name, headers) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name) || ss.insertSheet(name);
  if (sheet.getLastRow() === 0) {
    // Plain-text header cells, so size names like "4" and "10" stay as labels.
    sheet.getRange(1, 1, 1, headers.length).setNumberFormat('@');
    sheet.appendRow(headers);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

// Serializes writes so two submissions at the same moment can't collide.
function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    fn();
  } finally {
    lock.releaseLock();
  }
}

// Trims, caps the length, and neutralizes anything Sheets would run as a formula.
function text_(value, maxLen) {
  var s = String(value == null ? '' : value).replace(/[\u0000-\u001F\u007F]/g, ' ').trim();
  if (maxLen) s = s.slice(0, maxLen);
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return s;
}

function int_(value) {
  var n = parseInt(value, 10);
  return isNaN(n) ? -1 : n;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
