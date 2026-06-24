const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

// Optional first CLI arg = label appended to output filename so multiple
// pulls in the same Desktop folder don't overwrite each other. If omitted,
// stamps the filename with a YYYY-MM-DD_HHMMSS timestamp.
//   node build.js                     -> hubspot_manager_open_deals_2026-06-24_153012.xlsx
//   node build.js scale-renewals      -> hubspot_manager_open_deals_scale-renewals.xlsx
//   node build.js --in custom.json    -> read custom.json instead of data.json
let rawLabel = '';
let dataPath = path.join(__dirname, 'data.json');
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--in' && args[i + 1]) { dataPath = path.resolve(args[i + 1]); i++; continue; }
  if (!rawLabel) rawLabel = args[i];
}
const sanitize = s => String(s || '').trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
const suffix = sanitize(rawLabel) || (() => {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
})();

const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
const { owners, stageLabels, companies, deals } = data;

const HEADERS = [
  'Platform Company ID',
  'Company Name',
  'Client Success Manager',
  'Account Segment',
  'Subscription End Date',
  'Deal Name',
  'Deal Owner',
  'NEW Deal Type',
  'Event Attending',
  'NEW Deal Terms',
  'Amount',
  'Currency',
  'Deal Stage',
  'HubSpot Link'
];

const rows = deals.map(d => {
  const c = companies[d.companyId] || {};
  return [
    c.platform_companyid || '',
    c.name || '',
    c.account_manager ? (owners[c.account_manager] || `(unknown #${c.account_manager})`) : '',
    c.account_segment || '',
    c.subscription_end_date || '',
    d.dealname || '',
    d.hubspot_owner_id ? (owners[d.hubspot_owner_id] || `(unknown #${d.hubspot_owner_id})`) : '',
    d.new_deal_type || '',
    d.event_attending || '',
    d.new_deal_terms || '',
    d.amount || 0,
    d.currency || '',
    stageLabels[d.dealstage] || d.dealstage || '',
    `https://app.hubspot.com/contacts/8013348/record/0-3/${d.id}`
  ];
});

// Sort by Platform Company ID (numeric)
rows.sort((a, b) => {
  const aId = parseInt(a[0], 10) || 0;
  const bId = parseInt(b[0], 10) || 0;
  return aId - bId;
});

const totalAmount = rows.reduce((s, r) => s + (Number(r[10]) || 0), 0);

// Append TOTAL row
const totalRow = ['', '', '', '', '', '', '', '', '', 'TOTAL', totalAmount, 'USD', '', ''];

const sheetData = [HEADERS, ...rows, totalRow];
const ws = XLSX.utils.aoa_to_sheet(sheetData);

// Column widths
ws['!cols'] = [
  { wch: 13 }, // Platform Company ID
  { wch: 42 }, // Company Name
  { wch: 24 }, // CSM
  { wch: 14 }, // Segment
  { wch: 14 }, // Sub End
  { wch: 48 }, // Deal Name
  { wch: 24 }, // Deal Owner
  { wch: 18 }, // NEW Deal Type
  { wch: 38 }, // Event Attending
  { wch: 70 }, // NEW Deal Terms
  { wch: 12 }, // Amount
  { wch: 8 },  // Currency
  { wch: 30 }, // Deal Stage
  { wch: 70 }  // HubSpot Link
];

// Format Amount column as currency
const lastRow = rows.length + 1; // header + rows
for (let i = 2; i <= lastRow + 1; i++) {
  const cell = ws[`K${i}`];
  if (cell && typeof cell.v === 'number') cell.z = '"$"#,##0.00';
}

const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, 'Manager Open Deals');

const outPath = path.join('/Users/rahulsetya/Desktop', `hubspot_manager_open_deals_${suffix}.xlsx`);
XLSX.writeFile(wb, outPath);

// Archive the JSON snapshot too so a later re-build is reproducible without
// re-querying HubSpot. data.json (the live input) stays at its original path
// and may be overwritten by the next run — the archived copy is per-run.
try {
  const archiveDir = path.join(__dirname, 'runs');
  if (!fs.existsSync(archiveDir)) fs.mkdirSync(archiveDir, { recursive: true });
  fs.copyFileSync(dataPath, path.join(archiveDir, `data_${suffix}.json`));
} catch (e) { console.warn('Could not archive data snapshot:', e.message); }

// Summary
const companiesWithDeals = new Set(deals.map(d => d.companyId));
const multiDealCompanies = {};
deals.forEach(d => { multiDealCompanies[d.companyId] = (multiDealCompanies[d.companyId] || 0) + 1; });
const dupes = Object.entries(multiDealCompanies).filter(([k, v]) => v > 1).map(([k, v]) => {
  const c = companies[k] || {};
  return `  ${c.platform_companyid} ${c.name} — ${v} deals`;
});
const zeroDeals = deals.filter(d => (Number(d.amount) || 0) === 0).map(d => `  ${d.dealname} ($0)`);
const testDeals = deals.filter(d => /test/i.test(d.dealname || '')).map(d => `  ${d.dealname}`);
const pastEvents = deals.filter(d => /201[0-9]|2020|2021|2022|2023|2024/.test(d.event_attending || '')).map(d => `  ${d.dealname} — ${d.event_attending}`);

console.log(`\n=== EXPORT WRITTEN ===\n${outPath}\n`);
console.log(`Input platform IDs: 175`);
console.log(`Companies matched in HubSpot: ${Object.keys(companies).length}`);
console.log(`Open Manager-pipeline deals found: ${deals.length}`);
console.log(`Companies with ≥1 open deal: ${companiesWithDeals.size}`);
console.log(`Companies with NO open deals: ${Object.keys(companies).length - companiesWithDeals.size}`);
console.log(`Total pipeline value: $${totalAmount.toLocaleString()} USD`);
console.log(`\nFLAGS:`);
console.log(`  Multi-deal companies (${dupes.length}):`);
dupes.forEach(s => console.log(s));
console.log(`  $0 deals (${zeroDeals.length}):`);
zeroDeals.forEach(s => console.log(s));
if (testDeals.length) {
  console.log(`  TEST-named deals (${testDeals.length}):`);
  testDeals.forEach(s => console.log(s));
}
if (pastEvents.length) {
  console.log(`  Deals tied to past events (${pastEvents.length}):`);
  pastEvents.forEach(s => console.log(s));
}
