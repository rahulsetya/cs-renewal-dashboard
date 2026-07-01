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

async function main() {
  const now = Math.floor(Date.now() / 1000);

  const CANVAS = await ensureCanvas();

  console.log('Reading channel history…');
  const hist = await slack('conversations.history', { channel: CHANNEL, limit: 100 });

  const items = (hist.messages || [])
    .filter(m => m.bot_id === BOT_ID && (m.text || '').includes(SIGNED_MARKER))
    .map(m => {
      const text = m.text || '';
      const idx = text.indexOf(SIGNED_MARKER);
      // Account = text before " has signed their contract" (trimmed). The
      // HubSpot bot sometimes leaves this empty — fall back to "(unnamed)".
      const acctRaw = idx > 0 ? text.slice(0, idx).trim() : '';
      const account = acctRaw || '(unnamed)';
      // Deal type = first non-empty line after the marker.
      const after = text.slice(idx + SIGNED_MARKER.length);
      const dealType = (after.split(/\n/).map(s => s.trim()).find(Boolean) || '')
        .replace(/^\.\s*/, ''); // strip leading period that sometimes ends the marker
      const ts = m.ts;
      const permalink = `https://${WORKSPACE}.slack.com/archives/${CHANNEL}/p${ts.replace('.', '')}`;
      const rxArr = m.reactions || [];
      const reactions = new Set(rxArr.map(r => r.name));
      // For in-progress rows we want to attribute the :eyes: to whoever added
      // it. Slack returns each reaction's user array; keep it for the row.
      const eyesUsers = ((rxArr.find(r => r.name === 'eyes') || {}).users) || [];
      let status = 'unclaimed';
      if (reactions.has('white_check_mark')) status = 'done';
      else if (reactions.has('eyes')) status = 'in_progress';
      const age = now - parseFloat(ts);
      return { account, dealType, ts, permalink, status, age, eyesUsers };
    });

  // Sort tables oldest-first so the most stale float to the top.
  const unclaimed = items.filter(i => i.status === 'unclaimed').sort((a, b) => a.age - b.age).reverse();
  const inProg    = items.filter(i => i.status === 'in_progress').sort((a, b) => a.age - b.age).reverse();
  // Done: newest first, only last 24h shown as recent completions.
  const done      = items.filter(i => i.status === 'done').sort((a, b) => a.age - b.age);
  const doneRecent = done.filter(i => i.age < STALE_SECS);

  const rowMd = (i) => {
    const flag = i.age >= STALE_SECS ? ':rotating_light: ' : '';
    return `|${flag}${escCell(i.account)}|${escCell(i.dealType)}|${fmtAge(i.age)}|[open](${i.permalink})|`;
  };
  // In-progress rows also show WHO added :eyes: — Slack's <@U...> syntax
  // renders as a user chip in canvases. Multiple claimers = comma-joined.
  const rowMdInProg = (i) => {
    const flag = i.age >= STALE_SECS ? ':rotating_light: ' : '';
    const claimed = (i.eyesUsers && i.eyesUsers.length)
      ? i.eyesUsers.map(u => `<@${u}>`).join(', ')
      : '_(unknown)_';
    return `|${flag}${escCell(i.account)}|${escCell(i.dealType)}|${claimed}|${fmtAge(i.age)}|[open](${i.permalink})|`;
  };

  // Slack canvases.edit rejects the ![](slack_date:...) and ![](#channel) embeds
  // that the create tool accepts, so use plain-text alternatives everywhere.
  const nowD = new Date();
  const today = nowD.toISOString().slice(0, 10);
  const ts = nowD.toISOString().slice(11, 16) + ' UTC';

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

  const md = `# Contract → Account Creation Board

Auto-updated every 15 minutes from the HubSpot bot posts in #scale-account-creation. React on the original message with :eyes: when you're working on it, then :white_check_mark: when the account is created.

*Last update: ${today} · ${ts}*

**Legend** · :eyes: in progress · :white_check_mark: done · :rotating_light: stale > 24h with no update.

# :rotating_light: Unclaimed (${unclaimed.length})
${unclaimedSection}

# :eyes: In Progress (${inProg.length})
${inProgSection}

# :white_check_mark: Recently Completed (last 24h)

${doneSection}

# How this works

- The HubSpot bot posts to #scale-account-creation whenever a contract is signed.
- React with :eyes: to claim it, :white_check_mark: when the account is created.
- This canvas is refreshed automatically every 15 minutes by a GitHub Actions job — no manual action needed.
- Rows flagged :rotating_light: have been sitting unclaimed OR in-progress for more than 24 hours.
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
