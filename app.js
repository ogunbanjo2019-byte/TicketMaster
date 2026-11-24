const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const API_BASE_URL = 'https://ticketmaster-backend-8icp.onrender.com';
const apiURL = path => `${API_BASE_URL}${path}`;
const state = {
  events: [], favorites: [], orders: [], notifications: [], listings: [], profile: null,
  view: 'discover', ticketTab: 'upcoming', category: 'All', search: '', location: 'Lagos',
  selectedEvent: null, selectedType: null, selectedSeats: [], quantity: 1, currentOrder: null,
  submitting: false, toastTimer: null, authToken: '', authRefreshToken: '', authUser: null,
  recoveryTokens: null, reservedSeats: []
};
const money = value => `$${Number(value || 0).toFixed(2)}`;
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const dateIsFuture = order => {
  const match = String(order.date || '').match(/([A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2}, \d{4})/);
  return !match || new Date(match[1]) >= new Date(new Date().toDateString());
};

async function api(path, options = {}) {
  const response = await fetch(apiURL(path), {
    ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(state.authToken ? { Authorization: `Bearer ${state.authToken}` } : {}), ...options.headers }
  });
  const type = response.headers.get('content-type') || '';
  const result = type.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) { const error = new Error(result?.error || 'We couldn’t complete that request. Please try again.'); error.status = response.status; throw error; }
  return result;
}
function notify(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => toast.classList.remove('show'), 2800);
}
function setAuthMessage(message = '', kind = 'error') {
  const box = $('#authMessage');
  box.textContent = message;
  box.classList.toggle('success', kind === 'success');
  box.hidden = !message;
}
function setAuthMode(mode) {
  const titles = { login: ['Welcome back!', 'Sign in to continue to TicketPro.'], signup: ['Create your account', 'Join TicketPro and start planning your next night out.'], forgot: ['Reset your password', 'We’ll send you a secure link to reset your password.'], reset: ['Choose a new password', 'Use a strong password you have not used before.'] };
  const visibleForm = { login: 'loginForm', signup: 'signupForm', forgot: 'forgotForm', reset: 'resetForm' }[mode] || 'loginForm';
  for (const id of ['loginForm', 'signupForm', 'forgotForm', 'resetForm']) $(`#${id}`).hidden = id !== visibleForm;
  const [title, subtitle] = titles[mode] || titles.login;
  $('#authTitle').textContent = title;
  $('#authSubtitle').textContent = subtitle;
  $('#authTabs').hidden = mode === 'forgot' || mode === 'reset';
  $('#authSwitchCopy').hidden = mode === 'forgot' || mode === 'reset';
  $('#authSwitchCopy').innerHTML = mode === 'signup' ? 'Already have an account? <button class="auth-link" type="button" data-auth-mode="login">Sign in</button>' : 'New to TicketPro? <button class="auth-link" type="button" data-auth-mode="signup">Create an account</button>';
  $$('.auth-tab').forEach(tab => {
    const active = tab.dataset.authMode === (mode === 'signup' ? 'signup' : 'login');
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
  });
  setAuthMessage('');
}
function saveAuthToken(token, refreshToken, remember = false) {
  localStorage.removeItem('ticketpro-auth-token');
  localStorage.removeItem('ticketpro-refresh-token');
  sessionStorage.removeItem('ticketpro-auth-token');
  sessionStorage.removeItem('ticketpro-refresh-token');
  const storage = remember ? localStorage : sessionStorage;
  storage.setItem('ticketpro-auth-token', token);
  if (refreshToken) storage.setItem('ticketpro-refresh-token', refreshToken);
  state.authToken = token;
  state.authRefreshToken = refreshToken || '';
}
function clearAuthToken() {
  localStorage.removeItem('ticketpro-auth-token');
  localStorage.removeItem('ticketpro-refresh-token');
  sessionStorage.removeItem('ticketpro-auth-token');
  sessionStorage.removeItem('ticketpro-refresh-token');
  state.authToken = '';
  state.authRefreshToken = '';
  state.authUser = null;
}
async function showDashboard(user) {
  state.authUser = user;
  $('#authScreen').hidden = true;
  $('.app-shell').hidden = false;
  try { await refreshData(); }
  catch (error) {
    if (error.status === 401) {
      clearAuthToken();
      $('.app-shell').hidden = true;
      $('#authScreen').hidden = false;
      setAuthMessage('Your sign-in session ended. Please sign in again.');
      return;
    }
    $('#featureEvent').innerHTML = `<div class="feature-empty"><span class="empty-symbol">⌕</span><strong>We couldn’t reach TicketPro.</strong><span>${escapeHTML(error.message)}</span><button class="primary-button" data-action="retry-load">Try again</button></div>`;
    $('#eventGrid').innerHTML = `<div class="empty-inline">Connect to the internet and try again.</div>`;
  }
}
async function initializeAuth() {
  const requested = new URLSearchParams(window.location.search).get('mode');
  const requestedMode = requested === 'signup' ? 'signup' : 'login';
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  if (hash.get('error_description')) {
    const message = hash.get('error_description').replaceAll('+', ' ');
    history.replaceState(null, '', `${location.pathname}${location.search}`);
    setAuthMode('login');
    setAuthMessage(message);
    return;
  }
  if (hash.get('type') === 'recovery') {
    state.recoveryTokens = { accessToken: hash.get('access_token'), refreshToken: hash.get('refresh_token') };
    history.replaceState(null, '', `${location.pathname}${location.search}`);
    if (!state.recoveryTokens.accessToken || !state.recoveryTokens.refreshToken) {
      setAuthMode('forgot');
      setAuthMessage('That reset link is incomplete. Request a new password reset email.');
      return;
    }
    setAuthMode('reset');
    return;
  }
  if (hash.get('access_token') && hash.get('refresh_token')) {
    const accessToken = hash.get('access_token');
    const refreshToken = hash.get('refresh_token');
    history.replaceState(null, '', `${location.pathname}${location.search}`);
    saveAuthToken(accessToken, refreshToken);
    try { const session = await api('/api/auth/session'); await showDashboard(session.user); return; }
    catch { clearAuthToken(); }
  }
  const token = localStorage.getItem('ticketpro-auth-token') || sessionStorage.getItem('ticketpro-auth-token');
  const refreshToken = localStorage.getItem('ticketpro-refresh-token') || sessionStorage.getItem('ticketpro-refresh-token');
  if (!token) { setAuthMode(requestedMode); return; }
  state.authToken = token;
  state.authRefreshToken = refreshToken || '';
  try {
    const session = await api('/api/auth/session');
    await showDashboard(session.user);
  } catch {
    try {
      if (!refreshToken) throw new Error('No refresh token');
      const result = await api('/api/auth/refresh', { method: 'POST', body: JSON.stringify({ refreshToken }) });
      saveAuthToken(result.token, result.refreshToken, localStorage.getItem('ticketpro-refresh-token') !== null);
      const session = await api('/api/auth/session');
      await showDashboard(session.user);
    } catch {
      clearAuthToken(); setAuthMode('login'); setAuthMessage('Your sign-in session expired. Please sign in again.');
    }
  }
}
async function signOut() {
  try { if (state.authToken) await api('/api/auth/logout', { method: 'POST', body: JSON.stringify({ refreshToken: state.authRefreshToken }) }); } catch {}
  clearAuthToken();
  $('.app-shell').hidden = true;
  $('#authScreen').hidden = false;
  $('#loginForm').reset();
  $('#signupForm').reset();
  setAuthMode('login');
}
function findEvent(id) { return state.events.find(event => event.id === id); }
function orderEvent(order) { return findEvent(order.eventId) || state.events.find(event => event.shortTitle === order.title) || state.events[0]; }
function navChange(view) {
  const allowed = ['discover', 'tickets', 'favorites', 'account', 'notifications'];
  state.view = allowed.includes(view) ? view : 'discover';
  $$('.view').forEach(section => section.classList.toggle('active', section.id === `view-${state.view}`));
  $$('[data-nav]').forEach(button => button.classList.toggle('active', button.dataset.nav === state.view));
  $('#notificationsPopover').hidden = true;
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (state.view === 'tickets') renderTickets();
  if (state.view === 'account') fillProfile();
  if (state.view === 'notifications') renderNotificationPage();
}
function imgTag(source, alt, className = '') {
  return `<img class="${className}" src="${escapeHTML(source || '')}" alt="${escapeHTML(alt)}" loading="lazy">`;
}
function cardForEvent(event) {
  const saved = state.favorites.includes(event.id);
  const soldOut = event.ticketTypes.length === 0;
  return `<article class="event-card" data-action="event-detail" data-id="${escapeHTML(event.id)}" tabindex="0" aria-label="View ${escapeHTML(event.title)}">
    <div class="event-image-wrap">${imgTag(event.poster, event.title)}<span class="event-category">${escapeHTML(event.category)}</span><button class="favorite-toggle ${saved ? 'saved' : ''}" data-action="favorite" data-id="${escapeHTML(event.id)}" aria-label="${saved ? 'Remove from' : 'Add to'} favorites" aria-pressed="${saved}">${saved ? '♥' : '♡'}</button></div>
    <div class="event-card-content"><div class="event-card-title-row"><h3>${escapeHTML(event.shortTitle || event.title)}</h3><span class="event-category-text">${escapeHTML(event.category)}</span></div>
      <div class="event-card-meta"><span>▣ ${escapeHTML(event.date)}</span><span>⌖ ${escapeHTML(event.venue)}, ${escapeHTML(event.city)}</span></div>
      <div class="event-card-foot"><span class="event-price">${soldOut ? '<strong class="sold-out-label">Sold out</strong>' : `From <strong>${money(Math.min(...event.ticketTypes.map(type => type.price)))}</strong>`}</span><button class="event-buy" data-action="buy-event" data-id="${escapeHTML(event.id)}" ${soldOut ? 'disabled' : ''}>${soldOut ? 'Sold out' : 'Find tickets →'}</button></div>
    </div></article>`;
}
function renderDiscover() {
  const locationShort = state.location === 'All locations' ? 'All' : state.location.split(',')[0];
  $('#locationShort').textContent = locationShort;
  $('#locationLong').textContent = state.location;
  $('#locationButton').setAttribute('aria-label', `Change location, current location ${state.location}`);
  $('#currentLocation').textContent = state.location.toUpperCase();
  const cityEvents = state.location === 'All locations' ? state.events : state.events.filter(event => event.city.toLowerCase() === state.location.split(',')[0].toLowerCase());
  const feature = cityEvents[0];
  if (feature) {
    const soldOut = feature.ticketTypes.length === 0;
    $('#featureEvent').innerHTML = `<article class="hero-card" style="background-image:url('${escapeHTML(feature.hero)}')"><div class="hero-content"><span class="hero-label">✦ FEATURED EVENT</span><h2>${escapeHTML(feature.title)}</h2><p class="hero-tagline">${escapeHTML(feature.tagline)}</p><div class="hero-meta"><span><b>▣</b>${escapeHTML(feature.date)}</span><span><b>⌖</b>${escapeHTML(feature.venue)}, ${escapeHTML(feature.city)}</span></div><div class="hero-bottom"><button class="hero-cta" data-action="event-detail" data-id="${escapeHTML(feature.id)}" ${soldOut ? 'disabled' : ''}>${soldOut ? 'Sold out' : 'Get tickets →'}</button><span class="hero-price">From <strong>${money(Math.min(...feature.ticketTypes.map(type => type.price)))}</strong></span></div></div><button class="hero-arrow" aria-label="See featured event">›</button><div class="hero-dots" aria-hidden="true"><i></i><i></i><i></i></div></article>`;
  } else {
    $('#featureEvent').innerHTML = `<div class="feature-empty"><span class="empty-symbol">⌖</span><strong>No events in ${escapeHTML(state.location)} yet.</strong><span>Choose another location to see what’s on.</span><button class="text-button" data-action="choose-location">Change location →</button></div>`;
  }
  const term = state.search.trim().toLowerCase();
  const filtered = cityEvents.filter(event => (state.category === 'All' || event.category === state.category || (state.category === 'Festival' && event.title.toLowerCase().includes('festival'))) && (!term || `${event.title} ${event.category} ${event.venue} ${event.city}`.toLowerCase().includes(term)));
  $('#eventGrid').innerHTML = filtered.length ? filtered.map(cardForEvent).join('') : `<div class="empty-inline">No events found here. Try another search, category, or location.</div>`;
  $('#miniTickets').innerHTML = state.orders.filter(dateIsFuture).slice(0, 2).map(order => {
    const event = orderEvent(order);
    return `<article class="mini-ticket">${imgTag(event?.poster, order.title)}<div class="mini-ticket-body"><h3>${escapeHTML(order.title)}</h3><p>${escapeHTML(order.date)}<br>${escapeHTML(order.venue)}</p><span class="status-pill">${escapeHTML(order.status)}</span><div class="mini-ticket-actions"><button data-action="open-ticket" data-id="${escapeHTML(order.id)}">View pass →</button></div></div></article>`;
  }).join('') || `<div class="empty-inline">Your next night out starts here.</div>`;
  $('#ticketCount').textContent = state.orders.filter(dateIsFuture).length;
}
function ticketCard(order) {
  const event = orderEvent(order);
  const qr = apiURL(`/api/qr?data=${encodeURIComponent(order.code || order.id)}`);
  return `<article class="wallet-ticket"><div class="wallet-ticket-top">${imgTag(event?.poster, order.title, 'wallet-ticket-poster')}<div class="wallet-ticket-info"><span class="eyebrow blue">${escapeHTML(order.ticketType || 'General admission')}</span><h3>${escapeHTML(order.title)}</h3><p>▣ ${escapeHTML(order.date)}</p><p>⌖ ${escapeHTML(order.venue)}</p><p>${escapeHTML(order.seat || `${order.quantity} ticket${order.quantity === 1 ? '' : 's'}`)}</p><span class="status-pill">${escapeHTML(order.status)}</span></div><img class="ticket-qr" src="${qr}" alt="Scannable ticket code for ${escapeHTML(order.title)}"></div><div class="wallet-ticket-bottom"><span class="ticket-code">${escapeHTML(order.code || order.id)}</span><div class="ticket-actions"><button data-action="transfer" data-id="${escapeHTML(order.id)}">↗ Transfer</button><button class="primary-mini" data-action="sell" data-id="${escapeHTML(order.id)}">Sell ticket</button></div></div></article>`;
}
async function renderTickets() {
  const list = $('#ticketPageList');
  if (state.ticketTab === 'listings') {
    try { state.listings = await api('/api/listings'); } catch { state.listings = []; }
    list.innerHTML = state.listings.length ? `<div class="notification-page-list">${state.listings.map(item => `<div class="notification-row"><span class="notification-symbol blue">↗</span><div class="notification-copy"><strong>${escapeHTML(item.title)}</strong><p>${escapeHTML(item.quantity)} ticket${item.quantity === 1 ? '' : 's'} · Asking ${money(item.askingPrice)} each</p><small>${escapeHTML(item.createdAt?.slice(0, 10) || '')}</small></div><span class="listing-status">${escapeHTML(item.status)}</span></div>`).join('')}</div>` : `<div class="empty-state"><div class="empty-symbol">↗</div><h2>No listings just yet.</h2><p>Put a ticket up for resale from your wallet.</p></div>`;
    return;
  }
  const selected = state.orders.filter(order => state.ticketTab === 'past' ? !dateIsFuture(order) : dateIsFuture(order));
  $('#upcomingCount').textContent = state.orders.filter(dateIsFuture).length;
  list.innerHTML = selected.length ? selected.map(ticketCard).join('') : `<div class="empty-state"><div class="empty-symbol">▣</div><h2>${state.ticketTab === 'past' ? 'Your first encore is still ahead.' : 'Nothing on the calendar yet.'}</h2><p>${state.ticketTab === 'past' ? 'After your next show, it’ll be remembered here.' : 'Find a brilliant event and we’ll keep your ticket safe.'}</p><button class="primary-button" data-nav="discover">Explore events</button></div>`;
}
function renderFavorites() {
  const list = state.events.filter(event => state.favorites.includes(event.id));
  $('#favoritesGrid').innerHTML = list.map(cardForEvent).join('');
  $('#favoritesEmpty').hidden = list.length > 0;
  $('#favoritesGrid').hidden = list.length === 0;
}
function notificationMarkup(item) {
  return `<div class="notification-row ${item.read ? 'read' : ''}"><span class="notification-symbol ${escapeHTML(item.tone || 'blue')}">${escapeHTML(item.icon || '•')}</span><div class="notification-copy"><strong>${escapeHTML(item.title)}</strong><p>${escapeHTML(item.detail)}</p><small>${escapeHTML(item.time)}</small></div><span class="unread-dot" aria-label="${item.read ? 'Read' : 'Unread'}"></span></div>`;
}
function renderNotifications() {
  const unread = state.notifications.filter(item => !item.read).length;
  $('#notificationCount').textContent = unread > 9 ? '9+' : unread;
  $('#notificationCount').hidden = unread === 0;
  $('#notificationList').innerHTML = state.notifications.slice(0, 4).map(notificationMarkup).join('') || `<div class="empty-inline">You’re all caught up.</div>`;
}
function renderNotificationPage() { $('#notificationPageList').innerHTML = state.notifications.map(notificationMarkup).join('') || `<div class="empty-inline">You’re all caught up.</div>`; }
function renderAll() {
  renderDiscover(); renderFavorites(); renderNotifications();
  if (state.view === 'tickets') renderTickets();
}
function showModal(markup) {
  $('#modalBody').innerHTML = markup;
  $('#modalBackdrop').hidden = false;
  document.body.style.overflow = 'hidden';
}
function closeModal() { $('#modalBackdrop').hidden = true; document.body.style.overflow = ''; }
function showLocationPicker() {
  const locations = ['Lagos', 'Abuja', 'Accra', 'All locations'];
  showModal(`<div class="flow-modal location-picker"><div class="flow-heading"><button class="back-button" data-action="close-modal" aria-label="Close location picker">←</button><div><h2 id="modalTitle">Choose a location</h2><p>See live events in the city you have in mind.</p></div></div><div class="location-options">${locations.map(city => `<button class="location-option ${state.location === city ? 'selected' : ''}" data-action="select-location" data-city="${escapeHTML(city)}"><span class="location-pin">⌖</span><span><strong>${escapeHTML(city)}</strong><small>${city === 'All locations' ? 'Browse every city' : `Events around ${escapeHTML(city)}`}</small></span><span class="location-check">${state.location === city ? '✓' : '›'}</span></button>`).join('')}</div></div>`);
}
function showEventDetail(event) {
  if (!event) return;
  state.selectedEvent = event;
  state.reservedSeats = [];
  state.selectedType = event.ticketTypes[0]?.id || 'standard';
  state.selectedSeats = [];
  state.quantity = 1;
  const soldOut = event.ticketTypes.length === 0;
  showModal(`<div class="detail-hero" style="background-image:url('${escapeHTML(event.hero)}')"><div class="detail-hero-copy"><p class="eyebrow">${escapeHTML(event.category)} · ${escapeHTML(event.city)}</p><h2 id="modalTitle">${escapeHTML(event.title)}</h2><p>${escapeHTML(event.tagline)}</p></div></div><div class="detail-body"><div class="detail-columns"><div><h3>Make a night of it</h3><p class="detail-description">${escapeHTML(event.description)}</p><div class="event-facts"><span>▣ ${escapeHTML(event.date)}</span><span>⌖ ${escapeHTML(event.venue)}, ${escapeHTML(event.city)}</span><span>✓ Verified tickets</span></div></div><aside class="detail-buy-panel"><span class="price-start">Tickets from</span><strong>${money(Math.min(...event.ticketTypes.map(type => type.price)))}</strong><small>${soldOut ? 'This event is currently sold out.' : 'Fees shown before you place your order.'}</small><button class="primary-button" data-action="choose-seats" ${soldOut ? 'disabled' : ''}>${soldOut ? 'Sold out' : 'Choose tickets →'}</button></aside></div></div>`);
}
function sectionForType(typeId) { return typeId === 'premium' ? 'A' : typeId === 'resale' ? 'R' : 'B'; }
function seatsMarkup(event) {
  const selectedType = event.ticketTypes.find(type => type.id === state.selectedType) || event.ticketTypes[0];
  const options = event.ticketTypes.map(type => `<button class="ticket-option ${state.selectedType === type.id ? 'selected' : ''}" data-action="ticket-type" data-type="${escapeHTML(type.id)}"><span><strong>${escapeHTML(type.label)}</strong><small>Unlimited availability</small></span><b>${money(type.price)}</b></button>`).join('');
  const maximum = 6;
  state.quantity = Math.min(state.quantity, maximum);
  return `<div class="flow-heading"><button class="back-button" data-action="back-to-detail" aria-label="Back to event">←</button><div><h2 id="modalTitle">Choose tickets</h2><p>${escapeHTML(event.title)} · ${escapeHTML(event.date)} · ${escapeHTML(event.venue)}</p></div></div><div class="seat-flow-grid ticket-quantity-flow"><div class="seat-options">${options}</div><div><div class="seat-summary"><div><span>Ticket delivery</span><strong>Added to your wallet after confirmation</strong></div><div><span>Quantity</span><strong><select id="ticketQuantity" aria-label="Ticket quantity">${Array.from({ length: maximum }, (_, index) => `<option value="${index + 1}" ${state.quantity === index + 1 ? 'selected' : ''}>${index + 1}</option>`).join('')}</select></strong></div><button class="primary-button" data-action="go-checkout">Continue <span>→</span></button></div><p class="seat-note">Tickets are issued immediately. No payment is collected.</p></div></div>`;
}
function showSeatSelection() { if (state.selectedEvent) showModal(seatsMarkup(state.selectedEvent)); }
async function loadReservedSeats(eventId) {
  const result = await api(`/api/events/${encodeURIComponent(eventId)}/seats`);
  state.reservedSeats = result.reservedSeats || [];
}
function totals() {
  const type = state.selectedEvent.ticketTypes.find(item => item.id === state.selectedType) || state.selectedEvent.ticketTypes[0];
  const subtotal = type.price * state.quantity;
  const serviceFee = Math.round(subtotal * .12);
  const facilityFee = Math.round(subtotal * .067);
  return { type, subtotal, serviceFee, facilityFee, total: subtotal + serviceFee + facilityFee };
}
function showCheckout() {
  if (!state.selectedEvent) return;
  const amount = totals();
  const event = state.selectedEvent;
  showModal(`<div class="checkout-flow"><div class="flow-heading"><button class="back-button" data-action="back-to-seats" aria-label="Back to ticket selection">←</button><div><h2 id="modalTitle">Review tickets</h2><p>Confirm your event and ticket details.</p></div></div><div class="checkout-grid"><section class="checkout-box"><h3>Order summary</h3><div class="checkout-event">${imgTag(event.poster, event.title)}<div><strong>${escapeHTML(event.shortTitle || event.title)}</strong><small>${escapeHTML(event.date)}<br>${escapeHTML(event.venue)}, ${escapeHTML(event.city)}</small></div></div><div class="summary-line"><span>${escapeHTML(amount.type.label)} × ${state.quantity}</span><strong>${money(amount.subtotal)}</strong></div><div class="summary-line"><span>Service fee</span><strong>${money(amount.serviceFee)}</strong></div><div class="summary-line"><span>Facility fee</span><strong>${money(amount.facilityFee)}</strong></div><div class="summary-line total"><span>Displayed total</span><strong>${money(amount.total)}</strong></div></section><section class="checkout-box"><h3>No payment required</h3><p class="flow-subtitle">Prices are shown for the event, but this demo does not collect money. Tickets are added to your wallet immediately.</p><button class="primary-button" data-action="place-order" ${state.submitting ? 'disabled' : ''}>Add tickets to wallet <span>→</span></button><div class="secure-note">Your ticket details and event date will be saved to your account.</div></section></div></div>`);
}
function showConfirmation(order) {
  state.currentOrder = order;
  const event = orderEvent(order);
  const qr = apiURL(`/api/qr?data=${encodeURIComponent(order.code || order.id)}`);
  showModal(`<div class="confirmation-flow"><div class="success-check">✓</div><h2 id="modalTitle">Order confirmed!</h2><p>Your plans are set. We’ve added your tickets to the wallet.</p><div class="confirmation-ticket">${imgTag(event?.poster, order.title)}<div><strong>${escapeHTML(order.title)}</strong><small>${escapeHTML(order.date)}<br>${escapeHTML(order.venue)}</small></div><img class="ticket-qr" src="${qr}" alt="Scannable QR ticket"></div><div class="confirmation-code">Order #${escapeHTML(order.code || order.id)}</div><div class="confirmation-actions"><button class="primary-button" data-action="view-confirmed-ticket">View tickets</button><button class="outline-button" data-action="close-and-discover">Back to events</button></div></div>`);
}
function showTransfer(order) {
  const event = orderEvent(order);
  showModal(`<div class="flow-modal"><div class="flow-heading"><button class="back-button" data-action="close-modal" aria-label="Close transfer form">←</button><div><h2 id="modalTitle">Transfer tickets</h2><p>Send a little something to someone you like.</p></div></div><div class="flow-event-summary">${imgTag(event?.poster, order.title)}<div><strong>${escapeHTML(order.title)}</strong><small>${escapeHTML(order.seat || order.date)} · Order ${escapeHTML(order.id)}</small></div></div><p class="flow-subtitle">Choose the tickets to share, then tell us who they’re for.</p><form id="transferForm" class="flow-form"><input type="hidden" name="orderId" value="${escapeHTML(order.id)}"><label>Recipient first name<input name="recipientFirstName" placeholder="First name" required></label><label>Recipient last name<input name="recipientLastName" placeholder="Last name" required></label><label>Recipient email or phone<input name="recipientContact" placeholder="name@email.com or phone number" required></label><label>Optional message<textarea name="message" placeholder="Add a note for your friend"></textarea></label><button class="primary-button" type="submit">Review transfer <span>→</span></button></form></div>`);
}
function showSell(order) {
  const event = orderEvent(order);
  const quantity = Math.max(1, Math.min(order.quantity || 1, 6));
  showModal(`<div class="flow-modal"><div class="flow-heading"><button class="back-button" data-action="close-modal" aria-label="Close listing form">←</button><div><h2 id="modalTitle">Sell tickets</h2><p>List your ticket with a clear, fair price.</p></div></div><div class="flow-event-summary">${imgTag(event?.poster, order.title)}<div><strong>${escapeHTML(order.title)}</strong><small>${escapeHTML(order.seat || order.date)} · ${escapeHTML(order.ticketType || 'Ticket')}</small></div></div><form id="sellForm" class="flow-form"><input type="hidden" name="orderId" value="${escapeHTML(order.id)}"><label>Set asking price per ticket<input name="askingPrice" type="number" min="1" step="1" value="125" required></label><label>Quantity<select name="quantity">${Array.from({ length: quantity }, (_, index) => `<option value="${index + 1}" ${index === 0 ? 'selected' : ''}>${index + 1} ticket${index ? 's' : ''}</option>`).join('')}</select></label><div class="price-estimate"><span>Estimated payout after marketplace fees</span><strong id="payoutEstimate">$115.00</strong></div><button class="primary-button" type="submit">Publish listing <span>→</span></button></form></div>`);
  const price = $('input[name="askingPrice"]', $('#modalBody'));
  price.addEventListener('input', () => { $('#payoutEstimate').textContent = money(Math.max(0, Number(price.value) * .92)); });
}
function fillProfile() {
  if (!state.profile) return;
  const form = $('#profileForm');
  for (const [key, value] of Object.entries(state.profile)) {
    const field = form.elements.namedItem(key);
    if (field) field.value = value;
  }
  $('#profileName').textContent = `${state.profile.firstName} ${state.profile.lastName}`;
  $('#profileEmail').textContent = state.profile.email;
}
async function refreshData() {
  const [events, favorites, orders, notifications, profile] = await Promise.all([
    api('/api/events'), api('/api/favorites'), api('/api/orders'), api('/api/notifications'), api('/api/profile')
  ]);
  state.events = events;
  state.favorites = favorites;
  state.orders = orders;
  state.notifications = notifications;
  state.profile = profile;
  renderAll();
  fillProfile();
}
async function setFavorite(id) {
  const saved = !state.favorites.includes(id);
  const result = await api(`/api/favorites/${encodeURIComponent(id)}`, { method: 'POST', body: JSON.stringify({ saved }) });
  state.favorites = result.favorites;
  renderDiscover(); renderFavorites();
  notify(saved ? 'Saved to your favorites.' : 'Removed from your favorites.');
}
async function placeOrder() {
  if (state.submitting) return;
  const amount = totals();
  state.submitting = true;
  try {
    const order = await api('/api/orders', {
      method: 'POST',
      body: JSON.stringify({ eventId: state.selectedEvent.id, ticketType: amount.type.id, quantity: state.quantity })
    });
    state.orders = await api('/api/orders');
    state.events = await api('/api/events');
    state.notifications = await api('/api/notifications');
    renderAll();
    showConfirmation(order);
  } catch (error) {
    state.submitting = false;
    showCheckout();
    notify(error.message);
  } finally {
    state.submitting = false;
  }
}
async function markAllRead() {
  await api('/api/notifications/read', { method: 'POST', body: JSON.stringify({}) });
  state.notifications = await api('/api/notifications');
  renderNotifications(); renderNotificationPage();
  notify('All notifications marked as read.');
}

