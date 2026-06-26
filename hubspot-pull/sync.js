#!/usr/bin/env node
/**
 * HubSpot → hubspot-deals.json auto-sync.
 *
 * Runs on a schedule from .github/workflows/sync-hubspot.yml. Pulls every open
 * Manager-pipeline deal in the iConnections portal, joins each to its primary
 * associated company, resolves owner IDs to names and dealstage IDs to labels,
 * and writes hubspot-deals.json at the repo root in the same shape the
 * dashboard's existing _offHydrateFromTeam already understands.
 *
 * Auth: HUBSPOT_TOKEN env var (Private App access token, scopes:
 *   crm.objects.companies.read, crm.objects.deals.read, crm.schemas.companies.read).
 * No write scopes; this script only reads.
 *
 * Local debug: HUBSPOT_TOKEN=pat-… node hubspot-pull/sync.js
 *   (writes hubspot-deals.json to the repo root)
 */

const fs = require('fs');
const path = require('path');

const TOKEN = process.env.HUBSPOT_TOKEN;
if (!TOKEN) {
  console.error('ERROR: HUBSPOT_TOKEN env var not set.');
  process.exit(1);
}

const HS_BASE = 'https://api.hubapi.com';
const PORTAL_ID = '8013348'; // iConnections HubSpot portal — used to build deal record URLs
const HEADERS = {
  Authorization: 'Bearer ' + TOKEN,
  'Content-Type': 'application/json'
};

const DEAL_PROPS = [
  'dealname', 'pipeline', 'dealstage', 'amount', 'deal_currency_code',
  'hubspot_owner_id', 'new_deal_type', 'event_attending', 'new_deal_terms',
  'hs_lastmodifieddate', 'createdate', 'hs_is_closed'
];

const COMPANY_PROPS = [
  'name', 'platform_companyid', 'account_manager', 'account_segment',
  'subscription_end_date'
];

// Pipelines to include, matched by LABEL (case-insensitive). Resolved to IDs
// at runtime by hitting /crm/v3/pipelines/deals — that way the script doesn't
// break if HubSpot recreates a pipeline and the internal ID changes.
const INCLUDED_PIPELINE_LABEL_PATTERNS = [/^manager$/i, /^service\s*provider/i];

// Stage labels that should be dropped from pipeline view even when HubSpot
// marks them as "open" (e.g. Deal Cold = abandoned but technically not closed).
// Closed-won / closed-lost are detected automatically via stage.metadata.isClosed.
const EXTRA_EXCLUDED_STAGE_LABEL_PATTERNS = [/deal\s*cold/i];

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function hsFetch(url, init = {}, retries = 3) {
  let lastErr;
  for (let attempt = 0; attempt < retries; attempt++) {
    const res = await fetch(url, { ...init, headers: { ...HEADERS, ...(init.headers || {}) } });
    if (res.ok) return res.json();
    if (res.status === 429 || res.status >= 500) {
      // Rate limit or transient — back off and retry
      const wait = 500 * Math.pow(2, attempt);
      lastErr = new Error(`HubSpot ${res.status} (will retry in ${wait}ms): ${url}`);
      console.warn(lastErr.message);
      await sleep(wait);
      continue;
    }
    // Non-retryable
    const body = await res.text().catch(() => '');
    throw new Error(`HubSpot ${res.status}: ${url}\n${body.slice(0, 500)}`);
  }
  throw lastErr || new Error('HubSpot fetch failed after retries: ' + url);
}

// 1. Fetch every open deal in the included pipelines (paginated).
async function fetchOpenDeals(pipelineIds, excludedStageIds) {
  const out = [];
  let after = null;
  while (true) {
    const body = {
      filterGroups: [{
        filters: [
          { propertyName: 'pipeline', operator: 'IN', values: pipelineIds },
          { propertyName: 'dealstage', operator: 'NOT_IN', values: excludedStageIds }
        ]
      }],
      properties: DEAL_PROPS,
      limit: 100,
      ...(after ? { after } : {})
    };
    const j = await hsFetch(`${HS_BASE}/crm/v3/objects/deals/search`, {
      method: 'POST', body: JSON.stringify(body)
    });
    (j.results || []).forEach(d => out.push(d));
    const nextAfter = j.paging && j.paging.next && j.paging.next.after;
    if (!nextAfter) break;
    after = nextAfter;
  }
  return out;
}

// 2. For each deal, list its associated company IDs (typically one, sometimes
// more). We take the first company as the primary.
async function fetchDealCompanyAssociations(dealIds) {
  const map = {};
  for (let i = 0; i < dealIds.length; i += 100) {
    const batch = dealIds.slice(i, i + 100);
    const j = await hsFetch(
      `${HS_BASE}/crm/v4/associations/deals/companies/batch/read`,
      { method: 'POST', body: JSON.stringify({ inputs: batch.map(id => ({ id })) }) }
    );
    (j.results || []).forEach(r => {
      const dealId = r.from && r.from.id;
      const toIds = (r.to || []).map(t => String(t.toObjectId));
      if (dealId) map[dealId] = toIds;
    });
  }
  return map;
}

