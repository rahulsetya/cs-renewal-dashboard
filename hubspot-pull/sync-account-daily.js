#!/usr/bin/env node
/**
 * Daily poster for #scale-account-creation.
 *
 * Two modes:
 *   MODE=recap   → 5pm ET summary. One message, counts of what's done today
 *                  vs still open, plus a link to the board canvas.
 *   MODE=overdue → 9am ET catchup. Lists any unclaimed / in-progress items
 *                  from prior days so nothing sits invisible. Tags the
 *                  :eyes: claimer for in-progress rows so the owner is
 *                  explicitly on the hook.
 *
 * If MODE env var is unset, the script infers from the current ET hour
 * (17 → recap, 9 → overdue). Otherwise it exits cleanly — safe for the
 * cron to fire on both EDT and EST offsets without double-posting.
 *
 * Runs from .github/workflows/sync-account-daily.yml.
 *
 * Auth: SLACK_BOT_TOKEN. Scopes: channels:history, reactions:read,
 * chat:write.
 */

const TOKEN = process.env.SLACK_BOT_TOKEN;
if (!TOKEN) { console.error('ERROR: SLACK_BOT_TOKEN env var not set.'); process.exit(1); }

const CHANNEL = 'C0BD52FM8JW';
const BOT_ID  = 'B0B2U74MTV1';
const WORKSPACE = 'iconnectionsworkspace';
const SIGNED_MARKER = 'has signed their contract';
const OVERDUE_CUTOFF_SECS = 12 * 3600;   // "leftover" = older than 12h AND still open
const CANVAS_LINK = 'https://iconnectionsworkspace.slack.com/docs/T014SDVS3PD/F0BEPP3C1QC';

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
  if (!j.ok) throw new Error(`Slack ${method} failed: ${j.error} — ${JSON.stringify(j).slice(0, 500)}`);
  return j;
}

// Current ET clock hour (0-23), DST-aware via IANA zone.
function etHour() {
  const s = new Date().toLocaleTimeString('en-US', {
    timeZone: 'America/New_York', hour: 'numeric', hour12: false
  });
  return parseInt(s, 10);
}

// Unix seconds for the start of "today" in ET. Compute by asking Intl for
// the ET wall clock and subtracting the seconds-into-the-day from now.
function todayETStartSecs() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).formatToParts(now);
  const p = Object.fromEntries(parts.filter(x => x.type !== 'literal').map(x => [x.type, x.value]));
  const secsIntoDay = (parseInt(p.hour, 10) || 0) * 3600 + (parseInt(p.minute, 10) || 0) * 60 + (parseInt(p.second, 10) || 0);
  return Math.floor(now.getTime() / 1000) - secsIntoDay;
}

function fmtAge(secs) {
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  if (d >= 1) return `${d}d ${h}h ago`;
  return `${Math.max(0, h)}h ago`;
}

// Slack markdown link. escaping angle brackets in the label so a stray
// character can't break the mrkdwn parser.
const link = (url, label) => `<${url}|${String(label).replace(/[<>]/g, '')}>`;

