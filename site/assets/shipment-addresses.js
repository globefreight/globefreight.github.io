let countryDirectory;

function shipmentCountries() {
  countryDirectory ||= fetch(siteAsset('countries-regions.json')).then(response => {
    if (!response.ok) throw new Error('The country and region list is unavailable.');
    return response.json();
  }).catch(error => {
    countryDirectory = null;
    throw error;
  });
  return countryDirectory;
}

function addressCall(op, payload) {
  return rpc('gf_address_work', { op, payload });
}

function addressControl(parent, label, input) {
  const wrapper = el('label', label);
  wrapper.append(input);
  parent.append(wrapper);
  return input;
}

function addressFieldset(title, key, countries, saved, shipment) {
  const group = el('fieldset', undefined, 'shipment-address');
  group.append(el('legend', title));
  const grid = el('div', undefined, 'field-grid');
  const country = el('select');
  country.required = !shipment || !!saved;
  country.append(new Option(shipment && !saved ? 'Keep existing location' : 'Choose a country', ''));
  for (const [code, name] of countries) country.append(new Option(name, code));
  country.value = saved?.country_code || '';
  addressControl(grid, 'Country', country);

  const region = el('select');
  const regionLabel = el('label', 'State, province, or region');
  regionLabel.append(region);
  grid.append(regionLabel);
  const manualRegion = el('input');
  manualRegion.maxLength = 100;
  const manualLabel = el('label', 'Region name');
  manualLabel.append(manualRegion);
  grid.append(manualLabel);

  const city = addressControl(grid, 'City or locality', el('input'));
  city.maxLength = 100;
  city.value = saved?.city || '';
  const postal = addressControl(grid, 'Postal or ZIP code', el('input'));
  postal.maxLength = 24;
  postal.value = saved?.postal_code || '';
  group.append(grid);
  const addressFields = el('div', undefined, 'address-fields');
  const street = addressControl(addressFields, 'Street address', el('input'));
  street.maxLength = 200;
  street.autocomplete = 'off';
  street.value = saved?.street || '';
  const results = el('div', undefined, 'address-results');
  results.hidden = true;
  results.setAttribute('aria-label', 'Address suggestions');
  addressFields.append(results);
  const feedback = el('p', undefined, 'address-feedback muted');
  feedback.id = 'address-feedback-' + key;
  feedback.setAttribute('role', 'status');
  street.setAttribute('aria-describedby', feedback.id);
  addressFields.append(feedback);
  const unit = addressControl(addressFields, 'Apartment, suite, or unit (optional)', el('input'));
  unit.maxLength = 80;
  unit.value = saved?.unit || '';
  group.append(addressFields);

  let regions = [];
  let selectedCountry;
  let timer;
  let version = 0;

  function clearSuggestions() {
    clearTimeout(timer);
    version++;
    results.replaceChildren();
    results.hidden = true;
  }

  function selectRegion(value, code = '') {
    const normalized = value.trim().toLocaleLowerCase();
    const match = regions.find(([shortCode, name]) => name.toLocaleLowerCase() === normalized ||
      (code && shortCode.toUpperCase() === code.toUpperCase()));
    region.value = match ? match[1] : value ? '__manual__' : '';
    manualRegion.value = match ? '' : value;
    manualLabel.hidden = regions.length > 0 && region.value !== '__manual__';
  }

  function applyCountry(value = '') {
    clearSuggestions();
    selectedCountry = countries.find(item => item[0] === country.value);
    regions = selectedCountry?.[2] || [];
    region.replaceChildren(new Option('Choose a region', ''), ...regions.map(([, name]) => new Option(name, name)),
      new Option('Enter another region', '__manual__'));
    regionLabel.hidden = !selectedCountry || !regions.length;
    region.required = !!selectedCountry && regions.length > 0;
    manualLabel.hidden = !selectedCountry || regions.length > 0;
    manualRegion.required = false;
    for (const input of [city, postal, street, unit]) input.disabled = !selectedCountry;
    city.required = street.required = !!selectedCountry;
    addressFields.hidden = !selectedCountry;
    city.parentElement.hidden = postal.parentElement.hidden = !selectedCountry;
    feedback.textContent = 'Enter at least four characters for suggestions. You can also type the address manually.';
    if (selectedCountry) selectRegion(value);
    manualRegion.required = !!selectedCountry && region.value === '__manual__' && regions.length > 0;
  }

  function regionName() {
    return !regions.length || region.value === '__manual__' ? manualRegion.value.trim() : region.value;
  }

  country.addEventListener('change', () => applyCountry());
  region.addEventListener('change', () => {
    clearSuggestions();
    manualLabel.hidden = region.value !== '__manual__';
    manualRegion.required = region.value === '__manual__';
    if (manualRegion.required) manualRegion.focus();
  });
  applyCountry(saved?.region || '');

  async function showSuggestions(query, requestVersion) {
    if (!session) return;
    try {
      const response = await request('/functions/v1/address-autocomplete', {
        method: 'POST', token: session.access_token,
        body: { query, country: country.value, region: regionName(), shipment: shipment?.id || null }
      });
      if (requestVersion !== version || !group.isConnected) return;
      const items = Array.isArray(response?.suggestions) ? response.suggestions : [];
      feedback.textContent = items.length ? 'Choose an address suggestion.' : 'No suggestions found. Enter the address manually.';
      for (const item of items) {
        const choice = el('button', item.label, 'address-option');
        choice.type = 'button';
        choice.addEventListener('pointerdown', event => event.preventDefault());
        choice.addEventListener('click', () => {
          street.value = item.street;
          if (item.city) city.value = item.city;
          if (item.postalCode) postal.value = item.postalCode;
          if (item.region) selectRegion(item.region, item.regionCode);
          manualRegion.required = region.value === '__manual__' && regions.length > 0;
          clearSuggestions();
          feedback.textContent = 'Address filled in. Check the details and add a unit if needed.';
          street.focus();
        });
        results.append(choice);
      }
      results.hidden = !items.length;
    } catch {
      if (requestVersion === version && group.isConnected) {
        feedback.textContent = 'Address suggestions are unavailable. Enter the address manually.';
      }
    }
  }

  street.addEventListener('input', () => {
    clearSuggestions();
    const query = street.value.trim();
    if (!selectedCountry || query.length < 4) return;
    const requestVersion = version;
    timer = setTimeout(() => showSuggestions(query, requestVersion), 380);
  });
  addressFields.addEventListener('keydown', event => {
    if (results.hidden) return;
    if (event.key === 'Escape') {
      clearSuggestions();
      street.focus();
    } else if (event.key === 'ArrowDown' && event.target === street) {
      event.preventDefault();
      results.querySelector('button')?.focus();
    } else if (event.target.classList.contains('address-option') && ['ArrowDown','ArrowUp'].includes(event.key)) {
      event.preventDefault();
      const next = event.key === 'ArrowDown' ? event.target.nextElementSibling : event.target.previousElementSibling;
      (next || street).focus();
    }
  });
  addressFields.addEventListener('focusout', event => {
    if (!addressFields.contains(event.relatedTarget)) clearSuggestions();
  });

  return {
    element: group,
    data: () => selectedCountry ? {
      country_code: selectedCountry[0], country: selectedCountry[1], region: regionName(),
      city: city.value, street: street.value, unit: unit.value, postal_code: postal.value
    } : null
  };
}

