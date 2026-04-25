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

  return axios.get(BASE_URL + '/device/', {
    headers: { Authorization: 'Token ' + cleanToken }
  }).then(function(res) {
    console.log('SUCCESS, status:', res.status);
    return { valid: true };
  }).catch(function(e) {
    var status = e.response && e.response.status;
    var body = JSON.stringify(e.response && e.response.data);
    console.log('Failed HTTP ' + status + ':', body);
    if (status === 401) return { valid: false, error: 'Token rejected (401). Make sure token format is label:tokenvalue (e.g. portal:Ru1MRfz5...)' };
    if (status === 403) return { valid: false, error: 'Permission denied (403). Assign Administrator role to the token in Yodeck.' };
    if (status === 404) return { valid: false, error: 'API endpoint not found (404). Please contact Yodeck support.' };
    return { valid: false, error: 'HTTP ' + status + ': ' + body };
  });
}

module.exports = {
  uploadMedia: uploadMedia,
  getScreens: getScreens,
  addMediaToScreen: addMediaToScreen,
  verifyToken: verifyToken
};
