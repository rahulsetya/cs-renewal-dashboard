#!/usr/bin/env node
/**
 * Slack → canvas refresher for the Contract → Account Creation Board.
 *
 * Reads recent messages from #scale-account-creation, filters to the
 * HubSpot bot's "has signed their contract" posts, categorizes each by
 * its reactions (eyes / white_check_mark), and rewrites the pinned Slack
 * canvas via canvases.edit.
 *
 * Runs on a 15-minute cron from .github/workflows/sync-account-board.yml.
 *
 * Auth: SLACK_BOT_TOKEN env var (Bot User OAuth Token, xoxb-…). Required
 *   scopes: channels:history, channels:read, reactions:read, canvases:write.
 *   The bot must be a member of the channel or conversations.history 4xxs.
 */

const fs = require('fs');
const path = require('path');

const TOKEN = process.env.SLACK_BOT_TOKEN;
if (!TOKEN) { console.error('ERROR: SLACK_BOT_TOKEN env var not set.'); process.exit(1); }

const CHANNEL = 'C0BD52FM8JW';       // #scale-account-creation
const WIRES_CHANNEL = 'C0B3ASC5K5X'; // #cs-wires-onboarding (private)
const BOT_ID  = 'B0B2U74MTV1';       // HubSpot Slack app (posts the source msgs)
const WORKSPACE = 'iconnectionsworkspace';
// Slack canvases are owned by whoever created them; only the owner (or a
// workspace admin) can edit a standalone canvas. That means the bot must
// create its own canvas. We store the bot-owned canvas id in a small file
// beside this script and commit it back so the next run finds it.
const CANVAS_ID_FILE = path.join(__dirname, '.slack-canvas-id');
const CANVAS_TITLE = 'Contract → Account Creation Board';
const SIGNED_MARKER = 'has signed their contract';
const STALE_SECS = 24 * 3600;

async function slack(method, payload) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${TOKEN}`,
      'Content-Type': 'application/json; charset=utf-8'
    },
    body: JSON.stringify(payload)
  });
  const j = await res.json();
  if (!j.ok) throw new Error(`Slack ${method} failed: ${j.error}${j.needed ? ' (needed: ' + j.needed + ')' : ''} — ${JSON.stringify(j).slice(0, 500)}`);
  return j;
}

// One-line escape for markdown table cells. Pipes inside a cell break the
// row; angle brackets sometimes get munged.
const escCell = s => String(s || '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

function fmtAge(secs) {
  if (secs < 3600) return `${Math.max(0, Math.floor(secs / 60))}m ago`;
  if (secs < STALE_SECS) return `${Math.floor(secs / 3600)}h ago`;
  const d = Math.floor(secs / STALE_SECS);
  const h = Math.floor((secs % STALE_SECS) / 3600);
  return `${d}d ${h}h ago`;
}

function readCanvasId() {
  try { return fs.readFileSync(CANVAS_ID_FILE, 'utf8').trim() || null; }
  catch (e) { return null; }
}
function saveCanvasId(id) {
  fs.writeFileSync(CANVAS_ID_FILE, id + '\n');
}
// Post a small breadcrumb in the channel so people know the new bot-owned
// canvas is the one to watch. Only fires the first time we bootstrap.
async function announceNewCanvas(canvasId) {
  const url = `https://${WORKSPACE}.slack.com/docs/T014SDVS3PD/${canvasId}`;
  try {
    await slack('chat.postMessage', {
      channel: CHANNEL,
      text: `📋 The live Contract → Account Creation board is here: ${url} — refreshes every 15 minutes. React on any HubSpot signed-contract post with :eyes: to claim it and :white_check_mark: when done.`
    });
  } catch (e) { console.warn('Could not post canvas announcement:', e.message); }
}

