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
  var api = makeClient(token);
  return api.get('/screen/').then(function(res) {
    return res.data.results || res.data;
  }).catch(function() {
    return api.get('/monitor/').then(function(res) {
      return res.data.results || res.data;
    });
  });
}

function addMediaToScreen(token, screenId, mediaId, duration) {
  var api = makeClient(token);
  // Try /screen/ first, fall back to /monitor/
  var screenEndpoint = '/screen/';
  return api.get(screenEndpoint + screenId + '/').catch(function() {
    screenEndpoint = '/monitor/';
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

  // Try every combination of base path and endpoint
  var attempts = [
    'https://abizz.yodeck.com/api/v1/screen/',
    'https://abizz.yodeck.com/api/v1/monitor/',
    'https://abizz.yodeck.com/api/screen/',
    'https://abizz.yodeck.com/api/monitor/',
    'https://app.yodeck.com/api/v1/screen/',
    'https://app.yodeck.com/api/v1/monitor/'
  ];

  function tryNext(i) {
    if (i >= attempts.length) {
      return Promise.resolve({ valid: false, error: 'Could not find Yodeck API endpoint. Please open a support ticket with Yodeck and ask: what is the correct REST API base URL for reseller account abizz.yodeck.com?' });
    }
    var url = attempts[i];
    console.log('Trying URL ' + (i+1) + ': ' + url);
    return axios.get(url, {
      headers: { Authorization: 'Token ' + cleanToken }
    }).then(function(res) {
      console.log('SUCCESS at URL:', url, 'status:', res.status);
      return { valid: true, apiUrl: url.replace(/\/(screen|monitor)\/$/, '') };
    }).catch(function(e) {
      var status = e.response && e.response.status;
      console.log('URL ' + (i+1) + ' failed HTTP ' + status + ': ' + url);
      // 401/403 means the URL exists but auth issue — stop and report
      if (status === 401) return { valid: false, error: 'API found at ' + url + ' but token rejected (401). Check token format is label:value with Administrator role.' };
      if (status === 403) return { valid: false, error: 'API found at ' + url + ' but permission denied (403). Assign Administrator role to the token in Yodeck.' };
      // 404 means wrong URL — keep trying
      return tryNext(i + 1);
    });
  }

  return tryNext(0);
}

module.exports = {
  uploadMedia: uploadMedia,
  getScreens: getScreens,
  addMediaToScreen: addMediaToScreen,
  verifyToken: verifyToken
};