$('#searchInput').addEventListener('input', event => {
  state.search = event.target.value;
  if (state.view !== 'discover') navChange('discover');
  renderDiscover();
});
$('#searchInput').addEventListener('keydown', event => {
  if (event.key === 'Escape') { event.currentTarget.value = ''; state.search = ''; renderDiscover(); }
});
$$('.category-chip').forEach(button => button.addEventListener('click', () => {
  state.category = button.dataset.category;
  $$('.category-chip').forEach(chip => chip.classList.toggle('selected', chip === button));
  renderDiscover();
}));
$('#mobileMenuButton').addEventListener('click', () => {
  const expanded = $('#mobileMenuButton').getAttribute('aria-expanded') === 'true';
  $('#mobileMenuButton').setAttribute('aria-expanded', String(!expanded));
  $('#mobileNav').classList.toggle('menu-open', !expanded);
});
$('#notificationButton').addEventListener('click', () => { $('#notificationsPopover').hidden = !$('#notificationsPopover').hidden; });
$('#locationButton').addEventListener('click', showLocationPicker);
$('#locationButtonLarge').addEventListener('click', showLocationPicker);
$('#accountButton').addEventListener('click', () => navChange('account'));
$('#modalBackdrop').addEventListener('click', event => { if (event.target === $('#modalBackdrop')) closeModal(); });
document.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); $('#searchInput').focus(); }
  if (event.key === 'Escape') { closeModal(); $('#notificationsPopover').hidden = true; }
});
document.addEventListener('click', async event => {
  const button = event.target.closest('[data-action], [data-nav], [data-ticket-tab]');
  if (!button) return;
  try {
    if (button.dataset.nav) { event.preventDefault(); navChange(button.dataset.nav); return; }
    if (button.dataset.ticketTab) {
      state.ticketTab = button.dataset.ticketTab;
      $$('[data-ticket-tab]').forEach(tab => tab.classList.toggle('active', tab === button));
      renderTickets();
      return;
    }
    const id = button.dataset.id;
    switch (button.dataset.action) {
      case 'event-detail': if (!button.closest('.favorite-toggle')) showEventDetail(findEvent(id)); break;
      case 'buy-event': event.stopPropagation(); if (!button.disabled) showEventDetail(findEvent(id)); break;
      case 'favorite': event.stopPropagation(); await setFavorite(id); break;
      case 'show-all':
        state.category = 'All';
        $$('.category-chip').forEach(chip => chip.classList.toggle('selected', chip.dataset.category === 'All'));
        $('#searchInput').value = ''; state.search = ''; renderDiscover(); break;
      case 'choose-location': showLocationPicker(); break;
      case 'select-location':
        state.location = button.dataset.city;
        closeModal(); renderDiscover();
        notify(state.location === 'All locations' ? 'Showing events in every city.' : `Showing events in ${state.location}.`);
        break;
      case 'choose-seats': showSeatSelection(); break;
      case 'back-to-detail': showEventDetail(state.selectedEvent); break;
      case 'select-seat': {
        const seat = button.dataset.seat;
        if (state.selectedSeats.includes(seat)) state.selectedSeats = state.selectedSeats.filter(item => item !== seat);
        else if (state.selectedSeats.length >= state.quantity) notify(`Your ticket quantity is ${state.quantity}. Change it to select more seats.`);
        else state.selectedSeats = [...state.selectedSeats, seat];
        showSeatSelection();
        break;
      }
      case 'ticket-type':
        state.quantity = Number($('#ticketQuantity')?.value || 1);
        state.selectedType = button.dataset.type;
        state.selectedSeats = [];
        showSeatSelection();
        break;
      case 'go-checkout': state.quantity = Number($('#ticketQuantity')?.value || 1); showCheckout(); break;
      case 'back-to-seats': showSeatSelection(); break;
      case 'place-order': await placeOrder(); break;
      case 'close-modal': closeModal(); break;
      case 'close-and-discover': closeModal(); navChange('discover'); break;
      case 'view-confirmed-ticket': closeModal(); navChange('tickets'); break;
      case 'open-ticket': { const order = state.orders.find(item => item.id === id); if (order) showConfirmation(order); break; }
      case 'transfer': { const order = state.orders.find(item => item.id === id); if (order) showTransfer(order); break; }
      case 'sell': { const order = state.orders.find(item => item.id === id); if (order) showSell(order); break; }
      case 'close-notifications': $('#notificationsPopover').hidden = true; break;
      case 'mark-read': await markAllRead(); break;
      case 'payment-method': notify('Payment method management is coming soon.'); break;
      case 'security': notify('Your security settings will be available here.'); break;
      case 'logout': await signOut(); break;
      case 'forgot-password': setAuthMode('forgot'); break;
      case 'retry-load': await refreshData(); break;
      default: break;
    }
  } catch (error) { notify(error.message || 'Something went wrong.'); }
});
$('#modalBody').addEventListener('change', event => {
  if (event.target.id === 'ticketQuantity') {
    state.quantity = Number(event.target.value);
    state.selectedSeats = state.selectedSeats.slice(0, state.quantity);
    showSeatSelection();
  }
});
$('#modalBody').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.target;
  const data = Object.fromEntries(new FormData(form));
  try {
    if (form.id === 'transferForm') {
      await api('/api/transfers', { method: 'POST', body: JSON.stringify(data) });
      state.notifications = await api('/api/notifications');
      renderNotifications(); closeModal(); notify('Transfer invitation sent.');
    } else if (form.id === 'sellForm') {
      await api('/api/listings', { method: 'POST', body: JSON.stringify({ ...data, askingPrice: Number(data.askingPrice), quantity: Number(data.quantity) }) });
      closeModal(); state.ticketTab = 'listings';
      $$('[data-ticket-tab]').forEach(tab => tab.classList.toggle('active', tab.dataset.ticketTab === 'listings'));
      navChange('tickets'); notify('Your listing has been published.');
    }
  } catch (error) { notify(error.message); }
});
$('#profileForm').addEventListener('submit', async event => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.currentTarget));
  try {
    state.profile = await api('/api/profile', { method: 'PUT', body: JSON.stringify(data) });
    fillProfile(); $('#profileMessage').textContent = 'Your changes are saved.';
  } catch (error) { $('#profileMessage').textContent = error.message; }
});

