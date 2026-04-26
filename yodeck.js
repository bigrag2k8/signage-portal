// yodeck.js — Yodeck API v2 (correct endpoints confirmed from API docs)
var axios = require('axios');
var FormData = require('form-data');

var BASE_URL = 'https://app.yodeck.com/api/v2';

// Auth header format: Token <label:value>
// e.g. Token portal:Ru1MRfz5...
function makeClient(token) {
  return axios.create({
    baseURL: BASE_URL,
    headers: {
      Authorization: 'Token ' + token.trim(),
      'Content-Type': 'application/json'
    }
  });
}

// ── Verify token ──────────────────────────────────────────
function verifyToken(token) {
  if (!token || !token.trim()) {
    return Promise.resolve({ valid: false, error: 'No token provided.' });
  }
  var cleanToken = token.trim();
  console.log('Verifying token:', cleanToken.substring(0, 12) + '...');

  return makeClient(cleanToken).get('/screens/').then(function(res) {
    console.log('Token verified OK, status:', res.status);
    return { valid: true };
  }).catch(function(e) {
    var status = e.response && e.response.status;
    console.log('Token verify failed, HTTP', status);
    if (status === 401) return { valid: false, error: 'Token rejected (401). Format must be label:tokenvalue — e.g. portal:XXXXXXXXX. Make sure a Role was assigned when generating.' };
    if (status === 403) return { valid: false, error: 'Permission denied (403). Assign Administrator role to the token in Yodeck.' };
    return { valid: false, error: 'HTTP ' + status + ': Could not connect to Yodeck API.' };
  });
}

// ── Get all screens ───────────────────────────────────────
function getScreens(token) {
  return makeClient(token).get('/screens/').then(function(res) {
    return res.data.results || res.data;
  });
}

// ── Get single screen with current content ────────────────
function getScreen(token, screenId) {
  return makeClient(token).get('/screens/' + screenId + '/').then(function(res) {
    return res.data;
  });
}

// ── Upload media file ─────────────────────────────────────
function uploadMedia(token, fileBuffer, filename, mimetype, displayName) {
  var form = new FormData();
  form.append('file', fileBuffer, { filename: filename, contentType: mimetype });
  form.append('name', displayName || filename);

  return axios.post(BASE_URL + '/media/', form, {
    headers: Object.assign({}, form.getHeaders(), {
      Authorization: 'Token ' + token.trim()
    }),
    maxContentLength: Infinity,
    maxBodyLength: Infinity
  }).then(function(res) {
    console.log('Media uploaded, id:', res.data.id);
    return res.data;
  });
}

// ── Publish media to screens ──────────────────────────────
// Uses PATCH /screens/ with screen_content to assign media directly
function publishToScreens(token, screenIds, mediaId) {
  var objects = screenIds.map(function(id) {
    return {
      id: Number(id),
      screen_content: {
        source_id: Number(mediaId),
        source_type: 'media'
      }
    };
  });

  console.log('Publishing media', mediaId, 'to screens:', screenIds);

  return makeClient(token).patch('/screens/', {
    objects: objects
  }).then(function(res) {
    console.log('Publish success:', res.status);
    return res.data;
  });
}

// ── Get current content on a screen ──────────────────────
function getScreenContent(token, screenId) {
  return makeClient(token).get('/screens/' + screenId + '/').then(function(res) {
    var screen = res.data;
    return {
      id: screen.id,
      name: screen.name,
      content: screen.screen_content || null
    };
  });
}

// ── Remove content from screen (turn off) ────────────────
function clearScreen(token, screenId) {
  return makeClient(token).patch('/screens/', {
    objects: [{
      id: Number(screenId),
      screen_content: {
        source_type: 'turned_off'
      }
    }]
  }).then(function(res) {
    return res.data;
  });
}

module.exports = {
  verifyToken: verifyToken,
  getScreens: getScreens,
  getScreen: getScreen,
  uploadMedia: uploadMedia,
  publishToScreens: publishToScreens,
  getScreenContent: getScreenContent,
  clearScreen: clearScreen
};
