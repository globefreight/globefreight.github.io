function bookingCall(op, payload, signedIn = true) {
  return rpc('gf_booking', { op, payload }, signedIn);
}

function slotText(record) {
  return dateTime.formatRange(new Date(record.starts_at), new Date(record.ends_at));
}

function priceText(record) {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: record.currency, currencyDisplay: 'code' }).format(record.amount);
}

function deliveryDateTime(value) {
  const date = new Date(value);
  if (!value || !Number.isFinite(+date)) throw new Error('Enter a valid date and time.');
  return date.toISOString();
}

function trackingAnchor(code) {
  const anchor = el('a', 'Open shipment tracking', 'text-button');
  const url = new URL(location.href);
  url.hash = '';
  url.search = '';
  url.searchParams.set('tracking', code);
  anchor.href = url.href;
  return anchor;
}

function privateQuote(result, token, fragment) {
  const content = $('booking-content');
  const details = el('p', result.origin + ' to ' + result.destination + ' | ' + result.service, 'muted');
  content.replaceChildren(el('p', result.reference, 'muted'), details, el('p', priceText(result), 'booking-price'));
  if (result.tracking_code) {
    content.append(el('p', 'Your quote has been booked.'), trackingAnchor(result.tracking_code));
    return;
  }
  if (result.accepted_at) {
    content.append(el('p', 'Quote accepted. The team will email your tracking link after booking.'));
    return;
  }
  content.append(el('p', 'Accept by ' + dateTime.format(new Date(result.expires_at))));
  content.append(makeActionForm($('booking-message'), async () => {
    const accepted = await bookingCall('accept-quote', { token }, false);
    if (location.hash !== fragment) return;
    if (!accepted) throw new Error('This quote offer expired or was replaced.');
    privateQuote(accepted, token, fragment);
    message($('booking-message'), 'Quote accepted.');
  }, 'Accept quote'));
}

function privateShipment(result, token, fragment) {
  const target = $('booking-message');
  const content = $('booking-content');
  const pickup = result.pickup;
  content.replaceChildren(el('p', result.tracking_code + ' | ' + result.origin + ' to ' + result.destination, 'muted'),
    trackingAnchor(result.tracking_code));
  const pickupSection = el('section', undefined, 'detail-section');
  pickupSection.append(el('h2', 'Pickup scheduling'));
  if (pickup?.state) pickupSection.append(el('p', pickup.state + ': ' + slotText(pickup)));
  if (result.may_request) {
    const dates = el('div', undefined, 'field-grid');
    dates.append(field('Window starts', 'starts_at', { type: 'datetime-local', required: true }),
      field('Window ends', 'ends_at', { type: 'datetime-local', required: true }));
    pickupSection.append(el('p', 'Enter times in your current time zone (' +
      Intl.DateTimeFormat().resolvedOptions().timeZone + '). The team will review your proposed window.', 'muted'));
    pickupSection.append(makeActionForm(target, async (values) => {
      const next = await bookingCall('pickup-request', {
        token, starts_at: deliveryDateTime(values.get('starts_at')), ends_at: deliveryDateTime(values.get('ends_at'))
      }, false);
      if (location.hash !== fragment) return;
      if (!next) throw new Error('This shipment link expired or was replaced.');
      privateShipment(next, token, fragment);
      message(target, 'Pickup request sent for review.');
    }, 'Request pickup', dates));
  } else if (!pickup?.state) {
    pickupSection.append(el('p', 'Online pickup scheduling is closed for this shipment.', 'muted'));
  }
  content.append(pickupSection);

  if (!result.may_instruct) return;
  const instructionSection = el('section', undefined, 'detail-section');
  instructionSection.append(el('h2', 'Delivery instructions'),
    el('p', 'Share delivery notes or an alternate contact with the team handling your shipment. Keep this link private.', 'muted'));
  instructionSection.append(makeActionForm(target, async (values) => {
    const next = await bookingCall('delivery-note', {
      token, directions: values.get('directions'), alternate_contact: values.get('alternate_contact')
    }, false);
    if (location.hash !== fragment) return;
    if (!next) throw new Error('This shipment link expired or was replaced.');
    privateShipment(next, token, fragment);
    message(target, 'Delivery instructions saved.');
  }, 'Save instructions',
  field('Delivery note or access code', 'directions', { multiline: true, max: 1000, value: pickup?.directions || '' }),
  field('Alternate contact', 'alternate_contact', { max: 150, value: pickup?.alternate_contact || '' })));
  content.append(instructionSection);
}

