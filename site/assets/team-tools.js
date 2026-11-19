let exceptionOffset = 0;
let exceptionVersion = 0;
let csvVersion = 0;
let preparedBatch = null;

function teamTool(op, payload, signedIn = true) {
  return rpc('gf_team_tools', { op, payload }, signedIn);
}

function resetTeamTools() {
  exceptionVersion++;
  csvVersion++;
  preparedBatch = null;
  exceptionOffset = 0;
  $('exception-queue').open = false;
  $('shipment-import').open = false;
  $('shipment-import').hidden = true;
  $('shipment-import-form').reset();
  $('shipment-import-submit').disabled = true;
  $('exception-list').replaceChildren();
  $('shipment-import-preview').replaceChildren();
  $('more-exceptions').hidden = true;
  message($('exceptions-message'));
  message($('shipment-import-message'));
}

function exceptionRecord(record) {
  const panel = el('details', undefined, 'record');
  const title = el('summary', record.origin + ' to ' + record.destination + ' ');
  title.append(statusBadge(record.status));
  panel.append(title, el('p', record.reason + ' | Latest status: ' + record.latest_status),
    el('p', record.tracking_code + ' | Updated ' + dateTime.format(new Date(record.posted_at)), 'muted'));
  const fields = [
    field('Follow-up status', 'status', { choices: ['Open', 'In review', 'Handled'], value: record.status }),
    field('Internal note', 'note', { multiline: true, max: 1000, value: record.note })
  ];
  if (isAdmin) {
    panel.append(el('p', 'Assign a staff account that already has shipment access, or leave the staff email blank to keep it in the admin queue.', 'muted'));
    fields.push(field('Staff email (optional)', 'email', { type: 'email', max: 254, value: record.assigned_email || '' }));
  }
  panel.append(makeActionForm($('exceptions-message'), async (values) => {
    const active = session;
    await teamTool('exception-save', {
      id: record.id, event_id: record.event_id, expected_update: record.updated_at,
      status: values.get('status'), note: values.get('note'), email: values.get('email')
    });
    if (active !== session) return;
    await loadExceptions(false, record.id);
    message($('exceptions-message'), 'Follow-up saved.');
  }, 'Save follow-up', ...fields));
  return panel;
}

async function loadExceptions(append = false, reopen = null) {
  const version = ++exceptionVersion;
  const offset = append ? exceptionOffset : 0;
  const rows = await teamTool('exception-list', { offset });
  if (version !== exceptionVersion) return;
  const list = $('exception-list');
  if (!append) list.replaceChildren();
  if (!rows.length && !offset) list.append(el('p', isAdmin ? 'No shipment exceptions to review.' : 'No exceptions are assigned to you.', 'muted'));
  for (const record of rows.slice(0, 20)) {
    const panel = exceptionRecord(record);
    panel.open = reopen === record.id;
    list.append(panel);
  }
  exceptionOffset = offset + 20;
  $('more-exceptions').hidden = rows.length <= 20;
}

$('exception-queue').addEventListener('toggle', () => {
  if ($('exception-queue').open && session) run($('refresh-exceptions'), () => loadExceptions(), $('exceptions-message'));
});
$('refresh-exceptions').onclick = (event) => run(event.currentTarget, () => loadExceptions(), $('exceptions-message'));
$('more-exceptions').onclick = (event) => run(event.currentTarget, () => loadExceptions(true), $('exceptions-message'));

function parseShipmentCsv(text) {
  const rows = [];
  let row = [];
  let value = '';
  let state = 'start';
  const input = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  for (let i = 0; i <= input.length; i++) {
    const char = i === input.length ? '\n' : input[i];
    if (state === 'quoted') {
      if (char === '"' && input[i + 1] === '"') {
        value += '"';
        i++;
      } else if (char === '"') {
        state = 'closed';
      } else {
        value += char;
      }
      continue;
    }
    if (char === '\n' || char === ',') {
      row.push(value.trim());
      value = '';
      state = 'start';
      if (char === '\n') {
        if (row.some(Boolean)) rows.push(row);
        row = [];
      }
      continue;
    }
    if (char === '"' && state === 'start') {
      state = 'quoted';
      continue;
    }
    if (char === '"' || state === 'closed') throw new Error('Check the CSV quotation marks.');
    value += char;
    state = 'plain';
  }
  if (state === 'quoted') throw new Error('A quoted CSV field is missing its closing quote.');
  const headers = rows.shift()?.map(header => header.toLowerCase()) || [];
  const required = ['origin', 'destination', 'service'];
  const allowed = [...required, 'eta', 'internal_reference'];
  if (!required.every(name => headers.includes(name)) || !headers.every(name => allowed.includes(name)) ||
      new Set(headers).size !== headers.length || rows.length < 1 || rows.length > 100) {
    throw new Error('Use the template headers and include 1 to 100 shipment rows.');
  }
  return rows.map((values, index) => {
    const record = Object.fromEntries(headers.map((header, column) => [header, values[column] || '']));
    const eta = record.eta ? new Date(record.eta + 'T00:00:00Z') : null;
    const invalidEta = eta && (!/^\d{4}-\d{2}-\d{2}$/.test(record.eta) || !Number.isFinite(+eta) ||
      eta.toISOString().slice(0, 10) !== record.eta);
    if (values.length !== headers.length || !record.origin || !record.destination || record.origin.length > 100 ||
        record.destination.length > 100 || !services.includes(record.service) ||
        (record.internal_reference?.length || 0) > 150 || invalidEta) {
      throw new Error('Shipment row ' + (index + 1) + ' has invalid fields. Check the template and use YYYY-MM-DD for the ETA.');
    }
    return record;
  });
}

