// EDINET (金融庁 電子開示システム) helpers: code-list lookup, filing search,
// and extraction of interview-relevant facts from the XBRL→CSV archive of a
// 有価証券報告書.
//
// Everything that touches the network takes a `fetchImpl` so the parsing can
// be tested offline. Every string pulled out of a filing is external data —
// see AGENTS.md → "Untrusted External Content".

import { readZip } from './zip.mjs';

export const EDINET_API = 'https://api.edinet-fsa.go.jp/api/v2';
export const EDINET_CODELIST_URL =
  'https://disclosure2dl.edinet-fsa.go.jp/searchdocument/codelist/Edinetcode.zip';
export const edinetViewerUrl = (docID) =>
  `https://disclosure2.edinet-fsa.go.jp/WZEK0040.aspx?S1=${encodeURIComponent(docID)}`;

/** 書類種別コード we care about. */
export const DOC_TYPES = {
  '120': '有価証券報告書',
  '130': '訂正有価証券報告書',
  '160': '半期報告書',
  '140': '四半期報告書',
};

// ── Text utilities ─────────────────────────────────────────────────────────

/** Normalize a company name for matching: NFKC, drop legal-form words and spaces. */
export function normalizeCompanyName(s) {
  return String(s ?? '')
    .normalize('NFKC')
    .replace(/株式会社|\(株\)|有限会社|合同会社|ホールディングス|holdings?|co\.,?\s*ltd\.?|inc\.?|corporation|corp\.?/gi, (m) =>
      /ホールディングス|holdings?/i.test(m) ? 'HD' : '')
    .replace(/[\s・,.'"’]/g, '')
    .toLowerCase();
}

/** Parse one CSV/TSV line with RFC-4180 quoting. */
export function parseDelimitedLine(line, delim) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else q = false;
      } else cur += c;
    } else if (c === '"') q = true;
    else if (c === delim) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

/**
 * Split delimited text into rows, honouring quoted newlines (EDINET text
 * blocks contain line breaks inside quoted cells).
 */
export function parseDelimited(text, delim) {
  const rows = [];
  let cur = '';
  let quotes = 0;
  for (const line of text.split(/\r?\n/)) {
    cur = cur ? `${cur}\n${line}` : line;
    quotes += (line.match(/"/g) || []).length;
    if (quotes % 2 === 0) {
      if (cur.trim() !== '') rows.push(parseDelimitedLine(cur, delim));
      cur = '';
      quotes = 0;
    }
  }
  if (cur.trim() !== '') rows.push(parseDelimitedLine(cur, delim));
  return rows;
}

function decodeUtf16OrUtf8(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2));
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  // Heuristic: UTF-16LE without BOM has many NUL high bytes.
  let nul = 0;
  for (let i = 1; i < Math.min(buf.length, 400); i += 2) if (buf[i] === 0) nul++;
  return nul > 50 ? new TextDecoder('utf-16le').decode(buf) : buf.toString('utf8');
}

