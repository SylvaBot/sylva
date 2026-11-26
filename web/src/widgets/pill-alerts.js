// Minimal Pill Alerts for StreamElements (Custom Widget)
// Full-canvas (1920x1080) alert widget. Handles every StreamElements alert event,
// with a fallback for any new "-latest" event type.

var settings = {};
var currencySymbol = '$';
var queue = [];
var busy = false;
var hiding = false;
var ready = false;
var muted = false;
var timers = [];
var recentIds = {};

var stageEl = document.getElementById('stage');
var pillEl = document.getElementById('pill');
var rowEl = document.getElementById('row');
var iconEl = document.getElementById('icon');
var nameEl = document.getElementById('name');
var actionEl = document.getElementById('action');
var targetEl = document.getElementById('target');
var badgeEl = document.getElementById('badge');
var msgEl = document.getElementById('msg');

// Timing (milliseconds)
var POP_IN = 380;      // circle appears
var EXPAND = 650;      // pill opens and text fades in
var TEXT_OUT = 220;    // text fades out
var COLLAPSE = 450;    // pill closes to circle
var POP_OUT = 320;     // circle disappears
var GAP = 250;         // pause between queued alerts

var ICONS = {
  heart: '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>',
  star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
  gift: '<rect x="3" y="8" width="18" height="4" rx="1"/><path d="M12 8v13"/><path d="M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7"/><path d="M7.5 8a2.5 2.5 0 0 1 0-5A4.8 8 0 0 1 12 8a4.8 8 0 0 1 4.5-5 2.5 2.5 0 0 1 0 5"/>',
  gem: '<path d="M6 3h12l4 6-10 13L2 9Z"/><path d="M11 3 8 9l4 13 4-13-3-6"/><path d="M2 9h20"/>',
  dollar: '<circle cx="12" cy="12" r="10"/><path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8"/><path d="M12 18V6"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  tv: '<rect x="2" y="7" width="20" height="15" rx="2"/><polyline points="17 2 12 7 7 2"/>',
  chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  bag: '<path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/>',
  zap: '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>',
  sparkle: '<path d="M12 3 14.2 9.8 21 12l-6.8 2.2L12 21l-2.2-6.8L3 12l6.8-2.2Z"/>',
  ribbon: '<circle cx="12" cy="8" r="6"/><path d="M15.48 12.89 17 22l-5-3-5 3 1.52-9.11"/>'
};

function svg(name) {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" ' +
    'stroke-linecap="round" stroke-linejoin="round">' + (ICONS[name] || ICONS.sparkle) + '</svg>';
}

/* ---------- Loading ---------- */

window.addEventListener('onWidgetLoad', function (obj) {
  var detail = (obj && obj.detail) || {};
  settings = detail.fieldData || {};
  if (detail.currency && detail.currency.symbol) currencySymbol = detail.currency.symbol;
  ready = false;
  applyStyle().then(function () {
    ready = true;
    playNext();
  });
});

// Safety net: never wait forever for the load event
setTimeout(function () {
  if (!ready) { ready = true; playNext(); }
}, 4000);

function setting(key, fallback) {
  var value = settings[key];
  return value === undefined || value === null || value === '' ? fallback : value;
}

function on(key) {
  return setting(key, true) !== false;
}

function num(value, fallback) {
  var n = Number(value);
  return isFinite(n) ? n : (fallback || 0);
}

function toRgba(color, alpha) {
  var hex = String(color).trim().replace('#', '');
  if (/^[0-9a-f]{3}$/i.test(hex)) hex = hex.replace(/(.)/g, '$1$1');
  if (/^[0-9a-f]{6}$/i.test(hex)) {
    return 'rgba(' + parseInt(hex.slice(0, 2), 16) + ', ' + parseInt(hex.slice(2, 4), 16) + ', ' +
      parseInt(hex.slice(4, 6), 16) + ', ' + alpha + ')';
  }
  var m = String(color).match(/rgba?\(([^)]+)\)/i);
  if (m) {
    var p = m[1].split(',');
    return 'rgba(' + p[0].trim() + ', ' + p[1].trim() + ', ' + p[2].trim() + ', ' + alpha + ')';
  }
  return color;
}