document.addEventListener('click', event => {
  const trigger = event.target.closest('[data-auth-mode]');
  if (trigger) { event.preventDefault(); setAuthMode(trigger.dataset.authMode); }
});

$('#loginForm').addEventListener('submit', async event => {
  event.preventDefault();
  setAuthMessage('');
  const submit = $('button[type="submit"]', event.currentTarget);
  submit.disabled = true;
  try {
    const data = Object.fromEntries(new FormData(event.currentTarget));
    const result = await api('/api/auth/login', { method: 'POST', body: JSON.stringify(data) });
    saveAuthToken(result.token, result.refreshToken, $('#rememberMe').checked);
    await showDashboard(result.user);
  } catch (error) { setAuthMessage(error.message); }
  finally { submit.disabled = false; }
});

$('#signupForm').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  setAuthMessage('');
  const data = Object.fromEntries(new FormData(form));
  if (data.password !== data.confirmPassword) { setAuthMessage('Those passwords do not match.'); return; }
  const submit = $('button[type="submit"]', form);
  submit.disabled = true;
  try {
    const result = await api('/api/auth/signup', { method: 'POST', body: JSON.stringify({ firstName: data.firstName, lastName: data.lastName, email: data.email, phone: data.phone, password: data.password }) });
    if (result.requiresEmailVerification) {
      form.reset();
      setAuthMode('login');
      setAuthMessage(result.message, 'success');
      return;
    }
    saveAuthToken(result.token, result.refreshToken);
    await showDashboard(result.user);
  } catch (error) { setAuthMessage(error.message); }
  finally { submit.disabled = false; }
});

