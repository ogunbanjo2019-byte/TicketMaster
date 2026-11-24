const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const API_BASE_URL = String(window.TICKETPRO_API_BASE_URL || '').replace(/\/+$/, '');
const apiURL = path => `${API_BASE_URL}${path}`;
const HOLD_DURATION_SECONDS = 8 * 60;
const CUSTOM_TICKETS_KEY = 'ticketpro-custom-tickets';
const SEEDED_WALLET_KEY = 'ticketpro-wallet-seeded-v1';
const NOTICE_TEXT_KEY = 'ticketpro-notice-text';
const DEFAULT_NOTICE = 'Please note: Your tickets are confirmed. Barcodes will be available closer to the event date.';
const DEFAULT_POSTER = '/assets/events/singer-stage.jpg';
const seatChannel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('ticketpro-seat-sync') : null;

const INITIAL_WALLET_TICKETS = [
  {
    id: 'NK-2027-04-28',
    code: 'NK-428-115',
    title: 'Noah Kahan',
    date: 'Wed, Apr 28, 2027 • 7:00 PM',
    venue: 'U.S. Bank Stadium, Minneapolis, MN',
    quantity: 4,
    seat: 'Sec 115 • Row 12 • Seats 1–4',
    poster: DEFAULT_POSTER,
    ticketType: 'Standard Admission',
    status: 'Confirmed',
    tab: 'upcoming'
  },
  {
    id: 'NK-2027-05-14',
    code: 'NK-514-128',
    title: 'Noah Kahan',
    date: 'Fri, May 14, 2027 • 7:00 PM',
    venue: 'MetLife Stadium, East Rutherford, NJ',
    quantity: 4,
    seat: 'Sec 128 • Row 15 • Seats 1–4',
    poster: DEFAULT_POSTER,
    ticketType: 'Standard Admission',
    status: 'Confirmed',
    tab: 'upcoming'
  },
  {
    id: 'NK-2027-05-29',
    code: 'NK-529-110',
    title: 'Noah Kahan',
    date: 'Sat, May 29, 2027 • 7:00 PM',
    venue: 'Mercedes-Benz Stadium, Atlanta, GA',
    quantity: 4,
    seat: 'Sec 110 • Row 14 • Seats 1–4',
    poster: DEFAULT_POSTER,
    ticketType: 'Standard Admission',
    status: 'Confirmed',
    tab: 'upcoming'
  },
  {
    id: 'NK-2027-07-20',
    code: 'NK-720-120',
    title: 'Noah Kahan',
    date: 'Tue, Jul 20, 2027 • 7:00 PM',
    venue: 'SoFi Stadium, Inglewood, CA',
    quantity: 4,
    seat: 'Sec 120 • Row 13 • Seats 1–4',
    poster: DEFAULT_POSTER,
    ticketType: 'Standard Admission',
    status: 'Confirmed',
    tab: 'upcoming'
  }
];

const state = {
  events: [], favorites: [], orders: [], customTickets: [], notifications: [], listings: [], profile: null,
  view: 'discover', bottomTab: 'home', ticketTab: 'upcoming', category: 'All', search: '', location: 'All U.S. events',
  selectedEvent: null, selectedType: null, selectedSeats: [], quantity: 1, currentOrder: null,
  submitting: false, toastTimer: null, authToken: '', authRefreshToken: '', authUser: null,
  recoveryTokens: null, reservedSeats: [], holdSecondsLeft: 0, holdTimerId: null,
  noticeText: localStorage.getItem(NOTICE_TEXT_KEY) || DEFAULT_NOTICE
};

const money = value => `$${Number(value || 0).toFixed(2)}`;
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const dateIsFuture = order => {
  if (order.tab === 'upcoming') return true;
  if (order.tab === 'past') return false;
  const match = String(order.date || '').match(/([A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2}, \d{4})/);
  return !match || new Date(match[1]) >= new Date(new Date().toDateString());
};

function saveCustomTickets() {
  localStorage.setItem(CUSTOM_TICKETS_KEY, JSON.stringify(state.customTickets));
}

function seedInitialWalletIfEmpty() {
  if (!localStorage.getItem(SEEDED_WALLET_KEY) && state.customTickets.length === 0) {
    state.customTickets = INITIAL_WALLET_TICKETS.map(item => ({ ...item }));
    saveCustomTickets();
    localStorage.setItem(SEEDED_WALLET_KEY, '1');
  }
}

function loadCustomTickets() {
  try {
    const raw = JSON.parse(localStorage.getItem(CUSTOM_TICKETS_KEY) || '[]');
    state.customTickets = Array.isArray(raw) ? raw : [];
  } catch {
    state.customTickets = [];
  }
  seedInitialWalletIfEmpty();
}

function allWalletOrders() {
  return [...state.customTickets, ...state.orders];
}

function formatHoldClock(seconds) {
  const safe = Math.max(0, Number(seconds) || 0);
  const mins = String(Math.floor(safe / 60)).padStart(2, '0');
  const secs = String(safe % 60).padStart(2, '0');
  return `${mins}:${secs}`;
}

function stopHoldClock() {
  if (state.holdTimerId) {
    clearInterval(state.holdTimerId);
    state.holdTimerId = null;
  }
  state.holdSecondsLeft = 0;
}