function applyStyle() {
  var root = document.documentElement.style;
  var font = String(setting('fontFamily', 'Inter'));
  var accent = setting('accentColor', '#FFFFFF');

  root.setProperty('--font', "'" + font + "', 'Inter', 'Segoe UI', Arial, sans-serif");
  root.setProperty('--accent', accent);
  root.setProperty('--accent-soft', toRgba(accent, 0.10));
  root.setProperty('--accent-ring', toRgba(accent, 0.28));
  root.setProperty('--card', setting('cardColor', '#000000'));
  root.setProperty('--text', setting('textColor', '#FFFFFF'));
  root.setProperty('--muted', setting('mutedColor', '#A3A3A3'));
  root.setProperty('--badge-text', setting('badgeTextColor', '#000000'));
  root.setProperty('--size', (22 * num(setting('size', 120), 120) / 100) + 'px');
  root.setProperty('--offset-x', num(setting('offsetX', 60), 60) + 'px');
  root.setProperty('--offset-y', num(setting('offsetY', 60), 60) + 'px');

  // position looks like "bottom-left", "middle-center", "top-right"
  var parts = String(setting('position', 'bottom-left')).split('-');
  stageEl.classList.remove('v-middle', 'v-bottom', 'h-center', 'h-right');
  if (parts[0] === 'middle' || parts[0] === 'bottom') stageEl.classList.add('v-' + parts[0]);
  if (parts[1] === 'center' || parts[1] === 'right') stageEl.classList.add('h-' + parts[1]);

  return loadFont(font);
}

// Load the font fully before any alert is measured, so text never gets cut off
function loadFont(font) {
  return new Promise(function (resolve) {
    var finished = false;
    function done() { if (!finished) { finished = true; resolve(); } }
    setTimeout(done, 3000);

    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'https://fonts.googleapis.com/css?family=' +
      encodeURIComponent(font).replace(/%20/g, '+') + ':400,700&display=block';
    link.onerror = done;
    link.onload = function () {
      if (!document.fonts || !document.fonts.load) return done();
      Promise.all([
        document.fonts.load('400 20px "' + font + '"'),
        document.fonts.load('700 20px "' + font + '"')
      ]).then(done, done);
    };
    document.head.appendChild(link);
  });
}

/* ---------- Events ---------- */

window.addEventListener('onEventReceived', function (obj) {
  var detail = (obj && obj.detail) || {};
  var listener = detail.listener;
  var event = detail.event || {};

  // Some test events arrive wrapped
  if (listener === 'event:test' && event && typeof event.listener === 'string') {
    listener = event.listener;
    event = event.event || event;
  }

  if (listener === 'event:skip') {
    if (busy) hideAlert();
    return;
  }

  if (listener === 'alertService:toggleSound') {
    muted = typeof event.muted === 'boolean' ? event.muted : !muted;
    return;
  }

  if (listener === 'widget-button') {
    if (event.field === 'testAlerts') runTests();
    return;
  }

  var alert;
  try {
    alert = buildAlert(listener, event);
  } catch (err) {
    alert = null;
  }
  if (!alert) return;

  // Ignore the same real event delivered twice within a few seconds
  var id = event.activityId || event._id;
  if (id) {
    var now = Date.now();
    if (recentIds[id] && now - recentIds[id] < 8000) return;
    recentIds[id] = now;
  }

  var maxQueue = num(setting('maxQueue', 50), 50);
  if (queue.length >= maxQueue) queue.shift();
  queue.push(alert);
  playNext();
});

/* ---------- Text helpers ---------- */

