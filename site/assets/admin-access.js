let staffDirectoryVersion = 0;
let staffDetailsVersion = 0;
let staffDirectoryOffset = 0;
let staffDirectoryQuery = '';
let selectedStaff = null;
let verifyingTeamSession = false;

function staffAdminCall(op, payload = {}) {
  return rpc('gf_staff_admin', { op, payload });
}

function resetStaffDirectory() {
  staffDirectoryVersion++;
  staffDetailsVersion++;
  staffDirectoryOffset = 0;
  staffDirectoryQuery = '';
  selectedStaff = null;
  $('staff-directory-search').reset();
  $('customer-shipment-lookup').reset();
  $('staff-directory-list').replaceChildren();
  $('staff-selected').replaceChildren();
  $('staff-selected').hidden = true;
  $('more-staff').hidden = true;
  message($('staff-directory-message'));
  message($('customer-tools-message'));
}

async function verifyTeamSession() {
  const active = session;
  if (!active || isAdmin || verifyingTeamSession || document.hidden) return;
  verifyingTeamSession = true;
  try {
    const rights = await rpc('pf_rights', {});
    if (rights?.suspended === true && active === session) {
      clearSession();
      message($('portal-message'), 'Your GlobeFreight team access was suspended. Contact your administrator.', true);
    }
  } catch {
    // The database continues to enforce permissions if the refresh is unavailable.
  } finally {
    verifyingTeamSession = false;
  }
}
window.addEventListener('focus', verifyTeamSession);
window.setInterval?.(verifyTeamSession, 60000);

async function loadStaffDirectory(append = false) {
  if (!isAdmin) return;
  const version = ++staffDirectoryVersion;
  const offset = append ? staffDirectoryOffset : 0;
  const rows = await staffAdminCall('directory', { value: staffDirectoryQuery, offset });
  if (version !== staffDirectoryVersion || !isAdmin) return;
  const list = $('staff-directory-list');
  if (!append) list.replaceChildren();
  if (!rows.length && !offset) list.append(el('p', 'No matching confirmed staff accounts.', 'muted'));
  for (const record of rows.slice(0, 20)) {
    const item = button(record.email, () => openStaffRecord(record));
    item.dataset.staffId = record.id;
    item.setAttribute('aria-current', String(selectedStaff?.id === record.id));
    item.append(statusBadge(record.suspended ? 'Suspended' : 'Active'));
    item.append(el('span', record.shipments + ' shipments | ' + record.complaints + ' complaints', 'muted'));
    list.append(item);
  }
  staffDirectoryOffset = offset + 20;
  $('more-staff').hidden = rows.length <= 20;
}

function assignmentCheckbox(name, text, checked = false) {
  const label = el('label');
  const check = el('input');
  check.type = 'checkbox';
  check.name = name;
  check.checked = checked;
  label.append(check, ' ' + text);
  return label;
}

function shipmentPermissionForm(record, afterSave, target, grant) {
  const choices = el('div', undefined, 'staff-assignment-actions');
  choices.append(assignmentCheckbox('can_edit', 'Edit shipment details', grant?.can_edit),
    assignmentCheckbox('can_post', 'Post tracking updates', grant?.can_post));
  const fields = grant ? [choices] : [field('Tracking number', 'tracking', { required: true, max: 50 }), choices];
  return makeActionForm(target, async (values) => {
    await staffAdminCall('shipment-grant', { staff_id: record.id, value: grant?.tracking_code || values.get('tracking'),
      can_edit: values.has('can_edit'), can_post: values.has('can_post') });
    await afterSave('Shipment access saved.');
  }, grant ? 'Save permissions' : 'Assign shipment', ...fields);
}

async function openStaffRecord(record, shipmentOffset = 0, complaintOffset = 0) {
  if (!isAdmin) return;
  selectedStaff = record;
  for (const item of $('staff-directory-list').querySelectorAll('[data-staff-id]')) {
    item.setAttribute('aria-current', String(item.dataset.staffId === record.id));
  }
  const container = $('staff-selected');
  container.hidden = false;
  container.replaceChildren(el('p', 'Loading assignments...', 'muted'));
  const version = ++staffDetailsVersion;
  try {
    const data = await staffAdminCall('staff-work', { staff_id: record.id, shipment_offset: shipmentOffset, complaint_offset: complaintOffset });
    if (version !== staffDetailsVersion || !isAdmin) return;
    renderStaffRecord(record, data, shipmentOffset, complaintOffset);
  } catch (error) {
    if (version === staffDetailsVersion) container.replaceChildren(el('p', 'Assignments could not be loaded.', 'muted'));
    throw error;
  }
}

