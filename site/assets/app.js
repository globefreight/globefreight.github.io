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
let inboxVersion = 0;
let complaintOffset = 0;
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
      const setup = path.includes('gf_') ? 'Apply the latest GlobeFreight migrations in Supabase to enable this feature.' : 'The GlobeFreight database setup is incomplete.';
      throw new Error(setup);
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

function showTracking(data) {
  const result = $('tracking-result');
  const header = el('div', undefined, 'result-header');
  header.append(el('h2', data.tracking_code), statusBadge(data.events[0]?.status));
  result.replaceChildren(header, el('p', data.origin + ' to ' + data.destination + ' · ' + data.service, 'muted'));
  if (data.eta) result.append(el('p', 'Estimated delivery ' + dateOnly.format(new Date(data.eta))));
  result.append(el('h3', 'Tracking history'), timeline(data.events));
  result.hidden = false;
}

async function track(code, version, background = false) {
  const data = await rpc('pf_track', { code }, false);
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
  if (!background) {
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
  const version = ++trackingVersion;
  if (!code) throw new Error('Enter a tracking number.');
  await track(code, version);
}, $('track-message'));

bind($('complaint-form'), async (values) => {
  const body = Object.fromEntries(values);
  for (const name of Object.keys(body)) body[name] = body[name].trim();
  if (!body.customer || body.details.length < 10) throw new Error('Enter your name and at least 10 characters describing the issue.');
  const id = await rpc('gf_submit_complaint', body, false);
  if (!id) throw new Error('Could not confirm receipt. Please try again.');
  $('complaint-form').reset();
  message($('complaint-message'), 'Complaint received. Save your reference: ' + complaintReference(id));
}, $('complaint-message'));

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
  $('open-inbox').hidden = true;
  clearAdminOperations();
  closeComplaintInbox();
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
  $('identity').textContent = (isAdmin ? 'Administrator' : 'Staff') + ' · ' + auth.user.email;
  $('admin-operations').hidden = !isAdmin;
  $('identity').hidden = false;
  $('portal-title').textContent = isAdmin ? 'Operations dashboard' : 'Shipment dashboard';
  $('metric-shipments-label').textContent = isAdmin ? 'Total shipments' : 'Assigned shipments';
  $('signin-card').hidden = true;
  $('workspace').hidden = false;
  $('logout').hidden = false;
  $('open-inbox').hidden = false;
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
  const delivery = location.hash.startsWith('#delivery=');
  const wasOnPrivatePage = $('public-page').hidden;
  $('public-page').hidden = portal || delivery;
  $('portal-page').hidden = !portal;
  $('delivery-page').hidden = !delivery;
  if (delivery) message($('delivery-message'));
  if (portal || delivery || (wasOnPrivatePage && !location.hash)) window.scrollTo(0, 0);
  if (!portal && wasOnPrivatePage && !$('complaint-inbox').hidden) {
    closeComplaintInbox();
    $('open-inbox').hidden = !session;
  }
  if (!portal && !delivery && wasOnPrivatePage && location.hash) {
    $(location.hash.slice(1))?.scrollIntoView();
  }
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
  if (options.accept) input.accept = options.accept;
  if (options.max) input.maxLength = options.max;
  if (options.required) input.required = true;
  if (options.value !== undefined) input.value = options.value ?? '';
  label.append(input);
  return label;
}

function makeForm(action, label, ...fields) {
  return makeActionForm($('portal-message'), action, label, ...fields);
}

function makeActionForm(target, action, label, ...fields) {
  const form = el('form', undefined, 'fields');
  const actions = el('div');
  const submit = el('button', label);
  submit.type = 'submit';
  actions.append(submit);
  form.append(...fields, actions);
  bind(form, action, target);
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
    row.append(el('strong', member.email), el('p', rights.join(' · '), 'muted'), actions);
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
    detail.append(el('p', facts.join(' · ')));
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
    if (rights.admin) detail.append(recipientSection(id), accessSection(id, staff));
    if (rights.post && events[0]?.status === 'Delivered') detail.append(proofSection(id));
  } catch (error) {
    if (version !== detailVersion) return;
    detail.replaceChildren(el('p', 'Shipment details could not be loaded.', 'muted'),
      button('Retry', () => openShipment(id)));
    throw error;
  }
}