function clean(value, fallback) {
  var s = value === undefined || value === null ? '' : String(value);
  s = s.replace(/\s+/g, ' ').trim();
  return s || fallback || '';
}

function plural(n, one, many) {
  return formatNumber(n) + ' ' + (Number(n) === 1 ? one : many);
}

function formatNumber(n) {
  var v = num(n);
  var fixed = Number.isInteger(v) ? v.toString() : v.toFixed(2);
  var parts = fixed.split('.');
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return parts.join('.');
}

function formatMoney(amount) {
  var v = num(amount);
  var fixed = Number.isInteger(v) ? v.toString() : v.toFixed(2);
  var parts = fixed.split('.');
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return currencySymbol + parts.join('.');
}

function tierLabel(tier) {
  var t = String(tier || '');
  if (t === 'prime') return 'Prime';
  if (t === '2000') return 'Tier 2';
  if (t === '3000') return 'Tier 3';
  return '';
}

function gifterName(e) {
  var s = clean(e.sender, '');
  if (!s || /^an?anonymous/i.test(s)) return 'Anonymous';
  return s;
}

// Strip cheermotes like "Cheer100" from bits messages
var CHEERMOTES = /\b(cheer|biblethump|cheerwhal|corgo|uni|showlove|party|seemsgood|pride|kappa|frankerz|heyguys|dansgame|elegiggle|trihard|kreygasm|4head|swiftrage|notlikethis|failfish|vohiyo|pjsalt|mrdestructoid|bday|ripcheer|shamrock|streamlabs|muxy|doodlecheer|anon|holidaycheer|goal|charity)\d+\b/gi;

function message(e, isCheer) {
  if (setting('showMessages', false) !== true) return '';
  var text = clean(e.message, '');
  if (isCheer) text = clean(text.replace(CHEERMOTES, ' '), '');
  return text;
}

function humanize(listener) {
  var s = String(listener).replace(/-latest$/, '');
  s = s.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_]+/g, ' ').toLowerCase().trim();
  return s || 'event';
}

/* ---------- Event to alert ---------- */

function A(icon, name, action, target, badge, msg) {
  return { icon: icon, name: name, action: action, target: target || '', badge: badge || '', message: msg || '' };
}

