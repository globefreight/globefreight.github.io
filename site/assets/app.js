const base = 'https://wqxbwpilkmwgagqbdxud.supabase.co';
const key = 'sb_publishable_7Es7tNh436PTggmxTmE4hQ_I-SMO_RP';
const services = ['Express', 'Air Freight', 'Ocean Freight', 'Road Freight'];
const statuses = ['Label created', 'Picked up', 'In transit', 'Customs clearance', 'Out for delivery', 'Delivered', 'Exception', 'Returned'];
const $ = (id) => document.getElementById(id);
const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZoneName: undefined });
const dateOnly = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: 'UTC' });
const pageSize = 30;
let session = null;
let isAdmin = false;
let loginMode = 'staff';
let currentShipment = null;
let detailVersion = 0;
let listVersion = 0;
let metricsVersion = 0;
let shipmentQuery = '';
let pageOffset = 0;
let trackingVersion = 0;
let trackTimer;

async function request(path, { method = 'GET', body, token, prefer } = {}) {
  const headers = { apikey: key, Accept: 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (prefer) headers.Prefer = prefer;
  let response;
  try {
    response = await fetch(base + path, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store', signal: AbortSignal.timeout(15000)
    });
  } catch {
    throw new Error('The shipping service is unavailable. Please try again.');
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 404 && path === '/functions/v1/create-staff') {
      throw new Error('Deploy the create-staff Edge Function in Supabase to enable account creation.');
    }
    if (data?.code === 'PGRST202' || data?.code === 'PGRST205') {
      throw new Error('The GlobeFreight database setup is incomplete.');
    }
    throw new Error(data?.message || data?.msg || data?.error_description || 'Request failed. Please try again.');
  }
  if (method === 'HEAD') {
    const count = response.headers.get('Content-Range')?.split('/').at(-1);
    if (!/^\d+$/.test(count || '')) throw new Error('The shipment count is unavailable.');
    return Number(count);
  }
  return data;
}

function staffRequest(path, options = {}) {
  if (!session || Date.now() >= session.expiresAt) {
    if (session) clearSession();
    throw new Error('Your session expired. Sign in again.');
  }
  return request('/rest/v1/' + path, { ...options, token: session.access_token });
}

function rpc(name, body, signedIn = true) {
  const options = { method: 'POST', body };
  return signedIn ? staffRequest('rpc/' + name, options) : request('/rest/v1/rpc/' + name, options);
}

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function button(text, action, className = 'secondary') {
  const node = el('button', text, className);
  node.type = 'button';
  node.addEventListener('click', () => run(node, action));
  return node;
}

function statusBadge(status) {
  const badge = el('span', status || 'Awaiting update', 'badge');
  if (status) badge.dataset.status = status;
  return badge;
}

function message(target, text = '', error = false) {
  target.textContent = text;
  target.className = 'status-message' + (error ? ' error' : '');
  target.hidden = !text;
}

async function run(control, action, target = $('portal-message')) {
  control.disabled = true;
  message(target);
  try {
    await action();
  } catch (error) {
    message(target, error.message, true);
  } finally {
    control.disabled = false;
  }
}

function bind(form, action, target) {
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    run(event.submitter || form.querySelector('[type=submit]'), () => action(new FormData(form)), target);
  });
}

function timeline(events) {
  if (!events.length) return el('p', 'No updates have been recorded.', 'muted');
  const list = el('ol', undefined, 'timeline');
  for (const event of events) {
    const item = el('li');
    const time = el('time', dateTime.format(new Date(event.posted_at)), 'muted');
    time.dateTime = event.posted_at;
    item.append(el('strong', event.status), el('p', event.location || 'Location unavailable'), time);
    if (event.note) item.append(el('p', event.note));
    list.append(item);
  }
  return list;
}

const sample = {
  tracking_code: 'PF-DEMO-001', origin: 'Lagos, NG', destination: 'Accra, GH', service: 'Road Freight',
  events: [
    { status: 'In transit', location: 'Lagos, NG', note: 'Shipment departed the origin facility.', posted_at: '2026-10-15T11:30:00Z' },
    { status: 'Picked up', location: 'Lagos, NG', posted_at: '2026-10-15T08:10:00Z' },
    { status: 'Label created', location: 'Lagos, NG', posted_at: '2026-10-14T15:05:00Z' }
  ]
};