// 3. Pull the company records for the unique IDs we collected.
async function fetchCompanies(companyIds) {
  const out = [];
  for (let i = 0; i < companyIds.length; i += 100) {
    const batch = companyIds.slice(i, i + 100);
    const j = await hsFetch(`${HS_BASE}/crm/v3/objects/companies/batch/read`, {
      method: 'POST',
      body: JSON.stringify({ inputs: batch.map(id => ({ id })), properties: COMPANY_PROPS })
    });
    (j.results || []).forEach(c => out.push(c));
  }
  return out;
}

// 4. All owners (active + archived) so we can map IDs to display names.
async function fetchOwners() {
  const out = [];
  let next = `${HS_BASE}/crm/v3/owners?limit=100&archived=false`;
  while (next) {
    const j = await hsFetch(next);
    (j.results || []).forEach(o => out.push(o));
    next = j.paging && j.paging.next && j.paging.next.link;
  }
  // Archived owners too (the comp dashboard flags inactive owners)
  let nextA = `${HS_BASE}/crm/v3/owners?limit=100&archived=true`;
  while (nextA) {
    const j = await hsFetch(nextA);
    (j.results || []).forEach(o => out.push(o));
    nextA = j.paging && j.paging.next && j.paging.next.link;
  }
  return out;
}

// 5. Resolve which pipelines we're syncing from, plus the stage metadata we
// need from them. One HubSpot call drives three things:
//   - pipelineIds: the IDs the deal-search filter uses
//   - stageLabels: id → human label, for the dashboard's Stage column
//   - excludedStages: closed-won / closed-lost (detected via metadata.isClosed)
//     and any stages whose label matches EXTRA_EXCLUDED_STAGE_LABEL_PATTERNS.
async function resolvePipelineConfig() {
  const j = await hsFetch(`${HS_BASE}/crm/v3/pipelines/deals`);
  const all = j.results || [];
  const wanted = all.filter(p => INCLUDED_PIPELINE_LABEL_PATTERNS.some(re => re.test(p.label)));
  if (!wanted.length) {
    const avail = all.map(p => `${p.label}(${p.id})`).join(' | ');
    throw new Error(`No pipelines matched include patterns. Available: ${avail}`);
  }
  console.log('Pipelines included:', wanted.map(p => `${p.label}(${p.id})`).join(', '));

  const stageLabels = {};
  const excluded = new Set();
  wanted.forEach(p => {
    (p.stages || []).forEach(s => {
      stageLabels[s.id] = s.label;
      // HubSpot serializes metadata.isClosed as the string "true"/"false"
      const closed = s.metadata && (s.metadata.isClosed === 'true' || s.metadata.isClosed === true);
      if (closed) excluded.add(s.id);
      if (EXTRA_EXCLUDED_STAGE_LABEL_PATTERNS.some(re => re.test(s.label))) excluded.add(s.id);
    });
  });
  console.log('Excluded stages (closed + extras):', [...excluded].length);

  return {
    pipelineIds: wanted.map(p => p.id),
    pipelineLabels: wanted.map(p => p.label),
    stageLabels,
    excludedStages: [...excluded]
  };
}

function quarterOf(isoDate) {
  if (!isoDate) return 'Undated';
  const m = String(isoDate).match(/^\d{4}-(\d{2})/);
  if (!m) return 'Undated';
  const month = parseInt(m[1], 10);
  if (month <= 3) return 'Q1';
  if (month <= 6) return 'Q2';
  if (month <= 9) return 'Q3';
  return 'Q4';
}