function buildAlert(listener, e) {
  if (!listener || typeof listener !== 'string') return null;
  e = e || {};
  var name = clean(e.displayName || e.name || e.username, 'Someone');
  var amount = num(e.amount);

  switch (listener) {
    case 'follower-latest':
      if (!on('enableFollow')) return null;
      return A('heart', name, 'just followed');

    case 'subscriber-latest': {
      // Individual subs from a gift bomb: the bulk alert already covers them
      if (e.isCommunityGift || e.playedAsCommunityGift) return null;
      var tier = tierLabel(e.tier);
      if (e.bulkGifted) {
        if (!on('enableGift')) return null;
        return A('gift', gifterName(e), 'gifted' + (tier && tier !== 'Prime' ? ' ' + tier : ''), '',
          plural(amount || 1, 'sub', 'subs'));
      }
      if (e.gifted) {
        if (!on('enableGift')) return null;
        return A('gift', gifterName(e), 'gifted a' + (tier && tier !== 'Prime' ? ' ' + tier : '') + ' sub to', name);
      }
      if (!on('enableSub')) return null;
      var suffix = tier === 'Prime' ? ' with Prime' : (tier ? ' at ' + tier : '');
      if (amount > 1) return A('star', name, 'resubscribed' + suffix, '', plural(amount, 'month', 'months'), message(e));
      return A('star', name, 'subscribed' + suffix, '', '', message(e));
    }

    case 'tip-latest':
      if (!on('enableTip') || amount < num(setting('minTip', 0))) return null;
      return A('dollar', name, 'sent a tip', '', formatMoney(amount), message(e));

    case 'cheer-latest':
      if (!on('enableCheer') || amount < num(setting('minCheer', 1), 1)) return null;
      return A('gem', name, 'cheered', '', plural(amount, 'bit', 'bits'), message(e, true));

    case 'raid-latest':
      if (!on('enableRaid') || amount < num(setting('minRaid', 0))) return null;
      return A('users', name, 'is raiding', '', amount > 0 ? plural(amount, 'viewer', 'viewers') : '');

    case 'host-latest':
      if (!on('enableHost')) return null;
      return A('tv', name, 'is hosting', '', amount > 0 ? plural(amount, 'viewer', 'viewers') : '');

    case 'superchat-latest':
      if (!on('enableTip') || amount < num(setting('minTip', 0))) return null;
      return A('chat', name, 'sent a Super Chat', '', formatMoney(amount), message(e));

    case 'sponsor-latest': {
      // YouTube memberships
      if (e.isCommunityGift || e.playedAsCommunityGift) return null;
      if (e.bulkGifted) {
        if (!on('enableGift')) return null;
        return A('gift', gifterName(e), 'gifted', '', plural(amount || 1, 'membership', 'memberships'));
      }
      if (e.gifted) {
        if (!on('enableGift')) return null;
        return A('gift', gifterName(e), 'gifted a membership to', name);
      }
      if (!on('enableSub')) return null;
      if (amount > 1) return A('star', name, 'renewed their membership', '', plural(amount, 'month', 'months'), message(e));
      return A('star', name, 'became a member', '', '', message(e));
    }

    case 'merch-latest': {
      if (!on('enableMerch')) return null;
      var count = Array.isArray(e.items) ? e.items.reduce(function (s, it) { return s + (num(it && it.quantity) || 1); }, 0) : 0;
      return A('bag', name, 'bought merch', '', count > 0 ? plural(count, 'item', 'items') : '', message(e));
    }

    case 'charityCampaignDonation-latest':
      if (!on('enableCharity')) return null;
      return A('ribbon', name, 'donated to charity', '', amount > 0 ? formatMoney(amount) : '', message(e));

    case 'kicks-latest':
      if (!on('enableCheer') || amount < num(setting('minCheer', 1), 1)) return null;
      return A('zap', name, 'sent', '', plural(amount, 'KICK', 'KICKs'), message(e));

    case 'redemption-latest':
      if (!on('enableStore')) return null;
      return A('sparkle', name, 'redeemed', clean(e.item || e.redemption || e.itemName, ''), '', message(e));

    case 'event': {
      // Twitch channel points only come through the general "event" listener
      if (e.type !== 'channelPointsRedemption' || !on('enableChannelPoints')) return null;
      var d = e.data || {};
      var who = clean(d.displayName || d.username, 'Someone');
      var reward = clean(d.redemption, 'a reward');
      return A('sparkle', who, 'redeemed', reward, '',
        setting('showMessages', false) === true ? clean(d.message, '') : '');
    }
  }

  // Anything else StreamElements adds later
  if (/-latest$/.test(listener) && on('enableOther')) {
    return A('sparkle', name, humanize(listener), '', amount > 0 ? formatNumber(amount) : '', message(e));
  }
  return null;
}

/* ---------- Showing alerts ---------- */

function later(ms, fn) {
  timers.push(setTimeout(fn, ms));
}

function clearTimers() {
  for (var i = 0; i < timers.length; i++) clearTimeout(timers[i]);
  timers = [];
}

function playNext() {
  if (!ready || busy || queue.length === 0) return;
  busy = true;
  var next = queue.shift();
  try {
    showAlert(next);
  } catch (err) {
    busy = false;
    hiding = false;
    later(GAP, playNext);
  }
}

function availableWidth() {
  var cs = getComputedStyle(stageEl);
  var w = stageEl.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 2;
  return Math.max(120, w);
}