function showTracking(data) {
  const result = $('tracking-result');
  const header = el('div', undefined, 'result-header');
  header.append(el('h2', data.tracking_code), statusBadge(data.events[0]?.status));
  result.replaceChildren(header, el('p', data.origin + ' to ' + data.destination + ' Â· ' + data.service, 'muted'));
  if (data === sample) result.append(el('p', 'Sample shipment with illustrative tracking updates.', 'muted'));
  if (data.eta) result.append(el('p', 'Estimated delivery ' + dateOnly.format(new Date(data.eta))));
  result.append(el('h3', 'Tracking history'), timeline(data.events));
  result.hidden = false;
}

async function track(code, version, background = false) {
  const data = code === sample.tracking_code ? sample : await rpc('pf_track', { code }, false);
  if (version !== trackingVersion) return;
  if (!data) {
    $('tracking-result').hidden = true;
    message($('track-message'), 'Shipment not found. Check the tracking number and try again.', true);
    return;
  }
  message($('track-message'));
  const result = $('tracking-result');
  const signature = JSON.stringify(data);
  if (!background || result.dataset.signature !== signature) {
    showTracking(data);
    result.dataset.signature = signature;
  }
  if (!background && data !== sample) {
    trackTimer = setInterval(() => {
      if (!document.hidden && location.hash !== '#portal') {
        track(code, version, true).catch(() => {
          if (version === trackingVersion) message($('track-message'), 'Updates are temporarily unavailable. Showing the last recorded information.', true);
        });
      }
    }, 30000);
  }
}

bind($('track-form'), async (values) => {
  clearInterval(trackTimer);
  $('tracking-result').hidden = true;
  const code = values.get('code').trim().toUpperCase();
  if (!code) throw new Error('Enter a tracking number.');
  await track(code, ++trackingVersion);
}, $('track-message'));

$('sample').addEventListener('click', () => {
  $('tracking-code').value = sample.tracking_code;
  $('track-form').requestSubmit();
});

function chooseMode(mode) {
  loginMode = mode;
  $('signin-title').textContent = mode === 'admin' ? 'Administrator sign-in' : 'Staff sign-in';
  $('admin-mode').setAttribute('aria-pressed', String(mode === 'admin'));
  $('staff-mode').setAttribute('aria-pressed', String(mode === 'staff'));
  message($('portal-message'));
}

$('admin-mode').onclick = () => chooseMode('admin');
$('staff-mode').onclick = () => chooseMode('staff');

function clearSession() {
  session = null;
  isAdmin = false;
  currentShipment = null;
  detailVersion++;
  listVersion++;
  metricsVersion++;
  shipmentQuery = '';
  $('shipment-search').reset();
  for (const id of ['metric-shipments', 'metric-updates', 'metric-deliveries']) $(id).textContent = '—';
  $('shipment-list').replaceChildren();
  $('shipment-detail').replaceChildren();
  $('identity').textContent = '';
  $('identity').hidden = true;
  $('portal-title').textContent = 'Team portal';
  $('new-shipment').hidden = true;
  $('staff-create').hidden = true;
  $('staff-create').open = false;
  $('create-staff-form').reset();
  message($('create-staff-message'));
  $('next-page').hidden = true;
  $('signin-card').hidden = false;
  $('workspace').hidden = true;
  $('logout').hidden = true;
}

bind($('signin-form'), async (values) => {
  const selectedMode = loginMode;
  const auth = await request('/auth/v1/token?grant_type=password', {
    method: 'POST',
    body: { email: values.get('email').trim(), password: values.get('password') }
  });
  const rights = await request('/rest/v1/rpc/pf_rights', { method: 'POST', body: {}, token: auth.access_token });
  if (rights.admin !== (selectedMode === 'admin')) {
    throw new Error(selectedMode === 'admin' ? 'This account does not have administrator access.' : 'Use Admin login for this account.');
  }
  session = { ...auth, expiresAt: Date.now() + (auth.expires_in - 10) * 1000 };
  isAdmin = rights.admin;
  $('signin-form').reset();
  $('identity').textContent = (isAdmin ? 'Administrator' : 'Staff') + ' Â· ' + auth.user.email;
  $('identity').hidden = false;
  $('portal-title').textContent = isAdmin ? 'Operations dashboard' : 'Shipment dashboard';
  $('metric-shipments-label').textContent = isAdmin ? 'Total shipments' : 'Assigned shipments';
  $('signin-card').hidden = true;
  $('workspace').hidden = false;
  $('logout').hidden = false;
  $('new-shipment').hidden = !isAdmin;
  $('staff-create').hidden = !isAdmin;
  showEmptyDetail();
  await Promise.all([loadList(), loadMetrics()]);
}, $('portal-message'));