function renderImportPreview(rows) {
  const wrapper = el('div', undefined, 'csv-preview');
  wrapper.tabIndex = 0;
  wrapper.setAttribute('aria-label', 'CSV preview');
  const table = el('table');
  const headers = el('tr');
  for (const label of ['Origin','Destination','Service','Est. delivery','Internal reference']) {
    const th = el('th', label);
    th.scope = 'col';
    headers.append(th);
  }
  const head = el('thead');
  const body = el('tbody');
  head.append(headers);
  for (const record of rows) {
    const row = el('tr');
    for (const value of [record.origin,record.destination,record.service,record.eta,record.internal_reference]) row.append(el('td', value || '-'));
    body.append(row);
  }
  table.append(head, body);
  wrapper.append(table);
  $('shipment-import-preview').replaceChildren(el('p', rows.length + ' shipments ready for review.'), wrapper);
}

$('shipment-csv').addEventListener('change', async (event) => {
  const version = ++csvVersion;
  const file = event.currentTarget.files[0];
  const feedback = $('shipment-import-message');
  preparedBatch = null;
  $('shipment-import-submit').disabled = true;
  $('shipment-import-preview').replaceChildren();
  message(feedback);
  if (!file || !isAdmin) return;
  try {
    if (file.size > 150000) throw new Error('Choose a CSV under 150 KB.');
    const rows = parseShipmentCsv(await file.text());
    if (version !== csvVersion || !isAdmin) return;
    preparedBatch = { request_id: crypto.randomUUID(), rows };
    renderImportPreview(rows);
    $('shipment-import-submit').disabled = false;
  } catch (error) {
    if (version === csvVersion) message(feedback, error.message, true);
  }
});

$('shipment-import-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!isAdmin || !preparedBatch) return;
  const batch = preparedBatch;
  const active = session;
  const control = $('shipment-import-submit');
  const input = $('shipment-csv');
  input.disabled = true;
  await run(control, async () => {
    const count = await teamTool('import', batch);
    if (session !== active) return;
    preparedBatch = null;
    $('shipment-import-form').reset();
    $('shipment-import-preview').replaceChildren();
    message($('shipment-import-message'), count + ' shipments created.');
    await Promise.allSettled([loadList(), loadMetrics()]);
  }, $('shipment-import-message'));
  input.disabled = false;
  control.disabled = !preparedBatch;
});

async function showPrivateCaseStatus() {
  const fragment = location.hash;
  const token = fragment.slice('#case='.length);
  $('private-case-result').replaceChildren();
  if (!/^[0-9a-f]{64}$/.test(token)) throw new Error('This complaint status link is invalid.');
  const result = await teamTool('case-status', { token }, false);
  if (fragment !== location.hash) return;
  if (!result) throw new Error('This status link expired or was replaced. Contact support for a new link.');
  $('private-case-result').append(el('p', result.reference, 'muted'), statusBadge(result.status),
    el('p', 'Received ' + dateTime.format(new Date(result.received_at))));
}

function loadPrivateCase() {
  if (location.hash.startsWith('#case=')) {
    run($('refresh-private-case'), showPrivateCaseStatus, $('private-case-message'));
  }
}
$('refresh-private-case').onclick = loadPrivateCase;
window.addEventListener('hashchange', loadPrivateCase);
loadPrivateCase();

async function printShipmentLabel(shipment, url) {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Open the hosted site before printing a label with a public tracking link.');
  }
  const qr = qrcode(0, 'M');
  qr.addData(url.href);
  qr.make();
  const mark = el('img');
  mark.src = 'assets/globe-mark.svg?v=2';
  mark.alt = '';
  const brand = el('p', undefined, 'label-brand');
  brand.append(mark, 'GlobeFreight Express');
  const info = el('section', undefined, 'label-core');
  info.append(el('p', 'FROM ' + shipment.origin), el('h2', 'TO ' + shipment.destination),
    el('p', shipment.service), el('code', shipment.tracking_code));
  const code = el('img', undefined, 'label-qr');
  code.src = qr.createDataURL(5, 20);
  code.alt = 'QR code for public shipment tracking';
  const contents = $('print-label');
  contents.replaceChildren(brand, el('p', 'SHIPMENT LABEL', 'label-kicker'), info, code,
    el('p', 'Scan for shipment tracking', 'label-scan'));
  await Promise.allSettled([mark.decode(), code.decode()]);
  document.body.classList.add('printing-label');
  function restorePage() {
    document.body.classList.remove('printing-label');
    contents.replaceChildren();
  }
  window.addEventListener('afterprint', restorePage, { once: true });
  try {
    window.print();
  } catch (error) {
    window.removeEventListener('afterprint', restorePage);
    restorePage();
    throw error;
  }
}
