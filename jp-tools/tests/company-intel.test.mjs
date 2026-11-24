// Offline tests for jp-tools/company-intel.mjs.  Run: node --test jp-tools/tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseCodeList, findCompany, readXbrlCsv, extractFacts, candidateDates, findLatestFilings, normalizeCompanyName,
} from '../lib/edinet.mjs';
import { runFetch, parseArgs, htmlToText, findIrLinks, tagTdnetTitle, slugify } from '../company-intel.mjs';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const codeZip = readFileSync(join(FIX, 'Edinetcode.zip'));
const yuhoZip = readFileSync(join(FIX, 'yuho-csv.zip'));

test('code list parses Shift_JIS CSV with banner line and quoted commas', () => {
  const list = parseCodeList(codeZip);
  assert.equal(list.length, 4);
  assert.equal(list[0].name, 'ＡＢＣホールディングス株式会社');
  assert.equal(list[0].secCode, '23840');
  assert.equal(list[3].nameEn, 'Blue Shipping Co., Ltd.');
});

test('company lookup: half-width input, HD abbreviation, sec code, ambiguity', () => {
  const list = parseCodeList(codeZip);
  assert.equal(findCompany(list, { name: 'ABCホールディングス' }).match.edinetCode, 'E04274');
  assert.equal(findCompany(list, { name: 'ABC HD' }).match.edinetCode, 'E04274');
  assert.equal(findCompany(list, { name: 'ブルーシッピング' }).match.edinetCode, 'E77777');
  assert.equal(findCompany(list, { secCode: '2384' }).match.edinetCode, 'E04274');
  assert.equal(findCompany(list, { name: 'サンプルワークス' }).match.edinetCode, 'E99999');
  // "ABC" alone matches two filers → no automatic pick, both offered.
  const amb = findCompany(list, { name: 'ABC' });
  assert.equal(amb.match, null);
  assert.ok(amb.candidates.length >= 2);
  assert.equal(normalizeCompanyName('株式会社 港物流'), '港物流');
});

test('XBRL CSV: skips audit file, prefers consolidated, ignores segment members', () => {
  const rows = readXbrlCsv(yuhoZip);
  const f = extractFacts(rows, { periodEnd: '2025-12-31' });
  const cur = f.financials.find((x) => x.offset === 0);
  assert.equal(cur.label, '2025年12月期');
  assert.equal(cur.basis, '連結');
  assert.equal(cur.netSales, 450000000000);
  assert.equal(cur.operatingIncome, 21000000000, 'falls back to the P/L operating income');
  assert.equal(cur.ordinaryIncome, 20000000000);
  assert.equal(cur.netIncome, 12000000000);
  assert.equal(cur.employees, 9500, 'consolidated, not the segment member 8000');
  assert.equal(f.financials.find((x) => x.offset === 1).netSales, 400000000000);
  assert.deepEqual(
    { a: f.employees.avgAge, t: f.employees.avgTenure, s: f.employees.avgSalary, n: f.employees.nonConsolidated },
    { a: 41.2, t: 9.8, s: 7850000, n: 120 },
  );
  assert.match(f.sections.policy.text, /倉庫の自動化/);
  assert.equal(f.sections.risks.text, '燃料価格の高騰、 ドライバー不足', 'markup stripped');
  assert.match(f.sections.affiliates.text, /ABCロジスティクス/);
});

test('candidate dates put the statutory filing window first and skip weekends', () => {
  const today = new Date(2026, 10, 24);
  const dates = candidateDates(today, 400, '3月31日');
  // 3月決算 → 有報 is filed late June; the window is scanned before anything else.
  assert.match(dates[0], /^2026-07-0\d|^2026-06-/);
  assert.ok(dates.slice(0, 20).every((d) => d >= '2026-05-25' && d <= '2026-07-09'));
  for (const d of dates) assert.ok(![0, 6].includes(new Date(d).getUTCDay()), `${d} is a weekend`);
  assert.equal(new Set(dates).size, dates.length);
});