bind($('create-staff-form'), async (values) => {
  if (!isAdmin || !session) throw new Error('Administrator access is required.');
  if (Date.now() >= session.expiresAt) {
    clearSession();
    message($('portal-message'), 'Your session expired. Sign in again.', true);
    return;
  }
  const activeSession = session;
  const email = values.get('email').trim().toLowerCase();
  const password = values.get('password');
  if (new TextEncoder().encode(password).length > 72) throw new Error('Use a password of at most 72 UTF-8 bytes.');
  await request('/functions/v1/create-staff', {
    method: 'POST', body: { email, password }, token: activeSession.access_token
  });
  if (session !== activeSession) return;
  $('create-staff-form').reset();
  message($('create-staff-message'), 'Staff login created for ' + email + '. You can now grant shipment access.');
}, $('create-staff-message'));

$('logout').onclick = async () => {
  const token = session?.access_token;
  clearSession();
  message($('portal-message'));
  if (token) {
    try {
      await request('/auth/v1/logout?scope=local', { method: 'POST', token });
    } catch {
      if (!session) message($('portal-message'), 'Signed out on this device. The server could not end the session.', true);
    }
  }
};

function route() {
  const portal = location.hash === '#portal';
  $('public-page').hidden = portal;
  $('portal-page').hidden = !portal;
  if (portal) window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);
route();

function showEmptyDetail() {
  const panel = el('div', undefined, 'detail-empty');
  panel.append(el('h2', 'No shipment selected'), el('p', 'Select a shipment to view its details and tracking history.', 'muted'));
  $('shipment-detail').replaceChildren(panel);
}

async function loadMetrics() {
  const version = ++metricsVersion;
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const today = 'pf_events?select=id&posted_at=gte.' + encodeURIComponent(midnight.toISOString());
  const counts = {
    'metric-shipments': 'pf_shipments?select=id',
    'metric-updates': today,
    'metric-deliveries': today + '&status=eq.Delivered'
  };
  await Promise.all(Object.entries(counts).map(async ([id, path]) => {
    try {
      const count = await staffRequest(path, { method: 'HEAD', prefer: 'count=exact' });
      if (version === metricsVersion) $(id).textContent = count.toLocaleString();
    } catch {
      if (version === metricsVersion) $(id).textContent = '—';
    }
  }));
}

async function loadList(append = false) {
  const version = ++listVersion;
  const offset = append ? pageOffset : 0;
  const filter = shipmentQuery ? '&tracking_code=eq.' + encodeURIComponent(shipmentQuery) : '';
  const rows = await staffRequest('pf_shipments?select=id,tracking_code,origin,destination&order=created_at.desc,id.desc&limit=' + (pageSize + 1) + '&offset=' + offset + filter);
  if (version !== listVersion) return;
  const list = $('shipment-list');
  if (!append) list.replaceChildren();
  if (!rows.length && !offset) {
    const empty = shipmentQuery ? 'No shipments match this tracking number.' : 'No shipments are available.';
    list.append(el('p', empty, 'muted'));
  }
  for (const shipment of rows.slice(0, pageSize)) {
    const item = button(shipment.origin + ' to ' + shipment.destination, () => openShipment(shipment.id), 'secondary shipment-button');
    item.dataset.shipment = shipment.id;
    item.setAttribute('aria-current', String(currentShipment === shipment.id));
    item.append(el('small', shipment.tracking_code));
    list.append(item);
  }
  pageOffset = offset + pageSize;
  $('next-page').hidden = rows.length <= pageSize;
}

function selectShipment(id) {
  currentShipment = id;
  for (const item of $('shipment-list').querySelectorAll('[data-shipment]')) {
    item.setAttribute('aria-current', String(item.dataset.shipment === id));
  }
}

function field(labelText, name, options = {}) {
  const label = el('label', labelText);
  const input = el(options.choices ? 'select' : options.multiline ? 'textarea' : 'input');
  input.name = name;
  if (options.choices) {
    for (const value of options.choices) input.append(new Option(value, value));
  } else if (!options.multiline) {
    input.type = options.type || 'text';
  }
  if (options.max) input.maxLength = options.max;
  if (options.required) input.required = true;
  if (options.value !== undefined) input.value = options.value ?? '';
  label.append(input);
  return label;
}

