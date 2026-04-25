var axios = require('axios');
var FormData = require('form-data');

var BASE_URL = process.env.YODECK_BASE_URL || 'https://app.yodeck.com/api/v1';

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
  return makeClient(token).get('/monitor/').then(function(res) {
    return res.data.results || res.data;
  });
}

function addMediaToScreen(token, screenId, mediaId, duration) {
  var api = makeClient(token);
  return api.get('/monitor/' + screenId + '/').then(function(monitorRes) {
    var monitor = monitorRes.data;
    var playlistId = monitor.default_playlist;

    var getOrCreatePlaylist = playlistId
      ? Promise.resolve(playlistId)
      : api.post('/playlist/', {
          name: monitor.name + ' Playlist',
          description: 'Auto-created by Signage Portal'
        }).then(function(plRes) {
          var newId = plRes.data.id;
          return api.patch('/monitor/' + screenId + '/', {
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
  console.log('Verifying token (first 8 chars):', cleanToken.substring(0, 8) + '...');
  console.log('Auth header will be: Token ' + cleanToken.substring(0, 8) + '...');
  console.log('Hitting URL:', BASE_URL + '/monitor/');

  // Try both auth header formats
  return axios.get(BASE_URL + '/monitor/', {
    headers: { Authorization: 'Token ' + cleanToken }
  }).then(function(res) {
    console.log('SUCCESS with Token format, status:', res.status);
    return { valid: true };
  }).catch(function(e1) {
    var s1 = e1.response && e1.response.status;
    var d1 = JSON.stringify(e1.response && e1.response.data);
    console.log('Token format failed, HTTP ' + s1 + ':', d1);

    // Try Api-Key format as fallback
    return axios.get(BASE_URL + '/monitor/', {
      headers: { Authorization: 'Api-Key ' + cleanToken }
    }).then(function(res) {
      console.log('SUCCESS with Api-Key format, status:', res.status);
      return { valid: true };
    }).catch(function(e2) {
      var s2 = e2.response && e2.response.status;
      var d2 = JSON.stringify(e2.response && e2.response.data);
      console.log('Api-Key format also failed, HTTP ' + s2 + ':', d2);
      if (s2 === 401) return { valid: false, error: 'Token rejected (401 Unauthorized). In Yodeck: delete the token, generate a new one, and make sure to select a Role (Administrator) before clicking Generate.' };
      if (s2 === 403) return { valid: false, error: 'Token valid but no permission (403). Set role to Administrator when generating the token in Yodeck.' };
      if (s2 === 404) return { valid: false, error: 'API endpoint not found (404). Account may require Premium or Enterprise plan.' };
      return { valid: false, error: 'HTTP ' + s2 + ': ' + d2 + ' | First attempt: HTTP ' + s1 + ': ' + d1 };
    });
  });
}

module.exports = {
  uploadMedia: uploadMedia,
  getScreens: getScreens,
  addMediaToScreen: addMediaToScreen,
  verifyToken: verifyToken
};
