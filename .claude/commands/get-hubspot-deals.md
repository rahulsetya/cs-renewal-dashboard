---
description: Pull open Manager-pipeline HubSpot deals for a list of platform IDs and output as XLSX
---

Pull all deals from HubSpot for the platform company IDs listed below, and output a downloadable Excel file on the Desktop.

## Filter

- Pipeline = Manager (internal value `default`)
- Deal stage NOT IN: Closed Won (`closedwon`), Closed Lost (`closedlost`), Deal Cold (`1133741707`)

## Association rule

Resolve a deal to its company by HubSpot association, NOT by guessing from the deal name. After collecting deals, verify the company-side associations match.

## Output

File: `/Users/rahulsetya/Desktop/hubspot_manager_open_deals_<suffix>.xlsx`

The first non-ID token in `$ARGUMENTS` (a short word like `scale-team` or `q3-renewals`) is treated as a **label** and appended to the filename. If no label is supplied, the filename gets a `YYYY-MM-DD_HHMMSS` timestamp instead. Either way the file does NOT overwrite earlier runs.

Pass the label as the first argument to `build.js`:

```
node hubspot-pull/build.js <label>
```

Columns, in this order:

1. Platform Company ID (company property `platform_companyid`)
2. Company Name
3. Client Success Manager (company property `account_manager`, resolved to owner name)
4. Account Segment (company property `account_segment`)
5. Subscription End Date (company property `subscription_end_date`)
6. Deal Name
7. Deal Owner (resolved to owner name)
8. NEW Deal Type (`new_deal_type`)
9. Event Attending (`event_attending`)
10. NEW Deal Terms (`new_deal_terms`)
11. Amount
12. Currency
13. Deal Stage (resolved to stage label)
14. HubSpot Link to the deal

Sort by Platform Company ID. Append a TOTAL row summing Amount.

## Steps

1. **Search companies in batches** (≤100 IDs per `IN` filter): `search_crm_objects` on `companies` filtered by `platform_companyid IN [...]`. Pull `name, platform_companyid, account_manager, account_segment, subscription_end_date, hs_object_id`. Flag any input IDs that don't match.
2. **Search deals associated with the matched companies** in batches (≤100 per `associatedWith` filter): `search_crm_objects` on `deals` with `pipeline=default` AND `dealstage NOT_IN [closedwon, closedlost, 1133741707]` AND `associatedWith.companies IN [collected company IDs]`. Pull `dealname, pipeline, dealstage, amount, deal_currency_code, hubspot_owner_id, new_deal_type, event_attending, new_deal_terms`.
3. **Verify associations**: run one `search_crm_objects` on `companies` with `associatedWith.deals IN [all collected deal IDs]` and confirm the returned company set matches what the deal names suggest. For any ambiguous deal (no clear company name), query its single associated company explicitly.
4. **Resolve owner IDs to names** via `search_owners` for the union of `account_manager` (companies) and `hubspot_owner_id` (deals).
5. **Resolve dealstage IDs to labels** via `get_properties` on `deals` for the `dealstage` property options.
6. **Build the XLSX** by writing the data to `/Users/rahulsetya/Desktop/cs-renewal-dashboard-git/hubspot-pull/data.json`, then running `node /Users/rahulsetya/Desktop/cs-renewal-dashboard-git/hubspot-pull/build.js [label]` to emit the file. If `$ARGUMENTS` includes a label word (anything that isn't a numeric platform ID), pass it as the first arg so the output filename gets that suffix. Otherwise omit the arg and the script will auto-stamp a timestamp. The script already handles column layout, sort, TOTAL row, currency formatting, summary stats, and archives the raw JSON to `hubspot-pull/runs/data_<suffix>.json` for reproducibility.

## Final report

After the file is written, summarize:

- Input platform IDs (count) · companies matched · open deals found · total pipeline value
- Flags: multi-deal companies, $0 / TEST deals, deals owned by inactive HubSpot users, deals tied to past events (Event Attending mentions 2024 or earlier)
- Any input platform IDs that did NOT match a HubSpot company

## Platform IDs

$ARGUMENTS