function startHoldClock() {
  stopHoldClock();
  state.holdSecondsLeft = HOLD_DURATION_SECONDS;
  state.holdTimerId = setInterval(() => {
    state.holdSecondsLeft -= 1;
    $$('.hold-clock-time').forEach(el => { el.textContent = formatHoldClock(state.holdSecondsLeft); });
    if (state.holdSecondsLeft <= 0) {
      stopHoldClock();
      state.selectedSeats = [];
      notify('Your 8-minute seat hold expired. Select seats again.');
      if (!$('#modalBackdrop').hidden && $('#seatMapBox')) {
        showSeatSelection();
      }
    }
  }, 1000);
}

function broadcastReservedSeats(eventId) {
  if (!seatChannel || !eventId) return;
  seatChannel.postMessage({ type: 'SEATS_UPDATED', eventId, reservedSeats: state.reservedSeats });
}

if (seatChannel) {
  seatChannel.onmessage = async ({ data }) => {
    if (data?.type === 'SEATS_UPDATED' && state.selectedEvent?.id === data.eventId) {
      await loadReservedSeats(data.eventId).catch(() => {});
      state.selectedSeats = state.selectedSeats.filter(seat => !state.reservedSeats.includes(seat));
      if (!$('#modalBackdrop').hidden && $('#seatMapBox')) {
        showSeatSelection();
      }
    }
  };
}

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
  loadCustomTickets();
  state.authUser = user;
  $('#authScreen').hidden = true;
  $('.app-shell').hidden = false;
  navChange('discover');
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
  loadCustomTickets();
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
  stopHoldClock();
  clearAuthToken();
  $('.app-shell').hidden = true;
  $('#authScreen').hidden = false;
  $('#loginForm').reset();
  $('#signupForm').reset();
  setAuthMode('login');
}

function findEvent(id) { return state.events.find(event => event.id === id); }
function findTicketById(id) { return allWalletOrders().find(item => item.id === id); }
function orderEvent(order) { return findEvent(order.eventId) || state.events.find(event => event.shortTitle === order.title) || state.events[0]; }

function navChange(view) {
  const allowed = ['discover', 'tickets', 'favorites', 'account', 'notifications'];
  state.view = allowed.includes(view) ? view : 'discover';
  if (!$('#modalBackdrop').hidden) closeModal();
  $$('.view').forEach(section => section.classList.toggle('active', section.id === `view-${state.view}`));
  $$('[data-nav]').forEach(button => button.classList.toggle('active', button.dataset.nav === state.view));
  state.bottomTab = state.view === 'discover' ? 'home' : ['tickets', 'favorites'].includes(state.view) ? state.view : 'more';
  $$('[data-bottom-tab]').forEach(button => button.classList.toggle('active', button.dataset.bottomTab === state.bottomTab));
  $('#notificationsPopover').hidden = true;
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (state.view === 'tickets') renderTickets();
  if (state.view === 'account') fillProfile();
  if (state.view === 'notifications') renderNotificationPage();
}

function imgTag(source, alt, className = '') {
  const safeSrc = escapeHTML(source || DEFAULT_POSTER);
  return `<img class="${className}" src="${safeSrc}" alt="${escapeHTML(alt)}" loading="lazy" onerror="this.onerror=null;this.src='${DEFAULT_POSTER}';">`;
}

function cardForEvent(event) {
  const saved = state.favorites.includes(event.id);
  const soldOut = event.ticketTypes.length === 0;
  return `<article class="event-card" data-action="event-detail" data-id="${escapeHTML(event.id)}" tabindex="0" aria-label="View ${escapeHTML(event.title)}">
    <div class="event-image-wrap">${imgTag(event.poster, event.title)}<span class="event-category">${escapeHTML(event.category)}</span><button class="favorite-toggle ${saved ? 'saved' : ''}" data-action="favorite" data-id="${escapeHTML(event.id)}" aria-label="${saved ? 'Remove from' : 'Add to'} favorites" aria-pressed="${saved}">${saved ? '♥' : '♡'}</button></div>
    <div class="event-card-content"><div class="event-card-title-row"><h3>${escapeHTML(event.shortTitle || event.title)}</h3><span class="event-category-text">${escapeHTML(event.category)}</span></div>
      <div class="event-card-meta"><span>▣ ${escapeHTML(event.date)}</span><span>⌖ ${escapeHTML(event.venue)}, ${escapeHTML(event.city)}</span></div>
      <div class="event-card-foot"><span class="event-price">${soldOut ? '<strong class="sold-out-label">Sold out</strong>' : `From <strong>${money(Math.min(...event.ticketTypes.map(type => type.price)))}</strong>`}</span><button class="event-buy" data-action="buy-event" data-id="${escapeHTML(event.id)}" ${soldOut ? 'disabled' : ''}>${soldOut ? 'Sold out' : 'Choose seats →'}</button></div>
    </div></article>`;
}

