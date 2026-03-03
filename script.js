const fecFile = document.getElementById('fecFile');
const analyzeBtn = document.getElementById('analyzeBtn');
const targetPercentInput = document.getElementById('targetPercent');
const statusEl = document.getElementById('status');
const resultsEl = document.getElementById('results');

const clientsBody = document.getElementById('clientsBody');
const suppliersBody = document.getElementById('suppliersBody');
const clientsSummary = document.getElementById('clientsSummary');
const suppliersSummary = document.getElementById('suppliersSummary');

let fecRows = [];

fecFile.addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (!file) {
    analyzeBtn.disabled = true;
    return;
  }

  setStatus('Lecture du fichier en cours...');
  const text = await file.text();
  fecRows = parseFecText(text);
  analyzeBtn.disabled = fecRows.length === 0;
  setStatus(`Fichier chargé (${fecRows.length} lignes exploitables).`, true);
});

analyzeBtn.addEventListener('click', () => {
  if (!fecRows.length) return;

  const percent = Number(targetPercentInput.value);
  if (!Number.isFinite(percent) || percent <= 0 || percent > 100) {
    setStatus('Le pourcentage doit être compris entre 1 et 100.');
    return;
  }

  const { clients, suppliers } = aggregateTiers(fecRows);
  const selectedClients = selectTopByPercent(clients, percent);
  const selectedSuppliers = selectTopByPercent(suppliers, percent);

  renderTable({
    body: clientsBody,
    items: clients,
    selectedSet: new Set(selectedClients.map((x) => x.compte)),
    movementLabel: 'debitMovements',
    balanceLabel: 'debitBalance',
  });

  renderTable({
    body: suppliersBody,
    items: suppliers,
    selectedSet: new Set(selectedSuppliers.map((x) => x.compte)),
    movementLabel: 'creditMovements',
    balanceLabel: 'creditBalance',
  });

  clientsSummary.textContent = buildSummary(clients, selectedClients, 'debitBalance');
  suppliersSummary.textContent = buildSummary(suppliers, selectedSuppliers, 'creditBalance');

  resultsEl.hidden = false;
  setStatus('Analyse terminée.', true);
});

function setStatus(message, ok = false) {
  statusEl.textContent = message;
  statusEl.className = ok ? 'status ok' : 'status';
}

function parseFecText(text) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (!lines.length) return [];

  const sep = detectSeparator(lines[0]);
  const headers = splitRow(lines[0], sep);

  const index = {
    compteNum: findHeaderIndex(headers, ['CompteNum']),
    compteLib: findHeaderIndex(headers, ['CompteLib']),
    debit: findHeaderIndex(headers, ['Debit']),
    credit: findHeaderIndex(headers, ['Credit']),
  };

  if (Object.values(index).some((v) => v < 0)) {
    setStatus('Colonnes FEC introuvables (CompteNum, CompteLib, Debit, Credit).');
    return [];
  }

  return lines.slice(1).map((line) => {
    const cols = splitRow(line, sep);
    return {
      compteNum: (cols[index.compteNum] || '').trim(),
      compteLib: (cols[index.compteLib] || '').trim(),
      debit: parseAmount(cols[index.debit]),
      credit: parseAmount(cols[index.credit]),
    };
  });
}

function detectSeparator(headerLine) {
  const candidates = ['|', ';', '\t', ','];
  let best = '|';
  let bestCount = 0;

  for (const c of candidates) {
    const count = headerLine.split(c).length;
    if (count > bestCount) {
      best = c;
      bestCount = count;
    }
  }
  return best;
}

function splitRow(line, separator) {
  return line.split(separator).map((x) => x.replace(/^"|"$/g, '').trim());
}

function findHeaderIndex(headers, names) {
  return headers.findIndex((h) => names.includes(h));
}

function parseAmount(raw) {
  if (!raw) return 0;
  const normalized = String(raw).replace(/\s/g, '').replace(',', '.');
  const value = Number(normalized);
  return Number.isFinite(value) ? value : 0;
}

function aggregateTiers(rows) {
  const clientsMap = new Map();
  const suppliersMap = new Map();

  for (const row of rows) {
    const account = row.compteNum;
    if (!account) continue;

    if (account.startsWith('411')) {
      upsertTier(clientsMap, row, 'client');
    }

    if (account.startsWith('401')) {
      upsertTier(suppliersMap, row, 'supplier');
    }
  }

  return {
    clients: sortByScore([...clientsMap.values()]),
    suppliers: sortByScore([...suppliersMap.values()]),
  };
}

function upsertTier(map, row, type) {
  if (!map.has(row.compteNum)) {
    map.set(row.compteNum, {
      compte: row.compteNum,
      libelle: row.compteLib,
      debitMovements: 0,
      creditMovements: 0,
      debitBalance: 0,
      creditBalance: 0,
      score: 0,
    });
  }

  const item = map.get(row.compteNum);
  item.debitMovements += row.debit;
  item.creditMovements += row.credit;

  const net = item.debitMovements - item.creditMovements;
  item.debitBalance = Math.max(0, net);
  item.creditBalance = Math.max(0, -net);

  if (type === 'client') {
    item.score = item.debitMovements + item.debitBalance;
  } else {
    item.score = item.creditMovements + item.creditBalance;
  }
}

function sortByScore(items) {
  return items.sort((a, b) => b.score - a.score);
}

function selectTopByPercent(items, percent) {
  if (!items.length) return [];
  const count = Math.max(1, Math.ceil((items.length * percent) / 100));
  return items.slice(0, count);
}

function buildSummary(all, selected, balanceKey) {
  if (!all.length) return 'Aucun tiers trouvé.';

  const total = all.reduce((sum, x) => sum + x[balanceKey], 0);
  const selectedTotal = selected.reduce((sum, x) => sum + x[balanceKey], 0);
  const coverage = total ? (selectedTotal / total) * 100 : 0;

  return `${selected.length}/${all.length} tiers sélectionnés - Couverture du solde: ${formatNumber(
    coverage,
  )}% (${formatCurrency(selectedTotal)} / ${formatCurrency(total)}).`;
}

function renderTable({ body, items, selectedSet, movementLabel, balanceLabel }) {
  body.innerHTML = '';

  items.forEach((item) => {
    const tr = document.createElement('tr');
    const selected = selectedSet.has(item.compte);
    if (selected) tr.classList.add('selected');

    tr.innerHTML = `
      <td><input type="checkbox" ${selected ? 'checked' : ''} /></td>
      <td>${item.compte}</td>
      <td>${item.libelle || '-'}</td>
      <td>${formatCurrency(item[movementLabel])}</td>
      <td>${formatCurrency(item[balanceLabel])}</td>
      <td>${formatCurrency(item.score)}</td>
    `;

    body.appendChild(tr);
  });
}

function formatCurrency(value) {
  return new Intl.NumberFormat('fr-FR', {
    style: 'currency',
    currency: 'EUR',
    maximumFractionDigits: 2,
  }).format(value || 0);
}

function formatNumber(value) {
  return new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2 }).format(value || 0);
}