test('findLatestFilings stops after the annual report plus a newer half-year report', async () => {
  const lists = {
    '2026-06-26': [{ edinetCode: 'E1', docTypeCode: '120', docID: 'A', submitDateTime: '2026-06-26 15:00', withdrawalStatus: '0' }],
    '2026-11-13': [{ edinetCode: 'E1', docTypeCode: '160', docID: 'H', submitDateTime: '2026-11-13 15:00', withdrawalStatus: '0' }],
    '2025-06-27': [{ edinetCode: 'E1', docTypeCode: '120', docID: 'OLD', submitDateTime: '2025-06-27 15:00', withdrawalStatus: '0' }],
  };
  const asked = [];
  const r = await findLatestFilings({
    edinetCode: 'E1',
    dates: candidateDates(new Date(2026, 10, 24), 400, '3月31日'),
    listForDate: async (d) => { asked.push(d); return lists[d] ?? []; },
  });
  assert.equal(r.annual.docID, 'A');
  assert.equal(r.half.docID, 'H');
  assert.ok(asked.length < 120, `scanned ${asked.length} days`);
});

test('helpers: args, html, IR links, TDnet tags, slug', () => {
  const a = parseArgs(['fetch', 'サンプルワークス', '--url', 'https://a/', '--url=https://b/', '--no-tdnet', '--days', '30']);
  assert.deepEqual(a._, ['fetch', 'サンプルワークス']);
  assert.deepEqual(a.url, ['https://a/', 'https://b/']);
  assert.equal(a.noTdnet, true);
  assert.equal(a.days, '30');
  const html = '<html><title>IR | 例</title><nav>menu</nav><script>x()</script><p>本文です</p><a href="/ir/plan.pdf">中期経営計画2027</a><a href="javascript:void(0)">決算説明</a></html>';
  assert.deepEqual(htmlToText(html), { title: 'IR | 例', text: 'IR | 例 本文です\n中期経営計画2027 決算説明' });
  assert.deepEqual(findIrLinks(html, 'https://ex.co.jp/ir/'), [{ label: '中期経営計画2027', url: 'https://ex.co.jp/ir/plan.pdf' }]);
  assert.deepEqual(tagTdnetTitle('中期経営計画の策定及び子会社化に関するお知らせ'), ['中期経営計画', 'M&A・提携']);
  assert.equal(slugify('株式会社 港物流'), '港物流');
  assert.equal(slugify('ABCロジスティクス/貿易'), 'ABCロジスティクス-貿易');
});

function fakeFetch(routes) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    for (const [re, handler] of routes) {
      if (re.test(url)) {
        const { status = 200, type = 'application/json', body } = handler(url);
        const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
        return {
          ok: status < 400, status,
          headers: { get: (h) => (h.toLowerCase() === 'content-type' ? type : null) },
          json: async () => JSON.parse(buf.toString('utf8')),
          arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
        };
      }
    }
    return { ok: false, status: 404, headers: { get: () => null }, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) };
  };
  fn.calls = calls;
  return fn;
}