function renderDiscover() {
  const locationShort = state.location === 'All U.S. events' ? 'All U.S.' : state.location.split(',')[0];
  $('#locationShort').textContent = locationShort;
  $('#locationLong').textContent = state.location;
  $('#locationButton').setAttribute('aria-label', `Change location, current location ${state.location}`);
  $('#currentLocation').textContent = state.location.toUpperCase();
  const cityAliases = { 'Los Angeles': ['Los Angeles', 'Inglewood'], 'New York City': ['New York City', 'New York'] };
  const selectedCities = cityAliases[state.location.split(',')[0]] || [state.location.split(',')[0]];
  const cityEvents = state.location === 'All U.S. events' ? state.events : state.events.filter(event => selectedCities.some(city => event.city.toLowerCase() === city.toLowerCase()));
  const feature = cityEvents[0];
  if (feature) {
    const soldOut = feature.ticketTypes.length === 0;
    $('#featureEvent').innerHTML = `<article class="hero-card" style="background-image:url('${escapeHTML(feature.hero)}')"><div class="hero-content"><span class="hero-label">✦ FEATURED EVENT</span><h2>${escapeHTML(feature.title)}</h2><p class="hero-tagline">${escapeHTML(feature.tagline)}</p><div class="hero-meta"><span><b>▣</b>${escapeHTML(feature.date)}</span><span><b>⌖</b>${escapeHTML(feature.venue)}, ${escapeHTML(feature.city)}</span></div><div class="hero-bottom"><button class="hero-cta" data-action="choose-event-seats" data-id="${escapeHTML(feature.id)}" ${soldOut ? 'disabled' : ''}>${soldOut ? 'Sold out' : 'Choose seats →'}</button><span class="hero-price">From <strong>${money(Math.min(...feature.ticketTypes.map(type => type.price)))}</strong></span></div></div><button class="hero-arrow" aria-label="See featured event">›</button><div class="hero-dots" aria-hidden="true"><i></i><i></i><i></i></div></article>`;
  } else {
    $('#featureEvent').innerHTML = `<div class="feature-empty"><span class="empty-symbol">⌖</span><strong>No events in ${escapeHTML(state.location)} yet.</strong><span>Choose another location to see what’s on.</span><button class="text-button" data-action="choose-location">Change location →</button></div>`;
  }
  const term = state.search.trim().toLowerCase();
  const filtered = cityEvents.filter(event => (state.category === 'All' || event.category === state.category || (state.category === 'Festival' && event.title.toLowerCase().includes('festival'))) && (!term || `${event.title} ${event.category} ${event.venue} ${event.city}`.toLowerCase().includes(term)));
  $('#eventGrid').innerHTML = filtered.length ? filtered.map(cardForEvent).join('') : `<div class="empty-inline">No events found here. Try another search, category, or location.</div>`;
  const futureOrders = allWalletOrders().filter(dateIsFuture);
  $('#miniTickets').innerHTML = futureOrders.slice(0, 2).map(order => {
    const event = orderEvent(order);
    return `<article class="mini-ticket">${imgTag(order.poster || event?.poster, order.title)}<div class="mini-ticket-body"><h3>${escapeHTML(order.title)}</h3><p>${escapeHTML(order.date)}<br>${escapeHTML(order.venue)}</p><span class="status-pill">${escapeHTML(order.status || 'Confirmed')}</span><div class="mini-ticket-actions"><button data-action="open-ticket" data-id="${escapeHTML(order.id)}">View pass →</button></div></div></article>`;
  }).join('') || `<div class="empty-inline">Your next night out starts here.</div>`;
  $('#ticketCount').textContent = futureOrders.length;
}

function userInitials() {
  const first = state.profile?.firstName || state.authUser?.firstName || '';
  const last = state.profile?.lastName || state.authUser?.lastName || '';
  return [first, last].filter(Boolean).map(n => String(n).trim().charAt(0)).join('').toUpperCase() || 'MI';
}

function mobileTicketRow(order) {
  const event = orderEvent(order);
  const count = Number(order.quantity || 1);
  const seatLine = order.seat || (Array.isArray(order.seats) && order.seats.length ? `Seats ${order.seats.join(', ')}` : `Sec B • Row A • ${count} Ticket${count === 1 ? '' : 's'}`);
  return `<div class="tm-ticket-row" data-action="open-ticket" data-id="${escapeHTML(order.id)}">
    ${imgTag(order.poster || event?.poster, order.title, 'tm-ticket-thumb')}
    <div class="tm-ticket-main">
      <h3 class="tm-ticket-title">${escapeHTML(order.title)}</h3>
      <div class="tm-ticket-meta">${escapeHTML(order.date)}</div>
      <div class="tm-ticket-meta">⌖ ${escapeHTML(order.venue)}</div>
      <div class="tm-ticket-seats">▣ ${escapeHTML(count)} Ticket${count === 1 ? '' : 's'}</div>
      <div class="tm-ticket-subseats">${escapeHTML(seatLine)}</div>
    </div>
    <div class="tm-ticket-row-right">
      <button type="button" class="tm-inline-edit" data-action="edit-ticket" data-id="${escapeHTML(order.id)}" title="Edit ticket in browser">Edit</button>
      <span class="tm-chevron" aria-hidden="true">›</span>
    </div>
  </div>`;
}