async function ensureCanvas() {
  let id = readCanvasId();
  if (id) return id;
  console.log('No stored canvas ID — creating a bot-owned canvas…');
  const seed = `# ${CANVAS_TITLE}\n\n_Initializing… full board will populate on the next run._`;
  const j = await slack('canvases.create', {
    title: CANVAS_TITLE,
    document_content: { type: 'markdown', markdown: seed }
  });
  id = j.canvas_id;
  saveCanvasId(id);
  console.log('Created canvas', id);
  await announceNewCanvas(id);
  return id;
}

// User directory: single users.list call up front caches every workspace
// member. Turns out users.info hits `user_not_found` on this workspace for
// legit users (probably an Enterprise Grid quirk where reaction IDs are
// scoped differently than users.info lookups). users.list uses the same
// users:read scope but returns everyone in one shot and side-steps the
// per-ID lookup weirdness.
let _userMap = null;
async function loadUserMap() {
  if (_userMap) return _userMap;
  _userMap = {};
  let cursor = '';
  let calls = 0;
  try {
    do {
      calls++;
      const j = await slack('users.list', { limit: 200, cursor: cursor || undefined });
      (j.members || []).forEach(u => {
        const p = u.profile || {};
        const name = p.display_name || p.real_name || u.name || u.id;
        _userMap[u.id] = name;
      });
      cursor = (j.response_metadata && j.response_metadata.next_cursor) || '';
    } while (cursor && calls < 20);
    console.log(`users.list cached ${Object.keys(_userMap).length} members (${calls} call${calls === 1 ? '' : 's'})`);
  } catch (e) {
    console.warn(`users.list FAILED: ${e.message} — Claimed by column will show raw IDs.`);
  }
  return _userMap;
}
function resolveUser(uid) {
  if (!uid) return '';
  const name = _userMap && _userMap[uid];
  if (name) return name;
  // Not in the workspace list — most likely an Enterprise Grid cross-workspace
  // user. Log once so we know which IDs aren't resolvable, then fall back to
  // the raw ID.
  if (_userMap && !_userMap[uid + '_logged']) {
    console.log(`resolveUser: no directory entry for ${uid}`);
    _userMap[uid + '_logged'] = true;
  }
  return uid;
}

// Normalize a company name for substring matching. Lowercase, alphanumeric
// only. So "Corbin Capital Partners" → "corbincapitalpartners" and a wires
// post saying "Corbin Capital $50k wire in" normalizes to "corbincapital…".
function normStr(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ''); }

// Generic tokens to strip from an account name before matching — these
// appear on so many companies that requiring them causes false positives
// (a wires post saying "Corbin Capital" would miss because "partners" isn't
// there). Match against tokens BEFORE further concatenation.
const GENERIC_TOKENS = new Set([
  'the','and','of','a','an',
  // legal suffixes
  'llc','lp','llp','ltd','inc','corp','co','plc','pty','sarl','gmbh','sa','ag','bv','nv','oy',
  // finance descriptors
  'capital','partners','partner','management','managers','investments','investment',
  'fund','funds','group','advisors','advisers','advisory','asset','assets',
  'global','holdings','holding','ventures','venture','equity','trust','bank',
  'company','international','financial','services','securities','markets',
  'family','office','multi'
]);