function makeForm(action, label, ...fields) {
  const form = el('form', undefined, 'fields');
  const actions = el('div');
  const submit = el('button', label);
  submit.type = 'submit';
  actions.append(submit);
  form.append(...fields, actions);
  bind(form, action, $('portal-message'));
  return form;
}

function shipmentForm(shipment) {
  const grid = el('div', undefined, 'field-grid');
  grid.append(
    field('Origin city / region', 'origin', { required: true, max: 100, value: shipment?.origin }),
    field('Destination city / region', 'destination', { required: true, max: 100, value: shipment?.destination }),
    field('Service', 'service', { choices: services, value: shipment?.service }),
    field('Estimated delivery', 'eta', { type: 'date', value: shipment?.eta })
  );
  return makeForm(async (values) => {
    const body = Object.fromEntries(values);
    body.origin = body.origin.trim();
    body.destination = body.destination.trim();
    body.eta = body.eta || null;
    const id = shipment?.id;
    const rows = await staffRequest('pf_shipments' + (id ? '?id=eq.' + id : ''), {
      method: id ? 'PATCH' : 'POST', body, prefer: 'return=representation'
    });
    if (!rows?.length) throw new Error('The shipment could not be saved. Refresh your permissions and try again.');
    if (!session || currentShipment !== (id || null)) return;
    if (!id) {
      shipmentQuery = '';
      $('shipment-search').reset();
    }
    await Promise.all([openShipment(rows[0].id), loadList(), loadMetrics()]);
    message($('portal-message'), id ? 'Shipment details saved.' : 'Shipment created.');
  }, shipment ? 'Save details' : 'Create shipment', grid,
  field('Internal reference', 'internal_reference', { max: 150, value: shipment?.internal_reference }));
}

function updatesForm(id) {
  return makeForm(async (values) => {
    await staffRequest('pf_events', { method: 'POST', body: { shipment_id: id, ...Object.fromEntries(values) } });
    if (currentShipment !== id) return;
    await Promise.all([openShipment(id), loadMetrics()]);
    message($('portal-message'), 'Tracking update published.');
  }, 'Publish update',
  field('Status', 'status', { choices: statuses, value: 'In transit' }),
  field('Public location', 'location', { max: 100 }),
  field('Public note', 'note', { multiline: true, max: 500 }));
}

function checkbox(text, name, checked) {
  const label = el('label');
  const input = el('input');
  input.type = 'checkbox';
  input.name = name;
  input.checked = checked;
  label.append(input, ' ' + text);
  return label;
}

async function setAccess(id, email, edit, post, revoke) {
  await rpc('pf_set_access', { shipment: id, staff_email: email, can_edit: edit, can_post: post, revoke_access: revoke });
  if (currentShipment !== id) return;
  await openShipment(id);
  message($('portal-message'), revoke ? 'Shipment access revoked.' : 'Shipment access saved.');
}

function accessSection(id, staff) {
  const section = el('section', undefined, 'detail-section');
  section.append(el('h3', 'Staff access'), el('p', 'Every assignment grants view access for this shipment. Choose any additional permissions below.', 'muted'));
  const checks = el('div', undefined, 'checks');
  checks.append(checkbox('Edit shipment details', 'edit', false), checkbox('Post tracking updates', 'post', false));
  const form = makeForm((values) => setAccess(id, values.get('email'), values.has('edit'), values.has('post'), false),
    'Save access', field('Staff account email', 'email', { type: 'email', required: true }), checks);
  section.append(form);
  for (const member of staff) {
    const row = el('div', undefined, 'record');
    const rights = ['View', ...(member.can_edit ? ['Edit details'] : []), ...(member.can_post ? ['Post updates'] : [])];
    const actions = el('div', undefined, 'actions');
    actions.append(
      button('Change access', () => {
        form.elements.email.value = member.email;
        form.elements.edit.checked = member.can_edit;
        form.elements.post.checked = member.can_post;
        form.elements.email.focus();
      }),
      button('Revoke access', () => setAccess(id, member.email, false, false, true), 'secondary danger')
    );
    row.append(el('strong', member.email), el('p', rights.join(' Â· '), 'muted'), actions);
    section.append(row);
  }
  return section;
}

