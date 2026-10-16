#!/usr/bin/env node
import fs from 'fs';
import path from 'path';

const logDir = process.env.KIRO_LOG_DIR || `${process.env.HOME}/.config/opencode/kiro-logs`;
const argv = process.argv.slice(2);

let modelFilter = null;
let sinceDate = null;
let limitCount = null;
let csvMode = false;

for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--model') modelFilter = argv[++i];
  if (argv[i] === '--since') sinceDate = new Date(argv[++i]);
  if (argv[i] === '--limit') limitCount = parseInt(argv[++i], 10);
  if (argv[i] === '--csv') csvMode = true;
}

// Parse ISO timestamp from filename: 2026-10-14T04-54-55-255Z -> comparable
const parseFileTs = (name) => {
  const match = name.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/);
  if (!match) return null;
  return new Date(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.${match[7]}Z`);
};

const readJsonSafe = (filePath) => {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
};

const estimateTokens = (req) => {
  if (req.sizes?.estInputTokens) return req.sizes.estInputTokens;
  return Math.ceil((req.sizes?.total || 0) / 4);
};

const extractSessionId = (req) => req.sessionID || req.conversationId || 'unknown';

// Read and pair request/response logs
console.error(`Reading logs from ${logDir}...`);
const files = fs.readdirSync(logDir).sort();
const pairs = new Map();

for (const file of files) {
  if (!file.endsWith('_request.json')) continue;
  const ts = parseFileTs(file);
  if (!ts || (sinceDate && ts < sinceDate)) continue;

  const baseName = file.replace('_request.json', '');
  const reqFile = path.join(logDir, `${baseName}_request.json`);
  const resFile = path.join(logDir, `${baseName}_response.json`);

  const req = readJsonSafe(reqFile);
  const res = readJsonSafe(resFile);
  if (!req || !res) continue;

  if (modelFilter && req.model && !req.model.includes(modelFilter)) continue;

  pairs.set(baseName, { ts, req, res });
  if (limitCount && pairs.size >= limitCount) break;
}

console.error(`Found ${pairs.size} paired log entries`);

// Classify responses
const classify = (res) => {
  if (res.status !== 400) return res.status === 200 ? 'success' : 'other';
  const err = (res.error || res.statusText || '').toLowerCase();
  return err.includes('too long') ? 'toolong' : 'other';
};

// Aggregate by model
const byModel = new Map();
const recentFailures = [];

for (const [, { ts, req, res }] of pairs) {
  const model = req.model || 'unknown';
  if (!byModel.has(model)) {
    byModel.set(model, { success: [], toolong: [], other: [] });
  }

  const class_ = classify(res);
  const histLen = req.body?.conversationState?.historyLength || 0;
  const totalSize = req.sizes?.total || 0;
  const toolCount = req.sizes?.toolCount || req.sizes?.tools || 0;
  const estTokens = estimateTokens(req);

  const record = {
    ts,
    histLen,
    totalSize,
    toolCount,
    estTokens,
    inputTokens: res.usage?.inputTokens,
    contextUsage: res.usage?.contextUsagePercentage,
    sessionId: extractSessionId(req),
    conversationId: req.conversationId,
    attempt: req.attempt,
  };

  byModel.get(model)[class_].push(record);

  if (class_ === 'toolong') {
    recentFailures.push({ ...record, model });
  }
}

// Compute stats
const stats = (arr) => {
  if (!arr.length) return null;
  const vals = arr.sort((a, b) => a - b);
  const len = vals.length;
  return {
    min: vals[0],
    median: vals[Math.floor(len / 2)],
    p90: vals[Math.floor(len * 0.9)],
    max: vals[len - 1],
  };
};

const modelStats = new Map();
for (const [model, classes] of byModel) {
  const all = [...classes.success, ...classes.toolong, ...classes.other];
  modelStats.set(model, {
    total: all.length,
    success: classes.success.length,
    toolong: classes.toolong.length,
    other: classes.other.length,
    histLen: stats(all.map((r) => r.histLen)),
    totalSize: stats(all.map((r) => r.totalSize)),
    toolCount: stats(all.map((r) => r.toolCount)),
    estTokens: stats(all.map((r) => r.estTokens)),
    succInputTokens: stats(classes.success.map((r) => r.inputTokens).filter(Boolean)),
    succContextUsage: stats(classes.success.map((r) => r.contextUsage).filter(Boolean)),
  });
}

// Print summary table
console.log('\n=== Per-Model Summary ===');
console.log('Model\tTotal\tSuccess\tToolong\tOther\tHistLen(med)\tTotalKB(med)\tTools(med)\tEstTok(med)\tInputTok(med)\tContext%(med)');
for (const [model, s] of modelStats) {
  const row = [
    model,
    s.total,
    s.success,
    s.toolong,
    s.other,
    s.histLen?.median || '-',
    ((s.totalSize?.median || 0) / 1024).toFixed(1),
    s.toolCount?.median || '-',
    s.estTokens?.median || '-',
    s.succInputTokens?.median || '-',
    s.succContextUsage?.median?.toFixed(1) || '-',
  ].join('\t');
  console.log(row);
}

// Recent toolong failures with preceding success context
console.log('\n=== 20 Most Recent Too-Long Failures ===');
const recent20 = recentFailures
  .sort((a, b) => b.ts - a.ts)
  .slice(0, 20);

const sessionContext = new Map();
for (const [, { ts, req, res }] of pairs) {
  const sid = extractSessionId(req);
  if (classify(res) === 'success') {
    if (!sessionContext.has(sid) || sessionContext.get(sid).ts < ts) {
      sessionContext.set(sid, {
        ts,
        histLen: req.body?.conversationState?.historyLength || 0,
        inputTokens: res.usage?.inputTokens,
      });
    }
  }
}

console.log('Timestamp\tModel\tSession\tHistLen\tTotalKB\tTools\tEstTok\tAttempt\tPrevSuccess(InputTok,HistLen)');
for (const r of recent20) {
  const prev = sessionContext.get(r.sessionId);
  const prevStr = prev ? `${prev.inputTokens || '-'},${prev.histLen}` : '-';
  console.log(
    `${r.ts.toISOString()}\t${r.model}\t${r.sessionId.slice(0, 8)}\t${r.histLen}\t${(r.totalSize / 1024).toFixed(1)}\t${r.toolCount}\t${r.estTokens}\t${r.attempt || '-'}\t${prevStr}`
  );
}

// Histogram of historyMessages in buckets of 20
console.log('\n=== HistoryMessages Histogram (buckets of 20) ===');
const allRecords = Array.from(byModel.values()).flatMap((c) => [
  ...c.success.map((r) => ({ ...r, class: 'success' })),
  ...c.toolong.map((r) => ({ ...r, class: 'toolong' })),
  ...c.other.map((r) => ({ ...r, class: 'other' })),
]);

const histBuckets = new Map();
for (const r of allRecords) {
  const bucket = Math.floor(r.histLen / 20) * 20;
  if (!histBuckets.has(bucket)) histBuckets.set(bucket, { success: 0, toolong: 0, other: 0 });
  histBuckets.get(bucket)[r.class]++;
}

console.log('HistLen Range\tSuccess\tToolong\tOther');
for (const bucket of Array.from(histBuckets.keys()).sort((a, b) => a - b)) {
  const b = histBuckets.get(bucket);
  console.log(`${bucket}-${bucket + 19}\t${b.success}\t${b.toolong}\t${b.other}`);
}

// Exact counts for 195-205 range
const exact195to205 = allRecords.filter((r) => r.histLen >= 195 && r.histLen <= 205);
console.log('\n=== Exact HistoryMessages 195-205 ===');
const countByHist = new Map();
for (const r of exact195to205) {
  if (!countByHist.has(r.histLen)) countByHist.set(r.histLen, { success: 0, toolong: 0, other: 0 });
  countByHist.get(r.histLen)[r.class]++;
}
for (const h of Array.from(countByHist.keys()).sort((a, b) => a - b)) {
  const c = countByHist.get(h);
  console.log(`${h}\t${c.success}\t${c.toolong}\t${c.other}`);
}