// Split an account name into distinctive tokens for matching. Keeps tokens
// ≥ 3 characters that aren't in GENERIC_TOKENS. If nothing distinctive
// remains (rare — pure-generic names like "Global Capital Partners"), fall
// back to the raw first ≥3-char token so we still have something to match.
function accountTokens(account) {
  const raw = String(account || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const distinctive = raw.filter(t => t.length >= 3 && !GENERIC_TOKENS.has(t));
  if (distinctive.length) return distinctive;
  return raw.filter(t => t.length >= 3).slice(0, 1);
}

// True when EVERY distinctive token from the account name appears inside
// the normalized wires-message text. Requiring "all" keeps false positives
// low (a stray "capital" in the wires channel doesn't accidentally match
// three different accounts).
function wiresPostMatchesAccount(account, wiresNormText) {
  const toks = accountTokens(account);
  if (!toks.length) return false;
  return toks.every(t => wiresNormText.includes(t));
}

// Pull the wires-channel corpus. Fails gracefully — if the bot isn't in the
// channel or lacks groups:history, return null and the missing-wires section
// renders with a "can't check" placeholder instead of breaking the whole run.
async function fetchWiresCorpus() {
  try {
    const j = await slack('conversations.history', { channel: WIRES_CHANNEL, limit: 200 });
    const msgs = (j.messages || []).map(m => ({
      normText: normStr(m.text || ''),
      ts: parseFloat(m.ts),
      user: m.user || ''
    }));
    console.log(`Wires channel: ${msgs.length} messages loaded.`);
    return msgs;
  } catch (e) {
    console.warn(`Wires channel read FAILED: ${e.message}`);
    return null;
  }
}

async function main() {
  const now = Math.floor(Date.now() / 1000);

  const CANVAS = await ensureCanvas();

  console.log('Reading channel history…');
  const hist = await slack('conversations.history', { channel: CHANNEL, limit: 100 });
  const wiresCorpus = await fetchWiresCorpus();

  const items = (hist.messages || [])
    .filter(m => m.bot_id === BOT_ID && (m.text || '').includes(SIGNED_MARKER))
    .map(m => {
      const text = m.text || '';
      const idx = text.indexOf(SIGNED_MARKER);
      // Account = text before " has signed their contract" (trimmed). The
      // HubSpot bot sometimes leaves this empty — fall back to "(unnamed)".
      const acctRaw = idx > 0 ? text.slice(0, idx).trim() : '';
      const account = acctRaw || '(unnamed)';
      // Deal type = first meaningful line after the marker. The Slack text
      // slices as "…has signed their contract." + \n + "Platform Renewal"
      // + \n + events. Trim leading periods first so ".find(Boolean)" doesn't
      // grab the trailing period from the marker sentence.
      const after = text.slice(idx + SIGNED_MARKER.length);
      const dealType = after
        .split(/\n/)
        .map(s => s.replace(/^\.+\s*/, '').trim())
        .find(s => s && !/^[.,;:!\-–—]+$/.test(s)) || '';
      const ts = m.ts;
      const permalink = `https://${WORKSPACE}.slack.com/archives/${CHANNEL}/p${ts.replace('.', '')}`;
      const rxArr = m.reactions || [];
      const reactions = new Set(rxArr.map(r => r.name));
      // For in-progress rows we want to attribute the :eyes: to whoever added
      // it. Slack returns each reaction's user array; keep it for the row.
      const eyesUsers = ((rxArr.find(r => r.name === 'eyes') || {}).users) || [];
      // A :x: reaction voids the message — treat as canceled and drop from
      // every tracking bucket (unclaimed / in progress / done / missing wires).
      const voided = reactions.has('x');
      // A :money_with_wings: reaction is a MANUAL "wires post exists,
      // matcher just missed it" override. Item stays in every other bucket
      // but is excluded from the missing-wires check.
      const wiresOverride = reactions.has('money_with_wings');
      let status = 'unclaimed';
      if (reactions.has('white_check_mark')) status = 'done';
      else if (reactions.has('eyes')) status = 'in_progress';
      const age = now - parseFloat(ts);
      return { account, dealType, ts, permalink, status, age, eyesUsers, voided, wiresOverride };
    })
    .filter(i => !i.voided);
  const voidedCount = ((hist.messages || []).filter(m =>
    m.bot_id === BOT_ID
    && (m.text || '').includes(SIGNED_MARKER)
    && ((m.reactions || []).some(r => r.name === 'x'))
  )).length;
  if (voidedCount) console.log(`Skipping ${voidedCount} :x:-voided item${voidedCount === 1 ? '' : 's'}.`);

  // Sort tables oldest-first so the most stale float to the top.
  const unclaimed = items.filter(i => i.status === 'unclaimed').sort((a, b) => a.age - b.age).reverse();
  const inProg    = items.filter(i => i.status === 'in_progress').sort((a, b) => a.age - b.age).reverse();
  // Done: newest first, only last 24h shown as recent completions.
  const done      = items.filter(i => i.status === 'done').sort((a, b) => a.age - b.age);
  const doneRecent = done.filter(i => i.age < STALE_SECS);

  // Missing-wires check. For each ✅-marked account, break the name into
  // distinctive tokens (dropping "Capital", "Partners", "LLC", etc.) and
  // require ALL of them to appear in some wires post. That way a wires
  // post saying "Corbin Capital $50k wire" still counts as a match for
  // "Corbin Capital Partners" — the token "corbin" is present and there
  // are no missing anchors. Only checks completions from the last 14 days
  // so ancient posts that pre-date the wires channel don't get flagged.
  const MISSING_WIRES_WINDOW = 14 * 86400;
  const missingWires = [];
  if (wiresCorpus) {
    done.forEach(i => {
      if (i.age > MISSING_WIRES_WINDOW) return;
      if (i.account === '(unnamed)') return;
      if (i.wiresOverride) return;                       // manual :money_with_wings: override
      const hit = wiresCorpus.some(m => wiresPostMatchesAccount(i.account, m.normText));
      if (!hit) missingWires.push(i);
    });
  }
  missingWires.sort((a, b) => b.age - a.age); // oldest-first (largest age first)

  const rowMd = (i) => {
    const flag = i.age >= STALE_SECS ? ':rotating_light: ' : '';
    return `|${flag}${escCell(i.account)}|${escCell(i.dealType)}|${fmtAge(i.age)}|[open](${i.permalink})|`;
  };
  // In-progress rows AND missing-wires rows both attribute :eyes: to
  // whoever added it. <@U...> mentions don't render as chips inside canvas
  // table cells, so resolve display names via users.list and render plain
  // text. Multiple claimers → comma-joined. Load the workspace directory
  // once; resolveUser then does O(1) lookups.
  if (inProg.length || missingWires.length) await loadUserMap();
  const rowMdInProg = (i) => {
    const flag = i.age >= STALE_SECS ? ':rotating_light: ' : '';
    const claimed = (i.eyesUsers && i.eyesUsers.length)
      ? i.eyesUsers.map(u => resolveUser(u)).join(', ')
      : '_(unknown)_';
    return `|${flag}${escCell(i.account)}|${escCell(i.dealType)}|${escCell(claimed)}|${fmtAge(i.age)}|[open](${i.permalink})|`;
  };

  // Slack canvases.edit rejects the ![](slack_date:...) and ![](#channel) embeds
  // that the create tool accepts, so use plain-text alternatives everywhere.
  // Render the timestamp in Eastern time (auto-DST via IANA zone) 12h format.
  const nowD = new Date();
  const TZ = 'America/New_York';
  const today = nowD.toLocaleDateString('en-CA', { timeZone: TZ }); // YYYY-MM-DD
  const ts = nowD.toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true }) + ' ET';

  const unclaimedSection = unclaimed.length
    ? `*No reactions yet. Someone claim it with :eyes:.*

|Account|Deal Type|Posted|Link|
|---|---|---|---|
${unclaimed.map(rowMd).join('\n')}`
    : '*Nothing here — nice.*';

  const inProgSection = inProg.length
    ? `*Claimed by :eyes: — not yet completed.*

|Account|Deal Type|Claimed by|Posted|Link|
|---|---|---|---|---|
${inProg.map(rowMdInProg).join('\n')}`
    : '*Nothing in flight right now.*';

  const doneSection = doneRecent.length
    ? `${doneRecent.length} completed in the last 24 hours${doneRecent.length > 10 ? ' — showing 10 newest' : ''}.

${doneRecent.slice(0, 10).map(i => `- ${escCell(i.account)} — ${escCell(i.dealType)} — completed ${fmtAge(i.age)}`).join('\n')}`
    : '*No completions in the last 24 hours.*';

  // Missing-wires block. Three states:
  //   1. Wires corpus unavailable (bot not invited or missing scope) →
  //      placeholder tells you how to fix it.
  //   2. Corpus loaded, zero missing → celebratory line.
  //   3. Corpus loaded, N missing → table of the accounts to chase.
  const missingWiresSection = !wiresCorpus
    ? `_Bot can't read #cs-wires-onboarding yet — invite it with \`/invite @Account Creation Board Bot\` in that channel and add the \`groups:history\` scope so this check can run._`
    : missingWires.length
      ? `*${missingWires.length} account${missingWires.length === 1 ? '' : 's'} marked complete but no matching post found in #cs-wires-onboarding (last 14 days).* If one of these was actually posted, add :money_with_wings: to the HubSpot message and it will drop off the list on the next refresh.

|Account|Deal Type|Claimed by|Completed|Link|
|---|---|---|---|---|
${missingWires.map(i => {
  const claimed = (i.eyesUsers && i.eyesUsers.length)
    ? i.eyesUsers.map(u => resolveUser(u)).join(', ')
    : '_(unknown)_';
  return `|${escCell(i.account)}|${escCell(i.dealType)}|${escCell(claimed)}|${fmtAge(i.age)}|[open](${i.permalink})|`;
}).join('\n')}`
      : '*Nothing missing — every completed account has a matching wires post.*';

  const md = `# Contract → Account Creation Board

Auto-updated every 15 minutes from the HubSpot bot posts in #scale-account-creation. Everything below is driven by the reactions people add to those source messages.

*Last update: ${today} · ${ts}*

# Reactions — how this board is driven

React on the original HubSpot signed-contract message in #scale-account-creation. The board rebuilds from those reactions on the next refresh.

|Reaction|Meaning|Effect|
|---|---|---|
|:eyes:|Claim it — you're taking this one|Row moves from Unclaimed → In Progress, tags you as the owner|
|:white_check_mark:|Account creation complete|Row moves to Recently Completed, kicks off the wires-post check|
|:money_with_wings:|"Wires post exists — matcher missed it"|Row drops off the missing-wires section (manual override for false positives)|
|:x:|Void this row entirely|Row disappears from every section (use when the HubSpot post shouldn't have fired at all)|

Rows flagged :rotating_light: have been sitting in the same state for more than 24 hours.

# :rotating_light: Unclaimed (${unclaimed.length})
${unclaimedSection}

# :eyes: In Progress (${inProg.length})
${inProgSection}

# :white_check_mark: Recently Completed (last 24h)

${doneSection}

# :warning: Completed but not posted to #cs-wires-onboarding${missingWires.length ? ` (${missingWires.length})` : ''}
${missingWiresSection}

# How this works

- The HubSpot bot posts to #scale-account-creation whenever a contract is signed.
- People add reactions on those source messages (see the Reactions table above).
- After :white_check_mark:, the CSM posts the contract terms in #cs-wires-onboarding. This board scans that channel for a matching post (by account name) — anything missing shows up in the "Completed but not posted…" section.
- Refreshes automatically every 15 minutes via GitHub Actions.
`;

  console.log('Updating canvas…');
  await slack('canvases.edit', {
    canvas_id: CANVAS,
    changes: [{
      operation: 'replace',
      document_content: { type: 'markdown', markdown: md }
    }]
  });

  console.log(`Updated ${CANVAS} — Unclaimed: ${unclaimed.length}, In Progress: ${inProg.length}, Done (24h): ${doneRecent.length}`);
}

main().catch(e => { console.error(e); process.exit(1); });
