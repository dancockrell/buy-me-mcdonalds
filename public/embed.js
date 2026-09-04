(() => {
  const script = document.currentScript;
  const appletOrigin = new URL(script?.src || location.href).origin;
  let overlay;
  let frame;

  function open(facts = {}) {
    if (!overlay) build();
    const productId = typeof facts.productId === 'string' ? facts.productId : '';
    const nextUrl = new URL('/', appletOrigin);
    if (productId) nextUrl.searchParams.set('product', productId);
    const destinationChanged = frame.src !== nextUrl.href;
    if (destinationChanged) frame.src = nextUrl.href;
    overlay.hidden = false;
    document.documentElement.style.overflow = 'hidden';
    if (destinationChanged) frame.addEventListener('load', () => postFacts(facts), { once: true });
    else postFacts(facts);
    frame.focus();
  }

  function close() {
    if (!overlay) return;
    overlay.hidden = true;
    document.documentElement.style.overflow = '';
  }

  function postFacts(facts) {
    frame?.contentWindow?.postMessage({ type: 'independent-support-facts', ...facts }, appletOrigin);
  }

  function build() {
    overlay = document.createElement('div');
    overlay.hidden = true;
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-label', 'Voluntary software support');
    Object.assign(overlay.style, { position: 'fixed', inset: '0', zIndex: '2147483647', background: '#000b', padding: 'clamp(8px,3vw,30px)', display: 'grid', placeItems: 'center' });
    frame = document.createElement('iframe');
    frame.title = 'Support the person who made this';
    frame.src = `${appletOrigin}/`;
    frame.allow = 'payment';
    Object.assign(frame.style, { width: 'min(1440px,100%)', height: 'min(900px,100%)', border: '0', borderRadius: '10px', background: '#101817' });
    const closeButton = document.createElement('button');
    closeButton.type = 'button'; closeButton.textContent = 'Close support page';
    Object.assign(closeButton.style, { position: 'absolute', top: '8px', right: '12px', zIndex: '1', padding: '9px 12px' });
    closeButton.addEventListener('click', close);
    overlay.addEventListener('click', (event) => { if (event.target === overlay) close(); });
    overlay.append(frame, closeButton); document.body.append(overlay);
  }

  window.IndependentSupport = Object.freeze({ open, close });
})();
