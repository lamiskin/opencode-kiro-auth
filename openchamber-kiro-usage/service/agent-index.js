// Normalize model name: lowercase, '.' -> '-', strip suffixes (-thinking, -272k, -1m)
const normModel = (model) => {
  if (!model) return '';
  let norm = model.toLowerCase().replace(/\./g, '-');
  norm = norm.replace(/-(thinking|272k|1m)$/i, '');
  return norm;
};

// Build index: Map<normModel, sorted rows {created, completed, agent, sessionID}>
const buildIndex = (rows) => {
  const index = new Map();

  for (const row of rows) {
    const model = normModel(row.model_id);
    if (!model) continue;

    if (!index.has(model)) {
      index.set(model, []);
    }

    index.get(model).push({
      created: row.time_created,
      completed: row.time_completed,
      agent: row.agent,
      sessionID: row.session_id
    });
  }

  // Sort each model's rows by created
  for (const rows of index.values()) {
    rows.sort((a, b) => a.created - b.created);
  }

  return index;
};

// Resolve agent for a log request: {t (timestamp in ms), model}
// Returns {agent, source: 'inferred'|'ambiguous'|'unknown', reason?, candidates?}
const resolve = (index, { t, model }) => {
  const norm = normModel(model);
  if (!norm) {
    return { agent: null, source: 'unknown', reason: 'no_candidate' };
  }

  const rows = index.get(norm);
  if (!rows || rows.length === 0) {
    return { agent: null, source: 'unknown', reason: 'no_candidate' };
  }

  // Binary search for created <= t+2000
  let left = 0, right = rows.length - 1;
  let insertPos = rows.length;
  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    if (rows[mid].created <= t + 2000) {
      insertPos = mid;
      left = mid + 1;
    } else {
      right = mid - 1;
    }
  }

  // Scan back at most 60 rows
  const start = Math.max(0, insertPos - 59);
  const candidates = new Set();

  for (let i = start; i <= insertPos; i++) {
    const row = rows[i];
    const rowEnd = row.completed ?? (row.created + 120000);
    // Match: created-2000 <= t <= rowEnd+2000
    if (row.created - 2000 <= t && t <= rowEnd + 2000) {
      if (row.agent) {
        candidates.add(row.agent);
      }
    }
  }

  if (candidates.size === 0) {
    return { agent: null, source: 'unknown', reason: 'no_candidate' };
  }

  if (candidates.size === 1) {
    return { agent: Array.from(candidates)[0], source: 'inferred' };
  }

  return {
    agent: null,
    source: 'ambiguous',
    candidates: Array.from(candidates)
  };
};

module.exports = { buildIndex, resolve, normModel };
