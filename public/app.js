const state = { config: null };
const status = document.querySelector('#status');
const requestedProductId = new URLSearchParams(location.search).get('product');

window.addEventListener('message', (event) => {
  if (!event.data || event.data.type !== 'independent-support-facts') return;
  renderWork(event.data);
});

function renderWork(data) {
  const snapshot = data.githubSnapshot || data.updateSnapshot || data;
  setCount('#commits-value', snapshot.commitCount ?? findMetric(data.metrics, /commit/i));
  setCount('#pull-requests-value', snapshot.pullRequestCount ?? findMetric(data.metrics, /pull request|\bpr\b/i));
}

function findMetric(metrics, pattern) {
  return Array.isArray(metrics) ? metrics.find((metric) => pattern.test(String(metric?.label || '')))?.value : null;
}

function setCount(selector, value) {
  if (value === null || value === undefined || value === '') {
    document.querySelector(selector).textContent = '—';
    return;
  }
  const number = Number(value);
  document.querySelector(selector).textContent = Number.isFinite(number) && number >= 0
    ? Math.floor(number).toLocaleString()
    : '—';
}

async function load() {
  try {
    state.config = await loadConfig();
    renderWork(state.config.githubSnapshot || {});
    setCount('#meals-value', state.config.mealsFunded);
    const options = document.querySelector('#support-options');
    for (const option of state.config.options) options.append(optionButton(option));
    if (!state.config.paymentConfigured) status.textContent = 'PayPal unavailable.';
  } catch {
    status.textContent = 'Support menu unavailable.';
  }

  const result = new URLSearchParams(location.search).get('payment');
  if (result === 'completed') status.textContent = 'Dinner acquired. Thank you.';
  if (result === 'cancelled') status.textContent = '';
  if (result === 'error') status.textContent = 'PayPal did not complete that.';
}

async function loadConfig() {
  const loaders = location.hostname.endsWith('.github.io')
    ? [loadStaticConfig, loadServerConfig]
    : [loadServerConfig, loadStaticConfig];
  for (const loader of loaders) {
    try { return await loader(); }
    catch { /* Try the other supported hosting mode. */ }
  }
  throw new Error('Support menu unavailable.');
}

async function loadServerConfig() {
  const response = await fetch(apiPath('/api/config'), { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error('Server configuration unavailable.');
  return response.json();
}

async function loadStaticConfig() {
  const response = await fetch('./static-config.json', { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error('Static configuration unavailable.');
  const config = await response.json();
  const productId = requestedProductId || config.defaultProductId;
  if (!config.productIds?.includes(productId)) throw new Error('Unknown support product.');
  const snapshotResponse = await fetch(`./products/${encodeURIComponent(productId)}.json`, { headers: { Accept: 'application/json' } });
  if (!snapshotResponse.ok) throw new Error('Product statistics unavailable.');
  return { ...config, productId, githubSnapshot: await snapshotResponse.json() };
}

function optionButton(option) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'option';
  if (option.recommended) button.classList.add('recommended');
  button.innerHTML = `
    <span class="option-name">${escapeHtml(shortLabel(option))}</span>
    <strong>$${escapeHtml(option.amount)}</strong>
    ${option.recommended ? '<span class="option-note">PayPal</span>' : ''}`;
  button.setAttribute('aria-label', `Buy ${option.label} for $${option.amount} with PayPal`);
  button.disabled = !state.config.paymentConfigured;
  button.addEventListener('click', () => beginPayment(option, button));
  return button;
}

function shortLabel(option) {
  if (option.id === 'estimated_fry') return 'One fry';
  if (option.id === 'vanilla_cone') return 'Cone';
  if (option.id === 'hamburger_happy_meal') return 'Happy Meal';
  if (option.id === 'quarter_pounder_cheese_meal') return 'Quarter Pounder meal';
  return option.label;
}

async function beginPayment(option, button) {
  button.disabled = true;
  status.textContent = 'Opening PayPal…';
  try {
    if (state.config.paymentMode === 'paypal_me_static') {
      const handle = state.config.paypalMeHandle;
      if (!/^[A-Za-z0-9]{1,20}$/.test(handle)) throw new Error('PayPal unavailable.');
      location.assign(`https://paypal.me/${handle}/${encodeURIComponent(option.amount)}USD`);
      return;
    }
    const response = await fetch(apiPath('/api/orders'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ optionId: option.id })
    });
    const data = await response.json();
    if (!response.ok || !data.approvalUrl) throw new Error(data.message || 'Checkout unavailable.');
    location.assign(data.approvalUrl);
  } catch (error) {
    status.textContent = error.message;
    button.disabled = !state.config.paymentConfigured;
  }
}

function apiPath(pathname) {
  const productId = state.config?.productId || requestedProductId;
  return productId ? `${pathname}?product=${encodeURIComponent(productId)}` : pathname;
}

function escapeHtml(value) {
  const span = document.createElement('span');
  span.textContent = String(value);
  return span.innerHTML;
}

load();
