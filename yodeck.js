var axios = require('axios');
var FormData = require('form-data');

var BASE_URL = 'https://app.yodeck.com/api/v1';

function makeClient(token) {
  return axios.create({
    baseURL: BASE_URL,
    headers: {
      Authorization: 'Token ' + token.trim()
    }
  });
}

function uploadMedia(token, fileBuffer, filename, mimetype, displayName) {
  var form = new FormData();
  form.append('file', fileBuffer, { filename: filename, contentType: mimetype });
  form.append('name', displayName || filename);

  return makeClient(token).post('/media/', form, {
    headers: Object.assign({}, form.getHeaders(), {
      Authorization: 'Token ' + token.trim()
    }),
    maxContentLength: Infinity,
    maxBodyLength: Infinity
  }).then(function(res) {
    return res.data;
  });
}

function getScreens(token) {
  return makeClient(token).get('/device/').then(function(res) {
    return res.data.results || res.data;
  });
}

function addMediaToScreen(token, screenId, mediaId, duration) {
  var api = makeClient(token);
  // Try /screen/ first, fall back to /monitor/
  var screenEndpoint = '/device/';
  return api.get(screenEndpoint + screenId + '/').catch(function() {
    screenEndpoint = '/device/';
    return api.get(screenEndpoint + screenId + '/');
  }).then(function(monitorRes) {
    var monitor = monitorRes.data;
    var playlistId = monitor.default_playlist;

    var getOrCreatePlaylist = playlistId
      ? Promise.resolve(playlistId)
      : api.post('/playlist/', {
          name: monitor.name + ' Playlist',
          description: 'Auto-created by Signage Portal'
        }).then(function(plRes) {
          var newId = plRes.data.id;
          return api.patch(screenEndpoint + screenId + '/', {
            default_playlist: newId
          }).then(function() { return newId; });
        });

    return getOrCreatePlaylist.then(function(pid) {
      return api.get('/playlist/' + pid + '/').then(function(plRes) {
        var existingItems = plRes.data.playlistitem_set || [];
        var newItem = {
          media: mediaId,
          duration: duration || 10,
          ordering: existingItems.length + 1
        };
        return api.patch('/playlist/' + pid + '/', {
          playlistitem_set: existingItems.concat([newItem])
        });
      });
    });
  });
}

function verifyToken(token) {
  if (!token || !token.trim()) {
    return Promise.resolve({ valid: false, error: 'No token provided.' });
  }
  var cleanToken = token.trim();
  console.log('Verifying token:', cleanToken.substring(0, 12) + '...');
  console.log('URL:', BASE_URL + '/device/');

  var authHeader = 'Token ' + cleanToken;
  console.log('Full Authorization header being sent:', authHeader.substring(0, 40) + '...');

  return axios.get(BASE_URL + '/device/', {
    headers: { Authorization: authHeader }
  }).then(function(res) {
    console.log('SUCCESS, status:', res.status);
    return { valid: true };
  }).catch(function(e1) {
    console.log('Token prefix failed, trying without prefix...');
    // Try sending the token value directly without "Token" prefix
    return axios.get(BASE_URL + '/device/', {
      headers: { Authorization: cleanToken }
    }).then(function(res) {
      console.log('SUCCESS without Token prefix, status:', res.status);
      return { valid: true };
    }).catch(function(e2) {
      // Log full response headers for debugging
      console.log('Both attempts failed');
      console.log('Attempt 1 status:', e1.response && e1.response.status);
      console.log('Attempt 1 headers:', JSON.stringify(e1.response && e1.response.headers));
      console.log('Attempt 2 status:', e2.response && e2.response.status);
      var status = e1.response && e1.response.status;
      if (status === 401) return { valid: false, error: 'Token rejected (401). Please verify in Yodeck: (1) token was generated inside the client account not the partner console, (2) a Role was selected, (3) the account has Premium or Enterprise plan.' };
      if (status === 403) return { valid: false, error: 'Permission denied (403). Assign Administrator role to the token in Yodeck.' };
      if (status === 404) return { valid: false, error: 'API endpoint not found (404).' };
      return { valid: false, error: 'HTTP ' + status };
    });
  });
}

module.exports = {
  uploadMedia: uploadMedia,
  getScreens: getScreens,
  addMediaToScreen: addMediaToScreen,
  verifyToken: verifyToken
};