function renderStaffRecord(record, data, shipmentOffset, complaintOffset) {
  const target = $('staff-directory-message');
  const container = $('staff-selected');
  const heading = el('div', undefined, 'section-header');
  heading.append(el('h3', record.email), statusBadge(record.suspended ? 'Suspended' : 'Active'));
  container.replaceChildren(heading);
  async function afterSave(text, refreshed = record) {
    if (selectedStaff?.id === record.id && isAdmin) {
      await openStaffRecord(refreshed);
      await loadStaffDirectory();
    }
    message(target, text);
  }
  container.append(button(record.suspended ? 'Reinstate staff access' : 'Suspend staff access', async () => {
    const suspending = !record.suspended;
    if (suspending && !window.confirm('Suspend access for ' + record.email + '? Their assignments will be removed.')) return;
    await staffAdminCall(suspending ? 'suspend' : 'reinstate', { staff_id: record.id });
    await afterSave(suspending ? 'Staff access suspended and assignments removed.' : 'Staff access reinstated.',
      { ...record, suspended: suspending });
  }, record.suspended ? 'secondary' : 'secondary danger'));

  if (record.suspended) {
    container.append(el('p', 'Reinstate this account to assign new work.', 'muted'));
    return;
  }
  const assignmentGrid = el('div', undefined, 'staff-assignments');
  const ship = el('section');
  ship.append(el('h4', 'Shipment assignments'),
    el('p', 'All assignments include view access. Choose any additional permissions.', 'muted'),
    shipmentPermissionForm(record, afterSave, target));
  for (const grant of data.shipments.slice(0, 10)) {
    const item = el('details', undefined, 'record');
    item.append(el('summary', grant.origin + ' to ' + grant.destination), el('p', grant.tracking_code, 'muted'),
      shipmentPermissionForm(record, afterSave, target, grant),
      button('Revoke shipment access', async () => {
        await staffAdminCall('shipment-revoke', { staff_id: record.id, value: grant.tracking_code });
        await afterSave('Shipment access removed.');
      }, 'secondary danger'));
    ship.append(item);
  }
  if (!data.shipments.length) ship.append(el('p', 'No shipment assignments on this page.', 'muted'));
  appendAssignmentPaging(ship, shipmentOffset, data.shipments.length, offset => openStaffRecord(record, offset, complaintOffset));

  const cases = el('section');
  cases.append(el('h4', 'Complaint assignments'),
    makeActionForm(target, async (values) => {
      await staffAdminCall('complaint-assign', { staff_id: record.id, value: values.get('reference') });
      await afterSave('Complaint assigned.');
    }, 'Assign complaint', field('Complaint reference', 'reference', { required: true, max: 39 })));
  for (const item of data.complaints.slice(0, 10)) {
    const entry = el('div', undefined, 'record');
    entry.append(el('strong', item.category + ' | ' + item.status), el('p', item.reference, 'muted'),
      button('Return to admin queue', async () => {
        await staffAdminCall('complaint-revoke', { staff_id: record.id, value: item.reference, updated_at: item.updated_at });
        await afterSave('Complaint returned to the admin queue.');
      }));
    cases.append(entry);
  }
  if (!data.complaints.length) cases.append(el('p', 'No complaint assignments on this page.', 'muted'));
  appendAssignmentPaging(cases, complaintOffset, data.complaints.length, offset => openStaffRecord(record, shipmentOffset, offset));
  assignmentGrid.append(ship, cases);
  container.append(assignmentGrid);
}

function appendAssignmentPaging(section, offset, count, loadPage) {
  const actions = el('div', undefined, 'actions');
  if (offset > 0) actions.append(button('Previous', () => loadPage(offset - 10)));
  if (count > 10) actions.append(button('Next', () => loadPage(offset + 10)));
  if (actions.children.length) section.append(actions);
}

bind($('staff-directory-search'), async (values) => {
  staffDirectoryQuery = values.get('query').trim();
  await loadStaffDirectory();
}, $('staff-directory-message'));
$('more-staff').onclick = (event) => run(event.currentTarget, () => loadStaffDirectory(true), $('staff-directory-message'));

bind($('customer-shipment-lookup'), async (values) => {
  const value = values.get('tracking').trim().toUpperCase();
  const id = await staffAdminCall('find-shipment', { value });
  if (!id) throw new Error('No shipment matches that tracking number.');
  await openShipment(id);
}, $('customer-tools-message'));