$('new-shipment').onclick = () => {
  if (!isAdmin) return;
  closeComplaintInbox();
  $('open-inbox').hidden = false;
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

const complaintsPerPage = 20;

function complaintReference(id) {
  return 'GF-' + id.toUpperCase();
}

function closeComplaintInbox() {
  inboxVersion++;
  complaintOffset = 0;
  $('complaint-inbox').hidden = true;
  $('shipment-workspace').hidden = false;
  $('new-shipment').hidden = !isAdmin;
  $('complaint-list').replaceChildren();
  $('more-complaints').hidden = true;
  message($('inbox-message'));
}

function complaintRecord(record) {
  const card = el('details', undefined, 'complaint-record');
  const summary = el('summary', record.category + ' ');
  summary.append(statusBadge(record.status));
  const customer = el('p', record.customer_name + ' | ' + record.customer_email);
  const reference = el('p', complaintReference(record.id), 'muted');
  const received = el('p', 'Received ' + dateTime.format(new Date(record.received_at)), 'muted');
  const tracking = el('p', 'Tracking number: ' + (record.tracking_code || 'Not provided'));
  const assignment = el('p', 'Assigned to: ' + (record.assigned_email || 'Admin queue'));
  const description = el('p', record.description, 'case-description');
  card.append(summary, reference, received, customer, tracking, assignment, description);
  const work = el('section', undefined, 'detail-section');
  work.append(el('h3', 'Handle complaint'));
  work.append(makeActionForm($('inbox-message'), async (values) => {
    const activeSession = session;
    const query = 'gf_complaints?id=eq.' + record.id + '&updated_at=eq.' + encodeURIComponent(record.updated_at);
    const updated = await staffRequest(query, {
      method: 'PATCH',
      body: { status: values.get('status'), internal_note: values.get('internal_note').trim() },
      prefer: 'return=representation'
    });
    if (!updated?.length) throw new Error('This complaint changed or your access was removed. Refresh the inbox.');
    if (session === activeSession && !$('complaint-inbox').hidden) {
      await loadComplaintInbox(false, record.id);
      message($('inbox-message'), 'Complaint saved.');
    }
  }, 'Save complaint',
  field('Status', 'status', { choices: ['Open', 'In review', 'Resolved'], value: record.status }),
  field('Internal note', 'internal_note', { multiline: true, max: 2000, value: record.internal_note })));
  card.append(work, complaintReplies(record));
  if (isAdmin) {
    const assign = el('section', undefined, 'detail-section');
    assign.append(el('h3', 'Assignment'), el('p', 'Enter a confirmed staff email or leave the field empty to handle the complaint in the admin queue.', 'muted'));
    assign.append(makeActionForm($('inbox-message'), async (values) => {
      const activeSession = session;
      const email = values.get('staff_email').trim();
      await rpc('gf_assign_complaint', { case_id: record.id, staff_email: email, expected_update: record.updated_at });
      if (session === activeSession && !$('complaint-inbox').hidden) {
        await loadComplaintInbox(false, record.id);
        message($('inbox-message'), email ? 'Complaint assigned.' : 'Complaint moved to the admin queue.');
      }
    }, 'Save assignment', field('Staff email', 'staff_email', { type: 'email', max: 254, value: record.assigned_email || '' })));
    card.append(assign);
  }
  return card;
}

async function loadComplaintInbox(append = false, reopenId = null) {
  const version = ++inboxVersion;
  const offset = append ? complaintOffset : 0;
  const limit = complaintsPerPage + 1;
  const rows = await staffRequest('gf_complaints?select=*&order=received_at.desc,id.desc&offset=' + offset + '&limit=' + limit);
  if (version !== inboxVersion || $('complaint-inbox').hidden) return;
  const list = $('complaint-list');
  if (!append) list.replaceChildren();
  if (!rows.length && !offset) list.append(el('p', isAdmin ? 'No complaints received yet.' : 'No complaints are assigned to you.', 'muted'));
  for (const record of rows.slice(0, complaintsPerPage)) {
    const card = complaintRecord(record);
    card.open = reopenId === record.id;
    list.append(card);
  }
  complaintOffset = offset + complaintsPerPage;
  $('more-complaints').hidden = rows.length <= complaintsPerPage;
}

$('open-inbox').onclick = (event) => run(event.currentTarget, async () => {
  $('shipment-workspace').hidden = true;
  $('complaint-inbox').hidden = false;
  $('inbox-scope').textContent = isAdmin ? 'Review customer complaints and manage assignments.' : 'Review complaints assigned to you.';
  $('open-inbox').hidden = true;
  message($('portal-message'));
  await loadComplaintInbox();
}, $('inbox-message'));

$('close-inbox').onclick = () => {
  closeComplaintInbox();
  $('open-inbox').hidden = false;
  $('open-inbox').focus();
};

$('refresh-inbox').onclick = (event) => run(event.currentTarget, () => loadComplaintInbox(), $('inbox-message'));
$('more-complaints').onclick = (event) => run(event.currentTarget, () => loadComplaintInbox(true), $('inbox-message'));

function operation(op, payload, signedIn = true) {
  return rpc('gf_operations', { op, payload }, signedIn);
}

function applyBusinessDetails() {
  const config = window.globeFreightDetails;
  if (!config) return;
  const contact = $('business-contact');
  for (const [label, value, scheme] of [
    ['Email', config.email, 'mailto:'], ['Phone', config.phone, 'tel:'], ['Hours', config.hours, '']
  ]) {
    if (!value?.trim()) continue;
    const line = el('p', label + ': ');
    if (scheme) {
      const link = el('a', value);
      link.href = scheme + (scheme === 'tel:' ? value.replace(/[^+\d]/g, '') : encodeURIComponent(value));
      line.append(link);
    } else {
      line.append(value);
    }
    contact.append(line);
    contact.hidden = false;
  }
  const locations = $('design-print');
  const cards = locations.querySelectorAll('.location-card');
  let verifiedAddresses = 0;
  config.locations?.slice(0, cards.length).forEach((place, index) => {
    const card = cards[index];
    if (place.city?.trim()) card.querySelector('h3').textContent = place.city;
    if (!place.address?.trim()) return;
    verifiedAddresses++;
    card.querySelector('address').textContent = place.address;
    for (const [label, value] of [['Hours', place.hours], ['Services', place.services]]) {
      if (value?.trim()) card.append(el('p', label + ': ' + value, 'muted'));
    }
  });
  if (verifiedAddresses === cards.length && cards.length) locations.querySelector('.section-intro').hidden = true;
  if (verifiedAddresses > 0 && verifiedAddresses < cards.length) {
    locations.querySelector('.section-intro').textContent = 'Full details are available for confirmed locations.';
  }
}
applyBusinessDetails();

bind($('quote-form'), async (values) => {
  const data = Object.fromEntries(values);
  const id = await operation('quote', data, false);
  if (!id) throw new Error('Could not confirm receipt. Please try again.');
  $('quote-form').reset();
  message($('quote-message'), 'Quote request received. Your reference is GFQ-' + id.toUpperCase() + '.');
}, $('quote-message'));

function recipientSection(id) {
  const section = el('details', undefined, 'detail-section');
  const content = el('div');
  const feedback = el('p');
  message(feedback);
  section.append(el('summary', 'Shipment email notifications'), content, feedback);
  section.addEventListener('toggle', async () => {
    if (!section.open || content.children.length) return;
    try {
      const email = await operation('recipient', { id });
      content.append(el('p', 'Enter the confirmed recipient email. This queues the tracking link and future updates. Clear the address to stop future notifications.', 'muted'));
      content.append(makeActionForm(feedback, async (values) => {
        const address = values.get('email').trim();
        await operation('set-recipient', { id, email: address });
        message(feedback, address ? 'Recipient saved and email queued if the address changed.' : 'Shipment email notifications disabled.');
      }, 'Save recipient', field('Recipient email', 'email', { type: 'email', max: 254, value: email || '' })));
    } catch (error) {
      message(feedback, error.message, true);
    }
  });
  return section;
}

function proofSection(id) {
  const section = el('section', undefined, 'detail-section');
  const feedback = el('p');
  message(feedback);
  section.append(el('h3', 'Proof of delivery'),
    el('p', 'Upload a PDF, PNG, or JPEG up to 2 MB. The recipient gets a private link valid for seven days. A replacement disables the previous link.', 'muted'));
  section.append(makeActionForm(feedback, async (values) => {
    const file = values.get('document');
    if (!file?.size || file.size > 2097152 || !['application/pdf','image/png','image/jpeg'].includes(file.type)) {
      throw new Error('Choose a PDF, PNG, or JPEG up to 2 MB.');
    }
    const view = new Uint8Array(await file.arrayBuffer());
    const chunks = [];
    for (let offset = 0; offset < view.length; offset += 8192) {
      chunks.push(String.fromCharCode(...view.subarray(offset, offset + 8192)));
    }
    await operation('proof', { id, mime: file.type, data: btoa(chunks.join('')) });
    section.querySelector('form').reset();
    message(feedback, 'Delivery document saved. Its private link is queued for email.');
  }, 'Upload and queue delivery link',
  field('Delivery document', 'document', { type: 'file', required: true, accept: 'application/pdf,image/png,image/jpeg' })));
  section.append(feedback);
  return section;
}

$('download-proof').onclick = (event) => run(event.currentTarget, async () => {
  const token = location.hash.slice('#delivery='.length);
  if (!/^[0-9a-f]{64}$/.test(token)) throw new Error('This delivery link is invalid.');
  const documentData = await operation('download', { token }, false);
  if (location.hash !== '#delivery=' + token) return;
  if (!documentData) throw new Error('This delivery link is expired or unavailable.');
  const extensions = { 'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg' };
  const extension = extensions[documentData.mime];
  if (!extension) throw new Error('The delivery document format is unavailable.');
  const bytes = Uint8Array.from(atob(documentData.data), char => char.charCodeAt(0));
  const objectUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
  const link = el('a');
  link.href = objectUrl;
  link.download = 'globefreight-proof-of-delivery.' + extension;
  link.click();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}, $('delivery-message'));

function complaintReplies(record) {
  const section = el('details', undefined, 'detail-section');
  const history = el('ol', undefined, 'reply-history');
  const feedback = el('p');
  message(feedback);
  async function loadReplies() {
    const rows = await staffRequest('gf_complaint_replies?case_id=eq.' + record.id + '&order=created_at.desc,id.desc&limit=30');
    history.replaceChildren();
    for (const reply of rows) {
      const item = el('li');
      item.append(el('strong', reply.delivery), el('p', reply.body));
      history.append(item);
    }
  }
  section.append(el('summary', 'Email customer and view recent replies'));
  section.append(makeActionForm(feedback, async (values) => {
    await operation('reply', { id: record.id, message: values.get('reply').trim() });
    section.querySelector('form').reset();
    message(feedback, 'Reply queued for email.');
    await loadReplies();
  }, 'Queue email reply', field('Reply to customer', 'reply', { multiline: true, required: true, max: 2000 })));
  section.append(feedback, button('Refresh reply history', loadReplies), history);
  section.addEventListener('toggle', () => {
    if (section.open) loadReplies().catch(error => message(feedback, error.message, true));
  });
  return section;
}

const adminQueues = [
  { panel: 'quote-queue', list: 'quote-list', refresh: 'refresh-quotes', more: 'more-quotes', feedback: 'quotes-status',
    table: 'gf_quotes', date: 'created_at', empty: 'No quote requests received.', render: quoteRequest },
  { panel: 'activity-log', list: 'activity-list', refresh: 'refresh-activity', more: 'more-activity', feedback: 'activity-status',
    table: 'gf_audit', date: 'created_at', empty: 'No activity recorded yet.', render: auditEntry }
];

function quoteRequest(record, queue) {
  const item = el('details', undefined, 'record');
  item.append(el('summary', record.origin + ' to ' + record.destination + ' | ' + record.status));
  item.append(el('p', 'GFQ-' + record.id.toUpperCase() + ' | ' + record.email, 'muted'));
  item.append(el('p', record.service + ' | ' + record.weight_kg + ' kg | ' +
    [record.length_cm, record.width_cm, record.height_cm].join(' × ') + ' cm'));
  item.append(makeActionForm($(queue.feedback), async (values) => {
    const active = session;
    const rows = await staffRequest('gf_quotes?id=eq.' + record.id +
      '&updated_at=eq.' + encodeURIComponent(record.updated_at), {
      method: 'PATCH', body: { status: values.get('status'), note: values.get('note').trim() }, prefer: 'return=representation'
    });
    if (!rows?.length) throw new Error('This quote changed. Refresh before saving.');
    if (session !== active) return;
    const replacement = quoteRequest(rows[0], queue);
    replacement.open = true;
    item.replaceWith(replacement);
    message($(queue.feedback), 'Quote request saved.');
  }, 'Save quote',
  field('Status', 'status', { choices: ['New', 'In review', 'Quoted', 'Closed'], value: record.status }),
  field('Internal note', 'note', { multiline: true, max: 2000, value: record.note })));
  return item;
}

function auditEntry(record) {
  const item = el('article', undefined, 'record');
  item.append(el('strong', record.action), el('p', (record.actor_email || 'System') + ' | ' +
    dateTime.format(new Date(record.created_at)), 'muted'), el('p', 'Record ' + record.record_id, 'muted'));
  return item;
}

async function loadAdminQueue(queue, append = false) {
  if (!isAdmin) return;
  const size = 20;
  const version = queue.version = (queue.version || 0) + 1;
  const offset = append ? queue.offset : 0;
  const rows = await staffRequest(queue.table + '?select=*&order=' + queue.date + '.desc,id.desc&offset=' + offset + '&limit=' + (size + 1));
  if (queue.version !== version || !isAdmin) return;
  const list = $(queue.list);
  if (!append) list.replaceChildren();
  if (!rows.length && !offset) list.append(el('p', queue.empty, 'muted'));
  for (const row of rows.slice(0, size)) list.append(queue.render(row, queue));
  queue.offset = offset + size;
  $(queue.more).hidden = rows.length <= size;
}

function clearAdminOperations() {
  $('admin-operations').hidden = true;
  for (const queue of adminQueues) {
    queue.version = (queue.version || 0) + 1;
    $(queue.panel).open = false;
    $(queue.list).replaceChildren();
    $(queue.more).hidden = true;
    message($(queue.feedback));
  }
}

for (const queue of adminQueues) {
  $(queue.panel).addEventListener('toggle', () => {
    if (!$(queue.panel).open) return;
    run($(queue.refresh), () => loadAdminQueue(queue), $(queue.feedback));
  });
  $(queue.refresh).onclick = (event) => run(event.currentTarget, () => loadAdminQueue(queue), $(queue.feedback));
  $(queue.more).onclick = (event) => run(event.currentTarget, () => loadAdminQueue(queue, true), $(queue.feedback));
}

const trackingParam = new URLSearchParams(location.search).get('tracking');
if (trackingParam && trackingParam.length <= 50) {
  $('tracking-code').value = trackingParam;
  $('track-form').requestSubmit();
}