async function main() {
  // Pick mode. Manual dispatch can force one; cron infers by ET hour.
  const forced = (process.env.MODE || '').trim().toLowerCase();
  let mode;
  if (forced === 'recap' || forced === 'overdue') mode = forced;
  else {
    const h = etHour();
    if (h === 17) mode = 'recap';
    else if (h === 9) mode = 'overdue';
    else {
      console.log(`Current ET hour is ${h}, no daily message due — exiting.`);
      return;
    }
  }
  console.log(`Mode: ${mode}`);

  console.log('Reading channel history…');
  const hist = await slack('conversations.history', { channel: CHANNEL, limit: 200 });
  const nowSecs = Math.floor(Date.now() / 1000);

  const items = (hist.messages || [])
    .filter(m => m.bot_id === BOT_ID && (m.text || '').includes(SIGNED_MARKER))
    .map(m => {
      const text = m.text || '';
      const idx = text.indexOf(SIGNED_MARKER);
      const account = (idx > 0 ? text.slice(0, idx).trim() : '') || '(unnamed)';
      const rxArr = m.reactions || [];
      const reactions = new Set(rxArr.map(r => r.name));
      const eyesUsers = ((rxArr.find(r => r.name === 'eyes') || {}).users) || [];
      let status = 'unclaimed';
      if (reactions.has('white_check_mark')) status = 'done';
      else if (reactions.has('eyes')) status = 'in_progress';
      const ts = parseFloat(m.ts);
      const permalink = `https://${WORKSPACE}.slack.com/archives/${CHANNEL}/p${m.ts.replace('.', '')}`;
      return { account, status, ts, eyesUsers, permalink, age: nowSecs - ts };
    });

  if (mode === 'recap') {
    const todayStart = todayETStartSecs();
    const doneToday   = items.filter(i => i.status === 'done'        && i.ts >= todayStart).length;
    const inProg      = items.filter(i => i.status === 'in_progress').length;
    const unclaimed   = items.filter(i => i.status === 'unclaimed').length;
    const inProgStale = items.filter(i => i.status === 'in_progress' && i.age >= 86400).length;
    const unclStale   = items.filter(i => i.status === 'unclaimed'   && i.age >= 86400).length;
    const staleTail   = c => c ? ` _(${c} >24h)_` : '';
    const text = [
      `📊 *Account Creation daily recap*`,
      `:white_check_mark: Completed today: *${doneToday}*`,
      `:eyes: In progress: *${inProg}*${staleTail(inProgStale)}`,
      `:rotating_light: Unclaimed: *${unclaimed}*${staleTail(unclStale)}`,
      ``,
      `Live board: ${CANVAS_LINK}`
    ].join('\n');
    console.log('Posting recap…');
    await slack('chat.postMessage', { channel: CHANNEL, text });
    console.log(`Recap posted — done ${doneToday}, in progress ${inProg}, unclaimed ${unclaimed}`);
    return;
  }

  if (mode === 'overdue') {
    const overdue = items.filter(i =>
      i.age >= OVERDUE_CUTOFF_SECS && (i.status === 'unclaimed' || i.status === 'in_progress')
    );
    if (!overdue.length) {
      // Still post a short greeting so the team knows the check ran and cleared.
      await slack('chat.postMessage', {
        channel: CHANNEL,
        text: `:sunrise: Good morning! :white_check_mark: No leftover signed contracts from previous days. Nice work.`
      });
      console.log('No overdue items — posted the "all clear" note.');
      return;
    }

    const inProg    = overdue.filter(i => i.status === 'in_progress').sort((a, b) => b.age - a.age);
    const unclaimed = overdue.filter(i => i.status === 'unclaimed').sort((a, b) => b.age - a.age);

    const lines = [
      `:sunrise: *Good morning!* These signed contracts are still open from previous days — please clear them today.`
    ];
    if (inProg.length) {
      lines.push('', `:eyes: *In progress (${inProg.length}):*`);
      inProg.forEach(i => {
        const mentions = i.eyesUsers.length
          ? i.eyesUsers.map(u => `<@${u}>`).join(' ')
          : '_(no claimer)_';
        lines.push(`• ${mentions} — ${link(i.permalink, i.account)} · ${fmtAge(i.age)}`);
      });
    }
    if (unclaimed.length) {
      lines.push('', `:rotating_light: *Unclaimed (${unclaimed.length}):*`);
      unclaimed.forEach(i => {
        lines.push(`• ${link(i.permalink, i.account)} · ${fmtAge(i.age)}`);
      });
    }
    lines.push('', `Live board: ${CANVAS_LINK}`);
    console.log('Posting overdue…');
    await slack('chat.postMessage', { channel: CHANNEL, text: lines.join('\n') });
    console.log(`Overdue posted — in progress ${inProg.length}, unclaimed ${unclaimed.length}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