async function allEvents(id, version) {
  const limit = 100;
  const events = [];
  for (let offset = 0; version === detailVersion; offset += limit) {
    const batch = await staffRequest('pf_events?select=status,location,note,posted_at&shipment_id=eq.' + id +
      '&order=posted_at.desc,id.desc&limit=' + limit + '&offset=' + offset);
    events.push(...batch);
    if (batch.length < limit) break;
  }
  return events;
}

async function openShipment(id) {
  const version = ++detailVersion;
  selectShipment(id);
  const detail = $('shipment-detail');
  detail.replaceChildren(el('p', 'Loading shipment...', 'muted'));
  try {
    const [rows, rights, events] = await Promise.all([
      staffRequest('pf_shipments?id=eq.' + id + '&select=*'),
      rpc('pf_rights', { shipment: id }),
      allEvents(id, version)
    ]);
    if (version !== detailVersion) return;
    const shipment = rows[0];
    if (!shipment) {
      selectShipment(null);
      detail.replaceChildren(el('p', 'This shipment is no longer available to you.', 'muted'));
      await loadList();
      return;
    }
    const staff = rights.admin ? await rpc('pf_shipment_staff', { shipment: id }) : [];
    if (version !== detailVersion) return;

    const header = el('div', undefined, 'section-header');
    header.append(el('h2', shipment.origin + ' to ' + shipment.destination), statusBadge(events[0]?.status));
    detail.replaceChildren(header, el('p', shipment.tracking_code, 'muted'));
    const link = new URL(location.href);
    link.hash = '';
    link.search = '';
    link.searchParams.set('tracking', shipment.tracking_code);
    const trackingLink = el('a', 'Open public tracking', 'text-button');
    trackingLink.href = link.href;
    trackingLink.target = '_blank';
    trackingLink.rel = 'noopener noreferrer';
    const trackingActions = el('div', undefined, 'tracking-actions');
    trackingActions.append(trackingLink);
    if (navigator.clipboard) {
      trackingActions.append(button('Copy tracking link', async () => {
        await navigator.clipboard.writeText(link.href);
        message($('portal-message'), 'Tracking link copied.');
      }));
    }
    detail.append(trackingActions);

    const facts = [shipment.service, shipment.eta && 'Estimated delivery ' + dateOnly.format(new Date(shipment.eta)),
      shipment.internal_reference && 'Internal reference ' + shipment.internal_reference].filter(Boolean);
    detail.append(el('p', facts.join(' Â· ')));
    if (rights.edit) {
      const section = el('section', undefined, 'detail-section');
      section.append(el('h3', 'Shipment details'), shipmentForm(shipment));
      detail.append(section);
    }
    if (rights.post) {
      const section = el('section', undefined, 'detail-section');
      section.append(el('h3', 'Post a tracking update'),
        el('p', 'Customers can see the location and note on the public tracking page.', 'muted'), updatesForm(id));
      detail.append(section);
    }
    const history = el('section', undefined, 'detail-section');
    history.append(el('h3', 'Tracking history'), timeline(events));
    detail.append(history);
    if (rights.admin) detail.append(accessSection(id, staff));
  } catch (error) {
    if (version !== detailVersion) return;
    detail.replaceChildren(el('p', 'Shipment details could not be loaded.', 'muted'),
      button('Retry', () => openShipment(id)));
    throw error;
  }
}

$('new-shipment').onclick = () => {
  if (!isAdmin) return;
  detailVersion++;
  selectShipment(null);
  message($('portal-message'));
  $('shipment-detail').replaceChildren(el('h2', 'New shipment'), shipmentForm());
};
$('refresh-workspace').onclick = (event) => run(event.currentTarget, async () => {
  await Promise.all([loadMetrics(), currentShipment ? openShipment(currentShipment) : Promise.resolve()]);
  await loadList();
});

bind($('shipment-search'), async (values) => {
  const query = values.get('query').trim().toUpperCase();
  if (query && !/^[A-Z0-9-]+$/.test(query)) throw new Error('Use letters, numbers, and hyphens in the tracking number.');
  shipmentQuery = query;
  detailVersion++;
  selectShipment(null);
  showEmptyDetail();
  await loadList();
}, $('portal-message'));
$('next-page').onclick = (event) => run(event.currentTarget, () => loadList(true));

const trackingParam = new URLSearchParams(location.search).get('tracking');
if (trackingParam && trackingParam.length <= 50) {
  $('tracking-code').value = trackingParam;
  $('track-form').requestSubmit();
}