$('#forgotForm').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  setAuthMessage('');
  const submit = $('button[type="submit"]', form);
  submit.disabled = true;
  try {
    const data = Object.fromEntries(new FormData(form));
    const result = await api('/api/auth/forgot-password', { method: 'POST', body: JSON.stringify(data) });
    form.reset();
    setAuthMessage(result.message, 'success');
  } catch (error) { setAuthMessage(error.message); }
  finally { submit.disabled = false; }
});

$('#resetForm').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  setAuthMessage('');
  const data = Object.fromEntries(new FormData(form));
  if (data.password !== data.confirmPassword) { setAuthMessage('Those passwords do not match.'); return; }
  if (!state.recoveryTokens) { setAuthMode('forgot'); setAuthMessage('That reset link is invalid or has expired. Request a new one.'); return; }
  const submit = $('button[type="submit"]', form);
  submit.disabled = true;
  try {
    await api('/api/auth/update-password', { method: 'POST', body: JSON.stringify({ ...state.recoveryTokens, password: data.password }) });
    state.recoveryTokens = null;
    form.reset();
    setAuthMode('login');
    setAuthMessage('Your password has been updated. Sign in with your new password.', 'success');
  } catch (error) { setAuthMessage(error.message); }
  finally { submit.disabled = false; }
});

initializeAuth();