test('end to end: unlisted target via --parent, EDINET + TDnet + page, files written', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ci-'));
  process.env.EDINET_API_KEY = 'test-key';
  const fetchImpl = fakeFetch([
    [/codelist\/Edinetcode\.zip/, () => ({ type: 'application/zip', body: codeZip })],
    [/documents\.json\?date=2026-03-27/, () => ({ body: { metadata: { status: '200' }, results: [
      { edinetCode: 'E04274', docTypeCode: '120', docID: 'S100TEST', submitDateTime: '2026-03-27 10:00', withdrawalStatus: '0',
        docDescription: '有価証券報告書－第39期(2025/01/01－2025/12/31)', periodStart: '2025-01-01', periodEnd: '2025-12-31' },
    ] } })],
    [/documents\.json/, () => ({ body: { metadata: { status: '200' }, results: [] } })],
    [/documents\/S100TEST\?type=5/, () => ({ type: 'application/octet-stream', body: yuhoZip })],
    [/yanoshin.*\/2384\.json/, () => ({ body: { items: [
      { Tdnet: { pubdate: '2026-11-10 15:00:00', title: '中期経営計画に関するお知らせ', document_url: 'https://example.com/a.pdf' } },
      { Tdnet: { pubdate: '2026-11-01 15:00:00', title: '定款の一部変更', document_url: 'https://example.com/b.pdf' } },
    ] } })],
    [/abc-logi\.example/, () => ({ type: 'text/html; charset=utf-8', body: '<title>会社概要</title><p>輸出入プロジェクト物流</p>' })],
  ]);
  const r = await runFetch(
    parseArgs(['ABCロジスティクス', '--parent', 'ABCホールディングス', '--url', 'https://abc-logi.example/about', '--days', '300']),
    { fetchImpl, root, robots: async () => ({ allowed: true }), now: new Date('2026-11-24T00:00:00Z'), edinetDelayMs: 0 },
  );
  assert.equal(r.slug, 'ABCロジスティクス');
  const intel = JSON.parse(readFileSync(join(r.outDir, 'intel.json'), 'utf8'));
  assert.equal(intel.relationship, 'parent');
  assert.equal(intel.company.edinetCode, 'E04274');
  assert.equal(intel.company.secCode, '2384');
  assert.equal(intel.edinet.annual.docID, 'S100TEST');
  assert.equal(intel.edinet.annual.financials.find((f) => f.offset === 0).netSales, 450000000000);
  assert.ok(existsSync(join(r.outDir, intel.edinet.annual.sections.policy.file)));
  assert.equal(intel.tdnet.items[0].tags[0], '中期経営計画');
  assert.equal(intel.pages[0].status, 'ok');
  assert.ok(fetchImpl.calls.every((u) => !/Subscription-Key/.test(u) || u.includes('test-key')));
  const md = readFileSync(join(r.outDir, 'summary.md'), 'utf8');
  assert.match(md, /親会社「ＡＢＣホールディングス株式会社」のデータ/);
  assert.match(md, /4,500億円/);
  assert.match(md, /785万円/);
  assert.match(md, /【中期経営計画】/);
  assert.doesNotMatch(md, /定款の一部変更/, 'untagged items hidden when tagged ones exist');
  // Second run reuses cached daily lists (only today/yesterday are re-fetched).
  const before = fetchImpl.calls.filter((u) => /documents\.json/.test(u)).length;
  await runFetch(parseArgs(['ABCホールディングス', '--no-tdnet', '--days', '300']), { fetchImpl, root, now: new Date('2026-11-24T00:00:00Z'), edinetDelayMs: 0 });
  const after = fetchImpl.calls.filter((u) => /documents\.json/.test(u)).length - before;
  assert.ok(after < 5, `second run fetched ${after} lists`);
});

test('missing API key and unknown company degrade to warnings, not crashes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ci-'));
  delete process.env.EDINET_API_KEY;
  const fetchImpl = fakeFetch([[/codelist/, () => ({ type: 'application/zip', body: codeZip })]]);
  const r1 = await runFetch(parseArgs(['ブルーシッピング', '--no-tdnet']), { fetchImpl, root });
  assert.equal(r1.intel.company.edinetCode, 'E77777');
  assert.ok(r1.intel.warnings.some((w) => /EDINET_API_KEY/.test(w)));
  const r2 = await runFetch(parseArgs(['株式会社港物流']), { fetchImpl, root });
  assert.ok(r2.intel.warnings.some((w) => /見つかりません/.test(w)));
  assert.ok(r2.intel.warnings.some((w) => /非上場/.test(w)));
  assert.equal(r2.slug, '港物流');
});