/** Strip any residual markup from a text block and tidy whitespace. */
export function cleanText(s) {
  return String(s ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/[ \t　]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── EDINET code list ───────────────────────────────────────────────────────

/**
 * Parse EdinetcodeDlInfo.csv (Shift_JIS, first line is a download banner,
 * second line is the header).
 * @param {Buffer} zipBuf  Edinetcode.zip
 */
export function parseCodeList(zipBuf) {
  const entry = readZip(zipBuf).find((e) => /\.csv$/i.test(e.name));
  if (!entry) throw new Error('EDINET code list: no CSV inside the zip');
  const text = new TextDecoder('shift_jis').decode(entry.data());
  const rows = parseDelimited(text, ',');
  const headerIdx = rows.findIndex((r) => r.some((c) => /ＥＤＩＮＥＴコード|EDINETコード/.test(c)));
  if (headerIdx < 0) throw new Error('EDINET code list: header row not found');
  const header = rows[headerIdx].map((h) => h.normalize('NFKC').trim());
  const col = (re) => header.findIndex((h) => re.test(h));
  const idx = {
    edinetCode: col(/^EDINETコード$/),
    type: col(/^提出者種別$/),
    listed: col(/^上場区分$/),
    consolidated: col(/^連結の有無$/),
    fiscalYearEnd: col(/^決算日$/),
    name: col(/^提出者名$/),
    nameEn: col(/^提出者名\(英字\)$/),
    nameKana: col(/^提出者名\(ヨミ\)$/),
    address: col(/^所在地$/),
    industry: col(/^提出者業種$/),
    secCode: col(/^証券コード$/),
    corporateNumber: col(/^提出者法人番号$/),
  };
  const out = [];
  for (const r of rows.slice(headerIdx + 1)) {
    const get = (k) => (idx[k] >= 0 ? (r[idx[k]] ?? '').trim() : '');
    if (!get('edinetCode')) continue;
    out.push({
      edinetCode: get('edinetCode'),
      type: get('type'),
      listed: get('listed'),
      consolidated: get('consolidated'),
      fiscalYearEnd: get('fiscalYearEnd'),
      name: get('name'),
      nameEn: get('nameEn'),
      nameKana: get('nameKana'),
      address: get('address'),
      industry: get('industry'),
      secCode: get('secCode'),
      corporateNumber: get('corporateNumber'),
    });
  }
  return out;
}

/**
 * Find a company in the code list.
 * @returns {{match: object|null, candidates: object[]}}
 */
export function findCompany(list, { name, secCode, edinetCode }) {
  if (edinetCode) {
    const m = list.find((c) => c.edinetCode === edinetCode.trim().toUpperCase());
    return { match: m ?? null, candidates: m ? [m] : [] };
  }
  if (secCode) {
    const code = String(secCode).normalize('NFKC').trim();
    const m = list.filter((c) => c.secCode && (c.secCode === code || c.secCode.slice(0, 4) === code.slice(0, 4)));
    return { match: m.length === 1 ? m[0] : null, candidates: m };
  }
  const q = normalizeCompanyName(name);
  if (!q) return { match: null, candidates: [] };
  // Only corporations that actually file (内国法人・組合 / 外国法人・組合), not funds.
  const pool = list.filter((c) => !/ファンド|投資信託/.test(c.type));
  const exact = pool.filter((c) => normalizeCompanyName(c.name) === q || normalizeCompanyName(c.nameEn) === q);
  if (exact.length === 1) return { match: exact[0], candidates: exact };
  if (exact.length > 1) {
    const listed = exact.filter((c) => c.listed === '上場');
    return { match: listed.length === 1 ? listed[0] : null, candidates: exact };
  }
  const partial = pool.filter((c) => normalizeCompanyName(c.name).includes(q) || q.includes(normalizeCompanyName(c.name)) && normalizeCompanyName(c.name).length >= 3);
  const listedRank = (c) => (c.listed === '上場' ? 0 : 1);
  partial.sort((a, b) => listedRank(a) - listedRank(b) || a.name.length - b.name.length);
  return { match: partial.length === 1 ? partial[0] : null, candidates: partial.slice(0, 15) };
}

// ── Filing search ──────────────────────────────────────────────────────────

const pad = (n) => String(n).padStart(2, '0');
export const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** "3月31日" → {month: 3, day: 31} */
export function parseFiscalYearEnd(s) {
  const m = /(\d{1,2})\s*月\s*(\d{1,2})\s*日/.exec(String(s ?? '').normalize('NFKC'));
  return m ? { month: Number(m[1]), day: Number(m[2]) } : null;
}

/**
 * Dates to scan, most likely first: the statutory filing window (fiscal-year
 * end + ~60–100 days) of the latest closed fiscal year, then of the one
 * before, then every remaining day backwards from today.
 */
export function candidateDates(today, days, fiscalYearEnd) {
  const seen = new Set();
  const out = [];
  const push = (d) => {
    const s = ymd(d);
    const age = (today - d) / 86400000;
    if (age < 0 || age > days || seen.has(s)) return;
    // EDINET has no filings on weekends.
    if (d.getDay() === 0 || d.getDay() === 6) return;
    seen.add(s);
    out.push(s);
  };
  const fy = parseFiscalYearEnd(fiscalYearEnd);
  if (fy) {
    for (let back = 0; back < 3; back++) {
      let end = new Date(today.getFullYear() - back, fy.month - 1, fy.day);
      if (end > today) end = new Date(end.getFullYear() - 1, fy.month - 1, fy.day);
      // Walk the window from late to early: most companies file in the last week.
      for (let off = 100; off >= 55; off--) push(new Date(end.getTime() + off * 86400000));
    }
    // Half-year report window (six months after the FY end + ~45 days).
    const half = new Date(today.getFullYear(), fy.month - 1 + 6, fy.day);
    for (const base of [half, new Date(half.getFullYear() - 1, half.getMonth(), half.getDate())]) {
      for (let off = 50; off >= 30; off--) push(new Date(base.getTime() + off * 86400000));
    }
  }
  for (let i = 0; i <= days; i++) push(new Date(today.getTime() - i * 86400000));
  return out;
}

/**
 * Search daily document lists for the newest 有報 (and a newer 半期報告書 if
 * one exists) of one EDINET code.
 *
 * @param {object} o
 * @param {string} o.edinetCode
 * @param {string[]} o.dates            from candidateDates()
 * @param {(date: string) => Promise<object[]>} o.listForDate
 * @param {(msg: string) => void} [o.log]
 */
export async function findLatestFilings({ edinetCode, dates, listForDate, log = () => {}, extraAfterAnnual = 45 }) {
  let annual = null;
  let half = null;
  let scanned = 0;
  let extra = 0;
  for (const date of dates) {
    // Once the annual report is known, only newer days can still matter (a
    // later 半期報告書, or a newer 有報 filed outside the usual window).
    if (annual) {
      if (date <= annual.submitDateTime.slice(0, 10)) continue;
      if (half || extra++ >= extraAfterAnnual) break;
    }
    const results = await listForDate(date);
    scanned++;
    for (const r of results) {
      if (r.edinetCode !== edinetCode) continue;
      if (r.withdrawalStatus && r.withdrawalStatus !== '0') continue;
      if (r.docTypeCode === '120' && (!annual || r.submitDateTime > annual.submitDateTime)) annual = r;
      if (r.docTypeCode === '160' && (!half || r.submitDateTime > half.submitDateTime)) half = r;
    }
    if (scanned % 25 === 0) log(`  …${scanned} 日分を確認`);
  }
  if (half && annual && half.submitDateTime < annual.submitDateTime) half = null;
  return { annual, half, scanned };
}

// ── XBRL→CSV extraction ────────────────────────────────────────────────────

const FIN_ELEMENTS = {
  netSales: [
    /^jpcrp_cor:NetSalesSummaryOfBusinessResults$/,
    /^jpcrp_cor:RevenueIFRSSummaryOfBusinessResults$/,
    /^jpcrp_cor:RevenuesUSGAAPSummaryOfBusinessResults$/,
    /^jpcrp_cor:OperatingRevenue\d?SummaryOfBusinessResults$/,
    /^jpcrp_cor:NetSalesOfCompletedConstructionContractsSummaryOfBusinessResults$/,
  ],
  operatingIncome: [
    /^jpcrp_cor:OperatingProfitLossIFRSSummaryOfBusinessResults$/,
    /^jpcrp_cor:OperatingIncomeLossSummaryOfBusinessResults$/,
  ],
  ordinaryIncome: [/^jpcrp_cor:OrdinaryIncomeLossSummaryOfBusinessResults$/],
  netIncome: [
    /^jpcrp_cor:ProfitLossAttributableToOwnersOfParentSummaryOfBusinessResults$/,
    /^jpcrp_cor:ProfitLossAttributableToOwnersOfParentIFRSSummaryOfBusinessResults$/,
    /^jpcrp_cor:NetIncomeLossSummaryOfBusinessResults$/,
  ],
  employees: [/^jpcrp_cor:NumberOfEmployees$/],
};

// The P/L carries 営業利益 for J-GAAP filers, whose summary table often omits it.
const PL_OPERATING_INCOME = /^jppfs_cor:OperatingIncome$/;

const EMPLOYEE_ELEMENTS = {
  avgAge: /^jpcrp_cor:AverageAgeYearsInformationAboutReportingCompanyInformationAboutEmployees$/,
  avgTenure: /^jpcrp_cor:AverageLengthOfServiceYearsInformationAboutReportingCompanyInformationAboutEmployees$/,
  avgSalary: /^jpcrp_cor:AverageAnnualSalaryInformationAboutReportingCompanyInformationAboutEmployees$/,
};

/** Interview-relevant text blocks: element-ID pattern, then item-name fallback. */
export const SECTIONS = [
  { key: 'business', label: '事業の内容', id: /DescriptionOfBusinessTextBlock$/, name: /^事業の内容/ },
  { key: 'policy', label: '経営方針、経営環境及び対処すべき課題等', id: /BusinessPolicyBusinessEnvironmentIssuesToAddressEtcTextBlock$/, name: /経営方針/ },
  { key: 'sustainability', label: 'サステナビリティに関する考え方及び取組', id: /Sustainability.*TextBlock$/, name: /サステナビリティ/ },
  { key: 'risks', label: '事業等のリスク', id: /BusinessRisksTextBlock$/, name: /事業等のリスク/ },
  { key: 'mdna', label: '経営者による財政状態、経営成績及びキャッシュ・フローの状況の分析', id: /ManagementAnalysisOfFinancialPositionOperatingResultsAndCashFlowsTextBlock$/, name: /経営者による.*分析/ },
  { key: 'employees', label: '従業員の状況', id: /InformationAboutEmployeesTextBlock$/, name: /^従業員の状況/ },
  { key: 'affiliates', label: '関係会社の状況', id: /OverviewOfAffiliatedEntitiesTextBlock$/, name: /^関係会社の状況/ },
  { key: 'history', label: '沿革', id: /CompanyHistoryTextBlock$/, name: /^沿革/ },
  { key: 'rnd', label: '研究開発活動', id: /ResearchAndDevelopmentActivitiesTextBlock$/, name: /^研究開発活動/ },
];

function toNumber(v) {
  const s = String(v ?? '').normalize('NFKC').replace(/,/g, '').trim();
  if (!s || s === '-' || s === '－') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** "Prior2YearDuration_NonConsolidatedMember" → {offset: 2, nonConsolidated: true} */
function parseContext(ctx) {
  const m = /^(CurrentYear|Prior(\d)Year)(Duration|Instant)(.*)$/.exec(ctx);
  if (!m) return null;
  const rest = m[4] || '';
  // Only the plain consolidated / non-consolidated contexts — skip segment
  // and other member contexts (e.g. per-business employee counts).
  const nonConsolidated = /^_NonConsolidatedMember$/.test(rest);
  if (rest && !nonConsolidated) return null;
  return { offset: m[2] ? Number(m[2]) : 0, nonConsolidated };
}

/**
 * Pick the main CSV of an XBRL→CSV archive and parse it into rows.
 * @param {Buffer} zipBuf  documents/{docID}?type=5 response body
 */
export function readXbrlCsv(zipBuf) {
  const entries = readZip(zipBuf).filter((e) => /XBRL_TO_CSV\/.*\.csv$/i.test(e.name) || /\.csv$/i.test(e.name));
  if (entries.length === 0) throw new Error('XBRL→CSV archive contains no CSV');
  // jpcrp* is the main body of the report; audit reports (jpaud*) are skipped.
  const main = entries.filter((e) => /jpcrp/i.test(e.name));
  const chosen = main.length ? main : entries.filter((e) => !/jpaud/i.test(e.name));
  const rows = [];
  for (const e of chosen) {
    const text = decodeUtf16OrUtf8(e.data());
    const parsed = parseDelimited(text, '\t');
    const header = parsed[0]?.map((h) => h.trim());
    const at = (name) => header.indexOf(name);
    const iId = at('要素ID'), iName = at('項目名'), iCtx = at('コンテキストID'), iVal = at('値'), iUnit = at('単位');
    if ([iId, iName, iCtx, iVal].some((i) => i < 0)) continue;
    for (const r of parsed.slice(1)) {
      rows.push({ id: r[iId] ?? '', name: r[iName] ?? '', ctx: r[iCtx] ?? '', unit: iUnit >= 0 ? r[iUnit] ?? '' : '', value: r[iVal] ?? '' });
    }
  }
  return rows;
}

/**
 * Extract the facts an interview brief needs from parsed XBRL rows.
 * @param {{id,name,ctx,unit,value}[]} rows
 * @param {{periodEnd?: string}} meta
 */
export function extractFacts(rows, meta = {}) {
  // financials[offset] = {consolidated: {...}, nonConsolidated: {...}}
  const fin = new Map();
  const slot = (offset, nc) => {
    if (!fin.has(offset)) fin.set(offset, { consolidated: {}, nonConsolidated: {} });
    return fin.get(offset)[nc ? 'nonConsolidated' : 'consolidated'];
  };
  const employeeFacts = {};
  const sections = {};

  for (const r of rows) {
    const ctx = parseContext(r.ctx);
    if (ctx) {
      for (const [key, pats] of Object.entries(FIN_ELEMENTS)) {
        const rank = pats.findIndex((p) => p.test(r.id));
        if (rank < 0) continue;
        const n = toNumber(r.value);
        if (n == null) continue;
        const s = slot(ctx.offset, ctx.nonConsolidated);
        if (s[key] == null || rank < s[`${key}__rank`]) { s[key] = n; s[`${key}__rank`] = rank; }
      }
      if (PL_OPERATING_INCOME.test(r.id) && ctx.offset <= 1) {
        const n = toNumber(r.value);
        const s = slot(ctx.offset, ctx.nonConsolidated);
        if (n != null && s.operatingIncome == null) { s.operatingIncome = n; s.operatingIncome__rank = 99; }
      }
      if (ctx.offset === 0) {
        for (const [key, pat] of Object.entries(EMPLOYEE_ELEMENTS)) {
          if (pat.test(r.id)) { const n = toNumber(r.value); if (n != null) employeeFacts[key] = n; }
        }
      }
    }
    if (/TextBlock$/.test(r.id) || /\[テキストブロック\]/.test(r.name)) {
      if (!/^FilingDateInstant|^CurrentYear/.test(r.ctx) && r.ctx) continue;
      for (const sec of SECTIONS) {
        if (sections[sec.key]) continue;
        if (sec.id.test(r.id) || sec.name.test(r.name.replace(/\s*\[テキストブロック\]\s*$/, ''))) {
          const text = cleanText(r.value);
          if (text && text !== '-') sections[sec.key] = { label: sec.label, text };
        }
      }
    }
  }

  // Prefer consolidated figures; fall back to non-consolidated per year.
  const fyEndYear = meta.periodEnd ? Number(meta.periodEnd.slice(0, 4)) : null;
  const fyEndMonth = meta.periodEnd ? Number(meta.periodEnd.slice(5, 7)) : null;
  const financials = [...fin.keys()].sort((a, b) => b - a).map((offset) => {
    const { consolidated: c, nonConsolidated: nc } = fin.get(offset);
    const useC = ['netSales', 'ordinaryIncome', 'netIncome', 'operatingIncome'].some((k) => c[k] != null);
    const src = useC ? c : nc;
    const clean = Object.fromEntries(Object.entries(src).filter(([k]) => !k.endsWith('__rank')));
    // Employee count: the consolidated figure when present.
    clean.employees = c.employees ?? nc.employees ?? null;
    return {
      offset,
      label: fyEndYear ? `${fyEndYear - offset}年${fyEndMonth}月期` : offset === 0 ? '当期' : `${offset}期前`,
      basis: useC ? '連結' : '単体',
      ...clean,
    };
  });

  const current = fin.get(0);
  return {
    financials,
    employees: {
      consolidated: current?.consolidated.employees ?? null,
      nonConsolidated: current?.nonConsolidated.employees ?? null,
      ...employeeFacts,
    },
    sections,
  };
}

// ── Network client ─────────────────────────────────────────────────────────

/**
 * @param {object} o
 * @param {string} o.apiKey
 * @param {typeof fetch} [o.fetchImpl]
 * @param {{get(date): object[]|null, set(date, results): void}} [o.listCache]
 * @param {number} [o.delayMs]
 */
export function createEdinetClient({ apiKey, fetchImpl = fetch, listCache, delayMs = 250, userAgent }) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const headers = userAgent ? { 'user-agent': userAgent } : {};
  let last = 0;
  async function throttled(url) {
    const wait = last + delayMs - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    const res = await fetchImpl(url, { headers });
    return res;
  }
  const withKey = (url) => `${url}${url.includes('?') ? '&' : '?'}Subscription-Key=${encodeURIComponent(apiKey)}`;

  return {
    async listForDate(date) {
      const cached = listCache?.get(date);
      if (cached) return cached;
      const res = await throttled(withKey(`${EDINET_API}/documents.json?date=${date}&type=2`));
      if (!res.ok) throw new Error(`EDINET 書類一覧 ${date}: HTTP ${res.status}`);
      const body = await res.json();
      const status = String(body?.metadata?.status ?? body?.StatusCode ?? '200');
      if (status !== '200') {
        const msg = body?.metadata?.message ?? body?.message ?? '';
        throw new Error(`EDINET 書類一覧 ${date}: status ${status} ${msg}`.trim());
      }
      const results = Array.isArray(body.results) ? body.results : [];
      listCache?.set(date, results);
      return results;
    },
    async downloadCsvZip(docID) {
      const res = await throttled(withKey(`${EDINET_API}/documents/${encodeURIComponent(docID)}?type=5`));
      if (!res.ok) throw new Error(`EDINET 書類取得 ${docID}: HTTP ${res.status}`);
      const type = res.headers.get('content-type') || '';
      const buf = Buffer.from(await res.arrayBuffer());
      if (/json/.test(type)) throw new Error(`EDINET 書類取得 ${docID}: ${buf.toString('utf8').slice(0, 200)}`);
      return buf;
    },
  };
}