function showAlert(a) {
  var seconds = Math.max(1, num(setting('duration', 5), 5));
  hiding = false;
  clearTimers();

  iconEl.innerHTML = svg(a.icon);
  nameEl.textContent = a.name;
  actionEl.textContent = a.action;
  targetEl.textContent = a.target;
  badgeEl.textContent = a.badge;
  msgEl.textContent = a.message;
  msgEl.classList.remove('show');

  // Reset to the hidden circle and measure the open size
  pillEl.style.transition = 'none';
  pillEl.className = 'pill' + (a.badge ? ' has-badge' : '');
  pillEl.style.width = 'auto';
  rowEl.style.width = 'auto';
  rowEl.style.maxWidth = availableWidth() + 'px';
  pillEl.style.transform = 'none';
  var scale = stageEl.getBoundingClientRect().width / (stageEl.offsetWidth || 1) || 1;
  var fullWidth = Math.ceil(rowEl.getBoundingClientRect().width / scale);
  var circle = rowEl.offsetHeight;
  pillEl.style.transform = '';
  rowEl.style.width = fullWidth + 'px';
  pillEl.style.width = circle + 'px';
  void pillEl.offsetWidth;
  pillEl.style.transition = '';

  playSound();

  // 1. Circle pops in
  pillEl.classList.add('pop');
  // 2. Pill opens, text and badge fade in
  later(POP_IN, function () {
    pillEl.style.width = fullWidth + 'px';
    pillEl.classList.add('open');
  });
  // 3. Message (if any)
  later(POP_IN + EXPAND, function () {
    if (a.message) msgEl.classList.add('show');
  });
  // 4. Hold, then close
  later(POP_IN + EXPAND + seconds * 1000, hideAlert);
}

function hideAlert() {
  if (hiding) return;
  hiding = true;
  clearTimers();

  var circle = rowEl.offsetHeight;
  msgEl.classList.remove('show');
  pillEl.classList.add('closing');
  pillEl.classList.remove('open');

  later(TEXT_OUT, function () {
    pillEl.style.width = circle + 'px';
  });
  later(TEXT_OUT + COLLAPSE, function () {
    pillEl.classList.remove('pop');
  });
  later(TEXT_OUT + COLLAPSE + POP_OUT + GAP, function () {
    busy = false;
    hiding = false;
    playNext();
  });
}

function playSound() {
  var url = setting('alertSound', '');
  if (!url || muted) return;
  try {
    var audio = new Audio(url);
    audio.volume = Math.min(1, Math.max(0, num(setting('volume', 50), 50) / 100));
    var p = audio.play();
    if (p && p.catch) p.catch(function () {});
  } catch (err) {}
}

/* ---------- Test button ---------- */

function runTests() {
  var tests = [
    ['follower-latest', { name: 'kettlewitch' }],
    ['subscriber-latest', { name: 'orbitalfern', amount: 1, tier: '1000', message: 'Happy to be here!' }],
    ['subscriber-latest', { name: 'harborlight', amount: 14, tier: 'prime', message: '14 months already' }],
    ['subscriber-latest', { name: 'lucky_viewer', amount: 1, tier: '1000', gifted: true, sender: 'GenerousGhost' }],
    ['subscriber-latest', { name: 'GenerousGhost', amount: 10, tier: '1000', bulkGifted: true, sender: 'GenerousGhost' }],
    ['tip-latest', { name: 'coffeefund', amount: 150, message: 'Grab yourself a coffee' }],
    ['cheer-latest', { name: 'bitsandbobs', amount: 1000, message: 'Cheer1000 GG' }],
    ['raid-latest', { name: 'friendlystreamer', amount: 42 }],
    ['event', { type: 'channelPointsRedemption', data: { displayName: 'hydrohomie', redemption: 'Hydrate!' } }]
  ];
  tests.forEach(function (t) {
    window.dispatchEvent(new CustomEvent('onEventReceived', { detail: { listener: t[0], event: t[1] } }));
  });
}