async function main() {
  console.log('Resolving pipeline config…');
  const cfg = await resolvePipelineConfig();

  console.log('Fetching open deals across included pipelines…');
  const deals = await fetchOpenDeals(cfg.pipelineIds, cfg.excludedStages);
  console.log(`  ${deals.length} deals`);

  const dealIds = deals.map(d => d.id);
  console.log('Fetching deal → company associations…');
  const dealToCompanies = await fetchDealCompanyAssociations(dealIds);

  const uniqueCompanyIds = [...new Set(Object.values(dealToCompanies).flat())].filter(Boolean);
  console.log(`  ${uniqueCompanyIds.length} unique companies`);

  console.log('Fetching company records…');
  const companies = await fetchCompanies(uniqueCompanyIds);

  console.log('Fetching owners…');
  const owners = await fetchOwners();
  console.log(`  ${owners.length} owners`);

  const stageLabels = cfg.stageLabels;

  // Build owner ID → {name, isActive} map.
  const ownersMap = {};
  owners.forEach(o => {
    const name = [o.firstName, o.lastName].filter(Boolean).join(' ').trim() ||
                 o.email || ('Owner #' + o.id);
    ownersMap[o.id] = { name, isActive: !o.archived };
  });

  // Build company ID → record map.
  const companiesByHsId = {};
  companies.forEach(c => {
    companiesByHsId[c.id] = {
      hsId: c.id,
      platformId: c.properties.platform_companyid || '',
      name: c.properties.name || '',
      accountManager: c.properties.account_manager || '',
      accountSegment: c.properties.account_segment || '',
      subscriptionEndDate: c.properties.subscription_end_date || ''
    };
  });

  // Bucket deals by quarter (using the primary associated company's
  // subscription_end_date). The dashboard's Offers tab reads {quarters: {Q1,…}}
  // — same shape the manual upload produces — so dropping this in lets the
  // existing render path consume it unchanged.
  const quarters = { Q1: [], Q2: [], Q3: [], Q4: [], Undated: [] };
  const droppedNoCompany = [];
  const droppedNoPid = [];

  // Map pipeline ID → label so each deal item can carry its pipeline name
  // (e.g. 'Manager', 'Service Provider'). The dashboard's Offers tab uses
  // this to filter the GP/SP split.
  const pipelineLabelById = {};
  cfg.pipelineIds.forEach((id, i) => { pipelineLabelById[id] = cfg.pipelineLabels[i]; });

  deals.forEach(d => {
    const companyIds = dealToCompanies[d.id] || [];
    const primary = companyIds[0] ? companiesByHsId[companyIds[0]] : null;
    if (!primary) { droppedNoCompany.push(d.id); return; }
    if (!primary.platformId) { droppedNoPid.push({ dealId: d.id, companyName: primary.name }); return; }

    const q = quarterOf(primary.subscriptionEndDate);
    const ownerInfo = ownersMap[d.properties.hubspot_owner_id] || null;
    const stageLabel = stageLabels[d.properties.dealstage] || d.properties.dealstage || '';
    const pipelineId = d.properties.pipeline || '';
    const pipelineLabel = pipelineLabelById[pipelineId] || pipelineId;

    quarters[q].push({
      pid: primary.platformId,
      companyName: primary.name,                            // Lets SP_ACCTS (no pid) match by name
      dealName: d.properties.dealname || '',
      dealType: d.properties.new_deal_type || '',
      amount: Number(d.properties.amount) || 0,
      currency: d.properties.deal_currency_code || 'USD',
      stage: stageLabel,                                    // Pre-resolved label
      stageId: d.properties.dealstage || '',                // Keep raw ID for reference
      pipeline: pipelineLabel,                              // 'Manager' | 'Service Provider'
      pipelineId,                                           // Raw HubSpot pipeline ID
      eventAttending: d.properties.event_attending || '',
      dealTerms: d.properties.new_deal_terms || '',
      link: `https://app.hubspot.com/contacts/${PORTAL_ID}/record/0-3/${d.id}`,
      ownerId: d.properties.hubspot_owner_id || '',
      ownerName: ownerInfo ? ownerInfo.name : '',
      ownerActive: ownerInfo ? ownerInfo.isActive : true,
      hsLastModified: d.properties.hs_lastmodifieddate || ''
    });
  });

  const now = new Date().toISOString();
  const uploads = { Q1: now, Q2: now, Q3: now, Q4: now };

  const payload = {
    publishedAt: now,
    syncedAt: now,
    source: 'hubspot-auto-sync',
    filters: {
      pipelineIds: cfg.pipelineIds,
      pipelineLabels: cfg.pipelineLabels,
      dealstageExcludes: cfg.excludedStages
    },
    counts: {
      deals: deals.length,
      includedDeals: Object.values(quarters).reduce((s, arr) => s + arr.length, 0),
      companies: Object.keys(companiesByHsId).length,
      droppedNoCompany: droppedNoCompany.length,
      droppedNoPid: droppedNoPid.length,
      perQuarter: Object.fromEntries(Object.entries(quarters).map(([k, v]) => [k, v.length]))
    },
    quarters,
    uploads,
    owners: ownersMap,
    stageLabels,
    // Name → platform-ID lookup. The dashboard uses this for SP_ACCTS rows,
    // which come from the "All SP Rev 25 & 26" sheet (no platform_companyid
    // column) but need to surface the ID and join cleanly to deals. Keyed by
    // the canonical company name from HubSpot; the dashboard normalizes
    // lower-case + strips non-alphanumeric before lookup.
    companies: (() => {
      const idx = {};
      companies.forEach(c => {
        const name = c.properties.name || '';
        const pid = c.properties.platform_companyid || '';
        if (name && pid) idx[name] = { platformId: pid, hsId: c.id, segment: c.properties.account_segment || '' };
      });
      return idx;
    })()
  };

  const outPath = path.resolve(__dirname, '..', 'hubspot-deals.json');
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2) + '\n');
  console.log(`Wrote ${outPath}`);
  console.log(`  Deals included: ${payload.counts.includedDeals} / ${deals.length}`);
  console.log(`  Per quarter:`, payload.counts.perQuarter);
  if (droppedNoCompany.length) console.warn(`  Dropped (no company assoc): ${droppedNoCompany.length}`);
  if (droppedNoPid.length) console.warn(`  Dropped (company missing platform_companyid): ${droppedNoPid.length}`);
}

main().catch(e => { console.error(e); process.exit(1); });