function shipmentForm(shipment) {
  const panel = el('div');
  panel.append(el('p', 'Loading address fields...', 'muted'));
  const id = shipment?.id || null;
  const requestId = id ? null : crypto.randomUUID();
  Promise.all([shipmentCountries(), id ? addressCall('read', { id }) : {}]).then(([countries, previous]) => {
    if (!panel.isConnected) return;
    const addresses = el('div', undefined, 'shipment-address-grid');
    const origin = addressFieldset('Pickup address', 'origin', countries, previous.origin, shipment);
    const destination = addressFieldset('Delivery address', 'destination', countries, previous.destination, shipment);
    addresses.append(origin.element, destination.element);
    const details = el('div', undefined, 'field-grid');
    details.append(field('Service', 'service', { choices: services, value: shipment?.service }),
      field('Estimated delivery', 'eta', { type: 'date', value: shipment?.eta }),
      field('Internal reference', 'internal_reference', { max: 150, value: shipment?.internal_reference }));
    panel.replaceChildren(el('p', 'Street addresses are only visible in the team portal.', 'muted'),
      makeForm(async (values) => {
        const activeSession = session;
        const savedId = await addressCall('save', {
          id, request_id: requestId, ...Object.fromEntries(values), origin: origin.data(), destination: destination.data()
        });
        if (!savedId) throw new Error('The shipment could not be saved. Refresh your permissions and try again.');
        if (session !== activeSession || currentShipment !== id) return;
        if (!id) {
          shipmentQuery = '';
          $('shipment-search').reset();
        }
        await Promise.all([openShipment(savedId), loadList(), loadMetrics()]);
        message($('portal-message'), id ? 'Shipment details saved.' : 'Shipment created.');
      }, id ? 'Save details' : 'Create shipment', addresses, details));
  }).catch(error => panel.replaceChildren(el('p', error.message, 'status-message error')));
  return panel;
}

function readOnlyShipmentAddresses(id) {
  const section = el('details', undefined, 'detail-section');
  const content = el('div');
  section.append(el('summary', 'Pickup and delivery addresses'), content);
  section.addEventListener('toggle', async () => {
    if (!section.open) {
      content.replaceChildren();
      return;
    }
    try {
      const addresses = await addressCall('read', { id });
      if (!section.open) return;
      for (const [key, title] of [['origin','Pickup'],['destination','Delivery']]) {
        const value = addresses[key];
        const formatted = value ? [value.street, value.unit, value.city, value.region, value.postal_code, value.country].filter(Boolean).join(', ') :
          'No street address recorded.';
        content.append(el('p', title + ': ' + formatted));
      }
    } catch (error) {
      content.replaceChildren(el('p', error.message, 'status-message error'));
    }
  });
  return section;
}