async function loadPrivateBooking() {
  const fragment = location.hash;
  const result = $('booking-content');
  const feedback = $('booking-message');
  result.replaceChildren();
  message(feedback);
  const match = fragment.match(/^#(quote|shipment)=(.*)$/);
  if (!match) return;
  const [, kind, token] = match;
  $('booking-title').textContent = kind === 'quote' ? 'Review your quote' : 'Manage your shipment';
  if (!/^[0-9a-f]{64}$/.test(token)) {
    message(feedback, 'This private link is invalid.', true);
    return;
  }
  message(feedback, 'Loading details...');
  try {
    const data = await bookingCall(kind + '-link', { token }, false);
    if (location.hash !== fragment) return;
    if (!data) throw new Error('This private link expired or was replaced. Contact the team for a new link.');
    message(feedback);
    if (kind === 'quote') privateQuote(data, token, fragment);
    else privateShipment(data, token, fragment);
  } catch (error) {
    if (location.hash === fragment) message(feedback, error.message, true);
  }
}
window.addEventListener('hashchange', loadPrivateBooking);
loadPrivateBooking();

function bookingPanel(title, fetchDetails, render) {
  const panel = el('details', undefined, 'detail-section booking-panel');
  const content = el('div');
  const feedback = el('p');
  message(feedback);
  panel.append(el('summary', title), feedback, content);
  let version = 0;
  async function refresh() {
    const requestVersion = ++version;
    const details = await fetchDetails();
    if (requestVersion !== version || !panel.open) return;
    content.replaceChildren();
    render(content, feedback, details, refresh);
  }
  panel.addEventListener('toggle', () => {
    if (!panel.open) {
      version++;
      content.replaceChildren();
      message(feedback);
      return;
    }
    refresh().catch(error => message(feedback, error.message, true));
  });
  return panel;
}

function quoteBookingPanel(id) {
  return bookingPanel('Send quote and book shipment', () => bookingCall('offer-details', { id }),
    (content, feedback, offer, refresh) => {
      if (offer) {
        content.append(el('p', priceText(offer) + ' | Expires ' + dateTime.format(new Date(offer.expires_at))));
      }
      if (offer?.shipment_id) {
        content.append(button('Open booked shipment', () => openShipment(offer.shipment_id)));
        return;
      }
      if (offer?.accepted_at) {
        content.append(el('p', 'Accepted ' + dateTime.format(new Date(offer.accepted_at))),
          button('Book accepted quote', async () => {
            const shipmentId = await bookingCall('book-quote', { id });
            await loadList();
            await loadMetrics();
            await refresh();
            message(feedback, 'Shipment booked. Email notifications are queued.');
            if (shipmentId) await openShipment(shipmentId);
          }));
        return;
      }
      content.append(el('p', 'Offer expiry uses your browser time zone. Sending a replacement expires the previous link.', 'muted'));
      content.append(makeActionForm(feedback, async (values) => {
        await bookingCall('send-offer', { id, amount: values.get('amount'), currency: values.get('currency'),
          expires_at: deliveryDateTime(values.get('expires_at')) });
        await refresh();
        message(feedback, 'Quote offer queued for email.');
      }, 'Email quote offer',
      field('Price', 'amount', { type: 'number', required: true, value: offer?.amount }),
      field('Currency', 'currency', { choices: ['USD','NGN','GBP','EUR','CAD'], value: offer?.currency || 'USD' }),
      field('Offer expires', 'expires_at', { type: 'datetime-local', required: true })));
      const amount = content.querySelector('[name="amount"]');
      if (amount) {
        amount.step = '0.01';
        amount.min = '0.01';
        amount.max = '999999999.99';
      }
      if (offer) content.append(button('Refresh acceptance status', refresh));
    });
}

function shipmentServicesPanel(id, rights) {
  const panel = bookingPanel('Pickup and delivery instructions', () => bookingCall('shipment-details', { id }),
    (content, feedback, data, refresh) => {
      if (rights.admin) {
        content.append(button('Email a new private shipment link', async () => {
          await bookingCall('send-shipment-link', { id });
          message(feedback, 'Shipment link queued for email. Any previous link is disabled.');
        }));
      }
      if (!data?.state && !data?.directions && !data?.alternate_contact) {
        content.append(el('p', 'No pickup or delivery instructions have been submitted.', 'muted'));
        return;
      }
      if (data.directions) content.append(el('p', 'Delivery note: ' + data.directions, 'booking-sensitive'));
      if (data.alternate_contact) content.append(el('p', 'Alternate contact: ' + data.alternate_contact, 'booking-sensitive'));
      if (!data.state) return;
      content.append(el('p', 'Pickup ' + data.state.toLowerCase() + ': ' + slotText(data)));
      if (data.may_review && (rights.edit || rights.post)) {
        content.append(makeActionForm(feedback, async (values) => {
          await bookingCall('pickup-review', { id, expected_update: data.updated_at, state: values.get('state') });
          await refresh();
          if ($('pickup-queue').open) loadPickupQueue().catch(error => message($('pickups-message'), error.message, true));
          message(feedback, 'Pickup decision saved.');
        }, 'Save pickup decision',
        field('Decision', 'state', { choices: ['Confirmed','Change requested','Cancelled'], value: data.state === 'Requested' ? 'Confirmed' : data.state })));
      }
    });
  panel.id = 'shipment-services-panel';
  return panel;
}

let pickupPageOffset = 0;
let pickupQueueVersion = 0;

function resetPickupQueue() {
  pickupQueueVersion++;
  pickupPageOffset = 0;
  $('pickup-queue').open = false;
  $('more-pickups').hidden = true;
  $('pickup-list').replaceChildren();
  message($('pickups-message'));
}

async function loadPickupQueue(append = false) {
  const version = ++pickupQueueVersion;
  const offset = append ? pickupPageOffset : 0;
  const rows = await bookingCall('pickup-list', { offset });
  if (version !== pickupQueueVersion) return;
  const list = $('pickup-list');
  if (!append) list.replaceChildren();
  if (!rows.length && !offset) list.append(el('p', 'No pickup requests awaiting review.', 'muted'));
  for (const row of rows.slice(0, 20)) {
    const item = el('article', undefined, 'record');
    item.append(el('strong', row.origin + ' to ' + row.destination),
      el('p', row.tracking_code + ' | ' + slotText(row), 'muted'),
      button('Open pickup request', async () => {
        await openShipment(row.id);
        const panel = $('shipment-services-panel');
        if (!panel || currentShipment !== row.id) return;
        panel.open = true;
        panel.scrollIntoView();
        panel.querySelector('summary')?.focus();
      }));
    list.append(item);
  }
  pickupPageOffset = offset + 20;
  $('more-pickups').hidden = rows.length <= 20;
}

$('pickup-queue').addEventListener('toggle', () => {
  if ($('pickup-queue').open && session) run($('refresh-pickups'), () => loadPickupQueue(), $('pickups-message'));
});
$('refresh-pickups').onclick = (event) => run(event.currentTarget, () => loadPickupQueue(), $('pickups-message'));
$('more-pickups').onclick = (event) => run(event.currentTarget, () => loadPickupQueue(true), $('pickups-message'));