async function renderTickets() {
  const list = $('#ticketPageList');
  if (state.ticketTab === 'listings') {
    try { state.listings = await api('/api/listings'); } catch { state.listings = []; }
    const rowsHTML = state.listings.length
      ? state.listings.map(item => `<div class="notification-row"><span class="notification-symbol blue">↗</span><div class="notification-copy"><strong>${escapeHTML(item.title)}</strong><p>${escapeHTML(item.quantity)} ticket${item.quantity === 1 ? '' : 's'} · Asking ${money(item.askingPrice)} each</p><small>${escapeHTML(item.createdAt?.slice(0, 10) || '')}</small></div><span class="listing-status">${escapeHTML(item.status)}</span></div>`).join('')
      : `<div class="empty-state"><div class="empty-symbol">↗</div><h2>No listings just yet.</h2><p>Put a ticket up for resale from your wallet.</p></div>`;
    list.innerHTML = `<div class="tm-wallet-shell">
      <div class="tm-wallet-header">
        <div class="tm-wallet-toprow">
          <span class="tm-wallet-brand">ticketpro</span>
          <div class="tm-wallet-actions">
            <button type="button" class="tm-wallet-btn" data-action="add-ticket">+ Add Ticket</button>
            <span class="tm-wallet-badge">${escapeHTML(userInitials())}</span>
          </div>
        </div>
        <h2 class="tm-wallet-title">My Tickets</h2>
        <div class="tm-wallet-tabs">
          <button type="button" class="tm-wallet-tab" data-ticket-tab="upcoming">Upcoming</button>
          <button type="button" class="tm-wallet-tab" data-ticket-tab="past">Past Events</button>
          <button type="button" class="tm-wallet-tab active" data-ticket-tab="listings">My Listings</button>
        </div>
      </div>
      <div class="tm-wallet-body">${rowsHTML}</div>
    </div>`;
    return;
  }

  const allOrders = allWalletOrders();
  const selected = allOrders.filter(order => state.ticketTab === 'past' ? !dateIsFuture(order) : dateIsFuture(order));
  $('#upcomingCount').textContent = allOrders.filter(dateIsFuture).length;

  const listBody = selected.length
    ? selected.map(mobileTicketRow).join('')
    : `<div class="empty-state"><div class="empty-symbol">▣</div><h2>${state.ticketTab === 'past' ? 'Your first encore is still ahead.' : 'Nothing on the calendar yet.'}</h2><p>${state.ticketTab === 'past' ? 'After your next show, it’ll be remembered here.' : 'Add a ticket in the browser or pick seats on an event.'}</p><button class="primary-button" data-action="add-ticket">+ Add Ticket in Browser</button></div>`;

  list.innerHTML = `<div class="tm-wallet-shell">
    <div class="tm-wallet-header">
      <div class="tm-wallet-toprow">
        <span class="tm-wallet-brand">ticketpro</span>
        <div class="tm-wallet-actions">
          <button type="button" class="tm-wallet-btn" data-action="add-ticket">+ Add Ticket</button>
          <button type="button" class="tm-wallet-btn" data-action="edit-notice">Edit Notice</button>
          <span class="tm-wallet-badge">${escapeHTML(userInitials())}</span>
        </div>
      </div>
      <h2 class="tm-wallet-title">My Tickets</h2>
      <div class="tm-wallet-tabs">
        <button type="button" class="tm-wallet-tab ${state.ticketTab === 'upcoming' ? 'active' : ''}" data-ticket-tab="upcoming">Upcoming</button>
        <button type="button" class="tm-wallet-tab ${state.ticketTab === 'past' ? 'active' : ''}" data-ticket-tab="past">Past Events</button>
        <button type="button" class="tm-wallet-tab" data-ticket-tab="listings">My Listings</button>
      </div>
    </div>
    <div class="tm-wallet-body">
      ${listBody}
      <div class="tm-notice-banner" role="note">
        <span class="tm-notice-icon" aria-hidden="true">⚠</span>
        <div>
          <strong>Please note:</strong>
          <span>${escapeHTML(state.noticeText)}</span>
        </div>
      </div>
    </div>
  </div>`;
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

function closeModal() {
  $('#modalBackdrop').hidden = true;
  document.body.style.overflow = '';
}

function showLocationPicker() {
  const locations = ['New York City, NY', 'Los Angeles, CA', 'Las Vegas, NV', 'Chicago, IL', 'Atlanta, GA', 'Nashville, TN', 'Denver, CO', 'Miami, FL', 'Minneapolis, MN', 'All U.S. events'];
  showModal(`<div class="flow-modal location-picker"><div class="flow-heading"><button class="back-button" data-action="close-modal" aria-label="Close location picker">←</button><div><h2 id="modalTitle">Choose a location</h2><p>See live events in the city you have in mind.</p></div></div><div class="location-options">${locations.map(city => `<button class="location-option ${state.location === city ? 'selected' : ''}" data-action="select-location" data-city="${escapeHTML(city)}"><span class="location-pin">⌖</span><span><strong>${escapeHTML(city)}</strong><small>${city === 'All U.S. events' ? 'Browse live events nationwide' : `Events around ${escapeHTML(city)}`}</small></span><span class="location-check">${state.location === city ? '✓' : '›'}</span></button>`).join('')}</div></div>`);
}

function showEventDetail(event) {
  if (!event) return;
  state.selectedEvent = event;
  state.reservedSeats = [];
  state.selectedType = event.ticketTypes[0]?.id || 'standard';
  state.selectedSeats = [];
  state.quantity = 1;
  const soldOut = event.ticketTypes.length === 0;
  showModal(`<div class="detail-hero" style="background-image:url('${escapeHTML(event.hero)}')"><div class="detail-hero-copy"><p class="eyebrow">${escapeHTML(event.category)} · ${escapeHTML(event.city)}</p><h2 id="modalTitle">${escapeHTML(event.title)}</h2><p>${escapeHTML(event.tagline)}</p></div></div><div class="detail-body"><div class="detail-columns"><div><h3>Make a night of it</h3><p class="detail-description">${escapeHTML(event.description)}</p><div class="event-facts"><span>▣ ${escapeHTML(event.date)}</span><span>⌖ ${escapeHTML(event.venue)}, ${escapeHTML(event.city)}</span><span>✓ Live seat map &amp; 8-min hold clock</span></div></div><aside class="detail-buy-panel"><span class="price-start">Tickets from</span><strong>${money(Math.min(...event.ticketTypes.map(type => type.price)))}</strong><small>${soldOut ? 'This event is currently sold out.' : 'Select seats and hold for 8:00. No payment collected.'}</small><button class="primary-button" data-action="choose-seats" ${soldOut ? 'disabled' : ''}>Choose seats <span>→</span></button></aside></div></div>`);
}

function sectionForType(typeId) { return typeId === 'premium' ? 'A' : typeId === 'resale' ? 'R' : 'B'; }

async function loadReservedSeats(eventId) {
  try {
    const result = await api(`/api/events/${encodeURIComponent(eventId)}/seats`);
    state.reservedSeats = Array.isArray(result.reservedSeats) ? result.reservedSeats : [];
  } catch {
    state.reservedSeats = [];
  }
}

function seatsMarkup(event) {
  const options = event.ticketTypes.map(type => `<button class="ticket-option ${state.selectedType === type.id ? 'selected' : ''}" data-action="ticket-type" data-type="${escapeHTML(type.id)}"><span><strong>${escapeHTML(type.label)}</strong><small>Live seat availability</small></span><b>${money(type.price)}</b></button>`).join('');
  const maximum = 6;
  state.quantity = Math.min(state.quantity, maximum);
  const rows = ['A', 'B', 'C', 'D', 'E', 'F'];
  const cols = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const taken = new Set(state.reservedSeats || []);
  const prefix = sectionForType(state.selectedType);

  const mapGrid = rows.map((row, rIdx) => `<div class="seat-row">
    <span class="seat-row-label">${row}</span>
    <div class="seat-row-buttons">${cols.map(col => {
      const code = `${prefix}-${row}${col}`;
      const isSold = taken.has(code);
      const isChosen = state.selectedSeats.includes(code);
      const isPremium = rIdx < 2;
      return `<button type="button" class="seat-dot ${isPremium ? 'premium-seat' : ''} ${isSold ? 'sold-seat' : ''} ${isChosen ? 'chosen' : ''}" data-action="select-seat" data-seat="${escapeHTML(code)}" ${isSold ? 'disabled' : ''} title="${escapeHTML(code)}" aria-label="Seat ${escapeHTML(code)}"></button>`;
    }).join('')}</div>
  </div>`).join('');

  const clockBanner = state.holdSecondsLeft > 0
    ? `<div class="hold-banner" id="holdClockBanner"><span>Seat hold timer</span><strong class="hold-clock-time">${formatHoldClock(state.holdSecondsLeft)}</strong></div>`
    : `<div class="hold-banner" id="holdClockBanner"><span>8-minute hold starts when you pick a seat</span><strong class="hold-clock-time">08:00</strong></div>`;

  return `<div class="seat-flow" id="seatMapBox">
    <div class="flow-heading"><button class="back-button" data-action="back-to-detail" aria-label="Back to event">←</button><div><h2 id="modalTitle">Choose seats</h2><p>${escapeHTML(event.title)} · ${escapeHTML(event.date)} · ${escapeHTML(event.venue)}</p></div></div>
    ${clockBanner}
    <div class="seat-flow-grid">
      <div>
        <div class="seat-map">
          <div class="stage-label">STAGE</div>
          <div class="seat-rows">${mapGrid}</div>
          <div class="seat-legend">
            <span><i class="legend-standard"></i>Available</span>
            <span><i class="legend-premium"></i>Front tier</span>
            <span><i class="legend-sold"></i>Reserved</span>
            <span><i style="background:#23ab72"></i>Selected</span>
          </div>
        </div>
      </div>
      <div>
        <div class="seat-options">${options}</div>
        <div class="seat-summary">
          <div><span>Quantity</span><strong><select id="ticketQuantity" aria-label="Ticket quantity">${Array.from({ length: maximum }, (_, index) => `<option value="${index + 1}" ${state.quantity === index + 1 ? 'selected' : ''}>${index + 1}</option>`).join('')}</select></strong></div>
          <div><span>Selected seats</span><strong class="selected-seat-text">${escapeHTML(state.selectedSeats.length ? state.selectedSeats.join(', ') : 'Pick on map')}</strong></div>
          <button class="primary-button" data-action="go-checkout">Continue <span>→</span></button>
        </div>
        <p class="seat-note">Zero-payment reservation: seats hold for 8:00 and add straight to your wallet.</p>
      </div>
    </div>
  </div>`;
}

async function openSeatSelectionForEvent(event) {
  if (!event) return;
  state.selectedEvent = event;
  state.selectedType = event.ticketTypes[0]?.id || 'standard';
  state.selectedSeats = [];
  state.quantity = 1;
  await loadReservedSeats(event.id);
  showSeatSelection();
}

function showSeatSelection() {
  if (state.selectedEvent) showModal(seatsMarkup(state.selectedEvent));
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
  const seatSummary = state.selectedSeats.length ? state.selectedSeats.join(', ') : `${state.quantity} ticket${state.quantity === 1 ? '' : 's'}`;
  const timerLine = state.holdSecondsLeft > 0
    ? `<div class="hold-banner"><span>Hold remaining</span><strong class="hold-clock-time">${formatHoldClock(state.holdSecondsLeft)}</strong></div>`
    : '';
  showModal(`<div class="checkout-flow"><div class="flow-heading"><button class="back-button" data-action="back-to-seats" aria-label="Back to ticket selection">←</button><div><h2 id="modalTitle">Review reservation</h2><p>No payment required — confirm to save tickets in your wallet.</p></div></div>${timerLine}<div class="checkout-grid"><section class="checkout-box"><h3>Reservation summary</h3><div class="checkout-event">${imgTag(event.poster, event.title)}<div><strong>${escapeHTML(event.shortTitle || event.title)}</strong><small>${escapeHTML(event.date)}<br>${escapeHTML(event.venue)}, ${escapeHTML(event.city)}</small></div></div><div class="summary-line"><span>${escapeHTML(amount.type.label)} × ${state.quantity}</span><strong>${money(amount.subtotal)}</strong></div><div class="summary-line"><span>Seats</span><strong>${escapeHTML(seatSummary)}</strong></div><div class="summary-line"><span>Service fee</span><strong>${money(amount.serviceFee)}</strong></div><div class="summary-line"><span>Facility fee</span><strong>${money(amount.facilityFee)}</strong></div><div class="summary-line total"><span>Reservation total</span><strong>${money(amount.total)}</strong></div></section><section class="checkout-box"><h3>Ticket wallet</h3><p class="flow-subtitle">Zero payment gateway is used. Confirm to add tickets immediately.</p><button class="primary-button" data-action="place-order" ${state.submitting ? 'disabled' : ''}>Add tickets to wallet <span>→</span></button><div class="secure-note">Your seat selection and pass will appear in My Tickets.</div></section></div></div>`);
}

function showConfirmation(order) {
  state.currentOrder = order;
  const event = orderEvent(order);
  const qr = apiURL(`/api/qr?data=${encodeURIComponent(order.code || order.id)}`);
  showModal(`<div class="confirmation-flow"><div class="success-check">✓</div><h2 id="modalTitle">Tickets confirmed!</h2><p>Your seats are locked in and added to your wallet.</p><div class="confirmation-ticket">${imgTag(order.poster || event?.poster, order.title)}<div><strong>${escapeHTML(order.title)}</strong><small>${escapeHTML(order.date)}<br>${escapeHTML(order.venue)}<br>${escapeHTML(order.seat || '')}</small></div><img class="ticket-qr" src="${qr}" alt="Scannable QR ticket"></div><div class="confirmation-code">Order #${escapeHTML(order.code || order.id)}</div><div class="confirmation-actions"><button class="primary-button" data-action="view-confirmed-ticket">View tickets</button><button class="outline-button" data-action="close-and-discover">Back to events</button></div></div>`);
}

function showTicketEditorModal(existing = null) {
  const isEdit = Boolean(existing);
  const fallbackEvent = existing ? orderEvent(existing) : state.events[0];
  showModal(`<div class="flow-modal">
    <div class="flow-heading">
      <button class="back-button" data-action="close-modal" aria-label="Close editor">←</button>
      <div><h2 id="modalTitle">${isEdit ? 'Edit Ticket in Browser' : 'Add Ticket in Browser'}</h2><p>Edit details directly here without changing any code.</p></div>
    </div>
    <form id="browserTicketForm" class="flow-form">
      ${isEdit ? `<input type="hidden" name="id" value="${escapeHTML(existing.id)}">` : ''}
      <label>Event / Artist Title<input name="title" value="${escapeHTML(existing?.title || fallbackEvent?.title || 'Noah Kahan')}" required></label>
      <div class="form-two">
        <label>Date &amp; Time<input name="date" value="${escapeHTML(existing?.date || 'Wed, Apr 28, 2027 • 7:00 PM')}" required></label>
        <label>Venue &amp; City<input name="venue" value="${escapeHTML(existing?.venue || 'U.S. Bank Stadium, Minneapolis, MN')}" required></label>
      </div>
      <div class="form-two">
        <label>Ticket Count<input name="quantity" type="number" min="1" max="50" value="${escapeHTML(existing?.quantity || 4)}" required></label>
        <label>Section / Row / Seats<input name="seat" value="${escapeHTML(existing?.seat || 'Sec 115 • Row 12 • Seats 1–4')}" required></label>
      </div>
      <div class="form-two">
        <label>Poster Image URL<input name="poster" value="${escapeHTML(existing?.poster || fallbackEvent?.poster || DEFAULT_POSTER)}"></label>
        <label>Tab<select name="tab">
          <option value="upcoming" ${(!existing || dateIsFuture(existing)) ? 'selected' : ''}>Upcoming</option>
          <option value="past" ${existing && !dateIsFuture(existing) ? 'selected' : ''}>Past Events</option>
        </select></label>
      </div>
      <label>Bottom Notice Banner<input name="noticeText" value="${escapeHTML(state.noticeText)}"></label>
      <button class="primary-button" type="submit">${isEdit ? 'Save Ticket Changes' : 'Add Ticket to Wallet'}</button>
    </form>
  </div>`);
}

function showNoticeEditorModal() {
  showModal(`<div class="flow-modal">
    <div class="flow-heading">
      <button class="back-button" data-action="close-modal" aria-label="Close notice editor">←</button>
      <div><h2 id="modalTitle">Edit Notice Banner</h2><p>Customize the yellow message shown at the bottom of My Tickets.</p></div>
    </div>
    <form id="noticeBannerForm" class="flow-form">
      <label>Notice Message<textarea name="noticeText" required>${escapeHTML(state.noticeText)}</textarea></label>
      <button class="primary-button" type="submit">Save Notice</button>
    </form>
  </div>`);
}

function showTransfer(order) {
  const event = orderEvent(order);
  showModal(`<div class="flow-modal"><div class="flow-heading"><button class="back-button" data-action="close-modal" aria-label="Close transfer form">←</button><div><h2 id="modalTitle">Transfer tickets</h2><p>Send a little something to someone you like.</p></div></div><div class="flow-event-summary">${imgTag(order.poster || event?.poster, order.title)}<div><strong>${escapeHTML(order.title)}</strong><small>${escapeHTML(order.seat || order.date)} · Order ${escapeHTML(order.id)}</small></div></div><p class="flow-subtitle">Choose the tickets to share, then tell us who they’re for.</p><form id="transferForm" class="flow-form"><input type="hidden" name="orderId" value="${escapeHTML(order.id)}"><label>Recipient first name<input name="recipientFirstName" placeholder="First name" required></label><label>Recipient last name<input name="recipientLastName" placeholder="Last name" required></label><label>Recipient email or phone<input name="recipientContact" placeholder="name@email.com or phone number" required></label><label>Optional message<textarea name="message" placeholder="Add a note for your friend"></textarea></label><button class="primary-button" type="submit">Review transfer <span>→</span></button></form></div>`);
}

function showSell(order) {
  const event = orderEvent(order);
  const quantity = Math.max(1, Math.min(order.quantity || 1, 6));
  showModal(`<div class="flow-modal"><div class="flow-heading"><button class="back-button" data-action="close-modal" aria-label="Close listing form">←</button><div><h2 id="modalTitle">Sell tickets</h2><p>List your ticket with a clear, fair price.</p></div></div><div class="flow-event-summary">${imgTag(order.poster || event?.poster, order.title)}<div><strong>${escapeHTML(order.title)}</strong><small>${escapeHTML(order.seat || order.date)} · ${escapeHTML(order.ticketType || 'Ticket')}</small></div></div><form id="sellForm" class="flow-form"><input type="hidden" name="orderId" value="${escapeHTML(order.id)}"><label>Set asking price per ticket<input name="askingPrice" type="number" min="1" step="1" value="125" required></label><label>Quantity<select name="quantity">${Array.from({ length: quantity }, (_, index) => `<option value="${index + 1}" ${index === 0 ? 'selected' : ''}>${index + 1} ticket${index ? 's' : ''}</option>`).join('')}</select></label><div class="price-estimate"><span>Estimated payout after marketplace fees</span><strong id="payoutEstimate">$115.00</strong></div><button class="primary-button" type="submit">Publish listing <span>→</span></button></form></div>`);
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
  const initials = userInitials();
  $('#avatarInitials').textContent = initials;
  $('#profileInitials').textContent = initials;
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
  const seats = state.selectedSeats.length
    ? state.selectedSeats
    : Array.from({ length: state.quantity }, (_, idx) => `${sectionForType(state.selectedType)}-A${idx + 1}`);
  state.submitting = true;
  try {
    const order = await api('/api/orders', {
      method: 'POST',
      body: JSON.stringify({
        eventId: state.selectedEvent.id,
        ticketType: amount.type.id,
        quantity: state.quantity,
        seats
      })
    });
    stopHoldClock();
    state.selectedSeats = [];
    state.reservedSeats = [...new Set([...state.reservedSeats, ...seats])];
    broadcastReservedSeats(state.selectedEvent.id);
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
      case 'choose-event-seats': if (!button.disabled) await openSeatSelectionForEvent(findEvent(id)); break;
      case 'explore':
        navChange('discover');
        state.bottomTab = 'explore';
        $$('[data-bottom-tab]').forEach(tab => tab.classList.toggle('active', tab.dataset.bottomTab === state.bottomTab));
        requestAnimationFrame(() => { $('#categoryStrip').scrollIntoView({ behavior: 'smooth', block: 'start' }); $('#searchInput').focus({ preventScroll: true }); });
        break;
      case 'more-menu':
        state.bottomTab = 'more';
        $$('[data-bottom-tab]').forEach(tab => tab.classList.toggle('active', tab.dataset.bottomTab === state.bottomTab));
        showModal(`<div class="flow-modal"><div class="flow-heading"><div><h2 id="modalTitle">More</h2><p>Account and event updates.</p></div><button class="icon-button small" data-action="close-modal" aria-label="Close menu">×</button></div><div class="location-options"><button class="location-option" data-nav="account"><span class="location-pin">◉</span><span><strong>Account</strong><small>Profile and settings</small></span><span class="location-check">›</span></button><button class="location-option" data-nav="notifications"><span class="location-pin">♧</span><span><strong>Notifications</strong><small>Ticket and event updates</small></span><span class="location-check">›</span></button><button class="location-option" data-action="add-ticket"><span class="location-pin">+</span><span><strong>Add or Edit Tickets</strong><small>Customize wallet tickets in browser</small></span><span class="location-check">›</span></button></div></div>`);
        break;
      case 'buy-event': event.stopPropagation(); if (!button.disabled) await openSeatSelectionForEvent(findEvent(id)); break;
      case 'favorite': event.stopPropagation(); await setFavorite(id); break;
      case 'show-all':
        state.category = 'All';
        $$('.category-chip').forEach(chip => chip.classList.toggle('selected', chip.dataset.category === 'All'));
        $('#searchInput').value = ''; state.search = ''; renderDiscover(); break;
      case 'choose-location': showLocationPicker(); break;
      case 'select-location':
        state.location = button.dataset.city;
        closeModal(); renderDiscover();
        notify(state.location === 'All U.S. events' ? 'Showing live events across the United States.' : `Showing events in ${state.location}.`);
        break;
      case 'choose-seats':
        if (state.selectedEvent) {
          await loadReservedSeats(state.selectedEvent.id);
          showSeatSelection();
        }
        break;
      case 'back-to-detail': showEventDetail(state.selectedEvent); break;
      case 'select-seat': {
        const seat = button.dataset.seat;
        if (state.reservedSeats.includes(seat)) return;
        if (state.selectedSeats.includes(seat)) {
          state.selectedSeats = state.selectedSeats.filter(item => item !== seat);
          if (!state.selectedSeats.length) stopHoldClock();
        } else if (state.selectedSeats.length >= state.quantity) {
          notify(`Your ticket quantity is ${state.quantity}. Change it to select more seats.`);
        } else {
          state.selectedSeats = [...state.selectedSeats, seat];
          if (!state.holdTimerId) startHoldClock();
        }
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
      case 'open-ticket': { const order = findTicketById(id); if (order) showConfirmation(order); break; }
      case 'add-ticket': showTicketEditorModal(null); break;
      case 'edit-ticket': event.stopPropagation(); { const order = findTicketById(id); if (order) showTicketEditorModal(order); break; }
      case 'edit-notice': showNoticeEditorModal(); break;
      case 'transfer': { const order = findTicketById(id); if (order) showTransfer(order); break; }
      case 'sell': { const order = findTicketById(id); if (order) showSell(order); break; }
      case 'close-notifications': $('#notificationsPopover').hidden = true; break;
      case 'mark-read': await markAllRead(); break;
      case 'payment-method': notify('Zero-payment mode is active — no payment gateway needed.'); break;
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
    if (form.id === 'browserTicketForm') {
      if (typeof data.noticeText === 'string' && data.noticeText.trim()) {
        state.noticeText = data.noticeText.trim();
        localStorage.setItem(NOTICE_TEXT_KEY, state.noticeText);
      }
      const qty = Math.max(1, Number(data.quantity || 1));
      if (data.id) {
        const idxCustom = state.customTickets.findIndex(item => item.id === data.id);
        const idxOrder = state.orders.findIndex(item => item.id === data.id);
        if (idxCustom >= 0) {
          state.customTickets[idxCustom] = {
            ...state.customTickets[idxCustom],
            title: data.title.trim(),
            date: data.date.trim(),
            venue: data.venue.trim(),
            quantity: qty,
            seat: data.seat.trim(),
            poster: (data.poster || '').trim() || state.customTickets[idxCustom].poster,
            tab: data.tab
          };
          saveCustomTickets();
        } else if (idxOrder >= 0) {
          state.orders[idxOrder] = {
            ...state.orders[idxOrder],
            title: data.title.trim(),
            date: data.date.trim(),
            venue: data.venue.trim(),
            quantity: qty,
            seat: data.seat.trim(),
            poster: (data.poster || '').trim() || state.orders[idxOrder].poster,
            tab: data.tab
          };
        }
        notify('Ticket updated in browser.');
      } else {
        const newTicket = {
          id: `CUSTOM-${Date.now()}`,
          code: `TP-${Math.floor(100000 + Math.random() * 900000)}`,
          title: data.title.trim(),
          date: data.date.trim(),
          venue: data.venue.trim(),
          quantity: qty,
          seat: data.seat.trim(),
          poster: (data.poster || '').trim() || DEFAULT_POSTER,
          ticketType: 'Confirmed Pass',
          status: 'Confirmed',
          tab: data.tab || 'upcoming'
        };
        state.customTickets = [newTicket, ...state.customTickets];
        saveCustomTickets();
        notify('Ticket added to your wallet.');
      }
      closeModal();
      renderAll();
      return;
    }

    if (form.id === 'noticeBannerForm') {
      state.noticeText = String(data.noticeText || DEFAULT_NOTICE).trim() || DEFAULT_NOTICE;
      localStorage.setItem(NOTICE_TEXT_KEY, state.noticeText);
      closeModal();
      renderTickets();
      notify('Notice banner updated.');
      return;
    }

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